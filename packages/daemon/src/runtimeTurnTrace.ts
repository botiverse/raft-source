// What both agent hosts put on a `daemon.runtime.turn` span besides its
// counters (runtimeCommunicationTrace.ts): its outcome values and the
// attributes of the messages that started the turn. The legacy host
// (agentProcessManager.ts) and the OAR host (agentHost/oarTurnTrace.ts) both
// read them from here, so the span means the same whichever host ran the turn.

import { createHash } from "node:crypto";
import type { AgentMessage } from "@botiverse/raft-shared";
import { runtimeProfileNotificationFromMessage } from "./agentRuntimeInput";

/** `outcome` on `daemon.runtime.turn`. */
export type RuntimeTurnTraceOutcome =
  | "turn-completed"
  /** The turn was interrupted at a person's request and ended aborted (the OAR host; the legacy host reports such a turn end as `turn-completed`). */
  | "turn-interrupted"
  | "runtime-error-with-turn-end"
  | "runtime-error"
  | "runtime-stalled"
  | "runtime-start-failed"
  | "process-exit"
  | "process-crash"
  | "busy_state_cleared"
  | "app_inbox_notice_not_written"
  | "idle_task_reminder_not_written"
  | "subagents_finished_not_written"
  | "turn_end_compaction_not_written";

export function hashRuntimeProfileKey(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function messageProducerFactTraceAttrs(messages?: readonly AgentMessage[]): Record<string, unknown> {
  if (!messages || messages.length === 0) return {};
  const producerFactIds = new Set<string>();
  for (const message of messages) {
    const producerFactId = typeof message.producerFactId === "string" ? message.producerFactId.trim() : "";
    if (producerFactId) producerFactIds.add(producerFactId);
  }
  if (producerFactIds.size === 0) return {};
  return {
    message_producer_fact_count: producerFactIds.size,
    ...(producerFactIds.size === 1 ? { message_producer_fact_id: [...producerFactIds][0] } : {}),
  };
}

/**
 * The messages a turn (or a delivery) carries, as trace attributes: how many,
 * the first one's ids, or the runtime profile control it is. `deliveryIdOf`
 * is the server delivery id the host received a message under, if any.
 */
export function messagesTraceAttrs(
  messages: readonly AgentMessage[] | undefined,
  deliveryIdOf: (message: AgentMessage) => string | undefined,
): Record<string, unknown> {
  if (!messages || messages.length === 0) return {};
  const first = messages[0]!;
  const deliveryId = deliveryIdOf(first);
  const notification = runtimeProfileNotificationFromMessage(first);
  if (notification) {
    return {
      messages_count: messages.length,
      message_id_present: Boolean(first.message_id),
      deliveryId,
      delivery_correlation_id: deliveryId,
      ...messageProducerFactTraceAttrs(messages),
      control_kind: notification.kind,
      key_present: Boolean(notification.key),
      runtime_profile_control_kind: notification.kind,
      runtime_profile_key_hash: hashRuntimeProfileKey(notification.key),
      runtime_profile_key_present: Boolean(notification.key),
    };
  }
  return {
    messages_count: messages.length,
    messageId: first.message_id,
    message_id_present: Boolean(first.message_id),
    deliveryId,
    delivery_correlation_id: deliveryId ?? first.message_id,
    ...messageProducerFactTraceAttrs(messages),
  };
}
