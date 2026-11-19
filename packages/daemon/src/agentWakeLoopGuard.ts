import type { AgentMessage } from "@botiverse/raft-shared";
import type { RuntimeTraceCounters } from "./runtimeCommunicationTrace";

/**
 * Wake-loop guard: an agent woken again and again by the SAME message while
 * doing nothing (Cursor onboarding: 633 turns; Grok async-rejected retries:
 * 136 turns, 0 tool calls each). Runtime-independent: a turn is counted by
 * the messages that started it, whatever path started it.
 *
 * - A *wake turn* is a turn the daemon started with messages
 *   (`startRuntimeTrace` with a message list: spawn, idle stdin delivery,
 *   every idle retry). Its identity is the set of its messages' ids.
 * - It ends *counted* when the runtime reports a clean turn end (no error,
 *   interruption or sticky failure) or rejects the `turn/start` (unless only
 *   busy, or the same rejection repeats: the same-fingerprint fence owns that),
 *   and *uncounted* otherwise: a process exit before its turn end, crashes,
 *   errors and stalls have their own streaks and backoffs.
 * - Delivery entry (`deliverMessage`, transient deliveries included): a parked
 *   message is accepted and dropped; one in its backoff is held until it ends.
 * - A counted turn with no progress adds one to the streak of every message
 *   id that started it; a message that did not start it loses its streak
 *   (the streak is consecutive). Message-less turns are neutral.
 * - Progress — a tool call, a Raft send (accepted or held) or the agent's own
 *   read of its messages — clears every streak and backoff of the agent.
 * - At {@link WAKE_LOOP_BACKOFF_AT} the message is held for
 *   {@link WAKE_LOOP_BACKOFF_MS} before it is offered again (a pause); at
 *   {@link WAKE_LOOP_PARK_AT} it is parked: not offered again for as long as
 *   the agent runs here. Progress does not release it; a stop of the agent
 *   (and a daemon restart) does, and the start that follows offers it again
 *   from the server's unread catch-up (it stays unread on the server).
 */
export const WAKE_LOOP_PARK_AT = 3;
/** One no-progress turn short of parking, the next offer waits. */
export const WAKE_LOOP_BACKOFF_AT = WAKE_LOOP_PARK_AT - 1;
/** Four times the 15 s idle-retry interval: lets a transient (server state catching up, a short provider hiccup) clear. */
export const WAKE_LOOP_BACKOFF_MS = 60_000;

/** A message's identity for the guard: its id, else its seq. Null: not tracked (transient rows). */
export function wakeMessageKey(message: Pick<AgentMessage, "message_id" | "seq">): string | null {
  if (message.message_id) return message.message_id;
  if (typeof message.seq === "number" && message.seq > 0) return `seq:${message.seq}`;
  return null;
}

/** Tool calls and sends: what the daemon already counts per turn. */
export function turnProgressEvidence(counters: RuntimeTraceCounters): number {
  return counters.toolCalls + counters.raftMessagesSent + counters.raftMessageSendsHeld;
}

export type OpenWakeTurn = {
  keys: string[];
  reason: string;
  /** The counters the turn's evidence accumulates in, and their evidence when it started (a retry may join an open span). */
  counters: RuntimeTraceCounters;
  baseline: number;
  progressed: boolean;
};

export type WakeLoopStep = { key: string; count: number; reasons: string[] };

export type WakeLoopVerdict = {
  progress: boolean;
  /** Message keys whose next offer waits WAKE_LOOP_BACKOFF_MS. */
  backoff: WakeLoopStep[];
  /** Message keys no longer offered. */
  park: WakeLoopStep[];
};

const NO_VERDICT: WakeLoopVerdict = { progress: false, backoff: [], park: [] };

export class WakeLoopGuard {
  readonly #streaks = new Map<string, Map<string, { count: number; reasons: string[] }>>();
  readonly #parked = new Map<string, Set<string>>();
  readonly #backoffUntil = new Map<string, Map<string, number>>();

  beginTurn(reason: string, messages: readonly AgentMessage[], counters: RuntimeTraceCounters): OpenWakeTurn | null {
    const keys = [...new Set(messages.map(wakeMessageKey).filter((key): key is string => key !== null))].sort();
    if (keys.length === 0) return null;
    return { keys, reason, counters, baseline: turnProgressEvidence(counters), progressed: false };
  }

  /** The end of a wake turn (null: none open). `counted`: it ended cleanly. */
  settleTurn(agentId: string, turn: OpenWakeTurn | null, counted: boolean, nowMs: number): WakeLoopVerdict {
    if (!turn) return NO_VERDICT;
    if (turn.progressed || turnProgressEvidence(turn.counters) > turn.baseline) {
      this.reset(agentId);
      return { ...NO_VERDICT, progress: true };
    }
    if (!counted) return NO_VERDICT;
    const previous = this.#streaks.get(agentId);
    const next = new Map<string, { count: number; reasons: string[] }>();
    const verdict: WakeLoopVerdict = { progress: false, backoff: [], park: [] };
    for (const key of turn.keys) {
      const before = previous?.get(key);
      const step = { count: (before?.count ?? 0) + 1, reasons: [...(before?.reasons ?? []), turn.reason].slice(-WAKE_LOOP_PARK_AT) };
      if (step.count >= WAKE_LOOP_PARK_AT) {
        this.#park(agentId, key);
        verdict.park.push({ key, ...step });
      } else {
        next.set(key, step);
        if (step.count >= WAKE_LOOP_BACKOFF_AT) {
          this.#setBackoff(agentId, key, nowMs + WAKE_LOOP_BACKOFF_MS);
          verdict.backoff.push({ key, ...step });
        }
      }
    }
    if (next.size > 0) this.#streaks.set(agentId, next);
    else this.#streaks.delete(agentId);
    return verdict;
  }

  /** Real progress: streaks and backoffs end. Parked messages stay parked. */
  reset(agentId: string): void {
    this.#streaks.delete(agentId);
    this.#backoffUntil.delete(agentId);
  }

  /** The agent was stopped: everything, parked messages included, is released. */
  forget(agentId: string): void {
    this.reset(agentId);
    this.#parked.delete(agentId);
  }

  isParked(agentId: string, key: string): boolean {
    return this.#parked.get(agentId)?.has(key) === true;
  }

  /** How long an offer of this message still waits (0: none). */
  backoffRemainingMs(agentId: string, key: string, nowMs: number): number {
    const until = this.#backoffUntil.get(agentId)?.get(key);
    if (until === undefined) return 0;
    if (until <= nowMs) {
      this.#backoffUntil.get(agentId)?.delete(key);
      return 0;
    }
    return until - nowMs;
  }

  /** The backoff of this message is over (its held offer is being made). */
  clearBackoff(agentId: string, key: string): void {
    this.#backoffUntil.get(agentId)?.delete(key);
  }

  #park(agentId: string, key: string): void {
    let parked = this.#parked.get(agentId);
    if (!parked) this.#parked.set(agentId, (parked = new Set()));
    parked.add(key);
    this.#backoffUntil.get(agentId)?.delete(key);
  }

  #setBackoff(agentId: string, key: string, untilMs: number): void {
    let byKey = this.#backoffUntil.get(agentId);
    if (!byKey) this.#backoffUntil.set(agentId, (byKey = new Map()));
    byKey.set(key, untilMs);
  }
}
