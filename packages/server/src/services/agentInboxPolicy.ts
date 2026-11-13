/**
 * Pure rules for the server's process-local agent inbox: enqueue deduplication,
 * receive decisions and acknowledgement partitions. These rules neither own
 * the queue nor read durable inbox state; LocalAgentInboxes applies the results.
 * Keep this leaf module free of runtime imports (guarded by the boundary test).
 */
import type { AgentMessage } from "@botiverse/raft-shared";

export interface ReceivePlanInput {
  hasBufferedMessages: boolean;
  block: boolean;
}

export type ReceivePlanAction =
  | "return-buffered"
  | "return-empty"
  | "install-waiter";

export function planReceiveAction(input: ReceivePlanInput): ReceivePlanAction {
  if (input.hasBufferedMessages) {
    return "return-buffered";
  }
  return input.block ? "install-waiter" : "return-empty";
}

export interface AckPartitionInput {
  inbox: AgentMessage[];
  ackedSeqs: Set<number>;
  ackedMessageIds?: Set<string>;
}

export interface AckPartitionResult {
  removed: AgentMessage[];
  retained: AgentMessage[];
}

export function partitionAcknowledgedMessages(input: AckPartitionInput): AckPartitionResult {
  const removed: AgentMessage[] = [];
  const retained: AgentMessage[] = [];

  for (const message of input.inbox) {
    if (
      (message.seq && input.ackedSeqs.has(message.seq))
      || (!message.seq && message.message_id && input.ackedMessageIds?.has(message.message_id))
    ) {
      removed.push(message);
    } else {
      retained.push(message);
    }
  }

  return { removed, retained };
}

export interface TargetScopedAckPartitionInput {
  inbox: AgentMessage[];
  channelId: string;
  ackedSeqs: Set<number>;
}

export function partitionTargetScopedAcknowledgedMessages(input: TargetScopedAckPartitionInput): AckPartitionResult {
  const removed: AgentMessage[] = [];
  const retained: AgentMessage[] = [];

  for (const message of input.inbox) {
    if (message.channel_id === input.channelId && message.seq && input.ackedSeqs.has(message.seq)) {
      removed.push(message);
    } else {
      retained.push(message);
    }
  }

  return { removed, retained };
}

export interface TargetScopedAckUpToSeqPartitionInput {
  inbox: AgentMessage[];
  channelId: string;
  maxSeq: number;
}

export function partitionTargetScopedMessagesUpToSeq(input: TargetScopedAckUpToSeqPartitionInput): AckPartitionResult {
  const removed: AgentMessage[] = [];
  const retained: AgentMessage[] = [];

  for (const message of input.inbox) {
    if (message.channel_id === input.channelId && message.seq && message.seq <= input.maxSeq) {
      removed.push(message);
    } else {
      retained.push(message);
    }
  }

  return { removed, retained };
}

export interface LocalInboxEnqueuePlanInput {
  hasSeqDuplicate: boolean;
  hasMessageIdDuplicate: boolean;
}

export type LocalInboxEnqueuePlanAction = "enqueue" | "skip-duplicate";

export function planLocalInboxEnqueueAction(input: LocalInboxEnqueuePlanInput): LocalInboxEnqueuePlanAction {
  return input.hasSeqDuplicate || input.hasMessageIdDuplicate ? "skip-duplicate" : "enqueue";
}
