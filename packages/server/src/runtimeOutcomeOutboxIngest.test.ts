import assert from "node:assert/strict";
import { SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1, SERVER_CAPABILITY_START_SPAWN_ERROR_V1, type MachineToServerMessage, type ServerToMachineMessage, SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1, SERVER_CAPABILITY_AGENT_SEND_INTENT_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V2, SERVER_CAPABILITY_TURN_ENDED_V1, SERVER_CAPABILITY_SERVER_FEATURES_V1, SERVER_CAPABILITY_TASK_WRITE_LANDING_V1, SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1, SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1, SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1, SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1, SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2, SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1, SERVER_CAPABILITY_RUNTIME_READINESS_V1 } from "@botiverse/raft-shared";
import {
  RUNTIME_OUTCOME_ACK_ENABLED,
  RUNTIME_OUTCOME_OUTBOX_MESSAGE_TYPES,
  ingestRuntimeOutcomeOutboxMessage,
  serverMachineContextCapabilities,
  type RuntimeOutcomeOutboxMessage,
} from "./runtimeOutcomeOutboxIngest";
import { sendAuthenticatedMachineContext } from "./services/machineContext";
import {
  TERMINAL_FAILURE_CLOSED_TTL_SEC,
  applyTerminalManualStop,
  applyTerminalOutboxFrame,
  attachCatchupBatch,
  evaluateTerminalWakeGate,
  raiseCatchupObligation,
  terminalBreakerTtlSeconds,
  terminalOutboxWatermark,
  type TerminalFailureBreakerState,
} from "./terminalFailureBreaker";
import {
  InMemoryTerminalFailureBreakerStore,
  TerminalFailureBreaker,
  claimTerminalAndWakeCrashLoopStartSync,
  terminalStateFromStored,
  type CombinedClaimInput,
  type TerminalAndWakeCrashLoopWrite,
  type TerminalFailureBreakerStore,
} from "./terminalFailureBreakerStore";

// RFC 071 part 3: the server commits an outbox frame (breaker state +
// per-instance watermark, ONE compare-and-set) and only then acks it. Second
// slice: every frame class is handled (markers, old daemon instances and
// never-forgotten watermarks, null spawn identity, respawn, superseded launches, catch-up echo,
// unreadable frames); only an identity-less frame is held.

const AGENT = "agent-a";
const D1 = "daemon-1";
const D0 = "daemon-0";

/** Wraps the in-memory store: records every terminal CAS (decoded), and can reject or throw. */
class RecordingStore implements TerminalFailureBreakerStore {
  readonly inner = new InMemoryTerminalFailureBreakerStore();
  writes: TerminalFailureBreakerState[] = [];
  /** "reject": CAS returns false (conflict forever); "throw": the store errors (Redis down). */
  fail: "reject" | "throw" | null = null;
  beforeCas: (() => Promise<void>) | null = null;
  getTerminalFailureBreakerState(agentId: string) { return this.inner.getTerminalFailureBreakerState(agentId); }
  async compareAndSetTerminalFailureBreakerState(agentId: string, expectedVersion: number, state: TerminalFailureBreakerState) {
    const hook = this.beforeCas;
    this.beforeCas = null;
    if (hook) await hook();
    if (this.fail === "throw") throw new Error("redis unavailable");
    if (this.fail === "reject") return false;
    const ok = await this.inner.compareAndSetTerminalFailureBreakerState(agentId, expectedVersion, state);
    if (ok) this.writes.push(structuredClone(state));
    return ok;
  }
  getWakeCrashLoopState(agentId: string) { return this.inner.getWakeCrashLoopState(agentId); }
  /** task #365: the combined CAS can throw or lose a race too. */
  combinedFail: "reject_once" | "throw" | null = null;
  async compareAndSetTerminalAndWakeCrashLoop(agentId: string, write: TerminalAndWakeCrashLoopWrite) {
    if (this.combinedFail === "throw") throw new Error("redis unavailable");
    if (this.combinedFail === "reject_once") {
      this.combinedFail = null;
      return false;
    }
    return this.inner.compareAndSetTerminalAndWakeCrashLoop(agentId, write);
  }
  version(): number { return this.inner.getRawForTest(AGENT)?.version ?? 0; }
  state(): TerminalFailureBreakerState { return terminalStateFromStored(this.inner.getTerminalFailureBreakerStateSync(AGENT), 0).state; }
}

function harness() {
  const store = new RecordingStore();
  const breaker = new TerminalFailureBreaker(store);
  const sent: ServerToMachineMessage[] = [];
  const order: string[] = [];
  const deps = {
    applyOutboxFrame: async (...args: Parameters<TerminalFailureBreaker["applyOutboxFrame"]>) => {
      const result = await breaker.applyOutboxFrame(...args);
      order.push("committed");
      return result;
    },
    applyOutcomeMarker: async (...args: Parameters<TerminalFailureBreaker["applyOutcomeMarker"]>) => {
      const result = await breaker.applyOutcomeMarker(...args);
      order.push("committed");
      return result;
    },
    send: async (message: ServerToMachineMessage) => {
      order.push("ack");
      sent.push(message);
      return true;
    },
  };
  const ingest = (msg: MachineToServerMessage, nowMs = 1_000) =>
    ingestRuntimeOutcomeOutboxMessage(deps, msg as RuntimeOutcomeOutboxMessage, {
      nowMs,
      unreadCeilings: {},
      persistedSessionId: null,
    });
  return { store, breaker, sent, order, ingest };
}

const claimInput = (launchId: string, nowMs: number): CombinedClaimInput =>
  ({ launchId, nowMs, resumedSessionId: "S", daemonInstanceId: D1, capability: true, control: "automatic", human: false });

const e1 = (clientSeq: number, launchId = "L1", daemonInstanceId = D1): MachineToServerMessage => ({
  type: "agent:runtime:outcome",
  v: 1,
  agentId: AGENT,
  launchId,
  sessionId: "S",
  daemonInstanceId,
  clientSeq,
  observedAtMs: 0,
  outcome: { kind: "terminal_failure", failureKind: "compaction_failed", fingerprint: "c4722931c8a1f172", errorClass: "RuntimeError" },
});

