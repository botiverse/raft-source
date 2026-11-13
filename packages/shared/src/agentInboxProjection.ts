// Projection of delivered inbox messages into per-target inbox rows (the
// "Inbox update" / snapshot rows). Shared by the daemon (managed agents) and
// the server's External Agent inbox notice push, so both render the same rows.
import type { AgentInboxFlag, AgentInboxTargetRow } from "./agentInbox";
import type { AttentionHint } from "./attentionDependencyOracle";
import { formatAgentMessageTaskRef } from "./agentMessageText";

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
  /** Task v2: tasks hanging under the message (servers with task v2 conversations only). */
  source_tasks?: readonly unknown[] | null;
  /** Task v2: the message is in this task's own conversation (its target is the task ref). */
  task_conversation_number?: number | null;
  mentioned?: boolean;
  non_member_mention?: boolean;
  attention_hint?: AttentionHint;
  /**
   * `inbox_item_unread` (#wg-ax:#24): how many unread events the Server counts
   * on that inbox item when it pushed this one. Events that joined the item
   * without a wake are never pushed, so the row's count comes from here.
   */
  third_party_event?: { id?: string; kind?: string; client_id?: string; client_name?: string; inbox_item_target?: string; inbox_item_unread?: number } | null;
  /** Message body; read only by the latest-message previews below. */
  content?: string;
  /** A preview shows text only, so a message with attachments is never shown whole. */
  attachments?: readonly unknown[] | null;
};

/**
 * Task #387: the start of the latest pending message of a target, so an agent
 * woken by a notice can see an un-@'d "stop" without opening the target.
 *
 * It is a PREVIEW, not a read: rendering it advances no cursor and the message
 * stays pending. Only a preview that shows the whole message counts as seen
 * (projectAgentInboxWholePreviewMessages). It is computed at render time for
 * the managed runtime notice only and is never put on AgentInboxTargetRow, so
 * the row wire schema and the external inbox push stay content-free.
 */
export type AgentInboxLatestPreview = {
  senderName?: string;
  text: string;
  truncated: boolean;
};

export const AGENT_INBOX_LATEST_PREVIEW_MAX_CHARS = 80;

// C0/C1 controls, line/paragraph separators and bidi overrides/isolates: none
// may reach the notice, where they could forge lines or reorder what is shown.
const PREVIEW_UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu;

export function formatAgentInboxPreviewText(
  content: string,
  maxChars: number = AGENT_INBOX_LATEST_PREVIEW_MAX_CHARS,
): { text: string; truncated: boolean } | null {
  const flat = content.replace(PREVIEW_UNSAFE_CHARS, " ").replace(/\s+/gu, " ").trim();
  if (!flat) return null;
  // Latin sentence ends need a following space (so "v1.2" is not an end);
  // CJK ones (。！？) do not.
  const sentence = /^(.+?(?:[.!?](?=\s|$)|[\u3002\uff01\uff1f]))/u.exec(flat)?.[1] ?? flat;
  const chars = [...sentence];
  const text = chars.length > maxChars ? chars.slice(0, maxChars).join("").trimEnd() : sentence;
  return { text, truncated: text.length < flat.length };
}

function latestPreviewedMessageByTarget<T extends AgentInboxProjectionMessage>(
  messages: readonly T[],
): Map<string, T> {
  const latestByTarget = new Map<string, T>();
  for (const message of messages) {
    if (message.third_party_event) continue;
    const target = formatInboxMessageTarget(message);
    if (!target) continue;
    const current = latestByTarget.get(target);
    if (!current || compareInboxMessages(current, message) < 0) latestByTarget.set(target, message);
  }
  return latestByTarget;
}

export function projectAgentInboxLatestPreviews(
  messages: readonly AgentInboxProjectionMessage[],
): Map<string, AgentInboxLatestPreview> {
  const previews = new Map<string, AgentInboxLatestPreview>();
  for (const [target, message] of latestPreviewedMessageByTarget(messages)) {
    if (typeof message.content !== "string") continue;
    const preview = formatAgentInboxPreviewText(message.content);
    if (!preview) continue;
    const senderName = message.sender_name ?? message.senderName;
    previews.set(target, { ...(senderName ? { senderName } : {}), ...preview });
  }
  return previews;
}

