// Canonical message formatting for agent-facing output.
// This is the canonical implementation of the agent-facing message text
// format (the MCP chat-bridge it originally mirrored has been removed) —
// an AX contract, not an implementation detail. Pinned by `_format.test.ts`.

import { T, UUID_A, UUID_B, UUID_C, sampleMessage, sampleMessageChannelThread, sampleMessageDm, sampleMessageDmThread } from "../_axExampleFixtures.js";
import { axSurface } from "../../core/renderer.js";
import {
  formatUtcTimestamp,
  formatAgentReplyAffordanceSuffix,
  renderThirdPartyInertJson,
  type RaftTargetString,
} from "@botiverse/raft-shared";

interface TaskCurrentProjectionLike {
  title?: string;
  description?: string | null;
  revision?: number;
  superseded?: boolean;
  amendedAt?: string | null;
  amended_at?: string | null;
  amendedByType?: string | null;
  amended_by_type?: string | null;
  amendedByName?: string | null;
  amended_by_name?: string | null;
  source?: string;
}

export interface MessageLike {
  channel_type?: string;
  channel_name?: string;
  parent_channel_type?: string;
  parent_channel_name?: string;
  message_id?: string;
  timestamp?: string;
  sender_type?: string;
  sender_name?: string;
  sender_description?: string | null;
  content?: string;
  attachments?: Array<{ id: string; filename: string }>;
  task_status?: string | null;
  task_number?: number | null;
  task_assignee_id?: string | null;
  task_assignee_type?: string | null;
  task_assignee_name?: string | null;
  task_current_projection?: TaskCurrentProjectionLike | null;
  non_member_mention?: boolean;
  third_party_event?: {
    id: string;
    kind: string;
    client_id: string;
    client_name: string;
    external_event_id?: string | null;
    payload_hash: string;
    payload?: Record<string, unknown>;
    expires_at: string;
    source?: {
      client_id?: string;
      client_name?: string;
      oauth_client_id?: string;
      access_token_id_hash?: string | null;
      resource?: string;
    };
  };
  [key: string]: unknown;
}

function toLocalTimeWithOffset(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${offset}`;
}

// Return type is the structured wire form (not opaque string): a dropped `@`,
// a missing sigil, or a malformed thread suffix in any branch below is now a
// compile error instead of a subtly-wrong target string shipped to agents.
// Structured target shape, not a reply surface: consumed inside other
// formatters and by command routing; typed as RaftTargetString.
export function formatTarget(m: MessageLike): RaftTargetString {
  if (m.third_party_event) {
    return `agent-event:${m.third_party_event.id.slice(0, 8)}` as RaftTargetString;
  }
  if (m.channel_type === "thread" && m.parent_channel_name) {
    const shortId = m.channel_name?.startsWith("thread-") ? m.channel_name.slice(7) : m.channel_name;
    if (m.parent_channel_type === "dm") {
      return `dm:@${m.parent_channel_name}:${shortId}` as RaftTargetString;
    }
    return `#${m.parent_channel_name}:${shortId}` as RaftTargetString;
  }
  if (m.channel_type === "dm") {
    return `dm:@${m.channel_name}` as RaftTargetString;
  }
  return `#${m.channel_name}` as RaftTargetString;
}

function formatSenderHandle(m: MessageLike): string {
  const name = m.sender_name ?? "unknown";
  const desc = m.sender_description ?? null;
  return desc ? `@${name} — ${desc}` : `@${name}`;
}

function formatAttachmentSuffix(attachments: Array<{ id: string; filename: string }> | undefined): string {
  if (!attachments?.length) return "";
  return ` [${attachments.length} attachment${attachments.length > 1 ? "s" : ""}: ${attachments.map((a) => `${a.filename} (id:${a.id})`).join(", ")} — use raft attachment view to download]`;
}

function formatTaskAssigneeSuffix(assigneeId?: string | null, assigneeName?: string | null): string {
  if (!assigneeId) return "";
  return assigneeName ? ` assignee=@${assigneeName}` : " assignee=<unresolved>";
}

