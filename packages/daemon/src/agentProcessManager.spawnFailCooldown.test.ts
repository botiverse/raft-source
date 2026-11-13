// task #357 — an active spawn-fail cooldown must always carry a restart
// config. Field (Maggie, 2026-09-29, daemon 1.0.25): `[ReminderCache] onFire
// rejected … Error: active cooldown without restart config`, every wake of
// that agent (reminder, delivery, profile report) rejected until the cooldown
// ran out. Two daemon paths delete the cached restart config while the
// cooldown is still active and nobody re-caches it:
//   1. a start issued from outside the manager's own restart paths (the
//      server's `agent:start`, a manual start) fails after the process record
//      exists: `cleanupFailedRuntimeStart` deletes the snapshot and the core
//      caller only rethrows;
//   2. a silent stop (migration quiesce) deletes the snapshot but, by design,
//      keeps the backoff so stop/start churn cannot bypass the cap.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asAxSurfaceText, type AgentMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import type { RuntimeDriver } from "./drivers/index";
import { promptConfig } from "./testing/promptFixture";
import type { AgentLifecycleRecords, AgentLifecycleRecord } from "./agentLifecycleRecord";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: () => true };
  kill(): boolean {
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, null);
      this.emit("close", 0, null);
    });
    return true;
  }
}

