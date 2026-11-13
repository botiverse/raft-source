// Reconciler step 10b (#proj-raft-computer:#48, rows D1-D5 and D6; Tenny msg
// 89e55a48 item 3): an OAR session's end is planned by the legacy host's rule
// (`planExit`, from the facts the OAR host reads) and acted on here: start now,
// start after the crash streak's backoff, the next wake (the server's), or a
// hand-off at the cap. The crash streaks live in the store both hosts share
// (`ExitStreaks`).
//
// Parity: every `PLAN_EXIT_CASES` row OAR can express is driven through a real
// OAR exit (the scripted runtime) and must plan what the legacy host plans for
// the same row; the rows it cannot express are listed with the reason.
//
// RED proof (reverse-verified): carry nothing into the restart
// (`restartAfterEnd` starts with `carried: []`) and "a clean exit with held
// deliveries" finds no delivery in the next session's first input; read no
// recoverable class (`exitFacts` `recoverableError: null`) and "a 30 min
// provider outage" plans its first close as a crash (D5, counted toward the
// cap), not a D3 close; restart at once under a provider limit (Tenny,
// review of #13336) and "a provider limit's wait" starts 15 times in 500 ms;
// read no D6 on OAR (`zeroEvidenceTurn: false`) and "D6 on OAR" plans clean
// exits that start again at once, never handed off.
import assert from "node:assert/strict";
import type { Event, EventObserver, EventsOptions, FailedTurn, FailureClass, Session } from "@botiverse/oar";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import type { AgentDeliveryContext } from "./agentLifecycleHost";
import type { OarAgentHostDeps } from "./oarAgentHost";
import { AgentLifecycleRecords } from "../agentLifecycleRecord";
import { ExitStreaks, formatZeroEvidenceStreakMessage, planExit, type ExitFacts, type ExitPlan } from "../planExit";
import { ProviderLimitLedger, providerLimitCredentialKey } from "../providerLimitLedger";
import { PLAN_EXIT_CASES } from "../testing/planExitCases";
import { harness, makeConfig, message, request, sleep, until, type Harness } from "../testing/oarAgentHostHarness";

/** What a test does to one OAR session: its exit code, its failed turns' class, a runtime that answers `busy`. */
interface SessionControl {
  exitCode: number | null;
  failure: FailureClass;
  refusePrompts: boolean;
  /** The runtime process ends on its own with `code`. */
  exit(code: number | null): Promise<void>;
}

/**
 * A scripted session the test can end with any exit code (the scripted
 * runtime's own exit is 0) whose failed turns carry `failure` (it reports
 * only `unknown`), and which can answer every prompt `busy`, so deliveries
 * stay held by an idle session.
 */
