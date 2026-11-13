// Canonical message formatting for agent-facing output.
// This is the canonical implementation of the agent-facing message text
// format (the MCP chat-bridge it originally mirrored has been removed) —
// an AX contract, not an implementation detail. Pinned by `_format.test.ts`.

import { T, UUID_A, UUID_B, UUID_C, sampleMessage, sampleMessageChannelThread, sampleMessageDm, sampleMessageDmThread } from "../_axExampleFixtures";
import { axSurface } from "../../core/renderer";
import type {
  AgentApiMessageReaction,
  AgentMessageCardMarker,
  AgentMessageCardUpdatedText,
  AgentMessageLike,
  AgentMessageSourceTaskLike,
  AgentMessageTaskCurrentProjectionLike,
  AgentSearchContinueFilters,
  AgentSearchData,
  AgentSearchResultLike,
  RaftTargetString,
  ChannelCard,
  PeerCard,
  SendAttachment,
} from "@botiverse/raft-shared";
import {
  AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT,
  AGENT_API_MESSAGE_SEARCH_MAX_LIMIT,
  AGENT_MESSAGE_CARD_NOT_STORED_NOTICE,
  formatAgentAttachmentSuffix,
  formatAgentInboxHint,
  formatAgentMessageCardBlock,
  formatAgentMessageCardHeaderFields,
  formatAgentMessageCardUpdated,
  formatAgentMessageLine,
  formatAgentMessageReactionsLine,
  formatAgentMessages,
  formatAgentMessageTarget,
  formatAgentSenderHandle,
  formatAgentTaskAssigneeSuffix,
  formatAgentTaskCurrentProjection,
  formatAgentSearchResults,
  formatAgentSourceTasksSuffix,
  formatHint,
  formatUtcTimestamp,
  MESSAGE_CARD_LIMITS,
  parseAgentTaskRef,
  RAFT_HINTS,
  formatSenderHandleText,
  indentAgentBodyContinuationLines,
  neutralizeAgentRaftRefLiterals,
  renderAgentSearchPreviewText,
  renderChannelCard,
  renderPeerCard,
  renderSendAttachment,
} from "@botiverse/raft-shared/src/agentCliSurface";
import type { AgentApiMessageSearchResponse } from "@botiverse/raft-shared";

// The message-like shapes and the canonical header line live in
// `@botiverse/raft-shared` (`agentMessageText.ts`) so the SDK renders the same
// bytes; this file keeps the `axSurface` registrations and CLI-only formatters.
export type TaskCurrentProjectionLike = AgentMessageTaskCurrentProjectionLike;
export type MessageLike = AgentMessageLike;

// Return type is the structured wire form (not opaque string): a dropped `@`,
// a missing sigil, or a malformed thread suffix in any branch below is now a
// compile error instead of a subtly-wrong target string shipped to agents.
// Structured target shape, not a reply surface: consumed inside other
// formatters and by command routing; typed as RaftTargetString.
export function formatTarget(m: MessageLike): RaftTargetString {
  return formatAgentMessageTarget(m);
}

const formatSenderHandle = formatAgentSenderHandle;
const formatAttachmentSuffix = formatAgentAttachmentSuffix;
const formatTaskAssigneeSuffix = formatAgentTaskAssigneeSuffix;

function formatTaskCurrentProjection(
  projection: TaskCurrentProjectionLike | null | undefined,
  taskNumber?: number | null,
  neutralizeRefs = false,
): string {
  return formatAgentTaskCurrentProjection(projection, taskNumber, neutralizeRefs ? renderAgentSearchPreviewText : undefined);
}

/** Reactions as the envelope carries them: one emoji by one reactor, one by more than are named, and more emoji than are shown. */
const EXAMPLE_REACTIONS = [
  { emoji: "✅", count: 1, reactors: [{ name: "tygg", kind: "human" }] },
  { emoji: "👍", count: 3, reactors: [{ name: "alice", kind: "human" }, { name: "Remy", kind: "agent" }, { name: "bob", kind: "human" }] },
  { emoji: "🎉", count: 2, reactors: [{ name: "carol", kind: "human" }, { name: "dave", kind: "external" }] },
  { emoji: "👀", count: 1, reactors: [{ name: "erin", kind: "human" }] },
  { emoji: "🚀", count: 4 },
];

