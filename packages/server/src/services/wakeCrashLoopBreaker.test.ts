import assert from "node:assert/strict";
import {
  applyWakeCrashLoopStartFailure,
  InMemoryWakeCrashLoopStateStore,
  PAUSE_RETRY_BASE_MS,
  PAUSE_RETRY_MAX_MS,
  START_FAILURE_THRESHOLD,
  WakeCrashLoopBreaker,
  freshWakeCrashLoopEpisode,
  wakeCrashLoopRefusesAutomaticStart,
  type WakeCrashLoopEpisodeState,
  type WakeCrashLoopExit,
  type WakeCrashLoopStateRecord,
  type WakeCrashLoopStateStore,
} from "./wakeCrashLoopBreaker";

// task #1119 — breaker rules (60s window, K=3 consecutive process exits with
// evidence + matching launchId, human start resets) over a shared CAS store.

const processExit = (launchId: string, signal: string | null = "SIGTERM", code: number | null = null): WakeCrashLoopExit => ({
  kind: "agent_process_exited",
  evidence: { code, signal },
  launchId,
});

test("three consecutive early process exits block; the third is the only blockedNow", async () => {
  const b = new WakeCrashLoopBreaker();
  let t = 0;
  const outcomes: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    await b.recordStart("a", `launch-${i}`, t);
    const o = await b.recordExit("a", processExit(`launch-${i}`), t + 10_000);
    assert.equal(o.counted, true);
    outcomes.push(o.blockedNow);
    t += 15_000;
  }
  assert.deepEqual(outcomes, [false, false, true]);
  assert.equal(await b.isBlocked("a"), true);
  assert.equal((await b.snapshot("a")).earlyExitCount, 3);
  assert.equal((await b.snapshot("a")).lastLaunchId, "launch-2");
});

test("two early exits then a run that survives the window reset the streak", async () => {
  const b = new WakeCrashLoopBreaker();
  await b.recordStart("a", "l1", 0);
  await b.recordExit("a", processExit("l1"), 5_000);
  await b.recordStart("a", "l2", 10_000);
  await b.recordExit("a", processExit("l2"), 15_000);
  await b.recordStart("a", "l3", 20_000);
  // l3 lives past the window; the next start sees a broken streak.
  await b.recordStart("a", "l4", 100_000);
  const o = await b.recordExit("a", processExit("l4"), 105_000);
  assert.equal(o.counted, true);
  assert.equal(o.blockedNow, false);
  assert.equal((await b.snapshot("a")).earlyExitCount, 1);
});

test("an exit outside the window, a second exit for the same start, or an exit while blocked is not counted", async () => {
  const b = new WakeCrashLoopBreaker(undefined, { threshold: 1 });
  await b.recordStart("a", "l1", 0);
  assert.equal((await b.recordExit("a", processExit("l1"), 61_000)).rejected, "outside_window");
  await b.recordStart("a", "l2", 100_000);
  assert.equal((await b.recordExit("a", processExit("l2"), 100_500)).blockedNow, true);
  assert.equal((await b.recordExit("a", processExit("l2"), 100_600)).rejected, "already_blocked");
  assert.equal(await b.isBlocked("a"), true);
  // Not blocked, same start twice: the second is a duplicate.
  const c = new WakeCrashLoopBreaker();
  await c.recordStart("a", "l1", 0);
  assert.equal((await c.recordExit("a", processExit("l1"), 1_000)).counted, true);
  assert.equal((await c.recordExit("a", processExit("l1"), 1_100)).rejected, "already_counted");
});

// Review counterexample (task #1126): three WebSocket closes with no signal and
// no launch must not arm the breaker. A transport loss is not runner death.
test("machine disconnects are never early exits: three in a row leave automatic wakes allowed", async () => {
  const b = new WakeCrashLoopBreaker();
  for (let i = 0; i < 3; i++) {
    await b.recordStart("a", `l${i}`, i * 20_000);
    const o = await b.recordExit("a", { kind: "machine_disconnected", evidence: null, launchId: null }, i * 20_000 + 10_000);
    assert.equal(o.counted, false);
    assert.equal(o.rejected, "not_process_exit");
  }
  assert.equal(await b.isBlocked("a"), false);
  assert.equal((await b.snapshot("a")).earlyExitCount, 0);
});

test("an inactive frame without exit evidence, or with a launchId that is not the current start, is not counted", async () => {
  const b = new WakeCrashLoopBreaker(undefined, { threshold: 1 });
  await b.recordStart("a", "l1", 0);
  assert.equal((await b.recordExit("a", { kind: "agent_process_exited", evidence: null, launchId: "l1" }, 1_000)).rejected, "no_exit_evidence");
  assert.equal((await b.recordExit("a", processExit("l0"), 1_000)).rejected, "launch_mismatch");
  assert.equal((await b.recordExit("a", { kind: "agent_process_exited", evidence: { code: 1, signal: null }, launchId: null }, 1_000)).rejected, "launch_mismatch");
  assert.equal(await b.isBlocked("a"), false);
  // A start without a launchId cannot be bound, so nothing counts against it.
  const c = new WakeCrashLoopBreaker(undefined, { threshold: 1 });
  await c.recordStart("a", null, 0);
  assert.equal((await c.recordExit("a", processExit("l1"), 1_000)).rejected, "no_start");
  assert.equal(await c.isBlocked("a"), false);
  // Exit code without a signal is still process-exit evidence.
  await b.recordStart("a", "l2", 5_000);
  assert.equal((await b.recordExit("a", processExit("l2", null, 1), 6_000)).blockedNow, true);
});

test("only a human start lifts a block and opens a new episode; manual stop forgets the streak", async () => {
  const b = new WakeCrashLoopBreaker(undefined, { threshold: 2 });
  await b.recordStart("a", "l1", 0);
  await b.recordExit("a", processExit("l1"), 1_000);
  await b.recordStart("a", "l2", 2_000);
  await b.recordExit("a", processExit("l2"), 3_000);
  assert.equal(await b.isBlocked("a"), true);
  // An automatic start attempt does not lift the block.
  await b.recordStart("a", "l3", 4_000);
  assert.equal(await b.isBlocked("a"), true);
  await b.recordStart("a", "l4", 5_000, { human: true });
  assert.equal(await b.isBlocked("a"), false);
  assert.equal((await b.snapshot("a")).episode, 2);
  assert.equal((await b.snapshot("a")).earlyExitCount, 0);
  // One early exit in the new episode counts but does not block yet.
  assert.equal((await b.recordExit("a", processExit("l4", "SIGKILL"), 6_000)).blockedNow, false);
  await b.recordManualStop("a");
  assert.equal((await b.snapshot("a")).earlyExitCount, 0);
  assert.equal((await b.snapshot("a")).episode, 2);
});

// Review counterexample (task #1126): a block must outlive the process that
// armed it. A second breaker on the same shared store (a replica switch or a
// restart) must see the block; a human start on either side lifts it for both.
test("a block is read back by a fresh breaker on the same shared store; only a human start on any replica lifts it", async () => {
  const store = new InMemoryWakeCrashLoopStateStore();
  const replicaA = new WakeCrashLoopBreaker(store);
  for (let i = 0; i < 3; i++) {
    await replicaA.recordStart("a", `l${i}`, i * 20_000);
    await replicaA.recordExit("a", processExit(`l${i}`), i * 20_000 + 10_000);
  }
  assert.equal(await replicaA.isBlocked("a"), true, "positive control");

  const replicaB = new WakeCrashLoopBreaker(store);
  assert.equal(await replicaB.isBlocked("a"), true, "the replacement owner must not start unblocked");
  await replicaB.recordStart("a", "l3", 70_000);
  assert.equal(await replicaB.isBlocked("a"), true, "an automatic start on the new replica does not lift it");
  assert.equal(await replicaA.isBlocked("a"), true);

  await replicaB.recordStart("a", "l4", 80_000, { human: true });
  assert.equal(await replicaB.isBlocked("a"), false);
  assert.equal(await replicaA.isBlocked("a"), false, "the old replica reads the lifted block through the store");
  assert.equal((await replicaA.snapshot("a")).episode, 2);
});

