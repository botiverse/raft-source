/**
 * Agent activity scoped to who is watching (#proj-frontend:#8): the coarse
 * state fanout's throttle, who receives what from emitActivity (capable vs
 * legacy clients), and the subscribe authorization.
 */
import assert from "node:assert/strict";
import type { Server as SocketServer } from "socket.io";
import {
  AGENT_ACTIVITY_STATE_EVENT,
  AGENT_ACTIVITY_STATE_MIN_INTERVAL_MS,
  AGENT_ACTIVITY_SUBSCRIBED_EVENT,
  agentActivityCapableServerRoom,
  agentActivityRoom,
  type AgentActivityStatePayload,
} from "@botiverse/raft-shared";

import { AgentActivityStateFanout, SENT_STATE_TRUST_MS } from "./agentActivityStateFanout";
import { AgentOrchestrator } from "./agentOrchestrator";
import { parseAgentActivitySubscriptionIds, subscribeSocketToAgentActivity } from "../socket/index";

function fakeClock(start = 1_000_000) {
  let now = start;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (id: unknown) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms: number) {
      now += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > now) break;
        timers.shift();
        due.fn();
      }
    },
  };
}

test("the coarse state goes out on a change, at most once per agent per 5 s, as the state it has at the end", () => {
  const clock = fakeClock();
  const sent: AgentActivityStatePayload[] = [];
  const fanout = new AgentActivityStateFanout((_serverId, payload) => sent.push(payload), clock);

  fanout.observe("s1", "a", "online", 1, 1);
  assert.deepEqual(sent.map((p) => p.state), ["online"], "first state: sent at once");
  fanout.observe("s1", "a", "online", 2, 2);
  assert.equal(sent.length, 1, "same coarse state: nothing");

  clock.advance(1_000);
  fanout.observe("s1", "a", "working", 3, 3);
  fanout.observe("s1", "a", "thinking", 4, 4);
  fanout.observe("s1", "a", "working", 5, 5);
  assert.equal(sent.length, 1, "a change inside the interval is held");
  clock.advance(4_000);
  assert.deepEqual(sent.map((p) => [p.state, p.serverSeq]), [["online", 1], ["busy", 5]], "sent at the interval's end, with the latest push");

  clock.advance(1_000);
  fanout.observe("s1", "a", "online", 6, 6);
  fanout.observe("s1", "a", "working", 7, 7);
  clock.advance(5_000);
  assert.equal(sent.length, 2, "back where it was by the end: nothing");

  fanout.observe("s1", "b", "error", 8, 8);
  assert.deepEqual(sent.at(-1), { agentId: "b", state: "error", activity: "error", timestamp: 8, serverSeq: 8 }, "agents are throttled apart");
});

test("a deleted agent's held coarse state is dropped, not sent", () => {
  const clock = fakeClock();
  const sent: AgentActivityStatePayload[] = [];
  const fanout = new AgentActivityStateFanout((_serverId, payload) => sent.push(payload), clock);

  fanout.observe("s1", "a", "online", 1, 1);
  clock.advance(1_000);
  fanout.observe("s1", "a", "working", 2, 2);
  fanout.forget("a");
  clock.advance(5_000);
  assert.deepEqual(sent.map((p) => p.state), ["online"], "the held busy state never goes out");

  fanout.observe("s1", "a", "working", 3, 3);
  assert.deepEqual(sent.map((p) => p.state), ["online", "busy"], "nothing left of it: a later state is sent as a first one");
});

test("a Computer moving between replicas: the replica it returns to sends the change, not its memory from before", () => {
  // Two replicas on one clock; the agent's Computer m1 moves B -> A -> B.
  const clock = fakeClock();
  const sent: Array<[string, string]> = [];
  const replicaA = new AgentActivityStateFanout((_room, payload) => sent.push(["A", payload.state]), clock);
  const replicaB = new AgentActivityStateFanout((_room, payload) => sent.push(["B", payload.state]), clock);

  replicaB.resetMachine("m1");
  replicaB.observe("s1", "a", "working", 1, 1, "m1");
  assert.deepEqual(sent, [["B", "busy"]], "on B: busy sent");

  clock.advance(6_000);
  replicaB.resetMachine("m1");
  replicaA.resetMachine("m1");
  replicaA.observe("s1", "a", "online", 2, 2, "m1");
  assert.deepEqual(sent.at(-1), ["A", "online"], "moved to A: online sent, clients show online");

  clock.advance(6_000);
  replicaA.resetMachine("m1");
  replicaB.resetMachine("m1");
  replicaB.observe("s1", "a", "working", 3, 3, "m1");
  assert.deepEqual(sent.at(-1), ["B", "busy"], "back on B: busy sent again, not held back by B's old busy");

  replicaB.observe("s1", "a", "thinking", 4, 4, "m1");
  assert.equal(sent.length, 3, "still deduped while connected here");
  replicaB.resetMachine("other");
  replicaB.observe("s1", "a", "working", 5, 5, "m1");
  assert.equal(sent.length, 3, "another Computer connecting does not reset this agent");
});

