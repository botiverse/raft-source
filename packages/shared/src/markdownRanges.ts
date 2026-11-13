// Task #762: where a message's code and links are, as the markdown parser
// sees them. The web renders messages with this parser (react-markdown, i.e.
// mdast + GFM), so asking the same parser keeps "shown as code" and "skipped
// when looking for @mentions" the same thing. It replaces hand-written fence
// and backtick regexes that missed `~~~` fences, longer backtick runs and
// unclosed fences.

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { cjkFriendlyExtension } from "micromark-extension-cjk-friendly";
import { mathFromMarkdown } from "mdast-util-math";
import { raftMath } from "./markdownMath";
import type { Blockquote, Nodes, Parent } from "mdast";

export interface SourceRange {
  start: number;
  end: number;
}

export interface MarkdownLinkInfo extends SourceRange {
  /** The destination as the parser read it (angle brackets removed). */
  url: string;
  /** `[label](<target>)` or `<target>`: the forms Raft treats as refs. */
  angleBracketed: boolean;
}

export interface MarkdownStructure {
  /** Fenced, indented and inline code, and math (task #775). */
  code: SourceRange[];
  /** Links (label and destination), autolinks, link references, images, definitions. */
  links: MarkdownLinkInfo[];
  /**
   * Block quotes, as the web draws them. Quoted text is someone else's words,
   * so an `@` in it is not a mention. Code and links inside a quote are still
   * listed above.
   */
  quotes: SourceRange[];
}

// Math is source, like code: an `@` or a link inside a formula is not one.
const CODE_TYPES = new Set(["code", "inlineCode", "math", "inlineMath"]);
const LINK_TYPES = new Set(["link", "linkReference", "image", "imageReference", "definition"]);

function isParent(node: Nodes): node is Parent & Nodes {
  return Array.isArray((node as Parent).children);
}

// Inline nodes that are drawn whole: a quote never ends inside one.
const ATOMIC_INLINE_TYPES = new Set(["inlineCode", "inlineMath", "html", ...LINK_TYPES]);

/** `offset`, or the end of the atomic inline node under `parent` it falls inside. */
function pastAtomicInline(parent: Parent, offset: number): number {
  for (const child of parent.children as Nodes[]) {
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (start === undefined || end === undefined || offset <= start || offset >= end) continue;
    if (ATOMIC_INLINE_TYPES.has(child.type)) return end;
    return isParent(child) ? pastAtomicInline(child, offset) : offset;
  }
  return offset;
}

/**
 * Where a top-level block quote ends as it is drawn, or null when that is
 * where the parser ends it. CommonMark's lazy continuation pulls an unquoted
 * line after `> quote` into the quote; writers (and LLMs) mean a new
 * paragraph. So the quote ends where the first line of its last paragraph
 * that does not start with `>` starts (after a hard break too, and inside
 * emphasis), and the rest of that paragraph is drawn after the quote. A code
 * span, formula or link the line starts inside is kept whole in the quote.
 *
 * The one rule for both sides: the Server's mention parse (`quotes` above)
 * and the web, which splits the drawn tree at this offset
 * (repairGeneratedMarkdown's splitLazyBlockquoteContinuation). `quote` must
 * be a node parsed from `source`. A nested quote's lazy lines stay in it.
 */
export function drawnQuoteEnd(source: string, quote: Blockquote): number | null {
  const last = quote.children.at(-1);
  if (last?.type !== "paragraph") return null;
  const paragraphStart = last.position?.start.offset;
  const paragraphEnd = last.position?.end.offset;
  if (paragraphStart === undefined || paragraphEnd === undefined) return null;
  for (let newline = source.indexOf("\n", paragraphStart); newline !== -1 && newline < paragraphEnd; newline = source.indexOf("\n", newline + 1)) {
    const lineEnd = source.indexOf("\n", newline + 1);
    if (/^\s*>/.test(source.slice(newline + 1, lineEnd === -1 ? undefined : lineEnd))) continue;
    const end = pastAtomicInline(last, newline + 1);
    return end < paragraphEnd ? end : null;
  }
  return null;
}

const cache = new Map<string, MarkdownStructure>();
const CACHE_LIMIT = 64;

/**
 * Code, link and quote ranges of `source`, by source offset. Messages are parsed
 * more than once on the send path, so the last few results are kept.
 */
export function markdownStructure(source: string): MarkdownStructure {
  const cached = cache.get(source);
  if (cached) return cached;

  const structure: MarkdownStructure = { code: [], links: [], quotes: [] };
  const tree = fromMarkdown(source, {
    // Same as the web's message renderer (remarkDisableIndentedCode): an
    // indented line in chat is prose, not a code block.
    extensions: [gfm(), cjkFriendlyExtension(), raftMath(), { disable: { null: ["codeIndented"] } }],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
  const visit = (node: Nodes, inQuote: boolean) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (CODE_TYPES.has(node.type)) {
        structure.code.push({ start, end });
        return;
      }
      if (LINK_TYPES.has(node.type)) {
        const raw = source.slice(start, end);
        const url = node.type === "link" || node.type === "definition" ? node.url : "";
        structure.links.push({
          start,
          end,
          url,
          angleBracketed: node.type === "link" && (raw === `<${url}>` || /\]\(<[^<>\n]+>\)$/.test(raw)),
        });
        return;
      }
      if (node.type === "blockquote" && !inQuote) {
        structure.quotes.push({ start, end: drawnQuoteEnd(source, node) ?? end });
      }
    }
    if (isParent(node)) for (const child of node.children as Nodes[]) visit(child, inQuote || node.type === "blockquote");
  };
  visit(tree, false);

  cache.set(source, structure);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return structure;
}

/**
 * Call `visitor` for each stretch of `source` outside `ranges`, with its
 * offset. Ranges come from the parser, so they are disjoint and in order.
 */
export function visitOutsideRanges(
  source: string,
  ranges: readonly SourceRange[],
  visitor: (chunk: string, offset: number) => void,
): void {
  let cursor = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (range.end <= cursor) continue;
    if (range.start > cursor) visitor(source.slice(cursor, range.start), cursor);
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < source.length) visitor(source.slice(cursor), cursor);
}
