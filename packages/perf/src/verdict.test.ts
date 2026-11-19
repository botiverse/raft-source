import assert from "node:assert/strict";
import { median, overallVerdict, pairedVerdict } from "./verdict";

// The verdict of a paired on/off page measurement (docs/frontend/perf-measure.md).

test("median of odd and even lists, empty is null", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("better: median delta below the floor and the pairs agree", () => {
  const v = pairedVerdict([400, 410, 390, 405, 395], [600, 620, 590, 610, 605]);
  assert.equal(v.verdict, "better");
  assert.equal(v.pairs, 5);
  assert.equal(v.fasterPairs, 5);
  assert.equal(v.noiseFloor, 30);
});

test("worse mirrors better", () => {
  assert.equal(pairedVerdict([700, 720, 690], [500, 510, 495]).verdict, "worse");
});

test("same: a delta inside the noise floor", () => {
  const v = pairedVerdict([510, 495, 505, 500, 520], [500, 500, 500, 500, 500]);
  assert.equal(v.verdict, "same");
});

test("same: a large median delta the pairs do not agree on", () => {
  // Median delta -200, but only 3 of 5 pairs are faster beyond the floor (needs 4).
  const v = pairedVerdict([300, 300, 300, 520, 530], [500, 500, 500, 500, 500]);
  assert.equal(v.medianDelta, -200);
  assert.equal(v.fasterPairs, 3);
  assert.equal(v.verdict, "same");
});

test("the floor grows with the baseline: 2% of a 10 s load is 200 ms", () => {
  const v = pairedVerdict([9850, 9840, 9860], [10000, 10000, 10000]);
  assert.equal(v.noiseFloor, 200);
  assert.equal(v.verdict, "same");
});

test("pairs with a missing side are dropped; too few complete pairs is unknown, not a guess", () => {
  const v = pairedVerdict([400, null, 390, null], [600, 610, null, 600]);
  assert.equal(v.pairs, 1);
  assert.equal(v.verdict, "unknown");
  assert.equal(v.noiseFloor, null);
});

test("overall: any worse wins, then unknown, then better", () => {
  assert.equal(overallVerdict(["better", "worse"]), "worse");
  assert.equal(overallVerdict(["better", "unknown"]), "unknown");
  assert.equal(overallVerdict(["better", "same"]), "better");
  assert.equal(overallVerdict(["same", "same"]), "same");
});

test("worse beats unknown in the overall verdict", () => {
  assert.equal(overallVerdict(["unknown", "worse"]), "worse");
});

test("an even number of pairs uses the mean of the middle two deltas", () => {
  const v = pairedVerdict([400, 410, 420, 430], [500, 500, 500, 500]);
  assert.equal(v.medianDelta, -85);
  assert.equal(v.verdict, "better");
});

test("a delta exactly at the floor is not beyond it", () => {
  const v = pairedVerdict([530, 530, 530], [500, 500, 500]);
  assert.equal(v.noiseFloor, 30);
  assert.equal(v.slowerPairs, 0);
  assert.equal(v.verdict, "same");
});

test("non-finite values drop their pair", () => {
  const v = pairedVerdict([Number.NaN, Number.POSITIVE_INFINITY, 400, 400, 400], [500, 500, 500, 500, 500]);
  assert.equal(v.pairs, 3);
  assert.equal(v.verdict, "better");
});

test("confidence: five pairs are too few to settle, however well they agree", () => {
  const v = pairedVerdict([400, 410, 390, 405, 395], [600, 620, 590, 610, 605]);
  assert.equal(v.verdict, "better");
  assert.equal(v.confidence, "too-few");
  assert.equal(v.interval, null);
  // deltas -200, -210, -200, -205, -210: the estimate sits among them
  assert.ok(v.shift! <= -200 && v.shift! >= -210);
});

test("confidence: settled when the whole interval is beyond the floor, or wholly inside it", () => {
  const better = pairedVerdict([400, 410, 390, 405, 395, 402], [600, 620, 590, 610, 605, 600]);
  assert.equal(better.verdict, "better");
  assert.equal(better.confidence, "settled");
  assert.deepEqual(better.interval, [-210, -198]);
  const same = pairedVerdict([505, 495, 502, 498, 504, 497], [500, 500, 500, 500, 500, 500]);
  assert.equal(same.verdict, "same");
  assert.equal(same.confidence, "settled");
});

test("confidence: open when the interval crosses a floor line, whatever the rule answered", () => {
  // median delta -45 and 5 of 6 pairs faster: the rule says better, but the interval reaches inside the 30 ms floor
  const v = pairedVerdict([455, 450, 460, 452, 458, 495], [500, 500, 500, 500, 500, 500]);
  assert.equal(v.verdict, "better");
  assert.equal(v.confidence, "open");
  assert.ok(v.interval![1] > -30);
});

test("confidence: unknown verdicts are too-few", () => {
  assert.equal(pairedVerdict([1, 2], [1, 2]).confidence, "too-few");
});

test("confidence: open when the interval is beyond the floor but the rule says same (too few pairs agree)", () => {
  // 9 of 12 pairs faster beyond the floor (10 needed): the rule says same, the interval says better
  const deltas = [-45, -24, -1, -61, -47, -39, -29, -326, -37, -248, -107, -42];
  const v = pairedVerdict(deltas.map((d) => 500 + d), deltas.map(() => 500));
  assert.equal(v.verdict, "same");
  assert.ok(v.interval![1] < -30);
  assert.equal(v.confidence, "open");
});

test("confidence: an interval that only touches the floor line is still inside it", () => {
  // six deltas of exactly +30 and -30 around the 30 ms floor: the interval is [-30, 30]
  const v = pairedVerdict([530, 470, 530, 470, 530, 470], [500, 500, 500, 500, 500, 500]);
  assert.deepEqual(v.interval, [-30, 30]);
  assert.equal(v.verdict, "same");
  assert.equal(v.confidence, "settled");
});