function controlled(session: Session, controls: SessionControl[], failure: FailureClass): Session {
  const control: SessionControl = {
    exitCode: 0,
    failure,
    refusePrompts: false,
    exit: async (code) => {
      control.exitCode = code;
      await session.dispose();
    },
  };
  controls.push(control);
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === "events") {
        return (observer: EventObserver, options?: EventsOptions) => target.events((event: Event) => {
          if (event.kind === "exited") {
            observer({ ...event, code: control.exitCode });
            return;
          }
          if (event.kind === "turn_ended" && event.outcome.kind === "failed") {
            observer({ ...event, outcome: { kind: "failed", failure: control.failure, reason: event.outcome.reason } as FailedTurn });
            return;
          }
          observer(event);
        }, options);
      }
      if (property === "prompt") {
        return (input: string, options?: unknown) => (control.refusePrompts
          ? Promise.resolve({ kind: "rejected", code: "busy", reason: "a turn is running" })
          : (target.prompt as (input: string, options?: unknown) => Promise<unknown>)(input, options));
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function exitHarness(options: {
  turns: Array<(turn: ScriptedTurn) => void | Promise<void>>;
  failure?: FailureClass;
  deps?: Partial<OarAgentHostDeps>;
  /** A session opened while this says so exits 0 on its own right after it opens. */
  exitOnOpen?: () => boolean;
}): Promise<{ h: Harness; controls: SessionControl[]; streaks: ExitStreaks; ledger: ProviderLimitLedger }> {
  const controls: SessionControl[] = [];
  const streaks = new ExitStreaks();
  const ledger = new ProviderLimitLedger();
  let index = 0;
  const h = await harness({
    turn: async (turn) => {
      const script = options.turns[Math.min(index, options.turns.length - 1)]!;
      index += 1;
      await script(turn);
    },
    wrapSession: (session) => {
      const wrapped = controlled(session, controls, options.failure ?? "unknown");
      const control = controls.at(-1)!;
      if (options.exitOnOpen?.()) setTimeout(() => { void control.exit(0); }, 30);
      return wrapped;
    },
    deps: { exitStreaks: streaks, providerLimits: ledger, providerLimitBackoff: { baseMs: 10_000, maxMs: 300_000, jitterRatio: 0 }, ...options.deps },
  });
  return { h, controls, streaks, ledger };
}

const planned = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.exit.planned").map((event) => event.attrs);
const scheduled = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.oar.restart_scheduled").map((event) => event.attrs);
const handOffs = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.spawn.local_restart_stopped").map((event) => event.attrs);
const firstInputs = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.oar.first_input").map((event) => event.attrs);

/** The session's turn has ended and it is idle. */
async function idle(h: Harness, sessions: number): Promise<void> {
  await until(() => h.sessions.length === sessions && h.inputs.length >= sessions, `session ${sessions}'s turn`);
  await until(() => h.sessions[sessions - 1]!.status().value.kind === "idle", `session ${sessions} idle`);
}

/** A held delivery whose mention transitions, ack and rejection are counted. */
function mentionContext(id: string, seen: string[]): AgentDeliveryContext {
  return {
    deliveryId: `occ-${id}`,
    mentionDelivery: { occurrenceId: `occ-${id}`, messageId: id, machineId: "machine-1", launchId: "launch-1", sessionId: "s" } as never,
    onMentionTransition: (stage, outcome) => { seen.push(`${id}:${stage}:${outcome}`); },
    onMentionAck: () => { seen.push(`${id}:ack`); },
    onRejectedNoProcess: () => { seen.push(`${id}:rejected_no_process`); },
  };
}

const fail = (reason: string) => (turn: ScriptedTurn) => { void turn; throw new Error(reason); };
const answer = (turn: ScriptedTurn) => { turn.say("ok"); };

// ── Parity with the legacy host (Tenny item 3.5) ─────────────────────────────

/** Rows OAR cannot express, and why. Every other row runs below. */
const OAR_INEXPRESSIBLE: Record<string, string> = {
  "a deferred delivery does not wake (pending, not waking)": "the OAR host defers no delivery: every non-transient delivery it holds wakes the agent",
  "an unclassified provider stream failure: the next wake, counted": "OAR's failure text is read for both the recoverable class and the stream failure; text that names a stream failure is the recoverable stream class (D3), so no OAR exit has a stream failure without a class",
  "an unclassified provider stream failure counts toward the cap: the fifth is handed off": "as above: no unclassified stream failure on OAR",
  "known resume error: a new session, now": "no known resume error after the commit: a resume OAR refuses at open hands the start to the legacy host before it commits",
  "a sticky failure is a crash, never held": "OAR's sticky failures (input too large, an unusable model) end the session through E1 (`terminal_runtime_error`), never an exit",
  "turn end (process per turn), work queued: start now": "no OAR runtime runs a process per turn",
  "turn end after a live runtime error: a crash": "no OAR runtime runs a process per turn",
  "cold-idle stop with the credential invalid: held (step 6)": "the OAR host ends a session for its spec only when it is idle with nothing held (agentNotIdle), so never with work queued",
  "a person's turn interrupt: clean, a stale error ignored, never an early crash": "an OAR turn interrupt aborts the turn; the session keeps running",
  "start timeout cleanup: its own backoff, never clean even on exit 0": "no start timeout on OAR: a session that does not open hands the start to the legacy host before the commit",
  "start timeout with a provider error: the recoverable close": "as above: no start timeout on OAR",
  "startup request error cleanup: the server's next start, the streak reset": "no startup request cleanup on OAR (an open failure hands the start back before the commit)",
  "a turn that did nothing, nothing queued: counted, and the next wake": "on OAR's persistent sessions D6 is an exit with work held and no model output (Tenny, review of #13336): with nothing held, an exit 0 starts nothing, so it is an ordinary D2 and cannot loop",
  "stopped while starting: the stop's own end, no special case": "a stop before the commit ends no session (nothing to plan); it ends the streaks directly (the explicit stop test)",
};

/** The OAR failure (class and the runtime's words) that gives an exit the row's runtime error and recoverable class. */
function rowFailure(facts: ExitFacts): { failure: FailureClass; reason: string } | null {
  switch (facts.recoverableError) {
    case "provider_server_error": return { failure: "provider", reason: "upstream error" };
    case "provider_connection_error": return { failure: "unknown", reason: "Unable to connect to API (ECONNRESET)" };
    case "rate_limited": return { failure: "unknown", reason: "429 Too Many Requests" };
    case "provider_stream_error": return { failure: "unknown", reason: "stream closed before response.completed" };
    default: return facts.runtimeError ? { failure: "unknown", reason: "something went wrong while loading the conversation" } : null;
  }
}

/**
 * Drives one exit with the row's facts on the OAR host and returns its plan
 * (`daemon.agent.exit.planned`). OAR reads a turn that did nothing (D6) as a
 * session exit with work held and no model output, so a row whose clean exit
 * with work queued is not D6 (`zeroEvidenceTurn: false`) runs a session that
 * said something: on OAR that is the evidence.
 */
async function oarPlanFor(facts: ExitFacts): Promise<Record<string, unknown>> {
  let clock = facts.nowMs - facts.uptimeMs;
  const failure = rowFailure(facts);
  const evidence = facts.modelOutput
    || (!facts.zeroEvidenceTurn && facts.inbox.wakes && facts.code === 0 && facts.expectedTermination === null);
  const { h, controls, streaks, ledger } = await exitHarness({
    turns: [(turn) => {
      if (evidence) turn.say("partial answer");
      if (failure) throw new Error(failure.reason);
    }],
    failure: failure?.failure ?? "unknown",
    deps: { now: () => clock, providerLimitBackoff: { baseMs: facts.backoff.baseMs, maxMs: facts.backoff.maxMs, jitterRatio: 0 } },
  });
  try {
    await h.host.start(request({ config: makeConfig({ sessionId: facts.session.resumedSessionId }) }));
    await idle(h, 1);
    // The exit's moment: the streaks, the early-crash record and the credential as the row has them.
    clock = facts.nowMs;
    streaks.setStreaks("agent-1", facts.crashStreak, facts.capStreak);
    streaks.setResumeFailureRecord("agent-1", facts.session.resumeFailures);
    const key = providerLimitCredentialKey("agent-1", makeConfig());
    if (facts.credential.invalid) ledger.recordInvalid(key, { invalidReason: "user_reauth", recordedAtMs: clock }, { host: "legacy" });
    if (facts.credential.limitUntilMs !== null) {
      ledger.record(key, { attempts: 1, reason: "rate_limited", untilMs: facts.credential.limitUntilMs, providerLimitKind: "quota_exhausted", recordedAtMs: clock }, { host: "legacy" });
    }
    if (facts.inbox.wakes) {
      controls[0]!.refusePrompts = true;
      await h.host.deliverMessage("agent-1", message("m-queued"), {});
      await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery"), "the delivery held");
    }
    if (facts.expectedTermination === "explicit_stop") await h.host.stopAgent("agent-1");
    // The spec stop of an idle session (the cold-idle stop's OAR form).
    else if (facts.expectedTermination === "cold_idle_recycle") h.host.applyServerFeatures({ enabledApps: ["artifacts"] });
    else await controls[0]!.exit(facts.code);
    await until(() => planned(h).length > 0, "the exit planned");
    assert.equal(planned(h)[0]!.expected_termination ?? null, facts.expectedTermination, "the same end");
    return planned(h)[0]!;
  } finally {
    await h.cleanup();
  }
}

/** What the parity compares: kind, start, hold, session choice, streaks, hand-off. */
function comparable(plan: ExitPlan): Record<string, unknown> {
  return {
    plan_kind: plan.kind,
    plan_start: typeof plan.start === "string" ? plan.start : "after",
    plan_start_after_ms: typeof plan.start === "string" ? undefined : plan.start.afterMs,
    plan_hold: plan.hold ?? undefined,
    plan_session: plan.session.kind === "new" ? `new:${plan.session.reason}` : plan.session.kind,
    plan_session_cause: plan.session.kind === "new" && plan.session.reason === "resume_failed" ? plan.session.cause : undefined,
    crash_streak: plan.crashStreak,
    cap_streak: plan.capStreak,
    hand_to_server: plan.handToServer || undefined,
  };
}

function pick(attrs: Record<string, unknown>): Record<string, unknown> {
  const keys = ["plan_kind", "plan_start", "plan_start_after_ms", "plan_hold", "plan_session", "plan_session_cause", "crash_streak", "cap_streak", "hand_to_server"];
  return Object.fromEntries(keys.map((key) => [key, attrs[key]]));
}

const SPECIAL_ROWS = new Set(["stall replacement: start now with the queued work", "cold-idle (and spec) stop: clean, a stale error ignored"]);

test("parity: every PLAN_EXIT_CASES row is run on the OAR host or listed with the reason it cannot be expressed", () => {
  const names = PLAN_EXIT_CASES.map((row) => row.name);
  for (const name of Object.keys(OAR_INEXPRESSIBLE)) assert.ok(names.includes(name), `listed row exists: ${name}`);
  const run = names.filter((name) => !(name in OAR_INEXPRESSIBLE));
  // The counts, exactly: a new row must be run here or listed with a reason.
  assert.deepEqual({ total: names.length, run: run.length, inexpressible: Object.keys(OAR_INEXPRESSIBLE).length }, { total: 54, run: 40, inexpressible: 14 });
});

describe("parity: an OAR exit plans what the legacy host plans for the same row", () => {
  for (const row of PLAN_EXIT_CASES) {
    if (row.name in OAR_INEXPRESSIBLE || SPECIAL_ROWS.has(row.name)) continue;
    test(`${row.row}: ${row.name}`, async () => {
      assert.deepEqual(pick(await oarPlanFor(row.facts)), comparable(planExit(row.facts)));
    });
  }

  test("stalled_recovery: stall replacement: start now with the queued work", async () => {
    const row = PLAN_EXIT_CASES.find((each) => each.name === "stall replacement: start now with the queued work")!;
    const hang = (turn: ScriptedTurn) => new Promise<void>((resolve) => { turn.signal.addEventListener("abort", () => resolve(), { once: true }); });
    const { h } = await exitHarness({ turns: [hang, answer], deps: { stalledWithWorkThresholds: { stallMs: 100, nonStdinAliveStallMs: 250 } } });
    try {
      await h.host.start(request());
      await until(() => h.sessions[0]?.status().value.kind === "running", "the first turn running");
      await h.host.deliverMessage("agent-1", message("m-queued"), {});
      await until(() => planned(h).length > 0, "the stall planned");
      assert.equal(planned(h)[0]!.expected_termination, "stalled_recovery");
      assert.deepEqual(pick(planned(h)[0]!), comparable(planExit(row.facts)));
    } finally {
      await h.cleanup();
    }
  });

  test("cold_idle_recycle: cold-idle (and spec) stop: clean, a stale error ignored", async () => {
    const row = PLAN_EXIT_CASES.find((each) => each.name === "cold-idle (and spec) stop: clean, a stale error ignored")!;
    const { h } = await exitHarness({ turns: [fail("something went wrong")] });
    try {
      await h.host.start(request());
      await idle(h, 1);
      // The spec stop of an idle session whose last turn failed (the error is stale).
      h.host.applyServerFeatures({ enabledApps: ["artifacts"] });
      await until(() => planned(h).length > 0, "the spec stop planned");
      assert.equal(planned(h)[0]!.expected_termination, "cold_idle_recycle");
      assert.equal(planned(h)[0]!.oar_failure, "unknown", "the live error was read");
      assert.deepEqual(pick(planned(h)[0]!), comparable(planExit(row.facts)));
    } finally {
      await h.cleanup();
    }
  });
});

// ── The OAR host acting on the plan ──────────────────────────────────────────

test("D1: a clean exit with held deliveries starts again at once on the same session; the deliveries are taken once", async () => {
  const { h, controls } = await exitHarness({ turns: [answer] });
  try {
    await h.host.start(request());
    await idle(h, 1);
    const seen: string[] = [];
    let plainRejected = 0;
    controls[0]!.refusePrompts = true;
    await h.host.deliverMessage("agent-1", message("m-plain"), { onRejectedNoProcess: () => { plainRejected += 1; } });
    await h.host.deliverMessage("agent-1", message("m-mention"), mentionContext("m-mention", seen));
    await until(() => seen.includes("m-mention:daemon_pending:accepted"), "held: the runtime answered busy");
    await controls[0]!.exit(0);

    await idle(h, 2);
    assert.deepEqual(pick(planned(h)[0]!), { ...pick({}), plan_kind: "clean", plan_start: "now", plan_session: "resume", crash_streak: 0, cap_streak: 0 });
    assert.deepEqual(scheduled(h).map((attrs) => ({ cause: attrs.cause, delay_ms: attrs.delay_ms, carried_count: attrs.carried_count })), [{ cause: "exit", delay_ms: 0, carried_count: 2 }]);
    assert.equal(h.opened[1]!.options.resume, h.sessions[0]!.id, "the same session, resumed");
    assert.equal(firstInputs(h)[1]!.carried_deliveries, 2, "both in the next session's first input");
    const spawned = h.framesOf("agent:process_spawned");
    assert.equal(spawned.length, 2);
    assert.equal(spawned[1]!.launchId, "launch-1");
    assert.equal(spawned[1]!.respawn, true);
    const types = h.frames.map((frame) => frame.type);
    assert.ok(types.indexOf("agent:process_exited") < types.lastIndexOf("agent:process_spawned"), types.join(","));
    assert.deepEqual(h.framesOf("agent:status").map((frame) => frame.status), ["active", "active"], "never shown stopped");
    // Taken once: drained and acked once, never handed back to the server.
    assert.deepEqual(seen, ["m-mention:daemon_received:accepted", "m-mention:daemon_pending:accepted", "m-mention:daemon_drained:accepted", "m-mention:ack"]);
    assert.equal(plainRejected, 0);
    assert.equal(h.events.some((event) => event.name === "daemon.agent.oar.held_dropped"), false);
    await sleep(100);
    assert.equal(h.inputs.length, 2, "no second turn for them");
    assert.equal(h.host.owns("agent-1"), true);
  } finally {
    await h.cleanup();
  }
});

test("D3: a provider-class crash with held deliveries starts again after the crash backoff, kept active meanwhile", async () => {
  const { h, controls, streaks } = await exitHarness({
    turns: [fail("Unable to connect to API (ECONNRESET)"), answer],
    deps: { providerLimitBackoff: { baseMs: 300, maxMs: 300_000, jitterRatio: 0 } },
  });
  try {
    await h.host.start(request());
    await idle(h, 1);
    const seen: string[] = [];
    controls[0]!.refusePrompts = true;
    await h.host.deliverMessage("agent-1", message("m-mention"), mentionContext("m-mention", seen));
    const exitedAt = Date.now();
    await controls[0]!.exit(1);

    assert.deepEqual(pick(planned(h)[0]!), { ...pick({}), plan_kind: "recoverable", plan_start: "after", plan_start_after_ms: 300, plan_session: "resume", crash_streak: 1, cap_streak: 0 });
    assert.equal(streaks.crashStreak("agent-1"), 1);
    assert.equal(h.host.owns("agent-1"), true, "the restart holds the agent while it waits");
    assert.equal(h.host.getAgentStartAcceptance("agent-1").queueState, "starting");
    assert.deepEqual(h.framesOf("agent:status").map((frame) => frame.status), ["active", "active"], "kept active, as the legacy host keeps a D3 close");
    assert.match(h.framesOf("agent:activity").at(-1)!.detail, /^Crashed \(exit code 1\); restarting in 1 s$/);
    await sleep(150);
    assert.equal(h.sessions.length, 1, "not before the backoff");

    await idle(h, 2);
    assert.ok(Date.now() - exitedAt >= 300, `restarted after ${Date.now() - exitedAt}ms`);
    assert.equal(firstInputs(h)[1]!.carried_deliveries, 1);
    assert.deepEqual(seen.filter((entry) => entry.endsWith(":ack") || entry.endsWith("rejected_no_process")), ["m-mention:ack"], "taken once, never handed back");
    // The provider answered: the streak ended.
    assert.equal(streaks.crashStreak("agent-1"), 0);
    assert.ok(h.events.some((event) => event.name === "daemon.agent.runtime_error_process_restart.reset" && event.attrs.host === "oar"));
  } finally {
    await h.cleanup();
  }
});

test("no double start: a server start during the backoff rebinds onto the waiting restart; one session runs, with its wake and the held work", async () => {
  const { h, controls } = await exitHarness({
    turns: [fail("upstream error"), answer],
    failure: "provider",
    deps: { providerLimitBackoff: { baseMs: 300, maxMs: 300_000, jitterRatio: 0 } },
  });
  try {
    await h.host.start(request());
    await idle(h, 1);
    controls[0]!.refusePrompts = true;
    await h.host.deliverMessage("agent-1", message("m-held"), {});
    await controls[0]!.exit(1);
    assert.equal(planned(h)[0]!.plan_kind, "recoverable");

    // The server's start for a new message, while the restart waits.
    h.waiting.set("agent-1", ["launch-2"]);
    assert.deepEqual(await h.host.start(request({ launchId: "launch-2", wakeMessage: message("m-wake") })), { kind: "rebound" });
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.start_rebound" && event.attrs.committed === false));

    await idle(h, 2);
    await sleep(400);
    assert.equal(h.opened.length, 2, "one new session, not two");
    assert.equal(firstInputs(h)[1]!.carried_deliveries, 2, "the held work and the server start's wake, in one first input");
    const spawned = h.framesOf("agent:process_spawned");
    assert.equal(spawned.length, 2);
    assert.equal(spawned[1]!.launchId, "launch-2", "the server's launch names the one process");
    assert.equal(h.inputs.length, 2);
  } finally {
    await h.cleanup();
  }
});

test("D3 is never capped on OAR: a 30 min provider outage backs off to 5 min and keeps trying; the held work runs once the provider is back", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let outage = true;
  const { h, controls, streaks } = await exitHarness({
    turns: [(turn) => {
      if (outage) throw new Error("upstream error");
      turn.say("ok");
    }],
    failure: "provider",
  });
  // Bounded by real time (performance.now is not faked): the launch's file
  // work runs on real I/O, however far the fake clock is.
  const settle = async (check: () => boolean, what: string) => {
    const deadline = performance.now() + 10_000;
    while (!check() && performance.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(5);
    }
    if (!check()) throw new Error(`timed out waiting for ${what}`);
  };
  try {
    const seen: string[] = [];
    await h.host.start(request());
    const outageEndsAt = Date.now() + 30 * 60_000;
    let closes = 0;
    for (;;) {
      await settle(() => h.sessions.length === closes + 1 && h.sessions[closes]!.status().value.kind === "idle" && h.inputs.length === closes + 1, `session ${closes + 1}'s failed turn`);
      // Each session holds a new message when it exits.
      controls[closes]!.refusePrompts = true;
      await h.host.deliverMessage("agent-1", message(`m-${closes}`), mentionContext(`m-${closes}`, seen));
      await controls[closes]!.exit(1);
      closes += 1;
      await settle(() => planned(h).length === closes, `close ${closes} planned`);
      const plan = planned(h).at(-1)!;
      assert.equal(plan.plan_kind, "recoverable");
      assert.equal(plan.cap_streak, 0, "a provider close never counts toward the cap");
      const afterMs = plan.plan_start_after_ms as number;
      // The provider answers again from the restart after the outage's end.
      if (Date.now() + afterMs >= outageEndsAt) outage = false;
      await vi.advanceTimersByTimeAsync(afterMs);
      if (!outage) break;
    }
    assert.ok(closes >= 9, `closes: ${closes}`);
    assert.deepEqual(planned(h).map((attrs) => attrs.plan_start_after_ms).slice(0, 7), [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    assert.deepEqual(handOffs(h), [], "never handed to the server");
    assert.equal(h.framesOf("agent:activity").some((frame) => "spawnFailure" in frame), false);
    assert.equal(h.framesOf("agent:status").some((frame) => frame.status === "inactive"), false, "never shown stopped");

    // The provider is back: the next session takes the held message and answers.
    await settle(() => h.sessions.length === closes + 1 && h.framesOf("agent:runtime:outcome").length > 0, "the recovered session's answer");
    assert.equal(streaks.crashStreak("agent-1"), 0, "model output ended the streak");
    // Every message was taken by exactly one session's first input, once.
    assert.equal(seen.filter((entry) => entry.endsWith(":ack")).length, closes);
    assert.equal(seen.some((entry) => entry.endsWith("rejected_no_process")), false);
  } finally {
    vi.useRealTimers();
    await h.cleanup();
  }
});

test("D5 capped: the fifth unclassified crash in a row is handed to the server: local_restart_stopped, a failed start, a visible error; a held mention is left to the server", async () => {
  const { h, controls } = await exitHarness({ turns: [fail("Error: something went wrong while loading the conversation")] });
  try {
    const seen: string[] = [];
    for (let crash = 1; crash <= 5; crash += 1) {
      await h.host.start(request({ launchId: `launch-${crash}` }));
      await idle(h, crash);
      if (crash === 5) {
        controls[4]!.refusePrompts = true;
        await h.host.deliverMessage("agent-1", message("m-mention"), mentionContext("m-mention", seen));
      }
      await controls[crash - 1]!.exit(1);
      await until(() => planned(h).length === crash, `crash ${crash} planned`);
      await h.host.unwound("agent-1");
      assert.equal(h.host.owns("agent-1"), false, "D5: the next wake is the server's");
    }
    assert.deepEqual(planned(h).map((attrs) => [attrs.plan_kind, attrs.plan_start, attrs.cap_streak, attrs.hand_to_server]), [
      ["crash", "next_wake", 1, undefined],
      ["crash", "next_wake", 2, undefined],
      ["crash", "next_wake", 3, undefined],
      ["crash", "next_wake", 4, undefined],
      ["crash", "none", 5, true],
    ]);
    assert.deepEqual(scheduled(h), [], "never restarted locally");
    const stopped = handOffs(h);
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0]!.source, "process_close");
    assert.equal(stopped[0]!.attempts, 5);
    assert.equal(stopped[0]!.exit_code, 1);
    assert.equal(stopped[0]!.host, "oar");
    assert.equal(stopped[0]!.runtime_error_reported, true);
    const detail = "Grok Build crashed 5 times in a row (last: exit code 1). Raft stopped restarting it; restart the agent to try again.";
    const failedStart = h.framesOf("agent:activity").find((frame) => "spawnFailure" in frame && frame.spawnFailure);
    assert.deepEqual(failedStart?.spawnFailure, { reason: "runtime_spawn_failed" });
    assert.equal(failedStart?.detail, detail);
    const last = h.framesOf("agent:activity").at(-1)!;
    assert.equal(last.detailKind, "runtime_error");
    assert.equal(last.detail, detail);
    assert.equal(last.runtimeError?.requiredAction, undefined, "Restart is the way out");
    const statuses = h.framesOf("agent:status");
    assert.ok(statuses.at(-2)!.status === "inactive" && statuses.at(-2)!.exit, "the exit, for the early-exit breaker");
    assert.equal(statuses.at(-1)!.status, "inactive");
    // Left to the server (its held cycle and breakers), as on the legacy host.
    assert.equal(seen.includes("m-mention:rejected_no_process"), false);
  } finally {
    await h.cleanup();
  }
});

