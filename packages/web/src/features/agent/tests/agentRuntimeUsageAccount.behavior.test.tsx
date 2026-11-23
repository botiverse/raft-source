import assert from "node:assert/strict";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { RuntimeAccountUsageSnapshot } from "@botiverse/raft-shared";

import { summarizeRuntimeUsage } from "../../../components/machine/bulkChangeModelPlan";
import { useRuntimeUsageWindows } from "../../../hooks/useRuntimeUsageWindows";
import { RUNTIME_USAGE_REQUEST_HEADERS, RuntimeAccountUsageClient } from "../../../utils/runtimeAccountUsageClient";

// Agents on their own Codex account folder (CODEX_HOME): the profile's Usage
// row shows the account read from that folder, never the Computer's default
// account; an agent without one shows the default account only.

afterEach(cleanup);

type Account = RuntimeAccountUsageSnapshot["accounts"][number];
const account = (key: string, usedRatio: number, agentIds?: string[]): Account => ({
  accountKey: key.repeat(64),
  planLabel: `Plan ${key}`,
  health: "ok",
  windows: [{ id: `w_${key}`, label: `Window ${key}`, status: "ok", usedRatio }],
  ...(agentIds ? { agentIds } : {}),
});
const snapshotOf = (accounts: Account[]): RuntimeAccountUsageSnapshot => ({
  protocolVersion: 2,
  provider: "codex",
  collectedAt: "2026-11-18T09:00:00.000Z",
  staleAfter: "2099-11-18T09:30:00.000Z",
  collectorVersion: "test",
  accounts,
});

function windowsFor(snapshot: RuntimeAccountUsageSnapshot, agentId: string | null) {
  const client = new RuntimeAccountUsageClient(
    async () => ({ state: "fresh", snapshot }),
    async () => ({ accepted: false, state: "cooldown" }),
  );
  return renderHook(() => useRuntimeUsageWindows({ enabled: true, serverId: "s1", machineId: "m1", runtimeId: "codex", agentId, client }));
}

test("an agent on its own folder sees its folder's account; another agent the default account; an older Computer every account", async () => {
  const folders = snapshotOf([account("a", 0.1), account("b", 0.5, ["agent-own"])]);
  const own = windowsFor(folders, "agent-own");
  await waitFor(() => assert.deepEqual(own.result.current.map((window) => window.label), ["Window b"]));
  const shared = windowsFor(folders, "agent-shared");
  await waitFor(() => assert.deepEqual(shared.result.current.map((window) => window.label), ["Window a"]));
  const older = windowsFor(snapshotOf([account("a", 0.1), account("b", 0.5)]), "agent-own");
  await waitFor(() => assert.deepEqual(older.result.current.map((window) => window.label), ["Window a", "Window b"]));
});

test("Computer-level summaries read the default account, wherever it sits", () => {
  assert.deepEqual(summarizeRuntimeUsage(snapshotOf([account("b", 0.5, ["agent-own"]), account("a", 0.1)])), { kind: "used", plan: "Plan a", percent: 10 });
});

test("usage requests declare that this build reads agents' account folders", () => {
  assert.match(Object.values(RUNTIME_USAGE_REQUEST_HEADERS).join(","), /runtime-usage-account-folders@1/);
});
