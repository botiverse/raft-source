// Native compaction at a turn end past a size threshold (#proj-runtime:#54
// phase 3; design: "Cutting long-session cost at idle boundaries", section 6).
//
// Phases 1 and 2 (wakeSessionRecycle.ts) act after idle time. An agent that
// gets task after task is never idle, so its context only grows: in the bench
// chain of 7 tasks in one session it went from 25k to 744k and cost 2.3 times
// a fresh session per task. This asks the runtime to compact with its own
// compaction (which keeps working state a turn boundary still needs; a turn end
// is not a task end) at a turn end where nothing is running, held or queued.
//
// One rule for both hosts: the Server's `turn_end_compaction` flag is on, the
// session's last model request carried more than 250k tokens of context, and
// the model's window is at least 400k (smaller windows keep the runtime's own
// automatic compaction). After a compaction it does not fire again until the
// context has dropped below the threshold and grown past it again, so a
// compaction that leaves the context large can't loop.
import type { SessionCapabilityDeclaration } from "@botiverse/oar";
import type { AgentConfig } from "@botiverse/raft-shared";

export const DEFAULT_TURN_END_COMPACTION_MIN_CONTEXT_TOKENS = 250_000;
export const DEFAULT_TURN_END_COMPACTION_MIN_WINDOW_TOKENS = 400_000;
/**
 * How long the daemon holds deliveries for an in-process runtime's compaction
 * (`compactAtTurnEnd`) before it gives up on it: past this, the call counts as
 * `failed:timeout` and what waited is written, so a compaction that never
 * settles can't hold an agent's messages until someone restarts it.
 */
export const DEFAULT_TURN_END_COMPACTION_DRIVER_TIMEOUT_MS = 10 * 60_000;

/** Legacy-host runtimes whose native compaction the host can ask for at a turn end in this version. */
export const TURN_END_COMPACTION_LEGACY_RUNTIMES: ReadonlySet<string> = new Set(["claude", "pi", "builtin", "kimi-sdk"]);

/**
 * Whether the OAR host may compact a session at a turn end, from what OAR
 * declares for the installation the session runs on
 * (`oarInstalledSessionCapabilities`), never from the runtime id.
 *
 * The decision reads two things and does one: the session summary's
 * `context.tokens` and `context.window` (from the runtime's usage reports,
 * what `Session.contextUsage()` reports), then `Session.compact()`. So both
 * halves of `contextUsage` must be declared trustworthy (without a window the
 * decision can only skip `window_unknown`; an untrustworthy size could fire on
 * a wrong reading), and `manualCompaction` must be `supported`. Its
 * `activeTurn` does not matter: the host asks only with nothing running.
 * `compactionEvents` is not needed: it describes the runtime's own automatic
 * compaction, while the host's call is confirmed by `compact()`'s own outcome,
 * and re-arming waits for the next usage report below the threshold.
 * Absent (unmeasured) is off.
 */
export function turnEndCompactionDeclared(capabilities: Pick<SessionCapabilityDeclaration, "manualCompaction" | "contextUsage"> | null | undefined): boolean {
  return capabilities?.manualCompaction?.kind === "supported"
    && capabilities.contextUsage?.tokens === true
    && capabilities.contextUsage.contextWindow === true;
}

/**
 * The rollout: OAR-host runtimes on which turn-end compaction has actually
 * run in Raft. A runtime whose declaration turns true is not compacted until
 * it has been exercised and added here (Tenny, #oar-raft:#39 047b8ce2;
 * OpenCode 2.x and DSH declare it but have not run it). Grok stays listed:
 * OAR declares no trustworthy window for it, so it is off by declaration,
 * which it was in effect before (no window, `window_unknown`).
 */
export const TURN_END_COMPACTION_OAR_ROLLOUT_RUNTIMES: ReadonlySet<string> = new Set(["claude", "codex", "grok", "pi"]);

/** OAR declares it for the installation AND the runtime is rolled out. */
export function turnEndCompactionAllowed(runtimeId: string, capabilities: Pick<SessionCapabilityDeclaration, "manualCompaction" | "contextUsage"> | null | undefined): boolean {
  return TURN_END_COMPACTION_OAR_ROLLOUT_RUNTIMES.has(runtimeId) && turnEndCompactionDeclared(capabilities);
}

export interface TurnEndCompactionConfig {
  enabled: boolean;
  minContextTokens: number;
  minWindowTokens: number;
  /** The cap on the delivery hold around `compactAtTurnEnd()`. */
  driverTimeoutMs: number;
}