export const formatMessageLine = axSurface(
  "One received-message line: header bracket + sender + content + suffixes.",
  (m: MessageLike): string => formatAgentMessageLine(m),
  {
    // All four target shapes (@xxchan 8/31): channel, channel thread, dm, dm thread.
    examples: [
      { title: "channel", args: [sampleMessage] },
      { title: "channel thread", args: [sampleMessageChannelThread] },
      { title: "dm", args: [sampleMessageDm] },
      { title: "dm thread", args: [sampleMessageDmThread] },
      { title: "with reactions (more than three emoji, more reactors than named)", args: [{ ...sampleMessage, reactions: EXAMPLE_REACTIONS }] },
    ],
  },
);

export const formatMessages = axSurface(
  "Batch of received-message lines (message check output).",
  (messages: MessageLike[]): string => formatAgentMessages(messages),
  {
    examples: [{ title: "batch incl. agent sender + task bracket + all target shapes", args: [[sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, sender_type: "agent", sender_name: "Alice", sender_description: "example agent role", content: "hi there", task_status: "in_progress", task_number: 42, task_assignee_id: "a-1", task_assignee_type: "agent" }, { ...sampleMessageChannelThread, seq: 1202 }, { ...sampleMessageDm, message_id: UUID_A, seq: 1203 }, { ...sampleMessageDmThread, seq: 1204 }]] }],
  },
);

/**
 * `message check` hands over a bounded batch, oldest first per conversation;
 * the server reports how many conversations still have unread after it.
 */
export const formatInboxHint = axSurface(
  "Still-unread line appended to message check when conversations remain unread beyond the returned batch.",
  (hint: { unread_conversations: number }): string => formatAgentInboxHint(hint),
  {
    examples: [{ args: [{ unread_conversations: 12 }] }, { title: "singular", args: [{ unread_conversations: 1 }] }],
  },
);

/**
 * App items come from a Raft daemon's inbox; an external agent has no daemon.
 * Said explicitly so an absent pending-app-items line is not read as "none".
 */
export const formatAppItemsUnavailable = axSurface(
  "message check line for external agents: app items are not available (no Raft daemon).",
  (): string => "App items: not available for external agents.",
  {
    examples: [{ args: [] }],
  },
);

// --- History formatting (matches MCP read_history output) ---

export interface HistoryMessage {
  seq?: number;
  id?: string;
  message_id?: string;
  createdAt?: string;
  timestamp?: string;
  senderType?: string;
  sender_type?: string;
  senderName?: string;
  sender_name?: string;
  senderDescription?: string | null;
  sender_description?: string | null;
  content?: string;
  attachments?: Array<{ id: string; filename: string }>;
  taskStatus?: string | null;
  taskNumber?: number | null;
  taskAssigneeType?: string | null;
  taskAssigneeId?: string | null;
  taskAssigneeName?: string | null;
  task_assignee_name?: string | null;
  taskCurrentProjection?: TaskCurrentProjectionLike | null;
  threadId?: string | null;
  replyCount?: number | null;
  /** RFC 082: a card message (`card=r<revision>` in the header; `content` is its fallback; the card's own text under it). */
  message_card?: AgentMessageCardMarker | null;
  /** The message's reactions, one entry per emoji; printed under it (formatAgentMessageReactionsLine). */
  reactions?: AgentApiMessageReaction[] | null;
  [key: string]: unknown;
}

// Match the server's `parseChannelRef`: only the LAST colon can introduce a
// thread suffix, and that suffix must be exactly 8 hex characters. Parent
// channel/DM names may themselves contain colons, so `[^:]+` is incorrect.
export function isThreadTargetRef(channel: string): boolean {
  const prefixLength = channel.startsWith("#")
    ? 1
    : /^dm:@/i.test(channel) ? 4 : -1;
  if (prefixLength < 0) return false;
  const targetRest = channel.slice(prefixLength);
  const lastColon = targetRest.lastIndexOf(":");
  return lastColon > 0 && /^[0-9a-f]{8}$/i.test(targetRest.slice(lastColon + 1));
}

function isAgentEventTarget(channel: string): boolean {
  return channel.startsWith("agent-event:");
}

function buildReplyTarget(channel: string, messageId: string | undefined): string | null {
  if (!messageId) return null;
  if (isThreadTargetRef(channel)) return null;
  // Task v2: a task's conversation has no threads; its messages are replied to with `raft task reply`.
  if (parseAgentTaskRef(channel)) return null;
  // One app event has no thread to reply in.
  if (isAgentEventTarget(channel)) return null;
  return `${channel}:${messageId.slice(0, 8)}`;
}

