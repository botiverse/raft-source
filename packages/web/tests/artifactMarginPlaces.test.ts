// A Markdown Artifact's margin cards follow their passages (#proj-workspace:#152): the frame
// reports where marks are, each box clamped to its viewport (Porthole P104: a mark wholly above
// is a box of no size at y 0, one wholly below at the frame's height, one cut by the top edge has
// its top at 0); only a top inside the frame is a known place, and the others' cards aren't drawn.
// The margin follows one reference mark and moves every known card as far; with none inside, it
// follows the nearest mark past an edge, and asks for the places again when one comes in. A report
// of every mark replaces every place (InNOut's staging QA, #152: two passages in view, one card); a
// lost reference makes every top stale (a fast scroll: no card left where the page was).
// A newer frame (Porthole 0.14.10, P132: `documentRect` and `scroll`, #proj-workspace:#174) puts the
// margin in document mode: every attached mark placed from one report, the scroll from each
// `tracked`, asked again only when the followed mark's place drifts; an older frame keeps the above.
import assert from "node:assert/strict";
import type { AnchorResult, AnnotationRect } from "@botiverse/porthole";
import type { ArtifactComment, ArtifactCommentDraft } from "@botiverse/raft-shared";

import {
  DRIFT_PX,
  NO_MARGIN_PLACES,
  UNPLACED_POLL_CAP_MS,
  UNPLACED_POLL_MS,
  chooseRef,
  isRefreshMark,
  knownTop,
  marginAfterAnchored,
  marginAfterTracked,
  marginOffsetOf,
  marginTopOf,
  nonePlaced,
  refreshMark,
  refreshOf,
  unplacedPollAfterAsk,
} from "../src/apps/artifacts/artifactMarginPlaces";
import { commentMarks, withRefreshMark } from "../src/apps/artifacts/artifactCommentMarks";

const FRAME = 800;
const box = (y: number, height = 20): AnnotationRect => ({ x: 40, y, width: 300, height });
const at = (id: string, y: number, order: number): AnchorResult => ({ id, state: "attached", rect: box(y), order });
// What Porthole reports for a mark wholly past an edge: a box of no size on that edge.
const aboveFold = (id: string, order: number): AnchorResult => ({ id, state: "attached", rect: box(0, 0), order });
const belowFold = (id: string, order: number): AnchorResult => ({ id, state: "attached", rect: box(FRAME, 0), order });

test("a top is known only inside the frame: clamped boxes at either edge, or cut by the top edge, are not", () => {
  assert.equal(knownTop(box(120), FRAME), true);
  assert.equal(knownTop(box(0, 0), FRAME), false);
  assert.equal(knownTop(box(0, 14), FRAME), false);
  assert.equal(knownTop(box(FRAME, 0), FRAME), false);
  // Cut by the bottom edge: its top is still where it is.
  assert.equal(knownTop(box(790, 10), FRAME), true);
});

test("after a report only marks inside the frame have a place; clamped ones have none (their cards hidden, not stacked at an edge)", () => {
  const places = marginAfterAnchored(NO_MARGIN_PLACES, [aboveFold("a", 0), at("b", 120, 1), at("c", 380, 2), belowFold("d", 3), { id: "e", state: "orphaned" }], FRAME, true);
  assert.equal(marginTopOf(places, "a"), null);
  assert.equal(marginTopOf(places, "b"), 120);
  assert.equal(marginTopOf(places, "c"), 380);
  assert.equal(marginTopOf(places, "d"), null);
  assert.equal(marginTopOf(places, "e"), null);
  assert.deepEqual([...places.orphaned], ["e"]);
  assert.equal(places.ref, "c");
  assert.equal(places.above, "a");
  assert.equal(places.below, "d");
});

test("the followed mark's moves move every known card as far; another mark's box changes nothing", () => {
  let places = marginAfterAnchored(NO_MARGIN_PLACES, [at("a", 100, 0), at("b", 380, 1)], FRAME, true);
  ({ places } = marginAfterTracked(places, "b", box(300), FRAME));
  assert.equal(marginTopOf(places, "a"), 20);
  assert.equal(marginTopOf(places, "b"), 300);
  const other = marginAfterTracked(places, "a", box(5), FRAME);
  assert.equal(other.places, places);
  assert.equal(other.refresh, false);
  assert.equal(other.moved, false);
});

test("the followed mark moving says the page moved (the host asks again once it stops); the same box again doesn't", () => {
  const places = marginAfterAnchored(NO_MARGIN_PLACES, [at("a", 100, 0), at("b", 380, 1)], FRAME, true);
  const moved = marginAfterTracked(places, "b", box(300), FRAME);
  assert.equal(moved.moved, true);
  assert.equal(moved.refresh, false);
  const still = marginAfterTracked(moved.places, "b", box(300), FRAME);
  assert.equal(still.moved, false);
});

