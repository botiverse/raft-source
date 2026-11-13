import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { users } from "../db/schema";
import { machineDuplicateConnectionActionsTotal, machineDuplicateConnectionsTotal, machineOwnerRefreshTotal } from "../metrics";
import type { MachineReplicaRefreshResult } from "../replicaRouter";
import { AgentOrchestrator, daemonLacksDuplicateReconnectDelay, reportedHostnameHash } from "./agentOrchestrator";
import { registerMachine } from "./machineService";
import type { ReplicaStateStore } from "./replicaStateStore";
import { createServer } from "./serverService";

// Task #440: the owner lease refresh used to be `.catch(() => {})` with no
// result. A replica holding a live socket whose refresh kept not writing left
// the machine unroutable from every other replica with nothing to show for it.

afterEach(async () => {
  await closeTestDatabase();
});

function makeStore(refresh: () => Promise<MachineReplicaRefreshResult>): ReplicaStateStore {
  return {
    isAvailable: () => true,
    registerMachineReplica: async () => "generation-1",
    restoreMachineReplicaGeneration: async () => {},
    unregisterMachineReplica: async () => {},
    refreshMachineReplica: refresh,
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
}

async function refreshCount(result: string): Promise<number> {
  const metric = await machineOwnerRefreshTotal.get();
  return metric.values
    .filter((value) => value.labels.trigger === "pong" && value.labels.result === result)
    .reduce((sum, value) => sum + value.value, 0);
}

for (const [label, refresh, result, errorClass] of [
  ["a refused refresh", async () => "rejected_residual_generation" as const, "rejected_residual_generation", undefined],
  ["a throwing refresh", async () => { throw new TypeError("READONLY"); }, "error", "TypeError"],
] as const) {
  test(`task #440: ${label} on pong is counted and traced, not swallowed`, async ({ db: _db }) => {
    const [user] = await getDb()
      .insert(users)
      .values({ email: "owner-refresh@slock.test", name: "owner-refresh", passwordHash: "hash", emailVerified: true })
      .returning();
    const server = await createServer("Owner refresh", "owner-refresh", user!.id);
    const { machine } = await registerMachine(server.id, user!.id, "owner-refresh-machine");
    const sink = new MemoryTraceSink();
    let refreshes = 0;
    const orchestrator = new AgentOrchestrator(
      makeStore(async () => {
        refreshes += 1;
        return refresh();
      }),
      undefined,
      new BasicTracer({ sink }),
    );
    const ws = { readyState: 1, OPEN: 1, send: () => {}, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } };
    await orchestrator.registerMachine(machine.id, server.id, ws as never);
    const before = await refreshCount(result);

    await orchestrator.handleMachineMessage(machine.id, { type: "pong" } as never, ws as never);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(refreshes, 1);
    assert.equal((await refreshCount(result)) - before, 1);
    const events = [
      ...sink.getAllLogEvents(),
      ...sink.getAllSpans().flatMap((span) => span.events),
    ].filter((event) => event.name === "machine.replica.refresh");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.attrs?.result, result);
    assert.equal(events[0]!.attrs?.error_class, errorClass);
    await orchestrator.shutdown();
  });
}

// Task #374 (observation only): a live socket here whose refresh keeps being
// refused while another replica keeps renewing the lease is a second live
// connection for the same machine key.
async function duplicateCount(): Promise<number> {
  const metric = await machineDuplicateConnectionsTotal.get();
  return metric.values.reduce((sum, value) => sum + value.value, 0);
}

async function pongScenario(steps: Array<{
  atMs: number;
  refresh: MachineReplicaRefreshResult;
  lease: { replicaId: string | null; updatedAtMs: number | null } | null;
}>, label: string) {
  const [user] = await getDb()
    .insert(users)
    .values({ email: `dup-${label}@slock.test`, name: `dup-${label}`, passwordHash: "hash", emailVerified: true })
    .returning();
  const server = await createServer(`Dup ${label}`, `dup-${label}`, user!.id);
  const { machine } = await registerMachine(server.id, user!.id, `dup-${label}-machine`);
  const sink = new MemoryTraceSink();
  let now = 1_000_000;
  let step = 0;
  const clock = {
    now: () => now,
    scheduleRepeated: () => null,
    cancelRepeated: () => {},
    setTimeout: () => null,
    clearTimeout: () => {},
  };
  const store = {
    ...makeStore(async () => steps[step]!.refresh),
    getMachineReplicaLease: async () => steps[step]!.lease,
  } as ReplicaStateStore;
  const orchestrator = new AgentOrchestrator(store, clock as never, new BasicTracer({ sink }));
  const ws = { readyState: 1, OPEN: 1, send: () => {}, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } };
  await orchestrator.registerMachine(machine.id, server.id, ws as never);
  const before = await duplicateCount();
  for (step = 0; step < steps.length; step += 1) {
    now = 1_000_000 + steps[step]!.atMs;
    await orchestrator.handleMachineMessage(machine.id, { type: "pong" } as never, ws as never);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  step = steps.length - 1;
  const events = sink.getAllSpans()
    .flatMap((span) => span.events)
    .filter((event) => event.name === "machine.connection.duplicate_detected");
  const counted = (await duplicateCount()) - before;
  await orchestrator.shutdown();
  return { counted, events };
}

