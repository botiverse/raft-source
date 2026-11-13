/**
 * Reconciler step 14, PR 1, end to end on the server: daemon `agent:status`
 * and `agent:session` frames through `handleMachineMessage` into the real
 * agent row (PGlite). Another replica moved the agent to Computer B (a direct
 * write: this orchestrator's cache is not told); this orchestrator still
 * holds Computer A's socket and a cache that places the agent on A, so the
 * old process's frames pass the cached machine and launch checks. The SQL
 * Machine fence is what keeps them off the row. Only the socket is stubbed.
 */
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import type { MachineToServerMessage } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, machines, notificationEvents, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import { createServer } from "./serverService";

const test = createApiTest();

class SocketStubOrchestrator extends AgentOrchestrator {
  readonly emitted: Array<{ event: string; payload: unknown }> = [];

  bind(machineId: string, serverId: string): void {
    (this as any).machineConnections.set(machineId, {
      ws: { readyState: 1, send: () => undefined },
      daemonInstanceId: "inst-1",
      machineId,
      serverId,
      principalKind: "computer",
      connectionEpochId: `epoch-${machineId}`,
      replicaGeneration: "1",
      heartbeatTimer: null,
      runtimeAccountUsageTimer: null,
      lastPong: Date.now(),
      lastIngressAt: Date.now(),
      daemonVersion: "1.0.99",
      capabilities: new Set<string>(),
      readyCapabilitiesKnown: true,
      runtimes: ["codex"],
      migrationTransport: null,
      shutdownIntent: null,
      computerVersion: "1.0.99",
    });
    const target = {
      except: () => target,
      emit: (event: string, payload: unknown) => { this.emitted.push({ event, payload }); },
    };
    (this as any).io = { to: () => target };
  }

  /** What this replica's cache says about the agent (loads it on a miss). */
  async cachedMachineId(agentId: string): Promise<string | null | undefined> {
    return (await (this as any).getCachedAgent(agentId))?.machineId;
  }

  /**
   * The wake lock lives in the replica state store, shared across replicas by
   * agent id (Redis; without Redis an acquire always succeeds, so the test
   * records the releases instead).
   */
  readonly wakeLockReleases: string[] = [];
  recordWakeLockReleases(): void {
    const release = (this as any).releaseWakeLock.bind(this);
    (this as any).releaseWakeLock = (agentId: string) => {
      this.wakeLockReleases.push(agentId);
      release(agentId);
    };
  }

  isCached(agentId: string): boolean {
    return (this as any).agentStateCache.has(agentId);
  }
}

