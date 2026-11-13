// Task #762: message refs (@mentions, #channels, task refs, thread refs,
// `<target>` refs) and the thread-search highlight are recognised on the
// parsed markdown tree, not by rewriting the source string before parsing.
//
// The parser already knows where code, links and escapes are, so a token
// inside a fenced block (``` or ~~~), an inline code span, a link label or a
// URL is never touched — no placeholder and no hand-written "where is code"
// regex. What a token becomes is still decided by MessageItem; this module
// only walks text and splices nodes in.

import type { Html, Link, Nodes, Parent, PhrasingContent, Root, Text } from "mdast";
import type { VFile } from "vfile";
import { alignWithSource, pointAt } from "../../utils/markdownSourceAlignment";
import type { SourceAlignment } from "../../utils/markdownSourceAlignment";

/**
 * A node this module creates. It renders as `data.hName` with
 * `data.hProperties`, and its own text is never matched again, which is what
 * the old placeholders were for (a `dm:@peer` ref must not lose `@peer` to the
 * mention pass).
 */
export interface MessageTokenNode extends Parent {
  type: "messageToken";
  children: PhrasingContent[];
  data: { hName: string; hProperties?: Record<string, string> };
}

declare module "mdast" {
  interface PhrasingContentMap {
    messageToken: MessageTokenNode;
  }
  interface RootContentMap {
    messageToken: MessageTokenNode;
  }
}

export function messageTokenNode(
  hName: string,
  label: string | PhrasingContent[],
  hProperties?: Record<string, string>,
): MessageTokenNode {
  return {
    type: "messageToken",
    data: hProperties ? { hName, hProperties } : { hName },
    children: typeof label === "string" ? [{ type: "text", value: label }] : label,
  };
}

/** What a matcher puts in place of one match. */
export type TokenReplacement = string | PhrasingContent | PhrasingContent[];

export interface TokenContext {
  /**
   * True when the match's first character was written as a backslash escape
   * in the source (`\<@alice>`). The parser drops the backslash from the text
   * value, so only the source can tell.
   */
  escaped: boolean;
  /**
   * True inside a block quote (any depth, lazy continuation lines included).
   * Quoted text repeats someone else's words, so an `@handle` in it is not a
   * mention (the server's extractRaftMentionHandles skips quotes too).
   */
  inQuote: boolean;
}

export interface TextTokenMatcher {
  /** Must be global. Group handling is the replacer's business. */
  pattern: RegExp;
  /** `false` keeps the match as plain text for later matchers to see. */
  replace: (match: RegExpExecArray, context: TokenContext) => TokenReplacement | false;
}

const SKIPPED_PARENTS: ReadonlySet<string> = new Set(["link", "linkReference", "messageToken", "inlineCode", "code", "html"]);
/** For the thread-search highlight, which also marks text inside link labels. */
export const SKIP_CODE_AND_TOKENS: ReadonlySet<string> = new Set(["messageToken", "inlineCode", "code", "html"]);

function isParent(node: Nodes): node is Parent & Nodes {
  return Array.isArray((node as Parent).children);
}

function toNodes(replacement: TokenReplacement): PhrasingContent[] {
  if (typeof replacement === "string") return replacement ? [{ type: "text", value: replacement }] : [];
  return Array.isArray(replacement) ? replacement : [replacement];
}

function mergeAdjacentText(children: PhrasingContent[]): PhrasingContent[] {
  const merged: PhrasingContent[] = [];
  for (const child of children) {
    const previous = merged.at(-1);
    if (child.type === "text" && previous?.type === "text") {
      // Keep the source span when both halves have one: the escape check
      // reads the source through it.
      const position = previous.position && child.position
        ? { start: previous.position.start, end: child.position.end }
        : undefined;
      merged[merged.length - 1] = { type: "text", value: previous.value + child.value, ...(position ? { position } : {}) };
    } else {
      merged.push(child);
    }
  }
  return merged;
}

function alignmentOf(node: Text, file: VFile | undefined): SourceAlignment | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (file === undefined || start === undefined || end === undefined) return null;
  return alignWithSource(node.value, String(file.value).slice(start, end), start);
}

