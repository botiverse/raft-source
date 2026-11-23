// Wake-recycle start-failure fallback on the OAR host (#wg-ax:#3):
// when a wake-recycled OAR start fails before startup readiness (open failure,
// or process exit before any model output), the server's prior session is not
// overwritten, the failure is recorded in the shared WakeRecycleFailureMemory,
// and the next wake resumes the prior session instead of looping on recycle.
// Once a recycled session reaches readiness, its new session id is reported.
import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentConfig } from "@botiverse/raft-shared";
import { WakeRecycleFailureMemory } from "../wakeSessionRecycle";
import { ExitStreaks } from "../planExit";
import { harness, makeConfig, message, request, until, withFailure, type Harness } from "../testing/oarAgentHostHarness";

const HOUR_MS = 60 * 60_000;
const OLD_SESSION = "sess-oar-prior";
const SMALL_THRESHOLD = { RAFT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS: "50" };

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig =>
  makeConfig({ sessionId: OLD_SESSION, envVars: SMALL_THRESHOLD, wakeRecycleOar: true, ...overrides });

async function seedColdSummary(h: Harness, offset: { ms: number }): Promise<void> {
  assert.deepEqual(await h.host.start(request({ launchId: "launch-seed", config: config(), wakeMessage: message("m-seed") })), { kind: "started" });
  await until(() => h.framesOf("agent:turn:ended").length > 0, "seed turn ended");
  await until(() => h.sessions[0]!.status().value.kind === "idle", "seed idle");
  await h.host.stopAgent("agent-1", { wait: true, silent: true });
  offset.ms = 2 * HOUR_MS;
}

test("#wg-ax:#3: OAR open failure on a recycled start records failure and next wake resumes prior session", async () => {
  const offset = { ms: 0 };
  const failures = new WakeRecycleFailureMemory();
  let failNextOpen = false;
  const h = await harness({
    deps: {
      now: () => Date.now() + offset.ms,
      wakeRecycleFailures: failures,
    },
    openGate: () => {
      if (!failNextOpen) return undefined;
      failNextOpen = false;
      return Promise.reject(new Error("simulated open timeout"));
    },
  });
  try {
    await seedColdSummary(h, offset);

    // Next wake tries to recycle OLD_SESSION -> open fails before commit.
    failNextOpen = true;
    h.waiting.set("agent-1", ["launch-recycle-fail"]);
    const outcome = await h.host.start(request({ launchId: "launch-recycle-fail", config: config(), wakeMessage: message("m-2") }));
    assert.equal(outcome.kind, "fallback");
    assert.equal(outcome.request.config.sessionId, OLD_SESSION, "fallback preserves prior session");
    assert.equal(failures.hasFailed("agent-1", OLD_SESSION), true, "shared failure memory records OLD_SESSION");
    assert.equal(h.events.some((e) => e.name === "daemon.agent.wake_recycle.start_failed" && e.attrs.host === "oar"), true);

    // Subsequent wake on OAR sees the failed recycle and resumes OLD_SESSION without re-recycling.
    h.waiting.set("agent-1", ["launch-resume"]);
    assert.deepEqual(await h.host.start(request({ launchId: "launch-resume", config: config(), wakeMessage: message("m-3") })), { kind: "started" });
    assert.equal(h.opened.at(-1)!.options.resume, OLD_SESSION, "resumes prior session");
    assert.equal(
      h.events.some((e) => e.name === "daemon.agent.wake_recycle_skipped" && e.attrs.reason === "prior_recycle_start_failed"),
      true,
    );
  } finally {
    await h.cleanup();
  }
});

test("#wg-ax:#3: OAR recycled start holds agent:session until readiness and reports it once output arrives", async () => {
  const offset = { ms: 0 };
  const failures = new WakeRecycleFailureMemory();
  let releaseTurn!: () => void;
  const secondTurnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
  let gateSecondTurn = false;
  const h = await harness({
    deps: {
      now: () => Date.now() + offset.ms,
      wakeRecycleFailures: failures,
    },
    turn: async (turn) => {
      if (gateSecondTurn) {
        gateSecondTurn = false;
        await secondTurnGate;
      }
      turn.say("done");
    },
  });
  try {
    await seedColdSummary(h, offset);
    const sessionsBeforeRecycle = h.framesOf("agent:session").length;

    // Recycled start commits, but stays unready while turn 1 has emitted no output yet.
    gateSecondTurn = true;
    h.waiting.set("agent-1", ["launch-recycle-1"]);
    assert.deepEqual(await h.host.start(request({ launchId: "launch-recycle-1", config: config(), wakeMessage: message("m-2") })), { kind: "started" });
    assert.equal(h.opened[1]!.options.resume, undefined, "started fresh recycled session");
    assert.equal(h.framesOf("agent:session").length, sessionsBeforeRecycle, "new session id is held until readiness");

    // Once output arrives (readiness), the new session id is reported once and prior session is retired.
    releaseTurn();
    await until(() => h.framesOf("agent:session").length === sessionsBeforeRecycle + 1, "new session reported on output");
    const reportedAfterReady = h.framesOf("agent:session");
    assert.notEqual(reportedAfterReady.at(-1)!.sessionId, OLD_SESSION);
    assert.equal(failures.hasFailed("agent-1", OLD_SESSION), false);
  } finally {
    await h.cleanup();
  }
});

