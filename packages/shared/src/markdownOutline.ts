// The headings of a markdown document as the markdown parser reads them, for
// the outline beside a `.md` preview. The preview renders with the same
// parser (react-markdown, i.e. mdast + GFM + Raft math), so a heading here is
// exactly a heading there, on the same source line. It replaces a
// line-by-line regex scan that missed `Title\n===` headings, and stripped
// `*` and backticks out of code spans and escapes.

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { cjkFriendlyExtension } from "micromark-extension-cjk-friendly";
import { mathFromMarkdown } from "mdast-util-math";
import { raftMath } from "./markdownMath";
import type { Nodes, Parent } from "mdast";

export interface MarkdownHeading {
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  /** 1-based source line where the heading starts. */
  line: number;
  /** The heading as read: code and formulas as written, link and image text, no markup or HTML tags. */
  text: string;
}

function isParent(node: Nodes): node is Parent & Nodes {
  return Array.isArray((node as Parent).children);
}

function plainText(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "inlineMath":
      return node.value;
    case "image":
      return node.alt ?? "";
    case "html":
      return "";
    default:
      return isParent(node) ? (node.children as Nodes[]).map(plainText).join("") : "";
  }
}

/** Every heading of `source`, in document order. */
export function markdownHeadings(source: string): MarkdownHeading[] {
  const tree = fromMarkdown(source, {
    extensions: [gfm(), cjkFriendlyExtension(), raftMath()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
  const headings: MarkdownHeading[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "heading") {
      const line = node.position?.start.line;
      if (line !== undefined) {
        headings.push({ depth: node.depth, line, text: plainText(node).replace(/\s+/g, " ").trim() });
      }
      return;
    }
    if (isParent(node)) for (const child of node.children as Nodes[]) visit(child);
  };
  visit(tree);
  return headings;
}
