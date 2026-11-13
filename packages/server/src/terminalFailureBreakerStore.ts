/**
 * RFC 071 — terminal-failure breaker store seam, in-memory fallback, the
 * combined two-key claim (§4.3 step 3) and the CAS-driven breaker facade.
 *
 * The record lives under its own key; neither breaker's lift, rollback,
 * decode or TTL touches the other's key. The ONE place that writes both is
 * the start claim: read both records with their versions, compute both next
 * states with the pure functions (`claimTerminalStart` and the existing
 * `applyWakeCrashLoopStart`), then compare BOTH versions and write BOTH, or
 * nothing. On conflict, re-read and decide again. The Redis form is one Lua
 * script (terminalFailureBreakerRedisStore.ts); the in-memory form is one
 * synchronous function over both process-local stores.
 */
import {
  DEFAULT_WAKE_CRASH_LOOP_RULES,
  InMemoryWakeCrashLoopStateStore,
  applyWakeCrashLoopStart,
  wakeCrashLoopRefusesAutomaticStart,
  freshWakeCrashLoopEpisode,
  type WakeCrashLoopEpisodeState,
  type WakeCrashLoopRules,
  type WakeCrashLoopStartRecord,
  type WakeCrashLoopStateRecord,
  applyWakeCrashLoopStartFailureOwned,
} from "./services/wakeCrashLoopBreaker";
import {
  TERMINAL_BREAKER_UNREADABLE,
  applyCatchupBuild,
  applyTerminalDaemonReady,
  applyTerminalFailureFrame,
  applyTerminalLift,
  applyTerminalOutboxFrame,
  applyTerminalOutcomeMarker,
  applyTerminalManualStop,
  applyTerminalProcessExited,
  applyTerminalProcessSpawned,
  applyTerminalStartAck,
  applyTerminalStartRejectedBeforeSpawn,
  applyTurnCompletedFrame,
  attachCatchupBatch,
  claimTerminalStart,
  decodeTerminalFailureBreakerState,
  encodeTerminalFailureBreakerState,
  evaluateTerminalWakeGate,
  freshTerminalFailureBreakerState,
  normalizeTerminalBreakerLease,
  rollbackTerminalClaim,
  terminalBreakerStateFromUnreadable,
  type AttachCatchupBatchResult,
  type CatchupBuildApplied,
  type CatchupBatch,
  type TerminalClaimInput,
  type TerminalClaimToken,
  type TerminalExitOutcome,
  type TerminalFailureApplied,
  type TerminalFailureBreakerState,
  type TerminalFailureFrame,
  type TerminalIdentityOutcome,
  type TerminalOutboxFrame,
  type TerminalOutboxFrameInput,
  type TerminalOutcomeMarker,
  type TerminalProcessExitFrame,
  type TerminalRollbackOutcome,
  type TerminalWakeGateResult,
  type TerminalWakeRefusal,
  type TurnCompletedApplied,
  type TurnCompletedFrame,
} from "./terminalFailureBreaker";

/** A stored terminal record. `state` is the unreadable sentinel when it does not decode. */
export interface TerminalFailureBreakerStoredRecord {
  state: TerminalFailureBreakerState | typeof TERMINAL_BREAKER_UNREADABLE;
  /** 0 = no record yet (the expected version of a first write). */
  version: number;
}

export interface TerminalAndWakeCrashLoopWrite {
  terminal: { expectedVersion: number; state: TerminalFailureBreakerState };
  wakeCrashLoop: { expectedVersion: number; state: WakeCrashLoopEpisodeState };
}

/**
 * Store seam. Every compare-and-set writes only when the stored version equals
 * the expected one (0 when absent) and bumps it. The combined write compares
 * BOTH versions and writes both or neither.
 */
export interface TerminalFailureBreakerStore {
  getTerminalFailureBreakerState(agentId: string): Promise<TerminalFailureBreakerStoredRecord | null>;
  compareAndSetTerminalFailureBreakerState(agentId: string, expectedVersion: number, state: TerminalFailureBreakerState): Promise<boolean>;
  /** The task #1119 record, read through its own decoder. */
  getWakeCrashLoopState(agentId: string): Promise<WakeCrashLoopStateRecord | null>;
  compareAndSetTerminalAndWakeCrashLoop(agentId: string, write: TerminalAndWakeCrashLoopWrite): Promise<boolean>;
}

/**
 * Process-local store: the no-Redis (single replica) fallback and the
 * unit-test default. It keeps the encoded form, so every read goes through
 * the same decoder as Redis. `wakeCrashLoop` must be the SAME in-memory store
 * the #1119 breaker uses, or the combined claim protects nothing.
 */
