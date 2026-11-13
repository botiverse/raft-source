import type { SessionDropReason } from "./runtimeSpec";
import type { WakeRecyclePlan } from "./wakeSessionRecycle";

/**
 * Reconciler step 8a: whether a start resumes its session, starts a new one
 * or is refused. One pure rule for both hosts, from facts the caller has
 * already read (memory, the compaction ledger, the transcript); it reads
 * nothing itself. Fixed precedence:
 *
 * 1. Step 7's spec drop (`SessionSpecMemory.sessionToDrop`): a session that
 *    started on another runtime, or a Codex session on another model, is not
 *    resumed; a new one starts, and the rules below have no session to judge.
 * 1b. Step 10a's resume failure (row D4): the runtime named the session
 *    unusable (a known resume error), or RESUME_FAILURE_THRESHOLD launches in
 *    a row that resumed it crashed early: a new session starts. It goes before
 *    the refusal: a session that cannot be resumed at all has nothing a reset
 *    would keep, and the exit that found it already happened.
 * 2. task #10's stuck session (`SessionCompactionFailureLedger.needsReset`):
 *    resuming a session whose compaction failed too often in a row is
 *    refused (`session_needs_reset`); it never becomes a new session.
 * 3. RFC 070's at-wake recycle (`planWakeSessionRecycle`): a cold wake of a
 *    large session starts a new one with a briefing.
 *
 * A fact left out was not read for this call: a start decides as its facts
 * arrive (the legacy host checks rules 1 and 2 before the RFC 071 gate,
 * rule 1 again for a deferred rebind's config, and rule 3 just before the
 * spawn; the OAR host has no rule 2). Rule 1b is read at an exit
 * (`planExit`), from the facts that exit gathered. A choice other than `resume` clears the
 * session, so a later call sees none.
 */
/** A runtime's own error text that says the stored session cannot be resumed. */
export type KnownResumeError = "missing" | "provider_replay_rejected";

/**
 * Rule 1b: launches in a row that resumed one session and crashed early (no
 * model output, within the early window) before it is replaced. One can be a
 * transient; a second on the same session is cheap evidence the session is
 * the problem, and comes before the server's early-exit breaker (3) stops
 * automatic wakes.
 */
export const RESUME_FAILURE_THRESHOLD = 2;

export interface SessionResumeFailureFacts {
  /** The runtime's own resume error for this session, if it reported one. */
  knownError: KnownResumeError | null;
  /** Launches in a row that resumed this session and crashed early, this exit included. */
  earlyCrashes: number;
}

export interface SessionChoiceFacts {
  /** The session the start would resume, if any. */
  sessionId: string | null | undefined;
  /** Rule 1: why this session must not be resumed on the desired spec, or null. */
  specDrop?: SessionDropReason | null;
  /** Rule 2: the consecutive compaction failures that make this session need a reset, or null. */
  stuckFailures?: number | null;
  /** Rule 3: the at-wake recycle plan for this session. */
  wakeRecycle?: WakeRecyclePlan | null;
  /** Rule 1b: how resuming this session failed, read at an exit. */
  resumeFailure?: SessionResumeFailureFacts | null;
}

export type ResumeFailureCause = KnownResumeError | "repeated_early_crash";

export type WakeRecycleChosen = Extract<WakeRecyclePlan, { action: "recycle" }>;

export type SessionChoice =
  | { kind: "resume"; sessionId: string }
  | { kind: "new"; reason: "no_session" }
  | { kind: "new"; reason: "spec_drop"; dropReason: SessionDropReason }
  | { kind: "new"; reason: "resume_failed"; cause: ResumeFailureCause; sessionId: string }
  | { kind: "new"; reason: "wake_recycle"; recycle: WakeRecycleChosen }
  | { kind: "refuse"; reason: "session_needs_reset"; failures: number };

export function chooseSession(facts: SessionChoiceFacts): SessionChoice {
  const { sessionId } = facts;
  if (!sessionId) return { kind: "new", reason: "no_session" };
  if (facts.specDrop) return { kind: "new", reason: "spec_drop", dropReason: facts.specDrop };
  const resumeFailure = facts.resumeFailure;
  if (resumeFailure?.knownError) return { kind: "new", reason: "resume_failed", cause: resumeFailure.knownError, sessionId };
  if (resumeFailure && resumeFailure.earlyCrashes >= RESUME_FAILURE_THRESHOLD) {
    return { kind: "new", reason: "resume_failed", cause: "repeated_early_crash", sessionId };
  }
  if (facts.stuckFailures !== null && facts.stuckFailures !== undefined) {
    return { kind: "refuse", reason: "session_needs_reset", failures: facts.stuckFailures };
  }
  if (facts.wakeRecycle?.action === "recycle") return { kind: "new", reason: "wake_recycle", recycle: facts.wakeRecycle };
  return { kind: "resume", sessionId };
}
