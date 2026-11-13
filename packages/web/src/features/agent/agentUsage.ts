// An agent's token usage for the panel's Usage tab (#proj-o11y:#36 step 1):
// the read of GET /api/servers/:serverId/agent-usage and the sums the tab
// draws. Pure: no React, no store.
//
// The response (AgentUsageResponse and its rows) is @botiverse/raft-shared's:
// a count is null when not reported (drawn "—", left out of totals), 0 is a
// real zero; reasoning_output is part of output, never added to it.

import { AGENT_USAGE_MAX_RANGE_DAYS } from "@botiverse/raft-shared";
import type { AgentUsageResponse, AgentUsageRow } from "@botiverse/raft-shared";

export const AGENT_USAGE_RANGES = [7, 14, 30] as const;
export type AgentUsageRange = (typeof AGENT_USAGE_RANGES)[number];

/** What the tab shows: a range of days ending today and, optionally, one picked day in it. */
export interface AgentUsageView {
  range: AgentUsageRange;
  day: string | null;
}

export function agentUsagePath(serverId: string): string {
  return `/servers/${serverId}/agent-usage`;
}

/** The UTC date of an instant, YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/**
 * The days a range asks for: the range itself and as many days before it, so
 * the change against the prior period can be shown when the server has those
 * days. Never more than the server answers (AGENT_USAGE_MAX_RANGE_DAYS): days
 * cut off are missing, and missing prior days mean no change.
 */
export function agentUsageRequestWindow(range: number, today: string): { from: string; to: string } {
  const span = Math.min(2 * range, AGENT_USAGE_MAX_RANGE_DAYS);
  return { from: addDays(today, -(span - 1)), to: today };
}

/** The range's days, oldest first, ending today. */
export function rangeDays(range: AgentUsageRange, today: string): string[] {
  return Array.from({ length: range }, (_, index) => addDays(today, index - range + 1));
}

export interface UsageSums {
  inputNew: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  turns: number;
}

const EMPTY_SUMS: UsageSums = { inputNew: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, turns: 0 };

function addReported(sum: number | null, value: number | null): number | null {
  return value === null ? sum : (sum ?? 0) + value;
}

export function sumRows(rows: readonly AgentUsageRow[]): UsageSums {
  let sums = EMPTY_SUMS;
  for (const row of rows) {
    sums = {
      inputNew: addReported(sums.inputNew, row.input_new),
      cacheRead: addReported(sums.cacheRead, row.cache_read),
      cacheWrite: addReported(sums.cacheWrite, row.cache_write),
      output: addReported(sums.output, row.output),
      reasoning: addReported(sums.reasoning, row.reasoning_output),
      turns: sums.turns + row.turns,
    };
  }
  return sums;
}

/** The sum of the reported values; null when none of them is reported (not provided is not 0). */
function sumReported(values: readonly (number | null)[]): number | null {
  return values.reduce<number | null>((sum, value) => addReported(sum, value), null);
}

/** Every reported kind (reasoning is inside output); null when no kind is reported. */
export function totalTokens(sums: UsageSums): number | null {
  return sumReported([sums.inputNew, sums.cacheRead, sums.cacheWrite, sums.output]);
}

/** What the bars and the headline count: new input + cache write + output, plus cache reads when asked; null when none of those is reported. */
export function chartTokens(sums: UsageSums, withCacheReads: boolean): number | null {
  return sumReported([sums.inputNew, sums.cacheWrite, sums.output, ...(withCacheReads ? [sums.cacheRead] : [])]);
}

/** Cache reads as a share of all input (new + cache write + cache read); null when not reported or no input. */
export function cacheShareOfInput(sums: UsageSums): number | null {
  if (sums.cacheRead === null) return null;
  const input = (sums.inputNew ?? 0) + (sums.cacheWrite ?? 0) + sums.cacheRead;
  return input > 0 ? sums.cacheRead / input : null;
}

export function tokensPerTurn(sums: UsageSums): number | null {
  const total = totalTokens(sums);
  return total !== null && sums.turns > 0 ? total / sums.turns : null;
}

/** Change against a base: null when the base is 0 or missing. */
export function relativeChange(now: number | null, base: number | null): number | null {
  if (now === null || base === null || base <= 0) return null;
  return now / base - 1;
}

export interface UsageDay {
  day: string;
  /** Before usage was recorded for this agent: no bar, "—". */
  noData: boolean;
  /** The day still in progress. */
  partial: boolean;
  sums: UsageSums;
}

export interface UsageModel {
  /** null when the server has no runtime for the rows. */
  runtime: string | null;
  /** "" when the turns did not name their model. */
  model: string;
  /** null when the model reported none of the counted kinds. */
  tokens: number | null;
}

/**
 * The figures for some rows (one agent's, or every visible agent's) over a
 * view, with `since` where their data starts.
 */
export interface UsageFigures {
  days: UsageDay[];
  /** The first day with data; days before it have none. */
  since: string | null;
  asOf: string;
  /** The picked day is before the data starts: every figure is "—". */
  noData: boolean;
  sums: UsageSums;
  models: UsageModel[];
  /**
   * The change, like with like: the shown period's full days (today, still
   * in progress, left out) against as many full days just before them, or
   * a picked past day against the same weekday a week earlier. The chart
   * totals of both, or null when there is nothing to compare (Today alone,
   * or days before the data starts or outside the answer).
   */
  compared: number | null;
  base: number | null;
  /** The day the picked day is compared with (a week earlier), when there is one. */
  baseDay: string | null;
}