test("the followed mark clamped to the top edge or gone past the bottom asks for the places again", () => {
  const places = marginAfterAnchored(NO_MARGIN_PLACES, [at("a", 100, 0), at("b", 380, 1)], FRAME, true);
  const cut = marginAfterTracked(places, "b", box(0, 12), FRAME);
  assert.equal(cut.refresh, true);
  // Every top is stale: the page is somewhere the last report doesn't say (cards hidden until the next).
  assert.equal(cut.places.stale, true);
  assert.equal(nonePlaced(cut.places), true);
  assert.equal(marginAfterTracked(cut.places, "b", box(300), FRAME).moved, false);
  assert.equal(marginAfterTracked(places, "b", box(0, 0), FRAME).refresh, true);
  assert.equal(marginAfterTracked(places, "b", box(FRAME, 0), FRAME).refresh, true);
});

test("no mark inside the frame: nothing is drawn, the nearest past the bottom is followed, and its coming in asks again", () => {
  const places = marginAfterAnchored(NO_MARGIN_PLACES, [aboveFold("a", 0), aboveFold("b", 1), belowFold("c", 2), belowFold("d", 3)], FRAME, true);
  assert.equal(places.tops.size, 0);
  assert.equal(places.above, "b");
  assert.equal(places.below, "c");
  assert.equal(places.ref, "c");
  // Still past the edge: nothing to ask.
  assert.equal(marginAfterTracked(places, "c", box(FRAME, 0), FRAME).refresh, false);
  // In: ask where everything is.
  assert.equal(marginAfterTracked(places, "c", box(640), FRAME).refresh, true);
  // None placed: the host asks again now and then, whichever way the page scrolls.
  assert.equal(nonePlaced(places), true);
});

test("a full report replaces every place: two passages in view both have cards, none kept from an earlier report", () => {
  // First load at the top: P02 and P05 in view, the rest below.
  let places = marginAfterAnchored(NO_MARGIN_PLACES, [at("p02", 140, 0), at("p05", 520, 1), belowFold("p33", 2), belowFold("p39", 3)], FRAME, true);
  assert.equal(marginTopOf(places, "p02"), 140);
  // Scrolled down (the reference followed out of the frame), then a report mid-scroll: only P33 in.
  places = marginAfterAnchored(places, [aboveFold("p02", 0), aboveFold("p05", 1), at("p33", 300, 2), belowFold("p39", 3)], FRAME, true);
  assert.equal(marginTopOf(places, "p02"), null);
  // The page settles with P33 and P39 in view: the report after it stops places both.
  places = marginAfterAnchored(places, [aboveFold("p02", 0), aboveFold("p05", 1), at("p33", 120, 2), at("p39", 610, 3)], FRAME, true);
  assert.equal(marginTopOf(places, "p33"), 120);
  assert.equal(marginTopOf(places, "p39"), 610);
  // Back at the top: both P02 and P05 again, nothing left from the reports in between.
  places = marginAfterAnchored(places, [at("p02", 140, 0), at("p05", 520, 1), belowFold("p33", 2), belowFold("p39", 3)], FRAME, true);
  assert.deepEqual([...places.tops.keys()].sort(), ["p02", "p05"]);
  assert.equal(places.stale, false);
});

test("a fast scroll: the reference lost mid-jump hides every card, and the next report, wherever the page stopped, places them again", () => {
  let places = marginAfterAnchored(NO_MARGIN_PLACES, [at("p05", 300, 0), belowFold("p39", 1)], FRAME, true);
  ({ places } = marginAfterTracked(places, "p05", box(0, 0), FRAME));
  assert.equal(nonePlaced(places), true);
  // The report asked for at once comes mid-jump: nothing in view yet, still none placed (the host keeps asking).
  places = marginAfterAnchored(places, [aboveFold("p05", 0), belowFold("p39", 1)], FRAME, true);
  assert.equal(nonePlaced(places), true);
  assert.equal(places.ref, "p39");
  // The page stopped with P39 in view: the next report places it.
  places = marginAfterAnchored(places, [aboveFold("p05", 0), at("p39", 450, 1)], FRAME, true);
  assert.equal(marginTopOf(places, "p39"), 450);
  assert.equal(nonePlaced(places), false);
});

