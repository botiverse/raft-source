import type { AgentContextView, AgentContextViewMessage, AgentContextViewPart, RaftDelivery } from "@botiverse/raft-shared";
import { raftDeliveryOfPart } from "@botiverse/raft-shared";

import { agentContextViewMarkdownLiterals } from "./agentContextViewMarkdownSubset";

/**
 * The Messages list's filter and search (AgentContextViewContent): which
 * messages and parts each filter shows, how calls pair with their results
 * and messages group into turns, the text a part is searched in, and where
 * the matches are. Pure, and memoized by the callers on the context, so
 * typing in the search field never re-reads the context per row.
 */

/** How long typing rests before the context is searched (a context can hold megabytes of text). */
export const AGENT_CONTEXT_VIEW_SEARCH_DEBOUNCE_MS = 150;

export const AGENT_CONTEXT_VIEW_FILTERS = ["all", "conversation", "notices", "tools"] as const;
export type AgentContextViewFilter = (typeof AGENT_CONTEXT_VIEW_FILTERS)[number];

/** A message shown in another message's row (a tool result in its call's), and the parts of it the filter shows. */
export type AgentContextViewRowMember = { messageIndex: number; parts: readonly number[] };

/**
 * One row of the list: a message, the parts of it the filter shows (indexes
 * into `parts`), and the messages folded into it (`members`: the results of
 * its calls); `last` is the last message the row shows.
 */
export type AgentContextViewRow = { messageIndex: number; parts: readonly number[]; members: readonly AgentContextViewRowMember[]; last: number };

/** The key of a message's part in the list's fold state, which outlives its row's mounting. */
export function agentContextViewPartKey(messageIndex: number, partIndex: number): string {
  return `${messageIndex}:${partIndex}`;
}

/** A Raft notice's key in the fold state: its part's and its segment's. */
export function agentContextViewNoticeKey(messageIndex: number, partIndex: number, segment: number): string {
  return `${agentContextViewPartKey(messageIndex, partIndex)}:${segment}`;
}

/** A user's text part that Raft wrote (inbox, task, message notices): its notices; null for anything else. */
export function agentContextViewDelivery(message: AgentContextViewMessage, part: AgentContextViewPart): RaftDelivery | null {
  return message.role === "user" && part.kind === "text" ? raftDeliveryOfPart(part) : null;
}

/**
 * All: every part. Conversation: the text the user and the agent wrote (no
 * thinking, tool calls, results or compaction), Raft's notices included.
 * Raft notices: the user's text Raft wrote. Tool calls: the calls and their
 * results. A message with nothing left to show is not a row.
 */
function partShown(filter: AgentContextViewFilter, message: AgentContextViewMessage, part: AgentContextViewPart): boolean {
  if (filter === "all") return true;
  if (filter === "conversation") return part.kind === "text" && (message.role === "user" || message.role === "assistant");
  if (filter === "notices") return agentContextViewDelivery(message, part) !== null;
  return part.kind === "tool_use" || part.kind === "tool_result";
}

/** Where a part is. */
export type AgentContextViewPartPlace = { messageIndex: number; partIndex: number };

/**
 * Calls and their results, folded into one step: a message of results only
 * (Claude's format sends them as a user message) whose every result answers
 * a call of the agent's message before it (or of the one that message folds
 * into) is shown in that message's row (`absorbedInto`). The send call is
 * never paired: it is the step that sent the message.
 */
export type AgentContextViewPairs = {
  absorbedInto: ReadonlyMap<number, number>;
  /** A call's part key → its result. */
  resultOf: ReadonlyMap<string, AgentContextViewPartPlace>;
  /** A result's part key → its call's part key. */
  callOf: ReadonlyMap<string, string>;
};