const spawnedMsg = (clientSeq: number, launchId = "L1", extra: Partial<Extract<MachineToServerMessage, { type: "agent:process_spawned" }>> = {}): MachineToServerMessage => ({
  type: "agent:process_spawned",
  agentId: AGENT,
  daemonInstanceId: D1,
  processInstanceId: `pi-${launchId}`,
  launchId,
  clientSeq,
  ...extra,
});

const ackFor = (clientSeq: number, daemonInstanceId = D1): ServerToMachineMessage =>
  ({ type: "agent:outcome:ack", agentId: AGENT, daemonInstanceId, clientSeq });

// --- The switch: dormant today ---

test("capability: agent:runtime-outcome-ack-v1 is NOT advertised in machine:context today; the switch adds it", () => {
  assert.equal(RUNTIME_OUTCOME_ACK_ENABLED, false);
  // task #1268: ready-before-detection is always advertised, independent of the ack switch.
  assert.deepEqual(serverMachineContextCapabilities(), [SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1, SERVER_CAPABILITY_AGENT_SEND_INTENT_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V2, SERVER_CAPABILITY_TURN_ENDED_V1, SERVER_CAPABILITY_SERVER_FEATURES_V1, SERVER_CAPABILITY_TASK_WRITE_LANDING_V1, SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1, SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1, SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1, SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1, SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2, SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1, SERVER_CAPABILITY_RUNTIME_READINESS_V1]);
  const sent: string[] = [];
  sendAuthenticatedMachineContext({ send: (data) => sent.push(data) }, { machineId: "m1", serverId: "s1" });
  const context = JSON.parse(sent[0]!) as { capabilities?: string[] };
  assert.deepEqual(context.capabilities, [SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1, SERVER_CAPABILITY_AGENT_SEND_INTENT_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V2, SERVER_CAPABILITY_TURN_ENDED_V1, SERVER_CAPABILITY_SERVER_FEATURES_V1, SERVER_CAPABILITY_TASK_WRITE_LANDING_V1, SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1, SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1, SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1, SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1, SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2, SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1, SERVER_CAPABILITY_RUNTIME_READINESS_V1], "only the always-on capabilities while the ack switch is off");

  // task #365: start-spawn-error-v1 rides on the ack switch, never alone.
  assert.deepEqual(serverMachineContextCapabilities(true), [SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1, SERVER_CAPABILITY_START_SPAWN_ERROR_V1, SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1, SERVER_CAPABILITY_AGENT_SEND_INTENT_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V2, SERVER_CAPABILITY_TURN_ENDED_V1, SERVER_CAPABILITY_SERVER_FEATURES_V1, SERVER_CAPABILITY_TASK_WRITE_LANDING_V1, SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1, SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1, SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1, SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1, SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2, SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1, SERVER_CAPABILITY_RUNTIME_READINESS_V1]);
  sendAuthenticatedMachineContext({ send: (data) => sent.push(data) }, { machineId: "m1", serverId: "s1" }, serverMachineContextCapabilities(true));
  assert.deepEqual((JSON.parse(sent[1]!) as { capabilities?: string[] }).capabilities, [SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1, SERVER_CAPABILITY_START_SPAWN_ERROR_V1, SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1, SERVER_CAPABILITY_AGENT_SEND_INTENT_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V2, SERVER_CAPABILITY_TURN_ENDED_V1, SERVER_CAPABILITY_SERVER_FEATURES_V1, SERVER_CAPABILITY_TASK_WRITE_LANDING_V1, SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1, SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1, SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1, SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1, SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2, SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1, SERVER_CAPABILITY_RUNTIME_READINESS_V1]);
});

test("task #365: machine:context carries connectionEpochId only together with start-spawn-error-v1 (truth table)", () => {
  const contextFor = (capabilities: readonly string[]) => {
    const sent: string[] = [];
    sendAuthenticatedMachineContext({ send: (data) => sent.push(data) }, { machineId: "m1", serverId: "s1", connectionEpochId: "epoch-1" }, capabilities);
    return JSON.parse(sent[0]!) as { capabilities?: string[]; connectionEpochId?: string };
  };
  // Switch off (today): only the always-on capabilities, runtime auth (task #17), turn-ended and server features among them.
  assert.deepEqual(contextFor(serverMachineContextCapabilities()), { type: "machine:context", machineId: "m1", serverId: "s1", capabilities: [SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1, SERVER_CAPABILITY_AGENT_SEND_INTENT_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V2, SERVER_CAPABILITY_TURN_ENDED_V1, SERVER_CAPABILITY_SERVER_FEATURES_V1, SERVER_CAPABILITY_TASK_WRITE_LANDING_V1, SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1, SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1, SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1, SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1, SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2, SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1, SERVER_CAPABILITY_RUNTIME_READINESS_V1] });
  assert.equal(contextFor([SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1]).connectionEpochId, undefined);
  assert.equal(contextFor(serverMachineContextCapabilities(true)).connectionEpochId, "epoch-1");
});

// --- Commit, then ack ---

test("an applied frame is committed (state + watermark in one write) and then acked with its exact identity", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, claimInput("L1", 0))).ok);
  await h.breaker.recordProcessSpawned(AGENT, 0, { launchId: "L1", daemonInstanceId: D1, processInstanceId: "pi-L1" });
  const writesBefore = h.store.writes.length;

  const result = await h.ingest(e1(7));

  assert.deepEqual(result, { kind: "acked", duplicate: false, outcome: "applied", sent: true });
  assert.deepEqual(h.order, ["committed", "ack"]);
  assert.deepEqual(h.sent, [ackFor(7)]);
  const frameWrites = h.store.writes.slice(writesBefore);
  assert.equal(frameWrites.length, 1, "exactly one write for the frame");
  assert.equal(frameWrites[0]!.totalCount, 1, "the write carries the E1 count");
  assert.equal(terminalOutboxWatermark(frameWrites[0]!, D1), 7, "the same write carries the watermark");
});

