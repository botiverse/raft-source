import assert from "node:assert/strict";
import test from "node:test";

import { formatUtcTimestamp } from "./utcTimestamp.js";

test("formatUtcTimestamp emits a second-precision UTC timestamp with an explicit Z", () => {
  assert.equal(formatUtcTimestamp("2026-04-21T06:30:00.123Z"), "2026-04-21 06:30:00Z");
});

test("formatUtcTimestamp preserves an invalid source string", () => {
  assert.equal(formatUtcTimestamp("not-a-date"), "not-a-date");
});
