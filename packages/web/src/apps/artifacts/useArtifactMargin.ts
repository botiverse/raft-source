import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentTimeMs } from "@botiverse/raft-shared";
import type { AnnotationReport } from "@botiverse/porthole";

import { NO_MARGIN_PLACES, UNPLACED_POLL_MS, isRefreshMark, marginAfterAnchored, marginAfterTracked, marginPlacesStore, nonePlaced, refreshOf, unplacedPollAfterAsk } from "./artifactMarginPlaces";
import type { MarginPlacesStore } from "./artifactMarginPlaces";
import type { FrameBox } from "./artifactTrackedPlaces";

/** The id a followed selection's report is read under (no mark has it: Raft's mark ids are its comments' and drafts'). */
const SELECTION_FOLLOWED = "\u0000selection";

/** The least time between two requests for every mark's place. */
const REFRESH_GAP_MS = 300;
/** How long the page has to stop moving before every mark's place is asked for again. */
const SETTLE_MS = 120;

/**
 * A Markdown Artifact's comments as cards in the margin beside it (#proj-workspace:#152;
 * ArtifactMarkdownMargin), as the comments context holds it: `shown` while the surface draws the
 * margin (it says so, `setShown`); then posted threads' marks carry no count, the open thread's
 * card is drawn in the margin rather than floating, and the frame follows the margin's reference
 * mark (a posted thread's or, in comment mode, a draft's) with the refresh mark last (ArtifactFrame,
 * from the store). `places`: where the cards go (`useMarginTops`, `useMarginOrphaned`), the
 * reference and how often every place was asked for again (`useMarginRef`, `useMarginRefresh`):
 * a store, so a report or an ask that changes them re-renders only who reads them. This value
 * changes only as the margin is drawn or goes.
 */
export interface ArtifactMarginLayer {
  shown: boolean;
  setShown: (shown: boolean) => void;
  requestRefresh: () => void;
  places: MarginPlacesStore;
}

/**
 * The margin's state, and `onReport`, which takes the frame's reports of where marks are while the
 * margin is drawn (the page's word, a hint), for a Markdown file only (`markdown`: on any other the
 * margin is never drawn and takes no report): every card moves with the reference mark (`tracked`,
 * taken: true), and a report of where marks are places them again and picks the reference again
 * (`anchored`, which the comments still read for their own cards: false). `shownMarks`: the marks
 * the frame was given (a report naming them all replaces every place; one naming fewer, after a
 * `focus`, asks for all). Which marks are orphaned is kept whether or not the margin is drawn (the
 * surface draws none when every passage is gone); nothing else is while it isn't: the frame is then
 * as wide as the viewer, so where it says marks are is nowhere they are beside the margin.
 *
 * Drawn, the cards wait for the frame's places at its new width (it narrowed by the margin's): the
 * margin asks for them once the page beside it has that width (`requestRefresh`, the first it asks),
 * and no report before the answer to that ask places a card (the `show` the marks without counts
 * make may be measured before the frame narrowed).
 *
 * Every mark's place is asked for again (artifactMarginPlaces): once the page stops moving
 * (SETTLE_MS after the reference last moved), at most every REFRESH_GAP_MS during a long scroll, at
 * once when the reference is lost, and while comments are shown and no card is placed (the
 * reference past an edge says nothing until its mark comes in, and a page scrolled past every mark
 * gives no report at all): UNPLACED_POLL_MS after, then twice as long after each ask that still
 * places nothing, up to UNPLACED_POLL_CAP_MS (0.5, 1, 2, 4, 8, 8 s: unplacedPollAfterAsk). That is
 * also the resting state of a reader in a section with no comments, and each ask re-renders the
 * frame and has it find every mark again, so it slows down; a scroll, a new width or a report that
 * places a card starts it at UNPLACED_POLL_MS again.
 *
 * A newer frame (Porthole 0.14.10's P132: each report's `scroll`, each attached mark's
 * `documentRect`) puts the margin in document mode (artifactMarginPlaces): one report places every
 * card, offscreen ones too, and each `tracked` of the followed mark says the scroll, so none of those
 * asks is made: no ask once the page stops moving, none during a scroll, no unplaced poll. Still
 * asked: the first ask at the margin's width (and at each new one), a report naming fewer marks
 * than the frame was given, the content's marks changing (a new `show`, Porthole's own report), and
 * the followed mark's place in the document drifting (the layout changed near it). Which way is the
 * report's (`scroll` present): an older content Worker's frames keep the viewport boxes' way.
 */
