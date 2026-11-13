// Warm wake recycle (#proj-runtime:#54, RFC 070 §6.5).
//
// The recycle (wakeSessionRecycle.ts) is decided when a runtime process
// starts, and only after an idle gap. An agent woken every few minutes (by
// reminders, say) never stops and never meets the gate: one Claude session
// ran 625 turns while its per-turn cache reads grew about 15 times. Behind
// the Server's `wake_recycle_warm` flag, a clean turn end with nothing
// running, held or queued whose last request carried more than 250k tokens
// (on a window of at least 400k) marks the session; the host then stops the
// process through its cold-idle stop, after two minutes with no delivery, or
// at once past 500k. The next start finds the stop remembered here and
// recycles whatever the gap (`decideWakeRecycle`, reason `warm_recycle`).
//
// One rule for both hosts. This module owns the knobs, the mark decision, the
// per-agent marks (with the quiet timer) and the trace/log text; the hosts
// own "is it idle" and the stop.
import type { AgentConfig } from "@botiverse/raft-shared";
import type { TurnEndContextFacts } from "./turnEndCompaction";
import { parsePositiveInteger, resolveWakeRecycleConfig, runtimeSessionTranscriptReadable, summaryFactsRuntimesFor, type WarmRecycleStop } from "./wakeSessionRecycle";

/** The turn-end compaction gate's sizes (turnEndCompaction.ts): the same sessions, one of the two acts. */
export const DEFAULT_WARM_RECYCLE_MIN_CONTEXT_TOKENS = 250_000;
export const DEFAULT_WARM_RECYCLE_MIN_WINDOW_TOKENS = 400_000;
/** How long a marked session waits for a delivery before it is stopped: a back-and-forth keeps its session. */
export const DEFAULT_WARM_RECYCLE_QUIET_MS = 2 * 60_000;
/** Past this the session is stopped at the first clean turn end, with no wait. */
export const DEFAULT_WARM_RECYCLE_CEILING_TOKENS = 500_000;

export const WARM_RECYCLE_MARKED_EVENT = "daemon.agent.wake_recycle.warm_marked";
export const WARM_RECYCLE_STOPPED_EVENT = "daemon.agent.wake_recycle.warm_stopped";
export const WARM_RECYCLE_CANCELLED_EVENT = "daemon.agent.wake_recycle.warm_cancelled";

export interface WarmRecycleConfig {
  enabled: boolean;
  minContextTokens: number;
  minWindowTokens: number;
  quietMs: number;
  ceilingTokens: number;
}

/**
 * The knobs for one agent: the Server's flag, then per-agent env over the
 * daemon's env. The local `RAFT_WAKE_RECYCLE=0` turns it off even with the
 * flag on (the stop would be answered by a resume); nothing local turns it on.
 */
export function resolveWarmRecycleConfig(
  config: { envVars?: AgentConfig["envVars"]; wakeRecycleWarm?: AgentConfig["wakeRecycleWarm"] },
  processEnv: NodeJS.ProcessEnv = process.env,
): WarmRecycleConfig {
  const pick = (key: string): string | undefined => config.envVars?.[key] ?? processEnv[key];
  const minContextTokens = parsePositiveInteger(pick("RAFT_WAKE_RECYCLE_WARM_MIN_CONTEXT_TOKENS")) ?? DEFAULT_WARM_RECYCLE_MIN_CONTEXT_TOKENS;
  return {
    enabled: config.wakeRecycleWarm === true && resolveWakeRecycleConfig(config.envVars, processEnv).enabled,
    minContextTokens,
    minWindowTokens: parsePositiveInteger(pick("RAFT_WAKE_RECYCLE_WARM_MIN_WINDOW_TOKENS")) ?? DEFAULT_WARM_RECYCLE_MIN_WINDOW_TOKENS,
    quietMs: parsePositiveInteger(pick("RAFT_WAKE_RECYCLE_WARM_QUIET_MS")) ?? DEFAULT_WARM_RECYCLE_QUIET_MS,
    // A ceiling below the threshold would stop every marked session at once: never below it.
    ceilingTokens: Math.max(minContextTokens, parsePositiveInteger(pick("RAFT_WAKE_RECYCLE_WARM_CEILING_TOKENS")) ?? DEFAULT_WARM_RECYCLE_CEILING_TOKENS),
  };
}

