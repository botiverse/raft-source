// View Context entries: one restored request (`AgentContextView`) as a flat
// list of entries, each with an id that stays the same for that message. The
// web panel and an agent's `raft context search` / `raft context read` address
// the same entries, so a "Viewed by" row can point at what an agent looked at.
//
// - `s<i>`: a system prompt block.
// - `t<i>`: one tool definition.
// - `m<i>.p<j>`: one part of a message (text, thinking, tool call, tool result,
//   image, compaction).
//
// Pure; text is what the panel shows, after the daemon's redaction.

import {
  AGENT_CONTEXT_VIEW_MAX_BYTES,
  asAgentContextViewRequestId,
  type AgentContextView,
  type AgentContextViewMessageRole,
  type AgentContextViewPart,
  type AgentContextViewRequestId,
} from "./agentContextView";
import type { JsonValue } from "./jsonValue";

export type AgentContextEntryRole = "system" | "tool_definition" | AgentContextViewMessageRole;

export type AgentContextEntry = {
  id: string;
  role: AgentContextEntryRole;
  /** The part's kind (`text`, `tool_use bash`, ...); `system` or the tool's name for the first two groups. */
  type: string;
  text: string;
};

export function agentContextSystemEntryId(index: number): string {
  return `s${index}`;
}

export function agentContextToolEntryId(index: number): string {
  return `t${index}`;
}

export function agentContextPartEntryId(messageIndex: number, partIndex: number): string {
  return `m${messageIndex}.p${partIndex}`;
}

function partType(part: AgentContextViewPart): string {
  if (part.kind === "tool_use") return `tool_use ${part.toolName}`;
  if (part.kind === "tool_result") return part.toolName ? `tool_result ${part.toolName}` : "tool_result";
  return part.kind;
}

/**
 * A call's input as the panel shows and searches it: a flat object (every
 * value a string, number, boolean or null) as `key: value` lines, a string
 * unquoted; anything else as pretty JSON. The web panel's
 * `agentContextViewToolInput` builds the same text.
 */
export function agentContextToolInputText(input: JsonValue): string {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === "string") lines.push(`${key}: ${value}`);
      else if (value === null || typeof value === "number" || typeof value === "boolean") lines.push(`${key}: ${String(value)}`);
      else return JSON.stringify(input, null, 2);
    }
    if (lines.length > 0) return lines.join("\n");
  }
  return JSON.stringify(input, null, 2) ?? "";
}

function partText(part: AgentContextViewPart): string {
  switch (part.kind) {
    case "text":
      return part.text;
    case "thinking":
    case "compaction":
      return part.text ?? "";
    case "tool_use":
      return agentContextToolInputText(part.input);
    case "tool_result":
      return part.output;
    case "image":
      return `[image${part.mediaType ? ` ${part.mediaType}` : ""}${part.sizeBytes === null ? "" : `, ${part.sizeBytes} bytes`}]`;
    case "unknown":
      return "";
  }
}

/** Every entry of a restored request, in the order the panel shows them. */
export function agentContextEntries(view: AgentContextView): AgentContextEntry[] {
  const entries: AgentContextEntry[] = [];
  view.system.forEach((block, index) => {
    entries.push({ id: agentContextSystemEntryId(index), role: "system", type: "system", text: block.text });
  });
  view.tools.forEach((tool, index) => {
    const schema = tool.inputSchema === null ? "" : `\n${JSON.stringify(tool.inputSchema)}`;
    entries.push({ id: agentContextToolEntryId(index), role: "tool_definition", type: tool.name, text: `${tool.name}\n${tool.description}${schema}` });
  });
  view.messages.forEach((message, messageIndex) => {
    message.parts.forEach((part, partIndex) => {
      entries.push({ id: agentContextPartEntryId(messageIndex, partIndex), role: message.role, type: partType(part), text: partText(part) });
    });
  });
  return entries;
}

export const AGENT_CONTEXT_SEARCH_DEFAULT_LIMIT = 20;
export const AGENT_CONTEXT_SEARCH_MAX_LIMIT = 50;
export const AGENT_CONTEXT_SEARCH_MAX_QUERY_CHARS = 200;
/** One matching line in a search answer, cut around the match. */
export const AGENT_CONTEXT_SEARCH_LINE_CHARS = 400;
export const AGENT_CONTEXT_READ_DEFAULT_LIMIT = 5;
export const AGENT_CONTEXT_READ_MAX_LIMIT = 21;
/** One entry's text in a read answer; longer ones continue with a page. */
export const AGENT_CONTEXT_READ_PAGE_CHARS = 8 * 1024;
/** All entry text in one read answer, in UTF-16 code units (not bytes); past it, entries are left out and counted. */
export const AGENT_CONTEXT_READ_MAX_CHARS = 64 * 1024;