function formatHistoryMessageLine(channel: string, m: HistoryMessage, index: number, total: number): string {
  const senderName = m.senderName ?? m.sender_name ?? "unknown";
  const senderDescription = m.senderDescription ?? m.sender_description ?? null;
  const messageId = m.id ?? m.message_id ?? "-";
  const createdAt = m.createdAt ?? m.timestamp ?? null;
  const senderType = m.senderType ?? m.sender_type ?? null;
  const headerParts = [
    `${index + 1}/${total}`,
    `seq=${m.seq ?? "-"}`,
    `msg=${messageId}`,
    `time=${createdAt ? formatUtcTimestamp(createdAt) : "-"}`,
  ];
  if (senderType) headerParts.push(`type=${senderType}`);
  // RFC 082: a card message is marked here, never in the body (`card=r3 updated=…` once replaced).
  const cardFields = formatAgentMessageCardHeaderFields(m.message_card).trim();
  if (cardFields) headerParts.push(cardFields);
  // No `threadId=`: the thread channel's own id is a second address for the
  // same thread, and agents replied to it instead of `replyTarget` (the root
  // message's short id), which the daemon then recorded as a different target
  // (2026-10-14). `replyTarget` is the one address to use.
  if ((m.replyCount ?? 0) > 0) headerParts.push(`replyCount=${m.replyCount}`);
  const replyTarget = buildReplyTarget(channel, messageId);
  if (replyTarget) headerParts.push(`replyTarget=${replyTarget}`);

  const attachSuffix = formatAttachmentSuffix(m.attachments);
  const assigneeName = m.taskAssigneeName ?? m.task_assignee_name ?? null;
  // Task v2 (source_tasks present): every task hanging under the message, by ref.
  const sourceTasks = Array.isArray(m.source_tasks) ? m.source_tasks as AgentMessageSourceTaskLike[] : null;
  const taskSuffix = sourceTasks?.length
    ? formatAgentSourceTasksSuffix(sourceTasks, channel)
    : m.taskStatus
      ? ` [task #${m.taskNumber} status=${m.taskStatus}${formatTaskAssigneeSuffix(m.taskAssigneeId, assigneeName)}]`
      : "";
  const senderTimezone = typeof m.senderTimezone === "string" ? m.senderTimezone : typeof m.sender_timezone === "string" ? m.sender_timezone : null;
  const handle = formatSenderHandleText(senderName, senderDescription, senderTimezone);
  // RFC 082 §4.3: what the card says, under the body (`card:`, then its markdown).
  const cardBlock = formatAgentMessageCardBlock(m.message_card, m.content);
  return `[${headerParts.join(" ")}] ${handle}: ${indentAgentBodyContinuationLines(m.content ?? "")}${attachSuffix}${taskSuffix}${cardBlock}${formatTaskCurrentProjection(m.taskCurrentProjection)}${formatAgentMessageReactionsLine(m.reactions)}`;
}

export interface HistoryData {
  messages?: HistoryMessage[];
  has_more?: boolean;
  has_older?: boolean;
  has_newer?: boolean;
  historyLimited?: boolean;
  historyLimitMessage?: string;
  last_read_seq?: number | null;
  unread_after_seq?: number | null;
  read_through_seq?: number | null;
  model_seen_up_to_seq?: number | null;
}

function seqBoundary(messages: HistoryMessage[], edge: "first" | "last"): number | string {
  const message = edge === "first" ? messages[0] : messages[messages.length - 1];
  return typeof message?.seq === "number" && Number.isFinite(message.seq) ? message.seq : "-";
}

function seqRange(messages: HistoryMessage[]): string {
  const first = seqBoundary(messages, "first");
  const last = seqBoundary(messages, "last");
  return first === last ? String(first) : `${first}-${last}`;
}

// `Older: raft message read --target "#ops" --before 41`: the read that
// continues the window in one direction (task targets: `raft task read`),
// with the window size the read asked for.
function historyCursorLine(
  channel: string,
  label: "Older" | "Newer",
  flag: "before" | "after",
  anchor: number | string,
  limit: number | undefined,
): string {
  if (typeof anchor !== "number") return `${label} messages exist.`;
  return `${label}: ${formatHint(RAFT_HINTS.messageRead({ target: channel, [flag]: anchor, limit }))}`;
}

const TOP_LEVEL_COVERAGE = "Coverage: top-level messages in this target only; thread replies are excluded and must be read from their thread targets.";

/**
 * What a read of `channel` says it leaves out: the sentence for a top-level
 * channel or DM, null for a thread, task or app event target (their rows say
 * what they are). The read prints it once per context (`ax/readCoverage.ts`).
 */
export function topLevelCoverageSentence(channel: string): string | null {
  const isTopLevel = !parseAgentTaskRef(channel) && !isThreadTargetRef(channel) && !isAgentEventTarget(channel);
  return isTopLevel ? TOP_LEVEL_COVERAGE : null;
}

