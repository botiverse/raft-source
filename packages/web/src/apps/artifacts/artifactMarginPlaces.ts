import type { AnchorResult, AnnotationMark, AnnotationRect, AnnotationScroll } from "@botiverse/porthole";

/**
 * Where a Markdown Artifact's comment cards go in the margin beside its frame (#proj-workspace:#152;
 * raft-design patterns/comments.md, the margin): each card level with its passage, as the page
 * scrolls.
 *
 * Porthole tells where marks are (`anchored`) after the host shows them, and after a scroll
 * settles only while some mark has a marker (P104): too seldom for cards that move with the text,
 * and posted threads have no marker here (the card is in the margin). And every box it reports is
 * clamped to the frame's viewport (P104): a mark wholly above it is a box of no size at its top, one
 * wholly below at its bottom, one cut by the top edge has its top there. So a top is known only for
 * a mark whose top is inside the frame (`known`); the others' cards are not drawn, never stacked at
 * an edge, until the frame says where they are.
 *
 * The margin follows one mark, the reference (`trackedAnnotation`, P112: its box every animation
 * frame), and moves every known card by as much as it moved: a document scrolls as a whole.
 * `tops` are the known marks' tops when they were last reported, `shift` how far the reference
 * moved since. With no mark inside the frame, the reference is the nearest mark past one of its
 * edges (by document order, P112 `order`: `above`, `below`); its box coming in says the page
 * scrolled to it.
 *
 * Following one mark keeps the known cards level while the page scrolls, but says nothing of marks
 * that come in meanwhile, nor anything once the reference is gone (a fast scroll jumps it out
 * between two frames). So the host asks for every mark's place again (`refreshMark`) when the
 * page stops moving, now and then during a long scroll, when the reference is lost (the cards are
 * hidden until then: `stale`), and while none is placed (useArtifactMargin). A report of every mark
 * (`full`) replaces every place: none is kept from before.
 *
 * A newer frame (Porthole 0.14.10's P132, a content Worker on it) says more, and the margin is then
 * in document mode (`scrollY` not null): each attached mark's `documentRect` (its box in the
 * document, offscreen marks included, never clamped) and the document's `scroll` as the boxes were
 * read, in every `anchored` and every `tracked`. Every attached mark then has a top (in the
 * document), and a card's top in the frame is that top less `scrollY`, which each `tracked` of the
 * followed mark updates at every frame the page scrolled, the mark in view or not: one report places
 * every card and keeps them placed, with no ask on a scroll, no edge, no stale tops. The host asks
 * again only for what a scroll doesn't explain: a new width, the content's marks changing, a report
 * naming fewer marks, or the followed mark's place in the document drifting (the layout changed
 * near it: an image loaded). Which mode is per report (`scroll` present or not): the web and the
 * content Worker deploy apart, so an older frame keeps the viewport boxes' way.
 *
 * A top in the document is the page's word and unclamped (it may say a mark is 10,000,000 px down):
 * the margin draws from it only inside its own column, which clips (ArtifactMarkdownMargin), never
 * over the rest of the app (P132's threat; Tenny).
 *
 * Everything here is the page's word (a hint where to draw a card), never a fact.
 */
export interface MarginPlaces {
  /**
   * Each mark's top whose top was inside the frame, frame viewport px, as last reported (no shift);
   * in document mode every attached mark's top in the document (`documentRect.y`).
   */
  readonly tops: ReadonlyMap<string, number>;
  /** How far the reference moved since `tops` were reported, px (0 in document mode). */
  readonly shift: number;
  /**
   * Document mode (P132): how far the frame's document is scrolled now (the last report's
   * `scroll.y`), px; a top in the frame is a top less this. Null: an older frame, viewport tops.
   */
  readonly scrollY: number | null;
  /** The mark followed, or null (none attached). */
  readonly ref: string | null;
  /** The nearest attached mark past the frame's top and past its bottom, by document order. */
  readonly above: string | null;
  readonly below: string | null;
  /** Marks the frame reported orphaned (their passage is gone): no card, no place. */
  readonly orphaned: ReadonlySet<string>;
  /** The reference was lost since the tops were reported: they say nothing now (cards hidden until the next report). */
  readonly stale: boolean;
}