test("a report naming only some marks (a focus) takes the shift in, keeps what it doesn't name, and picks the reference again", () => {
  let places = marginAfterAnchored(NO_MARGIN_PLACES, [at("a", 100, 0), at("b", 380, 1), belowFold("c", 2)], FRAME, true);
  ({ places } = marginAfterTracked(places, "b", box(80), FRAME));
  // A report naming only `c`, now in (after a focus or a refresh that answered for it alone).
  places = marginAfterAnchored(places, [at("c", 500, 2)], FRAME, false);
  assert.equal(places.shift, 0);
  assert.equal(marginTopOf(places, "a"), -200);
  assert.equal(marginTopOf(places, "b"), 80);
  assert.equal(marginTopOf(places, "c"), 500);
  assert.equal(places.below, null);
  assert.equal(places.ref, "c");
});

test("a full report with the same places as before keeps the same places (no card re-renders); one that differs is new", () => {
  const results = [at("a", 100, 0), at("b", 380, 1), belowFold("c", 2), { id: "d", state: "orphaned" } as const];
  const places = marginAfterAnchored(NO_MARGIN_PLACES, results, FRAME, true);
  assert.equal(marginAfterAnchored(places, results, FRAME, true), places, "the same report again: the same places");
  const moved = marginAfterAnchored(places, [at("a", 120, 0), at("b", 380, 1), belowFold("c", 2), { id: "d", state: "orphaned" }], FRAME, true);
  assert.notEqual(moved, places);
  assert.notEqual(moved.tops, places.tops);
  assert.equal(moved.orphaned, places.orphaned, "the same orphans: the same set");
  assert.equal(marginTopOf(moved, "a"), 120);
  // Scrolled since (a shift taken in): the same tops, new places (the shift is 0 again).
  const { places: scrolled } = marginAfterTracked(places, "b", box(300), FRAME);
  const again = marginAfterAnchored(scrolled, results, FRAME, true);
  assert.notEqual(again, scrolled);
  assert.equal(again.tops, scrolled.tops);
  assert.equal(again.shift, 0);
});

test("the reference among known tops is the one nearest the frame's middle; none when no top is inside", () => {
  assert.equal(chooseRef(new Map([["a", 100], ["b", 420], ["c", 700]]), FRAME), "b");
  assert.equal(chooseRef(new Map(), FRAME), null);
});

test("the refresh mark says nothing of anyone and matches no text", () => {
  const mark = refreshMark(3);
  assert.equal(mark.id, "margin-refresh-3");
  assert.equal(isRefreshMark(mark.id), true);
  assert.equal(refreshOf(mark.id), 3, "which refresh it is: a report naming it answers that ask");
  assert.equal(refreshOf("c_margin-refresh-3"), null);
  assert.equal(refreshOf("fake-c-launch"), null);
  assert.equal(mark.count, undefined);
  assert.equal(mark.anchor.label, "");
  const quote = mark.anchor.selectors[0];
  assert.ok(quote?.type === "TextQuoteSelector" && quote.exact.startsWith("⁣"));
});

test("in the margin, marks carry no count and no draft marker (the cards are in the margin); the frame adds the refresh mark once asked", () => {
  const anchor = { type: "annotation" as const, data: { kind: "text" as const, selectors: [{ type: "TextQuoteSelector" as const, exact: "launch" }], label: "launch" } };
  const comment = {
    id: "c1",
    replyTo: null,
    target: { scope: "file", path: "report.md", anchor },
    createdAt: "2026-11-05T00:00:00.000Z",
    deletedAt: null,
  } as unknown as ArtifactComment;
  const draft = { id: "d1", replyTo: null, target: { scope: "file", path: "report.md", anchor } } as unknown as ArtifactCommentDraft;
  const beside = commentMarks([comment], [draft], "report.md");
  assert.equal(beside[0]?.count, 1);
  assert.equal(beside[1]?.kind, "draft");
  const margin = commentMarks([comment], [draft], "report.md", { margin: true });
  assert.equal(margin[0]?.count, undefined);
  assert.equal(margin[1]?.kind, undefined);
  assert.equal(margin.length, 2, "the frame adds the refresh mark");
  assert.deepEqual(withRefreshMark(margin, 2).at(-1), refreshMark(2));
  assert.equal(withRefreshMark(margin, 0), margin, "never asked again: no refresh mark");
});

