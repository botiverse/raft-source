import type { ParsedEvent } from "./drivers/types";

/**
 * task #1114 — per-process observation of "stdin writes since the last
 * runtime consumption signal".
 *
 * A successful stdin write (idle inbox update, app-inbox notice, busy
 * notification) proves only that bytes reached the runtime. Consumption is
 * proven only by a model-driven runtime event (thinking / text / tool_call /
 * tool_output / turn_end). This watch counts writes between such signals,
 * numbers the episodes, and exposes the result as typed, queryable state.
 * It never acts: no stop, restart, retry or quota decision lives here.
 */
export const DELIVERY_CONSUMPTION_OBSERVATION_THRESHOLD = 3;

/**
 * Reconciler step 6: how long input written into a running turn keeps the
 * process from reading as idle after that turn ends, unless a new turn
 * starts first (`queuedInputPending`). The old features-restart settle
 * window, now applied only when such a write is known to have landed.
 */
export const QUEUED_INPUT_SETTLE_MS = 10_000;

export type DeliveryWritePath =
  | "stdin_idle_delivery"
  | "stdin_turn_end_delivery"
  | "busy_stdin_notification"
  | "app_inbox_notice";

export type DeliveryConsumptionKind = "thinking" | "text" | "tool_call" | "tool_output" | "turn_end";

export type DeliveryRuntimeResult =
  | { kind: "completed"; atMs: number; empty: boolean }
  | { kind: "error"; atMs: number; errorClass: string };

export interface DeliveryConsumptionSnapshot {
  episode: number;
  unconsumedDeliveries: number;
  firstUnconsumedAtMs: number | null;
  lastDeliveryAtMs: number | null;
  lastDeliveryKey: string | null;
  lastDeliveryPath: DeliveryWritePath | null;
  lastConsumption: { kind: DeliveryConsumptionKind; atMs: number } | null;
  lastRuntimeResult: DeliveryRuntimeResult | null;
  lastDeliveryError: { atMs: number; errorClass: string } | null;
}

export interface DeliveryWriteObservation extends DeliveryConsumptionSnapshot {
  /** True exactly once per episode, on the write that reaches the threshold. */
  thresholdCrossed: boolean;
}

const CONSUMPTION_KINDS: ReadonlySet<ParsedEvent["kind"]> = new Set<ParsedEvent["kind"]>([
  "thinking",
  "text",
  "tool_call",
  "tool_output",
  "turn_end",
]);

export function isDeliveryConsumptionEvent(kind: ParsedEvent["kind"]): kind is DeliveryConsumptionKind {
  return CONSUMPTION_KINDS.has(kind);
}

export class DeliveryConsumptionWatch {
  private episode = 0;
  private unconsumed = 0;
  private firstUnconsumedAtMs: number | null = null;
  private lastDeliveryAtMs: number | null = null;
  private lastDeliveryKey: string | null = null;
  private lastDeliveryPath: DeliveryWritePath | null = null;
  private lastConsumption: { kind: DeliveryConsumptionKind; atMs: number } | null = null;
  private lastRuntimeResult: DeliveryRuntimeResult | null = null;
  private lastDeliveryError: { atMs: number; errorClass: string } | null = null;
  /** Whether a model-visible event (thinking/text/tool) happened in the current turn. */
  private turnHadContent = false;
  /** Writes since the last consumption signal that nothing explains: only these cross the threshold (`recordWrite` `expected`). */
  private unexplained = 0;
  /** Writes that landed into the running turn since the last turn end (`recordWrite` `intoRunningTurn`). */
  private midTurnWrites = 0;
  /** What the last turn end left queued for a next turn; `taken` once a turn started after it, until that turn's end. */
  private queuedForNextTurnState: { count: number; turnEndAtMs: number; taken: boolean } | null = null;

  constructor(private readonly threshold: number = DELIVERY_CONSUMPTION_OBSERVATION_THRESHOLD) {}