test("D4: a second early crash of a resumed session starts a new session at once; the server forgets the old one", async () => {
  const { h, controls, streaks } = await exitHarness({ turns: [fail("Error: something went wrong while loading the conversation")] });
  try {
    const resumed = request({ config: makeConfig({ sessionId: "s-1" }), wakeMessage: message("m-wake") });
    await h.host.start(resumed);
    await idle(h, 1);
    await controls[0]!.exit(1);
    await until(() => planned(h).length === 1, "the first early crash");
    assert.deepEqual([planned(h)[0]!.plan_kind, planned(h)[0]!.plan_start, planned(h)[0]!.early_crash_counted], ["crash", "next_wake", true]);
    assert.deepEqual(streaks.resumeFailureRecord("agent-1"), { sessionId: "s-1", count: 1 });
    await h.host.unwound("agent-1");

    // The server's next start resumes it again; it crashes early again.
    await h.host.start({ ...resumed, launchId: "launch-2" });
    await idle(h, 2);
    await controls[1]!.exit(1);
    await until(() => planned(h).length === 2, "the second early crash");
    assert.deepEqual(pick(planned(h)[1]!), { ...pick({}), plan_kind: "resume_failed", plan_start: "now", plan_session: "new:resume_failed", plan_session_cause: "repeated_early_crash", crash_streak: 2, cap_streak: 2 });
    assert.deepEqual(h.framesOf("agent:session:invalidate").map((frame) => ({ sessionId: frame.sessionId, reason: frame.reason })), [{ sessionId: "s-1", reason: "repeated_early_crash" }]);
    assert.ok(h.events.some((event) => event.name === "daemon.runtime.resume_failed" && event.attrs.fell_back_fresh === true));
    await until(() => h.opened.length === 3, "the new session");
    assert.equal(h.opened[0]!.options.resume, "s-1");
    assert.equal(h.opened[1]!.options.resume, "s-1");
    assert.equal(h.opened[2]!.options.resume, undefined, "a new session");
    assert.equal(streaks.resumeFailureRecord("agent-1"), null);
    assert.ok(h.framesOf("agent:activity").some((frame) => frame.detail === "Stored Grok Build session keeps crashing on resume; starting a new session…"));
  } finally {
    await h.cleanup();
  }
});

