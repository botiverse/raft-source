/**
 * Reconciler step 9 (#proj-raft-computer:#48, rule 3 / exception E2, rows
 * C14 and C15): is this process broken because it stalled with work queued?
 *
 * Pure: the host reads the facts (its inbox, its turn, its delivery holds,
 * the open tool's diagnostic snapshots, a liveness probe) and this decides.
 * Nothing in the signature is a host type, so the legacy host, the OAR host
 * and a Worker host can feed it the same way. `broken` means E2: the host
 * kills the process without waiting for idle and starts it again (now, since
 * work is queued), resuming its session. Stalled without queued work (C15) is
 * only a fact for the host to show: never broken here.
 */

/** Deliveries held on purpose: queued messages make no progress by design. */
export type StalledWithWorkDeliveryHold =
  /** The credential's provider limit (a shared sign-in's included) has not run out. */
  | "provider_limit"
  /** The agent's credential is invalid (reconciler step 4a). */
  | "credential_invalid"
  /** A recoverable runtime error's delivery backoff runs. */
  | "runtime_error_backoff"
  /** Reconciler step 13: a drain holds new input until the upgrade's shutdown (or its end). */
  | "drain";

export interface StalledWithWorkFacts {
  /** Messages queued for the process and not yet consumed. */
  inboxLength: number;
  /**
   * A turn is under way. An idle process with unread messages left them
   * unread itself (or was never told): not a stall.
   */
  turnInProgress: boolean;
  /** A stall replacement, or a person's turn interrupt, already stops this process. */
  recoveryUnderway: boolean;
  deliveryHold: StalledWithWorkDeliveryHold | null;
  /** The runtime takes notices on stdin while it runs. */
  supportsStdinNotification: boolean;
  busyDeliveryMode: "direct" | "notification" | "none";
  hasSession: boolean;
  /** Tool calls the runtime started and has not ended. */
  outstandingToolUses: number;
  /** The runtime said its stdin is broken (a stale tool wait is then a broken session). */
  hasDirectStdinRecoveryEvidence: boolean;
  /** The open tool call holds no live work (its diagnostic snapshots, read by the host). */
  openToolHoldsNoLiveWork: boolean;
  /** The liveness probe: true alive, false gone, undefined unknown. Read only for a non-stdin runtime. */
  processAlive: boolean | undefined;
  /**
   * The host already latched a stall: found this process silent past the
   * stall threshold with no live process behind it. Counts as past the
   * threshold, and an alive non-stdin runtime is no longer given the longer one.
   */
  runtimeProgressIsStale: boolean;
  /** Time without runtime progress: since the later of the last runtime event and the current turn's start. */
  staleForMs: number;
}

export interface StalledWithWorkThresholds {
  /** Silence after which a turn with queued work is stalled. */
  stallMs: number;
  /**
   * A silent, alive non-stdin runtime with queued messages and no open tool
   * is stalled only after this long (11-02: an OpenCode turn sat in
   * `thinking` for 16 h with 8 messages queued). Longer than `stallMs`
   * because not every model event of these drivers is parsed, so a long
   * think can look silent. For OpenCode it is the only guard: `opencode run
   * --format json` prints a tool only once it has finished, so no tool ever
   * reads as open.
   */
  nonStdinAliveStallMs: number;
}

export const STALLED_WITH_WORK_THRESHOLDS: StalledWithWorkThresholds = {
  stallMs: 15 * 60_000,
  nonStdinAliveStallMs: 60 * 60_000,
};

export type StalledWithWorkClearReason =
  | "empty_inbox"
  | "recovery_underway"
  | "delivery_held"
  | "turn_not_in_progress"
  | "runtime_not_restartable"
  | "runtime_progress_recent";

export type StalledWithWorkVerdict =
  | { broken: true; reason: "stalled_with_work"; thresholdMs: number }
  | {
    broken: false;
    reason: StalledWithWorkClearReason;
    /**
     * `runtime_progress_recent` only: how long until the process crosses its
     * threshold if nothing changes (the host's one deadline timer).
     */
    deadlineInMs?: number;
  };

export function stalledWithWork(
  facts: StalledWithWorkFacts,
  thresholds: StalledWithWorkThresholds = STALLED_WITH_WORK_THRESHOLDS,
): StalledWithWorkVerdict {
  if (facts.inboxLength === 0) return { broken: false, reason: "empty_inbox" };
  if (facts.recoveryUnderway) return { broken: false, reason: "recovery_underway" };
  if (facts.deliveryHold !== null) return { broken: false, reason: "delivery_held" };
  if (!facts.turnInProgress) return { broken: false, reason: "turn_not_in_progress" };

  let thresholdMs = thresholds.stallMs;
  if (facts.supportsStdinNotification) {
    // A direct-stdin runtime is replaced only with a session to resume, and
    // with no open tool unless stdin is known broken or the tool does no work.
    const restartable = facts.busyDeliveryMode === "direct"
      && facts.hasSession
      && (facts.outstandingToolUses === 0 || facts.hasDirectStdinRecoveryEvidence || facts.openToolHoldsNoLiveWork);
    if (!restartable) return { broken: false, reason: "runtime_not_restartable" };
  } else if (facts.processAlive === true && !facts.runtimeProgressIsStale) {
    // An alive non-stdin runtime with an open tool may be running a long
    // command, however long it is quiet (Cursor, Gemini, Copilot report
    // tool starts and ends).
    if (facts.outstandingToolUses > 0) return { broken: false, reason: "runtime_not_restartable" };
    thresholdMs = thresholds.nonStdinAliveStallMs;
  }

  if (facts.staleForMs < thresholdMs && !facts.runtimeProgressIsStale) {
    return { broken: false, reason: "runtime_progress_recent", deadlineInMs: thresholdMs - facts.staleForMs };
  }
  return { broken: true, reason: "stalled_with_work", thresholdMs };
}

/**
 * Stalled-with-work replacements in a row with no model output or turn end in
 * between, after which a process judged stalled again is no longer replaced:
 * the replacement resumes the same session, so one that stalls again would
 * otherwise be replaced every threshold forever.
 */
export const STALLED_REPLACEMENT_MAX_STREAK = 2;

/**
 * The stalled-replacement streak per agent and whether automatic replacement
 * gave up on it. Lives outside the process so the count survives the
 * replacement; model output, a turn end or an explicit stop ends it. One per
 * daemon, shared by both agent hosts (an agent runs on one at a time). Memory
 * only: a daemon restart forgets it.
 */
export class StalledReplacementStreaks {
  private readonly streaks = new Map<string, { count: number; gaveUp: boolean }>();

  get(agentId: string): { count: number; gaveUp: boolean } {
    return this.streaks.get(agentId) ?? { count: 0, gaveUp: false };
  }

  /** Counts one more replacement; returns the new streak. */
  note(agentId: string): number {
    const count = this.get(agentId).count + 1;
    this.streaks.set(agentId, { count, gaveUp: false });
    return count;
  }

  /** Automatic replacement gave up on this streak (traced and shown once). */
  noteGaveUp(agentId: string): void {
    this.streaks.set(agentId, { count: this.get(agentId).count, gaveUp: true });
  }

  delete(agentId: string): boolean {
    return this.streaks.delete(agentId);
  }
}
