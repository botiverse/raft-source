// Where an Artifact comment points, in the words an agent reads (artifacts.ts
// for comment lists, read and holds; artifactNotices.ts for notices). Two
// parts, kept apart so their roles are plain:
// - the place, in Raft's words: the kind (lines, rows, an element, selected
//   text, a place the page names) and what finds it again (line numbers, the
//   element's tag, the CSS selector Porthole recorded), then, for an element
//   or a selection, the section it is in as the page outlines it (Porthole
//   P152 `context`: ` · in "<headings joined by ›>"`, ` · region "<name>"`);
// - the text the anchor quotes, the Artifact's own (or, for an anchor format
//   Raft doesn't know, the commenter's), shown as a quote under its own label.
// Stored anchors are the web's (workspaceArtifacts.ts ArtifactCommentAnchor,
// copied from Porthole's annotate report) or an agent's free-form
// `{ type, data }`, so every field is read defensively.

import type { AgentApiArtifactCommentAnchor } from "../agentApiArtifactsContract";
import { ARTIFACT_ANCHOR_CONTEXT_LIMITS, cleanArtifactAnchorContextText } from "../artifactAnchorContext";
import { AGENT_BODY_LINE_SEPARATOR, foldAgentOneLineText, quoteAgentOneLineText } from "../agentMessageText";
import { ARTIFACT_PAGE_ANCHOR_NAME } from "../workspaceArtifacts";

/** A quoted line of the anchor's text: at most this many characters, then `…`. */
export const ARTIFACT_ANCHOR_TEXT_SHOWN = 60;
/** A CSS selector longer than this (Porthole allows 1,000) is cut with `…`. */
const SELECTOR_SHOWN = 200;

/** Which side wrote the quoted text: the Artifact's page, its file, or (an anchor format Raft doesn't know) the commenter. */
export type ArtifactAnchorTextSource = "page" | "file" | "comment";

export interface ArtifactAnchorView {
  /** The place in the file, in Raft's words (`lines 12-14`, `element <h2> · selector #pricing > h2 · in "Pricing › Plans"`); null when the anchor names none. */
  where: string | null;
  /**
   * `where` as its ` · ` parts, then shorter: for an element or a selection,
   * its section given up a step at a time (the region, then the middle
   * headings, `in "A › … › D"`, then the outermost, `in "… › D"`, then all of
   * it, a `…` part in its place), for a line that has to shrink (a notice). A
   * part is never cut: a quoted heading would lose its closing quote. Absent
   * when `where` is null.
   */
  whereSteps?: string[][];
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

/** Between two headings of a section's chain (`Pricing › Plans`). */
const HEADING_SEPARATOR = " › ";
/** Between two parts of a place (`element <h2> · selector #plans`). */
export const PART_SEPARATOR = " · ";

// What JSON leaves bare that a reader can't see or that breaks a line: the
// C1 controls, format characters (bidi controls, zero-width), line and
// paragraph separators; the joiners (U+200C, U+200D), which draw scripts and
// emoji, stay.
const QUOTE_UNSEEN = /[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200C\u200D])\p{Cf}/gu;

/**
 * The page's text in double quotes, on one line: JSON's escapes (`\"`, `\n`), and `\uXXXX` for what is otherwise unseen.
 * Also another Artifact's title in the read's "Linked from" (artifacts.ts): someone else's words.
 */
export function quotedPageText(text: string): string {
  return quoteAgentOneLineText(text).replace(QUOTE_UNSEEN, (char) =>
    Array.from({ length: char.length }, (_, unit) => `\\u${char.charCodeAt(unit).toString(16).padStart(4, "0")}`).join(""));
}

/** An element's or a selection's section, as agents read it: its headings (outermost first) and its region, each cleaned. */
interface AnnotationSection {
  headings: string[];
  region: string | null;
}

/**
 * A heading or the region, read defensively (an agent's anchor): cleaned as
 * Porthole cleans it (empty when nothing visible is left), cut to Porthole's
 * limit, and a ` › ` in it written ` > `, so the chain's separator is only ever
 * the chain's.
 */
function sectionText(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  const clean = cleanArtifactAnchorContextText(text);
  return clean === "" ? "" : cut(clean, max).replaceAll(HEADING_SEPARATOR, " > ");
}

