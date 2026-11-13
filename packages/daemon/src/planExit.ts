/**
 * Reconciler step 10a (#proj-raft-computer:#48, rows D1-D5, D12, D13; rules
 * 2 and 3): what follows when an agent's process exits. One pure rule, from
 * facts the host has already read (how the process ended, why the daemon
 * ended it if it did, its inbox, its credential, its session's resume record,
 * the crash streak); it reads nothing itself and holds no host types, so the
 * legacy host and the OAR host (step 10b) feed it the same way.
 *
 * - D1 clean exit with work queued: start now; a provider limit on the
 *   credential holds it until the limit ends, an invalid one until the
 *   credential is usable (step 4a).
 * - D2 clean exit with nothing queued: the next wake.
 * - D3 recoverable close (rate limit, provider server, connection, stream):
 *   with work queued, start again after the crash streak's backoff (capped
 *   by the policy's max, 5 min); with nothing queued, the next wake (held for
 *   the backoff from the second in a row). Never handed off: a provider
 *   outage is not the agent's fault and ends by itself, and the server's
 *   start-failure pause would not end with it (Tenny, review of #13328).
 * - D4 resume failure: `chooseSession` decides from the facts (the runtime's
 *   known resume error, or RESUME_FAILURE_THRESHOLD early crashes in a row on
 *   the resumed session); a new session starts now.
 * - D6 a clean exit of a turn that got nowhere (`zeroEvidenceTurn`): counts like
 *   a crash, so a runtime that keeps exiting 0 without a single event, or with
 *   only an error, backs off and reaches the cap, where a plain clean exit would
 *   start again at once (a user's OpenCode 1.17.13 did for days, every 38 s). A
 *   turn that reports events, no error and no output had nothing to do, and is
 *   D1 / D2. With a classified provider error it is D3, never handed off.
 * - D5 any other crash (OOM and signals included): the next wake, from the
 *   restart snapshot, which stays (it is the agent's state).
 * - The cap: every crash but a D3 one (D5, an unclassified stream failure, a
 *   resume failure's crash) counts into the cap streak; from the
 *   CRASH_STREAK_CAP-th in a row the host stops starting the agent itself
 *   and hands it to the server (its start-failure breaker, F2), with a
 *   visible error. A D3 close neither adds to nor resets the cap streak; it
 *   only grows the backoff streak.
 * - Expected terminations (the daemon's own stops) keep their outcomes: the
 *   cold-idle and spec stops, a stall replacement, a turn end or a turn
 *   interrupt are clean unless a live error says otherwise; the two startup
 *   cleanups have their own paths; an explicit stop starts nothing (the
 *   legacy host releases a stopped process before its close, so only a host
 *   that sees the stop's exit passes it).
 */
import { chooseSession, type KnownResumeError, type SessionChoice, type SessionChoiceFacts } from "./chooseSession";
import { runtimeErrorDeliveryBackoffDelayMs } from "./runtimeErrorDeliveryPolicy";
import { StickyFailureRecords } from "./stickyFailureRecords";

/**
 * D5 (and every crash but D3's) and D12: failures in a row after which the
 * host stops starting the agent by itself (about 30 s of spawn backoff) and
 * hands it to the server, whose start-failure breaker pauses automatic wakes
 * after as many failed starts and tells the owner.
 */
export const CRASH_STREAK_CAP = 5;

/** Reconciler step 10a, D3/D5 capped: the error a person sees, and restarts from (both hosts). */
export function formatCrashStreakExhaustedMessage(runtimeLabel: string, crashes: number, lastExit: string): string {
  return `${runtimeLabel} crashed ${crashes} times in a row (last: ${lastExit}). Raft stopped restarting it; restart the agent to try again.`;
}

/** D6 capped: the error a person sees, and restarts from (both hosts). */
export function formatZeroEvidenceStreakMessage(runtimeLabel: string, turns: number): string {
  // Says what's known: the cause varies (a provider that never answers looks the same), so no promised fix.
  return `${runtimeLabel} ended ${turns} turns in a row without any output. Raft stopped restarting it. Check the ${runtimeLabel} version and its logs, and your provider account, then restart the agent.`;
}

/** True from the CRASH_STREAK_CAP-th failure in a row (a crash the cap counts, a failed spawn, a start timeout). */
export function crashStreakExhausted(streak: number): boolean {
  return streak >= CRASH_STREAK_CAP;
}

