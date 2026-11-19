import { Children, isValidElement } from "react";
import type { ReactNode } from "react";

/**
 * The direction a block of text should take, from its first letter
 * (Hebrew, Arabic and the other right-to-left scripts: `rtl`; any other
 * letter: `ltr`; none: `null`). Mentions, #refs, links and inline code are
 * skipped: they are written left to right whatever the text around them, so
 * a Hebrew message that starts with `@alice` is still a right-to-left
 * paragraph (Hands 82e3ca69). `dir="auto"` alone would take the mention's
 * first letter and lay the paragraph out left to right.
 */
const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/u;
const ANY_LETTER = /\p{L}/u;
const SKIPPED_TOKENS = /(?:^|\s)[@#][^\s]+|https?:\/\/\S+|`[^`]*`/gu;

export type TextDirection = "rtl" | "ltr";

export function textDirection(text: string): TextDirection | null {
  for (const char of text.replace(SKIPPED_TOKENS, " ")) {
    if (RTL_LETTER.test(char)) return "rtl";
    if (ANY_LETTER.test(char)) return "ltr";
  }
  return null;
}

/** The plain text of rendered children, without links (mentions, refs, URLs) and inline code. */
function readableText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(readableText).join("");
  if (isValidElement<{ node?: { tagName?: unknown }; children?: ReactNode }>(node)) {
    // react-markdown renders through our components (the element type is a
    // function), passing the source element as `node`: mentions, refs and
    // links are `a` elements there, inline code `code`.
    const tagName = node.props.node?.tagName ?? node.type;
    if (tagName === "a" || tagName === "code") return " ";
    return readableText(node.props.children);
  }
  return Children.toArray(node).map(readableText).join("");
}

/** `dir` for a markdown block from its rendered children: right to left or left to right, else `auto`. */
export function blockDirection(children: ReactNode): TextDirection | "auto" {
  return textDirection(readableText(children)) ?? "auto";
}