test("an explicit stop starts nothing and ends the crash streaks and the early-crash record", async () => {
  const { h, controls, streaks } = await exitHarness({ turns: [answer] });
  try {
    await h.host.start(request());
    await idle(h, 1);
    streaks.setStreaks("agent-1", 3, 2);
    streaks.setResumeFailureRecord("agent-1", { sessionId: "s-0", count: 1 });
    controls[0]!.refusePrompts = true;
    await h.host.deliverMessage("agent-1", message("m-held"), {});
    await h.host.stopAgent("agent-1", { wait: true });
    assert.deepEqual(pick(planned(h)[0]!), { ...pick({}), plan_kind: "stopped", plan_start: "none", plan_session: "resume", crash_streak: 0, cap_streak: 0 });
    assert.equal(planned(h)[0]!.expected_termination, "explicit_stop");
    assert.deepEqual(scheduled(h), []);
    assert.equal(h.sessions.length, 1);
    assert.equal(h.host.owns("agent-1"), false);
    assert.equal(streaks.crashStreak("agent-1"), 0);
    assert.equal(streaks.capStreak("agent-1"), 0);
    assert.equal(streaks.resumeFailureRecord("agent-1"), null);
  } finally {
    await h.cleanup();
  }
});

test("a stop of a restart waiting out its backoff cancels it: nothing starts, the streaks end", async () => {
  const { h, controls, streaks } = await exitHarness({ turns: [fail("upstream error")], failure: "provider", deps: { providerLimitBackoff: { baseMs: 300, maxMs: 300_000, jitterRatio: 0 } } });
  try {
    await h.host.start(request());
    await idle(h, 1);
    controls[0]!.refusePrompts = true;
    await h.host.deliverMessage("agent-1", message("m-held"), {});
    await controls[0]!.exit(1);
    assert.equal(planned(h)[0]!.plan_kind, "recoverable");
    await h.host.stopAgent("agent-1", { wait: true });
    await sleep(450);
    assert.equal(h.opened.length, 1, "the waiting restart never launched");
    assert.equal(h.host.owns("agent-1"), false);
    assert.equal(streaks.crashStreak("agent-1"), 0);
  } finally {
    await h.cleanup();
  }
});

