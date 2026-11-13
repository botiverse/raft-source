// Task #762: three repairs for markdown that LLMs commonly emit, done on the
// parsed tree instead of by rewriting the source before parsing. Working on
// the tree means code is never touched (the old string version ran its
// blockquote fix before protecting code) and links are never split (a URL
// containing `\n` stays one link).

import type { Blockquote, Nodes, Paragraph, Parent, PhrasingContent, Root, Text } from "mdast";
import type { VFile } from "vfile";
import { drawnQuoteEnd } from "@botiverse/raft-shared";
import { alignWithSource, pointAt } from "../../utils/markdownSourceAlignment";
import { replaceTokensInTree } from "./remarkMessageTokens";

function isParent(node: Nodes): node is Parent & Nodes {
  return Array.isArray((node as Parent).children);
}

/**
 * A literal backslash-n (`\n` typed as two characters, as some LLM output
 * arrives) becomes a real newline, which remark-breaks then renders as a line
 * break. Outside code and links only.
 */
function literalNewlinesToNewlines(tree: Root, file: VFile): void {
  replaceTokensInTree(tree, [{ pattern: /\\n/g, replace: () => "\n" }], file);
}

/**
 * `- **Registration: **203 users`: CommonMark does not let the space before
 * `**` close the strong span, so the parser leaves both pairs as literal text.
 * Make it the strong span the writer meant; the space moves outside it.
 */
function strongWithClosingWhitespace(tree: Root, file: VFile): void {
  replaceTokensInTree(tree, [{
    pattern: /\*\*([^*\n]*?\S)([ \t]+)\*\*/g,
    replace: (match, { escaped }) => {
      if (escaped) return false;
      const [, content, whitespace] = match;
      const strong: PhrasingContent = { type: "strong", children: [{ type: "text", value: content }] };
      return [strong, { type: "text", value: whitespace }];
    },
  }], file);
}

/**
 * `> quote` followed by an unquoted line: CommonMark's lazy continuation
 * pulls that line into the quote. Writers (and LLMs) mean a new paragraph, so
 * the unquoted lines move out to a paragraph after the quote. Where the quote
 * ends is raft-shared's drawnQuoteEnd, the same offset the Server's mention
 * parse ends the quote at, so a handle is a chip exactly where it notifies.
 * Runs before remark-breaks, while each source line still ends in a `\n`
 * inside text.
 */
function splitLazyBlockquoteContinuation(tree: Root, file: VFile): void {
  const source = String(file.value ?? "");
  const visit = (parent: Parent) => {
    for (let index = 0; index < parent.children.length; index += 1) {
      const child = parent.children[index] as Nodes;
      if (child.type === "blockquote") {
        const outside = takeLazyLines(child, source);
        if (outside) parent.children.splice(index + 1, 0, outside as never);
      } else if (isParent(child)) {
        visit(child);
      }
    }
  };
  visit(tree);
}

function takeLazyLines(quote: Blockquote, source: string): Paragraph | null {
  const end = drawnQuoteEnd(source, quote);
  const last = quote.children.at(-1);
  if (end === null || last?.type !== "paragraph") return null;
  const [inside, outside] = splitPhrasingAt(last.children, end, source);
  if (outside.length === 0) return null;
  last.children = inside;
  // The quote ended at the end of a link or code span: the line break after
  // it starts the moved paragraph, which would draw as a leading `<br>`.
  const first = outside[0];
  if (first.type === "text") first.value = first.value.replace(/^[ \t]*\n/, "");
  return { type: "paragraph", children: outside };
}

/**
 * Split inline content at a source offset: the start of a line, or the end of
 * a node (drawnQuoteEnd never ends inside a code span, formula or link).
 * Emphasis spanning the offset becomes two, one on each side; text is split
 * at the line break the offset follows, which is dropped.
 */
function splitPhrasingAt(
  children: PhrasingContent[],
  offset: number,
  source: string,
): [PhrasingContent[], PhrasingContent[]] {
  const before: PhrasingContent[] = [];
  const after: PhrasingContent[] = [];
  for (const child of children) {
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (start === undefined || end === undefined) {
      (after.length > 0 ? after : before).push(child);
    } else if (start >= offset) {
      after.push(child);
    } else if (end <= offset) {
      before.push(child);
    } else if (child.type === "text") {
      const [head, tail] = splitTextAt(child, offset, source);
      if (head.value) before.push(head);
      if (tail.value) after.push(tail);
    } else if ("children" in child) {
      const [head, tail] = splitPhrasingAt(child.children as PhrasingContent[], offset, source);
      if (head.length > 0) before.push({ ...child, children: head } as PhrasingContent);
      if (tail.length > 0) after.push({ ...child, children: tail } as PhrasingContent);
    } else {
      before.push(child);
    }
  }
  return [before, after];
}

/**
 * Split a text node at a source offset. The value lost escapes, entity
 * references and `> ` prefixes, so the split index is found through the
 * source alignment, never by counting `\n` in the value (a `&#10;` is one
 * there). Both halves keep their source span, so later matchers still see
 * escapes (`\<@name>`). The line break the offset follows is dropped.
 */
function splitTextAt(text: Text, offset: number, source: string): [Text, Text] {
  const position = text.position;
  const start = position?.start.offset;
  const end = position?.end.offset;
  if (!position || start === undefined || end === undefined) return [text, { type: "text", value: "" }];
  const { offsets } = alignWithSource(text.value, source.slice(start, end), start);
  let at = 0;
  while (at < text.value.length && offsets[at] < offset) at += 1;
  const headEnd = at > 0 && source[offsets[at - 1]] === "\n" ? at - 1 : at;
  return [
    { type: "text", value: text.value.slice(0, headEnd), position: { start: position.start, end: pointAt(source, offset) } },
    { type: "text", value: text.value.slice(at), position: { start: pointAt(source, offset), end: position.end } },
  ];
}

export function repairGeneratedMarkdown(tree: Root, file: VFile): void {
  splitLazyBlockquoteContinuation(tree, file);
  literalNewlinesToNewlines(tree, file);
  strongWithClosingWhitespace(tree, file);
}

/**
 * `dm:@Twin~agent and dm:@Twin~human`: GFM reads the two single tildes as a
 * strikethrough. A `~` right after a `dm:@name` is a peer-kind suffix, so put
 * the tildes back as text before refs are matched.
 */
export function unwrapDmKindStrikethrough(tree: Root, file: VFile): void {
  const source = String(file.value ?? "");
  const visit = (parent: Parent) => {
    const next: Nodes[] = [];
    for (const child of parent.children as Nodes[]) {
      const previous = next.at(-1);
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (
        child.type === "delete"
        && previous?.type === "text"
        && /dm:@[\w.-]+$/u.test(previous.value)
        && start !== undefined && end !== undefined
        && source[start] === "~" && source[start + 1] !== "~"
      ) {
        next.push({ type: "text", value: "~" }, ...(child.children as Nodes[]), { type: "text", value: "~" });
        continue;
      }
      if (isParent(child)) visit(child);
      next.push(child);
    }
    parent.children = next as Parent["children"];
  };
  visit(tree);
}