export type AgentContextSearchMatch = {
  id: string;
  role: AgentContextEntryRole;
  type: string;
  /** How many times the query occurs in the entry. */
  hits: number;
  /** The first line that holds it, cut around the match. */
  line: string;
};

export type AgentContextSearchAnswer = {
  /** Entries that match, before paging. */
  total: number;
  matches: AgentContextSearchMatch[];
};

/** `text` cut to at most `chars` from `start`, never splitting a surrogate pair. */
function cutAt(text: string, start: number, chars: number): { text: string; from: number; to: number } {
  let from = Math.max(0, start);
  let to = Math.min(text.length, from + chars);
  if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from -= 1;
  if (to < text.length && isLowSurrogate(text.charCodeAt(to))) to -= 1;
  return { text: text.slice(from, to), from, to };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A whole number in [min, max]; anything else (NaN, a fraction, a string) gives the default. */
function wholeIn(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) ? Math.min(Math.max(min, value as number), max) : fallback;
}

function matchingLine(text: string, pattern: RegExp): string {
  for (const line of text.split("\n")) {
    const at = line.search(pattern);
    if (at === -1) continue;
    if (line.length <= AGENT_CONTEXT_SEARCH_LINE_CHARS) return line;
    const cut = cutAt(line, at - Math.floor(AGENT_CONTEXT_SEARCH_LINE_CHARS / 2), AGENT_CONTEXT_SEARCH_LINE_CHARS);
    return `${cut.from > 0 ? "…" : ""}${cut.text}${cut.to < line.length ? "…" : ""}`;
  }
  // The query spans lines: the entry still matches, its start stands for it.
  return cutAt(text, 0, AGENT_CONTEXT_SEARCH_LINE_CHARS).text;
}

/**
 * Literal, case-insensitive search over entries, as the panel's search
 * matches (the query trimmed, then as a substring); paged by `offset` and
 * `limit`.
 */
export function searchAgentContextEntries(
  entries: readonly AgentContextEntry[],
  query: string,
  options: { limit?: number; offset?: number } = {},
): AgentContextSearchAnswer {
  const trimmed = query.trim();
  if (!trimmed) return { total: 0, matches: [] };
  const counter = new RegExp(escapeRegExp(trimmed), "gi");
  const finder = new RegExp(escapeRegExp(trimmed), "i");
  const limit = wholeIn(options.limit, AGENT_CONTEXT_SEARCH_DEFAULT_LIMIT, 1, AGENT_CONTEXT_SEARCH_MAX_LIMIT);
  const offset = wholeIn(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const matches: AgentContextSearchMatch[] = [];
  let total = 0;
  for (const entry of entries) {
    const hits = entry.text.match(counter)?.length ?? 0;
    if (hits === 0) continue;
    total += 1;
    if (total <= offset || matches.length >= limit) continue;
    matches.push({ id: entry.id, role: entry.role, type: entry.type, hits, line: matchingLine(entry.text, finder) });
  }
  return { total, matches };
}

export type AgentContextReadEntry = {
  id: string;
  role: AgentContextEntryRole;
  type: string;
  /** This page of the entry's text. */
  text: string;
  page: number;
  pages: number;
};

export type AgentContextReadAnswer =
  | { found: false }
  | {
    found: true;
    entries: AgentContextReadEntry[];
    /** Entries of the window left out to stay inside the answer's size. */
    omitted: number;
  };

function pageCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / AGENT_CONTEXT_READ_PAGE_CHARS));
}

/**
 * A window of `limit` entries centred on `around`. The anchor shows `page`
 * of its text; every other entry its first page.
 */
