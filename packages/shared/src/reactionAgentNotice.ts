// What an agent is told when someone reacts to a message it sent
// (#wg-ax:#26): the reaction notices app's notice, carried as the `app_event`
// (`{ ...notice, app: "reaction-notices", kind: "message" }`) the Server
// attaches to a `system.reaction-notices` notification, and what a client
// needs to write it itself instead of the Server's one-line summary. This
// schema is the one the app registers (agentNotice.schema); the Server sets
// `app_event` only on a payload that passes it.
//
// Who gets one: the agent that sent the message (a message sent by a person,
// or by an assistant as its owner, tells nobody), for a reaction someone else
// adds, a person or another agent. Its own reaction tells it nothing. A
// removal sends nothing and takes the removed reaction's unread notice back.
//
// Where: one inbox item per reacted message,
// `app:system.reaction-notices/msg/<message id>` (reactionNoticeInboxTarget),
// about the message's conversation. More reactions while the item is unread
// join it without a new wake (RFC 081 D7).
//
// Only on servers with `agent_reaction_notices_v0` and inbox items on.
import { z } from "zod";

import { foldAgentOneLineText } from "./agentMessageText";
import { lazySchema } from "./lazySchema";

/** The app's registry id (`FirstPartyApp.id`, `app_event.app`, `enabledApps`). */
export const REACTION_NOTICES_APP_ID = "reaction-notices";
/** The app's key in the agent event queue and in inbox targets (`third_party_event.client_id`). */
export const REACTION_NOTICES_SYSTEM_APP = "system.reaction-notices";
/** What a notice is about (`app_event.kind`): a message, core's own object. */
export const REACTION_NOTICE_KIND = "message";
/** A notice stays readable this long (7 days, the most an app event is kept). */
export const REACTION_NOTICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The same reaction (message, reactor, emoji) added again within this long of its notice adds no notice. */
export const REACTION_NOTICE_READD_WINDOW_MS = 10 * 60 * 1000;
/** The message excerpt a notice carries (`message.excerpt`), in characters. */
export const REACTION_NOTICE_EXCERPT_MAX_CHARS = 160;
/** The part of the excerpt the one-line summary quotes, in characters. */
export const REACTION_NOTICE_SUMMARY_EXCERPT_MAX_CHARS = 40;

const OBJECT_REF_PREFIX = "msg/";
const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The notice's `object.ref`: `msg/<message id>`, the key its inbox item groups by. */
export function reactionNoticeObjectRef(messageId: string): string {
  return `${OBJECT_REF_PREFIX}${messageId}`;
}

/** The message a reaction notice's `object.ref` names, or null when it is not one. */
export function messageIdOfReactionNoticeObjectRef(objectRef: string): string | null {
  if (!objectRef.startsWith(OBJECT_REF_PREFIX)) return null;
  const id = objectRef.slice(OBJECT_REF_PREFIX.length);
  return MESSAGE_ID_RE.test(id) ? id : null;
}

/** The inbox item of a message's reactions: `app:system.reaction-notices/msg/<message id>`. */
export function reactionNoticeInboxTarget(messageId: string): string {
  return `app:${REACTION_NOTICES_SYSTEM_APP}/${reactionNoticeObjectRef(messageId)}`;
}

const INBOX_TARGET_PREFIX = `app:${REACTION_NOTICES_SYSTEM_APP}/`;

/** The message a reaction notices inbox target names (`app:system.reaction-notices/msg/<id>`), or null for any other target. */
export function messageIdOfReactionNoticeInboxTarget(target: string): string | null {
  const trimmed = target.trim();
  return trimmed.startsWith(INBOX_TARGET_PREFIX) ? messageIdOfReactionNoticeObjectRef(trimmed.slice(INBOX_TARGET_PREFIX.length)) : null;
}

/**
 * What `inbox read` says when the Server answers 410 `EXPIRED` for a
 * reaction notices item: every unread reaction on it was removed (withdrawn
 * with its reaction) before the agent read it. Said by the CLI and the SDK's
 * `inbox.read` alike (agentInboxReadText.ts, inboxReadExpiredRefusal).
 */