function formatTaskCurrentProjection(
  projection: TaskCurrentProjectionLike | null | undefined,
  taskNumber?: number | null,
  neutralizeRefs = false,
): string {
  if (!projection?.superseded) return "";
  const revision = Number.isInteger(projection.revision) ? projection.revision : "?";
  const source = projection.source ?? "tasks_current_projection";
  const actorName = projection.amendedByName ?? projection.amended_by_name ?? null;
  const actorType = projection.amendedByType ?? projection.amended_by_type ?? null;
  const actor = actorName
    ? neutralizeRefs ? `user:${actorName}` : `@${actorName}`
    : actorType === "system" ? "system" : "<unresolved>";
  const amendedAt = projection.amendedAt ?? projection.amended_at ?? null;
  const lines = [
    `[${taskNumber ? `task #${taskNumber} ` : "task "}superseded: current projection rev=${revision} source=${source} actor=${actor} time=${amendedAt ? formatUtcTimestamp(amendedAt) : "-"}]`,
    `Current title: ${neutralizeRefs ? renderPreviewText(projection.title ?? "") : projection.title ?? ""}`,
  ];
  if (projection.description != null) {
    lines.push(`Current description: ${neutralizeRefs ? renderPreviewText(projection.description) : projection.description}`);
  }
  return `\n${lines.join("\n")}`;
}

export const formatMessageLine = axSurface(
  "One received-message line: header bracket + sender + content + suffixes.",
  (m: MessageLike): string => {
  if (m.third_party_event) {
    const msgId = m.message_id ? m.message_id.slice(0, 8) : m.third_party_event.id.slice(0, 8);
    const time = m.timestamp ? formatUtcTimestamp(m.timestamp) : "-";
    const event = m.third_party_event;
    const content = m.content ?? "";
    const source = event.source;
    const sourceSuffix = source?.resource
      ? `; resource=${source.resource}${source.access_token_id_hash ? `; access_token_id_hash=${source.access_token_id_hash}` : ""}`
      : "";
    const provenance = `kind=${event.kind}; payload_hash=${event.payload_hash}${sourceSuffix}`;
    return (`[target=agent-event:${event.id.slice(0, 8)} msg=${msgId} time=${time} type=third_party_app] @${event.client_id} — ${event.client_name}: ${provenance}\n${content}${event.payload ? `\npayload:\n${renderThirdPartyInertJson(event.payload)}` : ""}`);
  }
  const target = formatTarget(m);
  const msgId = m.message_id ? m.message_id.slice(0, 8) : "-";
  const time = m.timestamp ? formatUtcTimestamp(m.timestamp) : "-";
  const senderType = ` type=${m.sender_type}`;
  const content = m.content ?? "";
  const attachSuffix = formatAttachmentSuffix(m.attachments);
  const taskSuffix = m.task_status
    ? ` [task #${m.task_number} status=${m.task_status}${formatTaskAssigneeSuffix(m.task_assignee_id, m.task_assignee_name)}]`
    : "";
  return (`[target=${target} msg=${msgId} time=${time}${senderType}] ${formatSenderHandle(m)}: ${content}${attachSuffix}${taskSuffix}${formatAgentReplyAffordanceSuffix(m)}${formatTaskCurrentProjection(m.task_current_projection)}`);
},
  {
    // All four target shapes (@xxchan 8/31): channel, channel thread, dm, dm thread.
    examples: [
      { title: "channel", args: [sampleMessage] },
      { title: "channel thread", args: [sampleMessageChannelThread] },
      { title: "dm", args: [sampleMessageDm] },
      { title: "dm thread", args: [sampleMessageDmThread] },
    ],
  },
);