test("negative control (a): commit succeeded but the ack was lost; the replay is NOT re-applied and is acked again", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, claimInput("L1", 0))).ok);
  // First delivery: committed (the pending entry takes the identity), ack lost in transit.
  const first = await h.ingest(spawnedMsg(3));
  assert.equal(first.kind, "acked");
  const versionAfterCommit = h.store.version();
  const stateAfterCommit = h.store.state();
  assert.equal(stateAfterCommit.unexited[0]!.processInstanceId, "pi-L1");
  h.sent.length = 0;
  h.order.length = 0;

  // The daemon resends the same (daemonInstanceId, clientSeq).
  const replay = await h.ingest(spawnedMsg(3), 5_000);

  assert.deepEqual(replay, { kind: "acked", duplicate: true, outcome: "duplicate", sent: true });
  assert.equal(h.store.version(), versionAfterCommit, "no write: the transition did not run again");
  assert.deepEqual(h.store.state(), stateAfterCommit);
  assert.deepEqual(h.sent, [ackFor(3)], "acked again with the same identity");
  // An older seq of the same instance is a replay as well.
  const older = await h.ingest(spawnedMsg(2), 6_000);
  assert.equal(older.kind === "acked" && older.duplicate, true);
  assert.equal(h.store.version(), versionAfterCommit);
});

test("negative control (b): the commit fails (CAS exhausted or store error); no ack is sent, and the resend is applied", async () => {
  for (const fail of ["reject", "throw"] as const) {
    const h = harness();
    assert.ok((await h.breaker.claimStart(AGENT, claimInput("L1", 0))).ok);
    await h.breaker.recordProcessSpawned(AGENT, 0, { launchId: "L1", daemonInstanceId: D1, processInstanceId: "pi-L1" });
    const versionBefore = h.store.version();
    const stateBefore = h.store.state();

    h.store.fail = fail;
    const failed = await h.ingest(e1(7));
    assert.equal(failed.kind, "commit_failed", fail);
    assert.deepEqual(h.sent, [], `${fail}: no ack`);
    assert.equal(h.store.version(), versionBefore, `${fail}: nothing written`);
    assert.deepEqual(h.store.state(), stateBefore, `${fail}: neither state nor watermark changed`);
    assert.equal(terminalOutboxWatermark(h.store.state(), D1), null);

    // The daemon resends; this time the write succeeds: applied (not a duplicate) and acked.
    h.store.fail = null;
    const resent = await h.ingest(e1(7));
    assert.deepEqual(resent, { kind: "acked", duplicate: false, outcome: "applied", sent: true }, fail);
    assert.equal(h.store.state().totalCount, 1);
    assert.deepEqual(h.sent, [ackFor(7)]);
  }
});

test("a CAS conflict re-reads and writes state and watermark together on top of the concurrent change", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, claimInput("L1", 0))).ok);
  // Between the frame's read and its write, another writer records the spawn.
  h.store.beforeCas = async () => {
    await h.breaker.recordProcessSpawned(AGENT, 0, { launchId: "L1", daemonInstanceId: D1, processInstanceId: "pi-L1" });
  };
  const writesBefore = h.store.writes.length;

  const result = await h.ingest(e1(9));

  assert.equal(result.kind, "acked");
  const writes = h.store.writes.slice(writesBefore);
  assert.equal(writes.length, 2, "the concurrent write, then the frame's one retried write");
  assert.equal(terminalOutboxWatermark(writes[0]!, D1), null, "the concurrent write has no watermark of this frame");
  const final = h.store.state();
  assert.equal(final.unexited[0]!.processInstanceId, "pi-L1", "the concurrent change survives");
  assert.equal(final.totalCount, 1, "the frame applied once");
  assert.equal(terminalOutboxWatermark(final, D1), 9);
  for (const write of writes) {
    assert.equal(write.totalCount > 0, terminalOutboxWatermark(write, D1) === 9, "count and watermark only ever written together");
  }
});

test("ignored and unmatched frames are committed (watermark only) and still acked", async () => {
  const h = harness();
  // No current launch: E1 is ignored; no pending entry: process_spawned is
  // tracked as a process the record did not know (its exit removes it).
  const ignored = await h.ingest(e1(4, "L-unknown"));
  assert.deepEqual(ignored, { kind: "acked", duplicate: false, outcome: "no_current_launch", sent: true });
  const unmatched = await h.ingest(spawnedMsg(5, "L-unknown"));
  assert.deepEqual(unmatched, { kind: "acked", duplicate: false, outcome: "untracked_tracked", sent: true });
  assert.deepEqual(h.store.state().unexited.map((e) => [e.spawnLaunchId, e.processInstanceId]), [["L-unknown", "pi-L-unknown"]]);
  const exited = await h.ingest({
    type: "agent:process_exited", agentId: AGENT, daemonInstanceId: D1, processInstanceId: "pi-x", spawnLaunchId: "L-x", launchId: "L-x", clientSeq: 6, code: 1, signal: null,
  });
  assert.equal(exited.kind === "acked" && exited.outcome, "exit_unmatched");
  const notSpawned = await h.ingest({
    type: "agent:start:outcome", agentId: AGENT, daemonInstanceId: D1, launchId: "L-y", clientSeq: 8, result: { kind: "not_spawned", reason: "cancelled" },
  });
  assert.equal(notSpawned.kind === "acked" && notSpawned.outcome, "unmatched");
  assert.deepEqual(h.sent, [ackFor(4), ackFor(5), ackFor(6), ackFor(8)]);
  assert.equal(terminalOutboxWatermark(h.store.state(), D1), 8);
  assert.deepEqual(h.order, ["committed", "ack", "committed", "ack", "committed", "ack", "committed", "ack"]);
});