export function readAgentContextWindow(
  entries: readonly AgentContextEntry[],
  around: string,
  options: { limit?: number; page?: number } = {},
): AgentContextReadAnswer {
  const index = entries.findIndex((entry) => entry.id === around);
  if (index === -1) return { found: false };
  const limit = wholeIn(options.limit, AGENT_CONTEXT_READ_DEFAULT_LIMIT, 1, AGENT_CONTEXT_READ_MAX_LIMIT);
  const start = Math.max(0, Math.min(index - Math.floor((limit - 1) / 2), entries.length - limit));
  const window = entries.slice(start, start + limit);
  const shown = window.map((entry) => {
    const pages = pageCount(entry.text);
    const page = entry.id === around ? wholeIn(options.page, 1, 1, pages) : 1;
    const { text } = cutAt(entry.text, (page - 1) * AGENT_CONTEXT_READ_PAGE_CHARS, AGENT_CONTEXT_READ_PAGE_CHARS);
    return { id: entry.id, role: entry.role, type: entry.type, text, page, pages };
  });
  // The anchor is always shown; the others nearest it first, while the answer has room.
  const anchor = shown.find((entry) => entry.id === around)!;
  let budget = AGENT_CONTEXT_READ_MAX_CHARS - anchor.text.length;
  const kept = new Set<AgentContextReadEntry>([anchor]);
  const anchorAt = shown.indexOf(anchor);
  const byDistance = shown.filter((entry) => entry !== anchor)
    .sort((a, b) => Math.abs(shown.indexOf(a) - anchorAt) - Math.abs(shown.indexOf(b) - anchorAt));
  for (const entry of byDistance) {
    if (entry.text.length > budget) continue;
    budget -= entry.text.length;
    kept.add(entry);
  }
  return { found: true, entries: shown.filter((entry) => kept.has(entry)), omitted: shown.length - kept.size };
}

// ---------------------------------------------------------------------------
// Agents searching a context (#wg-ax:#15): Server -> daemon frame and the
// daemon's answer, posted to the same result route as a view
// (`agentContextViewResultPath`). A separate frame type and capability, so a
// daemon that only knows views never answers one with a whole context.

/** Server -> daemon: search or read one message's context; answered by one result POST. */
export const AGENT_CONTEXT_SEARCH_REQUEST_TYPE = "agent:context_search_request";
/** A daemon that answers `agent:context_search_request`. */
export const DAEMON_CAPABILITY_AGENT_CONTEXT_SEARCH_V0 = "agent-context-search:v0";

export type AgentContextQuery =
  | { kind: "search"; query: string; limit: number; offset: number }
  | { kind: "read"; around: string; limit: number; page: number };

export type AgentContextSearchRequestMessage = {
  type: typeof AGENT_CONTEXT_SEARCH_REQUEST_TYPE;
  requestId: AgentContextViewRequestId;
  agentId: string;
  messageId: string;
  /** Cap on the uncompressed answer; at most `AGENT_CONTEXT_VIEW_MAX_BYTES`. */
  maxBytes: number;
  query: AgentContextQuery;
};

/** The daemon's answer to a search or read (a failure is the view's `{ok: false, reason}`). */
export type AgentContextQueryAnswerBody = {
  ok: true;
  runtime: string;
  model: string | null;
  /** How many entries the restored request has. */
  entryCount: number;
  answer: ({ kind: "search" } & AgentContextSearchAnswer) | ({ kind: "read" } & AgentContextReadAnswer);
};

const ENTRY_ID = /^(?:s\d+|t\d+|m\d+\.p\d+)$/;

function wholeAtLeast(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min;
}

function readQuery(raw: unknown): AgentContextQuery | null {
  if (typeof raw !== "object" || raw === null) return null;
  const query = raw as Record<string, unknown>;
  if (query.kind === "search") {
    const text = typeof query.query === "string" ? query.query.trim() : "";
    if (!text || text.length > AGENT_CONTEXT_SEARCH_MAX_QUERY_CHARS) return null;
    if (!wholeAtLeast(query.limit, 1) || query.limit > AGENT_CONTEXT_SEARCH_MAX_LIMIT || !wholeAtLeast(query.offset, 0)) return null;
    return { kind: "search", query: text, limit: query.limit, offset: query.offset };
  }
  if (query.kind === "read") {
    if (typeof query.around !== "string" || !ENTRY_ID.test(query.around)) return null;
    if (!wholeAtLeast(query.limit, 1) || query.limit > AGENT_CONTEXT_READ_MAX_LIMIT || !wholeAtLeast(query.page, 1)) return null;
    return { kind: "read", around: query.around, limit: query.limit, page: query.page };
  }
  return null;
}

