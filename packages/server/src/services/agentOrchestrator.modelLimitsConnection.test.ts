/**
 * task #1357 item 1: model limits reports through the real connection path
 * (`registerMachine`, ready, frames on their sockets). A superseded socket's
 * ready and frames are dropped; each daemon instance writes only its own row;
 * a same-instance reconnect keeps it. Real DB rows (PGlite:
 * one connection, so this interleaves handlers, not concurrent
 * transactions); only Redis is a stand-in, as in
 * agentOrchestrator.readyOwedWake.test.ts.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import { and, eq } from "drizzle-orm";
import { DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1, RUNTIME_CONFIG_VERSION, type ServerToMachineMessage } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentModelLimitsReports, agents, users } from "../db/schema";
import { getAgentModelLimitsWarning } from "./agentModelLimitsService";
import { AgentOrchestrator } from "./agentOrchestrator";
import { registerMachine } from "./machineService";
import type { ReplicaStateStore } from "./replicaStateStore";
import { createServer } from "./serverService";

afterEach(async () => {
  await closeTestDatabase();
});

const store = {
  isAvailable: () => true,
  setReadyOwedWakeAt: async () => {},
  getReadyOwedWakeAt: async () => null,
  registerMachineReplica: async () => "generation-1",
  restoreMachineReplicaGeneration: async () => {},
  unregisterMachineReplica: async () => {},
  refreshMachineReplica: async () => "refreshed",
  hasMachineReplica: async () => true,
  getMachineReplicaOwner: async () => "replica-1",
  bumpMachineStatusVersion: async () => 1,
  getMachineStatusVersion: async () => 1,
  acquireWakeLock: async () => true,
  releaseWakeLock: async () => {},
  setAgentActivity: async () => {},
  getAgentActivity: async () => null,
  getWakeCrashLoopState: async () => null,
  compareAndSetWakeCrashLoopState: async () => true,
  setAgentRuntimeError: async () => {},
  getAgentRuntimeError: async () => null,
  setAgentContextViewAvailability: async () => {},
  getAgentContextViewAvailability: async () => null,
  clearAgentContextViewAvailability: async () => {},
  setMachineMeta: async () => {},
  getMachineMeta: async () => null,
  clearMachineMeta: async () => {},
} as ReplicaStateStore;

class QuietOrchestrator extends AgentOrchestrator {
  protected override async sendToMachine(_machineId: string, _msg: ServerToMachineMessage): Promise<boolean> {
    return true;
  }
}

function fakeWs() {
  return { readyState: 1, OPEN: 1, send: () => {}, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } };
}

const ready = (instance: string) => ({
  type: "ready", runtimes: ["builtin"], runningAgents: [], daemonVersion: "1.0.99", capabilities: [DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1], daemonInstanceId: instance,
}) as never;

const frame = (agentId: string, instance: string, seq: number) => ({
  type: "agent:model_limits", v: 1, agentId, sessionId: "session-1", configRevision: 0, daemonInstanceId: instance, seq, observedAtMs: 1_794_000_000_000,
  runtime: "builtin", modelLimits: { contextWindow: { value: 200_000, source: "raft_default" }, maxTokens: { value: 8192, source: "raft_default" } },
}) as never;

test("superseded socket frames are dropped; each instance writes its own row; a same-instance reconnect keeps it", async ({ db: _db }) => {
  const db = getDb();
  const [user] = await db.insert(users).values({ email: "limits-conn@slock.test", name: "limits-conn", passwordHash: "hash", emailVerified: true }).returning();
  const server = await createServer("Limits Conn", "limits-conn", user!.id);
  const { machine } = await registerMachine(server.id, user!.id, "limits-conn-machine");
  const runtimeConfig = {
    version: RUNTIME_CONFIG_VERSION, runtime: "builtin",
    provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "https://gateway.example.test/v1", apiKey: "k" },
    hostUserState: "forbidden", model: { kind: "custom", name: "acme/custom" }, mode: { kind: "default" },
  } as const;
  const [agent] = await db.insert(agents).values({
    serverId: server.id, name: "limits-conn-agent", machineId: machine.id, status: "active", sessionId: "session-1", runtime: "builtin", model: "acme/custom",
    runtimeConfig: runtimeConfig as never,
  }).returning();
  const row = async (instance: string) => (await db.select().from(agentModelLimitsReports).where(and(
    eq(agentModelLimitsReports.agentId, agent!.id),
    eq(agentModelLimitsReports.daemonInstanceId, instance),
  )))[0];
  const orchestrator = new QuietOrchestrator(store);
  const warning = async () => (await getAgentModelLimitsWarning({ agentId: agent!.id, serverId: server.id, runtimeConfig: runtimeConfig as never }))?.defaultsReported;
  try {
    const wsA = fakeWs();
    await orchestrator.registerMachine(machine.id, server.id, wsA as never);
    await orchestrator.handleMachineMessage(machine.id, ready("inst-1"), wsA as never);
    await orchestrator.handleMachineMessage(machine.id, frame(agent!.id, "inst-1", 1), wsA as never);
    assert.equal((await row("inst-1"))?.seq, 1);
    assert.equal(await warning(), true);

    // The same daemon process reconnects on a new socket: its row stays.
    const wsB = fakeWs();
    await orchestrator.registerMachine(machine.id, server.id, wsB as never);
    await orchestrator.handleMachineMessage(machine.id, ready("inst-1"), wsB as never);
    await orchestrator.handleMachineMessage(machine.id, frame(agent!.id, "inst-1", 2), wsB as never);
    assert.equal((await row("inst-1"))?.seq, 2, "the same instance keeps writing its row");

    // The daemon restarts (inst-2 on socket C); socket B's late ready and frame are dropped.
    const wsC = fakeWs();
    await orchestrator.registerMachine(machine.id, server.id, wsC as never);
    await orchestrator.handleMachineMessage(machine.id, ready("inst-2"), wsC as never);
    await orchestrator.handleMachineMessage(machine.id, ready("inst-1"), wsB as never);
    await orchestrator.handleMachineMessage(machine.id, frame(agent!.id, "inst-1", 3), wsB as never);
    assert.equal((await row("inst-1"))?.seq, 2, "the superseded socket's frame never reached the write");

    await orchestrator.handleMachineMessage(machine.id, frame(agent!.id, "inst-2", 1), wsC as never);
    assert.equal((await row("inst-2"))?.seq, 1);
    assert.equal((await row("inst-1"))?.seq, 2, "inst-2 wrote its own row only");
  } finally {
    await orchestrator.shutdown();
  }
});