function parsePositiveInteger(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The knobs for one agent: the Server's flag, then per-agent env over the
 * daemon's env. `RAFT_TURN_END_COMPACTION=0` turns it off locally even with
 * the flag on; it never turns it on without the flag.
 */
export function resolveTurnEndCompactionConfig(
  config: { envVars?: AgentConfig["envVars"]; turnEndCompaction?: AgentConfig["turnEndCompaction"] },
  processEnv: NodeJS.ProcessEnv = process.env,
): TurnEndCompactionConfig {
  const pick = (key: string): string | undefined => config.envVars?.[key] ?? processEnv[key];
  return {
    enabled: config.turnEndCompaction === true && pick("RAFT_TURN_END_COMPACTION") !== "0",
    minContextTokens: parsePositiveInteger(pick("RAFT_TURN_END_COMPACTION_MIN_CONTEXT_TOKENS")) ?? DEFAULT_TURN_END_COMPACTION_MIN_CONTEXT_TOKENS,
    minWindowTokens: parsePositiveInteger(pick("RAFT_TURN_END_COMPACTION_MIN_WINDOW_TOKENS")) ?? DEFAULT_TURN_END_COMPACTION_MIN_WINDOW_TOKENS,
    driverTimeoutMs: parsePositiveInteger(pick("RAFT_TURN_END_COMPACTION_TIMEOUT_MS")) ?? DEFAULT_TURN_END_COMPACTION_DRIVER_TIMEOUT_MS,
  };
}

/** The size facts at a turn end: the last model request's context, and the model's window. */
export interface TurnEndContextFacts {
  /** input + cache read + cache write of the session's last model request; null when not reported. */
  contextTokens: number | null;
  /** The model's context window as the runtime reports it; null when unknown. */
  windowTokens: number | null;
}

export type TurnEndCompactionSkipReason =
  | "context_unknown"
  | "window_unknown"
  | "window_too_small"
  | "below_threshold"
  | "not_rearmed";

export type TurnEndCompactionDecision =
  | { fire: true }
  | { fire: false; reason: TurnEndCompactionSkipReason };

export function decideTurnEndCompaction(
  config: TurnEndCompactionConfig,
  facts: TurnEndContextFacts,
  armed: boolean,
): TurnEndCompactionDecision {
  if (facts.contextTokens === null) return { fire: false, reason: "context_unknown" };
  if (facts.windowTokens === null) return { fire: false, reason: "window_unknown" };
  if (facts.windowTokens < config.minWindowTokens) return { fire: false, reason: "window_too_small" };
  if (facts.contextTokens <= config.minContextTokens) return { fire: false, reason: "below_threshold" };
  if (!armed) return { fire: false, reason: "not_rearmed" };
  return { fire: true };
}

/**
 * "Don't fire twice in a row", per session: armed until a compaction fires,
 * armed again once a turn end sees the context at or below the threshold.
 * A new session starts armed.
 */
export class TurnEndCompactionArming {
  private sessionId: string | null = null;
  private armed = true;

  /** Whether a compaction may fire for this session now; a context at or below the threshold re-arms first. */
  observe(sessionId: string | null, contextTokens: number | null, minContextTokens: number): boolean {
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.armed = true;
    }
    if (contextTokens !== null && contextTokens <= minContextTokens) this.armed = true;
    return this.armed;
  }

  markFired(): void {
    this.armed = false;
  }

  /** A compaction the runtime refused did nothing: armed again for a later turn end. */
  rearm(): void {
    this.armed = true;
  }
}

/** Trace attributes every turn_end_compaction event carries (no content). */
export function turnEndCompactionTraceAttrs(config: TurnEndCompactionConfig, facts: TurnEndContextFacts): Record<string, number> {
  return {
    threshold_tokens: config.minContextTokens,
    min_window_tokens: config.minWindowTokens,
    ...(facts.contextTokens !== null ? { context_tokens: facts.contextTokens } : {}),
    ...(facts.windowTokens !== null ? { context_window_tokens: facts.windowTokens } : {}),
  };
}

export const TURN_END_COMPACTION_EVENT = "daemon.agent.turn_end_compaction";

/**
 * The one daemon-log line of a settled turn-end compaction (the offline bench
 * audits the log, not the traces): its outcome and the context it was asked
 * at, as the event's `outcome` / `context_tokens` say them.
 */
export function turnEndCompactionLogLine(input: {
  agentId: string;
  host: "legacy" | "oar";
  outcome: string;
  contextTokens: number | null;
  contextAfterTokens?: number | null;
  durationMs: number;
}): string {
  const after = input.contextAfterTokens != null ? `, ${input.contextAfterTokens} after` : "";
  return `[TurnEndCompaction] agent ${input.agentId}: ${input.outcome}, ${input.contextTokens ?? "unknown"} context tokens before${after}, took ${input.durationMs}ms (${input.host})`;
}

/**
 * What an in-process runtime's own compaction came to (`RuntimeDriver.compactAtTurnEnd`):
 * `refused` did nothing (busy, nothing to compact) and keeps the arm; `failed`
 * ran and failed, and stays disarmed until the context is back under the
 * threshold (Pi: a failed compaction sticks to the session, so retrying at
 * every turn end would loop).
 */
export type TurnEndCompactionDriverOutcome =
  | { kind: "completed" }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; reason: string };
