// The two cheap findings a check computes from what it measured (check.ts): a blank page
// and sideways scrolling on a phone.
import type { ArtifactCheckReport } from "@botiverse/raft-shared/src/artifactCheckContract";

/** What the page reports about itself after it settled (browser.ts measure). */
export interface PageMeasure {
  /** `document.body.innerText`, trimmed, in characters (0 with no body). */
  textLength: number;
  /** `document.scrollingElement.scrollWidth` (the document's own width when it has none). */
  scrollWidth: number;
  /** `window.innerWidth`. */
  innerWidth: number;
}

/** At least this share of a screenshot's sampled pixels one colour: a uniform shot. */
export const BLANK_UNIFORM_SHARE = 0.99;

/**
 * Blank: no text at all and a screenshot of (nearly) one colour. Both, so a
 * page of pictures or a canvas (no text) and a page of white-on-white text
 * aren't called blank; an unknown share (no shot, a PNG the decoder doesn't
 * read) is never blank.
 */
export function isBlank(textLength: number, uniformShare: number | null): boolean {
  return textLength === 0 && uniformShare !== null && uniformShare >= BLANK_UNIFORM_SHARE;
}

/** Sideways scrolling at a phone's width: content wider than the window (a pixel of rounding allowed), else null. */
export function phoneOverflowOf(measure: Pick<PageMeasure, "scrollWidth" | "innerWidth">): NonNullable<ArtifactCheckReport["phoneOverflow"]> | null {
  const contentWidth = Math.round(measure.scrollWidth);
  const viewportWidth = Math.round(measure.innerWidth);
  if (!Number.isSafeInteger(contentWidth) || !Number.isSafeInteger(viewportWidth) || contentWidth < 0 || viewportWidth <= 0) return null;
  return contentWidth > viewportWidth + 1 ? { contentWidth, viewportWidth } : null;
}