const foreign = (updatedAtMs: number) => ({ replicaId: "replica-other", updatedAtMs });

test("task #374: a socket refused while another replica keeps renewing the lease is counted once as a duplicate", async ({ db: _db }) => {
  const { counted, events } = await pongScenario([
    { atMs: 0, refresh: "rejected_other_lease", lease: foreign(100) },
    { atMs: 30_000, refresh: "rejected_other_lease", lease: foreign(130) },
    { atMs: 60_000, refresh: "rejected_other_lease", lease: foreign(160) },
    // Further refusals do not count the same connection again.
    { atMs: 90_000, refresh: "rejected_other_lease", lease: foreign(190) },
  ], "renewed");
  assert.equal(counted, 1);
  assert.equal(events.length, 1, "one span event, so it is queryable per machine");
  assert.equal(events[0]!.attrs?.enforcement, "observe_only");
  assert.equal(events[0]!.attrs?.foreign_lease_advances, 2);
});

test("task #374: a normal hand-off (refused briefly, then the socket's refresh succeeds) is not a duplicate", async ({ db: _db }) => {
  const { counted, events } = await pongScenario([
    { atMs: 0, refresh: "rejected_other_lease", lease: foreign(100) },
    { atMs: 30_000, refresh: "rejected_other_lease", lease: foreign(130) },
    { atMs: 45_000, refresh: "refreshed", lease: null },
    { atMs: 75_000, refresh: "rejected_other_lease", lease: foreign(200) },
    { atMs: 105_000, refresh: "rejected_other_lease", lease: foreign(230) },
  ], "handoff");
  assert.equal(counted, 0, "the successful refresh resets the evidence, and the later refusals are too short");
  assert.equal(events.length, 0);
});

test("task #374: a lease that is held elsewhere but not being renewed (a residual key) is not a duplicate", async ({ db: _db }) => {
  const { counted } = await pongScenario([
    { atMs: 0, refresh: "rejected_other_lease", lease: foreign(100) },
    { atMs: 60_000, refresh: "rejected_other_lease", lease: foreign(100) },
    { atMs: 120_000, refresh: "rejected_other_lease", lease: foreign(100) },
  ], "residual");
  assert.equal(counted, 0);
});

test("task #374: two quick foreign renewals inside the minimum duration are not yet a duplicate", async ({ db: _db }) => {
  const { counted } = await pongScenario([
    { atMs: 0, refresh: "rejected_other_lease", lease: foreign(100) },
    { atMs: 20_000, refresh: "rejected_other_lease", lease: foreign(120) },
    { atMs: 40_000, refresh: "rejected_other_lease", lease: foreign(140) },
  ], "tooshort");
  assert.equal(counted, 0);
});

// ---------------------------------------------------------------------------
// Task #374 PR 2: enforcement (SLOCK_MACHINE_DUPLICATE_CONNECTION_ENFORCEMENT).
// ---------------------------------------------------------------------------

type FakeWs = { readyState: number; OPEN: number; closes: Array<[number, string]>; send(): void; close(code?: number, reason?: string): void; terminate(): void };
function fakeWs(): FakeWs {
  return {
    readyState: 1,
    OPEN: 1,
    closes: [],
    send: () => {},
    close(code = 1000, reason = "") { this.closes.push([code, reason]); this.readyState = 3; },
    terminate() { this.readyState = 3; },
  };
}

async function actionCount(action: string): Promise<number> {
  const metric = await machineDuplicateConnectionActionsTotal.get();
  return metric.values.filter((value) => value.labels.action === action).reduce((sum, value) => sum + value.value, 0);
}

async function seedMachine(label: string) {
  const [user] = await getDb()
    .insert(users)
    .values({ email: `enf-${label}@slock.test`, name: `enf-${label}`, passwordHash: "hash", emailVerified: true })
    .returning();
  const server = await createServer(`Enf ${label}`, `enf-${label}`, user!.id);
  const { machine } = await registerMachine(server.id, user!.id, `enf-${label}-machine`);
  return { serverId: server.id, machineId: machine.id };
}

