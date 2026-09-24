import type { AgentMessage } from "@botiverse/raft-shared";
import type { AgentProxyVisibleMessage } from "./agentCredentialProxy.js";

export type AgentVisibleDeliveryConsumeSource =
  | "spawn_wake_message"
  | "agent_api_events_local"
  | "agent_api_events_server"
  | "agent_api_history"
  | "agent_api_send_commit"
  | "server_held_context"
  | "side_effect_preflight_context"
  | "spawn_starting_inbox_update"
  | "thread_join_context_rendered"
  | "verified_contiguous_content_consumption"
  | string;

type VisibleBucket = {
  maxSeq: number;
  boundarySeq: number;
  seqs: Set<number>;
  ids: Set<string>;
};

export type AgentVisibleDeliveryConsumption = {
  targets: string[];
  messagesCount: number;
  shouldSuppress(message: AgentMessage): boolean;
};

function getMessageShortId(messageId: string): string {
  return messageId.startsWith("thread-") ? messageId.slice(7) : messageId.slice(0, 8);
}

// Single source for the agent-visible target key (project-from-single-source, FM2
// discipline). Both pending-message suppression and visible-message consumption
// delegate here so the two sides cannot disagree on the key for the same message.
function computeTarget(
  channelType: string | undefined,
  channelName: string | undefined,
  parentChannelName: string | undefined,
  parentChannelType: string | undefined,
): string {
  if (channelType === "thread" && parentChannelName) {
    const shortId = getMessageShortId(String(channelName ?? ""));
    if (parentChannelType === "dm") {
      return `dm:@${parentChannelName}:${shortId}`;
    }
    return `#${parentChannelName}:${shortId}`;
  }
  if (channelType === "dm") {
    return `dm:@${channelName}`;
  }
  return `#${channelName}`;
}

export function formatAgentMessageVisibleTarget(message: AgentMessage): string {
  if (message.third_party_event) {
    return `agent-event:${getMessageShortId(message.third_party_event.id)}`;
  }
  return computeTarget(message.channel_type, message.channel_name, message.parent_channel_name, message.parent_channel_type);
}

export function formatProxyVisibleMessageTarget(message: AgentProxyVisibleMessage): string {
  return computeTarget(message.channel_type, message.channel_name, message.parent_channel_name, message.parent_channel_type);
}

function hasTargetMetadata(message: AgentProxyVisibleMessage): boolean {
  if (message.channel_type === "thread") return Boolean(message.parent_channel_name && message.channel_name);
  return Boolean(message.channel_type && message.channel_name);
}

function visibleMessageId(message: AgentProxyVisibleMessage | AgentMessage): string {
  if (typeof (message as AgentProxyVisibleMessage).message_id === "string") return String((message as AgentProxyVisibleMessage).message_id);
  if (typeof (message as AgentProxyVisibleMessage).id === "string") return String((message as AgentProxyVisibleMessage).id);
  return "";
}

function canAdvanceBoundaryForTarget(source: string, target: string): boolean {
  // Model-seen boundary contract: daemon delivery/queue/wake signals prove
  // attention, not contiguous content consumption. A sparse high-seq mention
  // must never advance the high-water boundary and hide older unseen rows.
  if (source === "verified_contiguous_content_consumption") return true;
  if (source === "thread_join_context_rendered") {
    // A rendered thread-join package shows the parent/root message and recent
    // thread replies. The recent replies are contiguous only within the thread
    // target; the parent message is an exact visible row, not proof that the
    // parent channel prefix was consumed.
    return target.includes(":");
  }
  return false;
}

