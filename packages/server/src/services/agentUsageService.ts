/**
 * Agent token usage (#proj-o11y:42f2af5c): each finished turn's `tokens`
 * (ActivityTurnSummary) added into agent_usage_daily per agent, model and UTC
 * day of the turn's end, and the agent's latest context use into
 * agent_usage_context.
 *
 * Idempotent by construction: the caller passes what the turn's
 * agent_activity_summary_v2 row held before this write (`before`, read under
 * the row lock in the same transaction) and what it holds now (`after`), and
 * only the difference is added. A replayed frame (the same summary again)
 * adds nothing; a rebuilt turn adds only what changed, and moves its counts
 * if its day or model changed. A turn counts once in `turns` however often it
 * is written.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  ACTIVITY_TURN_TOKEN_COUNT_FIELDS,
  type ActivityTurnTokenCountField,
  type ActivityTurnTokens,
  type AgentUsageResponse,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentUsageContext, agentUsageDaily } from "../db/schema";

export interface TurnTokensState {
  tokens?: ActivityTurnTokens;
  /** Epoch ms of the turn's end. */
  endedAt: number;
}

export interface TurnTokensChange {
  before?: TurnTokensState;
  after: TurnTokensState;
}

type Counts = Record<ActivityTurnTokenCountField, number | null>;

interface Bucket { day: string; model: string; counts: Counts; turns: number }

const COLUMN: Record<ActivityTurnTokenCountField, "inputNew" | "cacheRead" | "cacheWrite" | "output" | "reasoningOutput"> = {
  input: "inputNew",
  cacheRead: "cacheRead",
  cacheWrite: "cacheWrite",
  output: "output",
  reasoningOutput: "reasoningOutput",
};

const SQL_COLUMN: Record<ActivityTurnTokenCountField, string> = {
  input: "input_new",
  cacheRead: "cache_read",
  cacheWrite: "cache_write",
  output: "output",
  reasoningOutput: "reasoning_output",
};

/** UTC date (YYYY-MM-DD) of an epoch-ms time. */
export function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function hasCounts(tokens: ActivityTurnTokens | undefined): tokens is ActivityTurnTokens {
  return !!tokens && ACTIVITY_TURN_TOKEN_COUNT_FIELDS.some((field) => tokens[field] !== undefined);
}

function emptyCounts(): Counts {
  return { input: null, cacheRead: null, cacheWrite: null, output: null, reasoningOutput: null };
}

/**
 * The net change per (day, model): `after` added, `before` taken away. A
 * field stays null when neither side reported it, so a runtime that never
 * reports a count leaves the column null rather than writing 0.
 */
