/**
 * #proj-runtime:#62: the server's guard against an agent that is woken again
 * and again by the same message and does nothing with it, on any Computer
 * version and either runtime host.
 *
 * The causes we found are fixed where they live: the per-turn clean-exit
 * restart (#14982) and the daemon's wake guard (#14983) in Computer 1.25.3,
 * the same-error fence that an empty turn end kept resetting in 1.25.4, and
 * the onboarding wake on the server (#14955). A Computer that never takes
 * those keeps looping, and the server sees every turn it runs; this is the one
 * place that reaches all of them, including the OAR host (#proj-runtime:#61).
 *
 * One rule, the same definition of progress the daemon fence uses:
 * - A turn is one working → idle cycle of the agent's activity (thinking is
 *   working; a start or a reconnect does not open one, a heartbeat is not a
 *   frame here). Only an `idle` frame (or a legacy daemon's detail-less
 *   online) ends it cleanly. A turn that ends any other way (an error, an
 *   exit, a ready or restart frame) is neutral: a rate limit or a quota
 *   refusal costs no tokens, so it neither counts nor clears the count.
 * - A turn is empty when the agent made no progress since its previous turn
 *   ended (agentProgressMarks.ts: a successful Agent API call that changes
 *   something, a consumed app event, or its read position moving). An inbox
 *   check that finds nothing new is not progress.
 * - Empty turns are counted per input: what the server last offered the
 *   agent (a delivery, or a start). A different message starts the count
 *   again; the same ids again do not, and a frame that names no message is
 *   always new. An agent that ignores a stream of different messages never
 *   accumulates. Turns before this replica offered anything count against
 *   UNOFFERED_INPUT.
 * - Only a turn that starts within REPEATED_WAKE_MAX_GAP_MS of the previous
 *   one's end continues a streak. The server can't see wakes the Computer
 *   makes itself (a reminder on a current daemon, a background job), so an
 *   hourly reminder that leaves no trace in Raft must not add up; the loops
 *   this is for restart at once (15 s to 90 s). Slow loops across restarts
 *   (onboarding) are fixed at their source (#14955).
 * - REPEATED_WAKE_THRESHOLD empty turns in a row on one input trip once.
 *   AndyLok's 7-day replay (#62 msg c9f5389e): no agent outside a loop got
 *   past 8; 28 of the 30 loops were at 23 or more.
 *
 * State is in memory on the replica that holds the agent's Computer
 * connection, where activity arrives, and nothing here is durable. A replica
 * restart starts every count again; a Computer that reconnects to another
 * replica starts again there. So a reconnect storm only delays a trip, never
 * causes one: a count can only grow from turns this replica saw end empty.
 */
import type { AgentActivityDetailKind, AgentActivityKind } from "@botiverse/raft-shared";

export const REPEATED_WAKE_THRESHOLD = 10;
export const REPEATED_WAKE_MAX_GAP_MS = 10 * 60_000;

/**
 * Working kinds that are not the agent working on input: a start or a
 * reconnect opens no turn, and neither does a compaction (#proj-runtime:#67):
 * the daemon's own turn-end compaction (a `/compact` turn after the agent's
 * turn ended) shows only these two, so it is no empty turn of its own. A
 * compaction inside a real turn changes nothing: that turn is opened by its
 * other frames.
 */
const NOT_A_TURN: ReadonlySet<AgentActivityDetailKind> = new Set<AgentActivityDetailKind>([
  "starting",
  "runtime_starting",
  "runtime_reconnecting",
  "stalled_recovery",
  "compacting_context",
  "compaction_finished",
]);

/** What the server last offered the agent: the ids, the newest one named. */
export type RepeatedWakeInput = {
  /** The offered message ids, sorted and joined: equal keys are the same input. */
  key: string;
  /**
   * The one message that drives the loop, which an enforced trip leaves out
   * of later catch-ups: a delivery's message, a start's wake message. Null for
   * a start that offered only its catch-up: that is the agent's unread
   * backlog, and leaving it out would hide real messages (Archer, #62).
   */
  excludeId: string | null;
  /**
   * The newest offered message, the one a notice names. Null when the input
   * names none: UNOFFERED_INPUT, or a frame without message ids.
   */
  messageId: string | null;
  channelId: string | null;
};