export const formatChannelCard = axSurface(
  "Channel card printed before a read: the first read of the channel (or of a thread in it) in this model context, or the first after the card changed.",
  (card: ChannelCard, changed: boolean): string => `${renderChannelCard(card, { changed }).join("\n")}\n\n`,
  {
    examples: [
      { title: "first read in this context", args: [{ id: "c-1", name: "general", type: "channel", description: "Company-wide announcements. Post release notes here; questions go to #help." }, false] },
      { title: "after the description changed", args: [{ id: "c-1", name: "general", type: "channel", description: "Company-wide announcements only." }, true] },
      { title: "archived private channel without a description", args: [{ id: "c-2", name: "incident-42", type: "private", archived: true }, false] },
    ],
  },
);

export const formatSentChannelCard = axSurface(
  "Channel card after a sent message: the send named a card version other than the channel's current one (changed since this context saw it, or not yet seen: a first send with nothing unread, or one sent with --anyway).",
  (card: ChannelCard, changed: boolean): string => `\n${renderChannelCard(card, { changed }).join("\n")}\n`,
  {
    examples: [
      { title: "the card changed since this context saw it", args: [{ id: "c-1", name: "general", type: "channel", description: "Company-wide announcements only." }, true] },
    ],
  },
);

export const formatPeerCard = axSurface(
  "DM peer card printed before a DM read: this model context has seen nothing of the peer yet (no card, no message from them).",
  (card: PeerCard): string => `${renderPeerCard(card).join("\n")}\n\n`,
  {
    examples: [
      { title: "a human peer", args: [{ kind: "human", name: "richard", description: "Founder. Prefers short updates.", timezone: "Asia/Shanghai" }] },
      { title: "an agent peer", args: [{ kind: "agent", name: "Scout", description: "Bug triage worker." }] },
    ],
  },
);

export const formatSentPeerCard = axSurface(
  "DM peer card after a sent message: sent with --anyway before this context saw the peer.",
  (card: PeerCard): string => `\n${renderPeerCard(card).join("\n")}\n`,
  {
    examples: [{ args: [{ kind: "human", name: "richard", description: "Founder. Prefers short updates.", timezone: "Asia/Shanghai" }] }],
  },
);

export const formatSendAttachment = axSurface(
  "Context shown after every sent message for a runtime that does not report context compaction: not part of the message; the conversation's cards and latest messages before it, within 2000 characters.",
  (attachment: SendAttachment): string | null => {
    const lines = renderSendAttachment(attachment);
    return lines.length > 0 ? `\n${lines.join("\n")}\n` : null;
  },
  {
    examples: [{
      args: [{
        target: "#ops",
        channelCard: { id: "c-ops", name: "ops", type: "channel", description: "Release coordination. Post go/no-go here." },
        messages: [
          { seq: 40, sender: "richard", timestamp: "2026-10-15T09:00:00.000Z", content: "deploy at 5?" },
          { seq: 41, sender: "scout", timestamp: "2026-10-15T09:02:00.000Z", content: "canary is green" },
        ],
      }],
    }],
  },
);

/** When the Server flags a history-limited read without saying why. */
const HISTORY_LIMITED_FALLBACK = "Message history is limited on this plan.";

