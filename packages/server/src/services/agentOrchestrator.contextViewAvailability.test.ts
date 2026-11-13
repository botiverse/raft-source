/**
 * View Context: the daemon's `agent:context_view_availability` report is kept
 * per agent with the Computer that sent it, only from a Computer that
 * advertised `agent-context-view:v0` and only for an agent on it. Real DB rows
 * and the real handler; the machine socket and the replica store are stubbed.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import {
  AGENT_CONTEXT_VIEW_AVAILABILITY_TYPE,
  DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0,
  type MachineToServerMessage,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, machines, serverMembers, servers, users } from "../db/schema";
import { parseAgentContextViewAvailabilityRecord } from "../replicaRouter";
import { AgentOrchestrator } from "./agentOrchestrator";
import { redisReplicaStateStore, type AgentContextViewAvailabilityRecord, type ReplicaStateStore } from "./replicaStateStore";

afterEach(async () => {
  await closeTestDatabase();
});

async function seed(slug: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}@example.com`,
    name: `Ctx Owner ${slug}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Ctx", slug, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine, otherMachine] = await db.insert(machines).values([
    { serverId: server!.id, userId: owner!.id, name: "ctx-mac", apiKeyHash: `hash-${slug}` },
    { serverId: server!.id, userId: owner!.id, name: "ctx-other", apiKeyHash: `hash-${slug}-other` },
  ]).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "ctx-agent",
    status: "inactive",
    runtime: "claude",
    model: "sonnet",
    executionMode: "byoc",
    machineId: machine!.id,
  }).returning();
  return { server: server!, machine: machine!, otherMachine: otherMachine!, agent: agent! };
}

function setup(options: { failWrites?: boolean } = {}) {
  const writes: Array<{ agentId: string; record: AgentContextViewAvailabilityRecord }> = [];
  let attempts = 0;
  const store: ReplicaStateStore = {
    ...redisReplicaStateStore,
    setAgentContextViewAvailability: async (agentId, record) => {
      attempts += 1;
      if (options.failWrites) throw new Error("redis down");
      writes.push({ agentId, record });
    },
  };
  return { orchestrator: new AgentOrchestrator(store), writes, attempts: () => attempts };
}

function bindMachine(orchestrator: AgentOrchestrator, machineId: string, serverId: string, capabilities: string[]): void {
  (orchestrator as any).machineConnections.set(machineId, {
    ws: {},
    machineId,
    serverId,
    principalKind: "computer",
    connectionEpochId: `epoch-${machineId}`,
    heartbeatTimer: null,
    runtimeAccountUsageTimer: null,
    lastPong: Date.now(),
    lastIngressAt: Date.now(),
    daemonVersion: "1.0.60",
    capabilities: new Set<string>(capabilities),
    runtimes: ["claude"],
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: "1.0.60",
  });
}

function report(agentId: string, overrides: Record<string, unknown> = {}): MachineToServerMessage {
  return {
    type: AGENT_CONTEXT_VIEW_AVAILABILITY_TYPE,
    agentId,
    runtime: "claude",
    supported: true,
    retainedSince: "2026-10-01T00:00:00.000Z",
    retentionDays: 14,
    ...overrides,
  } as unknown as MachineToServerMessage;
}

test("a valid report from the agent's capable Computer is stored with that Computer", async ({ db: _db }) => {
  const { server, machine, agent } = await seed("ctxv-valid");
  const { orchestrator, writes } = setup();
  try {
    bindMachine(orchestrator, machine.id, server.id, [DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0]);
    await orchestrator.handleMachineMessage(machine.id, report(agent.id));
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.agentId, agent.id);
    assert.equal(writes[0]!.record.machineId, machine.id);
    assert.deepEqual(writes[0]!.record.report, {
      agentId: agent.id,
      runtime: "claude",
      supported: true,
      retainedSince: "2026-10-01T00:00:00.000Z",
      retentionDays: 14,
    });
    assert.ok(!Number.isNaN(Date.parse(writes[0]!.record.receivedAt)));
  } finally {
    await orchestrator.shutdown();
  }
});

test("a malformed report is dropped", async ({ db: _db }) => {
  const { server, machine, agent } = await seed("ctxv-invalid");
  const { orchestrator, writes } = setup();
  try {
    bindMachine(orchestrator, machine.id, server.id, [DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0]);
    await orchestrator.handleMachineMessage(machine.id, report(agent.id, { supported: "yes" }));
    await orchestrator.handleMachineMessage(machine.id, report(agent.id, { retainedSince: "yesterday" }));
    await orchestrator.handleMachineMessage(machine.id, report("", {}));
    assert.deepEqual(writes, []);
  } finally {
    await orchestrator.shutdown();
  }
});

test("a report for an agent that is not on this Computer is dropped", async ({ db: _db }) => {
  const { server, otherMachine, agent } = await seed("ctxv-elsewhere");
  const { orchestrator, writes } = setup();
  try {
    bindMachine(orchestrator, otherMachine.id, server.id, [DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0]);
    await orchestrator.handleMachineMessage(otherMachine.id, report(agent.id));
    assert.deepEqual(writes, []);
  } finally {
    await orchestrator.shutdown();
  }
});

test("a report from a Computer that did not advertise the capability is dropped", async ({ db: _db }) => {
  const { server, machine, agent } = await seed("ctxv-nocap");
  const { orchestrator, writes } = setup();
  try {
    bindMachine(orchestrator, machine.id, server.id, []);
    await orchestrator.handleMachineMessage(machine.id, report(agent.id));
    assert.deepEqual(writes, []);
  } finally {
    await orchestrator.shutdown();
  }
});

test("a store failure does not escape the handler", async ({ db: _db }) => {
  const { server, machine, agent } = await seed("ctxv-storefail");
  const { orchestrator, attempts } = setup({ failWrites: true });
  try {
    bindMachine(orchestrator, machine.id, server.id, [DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0]);
    await orchestrator.handleMachineMessage(machine.id, report(agent.id));
    assert.equal(attempts(), 1);
  } finally {
    await orchestrator.shutdown();
  }
});

test("a stored record reads back re-validated; malformed JSON or report reads as none", () => {
  const record: AgentContextViewAvailabilityRecord = {
    machineId: "machine-1",
    report: { agentId: "agent-1", runtime: "codex", supported: false, unsupportedReason: "unsupported_runtime", retainedSince: null },
    receivedAt: "2026-11-04T00:00:00.000Z",
  };
  assert.deepEqual(parseAgentContextViewAvailabilityRecord(JSON.stringify(record)), record);
  assert.equal(parseAgentContextViewAvailabilityRecord("{not json"), null);
  assert.equal(parseAgentContextViewAvailabilityRecord(null), null);
  assert.equal(parseAgentContextViewAvailabilityRecord(JSON.stringify({ ...record, machineId: "" })), null);
  assert.equal(parseAgentContextViewAvailabilityRecord(JSON.stringify({ ...record, report: { ...record.report, supported: "no" } })), null);
});

test("on a replica without the Computer's socket, the capability comes from the owner's mirrored ready facts", async () => {
  const { orchestrator } = setup();
  const facts = new Map<string, string[] | null>([
    ["machine-fresh", [DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0]],
    ["machine-other", ["something-else"]],
    ["machine-stale", null],
  ]);
  (orchestrator as any).readProbeCarrierFact = async (machineId: string) => {
    const capabilities = facts.get(machineId);
    return capabilities ? { capabilities } : null;
  };
  try {
    assert.equal(await orchestrator.machineAdvertisesCapability("machine-fresh", DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0), true);
    assert.equal(await orchestrator.machineAdvertisesCapability("machine-other", DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0), false);
    assert.equal(await orchestrator.machineAdvertisesCapability("machine-stale", DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0), false);
  } finally {
    await orchestrator.shutdown();
  }
});

test("forgetting a deleted agent clears its stored report", async () => {
  const cleared: string[] = [];
  const store: ReplicaStateStore = {
    ...redisReplicaStateStore,
    clearAgentContextViewAvailability: async (agentId) => {
      cleared.push(agentId);
    },
  };
  const orchestrator = new AgentOrchestrator(store);
  try {
    orchestrator.forgetAgentActivity("agent-gone");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cleared, ["agent-gone"]);
  } finally {
    await orchestrator.shutdown();
  }
});