test("a state sent SENT_STATE_TRUST_MS ago or longer no longer holds back the same state", () => {
  const clock = fakeClock();
  const sent: AgentActivityStatePayload[] = [];
  const fanout = new AgentActivityStateFanout((_room, payload) => sent.push(payload), clock);

  fanout.observe("s1", "a", "working", 1, 1, "m1");
  clock.advance(SENT_STATE_TRUST_MS - 1);
  fanout.observe("s1", "a", "working", 2, 2, "m1");
  assert.equal(sent.length, 1, "within the cutoff: deduped");
  clock.advance(1);
  fanout.observe("s1", "a", "working", 3, 3, "m1");
  assert.deepEqual(sent.map((p) => [p.state, p.serverSeq]), [["busy", 1], ["busy", 3]], "at the cutoff: sent again");
  fanout.observe("s1", "a", "working", 4, 4, "m1");
  assert.equal(sent.length, 2, "and trusted again from that send");
});

type Emitted = { to: string; except: string | null; event: string; payload: Record<string, unknown> };

function recordingIo(emitted: Emitted[]): SocketServer {
  const operatorFor = (to: string, except: string | null = null): any => ({
    except: (room: string) => operatorFor(to, room),
    to: () => operatorFor(to, except),
    in: () => operatorFor(to, except),
    socketsJoin: () => undefined,
    emit: (event: string, payload: Record<string, unknown>) => {
      emitted.push({ to, except, event, payload });
      return true;
    },
  });
  return { to: (room: string) => operatorFor(room), in: (room: string) => operatorFor(room) } as unknown as SocketServer;
}

class EmitOnlyOrchestrator extends AgentOrchestrator {
  protected override async loadJointActivityProjectionChannelIdsForAgent(): Promise<string[]> {
    return [];
  }
}

test("a detailed push reaches legacy clients server-wide and capable ones only through the agent's room; capable ones get the coarse state", async () => {
  const emitted: Emitted[] = [];
  const orchestrator = new EmitOnlyOrchestrator();
  orchestrator.setIO(recordingIo(emitted));
  (orchestrator as any).getCachedAgent = async (id: string) => ({ id, serverId: "s1" });

  await (orchestrator as any).emitActivity("a", "working", "Editing file", "action", 100);
  await (orchestrator as any).emitActivity("a", "working", "Running command", "action", 101);

  const detailed = emitted.filter((e) => e.event === "agent:activity");
  assert.deepEqual(detailed.map((e) => [e.to, e.except]), [
    ["server:s1", agentActivityCapableServerRoom("s1")],
    [agentActivityRoom("a"), null],
    ["server:s1", agentActivityCapableServerRoom("s1")],
    [agentActivityRoom("a"), null],
  ], "legacy: the server room minus capable sockets; capable: only the agent's room");
  const states = emitted.filter((e) => e.event === AGENT_ACTIVITY_STATE_EVENT);
  assert.deepEqual(states.map((e) => [e.to, e.payload.state, e.payload.agentId]), [[agentActivityCapableServerRoom("s1"), "busy", "a"]], "one coarse state for two detail changes");
});

test("forgetAgentActivity on the orchestrator drops the agent's held coarse state", async () => {
  const emitted: Emitted[] = [];
  const orchestrator = new EmitOnlyOrchestrator();
  orchestrator.setIO(recordingIo(emitted));
  (orchestrator as any).getCachedAgent = async (id: string) => ({ id, serverId: "s1" });
  const fanout = (orchestrator as any).agentActivityStateFanout as AgentActivityStateFanout;
  let forgotten: string | null = null;
  const forget = fanout.forget.bind(fanout);
  fanout.forget = (agentId: string) => { forgotten = agentId; forget(agentId); };

  orchestrator.forgetAgentActivity("a");
  assert.equal(forgotten, "a");
});