export const formatHistory = axSurface(
  "Read window: numbered lines; an Older:/Newer: line for each direction that has more (and, on a default read, the read for unread messages before the window), nothing when the whole conversation is on screen.",
  (
  channel: string,
  data: HistoryData,
  opts?: {
    around?: string;
    after?: string | number;
    before?: string | number;
    unread?: boolean;
    alreadyShownSeqs?: ReadonlySet<number>;
    /** The read's `--limit`, carried into the commands it prints. */
    limit?: number;
    /** Leave out the top-level Coverage line: this context was already shown it (`ax/readCoverage.ts`). */
    omitTopLevelCoverage?: boolean;
  },
): string => {
  const coverage = opts?.omitTopLevelCoverage ? null : topLevelCoverageSentence(channel);
  if (opts?.unread) return formatUnreadWindow(channel, data, coverage, opts.alreadyShownSeqs);
  if (!data.messages || data.messages.length === 0) {
    // An empty window on a plan that hides older history says why.
    const empty = data.historyLimited
      ? `No messages in this target's history window. ${data.historyLimitMessage || HISTORY_LIMITED_FALLBACK}`
      : "No messages in this target.";
    return coverage ? `${coverage}\n\n${empty}` : empty;
  }

  const messages = data.messages;
  const count = messages.length;
  const minSeq = seqBoundary(messages, "first");
  const maxSeq = seqBoundary(messages, "last");
  const hasOlder = Boolean(data.has_older ?? (data.has_more && !opts?.after));
  const hasNewer = Boolean(data.has_newer ?? (data.has_more && Boolean(opts?.after)));

  const formatted = messages
    .map((m, index) => formatHistoryMessageLine(channel, {
      ...m,
      senderName: m.senderName ?? m.sender_name ?? "unknown",
      senderDescription: m.senderDescription ?? m.sender_description ?? null,
    }, index, count))
    .join("\n");

  // One line per direction that has more; none when it is all on screen.
  const limit = opts?.limit;
  const headerLines: string[] = [];
  if (hasOlder) headerLines.push(historyCursorLine(channel, "Older", "before", minSeq, limit));
  // A default read (the latest page) moves the read position past unread
  // messages older than the window; name the read that shows them.
  const lastRead = data.last_read_seq ?? 0;
  if (opts?.after === undefined && opts?.before === undefined && opts?.around === undefined
    && lastRead > 0 && typeof minSeq === "number" && lastRead < minSeq - 1) {
    headerLines.push(`Unread before this window: ${formatHint(RAFT_HINTS.messageRead({ target: channel, after: lastRead, limit }))}`);
  }
  if (hasNewer) headerLines.push(historyCursorLine(channel, "Newer", "after", maxSeq, limit));
  if (coverage) headerLines.push(coverage);
  if (opts?.around) {
    headerLines.push(`Around: ${opts.around}. Your read position did not move. To read new messages and mark them read, use --unread.`);
  }
  if (data.historyLimited) {
    headerLines.push(data.historyLimitMessage || HISTORY_LIMITED_FALLBACK);
  }

  return headerLines.length > 0 ? `${headerLines.join("\n")}\n\n${formatted}` : formatted;
},
  {
    // Window examples cover all four target shapes (@xxchan 8/31); the dm
    // window also shows the replyTarget affordance, which thread windows omit.
    examples: [{ title: "unread window (--unread), more unread remain", args: ["#general:00000000", { messages: [sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, content: "second message" }], has_older: true, has_newer: true, last_read_seq: 1199, unread_after_seq: 1199, model_seen_up_to_seq: 1201 }, { unread: true }] }, { title: "unread window (--unread), newest message too recent to mark read", args: ["#general", { messages: [sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, content: "second message" }], has_older: true, has_newer: false, last_read_seq: 1199, unread_after_seq: 1199, read_through_seq: 1200, model_seen_up_to_seq: 1201 }, { unread: true }] }, { title: "unread window (--unread), a message already shown last time is folded", args: ["#general", { messages: [sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, content: "second message" }], has_older: true, has_newer: false, last_read_seq: 1199, unread_after_seq: 1199, read_through_seq: 1201, model_seen_up_to_seq: 1201 }, { unread: true, alreadyShownSeqs: new Set([1200]) }] }, { title: "unread window (--unread), nothing unread", args: ["#general", { messages: [], has_older: true, has_newer: false, last_read_seq: 1201, unread_after_seq: 1201 }, { unread: true }] }, { title: "unread window (--unread), started behind the plan's history window", args: ["#general", { messages: [sampleMessage], has_older: false, has_newer: false, last_read_seq: 900, unread_after_seq: 900, read_through_seq: 1200, model_seen_up_to_seq: 1200, historyLimited: true, historyLimitMessage: "Older messages are hidden: this server is on the Free plan, which keeps the last 30 days. Upgrading to Pro restores the full history." }, { unread: true }] }, { title: "channel window, older messages exist", args: ["#general", { messages: [sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, content: "second message" }], has_older: true, has_newer: false, last_read_seq: 1200 }] }, { title: "channel window (default read), unread messages before it", args: ["#general", { messages: [sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, content: "second message" }], has_older: true, has_newer: false, last_read_seq: 1100 }] }, { title: "channel thread window (--around anchor)", args: ["#general:00000000", { messages: [sampleMessage], has_older: true, has_newer: true }, { around: "00000000" }] }, { title: "dm window with a threaded reply", args: ["dm:@richard", { messages: [{ ...sampleMessage, content: "hey, can you help?", replyCount: 2 }], has_older: false, has_newer: false }] }, { title: "a message with reactions (one line under it)", args: ["#general", { messages: [{ ...sampleMessage, reactions: EXAMPLE_REACTIONS.slice(0, 2) }], has_older: false, has_newer: false }] }, { title: "dm thread window", args: ["dm:@richard:00000000", { messages: [sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, content: "DM thread reply" }], has_older: false, has_newer: false }] }, { title: "a card message (RFC 082): card=r2 in the header, the card's own text under the body", args: ["#builds", { messages: [{ ...sampleMessage, sender_type: "agent", sender_name: "hands", content: "Build 1.19.0 failed", message_card: { revision: 2, updated_at: T, text: "Build 1.19.0 · [Failed]\n\n⚠️ Font file missing: NotoSans_CJK.ttf\n\n`v1.19.0+11900001` · 2026-11-05 09:10:00Z – 2026-11-05 09:12:00Z\n\n[Open build log](https://ci.example.com/builds/42) · Retry (disabled: Builds are paused)" } }], has_older: false, has_newer: false }] }],
  },
);