export function netUsageBuckets(changes: readonly TurnTokensChange[]): Bucket[] {
  const buckets = new Map<string, Bucket>();
  const add = (state: TurnTokensState | undefined, sign: 1 | -1) => {
    if (!state || !hasCounts(state.tokens)) return;
    const day = utcDay(state.endedAt);
    const model = state.tokens.model ?? "";
    const key = `${day}\u0000${model}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, bucket = { day, model, counts: emptyCounts(), turns: 0 });
    bucket.turns += sign;
    for (const field of ACTIVITY_TURN_TOKEN_COUNT_FIELDS) {
      const value = state.tokens[field];
      if (value === undefined) continue;
      bucket.counts[field] = (bucket.counts[field] ?? 0) + sign * value;
    }
  };
  for (const change of changes) {
    add(change.before, -1);
    add(change.after, 1);
  }
  return [...buckets.values()].filter((bucket) => bucket.turns !== 0
    || ACTIVITY_TURN_TOKEN_COUNT_FIELDS.some((field) => (bucket.counts[field] ?? 0) !== 0));
}

/**
 * Add the turns' usage changes. Call inside the transaction that writes their
 * agent_activity_summary_v2 rows, with `before` read under that row's lock.
 */
export async function applyTurnUsage(
  executor: DatabaseExecutor,
  agent: { id: string; serverId: string; runtime: string | null },
  changes: readonly TurnTokensChange[],
  now: Date = new Date(),
): Promise<void> {
  const buckets = netUsageBuckets(changes);
  for (const bucket of buckets) {
    const set: Record<string, unknown> = { turns: sql`${agentUsageDaily.turns} + ${bucket.turns}`, runtime: agent.runtime, updatedAt: now };
    for (const field of ACTIVITY_TURN_TOKEN_COUNT_FIELDS) {
      const delta = bucket.counts[field];
      if (delta === null) continue;
      set[COLUMN[field]] = sql.raw(`coalesce("agent_usage_daily"."${SQL_COLUMN[field]}", 0) + ${Math.trunc(delta)}`);
    }
    await executor.insert(agentUsageDaily)
      .values({
        agentId: agent.id,
        day: bucket.day,
        model: bucket.model,
        serverId: agent.serverId,
        runtime: agent.runtime,
        inputNew: bucket.counts.input,
        cacheRead: bucket.counts.cacheRead,
        cacheWrite: bucket.counts.cacheWrite,
        output: bucket.counts.output,
        reasoningOutput: bucket.counts.reasoningOutput,
        turns: Math.max(0, bucket.turns),
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: [agentUsageDaily.agentId, agentUsageDaily.day, agentUsageDaily.model], set });
  }

  // The latest turn (by end time) that reported its context; an older turn
  // rebuilt later never moves it back.
  let latest: TurnTokensState | undefined;
  for (const { after } of changes) {
    const tokens = after.tokens;
    if (!tokens || (tokens.contextUsed === undefined && tokens.contextWindow === undefined)) continue;
    if (!latest || after.endedAt > latest.endedAt) latest = after;
  }
  if (latest?.tokens) {
    const at = new Date(latest.endedAt);
    await executor.insert(agentUsageContext)
      .values({
        agentId: agent.id,
        serverId: agent.serverId,
        contextUsed: latest.tokens.contextUsed ?? null,
        contextWindow: latest.tokens.contextWindow ?? null,
        at,
      })
      .onConflictDoUpdate({
        target: agentUsageContext.agentId,
        set: {
          serverId: agent.serverId,
          contextUsed: latest.tokens.contextUsed ?? null,
          contextWindow: latest.tokens.contextWindow ?? null,
          at,
        },
        setWhere: sql`${agentUsageContext.at} <= ${at.toISOString()}::timestamptz`,
      });
  }
}

/** Usage of `agentIds` (already narrowed to what the reader may inspect) over [from, to] UTC days. */
export async function readAgentUsage(input: {
  serverId: string;
  agentIds: readonly string[];
  from: string;
  to: string;
  now?: Date;
}): Promise<AgentUsageResponse> {
  const db = getDb();
  const now = input.now ?? new Date();
  const ids = [...new Set(input.agentIds)];
  const base: AgentUsageResponse = {
    from: input.from,
    to: input.to,
    as_of: now.toISOString(),
    since: null,
    visible_agents: ids.length,
    agents: [],
    rows: [],
    context: [],
  };
  const [serverSince] = await db.select({ since: sql<string | null>`min(${agentUsageDaily.day})::text` })
    .from(agentUsageDaily)
    .where(eq(agentUsageDaily.serverId, input.serverId));
  base.since = serverSince?.since ?? null;
  if (ids.length === 0) return base;

  const firstDays = await db.select({ agentId: agentUsageDaily.agentId, since: sql<string>`min(${agentUsageDaily.day})::text` })
    .from(agentUsageDaily)
    .where(and(eq(agentUsageDaily.serverId, input.serverId), inArray(agentUsageDaily.agentId, ids)))
    .groupBy(agentUsageDaily.agentId);
  const sinceByAgent = new Map(firstDays.map((row) => [row.agentId, row.since]));
  base.agents = ids.map((id) => {
    const since = sinceByAgent.get(id) ?? null;
    return { agent_id: id, since, usage_reported: since !== null };
  });

  const rows = await db.select({
    day: sql<string>`${agentUsageDaily.day}::text`,
    agentId: agentUsageDaily.agentId,
    runtime: agentUsageDaily.runtime,
    model: agentUsageDaily.model,
    inputNew: agentUsageDaily.inputNew,
    cacheRead: agentUsageDaily.cacheRead,
    cacheWrite: agentUsageDaily.cacheWrite,
    output: agentUsageDaily.output,
    reasoningOutput: agentUsageDaily.reasoningOutput,
    turns: agentUsageDaily.turns,
  })
    .from(agentUsageDaily)
    .where(and(
      eq(agentUsageDaily.serverId, input.serverId),
      inArray(agentUsageDaily.agentId, ids),
      gte(agentUsageDaily.day, input.from),
      lte(agentUsageDaily.day, input.to),
    ))
    .orderBy(agentUsageDaily.day, agentUsageDaily.agentId, agentUsageDaily.model);
  base.rows = rows.map((row) => ({
    day: row.day,
    agent_id: row.agentId,
    runtime: row.runtime,
    model: row.model,
    input_new: row.inputNew,
    cache_read: row.cacheRead,
    cache_write: row.cacheWrite,
    output: row.output,
    reasoning_output: row.reasoningOutput,
    turns: row.turns,
  }));

  const contexts = await db.select().from(agentUsageContext)
    .where(and(eq(agentUsageContext.serverId, input.serverId), inArray(agentUsageContext.agentId, ids)));
  base.context = contexts.map((row) => ({
    agent_id: row.agentId,
    context_used: row.contextUsed,
    context_window: row.contextWindow,
    at: row.at.toISOString(),
  }));
  return base;
}

/** Days of agent_usage_daily kept (the panel reads at most 30 and compares with the 30 before). */
export const AGENT_USAGE_RETENTION_DAYS = 90;
const AGENT_USAGE_PRUNE_BATCH = 1_000;
const AGENT_USAGE_PRUNE_BUDGET_MS = 10_000;

/**
 * The hourly maintenance (server.ts, `prune_agent_usage_daily`): delete
 * agent_usage_daily rows older than the retention window, in small batches
 * until none is left or the time budget runs out. A transaction advisory lock
 * per batch keeps it to one replica at a time (`yielded` when another holds it).
 */
export async function pruneAgentUsage(opts: { now?: Date; batchSize?: number; budgetMs?: number } = {}): Promise<{ deleted: number; yielded: boolean }> {
  const now = opts.now ?? new Date();
  const cutoff = utcDay(now.getTime() - AGENT_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const batchSize = opts.batchSize ?? AGENT_USAGE_PRUNE_BATCH;
  const budgetMs = opts.budgetMs ?? AGENT_USAGE_PRUNE_BUDGET_MS;
  const started = Date.now();
  let deleted = 0;
  for (;;) {
    const count = await getDb().transaction(async (tx) => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('agent_usage_daily.retention')) AS locked`,
      );
      if (!lock.rows[0]?.locked) return null;
      const result = await tx.execute<{ agent_id: string }>(sql`
        DELETE FROM ${agentUsageDaily}
        WHERE ctid = ANY(ARRAY(
          SELECT usage.ctid FROM ${agentUsageDaily} usage
          WHERE usage.day < ${cutoff}::date
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED))
        RETURNING agent_id`);
      return result.rows.length;
    });
    if (count === null) return { deleted, yielded: true };
    deleted += count;
    if (count < batchSize || Date.now() - started > budgetMs) return { deleted, yielded: false };
  }
}