/** The daemon's check of an `agent:context_search_request`; null for anything malformed. */
export function readAgentContextSearchRequest(frame: unknown): AgentContextSearchRequestMessage | null {
  if (typeof frame !== "object" || frame === null) return null;
  const raw = frame as Record<string, unknown>;
  if (raw.type !== AGENT_CONTEXT_SEARCH_REQUEST_TYPE) return null;
  const requestId = typeof raw.requestId === "string" ? asAgentContextViewRequestId(raw.requestId) : null;
  if (!requestId || typeof raw.agentId !== "string" || !raw.agentId || typeof raw.messageId !== "string" || !raw.messageId) return null;
  if (!wholeAtLeast(raw.maxBytes, 1) || raw.maxBytes > AGENT_CONTEXT_VIEW_MAX_BYTES) return null;
  const query = readQuery(raw.query);
  if (!query) return null;
  return { type: AGENT_CONTEXT_SEARCH_REQUEST_TYPE, requestId, agentId: raw.agentId, messageId: raw.messageId, maxBytes: raw.maxBytes, query };
}

/** Answer a query over a restored, redacted request. */
export function answerAgentContextQuery(view: AgentContextView, query: AgentContextQuery): AgentContextQueryAnswerBody {
  const entries = agentContextEntries(view);
  const answer = query.kind === "search"
    ? { kind: "search" as const, ...searchAgentContextEntries(entries, query.query, { limit: query.limit, offset: query.offset }) }
    : { kind: "read" as const, ...readAgentContextWindow(entries, query.around, { limit: query.limit, page: query.page }) };
  return { ok: true, runtime: view.runtime, model: view.model, entryCount: entries.length, answer };
}

const ENTRY_ROLES: ReadonlySet<string> = new Set(["system", "tool_definition", "user", "assistant", "tool"]);

function isWhole(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function isEntryHead(raw: unknown): raw is { id: string; role: AgentContextEntryRole; type: string } {
  if (typeof raw !== "object" || raw === null) return false;
  const entry = raw as Record<string, unknown>;
  return typeof entry.id === "string" && ENTRY_ID.test(entry.id) && typeof entry.role === "string" && ENTRY_ROLES.has(entry.role)
    && typeof entry.type === "string";
}

/**
 * The Server's check of a daemon's answer to a search or read: only this
 * shape is passed on. A whole view (`context`), or anything else, is not an
 * answer, so the agent never gets more than entries.
 */
export function parseAgentContextQueryAnswerBody(raw: unknown): AgentContextQueryAnswerBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (body.ok !== true || "context" in body) return null;
  if (typeof body.runtime !== "string" || !(typeof body.model === "string" || body.model === null) || !isWhole(body.entryCount)) return null;
  const answer = typeof body.answer === "object" && body.answer !== null ? body.answer as Record<string, unknown> : null;
  if (!answer) return null;
  const head = { ok: true as const, runtime: body.runtime, model: body.model as string | null, entryCount: body.entryCount };
  if (answer.kind === "search") {
    if (!isWhole(answer.total) || !Array.isArray(answer.matches)) return null;
    const matches: AgentContextSearchMatch[] = [];
    for (const match of answer.matches as unknown[]) {
      if (!isEntryHead(match)) return null;
      const m = match as unknown as Record<string, unknown>;
      if (!isWhole(m.hits, 1) || typeof m.line !== "string") return null;
      matches.push({ id: match.id, role: match.role, type: match.type, hits: m.hits, line: m.line });
    }
    return { ...head, answer: { kind: "search", total: answer.total, matches } };
  }
  if (answer.kind === "read") {
    if (answer.found === false) return { ...head, answer: { kind: "read", found: false } };
    if (answer.found !== true || !isWhole(answer.omitted) || !Array.isArray(answer.entries)) return null;
    const entries: AgentContextReadEntry[] = [];
    for (const entry of answer.entries as unknown[]) {
      if (!isEntryHead(entry)) return null;
      const e = entry as unknown as Record<string, unknown>;
      if (typeof e.text !== "string" || !isWhole(e.page, 1) || !isWhole(e.pages, 1)) return null;
      entries.push({ id: entry.id, role: entry.role, type: entry.type, text: e.text, page: e.page, pages: e.pages });
    }
    return { ...head, answer: { kind: "read", found: true, entries, omitted: answer.omitted } };
  }
  return null;
}