/**
 * `raft message read --unread`: what is unread in one conversation, starting
 * right after the agent's read position. Reading moves that position, so the
 * continuation is the same command again, never a seq that can go stale.
 */
function formatUnreadWindow(
  channel: string,
  data: HistoryData,
  coverage: string | null,
  alreadyShownSeqs: ReadonlySet<number> = new Set(),
): string {
  const readThrough = data.unread_after_seq ?? data.last_read_seq ?? 0;
  const messages = data.messages ?? [];
  // A read that started behind the plan's history window skipped what the
  // window hides; the server says so (and may offer the upgrade card), and
  // the note follows the Coverage line as in an ordinary window.
  const scope = [coverage, data.historyLimited ? data.historyLimitMessage || HISTORY_LIMITED_FALLBACK : null]
    .filter(Boolean)
    .join("\n");
  const scoped = (body: string): string => (scope ? `${scope}\n\n${body}` : body);
  if (messages.length === 0) {
    // Not the start: an empty read can still move the position (over what the
    // history window hides).
    const readNow = data.read_through_seq ?? readThrough;
    return scoped(`No unread messages in ${channel}. You have read through seq ${readNow}.`);
  }
  // Messages this agent was already shown (they came back because they were
  // too recent to mark read last time) are folded into one line, so a repeat
  // is not mistaken for a new message and answered twice.
  const folded = messages.filter((m) => typeof m.seq === "number" && alreadyShownSeqs.has(m.seq));
  const shown = messages.filter((m) => !folded.includes(m));
  const newPosition = typeof data.read_through_seq === "number" ? data.read_through_seq : data.model_seen_up_to_seq;
  const shownCount = messages.length - folded.length;
  const movedTo = shownCount > 0 && typeof newPosition === "number" && newPosition > readThrough
    ? `Read position: seq ${readThrough} → ${newPosition}. To re-read these: ${formatHint(RAFT_HINTS.messageRead({ target: channel, after: readThrough }))}`
    : null;
  // The re-read command is printed once: on the read-position line when there
  // is one, otherwise here.
  const foldNote = folded.length > 0
    ? `${folded.length} message${folded.length === 1 ? "" : "s"} you were already shown (seq ${seqRange(folded)}) ${folded.length === 1 ? "is" : "are"} not repeated.${movedTo ? "" : ` To see ${folded.length === 1 ? "it" : "them"} again: ${formatHint(RAFT_HINTS.messageRead({ target: channel, after: readThrough }))}`}`
    : null;
  const footer = data.has_newer
    ? `More unread remain. Next: ${formatHint(RAFT_HINTS.messageRead({ target: channel, unread: true }))}`
    : null;
  if (shown.length === 0) {
    return scoped(`No new unread messages in ${channel}. ${foldNote}${footer ? `\n${footer}` : ""}`);
  }
  const count = shown.length;
  const formatted = shown
    .map((m, index) => formatHistoryMessageLine(channel, {
      ...m,
      senderName: m.senderName ?? m.sender_name ?? "unknown",
      senderDescription: m.senderDescription ?? m.sender_description ?? null,
    }, index, count))
    .join("\n");
  const header = `Unread window: ${count} returned, seq ${seqRange(shown)}, oldest to newest, starting after your read position (seq ${readThrough}).`;
  // Rows newer than the read position were too recent to mark read now (seq
  // order is not commit order). The Server marks them read a few seconds
  // later, unless an older message committed late (readPositionSettle.ts);
  // only then, or when the next read comes within those seconds, do they come
  // back, folded into one line. Say that, not that they always come back.
  const unsettled = typeof newPosition === "number"
    ? shown.filter((m) => typeof m.seq === "number" && m.seq > newPosition).length
    : 0;
  const settleNote = unsettled > 0
    ? `${unsettled} newest message${unsettled === 1 ? " was" : "s were"} too recent to mark read at once; ${unsettled === 1 ? "it" : "they"} should be marked read in a few seconds. If your next --unread shows ${unsettled === 1 ? "it" : "them"} again, ${unsettled === 1 ? "it is" : "they are"} folded into one line: nothing new.`
    : null;
  const end = footer ?? (unsettled > 0 ? null : "No more unread in this target.");
  return `${[header, scope].filter(Boolean).join("\n")}\n\n${[foldNote, formatted].filter(Boolean).join("\n")}\n\n${[movedTo, settleNote, end].filter(Boolean).join("\n")}`;
}