export interface CrashBackoffPolicy {
  baseMs: number;
  maxMs: number;
  jitterRatio: number;
  /** A random unit the host drew for this call (0 with no jitter). */
  jitterUnit: number;
}

/** The wait before the next start after `streak` failures in a row: base, doubling, capped at max. */
export function crashStreakBackoffMs(streak: number, policy: CrashBackoffPolicy): number {
  return runtimeErrorDeliveryBackoffDelayMs(streak, policy);
}

/**
 * The generic resume fallback (AndyLok, #proj-raft-computer:#42): a launch
 * that resumed a stored session and crashed within this long of its spawn,
 * before any model output, counts as a failure to resume it. The field
 * crashes came 1-4 s after spawn; a resume that loads a long transcript can
 * take several seconds, and a process that ran a real turn is excluded by
 * the no-output rule anyway.
 */
export const RESUMED_EARLY_CRASH_WINDOW_MS = 15_000;

/** Why the daemon ended the process itself. */
export type ExitExpectedTermination =
  | "turn_end"
  | "stalled_recovery"
  | "startup_timeout"
  | "startup_request_error"
  /** The cold-idle stop, and the runtime spec restart (the same stop). */
  | "cold_idle_recycle"
  | "turn_interrupt"
  /** A person's stop (and a stop while starting, D13). */
  | "explicit_stop";

/** C4/C7: the error classes whose close is recoverable (provider-class: never toward the cap). */
export type RecoverableExitError = "rate_limited" | "provider_server_error" | "provider_connection_error" | "provider_stream_error";

/** The early crashes in a row of launches that resumed `sessionId`. */
export interface ResumeFailureRecord {
  sessionId: string;
  count: number;
}

export interface ExitFacts {
  code: number | null;
  signal: string | null;
  /** A SIGKILL the host did not send (on Linux almost always the OOM killer). */
  oom: boolean;
  /** The runtime reached its turn boundary before the exit (or its boundary is the exit). */
  turnBoundarySatisfied: boolean;
  expectedTermination: ExitExpectedTermination | null;
  /** The process reported a runtime error it did not recover from. */
  runtimeError: boolean;
  /** A failure that sticks to the agent (input too large, an unsupported model, ...). */
  stickyFailure: boolean;
  /** The failure is a provider stream failure the error classes did not name. */
  providerStreamFailure: boolean;
  /** The class that makes the close recoverable, or null. */
  recoverableError: RecoverableExitError | null;
  inbox: {
    /** A queued delivery wakes the agent (deferred and transient ones do not). */
    wakes: boolean;
    /** Any non-transient delivery is queued. */
    pending: boolean;
  };
  /** Step 4a / C6: the agent's credential. */
  credential: { invalid: boolean; limitUntilMs: number | null };
  nowMs: number;
  session: {
    /** The session the process ran (or resumed, when it never named one). */
    sessionId: string | null;
    /** The stored session this launch resumed, if any. */
    resumedSessionId: string | null;
    /** The runtime's own error says the session cannot be resumed. */
    knownResumeError: KnownResumeError | null;
    /** The early-crash record before this exit. */
    resumeFailures: ResumeFailureRecord | null;
  };
  /** The process produced model output. */
  modelOutput: boolean;
  /** The process ran a turn and got nowhere: no event from its output, or an error and no output; no send. */
  zeroEvidenceTurn: boolean;
  uptimeMs: number;
  /**
   * Crashes in a row before this exit, D3 included: the backoff grows with it
   * (reset by model output, a clean turn end, an explicit stop).
   */
  crashStreak: number;
  /** Of those, the crashes that count toward CRASH_STREAK_CAP: every one but a D3 close (same resets). */
  capStreak: number;
  backoff: CrashBackoffPolicy;
}

export type ExitKind =
  /** D4 */
  | "resume_failed"
  /** D1 / D2 */
  | "clean"
  /** D6 */
  | "zero_evidence_turn"
  /** A close while the credential is invalid (step 4a): it waits for the credential. */
  | "held_credential_invalid"
  /** A close inside a provider-limit wait: it waits for the limit to end. */
  | "held_provider_limit"
  /** D3 */
  | "recoverable"
  /** D3 for a stream failure the classes did not name: the next wake. */
  | "provider_stream_failure"
  | "startup_timeout"
  | "startup_request_error"
  /** D5 */
  | "crash"
  | "stopped";

