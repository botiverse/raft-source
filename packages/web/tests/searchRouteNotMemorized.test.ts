import assert from "node:assert/strict";
import test from "node:test";
import { classifyRouteForTab } from "../src/hooks/useTabRouteMemory";

// Regression: task #311 (#proj-uiux:c2313b1d). /search must NOT be
// classified as "chat" — if it is, visiting Search overwrites the chat
// memory slot with "/search", and clicking the Chat rail button reads
// that back and bounces the user right back to Search. The classifier
// returning null lets useTabRouteMemory skip the write entirely.
//
// Search is its own rail mode and selectRailMode("search") deliberately
// does not consult tabMemory — every entry starts at /search with no
// query.

test("classifyRouteForTab — /search is NOT memorized as any rail mode", () => {
  assert.equal(classifyRouteForTab("/s/dev/search", "/s/dev"), null);
  assert.equal(classifyRouteForTab("/s/dev/search/", "/s/dev"), null);
  assert.equal(classifyRouteForTab("/s/dev/search/anything", "/s/dev"), null);
});

test("classifyRouteForTab — chat-belonging routes still classify as chat", () => {
  // Sanity: the same suite would silently pass if classifyRouteForTab
  // started returning null for everything. Pin a few known-chat shapes
  // so the regression test above is meaningful.
  assert.equal(classifyRouteForTab("/s/dev", "/s/dev"), "chat");
  assert.equal(classifyRouteForTab("/s/dev/", "/s/dev"), "chat");
  assert.equal(classifyRouteForTab("/s/dev/channel/abc", "/s/dev"), "chat");
  assert.equal(classifyRouteForTab("/s/dev/dm/123", "/s/dev"), "chat");
  assert.equal(classifyRouteForTab("/s/dev/threads", "/s/dev"), "chat");
  assert.equal(classifyRouteForTab("/s/dev/saved", "/s/dev"), "chat");
});
