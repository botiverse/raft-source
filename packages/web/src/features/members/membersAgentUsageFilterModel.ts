// The agent filter of Members › Agents › Usage (#proj-o11y:#36 step 2, v5
// mock): its choices, quick picks by runtime and by model, then each agent,
// and which agents a set of picks selects (their union). Pure: no React, no
// store; the words are the component's.

import type { Agent } from "../../store/agentStore";

export type UsageFilterKind = "runtime" | "model" | "agent";

export interface UsageFilterOption {
  /** `runtime:<runtime>`, `model:<model>` or `agent:<id>`: what the filter keeps. */
  id: string;
  kind: UsageFilterKind;
  /** The agents it picks, in the given agents' order. */
  agentIds: string[];
  /** An agent of it, to name it by (a runtime's or model's label is its agents'). */
  agent: Agent;
}

export interface UsageFilterOptions {
  runtime: UsageFilterOption[];
  model: UsageFilterOption[];
  agent: UsageFilterOption[];
}

/** Runtimes and models by how many agents they hold, most first (ties in the agents' order). */
function quickPicks(agents: readonly Agent[], kind: "runtime" | "model"): UsageFilterOption[] {
  const byKey = new Map<string, Agent[]>();
  for (const agent of agents) {
    // An App's identity runs on no runtime or model of its own (agentRuntimeFacts).
    const key = agent.managedByAppInstallId ? null : agent[kind];
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), agent]);
  }
  return [...byKey.entries()]
    .map(([key, members]) => ({ id: `${kind}:${key}`, kind, agentIds: members.map((agent) => agent.id), agent: members[0]! }))
    .sort((a, b) => b.agentIds.length - a.agentIds.length);
}

/** The choices for the agents the usage view lists (in their list order). */
export function usageFilterOptions(agents: readonly Agent[]): UsageFilterOptions {
  return {
    runtime: quickPicks(agents, "runtime"),
    model: quickPicks(agents, "model"),
    agent: agents.map((agent) => ({ id: `agent:${agent.id}`, kind: "agent", agentIds: [agent.id], agent })),
  };
}

function allUsageFilterOptions(options: UsageFilterOptions): UsageFilterOption[] {
  return [...options.runtime, ...options.model, ...options.agent];
}

/** The picks that are still choices (an agent may have gone since it was picked), in pick order. */
export function knownUsageFilterPicks(picks: readonly string[], options: UsageFilterOptions): UsageFilterOption[] {
  const byId = new Map(allUsageFilterOptions(options).map((option) => [option.id, option]));
  return picks.map((id) => byId.get(id)).filter((option): option is UsageFilterOption => option !== undefined);
}

/** The agents the picks select, their union; null for no filter (no picks, or none still a choice). */
export function resolveUsageFilter(picks: readonly string[], options: UsageFilterOptions): ReadonlySet<string> | null {
  const known = knownUsageFilterPicks(picks, options);
  if (known.length === 0) return null;
  return new Set(known.flatMap((option) => option.agentIds));
}