  /**
   * A stdin write succeeded. Returns the observation to record.
   * `intoRunningTurn`: written while a turn runs (a busy write). Events of
   * that same turn reset the unconsumed count, yet a runtime may only have
   * queued it for a turn of its own after the turn end; see
   * `queuedForNextTurn`.
   * `expected`: the runtime has a reason not to answer yet (a turn is running,
   * or it is waiting on its own background task). Counted and traced as any
   * write, but it can't cross the threshold: queueing there is normal
   * (#triage:eedc43fe, a 3.5 min background task read as "not consuming").
   */
  recordWrite(key: string | null, path: DeliveryWritePath, nowMs: number, intoRunningTurn = false, expected = intoRunningTurn): DeliveryWriteObservation {
    if (intoRunningTurn) this.midTurnWrites += 1;
    if (this.unconsumed === 0) {
      this.episode += 1;
      this.firstUnconsumedAtMs = nowMs;
    }
    this.unconsumed += 1;
    this.lastDeliveryAtMs = nowMs;
    this.lastDeliveryKey = key;
    this.lastDeliveryPath = path;
    if (!expected) this.unexplained += 1;
    return { ...this.snapshot(), thresholdCrossed: !expected && this.unexplained === this.threshold };
  }

  /** A model-driven runtime event arrived for the live launch. */
  recordConsumption(kind: DeliveryConsumptionKind, nowMs: number): void {
    if (kind === "turn_end") {
      this.lastRuntimeResult = { kind: "completed", atMs: nowMs, empty: !this.turnHadContent };
      this.turnHadContent = false;
      this.queuedForNextTurnState = this.midTurnWrites > 0 ? { count: this.midTurnWrites, turnEndAtMs: nowMs, taken: false } : null;
      this.midTurnWrites = 0;
    } else {
      this.turnHadContent = true;
    }
    this.lastConsumption = { kind, atMs: nowMs };
    this.unconsumed = 0;
    this.unexplained = 0;
    this.firstUnconsumedAtMs = null;
  }

  /** The runtime reported an error: the turn had a result, so the writes were consumed. */
  recordRuntimeError(errorClass: string, nowMs: number): void {
    this.lastRuntimeResult = { kind: "error", atMs: nowMs, errorClass };
    this.turnHadContent = false;
    this.unconsumed = 0;
    this.unexplained = 0;
    this.firstUnconsumedAtMs = null;
  }

  /** The daemon failed to write. Not consumption; recorded separately and never resets the counter. */
  recordDeliveryError(errorClass: string, nowMs: number): void {
    this.lastDeliveryError = { atMs: nowMs, errorClass };
  }

  /**
   * The runtime did model work (the caller passes every main-session model
   * event): after a turn end that left input queued, that is a turn starting
   * on it, which runs until its own turn end (`recordConsumption`).
   */
  noteTurnStarted(): void {
    if (this.queuedForNextTurnState) this.queuedForNextTurnState.taken = true;
  }

  /**
   * Writes that landed while the last turn ran, as of its turn end. Not
   * consumption evidence either way: the turn's own events may have taken
   * them, or the runtime may run them as its next turn right after the turn
   * end. `taken`: a turn started since, and has not ended.
   */
  queuedForNextTurn(): { count: number; turnEndAtMs: number; taken: boolean } | null {
    return this.queuedForNextTurnState ? { ...this.queuedForNextTurnState } : null;
  }

  /**
   * Whether such writes may still be, or are being, run: a turn started on
   * them and has not ended, or none has and the turn end is less than
   * `settleMs` ago.
   */
  queuedInputPending(nowMs: number, settleMs: number = QUEUED_INPUT_SETTLE_MS): boolean {
    const queued = this.queuedForNextTurnState;
    return queued !== null && (queued.taken || nowMs - queued.turnEndAtMs < settleMs);
  }

  snapshot(): DeliveryConsumptionSnapshot {
    return {
      episode: this.episode,
      unconsumedDeliveries: this.unconsumed,
      firstUnconsumedAtMs: this.firstUnconsumedAtMs,
      lastDeliveryAtMs: this.lastDeliveryAtMs,
      lastDeliveryKey: this.lastDeliveryKey,
      lastDeliveryPath: this.lastDeliveryPath,
      lastConsumption: this.lastConsumption,
      lastRuntimeResult: this.lastRuntimeResult,
      lastDeliveryError: this.lastDeliveryError,
    };
  }
}
