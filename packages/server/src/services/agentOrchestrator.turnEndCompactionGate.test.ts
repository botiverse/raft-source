/**
 * #proj-runtime:#67: `turnEndCompaction` reaches only a daemon that declared
 * DAEMON_CAPABILITY_TURN_END_COMPACTION_V2 in the `ready` of its current
 * connection, through the real connection path (`registerMachine`, `ready`,
 * `server:features:request` on its socket). A reconnect starts without the
 * capability until its own `ready` declares it, so an older daemon taking
 * over the machine (a rollback) stays off in the start config and the
 * refresh alike. The flag-only matrix and mixed daemons on one server are in
 * agentOrchestrator.constructedWakeContext.test.ts. Real DB rows (PGlite);
 * only Redis is a stand-in, as in agentOrchestrator.modelLimitsConnection.test.ts.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { BasicTracer, DAEMON_CAPABILITY_TURN_END_COMPACTION_V2, MemoryTraceSink, type AgentConfig, type ServerToMachineMessage } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import { createFeatureFlag, TURN_END_COMPACTION_FEATURE_FLAG_KEY } from "./featureFlagService";
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

class FeatureCapturingOrchestrator extends AgentOrchestrator {
  readonly featureAnswers: Array<Extract<ServerToMachineMessage, { type: "server:features" }>> = [];

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "server:features") this.featureAnswers.push(msg);
    return true;
  }
}

function fakeWs() {
  return { readyState: 1, OPEN: 1, send: () => {}, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } };
}

const ready = (capabilities: string[]) => ({
  type: "ready", runtimes: ["claude"], runningAgents: [], daemonVersion: "1.0.99", capabilities, daemonInstanceId: `inst-${capabilities.length}`,
}) as never;

test("turn end compaction gate: a reconnect is off until its own ready declares the capability, and an older daemon taking over stays off", async ({ db: _db }) => {
  await createFeatureFlag({ key: TURN_END_COMPACTION_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const db = getDb();
  const [user] = await db.insert(users).values({ email: "tec-gate@slock.test", name: "tec-gate", passwordHash: "hash", emailVerified: true }).returning();
  const server = await createServer("TEC Gate", "tec-gate", user!.id);
  const { machine } = await registerMachine(server.id, user!.id, "tec-gate-machine");
  const [agent] = await db.insert(agents).values({
    serverId: server.id, name: "tec-gate-agent", machineId: machine.id, status: "inactive", runtime: "claude", model: "sonnet", executionMode: "byoc",
  }).returning();
  const sink = new MemoryTraceSink();
  const orchestrator = new FeatureCapturingOrchestrator(store, undefined, new BasicTracer({ sink }));
  const startConfig = async (): Promise<AgentConfig> => {
    const [row] = await db.select().from(agents).where(eq(agents.id, agent!.id));
    return (orchestrator as any).buildAgentConfig(row);
  };
  const askFeatures = async (ws: ReturnType<typeof fakeWs>, requestId: string) => {
    await orchestrator.handleMachineMessage(machine.id, { type: "server:features:request", requestId }, ws as never);
    const answers = orchestrator.featureAnswers.filter((answer) => answer.requestId === requestId);
    assert.equal(answers.length, 1, `one answer to ${requestId}`);
    return answers[0]!.features;
  };
  const gateTraces = () => sink.getAllLogEvents()
    .filter((event) => event.name === "server.agent.turn_end_compaction_gate")
    .map((event) => [event.attrs?.path, event.attrs?.turn_end_compaction_gate]);
  try {
    // A current daemon declares the capability: on in both paths.
    const wsA = fakeWs();
    await orchestrator.registerMachine(machine.id, server.id, wsA as never);
    await orchestrator.handleMachineMessage(machine.id, ready([DAEMON_CAPABILITY_TURN_END_COMPACTION_V2]), wsA as never);
    assert.equal((await askFeatures(wsA, "a")).turnEndCompaction, true);
    assert.equal((await startConfig()).turnEndCompaction, true);

    // The machine reconnects: the new connection carries nothing from the old
    // one, so before its ready the gate is closed.
    const wsB = fakeWs();
    await orchestrator.registerMachine(machine.id, server.id, wsB as never);
    assert.equal("turnEndCompaction" in (await askFeatures(wsB, "b-before-ready")), false);
    assert.equal((await startConfig()).turnEndCompaction, undefined);

    // An older daemon (no capability) is what connected: off in the refresh and the start config.
    await orchestrator.handleMachineMessage(machine.id, ready([]), wsB as never);
    assert.equal("turnEndCompaction" in (await askFeatures(wsB, "b-old")), false, "the refresh cannot bypass the gate");
    assert.equal((await startConfig()).turnEndCompaction, undefined);

    // Upgraded again: the next connection's ready opens it.
    const wsC = fakeWs();
    await orchestrator.registerMachine(machine.id, server.id, wsC as never);
    await orchestrator.handleMachineMessage(machine.id, ready([DAEMON_CAPABILITY_TURN_END_COMPACTION_V2]), wsC as never);
    assert.equal((await askFeatures(wsC, "c")).turnEndCompaction, true);
    assert.equal((await startConfig()).turnEndCompaction, true);

    assert.deepEqual(gateTraces(), [
      ["server_features", "capability_present"],
      ["agent_config", "capability_present"],
      ["server_features", "capability_missing"],
      ["agent_config", "capability_missing"],
      ["server_features", "capability_missing"],
      ["agent_config", "capability_missing"],
      ["server_features", "capability_present"],
      ["agent_config", "capability_present"],
    ]);
  } finally {
    await orchestrator.shutdown();
  }
});

test("turn end compaction gate: with the flag off nothing is traced and nothing is sent, capability or not", async ({ db: _db }) => {
  await createFeatureFlag({ key: TURN_END_COMPACTION_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const db = getDb();
  const [user] = await db.insert(users).values({ email: "tec-gate-off@slock.test", name: "tec-gate-off", passwordHash: "hash", emailVerified: true }).returning();
  const server = await createServer("TEC Gate Off", "tec-gate-off", user!.id);
  const { machine } = await registerMachine(server.id, user!.id, "tec-gate-off-machine");
  const sink = new MemoryTraceSink();
  const orchestrator = new FeatureCapturingOrchestrator(store, undefined, new BasicTracer({ sink }));
  try {
    const ws = fakeWs();
    await orchestrator.registerMachine(machine.id, server.id, ws as never);
    await orchestrator.handleMachineMessage(machine.id, ready([DAEMON_CAPABILITY_TURN_END_COMPACTION_V2]), ws as never);
    await orchestrator.handleMachineMessage(machine.id, { type: "server:features:request", requestId: "off" }, ws as never);
    assert.equal(orchestrator.featureAnswers.length, 1);
    assert.equal("turnEndCompaction" in orchestrator.featureAnswers[0]!.features, false);
    assert.deepEqual(sink.getAllLogEvents().filter((event) => event.name === "server.agent.turn_end_compaction_gate"), []);
  } finally {
    await orchestrator.shutdown();
  }
});