export const NO_MARGIN_PLACES: MarginPlaces = { tops: new Map(), shift: 0, scrollY: null, ref: null, above: null, below: null, orphaned: new Set(), stale: false };

/** How far the followed mark's place in the document may move before the host asks again (the layout changed), px. */
export const DRIFT_PX = 1;

/** How close to an edge a reported top is clamped there, px. */
const EDGE_PX = 0.5;

/** Whether a reported box's top is where the mark's top is: a box of some size, its top inside the frame. */
export function knownTop(rect: AnnotationRect, frameHeight: number): boolean {
  return rect.height > 0 && rect.y > EDGE_PX && rect.y < frameHeight - EDGE_PX;
}

/** The mark to follow among known tops: the one nearest the frame's middle; null when none. */
export function chooseRef(tops: ReadonlyMap<string, number>, frameHeight: number): string | null {
  let best: string | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const [id, top] of tops) {
    if (top <= EDGE_PX || top >= frameHeight - EDGE_PX) continue;
    const d = Math.abs(top - frameHeight / 2);
    if (d < distance) {
      best = id;
      distance = d;
    }
  }
  return best;
}

/**
 * The places after an `anchored` report. A mark it names with a known top takes it; one clamped to
 * an edge loses its top (its card hidden) and may be the nearest past that edge; an orphaned one
 * goes. `full` (it names every mark shown, as after `show`): it is all there is, nothing kept from
 * before. Else (a `focus` names one mark) the others keep their places with the shift so far taken
 * in, and the host asks for all of them. The reference is chosen again: a known mark nearest the
 * middle, else the nearest past the bottom, else past the top.
 *
 * With `scroll` (a newer frame, P132: document mode), every attached mark takes its top in the
 * document (`documentRect.y`), offscreen or not, and the scroll is the report's (marginInDocument).
 * Without it, tops kept from document mode say nothing in the viewport: none is kept.
 */
export function marginAfterAnchored(places: MarginPlaces, results: readonly AnchorResult[], frameHeight: number, full: boolean, scroll?: AnnotationScroll): MarginPlaces {
  if (scroll !== undefined) return marginInDocument(places, results, frameHeight, full, scroll.y);
  const tops = new Map<string, number>();
  if (!full && !places.stale && places.scrollY === null) for (const [id, top] of places.tops) tops.set(id, top + places.shift);
  const orphaned = new Set(full ? [] : places.orphaned);
  let above: { id: string; order: number } | null = null;
  let below: { id: string; order: number } | null = null;
  for (const [index, result] of results.entries()) {
    if (result.state !== "attached" || !result.rect) {
      tops.delete(result.id);
      orphaned.add(result.id);
      continue;
    }
    orphaned.delete(result.id);
    if (knownTop(result.rect, frameHeight)) {
      tops.set(result.id, result.rect.y);
      continue;
    }
    tops.delete(result.id);
    const order = result.order ?? index;
    if (result.rect.y <= EDGE_PX) {
      if (!above || order > above.order) above = { id: result.id, order };
    } else if (!below || order < below.order) {
      below = { id: result.id, order };
    }
  }
  // A past-the-edge mark from before stays one until it has a top again or is gone.
  const kept = (id: string | null) => (id !== null && !tops.has(id) && !orphaned.has(id) ? id : null);
  const aboveId = above?.id ?? (full ? null : kept(places.above));
  const belowId = below?.id ?? (full ? null : kept(places.below));
  // The same tops (or orphans) as before, as a report asked for with nothing moved gives: the same
  // Map (Set), and the same places when nothing else changed either, so no card re-renders.
  const sameTops = sameMap(tops, places.tops);
  const sameOrphaned = sameSet(orphaned, places.orphaned);
  const next: MarginPlaces = {
    tops: sameTops ? places.tops : tops,
    shift: 0,
    scrollY: null,
    ref: chooseRef(tops, frameHeight) ?? belowId ?? aboveId,
    above: aboveId,
    below: belowId,
    orphaned: sameOrphaned ? places.orphaned : orphaned,
    stale: false,
  };
  const same = sameTops && sameOrphaned && !places.stale && places.shift === 0 && places.scrollY === null && next.ref === places.ref && next.above === places.above && next.below === places.below;
  return same ? places : next;
}