export const REACTION_NOTICE_WITHDRAWN_SENTENCE = "There is nothing to read here: the reactions on this message were removed before you read them, or the notice expired (notices are kept 7 days).";

export const reactionAgentNoticeSchema = lazySchema("reactionAgentNoticeSchema", () => z.object({
  /** The message reacted to: one the receiving agent sent. */
  message: z.object({
    id: z.string(),
    /**
     * The conversation it is in, as the agent's own server has it: a thread's
     * own id for a reply in a thread; a Joint Channel by the server's copy
     * (for a reply in a Joint Channel's thread, the channel's copy).
     */
    channelId: z.string(),
    /**
     * That conversation as the agent addressed it when the reaction came in
     * (`#proj-x`, `#proj-x:3f2a1c9e` for a reply in a thread, `dm:@name`,
     * `#board:#7`), or null when it could not be named. The inbox row's
     * `related.target` is the same conversation, checked again at listing.
     */
    conversation: z.string().nullable(),
    /**
     * Where a reply about this message goes: its own thread
     * (`<conversation>:<id8>`), or for a reply already in a thread that
     * thread. Null when `conversation` is, or the conversation takes no threads.
     */
    replyTarget: z.string().nullable(),
    /** The message's text on one line, at most REACTION_NOTICE_EXCERPT_MAX_CHARS; empty for a message without text. */
    excerpt: z.string(),
    excerptTruncated: z.boolean(),
  }).passthrough(),
  /** Who reacted: never the receiving agent. `name` is the handle, written without `@`. */
  reactor: z.object({
    id: z.string(),
    kind: z.enum(["human", "agent"]),
    name: z.string(),
  }).passthrough(),
  emoji: z.string(),
  /** When the reaction was added (ISO time). */
  reactedAt: z.string(),
}));

export type ReactionAgentNotice = z.infer<typeof reactionAgentNoticeSchema>;
/** AgentMessage.app_event of a reaction notice. */
export type ReactionAgentAppEvent = { app: typeof REACTION_NOTICES_APP_ID; kind: typeof REACTION_NOTICE_KIND } & ReactionAgentNotice;

/** Text on one line cut to `maxChars` characters (code points), at a word end when one is near the limit. */
export function reactionNoticeExcerpt(text: string, maxChars: number): { excerpt: string; truncated: boolean } {
  const chars = Array.from(foldAgentOneLineText(text));
  if (chars.length <= maxChars) return { excerpt: chars.join(""), truncated: false };
  const cut = chars.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const kept = lastSpace >= Math.floor(maxChars * 0.6) ? cut.slice(0, lastSpace) : cut;
  return { excerpt: kept.join("").trimEnd(), truncated: true };
}

/**
 * The notice's one line, the event summary (wake text and the inbox row's
 * preview): `tygg reacted ✅ to your message in #proj-x: "Deploy plan for
 * v1.21.63 is ready for…"`. The reactor is named without `@`, so the line
 * pings no one when copied.
 */
export function formatReactionNoticeSummary(notice: ReactionAgentNotice): string {
  const where = notice.message.conversation ? ` in ${notice.message.conversation}` : "";
  const head = `${notice.reactor.name} reacted ${notice.emoji} to your message${where}`;
  const quoted = reactionNoticeExcerpt(notice.message.excerpt, REACTION_NOTICE_SUMMARY_EXCERPT_MAX_CHARS);
  if (!quoted.excerpt) return head;
  return `${head}: "${quoted.excerpt}${quoted.truncated || notice.message.excerptTruncated ? "…" : ""}"`;
}

/** The reaction notice an entry carries as its `app_event` (`{ app: "reaction-notices", kind: "message", ...notice }`), or null when it carries none or one that doesn't parse. */
export function reactionNoticeOfAppEvent(appEvent: unknown): ReactionAgentNotice | null {
  if (!appEvent || typeof appEvent !== "object" || Array.isArray(appEvent)) return null;
  const { app, kind, ...fields } = appEvent as Record<string, unknown>;
  if (app !== REACTION_NOTICES_APP_ID || kind !== REACTION_NOTICE_KIND) return null;
  const parsed = reactionAgentNoticeSchema.safeParse(fields);
  return parsed.success ? parsed.data : null;
}
