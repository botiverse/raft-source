// RaftMessage: one camelCase projection of the wire message envelope, with the
// reply target and the canonical header line computed the same way the CLI
// computes them. `text` is byte-identical to what `raft message check` prints
// for the same envelope, so a runtime can hand it to a model and get the CLI's
// agent experience.

import type { AgentApiMessageEnvelope } from "../agentApiMessageContract";
import { formatAgentMessageLine, formatAgentMessageTarget, type AgentMessageLike } from "../agentMessageText";
import type { RaftHintStyle } from "./hint";

export type RaftSenderType = "human" | "agent" | "system" | "third_party_app" | "unknown";

export interface RaftMessageAttachment {
  id: string;
  filename: string;
}

export interface RaftMessageTask {
  number: number | null;
  status: string | null;
  assigneeName: string | null;
  /** The assignee's id and kind (`human` / `agent`); null when unassigned or not sent. */
  assigneeId: string | null;
  assigneeType: string | null;
}

export interface RaftMessage {
  /** Full message id when the Server sent one. */
  id: string | null;
  /** First 8 characters of the id: the thread suffix an agent uses in targets. */
  shortId: string | null;
  seq: number | null;
  /** Where to reply: `#channel`, `#channel:shortid`, `dm:@peer`, `dm:@peer:shortid`, or `agent-event:shortid`. */
  target: string;
  timestamp: string | null;
  sender: { type: RaftSenderType; name: string | null; description: string | null };
  content: string;
  attachments: RaftMessageAttachment[];
  /** Whether this message formally @mentions the receiving agent, when the Server said. */
  mentioned: boolean | null;
  task: RaftMessageTask | null;
  thread: { id: string | null; replyCount: number | null };
  /** Canonical agent-readable line: `[target=… msg=… time=… type=…] @sender: content …`. */
  text: string;
  /** The wire envelope, for fields this projection does not name. */
  raw: AgentApiMessageEnvelope;
}

