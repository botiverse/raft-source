/**
 * task #1119 — server-side crash-loop breaker for automatic agent wakes.
 *
 * Incident 2026-09-14: an agent's runner died on every start and the server
 * woke it again on every reconnect for 181 cycles. This module is the state
 * machine the orchestrator consults before an *automatic* start (message wake,
 * app-inbox wake, rejected-delivery conversion). Human starts always pass and
 * open a new episode.
 *
 * Counting rule (locked by Huaihuai in #proj-runtime:3ddaa7c2, refined after
 * the task #1126 review):
 *  - an "early exit" is a daemon-reported *process exit* (agent:status inactive
 *    carrying the exit evidence and the launchId of the start it ends) observed
 *    within WINDOW_MS of that start; at most one early exit is counted per
 *    start;
 *  - a machine disconnect, an inactive frame without exit evidence, or an exit
 *    whose launchId does not match the current start is NOT an early exit: a
 *    transport loss is not proof of runner death, and a late exit from an
 *    earlier launch must not count against a later one;
 *  - THRESHOLD consecutive early exits block automatic wakes for the episode;
 *  - a start that runs past WINDOW_MS without an exit resets the count;
 *  - manual stop is not an exit (the caller forgets the streak instead);
 *  - only a human start/resume lifts a block, and it opens a new episode.
 *
 * State lives in the replica state store behind an optimistic compare-and-set
 * (read version → apply → write-if-unchanged, retry on conflict), so a block
 * survives a replica switch and concurrent writers cannot lose a count. The
 * pure transition functions are exported so the rules stay testable without a
 * store. Observation carrier: ids, classes, counts and times only.
 */
import {
  currentRandomUnit,
  type CredentialInvalidReason,
  isRuntimeAbsentStartFailure,
  NON_RETRYABLE_SPAWN_FAILURE_REASONS,
  RETRY_ONCE_SPAWN_FAILURE_REASONS,
  SPAWN_FAILURE_RETRY_ONCE_DELAY_MS,
  type SpawnFailureLookupReason,
  type SpawnFailureReason,
  type WakeCrashLoopActivityDiagnostic,
} from "@botiverse/raft-shared";

export const WAKE_CRASH_LOOP_WINDOW_MS = 60_000;
export const WAKE_CRASH_LOOP_THRESHOLD = 3;
/**
 * Failed starts in a row (typed start failures of any reason, each belonging
 * to the start it ends) after which automatic wakes stop, with the last
 * failure as the reason. Reasons retrying cannot fix stop sooner (see
 * `applyWakeCrashLoopStartFailure`).
 */
export const START_FAILURE_THRESHOLD = 5;
/**
 * A pause from start failures whose cause is usually outside the agent (a
 * model queued or rate-limited for everyone) must not stay forever: after
 * this cooldown one automatic wake may try again. A failed try re-pauses
 * with the cooldown doubled, up to PAUSE_RETRY_MAX_MS; the runtime reaching
 * readiness on that try lifts the pause.
 */
export const PAUSE_RETRY_BASE_MS = 30 * 60_000;
export const PAUSE_RETRY_MAX_MS = 8 * 60 * 60_000;
/**
 * A provider outage pauses many agents at about the same moment; without
 * spread their tries would stay aligned every round. Each try time is moved
 * by up to ±10% of its cooldown. The stored cooldown stays exact, so the
 * doubling stays 30m, 60m, … 8h; the jittered time may land up to 10% past
 * 8h (not capped, so agents at the cap stay spread too).
 */
export const PAUSE_RETRY_JITTER_RATIO = 0.1;
/** Start-failure reasons whose pause retries after a cooldown (see PAUSE_RETRY_BASE_MS). */
export const PAUSE_RETRY_START_FAILURE_REASONS: readonly SpawnFailureReason[] = ["runtime_start_timeout", "runtime_repeated_failure"];
/**
 * Reconciler step 12 (#proj-raft-computer:#48, decision 3): start failures a
 * runtime reports after it started, whose failures the daemon has already
 * counted (the same error N times, N crashes in a row). The start's readiness
 * reset this breaker's failed-start count, so counting them toward
 * START_FAILURE_THRESHOLD would never reach it: they pause at the first
 * report. A provider outage looks the same, so the pause retries by itself
 * (PAUSE_RETRY_START_FAILURE_REASONS). `model_unsupported` and
 * `session_needs_reset`, reported after a start too, pause at once anyway
 * (NON_RETRYABLE_SPAWN_FAILURE_REASONS).
 */
export const DAEMON_COUNTED_START_FAILURE_REASONS: readonly SpawnFailureReason[] = ["runtime_repeated_failure"];

export type WakeCrashLoopExitKind = WakeCrashLoopActivityDiagnostic["lastExitKind"];

/** How the process ended, as attached by the daemon to `agent:status inactive`. */
export interface WakeCrashLoopExitEvidence {
  code: number | null;
  signal: string | null;
}

export interface WakeCrashLoopExit {
  kind: WakeCrashLoopExitKind;
  /** Daemon exit evidence; `null` when the frame carried none (then the exit is not counted). */
  evidence: WakeCrashLoopExitEvidence | null;
  /** launchId of the run that ended; must match the current start to count. */
  launchId: string | null;
}

export type WakeCrashLoopExitRejectReason =
  | "not_process_exit"
  | "no_exit_evidence"
  | "launch_mismatch"
  | "no_start"
  | "outside_window"
  | "already_counted"
  | "already_blocked";

export interface WakeCrashLoopExitObservation {
  /** False when the exit was not eligible (see `rejected`). */
  counted: boolean;
  rejected: WakeCrashLoopExitRejectReason | null;
  /** True exactly once per episode: this exit crossed the threshold. */
  blockedNow: boolean;
  snapshot: WakeCrashLoopActivityDiagnostic;
}