/**
 * - `now`: start again at once (D1, D4).
 * - `{ afterMs }`: start again when the wait ends (D3's backoff, a provider limit).
 * - `next_wake`: the next delivery or server start (D2, D5).
 * - `none`: the host does not start it; the server's next start does (a stop,
 *   a startup request cleanup, a hand-off).
 */
export type ExitStart = "now" | { afterMs: number } | "next_wake" | "none";

export type ExitHold = "credential_invalid" | "provider_limit";

export interface ExitReport {
  kind: ExitKind | "crash_streak_exhausted";
  /** The status the host reports (null: none; a start, or the stop's own). */
  status: "active" | "inactive" | null;
  /** What the person sees. */
  userVisible?: {
    activity: "idle" | "error" | "crashed" | "recovering";
    /** The way out is a manual restart (the error carries no required action). */
    retry?: true;
  };
}

export interface ExitPlan {
  kind: ExitKind;
  /** The process ended cleanly (D1/D2). */
  clean: boolean;
  start: ExitStart;
  /** `next_wake` after a recoverable close: the next wake waits this long. */
  holdNextWakeMs?: number;
  /** What holds the next start, if anything. */
  hold: ExitHold | null;
  /** The facts for `chooseSession` (rule 1b) and its choice. */
  sessionFacts: SessionChoiceFacts;
  session: SessionChoice;
  /** This exit counted as an early crash of a resumed session. */
  earlyCrashCounted: boolean;
  /** The early-crash record to keep (null: none). */
  resumeFailures: ResumeFailureRecord | null;
  /** Crashes in a row after this exit (the backoff's). */
  crashStreak: number;
  /** Crashes in a row toward CRASH_STREAK_CAP after this exit (D3 closes excluded). */
  capStreak: number;
  report: ExitReport;
  /** The restart snapshot stays (false: the server owns the next start). */
  keepSnapshot: boolean;
  /** The cap streak reached CRASH_STREAK_CAP on a crash it counts: the host stops restarting the agent and hands it to the server. */
  handToServer: boolean;
}

const CRASH_COUNTED: ReadonlySet<ExitKind> = new Set(["recoverable", "provider_stream_failure", "crash", "zero_evidence_turn"]);