function senderType(value: unknown): RaftSenderType {
  return value === "human" || value === "agent" || value === "system" || value === "third_party_app" ? value : "unknown";
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Normalise an envelope (snake_case wire keys win, camelCase legacy keys fill in) into the formatter's shape. */
export function toAgentMessageLike(envelope: AgentApiMessageEnvelope): AgentMessageLike {
  const raw = envelope as Record<string, unknown>;
  return {
    ...raw,
    message_id: envelope.message_id ?? envelope.id,
    timestamp: envelope.timestamp ?? envelope.createdAt,
    sender_type: envelope.sender_type ?? envelope.senderType,
    sender_name: envelope.sender_name ?? envelope.senderName,
    sender_description: envelope.sender_description ?? envelope.senderDescription ?? null,
    sender_timezone: envelope.sender_timezone ?? envelope.senderTimezone ?? null,
    delegated_by: envelope.delegated_by
      ?? ((envelope as { delegatedBy?: { name?: unknown } | null }).delegatedBy?.name
        ? { name: String((envelope as { delegatedBy: { name: unknown } }).delegatedBy.name) }
        : null),
    task_status: envelope.task_status ?? envelope.taskStatus ?? null,
    task_number: envelope.task_number ?? envelope.taskNumber ?? null,
    task_assignee_id: envelope.task_assignee_id ?? envelope.taskAssigneeId ?? null,
    task_assignee_type: envelope.task_assignee_type ?? envelope.taskAssigneeType ?? null,
    task_assignee_name: envelope.task_assignee_name ?? envelope.taskAssigneeName ?? null,
    task_current_projection: envelope.task_current_projection ?? envelope.taskCurrentProjection ?? null,
    source_tasks: Array.isArray(envelope.source_tasks) ? envelope.source_tasks : null,
  } as AgentMessageLike;
}

/**
 * An envelope carries a reply target only when it names its conversation
 * (`channel_type` + `channel_name`, or a third-party event). Some Server
 * responses embed bare envelopes (for example `recentUnread: [{ content }]`);
 * those must not be rendered with a made-up target.
 */
export function hasAgentMessageIdentity(envelope: AgentApiMessageEnvelope): boolean {
  const like = toAgentMessageLike(envelope);
  if (like.third_party_event) return true;
  if (typeof like.channel_type !== "string" || typeof like.channel_name !== "string" || !like.channel_name) return false;
  if (like.channel_type === "thread" && !like.parent_channel_name) return false;
  return true;
}

/** Project one envelope; `null` when it has no conversation identity (skip it rather than render `#undefined`). */
export function projectRaftMessage(envelope: AgentApiMessageEnvelope, style: RaftHintStyle = "cli"): RaftMessage | null {
  if (!hasAgentMessageIdentity(envelope)) return null;
  const like = toAgentMessageLike(envelope);
  const id = nullableString(like.message_id);
  const taskNumber = nullableNumber(like.task_number);
  const taskStatus = nullableString(like.task_status);
  const raw = envelope as Record<string, unknown>;
  return {
    id,
    shortId: id ? id.slice(0, 8) : null,
    seq: nullableNumber(envelope.seq),
    target: formatAgentMessageTarget(like),
    timestamp: nullableString(like.timestamp),
    sender: {
      type: senderType(like.sender_type),
      name: nullableString(like.sender_name),
      description: nullableString(like.sender_description),
    },
    content: envelope.content ?? "",
    attachments: (envelope.attachments ?? []).map((a) => ({ id: a.id, filename: a.filename })),
    mentioned: typeof raw.mentioned === "boolean" ? raw.mentioned : null,
    task: taskNumber !== null || taskStatus !== null
      ? {
          number: taskNumber,
          status: taskStatus,
          assigneeName: nullableString(like.task_assignee_name),
          assigneeId: nullableString(like.task_assignee_id),
          assigneeType: nullableString(like.task_assignee_type),
        }
      : null,
    thread: { id: nullableString(envelope.threadId), replyCount: nullableNumber(envelope.replyCount) },
    text: formatAgentMessageLine(like, style),
    raw: envelope,
  };
}

export function sortBySeq<T extends { seq: number | null }>(messages: readonly T[]): T[] {
  return [...messages].sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
}

/** Project a list, skipping envelopes without a conversation identity. */
export function projectRaftMessages(envelopes: readonly AgentApiMessageEnvelope[], style: RaftHintStyle = "cli"): RaftMessage[] {
  return envelopes.map((envelope) => projectRaftMessage(envelope, style)).filter((m): m is RaftMessage => m !== null);
}

/** The conversation fields a target string names; `null` for a shape this cannot read. */
function identityFromTarget(target: string): Record<string, string> | null {
  const dm = /^dm:@([^:\s]+)(?::([^:\s]+))?$/.exec(target);
  if (dm) {
    return dm[2]
      ? { channel_type: "thread", channel_name: dm[2], parent_channel_name: dm[1]!, parent_channel_type: "dm" }
      : { channel_type: "dm", channel_name: dm[1]! };
  }
  const channel = /^#([^:\s]+)(?::([^:\s]+))?$/.exec(target);
  if (channel) {
    return channel[2]
      ? { channel_type: "thread", channel_name: channel[2], parent_channel_name: channel[1]!, parent_channel_type: "channel" }
      : { channel_type: "channel", channel_name: channel[1]! };
  }
  return null;
}

/**
 * Project envelopes that all belong to one known conversation. Some Server
 * responses (held previews) send envelopes without conversation fields
 * because the request already named the target; fill them from `target`
 * instead of dropping the message.
 */
export function projectRaftMessagesInTarget(envelopes: readonly AgentApiMessageEnvelope[], target: string, style: RaftHintStyle = "cli"): RaftMessage[] {
  const identity = identityFromTarget(target);
  return envelopes
    .map((envelope) => projectRaftMessage(
      identity && !hasAgentMessageIdentity(envelope) ? { ...envelope, ...identity } as AgentApiMessageEnvelope : envelope,
      style,
    ))
    .filter((m): m is RaftMessage => m !== null);
}
