/**
 * Agent read progress, per-conversation coalescing (agentReadProgressService.ts).
 *
 * Agents read in bursts: one `/events` acknowledgement (an external agent's
 * pull, or a `raft message check` that reaches the server) can move an
 * agent's read position in a dozen conversations, and a history read can move
 * it twice in a second (the read, then the deferred settle). A hosted agent's
 * `raft message check` is answered by its daemon and moves nothing here
 * (RFC 081 §3). Each advance is noted here and
 * the conversation's watchers get at most one frame per `intervalMs`, carrying
 * the latest position of every agent that moved. The work a frame costs (the
 * eligibility, member and visible-message reads) is done once per flush, not
 * once per advance.
 *
 * Per conversation:
 * - the first advance starts a timer of `intervalMs`; later ones only widen the
 *   agent's pending range (lowest `from`, highest `to`);
 * - when the timer fires, the pending advances are handed to `flush` and the
 *   conversation starts collecting again; advances that arrive while a flush is
 *   still running wait for it and then for a full interval, so two flushes of
 *   one conversation always start at least `intervalMs` apart;
 * - a conversation with nothing pending and no flush running is forgotten, its
 *   timer already gone.
 *
 * Memory is bounded: at most `maxScopes` conversations and `maxAgentsPerScope`
 * agents per conversation are pending at once; an advance past either bound is
 * dropped (the next channel detail fetch shows the position anyway). Timers
 * are process-local: every replica coalesces its own advances, and a frame
 * reaches the watchers on every replica through the socket adapter.
 */

export type AgentReadAdvance = {
  serverId: string;
  scopeId: string;
  agentId: string;
  /** The read position before the advance. */
  from: number;
  /** The read position after it. */
  to: number;
};

export type AgentReadRange = { from: number; to: number };

export type AgentReadProgressBatch = {
  serverId: string;
  scopeId: string;
  /** Per agent: the lowest `from` and highest `to` noted since the last flush. */
  advances: Map<string, AgentReadRange>;
};

type TimerHandle = unknown;

export type AgentReadProgressCoalescerOptions = {
  intervalMs: number;
  maxScopes: number;
  maxAgentsPerScope: number;
  flush: (batch: AgentReadProgressBatch) => Promise<void>;
  onFlushError?: (error: unknown, batch: AgentReadProgressBatch) => void;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

type ScopeState = {
  serverId: string;
  pending: Map<string, AgentReadRange>;
  timer: TimerHandle | null;
  flushing: boolean;
};

function defaultSetTimer(callback: () => void, ms: number): TimerHandle {
  const handle = setTimeout(callback, ms);
  // A pending frame must never keep the process alive at shutdown.
  handle.unref?.();
  return handle;
}

function defaultClearTimer(handle: TimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

export class AgentReadProgressCoalescer {
  private readonly scopes = new Map<string, ScopeState>();
  private readonly setTimer: (callback: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  constructor(private readonly options: AgentReadProgressCoalescerOptions) {
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  /** Note one advance. False when it was dropped (no forward move, or a bound was reached). */
  note(advance: AgentReadAdvance): boolean {
    if (!Number.isFinite(advance.from) || !Number.isFinite(advance.to) || advance.to <= advance.from) return false;
    let state = this.scopes.get(advance.scopeId);
    if (!state) {
      if (this.scopes.size >= this.options.maxScopes) return false;
      state = { serverId: advance.serverId, pending: new Map(), timer: null, flushing: false };
      this.scopes.set(advance.scopeId, state);
    }
    const existing = state.pending.get(advance.agentId);
    if (existing) {
      existing.from = Math.min(existing.from, advance.from);
      existing.to = Math.max(existing.to, advance.to);
    } else {
      if (state.pending.size >= this.options.maxAgentsPerScope) return false;
      state.pending.set(advance.agentId, { from: advance.from, to: advance.to });
    }
    if (state.timer === null && !state.flushing) this.schedule(advance.scopeId, state);
    return true;
  }

  /** Conversations with pending advances or a flush running. */
  get size(): number {
    return this.scopes.size;
  }

  /** Forget everything and cancel every timer (tests, shutdown). A flush already running finishes. */
  clear(): void {
    for (const state of this.scopes.values()) {
      if (state.timer !== null) this.clearTimer(state.timer);
      state.timer = null;
    }
    this.scopes.clear();
  }

  private schedule(scopeId: string, state: ScopeState): void {
    state.timer = this.setTimer(() => {
      state.timer = null;
      void this.run(scopeId, state);
    }, this.options.intervalMs);
  }

  private async run(scopeId: string, state: ScopeState): Promise<void> {
    // Cleared (or replaced) while the timer was due.
    if (this.scopes.get(scopeId) !== state) return;
    const batch: AgentReadProgressBatch = { serverId: state.serverId, scopeId, advances: state.pending };
    state.pending = new Map();
    state.flushing = true;
    try {
      if (batch.advances.size > 0) await this.options.flush(batch);
    } catch (error) {
      this.options.onFlushError?.(error, batch);
    } finally {
      state.flushing = false;
      if (this.scopes.get(scopeId) === state) {
        if (state.pending.size > 0) this.schedule(scopeId, state);
        else this.scopes.delete(scopeId);
      }
    }
  }
}