// Locked by Huaihuai (#proj-runtime:3ddaa7c2): a late exit from the previous
// episode's launch must not re-block after a human start/resume.
test("a late exit from an old launch after a human start does not count against the new episode", async () => {
  const b = new WakeCrashLoopBreaker(undefined, { threshold: 3 });
  await b.recordStart("a", "l1", 0);
  await b.recordExit("a", processExit("l1"), 1_000);
  await b.recordStart("a", "l2", 2_000);
  await b.recordExit("a", processExit("l2"), 3_000);
  assert.equal((await b.snapshot("a")).earlyExitCount, 2);
  // Human resumes with l3 before l2's late exit frame arrives (or a replayed l2).
  await b.recordStart("a", "l3", 4_000, { human: true });
  const late = await b.recordExit("a", processExit("l2"), 4_500);
  assert.equal(late.counted, false);
  assert.equal(late.rejected, "launch_mismatch");
  assert.equal(await b.isBlocked("a"), false);
  assert.equal((await b.snapshot("a")).episode, 2);
  assert.equal((await b.snapshot("a")).earlyExitCount, 0);
  // And an exit that really belongs to l3 counts as the first of the new episode.
  assert.equal((await b.recordExit("a", processExit("l3"), 5_000)).counted, true);
  assert.equal((await b.snapshot("a")).earlyExitCount, 1);
});

/** A store whose next N reads are held until released, so N writers observe the same version before any writes. */
class GatedWakeCrashLoopStateStore implements WakeCrashLoopStateStore {
  private readonly inner = new InMemoryWakeCrashLoopStateStore();
  private holdRemaining = 0;
  private readonly heldReads: Array<() => void> = [];
  private allHeld: (() => void) | null = null;

  /** Resolves once `count` reads are parked. */
  holdNextReads(count: number): Promise<void> {
    this.holdRemaining = count;
    return new Promise((resolve) => {
      this.allHeld = resolve;
    });
  }

  releaseHeldReads(): void {
    for (const release of this.heldReads.splice(0)) release();
  }

  async getWakeCrashLoopState(agentId: string): Promise<WakeCrashLoopStateRecord | null> {
    if (this.holdRemaining > 0) {
      this.holdRemaining -= 1;
      await new Promise<void>((release) => {
        this.heldReads.push(release);
        if (this.holdRemaining === 0) this.allHeld?.();
      });
    }
    return this.inner.getWakeCrashLoopState(agentId);
  }

  compareAndSetWakeCrashLoopState(agentId: string, expectedVersion: number, state: WakeCrashLoopEpisodeState): Promise<boolean> {
    return this.inner.compareAndSetWakeCrashLoopState(agentId, expectedVersion, state);
  }
}

// Locked by Huaihuai/XX (#proj-runtime:3ddaa7c2): read-count→increment→write
// must be atomic on the shared store. Two writers that both read the same
// state must not lose a count. RED with a plain get/set store: the start's
// stale write overwrites the exit's increment and the third exit lands on 2.
test("concurrent writers on the shared store never lose an early-exit count", async () => {
  const store = new GatedWakeCrashLoopStateStore();
  const b = new WakeCrashLoopBreaker(store);
  await b.recordStart("a", "l1", 0);
  await b.recordExit("a", processExit("l1"), 1_000);
  await b.recordStart("a", "l2", 2_000);
  assert.equal((await b.snapshot("a")).earlyExitCount, 1);

  // Writer 1 (owner replica): l2's early exit. Writer 2 (a replica handling the
  // next automatic wake): start l3. Both read before either writes.
  const bothRead = store.holdNextReads(2);
  const exitWrite = b.recordExit("a", processExit("l2"), 3_000);
  const startWrite = b.recordStart("a", "l3", 3_000);
  await bothRead;
  store.releaseHeldReads();
  const [exitObservation] = await Promise.all([exitWrite, startWrite]);
  assert.equal(exitObservation.counted, true);

  const afterRace = await b.snapshot("a");
  assert.equal(afterRace.earlyExitCount, 2, "the exit's increment must survive the concurrent start");
  assert.equal((await store.getWakeCrashLoopState("a"))!.state.lastStartLaunchId, "l3", "the start's launch binding must survive too");

  const third = await b.recordExit("a", processExit("l3"), 4_000);
  assert.equal(third.counted, true);
  assert.equal(third.blockedNow, true, "K=3 is reached; a lost count would leave this at 2");
  assert.equal(await b.isBlocked("a"), true);
});

// Review counterexample (task #1126): the start must be on record before the
// dispatch can produce a visible exit; a send that fails must roll it back
// without touching a newer start.
test("rollbackStart undoes a start whose dispatch failed, but never a newer start or a counted exit", async () => {
  const b = new WakeCrashLoopBreaker(undefined, { threshold: 3 });
  await b.recordStart("a", "l1", 0);
  await b.recordExit("a", processExit("l1"), 1_000);
  const failed = await b.recordStart("a", "l2", 2_000);
  assert.equal(await b.rollbackStart("a", failed), true);
  const after = await b.snapshot("a");
  assert.equal(after.earlyExitCount, 1, "the streak from l1 is untouched");
  // The rolled-back start is gone: an exit for l2 binds to nothing.
  assert.equal((await b.recordExit("a", processExit("l2"), 2_500)).rejected, "launch_mismatch");

  // A newer start supersedes the token: rolling back the old one is a no-op.
  const stale = await b.recordStart("a", "l3", 3_000);
  await b.recordStart("a", "l4", 4_000);
  assert.equal(await b.rollbackStart("a", stale), false);
  assert.equal((await b.recordExit("a", processExit("l4"), 4_500)).counted, true);

  // A counted exit pins the start: rolling back afterwards is a no-op.
  const counted = await b.recordStart("a", "l5", 5_000);
  await b.recordExit("a", processExit("l5"), 5_500);
  assert.equal(await b.rollbackStart("a", counted), false);
  assert.equal((await b.snapshot("a")).earlyExitCount, 3);
  assert.equal(await b.isBlocked("a"), true);
});

test("task #1221: a non-retryable start failure blocks at once, only for the current launch", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  await breaker.recordStart("agent-1", "launch-b", 2_000);
  // A late failure from the previous launch must not block the current one.
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-a", reason: "model_not_configured", nowMs: 3_000 })).outcome, "ignored");
  assert.equal(await breaker.isBlocked("agent-1"), false);
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: null, reason: "model_not_configured", nowMs: 3_000 })).outcome, "ignored");
  // The current launch's failure blocks immediately (no threshold) and only once.
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-b", reason: "model_not_configured", nowMs: 3_000 })).outcome, "blocked");
  assert.equal(await breaker.isBlocked("agent-1"), true);
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-b", reason: "model_not_configured", nowMs: 4_000 })).outcome, "ignored");
});

test("a start refused for a disallowed env var blocks at once: retrying the same settings cannot pass", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-a", reason: "env_var_not_allowed", nowMs: 2_000 })).outcome, "blocked");
  assert.equal(await breaker.isBlocked("agent-1"), true);
});

test("task #10: session_needs_reset blocks automatic starts on the first failure; a human start (Reset Session) lifts it", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-a", reason: "session_needs_reset", nowMs: 1_500 })).outcome, "blocked");
  assert.equal(await breaker.isBlocked("agent-1"), true);
  await breaker.recordStart("agent-1", "launch-b", 2_000, { human: true });
  assert.equal(await breaker.isBlocked("agent-1"), false);
});

test("task #1258: session_runtime_mismatch blocks automatic starts on the first failure; a human start (Reset Session) lifts it", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-a", reason: "session_runtime_mismatch", nowMs: 1_500 })).outcome, "blocked");
  assert.equal(await breaker.isBlocked("agent-1"), true);
  await breaker.recordStart("agent-1", "launch-b", 2_000, { human: true });
  assert.equal(await breaker.isBlocked("agent-1"), false);
});

test("task #1221: a config change or a human start lifts a start-failure block", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  await breaker.recordStartFailure("agent-1", { launchId: "launch-a", reason: "runtime_login_required", nowMs: 1_500 });
  assert.equal(await breaker.liftForConfigChange("agent-1"), true);
  assert.equal(await breaker.isBlocked("agent-1"), false);
  assert.equal(await breaker.liftForConfigChange("agent-1"), false, "nothing to lift");

  await breaker.recordStart("agent-1", "launch-b", 2_000);
  await breaker.recordStartFailure("agent-1", { launchId: "launch-b", reason: "runtime_config_invalid", nowMs: 2_500 });
  await breaker.recordStart("agent-1", "launch-c", 3_000, { human: true });
  assert.equal(await breaker.isBlocked("agent-1"), false, "a human start opens a fresh episode");
});


test("task #1221: a config change before the old launch reports its failure stops that late failure from blocking", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-old", 1_000);
  // Configuration changes while the old start is still in flight (not blocked yet).
  assert.equal(await breaker.liftForConfigChange("agent-1"), false, "nothing was blocked");
  // The old start's failure arrives late.
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-old", reason: "model_not_configured", nowMs: 2_000 })).outcome, "ignored");
  assert.equal(await breaker.isBlocked("agent-1"), false, "the next wake starts under the new configuration");
  // A start under the new configuration can still be blocked by its own failure.
  await breaker.recordStart("agent-1", "launch-new", 3_000);
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-new", reason: "model_not_configured", nowMs: 3_500 })).outcome, "blocked");
});