test("the unplaced poll waits 0.5, 1, 2, 4, then 8 s between asks (its ticks 0.5 s apart), never 0.5 twice", () => {
  // Ticks of the poll from its start (reset: gap UNPLACED_POLL_MS, nothing to skip), as useArtifactMargin runs them.
  let gap = UNPLACED_POLL_MS;
  let skips = 0;
  const asks: number[] = [];
  for (let tick = 1; asks.length < 7; tick += 1) {
    if (skips > 0) {
      skips -= 1;
      continue;
    }
    asks.push(tick * UNPLACED_POLL_MS);
    ({ gap, skips } = unplacedPollAfterAsk(gap));
  }
  const waits = asks.map((at, index) => at - (asks[index - 1] ?? 0));
  assert.deepEqual(waits, [500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  assert.equal(unplacedPollAfterAsk(UNPLACED_POLL_CAP_MS).gap, UNPLACED_POLL_CAP_MS, "capped");
});

// Document mode (P132). A result as a newer frame reports it: its box in the viewport (clamped, as
// before) and its place in the document (`documentRect`, unclamped), read at `scroll`.
const inDoc = (id: string, documentY: number, order: number, scrollY: number): AnchorResult => {
  const y = documentY - scrollY;
  const rect = y + 20 <= 0 ? box(0, 0) : y >= FRAME ? box(FRAME, 0) : box(y);
  return { id, state: "attached", rect, documentRect: box(documentY), order };
};
const scrolled = (y: number) => ({ x: 0, y });

test("document mode: one report places every attached mark, offscreen ones too, each at its place in the document less the scroll", () => {
  const places = marginAfterAnchored(NO_MARGIN_PLACES, [inDoc("a", 40, 0, 600), inDoc("b", 900, 1, 600), inDoc("c", 5_000, 2, 600), { id: "d", state: "orphaned" }], FRAME, true, scrolled(600));
  assert.equal(places.scrollY, 600);
  assert.equal(places.tops.get("a"), 40, "tops are in the document");
  assert.equal(marginTopOf(places, "a"), -560, "above the frame: placed all the same (the column clips it)");
  assert.equal(marginTopOf(places, "b"), 300);
  assert.equal(marginTopOf(places, "c"), 4_400, "below the frame: placed all the same");
  assert.equal(marginTopOf(places, "d"), null);
  assert.deepEqual([...places.orphaned], ["d"]);
  assert.equal(places.above, null, "no edges in the document");
  assert.equal(places.below, null);
  assert.equal(places.ref, "b", "the mark nearest the frame's middle now");
  assert.equal(nonePlaced(places), false);
  assert.equal(marginOffsetOf(places), -600);
});

test("document mode: every tracked report's scroll moves every card, in view or not, and asks nothing; the same scroll again changes nothing", () => {
  let places = marginAfterAnchored(NO_MARGIN_PLACES, [inDoc("a", 100, 0, 0), inDoc("b", 380, 1, 0), inDoc("c", 3_000, 2, 0)], FRAME, true, scrolled(0));
  assert.equal(places.ref, "b");
  // Scrolled 2,700 px down: the followed mark is far above the frame (its rect clamped), its place unchanged.
  const far = marginAfterTracked(places, "b", box(0, 0), FRAME, { documentRect: box(380), scroll: scrolled(2_700) });
  assert.equal(far.moved, true);
  assert.equal(far.refresh, false, "a scroll is no reason to ask");
  assert.equal(far.places.stale, false, "never stale: the scroll says where everything is");
  assert.equal(far.places.tops, places.tops, "the tops don't change on a scroll (no card re-renders)");
  places = far.places;
  assert.equal(marginTopOf(places, "c"), 300, "a mark that came in has its card where it is, with no ask");
  assert.equal(marginTopOf(places, "a"), -2_600);
  const still = marginAfterTracked(places, "b", box(0, 0), FRAME, { documentRect: box(380), scroll: scrolled(2_700) });
  assert.equal(still.places, places);
  assert.equal(still.moved, false);
  assert.equal(still.refresh, false);
  // Another mark's report (a frame still following the one before) tells the same document's scroll.
  const other = marginAfterTracked(places, "a", box(0, 0), FRAME, { documentRect: box(100), scroll: scrolled(2_650) });
  assert.equal(other.places.scrollY, 2_650);
  assert.equal(other.refresh, false);
});

test("document mode: the followed mark's place in the document drifting more than DRIFT_PX asks again (the layout changed); less doesn't", () => {
  const places = marginAfterAnchored(NO_MARGIN_PLACES, [inDoc("a", 100, 0, 0), inDoc("b", 380, 1, 0)], FRAME, true, scrolled(0));
  assert.equal(places.ref, "b");
  assert.equal(marginAfterTracked(places, "b", box(380 + DRIFT_PX), FRAME, { documentRect: box(380 + DRIFT_PX), scroll: scrolled(0) }).refresh, false);
  const drifted = marginAfterTracked(places, "b", box(420), FRAME, { documentRect: box(420), scroll: scrolled(0) });
  assert.equal(drifted.refresh, true, "an image loaded above it: every place is asked for again");
  assert.equal(drifted.moved, false);
  // Drift and scroll at once: both.
  const both = marginAfterTracked(places, "b", box(320), FRAME, { documentRect: box(420), scroll: scrolled(100) });
  assert.equal(both.refresh, true);
  assert.equal(both.places.scrollY, 100);
  // Another mark's place says nothing of the followed one's: no ask.
  assert.equal(marginAfterTracked(places, "a", box(160), FRAME, { documentRect: box(160), scroll: scrolled(0) }).refresh, false);
});

test("document mode: the reference stays the one followed while it is placed; a report naming some marks keeps the others' places in the document", () => {
  let places = marginAfterAnchored(NO_MARGIN_PLACES, [inDoc("a", 100, 0, 0), inDoc("b", 380, 1, 0), inDoc("c", 3_000, 2, 0)], FRAME, true, scrolled(0));
  ({ places } = marginAfterTracked(places, "b", box(0, 0), FRAME, { documentRect: box(380), scroll: scrolled(2_700) }));
  // A full report now: `c` nearest the middle, but `b` is still followed (no new track for nothing).
  places = marginAfterAnchored(places, [inDoc("a", 100, 0, 2_700), inDoc("b", 380, 1, 2_700), inDoc("c", 3_000, 2, 2_700)], FRAME, true, scrolled(2_700));
  assert.equal(places.ref, "b");
  // A focus's report naming `c` alone, moved: `a` and `b` keep their places.
  places = marginAfterAnchored(places, [inDoc("c", 3_040, 2, 2_700)], FRAME, false, scrolled(2_700));
  assert.equal(places.tops.get("a"), 100);
  assert.equal(places.tops.get("b"), 380);
  assert.equal(marginTopOf(places, "c"), 340);
  // `b`'s passage gone: the reference is chosen again, nearest the middle now.
  places = marginAfterAnchored(places, [inDoc("a", 100, 0, 2_700), { id: "b", state: "orphaned" }, inDoc("c", 3_040, 2, 2_700)], FRAME, true, scrolled(2_700));
  assert.equal(places.ref, "c");
  assert.equal(marginTopOf(places, "b"), null);
});

test("document mode: the same report again keeps the same places (no card re-renders)", () => {
  const results = [inDoc("a", 100, 0, 50), inDoc("b", 3_000, 1, 50), { id: "d", state: "orphaned" } as const];
  const places = marginAfterAnchored(NO_MARGIN_PLACES, results, FRAME, true, scrolled(50));
  assert.equal(marginAfterAnchored(places, results, FRAME, true, scrolled(50)), places);
  const moved = marginAfterAnchored(places, results, FRAME, true, scrolled(80));
  assert.notEqual(moved, places, "another scroll: new places");
  assert.equal(moved.tops, places.tops, "with the same tops");
});

test("which way is the report's: an older frame's (no scroll) keeps the viewport boxes' way, and never mixes in tops from the document", () => {
  // Document mode, then a report from an older shell (a frame reloaded onto an older Worker) naming one mark.
  const inDocument = marginAfterAnchored(NO_MARGIN_PLACES, [inDoc("a", 100, 0, 2_000), inDoc("b", 2_300, 1, 2_000)], FRAME, true, scrolled(2_000));
  const older = marginAfterAnchored(inDocument, [at("b", 300, 1)], FRAME, false);
  assert.equal(older.scrollY, null);
  assert.equal(marginTopOf(older, "a"), null, "a's top in the document says nothing in the viewport: not kept");
  assert.equal(marginTopOf(older, "b"), 300);
  // A tracked without a scroll on places in the document: they say nothing of it; the host asks.
  const lost = marginAfterTracked(inDocument, "b", box(300), FRAME);
  assert.equal(lost.refresh, true);
  assert.equal(lost.places, inDocument);
  // Viewport places, then a newer frame's report naming one mark: viewport tops aren't kept either.
  const viewport = marginAfterAnchored(NO_MARGIN_PLACES, [at("a", 100, 0), at("b", 380, 1)], FRAME, true);
  const newer = marginAfterAnchored(viewport, [inDoc("b", 1_380, 1, 1_000)], FRAME, false, scrolled(1_000));
  assert.equal(marginTopOf(newer, "a"), null);
  assert.equal(marginTopOf(newer, "b"), 380);
  // A tracked report with a scroll on viewport places (none from the document yet): as before.
  assert.equal(marginAfterTracked(viewport, "b", box(300), FRAME, { documentRect: box(1_300), scroll: scrolled(1_000) }).places.shift, -80);
});