/**
 * The messages a notice's previews show whole: each target's latest message
 * when its preview is not cut and it has no attachments. The model has read
 * all of such a message, so the daemon records it as seen (exact id only),
 * and the agent's reply is not held for the message it is answering. It stays
 * pending and unread: the notice still names it and `--unread` still returns it.
 */
export function projectAgentInboxWholePreviewMessages<T extends AgentInboxProjectionMessage>(
  messages: readonly T[],
): T[] {
  const whole: T[] = [];
  for (const message of latestPreviewedMessageByTarget(messages).values()) {
    if (typeof message.content !== "string") continue;
    if ((message.attachments?.length ?? 0) > 0) continue;
    const preview = formatAgentInboxPreviewText(message.content);
    if (preview && !preview.truncated) whole.push(message);
  }
  return whole;
}

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

export const AGENT_INBOX_ITEM_TARGET_MAX_CHARS = 512;

// Whitespace, C0/C1 controls, line/paragraph separators, zero-width and bidi marks, overrides and
// isolates, and what would break out of the double-quoted `--target "..."`
// the read line prints (`"`, `\`, `` ` ``, `$`).
const ITEM_TARGET_UNSAFE = String.raw`\s\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff"\\$` + "`";

/** `app:<key>` or `app:<key>/<ref>`, nothing empty, nothing unsafe. */
const APP_INBOX_ITEM_TARGET = new RegExp(String.raw`^app:([^/${ITEM_TARGET_UNSAFE}]+)(?:/([^${ITEM_TARGET_UNSAFE}]+))?$`, "u");

export type ThirdPartyEventInboxItemTarget = {
  /** `app:<key>/<ref>` or `app:<key>`, as the Server sent it. */
  target: string;
  /** The `<ref>` part; absent for an app's fallback item. */
  objectRef?: string;
};

/**
 * RFC 081: the inbox item a third-party event is listed under, from the
 * Server's `third_party_event.inbox_item_target`. It is server data rendered
 * into agent text, so anything but a well-formed `app:` target (a string, at
 * most AGENT_INBOX_ITEM_TARGET_MAX_CHARS, no whitespace or control
 * characters, non-empty key and ref) counts as absent: the event then stays
 * in the grouped third-party events row.
 */
export function thirdPartyEventInboxItemTarget(
  message: Pick<AgentInboxProjectionMessage, "third_party_event">,
): ThirdPartyEventInboxItemTarget | null {
  const raw: unknown = message.third_party_event?.inbox_item_target;
  if (typeof raw !== "string" || raw.length > AGENT_INBOX_ITEM_TARGET_MAX_CHARS) return null;
  const match = APP_INBOX_ITEM_TARGET.exec(raw);
  if (!match) return null;
  return match[2] ? { target: raw, objectRef: match[2] } : { target: raw };
}

export type AgentInboxSnapshotOptions = {
  /**
   * RFC 081, inbox items on (the daemon passes it only then): a third-party
   * event listed as an inbox item (thirdPartyEventInboxItemTarget) is bucketed
   * under its `app:` item instead of the grouped third-party events row. Off
   * (default, and the server's External Agent push): the field is ignored.
   */
  appInboxItemTargets?: boolean;
};