export type AgentUsageSummary =
  /** The agent's Computer does not report usage. */
  | { kind: "unsupported" }
  | { kind: "empty" }
  | (UsageFigures & { kind: "ready"; context: { used: number; window: number } | null });

/**
 * Where an agent's data starts: the later of the server's and the agent's
 * `since` (days before it are not drawn as zero); null when neither is known.
 */
export function usageSince(response: AgentUsageResponse, agentId: string): string | null {
  const agentSince = response.agents.find((agent) => agent.agent_id === agentId)?.since ?? null;
  const declared = [response.since, agentSince].filter((day): day is string => Boolean(day));
  return declared.length > 0 ? declared.sort().at(-1)! : null;
}

/** Whether the agent's Computer reports usage at all (false: "Update Raft Computer"). */
export function usageReported(response: AgentUsageResponse, agentId: string): boolean {
  return response.agents.find((agent) => agent.agent_id === agentId)?.usage_reported !== false;
}

/** The agent's latest context reading, when it reported both the context and its window. */
export function usageContext(response: AgentUsageResponse, agentId: string): { used: number; window: number } | null {
  const reading = response.context.find((entry) => entry.agent_id === agentId);
  return reading && reading.context_used !== null && reading.context_window !== null && reading.context_window > 0
    ? { used: reading.context_used, window: reading.context_window }
    : null;
}

function modelsOf(rows: readonly AgentUsageRow[], withCacheReads: boolean): UsageModel[] {
  const byModel = new Map<string, AgentUsageRow[]>();
  for (const row of rows) {
    const key = `${row.runtime}\u0000${row.model}`;
    byModel.set(key, [...(byModel.get(key) ?? []), row]);
  }
  return [...byModel.values()]
    .map((group) => ({ runtime: group[0]!.runtime, model: group[0]!.model, tokens: chartTokens(sumRows(group), withCacheReads) }))
    .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));
}

/**
 * The figures of some of the answer's rows for a view: one agent's (the
 * panel's tab, a Members row) or all of them (the Members summary). With no
 * rows at all, recorded days count as real zeros.
 */
export function summarizeUsageRows(
  response: AgentUsageResponse,
  rows: readonly AgentUsageRow[],
  since: string | null,
  view: AgentUsageView,
  withCacheReads: boolean,
): UsageFigures {
  const today = response.to;
  const hasData = (day: string) => day >= response.from && (since === null || day >= since);
  const partialDay = utcDay(Date.parse(response.as_of));
  const rowsOn = (day: string) => rows.filter((row) => row.day === day);
  const days = rangeDays(view.range, today).map((day) => ({
    day,
    noData: !hasData(day),
    partial: day === partialDay,
    sums: sumRows(rowsOn(day)),
  }));
  const shownDays = view.day ? [view.day] : days.map((day) => day.day);
  const shownRows = rows.filter((row) => shownDays.includes(row.day));
  const noData = !shownDays.some(hasData);
  // Recorded days without a row are real zeros for the kinds every runtime reports.
  const sumsOver = (period: readonly string[]): UsageSums => {
    const periodRows = rows.filter((row) => period.includes(row.day));
    const periodSums = sumRows(periodRows);
    return periodRows.length === 0 && period.some(hasData)
      ? { ...periodSums, inputNew: 0, cacheRead: 0, output: 0 }
      : periodSums;
  };
  const sums = sumsOver(shownDays);

  // Like with like: only full days, against as many full days just before.
  let compared: number | null = null;
  let base: number | null = null;
  let baseDay: string | null = null;
  const fullDays = shownDays.filter((day) => day !== partialDay);
  if (view.day && fullDays.length > 0) {
    baseDay = addDays(view.day, -7);
    if (hasData(baseDay)) {
      compared = chartTokens(sums, withCacheReads);
      base = chartTokens(sumsOver([baseDay]), withCacheReads);
    }
  } else if (!view.day && fullDays.length > 0) {
    const priorDays = fullDays.map((day) => addDays(day, -fullDays.length));
    if (hasData(priorDays[0]!)) {
      compared = chartTokens(sumsOver(fullDays), withCacheReads);
      base = chartTokens(sumsOver(priorDays), withCacheReads);
    }
  }

  return {
    days,
    since,
    asOf: response.as_of,
    noData,
    sums,
    models: modelsOf(shownRows, withCacheReads),
    compared,
    base,
    baseDay,
  };
}

/** The tab's figures for one agent and view, from the server's answer. */
export function summarizeAgentUsage(
  response: AgentUsageResponse,
  agentId: string,
  view: AgentUsageView,
  withCacheReads: boolean,
): AgentUsageSummary {
  if (!usageReported(response, agentId)) return { kind: "unsupported" };
  const rows = response.rows.filter((row) => row.agent_id === agentId);
  if (rows.length === 0) return { kind: "empty" };
  return {
    kind: "ready",
    ...summarizeUsageRows(response, rows, usageSince(response, agentId), view, withCacheReads),
    context: usageContext(response, agentId),
  };
}