export type WarmRecycleHost = "legacy" | "oar";

/**
 * Whether the next start can read this runtime's resume facts on this host,
 * so the stop is answered by a recycle: Claude through its transcript (legacy
 * host); on the OAR host the runtimes whose session summary supplies them,
 * while `wake_recycle_oar` is on (`summaryFactsRuntimesFor`). Every other
 * runtime (Pi, Kimi, Built-in, ...) is never marked.
 */
export function warmRecycleCoversRuntime(host: WarmRecycleHost, runtime: string, config: Pick<AgentConfig, "wakeRecycleOar">): boolean {
  return host === "legacy" ? runtimeSessionTranscriptReadable(runtime) : summaryFactsRuntimesFor(config).has(runtime);
}

/** `quiet`: stopped after the quiet period with no delivery; `ceiling`: stopped at once. */
export type WarmRecycleBand = WarmRecycleStop["band"];

export type WarmRecycleSkipReason = "context_unknown" | "window_unknown" | "window_too_small" | "below_threshold";

export type WarmRecycleMarkDecision =
  | { mark: true; band: WarmRecycleBand; contextTokens: number; windowTokens: number }
  | { mark: false; reason: WarmRecycleSkipReason };

/** The size half of the mark, over the turn-end compaction gate's facts. Unknown facts never mark. */
export function decideWarmRecycleMark(config: WarmRecycleConfig, facts: TurnEndContextFacts): WarmRecycleMarkDecision {
  if (facts.contextTokens === null) return { mark: false, reason: "context_unknown" };
  if (facts.windowTokens === null) return { mark: false, reason: "window_unknown" };
  if (facts.windowTokens < config.minWindowTokens) return { mark: false, reason: "window_too_small" };
  if (facts.contextTokens <= config.minContextTokens) return { mark: false, reason: "below_threshold" };
  return {
    mark: true,
    band: facts.contextTokens > config.ceilingTokens ? "ceiling" : "quiet",
    contextTokens: facts.contextTokens,
    windowTokens: facts.windowTokens,
  };
}

export interface WarmRecycleMark {
  sessionId: string;
  contextTokens: number;
  windowTokens: number;
  band: WarmRecycleBand;
  markedAtMs: number;
}

/** The quiet timer's clock (tests pass their own and fire it by hand). */
export interface WarmRecycleTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realWarmRecycleTimers: WarmRecycleTimers = {
  set: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * "Warm-recycle pending", per agent, for one host: `pending` from a clean
 * turn end until a delivery cancels it or the host stops the process, then
 * `stopped` until the next start takes it (`takeStopped`: any start clears
 * it, so a resume for another reason forgets the mark and a recycled session
 * starts unmarked). It outlives the runtime process, not the daemon.
 *
 * Two facts per agent keep the mark from fighting the rest of the turn end:
 * - declined: a start that took a remembered stop but resumed that session
 *   anyway (a resume prompt, a runtime-profile control, unknown facts) would
 *   resume it again after every stop, so that session is never marked again
 *   (`decline`, `declined`).
 * - yield: a pending mark a delivery (or another turn) cancelled skipped its
 *   turn end's compaction; the next turn end of that session is not marked
 *   below the ceiling, so compaction gets it (`takeYield`).
 */
export class WarmRecycleMarks {
  private readonly marks = new Map<string, { mark: WarmRecycleMark; stoppedAtMs: number | null; timer: unknown }>();
  /** agentId -> the session a start resumed although its stop was remembered. */
  private readonly declinedSessions = new Map<string, string>();
  /** agentId -> the session whose pending mark was cancelled: its next turn end goes to compaction. */
  private readonly yields = new Map<string, string>();

