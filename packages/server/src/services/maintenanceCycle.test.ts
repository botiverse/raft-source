import assert from "node:assert/strict";
import {
  MAINTENANCE_CYCLE_CHECK_INTERVAL_MS,
  MAINTENANCE_CYCLE_CLAIM_TTL_MS,
  MAINTENANCE_CYCLE_FIRST_CHECK_MIN_MS,
  maintenanceCycleFirstDelayMs,
  maintenanceCycleNextDelayMs,
  memoryMaintenanceCycleClaim,
  startMaintenanceCycle,
  type MaintenanceCycleClaim,
  type MaintenanceCycleTimers,
} from "./maintenanceCycle";

/** Timers driven by hand: `advance` fires due callbacks in time order. */
function manualTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: MaintenanceCycleTimers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    now: () => now,
    pendingCount: () => pending.size,
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        // Let the check's claim promise and its reschedule settle.
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      }
      now = until;
    },
  };
}

/** One claim shared by several replicas, as Redis would be. */
function sharedClaim(now: () => number): MaintenanceCycleClaim {
  return memoryMaintenanceCycleClaim(now);
}

test("first check is between 10 s and one interval after start; later checks are the interval ± 20 %", () => {
  assert.equal(maintenanceCycleFirstDelayMs(0), MAINTENANCE_CYCLE_FIRST_CHECK_MIN_MS);
  assert.ok(maintenanceCycleFirstDelayMs(0.999999) < MAINTENANCE_CYCLE_FIRST_CHECK_MIN_MS + MAINTENANCE_CYCLE_CHECK_INTERVAL_MS);
  assert.equal(maintenanceCycleNextDelayMs(0), MAINTENANCE_CYCLE_CHECK_INTERVAL_MS * 0.8);
  assert.ok(maintenanceCycleNextDelayMs(0.999999) < MAINTENANCE_CYCLE_CHECK_INTERVAL_MS * 1.2);
});

test("a dozen replicas started together run the cycle once, not a dozen times", async () => {
  const clock = manualTimers();
  const claim = sharedClaim(clock.now);
  let runs = 0;
  const handles = Array.from({ length: 12 }, (_, i) => startMaintenanceCycle({
    run: () => { runs += 1; },
    claim,
    timers: clock.timers,
    random: () => (i + 0.5) / 12,
    log: { error: () => {} },
  }));
  await clock.advance(MAINTENANCE_CYCLE_FIRST_CHECK_MIN_MS + MAINTENANCE_CYCLE_CHECK_INTERVAL_MS);
  assert.equal(runs, 1);
  for (const handle of handles) handle.stop();
});

test("the cycle runs about once per claim TTL across replicas, for hours", async () => {
  const clock = manualTimers();
  const claim = sharedClaim(clock.now);
  const runsAt: number[] = [];
  let seed = 0;
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const handles = Array.from({ length: 12 }, () => startMaintenanceCycle({
    run: () => { runsAt.push(clock.now()); },
    claim,
    timers: clock.timers,
    random,
    log: { error: () => {} },
  }));
  const hours = 10;
  await clock.advance(hours * 60 * 60_000);
  // At most one per TTL, and never a gap longer than the TTL plus one late check.
  assert.ok(runsAt.length <= Math.ceil((hours * 60 * 60_000) / MAINTENANCE_CYCLE_CLAIM_TTL_MS) + 1, `ran ${runsAt.length} times`);
  for (let i = 1; i < runsAt.length; i += 1) {
    const gap = runsAt[i]! - runsAt[i - 1]!;
    assert.ok(gap >= MAINTENANCE_CYCLE_CLAIM_TTL_MS, `gap ${gap}`);
    assert.ok(gap <= MAINTENANCE_CYCLE_CLAIM_TTL_MS + MAINTENANCE_CYCLE_CHECK_INTERVAL_MS * 1.2, `gap ${gap}`);
  }
  for (const handle of handles) handle.stop();
});

test("a claim that cannot be read skips the check, and the next check tries again", async () => {
  const clock = manualTimers();
  let failNext = true;
  const claim: MaintenanceCycleClaim = {
    async claim() {
      if (failNext) {
        failNext = false;
        throw new Error("redis down");
      }
      return true;
    },
  };
  const errors: unknown[] = [];
  let runs = 0;
  const handle = startMaintenanceCycle({
    run: () => { runs += 1; },
    claim,
    timers: clock.timers,
    random: () => 0,
    log: { error: (...args: unknown[]) => { errors.push(args); } },
  });
  assert.equal(await handle.check(), "claim_failed");
  assert.equal(runs, 0);
  assert.equal(errors.length, 1);
  assert.equal(await handle.check(), "ran");
  assert.equal(runs, 1);
  handle.stop();
});

test("stop cancels the pending check", async () => {
  const clock = manualTimers();
  let runs = 0;
  const handle = startMaintenanceCycle({
    run: () => { runs += 1; },
    claim: memoryMaintenanceCycleClaim(clock.now),
    timers: clock.timers,
    random: () => 0,
  });
  handle.stop();
  assert.equal(clock.pendingCount(), 0);
  await clock.advance(MAINTENANCE_CYCLE_CHECK_INTERVAL_MS * 3);
  assert.equal(runs, 0);
});
