import assert from "node:assert/strict";

import { cascadeSeam, SEAM_COLUMN_MIN_WIDTH, seamReach, solveRow } from "../src/components/ui/seamCascade";

// #proj-raft-ui:#189, the design lead's prototype (pt_141adb2e): its `cascade` (rule 1) and `solve` (rule 4).

const row = (...widths: number[]) => widths.map((width) => ({ width, min: SEAM_COLUMN_MIN_WIDTH }));

test("a seam trades width between its two neighbours only while neither is at 160", () => {
  // Conversation 500 | thread 400 | Tasks 300: the thread | Tasks seam 100px left.
  assert.deepEqual(cascadeSeam(row(500, 400, 300), 1, -100), [500, 300, 400]);
  assert.deepEqual(cascadeSeam(row(500, 400, 300), 1, 100), [500, 500, 200]);
  assert.deepEqual(cascadeSeam(row(500, 400, 300), 1, 0), [500, 400, 300]);
});

test("past 160 the drag takes from the next column further out, in both directions", () => {
  // Left: the thread gives 240 down to 160, the conversation the other 60.
  assert.deepEqual(cascadeSeam(row(500, 400, 300), 1, -300), [440, 160, 600]);
  // Right, through two neighbours: Tasks gives 140, Files 60.
  assert.deepEqual(cascadeSeam(row(500, 400, 300, 300), 1, 200), [500, 600, 160, 240]);
});

test("the cascade stops once every column on that side is at 160; the growing column takes only what was given", () => {
  assert.deepEqual(cascadeSeam(row(500, 400, 300), 1, -2000), [160, 160, 880]);
  assert.deepEqual(cascadeSeam(row(500, 400, 300, 300), 1, 1000), [500, 680, 160, 160]);
  assert.deepEqual(seamReach(row(500, 400, 300), 1), { left: 580, right: 140 });
});

test("the conversation is a column like the others: its own minimum is what the drag respects", () => {
  // Where the conversation keeps no width of its own (rowSeams: a thread covering it) it keeps its 360.
  const columns = [{ width: 500, min: 360 }, ...row(400, 300)];
  assert.deepEqual(cascadeSeam(columns, 1, -1000), [360, 160, 680]);
});

test("the sum of the row never changes", () => {
  for (const dx of [-700, -123.5, 0, 42, 999]) {
    const widths = cascadeSeam(row(440, 400, 360, 400), 2, dx);
    assert.equal(Math.round(widths.reduce((a, b) => a + b, 0)), 1600, String(dx));
  }
});

const unit = (saved: number, contentMin: number) => ({ saved, contentMin });

test("rule 4: room to spare grows every column in proportion; the saved widths fill the row exactly", () => {
  assert.deepEqual(solveRow([unit(600, 360), unit(400, 360)], 1500).map(Math.round), [900, 600]);
  assert.deepEqual(solveRow([unit(600, 360), unit(400, 360)], 1000), [600, 400], "what a release saved is what shows");
});

test("rule 4: short of room each gives up what it has above its content's minimum, in proportion, before anything clips", () => {
  // 80 short: the conversation has 240 above 360, the thread 40: they give 80 * 240/280 and 80 * 40/280.
  assert.deepEqual(solveRow([unit(600, 360), unit(400, 360)], 920).map(Math.round), [531, 389]);
  assert.deepEqual(solveRow([unit(600, 360), unit(400, 360)], 720), [360, 360]);
  // A column saved under its content's minimum keeps its saved width as its floor: it never grows to give way.
  assert.deepEqual(solveRow([unit(200, 360), unit(400, 360)], 560), [200, 360]);
});

test("rule 4: past the content minimums all shrink in proportion, clipping, never under 160", () => {
  assert.deepEqual(solveRow([unit(600, 360), unit(400, 360)], 520), [260, 260]);
  assert.deepEqual(solveRow([unit(600, 360), unit(400, 360)], 200), [160, 160]);
});