type ManagerInternals = {
  agents: Map<string, { inbox: AgentMessage[] }>;
  lifecycleRecords: AgentLifecycleRecords;
  agentLifecycleRecord(agentId: string): AgentLifecycleRecord<unknown, unknown> | undefined;
  recordSpawnFailure(agentId: string, reason: string): { backoffActive: boolean; attempts: number; untilMs: number };
};
function internals(manager: AgentProcessManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

type Harness = { manager: AgentProcessManager; failSpawn: { value: boolean }; spawns: { count: number } };

async function withManager(run: (h: Harness) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-spawnfail-cooldown-test-"));
  const failSpawn = { value: false };
  const spawns = { count: 0 };
  const driver: RuntimeDriver = {
    id: "prompt-test",
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    session: { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const,
    model: { detectedModelsVerifiedAs: "suggestion_only" },
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    supportsNativeStandingPrompt: true,
    buildSystemPrompt: () => asAxSurfaceText("standing"),
    spawn: () => {
      spawns.count += 1;
      if (failSpawn.value) throw new Error("synthetic spawn failure (task #357)");
      return { process: new FakeChild() as unknown as ChildProcess };
    },
    parseLine: () => [],
    encodeStdinMessage: (text) => text,
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      return Response.json({ apiKey: "sk_agent_prompt_test", credentialId: "prompt-test" }, { status: 201 });
    }
    if (url.includes("/internal/computer/runners/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  setDaemonFetchImplForTests(fetch as never);
  const manager = new AgentProcessManager(() => {}, "sk_machine_test", {
    dataDir, slockHome: dataDir, runtimeSessionHomeDir: dataDir,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test",
    serverUrl: "https://raft.example.test", driverResolver: () => driver,
  });
  try {
    await run({ manager, failSpawn, spawns });
  } finally {
    await drainAgentManagerForTests(manager);
    try {
      await manager.stopAll();
    } finally {
      fetch.mockRestore();
      setDaemonFetchImplForTests(undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

/** Put `agentId` into the real cooldown residency: idle restart config cached, one spawn failure recorded. */
function enterCooldown(manager: AgentProcessManager, agentId: string) {
  const m = internals(manager);
  const config = promptConfig({ name: agentId, displayName: agentId });
  m.lifecycleRecords.setRestartSnapshot(agentId, { config, sessionId: null, launchId: "", processInstanceId: `${agentId}-pi` });
  const report = m.recordSpawnFailure(agentId, "spawn_error");
  expect(report.backoffActive, "generic spawn failures enter cooldown immediately").toBe(true);
  expect(m.agentLifecycleRecord(agentId)?.kind).toBe("cooldown");
  return config;
}

test("a start that fails during an active cooldown leaves the agent readable and restartable (server agent:start path)", async () => {
  await withManager(async ({ manager, failSpawn, spawns }) => {
    const agentId = "cooldown-start-fails";
    const config = enterCooldown(manager, agentId);
    failSpawn.value = true;
    // The core's agent:start handler calls startAgent and only rethrows; it
    // never re-caches the restart config the failed-start cleanup deleted.
    await expect(manager.startAgent(agentId, config)).rejects.toThrow();
    const m = internals(manager);
    expect(m.agents.has(agentId)).toBe(false);
    // The cooldown is still active (clock has not moved past untilMs)…
    expect(m.lifecycleRecords.getSpawnFailBackoff(agentId)).toBeTruthy();
    // …so the agent's record must still be buildable: this is the line every
    // reminder / delivery / profile report for the agent goes through.
    const record = m.agentLifecycleRecord(agentId);
    expect(record?.kind).toBe("cooldown");
    // and a delivery during the cooldown is buffered, not rejected.
    const delivered = await manager.deliverMessage(agentId, {
      channel_id: "channel-1", channel_name: "general", channel_type: "channel",
      sender_id: "user-1", sender_name: "richard", sender_type: "human",
      content: "wake during cooldown", timestamp: "2026-09-29T04:34:12.000Z",
      message_id: "m-1", seq: 1,
    });
    expect(delivered).toBe(true);
    // When the cooldown ends, the daemon restarts the agent exactly once from
    // the re-cached config (the buffered delivery is its wake), and the
    // successful spawn resets the backoff.
    failSpawn.value = false;
    const spawnsBefore = spawns.count;
    const deadline = Date.now() + 4_000;
    while (!m.agents.has(agentId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(m.agents.has(agentId), "restarted from the re-cached config after the cooldown").toBe(true);
    expect(spawns.count - spawnsBefore).toBe(1);
    expect(m.lifecycleRecords.getSpawnFailBackoff(agentId)).toBeUndefined();
  });
}, 10_000);

test("a silent stop during an active cooldown leaves the agent readable (migration quiesce path)", async () => {
  await withManager(async ({ manager }) => {
    const agentId = "cooldown-silent-stop";
    enterCooldown(manager, agentId);
    await manager.stopAgent(agentId, { wait: true, silent: true });
    const m = internals(manager);
    // No process and no restart config: the backoff is dropped and the agent
    // reads as idle without a restart config (Server-owned wake); never an
    // exception, never a cooldown with nothing to restart.
    expect(m.lifecycleRecords.getSpawnFailBackoff(agentId)).toBeUndefined();
    expect(m.lifecycleRecords.getRestartSnapshot(agentId)).toBeUndefined();
    expect(m.agentLifecycleRecord(agentId)).toBeUndefined();
  });
});

test("task #365: a stale launch refused during an active cooldown is a refusal: the backoff is dropped, nothing is re-cached to restart", async () => {
  await withManager(async ({ manager }) => {
    const agentId = "cooldown-stale-launch";
    const config = enterCooldown(manager, agentId);
    // The server claimed this automatic start against connection A; the daemon is now on B.
    manager.setServerStartContext({ spawnErrorCapable: true, connectionEpochId: "epoch-B" });
    await expect(
      manager.startAgent(agentId, config, undefined, undefined, undefined, "launch-stale", false, undefined, undefined, null, undefined, null, "epoch-A"),
    ).rejects.toThrow(/earlier connection/);
    const m = internals(manager);
    expect(m.lifecycleRecords.getSpawnFailBackoff(agentId)).toBeUndefined();
    expect(m.lifecycleRecords.getRestartSnapshot(agentId)).toBeUndefined();
    expect(m.agentLifecycleRecord(agentId)).toBeUndefined();
  });
});