test("a Computer disconnecting from this replica resets its agents' sent coarse state", async () => {
  const emitted: Emitted[] = [];
  const clock = fakeClock();
  class DisconnectOnlyOrchestrator extends EmitOnlyOrchestrator {
    protected override observeComputerLifecycleDisconnect(): Promise<any> {
      return Promise.resolve();
    }
  }
  const orchestrator = new DisconnectOnlyOrchestrator(undefined, { ...clock, scheduleRepeated: () => null, cancelRepeated: () => undefined });
  orchestrator.setIO(recordingIo(emitted));
  (orchestrator as any).getCachedAgent = async (id: string) => ({ id, serverId: "s1", machineId: "m1" });
  // closedAsDuplicate: the disconnect stays local (no projection, no replica store).
  (orchestrator as any).machineConnections.set("m1", { ws: {}, machineId: "m1", serverId: "s1", connectionEpochId: null, replicaGeneration: null, closedAsDuplicate: true });

  await (orchestrator as any).emitActivity("a", "working", "Editing file", "action", 100);
  await orchestrator.handleMachineDisconnect("m1");
  clock.advance(AGENT_ACTIVITY_STATE_MIN_INTERVAL_MS);
  await (orchestrator as any).emitActivity("a", "working", "Running command", "action", 101);

  const states = emitted.filter((e) => e.event === AGENT_ACTIVITY_STATE_EVENT);
  assert.deepEqual(states.map((e) => e.payload.state), ["busy", "busy"], "the state after the disconnect is sent, not deduped");
});

/**
 * Two replicas sharing what Redis holds in production: the agent's mirrored
 * activity and which replica holds each Computer.
 */
function sharedReplicaState(computerOwners: Record<string, string>, available = true) {
  const activities = new Map<string, any>();
  return {
    activities,
    store: {
      isAvailable: () => available,
      setAgentActivity: async (agentId: string, activity: string, detail: string, detailKind: string, observedAtMs?: number) => {
        activities.set(agentId, { activity, detail, detailKind, ...(observedAtMs !== undefined ? { observedAtMs } : {}), updatedAt: Date.now() });
      },
      getAgentActivity: async (agentId: string) => activities.get(agentId) ?? null,
      getMachineReplicaOwner: async (machineId: string) => computerOwners[machineId] ?? null,
    } as any,
  };
}

/** Let the emits in flight (their getCachedAgent / owner reads) finish. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

class ReplicaOrchestrator extends EmitOnlyOrchestrator {
  readonly persistedRows: Array<{ activity: string; detail: string; entries: unknown[] }> = [];
  latestRow: { activity: string; detail: string; detailKind: string; updatedAt: number } | null = null;
  protected override async persistActivityEvent(_agentId: string, activity: any, detail: string, entries: any[]): Promise<boolean> {
    this.persistedRows.push({ activity, detail, entries });
    return true;
  }
  protected override async loadLatestPersistedActivityHint(): Promise<any> {
    return this.latestRow;
  }
}

/**
 * Replicas "replica-A" and "replica-B" in one process. By default A holds the
 * agent's Computer m1 (`machineId: null`: an agent without a Computer).
 */
function twoReplicas(options: { computerOwners?: Record<string, string>; machineId?: string | null; redisAvailable?: boolean } = {}) {
  const clock = fakeClock(Date.now());
  const testClock = { ...clock, scheduleRepeated: () => null, cancelRepeated: () => undefined };
  const machineId = options.machineId === undefined ? "m1" : options.machineId;
  const shared = sharedReplicaState(options.computerOwners ?? { m1: "replica-A" }, options.redisAvailable ?? true);
  const emittedA: Emitted[] = [];
  const emittedB: Emitted[] = [];
  const replicaA = new ReplicaOrchestrator(shared.store, testClock);
  const replicaB = new ReplicaOrchestrator(shared.store, testClock);
  replicaA.setIO(recordingIo(emittedA));
  replicaB.setIO(recordingIo(emittedB));
  for (const [replica, id] of [[replicaA, "replica-A"], [replicaB, "replica-B"]] as const) {
    (replica as any).getCachedAgent = async (agentId: string) => ({ id: agentId, serverId: "s1", machineId });
    Object.defineProperty(replica, "coarseStateReplicaId", { value: id });
  }
  (replicaA as any).hasMachineLocally = (id: string) => id === "m1" && machineId === "m1";
  (replicaB as any).hasMachineLocally = () => false;
  const coarse = (emitted: Emitted[]) => emitted.filter((e) => e.event === AGENT_ACTIVITY_STATE_EVENT).map((e) => e.payload.state);
  const detailed = (emitted: Emitted[]) => emitted.filter((e) => e.event === "agent:activity").map((e) => e.payload.activity);
  const daemonReports = (activity: string, detail: string) => (replicaA as any).broadcastActivity("a", activity, detail, "action", [{ kind: "text", text: detail }]);
  const shutdown = () => { replicaA.shutdown(); replicaB.shutdown(); };
  return { clock, shared, emittedA, emittedB, replicaA, replicaB, coarse, detailed, daemonReports, shutdown };
}

