import assert from "node:assert/strict";
import { test } from "vitest";

import {
  applyRunnerReset,
  canSpawn,
  exitTrigger,
  nextRunnerStateOnExit,
  rehydrateRunnerRecord,
  RUNNER_TRIGGER,
  type RunnerRecord,
} from "./runnerStateMachine.js";
import { RUNNER_STATE_VALUES, type RunnerState } from "./state.js";
import type { ChildExitClass } from "../service.js";

// Runner supervision state machine (RFC v9.8 §3.2 transition surface).
//
// Coverage anchors:
//   - nextRunnerStateOnExit: exhaustive {exitClass} × {budgetBreached}.
//   - exitTrigger: trace label agrees with the state transition.
//   - canSpawn: the pure spawn-eligibility table that replaces the old
//     `children.has && restarting.has` guard, incl. the backoff window
//     that structurally kills the double-spawn race.
//   - rehydrateRunnerRecord: degraded survives a service boot (durable
//     degrade → no respawn), the daemon-upgrade-compat-relevant case.

const SERVER = "11111111-1111-4111-8111-111111111111";
const EXIT_CLASSES: ChildExitClass[] = ["graceful", "config-error", "already-running", "unlinked-terminal", "crash"];

function rec(partial: Partial<RunnerRecord>): RunnerRecord {
  return { serverId: SERVER, lifecycle: "stopped", stopping: false, ...partial };
}

test("nextRunnerStateOnExit — exhaustive exitClass × budget", () => {
  assert.equal(nextRunnerStateOnExit("config-error", false), "degraded");
  assert.equal(nextRunnerStateOnExit("config-error", true), "degraded");
  assert.equal(nextRunnerStateOnExit("already-running", false), "running");
  assert.equal(nextRunnerStateOnExit("already-running", true), "running");
  assert.equal(nextRunnerStateOnExit("unlinked-terminal", false), "degraded");
  assert.equal(nextRunnerStateOnExit("unlinked-terminal", true), "degraded");
  assert.equal(nextRunnerStateOnExit("crash", false), "crashed");
  assert.equal(nextRunnerStateOnExit("crash", true), "degraded");
  assert.equal(nextRunnerStateOnExit("graceful", false), "stopped");
  assert.equal(nextRunnerStateOnExit("graceful", true), "stopped");
});

test("nextRunnerStateOnExit — total over every exitClass (no undefined)", () => {
  for (const ec of EXIT_CLASSES) {
    for (const breached of [false, true]) {
      const s = nextRunnerStateOnExit(ec, breached);
      assert.ok(
        (RUNNER_STATE_VALUES as readonly RunnerState[]).includes(s),
        `${ec}/${breached} → ${s} must be a valid RunnerState`,
      );
    }
  }
});

test("exitTrigger — agrees with the transition and is kebab-case", () => {
  assert.equal(exitTrigger("config-error", false), RUNNER_TRIGGER.exitConfigError);
  assert.equal(exitTrigger("already-running", false), RUNNER_TRIGGER.exitAlreadyRunning);
  assert.equal(exitTrigger("unlinked-terminal", false), RUNNER_TRIGGER.exitUnlinked);
  assert.equal(exitTrigger("crash", false), RUNNER_TRIGGER.exitCrash);
  assert.equal(exitTrigger("crash", true), RUNNER_TRIGGER.exitCrashDegraded);
  assert.equal(exitTrigger("graceful", false), RUNNER_TRIGGER.exitGraceful);
  for (const v of Object.values(RUNNER_TRIGGER)) {
    assert.match(v, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, `${v} must be kebab-case (§5.5)`);
  }
});

test("canSpawn — unwanted server is never spawned", () => {
  assert.equal(canSpawn(undefined, false, 1000), false);
  assert.equal(canSpawn(rec({ lifecycle: "crashed" }), false, 1000), false);
  assert.equal(canSpawn(rec({ lifecycle: "stopped" }), false, 1000), false);
});

test("canSpawn — fresh wanted server (no record) spawns", () => {
  assert.equal(canSpawn(undefined, true, 1000), true);
});