export class InMemoryTerminalFailureBreakerStore implements TerminalFailureBreakerStore {
  private readonly records = new Map<string, { raw: string; version: number }>();

  constructor(readonly wakeCrashLoop: InMemoryWakeCrashLoopStateStore = new InMemoryWakeCrashLoopStateStore()) {}

  getTerminalFailureBreakerStateSync(agentId: string): TerminalFailureBreakerStoredRecord | null {
    const record = this.records.get(agentId);
    return record ? { state: decodeTerminalFailureBreakerState(record.raw), version: record.version } : null;
  }

  compareAndSetTerminalFailureBreakerStateSync(agentId: string, expectedVersion: number, state: TerminalFailureBreakerState): boolean {
    const current = this.records.get(agentId)?.version ?? 0;
    if (current !== expectedVersion) return false;
    this.records.set(agentId, { raw: encodeTerminalFailureBreakerState(state), version: current + 1 });
    return true;
  }

  /** Both versions checked, then both written, with no await in between: atomic within one JS turn. */
  compareAndSetTerminalAndWakeCrashLoopSync(agentId: string, write: TerminalAndWakeCrashLoopWrite): boolean {
    const terminalVersion = this.records.get(agentId)?.version ?? 0;
    const wakeVersion = this.wakeCrashLoop.getWakeCrashLoopStateSync(agentId)?.version ?? 0;
    if (terminalVersion !== write.terminal.expectedVersion || wakeVersion !== write.wakeCrashLoop.expectedVersion) return false;
    if (!this.wakeCrashLoop.compareAndSetWakeCrashLoopStateSync(agentId, wakeVersion, write.wakeCrashLoop.state)) {
      throw new Error("in-memory combined claim: wake crash-loop version moved inside one JS turn");
    }
    this.records.set(agentId, { raw: encodeTerminalFailureBreakerState(write.terminal.state), version: terminalVersion + 1 });
    return true;
  }

  /** Test seam: store an arbitrary raw record (e.g. a corrupt one) at the next version. */
  setRawForTest(agentId: string, raw: string): void {
    const version = (this.records.get(agentId)?.version ?? 0) + 1;
    this.records.set(agentId, { raw, version });
  }

  getRawForTest(agentId: string): { raw: string; version: number } | null {
    const record = this.records.get(agentId);
    return record ? { ...record } : null;
  }

  async getTerminalFailureBreakerState(agentId: string): Promise<TerminalFailureBreakerStoredRecord | null> {
    return this.getTerminalFailureBreakerStateSync(agentId);
  }

  async compareAndSetTerminalFailureBreakerState(agentId: string, expectedVersion: number, state: TerminalFailureBreakerState): Promise<boolean> {
    return this.compareAndSetTerminalFailureBreakerStateSync(agentId, expectedVersion, state);
  }

  async getWakeCrashLoopState(agentId: string): Promise<WakeCrashLoopStateRecord | null> {
    return this.wakeCrashLoop.getWakeCrashLoopStateSync(agentId);
  }

  async compareAndSetTerminalAndWakeCrashLoop(agentId: string, write: TerminalAndWakeCrashLoopWrite): Promise<boolean> {
    return this.compareAndSetTerminalAndWakeCrashLoopSync(agentId, write);
  }
}

/** Map a stored record to a working state: missing → fresh; unreadable → RFC 4.1 closed + owedOverflow. */
export function terminalStateFromStored(
  record: TerminalFailureBreakerStoredRecord | null,
  nowMs: number,
): { state: TerminalFailureBreakerState; version: number; unreadable: boolean } {
  if (record === null) return { state: freshTerminalFailureBreakerState(), version: 0, unreadable: false };
  if (record.state === TERMINAL_BREAKER_UNREADABLE) {
    return { state: terminalBreakerStateFromUnreadable(nowMs), version: record.version, unreadable: true };
  }
  return { state: record.state, version: record.version, unreadable: false };
}

// --- Combined claim (RFC 071 §4.3 step 3) ---

export interface CombinedClaimInput extends TerminalClaimInput {
  /** Human start for the #1119 rules as well (lifts and opens a new episode there). */
  human: boolean;
  /**
   * The launchId the #1119 record stores, when it differs from the terminal
   * claim's (a start that carries no launchId: #1119 records null, as its
   * own `recordStart` does). Defaults to `launchId`.
   */
  crashLoopLaunchId?: string | null;
}