test("two replicas: a Raft action recorded on the replica without the agent's Computer writes no status and pushes nothing; the row carries the owner's status", async () => {
  const r = twoReplicas();
  r.daemonReports("working", "Editing file");
  await Promise.resolve();
  assert.deepEqual(r.coarse(r.emittedA), ["busy"], "mid-turn on A: busy sent");
  assert.equal(r.shared.activities.get("a")?.activity, "working");

  // The agent creates a task; the request lands on B.
  r.clock.advance(1_000);
  await r.replicaB.recordAgentRaftAction("a", { title: "Created 1 task", text: "target: #general" });
  assert.deepEqual(r.emittedB, [], "B pushes nothing: no online, and no status read from the shared record that could outrank the owner's next push");
  assert.equal((r.replicaB as any).agentActivity.get("a"), undefined, "B writes no status of its own");
  assert.equal(r.shared.activities.get("a")?.activity, "working", "nor over the shared one");
  assert.deepEqual(r.replicaB.persistedRows.map((row) => [row.activity, (row.entries[0] as any).title]), [["working", "Created 1 task"]], "the row is stored, with the owner's status");

  r.shutdown();
});

test("two replicas: only the replica holding the agent's Computer feeds the coarse state, so its dedupe cannot swallow a change", async () => {
  const r = twoReplicas();
  r.daemonReports("working", "Editing file");
  await Promise.resolve();

  // A status B pushes (here a direct emit) reaches the detailed rooms only.
  r.clock.advance(1_000);
  await (r.replicaB as any).emitActivity("a", "online", "", "none", r.clock.now());
  assert.deepEqual([...new Set(r.detailed(r.emittedB))], ["online"], "the detailed push still goes out");
  assert.deepEqual(r.coarse(r.emittedB), [], "B sends no coarse state for an agent whose Computer is on A");

  // The daemon reports working again on A: clients' coarse state never left busy.
  r.clock.advance(213);
  r.daemonReports("working", "Running command");
  r.clock.advance(AGENT_ACTIVITY_STATE_MIN_INTERVAL_MS);
  assert.deepEqual(r.coarse(r.emittedA), ["busy"], "A's dedupe is right: it sent busy, and clients still show busy");

  r.shutdown();
});

test("a status written on a replica without the agent's Computer is traced as skipped from the coarse state", async () => {
  const r = twoReplicas();
  const events: Array<{ name: string; attrs: any }> = [];
  (r.replicaA as any).recordEvent = (name: string, attrs: any) => events.push({ name: `A:${name}`, attrs });
  (r.replicaB as any).recordEvent = (name: string, attrs: any) => events.push({ name: `B:${name}`, attrs });
  r.daemonReports("working", "Editing file");
  await settle();

  // The real path: B writes the status (and mirrors it to the shared record) before it emits.
  r.clock.advance(1_000);
  // With an entry it emits now (a status-only write is debounced first).
  (r.replicaB as any).broadcastActivity("a", "online", "", "none", [{ kind: "text", text: "Stopped" }]);
  await settle();
  const skips = events.filter((e) => e.name.endsWith("activity.coarse_state.other_replica_skip"));
  assert.deepEqual(skips, [{ name: "B:activity.coarse_state.other_replica_skip", attrs: { agent_id: "a", activity_kind: "online", detail_kind: "none" } }], "B's skip is counted; A, the owner, feeds the coarse state");
  assert.deepEqual(r.coarse(r.emittedB), [], "and B sent no coarse state");

  r.shutdown();
});

