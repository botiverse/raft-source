import assert from "node:assert/strict";

import { EDGE_MARKER_PX, edgeMarkerPlace, followedPlace, selectionPlace, sheetLift } from "../src/apps/artifacts/artifactTrackedPlaces";

// A card opened beside its marker moves as its mark's box moves; the frame clamps that box to its
// edges (Porthole P104), so a clamped side says nothing about the move (review of #11839).

const frame = { left: 100, top: 100, width: 600, height: 400 };
const marker = { x: 650, y: 300, width: 16, height: 16 };
const box = (y: number, height: number) => ({ x: 120, y, width: 560, height });
/** The box Porthole reports for a passage at `y` of `height` (client px), clamped to the frame. */
const clamped = (y: number, height: number) => {
  const top = Math.max(y, frame.top);
  const bottom = Math.min(y + height, frame.top + frame.height);
  return box(top, Math.max(0, bottom - top));
};

test("unclamped: the card moves as the passage does", () => {
  const placed = followedPlace(marker, clamped(250, 80), clamped(200, 80), frame);
  assert.equal(placed.y, 250);
});

test("opened with the passage already cut off above: scrolling further moves the card with its end", () => {
  // The passage starts 60px above the frame; its marker is near its end.
  const base = clamped(40, 280);
  assert.equal(followedPlace(marker, base, clamped(-10, 280), frame).y, 250, "scrolled 50 up");
  assert.equal(followedPlace(marker, base, clamped(110, 280), frame).y, 370, "scrolled back 70 down, start visible again");
});

test("held at the bottom edge: the card moves with the passage's start", () => {
  const base = clamped(300, 400);
  assert.equal(followedPlace(marker, base, clamped(260, 400), frame).y, 260);
});

test("held at both edges (taller than the frame): the card stays put", () => {
  const base = clamped(50, 800);
  assert.equal(followedPlace(marker, base, clamped(20, 800), frame).y, 300);
});

test("the result stays within the frame", () => {
  const placed = followedPlace(marker, clamped(250, 80), clamped(-400, 80), frame);
  assert.equal(placed.y, frame.top);
});

// What follows a selection goes after its last line (Porthole 0.14.11, P133): the document's
// coordinates less the scroll it was read at, in the frame's box. That box is the page's word and
// unclamped, so it is clipped to the frame whatever the page says (THREAT_MODEL §6; Tenny).

/** A selection of three lines at the top of the frame: its whole box, clamped, as `selected` says it. */
const selection = { rect: { x: 40, y: 50, width: 500, height: 60 } };
const scroll = { x: 0, y: 1000 };

test("a selection's place is its last line, less the scroll, in client px", () => {
  const lastLineDocumentRect = { x: 40, y: 1090, width: 160, height: 20 };
  // The words end at 300 on screen, not at the widest line's 640.
  assert.deepEqual(selectionPlace({ ...selection, lastLineDocumentRect, scroll }, frame), { x: 140, y: 190, width: 160, height: 20 });
});

test("the frame scrolled sideways: less that too", () => {
  const lastLineDocumentRect = { x: 340, y: 90, width: 100, height: 20 };
  assert.deepEqual(selectionPlace({ ...selection, lastLineDocumentRect, scroll: { x: 300, y: 0 } }, frame), { x: 140, y: 190, width: 100, height: 20 });
});

test("an older frame says neither, or half: the selection's whole box, as ever", () => {
  const whole = { x: 140, y: 150, width: 500, height: 60 };
  assert.deepEqual(selectionPlace(selection, frame), whole);
  assert.deepEqual(selectionPlace({ ...selection, scroll }, frame), whole);
  assert.deepEqual(selectionPlace({ ...selection, lastLineDocumentRect: { x: 40, y: 90, width: 160, height: 20 } }, frame), whole);
});

test("no frame box, nothing to clip to: the clamped box, never the page's unclamped one", () => {
  const lastLineDocumentRect = { x: 10_000_000, y: 10_000_000, width: 160, height: 20 };
  assert.deepEqual(selectionPlace({ ...selection, lastLineDocumentRect, scroll: { x: 0, y: 0 } }, null), selection.rect);
});