test("task #1221: the block owes a catch-up; a config-change lift keeps it owed; only the carrying start's active report clears it", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  assert.equal(await breaker.isCatchupOwed("agent-1"), false);
  await breaker.recordStartFailure("agent-1", { launchId: "launch-a", reason: "model_not_configured", nowMs: 1_500 });
  assert.equal(await breaker.isCatchupOwed("agent-1"), true);
  await breaker.liftForConfigChange("agent-1");
  assert.equal(await breaker.isBlocked("agent-1"), false);
  assert.equal(await breaker.isCatchupOwed("agent-1"), true, "lifted, still owed to the next start");
  await breaker.recordStart("agent-1", "launch-b", 2_000);
  assert.equal(await breaker.isCatchupOwed("agent-1"), true, "a dispatch alone does not deliver it");
  assert.equal(await breaker.confirmCatchupDelivered("agent-1", "launch-b"), false, "launch-b was not marked as the carrier");
  await breaker.markCatchupCarried("agent-1", "launch-b");
  assert.equal(await breaker.confirmCatchupDelivered("agent-1", "launch-b"), true);
  assert.equal(await breaker.isCatchupOwed("agent-1"), false);
});


test("task #1221: a manual stop keeps an undelivered catch-up owed and voids the old carrier", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  await breaker.recordStartFailure("agent-1", { launchId: "launch-a", reason: "model_not_configured", nowMs: 1_500 });
  await breaker.recordStart("agent-1", "launch-b", 2_000, { human: true });
  await breaker.markCatchupCarried("agent-1", "launch-b");
  await breaker.recordManualStop("agent-1");
  assert.equal(await breaker.isCatchupOwed("agent-1"), true, "the stop does not deliver it");
  assert.equal(await breaker.confirmCatchupDelivered("agent-1", "launch-b"), false, "the pre-stop carrier can no longer clear it");
});


test("model_not_found retries once after the hold; a second failure in a row blocks", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), { retryOnceDelayMs: 60_000 });
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  const first = await breaker.recordStartFailure("agent-1", { launchId: "launch-a", reason: "model_not_found", nowMs: 2_000 });
  assert.deepEqual(first, { outcome: "retry_scheduled", blocked: false, startFailureCount: 1, retryAfterMs: 62_000, pauseRetryAtMs: null, previousPauseReason: null, notify: false, alreadyNotified: false, pauseRetryCapNoticeDue: false });
  assert.deepEqual(await breaker.automaticWakeHold("agent-1", 61_999), { kind: "retry_pending", retryAfterMs: 62_000 });
  assert.equal(await breaker.automaticWakeHold("agent-1", 62_000), null, "the hold ends; the retry may start");
  assert.equal(await breaker.isCatchupOwed("agent-1"), true, "messages refused during the hold are owed to the retry");

  await breaker.recordStart("agent-1", "launch-b", 62_250);
  const second = await breaker.recordStartFailure("agent-1", { launchId: "launch-b", reason: "model_not_found", nowMs: 63_000 });
  assert.deepEqual(second, { outcome: "blocked", blocked: true, startFailureCount: 2, retryAfterMs: null, pauseRetryAtMs: null, previousPauseReason: null, notify: false, alreadyNotified: false, pauseRetryCapNoticeDue: false });
  assert.deepEqual(await breaker.automaticWakeHold("agent-1", 200_000), { kind: "blocked", reason: "model_not_found" });
});

test("a retry that starts clears the streak, so a later model_not_found gets its own retry", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  await breaker.recordStartFailure("agent-1", { launchId: "launch-a", reason: "model_not_found", nowMs: 2_000 });
  await breaker.recordStart("agent-1", "launch-b", 70_000);
  assert.deepEqual(await breaker.recordStartSucceeded("agent-1", "launch-b"), { changed: true, unpaused: false });
  assert.deepEqual(await breaker.recordStartSucceeded("agent-1", "launch-b"), { changed: false, unpaused: false }, "nothing left to clear");
  await breaker.recordStart("agent-1", "launch-c", 80_000);
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-c", reason: "model_not_found", nowMs: 81_000 })).outcome, "retry_scheduled");
});

test("any start failure blocks after five failed starts in a row, keeping the last reason", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  const outcomes: string[] = [];
  for (let i = 1; i <= 5; i += 1) {
    await breaker.recordStart("agent-1", `launch-${i}`, i * 1_000);
    const reason = i === 5 ? "provider_connection_materialization_failed" : "runtime_spawn_failed";
    outcomes.push((await breaker.recordStartFailure("agent-1", { launchId: `launch-${i}`, reason, nowMs: i * 1_000 + 500 })).outcome);
  }
  assert.deepEqual(outcomes, ["counted", "counted", "counted", "counted", "blocked"]);
  assert.deepEqual(await breaker.automaticWakeHold("agent-1", 10_000), { kind: "blocked", reason: "provider_connection_materialization_failed" });
  assert.equal(await breaker.isCatchupOwed("agent-1"), true);
});

test("a model_not_found after a different failure is a first model_not_found: it retries", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-a", reason: "runtime_spawn_failed", nowMs: 1_500 })).outcome, "counted");
  await breaker.recordStart("agent-1", "launch-b", 2_000);
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-b", reason: "model_not_found", nowMs: 2_500 })).outcome, "retry_scheduled");
});

test("a config change or a human start ends a start-failure streak and a pending retry", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  await breaker.recordStartFailure("agent-1", { launchId: "launch-a", reason: "model_not_found", nowMs: 1_500 });
  assert.equal(await breaker.liftForConfigChange("agent-1"), false, "not blocked, but the streak is gone");
  assert.equal(await breaker.automaticWakeHold("agent-1", 2_000), null, "the new model need not wait for the retry");
  await breaker.recordStart("agent-1", "launch-b", 3_000);
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-b", reason: "model_not_found", nowMs: 3_500 })).outcome, "retry_scheduled", "counted as a first failure again");

  await breaker.recordStart("agent-1", "launch-c", 4_000, { human: true });
  assert.equal(await breaker.automaticWakeHold("agent-1", 4_100), null);
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-c", reason: "model_not_found", nowMs: 4_500 })).outcome, "retry_scheduled");
});

// A runtime error only the owner can fix (rejected credential) blocks
// automatic wakes at once; the owner is told once per distinct error. The
// caller marks the error as told only after its notice was posted.
async function blockAndTell(b: WakeCrashLoopBreaker, launchId: string, fingerprint: string, nowMs: number) {
  const result = await b.recordActionRequired("a", { launchId, reason: "user_reauth", fingerprint, nowMs });
  if (result.notify) await b.markActionRequiredNotified("a", fingerprint);
  return result;
}

test("an owner-action runtime error on the current start blocks at once and asks to notify once", async () => {
  const b = new WakeCrashLoopBreaker();
  await b.recordStart("a", "launch-1", 0);
  assert.deepEqual(await blockAndTell(b, "launch-1", "f1", 1_000), { outcome: "blocked", notify: true });
  assert.deepEqual(await b.automaticWakeHold("a", 2_000), { kind: "blocked", reason: "user_reauth" });
  assert.equal(await b.isCatchupOwed("a"), true, "messages that arrive while blocked are owed to the next start");
  // The same error again while blocked changes nothing and is not news.
  assert.deepEqual(await blockAndTell(b, "launch-1", "f1", 3_000), { outcome: "already_blocked", notify: false });
});

test("a notice that was not posted is asked for again on the next occurrence", async () => {
  const b = new WakeCrashLoopBreaker();
  await b.recordStart("a", "launch-1", 0);
  // Posting failed: the caller does not mark it.
  assert.deepEqual(
    await b.recordActionRequired("a", { launchId: "launch-1", reason: "user_reauth", fingerprint: "f1", nowMs: 1_000 }),
    { outcome: "blocked", notify: true },
  );
  await b.recordStart("a", "launch-2", 2_000, { human: true });
  assert.deepEqual(await blockAndTell(b, "launch-2", "f1", 3_000), { outcome: "blocked", notify: true });
});

test("an owner-action error from a start that is not the current one is ignored", async () => {
  const b = new WakeCrashLoopBreaker();
  await b.recordStart("a", "launch-2", 0);
  for (const launchId of ["launch-1", null]) {
    assert.deepEqual(
      await b.recordActionRequired("a", { launchId, reason: "user_reauth", fingerprint: "f1", nowMs: 1_000 }),
      { outcome: "ignored", notify: false },
    );
  }
  assert.equal(await b.automaticWakeHold("a", 2_000), null);
});