// --- Search result rendering (agent-facing AX readout) ---
// The text lives in `@botiverse/raft-shared` (`agentText/search.ts`) so the
// SDK renders the same bytes; this file keeps the axSurface registration.

type SearchResult = AgentSearchResultLike;
type SearchData = AgentSearchData;
type _DeclaredKeys<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };
type _UnmodelledSearchTopLevelFields = Exclude<_DeclaredKeys<AgentApiMessageSearchResponse>, keyof SearchData>;
const _searchDataModelsContractTopLevel: [_UnmodelledSearchTopLevelFields] extends [never] ? true : never = true;
void _searchDataModelsContractTopLevel;
export type { SearchResult, SearchData };

export const formatSearchResults = axSurface(
  "Search results with <match>/<omit /> preview markup.",
  (query: string, data: SearchData, offset?: number, sort?: string, limit?: number, filters?: AgentSearchContinueFilters): string =>
    formatAgentSearchResults(query, data, offset, sort, limit, "cli", filters),
  {
    // Results cover all four source shapes (@xxchan 8/31): channel, channel
    // thread, dm, dm thread — each renders a distinct Source: line.
    examples: [{ args: ["deploy", { results: [
      { id: UUID_A, seq: 1200, createdAt: T, channelType: "channel", channelName: "general", senderName: "richard", senderType: "human", content: "we should deploy on tuesday after the review", match: { start: 10, end: 16 } },
      { id: UUID_B, seq: 1201, createdAt: T, channelType: "thread", channelName: "thread-00000000", parentChannelType: "channel", parentChannelName: "general", senderName: "Alice", senderType: "agent", content: "deploy checklist is green, ready when you are", match: { start: 0, end: 6 } },
      { id: UUID_C, seq: 1202, createdAt: T, channelType: "dm", channelName: "richard", senderName: "richard", senderType: "human", content: "can you own the deploy tomorrow?", match: { start: 16, end: 22 } },
      { id: UUID_A, seq: 1203, createdAt: T, channelType: "thread", channelName: "thread-55555555", parentChannelType: "dm", parentChannelName: "richard", senderName: "Alice", senderType: "agent", content: "deploy done, readback posted", match: { start: 0, end: 6 } },
    ], hasMore: false }] }],
  },
);

// --- Send-path diagnostics (moved verbatim from send.ts, print-seam S3) ---

// Bytes observed before this deadline make --send-draft fail closed. Once the
// deadline wins, later bytes are outside the observation window and stay unread.
export const SEND_DRAFT_STDIN_OBSERVATION_MS = 1_000;

export const formatSendDraftStdinDeadlineDiagnostic = axSurface(
  "send --send-draft stdin-deadline diagnostic (stderr).",
  (
  observationWindowMs = SEND_DRAFT_STDIN_OBSERVATION_MS,
): string => {
  return (`No stdin bytes were detected within ${observationWindowMs}ms; the stored draft will now be sent.`);
},
  {
    examples: [{ args: [] }],
  },
);

export const DRAFT_REPLACED_EXCERPT_LIMIT = 160;

function replacedDraftRecoveryLine(recoveryFilePath: string | null): string {
  return recoveryFilePath
    ? `Recovery file: ${JSON.stringify(recoveryFilePath)}`
    : "Recovery copy: unavailable (local save failed; sending continued).";
}

/**
 * A target holds exactly ONE active draft. Before normal send replaces that
 * slot, the previous body is archived best-effort in local agent-state. The
 * terminal only gets a bounded excerpt plus the archive path; a local archive
 * failure is reported honestly but never blocks delivery.
 */
export const formatDraftReplacedWarning = axSurface(
  "Draft-replaced warning with a bounded excerpt and local recovery file.",
  (target: string, previousContent: string, recoveryFilePath: string | null): string => {
    const compact = previousContent.trim().replace(/\s+/gu, " ");
    const excerpt = compact.length > DRAFT_REPLACED_EXCERPT_LIMIT
      ? `${compact.slice(0, DRAFT_REPLACED_EXCERPT_LIMIT)}…`
      : compact;
    return ([
      `Warning: replacing an unsent draft for ${target}.`,
      `Previous draft excerpt (${previousContent.length} chars): ${excerpt}`,
      replacedDraftRecoveryLine(recoveryFilePath),
    ].join("\n"));
  },
  {
    examples: [{ args: ["#general", "the previously drafted body", "/home/agent/replaced-drafts/draft.txt"] }],
  },
);