test("start outcomes: rebound binds the identity like a rebind ack; not_spawned removes the pending entry", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, claimInput("L1", 0))).ok);
  const rebound = await h.ingest({
    type: "agent:start:outcome", agentId: AGENT, daemonInstanceId: D1, launchId: "L1", clientSeq: 2, result: { kind: "rebound", processInstanceId: "pi-live" },
  });
  assert.equal(rebound.kind === "acked" && rebound.outcome, "filled");
  assert.equal(h.store.state().unexited[0]!.processInstanceId, "pi-live");
  assert.equal(h.store.state().currentLaunch!.takeover, true);

  const h2 = harness();
  assert.ok((await h2.breaker.claimStart(AGENT, claimInput("L2", 0))).ok);
  assert.equal(h2.store.state().unexited.length, 1);
  const notSpawned = await h2.ingest({
    type: "agent:start:outcome", agentId: AGENT, daemonInstanceId: D1, launchId: "L2", clientSeq: 2, result: { kind: "not_spawned", reason: "spawn_failed" },
  });
  assert.equal(notSpawned.kind === "acked" && notSpawned.outcome, "pending_removed");
  assert.equal(h2.store.state().unexited.length, 0);
});

test("task #365: not_spawned carries its reason over the wire; only spawn_error counts, an unknown reason counts nothing", async () => {
  const outcomeFor = async (reason: string) => {
    const h = harness();
    assert.ok((await h.breaker.claimStart(AGENT, claimInput("L1", 0))).ok);
    const result = await h.ingest({
      type: "agent:start:outcome", agentId: AGENT, daemonInstanceId: D1, launchId: "L1", clientSeq: 2,
      result: { kind: "not_spawned", reason } as Extract<MachineToServerMessage, { type: "agent:start:outcome" }>["result"],
    });
    return { outcome: result.kind === "acked" ? result.outcome : result.kind, state: h.store.state(), sent: h.sent };
  };
  const counted = await outcomeFor("spawn_error");
  assert.equal(counted.outcome, "spawn_error_counted");
  assert.equal(counted.state.state, "open");
  assert.equal(counted.state.spawnError?.count, 1);
  assert.deepEqual(counted.sent, [ackFor(2)]);
  for (const reason of ["admission_full", "terminal_failure_outcome_storage_blocked", "stale_dispatch", "spawn_failed", "a_future_reason"]) {
    const other = await outcomeFor(reason);
    assert.equal(other.outcome, reason === "stale_dispatch" ? "stale_dispatch_released" : "pending_removed", reason);
    assert.equal(other.state.state, "closed", reason);
    assert.equal(other.state.spawnError, null, reason);
  }
});

test("task #365: two replicas that both find the retry due produce one probe (the claim compare-and-set)", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, claimInput("L1", 0))).ok);
  await h.ingest({ type: "agent:start:outcome", agentId: AGENT, daemonInstanceId: D1, launchId: "L1", clientSeq: 2, result: { kind: "not_spawned", reason: "spawn_error" } });
  await h.breaker.gate(AGENT, { nowMs: 60_000, capability: true, wakeMessage: null, wakeDemand: true });
  const due = 10 * 60_000;
  // Both replicas read the same due record, then both claim.
  const [a, b] = await Promise.all([
    h.breaker.claimStart(AGENT, claimInput("R1", due)),
    h.breaker.claimStart(AGENT, claimInput("R2", due)),
  ]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  const loser = a.ok ? b : a;
  assert.equal(!loser.ok && loser.reason, "terminal_failure_probe_in_flight");
  assert.equal(h.store.state().state, "half_open");
});

test("held: only a frame with no identity to acknowledge (neither applied nor acked)", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, claimInput("L1", 0))).ok);
  const versionBefore = h.store.version();
  const counts = { e1: 1, turnCompleted: 0, spawned: 0, exited: 0, startOutcome: 0 };
  const cases: MachineToServerMessage[] = [
    { ...e1(7), clientSeq: -1 } as MachineToServerMessage,
    { ...e1(7), daemonInstanceId: "" } as MachineToServerMessage,
    { type: "agent:runtime:outcome_gap", agentId: AGENT, daemonInstanceId: D1, gapId: "", fromSeq: 1, toSeq: 2, counts, takeoverEpoch: 0 },
  ];
  for (const msg of cases) {
    assert.deepEqual(await h.ingest(msg), { kind: "held", reason: "malformed_identity" });
  }
  assert.deepEqual(h.sent, [], "nothing acked");
  assert.deepEqual(h.order, [], "nothing committed");
  assert.equal(h.store.version(), versionBefore, "nothing written");
});

test("every outbox entry type is listed (rate-limit exemption and routing read this list)", () => {
  assert.deepEqual([...RUNTIME_OUTCOME_OUTBOX_MESSAGE_TYPES].sort(), [
    "agent:process_exited",
    "agent:process_spawned",
    "agent:runtime:outcome",
    "agent:runtime:outcome_cross_instance_unknown",
    "agent:runtime:outcome_gap",
    "agent:start:outcome",
  ]);
  assert.equal(RUNTIME_OUTCOME_OUTBOX_MESSAGE_TYPES.has("agent:runtime:outcome_unreliable"), false, "a best-effort notice, not an outbox entry");
});

// --- Second slice: every frame class gets real handling ---

const exitedMsg = (
  clientSeq: number,
  processInstanceId: string,
  spawnLaunchId: string | null,
  launchId: string,
  daemonInstanceId = D1,
): MachineToServerMessage => ({
  type: "agent:process_exited", agentId: AGENT, daemonInstanceId, processInstanceId, spawnLaunchId, launchId, clientSeq, code: 0, signal: null,
});

const gapMsg = (gapId: string, counts: Partial<Record<"e1" | "turnCompleted" | "spawned" | "exited" | "startOutcome", number>>, takeoverEpoch: number): MachineToServerMessage => ({
  type: "agent:runtime:outcome_gap",
  agentId: AGENT,
  daemonInstanceId: D1,
  gapId,
  fromSeq: 10,
  toSeq: 20,
  counts: { e1: 0, turnCompleted: 0, spawned: 0, exited: 0, startOutcome: 0, ...counts },
  takeoverEpoch,
});

const gate = (state: TerminalFailureBreakerState, nowMs = 2_000) =>
  evaluateTerminalWakeGate(state, { nowMs, capability: true, wakeMessage: null }).decision;

