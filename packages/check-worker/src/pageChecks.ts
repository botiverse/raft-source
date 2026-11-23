// The cheap findings a check computes from what it measured (check.ts): a blank page,
// sideways scrolling on a phone, and a soft hint: a page that may not scroll for readers.
import {
  ARTIFACT_CHECK_ELEMENT_MAX_CHARS,
  ARTIFACT_CHECK_HOLD_STYLES,
  type ArtifactCheckCantScroll,
  type ArtifactCheckHoldStyle,
  type ArtifactCheckReport,
  type ArtifactCheckViewport,
} from "@botiverse/raft-shared/src/artifactCheckContract";

/** What the page reports about itself after it settled (measurePage.ts, in the page). */
export interface PageMeasure {
  /** `document.body.innerText`, trimmed, in characters (0 with no body). */
  textLength: number;
  /** `document.scrollingElement.scrollWidth` (the document's own width when it has none). */
  scrollWidth: number;
  /** `window.innerWidth`. */
  innerWidth: number;
  /** Whether the reader can scroll to all of the page (measurePage.ts says how each is read). Absent from a page that measured none. */
  scroll?: ScrollMeasure;
}

/** The page's scrolling as measured, CSS px of the page (`window.innerHeight` and the document's). */
export interface ScrollMeasure {
  /** `window.innerHeight`. */
  innerHeight: number;
  /** The lowest bottom of the page's visible content that no inner container scrolls to, in the document's px. */
  contentBottom: number;
  /** The document's scrolling element's `scrollHeight` and `clientHeight`: how far the window scrolls, where it may. */
  rootScrollHeight: number;
  rootClientHeight: number;
  /** The computed overflow-y of html and body. */
  htmlOverflowY: string;
  bodyOverflowY: string;
  /** Body's bottom in the document's px (null with no body). */
  bodyBottom: number | null;
  /** A container that scrolls (more than CANT_SCROLL_SLACK px) and covers at least half the window: a full-window app. */
  innerScroller: boolean;
  /** Inside html and body, what cuts the lowest content: its tag, id and class attribute, and how (`position: fixed`, `overflow: hidden`). */
  holder: { tag: string; id: string; className: string; style: string } | null;
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

/**
 * Sideways scrolling at a phone's width: content wider than the window (a pixel
 * of rounding allowed), else null. The width reported is the phone's own
 * (`phoneWidth`, the emulated screen), not `innerWidth`: a page with no
 * viewport tag is zoomed out to fit, so its window can be up to 4x the phone
 * (1560 px on a 390 px phone), a width no reader has.
 */
export function phoneOverflowOf(measure: Pick<PageMeasure, "scrollWidth" | "innerWidth">, phoneWidth: number): NonNullable<ArtifactCheckReport["phoneOverflow"]> | null {
  const contentWidth = Math.round(measure.scrollWidth);
  const windowWidth = Math.round(measure.innerWidth);
  const viewportWidth = Math.round(phoneWidth);
  if (![contentWidth, windowWidth, viewportWidth].every(Number.isSafeInteger) || contentWidth < 0 || windowWidth <= 0 || viewportWidth <= 0) return null;
  return contentWidth > windowWidth + 1 ? { contentWidth, viewportWidth } : null;
}

/** More than this many px out of reach (the viewport's): a page that may not scroll. Less is a margin's rounding. */
export const CANT_SCROLL_SLACK = 24;

const CLIPS = new Set(["hidden", "clip"]);
/** The window scrolls where the overflow it takes (html's, else body's) lets it. */
const SCROLLS = new Set(["visible", "auto", "scroll"]);
const isHoldStyle = (style: string): style is ArtifactCheckHoldStyle => (ARTIFACT_CHECK_HOLD_STYLES as readonly string[]).includes(style);

/**
 * An element's name as the hint gives it: its tag, then `#id`, else `.class` (its first), each
 * only of characters a selector takes as they are, cut to ARTIFACT_CHECK_ELEMENT_MAX_CHARS. The
 * page's own words: the agent's text quotes it.
 */
export function elementLabel(holder: { tag: string; id: string; className: string }): string {
  const plain = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, "");
  const tag = plain(holder.tag).toLowerCase() || "element";
  const id = plain(holder.id);
  const className = plain(holder.className.trim().split(/\s+/)[0] ?? "");
  const label = id ? `${tag}#${id}` : className ? `${tag}.${className}` : tag;
  return label.slice(0, ARTIFACT_CHECK_ELEMENT_MAX_CHARS);
}

/**
 * A soft hint, else null: at `viewport` the page's content reaches more than CANT_SCROLL_SLACK px
 * beyond where a reader can scroll, and no container that covers most of the window scrolls (a
 * full-window app that scrolls inside its own containers is never reported, nor is a page that
 * fits). Where a reader can scroll: the window's height, plus as far as the window itself scrolls
 * when the overflow it takes (html's, else body's, which then goes to the window) lets it.
 *
 * What holds it: html and body where their overflow-y is `hidden` or `clip` (body's only where it
 * is the window's, or where body itself ends at the window's bottom and so cuts there), and what
 * the page measured inside them. Sizes are the viewport's CSS px: a phone page with no viewport
 * tag is zoomed out to fit (its window up to 4x the phone's), so its px are scaled to the phone's.
 */
export function cantScrollOf(measure: Pick<PageMeasure, "innerWidth" | "scroll">, viewport: Pick<ArtifactCheckViewport, "shot" | "width" | "height">): ArtifactCheckCantScroll | null {
  const scroll = measure.scroll;
  if (!scroll) return null;
  const numbers = [measure.innerWidth, scroll.innerHeight, scroll.contentBottom, scroll.rootScrollHeight, scroll.rootClientHeight];
  if (!numbers.every(Number.isFinite) || measure.innerWidth <= 0 || scroll.innerHeight <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  if (scroll.innerScroller) return null;
  const windowOverflow = scroll.htmlOverflowY !== "visible" ? scroll.htmlOverflowY : scroll.bodyOverflowY;
  const windowScroll = SCROLLS.has(windowOverflow) ? Math.max(0, scroll.rootScrollHeight - scroll.rootClientHeight) : 0;
  const scale = Math.min(1, viewport.width / measure.innerWidth);
  const hidden = (scroll.contentBottom - scroll.innerHeight - windowScroll) * scale;
  if (!(hidden > CANT_SCROLL_SLACK)) return null;

  const heldBy: ArtifactCheckCantScroll["heldBy"] = [];
  if (CLIPS.has(scroll.htmlOverflowY)) heldBy.push({ element: "html", style: scroll.htmlOverflowY === "clip" ? "overflow: clip" : "overflow: hidden" });
  const bodyCuts = scroll.htmlOverflowY === "visible" || (scroll.bodyBottom !== null && scroll.bodyBottom <= scroll.innerHeight + CANT_SCROLL_SLACK);
  if (CLIPS.has(scroll.bodyOverflowY) && bodyCuts) heldBy.push({ element: "body", style: scroll.bodyOverflowY === "clip" ? "overflow: clip" : "overflow: hidden" });
  if (scroll.holder && isHoldStyle(scroll.holder.style)) heldBy.push({ element: elementLabel(scroll.holder), style: scroll.holder.style });
  return {
    shot: viewport.shot,
    viewportWidth: Math.round(viewport.width),
    viewportHeight: Math.round(viewport.height),
    contentHeight: Math.round(scroll.contentBottom * scale),
    hiddenHeight: Math.round(hidden),
    heldBy,
  };
}
