import assert from "node:assert/strict";
import { test } from "vitest";
import { parseOffsetQueryParam } from "./offsetQueryParam";

test("an ordinary offset is read as a whole number", () => {
  assert.equal(parseOffsetQueryParam("30"), 30);
  assert.equal(parseOffsetQueryParam("30.9"), 30);
});

test("missing, non-numeric or negative reads as 0, as before", () => {
  assert.equal(parseOffsetQueryParam(undefined), 0);
  assert.equal(parseOffsetQueryParam(""), 0);
  assert.equal(parseOffsetQueryParam("abc"), 0);
  assert.equal(parseOffsetQueryParam("-5"), 0);
  assert.equal(parseOffsetQueryParam(["1", "2"]), 0);
});

test("an offset past bigint is clamped instead of reaching SQL (offset=1e20 failed the inbox read)", () => {
  assert.equal(parseOffsetQueryParam("100000000000000000000"), Number.MAX_SAFE_INTEGER);
  assert.equal(parseOffsetQueryParam("1e400"), Number.MAX_SAFE_INTEGER);
  assert.equal(parseOffsetQueryParam("Infinity"), Number.MAX_SAFE_INTEGER);
});