export const formatMessages = axSurface(
  "Batch of received-message lines (message check output).",
  (messages: MessageLike[]): string => {
  if (messages.length === 0) return ("No new inbox messages.");
  return (messages.map(formatMessageLine).join("\n"));
},
  {
    examples: [{ title: "batch incl. agent sender + task bracket + all target shapes", args: [[sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, sender_type: "agent", sender_name: "Alice", sender_description: "example agent role", content: "hi there", task_status: "in_progress", task_number: 42, task_assignee_id: "a-1", task_assignee_type: "agent" }, { ...sampleMessageChannelThread, seq: 1202 }, { ...sampleMessageDm, message_id: UUID_A, seq: 1203 }, { ...sampleMessageDmThread, seq: 1204 }]] }],
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
  [key: string]: unknown;
}

function buildReplyTarget(channel: string, messageId: string | undefined): string | null {
  if (!messageId) return null;
  const isThreadTarget = /^#[^:]+:[0-9a-f]{8}$/i.test(channel)
    || /^dm:@[^:]+:[0-9a-f]{8}$/i.test(channel);
  if (isThreadTarget) return null;
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
  if (m.threadId) headerParts.push(`threadId=${m.threadId}`);
  if ((m.replyCount ?? 0) > 0) headerParts.push(`replyCount=${m.replyCount}`);
  const replyTarget = buildReplyTarget(channel, messageId);
  if (replyTarget) headerParts.push(`replyTarget=${replyTarget}`);

  const attachSuffix = formatAttachmentSuffix(m.attachments);
  const assigneeName = m.taskAssigneeName ?? m.task_assignee_name ?? null;
  const taskSuffix = m.taskStatus
    ? ` [task #${m.taskNumber} status=${m.taskStatus}${formatTaskAssigneeSuffix(m.taskAssigneeId, assigneeName)}]`
    : "";
  const handle = senderDescription ? `@${senderName} — ${senderDescription}` : `@${senderName}`;
  return `[${headerParts.join(" ")}] ${handle}: ${m.content ?? ""}${attachSuffix}${taskSuffix}${formatTaskCurrentProjection(m.taskCurrentProjection)}`;
}

export interface HistoryData {
  messages?: HistoryMessage[];
  has_more?: boolean;
  has_older?: boolean;
  has_newer?: boolean;
  historyLimited?: boolean;
  historyLimitMessage?: string;
  last_read_seq?: number | null;
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

// Exported for the freshness-hold digest: the hold's never-shown line reuses
// this exact cursor phrasing so agents meet one recovery-command format
// everywhere. If this string shape changes, the hold line follows for free.
// `commandTarget` completes the fragment into a runnable command — required
// outside read output, where no surrounding context supplies the verb
// (instruction-surface universality: every printed command must execute
// as-is, without internal knowledge).
export function historyCursorText(
  label: "Older" | "Newer",
  exists: boolean,
  flag: "before" | "after",
  anchor: number | string,
  commandTarget?: string,
): string {
  if (!exists) return `No ${label.toLowerCase()}.`;
  const command = commandTarget !== undefined
    ? `raft message read --target "${commandTarget}" --${flag} ${anchor}`
    : `--${flag} ${anchor}`;
  return `${label} exist: ${command}.`;
}

export const formatHistory = axSurface(
  "Read window: header with seq range/cursors, numbered lines, end-of-window footer.",
  (
  channel: string,
  data: HistoryData,
  opts?: { around?: string; after?: string | number; before?: string | number },
): string => {
  if (!data.messages || data.messages.length === 0) return ("No messages in this channel.");

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

  const headerLines = [
    `Read window: ${count} returned, seq ${seqRange(messages)}, oldest to newest. ${historyCursorText("Older", hasOlder, "before", minSeq)} ${historyCursorText("Newer", hasNewer, "after", maxSeq)}`,
  ];
  if (opts?.around) {
    headerLines.push(`Around: ${opts.around}.`);
  }
  if (data.historyLimited) {
    headerLines.push(data.historyLimitMessage || "Message history is limited on this plan.");
  }
  if ((data.last_read_seq ?? 0) > 0 && !opts?.after && !opts?.before && !opts?.around) {
    headerLines.push(`Server unread cursor before this read: seq ${data.last_read_seq}. Use raft message read --target "${channel}" --after ${data.last_read_seq} to browse newer messages.`);
  }

  return (`${headerLines.join("\n")}\n\n${formatted}\n\nEnd of window: ${count}/${count} shown.`);
},
  {
    // Window examples cover all four target shapes (@xxchan 8/31); the dm
    // window also shows the replyTarget affordance, which thread windows omit.
    examples: [{ title: "channel window with unread cursor", args: ["#general", { messages: [sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, content: "second message" }], has_older: true, has_newer: false, last_read_seq: 1200 }] }, { title: "channel thread window (--around anchor)", args: ["#general:00000000", { messages: [sampleMessage], has_older: true, has_newer: true }, { around: "00000000" }] }, { title: "dm window with a threaded reply", args: ["dm:@richard", { messages: [{ ...sampleMessage, content: "hey, can you help?", replyCount: 2 }], has_older: false, has_newer: false }] }, { title: "dm thread window", args: ["dm:@richard:00000000", { messages: [sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, content: "DM thread reply" }], has_older: false, has_newer: false }] }],
  },
);