/**
 * Owns the daemon's agent-visible delivery ledger.
 *
 * The ledger is the single boundary where APM turns "the model has seen this"
 * into durable process-local facts. It owns both forms of model-seen state:
 * target high-water boundaries for verified rendered/contiguous content
 * consumption, and exact message-id sets for weaker visibility sources such as
 * delivery signals, history/context reads, and self-authored commits. APM
 * should ask this component whether a message is model-seen; it should not
 * infer meaning from raw boundary/id maps or mutate those maps directly.
 *
 * Invariants:
 * - I1 boundary/id synchronization: only verified rendered/contiguous content
 *   consume sources may advance a target boundary, and boundary advancement is
 *   recorded alongside the exact message ids observed in the same target scope.
 *   Current daemon attention/delivery sources can add exact ids but must never
 *   advance a boundary.
 * - I2 visibility authorization: a visible message may enter the ledger only
 *   for the current authorized target projection. Explicit target mismatches
 *   are rejected before any state is written, keeping parent/thread/DM/channel
 *   scopes isolated.
 * - I3 consume/suppress contract: consume returns a suppression matcher for
 *   the just-consumed batch. APM applies that matcher to active inbox and
 *   start-pending buffers; the ledger does not reach out and mutate those
 *   external queues itself.
 * - No raw mutable state leak: callers get read-only boundary/id-set queries
 *   and must route every write through recordConsumed().
 */
export class AgentVisibleDeliveryLedger {
  private readonly boundaryByAgent = new Map<string, Map<string, number>>();
  private readonly messageIdsByAgent = new Map<string, Map<string, Set<string>>>();

  clearAgent(agentId: string): void {
    this.boundaryByAgent.delete(agentId);
    this.messageIdsByAgent.delete(agentId);
  }

  hasAgentState(agentId: string): boolean {
    return this.boundaryByAgent.has(agentId) || this.messageIdsByAgent.has(agentId);
  }

  getBoundary(agentId: string, target: string): number | undefined {
    return this.boundaryByAgent.get(agentId)?.get(target);
  }

  getMessageIdSet(agentId: string, target: string): Set<string> | undefined {
    return this.messageIdsByAgent.get(agentId)?.get(target);
  }

  isModelSeen(agentId: string, target: string, message: { seq?: number; message_id?: string; id?: string }): boolean {
    const seq = Number(message.seq ?? 0);
    const boundary = this.getBoundary(agentId, target);
    if (Number.isFinite(seq) && seq > 0 && typeof boundary === "number" && boundary >= Math.floor(seq)) return true;
    const id = visibleMessageId(message);
    return id.length > 0 && this.getMessageIdSet(agentId, target)?.has(id) === true;
  }

  recordConsumed(
    agentId: string,
    input: { target?: string; messages: AgentProxyVisibleMessage[]; boundarySeq?: number; source: AgentVisibleDeliveryConsumeSource },
  ): AgentVisibleDeliveryConsumption | null {
    if (input.messages.length === 0 && (!input.target || typeof input.boundarySeq !== "number")) return null;
    const byTarget = new Map<string, VisibleBucket>();
    const ensureBucket = (target: string): VisibleBucket => {
      let bucket = byTarget.get(target);
      if (!bucket) {
        bucket = { maxSeq: 0, boundarySeq: 0, seqs: new Set<number>(), ids: new Set<string>() };
        byTarget.set(target, bucket);
      }
      return bucket;
    };

    for (const message of input.messages) {
      const messageTarget = formatProxyVisibleMessageTarget(message);
      if (input.target && hasTargetMetadata(message) && messageTarget !== input.target) {
        throw new Error(`AgentVisibleDeliveryLedger target mismatch: explicit target ${input.target} does not match visible message target ${messageTarget}`);
      }
      const target = input.target ?? messageTarget;
      if (!target) continue;
      const bucket = ensureBucket(target);
      const seq = Number(message.seq ?? 0);
      if (Number.isFinite(seq) && seq > 0) {
        const normalizedSeq = Math.floor(seq);
        bucket.maxSeq = Math.max(bucket.maxSeq, normalizedSeq);
        bucket.seqs.add(normalizedSeq);
      }
      const id = visibleMessageId(message);
      if (id.length > 0) bucket.ids.add(id);
    }

    if (input.target && typeof input.boundarySeq === "number" && Number.isFinite(input.boundarySeq) && input.boundarySeq > 0) {
      const bucket = ensureBucket(input.target);
      bucket.boundarySeq = Math.max(bucket.boundarySeq, Math.floor(input.boundarySeq));
    }
    if (byTarget.size === 0) return null;

    const boundaryAdvancingTargets = new Set<string>();
    for (const [target, bucket] of byTarget) {
      const previousBoundary = this.getBoundary(agentId, target);
      const advancesBoundary = canAdvanceBoundaryForTarget(input.source, target);
      if (advancesBoundary) {
        boundaryAdvancingTargets.add(target);
        const highWaterSeq = Math.max(bucket.maxSeq, bucket.boundarySeq);
        const boundaryMap = this.boundaryMap(agentId);
        boundaryMap.set(target, Math.max(previousBoundary ?? 0, highWaterSeq));
      }
      if (bucket.ids.size > 0) {
        const targetIds = this.messageIdSet(agentId, target);
        for (const id of bucket.ids) targetIds.add(id);
      }
      this.assertConsumedInvariants("recordConsumed", agentId, target, bucket, {
        advancesBoundary,
        previousBoundary,
      });
    }

    return {
      targets: [...byTarget.keys()],
      messagesCount: input.messages.length,
      shouldSuppress(message: AgentMessage): boolean {
        const target = formatAgentMessageVisibleTarget(message);
        const bucket = byTarget.get(target);
        if (!bucket) return false;
        const seq = typeof message.seq === "number" ? Math.floor(message.seq) : 0;
        const id = visibleMessageId(message);
        const advancesBoundary = boundaryAdvancingTargets.has(target);
        return (advancesBoundary && seq > 0 && bucket.boundarySeq > 0 && seq <= bucket.boundarySeq)
          || (seq > 0 && bucket.seqs.has(seq))
          || (id.length > 0 && bucket.ids.has(id));
      },
    };
  }