test("a spec stop is planned clean with nothing held: the next wake (the server's), as in steps 6 and 7", async () => {
  const { h } = await exitHarness({ turns: [answer] });
  try {
    await h.host.start(request());
    await idle(h, 1);
    h.host.applyServerFeatures({ enabledApps: ["artifacts"] });
    await until(() => planned(h).length > 0, "the spec stop planned");
    assert.deepEqual([planned(h)[0]!.expected_termination, planned(h)[0]!.plan_kind, planned(h)[0]!.plan_start], ["cold_idle_recycle", "clean", "next_wake"]);
    await h.host.unwound("agent-1");
    assert.deepEqual(scheduled(h), []);
    assert.equal(h.host.owns("agent-1"), false);
    assert.equal(h.sessions.length, 1);
    assert.deepEqual(h.framesOf("agent:status").map((frame) => frame.status), ["active"], "a stop on purpose: never reported inactive");
  } finally {
    await h.cleanup();
  }
});

// Tenny item 3.3: the server's re-wake stays the fallback. A daemon that
// crashed and restarted holds nothing: its new OAR host owns no agent, so a
// held mention the server sends again is rejected for no process and the
// server wakes the agent (the router sends a delivery for an agent no host
// owns to the legacy host, whose no-process rejection is the same; covered in
// the legacy host's delivery tests). Exits planned for the next wake keep
// handing a held mention back (oarAgentHost.test.ts, "a held tracked mention
// is handed back once when grok exits").
test("server fallback: after a daemon restart (a new host) a held mention the server sends again is rejected for no process", async () => {
  const h = await harness();
  try {
    const seen: string[] = [];
    assert.equal(await h.host.deliverMessage("agent-1", message("m-mention"), mentionContext("m-mention", seen)), false);
    assert.deepEqual(seen, ["m-mention:rejected_no_process"]);
  } finally {
    await h.cleanup();
  }
});