test("a manual start without a fix lifts the block but does not re-notify the same error", async () => {
  const b = new WakeCrashLoopBreaker();
  await b.recordStart("a", "launch-1", 0);
  await blockAndTell(b, "launch-1", "f1", 1_000);
  await b.recordStart("a", "launch-2", 2_000, { human: true });
  assert.equal(await b.automaticWakeHold("a", 2_500), null, "a human start lifts the block");
  assert.deepEqual(await blockAndTell(b, "launch-2", "f1", 3_000), { outcome: "blocked", notify: false });
  // A different error is news.
  await b.recordStart("a", "launch-3", 4_000, { human: true });
  assert.deepEqual(
    await b.recordActionRequired("a", { launchId: "launch-3", reason: "user_model_access", fingerprint: "f2", nowMs: 5_000 }),
    { outcome: "blocked", notify: true },
  );
});

test("after a config change or a run that clears the error, the same error is reported again", async () => {
  const b = new WakeCrashLoopBreaker();
  await b.recordStart("a", "launch-1", 0);
  await blockAndTell(b, "launch-1", "f1", 1_000);
  assert.equal(await b.liftForConfigChange("a"), true);
  assert.equal(await b.automaticWakeHold("a", 1_500), null);
  await b.recordStart("a", "launch-2", 2_000);
  assert.deepEqual(await blockAndTell(b, "launch-2", "f1", 3_000), { outcome: "blocked", notify: true });

  // Fixed outside Raft (e.g. signed in on the computer), started by hand, ran
  // fine for a while (the error cleared), then the credential expired again.
  await b.recordStart("a", "launch-3", 4_000, { human: true });
  await b.forgetActionRequiredNotice("a");
  assert.deepEqual(await blockAndTell(b, "launch-3", "f1", 5_000), { outcome: "blocked", notify: true });
});

test("a config change while not blocked (started by hand first, then a new key) still makes the error news", async () => {
  const b = new WakeCrashLoopBreaker();
  await b.recordStart("a", "launch-1", 0);
  await blockAndTell(b, "launch-1", "f1", 1_000);
  await b.recordStart("a", "launch-2", 2_000, { human: true });
  assert.equal(await b.liftForConfigChange("a"), false, "nothing was blocked");
  await b.recordStart("a", "launch-3", 3_000);
  assert.deepEqual(await blockAndTell(b, "launch-3", "f1", 4_000), { outcome: "blocked", notify: true });
});

test("a manual stop keeps the notified error", async () => {
  const b = new WakeCrashLoopBreaker();
  await b.recordStart("a", "launch-1", 0);
  await blockAndTell(b, "launch-1", "f1", 1_000);
  await b.recordManualStop("a");
  await b.recordStart("a", "launch-2", 2_000, { human: true });
  assert.deepEqual(await blockAndTell(b, "launch-2", "f1", 3_000), { outcome: "blocked", notify: false });
});

test("a runtime the computer does not have blocks on the first failure, unless the lookup itself did not decide", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-1", 1_000);
  const first = await breaker.recordStartFailure("agent-1", { launchId: "launch-1", reason: "runtime_not_found", nowMs: 1_500, noticeFingerprint: "runtime_not_found:codex:m1" });
  assert.equal(first.outcome, "blocked");
  assert.equal(first.notify, true, "the owner is told");
  assert.deepEqual(await breaker.automaticWakeHold("agent-1", 2_000), { kind: "blocked", reason: "runtime_not_found" });

  const confirmed = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await confirmed.recordStart("agent-1", "launch-1", 1_000);
  assert.equal((await confirmed.recordStartFailure("agent-1", { launchId: "launch-1", reason: "runtime_not_found", lookupReason: "not_on_path", nowMs: 1_500 })).outcome, "blocked");

  for (const lookupReason of ["lookup_timed_out", "lookup_failed"] as const) {
    const undecided = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
    await undecided.recordStart("agent-1", "launch-1", 1_000);
    const result = await undecided.recordStartFailure("agent-1", { launchId: "launch-1", reason: "runtime_not_found", lookupReason, nowMs: 1_500, noticeFingerprint: "f" });
    assert.equal(result.outcome, "counted", `${lookupReason} keeps the ordinary threshold`);
    assert.equal(result.notify, false);
  }
});

test("the runtime-missing notice is not repeated for the same runtime and computer, even after a human start", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  const fingerprint = "runtime_not_found:codex:m1";
  await breaker.recordStart("agent-1", "launch-1", 1_000);
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-1", reason: "runtime_not_found", nowMs: 1_500, noticeFingerprint: fingerprint })).notify, true);
  await breaker.markActionRequiredNotified("agent-1", fingerprint);
  await breaker.recordStart("agent-1", "launch-2", 2_000, { human: true });
  const again = await breaker.recordStartFailure("agent-1", { launchId: "launch-2", reason: "runtime_not_found", nowMs: 2_500, noticeFingerprint: fingerprint });
  assert.equal(again.outcome, "blocked");
  assert.equal(again.notify, false);
  assert.equal(again.alreadyNotified, true, "#proj-runtime:#32: the skip says why, so it can be recorded");
  await breaker.recordStart("agent-1", "launch-3", 3_000, { human: true });
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-3", reason: "runtime_not_found", nowMs: 3_500, noticeFingerprint: "runtime_not_found:codex:m2" })).notify, true, "another computer is news");
});

test("the computer listing the runtime lifts only a runtime-missing block, keeping the owed catch-up and the notice", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-1", 1_000);
  await breaker.recordStartFailure("agent-1", { launchId: "launch-1", reason: "runtime_not_found", nowMs: 1_500, noticeFingerprint: "f" });
  await breaker.markActionRequiredNotified("agent-1", "f");
  assert.equal(await breaker.liftForRuntimeAvailable("agent-1"), true);
  assert.equal(await breaker.automaticWakeHold("agent-1", 2_000), null);
  assert.equal(await breaker.isCatchupOwed("agent-1"), true);
  // If the start still fails, the owner already knows.
  await breaker.recordStart("agent-1", "launch-2", 3_000);
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-2", reason: "runtime_not_found", nowMs: 3_500, noticeFingerprint: "f" })).notify, false);

  const other = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await other.recordStart("agent-1", "launch-1", 1_000);
  await other.recordStartFailure("agent-1", { launchId: "launch-1", reason: "model_not_configured", nowMs: 1_500 });
  assert.equal(await other.liftForRuntimeAvailable("agent-1"), false);
  assert.deepEqual(await other.automaticWakeHold("agent-1", 2_000), { kind: "blocked", reason: "model_not_configured" });
});

/** Try times exactly on the cooldown (the jitter's midpoint). */
const NO_JITTER = { random: () => 0.5 } as const;

/** START_FAILURE_THRESHOLD start timeouts in a row; the last one at `nowMs` blocks. */
async function pauseOnStartTimeouts(breaker: WakeCrashLoopBreaker, nowMs: number) {
  let last;
  for (let i = 1; i <= START_FAILURE_THRESHOLD; i += 1) {
    await breaker.recordStart("agent-1", `launch-${i}`, nowMs - 10 + i);
    last = await breaker.recordStartFailure("agent-1", { launchId: `launch-${i}`, reason: "runtime_start_timeout", nowMs });
  }
  return last!;
}

test("a start-timeout pause tries one automatic wake after its cooldown; the try reaching readiness lifts it", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
  const paused = await pauseOnStartTimeouts(breaker, 100_000);
  assert.equal(paused.outcome, "blocked");
  assert.equal(paused.pauseRetryAtMs, 100_000 + PAUSE_RETRY_BASE_MS);
  assert.deepEqual(await breaker.automaticWakeHold("agent-1", 100_000 + PAUSE_RETRY_BASE_MS - 1), { kind: "blocked", reason: "runtime_start_timeout" });
  assert.equal(await breaker.automaticWakeHold("agent-1", 100_000 + PAUSE_RETRY_BASE_MS), null, "the cooldown ran out: one wake may try");

  // The try: the next try is armed at once, with the cooldown doubled.
  const tryAt = 100_000 + PAUSE_RETRY_BASE_MS;
  await breaker.recordStart("agent-1", "launch-try", tryAt);
  assert.equal(await breaker.pauseRetryAtMs("agent-1"), tryAt + 2 * PAUSE_RETRY_BASE_MS);
  assert.deepEqual(await breaker.automaticWakeHold("agent-1", tryAt + 1), { kind: "blocked", reason: "runtime_start_timeout" }, "only one wake per cooldown");

  // Readiness of an earlier launch does nothing; the try's lifts the pause.
  assert.deepEqual(await breaker.recordStartSucceeded("agent-1", "launch-5"), { changed: false, unpaused: false });
  assert.deepEqual(await breaker.recordStartSucceeded("agent-1", "launch-try"), { changed: true, unpaused: true });
  assert.equal(await breaker.automaticWakeHold("agent-1", tryAt + 2), null);
  assert.equal(await breaker.pauseRetryAtMs("agent-1"), null);
  assert.equal(await breaker.isCatchupOwed("agent-1"), true, "the owed catch-up waits for its own delivery confirmation");
});

