import assert from "node:assert/strict";
import test from "node:test";
import { createSyncHarnessPrng, createSyncViolationBuffer } from "./index.js";

// sync-core moved to its own workspace package; this pins the compatibility
// re-export so existing `@botiverse/raft-shared` consumers do not silently break.
test("sync-core APIs remain re-exported from the shared package root", () => {
  const buffer = createSyncViolationBuffer({ capacity: 1 });
  const record = buffer.push({ kind: "stale_flood", domain: "messages", scopeId: "channel-1" });

  assert.equal(record.index, 0);
  assert.deepEqual(buffer.drain(), { records: [record], droppedCount: 0, nextIndex: 1 });
  assert.equal(createSyncHarnessPrng(1)(), createSyncHarnessPrng(1)());
});