export function planExit(facts: ExitFacts): ExitPlan {
  const expected = facts.expectedTermination;
  const limitActive = facts.credential.limitUntilMs !== null && facts.credential.limitUntilMs > facts.nowMs;
  const limitWaitMs = limitActive ? facts.credential.limitUntilMs! - facts.nowMs : 0;

  if (expected === "explicit_stop") {
    const sessionFacts: SessionChoiceFacts = { sessionId: facts.session.sessionId };
    return {
      kind: "stopped",
      clean: true,
      start: "none",
      hold: null,
      sessionFacts,
      session: chooseSession(sessionFacts),
      earlyCrashCounted: false,
      resumeFailures: null,
      crashStreak: 0,
      capStreak: 0,
      report: { kind: "stopped", status: null },
      keepSnapshot: false,
      handToServer: false,
    };
  }

  const startupTimeout = expected === "startup_timeout";
  const startupRequestError = expected === "startup_request_error";
  // A cold-idle stop and a person's turn interrupt ignore an error the
  // runtime had long recovered from (it is cleared only by a delivery).
  const staleErrorIgnored = expected === "cold_idle_recycle" || expected === "turn_interrupt";
  // A startup cleanup is never clean, even when the killed process exits 0.
  const exitedClean = !facts.stickyFailure && !startupTimeout && !startupRequestError
    && ((facts.code === 0 && facts.turnBoundarySatisfied) || (expected !== null && (!facts.runtimeError || staleErrorIgnored)));
  // The daemon's own stops are not the runtime doing nothing. A limit or an invalid credential has its own wait.
  const zeroEvidence = exitedClean && expected === null && facts.zeroEvidenceTurn && !facts.modelOutput
    && !limitActive && !facts.credential.invalid;
  const clean = exitedClean && !zeroEvidence;

  // D4 facts. A known resume error is decided by its own text; the generic
  // rule counts only closes no matcher knows and no other path owns: not
  // clean, not the daemon's, not a signal or exit >= 128 (a SIGTERM from
  // outside exits 143), no model output, early, no credential hold, not
  // sticky, not a provider stream failure, not recoverable.
  const resumed = facts.session.resumedSessionId;
  const knownError = facts.session.knownResumeError;
  const earlyCrashCounted = !knownError
    && Boolean(resumed)
    && !clean
    && expected === null
    && facts.signal === null
    && typeof facts.code === "number" && facts.code > 0 && facts.code < 128
    && !facts.modelOutput
    && facts.uptimeMs <= RESUMED_EARLY_CRASH_WINDOW_MS
    && !limitActive && !facts.credential.invalid
    && !facts.stickyFailure
    && !facts.providerStreamFailure
    && facts.recoverableError === null;
  const prior = facts.session.resumeFailures;
  const earlyCrashes = earlyCrashCounted ? (prior?.sessionId === resumed ? prior.count + 1 : 1) : 0;
  const sessionFacts: SessionChoiceFacts = {
    sessionId: facts.session.sessionId,
    resumeFailure: { knownError, earlyCrashes },
  };
  const session = chooseSession(sessionFacts);
  const resumeFailed = session.kind === "new" && session.reason === "resume_failed";
  const resumeFailures = earlyCrashCounted && !resumeFailed ? { sessionId: resumed!, count: earlyCrashes } : null;

  const holdable = !facts.stickyFailure && !startupTimeout && !startupRequestError;
  let kind: ExitKind;
  if (resumeFailed) kind = "resume_failed";
  else if (zeroEvidence && !facts.recoverableError) kind = "zero_evidence_turn";
  else if (clean) kind = "clean";
  else if (holdable && facts.credential.invalid) kind = "held_credential_invalid";
  else if (holdable && limitActive) kind = "held_provider_limit";
  else if (facts.recoverableError) kind = "recoverable";
  else if (facts.providerStreamFailure) kind = "provider_stream_failure";
  else if (startupTimeout) kind = "startup_timeout";
  else if (startupRequestError) kind = "startup_request_error";
  else kind = "crash";

  // Every crash grows the backoff, a resume failure's crash included. The
  // loop guard (the cap) counts all but a D3 close, so a bad session or an
  // unclassified crash loop stops, while a provider outage backs off (to the
  // policy's max) until the provider answers again.
  const counted = CRASH_COUNTED.has(kind) || (kind === "resume_failed" && !clean);
  const capCounted = counted && kind !== "recoverable";
  const reset = kind === "startup_request_error";
  const crashStreak = reset ? 0 : counted ? facts.crashStreak + 1 : facts.crashStreak;
  const capStreak = reset ? 0 : capCounted ? facts.capStreak + 1 : facts.capStreak;
  const handToServer = capCounted && crashStreakExhausted(capStreak);

  const base = { kind, clean, sessionFacts, session, earlyCrashCounted, resumeFailures, crashStreak, capStreak, handToServer };
  if (handToServer) {
    return {
      ...base,
      start: "none",
      hold: null,
      report: { kind: "crash_streak_exhausted", status: "inactive", userVisible: { activity: "error", retry: true } },
      keepSnapshot: false,
    };
  }
  switch (kind) {
    case "resume_failed":
      return { ...base, start: "now", hold: null, report: { kind, status: null, userVisible: { activity: "recovering" } }, keepSnapshot: true };
    case "clean": {
      const hold: ExitHold | null = facts.credential.invalid ? "credential_invalid" : limitActive ? "provider_limit" : null;
      const start: ExitStart = !facts.inbox.wakes ? "next_wake"
        : hold === "credential_invalid" ? "next_wake"
          : hold === "provider_limit" ? { afterMs: limitWaitMs }
            : "now";
      return {
        ...base,
        start,
        hold,
        report: { kind, status: null, userVisible: { activity: hold === "credential_invalid" ? "error" : "idle" } },
        keepSnapshot: true,
      };
    }
    case "zero_evidence_turn":
      return {
        ...base,
        start: facts.inbox.wakes ? { afterMs: crashStreakBackoffMs(crashStreak, facts.backoff) } : "next_wake",
        hold: null,
        report: { kind, status: "active" },
        keepSnapshot: true,
      };
    case "held_credential_invalid":
      return { ...base, start: "next_wake", hold: "credential_invalid", report: { kind, status: "active", userVisible: { activity: "error" } }, keepSnapshot: true };
    case "held_provider_limit":
      return {
        ...base,
        start: facts.inbox.pending ? { afterMs: limitWaitMs } : "next_wake",
        hold: "provider_limit",
        report: { kind, status: "active" },
        keepSnapshot: true,
      };
    case "recoverable": {
      const delayMs = crashStreakBackoffMs(crashStreak, facts.backoff);
      if (facts.inbox.wakes) {
        return { ...base, start: { afterMs: delayMs }, hold: null, report: { kind, status: "active" }, keepSnapshot: true };
      }
      // Nothing queued: the first close keeps the agent wakeable; from the
      // second in a row the next delivery waits for the backoff.
      return {
        ...base,
        start: "next_wake",
        ...(crashStreak >= 2 ? { holdNextWakeMs: delayMs } : {}),
        hold: null,
        report: { kind, status: "active" },
        keepSnapshot: true,
      };
    }
    case "provider_stream_failure":
      return { ...base, start: "next_wake", hold: null, report: { kind, status: "active", userVisible: { activity: "error" } }, keepSnapshot: true };
    case "startup_timeout":
      // The start-timeout backoff (D12's) decides the next try.
      return { ...base, start: "next_wake", hold: null, report: { kind, status: null }, keepSnapshot: true };
    case "startup_request_error":
      return { ...base, start: "none", hold: null, report: { kind, status: null }, keepSnapshot: false };
    case "crash":
      return {
        ...base,
        start: "next_wake",
        hold: null,
        report: { kind, status: "inactive", userVisible: { activity: facts.stickyFailure || facts.runtimeError ? "error" : "crashed" } },
        keepSnapshot: true,
      };
  }
}

