// Reconciler step 10a: the planExit table (rows D1-D5, D13 and every expected
// termination), shared so the OAR host (step 10b) can run the same rows
// against its own exit path. Test support only.
import type { ExitFacts, ExitPlan } from "../planExit";

export const EXIT_NOW_MS = 1_000_000;

type Nested = "inbox" | "credential" | "session" | "backoff";
export type ExitFactsOverrides = Partial<Omit<ExitFacts, Nested>> & {
  inbox?: Partial<ExitFacts["inbox"]>;
  credential?: Partial<ExitFacts["credential"]>;
  session?: Partial<ExitFacts["session"]>;
  backoff?: Partial<ExitFacts["backoff"]>;
};

/** A process that ran a turn on session-1 (not resumed) and exited 0 with nothing queued. */
export function exitFacts(overrides: ExitFactsOverrides = {}): ExitFacts {
  const { inbox, credential, session, backoff, ...rest } = overrides;
  return {
    code: 0,
    signal: null,
    oom: false,
    turnBoundarySatisfied: true,
    expectedTermination: null,
    runtimeError: false,
    stickyFailure: false,
    providerStreamFailure: false,
    recoverableError: null,
    nowMs: EXIT_NOW_MS,
    modelOutput: false,
    zeroEvidenceTurn: false,
    uptimeMs: 2_000,
    crashStreak: 0,
    capStreak: 0,
    ...rest,
    inbox: { wakes: false, pending: false, ...inbox },
    credential: { invalid: false, limitUntilMs: null, ...credential },
    session: { sessionId: "session-1", resumedSessionId: null, knownResumeError: null, resumeFailures: null, ...session },
    backoff: { baseMs: 10_000, maxMs: 300_000, jitterRatio: 0, jitterUnit: 0, ...backoff },
  };
}

/** A crash: exit 1 before the turn boundary, after a runtime error. */
const crash: ExitFactsOverrides = { code: 1, turnBoundarySatisfied: false, runtimeError: true };
const queued: ExitFactsOverrides["inbox"] = { wakes: true, pending: true };
/** The launch resumed session-1 and crashed early, before model output. */
const resumedEarly: ExitFactsOverrides = { ...crash, session: { resumedSessionId: "session-1" } };
const LIMIT_UNTIL = EXIT_NOW_MS + 30 * 60_000;

export interface PlanExitCase {
  name: string;
  /** The design row (or the expected termination) the case pins. */
  row: string;
  facts: ExitFacts;
  expect: Partial<ExitPlan> & { sessionKind?: string };
}

