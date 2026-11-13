// The legacy host's half of turn-end compaction (#proj-runtime:#54 phase 3;
// the rule is turnEndCompaction.ts). Claude Code compacts on `/compact`, sent as
// a turn of its own once the previous turn has ended with nothing running,
// held or queued; Claude reports it as `compaction_started` /
// `compaction_finished` (claudeEventNormalizer.ts) and ends the turn with an
// ordinary result.
import { existsSync } from "node:fs";
import path from "node:path";
import type { ParsedEvent } from "./drivers/index";
import { TurnEndCompactionArming, type TurnEndContextFacts } from "./turnEndCompaction";

type TelemetryEvent = Extract<ParsedEvent, { kind: "telemetry" }>;

export interface LegacyTurnEndCompactionState {
  arming: TurnEndCompactionArming;
  /** The latest Claude result's facts: its last request's context and the model's window. */
  facts: TurnEndContextFacts;
  /** The `/compact` turn in flight, settled at its turn end. */
  /**
   * The compaction asked for and not settled yet. `viaDriver`: an in-process
   * runtime's own compaction API (Pi, Built-in, Kimi SDK), not a turn; until
   * the call settles the daemon holds every delivery itself
   * (`driverCompactionHolds`), whatever events the runtime reports.
   */
  inFlight: { startedAtMs: number; finishedAtMs: number | null; contextTokens: number | null; viaDriver?: true } | null;
  /** The last skip reported for this session (one event per session and reason). */
  lastSkipKey: string | null;
  /** True while `/compact` is being written (a failed write's give-back is an idle edge of its own). */
  attempting: boolean;
  /**
   * The `/compact` turn just ended: its idle edge is the end of no work the
   * agent did, so the working-to-idle hooks (the Cleaner's MEMORY.md hint, the
   * idle task reminder) already ran for the real turn before it and must not
   * run again. Consumed by that edge; any other input clears it.
   */
  skipNextIdleHooks: boolean;
}

export function createLegacyTurnEndCompactionState(): LegacyTurnEndCompactionState {
  return { arming: new TurnEndCompactionArming(), facts: { contextTokens: null, windowTokens: null }, inFlight: null, lastSkipKey: null, attempting: false, skipNextIdleHooks: false };
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Claude's result usage: `lastRequestContextTokens` is the main agent's last
 * request (claudeEventNormalizer.ts), `modelUsageMaxContextWindow` the largest
 * window among the models it used. A result without them keeps the last known.
 */
export function noteLegacyTurnEndContext(state: LegacyTurnEndCompactionState, event: TelemetryEvent): void {
  if (event.name !== "token_usage" || event.source !== "claude_result_usage") return;
  const context = positive(event.attrs.lastRequestContextTokens);
  const window = positive(event.attrs.modelUsageMaxContextWindow);
  if (context !== null) state.facts.contextTokens = context;
  if (window !== null) state.facts.windowTokens = window;
}

export type LegacyTurnEndCompactionBlock =
  | "agent_busy"
  | "compacting"
  | "stopping"
  | "deliveries_waiting"
  | "runtime_failure_state"
  | "server_context_pending"
  | "not_deliverable"
  | "compact_command_overridden";

/**
 * Why `/compact` must not be written now, or null. Server context pending
 * would be written ahead of the next input (task #26) and turn `/compact` into
 * ordinary text, so it waits for the next turn end like everything else here.
 */
export function legacyTurnEndCompactionPreconditionFailure(input: {
  notIdleReason: unknown;
  compacting: boolean;
  stopping: boolean;
  untoldInbox: boolean;
  failureState: boolean;
  serverContextPending: boolean;
  deliverable: boolean;
  commandOverridden: boolean;
}): LegacyTurnEndCompactionBlock | null {
  if (input.stopping) return "stopping";
  if (input.compacting) return "compacting";
  if (input.notIdleReason !== null) return "agent_busy";
  if (input.untoldInbox) return "deliveries_waiting";
  if (input.failureState) return "runtime_failure_state";
  if (!input.deliverable) return "not_deliverable";
  if (input.serverContextPending) return "server_context_pending";
  if (input.commandOverridden) return "compact_command_overridden";
  return null;
}

/**
 * Whether a project or user command named `compact` would run instead of
 * Claude Code's built-in (a `.claude/commands/compact.md` in the agent's
 * workspace, or `commands/compact.md` in its Claude config dir). OAR asks the
 * running Claude for its command catalog instead; the legacy driver reads no
 * control responses, so this checks the files Claude Code reads them from.
 * Plugin commands are not covered (they are namespaced `plugin:name`).
 */
export function claudeCompactCommandOverridden(input: { workspaceDir: string; homeDir: string; claudeConfigDir?: string | undefined }): boolean {
  const configDir = input.claudeConfigDir || path.join(input.homeDir, ".claude");
  return [
    path.join(input.workspaceDir, ".claude", "commands", "compact.md"),
    path.join(configDir, "commands", "compact.md"),
  ].some((file) => existsSync(file));
}