/**
 * Turns before this replica offered the agent anything (after a deploy, a
 * replica restart, or the Computer reconnecting here) still count: an old
 * daemon loops on its own inbox with no frame from the server (1.0.42's
 * async-rejected retry), so waiting for a frame could wait for hours (Archer,
 * #62). The first real offer replaces it and starts the count over. A trip on
 * it can't name a message, so it only stops the process.
 */
export const UNOFFERED_INPUT: RepeatedWakeInput = { key: "", excludeId: null, messageId: null, channelId: null };

export type RepeatedWakeTurn = { startedAtMs: number; endedAtMs: number; toolStarts: number };

export type RepeatedWakeTrip = {
  input: RepeatedWakeInput;
  emptyTurns: number;
  /** Tool starts the activity showed across the streak (workspace work the server can't see as progress). */
  toolStarts: number;
  /** When the first empty turn of the streak started. */
  streakStartedAtMs: number;
};

type AgentState = {
  input: RepeatedWakeInput | null;
  turnStartedAtMs: number | null;
  turnToolStarts: number;
  lastTurnEndedAtMs: number | null;
  emptyTurns: number;
  streakToolStarts: number;
  streakStartedAtMs: number | null;
  tripped: boolean;
};

type OfferedMessage = { message_id?: string | null; channel_id?: string | null };

export class RepeatedWakeGuard {
  private readonly states = new Map<string, AgentState>();
  /** One verdict at a time per agent, in turn order. */
  private readonly verdicts = new Map<string, Promise<unknown>>();
  private readonly threshold: number;
  private unnamedInputs = 0;

  constructor(private readonly deps: {
    /** When the agent last made progress (agentProgressAtMs). */
    progressAtMs: (agentId: string) => Promise<number | null>;
    threshold?: number;
  }) {
    this.threshold = deps.threshold ?? REPEATED_WAKE_THRESHOLD;
  }

  private state(agentId: string): AgentState {
    let state = this.states.get(agentId);
    if (!state) {
      state = {
        input: null,
        turnStartedAtMs: null,
        turnToolStarts: 0,
        lastTurnEndedAtMs: null,
        emptyTurns: 0,
        streakToolStarts: 0,
        streakStartedAtMs: null,
        tripped: false,
      };
      this.states.set(agentId, state);
    }
    return state;
  }

  private static clearStreak(state: AgentState): void {
    state.emptyTurns = 0;
    state.streakToolStarts = 0;
    state.streakStartedAtMs = null;
    state.tripped = false;
  }

  /**
   * The server handed the agent these messages (in order, newest last). The
   * same ids again are the same input; a frame naming no message (a notice,
   * a start with only a summary or a prompt) is always a new one.
   * `drivesLoop`: the newest message is the input (a delivery, a start's
   * wake), not a catch-up backlog.
   */
  noteOffered(agentId: string, messages: readonly OfferedMessage[], options: { drivesLoop: boolean }): void {
    const withIds = messages.filter((m): m is OfferedMessage & { message_id: string } => typeof m.message_id === "string" && m.message_id.length > 0);
    const newest = withIds[withIds.length - 1];
    const state = this.state(agentId);
    if (!newest) {
      this.unnamedInputs += 1;
      state.input = { key: `unnamed:${this.unnamedInputs}`, excludeId: null, messageId: null, channelId: null };
      RepeatedWakeGuard.clearStreak(state);
      return;
    }
    const key = [...new Set(withIds.map((m) => m.message_id))].sort().join(",");
    if (state.input?.key === key) return;
    state.input = {
      key,
      excludeId: options.drivesLoop ? newest.message_id : null,
      messageId: newest.message_id,
      channelId: newest.channel_id ?? null,
    };
    RepeatedWakeGuard.clearStreak(state);
  }

