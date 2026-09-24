import assert from "node:assert/strict";
import { test } from "vitest";

import {
  runtimeAccountUsageIntervalMs,
  runtimeAccountUsageProvidersForScheduledCollection,
  runtimeAccountUsageProvidersForRuntimes,
} from "./agentOrchestrator.js";

test("scheduled usage collection selects only installed supported providers and dedupes Kimi aliases", () => {
  assert.deepEqual(
    runtimeAccountUsageProvidersForRuntimes(["claude", "codex", "kimi", "kimi-sdk", "pi", "claude", "grok"]),
    ["claude", "codex", "kimi", "grok"],
  );
  assert.deepEqual(runtimeAccountUsageProvidersForRuntimes(["pi", "cursor"]), []);
});

test("scheduled usage collection fails closed while the server gate is off", () => {
  assert.deepEqual(
    runtimeAccountUsageProvidersForScheduledCollection(["claude", "codex", "kimi", "grok"], false),
    [],
  );
  assert.deepEqual(
    runtimeAccountUsageProvidersForScheduledCollection(["claude", "codex", "kimi", "grok"], true),
    ["claude", "codex", "kimi", "grok"],
  );
});

test("scheduled usage collection uses stable 15-17 minute machine jitter", () => {
  const first = runtimeAccountUsageIntervalMs("machine-a");
  assert.equal(first, runtimeAccountUsageIntervalMs("machine-a"));
  assert.ok(first >= 15 * 60_000);
  assert.ok(first < 17 * 60_000);
});