test("old daemon instance: a restarted daemon's replay of its previous instance is applied by that instance's own identity, once", async () => {
  const h = harness();
  // The agent runs on instance D0; the breaker is engaged (one counted failure), so its entry is protected.
  assert.ok((await h.breaker.claimStart(AGENT, { ...claimInput("L1", 0), daemonInstanceId: D0 })).ok);
  assert.equal((await h.ingest(spawnedMsg(2, "L1", { daemonInstanceId: D0 }))).kind, "acked");
  assert.equal((await h.ingest(e1(3, "L1", D0))).kind, "acked");
  assert.equal(h.store.state().totalCount, 1);
  // The daemon restarts as D1. Its ready arrives first: the D0 process is still unexited.
  await h.breaker.recordDaemonReady(AGENT, { daemonInstanceId: D1, nowMs: 1_500 });
  assert.equal(h.store.state().needsManual?.reason, "daemon_restarted_no_exit");
  assert.equal(gate(h.store.state()), "terminal_failure_needs_manual");

  // D1 replays D0's queued exit: applied (the old process really exited) and acked by its D0 identity.
  const exit = await h.ingest(exitedMsg(4, "pi-L1", "L1", "L1", D0), 2_000);
  assert.deepEqual(exit, { kind: "acked", duplicate: false, outcome: "removed", sent: true });
  assert.deepEqual(h.sent.at(-1), ackFor(4, D0));
  assert.deepEqual(h.store.state().unexited, [], "the D0 process left the set");
  assert.equal(h.store.state().needsManual, null, "its cause resolved, the restart block lifts");
  assert.equal(terminalOutboxWatermark(h.store.state(), D0), 4);

  // Ack lost; D1 resends the same D0 frame: not re-applied, acked again.
  const versionAfter = h.store.version();
  const replay = await h.ingest(exitedMsg(4, "pi-L1", "L1", "L1", D0), 3_000);
  assert.deepEqual(replay, { kind: "acked", duplicate: true, outcome: "duplicate", sent: true });
  assert.equal(h.store.version(), versionAfter);
});

/** Many newer daemon instances (more than the old 8- and 64-entry bounds) each commit one frame. */
async function manyNewerInstances(h: ReturnType<typeof harness>, count = 70) {
  for (let i = 1; i <= count; i += 1) {
    assert.equal((await h.ingest(e1(1, "L-none", `daemon-n${i}`), 200 + i)).kind, "acked");
  }
}

test("control (1): watermarks are never forgotten: the oldest instance replays an applied frame after 70 newer instances, on its own connection, and it is not applied again", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, { ...claimInput("L1", 0), daemonInstanceId: D0 })).ok);
  assert.deepEqual(await h.ingest(e1(5, "L1", D0), 100), { kind: "acked", duplicate: false, outcome: "applied", sent: true });
  assert.equal(h.store.state().totalCount, 1);
  await manyNewerInstances(h);
  assert.equal(Object.keys(h.store.state().outboxWatermarks).length, 71, "no bound");
  assert.equal(terminalOutboxWatermark(h.store.state(), D0), 5);
  const version = h.store.version();
  h.sent.length = 0;

  const replay = await h.ingest(e1(5, "L1", D0), 5_000);
  assert.deepEqual(replay, { kind: "acked", duplicate: true, outcome: "duplicate", sent: true });
  assert.equal(h.store.version(), version, "nothing written");
  assert.equal(h.store.state().totalCount, 1);
  assert.deepEqual(h.sent, [ackFor(5, D0)]);
});

test("control (2): a human takeover, a reset lift and a manual stop never clear watermarks; the replay after them is not applied again", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, { ...claimInput("L1", 0), daemonInstanceId: D0 })).ok);
  await h.ingest(spawnedMsg(4, "L1", { daemonInstanceId: D0 }), 100);
  await manyNewerInstances(h);
  const before = h.store.state().outboxWatermarks;
  assert.ok((await h.breaker.claimStart(AGENT, { ...claimInput("L2", 1_000), control: "human_start", human: true })).ok);
  await h.breaker.lift(AGENT, { cause: "human_reset", nowMs: 1_100 });
  await h.breaker.lift(AGENT, { cause: "runtime_config_changed", nowMs: 1_150 });
  await h.breaker.recordManualStop(AGENT, 1_200);
  assert.deepEqual(h.store.state().outboxWatermarks, before, "every write path kept them");
  const version = h.store.version();

  const replay = await h.ingest(spawnedMsg(4, "L1", { daemonInstanceId: D0 }), 5_000);
  assert.deepEqual(replay, { kind: "acked", duplicate: true, outcome: "duplicate", sent: true });
  assert.equal(h.store.version(), version);

  // A manual stop that clears a probe (half_open -> open) and the unreadable-record
  // replacement are the other rebuilds; the stop keeps them too.
  const probing = { ...h.store.state(), state: "half_open" as const, currentLaunch: { ...h.store.state().currentLaunch!, isProbe: true, leaseExpiresAtMs: 1e15 } };
  const stopped = applyTerminalManualStop(probing, { nowMs: 6_000 });
  assert.equal(stopped.state.state, "open");
  assert.deepEqual(stopped.state.outboxWatermarks, before);
});

test("control (3): a record holding a watermark never expires; without one, a closed record keeps its 7-day TTL", async () => {
  const h = harness();
  await h.ingest(e1(3, "L-none", D0), 100);
  const state = h.store.state();
  assert.equal(state.state, "closed");
  assert.equal(state.totalCount, 0, "nothing else protective in it");
  assert.equal(terminalBreakerTtlSeconds(state), 0, "persisted: the replay a week later is still a duplicate");
  assert.equal(terminalBreakerTtlSeconds({ ...state, outboxWatermarks: {} }), TERMINAL_FAILURE_CLOSED_TTL_SEC);
  // The in-memory store has no TTL at all: a week later the replay is a duplicate.
  const replay = await h.ingest(e1(3, "L-none", D0), 100 + 8 * 86_400_000);
  assert.deepEqual(replay, { kind: "acked", duplicate: true, outcome: "duplicate", sent: true });
});