test("a failed try re-pauses with a longer cooldown, and the next try comes after it", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), { pauseRetryBaseMs: 1_000, ...NO_JITTER });
  await pauseOnStartTimeouts(breaker, 10_000);
  assert.equal(await breaker.pauseRetryAtMs("agent-1"), 11_000);
  await breaker.recordStart("agent-1", "launch-try-1", 11_000);
  const failed = await breaker.recordStartFailure("agent-1", { launchId: "launch-try-1", reason: "runtime_start_timeout", nowMs: 11_500 });
  assert.equal(failed.outcome, "ignored", "already paused");
  assert.equal(failed.blocked, true);
  assert.equal(failed.pauseRetryAtMs, 13_000, "cooldown doubled: 2s from the try");
  assert.deepEqual(await breaker.automaticWakeHold("agent-1", 12_999), { kind: "blocked", reason: "runtime_start_timeout" });
  assert.equal(await breaker.automaticWakeHold("agent-1", 13_000), null);
  await breaker.recordStart("agent-1", "launch-try-2", 13_000);
  assert.equal(await breaker.pauseRetryAtMs("agent-1"), 17_000, "doubled again: 4s");
});

test("other threshold pauses keep waiting for a person; a human start clears a start-timeout pause", async () => {
  const other = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  for (let i = 1; i <= START_FAILURE_THRESHOLD; i += 1) {
    await other.recordStart("agent-1", `launch-${i}`, i);
    await other.recordStartFailure("agent-1", { launchId: `launch-${i}`, reason: "runtime_spawn_failed", nowMs: 100 });
  }
  assert.equal(await other.pauseRetryAtMs("agent-1"), null);
  assert.deepEqual(await other.automaticWakeHold("agent-1", 100 + 100 * PAUSE_RETRY_BASE_MS), { kind: "blocked", reason: "runtime_spawn_failed" });

  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await pauseOnStartTimeouts(breaker, 100);
  await breaker.recordStart("agent-1", "launch-human", 200, { human: true });
  assert.equal(await breaker.pauseRetryAtMs("agent-1"), null);
  assert.equal(await breaker.automaticWakeHold("agent-1", 300), null);
});

test("the combined-claim gate lets exactly a due try through", () => {
  const blocked: WakeCrashLoopEpisodeState = { ...freshWakeCrashLoopEpisode(1), blocked: true, pauseRetryAtMs: 5_000, pauseRetryCooldownMs: 1_000 };
  assert.equal(wakeCrashLoopRefusesAutomaticStart(blocked, 4_999), true);
  assert.equal(wakeCrashLoopRefusesAutomaticStart(blocked, 5_000), false);
  assert.equal(wakeCrashLoopRefusesAutomaticStart({ ...blocked, pauseRetryAtMs: null }, 1e12), true, "a pause without a retry stays refused");
});

test("the pause-retry cooldown doubles from 30 minutes and stops at 8 hours; jitter moves only the try time", async () => {
  // Jitter on, at both ends of its range: the stored cooldown still doubles exactly.
  const units = [0, 0.999_999, 0.25, 0.75, 0, 0.999_999, 0.5];
  let draw = 0;
  const store = new InMemoryWakeCrashLoopStateStore();
  const breaker = new WakeCrashLoopBreaker(store, { random: () => units[draw++ % units.length] });
  await pauseOnStartTimeouts(breaker, 0);
  const minute = 60_000;
  const cooldowns: number[] = [];
  const gaps: number[] = [];
  let previousAtMs = 0;
  let retryAtMs = (await breaker.pauseRetryAtMs("agent-1"))!;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const cooldownMs = store.getWakeCrashLoopStateSync("agent-1")!.state.pauseRetryCooldownMs!;
    cooldowns.push(cooldownMs);
    gaps.push(retryAtMs - previousAtMs);
    await breaker.recordStart("agent-1", `launch-try-${attempt}`, retryAtMs);
    await breaker.recordStartFailure("agent-1", { launchId: `launch-try-${attempt}`, reason: "runtime_start_timeout", nowMs: retryAtMs + minute });
    previousAtMs = retryAtMs;
    retryAtMs = (await breaker.pauseRetryAtMs("agent-1"))!;
  }
  assert.equal(PAUSE_RETRY_MAX_MS, 480 * minute);
  assert.deepEqual(cooldowns.map((ms) => ms / minute), [30, 60, 120, 240, 480, 480]);
  gaps.forEach((gap, i) => {
    assert.ok(gap >= 0.9 * cooldowns[i] && gap <= 1.1 * cooldowns[i], `try ${i + 1}: ${gap} within ±10% of ${cooldowns[i]}`);
  });
});

test("the try time is jittered by at most ±10% of the cooldown, and may pass 8 hours at the cap", async () => {
  const at = async (unit: number, base?: number) => {
    const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), { random: () => unit, ...(base ? { pauseRetryBaseMs: base } : {}) });
    await pauseOnStartTimeouts(breaker, 1_000);
    return (await breaker.pauseRetryAtMs("agent-1"))! - 1_000;
  };
  assert.equal(await at(0), 0.9 * PAUSE_RETRY_BASE_MS, "earliest: 27 minutes");
  assert.equal(await at(0.5), PAUSE_RETRY_BASE_MS);
  assert.equal(await at(0.999_999), Math.round(PAUSE_RETRY_BASE_MS * (1 + 0.1 * (2 * 0.999_999 - 1))));
  assert.ok((await at(0.999_999)) < 1.1 * PAUSE_RETRY_BASE_MS, "latest: just under 33 minutes");
  assert.ok((await at(0.999_999, PAUSE_RETRY_MAX_MS)) > PAUSE_RETRY_MAX_MS, "not capped: agents at the cap stay spread");
});

test("a configured pause-retry base above 8 hours is capped from the first pause", async () => {
  const hour = 60 * 60_000;
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), { pauseRetryBaseMs: 10 * hour, ...NO_JITTER });
  await pauseOnStartTimeouts(breaker, 0);
  assert.equal(await breaker.pauseRetryAtMs("agent-1"), PAUSE_RETRY_MAX_MS);
});

test("a try that fails for a reason that does not retry by itself ends the self-retry, keeps the pause and takes the new reason", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
  await pauseOnStartTimeouts(breaker, 0);
  const tryAt = PAUSE_RETRY_BASE_MS;
  await breaker.recordStart("agent-1", "launch-try", tryAt);
  // A late failure of an earlier launch is still ignored.
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-3", reason: "runtime_login_required", nowMs: tryAt + 1 })).outcome, "ignored");

  const ended = await breaker.recordStartFailure("agent-1", {
    launchId: "launch-try",
    reason: "runtime_login_required",
    nowMs: tryAt + 1_000,
    noticeFingerprint: "runtime_login_required:opencode:m",
    noticeOnBlock: false,
  });
  assert.equal(ended.outcome, "pause_retry_ended");
  assert.equal(ended.blocked, true);
  assert.equal(ended.pauseRetryAtMs, null, "no further try");
  assert.equal(ended.previousPauseReason, "runtime_start_timeout");
  assert.equal(ended.notify, true, "the owner hears it will not retry by itself");
  assert.deepEqual(await breaker.automaticWakeHold("agent-1", tryAt + 100 * PAUSE_RETRY_MAX_MS), { kind: "blocked", reason: "runtime_login_required" });
  assert.equal((await breaker.recordStartFailure("agent-1", { launchId: "launch-try", reason: "model_not_found", nowMs: tryAt + 2_000 })).outcome, "ignored", "once per try");
  assert.deepEqual(await breaker.recordStartSucceeded("agent-1", "launch-try"), { changed: true, unpaused: false }, "a late readiness of that try no longer lifts it");
  assert.equal(await breaker.isBlocked("agent-1"), true);
});

test("a try that times out again keeps the doubling self-retry; a plain block never notifies when told not to", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
  await pauseOnStartTimeouts(breaker, 0);
  await breaker.recordStart("agent-1", "launch-try", PAUSE_RETRY_BASE_MS);
  const again = await breaker.recordStartFailure("agent-1", { launchId: "launch-try", reason: "runtime_start_timeout", nowMs: PAUSE_RETRY_BASE_MS + 1 });
  assert.equal(again.outcome, "ignored");
  assert.equal(again.pauseRetryAtMs, 3 * PAUSE_RETRY_BASE_MS);

  const other = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
  await other.recordStart("agent-1", "launch-1", 0);
  const blocked = await other.recordStartFailure("agent-1", { launchId: "launch-1", reason: "model_not_configured", nowMs: 1, noticeFingerprint: "f", noticeOnBlock: false });
  assert.equal(blocked.outcome, "blocked");
  assert.equal(blocked.notify, false);
  assert.equal(blocked.alreadyNotified, false, "a block that tells no one was not skipped as already told");
});