export function agentContextViewPairs(context: AgentContextView): AgentContextViewPairs {
  const absorbedInto = new Map<number, number>();
  const resultOf = new Map<string, AgentContextViewPartPlace>();
  const callOf = new Map<string, string>();
  const trigger = context.trigger;
  let head: number | null = null;
  let open = new Map<string, number>();
  context.messages.forEach((message, messageIndex) => {
    const results = message.role !== "assistant" && message.parts.length > 0
      && message.parts.every((part) => part.kind === "tool_result" && part.toolUseId !== null && open.has(part.toolUseId));
    if (results && head !== null) {
      const callMessage = head;
      absorbedInto.set(messageIndex, callMessage);
      message.parts.forEach((part, partIndex) => {
        const id = (part as Extract<AgentContextViewPart, { kind: "tool_result" }>).toolUseId!;
        const callKey = agentContextViewPartKey(callMessage, open.get(id)!);
        open.delete(id);
        resultOf.set(callKey, { messageIndex, partIndex });
        callOf.set(agentContextViewPartKey(messageIndex, partIndex), callKey);
      });
      return;
    }
    head = null;
    open = new Map();
    if (message.role !== "assistant") return;
    message.parts.forEach((part, partIndex) => {
      const sends = trigger !== null && trigger.messageIndex === messageIndex && trigger.partIndex === partIndex;
      if (part.kind === "tool_use" && part.toolUseId && !sends) open.set(part.toolUseId, partIndex);
    });
    if (open.size > 0) head = messageIndex;
  });
  return { absorbedInto, resultOf, callOf };
}

type MutableRow = { messageIndex: number; parts: number[]; members: AgentContextViewRowMember[]; last: number };

/** The rows of every filter, in one pass over the context. */
export function agentContextViewRows(context: AgentContextView, pairs: AgentContextViewPairs): Record<AgentContextViewFilter, AgentContextViewRow[]> {
  const rows: Record<AgentContextViewFilter, MutableRow[]> = { all: [], conversation: [], notices: [], tools: [] };
  context.messages.forEach((message, messageIndex) => {
    const head = pairs.absorbedInto.get(messageIndex);
    for (const filter of AGENT_CONTEXT_VIEW_FILTERS) {
      const parts: number[] = [];
      message.parts.forEach((part, partIndex) => {
        if (partShown(filter, message, part)) parts.push(partIndex);
      });
      const previous = rows[filter].at(-1);
      if (head !== undefined && parts.length > 0 && previous?.messageIndex === head) {
        previous.members.push({ messageIndex, parts });
        previous.last = messageIndex;
        continue;
      }
      // All keeps a message without parts, as the list always has.
      if (parts.length > 0 || filter === "all") rows[filter].push({ messageIndex, parts, members: [], last: messageIndex });
    }
  });
  return rows;
}

/**
 * Whether a row's first and its last shown part is a step (a call other than
 * the send call): consecutive steps of a turn join into one card across rows.
 */
export function agentContextViewRowStepEdges(context: AgentContextView, row: AgentContextViewRow): { starts: boolean; ends: boolean } {
  const isStep = (partIndex: number | undefined) => {
    if (partIndex === undefined) return false;
    const sends = context.trigger !== null && context.trigger.messageIndex === row.messageIndex && context.trigger.partIndex === partIndex;
    return !sends && context.messages[row.messageIndex]!.parts[partIndex]?.kind === "tool_use";
  };
  return { starts: isStep(row.parts[0]), ends: isStep(row.parts.at(-1)) };
}

/** How many messages a filter's rows show (a row's folded results count as theirs). */
export function agentContextViewMessageCount(rows: readonly AgentContextViewRow[]): number {
  return rows.reduce((total, row) => total + 1 + row.members.length, 0);
}

/** The row showing `messageIndex`, or the first one after it; the last row when there is none after. */
export function agentContextViewRowAtOrAfter(rows: readonly AgentContextViewRow[], messageIndex: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid]!.last < messageIndex) low = mid + 1;
    else high = mid;
  }
  return Math.min(low, rows.length - 1);
}

/** Who a turn is: the system, the user (or Raft on their behalf), or the agent (its messages and its tools' results). */
export type AgentContextViewTurnKind = "system" | "user" | "agent";

/** Consecutive messages of one side: their range, how many tool calls (steps) the agent made, whether Raft wrote the user's. */
export type AgentContextViewTurn = { kind: AgentContextViewTurnKind; first: number; last: number; steps: number; fromRaft: boolean };

