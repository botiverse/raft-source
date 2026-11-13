import type { Heading, Nodes, Parent, PhrasingContent, Root, RootContent, Text } from "mdast";
import type { VFile } from "vfile";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as RehypeSanitizeOptions } from "rehype-sanitize";
import type { Options } from "react-markdown";
import { messageCardMarkdownViolations, parseMessageCardMarkdown } from "@botiverse/raft-shared";

import { markdownSanitizeSchema } from "../markdown/markdownSanitizeSchema";
import { remarkRaftMath } from "../markdown/remarkRaftMath";

/**
 * The context view's Markdown (AgentContextViewMarkdown): the text an agent
 * was given or wrote, which may come from anyone (a web page, a tool's
 * output, another person's message), so it is drawn from a short allowlist
 * and loads nothing.
 *
 * - The card Markdown subset (RFC 082 §4.8, messageCardMarkdownViolations in
 *   raft-shared): paragraphs, line breaks, bold, italic, strikethrough,
 *   inline code, fenced code, lists, quotes and links, plus headings and
 *   rules (system prompts are written with them; neither loads or links
 *   anything). Links are http(s) only here (Tenny): a mailto link or a bare
 *   email is text. A node outside it (an image, HTML, math, a table, a
 *   reference link, a link to another scheme) is drawn as its source text,
 *   so an image is never fetched, HTML never parsed and math never typeset.
 *   No mentions, channel or task refs: `@name` and `#channel` stay text.
 * - Search counts on the visible text, the literal nodes (text, inline code,
 *   code) in document order (agentContextViewMarkdownLiterals, read by
 *   findAgentContextViewMatches), and the render marks every match it
 *   counts, numbered in the same order: a match is never counted and left
 *   unmarked (one in a link's URL or across Markdown syntax is neither).
 *   The parse is the same on both sides (parseMessageCardMarkdown's: GFM,
 *   CJK emphasis, Raft math, no indented code).
 * - A long path or URL (a token over 30 characters) may break after a `/`
 *   (a `wbr`, at most a few hundred per text); a line break in a paragraph
 *   is one (as in chat).
 */

type PluggableList = NonNullable<Options["remarkPlugins"]>;

/** A node this module creates, drawn as `data.hName`. */
interface ContextViewNode extends Parent {
  type: "agentContextViewNode";
  children: PhrasingContent[];
  data: { hName: string; hProperties?: Record<string, string | string[]> };
}

declare module "mdast" {
  interface PhrasingContentMap {
    agentContextViewNode: ContextViewNode;
  }
  interface RootContentMap {
    agentContextViewNode: ContextViewNode;
  }
}

/** Search's pattern, and which of the shown text's matches is the current one (null: none here). */
export type AgentContextViewMarkdownSearch = { pattern: RegExp; hit: number | null };

/** The `data-agent-context-view-match` of a mark: the current match, or another. */
export const AGENT_CONTEXT_VIEW_MATCH_PROPERTY = "dataAgentContextViewMatch";
/** On every block of code this module draws (a fence without a language gets this one), so it is never taken for inline code. */
const PLAIN_LANGUAGE = "language-text";

function node(hName: string, children: PhrasingContent[], hProperties?: Record<string, string | string[]>): ContextViewNode {
  return { type: "agentContextViewNode", data: hProperties ? { hName, hProperties } : { hName }, children };
}

function isParent(value: Nodes): value is Nodes & Parent {
  return "children" in value && Array.isArray(value.children);
}

const FLOW_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