test("canSpawn — a live child blocks a second spawn (idempotency)", () => {
  // `child` present ⇔ a live daemon is registered; never spawn a second.
  const live = rec({ lifecycle: "running", child: {} as RunnerRecord["child"] });
  assert.equal(canSpawn(live, true, 1000), false);
});

test("canSpawn — only crashed/stopped resting states are eligible", () => {
  assert.equal(canSpawn(rec({ lifecycle: "crashed" }), true, 1000), true);
  assert.equal(canSpawn(rec({ lifecycle: "stopped" }), true, 1000), true);
  // starting = spawn already in flight; running = up; degraded = parked.
  assert.equal(canSpawn(rec({ lifecycle: "starting" }), true, 1000), false);
  assert.equal(canSpawn(rec({ lifecycle: "running" }), true, 1000), false);
  assert.equal(canSpawn(rec({ lifecycle: "degraded" }), true, 1000), false);
});

test("canSpawn — degraded is never eligible without going through reset", () => {
  // No backoff can make a degraded runner spawnable — only `reset` (which
  // clears health.json → rehydrate/transition to a resting state) can.
  assert.equal(canSpawn(rec({ lifecycle: "degraded", backoffUntil: 0 }), true, 9_999_999), false);
});

test("canSpawn — backoff window blocks respawn, then opens (kills the race)", () => {
  const backoffUntil = 5_000;
  const crashedMidBackoff = rec({ lifecycle: "crashed", backoffUntil });
  // During the backoff the runner is crashed-with-future-deadline → the
  // periodic reconcile must NOT spawn it (this is the old double-spawn
  // race, now structurally impossible without a side `restarting` set).
  assert.equal(canSpawn(crashedMidBackoff, true, backoffUntil - 1), false);
  // Deadline reached → eligible.
  assert.equal(canSpawn(crashedMidBackoff, true, backoffUntil), true);
  assert.equal(canSpawn(crashedMidBackoff, true, backoffUntil + 1), true);
});

test("canSpawn — crashed/stopped with no backoff is immediately eligible", () => {
  assert.equal(canSpawn(rec({ lifecycle: "crashed" }), true, 0), true);
  assert.equal(canSpawn(rec({ lifecycle: "stopped" }), true, 0), true);
});

test("rehydrateRunnerRecord — degraded survives boot (no respawn)", () => {
  const r = rehydrateRunnerRecord(SERVER, true);
  assert.equal(r.lifecycle, "degraded");
  assert.equal(r.stopping, false);
  assert.equal(r.child, undefined);
  // The boot reconcile must not respawn a rehydrated-degraded runner.
  assert.equal(canSpawn(r, true, Number.MAX_SAFE_INTEGER), false);
});

test("rehydrateRunnerRecord — healthy server boots as stopped+spawnable", () => {
  const r = rehydrateRunnerRecord(SERVER, false);
  assert.equal(r.lifecycle, "stopped");
  assert.equal(canSpawn(r, true, 0), true);
});

test("applyRunnerReset — degraded → stopped + clears backoff, becomes spawnable (the ② sync)", () => {
  // The single-writer side of reset: post-②, spawn-eligibility is the
  // in-memory lifecycle, so a degraded cache must be un-parked or the
  // runner never respawns until a service restart. Reset transitions it to
  // stopped so the next reconcile respawns it.
  const r = rec({ lifecycle: "degraded", backoffUntil: 999_999 });
  assert.equal(canSpawn(r, true, Number.MAX_SAFE_INTEGER), false); // parked while degraded
  assert.equal(applyRunnerReset(r), true);
  assert.equal(r.lifecycle, "stopped");
  assert.equal(r.backoffUntil, undefined);
  assert.equal(canSpawn(r, true, 0), true); // now respawnable without a restart
});

test("applyRunnerReset — non-degraded runners are untouched (reset never kills/respawns a healthy one)", () => {
  for (const lifecycle of ["running", "starting", "crashed", "stopped"] as const) {
    const r = rec({ lifecycle, child: lifecycle === "running" ? ({} as RunnerRecord["child"]) : undefined });
    assert.equal(applyRunnerReset(r), false, `${lifecycle} must be a no-op`);
    assert.equal(r.lifecycle, lifecycle);
  }
});
