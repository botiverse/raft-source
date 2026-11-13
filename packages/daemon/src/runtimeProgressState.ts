import type { ParsedEvent } from "./drivers/types";

/**
 * Owns the daemon's derived runtime-progress clock.
 *
 * Lifecycle telemetry intentionally does not flow through this helper: only
 * runtime app events and explicit internal-progress observations may refresh
 * the clock or clear a latched stall.
 *
 * Stall age is measured from the later of the last runtime event and the start
 * of the current turn (an input written to an idle runtime). Idle time between
 * turns is never stall time: without the turn-start anchor, the first message
 * after a long idle gap made a runtime that had just been handed its notice look
 * stalled for the whole gap. Turn start does not clear a latched stall; only
 * runtime evidence does.
 */
export class RuntimeProgressState {
  private lastEventAtMs: number;
  private lastEventKindValue: ParsedEvent["kind"] | null = null;
  private staleSinceMs: number | null = null;
  private turnStartedAtMs: number | null = null;

  /** When this process's progress clock started (its first turn's anchor). */
  readonly createdAtMs: number;

  constructor(nowMs: number = Date.now()) {
    this.lastEventAtMs = nowMs;
    this.createdAtMs = nowMs;
  }

  /** When a turn was explicitly started on this process; null while its first turn rides the spawn. */
  get notedTurnStartedAt(): number | null {
    return this.turnStartedAtMs;
  }

  /** task #25 step 2: when the current turn began; the process start for its first turn. */
  get currentTurnStartedAt(): number {
    return this.turnStartedAtMs ?? this.createdAtMs;
  }

  get lastEventAt(): number {
    return this.lastEventAtMs;
  }

  get lastEventKind(): ParsedEvent["kind"] | null {
    return this.lastEventKindValue;
  }

  get staleSince(): number | null {
    return this.staleSinceMs;
  }

  get isStale(): boolean {
    return this.staleSinceMs !== null;
  }

  ageMs(nowMs: number = Date.now()): number {
    return nowMs - Math.max(this.lastEventAtMs, this.turnStartedAtMs ?? this.lastEventAtMs);
  }

  /** Time since the last runtime event, ignoring the turn-start anchor. This is
   * what telemetry columns named `last_event_age_*` report; stall decisions use
   * `ageMs()`. */
  lastEventAgeMs(nowMs: number = Date.now()): number {
    return nowMs - this.lastEventAtMs;
  }

  noteTurnStarted(nowMs: number = Date.now()) {
    this.turnStartedAtMs = nowMs;
  }

  noteRuntimeEvent(eventKind?: ParsedEvent["kind"], nowMs: number = Date.now()) {
    this.lastEventAtMs = nowMs;
    this.lastEventKindValue = eventKind ?? null;
    this.staleSinceMs = null;
  }

  noteInternalProgress(observedAtMs: number = Date.now()) {
    this.lastEventAtMs = observedAtMs;
    this.staleSinceMs = null;
  }

  markStale(nowMs: number = Date.now()): number {
    this.staleSinceMs ??= nowMs;
    return this.staleSinceMs;
  }
}