const sameMap = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) => a.size === b.size && [...a].every(([id, top]) => b.get(id) === top);
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id));

/**
 * Document mode's places after an `anchored` (P132): each attached mark's top is its
 * `documentRect.y` (an attached result without one has no place); an orphaned one goes. Not `full`
 * (a `focus`), the marks it doesn't name keep their tops in the document, if the places were in it.
 * No edge and no stale tops: a mark scrolled out of the frame still has its place. The reference
 * stays the one followed while it is still placed (following another re-renders the frame for
 * nothing: any mark's box says the scroll), else the one nearest the frame's middle now.
 */
function marginInDocument(places: MarginPlaces, results: readonly AnchorResult[], frameHeight: number, full: boolean, scrollY: number): MarginPlaces {
  const kept = !full && places.scrollY !== null;
  const tops = new Map<string, number>(kept ? places.tops : []);
  const orphaned = new Set(full ? [] : places.orphaned);
  for (const result of results) {
    if (result.state !== "attached" || !result.rect) {
      tops.delete(result.id);
      orphaned.add(result.id);
      continue;
    }
    orphaned.delete(result.id);
    if (result.documentRect) tops.set(result.id, result.documentRect.y);
    else tops.delete(result.id);
  }
  const sameTops = sameMap(tops, places.tops);
  const sameOrphaned = sameSet(orphaned, places.orphaned);
  const ref = places.ref !== null && tops.has(places.ref) ? places.ref : nearestMiddle(tops, scrollY, frameHeight);
  const same = sameTops && sameOrphaned && !places.stale && places.shift === 0 && places.scrollY === scrollY && ref === places.ref && places.above === null && places.below === null;
  if (same) return places;
  return {
    tops: sameTops ? places.tops : tops,
    shift: 0,
    scrollY,
    ref,
    above: null,
    below: null,
    orphaned: sameOrphaned ? places.orphaned : orphaned,
    stale: false,
  };
}

/** The mark whose top in the document is nearest the frame's middle at `scrollY`; null when none. */
function nearestMiddle(tops: ReadonlyMap<string, number>, scrollY: number, frameHeight: number): string | null {
  let best: string | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const [id, top] of tops) {
    const d = Math.abs(top - scrollY - frameHeight / 2);
    if (d < distance) {
      best = id;
      distance = d;
    }
  }
  return best;
}

/**
 * The places after the followed mark moved (`tracked`). A reference with a known top moves every
 * card as far (`moved`: the page scrolled, so the host asks again once it stops); once its box no
 * longer says where its top is (cut by the top edge, or out of the frame) every top is `stale` and
 * the host asks at once (`refresh`). A reference past an edge (no top) asks as soon as its box says
 * it came inside. A box for another mark changes nothing.
 *
 * In document mode (`scroll`, P132, on places from a report that had it too): the report's scroll is
 * the document's, whichever mark it is of, so it is taken (`moved` when it changed: the column moves,
 * nothing is asked); the followed mark's `documentRect` away from its top by more than DRIFT_PX
 * says the layout changed (`refresh`). A `tracked` without a scroll on places in the document (a
 * frame gone back to an older shell) says nothing of them: the host asks.
 */
export function marginAfterTracked(
  places: MarginPlaces,
  id: string,
  rect: AnnotationRect,
  frameHeight: number,
  inDocument?: { documentRect?: AnnotationRect; scroll?: AnnotationScroll },
): { places: MarginPlaces; refresh: boolean; moved: boolean } {
  const scroll = inDocument?.scroll;
  if (places.scrollY !== null) {
    if (scroll === undefined) return { places, refresh: true, moved: false };
    const base = places.tops.get(id);
    const documentRect = inDocument?.documentRect;
    const drifted = id === places.ref && base !== undefined && documentRect !== undefined && Math.abs(documentRect.y - base) > DRIFT_PX;
    if (scroll.y === places.scrollY) return { places, refresh: drifted, moved: false };
    return { places: { ...places, scrollY: scroll.y }, refresh: drifted, moved: true };
  }
  if (id !== places.ref || places.stale) return { places, refresh: false, moved: false };
  const base = places.tops.get(id);
  if (base === undefined) {
    const came = knownTop(rect, frameHeight);
    return { places: came ? { ...places, stale: true } : places, refresh: came, moved: came };
  }
  if (!knownTop(rect, frameHeight)) return { places: { ...places, stale: true }, refresh: true, moved: true };
  const shift = rect.y - base;
  if (shift === places.shift) return { places, refresh: false, moved: false };
  return { places: { ...places, shift }, refresh: false, moved: true };
}