test("dedupe does not rely on the transition being idempotent: a replayed E1 that would bind and count is not applied", () => {
  let state = claimSync("L1");
  state = { ...state, outboxWatermarks: { [D0]: 5 } };
  const frame = { kind: "terminal_failure" as const, frame: { launchId: "L1", sessionId: "S", daemonInstanceId: D0, clientSeq: 5, failureKind: "compaction_failed", fingerprint: "fp" } };
  const replay = applyTerminalOutboxFrame(state, frame, { nowMs: 20, unreadCeilings: {}, persistedSessionId: null });
  assert.equal(replay.outcome, "duplicate");
  assert.equal(replay.write, false);
  // Control: the next seq binds and counts.
  const next = applyTerminalOutboxFrame(state, { ...frame, frame: { ...frame.frame, clientSeq: 6 } }, { nowMs: 30, unreadCeilings: {}, persistedSessionId: null });
  assert.equal(next.state.totalCount, 1);
});

test("unreadable record: the watermarks are lost, so each instance's first frame is not applied (lost evidence, acked); later frames apply", async () => {
  const h = harness();
  h.store.inner.setRawForTest(AGENT, "{not json");
  const first = await h.ingest(e1(5, "L1", D0), 1_000);
  assert.deepEqual(first, { kind: "acked", duplicate: false, outcome: "watermarks_lost", sent: true });
  const state = h.store.state();
  assert.equal(state.needsManual?.reason, "outcome_evidence_lost");
  assert.equal(state.totalCount, 0, "not applied");
  assert.equal(terminalOutboxWatermark(state, D0), 5);
  assert.equal(state.outboxWatermarksLost, true);
  const later = await h.ingest(spawnedMsg(6, "L-x", { daemonInstanceId: D0 }), 2_000);
  assert.equal(later.kind === "acked" && later.outcome, "untracked_tracked", "a later frame of that instance applies");
  // A failed commit sends no ack.
  const h2 = harness();
  h2.store.inner.setRawForTest(AGENT, "{not json");
  h2.store.fail = "throw";
  assert.equal((await h2.ingest(e1(5, "L1", D0))).kind, "commit_failed");
  assert.deepEqual(h2.sent, []);
});

function claimSync(launchId: string): TerminalFailureBreakerState {
  const store = new InMemoryTerminalFailureBreakerStore();
  const result = claimTerminalAndWakeCrashLoopStartSync(store, AGENT, claimInput(launchId, 0));
  assert.ok(result.ok);
  return terminalStateFromStored(store.getTerminalFailureBreakerStateSync(AGENT), 0).state;
}

test("gap marker of critical frames: committed as lost evidence (needs manual), then acked by gapId; a replay is acked again with no write", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, claimInput("L1", 0))).ok);
  const result = await h.ingest(gapMsg("g1", { e1: 1, exited: 2 }, 0), 1_000);
  assert.deepEqual(result, { kind: "acked", duplicate: false, outcome: "evidence_lost", sent: true });
  assert.deepEqual(h.order, ["committed", "ack"]);
  assert.deepEqual(h.sent, [{ type: "agent:outcome:ack", agentId: AGENT, gapId: "g1" }]);
  assert.equal(h.store.state().needsManual?.reason, "outcome_evidence_lost");
  assert.equal(gate(h.store.state()), "terminal_failure_needs_manual");

  const version = h.store.version();
  const replay = await h.ingest(gapMsg("g1", { e1: 1, exited: 2 }, 0), 2_000);
  assert.deepEqual(replay, { kind: "acked", duplicate: false, outcome: "already_blocked", sent: true });
  assert.equal(h.store.version(), version, "idempotent: no write");
  assert.deepEqual(h.sent.at(-1), { type: "agent:outcome:ack", agentId: AGENT, gapId: "g1" });
});

test("cross-instance marker: always lost critical evidence (needs manual), acked by gapId", async () => {
  const h = harness();
  const result = await h.ingest({
    type: "agent:runtime:outcome_cross_instance_unknown", agentId: AGENT, gapId: "x1", instances: [D0, "daemon-9"],
    counts: { e1: 0, turnCompleted: 3, spawned: 0, exited: 0, startOutcome: 0 }, takeoverEpoch: 0,
  });
  assert.deepEqual(result, { kind: "acked", duplicate: false, outcome: "evidence_lost", sent: true });
  assert.equal(h.store.state().needsManual?.reason, "outcome_evidence_lost");
  assert.deepEqual(h.sent, [{ type: "agent:outcome:ack", agentId: AGENT, gapId: "x1" }]);
});

test("gap of turn_completed only is backlog: acked, nothing written (a lost E2 only delays a recovery)", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, claimInput("L1", 0))).ok);
  const version = h.store.version();
  const result = await h.ingest(gapMsg("g2", { turnCompleted: 4 }, 0));
  assert.deepEqual(result, { kind: "acked", duplicate: false, outcome: "backlog_only", sent: true });
  assert.equal(h.store.version(), version);
  assert.equal(h.store.state().needsManual, null);
});

test("a human start clears lost evidence and raises the takeover epoch; a replay of the older marker stays covered", async () => {
  const h = harness();
  assert.equal((await h.ingest(gapMsg("g1", { spawned: 1 }, 0))).kind, "acked");
  assert.equal(h.store.state().needsManual?.reason, "outcome_evidence_lost");
  const human = await h.breaker.claimStart(AGENT, { ...claimInput("L2", 3_000), control: "human_start", human: true });
  assert.ok(human.ok);
  assert.equal(human.token.takeoverEpoch, 1, "the takeover epoch the agent:start carries");
  assert.equal(h.store.state().needsManual, null);
  const version = h.store.version();
  const replay = await h.ingest(gapMsg("g1", { spawned: 1 }, 0), 4_000);
  assert.deepEqual(replay, { kind: "acked", duplicate: false, outcome: "covered_by_takeover", sent: true });
  assert.equal(h.store.version(), version);
  assert.equal(h.store.state().needsManual, null, "not re-blocked by evidence the takeover settled");
  // A marker of the CURRENT epoch (lost after the takeover) blocks again.
  assert.equal((await h.ingest(gapMsg("g3", { e1: 1 }, 1), 5_000)).kind, "acked");
  assert.equal(h.store.state().needsManual?.reason, "outcome_evidence_lost");
});