test("a replica feeds the coarse state while no replica holds the agent's Computer", async () => {
  const r = twoReplicas({ computerOwners: {} });
  await (r.replicaB as any).emitActivity("a", "offline", "", "none", r.clock.now());
  assert.deepEqual(r.coarse(r.emittedB), ["offline"]);
  r.shutdown();
});

test("a Raft action on another replica without the shared record: the row takes the latest row's status as readers serve it, and nothing is pushed", async () => {
  const cases: Array<[string, { activity: string; detail: string; detailKind: string; ageMs: number } | null, [string, string]]> = [
    ["fresh busy latest row", { activity: "working", detail: "Editing file", detailKind: "action", ageMs: 5_000 }, ["working", "Editing file"]],
    ["stale busy latest row: served as online, not made fresh again", { activity: "working", detail: "Editing file", detailKind: "action", ageMs: 30 * 60_000 }, ["online", ""]],
    ["idle latest row", { activity: "offline", detail: "Stopped", detailKind: "none", ageMs: 30 * 60_000 }, ["offline", "Stopped"]],
    ["no row at all", null, ["online", ""]],
  ];
  for (const [name, row, expected] of cases) {
    const r = twoReplicas();
    r.replicaB.latestRow = row ? { activity: row.activity, detail: row.detail, detailKind: row.detailKind, updatedAt: r.clock.now() - row.ageMs } : null;
    await r.replicaB.recordAgentRaftAction("a", { title: "Created 1 task", text: "target: #general" });
    assert.deepEqual(r.replicaB.persistedRows.map((stored) => [stored.activity, stored.detail]), [expected], name);
    assert.deepEqual(r.emittedB, [], `${name}: nothing pushed`);
    assert.equal((r.replicaB as any).agentActivity.get("a"), undefined, `${name}: no status written`);
    r.shutdown();
  }
});

test("an agent without a Computer across two replicas: a Raft action pushes nothing, and a replica's memory of what it sent does not swallow a change", async () => {
  const r = twoReplicas({ machineId: null });
  // Its status comes in over HTTP on A.
  r.daemonReports("working", "Editing file");
  await settle();
  assert.deepEqual(r.coarse(r.emittedA), ["busy"]);

  r.clock.advance(1_000);
  await r.replicaB.recordAgentRaftAction("a", { title: "Created 1 task", text: "target: #general" });
  assert.deepEqual(r.emittedB, [], "no online from B's empty memory, nothing pushed");
  assert.equal((r.replicaB as any).agentActivity.get("a"), undefined);
  assert.equal(r.shared.activities.get("a")?.activity, "working", "the shared record keeps working");
  assert.deepEqual(r.replicaB.persistedRows.map((row) => row.activity), ["working"], "the row takes the shared status");

  // Another replica pushes a different state in between (no owner: any may).
  await (r.replicaB as any).emitActivity("a", "online", "", "none", r.clock.now());
  assert.deepEqual(r.coarse(r.emittedB), ["online"]);
  r.clock.advance(213);
  r.daemonReports("working", "Running command");
  await settle();
  r.clock.advance(AGENT_ACTIVITY_STATE_MIN_INTERVAL_MS);
  assert.deepEqual(r.coarse(r.emittedA), ["busy", "busy"], "A sends busy again: it does not dedupe without owning a Computer");

  r.shutdown();
});

test("with the Computer's owner unreadable (Redis down), a replica not holding it feeds the coarse state without the last-sent skip; the owner keeps it", async () => {
  const r = twoReplicas({ redisAvailable: false });
  await (r.replicaB as any).emitActivity("a", "working", "Editing file", "action", r.clock.now());
  r.clock.advance(AGENT_ACTIVITY_STATE_MIN_INTERVAL_MS);
  await (r.replicaB as any).emitActivity("a", "working", "Running command", "action", r.clock.now());
  assert.deepEqual(r.coarse(r.emittedB), ["busy", "busy"], "B: sent again");

  await (r.replicaA as any).emitActivity("a", "working", "Editing file", "action", r.clock.now());
  r.clock.advance(AGENT_ACTIVITY_STATE_MIN_INTERVAL_MS);
  await (r.replicaA as any).emitActivity("a", "working", "Running command", "action", r.clock.now());
  assert.deepEqual(r.coarse(r.emittedA), ["busy"], "A holds the Computer: deduped");
  r.shutdown();
});