/** The nodes outside the allowlist: the card subset's, less headings (whose own content is checked) and rules. */
function outsideNodes(tree: Root): Set<Nodes> {
  const outside = new Set<Nodes>();
  const collect = (root: Root) => {
    for (const violation of messageCardMarkdownViolations(root)) {
      if (violation.found === "heading") collect({ type: "root", children: (violation.node as Heading).children as RootContent[] });
      else if (violation.found !== "thematicBreak") outside.add(violation.node);
    }
  };
  collect(tree);
  // Links are http(s) only in this view: a mailto link, a bare email (GFM autolinks it) is its source.
  const links = (parent: Nodes) => {
    if (outside.has(parent)) return;
    if (parent.type === "link" && !/^https?:/i.test(parent.url)) {
      outside.add(parent);
      return;
    }
    if (isParent(parent)) for (const child of parent.children as Nodes[]) links(child);
  };
  links(tree);
  return outside;
}

function sourceOf(value: Nodes, source: string): string {
  const start = value.position?.start.offset;
  const end = value.position?.end.offset;
  return start === undefined || end === undefined ? "" : source.slice(start, end);
}

/** Every node outside the allowlist becomes its source text (a paragraph of it where a block stood). */
function drawOutsideAsSource(tree: Root, source: string) {
  const outside = outsideNodes(tree);
  if (outside.size === 0) return;
  const visit = (parent: Parent) => {
    const flow = FLOW_PARENTS.has(parent.type);
    parent.children = (parent.children as Nodes[]).map((child) => {
      if (outside.has(child)) {
        const text: Text = { type: "text", value: sourceOf(child, source), position: child.position };
        return flow ? { type: "paragraph", children: [text], position: child.position } : text;
      }
      if (isParent(child)) visit(child);
      return child;
    }) as Parent["children"];
  };
  visit(tree);
}

/** Numbers the matches in literal after literal, as search counts them. */
type MatchCounter = { search: AgentContextViewMarkdownSearch; next: number };

/** `value` cut at its matches, each a mark numbered by `counter` (the current one so marked). */
function markMatches(value: string, counter: MatchCounter | null): PhrasingContent[] {
  if (!counter || value === "") return [{ type: "text", value }];
  const out: PhrasingContent[] = [];
  const { pattern } = counter.search;
  pattern.lastIndex = 0;
  let from = 0;
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    const hit = counter.next++;
    if (match.index > from) out.push({ type: "text", value: value.slice(from, match.index) });
    out.push(node("mark", [{ type: "text", value: match[0] }], { [AGENT_CONTEXT_VIEW_MATCH_PROPERTY]: hit === counter.search.hit ? "current" : "other" }));
    from = match.index + match[0].length;
  }
  if (out.length === 0) return [{ type: "text", value }];
  if (from < value.length) out.push({ type: "text", value: value.slice(from) });
  return out;
}

/** The literal nodes search reads, in document order: text, inline code and code values. */
function forEachLiteral(tree: Root, visit: (value: string) => void) {
  const walk = (parent: Nodes) => {
    if (parent.type === "text" || parent.type === "inlineCode" || parent.type === "code") visit(parent.value);
    else if (isParent(parent)) for (const child of parent.children as Nodes[]) walk(child);
  };
  walk(tree);
}

/**
 * The visible text of `source` as this view draws it, literal by literal
 * (search counts in each; a match never spans two): parsed as the render
 * parses it, nodes outside the allowlist as their source.
 */
export function agentContextViewMarkdownLiterals(source: string): string[] {
  const tree = parseMessageCardMarkdown(source);
  drawOutsideAsSource(tree, source);
  const literals: string[] = [];
  forEachLiteral(tree, (value) => literals.push(value));
  return literals;
}

/**
 * Marks the matches, and draws code as this view does: a fence as a `pre`
 * whose `code` always has a language class, inline code with its marks inside.
 */
function markAndDrawCode(tree: Root, search: AgentContextViewMarkdownSearch | null) {
  const counter = search ? { search, next: 0 } : null;
  const visit = (parent: Parent) => {
    parent.children = (parent.children as Nodes[]).flatMap((child): Nodes[] => {
      switch (child.type) {
        case "text":
          return markMatches(child.value, counter);
        case "inlineCode":
          return [node("code", markMatches(child.value, counter))];
        case "code": {
          const language = child.lang ? `language-${child.lang}` : PLAIN_LANGUAGE;
          return [node("pre", [node("code", markMatches(child.value, counter), { className: [language] })])];
        }
        default:
          if (isParent(child)) visit(child);
          return [child];
      }
    }) as Parent["children"];
  };
  visit(tree);
}

