import type { DatabaseExecutor } from "../db/index";
import { agentConfigChangeEvents } from "../db/schema";

/**
 * History of an agent's configured runtime / model / reasoning effort.
 *
 * `agents` stores only the current values. Every code path that writes one of
 * those three columns calls `recordAgentConfigChange` with the same executor
 * (transaction) as its agents write, so a committed change always has its
 * event and a rolled-back one never does. Only the three values are copied:
 * never `runtime_config` or env vars, which may carry secrets.
 *
 * This is the CONFIGURED model. The model a turn actually ran on (a runtime
 * fallback, an external agent's own choice) is not known here.
 */

/** The code path that changed the configuration. Add a value per new writer. */
export type AgentConfigChangeSource =
  | "agent_create"
  | "agents_route_create"
  | "assistant_create"
  | "hosted_cindy_create"
  | "raftbench_create"
  | "app_bot_create"
  | "agent_update"
  | "agents_route_update"
  | "hosted_cindy_convert_to_computer"
  | "hosted_migration"
  | "hosted_migration_revert";

export type AgentConfigChangeActor =
  | { kind: "user" | "agent"; id: string }
  | { kind: "system"; id?: null };

export type AgentConfigValues = {
  runtime: string;
  model: string;
  reasoningEffort: string | null;
};

export type AgentConfigChangeInput = {
  serverId: string;
  agentId: string;
  source: AgentConfigChangeSource;
  /** Null when the code path does not know who made the change. */
  actor?: AgentConfigChangeActor | null;
  /** Null for a newly created agent. */
  before: AgentConfigValues | null;
  after: AgentConfigValues;
  changedAt?: Date;
};

export function agentConfigChanged(before: AgentConfigValues | null, after: AgentConfigValues): boolean {
  if (!before) return true;
  return before.runtime !== after.runtime
    || before.model !== after.model
    || (before.reasoningEffort ?? null) !== (after.reasoningEffort ?? null);
}

/**
 * Write one event when runtime, model or reasoning effort differ between
 * `before` and `after` (always for a creation). Returns whether it wrote.
 */
export async function recordAgentConfigChange(
  executor: DatabaseExecutor,
  input: AgentConfigChangeInput,
): Promise<boolean> {
  if (!agentConfigChanged(input.before, input.after)) return false;
  await executor.insert(agentConfigChangeEvents).values({
    serverId: input.serverId,
    agentId: input.agentId,
    ...(input.changedAt ? { changedAt: input.changedAt } : {}),
    actorKind: input.actor?.kind ?? null,
    actorId: input.actor?.id ?? null,
    source: input.source,
    beforeRuntime: input.before?.runtime ?? null,
    afterRuntime: input.after.runtime,
    beforeModel: input.before?.model ?? null,
    afterModel: input.after.model,
    beforeReasoningEffort: input.before?.reasoningEffort ?? null,
    afterReasoningEffort: input.after.reasoningEffort ?? null,
  });
  return true;
}

/** The three tracked values of an agents row. */
export function agentConfigValues(row: { runtime: string; model: string; reasoningEffort: string | null }): AgentConfigValues {
  return { runtime: row.runtime, model: row.model, reasoningEffort: row.reasoningEffort ?? null };
}