test("a replica the Computer's owner record names, without the connection, feeds the coarse state (no other replica holds it)", async () => {
  const r = twoReplicas({ computerOwners: { m1: "replica-B" } });
  await (r.replicaB as any).emitActivity("a", "offline", "", "none", r.clock.now());
  assert.deepEqual(r.coarse(r.emittedB), ["offline"]);
  await (r.replicaA as any).emitActivity("a", "offline", "", "none", r.clock.now());
  assert.deepEqual(r.coarse(r.emittedA), ["offline"], "A holds it locally: feeds");
  r.shutdown();
});

test("a Raft action on another replica: a busy shared status older than ACTIVITY_STALE_SEC is stored as online; a fresh one, starting included, as it is", async () => {
  const cases: Array<[string, { activity: string; detail: string; detailKind: string; ageMs: number }, [string, string]]> = [
    ["stale busy shared record", { activity: "working", detail: "Editing file", detailKind: "action", ageMs: 30 * 60_000 }, ["online", ""]],
    ["fresh busy shared record", { activity: "thinking", detail: "", detailKind: "other", ageMs: 5_000 }, ["thinking", ""]],
    ["fresh starting shared record", { activity: "working", detail: "Starting", detailKind: "starting", ageMs: 5_000 }, ["working", "Starting"]],
  ];
  for (const [name, record, expected] of cases) {
    const r = twoReplicas();
    r.shared.activities.set("a", { activity: record.activity, detail: record.detail, detailKind: record.detailKind, observedAtMs: r.clock.now() - record.ageMs, updatedAt: r.clock.now() - record.ageMs });
    await r.replicaB.recordAgentRaftAction("a", { title: "Created 1 task", text: "target: #general" });
    assert.deepEqual(r.replicaB.persistedRows.map((stored) => [stored.activity, stored.detail]), [expected], name);
    assert.deepEqual(r.emittedB, [], `${name}: nothing pushed`);
    r.shutdown();
  }
});

function fakeSocket() {
  const joined: string[] = [];
  const emits: Array<[string, unknown]> = [];
  return {
    joined,
    emits,
    socket: { connected: true, join: (room: string) => { joined.push(room); }, emit: (event: string, payload: unknown) => { emits.push([event, payload]); return true; } } as any,
  };
}

test("a capable member socket subscribes only to agents of its own server; guests and legacy sockets get nothing", async () => {
  const inServer = async (_serverId: string, ids: readonly string[]) => new Set(ids.filter((id) => id.startsWith("own-")));

  const member = fakeSocket();
  const joined = await subscribeSocketToAgentActivity(member.socket, { userId: "u1", serverId: "s1", serverRole: "member", capable: true, body: { agentIds: ["own-a", "other-b", "own-a"] } }, inServer);
  assert.deepEqual(joined, ["own-a"]);
  assert.deepEqual(member.joined, [agentActivityRoom("own-a")], "another server's agent is not joined");
  assert.deepEqual(member.emits, [[AGENT_ACTIVITY_SUBSCRIBED_EVENT, { agentIds: ["own-a"] }]]);

  for (const input of [
    { serverId: "s1", serverRole: "guest", capable: true },
    { serverId: "s1", serverRole: "member", capable: false },
    { serverId: null, serverRole: "member", capable: true },
  ]) {
    const other = fakeSocket();
    assert.deepEqual(await subscribeSocketToAgentActivity(other.socket, { userId: "u1", ...input, body: { agentIds: ["own-a"] } }, inServer), [], JSON.stringify(input));
    assert.deepEqual(other.joined, []);
  }

  const failing = fakeSocket();
  assert.deepEqual(await subscribeSocketToAgentActivity(failing.socket, { userId: "u1", serverId: "s1", serverRole: "member", capable: true, body: { agentIds: ["own-a"] } }, async () => { throw new Error("db down"); }), [], "a failed read joins nothing");
});

test("subscribe bodies: strings only, deduped, bounded", () => {
  assert.deepEqual(parseAgentActivitySubscriptionIds({ agentIds: ["a", 1, "a", "", "b"] }), ["a", "b"]);
  assert.deepEqual(parseAgentActivitySubscriptionIds(null), []);
  assert.deepEqual(parseAgentActivitySubscriptionIds({ agentIds: "a" }), []);
  assert.equal(parseAgentActivitySubscriptionIds({ agentIds: Array.from({ length: 500 }, (_, i) => `id-${i}`) }).length, 200);
});