export type AgentContextViewTimeline = {
  turns: readonly AgentContextViewTurn[];
  /** Each message's turn (an index into `turns`). */
  turnOf: readonly number[];
  /** A call's part key → its step number in its turn (from 1). */
  stepOf: ReadonlyMap<string, number>;
};

function turnKind(message: AgentContextViewMessage): AgentContextViewTurnKind {
  if (message.role === "assistant" || message.role === "tool") return "agent";
  if (message.role === "system") return "system";
  return message.parts.length > 0 && message.parts.every((part) => part.kind === "tool_result") ? "agent" : "user";
}

/** The context's turns, in one pass. */
export function agentContextViewTimeline(context: AgentContextView): AgentContextViewTimeline {
  const turns: AgentContextViewTurn[] = [];
  const turnOf: number[] = [];
  const stepOf = new Map<string, number>();
  context.messages.forEach((message, messageIndex) => {
    const kind = turnKind(message);
    let turn = turns.at(-1);
    if (!turn || turn.kind !== kind) {
      turn = { kind, first: messageIndex, last: messageIndex, steps: 0, fromRaft: false };
      turns.push(turn);
    }
    const current = turn;
    current.last = messageIndex;
    turnOf.push(turns.length - 1);
    message.parts.forEach((part, partIndex) => {
      if (part.kind === "tool_use" && kind === "agent") stepOf.set(agentContextViewPartKey(messageIndex, partIndex), ++current.steps);
      else if (agentContextViewDelivery(message, part)) current.fromRaft = true;
    });
  });
  return { turns, turnOf, stepOf };
}

type ToolUsePart = Extract<AgentContextViewPart, { kind: "tool_use" }>;

/** One argument of a flat input, and where its key and value sit in the input's text (`key: value` lines). */
export type AgentContextViewInputEntry = { key: string; value: string; keyStart: number; valueStart: number };
/** A call's input as shown: a flat object (every value a string, number, boolean or null) as its arguments, anything else as pretty JSON. */
export type AgentContextViewToolInput = { text: string; entries: readonly AgentContextViewInputEntry[] | null };

const toolInputs = new WeakMap<object, AgentContextViewToolInput>();

function flatEntries(input: unknown): Array<[string, string]> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return null;
  const flat: Array<[string, string]> = [];
  for (const [key, value] of entries) {
    if (typeof value === "string") flat.push([key, value]);
    else if (value === null || typeof value === "number" || typeof value === "boolean") flat.push([key, String(value)]);
    else return null;
  }
  return flat;
}

/**
 * A call's input as shown and searched, read once per part however often it
 * is shown or searched: a flat input as `key: value` lines (a string as it
 * is, unquoted), so what search counts is what the list shows; any other
 * input as pretty JSON.
 */
export function agentContextViewToolInput(part: ToolUsePart): AgentContextViewToolInput {
  let shown = toolInputs.get(part);
  if (shown === undefined) {
    const flat = flatEntries(part.input);
    if (flat) {
      const entries: AgentContextViewInputEntry[] = [];
      let text = "";
      for (const [key, value] of flat) {
        if (text) text += "\n";
        entries.push({ key, value, keyStart: text.length, valueStart: text.length + key.length + 2 });
        text += `${key}: ${value}`;
      }
      shown = { text, entries };
    } else {
      shown = { text: JSON.stringify(part.input, null, 2) ?? "", entries: null };
    }
    toolInputs.set(part, shown);
  }
  return shown;
}

/** How many characters of a call's summary are kept (the title truncates it to its width). */
const TOOL_SUMMARY_CHARS = 160;

/**
 * A call in a few words, for its title: the input's `description`, else its
 * first non-empty string argument (a command, a path, a query), on one line;
 * null when it has none.
 */
export function agentContextViewToolSummary(input: unknown): string | null {
  let summary: unknown = null;
  if (typeof input === "string") summary = input;
  else if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    summary = typeof record.description === "string" && record.description.trim()
      ? record.description
      : Object.values(record).find((value) => typeof value === "string" && value.trim() !== "");
  }
  if (typeof summary !== "string") return null;
  const line = summary.replace(/\s+/g, " ").trim();
  return line ? line.slice(0, TOOL_SUMMARY_CHARS) : null;
}