// --- Search result rendering (agent-facing AX readout) ---

interface SearchResult {
  id: string;
  seq: number;
  createdAt?: string;
  channelType?: string;
  channelName?: string;
  parentChannelType?: string;
  parentChannelName?: string;
  senderName?: string;
  senderType?: string;
  content?: string;
  snippet?: string;
  threadId?: string;
  taskStatus?: string | null;
  taskNumber?: number | null;
  taskCurrentProjection?: TaskCurrentProjectionLike | null;
  [key: string]: unknown;
}

function renderSearchSource(result: SearchResult): string {
  if (result.channelType === "thread") {
    const shortId = typeof result.channelName === "string" && result.channelName.startsWith("thread-")
      ? result.channelName.slice(7)
      : (typeof result.threadId === "string" && result.threadId ? result.threadId.slice(0, 8) : result.channelName);
    if (result.parentChannelType === "dm") {
      return `dm:${neutralizeRaftRefLiterals(result.parentChannelName ?? "unknown")}:${shortId}`;
    }
    return `thread:${neutralizeRaftRefLiterals(result.parentChannelName ?? "unknown")}:${shortId}`;
  }
  if (result.channelType === "dm") {
    return `dm:${neutralizeRaftRefLiterals(result.channelName ?? "unknown")}`;
  }
  return `channel:${neutralizeRaftRefLiterals(result.channelName ?? "unknown")}`;
}

interface SearchData {
  results?: SearchResult[];
}

const PREVIEW_BEFORE_CHARS = 80;
const PREVIEW_AFTER_CHARS = 120;
const PREVIEW_FALLBACK_CHARS = PREVIEW_BEFORE_CHARS + PREVIEW_AFTER_CHARS;

interface SearchMatchRange {
  start: number;
  end: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findSearchMatch(content: string, query: string): SearchMatchRange | null {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return null;

  const exactIndex = content.toLowerCase().indexOf(normalizedQuery.toLowerCase());
  if (exactIndex >= 0) {
    return { start: exactIndex, end: exactIndex + normalizedQuery.length };
  }

  const terms = normalizedQuery.match(/"([^"]+)"|\S+/g) ?? [];
  for (const rawTerm of terms) {
    const term = rawTerm.replace(/^"|"$/g, "").trim();
    if (!term) continue;
    const match = new RegExp(escapeRegExp(term), "i").exec(content);
    if (match?.index !== undefined) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }

  return null;
}