for (const [name, lastLineDocumentRect, place] of [
  ["10,000,000 px down and right", { x: 10_000_000, y: 10_000_000, width: 160, height: 20 }, { x: 700, y: 500, width: 0, height: 0 }],
  ["10,000,000 px up and left", { x: -10_000_000, y: -10_000_000, width: 160, height: 20 }, { x: 100, y: 100, width: 0, height: 0 }],
  ["wider and taller than the frame", { x: -10_000_000, y: -10_000_000, width: 20_000_000, height: 20_000_000 }, { x: 100, y: 100, width: 600, height: 400 }],
  ["cut by the frame's bottom right corner", { x: 500, y: 390, width: 160, height: 20 }, { x: 600, y: 490, width: 100, height: 10 }],
] as const) {
  test(`P133 clip (Tenny): a last line ${name} is drawn from inside the frame alone`, () => {
    const placed = selectionPlace({ ...selection, lastLineDocumentRect, scroll: { x: 0, y: 0 } }, frame);
    assert.deepEqual(placed, place);
    assert.ok(placed.x >= frame.left && placed.x + placed.width <= frame.left + frame.width, "within the frame's width");
    assert.ok(placed.y >= frame.top && placed.y + placed.height <= frame.top + frame.height, "within the frame's height");
  });
}

test("P133 clip (Tenny): a page's scroll is the page's word too: it can't take the line out of the frame", () => {
  const lastLineDocumentRect = { x: 40, y: 90, width: 160, height: 20 };
  const placed = selectionPlace({ ...selection, lastLineDocumentRect, scroll: { x: -10_000_000, y: 10_000_000 } }, frame);
  assert.deepEqual(placed, { x: 700, y: 100, width: 0, height: 0 });
});

// #proj-workspace:#229: a composer whose selection is out of view leaves a marker at the frame's
// edge, from the page's unclamped `documentRect` and `scroll` (P138), clipped to the frame.
test("the edge marker of a composer out of view: at the top for a selection above, else at the bottom, level with it across", () => {
  const scroll = { x: 0, y: 1000 };
  assert.deepEqual(edgeMarkerPlace({ documentRect: { x: 40, y: 700, width: 100, height: 20 }, scroll }, frame), { x: 140, y: 100, edge: "top" });
  assert.deepEqual(edgeMarkerPlace({ documentRect: { x: 40, y: 1900, width: 100, height: 20 }, scroll }, frame), { x: 140, y: 100 + 400 - EDGE_MARKER_PX, edge: "bottom" });
});

test("the edge marker never leaves the frame, wherever the page says the selection is", () => {
  for (const far of [10_000_000, -10_000_000]) {
    const placed = edgeMarkerPlace({ documentRect: { x: far, y: far, width: 100, height: 20 }, scroll: { x: 0, y: 0 } }, frame);
    assert.ok(placed.x >= frame.left && placed.x + EDGE_MARKER_PX <= frame.left + frame.width, `x ${placed.x}`);
    assert.ok(placed.y >= frame.top && placed.y + EDGE_MARKER_PX <= frame.top + frame.height, `y ${placed.y}`);
  }
});

test("a phone's sheet: the frame is lifted just enough for the selection to clear it, never past its top nor more than the frame", () => {
  assert.equal(sheetLift({ top: 50, bottom: 90 }, 300, 500), 0, "above the sheet already");
  assert.equal(sheetLift({ top: 350, bottom: 390 }, 300, 500), 390 + 16 - 300, "under it: lifted until it clears it");
  assert.equal(sheetLift({ top: 200, bottom: 700 }, 300, 500), 200 - 16, "taller than the room: its top stays in view");
  assert.equal(sheetLift({ top: 10_000_000, bottom: 10_000_040 }, 300, 500), 500, "the page's word, bounded by the frame");
  assert.equal(sheetLift({ top: -400, bottom: -360 }, 300, 500), 0, "above the frame: no lift");
});