/** Whether no card has a place to be drawn at: none known, or the known ones stale. */
export const nonePlaced = (places: MarginPlaces) => places.stale || places.tops.size === 0;

/** How far every top is moved to be where its mark is in the frame now, px: the shift, or in document mode the scroll, negated. */
export const marginOffsetOf = (places: MarginPlaces) => places.shift - (places.scrollY ?? 0);

/** A mark's top now (frame viewport px), or null when it has no known place. */
export function marginTopOf(places: MarginPlaces, id: string): number | null {
  const top = places.tops.get(id);
  return top === undefined ? null : top + marginOffsetOf(places);
}

/**
 * The mark that makes Porthole report every mark's place again (`refresh`, from 1): Porthole
 * compares the marks it is given by value and shows them again only when they differ, and `show`
 * reports where each is. Its id says nothing, and its quote matches no text (an invisible
 * separator and a number), so it is orphaned and drawn nowhere.
 */
export function refreshMark(refresh: number): AnnotationMark {
  return {
    id: `margin-refresh-${refresh}`,
    anchor: { kind: "text", selectors: [{ type: "TextQuoteSelector", exact: `⁣${refresh}⁣` }], label: "" },
  };
}

/**
 * The margin's places as the frame reports them, with the frame's box (client px: the margin
 * places its cards by the frame's top), and `refresh`, how often every mark's place was asked for
 * again (the refresh mark's number; 0: never). Kept out of the comments context's value: only the
 * margin reads the places (`useMarginTops`, the store for the shift) and only the frame the
 * reference and the refresh (`useMarginRef`, `useMarginRefresh`), so neither a scroll (up to 60
 * `tracked` a second) nor an ask re-renders every reader of the comments.
 */
export interface MarginPlacesStore {
  get: () => { places: MarginPlaces; frameTop: number | null; refresh: number };
  subscribe: (listener: () => void) => () => void;
}

export function marginPlacesStore(): MarginPlacesStore & { set: (places: MarginPlaces, frameTop: number | null) => void; refreshed: () => number } {
  let value: { places: MarginPlaces; frameTop: number | null; refresh: number } = { places: NO_MARGIN_PLACES, frameTop: null, refresh: 0 };
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  return {
    get: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set: (places, frameTop) => {
      if (places === value.places && frameTop === value.frameTop) return;
      value = { ...value, places, frameTop };
      changed();
    },
    // Asked again: the next refresh mark's number.
    refreshed: () => {
      value = { ...value, refresh: value.refresh + 1 };
      changed();
      return value.refresh;
    },
  };
}

/** While cards are drawn nowhere (none placed, or the reference lost), how soon to ask again at first; the poll's tick. */
export const UNPLACED_POLL_MS = 500;
/** The longest wait between those asks: each one that still places nothing doubles it up to this. */
export const UNPLACED_POLL_CAP_MS = 8_000;

/**
 * The unplaced poll once it has asked (useArtifactMargin): the wait until its next ask, twice the
 * last up to UNPLACED_POLL_CAP_MS, and how many ticks (UNPLACED_POLL_MS apart) to let pass before
 * it. Doubled first, so from the start (`gap` UNPLACED_POLL_MS) the waits are 0.5, 1, 2, 4, 8 s.
 */
export function unplacedPollAfterAsk(gap: number): { gap: number; skips: number } {
  const next = Math.min(gap * 2, UNPLACED_POLL_CAP_MS);
  return { gap: next, skips: next / UNPLACED_POLL_MS - 1 };
}

/** Whether a mark is the refresh mark (it is no comment's). */
export const isRefreshMark = (id: string) => id.startsWith("margin-refresh-");

/** Which refresh a refresh mark's id says it is (`refreshMark`); null for any other mark. */
export function refreshOf(id: string): number | null {
  const n = /^margin-refresh-(\d+)$/.exec(id)?.[1];
  return n === undefined ? null : Number(n);
}
