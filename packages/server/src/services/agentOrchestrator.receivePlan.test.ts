import { test } from "vitest";
import assert from "node:assert/strict";

import { planReceiveAction } from "./agentOrchestrator.js";

test("planReceiveAction returns buffered when messages are already queued", () => {
  assert.equal(
    planReceiveAction({ hasBufferedMessages: true, block: false }),
    "return-buffered",
  );
  assert.equal(
    planReceiveAction({ hasBufferedMessages: true, block: true }),
    "return-buffered",
  );
});

test("planReceiveAction returns empty for non-blocking empty inbox reads", () => {
  assert.equal(
    planReceiveAction({ hasBufferedMessages: false, block: false }),
    "return-empty",
  );
});

test("planReceiveAction installs a waiter for blocking empty inbox reads", () => {
  assert.equal(
    planReceiveAction({ hasBufferedMessages: false, block: true }),
    "install-waiter",
  );
});
