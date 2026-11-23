import { cleanArtifactAnchorContextText } from "@botiverse/raft-shared";
import type { ArtifactCommentAnchor } from "@botiverse/raft-shared";

/** Between two headings of a section's chain (`Pricing › Plans`), as agents read it too. */
const HEADING_SEPARATOR = " › ";

/** The section a comment's place is in: `shown` on its anchor line, `full` in its tooltip. */
export interface ArtifactAnchorSection {
  shown: string;
  full: string;
}

/** An HTML tag name, as Porthole starts an element's label with it (`h2#plans.big Plans`). */
const TAG_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?=[#.\s:[]|$)/i;

/** The words of the place's label: an element's without the name Porthole puts first, a selection's as they are. */
function labelWords(anchor: Extract<ArtifactCommentAnchor, { type: "annotation" }>): string {
  const label = cleanArtifactAnchorContextText(anchor.data.label);
  return anchor.data.kind === "element" && TAG_NAME.test(label) ? label.replace(/^\S+\s*/, "") : label;
}

/**
 * A heading or the region as shown: cleaned as Porthole cleans it (empty when nothing visible is
 * left, a Hangul filler say), a heading's own ` › ` written ` > ` so the chain's separator is only
 * the chain's.
 */
const sectionText = (text: string) => cleanArtifactAnchorContextText(text).replaceAll(HEADING_SEPARATOR, " > ");

/**
 * The section an element or a selection is in, as the page outlines it (Porthole P152 `context`,
 * the page's own words): `shown`, its own heading (the last), else the named region around it;
 * `full`, every heading from the top down and the region, for a tooltip. When the place is that
 * heading itself (Porthole puts a picked heading last), it isn't said twice: the heading above it
 * is shown instead, else the region, else nothing. Null where the anchor carries none (older
 * comments, lines, rows, a place the page names).
 */
export function anchorSection(anchor: ArtifactCommentAnchor): ArtifactAnchorSection | null {
  if (anchor.type !== "annotation" || !anchor.data.context) return null;
  const headings = (anchor.data.context.headings ?? []).map(sectionText).filter((heading) => heading !== "");
  const region = sectionText(anchor.data.context.region ?? "") || null;
  const words = labelWords(anchor);
  const own = headings.length > 0 && headings[headings.length - 1] === words ? headings.slice(0, -1) : headings;
  const shown = own[own.length - 1] ?? region;
  if (!shown) return null;
  const chain = headings.join(HEADING_SEPARATOR);
  return { shown, full: chain && region ? `${chain} · ${region}` : chain || shown };
}