test("the exit streaks are one store: an OAR crash counts into the store the legacy host's records read", async () => {
  const { h, controls, streaks } = await exitHarness({ turns: [fail("Error: something went wrong while loading the conversation")] });
  const legacyRecords = new AgentLifecycleRecords(undefined, streaks);
  try {
    // A legacy crash before the agent moved to OAR.
    legacyRecords.setRuntimeErrorCloseStreak("agent-1", 2, 2);
    await h.host.start(request());
    await idle(h, 1);
    // The first turn failed with no output, so nothing reset the seeded streaks.
    await controls[0]!.exit(1);
    await until(() => planned(h).length === 1, "the crash planned");
    assert.deepEqual([legacyRecords.getRuntimeErrorCloseStreak("agent-1"), legacyRecords.getCrashCapStreak("agent-1")], [3, 3]);
    // A legacy explicit stop ends them for the OAR host too.
    legacyRecords.deleteRuntimeErrorCloseStreak("agent-1");
    assert.equal(streaks.crashStreak("agent-1"), 0);
  } finally {
    await h.cleanup();
  }
});

// Tenny, review of #13336 (1): a provider limit's wait is the plan's, not
// "start now and let the new session hold its first input": a runtime that
// exits right after it opens would otherwise start again at once for the
// whole limit window, minting a credential each time.
test("a provider limit's wait: a runtime that exits on every open during the limit starts once, and again only when the limit is released", async () => {
  let limitHolds = true;
  const { h, ledger } = await exitHarness({ turns: [answer], exitOnOpen: () => limitHolds });
  try {
    const key = providerLimitCredentialKey("agent-1", makeConfig());
    ledger.record(key, { attempts: 1, reason: "rate_limited", untilMs: Date.now() + 30 * 60_000, providerLimitKind: "quota_exhausted", recordedAtMs: Date.now() }, { host: "legacy" });
    await h.host.start(request({ wakeMessage: message("m-wake") }));
    await until(() => planned(h).length === 1, "the exit planned");
    assert.deepEqual([planned(h)[0]!.plan_kind, planned(h)[0]!.plan_hold, planned(h)[0]!.plan_start], ["clean", "provider_limit", "after"]);
    assert.ok((planned(h)[0]!.plan_start_after_ms as number) > 29 * 60_000);
    await sleep(500);
    assert.equal(h.opened.length, 1, "no start while the limit holds");
    assert.equal(planned(h).length, 1);
    assert.equal(h.host.owns("agent-1"), true, "the restart waits, registered");
    assert.equal(h.framesOf("agent:status").at(-1)!.status, "active");

    // The limit is released: the waiting restart starts now, with the start's wake.
    limitHolds = false;
    ledger.release(key, "model_output", { host: "legacy" });
    // Session 1 never ran a turn (its first input was held for the limit): the restart's is the first.
    await until(() => h.opened.length === 2 && h.inputs.length === 1, "the restart's first turn");
    assert.equal(firstInputs(h).at(-1)!.outcome, "accepted");
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.restart_wait_ended"));
    await sleep(200);
    assert.equal(h.opened.length, 2, "one restart");
  } finally {
    await h.cleanup();
  }
});

