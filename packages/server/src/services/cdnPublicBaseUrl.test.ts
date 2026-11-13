import assert from "node:assert/strict";
import { test } from "vitest";
import { cdnPublicBaseUrl } from "./storageService";

test("The CDN base: CDN_BASE_URL, trimmed; blank is none, and the old base's variable is gone", () => {
  assert.equal(cdnPublicBaseUrl({ CDN_BASE_URL: " https://cdn.raft.build " }), "https://cdn.raft.build");
  assert.equal(cdnPublicBaseUrl({ CDN_BASE_URL: "" }), null);
  assert.equal(cdnPublicBaseUrl({ CDN_LEGACY_BASE_URL: "https://cdn.slock.ai" }), null);
});
