// The trace event for one app's group of `/api/search` (routes/search.ts):
// the request span names which app answered how, with how many items, and
// never carries the query or the items themselves.
import assert from "node:assert/strict";
import { asSearchCursor } from "@botiverse/raft-shared";
import { appSearchGroupTraceAttrs } from "./search";

test("a page with items is ok, with its count and whether there is more", () => {
  const attrs = appSearchGroupTraceAttrs("artifacts", { kind: "page", items: [{} as never, {} as never], nextCursor: asSearchCursor("next") }, 12.6);
  assert.deepEqual(attrs, { app: "artifacts", duration_ms: 13, outcome: "ok", item_count: 2, has_more: true });
});

test("a page with no items is empty, not ok", () => {
  const attrs = appSearchGroupTraceAttrs("artifacts", { kind: "page", items: [], nextCursor: null }, 4);
  assert.deepEqual(attrs, { app: "artifacts", duration_ms: 4, outcome: "empty", item_count: 0, has_more: false });
});

test("a timed-out or failed group names its error, with no item count", () => {
  assert.deepEqual(appSearchGroupTraceAttrs("artifacts", { kind: "error", error: "timeout" }, 2500), { app: "artifacts", duration_ms: 2500, outcome: "timeout" });
  assert.deepEqual(appSearchGroupTraceAttrs("artifacts", { kind: "error", error: "failed" }, 30), { app: "artifacts", duration_ms: 30, outcome: "failed" });
});

test("a refused cursor is its own outcome", () => {
  assert.deepEqual(appSearchGroupTraceAttrs("artifacts", { kind: "invalid_cursor" }, 1), { app: "artifacts", duration_ms: 1, outcome: "invalid_cursor" });
});

test("the event carries no query text and no item content", () => {
  const attrs = appSearchGroupTraceAttrs("artifacts", { kind: "page", items: [{ title: "secret plan" } as never], nextCursor: null }, 5);
  assert.ok(!JSON.stringify(attrs).includes("secret plan"));
});