export type CombinedClaimResult =
  | {
    ok: true;
    token: TerminalClaimToken;
    /** Rollback token for the #1119 record (its own ownership-checked `rollbackStart`). */
    crashLoopStart: WakeCrashLoopStartRecord;
    /** The #1119 record version this claim wrote. */
    crashLoopVersion: number;
  }
  | { ok: false; reason: TerminalWakeRefusal | "wake_crash_loop_blocked" };

type CombinedDecision =
  | { kind: "refuse"; result: CombinedClaimResult }
  | { kind: "write"; write: TerminalAndWakeCrashLoopWrite; result: CombinedClaimResult };

/**
 * Decide the combined claim from two versioned reads. Pure. #1119 blocked
 * refuses an automatic start first (the older reason wins, RFC X-1/X-2); then
 * the terminal claim; then both next states are written together.
 */
export function decideCombinedClaim(
  terminal: { state: TerminalFailureBreakerState; version: number },
  wake: WakeCrashLoopStateRecord,
  input: CombinedClaimInput,
  rules: WakeCrashLoopRules = DEFAULT_WAKE_CRASH_LOOP_RULES,
): CombinedDecision {
  if (!input.human && wakeCrashLoopRefusesAutomaticStart(wake.state, input.nowMs)) return { kind: "refuse", result: { ok: false, reason: "wake_crash_loop_blocked" } };
  const claim = claimTerminalStart(terminal.state, input);
  if (!claim.ok) return { kind: "refuse", result: { ok: false, reason: claim.reason } };
  const crashLoopLaunchId = input.crashLoopLaunchId !== undefined ? input.crashLoopLaunchId : input.launchId;
  const wakeNext = applyWakeCrashLoopStart(wake.state, { launchId: crashLoopLaunchId, nowMs: input.nowMs, human: input.human }, rules);
  return {
    kind: "write",
    write: {
      terminal: { expectedVersion: terminal.version, state: claim.state },
      wakeCrashLoop: { expectedVersion: wake.version, state: wakeNext },
    },
    result: {
      ok: true,
      token: claim.token,
      crashLoopStart: { launchId: crashLoopLaunchId, nowMs: input.nowMs, previous: { ...wake.state } },
      crashLoopVersion: wake.version + 1,
    },
  };
}

/**
 * The in-memory combined claim: one synchronous function over both local
 * stores, so it is atomic within a single JS turn (no retry needed).
 */
export function claimTerminalAndWakeCrashLoopStartSync(
  store: InMemoryTerminalFailureBreakerStore,
  agentId: string,
  input: CombinedClaimInput,
  rules: WakeCrashLoopRules = DEFAULT_WAKE_CRASH_LOOP_RULES,
): CombinedClaimResult {
  const terminal = terminalStateFromStored(store.getTerminalFailureBreakerStateSync(agentId), input.nowMs);
  const wake = store.wakeCrashLoop.getWakeCrashLoopStateSync(agentId) ?? { state: freshWakeCrashLoopEpisode(1), version: 0 };
  const decision = decideCombinedClaim(terminal, wake, input, rules);
  if (decision.kind === "refuse") return decision.result;
  if (!store.compareAndSetTerminalAndWakeCrashLoopSync(agentId, decision.write)) {
    throw new Error("in-memory combined claim: versions moved inside one JS turn");
  }
  return decision.result;
}

const CAS_MAX_ATTEMPTS = 16;

/**
 * CAS-driven facade over the pure transitions. Each method is read →
 * transition → compare-and-set, retried on version conflict. Nothing here is
 * wired into the orchestrator yet (RFC 071 part 1).
 */
export class TerminalFailureBreaker {
  constructor(
    private readonly store: TerminalFailureBreakerStore = new InMemoryTerminalFailureBreakerStore(),
    private readonly wakeRules: WakeCrashLoopRules = DEFAULT_WAKE_CRASH_LOOP_RULES,
  ) {}

  private async readRecord(agentId: string, nowMs: number) {
    return terminalStateFromStored(await this.store.getTerminalFailureBreakerState(agentId), nowMs);
  }