async function seed() {
  const slug = `fence-${randomUUID().slice(0, 8)}`;
  const [owner] = await getDb().insert(users).values({
    email: `${slug}@slock.test`,
    name: slug,
    displayName: slug,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Machine fence", slug, owner!.id);
  const [a, b] = await getDb().insert(machines).values([
    { serverId: server.id, userId: owner!.id, name: "computer-a", apiKeyHash: `a-${slug}` },
    { serverId: server.id, userId: owner!.id, name: "computer-b", apiKeyHash: `b-${slug}` },
  ]).returning();
  const [agent] = await getDb().insert(agents).values({
    serverId: server.id,
    name: "fence-agent",
    status: "active",
    runtime: "codex",
    model: "gpt-5",
    executionMode: "byoc",
    machineId: a!.id,
    sessionId: "session-a",
    creatorType: "user",
    creatorId: owner!.id,
  }).returning();
  const orchestrator = new SocketStubOrchestrator();
  orchestrator.bind(a!.id, server.id);
  return { server, a: a!, b: b!, agent: agent!, orchestrator };
}

/** Another replica's move: the row changes, this replica's cache does not. */
async function moveOnAnotherReplica(agentId: string, machineId: string, sessionId: string | null) {
  await getDb().update(agents).set({ machineId, sessionId }).where(eq(agents.id, agentId));
}

async function row(agentId: string) {
  const [found] = await getDb().select({ status: agents.status, sessionId: agents.sessionId, machineId: agents.machineId })
    .from(agents).where(eq(agents.id, agentId)).limit(1);
  return found!;
}

async function statusChangedEvents(agentId: string) {
  const events = await getDb().select().from(notificationEvents).where(eq(notificationEvents.subjectId, agentId));
  return events.filter((event) => event.eventType === "agent.status_changed").length;
}

test("a stale replica cache cannot let the old Computer's exit mark the moved agent inactive", async ({ app: _app }) => {
  const { a, b, agent, orchestrator } = await seed();
  try {
    assert.equal(await orchestrator.cachedMachineId(agent.id), a.id, "this replica caches the agent on A");
    await moveOnAnotherReplica(agent.id, b.id, "session-b");
    const eventsBefore = await statusChangedEvents(agent.id);

    await orchestrator.handleMachineMessage(a.id, {
      type: "agent:status",
      agentId: agent.id,
      status: "inactive",
    } as MachineToServerMessage);

    assert.deepEqual(await row(agent.id), { status: "active", sessionId: "session-b", machineId: b.id });
    assert.equal(await statusChangedEvents(agent.id), eventsBefore, "no status notification");
    assert.deepEqual(orchestrator.emitted.map((entry) => entry.event), [], "no broadcast");
    assert.equal(orchestrator.isCached(agent.id), false, "the stale entry is evicted");
    assert.equal(await orchestrator.cachedMachineId(agent.id), b.id, "the reload follows the row");
  } finally {
    orchestrator.shutdown();
  }
});

test("a stale replica cache cannot let the old Computer's session report overwrite the moved agent's sessionId", async ({ app: _app }) => {
  const { a, b, agent, orchestrator } = await seed();
  try {
    await getDb().update(agents).set({ status: "inactive" }).where(eq(agents.id, agent.id));
    assert.equal(await orchestrator.cachedMachineId(agent.id), a.id);
    await moveOnAnotherReplica(agent.id, b.id, null);

    await orchestrator.handleMachineMessage(a.id, {
      type: "agent:session",
      agentId: agent.id,
      sessionId: "session-late-a",
    } as MachineToServerMessage);

    assert.deepEqual(await row(agent.id), { status: "inactive", sessionId: null, machineId: b.id });
    assert.deepEqual(orchestrator.emitted.map((entry) => entry.event), [], "no agent:session broadcast");
    assert.equal(orchestrator.isCached(agent.id), false);
  } finally {
    orchestrator.shutdown();
  }
});

test("status and session frames from the agent's own Computer still write the row", async ({ app: _app }) => {
  const { server, b, agent, orchestrator } = await seed();
  try {
    await moveOnAnotherReplica(agent.id, b.id, null);
    orchestrator.bind(b.id, server.id);
    assert.equal(await orchestrator.cachedMachineId(agent.id), b.id);

    await orchestrator.handleMachineMessage(b.id, {
      type: "agent:status",
      agentId: agent.id,
      status: "inactive",
    } as MachineToServerMessage);
    assert.deepEqual(await row(agent.id), { status: "inactive", sessionId: null, machineId: b.id });

    await orchestrator.handleMachineMessage(b.id, {
      type: "agent:session",
      agentId: agent.id,
      sessionId: "session-b",
    } as MachineToServerMessage);
    assert.deepEqual(await row(agent.id), { status: "active", sessionId: "session-b", machineId: b.id });
    assert.equal(orchestrator.emitted.some((entry) => entry.event === "agent:session"), true);
  } finally {
    orchestrator.shutdown();
  }
});

test("a fenced exit from the old Computer leaves the new Computer's wake lock held", async ({ app: _app }) => {
  const { a, b, agent, orchestrator } = await seed();
  try {
    assert.equal(await orchestrator.cachedMachineId(agent.id), a.id);
    await moveOnAnotherReplica(agent.id, b.id, null);
    orchestrator.recordWakeLockReleases();

    await orchestrator.handleMachineMessage(a.id, {
      type: "agent:status",
      agentId: agent.id,
      status: "inactive",
    } as MachineToServerMessage);

    assert.deepEqual(orchestrator.wakeLockReleases, [], "the shared wake lock (held by the new Computer's wake) is not released");
  } finally {
    orchestrator.shutdown();
  }
});

test("an exit from the agent's own Computer still releases the wake lock", async ({ app: _app }) => {
  const { server, b, agent, orchestrator } = await seed();
  try {
    await moveOnAnotherReplica(agent.id, b.id, null);
    orchestrator.recordWakeLockReleases();
    orchestrator.bind(b.id, server.id);
    assert.equal(await orchestrator.cachedMachineId(agent.id), b.id);

    await orchestrator.handleMachineMessage(b.id, {
      type: "agent:status",
      agentId: agent.id,
      status: "inactive",
    } as MachineToServerMessage);

    assert.deepEqual(orchestrator.wakeLockReleases, [agent.id], "the real exit releases the lock");
  } finally {
    orchestrator.shutdown();
  }
});