  constructor(private readonly timers: WarmRecycleTimers = realWarmRecycleTimers) {}

  /** Mark the agent's session; `onQuiet` runs after `quietMs` unless cancelled first (not armed when null: the caller stops now). */
  mark(agentId: string, mark: WarmRecycleMark, quiet: { quietMs: number; onQuiet: () => void } | null): void {
    this.dropMark(agentId);
    const timer = quiet ? this.timers.set(quiet.onQuiet, quiet.quietMs) : null;
    this.marks.set(agentId, { mark, stoppedAtMs: null, timer });
  }

  /** The mark still waiting for its stop, if any. */
  pending(agentId: string): WarmRecycleMark | null {
    const entry = this.marks.get(agentId);
    return entry && entry.stoppedAtMs === null ? entry.mark : null;
  }

  /**
   * Drop a pending mark; returns it, or null when none was pending. `yieldNext`
   * (a delivery arrived, the session is busy again): that session's next turn
   * end is left to compaction (`takeYield`).
   */
  cancel(agentId: string, { yieldNext = false }: { yieldNext?: boolean } = {}): WarmRecycleMark | null {
    const mark = this.pending(agentId);
    if (!mark) return null;
    this.dropMark(agentId);
    if (yieldNext) this.yields.set(agentId, mark.sessionId);
    return mark;
  }

  /** The host is stopping the process for this mark: kept for the next start. */
  stopped(agentId: string, nowMs: number): WarmRecycleMark | null {
    const entry = this.marks.get(agentId);
    if (!entry || entry.stoppedAtMs !== null) return null;
    if (entry.timer != null) this.timers.clear(entry.timer);
    entry.timer = null;
    entry.stoppedAtMs = nowMs;
    return entry.mark;
  }

  /** At a start: the stop to decide on, if one is remembered. Whatever was kept for the agent's mark is gone after this. */
  takeStopped(agentId: string): WarmRecycleStop | null {
    const entry = this.marks.get(agentId);
    this.dropMark(agentId);
    this.yields.delete(agentId);
    if (!entry || entry.stoppedAtMs === null) return null;
    return { sessionId: entry.mark.sessionId, stoppedAtMs: entry.stoppedAtMs, contextTokens: entry.mark.contextTokens, band: entry.mark.band };
  }

  /** A start took this session's remembered stop and resumed it anyway: never mark it again. */
  decline(agentId: string, sessionId: string): void {
    this.declinedSessions.set(agentId, sessionId);
  }

  declined(agentId: string, sessionId: string): boolean {
    return this.declinedSessions.get(agentId) === sessionId;
  }

  /** At a turn end: whether this session's turn end goes to compaction after a cancelled mark. Asked once: it is gone after this. */
  takeYield(agentId: string, sessionId: string): boolean {
    const yielded = this.yields.get(agentId);
    this.yields.delete(agentId);
    return yielded === sessionId;
  }

  /**
   * The process is gone or going for another reason (an exit or crash, a
   * stop, a spec restart): a pending mark and its timer go, with no event.
   * A stop the host already made for a mark is kept for the next start.
   */
  dropPending(agentId: string): void {
    this.yields.delete(agentId);
    if (this.pending(agentId)) this.dropMark(agentId);
  }

  /** The agent leaves this host for good (an explicit stop): everything kept for it goes. */
  forget(agentId: string): void {
    this.dropMark(agentId);
    this.declinedSessions.delete(agentId);
    this.yields.delete(agentId);
  }

  /** Host shutdown: no timer outlives it. */
  clear(): void {
    for (const agentId of [...this.marks.keys()]) this.dropMark(agentId);
    this.declinedSessions.clear();
    this.yields.clear();
  }

