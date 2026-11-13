import assert from "node:assert/strict";
import {
  __setSyncLateCapForTests,
  parseSyncHorizon,
  snapshotXidSpan,
  SYNC_LATE_CAP,
  syncHorizonFromDatabase,
  syncLateCap,
} from "./syncHorizon";

test("a since-horizon is the decimal string of a non-negative integer that fits xid8", () => {
  for (const valid of ["0", "1", "752", "4294967296", "18446744073709551615"]) {
    assert.equal(parseSyncHorizon(valid), valid, valid);
  }
  for (const invalid of [
    "", " 1", "1 ", "-1", "+1", "01", "00", "1.0", "1e3", "0x10", "abc",
    "18446744073709551616", // 2^64: does not fit xid8
    "99999999999999999999999",
    "１２", // full-width digits
  ]) {
    assert.equal(parseSyncHorizon(invalid), null, JSON.stringify(invalid));
  }
  // Only strings: query arrays, numbers (precision loss above 2^53) and objects are refused.
  for (const invalid of [1, 0, 1n, null, undefined, ["1"], { horizon: "1" }, true]) {
    assert.equal(parseSyncHorizon(invalid), null, String(invalid));
  }
});

test("the database horizon must be a valid xid8 text, and the snapshot span is xmax - xmin", () => {
  assert.equal(syncHorizonFromDatabase("42"), "42");
  assert.equal(syncHorizonFromDatabase(42n), "42");
  assert.throws(() => syncHorizonFromDatabase(null), /sync_horizon_invalid_from_database/);
  assert.throws(() => syncHorizonFromDatabase("-1"), /sync_horizon_invalid_from_database/);

  const xmin = syncHorizonFromDatabase("1000");
  assert.equal(snapshotXidSpan(xmin, "1000"), 0);
  assert.equal(snapshotXidSpan(xmin, "1007"), 7);
  assert.equal(snapshotXidSpan(xmin, null), null);
  assert.equal(snapshotXidSpan(xmin, "999"), null, "a span below zero is not a measurement");
});

test("the late cap is 500 unless a test overrides it", () => {
  assert.equal(SYNC_LATE_CAP, 500);
  assert.equal(syncLateCap(), 500);
  __setSyncLateCapForTests(2);
  try {
    assert.equal(syncLateCap(), 2);
  } finally {
    __setSyncLateCapForTests(null);
  }
  assert.equal(syncLateCap(), 500);
});
