import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DoneFrontierAboveInt4AuthorityError,
  DoneFrontierBeyondLatestError,
  DoneFrontierRequiredError,
  parsePositiveCanonicalDecimalForTest,
} from "./inboxSuppressionWriters.js";

test("Done frontier parser preserves exact positive canonical decimals beyond 2^53", () => {
  assert.equal(parsePositiveCanonicalDecimalForTest("1"), 1n);
  assert.equal(parsePositiveCanonicalDecimalForTest("2147483648"), 2_147_483_648n);
  assert.equal(parsePositiveCanonicalDecimalForTest("9007199254740993"), 9_007_199_254_740_993n);
});

test("Done frontier parser rejects zero, non-canonical strings, and every non-string", () => {
  for (const value of [
    undefined,
    null,
    1,
    1n,
    "",
    "0",
    "00",
    "007",
    "+1",
    "-1",
    "1.0",
    " 1",
    "1 ",
    "1e3",
  ]) {
    assert.equal(parsePositiveCanonicalDecimalForTest(value), null, `must reject ${String(value)}`);
  }
});

test("adjacent exact frontiers beyond 2^53 remain ordered", () => {
  const latest = parsePositiveCanonicalDecimalForTest("9007199254740992")!;
  const beyond = parsePositiveCanonicalDecimalForTest("9007199254740993")!;
  assert.equal(beyond > latest, true);
  assert.equal(latest > latest, false);
});

test("typed Done frontier errors expose distinct stable route codes", () => {
  const required = new DoneFrontierRequiredError("scope", undefined);
  const beyond = new DoneFrontierBeyondLatestError("scope", "8", "7");
  const capped = new DoneFrontierAboveInt4AuthorityError("scope", "2147483648", "shadow_widen");
  assert.equal(required.code, "DONE_FRONTIER_REQUIRED");
  assert.equal(beyond.code, "DONE_FRONTIER_BEYOND_LATEST");
  assert.equal(capped.code, "DONE_FRONTIER_ABOVE_INT4_AUTHORITY");
  assert.match(beyond.message, /beyond current latest/);
  assert.match(capped.message, /exceeds the int4 rollback authority/);
});