  private dropMark(agentId: string): void {
    const entry = this.marks.get(agentId);
    if (entry && entry.timer != null) this.timers.clear(entry.timer);
    this.marks.delete(agentId);
  }
}

/** Who a delivery that cancelled a pending stop came from: the message's sender type (`third_party_app` as `app`), or `daemon` for input the daemon wrote itself. */
export type WarmRecycleSenderKind = "human" | "agent" | "system" | "app" | "daemon";

export function warmRecycleSenderKind(senderType: string | null | undefined): WarmRecycleSenderKind {
  if (senderType === "human" || senderType === "agent" || senderType === "system") return senderType;
  return senderType === "third_party_app" ? "app" : "daemon";
}

/** Why a pending stop was dropped: a delivery arrived, or the session was no longer idle when the quiet period ended. */
export type WarmRecycleCancelReason = "delivery" | "not_idle";

interface WarmRecycleTraceBase {
  agentId: string;
  launchId?: string | undefined;
  runtime: string | undefined;
  host: WarmRecycleHost;
}

/** Trace attributes (no content, no ids beyond the neighbours') and the one daemon-log line of each warm-recycle step. */
export function describeWarmRecycleMarked(base: WarmRecycleTraceBase, mark: WarmRecycleMark, config: WarmRecycleConfig): { attrs: Record<string, unknown>; logLine: string } {
  return {
    attrs: {
      ...base,
      session_id: mark.sessionId,
      context_tokens: mark.contextTokens,
      window_tokens: mark.windowTokens,
      band: mark.band,
      threshold_tokens: config.minContextTokens,
      ceiling_tokens: config.ceilingTokens,
      quiet_ms: config.quietMs,
    },
    logLine: `[WakeRecycle] warm mark: agent ${base.agentId} session ${mark.sessionId}, band ${mark.band}, ${mark.contextTokens} context tokens of a ${mark.windowTokens} window (${base.host}); ${mark.band === "ceiling" ? "stopping now" : `stops after ${config.quietMs}ms with no delivery`}`,
  };
}

export function describeWarmRecycleStopped(base: WarmRecycleTraceBase, mark: WarmRecycleMark, nowMs: number): { attrs: Record<string, unknown>; logLine: string } {
  const waitedMs = Math.max(0, nowMs - mark.markedAtMs);
  return {
    attrs: {
      ...base,
      session_id: mark.sessionId,
      context_tokens: mark.contextTokens,
      window_tokens: mark.windowTokens,
      band: mark.band,
      waited_ms: waitedMs,
    },
    logLine: `[WakeRecycle] warm stop: agent ${base.agentId} session ${mark.sessionId}, band ${mark.band}, ${mark.contextTokens} context tokens of a ${mark.windowTokens} window, waited ${waitedMs}ms (${base.host}); the next start is a warm recycle`,
  };
}

export function describeWarmRecycleCancelled(
  base: WarmRecycleTraceBase,
  mark: WarmRecycleMark,
  nowMs: number,
  cause: { reason: WarmRecycleCancelReason; senderKind?: WarmRecycleSenderKind | undefined; triggerKind?: string | undefined },
): { attrs: Record<string, unknown>; logLine: string } {
  const waitedMs = Math.max(0, nowMs - mark.markedAtMs);
  return {
    attrs: {
      ...base,
      context_tokens: mark.contextTokens,
      band: mark.band,
      waited_ms: waitedMs,
      reason: cause.reason,
      ...(cause.senderKind ? { sender_kind: cause.senderKind } : {}),
      ...(cause.triggerKind ? { trigger_kind: cause.triggerKind } : {}),
    },
    logLine: `[WakeRecycle] warm cancel: agent ${base.agentId} session ${mark.sessionId}, ${cause.reason}${cause.senderKind ? ` from ${cause.senderKind}` : ""}, waited ${waitedMs}ms, band ${mark.band}, ${mark.contextTokens} context tokens (${base.host}); the session continues`,
  };
}
