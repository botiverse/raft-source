import assert from "node:assert/strict";
import { DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY } from "@botiverse/raft-shared";

import {
  runtimeAccountUsageIntervalMs,
  runtimeAccountUsageProvidersForRuntimes,
} from "./agentOrchestrator";

test("scheduled usage collection selects only installed supported providers and dedupes Kimi aliases", () => {
  assert.deepEqual(
    runtimeAccountUsageProvidersForRuntimes(["claude", "codex", "kimi", "kimi-sdk", "pi", "claude", "grok", "antigravity"], [DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY]),
    ["claude", "codex", "kimi", "grok", "antigravity"],
  );
  assert.deepEqual(runtimeAccountUsageProvidersForRuntimes(["pi", "cursor"], []), []);
});

test("Antigravity's usage is read only on a Computer whose daemon advertises it reads it", () => {
  assert.deepEqual(runtimeAccountUsageProvidersForRuntimes(["claude", "antigravity"], []), ["claude"], "an older Computer: never asked");
  assert.deepEqual(runtimeAccountUsageProvidersForRuntimes(["antigravity"], new Set([DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY])), ["antigravity"]);
});

test("scheduled usage collection uses stable 15-17 minute machine jitter", () => {
  const first = runtimeAccountUsageIntervalMs("machine-a");
  assert.equal(first, runtimeAccountUsageIntervalMs("machine-a"));
  assert.ok(first >= 15 * 60_000);
  assert.ok(first < 17 * 60_000);
});