/** The calls of a context by their id, so a result's title can say what its call did. */
export function agentContextViewCallsById(context: AgentContextView): ReadonlyMap<string, ToolUsePart> {
  const calls = new Map<string, ToolUsePart>();
  for (const message of context.messages) {
    for (const part of message.parts) {
      if (part.kind === "tool_use" && part.toolUseId) calls.set(part.toolUseId, part);
    }
  }
  return calls;
}

/** The text a part shows, which search reads; null for a part with none (an image, hidden thinking). */
export function agentContextViewPartText(part: AgentContextViewPart): string | null {
  switch (part.kind) {
    case "text": return part.text;
    case "thinking": return part.text;
    case "tool_use": return agentContextViewToolInput(part).text;
    case "tool_result": return part.output;
    case "compaction": return part.text;
    default: return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The query as a case-insensitive substring pattern; null for an empty query. */
export function agentContextViewSearchPattern(query: string): RegExp | null {
  const trimmed = query.trim();
  return trimmed ? new RegExp(escapeRegExp(trimmed), "gi") : null;
}

/** How many times `pattern` matches in `text` (as search counts: non-overlapping). */
export function countHits(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text) !== null) count++;
  return count;
}

const markdownLiterals = new WeakMap<object, string[]>();

/**
 * How many matches a part has, as it is shown: a text part (drawn as
 * Markdown) in its visible text, literal by literal
 * (agentContextViewMarkdownLiterals, read once per part), so every match
 * counted is one the render marks; a text Raft wrote (a notice card) and any
 * other part in its text.
 */
function partHits(message: AgentContextViewMessage, part: AgentContextViewPart, pattern: RegExp): number {
  // Raft's notices are cards: searched in their original text, which the card shows.
  if (part.kind === "text" && agentContextViewDelivery(message, part)) return countHits(part.text, pattern);
  if (part.kind === "text") {
    let literals = markdownLiterals.get(part);
    if (literals === undefined) {
      literals = agentContextViewMarkdownLiterals(part.text);
      markdownLiterals.set(part, literals);
    }
    return literals.reduce((total, literal) => total + countHits(literal, pattern), 0);
  }
  const text = agentContextViewPartText(part);
  return text ? countHits(text, pattern) : 0;
}

/** A piece of shown text from `start`: plain, or the `hit`-th match in the part's text (counting from 0). */
export type AgentContextViewTextPiece = { start: number; text: string; hit: number | null };

/** Where the `hit`-th match (from 0) of `pattern` in `text` starts; -1 when there is none. */
export function agentContextViewHitOffset(text: string, pattern: RegExp, hit: number): number {
  pattern.lastIndex = 0;
  let count = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (count++ === hit) return match.index;
  }
  return -1;
}

/** The text cut at its matches. Matches in a prefix of a text are its first matches, so a folded text keeps their numbers. */
export function splitAgentContextViewHits(text: string, pattern: RegExp): AgentContextViewTextPiece[] {
  const pieces: AgentContextViewTextPiece[] = [];
  pattern.lastIndex = 0;
  let from = 0;
  let hit = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > from) pieces.push({ start: from, text: text.slice(from, match.index), hit: null });
    pieces.push({ start: match.index, text: match[0], hit: hit++ });
    from = match.index + match[0].length;
  }
  if (from < text.length) pieces.push({ start: from, text: text.slice(from), hit: null });
  return pieces;
}

/** The matches of one shown part: `count` of them, numbered from `first` among all of the list's. */
export type AgentContextViewPartHits = { row: number; messageIndex: number; partIndex: number; first: number; count: number };
export type AgentContextViewMatches = { parts: AgentContextViewPartHits[]; total: number };
/** One match: its row, message and part, and which of the part's matches it is. */
export type AgentContextViewMatch = { row: number; messageIndex: number; partIndex: number; hit: number };

/**
 * Every match in the parts the rows show, in list order: a call's result
 * (folded into its row) right after the call, as the step shows them.
 */