  private async mutate<T>(
    agentId: string,
    nowMs: number,
    transition: (state: TerminalFailureBreakerState) => { state: TerminalFailureBreakerState; result: T; write: boolean },
  ): Promise<T> {
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
      const record = await this.readRecord(agentId, nowMs);
      const next = transition(record.state);
      if (!next.write) return next.result;
      if (await this.store.compareAndSetTerminalFailureBreakerState(agentId, record.version, next.state)) return next.result;
    }
    throw new Error(`terminal-failure breaker state for agent ${agentId}: compare-and-set did not converge after ${CAS_MAX_ATTEMPTS} attempts`);
  }

  /** Current state with the lease normalised (not written; the next CAS persists it). */
  async read(agentId: string, nowMs: number): Promise<TerminalFailureBreakerState> {
    return normalizeTerminalBreakerLease((await this.readRecord(agentId, nowMs)).state, nowMs).state;
  }

  async gate(agentId: string, input: Parameters<typeof evaluateTerminalWakeGate>[1]): Promise<TerminalWakeGateResult["decision"]> {
    return this.mutate(agentId, input.nowMs, (state) => {
      const gate = evaluateTerminalWakeGate(state, input);
      return { state: gate.state, result: gate.decision, write: gate.write };
    });
  }

  /** The combined two-key claim: both records or neither; re-read and decide again on conflict. */
  async claimStart(agentId: string, input: CombinedClaimInput): Promise<CombinedClaimResult> {
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
      const terminal = await this.readRecord(agentId, input.nowMs);
      const wake = (await this.store.getWakeCrashLoopState(agentId)) ?? { state: freshWakeCrashLoopEpisode(1), version: 0 };
      const decision = decideCombinedClaim(terminal, wake, input, this.wakeRules);
      if (decision.kind === "refuse") return decision.result;
      if (await this.store.compareAndSetTerminalAndWakeCrashLoop(agentId, decision.write)) return decision.result;
    }
    throw new Error(`terminal-failure breaker combined claim for agent ${agentId}: did not converge after ${CAS_MAX_ATTEMPTS} attempts`);
  }

  async rollbackClaim(agentId: string, token: TerminalClaimToken, input: { nowMs: number; dispatchLeftReplica: boolean }): Promise<TerminalRollbackOutcome> {
    return this.mutate(agentId, input.nowMs, (state) => {
      const rolled = rollbackTerminalClaim(state, token, input);
      return { state: rolled.state, result: rolled.outcome, write: rolled.outcome === "restored" };
    });
  }

  async recordTerminalFailure(agentId: string, frame: TerminalFailureFrame, input: { nowMs: number; unreadCeilings: Record<string, number> | null }): Promise<TerminalFailureApplied> {
    return this.mutate(agentId, input.nowMs, (state) => {
      const applied = applyTerminalFailureFrame(state, frame, input);
      return { state: applied.state, result: applied, write: applied.applied };
    });
  }

  async recordTurnCompleted(agentId: string, frame: TurnCompletedFrame, input: { nowMs: number; persistedSessionId: string | null }): Promise<TurnCompletedApplied> {
    return this.mutate(agentId, input.nowMs, (state) => {
      const applied = applyTurnCompletedFrame(state, frame, input);
      return { state: applied.state, result: applied, write: applied.applied };
    });
  }

  /**
   * RFC 071 part 3: apply one outbox frame and advance its instance's
   * watermark in ONE compare-and-set (the watermark lives in the record).
   * Resolves only after that write succeeded, or for a replay at or below the
   * watermark (nothing to write). Rejects when the write did not happen
   * (store error, CAS not converging): the caller must not acknowledge then,
   * so the daemon resends and the frame is judged again.
   */
  async applyOutboxFrame(
    agentId: string,
    frame: TerminalOutboxFrame,
    input: TerminalOutboxFrameInput,
  ): Promise<{ duplicate: boolean; outcome: string; startFailureWithdrawn?: boolean; startFailureUnblocked?: boolean }> {
    if (frame.kind === "start_not_spawned" && frame.reason === "spawn_error") {
      // task #365: when this commit counts the spawn error, the #1119 record
      // learns in the SAME compare-and-set that the RFC 071 breaker owns that
      // start's failure (see applyWakeCrashLoopStartFailureOwned).
      for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
        const terminal = await this.readRecord(agentId, input.nowMs);
        const applied = applyTerminalOutboxFrame(terminal.state, frame, input);
        if (applied.outcome !== "spawn_error_counted") {
          if (!applied.write) return { duplicate: applied.duplicate, outcome: applied.outcome };
          if (await this.store.compareAndSetTerminalFailureBreakerState(agentId, terminal.version, applied.state)) {
            return { duplicate: applied.duplicate, outcome: applied.outcome };
          }
          continue;
        }
        const wake = (await this.store.getWakeCrashLoopState(agentId)) ?? { state: freshWakeCrashLoopEpisode(1), version: 0 };
        const owned = applyWakeCrashLoopStartFailureOwned(wake.state, frame.launchId);
        const written = await this.store.compareAndSetTerminalAndWakeCrashLoop(agentId, {
          terminal: { expectedVersion: terminal.version, state: applied.state },
          wakeCrashLoop: { expectedVersion: wake.version, state: owned.state },
        });
        if (written) {
          return { duplicate: false, outcome: applied.outcome, startFailureWithdrawn: owned.withdrawn, startFailureUnblocked: owned.unblocked };
        }
      }
      throw new Error(`terminal-failure breaker outbox frame for agent ${agentId}: did not converge after ${CAS_MAX_ATTEMPTS} attempts`);
    }
    return this.mutate(agentId, input.nowMs, (state) => {
      const applied = applyTerminalOutboxFrame(state, frame, input);
      return { state: applied.state, result: { duplicate: applied.duplicate, outcome: applied.outcome }, write: applied.write };
    });
  }

  /** A daemon outbox marker: lost evidence becomes needs-manual (see `applyTerminalOutcomeMarker`). Rejects when the write did not happen. */
  async applyOutcomeMarker(agentId: string, marker: TerminalOutcomeMarker, input: { nowMs: number }): Promise<{ outcome: string }> {
    return this.mutate(agentId, input.nowMs, (state) => {
      const applied = applyTerminalOutcomeMarker(state, marker, input);
      return { state: applied.state, result: { outcome: applied.outcome }, write: applied.write };
    });
  }

  async lift(agentId: string, input: { cause: "human_reset" | "runtime_config_changed"; nowMs: number }): Promise<void> {
    await this.mutate(agentId, input.nowMs, (state) => ({ state: applyTerminalLift(state, input), result: undefined, write: true }));
  }

  async recordManualStop(agentId: string, nowMs: number): Promise<void> {
    await this.mutate(agentId, nowMs, (state) => {
      const stopped = applyTerminalManualStop(state, { nowMs });
      return { state: stopped.state, result: undefined, write: stopped.write };
    });
  }

  async recordStartAck(agentId: string, nowMs: number, ack: Parameters<typeof applyTerminalStartAck>[1]): Promise<TerminalIdentityOutcome> {
    return this.mutate(agentId, nowMs, (state) => {
      const applied = applyTerminalStartAck(state, ack);
      return { state: applied.state, result: applied.outcome, write: applied.write };
    });
  }

  async recordProcessSpawned(agentId: string, nowMs: number, frame: Parameters<typeof applyTerminalProcessSpawned>[1]): Promise<TerminalIdentityOutcome> {
    return this.mutate(agentId, nowMs, (state) => {
      const applied = applyTerminalProcessSpawned(state, frame);
      return { state: applied.state, result: applied.outcome, write: applied.write };
    });
  }

  async recordProcessExited(agentId: string, frame: TerminalProcessExitFrame): Promise<TerminalExitOutcome> {
    return this.mutate(agentId, frame.atMs, (state) => {
      const applied = applyTerminalProcessExited(state, frame);
      return { state: applied.state, result: applied.outcome, write: true };
    });
  }

  async recordDaemonReady(agentId: string, input: { daemonInstanceId: string; nowMs: number }): Promise<boolean> {
    return this.mutate(agentId, input.nowMs, (state) => {
      const applied = applyTerminalDaemonReady(state, input);
      return { state: applied.state, result: applied.write, write: applied.write };
    });
  }

  async recordStartRejectedBeforeSpawn(agentId: string, nowMs: number, input: { launchId: string; daemonInstanceId: string }): Promise<boolean> {
    return this.mutate(agentId, nowMs, (state) => {
      const applied = applyTerminalStartRejectedBeforeSpawn(state, input);
      return { state: applied.state, result: applied.write, write: applied.write };
    });
  }

  /** RFC 6: settle owed conversations the read cursor passed, then attach the start's batch (one CAS). */
  async recordCatchupBuild(
    agentId: string,
    nowMs: number,
    input: { readCursors: Record<string, number>; batch: CatchupBatch | null },
  ): Promise<Omit<CatchupBuildApplied, "state" | "write">> {
    return this.mutate(agentId, nowMs, (state) => {
      const applied = applyCatchupBuild(state, input);
      return {
        state: applied.state,
        result: { attached: applied.attached, settled: applied.settled, obligationCleared: applied.obligationCleared },
        write: applied.write,
      };
    });
  }

  async attachCatchupBatch(agentId: string, nowMs: number, batch: CatchupBatch): Promise<AttachCatchupBatchResult["attached"]> {
    return this.mutate(agentId, nowMs, (state) => {
      const attached = attachCatchupBatch(state, batch);
      return attached.attached
        ? { state: attached.state, result: true, write: true }
        : { state, result: false, write: false };
    });
  }
}