test("a transient failure of the try is just a failed try: the doubled retry stands, the pause keeps its reason, nobody is told", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
  await pauseOnStartTimeouts(breaker, 0);
  await breaker.recordStart("agent-1", "launch-try", PAUSE_RETRY_BASE_MS);
  for (const [reason, lookupReason] of [
    ["runner_credential_mint_failed", undefined],
    ["runtime_spawn_failed", undefined],
    ["provider_connection_materialization_failed", undefined],
    ["agent_proxy_bind_failed", undefined],
    ["runtime_not_found", "lookup_timed_out"],
    ["runtime_not_found", "lookup_failed"],
  ] as const) {
    const failed = await breaker.recordStartFailure("agent-1", {
      launchId: "launch-try",
      reason,
      ...(lookupReason ? { lookupReason } : {}),
      nowMs: PAUSE_RETRY_BASE_MS + 1,
      noticeFingerprint: `${reason}:codex:m`,
      noticeOnBlock: false,
    });
    assert.equal(failed.outcome, "ignored", reason);
    assert.equal(failed.notify, false, reason);
    assert.equal(failed.pauseRetryAtMs, 3 * PAUSE_RETRY_BASE_MS, `${reason}: the doubled try stands`);
  }
  assert.deepEqual(await breaker.automaticWakeHold("agent-1", PAUSE_RETRY_BASE_MS + 2), { kind: "blocked", reason: "runtime_start_timeout" });
});

test("a malformed API key, a known-bad runtime version, a confirmed missing runtime or a missing model on the try ends the self-retry", async () => {
  for (const [reason, lookupReason] of [
    ["provider_api_key_invalid", undefined],
    ["runtime_version_too_old", undefined],
    ["runtime_not_found", "not_on_path"],
    // Tries are >=27 minutes apart: the first model_not_found is already the confirmation.
    ["model_not_found", undefined],
  ] as const) {
    const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
    await pauseOnStartTimeouts(breaker, 0);
    await breaker.recordStart("agent-1", "launch-try", PAUSE_RETRY_BASE_MS);
    const ended = await breaker.recordStartFailure("agent-1", {
      launchId: "launch-try",
      reason,
      ...(lookupReason ? { lookupReason } : {}),
      nowMs: PAUSE_RETRY_BASE_MS + 1,
      noticeFingerprint: `${reason}:codex:m`,
      noticeOnBlock: false,
    });
    assert.equal(ended.outcome, "pause_retry_ended", reason);
    assert.equal(ended.pauseRetryAtMs, null, reason);
    assert.equal(ended.notify, true, reason);
    assert.deepEqual(await breaker.automaticWakeHold("agent-1", 100 * PAUSE_RETRY_MAX_MS), { kind: "blocked", reason });
  }
});

test("the RFC 071 ownership of the try's failure is checked before the self-retry can end", () => {
  const paused: WakeCrashLoopEpisodeState = {
    ...freshWakeCrashLoopEpisode(1),
    blocked: true,
    needsActionReason: "runtime_start_timeout",
    lastStartLaunchId: "launch-try",
    pauseRetryLaunchId: "launch-try",
    pauseRetryAtMs: 5_000,
    pauseRetryCooldownMs: 1_000,
    startFailureOwnedLaunchId: "launch-try",
  };
  const applied = applyWakeCrashLoopStartFailure(paused, { launchId: "launch-try", reason: "runtime_login_required", nowMs: 1 });
  assert.equal(applied.outcome, "owned_by_terminal_breaker");
  assert.equal(applied.state.pauseRetryAtMs, 5_000, "the self-retry stands");
});

test("a runtime error that needs the owner during the try ends the self-retry and tells the owner once", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
  await pauseOnStartTimeouts(breaker, 0);
  // During the cooldown, an error of an older launch changes nothing.
  assert.equal((await breaker.recordActionRequired("agent-1", { launchId: "launch-5", reason: "user_reauth", fingerprint: "f", nowMs: 1 })).outcome, "already_blocked");
  await breaker.recordStart("agent-1", "launch-try", PAUSE_RETRY_BASE_MS);
  const ended = await breaker.recordActionRequired("agent-1", { launchId: "launch-try", reason: "user_reauth", fingerprint: "f", nowMs: PAUSE_RETRY_BASE_MS + 1 });
  assert.deepEqual(ended, { outcome: "pause_retry_ended", notify: true, previousPauseReason: "runtime_start_timeout" });
  assert.equal(await breaker.pauseRetryAtMs("agent-1"), null);
  assert.deepEqual(await breaker.automaticWakeHold("agent-1", 100 * PAUSE_RETRY_MAX_MS), { kind: "blocked", reason: "user_reauth" });
  assert.equal((await breaker.recordActionRequired("agent-1", { launchId: "launch-try", reason: "user_reauth", fingerprint: "f", nowMs: PAUSE_RETRY_BASE_MS + 2 })).outcome, "already_blocked", "once");
});

test("#proj-raft-computer:#46: a successful sign-in lifts only a sign-in block, keeping the owed catch-up; any other block stays", async () => {
  const reauth = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await reauth.recordStart("agent-1", "launch-1", 1_000);
  assert.equal((await reauth.recordActionRequired("agent-1", { launchId: "launch-1", reason: "user_reauth", fingerprint: "auth-f", nowMs: 1_500 })).outcome, "blocked");
  await reauth.markActionRequiredNotified("agent-1", "auth-f");
  assert.deepEqual(await reauth.automaticWakeHold("agent-1", 2_000), { kind: "blocked", reason: "user_reauth" });
  assert.equal(await reauth.liftForCredentialsChange("agent-1"), true);
  assert.equal(await reauth.automaticWakeHold("agent-1", 2_000), null, "the next wake starts the agent");
  assert.equal(await reauth.isCatchupOwed("agent-1"), true);
  // The new account failing too is news to the owner.
  await reauth.recordStart("agent-1", "launch-2", 3_000);
  assert.equal((await reauth.recordActionRequired("agent-1", { launchId: "launch-2", reason: "user_reauth", fingerprint: "auth-f", nowMs: 3_500 })).notify, true);
  assert.equal(await reauth.liftForCredentialsChange("agent-2"), false, "an agent with no block");

  const startLogin = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await startLogin.recordStart("agent-1", "launch-1", 1_000);
  await startLogin.recordStartFailure("agent-1", { launchId: "launch-1", reason: "runtime_login_required", nowMs: 1_500 });
  assert.deepEqual(await startLogin.automaticWakeHold("agent-1", 2_000), { kind: "blocked", reason: "runtime_login_required" });
  assert.equal(await startLogin.liftForCredentialsChange("agent-1"), true);
  assert.equal(await startLogin.automaticWakeHold("agent-1", 2_000), null);

  for (const [kind, block] of [
    ["model access", (b: WakeCrashLoopBreaker) => b.recordActionRequired("agent-1", { launchId: "launch-1", reason: "user_model_access", fingerprint: "m", nowMs: 1_500 })],
    ["start failure", (b: WakeCrashLoopBreaker) => b.recordStartFailure("agent-1", { launchId: "launch-1", reason: "model_not_configured", nowMs: 1_500 })],
  ] as const) {
    const other = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
    await other.recordStart("agent-1", "launch-1", 1_000);
    await block(other);
    const before = await other.automaticWakeHold("agent-1", 2_000);
    assert.equal(before?.kind, "blocked", kind);
    assert.equal(await other.liftForCredentialsChange("agent-1"), false, kind);
    assert.deepEqual(await other.automaticWakeHold("agent-1", 2_000), before, kind);
  }
});

test("#proj-raft-computer:#48 (step 4b): a credential restored lifts only a block of the same reason, keeping the owed catch-up", async () => {
  const blockedFor = async (reason: "user_reauth" | "user_model_access") => {
    const b = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
    await b.recordStart("agent-1", "launch-1", 1_000);
    assert.equal((await b.recordActionRequired("agent-1", { launchId: "launch-1", reason, fingerprint: "f", nowMs: 1_500 })).outcome, "blocked");
    return b;
  };

  const reauth = await blockedFor("user_reauth");
  assert.equal(await reauth.liftForCredentialRestored("agent-1", "billing"), false, "a billing balance restored says nothing about the sign-in");
  assert.equal(await reauth.liftForCredentialRestored("agent-1", "user_model_access"), false);
  assert.deepEqual(await reauth.automaticWakeHold("agent-1", 2_000), { kind: "blocked", reason: "user_reauth" });
  assert.equal(await reauth.liftForCredentialRestored("agent-1", "user_reauth"), true);
  assert.equal(await reauth.automaticWakeHold("agent-1", 2_000), null, "the next wake starts the agent");
  assert.equal(await reauth.isCatchupOwed("agent-1"), true);
  assert.equal(await reauth.liftForCredentialRestored("agent-1", "user_reauth"), false, "nothing left to lift");

  const modelAccess = await blockedFor("user_model_access");
  assert.equal(await modelAccess.liftForCredentialRestored("agent-1", "user_reauth"), false);
  assert.equal(await modelAccess.liftForCredentialRestored("agent-1", "user_model_access"), true);

});

