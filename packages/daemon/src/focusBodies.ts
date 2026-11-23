// Focus (docs/contracts/agent-focus.md): what both agent hosts share about a
// message body written in full: the telemetry of a write that carried focused
// bodies, and the shape of the `agent:model-seen` report for bodies the model
// took.

import { MODEL_SEEN_MAX_ITEMS_PER_REPORT, type AgentMessage, type AgentModelSeenItem } from "@botiverse/raft-shared";
import { focusedBodyBytes, runtimeProfileNotificationFromMessage, type FocusedBodyRowCause } from "./agentRuntimeInput";

/**
 * Focus telemetry for a write: how many focused bodies it carried and their
 * content bytes, and how many focused messages each size limit made notice
 * rows instead (`selectFocusedBodies`). Each attribute only when above zero.
 */
export function focusedBodyTraceAttrs(
  focusedBodies: readonly AgentMessage[],
  rows: ReadonlyArray<{ limit: FocusedBodyRowCause }> = [],
): Record<string, number> {
  const overMessage = rows.filter((row) => row.limit === "message").length;
  const overWrite = rows.filter((row) => row.limit === "write").length;
  return {
    ...(focusedBodies.length > 0
      ? { focused_bodies: focusedBodies.length, focused_bytes_count: focusedBodies.reduce((bytes, message) => bytes + focusedBodyBytes(message), 0) }
      : {}),
    ...(overMessage > 0 ? { focused_rows_over_message_cap_count: overMessage } : {}),
    ...(overWrite > 0 ? { focused_rows_over_write_cap: overWrite } : {}),
  };
}

/** The messages `agent:model-seen` can name: a Server row with a seq, not a runtime-profile control message. */
export function modelSeenReportable(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter((message) =>
    typeof message.seq === "number" && message.seq > 0
    && Boolean(message.channel_id)
    && !runtimeProfileNotificationFromMessage(message));
}

/**
 * The `items` of the `agent:model-seen` reports for these messages (each has
 * a seq and a channel): one item per conversation, seqs ascending, split so
 * no report carries more conversations than the Server reads.
 */
export function modelSeenReportItems(messages: readonly AgentMessage[]): AgentModelSeenItem[][] {
  const byChannel = new Map<string, Set<number>>();
  for (const message of messages) {
    const seqs = byChannel.get(message.channel_id) ?? new Set<number>();
    seqs.add(message.seq!);
    byChannel.set(message.channel_id, seqs);
  }
  const items = [...byChannel].map(([channelId, seqs]) => ({ channelId, seqs: [...seqs].sort((a, b) => a - b) }));
  const reports: AgentModelSeenItem[][] = [];
  for (let start = 0; start < items.length; start += MODEL_SEEN_MAX_ITEMS_PER_REPORT) {
    reports.push(items.slice(start, start + MODEL_SEEN_MAX_ITEMS_PER_REPORT));
  }
  return reports;
}
