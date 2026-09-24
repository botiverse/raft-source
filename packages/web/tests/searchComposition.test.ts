import assert from "node:assert/strict";
import test from "node:test";
import {
  getCommittedSearchQuery,
  isSearchKeyboardComposing,
} from "../src/components/search/searchComposition.js";

test("defers committed search query while IME composition is active", () => {
  assert.equal(getCommittedSearchQuery("nihao", true), null);
});

test("commits the final trimmed query after composition ends", () => {
  assert.equal(getCommittedSearchQuery("  nihao  ", false), "nihao");
  assert.equal(getCommittedSearchQuery("   ", false), "");
});

test("detects IME composition keydowns from native event and keyCode fallback", () => {
  assert.equal(isSearchKeyboardComposing({ nativeEvent: { isComposing: true } }), true);
  assert.equal(isSearchKeyboardComposing({ nativeEvent: { keyCode: 229 } }), true);
  assert.equal(isSearchKeyboardComposing({ isComposing: true }), true);
  assert.equal(isSearchKeyboardComposing({ keyCode: 229 }), true);
  assert.equal(isSearchKeyboardComposing({ nativeEvent: { isComposing: false, keyCode: 13 } }), false);
});