test("step 4b: a restored sign-in (user_reauth) also lifts a start's runtime_login_required block; plan access or billing restored does not", async () => {
  const startLogin = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await startLogin.recordStart("agent-1", "launch-1", 1_000);
  await startLogin.recordStartFailure("agent-1", { launchId: "launch-1", reason: "runtime_login_required", nowMs: 1_500 });
  for (const reason of ["user_model_access", "billing"] as const) {
    assert.equal(await startLogin.liftForCredentialRestored("agent-1", reason), false, reason);
    assert.deepEqual(await startLogin.automaticWakeHold("agent-1", 2_000), { kind: "blocked", reason: "runtime_login_required" }, reason);
  }
  assert.equal(await startLogin.liftForCredentialRestored("agent-1", "user_reauth"), true);
  assert.equal(await startLogin.automaticWakeHold("agent-1", 2_000), null);
  assert.equal(await startLogin.isCatchupOwed("agent-1"), true);
});

test("a manual stop reports the block it lifted, for the trace", async () => {
  const b = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await b.recordStart("agent-1", "launch-1", 1_000);
  assert.deepEqual(await b.recordManualStop("agent-1"), { liftedBlock: null });
  await b.recordStart("agent-1", "launch-2", 2_000);
  await b.recordActionRequired("agent-1", { launchId: "launch-2", reason: "user_reauth", fingerprint: "f", nowMs: 2_500 });
  assert.deepEqual(await b.recordManualStop("agent-1"), { liftedBlock: { reason: "user_reauth" } });
  assert.equal(await b.automaticWakeHold("agent-1", 3_000), null);
});

// Reconciler step 12 (#proj-raft-computer:#48, decision 3). Every round below
// is start → readiness (`recordStartSucceeded`, the server's handling of
// `agent:runtime:ready`) → the runtime's failure: readiness resets the
// failed-start count, so a reason counted toward START_FAILURE_THRESHOLD
// would never pause. RED proof (reverse-verified): drop
// `runtime_repeated_failure` from DAEMON_COUNTED_START_FAILURE_REASONS, or
// `model_unsupported` from NON_RETRYABLE_SPAWN_FAILURE_REASONS, and the
// message-driven wakes below start the agent every time.
/** Message-driven wakes: each one starts the agent unless the breaker refuses; each start gets ready, then fails with `reason`. */
async function wakesAfterReadyFailures(breaker: WakeCrashLoopBreaker, reason: string, wakes: number, startAtMs = 1_000): Promise<number> {
  let starts = 0;
  for (let i = 1; i <= wakes; i += 1) {
    const nowMs = startAtMs + i * 1_000;
    if (await breaker.automaticWakeHold("agent-1", nowMs)) continue;
    starts += 1;
    await breaker.recordStart("agent-1", `launch-${i}`, nowMs);
    await breaker.recordStartSucceeded("agent-1", `launch-${i}`);
    await breaker.recordStartFailure("agent-1", { launchId: `launch-${i}`, reason, nowMs: nowMs + 500 });
  }
  return starts;
}

test("step 12: a failure after readiness of a reason the daemon counted, or of an unsupported model, pauses at its first report; a plain failed start never would", async () => {
  for (const reason of ["model_unsupported", "runtime_repeated_failure", "session_needs_reset"]) {
    const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
    assert.equal(await wakesAfterReadyFailures(breaker, reason, 20), 1, `${reason}: one start, then paused`);
    assert.deepEqual(await breaker.automaticWakeHold("agent-1", 30_000), { kind: "blocked", reason }, reason);
  }
  // The hole decision 3 closes: the same rounds with the old reason never pause.
  const legacy = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
  assert.equal(await wakesAfterReadyFailures(legacy, "runtime_spawn_failed", 20), 20);
});

test("step 12: an unsupported model waits for a person, a config change or a new credential; repeated failures retry by themselves", async () => {
  const model = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
  await wakesAfterReadyFailures(model, "model_unsupported", 1);
  assert.equal(await model.pauseRetryAtMs("agent-1"), null, "no self-retry");
  assert.deepEqual(await model.automaticWakeHold("agent-1", 100 * PAUSE_RETRY_MAX_MS), { kind: "blocked", reason: "model_unsupported" });

  const repeated = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
  await wakesAfterReadyFailures(repeated, "runtime_repeated_failure", 1);
  assert.equal(await repeated.pauseRetryAtMs("agent-1"), 2_500 + PAUSE_RETRY_BASE_MS);
  assert.equal(await repeated.automaticWakeHold("agent-1", 2_500 + PAUSE_RETRY_BASE_MS), null, "the cooldown ran out: one wake may try");
});

test("step 12: a self-retrying try that gets ready and then fails the same way re-pauses with its doubled cooldown, so tries keep doubling", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), { pauseRetryBaseMs: 1_000, ...NO_JITTER });
  await breaker.recordStart("agent-1", "launch-1", 0);
  await breaker.recordStartSucceeded("agent-1", "launch-1");
  await breaker.recordStartFailure("agent-1", { launchId: "launch-1", reason: "runtime_repeated_failure", nowMs: 100 });
  let due = (await breaker.pauseRetryAtMs("agent-1"))!;
  /** Each pause's cooldown: from its failure to its try. */
  const cooldowns = [due - 100];
  for (let n = 1; n <= 4; n += 1) {
    assert.equal(await breaker.automaticWakeHold("agent-1", due), null, `try ${n} is due`);
    await breaker.recordStart("agent-1", `launch-try-${n}`, due);
    assert.deepEqual(await breaker.recordStartSucceeded("agent-1", `launch-try-${n}`), { changed: true, unpaused: true }, "readiness lifts the pause");
    const failed = await breaker.recordStartFailure("agent-1", { launchId: `launch-try-${n}`, reason: "runtime_repeated_failure", nowMs: due + 10 });
    assert.equal(failed.outcome, "blocked", `try ${n} re-pauses`);
    cooldowns.push(failed.pauseRetryAtMs! - (due + 10));
    due = failed.pauseRetryAtMs!;
  }
  assert.deepEqual(cooldowns, [1_000, 2_000, 4_000, 8_000, 16_000]);
  // A later start (a person's) forgets the ready try: its own failure pauses from the base again.
  await breaker.recordStart("agent-1", "launch-human", due + 1, { human: true });
  await breaker.recordStartSucceeded("agent-1", "launch-human");
  const fresh = await breaker.recordStartFailure("agent-1", { launchId: "launch-human", reason: "runtime_repeated_failure", nowMs: due + 2 });
  assert.equal(fresh.pauseRetryAtMs, due + 2 + 1_000);
});

test("step 12: a new credential or plan lifts a model_unsupported pause (a web login, a working sign-in or plan access restored); billing restored does not", async () => {
  const paused = async () => {
    const b = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
    await wakesAfterReadyFailures(b, "model_unsupported", 1);
    return b;
  };
  const login = await paused();
  assert.equal(await login.liftForCredentialsChange("agent-1"), true);
  assert.equal(await login.automaticWakeHold("agent-1", 5_000), null);
  assert.equal(await login.isCatchupOwed("agent-1"), true);
  for (const reason of ["user_reauth", "user_model_access"] as const) {
    const restored = await paused();
    assert.equal(await restored.liftForCredentialRestored("agent-1", reason), true, reason);
    assert.equal(await restored.automaticWakeHold("agent-1", 5_000), null, reason);
  }
  const billing = await paused();
  assert.equal(await billing.liftForCredentialRestored("agent-1", "billing"), false);
  const config = await paused();
  assert.equal(await config.liftForConfigChange("agent-1"), true, "a model change is a config change");
  const human = await paused();
  await human.recordStart("agent-1", "launch-human", 5_000, { human: true });
  assert.equal(await human.automaticWakeHold("agent-1", 5_001), null);
  // A repeated-failure pause is about the runtime, not the credential.
  const repeated = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
  await wakesAfterReadyFailures(repeated, "runtime_repeated_failure", 1);
  assert.equal(await repeated.liftForCredentialsChange("agent-1"), false);
});

