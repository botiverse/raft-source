import { useMemo, useState } from "react";
import { AGENT_USAGE_FEATURE_FLAG_KEY, currentTimeMs } from "@botiverse/raft-shared";
import type { AgentUsageResponse } from "@botiverse/raft-shared";
import type { Agent } from "../../store/agentStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { canViewAgentPrivateSurfaces } from "../../utils/agentVisibility";
import { utcDay } from "../agent/agentUsage";
import type { AgentUsageView } from "../agent/agentUsage";
import { useAgentUsage } from "../agent/useAgentUsage";
import { DEFAULT_USAGE_SORT, summarizeMembersUsage } from "./membersAgentUsageModel";
import type { UsageSort } from "./membersAgentUsageModel";
import { knownUsageFilterPicks, resolveUsageFilter, usageFilterOptions } from "./membersAgentUsageFilterModel";

// The state of Members › Agents › Usage (#proj-o11y:#36 step 2): who gets it,
// and its period, cache reads, sort and one read per period.

/**
 * Whether the reader gets the usage view: agent_usage_v0 is on and they may
 * inspect at least one listed agent (the Activity rule; the server answers
 * for exactly those).
 */
export function useMembersUsageAccess(agents: readonly Agent[], userId: string | undefined, canEditAgents: boolean): boolean {
  const enabled = useServerFeatureFlag(AGENT_USAGE_FEATURE_FLAG_KEY).enabled;
  return enabled && agents.some((agent) => canViewAgentPrivateSurfaces(agent, userId, canEditAgents));
}

/**
 * The usage view's state and its one read, made while `enabled`: the period,
 * cache reads, the sort and the agent filter. Its figures cover only the
 * `listed` agents (the Members list's), whatever else the answer holds. The
 * filter narrows the answer here, with no read of its own: the summary
 * shows the kept agents, Share stays of all of them (v5 mock), and one kept
 * agent is the one-agent view. Like the page's other filters (search, tab),
 * it lives as long as the page, not in the URL.
 */
export function useMembersAgentUsage(enabled: boolean, listed: readonly Agent[]) {
  const [view, setView] = useState<AgentUsageView>({ range: 7, day: null });
  const [withCacheReads, setWithCacheReads] = useState(false);
  const [sort, setSort] = useState<UsageSort>(DEFAULT_USAGE_SORT);
  const { load, retry } = useAgentUsage(null, view.range, enabled);
  const today = load.kind === "ready" ? load.response.to : utcDay(currentTimeMs());
  const [filter, setFilter] = useState<string[]>([]);
  // The filter's choices are the listed agents of the latest answer, kept
  // while the next period loads, so a picked filter keeps its name.
  const [answer, setAnswer] = useState<AgentUsageResponse | null>(null);
  if (load.kind === "ready" && load.response !== answer) setAnswer(load.response);
  const listedIds = useMemo(() => new Set(listed.map((agent) => agent.id)), [listed]);
  const filterOptions = useMemo(() => {
    const answered = new Set(answer?.agents.map((agent) => agent.agent_id) ?? []);
    return usageFilterOptions(listed.filter((agent) => answered.has(agent.id)));
  }, [answer, listed]);
  // A pick that is no longer a choice (its agent left the answer) is dropped
  // for good, so it doesn't come back with a later period.
  const [optionsSeen, setOptionsSeen] = useState(filterOptions);
  if (optionsSeen !== filterOptions) {
    setOptionsSeen(filterOptions);
    const known = knownUsageFilterPicks(filter, filterOptions).map((option) => option.id);
    if (known.length !== filter.length) setFilter(known);
  }
  const selected = useMemo(() => resolveUsageFilter(filter, filterOptions), [filter, filterOptions]);
  const figures = useMemo(
    () => (load.kind === "ready" ? summarizeMembersUsage(load.response, listedIds, view, withCacheReads, selected) : null),
    [listedIds, load, selected, view, withCacheReads],
  );
  const oneId = selected?.size === 1 ? [...selected][0]! : null;
  const one = oneId ? listed.find((agent) => agent.id === oneId) ?? null : null;
  return {
    view,
    setView,
    withCacheReads,
    setWithCacheReads,
    sort,
    setSort,
    load,
    retry,
    today,
    figures,
    filter,
    setFilter,
    filterOptions,
    /** The agents the filter keeps; null with no filter. */
    selected,
    /** The filter keeps exactly one agent: its usage in full, no list. */
    one,
    /** The reader may inspect none of the listed agents, the server says: no usage view. */
    none: figures !== null && figures.visible === 0,
  };
}
export type MembersAgentUsageState = ReturnType<typeof useMembersAgentUsage>;
