import type { AgentMessage } from "@botiverse/raft-shared";
import {
  partitionAcknowledgedMessages,
  partitionTargetScopedAcknowledgedMessages,
  partitionTargetScopedMessagesUpToSeq,
  planLocalInboxEnqueueAction,
  planReceiveAction,
  type AckPartitionResult,
} from "./agentInboxPolicy";

interface LocalInbox {
  messages: AgentMessage[];
  pendingReceive: { finish: (messages: AgentMessage[]) => void } | null;
}

export interface LocalInboxSnapshot {
  readonly messages: readonly AgentMessage[];
  readonly receiving: boolean;
}

/**
 * Owns only this replica's volatile queues and blocked receives. A receive is
 * a snapshot, never an acknowledgement: entries stay replayable until acked,
 * discarded, or cleared by the orchestrator's lifecycle/access decision.
 * Does not read durable inboxes, authorize delivery, wake agents or send IO.
 */
export class LocalAgentInboxes {
  private readonly entries = new Map<string, LocalInbox>();

  ensure(agentId: string): void {
    if (!this.entries.has(agentId)) this.entries.set(agentId, { messages: [], pendingReceive: null });
  }

  has(agentId: string): boolean {
    return this.entries.has(agentId);
  }

  snapshot(agentId: string): LocalInboxSnapshot | undefined {
    const inbox = this.entries.get(agentId);
    return inbox && { messages: [...inbox.messages], receiving: inbox.pendingReceive !== null };
  }

  peek(agentId: string): AgentMessage[] {
    return [...(this.entries.get(agentId)?.messages ?? [])];
  }

  peekFirst(agentId: string): AgentMessage | null {
    return this.entries.get(agentId)?.messages[0] ?? null;
  }

  enqueue(agentId: string, message: AgentMessage, options: {
    notifyPendingReceive?: boolean;
    reconcileNonMemberMention?: boolean;
  } = {}): void {
    this.ensure(agentId);
    const inbox = this.entries.get(agentId)!;
    if (options.reconcileNonMemberMention && this.reconcileNonMemberMention(agentId, message)) return;
    const action = planLocalInboxEnqueueAction({
      hasSeqDuplicate: Boolean(message.seq && inbox.messages.some(queued => queued.seq === message.seq)),
      hasMessageIdDuplicate: Boolean(!message.seq && message.message_id && inbox.messages.some(queued => queued.message_id === message.message_id)),
    });
    if (action !== "enqueue") return;
    inbox.messages.push(message);
    if (inbox.messages.length > 1000) inbox.messages.shift();
    if (options.notifyPendingReceive !== false) inbox.pendingReceive?.finish([...inbox.messages]);
  }

  reconcileNonMemberMention(agentId: string, message: AgentMessage): boolean {
    const inbox = this.entries.get(agentId);
    if (!inbox || !message.seq || message.non_member_mention === true) return false;
    const index = inbox.messages.findIndex(queued => queued.seq === message.seq);
    if (index < 0 || inbox.messages[index]?.non_member_mention !== true) return false;
    inbox.messages[index] = message;
    return true;
  }

  receive(agentId: string, block: boolean, timeoutMs: number, signal?: AbortSignal): Promise<AgentMessage[]> {
    this.ensure(agentId);
    const inbox = this.entries.get(agentId)!;
    const action = planReceiveAction({ hasBufferedMessages: inbox.messages.length > 0, block });
    if (action === "return-buffered") return Promise.resolve([...inbox.messages]);
    if (action === "return-empty") return Promise.resolve([]);
    return this.installReceiveWaiter(agentId, timeoutMs, signal);
  }