export const formatDraftReplacedSuccess = axSurface(
  "Successful send receipt line for a replaced draft and its local recovery file.",
  (recoveryFilePath: string | null): string =>
    `Replaced an unsent draft. ${replacedDraftRecoveryLine(recoveryFilePath)}`,
  {
    examples: [{ args: ["/home/agent/replaced-drafts/draft.txt"] }],
  },
);

/** What a held `message send` continuation ended with, as `cont` reports it (message/_sendContinuation.ts). */
export type SendContinuationOutcome =
  | { status: "sent" | "committed"; target: string; messageId: string | null }
  | { status: "not_sent" };

export const formatSendContinuationOutcome = axSurface(
  "How a held `message send` continuation (the pilot) ended: not sent, or sent with its message id when its full receipt was printed in an earlier call (a retry of the same answer); nothing more when this call printed the receipt.",
  (outcome: SendContinuationOutcome, shown: { printedAbove: boolean }): string => {
    if (outcome.status === "not_sent") return "Not sent.\n";
    if (shown.printedAbove) return "";
    const id = outcome.messageId ? ` Message ID: ${outcome.messageId}` : "";
    return outcome.status === "committed"
      ? `Message commit confirmed for ${outcome.target}.${id}\n`
      : `Message sent to ${outcome.target}.${id}\n`;
  },
  {
    examples: [
      { title: "the agent chose not to send", args: [{ status: "not_sent" }, { printedAbove: false }] },
      { title: "a retry of the answer that sent it", args: [{ status: "sent", target: "#ops", messageId: UUID_A }, { printedAbove: false }] },
    ],
  },
);

// --- Card messages (RFC 082): `message send --card` and `message update-card` ---

export const formatMessageCardSentHint = axSurface(
  "After `message send --card` is sent and the receipt says its card was stored (`messageCard`): how to replace the card later (from the revision stored now), and that doing so notifies no one.",
  (messageId: string, revision: number = 1): string =>
    `To update this card later (up to ${MESSAGE_CARD_LIMITS.updateWindowDays} days; notifies no one): raft message update-card --message-id ${messageId.slice(0, 8)} --card <file> --expected-revision ${revision}`,
  {
    examples: [
      { title: "a new card message", args: [UUID_A] },
      { title: "a replay (same key) after the card was updated", args: [UUID_A, 3] },
    ],
  },
);

export const formatMessageCardNotStored = axSurface(
  "After `message send --card` is sent but the receipt has no `messageCard`: the text was sent and no card was stored (a Server older than card messages ignores the card). Part of the success output, not an error.",
  (): string => AGENT_MESSAGE_CARD_NOT_STORED_NOTICE,
  {
    examples: [{ args: [] }],
  },
);

export const formatCardStdinDeadlineDiagnostic = axSurface(
  "`message send --card` / `message update-card` stderr diagnostic: no text arrived on stdin in time, so Raft derives the card's text.",
  (action: "sent" | "updated", observationWindowMs: number = SEND_DRAFT_STDIN_OBSERVATION_MS): string =>
    `No text arrived on stdin within ${observationWindowMs}ms; the card is ${action} with the text Raft derives from it.`,
  {
    examples: [{ title: "a card send", args: ["sent"] }, { title: "a card update", args: ["updated"] }],
  },
);

export const formatMessageCardUpdated = axSurface(
  "`message update-card` succeeded: the card's new revision, and that nobody was notified (naming each @mention of the new text). Also the retry rule's answer when an earlier run already made the same change.",
  (input: AgentMessageCardUpdatedText): string => formatAgentMessageCardUpdated(input),
  {
    examples: [
      { title: "updated", args: [{ messageId: UUID_A, revision: 3, notice: "Updating notifies no one. To tell someone, send a new message." }] },
      {
        title: "an @mention in the new text",
        args: [{ messageId: UUID_A, revision: 2, notice: "Updating notifies no one. @alice in the new text was not notified; to tell them, send a new message." }],
      },
      {
        title: "an earlier run already made this change (retry after a lost answer)",
        args: [{ messageId: UUID_A, revision: 4, notice: "Updating notifies no one. To tell someone, send a new message.", alreadyApplied: true }],
      },
    ],
  },
);
