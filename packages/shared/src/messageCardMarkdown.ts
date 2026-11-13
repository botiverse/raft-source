// Card messages v2.0 (RFC 082 §4.8): the `Markdown` element's subset.
//
// A card's Markdown is parsed with the parser the web draws messages with:
// CommonMark + GFM (mdast-util-from-markdown with micromark's GFM extension,
// which is what remark-parse + remark-gfm run), Raft's CJK emphasis rules and
// Raft math, and indented code off, as in chat (remarkDisableIndentedCode).
// Every node of the tree must be on an allowlist: paragraph, text, line
// break, bold, italic, strikethrough, inline code, fenced code block, list and
// list item, block quote, and a link to an http:, https: or mailto: URL (the
// schemes a message's own links take, GFM's email autolinks included). Lists and
// quotes nest at most 3 levels. Anything else (a heading, image, table,
// horizontal rule, HTML, footnote, reference-style link or definition, math,
// a task list item, a link or autolink to another scheme such as tel: or sms:)
// is outside it.
//
// The Server refuses a card with such a node (400 `card_invalid`, limit
// `markdown`, naming the node), never strips it. Clients check the same
// allowlist on their own parse and draw a node outside it as its source text
// (messageCardMarkdownViolations), so a stored card never depends on the
// Server having been right when it was sent. The shared contract vectors
// (messageCard.v1.vector.json) pin the verdicts, including where markdown
// libraries tend to differ.
//
// Agents read the content as it stands (RFC 082 §4.3), except that each
// `@name` outside code and links is wrapped as inline code, so no reader takes
// it for a mention (messageCardMarkdownAgentSource).

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { cjkFriendlyExtension } from "micromark-extension-cjk-friendly";
import type { Nodes, Root } from "mdast";
import { raftMath } from "./markdownMath";
import { markdownStructure, visitOutsideRanges } from "./markdownRanges";
import { createRaftUserRefRegex, RAFT_REF_USER_NAME_PATTERN } from "./raftRefs";

/** The mdast node types card Markdown may contain (`root` aside). */
export const MESSAGE_CARD_MARKDOWN_NODE_TYPES = [
  "paragraph", "text", "break", "strong", "emphasis", "delete", "inlineCode", "code", "list", "listItem", "blockquote", "link",
] as const;
export type MessageCardMarkdownNodeType = typeof MESSAGE_CARD_MARKDOWN_NODE_TYPES[number];
const ALLOWED_TYPES: ReadonlySet<string> = new Set<string>(MESSAGE_CARD_MARKDOWN_NODE_TYPES);

/** Lists and quotes, together, nest at most this many levels (a top-level list is level 1). */
export const MESSAGE_CARD_MARKDOWN_MAX_NESTING = 3;

/**
 * A link's URL schemes: a message's own links' (the web's markdown renderer
 * keeps http, https and mailto hrefs), so GFM's email autolinks are links. A
 * card Button stays https: only.
 */
const LINK_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto"]);
const URL_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** What the subset allows, as a refusal says it. */
export const MESSAGE_CARD_MARKDOWN_ALLOWED_SUMMARY =
  "card Markdown has paragraphs, line breaks, **bold**, _italic_, ~~strikethrough~~, `inline code`, fenced code blocks, lists, quotes (nested at most 3 levels), and http:, https: and mailto: links";

/**
 * Parses `source` as the web parses a message (see the top of this file).
 * The tree is the caller's to change.
 */