export function projectAgentInboxSnapshot(
  messages: readonly AgentInboxProjectionMessage[],
  suppressedByTarget?: SuppressedByTarget,
  options: AgentInboxSnapshotOptions = {},
): AgentInboxTargetRow[] {
  const buckets = new Map<string, AgentInboxProjectionMessage[]>();
  for (const message of messages) {
    const target = (options.appInboxItemTargets === true ? thirdPartyEventInboxItemTarget(message)?.target : undefined)
      ?? formatInboxMessageTarget(message);
    if (!target) continue;
    const bucket = buckets.get(target) ?? [];
    bucket.push(message);
    buckets.set(target, bucket);
  }

  const rows = [...buckets.entries()].map(([target, bucket]) => {
    const row = withServerUnread(projectBucket(target, bucket), bucket, options);
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

/**
 * An app inbox item's count is the Server's (#wg-ax:#24): later events on an
 * unread item join it without being pushed, so the pushed ones under-count
 * it. The largest well-formed `inbox_item_unread` among them, never below
 * what is here, so the wake notice reads as `inbox check` does.
 */
function withServerUnread(row: AgentInboxTargetRow, bucket: readonly AgentInboxProjectionMessage[], options: AgentInboxSnapshotOptions): AgentInboxTargetRow {
  if (options.appInboxItemTargets !== true || !row.target.startsWith("app:")) return row;
  let unread = row.pendingCount;
  for (const message of bucket) {
    const raw: unknown = message.third_party_event?.inbox_item_unread;
    if (typeof raw === "number" && Number.isInteger(raw) && raw > unread && raw <= AGENT_INBOX_ITEM_UNREAD_MAX) unread = raw;
  }
  return unread === row.pendingCount ? row : { ...row, pendingCount: unread };
}

/** No item holds more unread events than this (an agent keeps at most 7 days of them); anything above is not believed. */
const AGENT_INBOX_ITEM_UNREAD_MAX = 100_000;

/** A row the snapshot buckets under an app inbox item (only with `appInboxItemTargets`). */
export function isAppInboxItemTargetRow(row: Pick<AgentInboxTargetRow, "target">): boolean {
  return row.target.startsWith("app:");
}

/**
 * RFC 081, inbox items on, for a list that sits beside the Server's own (the
 * daemon's `inbox check` snapshot): the Server lists every third-party event
 * it marks with an inbox item, so they leave both the rows and the pending
 * messages, and the grouped third-party row counts only the events the
 * Server does not list. The same projection the wake-up notice renders its
 * rows from, so the two grouped counts cannot drift.
 */
export function projectAgentInboxSnapshotWithoutAppItems<T extends AgentInboxProjectionMessage>(
  messages: readonly T[],
): { rows: AgentInboxTargetRow[]; pending: T[] } {
  return {
    rows: projectAgentInboxSnapshot(messages, undefined, { appInboxItemTargets: true }).filter((row) => !isAppInboxItemTargetRow(row)),
    pending: messages.filter((message) => thirdPartyEventInboxItemTarget(message) === null),
  };
}

function projectBucket(target: string, messages: readonly AgentInboxProjectionMessage[]): AgentInboxTargetRow {
  const sorted = [...messages].sort(compareInboxMessages);
  const first = sorted[0];
  const latest = sorted[sorted.length - 1];
  const flags = new Set<AgentInboxFlag>();
  for (const message of messages) {
    // Task v2: a task's own conversation is a task row, not a thread row.
    if (message.channel_type === "thread" && !message.task_conversation_number) flags.add("thread");
    if (message.task_conversation_number) flags.add("task");
    if (message.channel_type === "dm") flags.add("dm");
    if (message.task_number || message.task_status || message.source_tasks?.length) flags.add("task");
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

/**
 * The canonical send target of one delivered inbox message (`#name`,
 * `#name:<8hex>`, `dm:@peer`, `dm:@peer:<8hex>`) -- the same string the CLI's
 * `formatTarget` prints for it and `/send` resolves. DM names are already the
 * recipient-resolved peer refs (with `~agent`/`~human` when disambiguated).
 * Null when the message has no conversation name (e.g. third-party events).
 */
export function formatInboxMessageTarget(message: AgentInboxProjectionMessage): string | null {
  // Task v2: a task's own conversation is addressed by its ref (`#name:#7`).
  const taskRef = formatAgentMessageTaskRef(message);
  if (taskRef) return taskRef;
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
