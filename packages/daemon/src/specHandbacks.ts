/**
 * Reconciler step 11c: how long a handback waits for the server's start
 * (step 11d). After it the agent reports the runtime unavailable, with Retry,
 * instead of a start that never comes (a lost refusal, a replica switch).
 */
export const SPEC_HANDBACK_START_DEADLINE_MS = 60_000;

/**
 * Reconciler step 11c: agents a host released for a config it does not
 * restart itself, so the server starts them at their next delivery, which
 * the legacy host refuses (no process). That refusal is the switch going
 * ahead, not an unavailable runtime, and reports a start. Set by the legacy
 * host (a runtime, host or session change) and the OAR host (every spec
 * stop: it never restarts a session itself); one instance shared by both
 * (the legacy host's, passed to the OAR host). Ended by the agent's next
 * start on either host (the router) or an explicit stop (the legacy host's:
 * a handed-back agent is on no OAR session, so its stop reaches it).
 *
 * Step 11d: a handback is awaited for the deadline from when it was set.
 * A refusal decides it by the clock (`awaitingStart`); once a refusal has
 * reported the start, `armDeadline` also ends it at the deadline when no
 * further refusal comes, and calls `onDeadline` so the host reports the
 * runtime unavailable. That timer belongs to this store, so every end of
 * the handback (a start, a stop, the deadline) clears it.
 */
export class SpecHandbacks {
  /** When each handback was set (the owning host's clock). */
  private readonly setAt = new Map<string, number>();
  /** Handbacks from an idle stop, waiting for the next delivery (`park`). */
  private readonly parked = new Set<string>();
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly deadlineMs: number;
  private readonly onDeadline: ((agentId: string) => void) | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    options: { deadlineMs?: number; onDeadline?: (agentId: string) => void } = {},
  ) {
    this.deadlineMs = options.deadlineMs ?? SPEC_HANDBACK_START_DEADLINE_MS;
    this.onDeadline = options.onDeadline;
  }

  /** A new handback, or a later one for the same agent: its deadline counts from now (an armed timer re-reads it). */
  mark(agentId: string): void {
    this.setAt.set(agentId, this.now());
  }

  /**
   * An intentional idle stop (#proj-runtime:#63: a cold-idle recycle, an idle
   * process stop): no start is expected until the agent's next delivery,
   * which may be hours away, so the deadline counts from that delivery's
   * refusal, not from now. Until then the handback stays.
   */
  park(agentId: string): void {
    this.clearDeadlineTimer(agentId);
    this.setAt.set(agentId, this.now());
    this.parked.add(agentId);
  }

  has(agentId: string): boolean {
    return this.setAt.has(agentId);
  }

  /**
   * Whether a refusal now is the agent's handback still waiting for the
   * server's start. Past the deadline the handback ends here: the refusal
   * reports the runtime unavailable.
   */
  awaitingStart(agentId: string): false | "handback" | "idle_stop" {
    // A parked handback's wait starts with this refusal (`park`).
    if (this.parked.delete(agentId)) {
      this.setAt.set(agentId, this.now());
      return "idle_stop";
    }
    if (this.remainingMs(agentId) > 0) return "handback";
    this.forget(agentId);
    return false;
  }

  /**
   * A refusal reported the agent starting: end the handback at its deadline
   * even if no refusal comes again, then `onDeadline`. Armed once per
   * handback. A timer can fire before the clock has moved its full delay
   * (#13385), so a firing before the deadline re-arms for the remainder.
   */
  armDeadline(agentId: string): void {
    if (!this.onDeadline || this.deadlineTimers.has(agentId) || !this.setAt.has(agentId) || this.parked.has(agentId)) return;
    this.scheduleDeadline(agentId);
  }

  forget(agentId: string): void {
    this.setAt.delete(agentId);
    this.parked.delete(agentId);
    this.clearDeadlineTimer(agentId);
  }

  /** Daemon shutdown: no deadline fires afterwards (the handbacks themselves are kept). */
  dispose(): void {
    for (const agentId of [...this.deadlineTimers.keys()]) this.clearDeadlineTimer(agentId);
  }

  private remainingMs(agentId: string): number {
    const setAt = this.setAt.get(agentId);
    return setAt === undefined ? 0 : setAt + this.deadlineMs - this.now();
  }

  private scheduleDeadline(agentId: string): void {
    const timer = setTimeout(() => {
      this.deadlineTimers.delete(agentId);
      if (!this.setAt.has(agentId)) return;
      if (this.remainingMs(agentId) > 0) {
        this.scheduleDeadline(agentId);
        return;
      }
      this.forget(agentId);
      this.onDeadline?.(agentId);
    }, Math.max(1, this.remainingMs(agentId)));
    timer.unref?.();
    this.deadlineTimers.set(agentId, timer);
  }

  private clearDeadlineTimer(agentId: string): void {
    const timer = this.deadlineTimers.get(agentId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.deadlineTimers.delete(agentId);
  }
}