test("a marker whose commit fails is not acked", async () => {
  const h = harness();
  h.store.fail = "throw";
  assert.equal((await h.ingest(gapMsg("g1", { e1: 1 }, 0))).kind, "commit_failed");
  assert.deepEqual(h.sent, []);
});

test("process_exited with a null spawnLaunchId is settled by process identity only", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, claimInput("L2", 0))).ok);
  // L2 was rebound onto π, a process the daemon had started on its own (no server launch).
  assert.equal((await h.ingest({
    type: "agent:start:outcome", agentId: AGENT, daemonInstanceId: D1, launchId: "L2", clientSeq: 1, result: { kind: "rebound", processInstanceId: "pi-internal" },
  })).kind, "acked");
  assert.deepEqual(h.store.state().unexited.map((e) => e.processInstanceId), ["pi-internal"]);
  const exit = await h.ingest(exitedMsg(2, "pi-internal", null, "L2"));
  assert.deepEqual(exit, { kind: "acked", duplicate: false, outcome: "removed", sent: true });
  assert.deepEqual(h.store.state().unexited, []);
  assert.deepEqual(h.store.state().recentExits.map((e) => [e.processInstanceId, e.spawnLaunchId]), [["pi-internal", null]]);
  assert.equal(h.store.state().currentLaunch!.terminal, "process_exit", "the launch it carried is known dead");

  // Control: a null-spawn exit of an unknown process never falls back to a pending entry of its launchId.
  const h2 = harness();
  assert.ok((await h2.breaker.claimStart(AGENT, claimInput("L3", 0))).ok);
  const unmatched = await h2.ingest(exitedMsg(2, "pi-other", null, "L3"));
  assert.deepEqual(unmatched, { kind: "acked", duplicate: false, outcome: "exit_unmatched", sent: true });
  assert.deepEqual(h2.store.state().unexited.map((e) => [e.spawnLaunchId, e.processInstanceId]), [["L3", null]], "the pending L3 entry stays");
});

test("respawn: the daemon's own restart under the current launch is tracked; the launch is live again", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, claimInput("L1", 0))).ok);
  await h.ingest(spawnedMsg(1, "L1"));
  await h.ingest(exitedMsg(2, "pi-L1", "L1", "L1"));
  assert.equal(h.store.state().currentLaunch!.terminal, "process_exit");
  assert.deepEqual(h.store.state().unexited, []);

  const respawn = await h.ingest(spawnedMsg(3, "L1", { processInstanceId: "pi-L1-b", respawn: true }));
  assert.deepEqual(respawn, { kind: "acked", duplicate: false, outcome: "respawn_tracked", sent: true });
  const state = h.store.state();
  assert.deepEqual(state.unexited.map((e) => [e.spawnLaunchId, e.processInstanceId]), [["L1", "pi-L1-b"]], "a live process the record now tracks");
  assert.equal(state.currentLaunch!.terminal, null, "the launch is live again");
  assert.equal(gate(state), "pass", "the confirmed live process of the current launch does not block");
  // Its failure counts.
  assert.deepEqual(await h.ingest(e1(4, "L1")), { kind: "acked", duplicate: false, outcome: "applied", sent: true });
  assert.equal(h.store.state().totalCount, 1);
  // Its exit settles it.
  await h.ingest(exitedMsg(5, "pi-L1-b", "L1", "L1"));
  assert.deepEqual(h.store.state().unexited, []);
});

test("respawn under a launch that is not current is tracked and blocks automatic starts until it exits", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, claimInput("L2", 0))).ok);
  await h.ingest(spawnedMsg(1, "L2"));
  const respawn = await h.ingest(spawnedMsg(2, "L-old", { processInstanceId: "pi-old", respawn: true }));
  assert.equal(respawn.kind === "acked" && respawn.outcome, "respawn_tracked");
  assert.equal(gate(h.store.state()), "terminal_failure_needs_manual");
  await h.ingest(exitedMsg(3, "pi-old", "L-old", "L-old"));
  assert.equal(gate(h.store.state(), 3_000), "pass");
});

test("superseded launches: every folded launch is bound to the one process; their pending entries leave", () => {
  let state = claimSync("L2");
  // L1 was dispatched before L2 and is still pending (e.g. both waited for a slow spawn).
  state.unexited.unshift({ spawnLaunchId: "L1", daemonInstanceId: D1, processInstanceId: null, launchIds: ["L1"], dispatchedAtMs: 0, protected: false });
  const applied = applyTerminalOutboxFrame(state, {
    kind: "process_spawned", daemonInstanceId: D1, clientSeq: 4, launchId: "L2", processInstanceId: "pi", supersededLaunchIds: ["L1"],
  }, { nowMs: 10, unreadCeilings: {}, persistedSessionId: null });
  assert.equal(applied.outcome, "filled");
  assert.deepEqual(applied.state.unexited.map((e) => [e.spawnLaunchId, e.processInstanceId, e.launchIds]), [["L2", "pi", ["L2", "L1"]]]);
  state = applied.state;
  assert.equal(gate(state), "pass", "no pending entry is left behind to block");
  const exit = applyTerminalOutboxFrame(state, { kind: "process_exited", daemonInstanceId: D1, clientSeq: 5, processInstanceId: "pi", spawnLaunchId: "L2", launchId: "L2" }, { nowMs: 20, unreadCeilings: {}, persistedSessionId: null });
  assert.deepEqual(exit.state.unexited, []);
});

test("superseded launches through the ingest: a human-taken-over launch folded into the spawn gets the identity", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, claimInput("L1", 0))).ok);
  assert.ok((await h.breaker.claimStart(AGENT, { ...claimInput("L2", 1), control: "human_start", human: true })).ok);
  const spawned = await h.ingest(spawnedMsg(1, "L2", { processInstanceId: "pi", supersededLaunchIds: ["L1"] }));
  assert.equal(spawned.kind === "acked" && spawned.outcome, "filled");
  const state = h.store.state();
  assert.deepEqual(state.unexited.map((e) => [e.spawnLaunchId, e.processInstanceId, e.launchIds]), [["L2", "pi", ["L2", "L1"]]]);
  assert.deepEqual(state.acknowledgedUnexited.map((e) => [e.spawnLaunchId, e.processInstanceId]), [["L1", "pi"]]);
});