/** Persisted per-agent episode state. Plain JSON: ids, counts, classes, times. */
export interface WakeCrashLoopEpisodeState {
  episode: number;
  earlyExitCount: number;
  blocked: boolean;
  blockedAtMs: number | null;
  lastStartAtMs: number | null;
  lastStartLaunchId: string | null;
  lastStartCounted: boolean;
  firstExitAtMs: number | null;
  lastExitAtMs: number | null;
  lastExitKind: WakeCrashLoopExitKind | null;
  lastSignal: string | null;
  lastLaunchId: string | null;
  /**
   * task #1221: set when the block came from a start failure that retrying
   * cannot fix (e.g. the model is not configured on the computer), instead of
   * repeated early exits. Absent on older records (= null).
   */
  needsActionReason?: string | null;
  /**
   * task #1221: messages may have arrived while automatic wakes were refused
   * for a non-retryable start failure. Starts carry the unread catch-up (with
   * or without a session) until one that carried it reports its runtime
   * active; only that clears it.
   */
  catchupOwed?: boolean;
  /** task #1221: the start (launchId) that carried the owed catch-up, pending its active report. */
  catchupCarriedLaunchId?: string | null;
  /**
   * Failed starts in a row, any reason; a start that reports its runtime
   * active, a new episode or a config change resets it. Absent on older
   * records (= 0).
   */
  startFailureCount?: number;
  /** Reason of the last counted start failure (absent = null). */
  lastStartFailureReason?: string | null;
  /** The start whose failure was counted last: one count per start. */
  lastStartFailureLaunchId?: string | null;
  /**
   * A retry-once failure (`RETRY_ONCE_SPAWN_FAILURE_REASONS`) holds automatic
   * wakes until this time; the server then retries once. Absent = null.
   */
  retryAfterMs?: number | null;
  /**
   * task #365: the start (launchId) whose failure the RFC 071 terminal
   * breaker owns: its outbox proved no process was created
   * (`not_spawned: spawn_error`) and counts it in its own bounded backoff, so
   * this streak does not count it again. Written only in the same
   * compare-and-set that commits that outcome. Absent = null (= no owner).
   */
  startFailureOwnedLaunchId?: string | null;
  /**
   * task #365: the start whose counted failure set `blocked` (written by the
   * start-failure path only; an early-exit block leaves it null). Only that
   * start's ownership can lift the block. Absent = null (= never lifted).
   */
  blockedByLaunchId?: string | null;
  /**
   * Fingerprint of the needs-action runtime error the owner was last told
   * about, written only after the notice was posted. Survives a human start
   * and a manual stop (restarting without a fix is not news to them); any
   * runtime config change or a run that clears the error forgets it, so the
   * next failure is reported again. Absent = null.
   */
  actionRequiredNotifiedFingerprint?: string | null;
  /**
   * A pause that retries by itself (PAUSE_RETRY_START_FAILURE_REASONS): from
   * this time one automatic wake may start the agent. Absent = null (the
   * pause waits for a person, as before).
   */
  pauseRetryAtMs?: number | null;
  /** The cooldown that set `pauseRetryAtMs`; doubles on every try. Absent = null. */
  pauseRetryCooldownMs?: number | null;
  /** The start that is the current try; its readiness lifts the pause. Absent = null. */
  pauseRetryLaunchId?: string | null;
  /**
   * Reconciler step 12: the try whose readiness lifted a self-retrying pause,
   * and that try's cooldown. A runtime can fail only after it is ready (the
   * same error again, a crash streak the daemon counted): when this same
   * start then fails for a self-retrying reason, the pause comes back with
   * that cooldown instead of starting over at PAUSE_RETRY_BASE_MS, so the
   * tries keep doubling. Any later start forgets it. Absent = null.
   */
  pauseRetryReadyLaunchId?: string | null;
  pauseRetryReadyCooldownMs?: number | null;
  /**
   * Reconciler step 12 follow-up: the owner was told that this
   * `runtime_repeated_failure` pause's cooldown reached PAUSE_RETRY_MAX_MS
   * (`pauseRetryCapNoticeDue`), written only after the notice was posted.
   * Kept while the tries go on (also across a ready try that fails again,
   * which comes back at the same cooldown); forgotten when the cooldown would
   * start over: a later start outside the pause, a human start, a manual stop,
   * a config change. Absent on older records (= not told).
   */
  pauseRetryCapNotified?: boolean;
}

/** The pause-retry fields of a state with no self-retrying pause. */
const NO_PAUSE_RETRY = {
  pauseRetryAtMs: null,
  pauseRetryCooldownMs: null,
  pauseRetryLaunchId: null,
} as const satisfies Partial<WakeCrashLoopEpisodeState>;

/** No ready try to come back to (see `pauseRetryReadyLaunchId`). */
const NO_PAUSE_RETRY_READY = {
  pauseRetryReadyLaunchId: null,
  pauseRetryReadyCooldownMs: null,
} as const satisfies Partial<WakeCrashLoopEpisodeState>;

/** Token returned by `recordStart`; lets a failed dispatch roll the record back. */
export interface WakeCrashLoopStartRecord {
  launchId: string | null;
  nowMs: number;
  previous: WakeCrashLoopEpisodeState;
}

/** Versioned read; `version` 0 means "no state yet" and is the expected version for a first write. */
export interface WakeCrashLoopStateRecord {
  state: WakeCrashLoopEpisodeState;
  version: number;
}

/**
 * The shared-store seam. `compareAndSet` must be atomic with respect to other
 * writers: write only if the stored version equals `expectedVersion` (0 when
 * absent) and bump it; return false otherwise.
 */
export interface WakeCrashLoopStateStore {
  getWakeCrashLoopState(agentId: string): Promise<WakeCrashLoopStateRecord | null>;
  compareAndSetWakeCrashLoopState(agentId: string, expectedVersion: number, state: WakeCrashLoopEpisodeState): Promise<boolean>;
}

export function freshWakeCrashLoopEpisode(episode: number): WakeCrashLoopEpisodeState {
  return {
    episode,
    earlyExitCount: 0,
    blocked: false,
    blockedAtMs: null,
    lastStartAtMs: null,
    lastStartLaunchId: null,
    lastStartCounted: false,
    firstExitAtMs: null,
    lastExitAtMs: null,
    lastExitKind: null,
    lastSignal: null,
    lastLaunchId: null,
  };
}

export interface WakeCrashLoopRules {
  windowMs: number;
  threshold: number;
  /** Default START_FAILURE_THRESHOLD. */
  startFailureThreshold?: number;
  /** Default SPAWN_FAILURE_RETRY_ONCE_DELAY_MS. */
  retryOnceDelayMs?: number;
  /** First cooldown of a self-retrying pause. Default PAUSE_RETRY_BASE_MS. */
  pauseRetryBaseMs?: number;
  /** Uniform [0, 1) source for the try-time jitter. Default `currentRandomUnit`; tests inject a fixed one. */
  random?: () => number;
}

export const DEFAULT_WAKE_CRASH_LOOP_RULES: WakeCrashLoopRules = {
  windowMs: WAKE_CRASH_LOOP_WINDOW_MS,
  threshold: WAKE_CRASH_LOOP_THRESHOLD,
  startFailureThreshold: START_FAILURE_THRESHOLD,
  retryOnceDelayMs: SPAWN_FAILURE_RETRY_ONCE_DELAY_MS,
  pauseRetryBaseMs: PAUSE_RETRY_BASE_MS,
};

/** When a try is due: `cooldownMs` from now, moved by up to ±PAUSE_RETRY_JITTER_RATIO of it. */
function jitteredPauseRetryAtMs(nowMs: number, cooldownMs: number, rules: WakeCrashLoopRules): number {
  const unit = (rules.random ?? currentRandomUnit)();
  return nowMs + Math.round(cooldownMs * (1 + PAUSE_RETRY_JITTER_RATIO * (2 * unit - 1)));
}

/** The pause retries by itself and its cooldown has run out: one automatic wake may try. */
function isPauseRetryDue(state: WakeCrashLoopEpisodeState, nowMs: number): boolean {
  const retryAtMs = state.pauseRetryAtMs ?? null;
  return state.blocked && retryAtMs !== null && nowMs >= retryAtMs;
}

/**
 * Whether automatic starts are refused now: blocked, unless the pause's
 * cooldown has run out (then exactly the next start is its try, see
 * `applyWakeCrashLoopStart`).
 */
export function wakeCrashLoopRefusesAutomaticStart(state: WakeCrashLoopEpisodeState, nowMs: number): boolean {
  return state.blocked && !isPauseRetryDue(state, nowMs);
}

