/**
 * task #1351: a stored BillingError (provider HTTP 402, `billing_exhausted`)
 * drives the agent page's billing banner. It stays through a start, Starting,
 * a session report, `model_request_started` and a manual Stop; only output
 * that proves the provider served a request after it clears it (R1: same
 * daemon process and launch, higher clientSeq; R2: the launch a start armed
 * while it was stored), and that clear removes exactly the occurrence judged.
 * Real DB rows and the real ingest/start/stop paths; only the machine socket
 * and Socket.IO are stubbed.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import type { Server as SocketServer } from "socket.io";

import type { AgentRuntimeErrorState, MachineToServerMessage, ServerToMachineMessage } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, machines, serverMembers, servers, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import { getAgentLastRuntimeError, setAgentLastRuntimeError, stampAgentRuntimeErrorRecoveryLaunch } from "./agentService";
import { eq } from "drizzle-orm";

afterEach(async () => {
  await closeTestDatabase();
});

type Emit = { room: string; event: string; payload: unknown };

function capturingIo(emits: Emit[]): SocketServer {
  const to = (room: string) => {
    const operator = {
      in: to,
      to,
      except: () => operator,
      socketsJoin: () => undefined,
      emit: (event: string, payload: unknown) => {
        emits.push({ room, event, payload });
        return true;
      },
    };
    return operator;
  };
  return { in: to, to } as unknown as SocketServer;
}

class BillingOrchestrator extends AgentOrchestrator {
  readonly starts: Array<Extract<ServerToMachineMessage, { type: "agent:start" }>> = [];
  readonly emits: Emit[] = [];

  constructor() {
    super();
    this.setIO(capturingIo(this.emits));
  }

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start") this.starts.push(msg);
    return true;
  }

  agentUpdated(): number {
    return this.emits.filter((e) => e.event === "agent:updated").length;
  }

  cachedError(agentId: string): AgentRuntimeErrorState | null | undefined {
    return (this as any).agentStateCache.get(agentId)?.lastRuntimeError;
  }
}

async function seed() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "billing-owner@example.com",
    name: "billingowner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Billing", slug: "billing-test", ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: owner!.id,
    name: "billing-box",
    apiKeyHash: "hash-billing",
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "witty",
    status: "inactive",
    runtime: "codex",
    model: "gpt-5",
    executionMode: "byoc",
    machineId: machine!.id,
    creatorType: "user",
    creatorId: owner!.id,
  }).returning();
  return { server: server!, machine: machine!, agent: agent! };
}

function bindMachine(orchestrator: AgentOrchestrator, machineId: string, serverId: string): void {
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
    daemonVersion: "1.0.48",
    capabilities: new Set<string>(),
    runtimes: ["codex"],
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: "1.0.48",
  });
}

type Order = { launchId?: string; daemonInstanceId?: string; clientSeq?: number };

const RAW_402 = "API Error: 402 Insufficient Balance";

function billingFrame(agentId: string, order: Order, detail = RAW_402): MachineToServerMessage {
  return {
    type: "agent:activity",
    agentId,
    ...order,
    activity: "error",
    detail,
    detailKind: "runtime_error",
    isHeartbeat: false,
    runtimeError: { errorClass: "BillingError", errorReason: "billing_exhausted", fingerprint: "b111111111111111", reasonProvenance: "runtime_error_event" },
  } as unknown as MachineToServerMessage;
}

function workingFrame(agentId: string, order: Order, detailKind = "model_response_started", entries: unknown[] = [{ kind: "text", text: "Hello" }]): MachineToServerMessage {
  return {
    type: "agent:activity",
    agentId,
    ...order,
    activity: "working",
    detail: "Writing",
    detailKind,
    entries,
    isHeartbeat: false,
  } as unknown as MachineToServerMessage;
}

async function setup() {
  const { server, machine, agent } = await seed();
  const orchestrator = new BillingOrchestrator();
  bindMachine(orchestrator, machine.id, server.id);
  const send = (msg: MachineToServerMessage) => orchestrator.handleMachineMessage(machine.id, msg);
  return { server, machine, agent, orchestrator, send };
}

const stored = (agentId: string) => getAgentLastRuntimeError(agentId);

test("a stored BillingError survives model_request_started and the session report", async ({ db: _db }) => {
  const { agent, orchestrator, send } = await setup();
  try {
    await send(billingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 10 }));
    const first = await stored(agent.id);
    assert.equal(first?.errorClass, "BillingError");
    assert.ok(first?.occurrenceId, "a stored occurrence has an id");
    assert.deepEqual([first?.launchId, first?.daemonInstanceId, first?.clientSeq], ["launch-1", "daemon-a", 10], "and its set-frame evidence");

    await send(workingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 11 }, "model_request_started"));
    assert.deepEqual(await stored(agent.id), first);
    await send({ type: "agent:session", agentId: agent.id, sessionId: "session-1", launchId: "launch-1" } as MachineToServerMessage);
    assert.deepEqual(await stored(agent.id), first, "a session report is not output");
    assert.equal(orchestrator.agentUpdated(), 0);
  } finally {
    await orchestrator.shutdown();
  }
});

test("R1: output of the 402's own daemon process and launch with a higher seq clears it; seq is not compared across launches or processes", async ({ db: _db }) => {
  const { agent, orchestrator, send } = await setup();
  try {
    // One turn: output, then the 402. The output's late replay changes nothing.
    await send(workingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 9 }));
    await send(billingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 10 }));
    await send(workingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 9 }));
    assert.equal((await stored(agent.id))?.errorClass, "BillingError", "the 402 is what stays");

    await send(workingFrame(agent.id, { launchId: "launch-0", daemonInstanceId: "daemon-a", clientSeq: 99 }));
    assert.equal((await stored(agent.id))?.errorClass, "BillingError", "a higher seq of another launch");
    await send(workingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-b", clientSeq: 99 }));
    assert.equal((await stored(agent.id))?.errorClass, "BillingError", "another daemon process");
    await send(workingFrame(agent.id, { launchId: "launch-1" }));
    assert.equal((await stored(agent.id))?.errorClass, "BillingError", "no evidence");
    // The daemon's empty turn-start thinking / text frames are not output.
    await send(workingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 11 }, "thinking_started", []));
    assert.equal((await stored(agent.id))?.errorClass, "BillingError", "an empty thinking_started");
    await send(workingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 12 }, "model_response_started", [{ kind: "turn_summary", outcome: "completed", text: "earlier turn" }]));
    assert.equal((await stored(agent.id))?.errorClass, "BillingError", "a model_response_started carrying only an earlier turn's summary");
    assert.equal(orchestrator.agentUpdated(), 0);

    await send(workingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 13 }));
    assert.equal(await stored(agent.id), null);
    assert.equal(orchestrator.cachedError(agent.id), null);
    assert.equal(orchestrator.agentUpdated(), 1, "open pages re-read the agent");
  } finally {
    await orchestrator.shutdown();
  }
});

test("a late 402 replay or a 402 from another launch never rewrites newer evidence", async ({ db: _db }) => {
  const { agent, orchestrator, send } = await setup();
  try {
    await send(billingFrame(agent.id, { launchId: "launch-2", daemonInstanceId: "daemon-a", clientSeq: 20 }));
    const current = await stored(agent.id);
    await send(billingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 5 }, `${RAW_402} (old launch)`));
    assert.deepEqual(await stored(agent.id), current, "a 402 from an older, unstamped launch");
    assert.deepEqual(orchestrator.cachedError(agent.id), current);
    // What clients are shown stays the stored occurrence, not the refused 402.
    assert.equal((orchestrator as any).agentActivity.get(agent.id)?.detail, current?.message, "live activity detail");
    assert.deepEqual(await orchestrator.getActivity(agent.id), { activity: "error", activityDetail: current?.message });
    await send(billingFrame(agent.id, { launchId: "launch-2", daemonInstanceId: "daemon-b", clientSeq: 1 }, `${RAW_402} (other process)`));
    assert.deepEqual(await stored(agent.id), current);
    // The same process's next 402 is a new occurrence (no 5-minute merge).
    await send(billingFrame(agent.id, { launchId: "launch-2", daemonInstanceId: "daemon-a", clientSeq: 21 }));
    const next = await stored(agent.id);
    assert.equal(next?.clientSeq, 21);
    assert.notEqual(next?.occurrenceId, current?.occurrenceId);
  } finally {
    await orchestrator.shutdown();
  }
});

test("R2: a launch armed after the 402 recovers it; a launch armed before it does not, and a later 402 does not inherit the stamp", async ({ db: _db }) => {
  const { agent, orchestrator, send } = await setup();
  try {
    // Armed before the 402: the start finds nothing to stamp.
    await orchestrator.startAgent(agent.id);
    const early = orchestrator.starts[0]!.launchId!;
    await send(billingFrame(agent.id, { launchId: early, daemonInstanceId: "daemon-a", clientSeq: 10 }));
    assert.equal((await stored(agent.id))?.recoveryLaunchId, undefined);
    await send(workingFrame(agent.id, { launchId: early }));
    assert.equal((await stored(agent.id))?.errorClass, "BillingError", "the armed launch's own output does not prove it came after its 402");

    // Armed after the 402: stamped, and its first output (no seq evidence) clears it.
    await orchestrator.startAgent(agent.id);
    const late = orchestrator.starts[1]!.launchId!;
    const stampedA = await stored(agent.id);
    assert.equal(stampedA?.recoveryLaunchId, late);
    assert.equal(orchestrator.cachedError(agent.id)?.recoveryLaunchId, late);

    // ...unless that launch hits a new 402 first: B replaces A without the stamp.
    await send(billingFrame(agent.id, { launchId: late, daemonInstanceId: "daemon-a", clientSeq: 30 }));
    const b = await stored(agent.id);
    assert.notEqual(b?.occurrenceId, stampedA?.occurrenceId);
    assert.equal(b?.recoveryLaunchId, undefined, "B does not inherit A's stamp");
    await send(workingFrame(agent.id, { launchId: late }));
    assert.equal((await stored(agent.id))?.occurrenceId, b?.occurrenceId, "L2's output does not clear B by R2");
    assert.equal(orchestrator.agentUpdated(), 0);
    await send(workingFrame(agent.id, { launchId: late, daemonInstanceId: "daemon-a", clientSeq: 31 }));
    assert.equal(await stored(agent.id), null, "R1 does");
    assert.equal(orchestrator.agentUpdated(), 1);

    // A fresh 402, then a start armed after it: R2 clears with no seq at all.
    await send(billingFrame(agent.id, { launchId: late, daemonInstanceId: "daemon-a", clientSeq: 40 }));
    await orchestrator.startAgent(agent.id);
    const third = orchestrator.starts[2]!.launchId!;
    await send(workingFrame(agent.id, { launchId: third }));
    assert.equal(await stored(agent.id), null);
    assert.equal(orchestrator.agentUpdated(), 2);
  } finally {
    await orchestrator.shutdown();
  }
});

test("a manual Stop keeps a BillingError, Start is not blocked, and the new launch's output clears it", async ({ db: _db }) => {
  const { agent, orchestrator, send } = await setup();
  try {
    await send(billingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 10 }));
    const before = await stored(agent.id);
    await orchestrator.stopAgent(agent.id, "manual");
    assert.deepEqual(await stored(agent.id), before, "Stop does not clear a billing error");
    assert.equal(orchestrator.agentUpdated(), 0, "nothing cleared, nothing announced");

    const started = await orchestrator.startAgent(agent.id);
    assert.equal(started.outcome, "dispatched", "a stored BillingError does not block Start");
    const launchId = orchestrator.starts[0]!.launchId!;
    assert.equal((await stored(agent.id))?.recoveryLaunchId, launchId);
    await send(workingFrame(agent.id, { launchId }));
    assert.equal(await stored(agent.id), null);
    assert.equal(orchestrator.agentUpdated(), 1);
  } finally {
    await orchestrator.shutdown();
  }
});

test("a manual Stop still clears another error class and tells open pages; another class replaces a BillingError", async ({ db: _db }) => {
  const { agent, orchestrator, send } = await setup();
  try {
    await send(billingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 10 }));
    await send({
      type: "agent:activity",
      agentId: agent.id,
      launchId: "launch-1",
      daemonInstanceId: "daemon-a",
      clientSeq: 11,
      activity: "error",
      detail: "Codex is not logged in on this machine.",
      detailKind: "runtime_error",
      isHeartbeat: false,
      runtimeError: { errorClass: "AuthError", errorReason: "auth_failed", fingerprint: "0123456789abcdef", reasonProvenance: "runtime_error_event" },
    } as unknown as MachineToServerMessage);
    assert.equal((await stored(agent.id))?.errorClass, "AuthError");
    await orchestrator.stopAgent(agent.id, "manual");
    assert.equal(await stored(agent.id), null);
    assert.equal(orchestrator.agentUpdated(), 1);
  } finally {
    await orchestrator.shutdown();
  }
});

test("another replica with a stale cache can neither Stop-clear nor session/progress-clear a stored BillingError, and resyncs", async ({ db: _db }) => {
  const { server, machine, agent, orchestrator: owner, send } = await setup();
  const replica = new BillingOrchestrator();
  try {
    await send(billingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 10 }));
    const billing = await stored(agent.id);
    bindMachine(replica, machine.id, server.id);
    await (replica as any).getCachedAgent(agent.id);
    const generic: AgentRuntimeErrorState = { message: "Request timed out.", at: new Date(0).toISOString(), actionRequired: true };

    // Generic progress with a cache that believes the error is generic.
    (replica as any).updateCache(agent.id, { lastRuntimeError: generic });
    await replica.handleMachineMessage(machine.id, workingFrame(agent.id, { launchId: "launch-1" }, "model_request_started"));
    assert.deepEqual(await stored(agent.id), billing);
    assert.deepEqual(replica.cachedError(agent.id), billing, "the cache takes the row's BillingError");

    // A session report, same stale belief.
    (replica as any).updateCache(agent.id, { lastRuntimeError: generic });
    await replica.handleMachineMessage(machine.id, { type: "agent:session", agentId: agent.id, sessionId: "session-b", launchId: "launch-1" } as MachineToServerMessage);
    assert.deepEqual(await stored(agent.id), billing);
    assert.deepEqual(replica.cachedError(agent.id), billing);

    // A manual Stop with a cache that shows no error at all.
    (replica as any).updateCache(agent.id, { lastRuntimeError: null });
    await replica.stopAgent(agent.id, "manual");
    assert.deepEqual(await stored(agent.id), billing);
    assert.deepEqual(replica.cachedError(agent.id), billing);
    assert.equal(replica.agentUpdated(), 0);
  } finally {
    await replica.shutdown();
    await owner.shutdown();
  }
});

test("after a restart the persisted evidence still decides; an old record without evidence is kept, and a new start can recover it", async ({ db: _db }) => {
  const { server, machine, agent, orchestrator: first, send } = await setup();
  await send(billingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 10 }));
  await first.shutdown();

  const restarted = new BillingOrchestrator();
  try {
    bindMachine(restarted, machine.id, server.id);
    await restarted.handleMachineMessage(machine.id, workingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 11 }));
    assert.equal(await stored(agent.id), null, "R1 from the persisted evidence");

    // A record stored before occurrenceIds and evidence (old shape).
    const old: AgentRuntimeErrorState = { message: RAW_402, at: "2026-11-01T09:00:00.000Z", launchId: "launch-1", actionRequired: true, errorClass: "BillingError", errorReason: "billing_exhausted" };
    await getDb().update(agents).set({ lastRuntimeError: old }).where(eq(agents.id, agent.id));
    (restarted as any).updateCache(agent.id, { lastRuntimeError: old });
    await restarted.handleMachineMessage(machine.id, workingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 50 }));
    assert.deepEqual(await stored(agent.id), old, "no evidence: preserved, never cleared to give it an id");
    await restarted.stopAgent(agent.id, "manual");
    assert.deepEqual(await stored(agent.id), old, "Stop keeps it too");

    await restarted.startAgent(agent.id);
    const launchId = restarted.starts[0]!.launchId!;
    assert.deepEqual(await stored(agent.id), { ...old, recoveryLaunchId: launchId }, "the start stamps the old record");
    await restarted.handleMachineMessage(machine.id, workingFrame(agent.id, { launchId }));
    assert.equal(await stored(agent.id), null, "and that launch's output recovers it");
  } finally {
    await restarted.shutdown();
  }
});

test("the 402 stored when the frame arrives is the one judged: a newer 402 is not cleared by evidence against the older one", async ({ db: _db }) => {
  const { agent, orchestrator, send } = await setup();
  try {
    await send(billingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 10 }));
    const a = await stored(agent.id);
    // B written meanwhile (by another replica): this replica's cache still shows A.
    const b = await setAgentLastRuntimeError(agent.id, {
      ...a!,
      occurrenceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      clientSeq: 12,
      at: new Date().toISOString(),
    });
    assert.equal(b?.clientSeq, 12);
    // Later than A (11 > 10) but not than B: B survives.
    await send(workingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 11 }));
    assert.deepEqual(await stored(agent.id), b, "B survives");
    assert.deepEqual(orchestrator.cachedError(agent.id), b, "the cache learns B");
    assert.equal(orchestrator.agentUpdated(), 0, "no emit");
  } finally {
    await orchestrator.shutdown();
  }
});

test("another replica decides recovery on the database in the frame, whether its cache is empty or holds an old generic error", async ({ db: _db }) => {
  const { server, machine, agent, orchestrator: owner, send } = await setup();
  const replica = new BillingOrchestrator();
  try {
    bindMachine(replica, machine.id, server.id);
    const generic: AgentRuntimeErrorState = { message: "Request timed out.", at: new Date(0).toISOString(), actionRequired: true };

    // R1 with an empty cache.
    await send(billingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 10 }));
    await (replica as any).getCachedAgent(agent.id);
    (replica as any).updateCache(agent.id, { lastRuntimeError: null });
    await replica.handleMachineMessage(machine.id, workingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 11 }));
    assert.equal(await stored(agent.id), null);
    assert.equal(replica.cachedError(agent.id), null);
    assert.equal(replica.agentUpdated(), 1);

    // R2 with a cache holding an old generic error.
    await send(billingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 20 }));
    await stampAgentRuntimeErrorRecoveryLaunch(agent.id, "launch-2");
    (replica as any).updateCache(agent.id, { lastRuntimeError: generic });
    await replica.handleMachineMessage(machine.id, workingFrame(agent.id, { launchId: "launch-2" }));
    assert.equal(await stored(agent.id), null);
    assert.equal(replica.cachedError(agent.id), null);
    assert.equal(replica.agentUpdated(), 2);

    // R1 with a cache holding an old generic error.
    await send(billingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 30 }));
    (replica as any).updateCache(agent.id, { lastRuntimeError: generic });
    await replica.handleMachineMessage(machine.id, workingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 31 }));
    assert.equal(await stored(agent.id), null);
    assert.equal(replica.cachedError(agent.id), null);
    assert.equal(replica.agentUpdated(), 3);
  } finally {
    await replica.shutdown();
    await owner.shutdown();
  }
});

test("an unproven frame on another replica leaves the BillingError; a cache that held another error learns it", async ({ db: _db }) => {
  const { server, machine, agent, orchestrator: owner, send } = await setup();
  const replica = new BillingOrchestrator();
  try {
    bindMachine(replica, machine.id, server.id);
    await send(billingFrame(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 10 }));
    const billing = await stored(agent.id);
    await (replica as any).getCachedAgent(agent.id);
    const generic: AgentRuntimeErrorState = { message: "Request timed out.", at: new Date(0).toISOString(), actionRequired: true };
    const invalid: Array<[string, Order]> = [
      ["no launch", { daemonInstanceId: "daemon-a", clientSeq: 50 }],
      ["wrong launch", { launchId: "launch-9", daemonInstanceId: "daemon-a", clientSeq: 51 }],
      ["lower seq", { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 9 }],
    ];
    for (const [label, order] of invalid) {
      // Empty cache: nothing to learn from a statement that matched nothing (no extra read).
      (replica as any).updateCache(agent.id, { lastRuntimeError: null });
      await replica.handleMachineMessage(machine.id, workingFrame(agent.id, { ...order, daemonInstanceId: `${order.daemonInstanceId}-null-${label}` }));
      assert.deepEqual(await stored(agent.id), billing, `${label}, empty cache`);
      // A cache with another error: its generic clear is refused and it learns the BillingError.
      (replica as any).updateCache(agent.id, { lastRuntimeError: generic });
      await replica.handleMachineMessage(machine.id, workingFrame(agent.id, order));
      assert.deepEqual(await stored(agent.id), billing, label);
      assert.deepEqual(replica.cachedError(agent.id), billing, `${label}: the cache resyncs`);
    }
    assert.equal(replica.agentUpdated(), 0);
  } finally {
    await replica.shutdown();
    await owner.shutdown();
  }
});

test("a missing launch is not the same launch: same daemon process, seq 10 -> 11, no launchIds", async ({ db: _db }) => {
  const { agent, orchestrator, send } = await setup();
  try {
    await send(billingFrame(agent.id, { daemonInstanceId: "daemon-a", clientSeq: 10 }));
    const first = await stored(agent.id);
    assert.equal(first?.errorClass, "BillingError");
    assert.equal(first?.launchId, undefined);
    await send(workingFrame(agent.id, { daemonInstanceId: "daemon-a", clientSeq: 11 }));
    assert.deepEqual(await stored(agent.id), first, "no clear");
    await send(billingFrame(agent.id, { daemonInstanceId: "daemon-a", clientSeq: 12 }, `${RAW_402} (again)`));
    assert.deepEqual(await stored(agent.id), first, "no replacement");
    assert.equal(orchestrator.agentUpdated(), 0);
  } finally {
    await orchestrator.shutdown();
  }
});
