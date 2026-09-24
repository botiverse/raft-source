import type { AgentInboxFlag, AgentInboxTargetRow, AttentionHint } from "@botiverse/raft-shared";

export {
  AGENT_INBOX_TARGET_ROW_KEYS,
  formatAgentReplyAffordanceSuffix,
  formatAgentInboxDelta,
  formatAgentInboxSnapshot,
  type AgentInboxFlag,
  type AgentInboxTargetRow,
} from "@botiverse/raft-shared";

export type AgentInboxProjectionMessage = {
  seq?: number;
  id?: string;
  message_id?: string;
  channel_id?: string;
  channel_type?: string;
  channel_name?: string;
  parent_channel_id?: string;
  parent_channel_type?: string;
  parent_channel_name?: string;
  sender_type?: string;
  senderType?: string;
  sender_name?: string;
  senderName?: string;
  task_number?: number | null;
  task_status?: string | null;
  mentioned?: boolean;
  non_member_mention?: boolean;
  attention_hint?: AttentionHint;
  third_party_event?: { id?: string; kind?: string } | null;
};

/**
 * Suppressed counts arrive as a SIBLING of the message list, never inside it.
 *
 * A suppressed notification is a property of the TARGET, not of any message --
 * and the daemon never receives those messages at all, so the count cannot be
 * derived here. Synthesising placeholder "suppressed messages" into `messages`
 * would make a non-message into a message (one field, two meanings) and would
 * change the message surface, which this work deliberately does not touch.
 */
export type SuppressedByTarget = ReadonlyMap<string, number>;

/**
 * A count is only usable if it is a positive safe integer.
 *
 * The map's type is `number`, which admits `Infinity`, `1.5`, `-3` and `NaN` --
 * and the renderer would faithfully print "Infinity suppressed (not delivered)".
 * Validation happens HERE rather than being deferred to a future server->daemon
 * parser, because that parser does not exist yet: treating a bare `number` as
 * already-validated would be trusting a check nobody has written.
 *
 * Illegal values fail closed -- the count is dropped rather than rendered -- on
 * the same reasoning as the rest of this field: a wrong number in a surface the
 * agent reads is worse than no number, because it looks like a measurement.
 *
 * KNOWN COST, chosen deliberately rather than overlooked: a dropped count is
 * indistinguishable, to the agent, from no suppression at all. So a bad number
 * makes suppression invisible again -- the exact thing this field exists to
 * prevent. It is chosen because the alternatives are worse: rendering
 * "Infinity suppressed" is nonsense presented as a measurement, and throwing
 * leaves the agent with no snapshot at all.
 *
 * This is currently the one cell here with NO instrument. The real fix is to
 * move validation upstream once the server->daemon parser exists, at which
 * point this concession can be withdrawn.
 */
function usableCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function projectAgentInboxSnapshot(
  messages: readonly AgentInboxProjectionMessage[],
  suppressedByTarget?: SuppressedByTarget,
): AgentInboxTargetRow[] {
  const buckets = new Map<string, AgentInboxProjectionMessage[]>();
  for (const message of messages) {
    const target = formatInboxMessageTarget(message);
    if (!target) continue;
    const bucket = buckets.get(target) ?? [];
    bucket.push(message);
    buckets.set(target, bucket);
  }

  const rows = [...buckets.entries()].map(([target, bucket]) => {
    const row = projectBucket(target, bucket);
    const suppressed = usableCount(suppressedByTarget?.get(target));
    return suppressed === undefined ? row : { ...row, suppressedCount: suppressed };
  });

  // A target whose notifications were ALL suppressed has no messages here, so it
  // yields no row at all -- and "no row" is exactly the invisibility this exists
  // to remove. It is built directly rather than through projectBucket, which
  // requires at least one message to derive its fields from.
  for (const [target, raw] of suppressedByTarget ?? []) {
    const suppressed = usableCount(raw);
    if (suppressed !== undefined && !buckets.has(target)) {
      rows.push({ target, pendingCount: 0, flags: [], suppressedCount: suppressed });
    }
  }

  return rows
    .sort((a, b) => (b.latestSeq ?? 0) - (a.latestSeq ?? 0) || a.target.localeCompare(b.target));
}

function projectBucket(target: string, messages: readonly AgentInboxProjectionMessage[]): AgentInboxTargetRow {
  const sorted = [...messages].sort(compareInboxMessages);
  const first = sorted[0];
  const latest = sorted[sorted.length - 1];
  const flags = new Set<AgentInboxFlag>();
  for (const message of messages) {
    if (message.channel_type === "thread") flags.add("thread");
    if (message.channel_type === "dm") flags.add("dm");
    if (message.task_number || message.task_status) flags.add("task");
    if (message.mentioned === true) flags.add("mention");
    if (message.non_member_mention === true) flags.add("non_member_mention");
  }
  const attentionHint = [...sorted].reverse().find((message) => message.attention_hint)?.attention_hint;
  return stripUndefined({
    target,
    channelId: latest.channel_id ?? latest.parent_channel_id,
    channelType: latest.channel_type,
    pendingCount: messages.length,
    firstPendingMsgId: messageId(first),
    firstPendingSeq: messageSeq(first),
    latestMsgId: messageId(latest),
    latestSeq: messageSeq(latest),
    latestSenderName: latest.sender_name ?? latest.senderName,
    latestSenderType: normalizeSenderType(latest.sender_type ?? latest.senderType),
    flags: [...flags].sort(),
    attentionHint,
  });
}

function compareInboxMessages(a: AgentInboxProjectionMessage, b: AgentInboxProjectionMessage): number {
  return (messageSeq(a) ?? 0) - (messageSeq(b) ?? 0) || (messageId(a) ?? "").localeCompare(messageId(b) ?? "");
}

function formatInboxMessageTarget(message: AgentInboxProjectionMessage): string | null {
  if (message.channel_type === "thread" && message.parent_channel_name && message.channel_name) {
    const shortId = shortMessageId(String(message.channel_name).startsWith("thread-")
      ? String(message.channel_name).slice("thread-".length)
      : String(message.channel_name));
    if (message.parent_channel_type === "dm") return `dm:@${message.parent_channel_name}:${shortId}`;
    return `#${message.parent_channel_name}:${shortId}`;
  }
  if (message.channel_type === "dm" && message.channel_name) return `dm:@${message.channel_name}`;
  if (message.channel_name) return `#${message.channel_name}`;
  return null;
}

function messageId(message: AgentInboxProjectionMessage | undefined): string | undefined {
  if (!message) return undefined;
  return nonEmptyString(message.message_id) ?? nonEmptyString(message.id);
}

function messageSeq(message: AgentInboxProjectionMessage | undefined): number | undefined {
  if (!message || typeof message.seq !== "number" || !Number.isFinite(message.seq) || message.seq <= 0) return undefined;
  return Math.floor(message.seq);
}

function shortMessageId(value: string): string {
  return value.slice(0, 8);
}

function normalizeSenderType(value: string | undefined): AgentInboxTargetRow["latestSenderType"] | undefined {
  return value === "human" || value === "agent" || value === "system" || value === "third_party_app" ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
