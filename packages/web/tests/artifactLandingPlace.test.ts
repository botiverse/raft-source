// A landing (a comment's Activity row, `?comment=`) opens its thread's card once the frame has
// brought its mark into view (InNOut's staging QA, #proj-workspace:#152: at 1440 px nothing opened
// beside the margin, at 780 px the card opened where the mark was before the page scrolled). The
// frame's boxes are clamped to its viewport (P104): one past an edge says the focus hasn't landed.
import assert from "node:assert/strict";
import type { AnchorResult, AnnotationRect } from "@botiverse/porthole";

import { LANDING_FOCUS_TRIES, landingStep } from "../src/apps/artifacts/artifactLandingPlace";

const FRAME = 900;
const box = (y: number, height = 24): AnnotationRect => ({ x: 40, y, width: 600, height });
const attached = (rect: AnnotationRect): AnchorResult => ({ id: "p39", state: "attached", rect });

test("the mark brought into view: its card opens there", () => {
  assert.equal(landingStep(attached(box(420)), FRAME, 0), "land");
  // Cut by the frame's foot: its top is still where it is.
  assert.equal(landingStep(attached(box(890, 10)), FRAME, 1), "land");
});

test("the mark still past an edge (the report came before the scroll, or the focus was lost): ask again, then the list on the comment, never a card at the edge", () => {
  const below = attached(box(FRAME, 0));
  const above = attached(box(0, 0));
  assert.equal(landingStep(below, FRAME, 0), "refocus");
  assert.equal(landingStep(above, FRAME, 1), "refocus");
  assert.equal(landingStep(attached(box(0, 18)), FRAME, 2), "refocus");
  assert.equal(landingStep(below, FRAME, LANDING_FOCUS_TRIES), "list");
  assert.equal(landingStep(above, FRAME, LANDING_FOCUS_TRIES), "list");
  // Brought into view on the last try: its card opens there.
  assert.equal(landingStep(attached(box(420)), FRAME, LANDING_FOCUS_TRIES), "land");
});

test("the passage is gone: the list on the comment instead", () => {
  assert.equal(landingStep({ id: "p39", state: "orphaned" }, FRAME, 0), "list");
  assert.equal(landingStep({ id: "p39", state: "attached" }, FRAME, 0), "list");
});

test("a frame not laid out (no height known): the mark is taken as in view", () => {
  assert.equal(landingStep(attached(box(300, 12)), 0, 0), "land");
  assert.equal(landingStep(attached(box(0, 0)), 0, 0), "refocus");
  assert.equal(landingStep(attached(box(0, 0)), 0, LANDING_FOCUS_TRIES), "list");
});
