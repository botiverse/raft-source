import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchRetryReset } from "../src/components/search/searchRetry.js";

test("retry clears stale results and enters a fresh loading cycle", () => {
  assert.deepEqual(buildSearchRetryReset(), {
    results: [],
    loading: true,
    loadingMore: false,
    hasMore: false,
    searchError: null,
  });
});
