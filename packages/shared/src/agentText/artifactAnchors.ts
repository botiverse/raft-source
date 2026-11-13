// Where an Artifact comment points, in the words an agent reads (artifacts.ts
// for comment lists, read and holds; artifactNotices.ts for notices). Two
// parts, kept apart so their roles are plain:
// - the place, in Raft's words: the kind (lines, rows, an element, selected
//   text, a place the page names) and what finds it again (line numbers, the
//   element's tag, the CSS selector Porthole recorded);
// - the text the anchor quotes, the Artifact's own (or, for an anchor format
//   Raft doesn't know, the commenter's), shown as a quote under its own label.
// Stored anchors are the web's (workspaceArtifacts.ts ArtifactCommentAnchor,
// copied from Porthole's annotate report) or an agent's free-form
// `{ type, data }`, so every field is read defensively.

import type { AgentApiArtifactCommentAnchor } from "../agentApiArtifactsContract";
import { AGENT_BODY_LINE_SEPARATOR, foldAgentOneLineText } from "../agentMessageText";
import { ARTIFACT_PAGE_ANCHOR_NAME } from "../workspaceArtifacts";

/** A quoted line of the anchor's text: at most this many characters, then `…`. */
export const ARTIFACT_ANCHOR_TEXT_SHOWN = 60;
/** A CSS selector longer than this (Porthole allows 1,000) is cut with `…`. */
const SELECTOR_SHOWN = 200;

/** Which side wrote the quoted text: the Artifact's page, its file, or (an anchor format Raft doesn't know) the commenter. */
export type ArtifactAnchorTextSource = "page" | "file" | "comment";

export interface ArtifactAnchorView {
  /** The place in the file, in Raft's words (`lines 12-14`, `element <h2> · selector #pricing > h2`); null when the anchor names none. */
  where: string | null;
  /** The text it quotes, each folded to one line and cut. */
  text: string[];
  textSource: ArtifactAnchorTextSource;
}

const TEXT_LABELS: Record<ArtifactAnchorTextSource, string> = {
  page: "Page text (from the Artifact, quoted):",
  file: "File text (from the Artifact, quoted):",
  comment: "Anchor text (given with the comment, quoted):",
};

/** The line above an anchor's quoted text, naming whose words they are. */
export const artifactAnchorTextLabel = (source: ArtifactAnchorTextSource): string => TEXT_LABELS[source];

function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** Where the quoted text broke a line: kept visible on its one line, so the words either side aren't read as one run. */
export const ARTIFACT_ANCHOR_LINE_BREAK = " ⏎ ";

/** Text on one line (each line break a ` ⏎ `, blank lines dropped), cut; null when blank. */
function shown(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const one = text.split(AGENT_BODY_LINE_SEPARATOR).map(foldAgentOneLineText).filter((line) => line !== "").join(ARTIFACT_ANCHOR_LINE_BREAK);
  return one ? cut(one, ARTIFACT_ANCHOR_TEXT_SHOWN) : null;
}

function range(data: Record<string, unknown>, one: string, many: string): string | null {
  const start = Number(data.start);
  const end = Number(data.end ?? start);
  if (!Number.isFinite(start)) return null;
  return start === end || !Number.isFinite(end) ? `${one} ${start}` : `${many} ${start}-${end}`;
}

function selector(data: Record<string, unknown>, type: string): Record<string, unknown> | null {
  const list: unknown[] = Array.isArray(data.selectors) ? data.selectors : [];
  const found = list.find((s) => typeof s === "object" && s !== null && (s as { type?: unknown }).type === type);
  return (found as Record<string, unknown> | undefined) ?? null;
}