  private installReceiveWaiter(agentId: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentMessage[]> {
    return new Promise(resolve => {
      let finished = false;
      let cleanupAbortListener = () => {};
      const finish = (messages: AgentMessage[]) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        cleanupAbortListener();
        const inbox = this.entries.get(agentId);
        if (inbox?.pendingReceive === pendingReceive) inbox.pendingReceive = null;
        resolve(messages);
      };
      // Preserve the long-poll's existing native timer; fake timers exercise
      // exactly this scheduling path in the lifecycle tests.
      const timer = setTimeout(() => finish([]), timeoutMs);
      const pendingReceive = { finish };
      const inbox = this.entries.get(agentId)!;
      // Superseding a waiter must finish it before publishing the new one.
      // An old abort/timeout must never clear its replacement.
      inbox.pendingReceive?.finish([]);
      if (signal) {
        if (signal.aborted) {
          finish([]);
          return;
        }
        const onAbort = () => finish([]);
        signal.addEventListener("abort", onAbort, { once: true });
        cleanupAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
      inbox.pendingReceive = pendingReceive;
    });
  }

  /** Resolve a blocked receive and release its timer/listener before forgetting it. */
  clear(agentId: string): boolean {
    const pending = this.entries.get(agentId)?.pendingReceive;
    this.entries.delete(agentId);
    pending?.finish([]);
    return Boolean(pending);
  }

  clearAll(): void {
    for (const agentId of this.entries.keys()) this.clear(agentId);
  }

  removeWakeMessage(agentId: string, message: AgentMessage): boolean {
    const inbox = this.entries.get(agentId);
    if (!inbox) return false;
    const index = inbox.messages.findIndex(candidate => {
      if (message.seq && candidate.seq === message.seq) return true;
      return Boolean(!message.seq && message.message_id && candidate.message_id === message.message_id);
    });
    if (index < 0) return false;
    inbox.messages.splice(index, 1);
    return true;
  }

  /** Apply a caller's admission filter without exposing the mutable queue. */
  retain(agentId: string, keep: (message: Readonly<AgentMessage>) => boolean): { removedCount: number } {
    const inbox = this.entries.get(agentId);
    if (!inbox) return { removedCount: 0 };
    const retained = inbox.messages.filter(keep);
    const removedCount = inbox.messages.length - retained.length;
    if (removedCount > 0) inbox.messages = retained;
    return { removedCount };
  }

  acknowledge(agentId: string, seqs: number[], messageIds: string[] = []): { removedCount: number } {
    if (seqs.length === 0 && messageIds.length === 0) return { removedCount: 0 };
    return this.applyAck(agentId, messages => partitionAcknowledgedMessages({
      inbox: messages, ackedSeqs: new Set(seqs), ackedMessageIds: new Set(messageIds),
    }));
  }

  acknowledgeForChannel(agentId: string, channelId: string, seqs: number[]): { removedCount: number } {
    if (seqs.length === 0) return { removedCount: 0 };
    return this.applyAck(agentId, messages => partitionTargetScopedAcknowledgedMessages({
      inbox: messages, channelId, ackedSeqs: new Set(seqs),
    }));
  }

  acknowledgeForChannelUpToSeq(agentId: string, channelId: string, maxSeq: number): { removedCount: number } {
    if (!Number.isInteger(maxSeq) || maxSeq <= 0) return { removedCount: 0 };
    return this.applyAck(agentId, messages => partitionTargetScopedMessagesUpToSeq({ inbox: messages, channelId, maxSeq }));
  }

  private applyAck(agentId: string, partition: (messages: AgentMessage[]) => AckPartitionResult): { removedCount: number } {
    const inbox = this.entries.get(agentId);
    if (!inbox || inbox.messages.length === 0) return { removedCount: 0 };
    const { removed, retained } = partition(inbox.messages);
    if (removed.length > 0) inbox.messages = retained;
    return { removedCount: removed.length };
  }

  discard(agentId: string, messages: AgentMessage[]): { removedCount: number } {
    if (messages.length === 0) return { removedCount: 0 };
    const seqs = new Set<number>();
    const seqlessMessageIds = new Set<string>();
    for (const message of messages) {
      if (Number.isInteger(message.seq) && (message.seq ?? 0) > 0) seqs.add(message.seq!);
      else if (message.message_id) seqlessMessageIds.add(message.message_id);
    }
    if (seqs.size === 0 && seqlessMessageIds.size === 0) return { removedCount: 0 };
    return this.retain(agentId, queued => !(
      (Number.isInteger(queued.seq) && seqs.has(queued.seq!))
      || (!queued.seq && Boolean(queued.message_id) && seqlessMessageIds.has(queued.message_id!))
    ));
  }

  discardForChannels(agentId: string, channelIds: readonly string[]): { removedCount: number } {
    const ids = new Set(channelIds.filter(id => typeof id === "string" && id.length > 0));
    if (ids.size === 0) return { removedCount: 0 };
    return this.retain(agentId, message => !ids.has(message.channel_id));
  }
}