/** A token longer than this may break after its slashes. */
const LONG_TOKEN = /[^\s]{31,}/g;
/** At most this many break opportunities per text; past them, overflow-wrap breaks a long token anywhere. */
const MAX_BREAKS = 200;

/** `line` with a `wbr` after each `/` inside a long token, `budget` counting down the ones it may still add. */
function breakLongTokens(line: string, budget: { left: number }): Nodes[] {
  const out: Nodes[] = [];
  let from = 0;
  LONG_TOKEN.lastIndex = 0;
  for (let token = LONG_TOKEN.exec(line); token !== null && budget.left > 0; token = LONG_TOKEN.exec(line)) {
    for (let slash = line.indexOf("/", token.index); slash !== -1 && slash < token.index + token[0].length - 1 && budget.left > 0; slash = line.indexOf("/", slash + 1)) {
      if (line[slash + 1] === "/") continue;
      out.push({ type: "text", value: line.slice(from, slash + 1) }, node("wbr", []));
      from = slash + 1;
      budget.left--;
    }
  }
  if (from < line.length) out.push({ type: "text", value: line.slice(from) });
  return out;
}

/** Outside code: a line break where the text breaks a line, and break opportunities in long paths and URLs. */
function addBreaks(tree: Root) {
  const budget = { left: MAX_BREAKS };
  const visit = (parent: Parent) => {
    parent.children = (parent.children as Nodes[]).flatMap((child): Nodes[] => {
      if (child.type === "text") {
        if (!child.value.includes("\n") && (budget.left === 0 || !child.value.includes("/"))) return [child];
        const out: Nodes[] = [];
        child.value.split("\n").forEach((line, index) => {
          if (index > 0) out.push({ type: "break" });
          if (line) out.push(...breakLongTokens(line, budget));
        });
        return out;
      }
      if (child.type === "agentContextViewNode" && (child.data.hName === "code" || child.data.hName === "pre")) return [child];
      if (isParent(child)) visit(child);
      return [child];
    }) as Parent["children"];
  };
  visit(tree);
}

/** The remark step: the allowlist, search's marks, code, breaks. */
function remarkAgentContextView(options: { search: AgentContextViewMarkdownSearch | null }) {
  return (tree: Root, file: VFile) => {
    const source = String(file.value);
    drawOutsideAsSource(tree, source);
    markAndDrawCode(tree, options.search);
    addBreaks(tree);
  };
}

/** The remark plugins for a search (null: none): parsed as parseMessageCardMarkdown parses (MarkdownContent adds no indented code), then this view's step. */
export function agentContextViewRemarkPlugins(search: AgentContextViewMarkdownSearch | null): PluggableList {
  return [remarkGfm, remarkCjkFriendly, remarkRaftMath, [remarkAgentContextView, { search }]];
}

/** The shared sanitize schema, with search's mark and the break opportunity. */
const agentContextViewSanitizeSchema: RehypeSanitizeOptions = {
  ...markdownSanitizeSchema,
  tagNames: [...(markdownSanitizeSchema.tagNames ?? defaultSchema.tagNames ?? []), "mark", "wbr"],
  attributes: {
    ...markdownSanitizeSchema.attributes,
    mark: [AGENT_CONTEXT_VIEW_MATCH_PROPERTY],
  },
};

/** Sanitized as every Markdown surface is (no raw HTML is ever parsed), with this view's two tags. */
export const AGENT_CONTEXT_VIEW_REHYPE_PLUGINS: PluggableList = [[rehypeSanitize, agentContextViewSanitizeSchema]];