function hasStartFailureStreak(state: WakeCrashLoopEpisodeState): boolean {
  return (state.startFailureCount ?? 0) > 0 || (state.retryAfterMs ?? null) !== null;
}

/** The start-failure fields of a state with no failed start counted. */
const NO_START_FAILURE_STREAK = {
  startFailureCount: 0,
  lastStartFailureReason: null,
  lastStartFailureLaunchId: null,
  retryAfterMs: null,
} as const satisfies Partial<WakeCrashLoopEpisodeState>;

/**
 * A start was dispatched. `human` starts (manual start / resume) always lift a
 * block and open a new episode; automatic starts keep the episode. A start
 * whose predecessor ran past the window without an exit resets the count.
 */
export function applyWakeCrashLoopStart(
  current: WakeCrashLoopEpisodeState,
  input: { launchId: string | null; nowMs: number; human: boolean },
  rules: WakeCrashLoopRules = DEFAULT_WAKE_CRASH_LOOP_RULES,
): WakeCrashLoopEpisodeState {
  let state: WakeCrashLoopEpisodeState = { ...current };
  if (input.human && (state.blocked || state.earlyExitCount > 0 || hasStartFailureStreak(state))) {
    // A new episode, but an owed catch-up survives until it is delivered, and
    // the owner is not told again about an error they have already seen.
    state = {
      ...freshWakeCrashLoopEpisode(state.episode + 1),
      catchupOwed: current.catchupOwed === true,
      actionRequiredNotifiedFingerprint: current.actionRequiredNotifiedFingerprint ?? null,
    };
  } else if (!input.human && isPauseRetryDue(state, input.nowMs)) {
    // This start is the pause's try. The next try is armed now, with the
    // cooldown doubled, so a try that fails in any way (a typed failure, a
    // crash, no report at all) leads to the next one; its readiness lifts
    // the pause instead (`applyWakeCrashLoopStartSucceeded`).
    const cooldownMs = Math.min(PAUSE_RETRY_MAX_MS, 2 * (state.pauseRetryCooldownMs ?? PAUSE_RETRY_BASE_MS));
    state.pauseRetryCooldownMs = cooldownMs;
    state.pauseRetryAtMs = jitteredPauseRetryAtMs(input.nowMs, cooldownMs, rules);
    state.pauseRetryLaunchId = input.launchId;
  } else if (
    state.lastStartAtMs !== null
    && !state.lastStartCounted
    && input.nowMs - state.lastStartAtMs > rules.windowMs
  ) {
    // The previous run survived the window: the streak is broken.
    state.earlyExitCount = 0;
    state.firstExitAtMs = null;
  }
  state.lastStartAtMs = input.nowMs;
  state.lastStartLaunchId = input.launchId;
  state.lastStartCounted = false;
  // A later start is not the ready try a pause could come back to.
  Object.assign(state, NO_PAUSE_RETRY_READY);
  // Outside a self-retrying pause the next one starts at the first cooldown
  // again, so reaching the cap would be news again.
  if (state.pauseRetryCapNotified === true && (state.pauseRetryCooldownMs ?? null) === null) state.pauseRetryCapNotified = false;
  // A new start supersedes any earlier carrier; the owed catch-up stays until delivered.
  state.catchupCarriedLaunchId = null;
  return state;
}

/** Human said stop: the agent is offline by intent; forget the streak but keep the episode number. */
export function applyWakeCrashLoopManualStop(current: WakeCrashLoopEpisodeState): WakeCrashLoopEpisodeState {
  // task #1221: an undelivered catch-up survives the stop; the carrier (if any)
  // loses its claim, so only a later start that carries it again can clear it.
  return {
    ...freshWakeCrashLoopEpisode(current.episode),
    catchupOwed: current.catchupOwed === true,
    catchupCarriedLaunchId: null,
    actionRequiredNotifiedFingerprint: current.actionRequiredNotifiedFingerprint ?? null,
  };
}

export function wakeCrashLoopExitRejectReason(
  state: WakeCrashLoopEpisodeState,
  exit: WakeCrashLoopExit,
  nowMs: number,
  rules: WakeCrashLoopRules = DEFAULT_WAKE_CRASH_LOOP_RULES,
): WakeCrashLoopExitRejectReason | null {
  if (exit.kind !== "agent_process_exited") return "not_process_exit";
  if (!exit.evidence) return "no_exit_evidence";
  if (state.lastStartAtMs === null || state.lastStartLaunchId === null) return "no_start";
  if (exit.launchId === null || exit.launchId !== state.lastStartLaunchId) return "launch_mismatch";
  if (state.blocked) return "already_blocked";
  if (state.lastStartCounted) return "already_counted";
  if (nowMs - state.lastStartAtMs > rules.windowMs) return "outside_window";
  return null;
}

export function applyWakeCrashLoopExit(
  current: WakeCrashLoopEpisodeState,
  exit: WakeCrashLoopExit,
  nowMs: number,
  rules: WakeCrashLoopRules = DEFAULT_WAKE_CRASH_LOOP_RULES,
): { state: WakeCrashLoopEpisodeState; counted: boolean; rejected: WakeCrashLoopExitRejectReason | null; blockedNow: boolean } {
  const rejected = wakeCrashLoopExitRejectReason(current, exit, nowMs, rules);
  if (rejected) return { state: current, counted: false, rejected, blockedNow: false };
  const state: WakeCrashLoopEpisodeState = { ...current };
  state.lastStartCounted = true;
  state.earlyExitCount += 1;
  state.firstExitAtMs ??= nowMs;
  state.lastExitAtMs = nowMs;
  state.lastExitKind = exit.kind;
  state.lastSignal = exit.evidence?.signal ?? null;
  state.lastLaunchId = exit.launchId;
  const blockedNow = state.earlyExitCount >= rules.threshold;
  if (blockedNow) {
    state.blocked = true;
    state.blockedAtMs = nowMs;
  }
  return { state, counted: true, rejected: null, blockedNow };
}

export type WakeCrashLoopStartFailureOutcome =
  /** Not this start's failure, already counted, or already blocked: no change. */
  | "ignored"
  /** Counted; automatic wakes continue. */
  | "counted"
  /** Counted; automatic wakes wait `retryOnceDelayMs`, then the server retries once. */
  | "retry_scheduled"
  /** Counted and automatic wakes are now blocked (needs the owner). */
  | "blocked"
  /**
   * A self-retrying pause's try failed for a reason outside
   * PAUSE_RETRY_START_FAILURE_REASONS: the self-retry ends, the pause now
   * waits for a person, with that reason.
   */
  | "pause_retry_ended"
  /** task #365: the RFC 071 breaker owns this start's failure: not counted here. */
  | "owned_by_terminal_breaker";