export function findAgentContextViewMatches(context: AgentContextView, rows: readonly AgentContextViewRow[], pattern: RegExp, pairs: AgentContextViewPairs): AgentContextViewMatches {
  const parts: AgentContextViewPartHits[] = [];
  let total = 0;
  rows.forEach((row, rowIndex) => {
    const add = (messageIndex: number, partIndex: number) => {
      const message = context.messages[messageIndex]!;
      const count = partHits(message, message.parts[partIndex]!, pattern);
      if (count === 0) return;
      parts.push({ row: rowIndex, messageIndex, partIndex, first: total, count });
      total += count;
    };
    const counted = new Set<string>();
    for (const partIndex of row.parts) {
      add(row.messageIndex, partIndex);
      const result = pairs.resultOf.get(agentContextViewPartKey(row.messageIndex, partIndex));
      if (result && row.members.some((member) => member.messageIndex === result.messageIndex && member.parts.includes(result.partIndex))) {
        add(result.messageIndex, result.partIndex);
        counted.add(agentContextViewPartKey(result.messageIndex, result.partIndex));
      }
    }
    for (const member of row.members) {
      for (const partIndex of member.parts) {
        if (!counted.has(agentContextViewPartKey(member.messageIndex, partIndex))) add(member.messageIndex, partIndex);
      }
    }
  });
  return { parts, total };
}

/** The `index`-th match (0-based; the caller keeps it within `total`). */
export function locateAgentContextViewMatch(matches: AgentContextViewMatches, index: number): AgentContextViewMatch {
  let low = 0;
  let high = matches.parts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (matches.parts[mid]!.first <= index) low = mid;
    else high = mid - 1;
  }
  const part = matches.parts[low]!;
  return { row: part.row, messageIndex: part.messageIndex, partIndex: part.partIndex, hit: index - part.first };
}

/** The first match in `row` or after it, as Find in a browser starts from where you are; wraps to the first. */
export function firstAgentContextViewMatchFrom(matches: AgentContextViewMatches, row: number): number {
  const part = matches.parts.find((candidate) => candidate.row >= row);
  return part ? part.first : 0;
}

/** How many characters of a tool's result its folded line shows. */
export const TOOL_RESULT_PREVIEW_CHARS = 80;

/** A folded result's line: its first characters, as search reads them (matched against these, so numbers agree). */
export function agentContextViewResultPreview(output: string): string {
  return output.slice(0, TOOL_RESULT_PREVIEW_CHARS);
}

/** How a folded result's line draws text: each line break or tab a space. */
export function flattenAgentContextViewWhitespace(text: string): string {
  return text.replace(/\s/g, " ");
}

/**
 * The pieces of `text` from `start` to `end`, cut at the matches search counts
 * in the whole of `text` (numbered as there); a match only partly inside is plain.
 */
export function splitAgentContextViewSliceHits(text: string, start: number, end: number, pattern: RegExp): AgentContextViewTextPiece[] {
  return sliceAgentContextViewPieces(splitAgentContextViewHits(text, pattern), start, end);
}

/**
 * Already cut pieces of a text (splitAgentContextViewHits), from `start` to
 * `end`: the text is cut once and sliced per range (a Raft delivery's
 * notices), not cut again for each. Starts are relative to `start`.
 */
export function sliceAgentContextViewPieces(all: readonly AgentContextViewTextPiece[], start: number, end: number): AgentContextViewTextPiece[] {
  const pieces: AgentContextViewTextPiece[] = [];
  // The first piece that reaches past `start` (pieces are in order and contiguous).
  let low = 0;
  let high = all.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const piece = all[mid]!;
    if (piece.start + piece.text.length <= start) low = mid + 1;
    else high = mid;
  }
  for (let index = low; index < all.length; index++) {
    const piece = all[index]!;
    const pieceEnd = piece.start + piece.text.length;
    if (piece.start >= end) break;
    const inside = piece.start >= start && pieceEnd <= end;
    const from = Math.max(piece.start, start);
    const clipped = piece.text.slice(from - piece.start, Math.min(pieceEnd, end) - piece.start);
    const last = pieces.at(-1);
    if (!inside || piece.hit === null) {
      if (last && last.hit === null) last.text += clipped;
      else pieces.push({ start: from - start, text: clipped, hit: null });
    } else {
      pieces.push({ start: from - start, text: clipped, hit: piece.hit });
    }
  }
  return pieces;
}
