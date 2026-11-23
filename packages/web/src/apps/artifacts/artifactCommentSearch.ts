// The comment list's search (#proj-workspace:#341, xxchan): the parts with no React in them. The
// words searched for, which comments match them (the words their Markdown shows, and their author's
// name), which threads show (any of their comments matches), where the words are in a text (its
// marks), and whether a collapsed thread hides a match on one of its one-line comments (it opens).
import type { ArtifactActor, ArtifactComment, ArtifactCommentId } from "@botiverse/raft-shared";

import { mentionToken } from "./artifactComments";
import type { ArtifactCommentThread } from "./artifactComments";
import { threadComments } from "./artifactCommentListOrder";

/**
 * A text as search compares it: each character in lower case, one by one, so a text and any part
 * of it fold alike (a word's last Greek sigma too) and a mark found in the folded text is where it
 * is in the text. Chinese, Japanese and Korean have no case and no spaces between words: a word is
 * found inside a run of them as anywhere else.
 */
export function foldForSearch(text: string): string {
  let folded = "";
  for (const character of text) folded += character.toLowerCase();
  return folded;
}

/**
 * The words of a query: split at spaces, each without the `@` or `#` it starts with (a mention or a
 * channel is found by its name), folded, each once. None: not searching.
 */
export function commentSearchTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const word of query.trim().split(/\s+/u)) {
    const term = foldForSearch(word.replace(/^[@#]+/u, ""));
    if (term === "" || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

// Private Use characters stand for a mention (MENTION_*) or for text kept as written (KEPT_*: a code
// span, an escaped character, an autolink) while the Markdown around them is read; typed ones go.
const MENTION_OPEN = "\uE000";
const MENTION_CLOSE = "\uE001";
const KEPT_OPEN = "\uE002";
const KEPT_CLOSE = "\uE003";
const STAND_INS = /[\uE000-\uE003]/gu;
const MENTION_AT = /\uE000(\d+)\uE001/gu;
const KEPT_AT = /\uE002(\d+)\uE003/gu;

/**
 * A comment's words as its Markdown shows them, its mentions as they show (`@Name`): what search
 * matches, so that a match is in words the message renderer marks (artifactCommentSearch's marks
 * agree with MessageMarkdownText's).
 */
export function commentSearchText(comment: Pick<ArtifactComment, "body">): string {
  const mentions: string[] = [];
  const source = comment.body
    .map((part) => (part.type === "text" ? part.text.replace(STAND_INS, "\uFFFD") : `${MENTION_OPEN}${mentions.push(mentionToken(part.actor)) - 1}${MENTION_CLOSE}`))
    .join("");
  return markdownSearchText(source).replace(MENTION_AT, (_, index: string) => mentions[Number(index)] ?? "");
}

/**
 * The words a Markdown text shows, read as the message renderer draws it (CommonMark with GFM, the
 * CJK-friendly emphasis rule), close enough for search, without a parser (the web has none to hand
 * apart from react-markdown's own): a link's label without its address, an image as nothing (its
 * text isn't drawn), no emphasis, strikethrough, heading, quote, list, task box, table or rule
 * syntax, no code fence or its language, a reference definition as nothing; the text of code (spans
 * and blocks), escaped characters and autolinks as written; raw HTML as text (the renderer shows it
 * so). Its lines are the source's lines.
 */
export function markdownSearchText(source: string): string {
  const lines: string[] = [];
  let fence: { mark: string; size: number } | null = null;
  for (const line of source.split("\n")) {
    const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (fenceLine && fenceLine[1]![0] === fence.mark && fenceLine[1]!.length >= fence.size && fenceLine[2]!.trim() === "") fence = null;
      else lines.push(line);
      continue;
    }
    // A backtick fence's info string has no backtick (else it is a code span).
    if (fenceLine && !(fenceLine[1]![0] === "`" && fenceLine[2]!.includes("`"))) {
      fence = { mark: fenceLine[1]![0]!, size: fenceLine[1]!.length };
      continue;
    }
    // A reference definition, a rule (or a setext heading's line), a table's delimiter row: nothing drawn.
    if (/^ {0,3}\[[^\]]+\]:\s*\S/u.test(line) || /^ {0,3}(?:[-*_=]\s*){3,}$/u.test(line) || /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/u.test(line)) continue;
    lines.push(inlineSearchText(blockSearchText(line)));
  }
  return lines.join("\n");
}

/** A line without its block syntax: quote marks, a heading's #s, list markers and a task's box, a table row's pipes. */
function blockSearchText(line: string): string {
  let rest = line;
  let heading = false;
  for (;;) {
    const quote = rest.replace(/^ {0,3}>\s?/u, "");
    const title = quote.replace(/^ {0,3}#{1,6}(?:\s+|$)/u, "");
    const item = title.replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/u, "");
    if (title !== quote) heading = true;
    if (item === rest) break;
    rest = item;
  }
  if (heading) rest = rest.replace(/\s+#+\s*$/u, "");
  const trimmed = rest.trim();
  return trimmed.startsWith("|") || trimmed.endsWith("|") ? rest.replace(/(^|[^\\])\|/gu, "$1 ") : rest;
}

/** A line's words without its inline syntax (markdownSearchText). */
function inlineSearchText(line: string): string {
  const kept: string[] = [];
  const keep = (text: string) => `${KEPT_OPEN}${kept.push(text) - 1}${KEPT_CLOSE}`;
  let text = line
    // Code spans: their text as written.
    .replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/gu, (_, _ticks: string, code: string) => keep(code))
    // Escaped punctuation: the character itself, never syntax.
    .replace(/\\([!-/:-@[-`{-~])/gu, (_, character: string) => keep(character))
    // Autolinks: the address is the link's text.
    .replace(/<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/gu, (_, address: string) => keep(address))
    // Images: their text isn't drawn. Links: the label, not the address (nor its title).
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/gu, "")
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/gu, "$1");
  // Emphasis and strikethrough, in pairs (a lone `*` or `~` is drawn as written), inside out; `_` not inside a word.
  for (let before = ""; before !== text;) {
    before = text;
    text = text
      .replace(/(\*{1,3})(?=\S)([\s\S]*?\S)\1/gu, "$2")
      .replace(/(^|[^\p{L}\p{N}_])(_{1,3})(?=\S)([\s\S]*?\S)\2(?![\p{L}\p{N}_])/gu, "$1$3")
      .replace(/(~{1,2})(?=\S)([\s\S]*?\S)\1/gu, "$2");
  }
  return text.replace(KEPT_AT, (_, index: string) => kept[Number(index)] ?? "");
}

/**
 * Whether a comment matches: every word is in its author's name (`nameOf`, as the list shows it)
 * or its text. A deleted one shows neither, so never; nor does anything without words to find.
 */
export function commentMatches(
  comment: ArtifactComment,
  terms: readonly string[],
  nameOf: (actor: ArtifactActor) => string,
): boolean {
  if (comment.deletedAt || terms.length === 0) return false;
  const searched = foldForSearch(`${nameOf(comment.author)}\n${commentSearchText(comment)}`);
  return terms.every((term) => searched.includes(term));
}

/** What a search found: the threads to show and, in them, the comments that match. */
export interface ArtifactCommentSearchResult {
  threads: ReadonlySet<ArtifactCommentId>;
  comments: ReadonlySet<ArtifactCommentId>;
}

/** Every thread with a matching comment, its root or any reply, open or resolved. */
export function searchCommentThreads(
  threads: readonly ArtifactCommentThread[],
  terms: readonly string[],
  nameOf: (actor: ArtifactActor) => string,
): ArtifactCommentSearchResult {
  const found = new Set<ArtifactCommentId>();
  const matching = new Set<ArtifactCommentId>();
  for (const thread of threads) {
    for (const comment of threadComments(thread)) {
      if (!commentMatches(comment, terms, nameOf)) continue;
      matching.add(comment.id);
      found.add(thread.id);
    }
  }
  return { threads: found, comments: matching };
}

/** Where a word is in a text: `start` to `end` (not included), in the text's own indices. */
export interface ArtifactSearchRange {
  start: number;
  end: number;
}

/**
 * Where the words are in a text, in order, overlapping and touching ones joined. Found in the folded
 * text (foldForSearch) and given back in the text's own indices: a character whose lower case is
 * longer than itself is marked whole. A mark takes an `@` or `#` just before it, as the message
 * renderer's do (a mention chip's `@Name` is marked as `@Name` in its Markdown).
 */
export function searchRanges(text: string, terms: readonly string[]): ArtifactSearchRange[] {
  if (text === "" || terms.length === 0) return [];
  // The folded text, and for each of its units the index in `text` of the character it came from.
  let folded = "";
  const from: number[] = [];
  for (let at = 0; at < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(at)!);
    const lower = character.toLowerCase();
    for (let unit = 0; unit < lower.length; unit += 1) from.push(at);
    folded += lower;
    at += character.length;
  }
  from.push(text.length);
  // The end of a match in `text`: past the whole character its last unit came from.
  const endOf = (foldedEnd: number) => {
    const last = from[foldedEnd - 1]!;
    let next = foldedEnd;
    while (from[next]! <= last && next < from.length - 1) next += 1;
    return Math.max(from[next]!, last + 1);
  };
  const found: ArtifactSearchRange[] = [];
  for (const term of terms) {
    for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + 1)) {
      const start = from[at]!;
      found.push({ start: start > 0 && (text[start - 1] === "@" || text[start - 1] === "#") ? start - 1 : start, end: endOf(at + term.length) });
    }
  }
  found.sort((a, b) => a.start - b.start || a.end - b.end);
  const joined: ArtifactSearchRange[] = [];
  for (const range of found) {
    const last = joined.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else joined.push({ ...range });
  }
  return joined;
}

/** A run of a text: marked (a word searched for) or not, and where it starts in the text. */
export interface ArtifactSearchPart {
  text: string;
  hit: boolean;
  at: number;
}

/** A text cut into runs at its marks (searchRanges); one unmarked run without any. */
export function searchParts(text: string, terms: readonly string[]): ArtifactSearchPart[] {
  const parts: ArtifactSearchPart[] = [];
  let at = 0;
  for (const range of searchRanges(text, terms)) {
    if (range.start > at) parts.push({ text: text.slice(at, range.start), hit: false, at });
    parts.push({ text: text.slice(range.start, range.end), hit: true, at: range.start });
    at = range.end;
  }
  if (at < text.length || parts.length === 0) parts.push({ text: text.slice(at), hit: false, at });
  return parts;
}

/**
 * Whether a collapsed thread hides a match: a matching comment it shows on one line, which is every
 * comment before its first new one (`newIds`, after the "New replies" divider, in full), or every
 * comment when none is new (ArtifactCommentThreadCard). Such a thread opens while searching.
 */
export function hidesMatch(
  thread: ArtifactCommentThread,
  matching: ReadonlySet<ArtifactCommentId>,
  newIds: readonly ArtifactCommentId[],
): boolean {
  const fresh = new Set(newIds);
  const all = threadComments(thread);
  const firstNew = all.findIndex((c) => fresh.has(c.id));
  return all.some((c, index) => (firstNew < 0 || index < firstNew) && matching.has(c.id));
}