/**
 * A start failed with a typed reason. Counted only when the failure belongs to
 * the current start, once per start: a late failure from an older launch must
 * not count against (or block) a start a person or a config change has since
 * made. Then, in order:
 *  - task #1221: a reason retrying cannot fix blocks at once; so does a
 *    runtime the computer does not have (`runtime_not_found`), unless the
 *    lookup itself timed out or failed;
 *  - a retry-once reason blocks when the previous counted failure had the same
 *    reason (the retry failed too), else holds automatic wakes for
 *    `retryOnceDelayMs` so the server retries once after it;
 *  - any reason blocks once `startFailureThreshold` starts failed in a row.
 * A block keeps the last reason (`needsActionReason`) and owes the unread
 * catch-up to the start that follows it; so does a held retry. A threshold
 * block for a reason in PAUSE_RETRY_START_FAILURE_REASONS also arms its first
 * automatic try after `pauseRetryBaseMs`. While blocked, failures are ignored,
 * except one of a self-retrying pause's own try that only a person can fix
 * (`startFailureNeedsPerson`): that ends the self-retry (`pause_retry_ended`).
 * Any other failure of the try is just a failed try: the next one, already
 * armed with the doubled cooldown, stands.
 */
export function applyWakeCrashLoopStartFailure(
  current: WakeCrashLoopEpisodeState,
  input: { launchId: string | null; reason: string; lookupReason?: SpawnFailureLookupReason; nowMs: number },
  rules: WakeCrashLoopRules = DEFAULT_WAKE_CRASH_LOOP_RULES,
): { state: WakeCrashLoopEpisodeState; outcome: WakeCrashLoopStartFailureOutcome } {
  if (input.launchId === null || input.launchId !== current.lastStartLaunchId) return { state: current, outcome: "ignored" };
  if ((current.startFailureOwnedLaunchId ?? null) === input.launchId) return { state: current, outcome: "owned_by_terminal_breaker" };
  if (current.blocked) {
    // `pauseRetryLaunchId` is cleared when a try ends the self-retry, so this
    // applies once per try.
    if ((current.pauseRetryLaunchId ?? null) !== input.launchId || !startFailureNeedsPerson(input.reason, input.lookupReason)) {
      return { state: current, outcome: "ignored" };
    }
    return {
      state: {
        ...endPauseRetry(current, input.launchId, input.reason),
        startFailureCount: (current.startFailureCount ?? 0) + 1,
        lastStartFailureReason: input.reason,
        lastStartFailureLaunchId: input.launchId,
      },
      outcome: "pause_retry_ended",
    };
  }
  if (current.lastStartFailureLaunchId === input.launchId) return { state: current, outcome: "ignored" };
  const previousCount = current.startFailureCount ?? 0;
  const count = previousCount + 1;
  const counted: WakeCrashLoopEpisodeState = {
    ...current,
    startFailureCount: count,
    lastStartFailureReason: input.reason,
    lastStartFailureLaunchId: input.launchId,
    retryAfterMs: null,
  };
  const reason = input.reason as SpawnFailureReason;
  const retryOnce = RETRY_ONCE_SPAWN_FAILURE_REASONS.includes(reason);
  const block = NON_RETRYABLE_SPAWN_FAILURE_REASONS.includes(reason)
    || DAEMON_COUNTED_START_FAILURE_REASONS.includes(reason)
    || isRuntimeAbsentStartFailure(reason, input.lookupReason)
    || (retryOnce && previousCount > 0 && current.lastStartFailureReason === input.reason)
    || count >= (rules.startFailureThreshold ?? START_FAILURE_THRESHOLD);
  if (block) {
    // A try that was ready and then failed comes back with its own cooldown
    // (already doubled when it started), not the first one.
    const readyTryCooldownMs = (current.pauseRetryReadyLaunchId ?? null) === input.launchId
      ? current.pauseRetryReadyCooldownMs ?? null
      : null;
    const pauseRetryCooldownMs = PAUSE_RETRY_START_FAILURE_REASONS.includes(reason)
      ? readyTryCooldownMs ?? rules.pauseRetryBaseMs ?? PAUSE_RETRY_BASE_MS
      : null;
    return {
      state: {
        ...counted,
        blocked: true,
        blockedAtMs: input.nowMs,
        lastLaunchId: input.launchId,
        needsActionReason: input.reason,
        blockedByLaunchId: input.launchId,
        catchupOwed: true,
        ...NO_PAUSE_RETRY_READY,
        ...(pauseRetryCooldownMs === null
          ? NO_PAUSE_RETRY
          : { pauseRetryCooldownMs, pauseRetryAtMs: jitteredPauseRetryAtMs(input.nowMs, pauseRetryCooldownMs, rules), pauseRetryLaunchId: null }),
      },
      outcome: "blocked",
    };
  }
  if (retryOnce) {
    return {
      state: { ...counted, retryAfterMs: input.nowMs + (rules.retryOnceDelayMs ?? SPAWN_FAILURE_RETRY_ONCE_DELAY_MS), catchupOwed: true },
      outcome: "retry_scheduled",
    };
  }
  return { state: counted, outcome: "counted" };
}

/**
 * A failure of a self-retrying pause's try that only a person can fix (used
 * only there; ordinary starts keep their own rules): a reason retrying cannot
 * fix (NON_RETRYABLE_SPAWN_FAILURE_REASONS), a runtime confirmed missing on
 * the computer, a malformed provider API key, a runtime version known not to
 * work, or a retry-once reason (`model_not_found`). On an ordinary start the
 * retry-once reason gets one retry a minute later in case the model list was
 * momentarily empty; tries are at least 27 minutes apart, so here its first
 * occurrence is already the confirmation. Transient reasons (the unclassified
 * spawn failure, a credential mint or provider connection error, a proxy
 * bind, an undecided runtime lookup) never end it.
 */
export function startFailureNeedsPerson(reason: string, lookupReason: SpawnFailureLookupReason | undefined): boolean {
  return NON_RETRYABLE_SPAWN_FAILURE_REASONS.includes(reason as SpawnFailureReason)
    || RETRY_ONCE_SPAWN_FAILURE_REASONS.includes(reason as SpawnFailureReason)
    || isRuntimeAbsentStartFailure(reason, lookupReason)
    || reason === "provider_api_key_invalid"
    || reason === "runtime_version_too_old";
}

/**
 * Reconciler step 12 follow-up: a `runtime_repeated_failure` pause whose
 * cooldown has reached PAUSE_RETRY_MAX_MS (its tries keep failing, now every
 * 8 hours) and whose owner was not told yet. Asked after a failure report,
 * so the try at the cap has failed; the caller posts the notice and then
 * records it (`markPauseRetryCapNotified`).
 */
export function pauseRetryCapNoticeDue(state: WakeCrashLoopEpisodeState): boolean {
  return state.blocked
    && state.needsActionReason === "runtime_repeated_failure"
    && (state.pauseRetryAtMs ?? null) !== null
    && state.pauseRetryCooldownMs === PAUSE_RETRY_MAX_MS
    && state.pauseRetryCapNotified !== true;
}

/** A self-retrying pause's try hit something only a person can fix: stop trying, keep the pause, with that reason. */
function endPauseRetry(current: WakeCrashLoopEpisodeState, launchId: string, reason: string): WakeCrashLoopEpisodeState {
  return {
    ...current,
    ...NO_PAUSE_RETRY,
    lastLaunchId: launchId,
    needsActionReason: reason,
    blockedByLaunchId: launchId,
  };
}

