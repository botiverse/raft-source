// RFC 081 (D4, D12, D16): the text of one `inbox read` page and of an
// `inbox dismiss`, shared by the CLI (`raft inbox read` / `raft inbox
// dismiss`) and the SDK (`inbox.read`), so an agent reads the same page
// either way. `style` picks how the next commands are written: as CLI
// commands, or as tool calls.

import type {
  AgentApiInboxDismissResponse,
  AgentApiInboxReadEntry,
  AgentApiInboxReadResponse,
} from "./agentApiContract";
import { foldAgentOneLineText, formatAgentMessageLine, formatAgentMessageTarget, formatAgentReactorName, type AgentMessageLike } from "./agentMessageText";
import { formatHint, RAFT_HINTS, type RaftHint, type RaftHintStyle } from "./agentOps/hint";
import { toAgentMessageLike } from "./agentOps/message";
import {
  messageIdOfReactionNoticeInboxTarget,
  REACTION_NOTICE_WITHDRAWN_SENTENCE,
  reactionNoticeOfAppEvent,
  type ReactionAgentNotice,
} from "./reactionAgentNotice";

export type AgentInboxReadEntry = AgentApiInboxReadEntry & AgentMessageLike;

export type AgentInboxReadInput = {
  response: AgentApiInboxReadResponse;
  /** The page's entries as message lines take them (the CLI and the SDK map the envelopes the same way). */
  entries: readonly AgentInboxReadEntry[];
  /** Now, for the reaction view's times (dated when not today, UTC); defaults to the clock. */
  nowMs?: number;
};

const APP_READ_KINDS: ReadonlySet<string> = new Set(["app", "app_fallback", "event"]);

/**
 * A conversation page's entries are history rows with only `channelId`, so
 * their own fields can't name the conversation: each takes the page's
 * canonical `target`, for its `[target=…]` header and for whatever the client
 * records as seen. A reminder page's entries are its fires, addressed by the
 * reminder (`reminder:<id>`). App and event entries carry their own
 * `agent-event:<id>` and are returned as they are.
 */