test("#wg-ax:#3: OAR recycled session exiting before any model output preserves prior session and next wake resumes it", async () => {
  const offset = { ms: 0 };
  const failures = new WakeRecycleFailureMemory();
  let crashNextTurn = false;
  const h = await harness({
    deps: {
      now: () => Date.now() + offset.ms,
      wakeRecycleFailures: failures,
    },
    turn: async (turn) => {
      if (crashNextTurn) {
        crashNextTurn = false;
        turn.exit(1);
        return;
      }
      turn.say("done");
    },
  });
  try {
    await seedColdSummary(h, offset);
    const sessionsBeforeRecycle = h.framesOf("agent:session").length;

    crashNextTurn = true;
    h.waiting.set("agent-1", ["launch-recycle-crash"]);
    assert.deepEqual(await h.host.start(request({ launchId: "launch-recycle-crash", config: config(), wakeMessage: message("m-2") })), { kind: "started" });
    await until(() => failures.hasFailed("agent-1", OLD_SESSION), "failed recycle recorded on early exit");
    assert.equal(h.framesOf("agent:session").length, sessionsBeforeRecycle, "unready crashed session was never reported to server");
    await h.host.unwound("agent-1");

    // Next wake resumes OLD_SESSION without re-recycling.
    h.waiting.set("agent-1", ["launch-resume-after-crash"]);
    assert.deepEqual(await h.host.start(request({ launchId: "launch-resume-after-crash", config: config(), wakeMessage: message("m-3") })), { kind: "started" });
    assert.equal(h.opened.at(-1)!.options.resume, OLD_SESSION, "resumes prior session after early crash");
    assert.equal(
      h.events.some((e) => e.name === "daemon.agent.wake_recycle_skipped" && e.attrs.reason === "prior_recycle_start_failed"),
      true,
    );
  } finally {
    await h.cleanup();
  }
});

test("#wg-ax:#3: OAR fallback restart carries sameStartInputs to resumed prior session and does not consume noteSessionReset", async () => {
  const offset = { ms: 0 };
  const failures = new WakeRecycleFailureMemory();
  const exitStreaks = new ExitStreaks();
  let failRecycledInputTooLarge = false;
  const h = await harness({
    deps: {
      now: () => Date.now() + offset.ms,
      wakeRecycleFailures: failures,
      exitStreaks,
    },
    wrapSession: (session) => withFailure(session, "input_too_large"),
    turn: async (turn) => {
      if (failRecycledInputTooLarge) {
        failRecycledInputTooLarge = false;
        throw new Error("maximum context length exceeded");
      }
      turn.say("done");
    },
  });
  try {
    await seedColdSummary(h, offset);

    // Recycled start hits sticky `input_too_large` before any output ->
    // `replaceSession` -> `restartAfterEnd` must resume OLD_SESSION with the
    // original wake message ("m-keep-me") and NOT burn `noteSessionReset`.
    failRecycledInputTooLarge = true;
    h.waiting.set("agent-1", ["launch-recycle-sticky"]);
    assert.deepEqual(await h.host.start(request({ launchId: "launch-recycle-sticky", config: config(), wakeMessage: message("m-keep-me", { content: "keep-this-wake-text" }) })), { kind: "started" });
    await until(() => h.opened.length >= 3, "fallback restart opened on prior session");
    assert.equal(h.opened[2]!.options.resume, OLD_SESSION, "fallback restart resumes prior session");
    await until(() => h.inputs.length >= 3, "fallback restart delivered first input");
    assert.match(h.inputs[2]!, /keep-this-wake-text/, "resumed prior session receives original wake message");
    assert.equal(exitStreaks.sticky.sessionReset("agent-1"), null, "fallback does not burn the one automatic session reset");
    assert.equal(h.framesOf("agent:session:invalidate").length, 0, "unreported recycled session is not invalidated");
  } finally {
    await h.cleanup();
  }
});