/**
 * task #365: the RFC 071 terminal breaker just committed `not_spawned:
 * spawn_error` for `launchId` (its current launch): it owns that start's
 * failure. Applied only inside that commit's compare-and-set, never on its
 * own, so a replayed, stale or mismatched outcome changes nothing here.
 *  - Ownership is recorded only when `launchId` is also this record's
 *    current start; a late activity for it is then not counted.
 *  - If this streak already counted that start (it is the last counted
 *    start), exactly that contribution is withdrawn: one count, the
 *    retry-once it scheduled, and the block only when that start set it
 *    (`blockedByLaunchId`). An early-exit block, another start's failure, a
 *    manual stop (which already cleared the streak) are left alone. A record
 *    without `blockedByLaunchId` (written by an older replica) keeps its
 *    block: withdrawing it then needs a person.
 */
export function applyWakeCrashLoopStartFailureOwned(
  current: WakeCrashLoopEpisodeState,
  launchId: string,
): { state: WakeCrashLoopEpisodeState; changed: boolean; withdrawn: boolean; unblocked: boolean } {
  if (current.lastStartLaunchId !== launchId) return { state: current, changed: false, withdrawn: false, unblocked: false };
  const state: WakeCrashLoopEpisodeState = { ...current, startFailureOwnedLaunchId: launchId };
  if ((current.lastStartFailureLaunchId ?? null) !== launchId) return { state, changed: true, withdrawn: false, unblocked: false };
  const count = Math.max(0, (current.startFailureCount ?? 0) - 1);
  state.startFailureCount = count;
  state.lastStartFailureLaunchId = null;
  if (count === 0) state.lastStartFailureReason = null;
  state.retryAfterMs = null;
  const unblocked = current.blocked && (current.blockedByLaunchId ?? null) === launchId;
  if (unblocked) {
    state.blocked = false;
    state.blockedAtMs = null;
    state.needsActionReason = null;
    state.blockedByLaunchId = null;
    Object.assign(state, NO_PAUSE_RETRY);
  }
  return { state, changed: true, withdrawn: true, unblocked };
}

/** Block reasons a sign-in fixes: a runtime error's `user_reauth`, a start failure's `runtime_login_required`. */
const AUTH_CLASS_BLOCK_REASONS: ReadonlySet<string> = new Set(["user_reauth", "runtime_login_required"]);

/**
 * #proj-raft-computer:#48 (step 4b): the block reasons a restored credential
 * reason lifts. A restored `user_reauth` proves a working sign-in for the
 * runtime, which is also what a start's `runtime_login_required` waits for;
 * a billing balance or a model's plan access restored lifts only its own.
 */
const CREDENTIAL_RESTORED_LIFTS: Readonly<Record<CredentialInvalidReason, ReadonlySet<string>>> = {
  // Reconciler step 12: a working sign-in may be another account, whose plan
  // may have the model (a start's `model_unsupported`).
  user_reauth: new Set([...AUTH_CLASS_BLOCK_REASONS, "model_unsupported"]),
  user_model_access: new Set(["user_model_access", "model_unsupported"]),
  billing: new Set(["billing"]),
};

/**
 * Block reasons a web login or provider connect for the agent's runtime
 * lifts (`liftForCredentialsChange`): the sign-in ones, and (reconciler step
 * 12) `model_unsupported`, since a new key or plan may have the model.
 */
const CREDENTIALS_CHANGE_LIFTS: ReadonlySet<string> = new Set([...AUTH_CLASS_BLOCK_REASONS, "model_unsupported"]);

/**
 * What lifts a credentials change: `credentials_change` (a web login or
 * provider connect: `CREDENTIALS_CHANGE_LIFTS`), or `sign_in` (reconciler
 * step 15, a terminal sign-in seen on disk: the sign-in blocks only, since a
 * changed file may be a token refresh of the same account and plan).
 */
export type CredentialsChangeLiftScope = "credentials_change" | "sign_in";
const CREDENTIALS_CHANGE_LIFTS_BY_SCOPE: Readonly<Record<CredentialsChangeLiftScope, ReadonlySet<string>>> = {
  credentials_change: CREDENTIALS_CHANGE_LIFTS,
  sign_in: AUTH_CLASS_BLOCK_REASONS,
};

export type WakeCrashLoopActionRequiredOutcome =
  /** Not the current start's error, or no start recorded: no change. */
  | "ignored"
  /** The error came from a self-retrying pause's try: the self-retry ends, the pause takes this reason. */
  | "pause_retry_ended"
  /** Already blocked: nothing new to hold. */
  | "already_blocked"
  /** Automatic wakes are now blocked until the owner acts. */
  | "blocked";

/**
 * The current start's runtime reported an error only the owner can fix (a
 * rejected credential, a model the plan does not allow). Retrying cannot help,
 * so automatic wakes stop at once, like a non-retryable start failure: the
 * block keeps the reason, owes the unread catch-up, and lifts on a human start
 * or a runtime config change. `notify` is true when the owner has not been
 * told about this error (by fingerprint) yet; the caller records the
 * fingerprint once the notice is actually posted (`markActionRequiredNotified`).
 */
export function applyWakeCrashLoopActionRequired(
  current: WakeCrashLoopEpisodeState,
  input: { launchId: string | null; reason: string; fingerprint: string; nowMs: number },
): { state: WakeCrashLoopEpisodeState; outcome: WakeCrashLoopActionRequiredOutcome; notify: boolean } {
  if (input.launchId === null || input.launchId !== current.lastStartLaunchId) {
    return { state: current, outcome: "ignored", notify: false };
  }
  const notify = (current.actionRequiredNotifiedFingerprint ?? null) !== input.fingerprint;
  // A runtime that needs a login or a model fix during a self-retrying
  // pause's try (Codex, Grok: before any output) ends the self-retry.
  if (current.blocked && (current.pauseRetryLaunchId ?? null) === input.launchId) {
    return { state: endPauseRetry(current, input.launchId, input.reason), outcome: "pause_retry_ended", notify };
  }
  if (current.blocked) return { state: current, outcome: "already_blocked", notify: false };
  return {
    state: {
      ...current,
      blocked: true,
      blockedAtMs: input.nowMs,
      lastLaunchId: input.launchId,
      needsActionReason: input.reason,
      blockedByLaunchId: input.launchId,
      catchupOwed: true,
    },
    outcome: "blocked",
    notify,
  };
}

/**
 * A start made real progress: its runtime reached startup readiness (or, from
 * a daemon without DAEMON_CAPABILITY_STARTUP_READINESS, reported active). The
 * failed-start streak is over, and when this start was a self-retrying
 * pause's try, so is the pause.
 */
export function applyWakeCrashLoopStartSucceeded(
  current: WakeCrashLoopEpisodeState,
  launchId: string,
): { state: WakeCrashLoopEpisodeState; changed: boolean; unpaused: boolean } {
  if (current.lastStartLaunchId !== launchId) return { state: current, changed: false, unpaused: false };
  if (current.blocked && (current.pauseRetryLaunchId ?? null) === launchId) {
    return {
      state: {
        ...current,
        ...NO_START_FAILURE_STREAK,
        ...NO_PAUSE_RETRY,
        pauseRetryReadyLaunchId: launchId,
        pauseRetryReadyCooldownMs: current.pauseRetryCooldownMs ?? null,
        blocked: false,
        blockedAtMs: null,
        needsActionReason: null,
        blockedByLaunchId: null,
      },
      changed: true,
      unpaused: true,
    };
  }
  if (!hasStartFailureStreak(current)) return { state: current, changed: false, unpaused: false };
  return { state: { ...current, ...NO_START_FAILURE_STREAK }, changed: true, unpaused: false };
}