/** The section an element or a selection is in (Porthole P152 `context`, the page's own words); none where it gives none. */
function annotationSection(data: Record<string, unknown>): AnnotationSection {
  const context = data.context;
  if (typeof context !== "object" || context === null || Array.isArray(context)) return { headings: [], region: null };
  const { headings, region } = context as { headings?: unknown; region?: unknown };
  const chain = (Array.isArray(headings) ? headings : [])
    .map((heading) => sectionText(heading, ARTIFACT_ANCHOR_CONTEXT_LIMITS.heading))
    .filter((heading) => heading !== "")
    .slice(-ARTIFACT_ANCHOR_CONTEXT_LIMITS.headings);
  const named = sectionText(region, ARTIFACT_ANCHOR_CONTEXT_LIMITS.region);
  return { headings: chain, region: named === "" ? null : named };
}

/**
 * Where a shortened line left something out: a heading in a section's chain
 * (`in "Pricing › … › Plans"`), the whole section, or a place's trailing
 * parts in a notice (`docs/pricing.html · …`). Never inside a quoted text.
 */
export const DROPPED_MARK = "…";

/** ` · in "Pricing › Plans"`, ` · region "Design"`: each part only when there is one, the page's words quoted. */
function sectionParts(section: AnnotationSection): string[] {
  return [
    ...(section.headings.length > 0 ? [`in ${quotedPageText(section.headings.join(HEADING_SEPARATOR))}`] : []),
    ...(section.region !== null ? [`region ${quotedPageText(section.region)}`] : []),
  ];
}

/**
 * The section's parts, then fewer, as a short line gives them up: the region;
 * then the middle headings (`in "A › … › D"`, the outermost and the
 * section's own kept); then the outermost too (`in "… › D"`); then all of it,
 * a `…` part where it was. A heading is kept whole or left out, never cut.
 */
function sectionSteps(section: AnnotationSection): string[][] {
  const { headings } = section;
  if (headings.length === 0 && section.region === null) return [[]];
  const steps: string[][] = [sectionParts(section)];
  const chain = (kept: string[]) => sectionParts({ headings: kept, region: null });
  if (section.region !== null && headings.length > 0) steps.push(chain(headings));
  const innermost = headings[headings.length - 1]!;
  if (headings.length > 2) steps.push(chain([headings[0]!, DROPPED_MARK, innermost]));
  if (headings.length > 1) steps.push(chain([DROPPED_MARK, innermost]));
  steps.push([DROPPED_MARK]);
  return steps;
}

/**
 * Text that could be read as more than one ` · ` part of a place, or as one
 * of the page's quoted words: a separator (` · `, ` › `), a quote mark, or
 * a character a reader can't see.
 */
const AMBIGUOUS_IN_PLACE = new RegExp(`${PART_SEPARATOR}|${HEADING_SEPARATOR}|"|${QUOTE_UNSEEN.source}`, "u");

/**
 * The CSS selector Porthole recorded, as it is shown: on one line, cut; null
 * when nothing is left. What can't be seen is kept (an id may hold it, and an
 * agent finds the element by it): it makes the selector quoted, where it is
 * written `\uXXXX`.
 */
function selectorText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const folded = foldAgentOneLineText(value);
  return folded === "" ? null : cut(folded, SELECTOR_SHOWN);
}

/** A selector in a place: as it is, unless it could pass for a part of its own (` · in "…"`); then quoted as the page's words are. */
const selectorPart = (css: string): string => `selector ${AMBIGUOUS_IN_PLACE.test(css) ? quotedPageText(css) : css}`;

/** A picked element's or a selection's place, its ` · ` parts: the kind, the tag, the CSS selector Porthole recorded. */
function annotationPlace(data: Record<string, unknown>, withSelector: boolean): string[] {
  const css = selectorText(selector(data, "CssSelector")?.value);
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
  if (css && withSelector) parts.push(selectorPart(css));
  return parts;
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
      // Then the section it is in (Porthole P152), shrinking a step at a time for a short line.
      const place = annotationPlace(data, withSelector);
      const steps = sectionSteps(annotationSection(data)).map((step) => [...place, ...step]);
      view = { where: steps[0]!.join(PART_SEPARATOR), whereSteps: steps, text: [exact ?? label].filter((t) => t !== null), textSource: "page" };
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
  if (view.where === null && view.text.length === 0) return null;
  return view.whereSteps || view.where === null ? view : { ...view, whereSteps: [[view.where]] };
}

/** Two anchors that point at the same place (a reply takes its parent's). */
export function sameArtifactAnchor(a: AgentApiArtifactCommentAnchor | null | undefined, b: AgentApiArtifactCommentAnchor | null | undefined): boolean {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}