// Tenny, review of #13336 (2): a session that exits 0 with work held and no
// output (whether or not a turn started) is D6 on OAR: counted, backed off,
// handed off at the cap, never started again at once forever.
test("D6 on OAR: a session that exits 0 with work held and no output backs off and the fifth is handed to the server with the zero-evidence error", async () => {
  const { h, controls } = await exitHarness({
    turns: [() => {}],
    deps: { providerLimitBackoff: { baseMs: 50, maxMs: 300_000, jitterRatio: 0 } },
  });
  // Reconciler step 12: to a server that counts it, the hand-off is
  // `runtime_repeated_failure` (each session was ready before it exited, so a
  // plain failed start would never reach the server's own threshold).
  h.host.setServerStickyFailureReasonsCapable(true);
  try {
    await h.host.start(request());
    for (let exit = 1; exit <= 5; exit += 1) {
      await idle(h, exit);
      controls[exit - 1]!.refusePrompts = true;
      await h.host.deliverMessage("agent-1", message(`m-${exit}`), {});
      await until(() => h.events.filter((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.code === "busy").length >= exit, `m-${exit} held`);
      await controls[exit - 1]!.exit(0);
      await until(() => planned(h).length === exit, `exit ${exit} planned`);
    }
    assert.deepEqual(planned(h).map((attrs) => [attrs.plan_kind, attrs.plan_start, attrs.plan_start_after_ms, attrs.cap_streak, attrs.hand_to_server]), [
      ["zero_evidence_turn", "after", 50, 1, undefined],
      ["zero_evidence_turn", "after", 100, 2, undefined],
      ["zero_evidence_turn", "after", 200, 3, undefined],
      ["zero_evidence_turn", "after", 400, 4, undefined],
      ["zero_evidence_turn", "none", undefined, 5, true],
    ]);
    assert.equal(h.opened.length, 5, "four restarts, each after its backoff; none after the hand-off");
    const detail = formatZeroEvidenceStreakMessage("Grok Build", 5);
    assert.equal(handOffs(h)[0]!.failure_reason, "zero_evidence_turn");
    const failedStart = h.framesOf("agent:activity").find((frame) => "spawnFailure" in frame && frame.spawnFailure);
    assert.equal(failedStart?.detail, detail);
    assert.equal(failedStart?.spawnFailure?.reason, "runtime_repeated_failure");
    assert.equal(h.framesOf("agent:runtime:ready").length, 5, "every session was ready first");
    assert.equal(h.framesOf("agent:activity").at(-1)!.detail, detail);
    await sleep(500);
    assert.equal(h.opened.length, 5);
    assert.equal(h.host.owns("agent-1"), false);
  } finally {
    await h.cleanup();
  }
});
