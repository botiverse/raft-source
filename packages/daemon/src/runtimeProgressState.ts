import type { ParsedEvent } from "./drivers/types.js";

/**
 * Owns the daemon's derived runtime-progress clock.
 *
 * Lifecycle telemetry intentionally does not flow through this helper: only
 * runtime app events and explicit internal-progress observations may refresh
 * the clock or clear a latched stall.
 */
export class RuntimeProgressState {
  private lastEventAtMs: number;
  private lastEventKindValue: ParsedEvent["kind"] | null = null;
  private staleSinceMs: number | null = null;

  constructor(nowMs: number = Date.now()) {
    this.lastEventAtMs = nowMs;
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
    return nowMs - this.lastEventAtMs;
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
