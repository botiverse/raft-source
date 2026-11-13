import { parseSlackEditTimestamp } from "./slackMessageEditTimestamp";
import { extractSlackUsergroupMentions } from "./slackMentionTokens";

/** Intermediate shapes only. Unrecognized input must remain in durable custody. */
export type VerifiedSlackMessage = {
  kind: "message";
  author: Record<string, unknown>;
  providerMessageId: string;
  providerThreadId: string | null;
  providerEditedTs: string | null;
  providerFileIds: string[];
  providerAgentMentions: ReturnType<typeof extractSlackUsergroupMentions>;
  content: string;
  createdAt: string;
};

export type VerifiedSlackReaction = {
  kind: "reaction";
  operation: "add" | "remove";
  providerMessageId: string;
  externalActorId: string;
  providerReactionKey: string;
  eventOccurredAt: string;
  eventSequence: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nonEmpty(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max ? value : null;
}
const TIMESTAMP = /^[0-9]{1,20}\.[0-9]{1,20}$/u;

/** Parse a reaction without deciding whether its actor or binding is authorized. */
export function parseVerifiedSlackReaction(value: unknown): VerifiedSlackReaction | null {
  const envelope = record(value);
  const event = record(envelope?.event);
  if (envelope?.type !== "event_callback"
    || (event?.type !== "reaction_added" && event?.type !== "reaction_removed")) return null;
  const item = record(event.item);
  const providerMessageId = nonEmpty(item?.ts, 160);
  const externalActorId = nonEmpty(event.user, 160);
  const providerReactionKey = nonEmpty(event.reaction, 160);
  const clock = typeof event.event_ts === "string" ? /^(\d{1,10})\.(\d{1,6})$/u.exec(event.event_ts) : null;
  if (item?.type !== "message" || !nonEmpty(item.channel, 160)
    || !providerMessageId || !TIMESTAMP.test(providerMessageId) || !externalActorId
    || !providerReactionKey || !/^[a-z0-9_+:-]+$/u.test(providerReactionKey) || !clock) return null;
  const seconds = Number(clock[1]);
  const micros = Number(clock[2]!.padEnd(6, "0"));
  const sequence = seconds * 1_000_000 + micros;
  const date = new Date(seconds * 1_000 + Math.floor(micros / 1_000));
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || !Number.isFinite(date.getTime())) return null;
  return { kind: "reaction", operation: event.type === "reaction_added" ? "add" : "remove",
    providerMessageId, externalActorId, providerReactionKey,
    eventOccurredAt: date.toISOString(), eventSequence: sequence };
}

/**
 * Parse an already verified event without consulting mutable provider state.
 * Null means the caller must retain the encrypted receipt; it is not proof
 * that dropping the event is safe. Never classify an author's authority here.
 */
export function parseVerifiedSlackMessage(value: unknown): VerifiedSlackMessage | null {
  const envelope = record(value);
  const outer = record(envelope?.event);
  if (envelope?.type !== "event_callback" || outer?.type !== "message") return null;
  const edit = outer.subtype === "message_changed";
  const body = edit ? record(outer.message) : outer;
  if (!body) return null;
  const subtype = body.subtype;
  if (subtype !== undefined && subtype !== "file_share" && subtype !== "bot_message") return null;
  const messageId = nonEmpty(body.ts, 160);
  if (!messageId || !TIMESTAMP.test(messageId)) return null;
  const threadId = body.thread_ts === undefined || body.thread_ts === messageId
    ? null : nonEmpty(body.thread_ts, 160);
  if (body.thread_ts !== undefined && !threadId && body.thread_ts !== messageId) return null;
  if (threadId && !TIMESTAMP.test(threadId)) return null;
  const edited = record(body.edited);
  const editedTs = edit ? parseSlackEditTimestamp(edited?.ts ?? outer.event_ts ?? outer.ts) : null;
  if (edit && !editedTs) return null;
  let fileIds: string[] = [];
  if (body.files !== undefined) {
    if (!Array.isArray(body.files) || body.files.length > 10) return null;
    const ids = body.files.map(item => nonEmpty(record(item)?.id, 320));
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) return null;
    fileIds = ids as string[];
  }
  if (!edit && subtype === "file_share" && fileIds.length === 0) return null;
  // The current edit pipeline cannot reconcile a changed file set. Keep the
  // signed receipt for operator-visible replay rather than silently dropping
  // file information while applying the text portion.
  if (edit && fileIds.length > 0) return null;
  // Other-App bot messages can carry files even when their subtype is
  // bot_message; preserve those files instead of rejecting the whole body.
  const rawContent = nonEmpty(body.text, 40_000);
  if ((body.text !== undefined && typeof body.text !== "string")
    || (typeof body.text === "string" && body.text.trim() && !rawContent)
    || (!rawContent && !fileIds.length)) return null;
  const content = rawContent ?? "[Attachment]";
  // PostgreSQL/JS dates retain milliseconds; preserve those from Slack's
  // fractional timestamp instead of moving every message to the second start.
  // The complete Slack timestamp remains the provider message identity.
  const [seconds, fraction = ""] = messageId.split(".");
  const date = new Date(Number(seconds) * 1_000 + Number(fraction.padEnd(3, "0").slice(0, 3)));
  if (!Number.isFinite(date.getTime())) return null;
  return { kind: "message", author: body, providerMessageId: messageId, providerThreadId: threadId,
    providerEditedTs: editedTs, providerFileIds: edit ? [] : fileIds,
    providerAgentMentions: extractSlackUsergroupMentions(content), content, createdAt: date.toISOString() };
}
