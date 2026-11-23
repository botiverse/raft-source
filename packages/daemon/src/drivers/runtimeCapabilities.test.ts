import assert from "node:assert/strict";
import { getRuntimeRaftCapabilities, RUNTIMES, RUNTIMES_WITH_SUBAGENTS } from "@botiverse/raft-shared";
import type { RuntimeRaftCapabilities } from "@botiverse/raft-shared";
import type { OarLaunch } from "../agentHost/oarLaunch";
import { antigravityOarLaunch } from "../agentHost/oarAntigravityLaunch";
import { codexOarLaunch } from "../agentHost/oarCodexLaunch";
import { OAR_HOSTED_RUNTIMES } from "../agentHost/oarAgentHost";
import { oarOnlyLaunch } from "../agentHost/oarOnlyLaunch";
import { oarInstalledSessionCapabilities } from "../oarLoader";
import { dshRuntime } from "@botiverse/oar/runtimes/dsh";
import { qoderRuntime } from "@botiverse/oar/runtimes/qoder";
import { qwenRuntime } from "@botiverse/oar/runtimes/qwen";
import { getDriver, isOarOnlyRuntimeId, registeredRuntimeIds } from "./index";
import type { SpawnContext } from "./types";

// The runtime pickers tell people what a runtime lacks in Raft from the shared
// catalog's RUNTIME_RAFT_CAPABILITIES (web runtimeCapabilityHint.ts). This
// keeps that catalog equal to what the daemon declares for the host each
// runtime runs on by default, so a driver change cannot leave the hint wrong.

/**
 * Runtimes whose default host is the OAR host rather than their legacy driver:
 * the OAR-only ones (including Codex after its legacy driver was retired), and
 * Antigravity (`agent_runtime_oar_antigravity` has been on for every server
 * since 2026-11-13).
 */
const OAR_DEFAULT_RUNTIME_IDS = new Set(["antigravity", "codex", "qwen", "qoder", "dsh"]);

/**
 * Runtimes that start sub-agents without declaring `supportsSubagents` (that
 * flag means "render the delegation section of the standing prompt"): Kimi
 * Code reports them from its own `subagent.*` events (drivers/kimi-sdk.ts),
 * Qwen Code and Qoder as OAR tasks of type `agent` (agentHost/oarTaskActivity.ts).
 * Add a runtime here only with the code that reports its sub-agents.
 */
const SUBAGENTS_FROM_EVENTS = new Map<string, "own_events" | "oar_tasks">([
  ["kimi-sdk", "own_events"],
  ["qwen", "oar_tasks"],
  ["qoder", "oar_tasks"],
]);

const ctx = (runtime: string): SpawnContext => ({
  agentId: "agent-1",
  config: {
    name: "a", displayName: null, description: null, model: "default", runtime, reasoningEffort: null,
    envVars: null, sessionId: null, serverUrl: "http://localhost:3001", authToken: "",
  },
  standingPrompt: "standing instructions",
  prompt: "first input",
  workingDirectory: "/work/agent-1",
} as SpawnContext);

function defaultOarLaunch(runtimeId: string): OarLaunch {
  if (runtimeId === "antigravity") return antigravityOarLaunch(ctx(runtimeId), { command: "/bin/agy", env: {} }, {});
  if (runtimeId === "codex") {
    return codexOarLaunch(ctx(runtimeId), {
      command: "/bin/codex",
      args: ["app-server", "--listen", "stdio://"],
      appServerArgs: ["app-server", "--listen", "stdio://"],
      spawnEnv: {},
      appServerEnv: {},
      windowsShim: undefined,
      managedMcp: null,
    }, {});
  }
  if (isOarOnlyRuntimeId(runtimeId)) {
    const installation = { kind: "available", via: "executable", command: `/bin/${runtimeId}` } as const;
    // OAR's real capability answer decides busy delivery (oarOnlyLaunchPolicy).
    const caps = oarInstalledSessionCapabilities({ qwen: qwenRuntime, qoder: qoderRuntime, dsh: dshRuntime }[runtimeId], installation);
    return oarOnlyLaunch(runtimeId, ctx(runtimeId), {}, installation, caps, {});
  }
  throw new Error(`No default OAR launch for ${runtimeId}`);
}

function declaredCapabilities(runtimeId: string): RuntimeRaftCapabilities {
  const driver = getDriver(runtimeId);
  const onOar = OAR_DEFAULT_RUNTIME_IDS.has(runtimeId);
  return {
    midTurnSteering: onOar ? defaultOarLaunch(runtimeId).busyDelivery === "now" : driver.busyDeliveryMode !== "none",
    subagents: driver.supportsSubagents === true || SUBAGENTS_FROM_EVENTS.has(runtimeId),
    // The OAR host plans with the driver's compaction declaration too (oarAgentHost.ts).
    compactionReported: driver.session.compaction === "reported",
  };
}

test("every runtime the daemon runs, and every runtime in the shared catalog, has Raft capabilities", () => {
  for (const runtimeId of registeredRuntimeIds()) {
    assert.ok(getRuntimeRaftCapabilities(runtimeId), runtimeId);
  }
  for (const runtime of RUNTIMES) {
    assert.ok(getRuntimeRaftCapabilities(runtime.id), runtime.id);
  }
});

test("the shared catalog's Raft capabilities are what the daemon declares for each runtime's default host", () => {
  for (const runtimeId of registeredRuntimeIds()) {
    assert.deepEqual(getRuntimeRaftCapabilities(runtimeId), declaredCapabilities(runtimeId), runtimeId);
  }
});

test("the runtimes whose default host is OAR are hosted there, and the sub-agent sources are real", () => {
  for (const runtimeId of OAR_DEFAULT_RUNTIME_IDS) assert.ok(OAR_HOSTED_RUNTIMES.has(runtimeId), runtimeId);
  // An OAR-only runtime has no other host: missing here, it would be checked against its placeholder driver.
  for (const { id } of RUNTIMES) if (isOarOnlyRuntimeId(id)) assert.ok(OAR_DEFAULT_RUNTIME_IDS.has(id), `${id} is OAR-only`);
  for (const [runtimeId, source] of SUBAGENTS_FROM_EVENTS) {
    if (source === "oar_tasks") assert.ok(isOarOnlyRuntimeId(runtimeId), `${runtimeId} reports sub-agents only on its default OAR host`);
  }
  // Activity's Sub-agents view reads the same flag.
  assert.deepEqual(
    [...RUNTIMES_WITH_SUBAGENTS].sort(),
    registeredRuntimeIds().filter((runtimeId) => declaredCapabilities(runtimeId).subagents).sort(),
  );
});
