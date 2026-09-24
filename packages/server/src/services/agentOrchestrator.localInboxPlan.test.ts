import { test } from "vitest";
import assert from "node:assert/strict";

import { planLocalInboxEnqueueAction } from "./agentOrchestrator.js";

test("planLocalInboxEnqueueAction enqueues when neither seq nor messageId is duplicated", () => {
  assert.equal(
    planLocalInboxEnqueueAction({
      hasSeqDuplicate: false,
      hasMessageIdDuplicate: false,
    }),
    "enqueue",
  );
});

test("planLocalInboxEnqueueAction skips a duplicate when seq already exists", () => {
  assert.equal(
    planLocalInboxEnqueueAction({
      hasSeqDuplicate: true,
      hasMessageIdDuplicate: false,
    }),
    "skip-duplicate",
  );
});

test("planLocalInboxEnqueueAction skips a duplicate when seq-less messageId already exists", () => {
  assert.equal(
    planLocalInboxEnqueueAction({
      hasSeqDuplicate: false,
      hasMessageIdDuplicate: true,
    }),
    "skip-duplicate",
  );
});