/**
 * Reconciler step 10b: what `planExit` reads and leaves per agent, kept
 * outside the process (each crash replaces it) and outside either host: the
 * crash streak (the backoff's), its cap streak, and the early-crash record of
 * launches that resumed one session. One per daemon (core.ts), shared by both
 * agent hosts, like `StalledReplacementStreaks` and `ProviderLimitLedger`: an
 * agent runs on one host at a time, and a person's stop on either ends its
 * streaks. Memory only: a daemon restart forgets it.
 */
export class ExitStreaks {
  /** Reconciler step 12: the session reset and unusable-model records (stickyFailureRecords.ts), shared the same way. */
  readonly sticky = new StickyFailureRecords();
  private readonly crashStreaks = new Map<string, number>();
  private readonly capStreaks = new Map<string, number>();
  private readonly resumeFailures = new Map<string, ResumeFailureRecord>();

  crashStreak(agentId: string): number {
    return this.crashStreaks.get(agentId) ?? 0;
  }

  capStreak(agentId: string): number {
    return this.capStreaks.get(agentId) ?? 0;
  }

  /** Both streaks after an exit (`ExitPlan.crashStreak` / `capStreak`); 0 deletes one. */
  setStreaks(agentId: string, crashStreak: number, capStreak: number): void {
    if (crashStreak > 0) this.crashStreaks.set(agentId, crashStreak);
    else this.crashStreaks.delete(agentId);
    if (capStreak > 0) this.capStreaks.set(agentId, capStreak);
    else this.capStreaks.delete(agentId);
  }

  /** Ends both streaks (model output, a clean turn end, an explicit stop); true if there was one. */
  deleteStreaks(agentId: string): boolean {
    const hadCap = this.capStreaks.delete(agentId);
    return this.crashStreaks.delete(agentId) || hadCap;
  }

  resumeFailureRecord(agentId: string): ResumeFailureRecord | null {
    return this.resumeFailures.get(agentId) ?? null;
  }

  /** The early-crash record an exit leaves (`ExitPlan.resumeFailures`); null deletes it. */
  setResumeFailureRecord(agentId: string, record: ResumeFailureRecord | null): void {
    if (record) this.resumeFailures.set(agentId, record);
    else this.resumeFailures.delete(agentId);
  }

  deleteResumeFailureRecord(agentId: string): boolean {
    return this.resumeFailures.delete(agentId);
  }

  /** What an exit's plan leaves: both streaks and the early-crash record. */
  recordPlan(agentId: string, plan: Pick<ExitPlan, "crashStreak" | "capStreak" | "resumeFailures">): void {
    this.setStreaks(agentId, plan.crashStreak, plan.capStreak);
    this.setResumeFailureRecord(agentId, plan.resumeFailures);
  }
}