test("step 15 PR 3: a sign-in seen on disk (scope sign_in) lifts the sign-in pauses only, never a model_unsupported or other pause", async () => {
  const reauth = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
  await reauth.recordStart("agent-1", "launch-1", 1_000);
  await reauth.recordActionRequired("agent-1", { launchId: "launch-1", reason: "user_reauth", fingerprint: "f", nowMs: 1_500 });
  assert.equal(await reauth.liftForCredentialsChange("agent-1", "sign_in"), true);
  assert.equal(await reauth.automaticWakeHold("agent-1", 2_000), null);
  assert.equal(await reauth.isCatchupOwed("agent-1"), true, "the owed catch-up is kept");

  const startLogin = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
  await startLogin.recordStart("agent-1", "launch-1", 1_000);
  await startLogin.recordStartFailure("agent-1", { launchId: "launch-1", reason: "runtime_login_required", nowMs: 1_500 });
  assert.equal(await startLogin.liftForCredentialsChange("agent-1", "sign_in"), true, "a start's login-required is a sign-in pause");

  // A changed file may be a token refresh of the same account and plan.
  const model = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
  await wakesAfterReadyFailures(model, "model_unsupported", 1);
  assert.equal(await model.liftForCredentialsChange("agent-1", "sign_in"), false);
  assert.deepEqual(await model.automaticWakeHold("agent-1", 5_000), { kind: "blocked", reason: "model_unsupported" });
  for (const reason of ["user_model_access", "billing"] as const) {
    const other = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), NO_JITTER);
    await other.recordStart("agent-1", "launch-1", 1_000);
    await other.recordActionRequired("agent-1", { launchId: "launch-1", reason, fingerprint: "f", nowMs: 1_500 });
    assert.deepEqual(await other.automaticWakeHold("agent-1", 2_000), { kind: "blocked", reason }, reason);
    assert.equal(await other.liftForCredentialsChange("agent-1", "sign_in"), false, reason);
  }
});

describe("step 12 follow-up: a repeated-failure pause tells the owner once when its cooldown reaches the cap", () => {
  const quarter = PAUSE_RETRY_MAX_MS / 4;
  /** A breaker whose repeated-failure pause starts at a quarter of the cap: tries at 1/2, then the cap. */
  const pausedForRepeatedFailure = async () => {
    const store = new InMemoryWakeCrashLoopStateStore();
    const breaker = new WakeCrashLoopBreaker(store, { pauseRetryBaseMs: quarter, ...NO_JITTER });
    await breaker.recordStart("agent-1", "launch-1", 0);
    await breaker.recordStartSucceeded("agent-1", "launch-1");
    const first = await breaker.recordStartFailure("agent-1", { launchId: "launch-1", reason: "runtime_repeated_failure", nowMs: 100 });
    assert.equal(first.pauseRetryCapNoticeDue, false);
    return { store, breaker };
  };
  /** One try: due start, ready, then the same failure again. Returns the failure's result. */
  const failedTry = async (breaker: WakeCrashLoopBreaker, launchId: string) => {
    const due = (await breaker.pauseRetryAtMs("agent-1"))!;
    await breaker.recordStart("agent-1", launchId, due);
    await breaker.recordStartSucceeded("agent-1", launchId);
    return breaker.recordStartFailure("agent-1", { launchId, reason: "runtime_repeated_failure", nowMs: due + 10 });
  };
  const climbToCap = async (breaker: WakeCrashLoopBreaker, tag: string) => {
    assert.equal((await failedTry(breaker, `${tag}-try-1`)).pauseRetryCapNoticeDue, false, "half the cap: not yet");
    return failedTry(breaker, `${tag}-try-2`);
  };

  test("the first failed try at the cap asks once; staying at the cap does not ask again", async () => {
    const { store, breaker } = await pausedForRepeatedFailure();
    const atCap = await climbToCap(breaker, "a");
    assert.equal(store.getWakeCrashLoopStateSync("agent-1")!.state.pauseRetryCooldownMs, PAUSE_RETRY_MAX_MS);
    assert.equal(atCap.pauseRetryCapNoticeDue, true, "first reach of the cap");
    // Not posted yet (no owner, a failed post): asked again on the next failed try.
    assert.equal((await failedTry(breaker, "a-try-3")).pauseRetryCapNoticeDue, true);
    assert.equal(await breaker.markPauseRetryCapNotified("agent-1"), true);
    assert.equal(store.getWakeCrashLoopStateSync("agent-1")!.state.pauseRetryCapNotified, true);
    assert.equal((await failedTry(breaker, "a-try-4")).pauseRetryCapNoticeDue, false, "still at the cap: told already");
    // A try that fails without getting ready (a transient failure) is not news either.
    const due = (await breaker.pauseRetryAtMs("agent-1"))!;
    await breaker.recordStart("agent-1", "a-try-5", due);
    const transient = await breaker.recordStartFailure("agent-1", { launchId: "a-try-5", reason: "runtime_spawn_failed", nowMs: due + 10 });
    assert.equal(transient.outcome, "ignored");
    assert.equal(transient.pauseRetryCapNoticeDue, false);
  });

  test("a transient failure of the try at the cap also asks, the first time", async () => {
    const { breaker } = await pausedForRepeatedFailure();
    await failedTry(breaker, "t-try-1");
    const due = (await breaker.pauseRetryAtMs("agent-1"))!;
    await breaker.recordStart("agent-1", "t-try-2", due);
    const transient = await breaker.recordStartFailure("agent-1", { launchId: "t-try-2", reason: "runtime_spawn_failed", nowMs: due + 10 });
    assert.equal(transient.outcome, "ignored");
    assert.equal(transient.pauseRetryCapNoticeDue, true);
  });

  test("recovery forgets the notice; climbing to the cap again asks once again", async () => {
    const { store, breaker } = await pausedForRepeatedFailure();
    await climbToCap(breaker, "a");
    await breaker.markPauseRetryCapNotified("agent-1");
    // The next try gets ready and keeps running; a later ordinary start ends the chain.
    const due = (await breaker.pauseRetryAtMs("agent-1"))!;
    await breaker.recordStart("agent-1", "a-try-ok", due);
    assert.equal((await breaker.recordStartSucceeded("agent-1", "a-try-ok")).unpaused, true);
    assert.equal(store.getWakeCrashLoopStateSync("agent-1")!.state.pauseRetryCapNotified, true, "a ready try alone may still fail back into the cap");
    await breaker.recordStart("agent-1", "b-1", due + 1_000);
    assert.equal(store.getWakeCrashLoopStateSync("agent-1")!.state.pauseRetryCapNotified, false, "recovered");
    await breaker.recordStartSucceeded("agent-1", "b-1");
    const again = await breaker.recordStartFailure("agent-1", { launchId: "b-1", reason: "runtime_repeated_failure", nowMs: due + 2_000 });
    assert.equal(again.pauseRetryAtMs, due + 2_000 + quarter, "the cooldown starts over");
    assert.equal(again.pauseRetryCapNoticeDue, false);
    assert.equal((await climbToCap(breaker, "b")).pauseRetryCapNoticeDue, true, "the cap again is news again");
  });

  test("a human start, a manual stop or a config change forgets the notice", async () => {
    for (const recover of ["human", "stop", "config"] as const) {
      const { store, breaker } = await pausedForRepeatedFailure();
      await climbToCap(breaker, "a");
      await breaker.markPauseRetryCapNotified("agent-1");
      if (recover === "human") await breaker.recordStart("agent-1", "h-1", 1e9, { human: true });
      else if (recover === "stop") await breaker.recordManualStop("agent-1");
      else assert.equal(await breaker.liftForConfigChange("agent-1"), true);
      assert.notEqual(store.getWakeCrashLoopStateSync("agent-1")!.state.pauseRetryCapNotified, true, recover);
    }
  });

  test("a start-timeout pause at the cap does not ask (it has its own notice); a mark after recovery is not written", async () => {
    const timeouts = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore(), { pauseRetryBaseMs: PAUSE_RETRY_MAX_MS, ...NO_JITTER });
    let last: Awaited<ReturnType<WakeCrashLoopBreaker["recordStartFailure"]>> | null = null;
    for (let i = 1; i <= START_FAILURE_THRESHOLD; i += 1) {
      await timeouts.recordStart("agent-1", `launch-${i}`, i * 1_000);
      last = await timeouts.recordStartFailure("agent-1", { launchId: `launch-${i}`, reason: "runtime_start_timeout", nowMs: i * 1_000 + 500 });
    }
    assert.equal(last!.outcome, "blocked");
    assert.equal(last!.pauseRetryCapNoticeDue, false);

    const { breaker } = await pausedForRepeatedFailure();
    await climbToCap(breaker, "a");
    await breaker.recordStart("agent-1", "h-1", 1e9, { human: true });
    assert.equal(await breaker.markPauseRetryCapNotified("agent-1"), false, "the post raced a recovery: not recorded");
  });
});