/** An HTML tag name, as Porthole writes an element's (`localName`), or null. */
const TAG = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?=[#.\s:[]|$)/i;

function tagOf(text: string | null): string | null {
  const match = text === null ? null : TAG.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * The words of a picked element's label, without the name Porthole puts
 * first (`img#hero.wide Team photo` → `Team photo`: its text, else its alt,
 * aria-label or title); null when it has none (the tag is the place's).
 */
function labelWords(label: unknown): string | null {
  if (typeof label !== "string") return null;
  return tagOf(label) === null ? label : label.replace(/^\S+\s*/, "") || null;
}

/** A picked element's or a selection's place: the kind, the tag, the CSS selector Porthole recorded. */
function annotationPlace(data: Record<string, unknown>, withSelector: boolean): string {
  const cssValue = selector(data, "CssSelector")?.value;
  const css = typeof cssValue === "string" && foldAgentOneLineText(cssValue) ? cut(foldAgentOneLineText(cssValue), SELECTOR_SHOWN) : null;
  // A selector's last step (`p:nth-of-type(2)`; `#intro` names no tag).
  const lastStep = css === null ? null : css.split(">").pop()!.trim();
  const parts: string[] = [];
  if (data.kind === "element") {
    // Porthole's label starts with the element's own name (`h2#revenue.big Revenue grew`).
    const tag = tagOf(typeof data.label === "string" ? data.label : null) ?? tagOf(lastStep);
    parts.push(tag ? `element <${tag}>` : "element");
  } else {
    const tag = tagOf(lastStep);
    parts.push(tag ? `selected text in <${tag}>` : "selected text");
  }
  if (css && withSelector) parts.push(`selector ${css}`);
  return parts.join(" · ");
}

function typeName(type: string): string | null {
  return /^[A-Za-z0-9._-]{1,40}$/.test(type) ? type : null;
}

/**
 * An anchor as agents read it; null when it names no place and quotes
 * nothing (the comment then reads as one on the whole file).
 * `withSelector` false leaves out the CSS selector (a notice's one line).
 */
export function artifactAnchorView(anchor: AgentApiArtifactCommentAnchor | null | undefined, opts: { withSelector?: boolean } = {}): ArtifactAnchorView | null {
  if (!anchor) return null;
  const data = anchor.data;
  const withSelector = opts.withSelector !== false;
  let view: ArtifactAnchorView;
  switch (anchor.type) {
    case "lines":
      view = { where: range(data, "line", "lines"), text: [shown(data.quote)].filter((t) => t !== null), textSource: "file" };
      break;
    case "csv-rows":
      view = { where: range(data, "row", "rows"), text: [shown(data.quote)].filter((t) => t !== null), textSource: "file" };
      break;
    case "annotation": {
      // The words picked or selected (an element's text, up to 300), else those of Porthole's label (a selection's is its text).
      const exact = shown(selector(data, "TextQuoteSelector")?.exact);
      const label = shown(data.kind === "element" ? labelWords(data.label) : data.label);
      view = { where: annotationPlace(data, withSelector), text: [exact ?? label].filter((t) => t !== null), textSource: "page" };
      break;
    }
    case "page": {
      // A place the page names (P108): its name an identifier, its label and quote the page's own text.
      const name = typeof data.name === "string" && ARTIFACT_PAGE_ANCHOR_NAME.test(data.name) ? data.name : null;
      view = { where: name ? `place ${name}, named by the page` : "a place the page names", text: [shown(data.label), shown(data.quote)].filter((t) => t !== null), textSource: "page" };
      break;
    }
    default: {
      // A format Raft doesn't draw (an agent's `html-region`): its type, and the text it was given with.
      const label = shown(data.label);
      const quote = shown(data.quote) ?? shown(data.text);
      const type = typeName(anchor.type);
      view = { where: type ? `${type} anchor` : null, text: [label, quote === label ? null : quote].filter((t) => t !== null), textSource: "comment" };
    }
  }
  return view.where === null && view.text.length === 0 ? null : view;
}

/** Two anchors that point at the same place (a reply takes its parent's). */
export function sameArtifactAnchor(a: AgentApiArtifactCommentAnchor | null | undefined, b: AgentApiArtifactCommentAnchor | null | undefined): boolean {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}
