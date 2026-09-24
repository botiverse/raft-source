import assert from "node:assert/strict";
import { test } from "vitest";

import { classifySlackOutboundReconciliation } from "./slackBridgeDatabaseOutboundRuntime.js";

test("outbound caller aborts on every unsafe reconciliation result", () => {
  for (const reason of [
    "reconciliation_rate_limited",
    "reconciliation_page_limit_exceeded",
    "reconciliation_marker_conflict",
  ]) {
    assert.deepEqual(
      classifySlackOutboundReconciliation({ kind: "unavailable", reason }),
      { kind: "abort", reason },
    );
  }
});

test("outbound caller dispatches only on a complete zero-match scan", () => {
  assert.deepEqual(
    classifySlackOutboundReconciliation({ kind: "not_found" }),
    { kind: "dispatch" },
  );
});

test("outbound caller accepts exactly one reconciled provider message", () => {
  assert.deepEqual(
    classifySlackOutboundReconciliation({
      kind: "found",
      providerMessageId: "1753865100.000300",
      providerThreadId: "1753865000.000100",
    }),
    {
      kind: "accept",
      providerMessageId: "1753865100.000300",
      providerThreadId: "1753865000.000100",
    },
  );
});
