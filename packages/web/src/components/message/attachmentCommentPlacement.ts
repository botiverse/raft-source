// Where a comment sits in the rendered file (task #118: comments beside the
// passage they are about, raft-design patterns/comments.md).
//
// A stored anchor (attachmentCommentAnchors.ts) names a place structurally:
// a Markdown section plus the quoted text, a run of lines, a run of CSV rows.
// This module turns it into a DOM Range inside the open preview, which the
// margin measures for the card's top and highlights. It never changes the
// document's DOM.

import type { StoredAnchor } from "./attachmentCommentAnchors";

export type CommentPlacement =
  /** Placed beside the document. `exact` is false when only the section's
   *  heading was found, not the quoted text in it. */
  | { kind: "placed"; range: Range; exact: boolean }
  /** The anchor's place is gone from the document (it changed under it). */
  | { kind: "lost" }
  /** An anchor this surface can't measure (an HTML region, a video time):
   *  the preview that owns it shows it its own way. */
  | { kind: "unsupported" };

const HEADING_SELECTOR = "h1[id], h2[id], h3[id]";

// Elements that start a new block (or line) of text. Where the DOM moves
// from one to the next, a reader's selection puts whitespace (a newline, a
// tab between table cells) that no text node has; inline elements (bold,
// code, links) split a run of text with nothing between the pieces.
const BLOCK_BOUNDARY = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "CAPTION", "DD", "DETAILS", "DIV", "DL", "DT",
  "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN",
  "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

/** One character of the text a quote is searched in: where it came from, or a block boundary. */
type Char = { ch: string; node: Text; offset: number } | { ch: " "; node: null; offset: -1 };

const BOUNDARY: Char = { ch: " ", node: null, offset: -1 };

/** The text of `scope` inside `root`, character by character, with a space at each block boundary. */
function charsIn(root: Node, scope: Range): Char[] {
  const chars: Char[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!scope.intersectsNode(node)) return;
      const value = node.nodeValue ?? "";
      for (let i = 0; i < value.length; i++) chars.push({ ch: value[i]!, node: node as Text, offset: i });
      return;
    }
    const block = node.nodeType === Node.ELEMENT_NODE && BLOCK_BOUNDARY.has((node as Element).tagName);
    if (block) chars.push(BOUNDARY);
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
    if (block) chars.push(BOUNDARY);
  };
  visit(root);
  return chars;
}

/** The range of `chars[from]` through `chars[to]`, both real characters. */
function rangeOf(chars: readonly Char[], from: number, to: number): Range | null {
  const first = chars[from];
  const last = chars[to];
  if (!first?.node || !last?.node) return null;
  const range = first.node.ownerDocument!.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

/**
 * Where `needle` first appears in `chars`, comparing them after `fold`
 * (each character to itself, a space, or nothing). `needle` must already be
 * folded, with no space at either end.
 */
function search(chars: readonly Char[], needle: string, fold: (ch: string, previous: string) => string): Range | null {
  // Collect the folded characters and join them once. Reading the end of a
  // string grown with += (hay.slice(-1), hay[hay.length - 1]) makes V8 flatten
  // it every time, which turns a long section into quadratic work.
  const parts: string[] = [];
  const map: number[] = [];
  let previous = "";
  for (let i = 0; i < chars.length; i++) {
    const folded = fold(chars[i]!.ch, previous);
    if (!folded) continue;
    parts.push(folded);
    map.push(i);
    previous = folded;
  }
  const hay = parts.join("");
  const at = hay.indexOf(needle);
  if (at < 0) return null;
  return rangeOf(chars, map[at]!, map[at + needle.length - 1]!);
}

const WHITESPACE = /\s/u;

/** Whitespace runs (and block boundaries) as one space. */
const collapse = (ch: string, previous: string) => (WHITESPACE.test(ch) ? (previous === " " || previous === "" ? "" : " ") : ch);
/** No whitespace at all. */
const strip = (ch: string) => (WHITESPACE.test(ch) ? "" : ch);

/**
 * The range where `quote` first appears in `chars`, matching across element
 * boundaries. A quote cut with "…" (stored quotes are capped) matches on what
 * precedes the ellipsis.
 *
 * First with every whitespace run as one space, a block boundary counting as
 * whitespace: that is how a selection reads the text (no space where bold or
 * code meets the words around it, a newline between two list items), and it keeps
 * "apart" from matching an earlier "a part". Only when that finds nothing,
 * with whitespace ignored altogether, for a quote whose spacing differs from
 * the DOM's in some other way.
 */
function findQuote(chars: readonly Char[], quote: string): Range | null {
  const spaced = quote.replace(/…$/u, "").trim().replace(/\s+/gu, " ");
  if (!spaced || chars.length === 0) return null;
  return search(chars, spaced, collapse) ?? search(chars, spaced.replace(/ /gu, ""), strip);
}

function placeMarkdownSection(root: HTMLElement, anchor: StoredAnchor): CommentPlacement {
  const id = typeof anchor.data.headingId === "string" ? anchor.data.headingId : "";
  const heading = id ? root.querySelector<HTMLElement>(`#${CSS.escape(id)}`) : null;
  if (!heading) return { kind: "lost" };
  const headings = Array.from(root.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
  const next = headings[headings.indexOf(heading) + 1] ?? null;
  const quote = typeof anchor.data.quote === "string" ? anchor.data.quote : "";
  if (quote) {
    const section = root.ownerDocument.createRange();
    section.setStartBefore(heading);
    if (next) section.setEndBefore(next);
    else section.setEnd(root, root.childNodes.length);
    const range = findQuote(charsIn(root, section), quote);
    if (range) return { kind: "placed", range, exact: true };
  }
  // The section is still there but not the quoted words: the comment is about
  // the section, so it sits by its heading.
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(heading);
  return { kind: "placed", range, exact: !quote };
}

function placeRun(root: HTMLElement, anchor: StoredAnchor, attr: string): CommentPlacement {
  const start = Number(anchor.data.start);
  const end = Number(anchor.data.end ?? start);
  if (!Number.isFinite(start)) return { kind: "lost" };
  const first = root.querySelector<HTMLElement>(`[${attr}="${start}"]`);
  if (!first) return { kind: "lost" };
  const last = (Number.isFinite(end) ? root.querySelector<HTMLElement>(`[${attr}="${end}"]`) : null) ?? first;
  const range = root.ownerDocument.createRange();
  range.setStartBefore(first);
  range.setEndAfter(last);
  return { kind: "placed", range, exact: true };
}

/** Where `anchor` sits inside `root`, the element that holds the rendered document (the margin's document column). */
export function placeAnchor(root: HTMLElement, anchor: StoredAnchor): CommentPlacement {
  switch (anchor.type) {
    case "md-section":
      return placeMarkdownSection(root, anchor);
    case "lines":
      return placeRun(root, anchor, "data-anchor-line");
    case "csv-rows":
      return placeRun(root, anchor, "data-anchor-row");
    default:
      return { kind: "unsupported" };
  }
}