export function useArtifactMargin(markdown: boolean): { margin: ArtifactMarginLayer; onReport: (report: AnnotationReport, frameBox: FrameBox | null, shownMarks: readonly { id: string }[]) => boolean } {
  const [shown, setShownState] = useState(false);
  const [places] = useState(marginPlacesStore);
  // Whether the cards wait for the frame's places at its new width, since the margin was drawn:
  // "width" until the margin asks (the page beside it has its width), "asked" until that ask goes
  // (the refresh it makes, a number, then), null once a report answered it.
  const widthWait = useRef<"width" | "asked" | number | null>(null);
  const wasShown = useRef(false);
  // A margin no longer drawn forgets its places (they were the frame's at another width); its
  // reference is read only while it is drawn, and chosen again by the next report. Drawn again, it
  // waits for its width's places.
  const setShown = useCallback((next: boolean) => {
    if (!next) places.set({ ...NO_MARGIN_PLACES, orphaned: places.get().places.orphaned }, null);
    else if (!wasShown.current) widthWait.current = "width";
    wasShown.current = next;
    setShownState(next);
  }, [places]);
  const lastRefresh = useRef(Number.NEGATIVE_INFINITY);
  const timer = useRef<number | null>(null);
  // At once, or once REFRESH_GAP_MS have passed since the last time (a reference leaving the frame
  // while the page scrolls fast asks often).
  const ask = useCallback(() => {
    if (timer.current !== null) return;
    const wait = Math.max(0, lastRefresh.current + REFRESH_GAP_MS - currentTimeMs());
    timer.current = window.setTimeout(() => {
      timer.current = null;
      lastRefresh.current = currentTimeMs();
      const refresh = places.refreshed();
      if (widthWait.current === "asked") widthWait.current = refresh;
    }, wait);
  }, [places]);
  // The unplaced poll's wait now, and how many of its ticks (UNPLACED_POLL_MS apart) to let pass
  // before it asks again (0: at the next).
  const pollGap = useRef(UNPLACED_POLL_MS);
  const pollSkips = useRef(0);
  const pollFromStart = useCallback(() => {
    pollGap.current = UNPLACED_POLL_MS;
    pollSkips.current = 0;
  }, []);
  // The margin's own ask (the page beside it has a new width: it was just drawn, or the viewer was
  // resized): the poll starts over too. The first since it was drawn is the one its cards wait for.
  const requestRefresh = useCallback(() => {
    if (widthWait.current === "width") widthWait.current = "asked";
    pollFromStart();
    ask();
  }, [pollFromStart, ask]);
  // Asked again once the page stops moving: put off by each move.
  const settle = useRef<number | null>(null);
  const settleThenRefresh = useCallback(() => {
    if (settle.current !== null) window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      settle.current = null;
      ask();
    }, SETTLE_MS);
  }, [ask]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (settle.current !== null) window.clearTimeout(settle.current);
    timer.current = null;
    settle.current = null;
  }, []);
  // How many comments' marks the frame was last given (none: nothing to place, nothing to ask).
  const shownComments = useRef(0);
  const onReport = useCallback((reported: AnnotationReport, frameBox: FrameBox | null, shownMarks: readonly { id: string }[]) => {
    // While comment mode's composer follows the selection (P138) the frame follows no mark, the
    // margin's reference included (one followed thing at a time): its reports carry the document's
    // scroll all the same, and in document mode that is all the margin reads from the reference.
    // As a mark that is not the reference's, so it says nothing of where any mark is.
    const report = reported.type === "selectionTracked"
      ? (reported.state === "attached" ? { type: "tracked" as const, id: SELECTION_FOLLOWED, rect: reported.rect, scroll: reported.scroll } : null)
      : reported;
    if (!markdown || !report || (report.type !== "tracked" && report.type !== "anchored")) return false;
    const height = frameBox?.height ?? 0;
    const now = places.get().places;
    const comments = shownMarks.filter((mark) => !isRefreshMark(mark.id)).length;
    shownComments.current = comments;
    const full = report.type === "anchored" && report.results.filter((result) => !isRefreshMark(result.id)).length >= comments;
    // Not drawn, or waiting for the places at its width (a report answering its width's ask, every
    // mark's place with the refresh mark it asked with): only which passages are gone.
    const wait = widthWait.current;
    const answers = typeof wait === "number" && report.type === "anchored" && report.results.some((result) => (refreshOf(result.id) ?? 0) >= wait);
    if (shown && answers) widthWait.current = null;
    if (!shown || (wait !== null && !answers)) {
      if (report.type === "anchored") {
        const orphaned = marginAfterAnchored(now, report.results, height, full, report.scroll).orphaned;
        if (orphaned !== now.orphaned) places.set({ ...now, orphaned }, null);
      }
      return shown && report.type === "tracked";
    }
    if (report.type === "tracked") {
      const next = marginAfterTracked(now, report.id, report.rect, height, report);
      places.set(next.places, frameBox?.top ?? null);
      if (next.refresh) ask();
      // Document mode: the scroll is taken, every card is placed already; nothing more to ask.
      if (next.places.scrollY !== null) return true;
      // The page moved: marks may have come in that the reference says nothing of. During a long
      // scroll REFRESH_GAP_MS spaces the asks; the last one waits for the page to stop.
      if (next.moved) {
        pollFromStart();
        ask();
        settleThenRefresh();
      }
      return true;
    }
    const next = marginAfterAnchored(now, report.results, height, full, report.scroll);
    places.set(next, frameBox?.top ?? null);
    if (!nonePlaced(next)) pollFromStart();
    if (!full) ask();
    return false;
  }, [markdown, shown, places, ask, pollFromStart, settleThenRefresh]);
  // Comments shown but no card placed (the reference past an edge, or lost): ask again now and then,
  // never a margin that waits for a report that may not come; less often the longer nothing comes
  // in. The tick only reads refs: nothing re-renders until it asks. Not in document mode: a report
  // there placed every mark the page has (none placed: none is attached), and asking again finds
  // the same until the content changes, which reports by itself.
  useEffect(() => {
    if (!shown) return;
    const poll = window.setInterval(() => {
      const now = places.get().places;
      if (shownComments.current === 0 || now.scrollY !== null || !nonePlaced(now)) return;
      if (pollSkips.current > 0) {
        pollSkips.current -= 1;
        return;
      }
      ask();
      const next = unplacedPollAfterAsk(pollGap.current);
      pollGap.current = next.gap;
      pollSkips.current = next.skips;
    }, UNPLACED_POLL_MS);
    return () => window.clearInterval(poll);
  }, [shown, places, ask]);
  const margin = useMemo(() => ({ shown, setShown, requestRefresh, places }), [shown, setShown, requestRefresh, places]);
  return { margin, onReport };
}