const PAGE_TARGET_KINDS: ReadonlySet<string> = new Set(["conversation", "reminder"]);
export function inboxReadEntriesWithTarget<E extends AgentMessageLike>(response: Pick<AgentApiInboxReadResponse, "kind" | "target">, entries: readonly E[]): E[] {
  // A conversation page returns history rows (`id`, `createdAt`,
  // `senderType`, `senderName`): normalize them the way `messages.read` does,
  // so the line reads exactly as `raft message read` prints it.
  const normalized = entries.map((entry) => toAgentMessageLike(entry as never) as E);
  if (!PAGE_TARGET_KINDS.has(response.kind)) return normalized;
  return normalized.map((entry) => (entry.display_target ? entry : { ...entry, display_target: response.target }));
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function formatLeft(response: AgentApiInboxReadResponse): string {
  return `${response.remaining}${response.remainingCapped ? "+" : ""} left`;
}

/** `From Stamp, about #proj:#232.` for an app item; null when the server named neither. */
function formatReadSource(response: AgentApiInboxReadResponse): string | null {
  if (!APP_READ_KINDS.has(response.kind)) return null;
  const from = response.app ? foldAgentOneLineText(response.app.name) : "";
  const about = response.related?.target ?? "";
  if (from) return `From ${from}${about ? `, about ${about}` : ""}.`;
  return about ? `About ${about}.` : null;
}

function formatFullDataLine(entries: readonly AgentMessageLike[], style: RaftHintStyle): string {
  const only = entries.length === 1 ? formatAgentMessageTarget(entries[0]!) : null;
  if (only?.startsWith("agent-event:")) {
    return `Full data of this event: ${formatHint(RAFT_HINTS.messageRead({ target: only }), style)}`;
  }
  return `Full data of one event: ${formatHint(RAFT_HINTS.messageRead({ target: "agent-event:<id>" }), style)}`;
}

/** `10:02Z` today (UTC), `2026-11-09 10:02Z` on another day; empty when the time doesn't parse. */
function formatReactedAt(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const at = new Date(ms).toISOString();
  const day = at.slice(0, 10);
  return `${day === new Date(nowMs).toISOString().slice(0, 10) ? "" : `${day} `}${at.slice(11, 16)}Z`;
}

/**
 * A reaction notices item (`app:system.reaction-notices/msg/<id>`, one per
 * reacted message) read as what it is, from each entry's `app_event`
 * (reactionAgentNotice.ts) instead of the Server's one-line summaries:
 *
 *   Reactions to your message in #proj-x (3f2a1c9e), new since you last read (each line starts "  · ", so an emoji can't pass for a header):
 *     · ✅ tygg · 10:02Z
 *     · 👍 Remy (agent) · 10:05Z
 *     "Deploy plan for v1.21.63 is ready…"
 *   Next: reply in its thread: raft message send --target "#proj-x:3f2a1c9e" <<<'<your reply>'
 *
 * Reactors by handle without `@` (an agent marked `(agent)`); every emoji,
 * name and the excerpt folded to one line, each line indented so none starts
 * at column 0. Null (the generic page) for any other item, and when an entry
 * has no `app_event` or one that doesn't parse (an older Server, another
 * app's event).
 */
function formatReactionNoticeReadText(
  response: AgentApiInboxReadResponse,
  entries: readonly AgentMessageLike[],
  style: RaftHintStyle,
  nowMs: number,
): string | null {
  if (entries.length === 0 || messageIdOfReactionNoticeInboxTarget(response.target) === null) return null;
  const notices: ReactionAgentNotice[] = [];
  for (const entry of entries) {
    const notice = reactionNoticeOfAppEvent(entry.app_event);
    if (!notice) return null;
    notices.push(notice);
  }
  // Every entry is about the one message; the newest names its conversation as it is now.
  const { message } = notices[notices.length - 1]!;
  const id8 = foldAgentOneLineText(message.id).slice(0, 8);
  const conversation = message.conversation ? foldAgentOneLineText(message.conversation) : null;
  const where = conversation ?? (response.related?.target ? foldAgentOneLineText(response.related.target) : null);
  const lines = [`Reactions to your message${where ? ` in ${where}` : ""} (${id8}), new since you last read:`];
  for (const notice of notices) {
    const time = formatReactedAt(notice.reactedAt, nowMs);
    lines.push(`  · ${foldAgentOneLineText(notice.emoji)} ${formatAgentReactorName(notice.reactor.name)}${notice.reactor.kind === "agent" ? " (agent)" : ""}${time ? ` · ${time}` : ""}`);
  }
  const excerpt = foldAgentOneLineText(message.excerpt);
  if (excerpt) lines.push(`  "${excerpt}${message.excerptTruncated ? "…" : ""}"`);
  const replyTarget = message.replyTarget ? foldAgentOneLineText(message.replyTarget) : null;
  if (response.remaining > 0 && !response.consumed) {
    lines.push(`Next: run the same command for the rest: ${formatHint(RAFT_HINTS.inboxRead({ target: response.target }), style)}`);
  } else if (replyTarget) {
    lines.push(`Next: reply in its thread: ${formatHint(RAFT_HINTS.messageReply({ target: replyTarget }), style)}`);
  } else if (conversation) {
    lines.push(`Next: ${formatHint(RAFT_HINTS.messageRead({ target: conversation, around: { shown: id8, id: message.id } }), style)}`);
  }
  return lines.join("\n");
}

/**
 * Raft's own words for a 410 `EXPIRED` answer to `inbox read --target
 * <target>`, where it has them: a reaction notices item whose reactions were
 * all removed before it was read. Null for every other item (the caller's
 * generic sentence stands). Used by the CLI (`raft inbox read`) and the SDK
 * (`inbox.read`); `nextAction` is the CLI form of `nextHint`.
 */
export function inboxReadExpiredRefusal(target: string): { message: string; nextAction: string; nextHint: RaftHint } | null {
  if (messageIdOfReactionNoticeInboxTarget(target) === null) return null;
  const nextHint = RAFT_HINTS.inboxList();
  return { message: REACTION_NOTICE_WITHDRAWN_SENTENCE, nextAction: formatHint(nextHint), nextHint };
}

/** One page of one inbox item: the entries as message lines; how many are left and the command for them only when some are. */
export function formatAgentInboxReadText(input: AgentInboxReadInput, style: RaftHintStyle = "cli"): string {
  const { response } = input;
  const entries = inboxReadEntriesWithTarget(response, input.entries);
  const target = response.target;
  const reactions = formatReactionNoticeReadText(response, entries, style, input.nowMs ?? Date.now());
  if (reactions !== null) return reactions;
  if (entries.length === 0) {
    return response.kind === "conversation"
      ? [`Nothing unread on ${target}.`, `Next: to re-read it, ${formatHint(RAFT_HINTS.messageRead({ target }), style)}`].join("\n")
      : `Nothing unread on ${target}.`;
  }
  const reminder = response.kind === "reminder";
  // The count is said only when a page is left: a last page is all there is.
  const head: string[] = [];
  if (reminder) head.push(`Showing ${entries.length} fired, not acked on ${target}; it stays listed until you ack it.`);
  else if (response.remaining > 0) head.push(`Showing ${entries.length} of ${response.unreadBefore} unread on ${target}; ${formatLeft(response)}.`);
  const source = formatReadSource(response);
  if (source) head.push(source);
  const body = entries.flatMap((entry) => [
    formatAgentMessageLine(entry, style),
    ...(entry.ack ? [`  ack: ${formatHint(RAFT_HINTS.reminderAck({ id: entry.ack.id, revision: entry.ack.revision }), style)}`] : []),
  ]);
  // App events print one line each (no payload); the full data of one is a
  // single-event read away. A page of one event names it, ready to run.
  const fullData = APP_READ_KINDS.has(response.kind) ? formatFullDataLine(entries, style) : null;
  let next: string | null = null;
  if (reminder) {
    next = response.nextCursor
      ? `Next: ${formatHint(RAFT_HINTS.inboxRead({ target, cursor: response.nextCursor }), style)}`
      : "Next: ack each revision once handled (the ack: lines above).";
  } else if (response.remaining > 0 && !response.consumed) {
    next = `Next: run the same command for the rest: ${formatHint(RAFT_HINTS.inboxRead({ target }), style)}`;
  }
  const tail = [fullData, next].filter((line): line is string => line !== null);
  return [head.join("\n"), body.join("\n"), tail.join("\n")].filter((block) => block.length > 0).join("\n\n");
}

/** How many items were dismissed without being read, what was skipped or is left, one Next line. */
export function formatAgentInboxDismissedText(response: AgentApiInboxDismissResponse, style: RaftHintStyle = "cli"): string {
  const lines = [`Dismissed ${plural(response.dismissed, "item")}; not read.`];
  if (response.skippedNeedsAck > 0) {
    lines.push(`Skipped ${plural(response.skippedNeedsAck, "reminder")} that ${response.skippedNeedsAck === 1 ? "needs" : "need"} an ack.`);
  }
  if (response.remaining > 0) lines.push(`${response.remaining} more to dismiss: run the same command again.`);
  lines.push(`Next: ${formatHint(RAFT_HINTS.inboxList(), style)}`);
  return lines.join("\n");
}