function* findRaftRefLiteralRanges(content: string): Generator<SearchMatchRange> {
  for (const match of content.matchAll(/\bdm:@[A-Za-z0-9][A-Za-z0-9_-]*/g)) {
    if (match.index !== undefined) yield { start: match.index, end: match.index + match[0].length };
  }
  for (const match of content.matchAll(/\btask #[0-9]+\b/g)) {
    if (match.index !== undefined) yield { start: match.index, end: match.index + match[0].length };
  }
  for (const match of content.matchAll(/(^|[\n\s([{"'`;])(@[A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
    if (match.index === undefined) continue;
    const prefix = match[1] ?? "";
    const ref = match[2] ?? "";
    yield { start: match.index + prefix.length, end: match.index + prefix.length + ref.length };
  }
  for (const match of content.matchAll(/(^|[\n\s([{"'`;])(#[A-Za-z][A-Za-z0-9_-]*)/g)) {
    if (match.index === undefined) continue;
    const prefix = match[1] ?? "";
    const ref = match[2] ?? "";
    yield { start: match.index + prefix.length, end: match.index + prefix.length + ref.length };
  }
}

function expandSearchMatchToRefLiteral(content: string, match: SearchMatchRange): SearchMatchRange {
  for (const refRange of findRaftRefLiteralRanges(content)) {
    if (match.start < refRange.end && match.end > refRange.start) {
      return {
        start: Math.min(match.start, refRange.start),
        end: Math.max(match.end, refRange.end),
      };
    }
  }
  return match;
}

function trimPreviewWindow(content: string, start: number, end: number): { start: number; end: number } {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart > 0 && /\s/.test(content[trimmedStart] ?? "")) trimmedStart += 1;
  while (trimmedEnd < content.length && /\s/.test(content[trimmedEnd - 1] ?? "")) trimmedEnd -= 1;
  return {
    start: Math.max(0, Math.min(trimmedStart, content.length)),
    end: Math.max(0, Math.min(trimmedEnd, content.length)),
  };
}

function escapeSearchComponentLiterals(text: string): string {
  return text.replace(/<\/?(?:result|preview|match)\b[^>]*>|<omit\s*\/>/gi, (tag) => tag
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;"));
}

function neutralizeRaftRefLiterals(text: string): string {
  return text
    .replace(/\bdm:@([A-Za-z0-9][A-Za-z0-9_-]*)/g, "dm:user:$1")
    .replace(/\btask #([0-9]+)\b/g, "task:$1")
    .replace(/(^|[\n\s([{"'`;])@([A-Za-z0-9][A-Za-z0-9_-]*)/g, "$1user:$2")
    .replace(/(^|[\n\s([{"'`;])#([A-Za-z][A-Za-z0-9_-]*)/g, "$1channel:$2");
}

function renderPreviewText(text: string): string {
  return neutralizeRaftRefLiterals(escapeSearchComponentLiterals(text));
}

function renderSearchPreview(content: string, query: string): string {
  const foundMatch = findSearchMatch(content, query);
  const match = foundMatch ? expandSearchMatchToRefLiteral(content, foundMatch) : null;

  let start = 0;
  let end = Math.min(content.length, PREVIEW_FALLBACK_CHARS);
  if (match) {
    start = Math.max(0, match.start - PREVIEW_BEFORE_CHARS);
    end = Math.min(content.length, match.end + PREVIEW_AFTER_CHARS);
  }
  ({ start, end } = trimPreviewWindow(content, start, end));

  const leadingOmit = start > 0 ? "<omit />" : "";
  const trailingOmit = end < content.length ? "<omit />" : "";

  if (!match || match.end <= start || match.start >= end) {
    return `${leadingOmit}${renderPreviewText(content.slice(start, end))}${trailingOmit}`;
  }

  const before = content.slice(start, match.start);
  const matched = content.slice(match.start, match.end);
  const after = content.slice(match.end, end);
  return [
    leadingOmit,
    renderPreviewText(before),
    "<match>",
    renderPreviewText(matched),
    "</match>",
    renderPreviewText(after),
    trailingOmit,
  ].join("");
}

export const formatSearchResults = axSurface(
  "Search results with <match>/<omit /> preview markup.",
  (query: string, data: SearchData): string => {
  if (!data.results || data.results.length === 0) return ("No search results.");
  const trimmedQuery = query.trim();

  const formatted = data.results.map((result, index) => {
    const ref = `msg:${result.id}`;
    const content = result.content ?? result.snippet ?? "";
    const sender = neutralizeRaftRefLiterals(result.senderName ?? "unknown");
    const senderType = result.senderType ? ` (${result.senderType})` : "";
    const taskProjection = formatTaskCurrentProjection(result.taskCurrentProjection, result.taskNumber, true).trimStart();
    return [
      `<result ref="${ref}">`,
      `Source: ${renderSearchSource(result)}`,
      `Sender: ${sender}${senderType}`,
      `Time: ${result.createdAt ? toLocalTimeWithOffset(result.createdAt) : "-"}`,
      ...(taskProjection ? [taskProjection] : []),
      "",
      "<preview>",
      renderSearchPreview(content, trimmedQuery),
      "</preview>",
      "</result>",
    ].join("\n");
  }).join("\n\n");

  const resultLabel = data.results.length === 1 ? "result" : "results";
  return ([
    trimmedQuery
      ? `Search results for: "${trimmedQuery}" (${data.results.length} ${resultLabel})`
      : `Filtered message results (${data.results.length} ${resultLabel})`,
    "",
    formatted,
    "",
    "If a result may be relevant but its preview is not enough, read the surrounding context for that result before answering.",
  ].join("\n"));
},
  {
    // Results cover all four source shapes (@xxchan 8/31): channel, channel
    // thread, dm, dm thread — each renders a distinct Source: line.
    examples: [{ args: ["deploy", { results: [
      { id: UUID_A, seq: 1200, createdAt: T, channelType: "channel", channelName: "general", senderName: "richard", senderType: "human", content: "we should deploy on tuesday after the review", match: { start: 10, end: 16 } },
      { id: UUID_B, seq: 1201, createdAt: T, channelType: "thread", channelName: "thread-00000000", parentChannelType: "channel", parentChannelName: "general", senderName: "Alice", senderType: "agent", content: "deploy checklist is green, ready when you are", match: { start: 0, end: 6 } },
      { id: UUID_C, seq: 1202, createdAt: T, channelType: "dm", channelName: "richard", senderName: "richard", senderType: "human", content: "can you own the deploy tomorrow?", match: { start: 16, end: 22 } },
      { id: UUID_A, seq: 1203, createdAt: T, channelType: "thread", channelName: "thread-55555555", parentChannelType: "dm", parentChannelName: "richard", senderName: "Alice", senderType: "agent", content: "deploy done, readback posted", match: { start: 0, end: 6 } },
    ] }] }],
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

export const DRAFT_REPLACED_EXCERPT_LIMIT = 400;

/**
 * A target holds exactly ONE draft — the slot is keyed `(agentId, target)` both
 * locally and server-side — so sending new content discards whatever was there.
 *
 * The discarded body is printed on purpose: after this point it exists nowhere
 * else, and this line is the last copy. It is the sender's own text going back
 * to the sender's own terminal. Deliberately NOT suggesting `--send-draft` as a
 * recovery: by the time this prints, the slot already belongs to the new
 * content, so that command would send the replacement rather than the thing
 * just lost.
 */
export const formatDraftReplacedWarning = axSurface(
  "Draft-replaced warning carrying the last copy of the discarded body.",
  (target: string, previousContent: string): string => {
  const trimmed = previousContent.trim();
  const excerpt = trimmed.length > DRAFT_REPLACED_EXCERPT_LIMIT
    ? `${trimmed.slice(0, DRAFT_REPLACED_EXCERPT_LIMIT)}… (${trimmed.length} chars total, truncated)`
    : trimmed;
  return ([
    `Warning: replacing an unsent draft for ${target}.`,
    `One draft is kept per target, so the previous body is now discarded.`,
    `Discarded draft (last copy):`,
    excerpt,
  ].join("\n"));
},
  {
    examples: [{ args: ["#general", "the previously drafted body that is being discarded"] }],
  },
);