  /**
   * An accepted, non-heartbeat activity frame (`atMs`: when the daemon saw
   * it). Returns the turn when this frame ended one cleanly; the caller then
   * calls `completeTurn`.
   */
  noteActivity(agentId: string, activity: AgentActivityKind, detailKind: AgentActivityDetailKind | undefined, atMs: number): RepeatedWakeTurn | null {
    if (activity === "working" || activity === "thinking") {
      if (detailKind !== undefined && NOT_A_TURN.has(detailKind)) return null;
      const state = this.state(agentId);
      if (state.turnStartedAtMs === null) {
        state.turnStartedAtMs = atMs;
        state.turnToolStarts = 0;
      }
      if (detailKind === "tool_started") state.turnToolStarts += 1;
      return null;
    }
    const state = this.states.get(agentId);
    if (!state || state.turnStartedAtMs === null) return null;
    const turn = { startedAtMs: state.turnStartedAtMs, endedAtMs: atMs, toolStarts: state.turnToolStarts };
    state.turnStartedAtMs = null;
    state.turnToolStarts = 0;
    // Only an idle frame (a legacy daemon's: `other`) is a clean end; any other
    // end is neutral: neither counted nor clearing.
    const clean = activity === "online" && (detailKind === undefined || detailKind === "idle" || detailKind === "other");
    return clean ? turn : null;
  }

  /**
   * Decide a clean turn end, after the verdicts of the agent's earlier turns.
   * Resolves to a trip the first time the streak reaches the threshold.
   */
  completeTurn(agentId: string, turn: RepeatedWakeTurn): Promise<RepeatedWakeTrip | null> {
    const previous = this.verdicts.get(agentId) ?? Promise.resolve();
    const verdict = previous.catch(() => undefined).then(() => this.decide(agentId, turn));
    this.verdicts.set(agentId, verdict);
    void verdict.finally(() => {
      if (this.verdicts.get(agentId) === verdict) this.verdicts.delete(agentId);
    }).catch(() => undefined);
    return verdict;
  }

  private async decide(agentId: string, turn: RepeatedWakeTurn): Promise<RepeatedWakeTrip | null> {
    const before = this.states.get(agentId);
    if (!before) return null;
    before.input ??= UNOFFERED_INPUT;
    const input = before.input;
    const since = before.lastTurnEndedAtMs ?? turn.startedAtMs;
    const progressAt = await this.deps.progressAtMs(agentId);
    const state = this.states.get(agentId);
    // Forgotten, or offered something else, while the mark was read: this turn's verdict no longer applies.
    if (!state || state !== before || state.input?.key !== input.key) return null;
    const gap = state.lastTurnEndedAtMs === null ? 0 : turn.startedAtMs - state.lastTurnEndedAtMs;
    state.lastTurnEndedAtMs = turn.endedAtMs;
    if (progressAt !== null && progressAt >= since) {
      RepeatedWakeGuard.clearStreak(state);
      return null;
    }
    // A turn long after the previous one was woken by something else (a wake
    // the server does not see): it starts a streak, it does not continue one.
    if (gap > REPEATED_WAKE_MAX_GAP_MS) RepeatedWakeGuard.clearStreak(state);
    state.emptyTurns += 1;
    state.streakToolStarts += turn.toolStarts;
    state.streakStartedAtMs ??= turn.startedAtMs;
    if (state.emptyTurns < this.threshold || state.tripped) return null;
    state.tripped = true;
    return { input, emptyTurns: state.emptyTurns, toolStarts: state.streakToolStarts, streakStartedAtMs: state.streakStartedAtMs };
  }

  /** The trip's stop could not be delivered: the next empty turn on the same input trips again. */
  rearm(agentId: string): void {
    const state = this.states.get(agentId);
    if (state) state.tripped = false;
  }

  /** A person stopped or started the agent (or the agent was stopped): start over. */
  forget(agentId: string): void {
    this.states.delete(agentId);
  }
}