export type WakeCrashLoopAutomaticWakeHold =
  | { kind: "blocked"; reason: string | null }
  | { kind: "retry_pending"; retryAfterMs: number };

/** Why an automatic wake may not start now, or null when it may. Human starts ignore this. */
export function wakeCrashLoopAutomaticWakeHold(state: WakeCrashLoopEpisodeState, nowMs: number): WakeCrashLoopAutomaticWakeHold | null {
  if (wakeCrashLoopRefusesAutomaticStart(state, nowMs)) return { kind: "blocked", reason: state.needsActionReason ?? null };
  if (state.blocked) return null;
  const retryAfterMs = state.retryAfterMs ?? null;
  if (retryAfterMs !== null && nowMs < retryAfterMs) return { kind: "retry_pending", retryAfterMs };
  return null;
}

const WAKE_CRASH_LOOP_EXIT_KINDS: ReadonlySet<string> = new Set(["machine_disconnected", "agent_process_exited"]);
const MAX_WAKE_CRASH_LOOP_ID_LENGTH = 128;

function isNullableNonNegativeInt(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isNullableBoundedString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= MAX_WAKE_CRASH_LOOP_ID_LENGTH);
}

/**
 * Shape-validate a mirrored breaker carrier. Anything that is not exactly the
 * typed diagnostic (ids, counts, classes, times) is dropped, never propagated.
 */
export function normalizeWakeCrashLoopActivityDiagnostic(value: unknown): WakeCrashLoopActivityDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (!Number.isInteger(c.episode) || (c.episode as number) < 1) return null;
  if (!Number.isInteger(c.earlyExitCount) || (c.earlyExitCount as number) < 0) return null;
  if (!Number.isInteger(c.threshold) || (c.threshold as number) < 1) return null;
  if (!Number.isInteger(c.windowMs) || (c.windowMs as number) < 1) return null;
  if (typeof c.blocked !== "boolean") return null;
  if (!isNullableNonNegativeInt(c.blockedAtMs) || !isNullableNonNegativeInt(c.firstExitAtMs) || !isNullableNonNegativeInt(c.lastExitAtMs)) return null;
  if (c.lastExitKind !== null && !(typeof c.lastExitKind === "string" && WAKE_CRASH_LOOP_EXIT_KINDS.has(c.lastExitKind))) return null;
  if (!isNullableBoundedString(c.lastSignal) || !isNullableBoundedString(c.lastLaunchId)) return null;
  return {
    episode: c.episode as number,
    earlyExitCount: c.earlyExitCount as number,
    threshold: c.threshold as number,
    windowMs: c.windowMs as number,
    blocked: c.blocked,
    blockedAtMs: c.blockedAtMs,
    firstExitAtMs: c.firstExitAtMs,
    lastExitAtMs: c.lastExitAtMs,
    lastExitKind: c.lastExitKind as WakeCrashLoopExitKind | null,
    lastSignal: c.lastSignal,
    lastLaunchId: c.lastLaunchId,
  };
}

export function wakeCrashLoopSnapshot(
  state: WakeCrashLoopEpisodeState,
  rules: WakeCrashLoopRules = DEFAULT_WAKE_CRASH_LOOP_RULES,
): WakeCrashLoopActivityDiagnostic {
  return {
    episode: state.episode,
    earlyExitCount: state.earlyExitCount,
    threshold: rules.threshold,
    windowMs: rules.windowMs,
    blocked: state.blocked,
    blockedAtMs: state.blockedAtMs,
    firstExitAtMs: state.firstExitAtMs,
    lastExitAtMs: state.lastExitAtMs,
    lastExitKind: state.lastExitKind,
    lastSignal: state.lastSignal,
    lastLaunchId: state.lastLaunchId,
  };
}

/** Process-local store: the no-Redis (single replica) fallback and the unit-test default. */
export class InMemoryWakeCrashLoopStateStore implements WakeCrashLoopStateStore {
  private readonly records = new Map<string, WakeCrashLoopStateRecord>();

  async getWakeCrashLoopState(agentId: string): Promise<WakeCrashLoopStateRecord | null> {
    return this.getWakeCrashLoopStateSync(agentId);
  }

  async compareAndSetWakeCrashLoopState(agentId: string, expectedVersion: number, state: WakeCrashLoopEpisodeState): Promise<boolean> {
    return this.compareAndSetWakeCrashLoopStateSync(agentId, expectedVersion, state);
  }

  /**
   * Synchronous forms, so a caller can read and write this store together
   * with another process-local store in one JS turn (RFC 071 combined claim).
   */
  getWakeCrashLoopStateSync(agentId: string): WakeCrashLoopStateRecord | null {
    const record = this.records.get(agentId);
    return record ? { state: { ...record.state }, version: record.version } : null;
  }

  compareAndSetWakeCrashLoopStateSync(agentId: string, expectedVersion: number, state: WakeCrashLoopEpisodeState): boolean {
    const current = this.records.get(agentId)?.version ?? 0;
    if (current !== expectedVersion) return false;
    this.records.set(agentId, { state: { ...state }, version: current + 1 });
    return true;
  }
}

const CAS_MAX_ATTEMPTS = 16;

export class WakeCrashLoopBreaker {
  private readonly rules: WakeCrashLoopRules;

  constructor(
    private readonly store: WakeCrashLoopStateStore = new InMemoryWakeCrashLoopStateStore(),
    options: Partial<WakeCrashLoopRules> = {},
  ) {
    this.rules = {
      windowMs: options.windowMs ?? WAKE_CRASH_LOOP_WINDOW_MS,
      threshold: options.threshold ?? WAKE_CRASH_LOOP_THRESHOLD,
      startFailureThreshold: options.startFailureThreshold ?? START_FAILURE_THRESHOLD,
      retryOnceDelayMs: options.retryOnceDelayMs ?? SPAWN_FAILURE_RETRY_ONCE_DELAY_MS,
      // Capped like every later cooldown, so the sequence never shrinks.
      pauseRetryBaseMs: Math.min(PAUSE_RETRY_MAX_MS, options.pauseRetryBaseMs ?? PAUSE_RETRY_BASE_MS),
      random: options.random ?? currentRandomUnit,
    };
  }

  private async read(agentId: string): Promise<WakeCrashLoopStateRecord> {
    const record = await this.store.getWakeCrashLoopState(agentId);
    return record ?? { state: freshWakeCrashLoopEpisode(1), version: 0 };
  }