test("E2 with a catch-up echo: applied; the batch is fulfilled only when every batch row was rendered", async () => {
  for (const [renderedRows, fulfilled] of [[1, false], [2, true], [undefined, false]] as const) {
    const h = harness();
    assert.ok((await h.breaker.claimStart(AGENT, claimInput("L1", 0))).ok);
    // Owed: c1 up to seq 5; the start carried batch B1 with two rows covering it.
    let state = h.store.state();
    state = { ...state, catchupObligation: raiseCatchupObligation(null, { c1: 5 }) };
    const attached = attachCatchupBatch(state, {
      batchId: "B1", launchId: "L1", builtAtMs: 0,
      coverage: [{ conversationId: "c1", fromSeqExclusive: 3, coveredUpToSeq: 5, truncated: false }],
      messages: [{ id: "m4", conversationId: "c1", seq: 4, inPrefix: true }, { id: "m5", conversationId: "c1", seq: 5, inPrefix: true }],
      settledByCursor: [],
      candidateCapHit: false, allUnreadCovered: true,
    });
    assert.ok(attached.attached);
    assert.ok(await h.store.inner.compareAndSetTerminalFailureBreakerState(AGENT, h.store.version(), attached.state));
    await h.breaker.recordTerminalFailure(AGENT, { launchId: "L1", sessionId: "S", daemonInstanceId: "daemon-pre", clientSeq: 1, failureKind: "compaction_failed", fingerprint: "fp" }, { nowMs: 1, unreadCeilings: {} });
    assert.equal(h.store.state().totalCount, 1);
    // The launch's E1 above made it terminal; use a fresh current launch for the echo check.
    const fresh = h.store.state();
    fresh.currentLaunch = { ...fresh.currentLaunch!, terminal: null };
    assert.ok(await h.store.inner.compareAndSetTerminalFailureBreakerState(AGENT, h.store.version(), fresh));

    const result = await h.ingest({
      type: "agent:runtime:outcome", v: 1, agentId: AGENT, launchId: "L1", sessionId: "S", daemonInstanceId: D1, clientSeq: 6, observedAtMs: 0,
      outcome: { kind: "turn_completed", textEvents: 1, toolCalls: 0, catchupBatchId: "B1", ...(renderedRows === undefined ? {} : { catchupRenderedRows: renderedRows }) },
    });
    assert.deepEqual(result, { kind: "acked", duplicate: false, outcome: fulfilled ? "applied" : "applied_echo_unmatched", sent: true }, String(renderedRows));
    const after = h.store.state();
    assert.equal(after.totalCount, 0, "the E2 itself applies (counts reset)");
    assert.equal(after.catchupObligation === null, fulfilled, `rendered ${String(renderedRows)} of 2 rows`);
  }
});

test("a frame the server cannot read but can identify is committed as lost evidence and acked, never held", async () => {
  const h = harness();
  const cases: Array<[MachineToServerMessage, string]> = [
    [{ ...e1(7), v: 2 } as unknown as MachineToServerMessage, "evidence_lost:unknown_version"],
    [{ ...e1(8), outcome: { kind: "something_new" } } as unknown as MachineToServerMessage, "evidence_lost:unknown_outcome_kind"],
    [{ ...spawnedMsg(9), processInstanceId: "" } as MachineToServerMessage, "evidence_lost:malformed_spawned"],
  ];
  for (const [msg, outcome] of cases) {
    assert.deepEqual(await h.ingest(msg), { kind: "acked", duplicate: false, outcome, sent: true }, outcome);
  }
  assert.equal(h.store.state().needsManual?.reason, "outcome_evidence_lost");
  assert.equal(terminalOutboxWatermark(h.store.state(), D1), 9);
  assert.deepEqual(h.sent, [ackFor(7), ackFor(8), ackFor(9)]);
});

test("task #365 × #9150: the spawn_error commit and its #1119 ownership are one compare-and-set: a failed write changes neither and is resent; a lost race retries; a replay changes nothing", async () => {
  const h = harness();
  assert.ok((await h.breaker.claimStart(AGENT, claimInput("L1", 0))).ok);
  const frame: MachineToServerMessage = { type: "agent:start:outcome", agentId: AGENT, daemonInstanceId: D1, launchId: "L1", clientSeq: 2, result: { kind: "not_spawned", reason: "spawn_error" } };
  const wakeBefore = (await h.store.getWakeCrashLoopState(AGENT))!.state;
  // The store is down: nothing is written, nothing acked; the daemon resends.
  h.store.combinedFail = "throw";
  const failed = await h.ingest(frame);
  assert.equal(failed.kind, "commit_failed");
  assert.deepEqual(h.sent, []);
  assert.equal(h.store.state().spawnError, null);
  assert.deepEqual((await h.store.getWakeCrashLoopState(AGENT))!.state, wakeBefore);
  // The resend loses one race, then commits both records together.
  h.store.combinedFail = "reject_once";
  const committed = await h.ingest(frame);
  assert.deepEqual(committed, { kind: "acked", duplicate: false, outcome: "spawn_error_counted", sent: true });
  assert.equal(h.store.state().spawnError?.count, 1);
  assert.equal((await h.store.getWakeCrashLoopState(AGENT))!.state.startFailureOwnedLaunchId, "L1");
  // A replay of the committed frame: acked again, nothing applied again.
  const wakeAfter = (await h.store.getWakeCrashLoopState(AGENT))!.state;
  const replay = await h.ingest(frame);
  assert.equal(replay.kind === "acked" && replay.duplicate, true);
  assert.equal(h.store.state().spawnError?.count, 1);
  assert.deepEqual((await h.store.getWakeCrashLoopState(AGENT))!.state, wakeAfter);
});
