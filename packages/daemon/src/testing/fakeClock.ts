import type { Clock } from "../connection.js";

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

/**
 * Tiny deterministic clock for daemon timing tests.
 *
 * It intentionally only implements the primitives we currently need
 * (`now`, `setTimeout`, `clearTimeout`, `advanceBy`) to keep PR 1 small.
 */
export class FakeClock implements Clock {
  private currentMs = 0;
  private nextId = 1;
  private timers = new Map<number, FakeTimer>();

  now(): number {
    return this.currentMs;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, {
      id,
      at: this.currentMs + Math.max(0, ms),
      fn,
    });
    return id;
  }

  clearTimeout(timer: unknown): void {
    if (typeof timer === "number") this.timers.delete(timer);
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }

  advanceBy(ms: number): void {
    const target = this.currentMs + Math.max(0, ms);

    while (true) {
      const next = this.getNextTimer();
      if (!next || next.at > target) break;
      this.currentMs = next.at;
      this.timers.delete(next.id);
      next.fn();
    }

    this.currentMs = target;
  }

  private getNextTimer(): FakeTimer | null {
    let next: FakeTimer | null = null;
    for (const timer of this.timers.values()) {
      if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) {
        next = timer;
      }
    }
    return next;
  }
}
