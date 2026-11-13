// The figures of Members › Agents › Usage (#proj-o11y:#36 step 2): one
// answer of GET /api/servers/:serverId/agent-usage for every agent the reader
// may inspect, summed for the whole list and per agent with the agent panel's
// own helpers (agentUsage.ts), and the list's sort. Pure: no React, no store.

import type { AgentUsageResponse, AgentUsageRow } from "@botiverse/raft-shared";
import {
  chartTokens,
  relativeChange,
  summarizeUsageRows,
  tokensPerTurn,
  usageContext,
  usageReported,
  usageSince,
} from "../agent/agentUsage";
import type { AgentUsageView, UsageFigures } from "../agent/agentUsage";

/** One agent's row of the usage view; null is "—" (not reported, or before its data starts). */
export interface AgentUsageListRow {
  /**
   * False: no turn of the agent has reported usage yet (the server's
   * `usage_reported`): it hasn't run since usage was recorded, or its Computer
   * doesn't send usage; nothing here tells which. Every figure is null.
   */
  hasUsage: boolean;
  /** New input + cache write + output, plus cache reads when asked. */
  tokens: number | null;
  perTurn: number | null;
  /** The latest context reading; null for a past day (it is the latest only) or when not reported. */
  context: { used: number; window: number } | null;
  /** Against the prior period, like with like (agentUsage.ts). */
  change: number | null;
  /** The range's days, oldest first, for the trend line: null before the data starts. */
  trend: (number | null)[];
}

/** Some agents together: their figures from the earliest of their `since`. */
export interface UsageGroupFigures {
  total: UsageFigures;
  /** The total's tokens, as the rows count them. */
  totalTokens: number | null;
  /** Of them, the agents with usage in the shown period. */
  reporting: number;
  /** How many agents they are. */
  agents: number;
}

export interface MembersAgentUsage {
  /** The listed agents together, from the earliest of their `since`. */
  total: UsageFigures;
  /** The total's tokens, as the rows count them: what Share divides by, also while filtered. */
  totalTokens: number | null;
  /** Listed agents with usage in the shown period. */
  reporting: number;
  /** Listed agents the reader may inspect (the answer's agents in the list). */
  visible: number;
  rows: ReadonlyMap<string, AgentUsageListRow>;
  /** The agents the filter keeps, together (what the summary shows then); null with no filter. */
  selection: UsageGroupFigures | null;
}

/**
 * Some of the answer's agents together. The total starts at the earliest
 * `since` of them (never before the server's), so days before any of them
 * reported are "—" and the change compares like with like.
 */
function summarizeGroup(
  response: AgentUsageResponse,
  agentIds: ReadonlySet<string>,
  view: AgentUsageView,
  withCacheReads: boolean,
): UsageGroupFigures {
  const agents = response.agents.filter((agent) => agentIds.has(agent.agent_id));
  const rows = response.rows.filter((row) => agentIds.has(row.agent_id));
  const earliestAgentSince = agents.map((agent) => agent.since).filter((day): day is string => day !== null).sort()[0] ?? null;
  const since = [response.since, earliestAgentSince].filter((day): day is string => day !== null).sort().at(-1) ?? null;
  const total = summarizeUsageRows(response, rows, since, view, withCacheReads);
  const shownDays = new Set(view.day ? [view.day] : total.days.map((day) => day.day));
  return {
    total,
    totalTokens: total.noData ? null : chartTokens(total.sums, withCacheReads),
    reporting: new Set(rows.filter((row) => shownDays.has(row.day)).map((row) => row.agent_id)).size,
    agents: agents.length,
  };
}


/**
 * The usage view's figures over the agents the list shows (`listed`): the
 * answer may hold others the reader may inspect (an archived agent, one the
 * Members list leaves out), which count nowhere here. With a filter
 * (`selected`), its agents together too: Share stays of all listed agents.
 */
export function summarizeMembersUsage(
  response: AgentUsageResponse,
  listed: ReadonlySet<string>,
  view: AgentUsageView,
  withCacheReads: boolean,
  selected: ReadonlySet<string> | null = null,
): MembersAgentUsage {
  const agents = response.agents.filter((agent) => listed.has(agent.agent_id));
  const answered = new Set(agents.map((agent) => agent.agent_id));
  const whole = summarizeGroup(response, answered, view, withCacheReads);
  const rowsByAgent = new Map<string, AgentUsageRow[]>(agents.map((agent) => [agent.agent_id, []]));
  for (const row of response.rows) rowsByAgent.get(row.agent_id)?.push(row);
  // The context is the latest reading only: not shown for a past day.
  const pickedPast = view.day !== null && view.day !== response.to;

  const rows = new Map<string, AgentUsageListRow>();
  for (const { agent_id: agentId } of agents) {
    if (!usageReported(response, agentId)) {
      rows.set(agentId, { hasUsage: false, tokens: null, perTurn: null, context: null, change: null, trend: whole.total.days.map(() => null) });
      continue;
    }
    const figures = summarizeUsageRows(response, rowsByAgent.get(agentId)!, usageSince(response, agentId), view, withCacheReads);
    rows.set(agentId, {
      hasUsage: true,
      tokens: figures.noData ? null : chartTokens(figures.sums, withCacheReads),
      perTurn: figures.noData ? null : tokensPerTurn(figures.sums),
      context: pickedPast ? null : usageContext(response, agentId),
      change: figures.noData ? null : relativeChange(figures.compared, figures.base),
      trend: figures.days.map((day) => (day.noData ? null : chartTokens(day.sums, withCacheReads) ?? 0)),
    });
  }
  const kept = selected ? new Set([...answered].filter((agentId) => selected.has(agentId))) : null;
  return {
    total: whole.total,
    totalTokens: whole.totalTokens,
    reporting: whole.reporting,
    visible: whole.agents,
    rows,
    selection: kept ? summarizeGroup(response, kept, view, withCacheReads) : null,
  };
}

export const USAGE_SORT_KEYS = ["name", "tokens", "share", "perTurn", "context", "change"] as const;
export type UsageSortKey = (typeof USAGE_SORT_KEYS)[number];
export interface UsageSort {
  key: UsageSortKey;
  direction: "ascending" | "descending";
}

export const DEFAULT_USAGE_SORT: UsageSort = { key: "tokens", direction: "descending" };

/** A column's first sort: names A–Z, numbers most first. */
export function firstUsageSort(key: UsageSortKey): UsageSort["direction"] {
  return key === "name" ? "ascending" : "descending";
}

function sortValue(row: AgentUsageListRow | undefined, key: Exclude<UsageSortKey, "name">): number | null {
  if (!row) return null;
  if (key === "tokens" || key === "share") return row.tokens;
  if (key === "perTurn") return row.perTurn;
  if (key === "context") return row.context ? row.context.used / row.context.window : null;
  return row.change;
}

/**
 * The entries in the sort's order. What is not known ("—") goes last either
 * way; ties keep their name order.
 */
export function sortUsageEntries<T extends { id: string; name: string }>(
  entries: readonly T[],
  rows: ReadonlyMap<string, AgentUsageListRow>,
  sort: UsageSort,
  locale: string,
): T[] {
  const sign = sort.direction === "ascending" ? 1 : -1;
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, locale, { sensitivity: "base" });
  return [...entries].sort((a, b) => {
    if (sort.key === "name") return sign * byName(a, b);
    const x = sortValue(rows.get(a.id), sort.key);
    const y = sortValue(rows.get(b.id), sort.key);
    if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1;
    return x === y ? byName(a, b) : sign * (x - y);
  });
}