  private boundaryMap(agentId: string): Map<string, number> {
    let map = this.boundaryByAgent.get(agentId);
    if (!map) {
      map = new Map<string, number>();
      this.boundaryByAgent.set(agentId, map);
    }
    return map;
  }

  private messageIdMap(agentId: string): Map<string, Set<string>> {
    let map = this.messageIdsByAgent.get(agentId);
    if (!map) {
      map = new Map<string, Set<string>>();
      this.messageIdsByAgent.set(agentId, map);
    }
    return map;
  }

  private messageIdSet(agentId: string, target: string): Set<string> {
    const map = this.messageIdMap(agentId);
    let ids = map.get(target);
    if (!ids) {
      ids = new Set<string>();
      map.set(target, ids);
    }
    return ids;
  }

  private assertConsumedInvariants(
    context: string,
    agentId: string,
    target: string,
    bucket: VisibleBucket,
    options: { advancesBoundary: boolean; previousBoundary: number | undefined },
  ): void {
    const boundary = this.getBoundary(agentId, target);
    if (!options.advancesBoundary && boundary !== options.previousBoundary) {
      throw new Error(`Agent visible delivery ledger invariant violation after ${context}: set-only source advanced boundary for ${agentId} ${target}`);
    }

    if (options.advancesBoundary) {
      const highWaterSeq = Math.max(bucket.maxSeq, bucket.boundarySeq);
      const normalizedBoundary = boundary ?? 0;
      if (normalizedBoundary < (options.previousBoundary ?? 0)) {
        throw new Error(`Agent visible delivery ledger invariant violation after ${context}: boundary regressed for ${agentId} ${target}`);
      }
      if (highWaterSeq > 0 && normalizedBoundary < highWaterSeq) {
        throw new Error(`Agent visible delivery ledger invariant violation after ${context}: boundary below consumed high-water for ${agentId} ${target}`);
      }
    }

    if (bucket.ids.size > 0) {
      const targetIds = this.getMessageIdSet(agentId, target);
      for (const id of bucket.ids) {
        if (targetIds?.has(id) !== true) {
          throw new Error(`Agent visible delivery ledger invariant violation after ${context}: missing consumed message id for ${agentId} ${target}`);
        }
      }
    }
  }
}