function controlledClock(start = 1_000_000) {
  const state = { now: start };
  return {
    state,
    clock: {
      now: () => state.now,
      scheduleRepeated: () => null,
      cancelRepeated: () => {},
      setTimeout: () => null,
      clearTimeout: () => {},
    },
  };
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("task #374: with enforcement off (the default), a detected duplicate is only observed", async ({ db: _db }) => {
  const { serverId, machineId } = await seedMachine("off");
  const { state, clock } = controlledClock();
  let foreignUpdatedAt = 100;
  const holds: unknown[] = [];
  const store = {
    ...makeStore(async () => "rejected_other_lease"),
    getMachineReplicaLease: async () => ({ replicaId: "replica-other", generation: "gen-winner", updatedAtMs: foreignUpdatedAt }),
    setMachineDuplicateHold: async (...args: unknown[]) => { holds.push(args); },
  } as ReplicaStateStore;
  const orchestrator = new AgentOrchestrator(store, clock as never, new BasicTracer({ sink: new MemoryTraceSink() }));
  const ws = fakeWs();
  await orchestrator.registerMachine(machineId, serverId, ws as never);
  for (const at of [0, 30_000, 60_000]) {
    state.now = 1_000_000 + at;
    foreignUpdatedAt += 30;
    await orchestrator.handleMachineMessage(machineId, { type: "pong" } as never, ws as never);
    await settle();
  }
  assert.deepEqual(ws.closes, [], "not closed");
  assert.deepEqual(holds, [], "no hold written");
  await orchestrator.shutdown();
});

test("task #374: with enforcement on, the refused (older) socket is closed and the winner is recorded", async ({ db: _db }) => {
  const { serverId, machineId } = await seedMachine("on");
  const { state, clock } = controlledClock();
  let foreignUpdatedAt = 100;
  const holds: Array<[string, unknown, number]> = [];
  const store = {
    ...makeStore(async () => "rejected_other_lease"),
    getMachineReplicaLease: async () => ({ replicaId: "replica-other", generation: "gen-winner", updatedAtMs: foreignUpdatedAt }),
    setMachineDuplicateHold: async (machine: string, hold: unknown, ttl: number) => { holds.push([machine, hold, ttl]); },
  } as ReplicaStateStore;
  const orchestrator = new AgentOrchestrator(store, clock as never, new BasicTracer({ sink: new MemoryTraceSink() }));
  (orchestrator as unknown as { duplicateConnectionEnforcement: boolean }).duplicateConnectionEnforcement = true;
  const ws = fakeWs();
  await orchestrator.registerMachine(machineId, serverId, ws as never);
  const before = await actionCount("closed_older");
  for (const at of [0, 30_000, 60_000]) {
    state.now = 1_000_000 + at;
    foreignUpdatedAt += 30;
    await orchestrator.handleMachineMessage(machineId, { type: "pong" } as never, ws as never);
    await settle();
  }
  assert.deepEqual(ws.closes, [[4003, "duplicate_machine_connection"]]);
  assert.equal(holds.length, 1);
  assert.equal(holds[0]![0], machineId);
  assert.deepEqual(holds[0]![1], { replicaId: "replica-other", generation: "gen-winner", closedDaemonVersion: null });
  assert.equal(holds[0]![2], 600);
  assert.equal((await actionCount("closed_older")) - before, 1);
  await orchestrator.shutdown();
});

function holdStore(input: {
  lease: () => { replicaId: string | null; generation: string | null; updatedAtMs: number | null };
  hold: { replicaId: string; generation: string; closedDaemonVersion: string | null } | null;
  registered: string[];
  touched: number[];
}): ReplicaStateStore {
  return {
    ...makeStore(async () => "refreshed"),
    registerMachineReplica: async (machine: string) => { input.registered.push(machine); return "gen-new"; },
    getMachineReplicaLease: async () => input.lease(),
    getMachineDuplicateHold: async () => input.hold,
    touchMachineDuplicateHold: async (_machine: string, ttl: number) => { input.touched.push(ttl); },
  } as ReplicaStateStore;
}

test("task #374: two daemons on one key do not keep kicking each other: the loser's reconnects are refused and never take the lease", async ({ db: _db }) => {
  const { serverId, machineId } = await seedMachine("pingpong");
  const { state, clock } = controlledClock();
  const registered: string[] = [];
  const touched: number[] = [];
  // The winner keeps renewing: its lease is always fresh at the moment of each reconnect.
  const store = holdStore({
    lease: () => ({ replicaId: "replica-other", generation: "gen-winner", updatedAtMs: state.now - 10_000 }),
    hold: { replicaId: "replica-other", generation: "gen-winner", closedDaemonVersion: "1.0.25" },
    registered,
    touched,
  });
  const orchestrator = new AgentOrchestrator(store, clock as never, new BasicTracer({ sink: new MemoryTraceSink() }));
  (orchestrator as unknown as { duplicateConnectionEnforcement: boolean }).duplicateConnectionEnforcement = true;
  const before = await actionCount("refused_held");
  // An old daemon ignores the close code and reconnects every second or so.
  const sockets: FakeWs[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    state.now += 1_000;
    const ws = fakeWs();
    sockets.push(ws);
    await orchestrator.registerMachine(machineId, serverId, ws as never);
  }
  assert.deepEqual(registered, [], "the loser never re-registers, so the winner's lease is never taken");
  assert.ok(sockets.every((ws) => ws.closes.length === 1 && ws.closes[0]![0] === 4003 && ws.closes[0]![1] === "duplicate_machine_connection_held"));
  assert.equal((await actionCount("refused_held")) - before, 20);
  assert.equal(touched.length, 20, "each refusal extends the hold while the loser keeps trying");
  await orchestrator.shutdown();
});

test("task #374: the winner's own reconnect is accepted at most one window (45 s) after its socket dropped", async ({ db: _db }) => {
  const { serverId, machineId } = await seedMachine("winner");
  const { state, clock } = controlledClock();
  const registered: string[] = [];
  const lastRenewalAt = state.now; // the winner's old socket dropped right after this renewal
  const store = holdStore({
    lease: () => ({ replicaId: "replica-other", generation: "gen-winner", updatedAtMs: lastRenewalAt }),
    hold: { replicaId: "replica-other", generation: "gen-winner", closedDaemonVersion: "1.0.45" },
    registered,
    touched: [],
  });
  const orchestrator = new AgentOrchestrator(store, clock as never, new BasicTracer({ sink: new MemoryTraceSink() }));
  (orchestrator as unknown as { duplicateConnectionEnforcement: boolean }).duplicateConnectionEnforcement = true;
  state.now = lastRenewalAt + 10_000;
  const early = fakeWs();
  await orchestrator.registerMachine(machineId, serverId, early as never);
  assert.deepEqual(early.closes, [[4003, "duplicate_machine_connection_held"]], "inside the window the lease still looks alive");
  assert.deepEqual(registered, []);
  state.now = lastRenewalAt + 45_001;
  const late = fakeWs();
  await orchestrator.registerMachine(machineId, serverId, late as never);
  assert.deepEqual(late.closes, [], "past the window nobody renewed it, so the reconnect is accepted");
  assert.deepEqual(registered, [machineId]);
  await orchestrator.shutdown();
});

test("task #374: a hold whose winner no longer owns the lease (another generation) does not block anyone", async ({ db: _db }) => {
  const { serverId, machineId } = await seedMachine("stalehold");
  const { state, clock } = controlledClock();
  const registered: string[] = [];
  const store = holdStore({
    lease: () => ({ replicaId: "replica-other", generation: "gen-someone-else", updatedAtMs: state.now }),
    hold: { replicaId: "replica-other", generation: "gen-winner", closedDaemonVersion: null },
    registered,
    touched: [],
  });
  const orchestrator = new AgentOrchestrator(store, clock as never, new BasicTracer({ sink: new MemoryTraceSink() }));
  (orchestrator as unknown as { duplicateConnectionEnforcement: boolean }).duplicateConnectionEnforcement = true;
  const ws = fakeWs();
  await orchestrator.registerMachine(machineId, serverId, ws as never);
  assert.deepEqual(ws.closes, []);
  assert.deepEqual(registered, [machineId]);
  await orchestrator.shutdown();
});

test("task #374: with enforcement off, a hold record never refuses a connection", async ({ db: _db }) => {
  const { serverId, machineId } = await seedMachine("holdoff");
  const { state, clock } = controlledClock();
  const registered: string[] = [];
  const store = holdStore({
    lease: () => ({ replicaId: "replica-other", generation: "gen-winner", updatedAtMs: state.now }),
    hold: { replicaId: "replica-other", generation: "gen-winner", closedDaemonVersion: null },
    registered,
    touched: [],
  });
  const orchestrator = new AgentOrchestrator(store, clock as never, new BasicTracer({ sink: new MemoryTraceSink() }));
  const ws = fakeWs();
  await orchestrator.registerMachine(machineId, serverId, ws as never);
  assert.deepEqual(ws.closes, []);
  assert.deepEqual(registered, [machineId]);
  await orchestrator.shutdown();
});

test("task #374: a socket closed as the duplicate leaves no offline projection, outage or lease cleanup behind (the winner is alive elsewhere)", async ({ db: _db }) => {
  async function closeAndDisconnect(label: string, closeAsDuplicate: boolean) {
    const { serverId, machineId } = await seedMachine(label);
    const { state, clock } = controlledClock();
    let foreignUpdatedAt = 100;
    const unregistered: unknown[] = [];
    const metaCleared: unknown[] = [];
    const store = {
      ...makeStore(async () => "rejected_other_lease"),
      getMachineReplicaLease: async () => ({ replicaId: "replica-other", generation: "gen-winner", updatedAtMs: foreignUpdatedAt }),
      setMachineDuplicateHold: async () => {},
      unregisterMachineReplica: async (...args: unknown[]) => { unregistered.push(args); },
      clearMachineMeta: async (...args: unknown[]) => { metaCleared.push(args); },
    } as ReplicaStateStore;
    const scheduled: Array<() => void> = [];
    const orchestrator = new AgentOrchestrator(store, {
      ...clock,
      setTimeout: (fn: () => void) => { scheduled.push(fn); return scheduled.length; },
    } as never, new BasicTracer({ sink: new MemoryTraceSink() }));
    (orchestrator as unknown as { duplicateConnectionEnforcement: boolean }).duplicateConnectionEnforcement = closeAsDuplicate;
    const ws = fakeWs();
    await orchestrator.registerMachine(machineId, serverId, ws as never);
    if (closeAsDuplicate) {
      for (const at of [0, 30_000, 60_000]) {
        state.now = 1_000_000 + at;
        foreignUpdatedAt += 30;
        await orchestrator.handleMachineMessage(machineId, { type: "pong" } as never, ws as never);
        await settle();
      }
      assert.deepEqual(ws.closes, [[4003, "duplicate_machine_connection"]]);
    }
    const before = { unregistered: unregistered.length, metaCleared: metaCleared.length };
    await orchestrator.handleMachineDisconnect(machineId, ws as never, { cause: "socket_close", closeCode: closeAsDuplicate ? 4003 : 1006 });
    for (const fn of scheduled.splice(0)) fn();
    await settle();
    const projectionPending = (orchestrator as unknown as { pendingMachineDisconnects: Map<string, unknown> }).pendingMachineDisconnects.has(machineId);
    await orchestrator.shutdown();
    return {
      projectionPending,
      unregistered: unregistered.length - before.unregistered,
      metaCleared: metaCleared.length - before.metaCleared,
    };
  }

  // Positive control: an ordinary disconnect of the same kind of socket runs the projection.
  const ordinary = await closeAndDisconnect("ordinary", false);
  assert.ok(ordinary.unregistered > 0 || ordinary.metaCleared > 0, "the ordinary disconnect reaches the projection (lease/meta cleanup)");

  const duplicate = await closeAndDisconnect("duplicate", true);
  assert.equal(duplicate.projectionPending, false, "no offline projection is scheduled");
  assert.equal(duplicate.unregistered, 0, "the winner's lease is not touched");
  assert.equal(duplicate.metaCleared, 0, "the winner's machine meta is not cleared");
});

// Task #374 observation: name both daemons in a duplicate report.
test("task #374: the lease holder publishes its daemon identity after a successful refresh, at most once per interval", async ({ db: _db }) => {
  const { serverId, machineId } = await seedMachine("publish");
  const { state, clock } = controlledClock();
  const published: Array<[string, unknown]> = [];
  const store = {
    ...makeStore(async () => "refreshed"),
    setMachineReplicaInstance: async (machine: string, instance: unknown) => { published.push([machine, instance]); },
  } as ReplicaStateStore;
  const orchestrator = new AgentOrchestrator(store, clock as never, new BasicTracer({ sink: new MemoryTraceSink() }));
  const ws = fakeWs();
  await orchestrator.registerMachine(machineId, serverId, ws as never);
  const conn = (orchestrator as unknown as { machineConnections: Map<string, { daemonInstanceId: string | null; daemonVersion: string | null; reportedHostnameHash?: string | null }> }).machineConnections.get(machineId)!;
  // Before `ready` there is no identity to publish.
  await orchestrator.handleMachineMessage(machineId, { type: "pong" } as never, ws as never);
  await settle();
  assert.deepEqual(published, []);
  conn.daemonInstanceId = "inst-holder";
  conn.daemonVersion = "1.0.45";
  conn.reportedHostnameHash = null; // as `ready` leaves it when no hostname was reported
  for (const at of [30_000, 60_000, 90_000, 181_000]) {
    state.now = 1_000_000 + at;
    await orchestrator.handleMachineMessage(machineId, { type: "pong" } as never, ws as never);
    await settle();
  }
  assert.equal(published.length, 2, "published at 30 s and again only after 150 s");
  assert.deepEqual(published[0], [machineId, { generation: "generation-1", daemonInstanceId: "inst-holder", daemonVersion: "1.0.45", reportedHostnameHash: null }]);
  await orchestrator.shutdown();
});

test("task #374: an old daemon that sends no instance id in `ready` still publishes its version and hostname hash as lease holder", async ({ db: _db }) => {
  const { serverId, machineId } = await seedMachine("publish-old");
  const { state, clock } = controlledClock();
  const published: Array<[string, unknown]> = [];
  const store = {
    ...makeStore(async () => "refreshed"),
    setMachineReplicaInstance: async (machine: string, instance: unknown) => { published.push([machine, instance]); },
  } as ReplicaStateStore;
  const orchestrator = new AgentOrchestrator(store, clock as never, new BasicTracer({ sink: new MemoryTraceSink() }));
  const ws = fakeWs();
  await orchestrator.registerMachine(machineId, serverId, ws as never);
  // computer-v1.0.4..1.0.2x: `ready` carries the hostname but no daemonInstanceId.
  await orchestrator.handleMachineMessage(machineId, {
    type: "ready",
    runtimes: [],
    runningAgents: [],
    hostname: "Old-Box",
    daemonVersion: "1.0.17",
  } as never, ws as never);
  await settle();
  state.now = 1_000_000 + 30_000;
  await orchestrator.handleMachineMessage(machineId, { type: "pong" } as never, ws as never);
  await settle();
  assert.ok(published.length >= 1, "an old holder publishes too");
  assert.deepEqual(published[0], [machineId, {
    generation: "generation-1",
    daemonInstanceId: null,
    daemonVersion: "1.0.17",
    reportedHostnameHash: reportedHostnameHash("old-box"),
  }]);
  await orchestrator.shutdown();
});

test("task #374: a duplicate report names both daemons and whether they are the same instance", async ({ db: _db }) => {
  async function report(
    label: string,
    holderInstanceId: string | null,
    hostnames: { refused?: string | null; holder?: string | null } = {},
    opts: { refusedInstanceId?: string | null; holderRecord?: boolean } = {},
  ) {
    const { serverId, machineId } = await seedMachine(label);
    const { state, clock } = controlledClock();
    const sink = new MemoryTraceSink();
    let foreignUpdatedAt = 100;
    const store = {
      ...makeStore(async () => "rejected_other_lease"),
      getMachineReplicaLease: async () => ({
        replicaId: "replica-other",
        generation: "gen-holder",
        updatedAtMs: foreignUpdatedAt,
        // A record from another generation or an expired one reads back as null.
        instance: opts.holderRecord === false ? null : {
          generation: "gen-holder",
          daemonInstanceId: holderInstanceId,
          daemonVersion: holderInstanceId === null ? "1.0.17" : "1.0.45",
          reportedHostnameHash: reportedHostnameHash(hostnames.holder ?? null),
        },
      }),
    } as ReplicaStateStore;
    const orchestrator = new AgentOrchestrator(store, clock as never, new BasicTracer({ sink }));
    const ws = fakeWs();
    await orchestrator.registerMachine(machineId, serverId, ws as never);
    const conn = (orchestrator as unknown as { machineConnections: Map<string, { daemonInstanceId: string | null; daemonVersion: string | null; reportedHostnameHash?: string | null }> }).machineConnections.get(machineId)!;
    conn.reportedHostnameHash = reportedHostnameHash(hostnames.refused ?? null);
    conn.daemonInstanceId = opts.refusedInstanceId === undefined ? "inst-refused" : opts.refusedInstanceId;
    conn.daemonVersion = "1.0.25";
    for (const at of [0, 30_000, 60_000]) {
      state.now = 1_000_000 + at;
      foreignUpdatedAt += 30;
      await orchestrator.handleMachineMessage(machineId, { type: "pong" } as never, ws as never);
      await settle();
    }
    await orchestrator.shutdown();
    const events = sink.getAllSpans().flatMap((span) => span.events).filter((event) => event.name === "machine.connection.duplicate_detected");
    assert.equal(events.length, 1);
    return events[0]!.attrs!;
  }
  const twoDaemons = await report("twodaemons", "inst-holder");
  assert.equal(twoDaemons.refused_daemon_instance_id, "inst-refused");
  assert.equal(twoDaemons.holder_daemon_instance_id, "inst-holder");
  assert.equal(twoDaemons.holder_daemon_version, "1.0.45");
  assert.equal(twoDaemons.daemon_version, "1.0.25");
  assert.equal(twoDaemons.same_daemon_instance, "different");
  assert.equal(twoDaemons.reported_hostname_match, "unknown", "no hostname on either side is unknown, not a match");
  const oneDaemon = await report("onedaemon", "inst-refused");
  assert.equal(oneDaemon.same_daemon_instance, "same", "one daemon process holding two sockets is told apart from two daemons");

  const sameName = await report("samename", "inst-holder", { refused: "Tenant-Laptop", holder: "tenant-laptop " });
  assert.equal(sameName.reported_hostname_match, "same");
  assert.equal(sameName.refused_hostname_hash, sameName.holder_hostname_hash);
  assert.doesNotMatch(JSON.stringify(sameName), /laptop/i, "the hostname itself never reaches the event");
  const otherName = await report("othername", "inst-holder", { refused: "host-a", holder: "host-b" });
  assert.equal(otherName.reported_hostname_match, "different");
  const oneSide = await report("oneside", "inst-holder", { refused: "host-a", holder: null });
  assert.equal(oneSide.reported_hostname_match, "unknown", "one missing side is unknown");

  // Old daemons send no instance id. An old holder is still named by version and hostname hash,
  // and a missing id on either side is unknown, never "different" (production: 1.0.25 + 1.0.45 on one key).
  const oldHolder = await report("oldholder", null, { refused: "box", holder: "box" });
  assert.equal(oldHolder.holder_daemon_version, "1.0.17");
  assert.equal(oldHolder.holder_hostname_hash, reportedHostnameHash("box"));
  assert.equal(oldHolder.reported_hostname_match, "same");
  assert.equal(oldHolder.holder_daemon_instance_id, "unknown");
  assert.equal(oldHolder.same_daemon_instance, "unknown", "holder side missing");
  const oldRefused = await report("oldrefused", "inst-holder", {}, { refusedInstanceId: null });
  assert.equal(oldRefused.refused_daemon_instance_id, "unknown");
  assert.equal(oldRefused.same_daemon_instance, "unknown", "refused side missing");
  const bothOld = await report("bothold", null, {}, { refusedInstanceId: null });
  assert.equal(bothOld.same_daemon_instance, "unknown", "both sides missing");
  // Identity stays bound to the lease generation: no record for this generation means every holder field is unknown.
  const noRecord = await report("norecord", "inst-holder", { refused: "box", holder: "box" }, { holderRecord: false });
  assert.equal(noRecord.holder_daemon_version, "unknown");
  assert.equal(noRecord.holder_hostname_hash, "unknown");
  assert.equal(noRecord.holder_daemon_instance_id, "unknown");
  assert.equal(noRecord.same_daemon_instance, "unknown");
  assert.equal(noRecord.reported_hostname_match, "unknown");
});

test("task #374: `ready` records the daemon identity and a hash of its reported hostname, never the name", async ({ db: _db }) => {
  const { serverId, machineId } = await seedMachine("ready");
  const { clock } = controlledClock();
  const orchestrator = new AgentOrchestrator(makeStore(async () => "refreshed"), clock as never, new BasicTracer({ sink: new MemoryTraceSink() }));
  const ws = fakeWs();
  await orchestrator.registerMachine(machineId, serverId, ws as never);
  await orchestrator.handleMachineMessage(machineId, {
    type: "ready",
    runtimes: [],
    runningAgents: [],
    hostname: "Tenant-Laptop",
    daemonInstanceId: "inst-ready",
    daemonVersion: "1.0.45",
  } as never, ws as never);
  await settle();
  const conn = (orchestrator as unknown as { machineConnections: Map<string, { daemonInstanceId: string | null; reportedHostnameHash?: string | null }> }).machineConnections.get(machineId)!;
  assert.equal(conn.daemonInstanceId, "inst-ready");
  assert.equal(conn.reportedHostnameHash, reportedHostnameHash("tenant-laptop"));
  assert.match(conn.reportedHostnameHash ?? "", /^[0-9a-f]{12}$/);
  await orchestrator.shutdown();
});

test("task #374: the handshake check refuses a held duplicate (counted, hold extended) only while enforcement is on", async ({ db: _db }) => {
  const { machineId } = await seedMachine("handshake");
  const { state, clock } = controlledClock();
  const touched: number[] = [];
  // The winner last renewed 10 s ago; the lease does not move unless it renews.
  const winnerRenewedAt = state.now - 10_000;
  const store = holdStore({
    lease: () => ({ replicaId: "replica-other", generation: "gen-winner", updatedAtMs: winnerRenewedAt }),
    hold: { replicaId: "replica-other", generation: "gen-winner", closedDaemonVersion: "1.0.19" },
    registered: [],
    touched,
  });
  const orchestrator = new AgentOrchestrator(store, clock as never, new BasicTracer({ sink: new MemoryTraceSink() }));
  const enforcement = orchestrator as unknown as { duplicateConnectionEnforcement: boolean };

  enforcement.duplicateConnectionEnforcement = false;
  assert.equal(await orchestrator.refuseHeldDuplicateAtHandshake(machineId), false, "observe-only never refuses");
  assert.equal(touched.length, 0);

  enforcement.duplicateConnectionEnforcement = true;
  const before = await actionCount("refused_held_handshake");
  assert.equal(await orchestrator.refuseHeldDuplicateAtHandshake(machineId), true);
  assert.equal((await actionCount("refused_held_handshake")) - before, 1);
  assert.equal(touched.length, 1, "a refusal extends the hold while the loser keeps trying");

  // The winner stopped renewing: its hold no longer protects it.
  state.now += 10 * 60_000;
  assert.equal(await orchestrator.refuseHeldDuplicateAtHandshake(machineId), false);
  await orchestrator.shutdown();
});

test("task #374: only daemons without the 5-minute duplicate delay (before 1.0.47, or unknown) are refused at the handshake", () => {
  assert.equal(daemonLacksDuplicateReconnectDelay("1.0.19"), true);
  assert.equal(daemonLacksDuplicateReconnectDelay("1.0.46"), true);
  assert.equal(daemonLacksDuplicateReconnectDelay(null), true, "a version that never reported is treated as old");
  assert.equal(daemonLacksDuplicateReconnectDelay("not-a-version"), true);
  assert.equal(daemonLacksDuplicateReconnectDelay("1.0.47"), false);
  assert.equal(daemonLacksDuplicateReconnectDelay("1.0.51"), false);
});

test("task #374: a held loser on 1.0.47+ stays on the after-open 4003 path, which keeps its 5-minute delay", async ({ db: _db }) => {
  const { machineId } = await seedMachine("handshake-new");
  const { state, clock } = controlledClock();
  const touched: number[] = [];
  const store = holdStore({
    lease: () => ({ replicaId: "replica-other", generation: "gen-winner", updatedAtMs: state.now - 10_000 }),
    hold: { replicaId: "replica-other", generation: "gen-winner", closedDaemonVersion: "1.0.51" },
    registered: [],
    touched,
  });
  const orchestrator = new AgentOrchestrator(store, clock as never, new BasicTracer({ sink: new MemoryTraceSink() }));
  (orchestrator as unknown as { duplicateConnectionEnforcement: boolean }).duplicateConnectionEnforcement = true;
  assert.equal(await orchestrator.refuseHeldDuplicateAtHandshake(machineId), false);
  assert.equal(touched.length, 0, "not refused here, so the hold is not extended here");
  await orchestrator.shutdown();
});

test("a committed replica registration names the machine and server, so a rollout readout can join it with the daemon's disconnect", async ({ db: _db }) => {
  const [user] = await getDb()
    .insert(users)
    .values({ email: "register-committed@slock.test", name: "register-committed", passwordHash: "hash", emailVerified: true })
    .returning();
  const server = await createServer("Register committed", "register-committed", user!.id);
  const { machine } = await registerMachine(server.id, user!.id, "register-committed-machine");
  const sink = new MemoryTraceSink();
  const orchestrator = new AgentOrchestrator(makeStore(async () => "refreshed" as MachineReplicaRefreshResult), undefined, new BasicTracer({ sink }));
  const ws = { readyState: 1, OPEN: 1, send: () => {}, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } };
  await orchestrator.registerMachine(machine.id, server.id, ws as never);
  await new Promise((resolve) => setImmediate(resolve));

  const events = [
    ...sink.getAllLogEvents(),
    ...sink.getAllSpans().flatMap((span) => span.events),
  ].filter((event) => event.name === "machine.replica.register_committed");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.attrs?.machine_id, machine.id);
  assert.equal(events[0]!.attrs?.server_id, server.id);
  await orchestrator.shutdown();
});
