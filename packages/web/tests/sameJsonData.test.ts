import assert from "node:assert/strict";
import { sameJsonData } from "../src/utils/sameJsonData";

// One comparison for "the answer holds what we already show": a channel list
// row (channelDomain's hydrate) and a fetched message (messageReuse).

test("JSON data is compared by content, nested values included", () => {
  assert.equal(sameJsonData({ a: 1, b: [1, { c: "x", d: null }] }, { b: [1, { d: null, c: "x" }], a: 1 }), true);
  assert.equal(sameJsonData([], []), true);
  assert.equal(sameJsonData(null, null), true);
  assert.equal(sameJsonData({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(sameJsonData({ a: [1, 2] }, { a: [1, 2, 3] }), false);
  assert.equal(sameJsonData({ a: 1 }, { a: "1" }), false);
  assert.equal(sameJsonData({ a: null }, { a: {} }), false);
  assert.equal(sameJsonData([], {}), false);
  assert.equal(sameJsonData({}, []), false);
  assert.equal(sameJsonData({ 0: "a" }, ["a"]), false);
});

test("the strict cases: an undefined key is not an absent key, 0 is not -0, and only plain objects are read", () => {
  assert.equal(sameJsonData({ a: 1, b: undefined }, { a: 1 }), false);
  assert.equal(sameJsonData({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(sameJsonData({ a: undefined }, { b: undefined }), false);
  assert.equal(sameJsonData({ a: 0 }, { a: -0 }), false);
  assert.equal(sameJsonData({ a: Number.NaN }, { a: Number.NaN }), true);
  assert.equal(sameJsonData({ at: new Date(0) }, { at: new Date(0) }), false);
  assert.equal(sameJsonData(new Map(), new Map()), false);
  const shared = new Date(0);
  assert.equal(sameJsonData({ at: shared }, { at: shared }), true);
  assert.equal(sameJsonData(Object.assign(Object.create(null) as object, { a: 1 }), { a: 1 }), true);
});