  /**
   * Read → transition → compare-and-set, retried on version conflict so two
   * writers (two replicas, or a start racing an exit) both land their update
   * on the latest state instead of one overwriting the other.
   */
  private async mutate<T>(
    agentId: string,
    transition: (state: WakeCrashLoopEpisodeState) => { state: WakeCrashLoopEpisodeState; result: T; write: boolean },
  ): Promise<T> {
    let last: { state: WakeCrashLoopEpisodeState; result: T } | null = null;
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
      const record = await this.read(agentId);
      const next = transition(record.state);
      last = next;
      if (!next.write) return next.result;
      if (await this.store.compareAndSetWakeCrashLoopState(agentId, record.version, next.state)) return next.result;
    }
    throw new Error(`wake crash-loop state for agent ${agentId}: compare-and-set did not converge after ${CAS_MAX_ATTEMPTS} attempts`);
  }

  async isBlocked(agentId: string): Promise<boolean> {
    return (await this.read(agentId)).state.blocked;
  }

  /** See `wakeCrashLoopAutomaticWakeHold`. */
  async automaticWakeHold(agentId: string, nowMs: number): Promise<WakeCrashLoopAutomaticWakeHold | null> {
    return wakeCrashLoopAutomaticWakeHold((await this.read(agentId)).state, nowMs);
  }

  /** When a self-retrying pause next tries, or null when the agent is not in one. */
  async pauseRetryAtMs(agentId: string): Promise<number | null> {
    const { state } = await this.read(agentId);
    return state.blocked ? state.pauseRetryAtMs ?? null : null;
  }

  /** task #1221: does the next start owe the unread catch-up (see `catchupOwed`)? */
  async isCatchupOwed(agentId: string): Promise<boolean> {
    return (await this.read(agentId)).state.catchupOwed === true;
  }

  /** task #1221: this start (launchId) carries the owed catch-up. */
  async markCatchupCarried(agentId: string, launchId: string): Promise<void> {
    await this.mutate(agentId, (state) => state.catchupOwed === true && state.lastStartLaunchId === launchId
      ? { state: { ...state, catchupCarriedLaunchId: launchId }, result: undefined, write: true }
      : { state, result: undefined, write: false });
  }

  /**
   * task #1221: the catch-up a start built found nothing unread (the agent
   * read the owed messages some other way, e.g. `raft message check` from a
   * start that did not carry them): nothing is owed any more, so clear it.
   * Otherwise the flag would outlive its messages and keep folding wakes into
   * catch-ups until some start carried an unread message.
   */
  async clearCatchupOwedNothingUnread(agentId: string): Promise<boolean> {
    return this.mutate(agentId, (state) => state.catchupOwed === true
      ? { state: { ...state, catchupOwed: false, catchupCarriedLaunchId: null }, result: true, write: true }
      : { state, result: false, write: false });
  }

  /**
   * task #1221: a start reported its runtime active. If it is the start that
   * carried the owed catch-up, the messages reached the runtime: clear it. A
   * failed query, a start that could not carry it, or a runtime that never
   * came up leaves it owed for the next start.
   */
  async confirmCatchupDelivered(agentId: string, launchId: string): Promise<boolean> {
    return this.mutate(agentId, (state) => state.catchupOwed === true && state.catchupCarriedLaunchId === launchId
      ? { state: { ...state, catchupOwed: false, catchupCarriedLaunchId: null }, result: true, write: true }
      : { state, result: false, write: false });
  }

  /**
   * Record a dispatched start. Returns a token for `rollbackStart` so a start
   * whose send fails can be undone without disturbing a newer start.
   */
  async recordStart(agentId: string, launchId: string | null, nowMs: number, options: { human?: boolean } = {}): Promise<WakeCrashLoopStartRecord> {
    return this.mutate(agentId, (state) => ({
      state: applyWakeCrashLoopStart(state, { launchId, nowMs, human: options.human === true }, this.rules),
      result: { launchId, nowMs, previous: { ...state } },
      write: true,
    }));
  }

  /**
   * Undo a `recordStart` whose dispatch never left this replica. Only applies
   * while the recorded start is still the current one (same launchId and
   * start time); a newer start or a counted exit leaves the state alone.
   */
  async rollbackStart(agentId: string, record: WakeCrashLoopStartRecord): Promise<boolean> {
    return this.mutate(agentId, (state) => {
      const isSameStart = state.lastStartAtMs === record.nowMs
        && state.lastStartLaunchId === record.launchId
        && !state.lastStartCounted;
      return isSameStart
        ? { state: { ...record.previous }, result: true, write: true }
        : { state, result: false, write: false };
    });
  }

  /** Returns the block the stop lifted (its reason), for the trace: a manual stop lifts any block. */
  async recordManualStop(agentId: string): Promise<{ liftedBlock: { reason: string | null } | null }> {
    return this.mutate(agentId, (state) => ({
      state: applyWakeCrashLoopManualStop(state),
      result: { liftedBlock: state.blocked ? { reason: state.needsActionReason ?? null } : null },
      write: true,
    }));
  }

  async recordExit(agentId: string, exit: WakeCrashLoopExit, nowMs: number): Promise<WakeCrashLoopExitObservation> {
    return this.mutate(agentId, (state) => {
      const applied = applyWakeCrashLoopExit(state, exit, nowMs, this.rules);
      return {
        state: applied.state,
        write: applied.counted,
        result: {
          counted: applied.counted,
          rejected: applied.rejected,
          blockedNow: applied.blockedNow,
          snapshot: wakeCrashLoopSnapshot(applied.state, this.rules),
        },
      };
    });
  }

  /**
   * See `applyWakeCrashLoopStartFailure`. Also returns the resulting state's
   * block, count and retry time, so a failure that changed nothing (already
   * blocked) can still be shown as paused.
   */
  async recordStartFailure(
    agentId: string,
    input: {
      launchId: string | null;
      reason: string;
      lookupReason?: SpawnFailureLookupReason;
      nowMs: number;
      noticeFingerprint?: string;
      /** Whether a plain block tells the owner (default true); an ended self-retry always does. */
      noticeOnBlock?: boolean;
    },
  ): Promise<{
    outcome: WakeCrashLoopStartFailureOutcome;
    blocked: boolean;
    startFailureCount: number;
    retryAfterMs: number | null;
    pauseRetryAtMs: number | null;
    /** The pause reason before this failure (for `pause_retry_ended`, the self-retrying one). */
    previousPauseReason: string | null;
    notify: boolean;
    /** This failure would tell the owner, who was already told about the same fingerprint, so `notify` is false. */
    alreadyNotified: boolean;
    /** See `pauseRetryCapNoticeDue`, on the resulting state. */
    pauseRetryCapNoticeDue: boolean;
  }> {
    return this.mutate(agentId, (state) => {
      const applied = applyWakeCrashLoopStartFailure(state, input, this.rules);
      const tells = applied.outcome === "pause_retry_ended"
        || (applied.outcome === "blocked" && input.noticeOnBlock !== false);
      const toldBefore = input.noticeFingerprint !== undefined
        && (state.actionRequiredNotifiedFingerprint ?? null) === input.noticeFingerprint;
      return {
        state: applied.state,
        write: applied.outcome !== "ignored",
        result: {
          outcome: applied.outcome,
          previousPauseReason: state.blocked ? state.needsActionReason ?? null : null,
          blocked: applied.state.blocked,
          startFailureCount: applied.state.startFailureCount ?? 0,
          retryAfterMs: applied.state.retryAfterMs ?? null,
          pauseRetryAtMs: applied.state.blocked ? applied.state.pauseRetryAtMs ?? null : null,
          // The owner is told once per fingerprint, as for a needs-action runtime error.
          notify: tells && input.noticeFingerprint !== undefined && !toldBefore,
          alreadyNotified: tells && toldBefore,
          pauseRetryCapNoticeDue: pauseRetryCapNoticeDue(applied.state),
        },
      };
    });
  }

  /** See `applyWakeCrashLoopActionRequired`. */
  async recordActionRequired(
    agentId: string,
    input: { launchId: string | null; reason: string; fingerprint: string; nowMs: number },
  ): Promise<{ outcome: WakeCrashLoopActionRequiredOutcome; notify: boolean; /** With `pause_retry_ended` only: the self-retrying reason it replaces. */ previousPauseReason?: string | null }> {
    return this.mutate(agentId, (state) => {
      const applied = applyWakeCrashLoopActionRequired(state, input);
      return {
        state: applied.state,
        write: applied.outcome === "blocked" || applied.outcome === "pause_retry_ended",
        result: {
          outcome: applied.outcome,
          notify: applied.notify,
          ...(applied.outcome === "pause_retry_ended" ? { previousPauseReason: state.needsActionReason ?? null } : {}),
        },
      };
    });
  }

  /** The owner was told about this error: the same one is not news until a fix is tried. */
  async markActionRequiredNotified(agentId: string, fingerprint: string): Promise<void> {
    await this.mutate(agentId, (state) => (state.actionRequiredNotifiedFingerprint ?? null) === fingerprint
      ? { state, result: undefined, write: false }
      : { state: { ...state, actionRequiredNotifiedFingerprint: fingerprint }, result: undefined, write: true });
  }

  /**
   * The owner was told the pause's tries reached the cap. Recorded only while
   * that is still the case, so a recovery that raced the post wins.
   */
  async markPauseRetryCapNotified(agentId: string): Promise<boolean> {
    return this.mutate(agentId, (state) => pauseRetryCapNoticeDue(state)
      ? { state: { ...state, pauseRetryCapNotified: true }, result: true, write: true }
      : { state, result: false, write: false });
  }

  /** The runtime ran past the error the owner was told about: a later one is news again. */
  async forgetActionRequiredNotice(agentId: string): Promise<void> {
    await this.mutate(agentId, (state) => (state.actionRequiredNotifiedFingerprint ?? null) === null
      ? { state, result: undefined, write: false }
      : { state: { ...state, actionRequiredNotifiedFingerprint: null }, result: undefined, write: true });
  }

  /** See `applyWakeCrashLoopStartSucceeded`. */
  async recordStartSucceeded(agentId: string, launchId: string): Promise<{ changed: boolean; unpaused: boolean }> {
    return this.mutate(agentId, (state) => {
      const applied = applyWakeCrashLoopStartSucceeded(state, launchId);
      return { state: applied.state, result: { changed: applied.changed, unpaused: applied.unpaused }, write: applied.changed };
    });
  }

  /**
   * task #1221: the agent's runtime configuration changed, so a block that
   * retrying could not lift may no longer apply. Open a fresh episode; the next
   * wake starts normally. Also drops the in-flight start's eligibility, so a
   * failure it reports after the change cannot block. A human start/resume
   * lifts a block too (recordStart).
   */
  async liftForConfigChange(agentId: string): Promise<boolean> {
    return this.mutate(agentId, (state) => {
      if (state.blocked || hasStartFailureStreak(state)) {
        return {
          state: { ...freshWakeCrashLoopEpisode(state.episode + 1), catchupOwed: state.catchupOwed === true },
          result: state.blocked,
          write: true,
        };
      }
      // Not blocked yet, but a start made under the old configuration may still
      // report its failure. Forget that start so its late failure cannot block
      // the agent under the new configuration. A new configuration also makes
      // an error the owner was told about news again.
      // So does a pause's cooldown reaching the cap (the next one starts over).
      if (state.lastStartLaunchId === null && (state.actionRequiredNotifiedFingerprint ?? null) === null && state.pauseRetryCapNotified !== true) {
        return { state, result: false, write: false };
      }
      return {
        state: { ...state, lastStartLaunchId: null, actionRequiredNotifiedFingerprint: null, ...(state.pauseRetryCapNotified === true ? { pauseRetryCapNotified: false } : {}) },
        result: false,
        write: true,
      };
    });
  }

  /**
   * The computer now reports the agent's runtime: a block that was only about
   * it missing there no longer applies. Same fresh episode as a config change
   * (the owed catch-up kept); any other block stays. The owner is not told
   * again if the start still fails: the listing and the start disagreeing is
   * not something new they can act on.
   */
  async liftForRuntimeAvailable(agentId: string): Promise<boolean> {
    return this.mutate(agentId, (state) => state.blocked && state.needsActionReason === "runtime_not_found"
      ? {
        state: {
          ...freshWakeCrashLoopEpisode(state.episode + 1),
          catchupOwed: state.catchupOwed === true,
          actionRequiredNotifiedFingerprint: state.actionRequiredNotifiedFingerprint ?? null,
        },
        result: true,
        write: true,
      }
      : { state, result: false, write: false });
  }

  /**
   * #proj-raft-computer:#46: a web login or provider connect for the agent's
   * runtime succeeded on its Computer, so a block that was only about a
   * rejected or missing sign-in (the runtime's `user_reauth`, a start's
   * `runtime_login_required`) or a model the old key could not use
   * (`model_unsupported`, reconciler step 12) may no longer apply. Same fresh episode as a
   * config change (`liftForConfigChange`: the owed catch-up kept; a failure
   * on the new account is news to the owner again); any other block stays.
   * Wakes nothing: the next wake starts the agent. `sign_in`: the sign-in
   * blocks only (`CredentialsChangeLiftScope`).
   */
  async liftForCredentialsChange(agentId: string, scope: CredentialsChangeLiftScope = "credentials_change"): Promise<boolean> {
    const lifts = CREDENTIALS_CHANGE_LIFTS_BY_SCOPE[scope];
    return this.mutate(agentId, (state) => state.blocked && lifts.has(state.needsActionReason ?? "")
      ? {
        state: { ...freshWakeCrashLoopEpisode(state.episode + 1), catchupOwed: state.catchupOwed === true },
        result: true,
        write: true,
      }
      : { state, result: false, write: false });
  }

  /**
   * #proj-raft-computer:#48 (reconciler step 4b): the daemon no longer counts
   * the agent's credential invalid for `reason` (a turn on it produced model
   * output, a person stopped an agent on it, its model changed, its
   * credentials changed). Lifts only a block that reason fixes
   * (`CREDENTIAL_RESTORED_LIFTS`: `user_reauth` also lifts a start's
   * `runtime_login_required`; a working sign-in or plan access lifts a
   * start's `model_unsupported`); a billing balance restored says nothing
   * about a rejected sign-in. Same fresh episode
   * as a credentials change (`liftForCredentialsChange`); any other block
   * stays. Wakes nothing.
   */
  async liftForCredentialRestored(agentId: string, reason: CredentialInvalidReason): Promise<boolean> {
    return this.mutate(agentId, (state) => state.blocked && CREDENTIAL_RESTORED_LIFTS[reason].has(state.needsActionReason ?? "")
      ? {
        state: { ...freshWakeCrashLoopEpisode(state.episode + 1), catchupOwed: state.catchupOwed === true },
        result: true,
        write: true,
      }
      : { state, result: false, write: false });
  }

  async snapshot(agentId: string): Promise<WakeCrashLoopActivityDiagnostic> {
    return wakeCrashLoopSnapshot((await this.read(agentId)).state, this.rules);
  }
}
