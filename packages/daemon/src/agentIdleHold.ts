// How long an idle-gated action (agentIdle.ts) has been held by the same
// reason. A gate that keeps being refused for the same reason (a background
// task count that never returns to zero, a delivery stuck in flight) is
// otherwise invisible: each refusal on its own looks routine. Past
// IDLE_HOLD_LONG_MS the APM traces `daemon.agent.idle_hold_long` once per
// hold episode.

/** A hold this long, by one reason, is traced. */
export const IDLE_HOLD_LONG_MS = 30 * 60_000;

/**
 * `spec_restart`: the runtime spec restart (reconcile, reconciler step 7;
 * `features_restart` before it). `cold_idle`: the cold-idle stop of a process
 * already past the cold gap (reconcile, reconciler step 8b).
 */
export type IdleHoldGate = "spec_restart" | "session_rotation" | "cold_idle";

export interface IdleHoldLong {
  gate: IdleHoldGate;
  reason: string;
  heldMs: number;
}

interface Hold {
  processKey: string;
  reason: string;
  sinceMs: number;
  emitted: boolean;
}

/**
 * One hold per agent and gate. An episode lasts while every observation
 * names the same reason for the same process; a different reason, a pass
 * (null), or a new process starts over.
 */
export class AgentIdleHoldTracker {
  private readonly holds = new Map<string, Map<IdleHoldGate, Hold>>();

  constructor(private readonly longMs: number = IDLE_HOLD_LONG_MS) {}

  /**
   * Record what held `gate` at `nowMs` (null: it passed). `processKey`
   * identifies the process (the APM passes its processInstanceId). Returns
   * the event to trace the first time this episode reaches the threshold.
   */
  observe(agentId: string, processKey: string, gate: IdleHoldGate, reason: string | null, nowMs: number): IdleHoldLong | null {
    let gates = this.holds.get(agentId);
    if (reason === null) {
      gates?.delete(gate);
      if (gates?.size === 0) this.holds.delete(agentId);
      return null;
    }
    if (!gates) {
      gates = new Map();
      this.holds.set(agentId, gates);
    }
    let hold = gates.get(gate);
    if (!hold || hold.processKey !== processKey || hold.reason !== reason) {
      hold = { processKey, reason, sinceMs: nowMs, emitted: false };
      gates.set(gate, hold);
    }
    const heldMs = nowMs - hold.sinceMs;
    if (hold.emitted || heldMs < this.longMs) return null;
    hold.emitted = true;
    return { gate, reason, heldMs };
  }

  /** Drop an agent's holds (its process is gone), or one gate's (nobody waits on it any more). */
  forget(agentId: string, gate?: IdleHoldGate): void {
    if (gate === undefined) {
      this.holds.delete(agentId);
      return;
    }
    const gates = this.holds.get(agentId);
    gates?.delete(gate);
    if (gates?.size === 0) this.holds.delete(agentId);
  }

  /** Agents with a hold being measured (tests, diagnostics). */
  trackedAgentIds(): string[] {
    return [...this.holds.keys()];
  }
}