export function parseMessageCardMarkdown(source: string): Root {
  return fromMarkdown(source, {
    extensions: [gfm(), cjkFriendlyExtension(), raftMath(), { disable: { null: ["codeIndented"] } }],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
}

// Parsed at send (the check), and each time agents read a card (the text):
// the last few trees are kept. Never handed out: callers may not change them.
const treeCache = new Map<string, Root>();
const TREE_CACHE_LIMIT = 64;
function cachedTree(source: string): Root {
  const cached = treeCache.get(source);
  if (cached) return cached;
  const tree = parseMessageCardMarkdown(source);
  treeCache.set(source, tree);
  if (treeCache.size > TREE_CACHE_LIMIT) treeCache.delete(treeCache.keys().next().value as string);
  return tree;
}

/** One node outside the subset. */
export interface MessageCardMarkdownViolation {
  node: Nodes;
  /**
   * What was found, as the 400 names it: the mdast node type (`heading`,
   * `html`, `image`, `table`, `thematicBreak`, `linkReference`, `definition`,
   * `footnoteReference`, `footnoteDefinition`, `math`, `inlineMath`, ...),
   * `link` for a link to another scheme (not http:, https: or mailto:), `list` or `blockquote` nested too
   * deep, `taskListItem` for a GFM task list item (`- [ ]`).
   */
  found: string;
  /** What it is, in words: "a heading", "a link to tel: (not http:, https: or mailto:)". */
  description: string;
}

function linkSchemeDescription(url: string): string | null {
  const scheme = URL_SCHEME.exec(url)?.[1]?.toLowerCase();
  if (!scheme) return `a link to ${JSON.stringify(url.slice(0, 60))} (not an http:, https: or mailto: URL)`;
  if (!LINK_SCHEMES.has(scheme)) return `a link to ${scheme}: (not http:, https: or mailto:)`;
  try {
    new URL(url);
    return null;
  } catch {
    return `a link to ${JSON.stringify(url.slice(0, 60))} (not a URL)`;
  }
}

const NODE_DESCRIPTIONS: Record<string, string> = {
  heading: "a heading",
  thematicBreak: "a horizontal rule (a Divider element draws one)",
  image: "an image",
  imageReference: "an image",
  linkReference: "a reference-style link",
  definition: "a link reference definition",
  footnoteReference: "a footnote",
  footnoteDefinition: "a footnote",
  table: "a table",
  tableRow: "a table",
  tableCell: "a table",
  html: "HTML",
  math: "math",
  inlineMath: "math",
};

/** Why `node` (at `nesting` lists and quotes deep, itself included) is outside the subset; null when it is in it. */
function violationOf(node: Nodes, nesting: number): Omit<MessageCardMarkdownViolation, "node"> | null {
  if (!ALLOWED_TYPES.has(node.type)) {
    return { found: node.type, description: NODE_DESCRIPTIONS[node.type] ?? `a ${node.type} node` };
  }
  // A `code` node is a fenced block: indented code is off (as in chat).
  switch (node.type) {
    case "link": {
      const description = linkSchemeDescription(node.url);
      return description ? { found: "link", description } : null;
    }
    case "listItem":
      return typeof node.checked === "boolean" ? { found: "taskListItem", description: "a task list item ([ ] or [x])" } : null;
    case "list": case "blockquote":
      return nesting > MESSAGE_CARD_MARKDOWN_MAX_NESTING
        ? { found: node.type, description: `a ${node.type === "list" ? "list" : "quote"} nested ${nesting} levels deep (lists and quotes nest at most ${MESSAGE_CARD_MARKDOWN_MAX_NESTING})` }
        : null;
    default:
      return null;
  }
}

/**
 * Every node of `tree` outside the subset, in document order, outermost
 * first: nothing inside one is looked at. Empty when the whole tree is in it.
 * Clients draw each as its source text; the Server refuses the first.
 */
export function messageCardMarkdownViolations(tree: Root): MessageCardMarkdownViolation[] {
  const violations: MessageCardMarkdownViolation[] = [];
  const visit = (node: Nodes, nesting: number) => {
    const depth = node.type === "list" || node.type === "blockquote" ? nesting + 1 : nesting;
    const violation = node.type === "root" ? null : violationOf(node, depth);
    if (violation) {
      violations.push({ node, ...violation });
      return;
    }
    if ("children" in node) for (const child of node.children as Nodes[]) visit(child, depth);
  };
  visit(tree, 0);
  return violations;
}

/** The first node of `content` outside the subset (as the Server checks it at send and update), with where it starts; null when there is none. */
export function checkMessageCardMarkdown(content: string): (MessageCardMarkdownViolation & { line: number; column: number }) | null {
  const [first] = messageCardMarkdownViolations(cachedTree(content));
  if (!first) return null;
  return { ...first, line: first.node.position?.start.line ?? 1, column: first.node.position?.start.column ?? 1 };
}

// ---------------------------------------------------------------------------
// The content as agents read it (RFC 082 §4.3, v2.0).

/** One stretch of rendered markdown, never cut; `opens` names what ends the span it starts, `closes` ends one. */
export interface CardMarkdownToken {
  text: string;
  opens?: string;
  closes?: true;
}

// Where the Server's mention parser sees no mention (raftRefs.ts): inside a bare URL.
const BARE_URL = /https?:\/\/[^\s<>]+/g;
// `@a@b`: once `@a` is code, `@b` would start the text after it, so it goes into the same span.
const MENTION_CHAIN = new RegExp(`^(?:@${RAFT_REF_USER_NAME_PATTERN})+`, "u");
// An `@` written as an escape or a character reference: the web's mention chips read the decoded text, so it is an `@` too.
const AT_REFERENCE = /^(?:&#0*64;|&#[xX]0*40;|&commat;)/;
const LEADING_BLANK_LINES = /^(?:[ \t]*(?:\r\n|\n|\r))+/;

function longestBacktickRun(text: string): number {
  return Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
}

/** Whether the character at `index` is escaped: an odd run of backslashes right before it. */
function escapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let at = index - 1; at >= 0 && text[at] === "\\"; at--) backslashes++;
  return backslashes % 2 === 1;
}

/**
 * `text` with every `@` it writes as one (`\@`, `&#64;`, `&#x40;`,
 * `&commat;`) read as `@`, and where each of its characters starts in `text`
 * (one more entry: the end).
 */
function atView(text: string): { view: string; at: number[] } {
  let view = "";
  const at: number[] = [];
  for (let index = 0; index < text.length;) {
    const written = text[index] === "\\" && text[index + 1] === "@" && !escapedAt(text, index) ? "\\@"
      : text[index] === "&" && !escapedAt(text, index) ? AT_REFERENCE.exec(text.slice(index))?.[0] : undefined;
    view += written ? "@" : text[index];
    at.push(index);
    index += written ? written.length : 1;
  }
  at.push(text.length);
  return { view, at };
}

/** Where each text node outside links starts and ends in `source`: where the web looks for mention chips. */
function proseTextRanges(source: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  const visit = (node: Nodes) => {
    if (node.type === "link" || node.type === "linkReference") return;
    if (node.type === "text" && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      ranges.push([node.position.start.offset, node.position.end.offset]);
    }
    if ("children" in node) for (const child of node.children as Nodes[]) visit(child);
  };
  visit(cachedTree(source));
  return ranges;
}

/**
 * Each `@name` a reader could take for a mention in `source` (outside code
 * and links, not in a bare URL) as inline code. The Server's mention parser
 * reads the source as written (`a\@b` is a mention of b to it); the web's
 * chips read each text node as shown, its emphasis marks and escapes gone
 * (`_@a_` and `&#64;a` are mentions to them): both are wrapped. An `@`
 * written as an escape or a character reference is set as a plain `@` in the
 * code: it shows the same. The fence is longer than any backtick run outside
 * code (a backtick the sender left unpaired), so it pairs with nothing the
 * sender wrote, and stands apart from a backtick next to it.
 */
function wrapMentions(source: string): string {
  const { code, links } = markdownStructure(source);
  const prose = proseTextRanges(source);
  let unpaired = 0;
  visitOutsideRanges(source, code, (chunk) => {
    unpaired = Math.max(unpaired, longestBacktickRun(chunk));
  });
  const fence = "`".repeat(unpaired + 1);
  let out = "";
  let cursor = 0;
  visitOutsideRanges(source, [...code, ...links], (chunk, offset) => {
    const { view, at: sourceAt } = atView(chunk);
    const urls = Array.from(view.matchAll(BARE_URL), (match) => [match.index, match.index + match[0].length] as const);
    // Where a mention starts, in the view: as shown, and as written.
    const viewOf = new Map<number, number>();
    for (let index = 0; index < view.length; index++) {
      const at = sourceAt[index]!;
      // An `@` written `\@`: the Server's parser finds its `@` one character on.
      viewOf.set(view[index] === "@" && chunk[at] === "\\" ? at + 1 : at, index);
    }
    // Each start, with where its name may end: the chunk's end as written, its text node's end as shown (`_@a_`: the `_` closes the emphasis).
    const starts = new Map<number, number>();
    const add = (from: number, limit: number) => starts.set(from, Math.max(starts.get(from) ?? 0, limit));
    for (const match of view.matchAll(createRaftUserRefRegex())) add(match.index + match[1]!.length, view.length);
    for (const match of chunk.matchAll(createRaftUserRefRegex())) {
      const from = viewOf.get(match.index + match[1]!.length);
      if (from !== undefined) add(from, view.length);
    }
    for (const [start, end] of prose) {
      const from = viewOf.get(start - offset);
      const to = end - offset === chunk.length ? view.length : viewOf.get(end - offset);
      if (from === undefined || to === undefined) continue;
      for (const match of view.slice(from, to).matchAll(createRaftUserRefRegex())) add(from + match.index + match[1]!.length, to);
    }
    let covered = 0;
    for (const [from, limit] of [...starts].sort(([a], [b]) => a - b)) {
      if (from < covered || urls.some(([start, end]) => from >= start && from < end)) continue;
      const to = from + MENTION_CHAIN.exec(view.slice(from, limit))![0].length;
      const start = offset + sourceAt[from]!;
      const end = offset + sourceAt[to]!;
      out += source.slice(cursor, start)
        + (source[start - 1] === "`" ? " " : "") + fence + view.slice(from, to) + fence + (source[end] === "`" ? " " : "");
      cursor = end;
      covered = to;
    }
  });
  return out + source.slice(cursor);
}

/** The prefix a line inside the node's container starts with: its first line's prefix with list markers as spaces. */
function containerPrefix(source: string, start: number): string {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  return source.slice(lineStart, start).replace(/[^>\s]/g, " ");
}

/** The fence that closes a fenced code node, and whether the source already closes it. */
function codeFence(source: string, node: Extract<Nodes, { type: "code" }>): { closer: string; closed: boolean; firstBreak: number; lastBreak: number } | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return null;
  const text = source.slice(start, end);
  const fence = /^(`{3,}|~{3,})/.exec(text)?.[1];
  if (!fence) return null;
  const firstBreak = text.indexOf("\n");
  const lastBreak = text.lastIndexOf("\n");
  const lastLine = text.slice(lastBreak + 1).replace(/^[>\s]*/, "");
  const closing = new RegExp(`^${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
  return {
    closer: `\n${containerPrefix(source, start)}${fence}`,
    closed: firstBreak >= 0 && lastBreak > firstBreak && closing.test(lastLine),
    firstBreak,
    lastBreak,
  };
}

/**
 * A card Markdown's content as agents read it (and as the derived fallback
 * carries it): as it stands, each `@name` outside code and links as inline
 * code. Blank lines before it and whitespace after it are dropped, and a
 * fenced code block left open at its end is closed, so what follows the
 * element on the card is not taken into it. Empty when it says nothing.
 */
export function messageCardMarkdownAgentSource(content: string): string {
  const trimmed = content.replace(LEADING_BLANK_LINES, "").trimEnd();
  if (!trimmed.trim()) return "";
  let source = wrapMentions(trimmed);
  let open: string | null = null;
  const visit = (node: Nodes) => {
    if (node.type === "code" && node.position?.end.offset === source.length) {
      const fence = codeFence(source, node);
      if (fence && !fence.closed) open = fence.closer;
    }
    if ("children" in node) for (const child of node.children as Nodes[]) visit(child);
  };
  visit(cachedTree(source));
  if (open) source += open;
  return source;
}

const ESCAPE = /^\\[!-/:-@[-`{-~]/;
const ENTITY = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/;

/**
 * `source` (card Markdown as agents read it) as tokens for a cut: an inline
 * code span, an autolink, an escape or an entity is one token; bold, italic,
 * strikethrough and a link's label are spans (a cut inside one still closes
 * it: `**Bui…**`, `[Ope…](https://…)`), and so is a closed fenced code block.
 * Everything else a code point at a time.
 */
export function messageCardMarkdownTokens(source: string): CardMarkdownToken[] {
  const tokens: CardMarkdownToken[] = [];
  let cursor = 0;
  const plainTo = (end: number) => {
    while (cursor < end) {
      const rest = source.slice(cursor, end);
      const text = ESCAPE.exec(rest)?.[0] ?? ENTITY.exec(rest)?.[0] ?? String.fromCodePoint(source.codePointAt(cursor)!);
      tokens.push({ text });
      cursor += text.length;
    }
  };
  const whole = (start: number, end: number) => {
    plainTo(start);
    tokens.push({ text: source.slice(start, end) });
    cursor = end;
  };
  const span = (start: number, inner: number, innerEnd: number, end: number, children: readonly Nodes[]) => {
    plainTo(start);
    tokens.push({ text: source.slice(start, inner), opens: source.slice(innerEnd, end) });
    cursor = inner;
    for (const child of children) visit(child);
    plainTo(innerEnd);
    tokens.push({ text: source.slice(innerEnd, end), closes: true });
    cursor = end;
  };
  const visit = (node: Nodes) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined || start < cursor) return;
    const children = "children" in node ? node.children as Nodes[] : [];
    const inner = children[0]?.position?.start.offset;
    const innerEnd = children[children.length - 1]?.position?.end.offset;
    switch (node.type) {
      case "inlineCode":
        whole(start, end);
        return;
      case "link":
        if (source[start] === "[" && inner !== undefined && innerEnd !== undefined) span(start, inner, innerEnd, end, children);
        else whole(start, end);
        return;
      case "strong": case "emphasis": case "delete":
        if (inner !== undefined && innerEnd !== undefined) span(start, inner, innerEnd, end, children);
        else whole(start, end);
        return;
      case "code": {
        const fence = codeFence(source, node);
        if (!fence?.closed) return;
        plainTo(start);
        tokens.push({ text: source.slice(start, start + fence.firstBreak + 1), opens: source.slice(start + fence.lastBreak, end) });
        cursor = start + fence.firstBreak + 1;
        plainTo(start + fence.lastBreak);
        tokens.push({ text: source.slice(start + fence.lastBreak, end), closes: true });
        cursor = end;
        return;
      }
      default:
        for (const child of children) visit(child);
    }
  };
  visit(cachedTree(source));
  plainTo(source.length);
  return tokens;
}