function splitText(
  node: Text,
  file: VFile | undefined,
  matcher: TextTokenMatcher,
  inQuote: boolean,
): PhrasingContent[] | null {
  const { value } = node;
  const alignment = alignmentOf(node, file);
  const source = file ? String(file.value) : "";
  // Slices keep a source position, so later matchers can still read escapes.
  const slice = (from: number, to: number): Text => {
    const text: Text = { type: "text", value: value.slice(from, to) };
    if (alignment) {
      text.position = { start: pointAt(source, alignment.offsets[from]), end: pointAt(source, alignment.offsets[to]) };
    }
    return text;
  };
  const pattern = new RegExp(matcher.pattern.source, matcher.pattern.flags);
  const out: PhrasingContent[] = [];
  let cursor = 0;
  let changed = false;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    if (match[0] === "") {
      pattern.lastIndex += 1;
      continue;
    }
    const replacement = matcher.replace(match, { escaped: alignment?.escaped.has(match.index) ?? false, inQuote });
    if (replacement === false) continue;
    if (match.index > cursor) out.push(slice(cursor, match.index));
    out.push(...toNodes(replacement));
    cursor = match.index + match[0].length;
    changed = true;
  }
  if (!changed) return null;
  if (cursor < value.length) out.push(slice(cursor, value.length));
  return out;
}

/**
 * Run matchers in order over every text node outside code and links. Each
 * matcher sees only text the earlier ones left as text, which keeps the old
 * "thread refs before mentions" precedence. Text in one parent is joined
 * first so a token is not missed because the parser split it in two.
 */
export function replaceTokensInTree(
  tree: Root,
  matchers: readonly TextTokenMatcher[],
  file?: VFile,
  skippedParents: ReadonlySet<string> = SKIPPED_PARENTS,
): void {
  if (matchers.length === 0) return;
  const visit = (parent: Parent, inQuote: boolean) => {
    if (skippedParents.has(parent.type)) return;
    for (const child of parent.children as Nodes[]) {
      if (isParent(child)) visit(child, inQuote || child.type === "blockquote");
    }
    if (!parent.children.some((child) => child.type === "text")) return;

    let children = mergeAdjacentText(parent.children as PhrasingContent[]);
    for (const matcher of matchers) {
      const next: PhrasingContent[] = [];
      for (const child of children) {
        if (child.type !== "text") {
          next.push(child);
          continue;
        }
        const split = splitText(child, file, matcher, inQuote);
        if (split) next.push(...split);
        else next.push(child);
      }
      children = next;
    }
    parent.children = children as Parent["children"];
  };
  visit(tree, false);
}

/**
 * Replace each link node whose destination `toToken` recognises. Used for
 * `[label](<target>)` and `<scheme:target>` autolinks, which the parser has
 * already turned into links.
 */
export function replaceLinksInTree(
  tree: Root,
  toToken: (link: Link, context: { inQuote: boolean }) => PhrasingContent | null,
): void {
  const visit = (parent: Parent, inQuote: boolean) => {
    parent.children = (parent.children as Nodes[]).map((child) => {
      if (child.type === "link") return toToken(child, { inQuote }) ?? child;
      if (isParent(child) && !SKIPPED_PARENTS.has(child.type)) visit(child, inQuote || child.type === "blockquote");
      return child;
    }) as Parent["children"];
  };
  visit(tree, false);
}

/**
 * Raw HTML that a user typed is shown as the text they typed. Before #762
 * this was an `&lt;` rewrite of the source; on the tree it is just the `html`
 * node's own value. A block of HTML becomes a paragraph so the tree stays
 * valid. Runs before remark-breaks so its newlines still become line breaks.
 */
export function remarkRawHtmlAsText() {
  return (tree: Root) => {
    const visit = (parent: Parent, inPhrasing: boolean) => {
      parent.children = (parent.children as Nodes[]).map((child) => {
        if (child.type === "html") {
          const text: Text = { type: "text", value: (child as Html).value, position: child.position };
          return inPhrasing ? text : { type: "paragraph", children: [text], position: child.position };
        }
        if (isParent(child)) {
          visit(child, child.type === "paragraph" || child.type === "heading" || child.type === "tableCell"
            || child.type === "emphasis" || child.type === "strong" || child.type === "delete"
            || child.type === "link" || child.type === "linkReference");
        }
        return child;
      }) as Parent["children"];
    };
    visit(tree, false);
  };
}

/** Text value of a node, for link labels. */
export function plainTextOf(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (isParent(node)) return (node.children as Nodes[]).map(plainTextOf).join("");
  return "";
}