export const PLAN_EXIT_CASES: PlanExitCase[] = [
  // D1 / D2
  { row: "D1", name: "clean exit, work queued: start now", facts: exitFacts({ inbox: queued }), expect: { kind: "clean", start: "now", hold: null, keepSnapshot: true, crashStreak: 0 } },
  {
    row: "D1", name: "clean exit, work queued, provider limit: held until it ends",
    facts: exitFacts({ inbox: queued, credential: { limitUntilMs: LIMIT_UNTIL } }),
    expect: { kind: "clean", start: { afterMs: 30 * 60_000 }, hold: "provider_limit", keepSnapshot: true },
  },
  {
    row: "D1", name: "clean exit, work queued, credential invalid: held for the credential (step 4a)",
    facts: exitFacts({ inbox: queued, credential: { invalid: true, limitUntilMs: LIMIT_UNTIL } }),
    expect: { kind: "clean", start: "next_wake", hold: "credential_invalid", keepSnapshot: true },
  },
  { row: "D1", name: "an elapsed provider limit holds nothing", facts: exitFacts({ inbox: queued, credential: { limitUntilMs: EXIT_NOW_MS } }), expect: { kind: "clean", start: "now", hold: null } },
  // D6
  {
    row: "D6", name: "a turn that did nothing, work queued: counted, and it waits for the backoff",
    facts: exitFacts({ zeroEvidenceTurn: true, inbox: queued, crashStreak: 2 }),
    expect: { kind: "zero_evidence_turn", clean: false, start: { afterMs: 40_000 }, crashStreak: 3, handToServer: false, keepSnapshot: true },
  },
  {
    row: "D6", name: "a turn that did nothing, nothing queued: counted, and the next wake",
    facts: exitFacts({ zeroEvidenceTurn: true }),
    expect: { kind: "zero_evidence_turn", start: "next_wake", crashStreak: 1, handToServer: false },
  },
  {
    row: "D6", name: "the fifth in a row: handed to the server with a visible error",
    facts: exitFacts({ zeroEvidenceTurn: true, inbox: queued, crashStreak: 4, capStreak: 4 }),
    expect: { kind: "zero_evidence_turn", start: "none", crashStreak: 5, capStreak: 5, handToServer: true, keepSnapshot: false },
  },
  { row: "D6", name: "model output is evidence: an ordinary clean exit", facts: exitFacts({ zeroEvidenceTurn: true, modelOutput: true, inbox: queued }), expect: { kind: "clean", start: "now", crashStreak: 0 } },
  { row: "D6", name: "the daemon's own stop isn't the runtime doing nothing", facts: exitFacts({ zeroEvidenceTurn: true, expectedTermination: "cold_idle_recycle" }), expect: { kind: "clean", crashStreak: 0 } },
  {
    row: "D6", name: "a provider limit has its own wait, and doesn't count",
    facts: exitFacts({ zeroEvidenceTurn: true, inbox: queued, credential: { limitUntilMs: LIMIT_UNTIL } }),
    expect: { kind: "clean", start: { afterMs: 30 * 60_000 }, hold: "provider_limit", crashStreak: 0 },
  },
  { row: "D6", name: "an invalid credential has its own wait, and doesn't count", facts: exitFacts({ zeroEvidenceTurn: true, inbox: queued, credential: { invalid: true } }), expect: { kind: "clean", start: "next_wake", hold: "credential_invalid", crashStreak: 0 } },
  {
    row: "D6", name: "a classified provider error is D3: it backs off and is never handed off",
    facts: exitFacts({ zeroEvidenceTurn: true, inbox: queued, recoverableError: "provider_server_error", crashStreak: 4, capStreak: 4 }),
    expect: { kind: "recoverable", handToServer: false, crashStreak: 5 },
  },
  { row: "D2", name: "clean exit, nothing queued: the next wake", facts: exitFacts(), expect: { kind: "clean", start: "next_wake", hold: null, keepSnapshot: true, handToServer: false } },
  { row: "D2", name: "clean exit, nothing queued, provider limit: the next wake is held", facts: exitFacts({ credential: { limitUntilMs: LIMIT_UNTIL } }), expect: { kind: "clean", start: "next_wake", hold: "provider_limit" } },
  { row: "D2", name: "a deferred delivery does not wake (pending, not waking)", facts: exitFacts({ inbox: { pending: true, wakes: false } }), expect: { kind: "clean", start: "next_wake" } },

  // D3
  {
    row: "D3", name: "recoverable close, work queued: start after the crash backoff (first)",
    facts: exitFacts({ ...crash, recoverableError: "provider_connection_error", inbox: queued }),
    expect: { kind: "recoverable", start: { afterMs: 10_000 }, crashStreak: 1, keepSnapshot: true, handToServer: false },
  },
  {
    row: "D3", name: "recoverable close, work queued, fourth in a row: 80 s",
    facts: exitFacts({ ...crash, recoverableError: "rate_limited", inbox: queued, crashStreak: 3 }),
    expect: { kind: "recoverable", start: { afterMs: 80_000 }, crashStreak: 4, handToServer: false },
  },
  {
    row: "D3", name: "recoverable close, nothing queued, first: the next wake, not held",
    facts: exitFacts({ ...crash, recoverableError: "provider_server_error" }),
    expect: { kind: "recoverable", start: "next_wake", holdNextWakeMs: undefined, crashStreak: 1 },
  },
  {
    row: "D3", name: "recoverable close, nothing queued, second in a row: the next wake waits the backoff",
    facts: exitFacts({ ...crash, recoverableError: "provider_stream_error", crashStreak: 1 }),
    expect: { kind: "recoverable", start: "next_wake", holdNextWakeMs: 20_000, crashStreak: 2 },
  },
  // A provider outage is not capped (Tenny, review of #13328): the backoff
  // grows to the policy's max (5 min) and the agent keeps trying.
  {
    row: "D3", name: "never capped: the fifth recoverable close in a row backs off 160 s, not handed off",
    facts: exitFacts({ ...crash, recoverableError: "provider_connection_error", inbox: queued, crashStreak: 4, capStreak: 4 }),
    expect: { kind: "recoverable", start: { afterMs: 160_000 }, crashStreak: 5, capStreak: 4, handToServer: false, keepSnapshot: true, report: { kind: "recoverable", status: "active" } },
  },
  {
    row: "D3", name: "never capped: the sixth in a row backs off the 5 min max",
    facts: exitFacts({ ...crash, recoverableError: "provider_server_error", inbox: queued, crashStreak: 5, capStreak: 4 }),
    expect: { kind: "recoverable", start: { afterMs: 300_000 }, crashStreak: 6, capStreak: 4, handToServer: false },
  },
  {
    row: "D3", name: "never capped: the tenth in a row stays at the 5 min max",
    facts: exitFacts({ ...crash, recoverableError: "rate_limited", inbox: queued, crashStreak: 9, capStreak: 4 }),
    expect: { kind: "recoverable", start: { afterMs: 300_000 }, crashStreak: 10, capStreak: 4, handToServer: false },
  },
  {
    row: "D3", name: "never capped, nothing queued: the next wake waits the 5 min max",
    facts: exitFacts({ ...crash, recoverableError: "provider_stream_error", crashStreak: 9, capStreak: 4 }),
    expect: { kind: "recoverable", start: "next_wake", holdNextWakeMs: 300_000, crashStreak: 10, capStreak: 4, handToServer: false },
  },
  {
    row: "D3", name: "an unclassified provider stream failure: the next wake, counted",
    facts: exitFacts({ ...crash, providerStreamFailure: true, inbox: queued }),
    expect: { kind: "provider_stream_failure", start: "next_wake", crashStreak: 1, capStreak: 1, keepSnapshot: true },
  },
  {
    row: "D3", name: "an unclassified provider stream failure counts toward the cap: the fifth is handed off",
    facts: exitFacts({ ...crash, providerStreamFailure: true, inbox: queued, crashStreak: 4, capStreak: 4 }),
    expect: { kind: "provider_stream_failure", start: "none", capStreak: 5, handToServer: true },
  },

  // D4
  {
    row: "D4", name: "known resume error: a new session, now",
    facts: exitFacts({ ...crash, session: { knownResumeError: "missing" } }),
    expect: { kind: "resume_failed", start: "now", sessionKind: "new:resume_failed:missing", crashStreak: 1, resumeFailures: null, keepSnapshot: true },
  },
  {
    row: "D4", name: "first early crash of a resumed session: counted, the next wake resumes it",
    facts: exitFacts(resumedEarly),
    expect: { kind: "crash", start: "next_wake", earlyCrashCounted: true, resumeFailures: { sessionId: "session-1", count: 1 }, sessionKind: "resume" },
  },
  {
    row: "D4", name: "second early crash on the same session: chooseSession starts a new one",
    facts: exitFacts({ ...resumedEarly, session: { resumedSessionId: "session-1", resumeFailures: { sessionId: "session-1", count: 1 } } }),
    expect: { kind: "resume_failed", start: "now", earlyCrashCounted: true, resumeFailures: null, sessionKind: "new:resume_failed:repeated_early_crash" },
  },
  {
    row: "D4", name: "an early crash on another session starts its own count",
    facts: exitFacts({ ...resumedEarly, session: { resumedSessionId: "session-1", resumeFailures: { sessionId: "session-0", count: 1 } } }),
    expect: { kind: "crash", resumeFailures: { sessionId: "session-1", count: 1 } },
  },
  {
    row: "D4", name: "not early: after model output, past the window, by a signal or exit >= 128",
    facts: exitFacts({ ...resumedEarly, modelOutput: true }),
    expect: { kind: "crash", earlyCrashCounted: false, resumeFailures: null },
  },
  { row: "D4", name: "not early: past the window", facts: exitFacts({ ...resumedEarly, uptimeMs: 16_000 }), expect: { earlyCrashCounted: false } },
  { row: "D4", name: "not early: exit 143 (a SIGTERM from outside)", facts: exitFacts({ ...resumedEarly, code: 143 }), expect: { earlyCrashCounted: false } },
  { row: "D4", name: "not early: inside a provider limit", facts: exitFacts({ ...resumedEarly, credential: { limitUntilMs: LIMIT_UNTIL } }), expect: { kind: "held_provider_limit", earlyCrashCounted: false } },
  {
    row: "D4", name: "a resume failure at the cap: the session is replaced, the start is the server's",
    facts: exitFacts({ ...resumedEarly, crashStreak: 4, capStreak: 4, session: { resumedSessionId: "session-1", resumeFailures: { sessionId: "session-1", count: 1 } } }),
    expect: { kind: "resume_failed", start: "none", handToServer: true, crashStreak: 5, capStreak: 5, sessionKind: "new:resume_failed:repeated_early_crash" },
  },

  // D5
  {
    row: "D5", name: "non-recoverable crash: the next wake, the snapshot kept, counted",
    facts: exitFacts(crash),
    expect: { kind: "crash", start: "next_wake", keepSnapshot: true, crashStreak: 1, capStreak: 1, report: { kind: "crash", status: "inactive", userVisible: { activity: "error" } } },
  },
  { row: "D5", name: "OOM (a SIGKILL the host did not send)", facts: exitFacts({ code: null, signal: "SIGKILL", oom: true, turnBoundarySatisfied: false }), expect: { kind: "crash", start: "next_wake", keepSnapshot: true, crashStreak: 1 } },
  { row: "D5", name: "killed by a signal", facts: exitFacts({ code: null, signal: "SIGTERM", turnBoundarySatisfied: false }), expect: { kind: "crash", start: "next_wake", keepSnapshot: true } },
  { row: "D5", name: "a sticky failure is a crash, never held", facts: exitFacts({ ...crash, stickyFailure: true, credential: { invalid: true } }), expect: { kind: "crash", hold: null } },
  {
    row: "D5", name: "capped: the fifth crash in a row is handed to the server with a visible error",
    facts: exitFacts({ ...crash, inbox: queued, crashStreak: 4, capStreak: 4 }),
    expect: {
      kind: "crash", start: "none", crashStreak: 5, capStreak: 5, handToServer: true, keepSnapshot: false,
      report: { kind: "crash_streak_exhausted", status: "inactive", userVisible: { activity: "error", retry: true } },
    },
  },
  {
    row: "D5", name: "a crash after six provider closes counts 1 toward the cap, not 7",
    facts: exitFacts({ ...crash, crashStreak: 6, capStreak: 0 }),
    expect: { kind: "crash", start: "next_wake", crashStreak: 7, capStreak: 1, handToServer: false },
  },
  {
    row: "D5", name: "provider closes in between neither add to nor reset the cap streak: the fifth counted crash is handed off",
    facts: exitFacts({ ...crash, crashStreak: 10, capStreak: 4 }),
    expect: { kind: "crash", start: "none", crashStreak: 11, capStreak: 5, handToServer: true },
  },
  {
    row: "D5", name: "a close while the credential is invalid waits for it, uncounted",
    facts: exitFacts({ ...crash, credential: { invalid: true }, crashStreak: 4, capStreak: 4 }),
    expect: { kind: "held_credential_invalid", start: "next_wake", hold: "credential_invalid", crashStreak: 4, capStreak: 4, handToServer: false },
  },
  {
    row: "D5", name: "a close inside a provider limit waits for it, uncounted",
    facts: exitFacts({ ...crash, inbox: queued, credential: { limitUntilMs: LIMIT_UNTIL } }),
    expect: { kind: "held_provider_limit", start: { afterMs: 30 * 60_000 }, hold: "provider_limit", crashStreak: 0, capStreak: 0 },
  },

  // Expected terminations: today's outcomes.
  { row: "turn_end", name: "turn end (process per turn), work queued: start now", facts: exitFacts({ expectedTermination: "turn_end", code: null, signal: "SIGTERM", inbox: queued }), expect: { kind: "clean", start: "now" } },
  { row: "turn_end", name: "turn end after a live runtime error: a crash", facts: exitFacts({ expectedTermination: "turn_end", code: null, signal: "SIGTERM", runtimeError: true }), expect: { kind: "crash", crashStreak: 1 } },
  { row: "stalled_recovery", name: "stall replacement: start now with the queued work", facts: exitFacts({ expectedTermination: "stalled_recovery", code: null, signal: "SIGTERM", inbox: queued }), expect: { kind: "clean", start: "now" } },
  { row: "cold_idle_recycle", name: "cold-idle (and spec) stop: clean, a stale error ignored", facts: exitFacts({ expectedTermination: "cold_idle_recycle", code: null, signal: "SIGTERM", runtimeError: true }), expect: { kind: "clean", start: "next_wake", crashStreak: 0 } },
  { row: "cold_idle_recycle", name: "cold-idle stop with the credential invalid: held (step 6)", facts: exitFacts({ expectedTermination: "cold_idle_recycle", inbox: queued, credential: { invalid: true } }), expect: { kind: "clean", hold: "credential_invalid" } },
  { row: "turn_interrupt", name: "a person's turn interrupt: clean, a stale error ignored, never an early crash", facts: exitFacts({ ...resumedEarly, expectedTermination: "turn_interrupt", inbox: queued }), expect: { kind: "clean", start: "now", earlyCrashCounted: false } },
  { row: "startup_timeout", name: "start timeout cleanup: its own backoff, never clean even on exit 0", facts: exitFacts({ expectedTermination: "startup_timeout", crashStreak: 2 }), expect: { kind: "startup_timeout", clean: false, start: "next_wake", keepSnapshot: true, crashStreak: 2 } },
  { row: "startup_timeout", name: "start timeout with a provider error: the recoverable close", facts: exitFacts({ expectedTermination: "startup_timeout", recoverableError: "rate_limited", inbox: queued }), expect: { kind: "recoverable", start: { afterMs: 10_000 } } },
  { row: "startup_request_error", name: "startup request error cleanup: the server's next start, the streak reset", facts: exitFacts({ ...crash, expectedTermination: "startup_request_error", crashStreak: 3, capStreak: 2 }), expect: { kind: "startup_request_error", start: "none", keepSnapshot: false, crashStreak: 0, capStreak: 0 } },
  { row: "explicit_stop", name: "a person's stop: nothing starts", facts: exitFacts({ expectedTermination: "explicit_stop", inbox: queued, crashStreak: 3, capStreak: 2 }), expect: { kind: "stopped", start: "none", keepSnapshot: false, crashStreak: 0, capStreak: 0 } },
  { row: "D13", name: "stopped while starting: the stop's own end, no special case", facts: exitFacts({ expectedTermination: "explicit_stop", code: null, signal: "SIGTERM", uptimeMs: 50, turnBoundarySatisfied: false }), expect: { kind: "stopped", start: "none", handToServer: false } },
];
