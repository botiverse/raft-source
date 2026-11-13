import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import {
  AGENT_USAGE_FEATURE_FLAG_KEY,
  isAgentActivity,
  normalizeActivityDetailKind,
  readDaemonTurnSummary,
  type AgentActivity,
  type ActivityTurnSummary,
  type AgentActivityDetailKind,
  type ServerId,
  type TrajectoryEntry,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentActivityEvents, agentActivitySummaryV2, agents, messages } from "../db/schema";
import { appEnabled } from "../platform/flags";
import { applyTurnUsage, type TurnTokensState } from "./agentUsageService";
import { pageTurnSummaries } from "./activityTurnMerge";

export interface PersistedTrajectoryLogEntry {
  timestamp: number;
  entry: TrajectoryEntry;
}

export interface PersistedAgentActivityHint {
  activity: AgentActivity;
  detail: string;
  detailKind: AgentActivityDetailKind;
  updatedAt: number;
}

export function projectAgentActivityHintFromPersistedEvent(row: {
  activity: AgentActivity;
  detail: string;
  entries?: TrajectoryEntry[] | null;
  createdAt: Date;
}): PersistedAgentActivityHint {
  // A Tool finished row (tool_end) marks a step, never a state to resume in.
  const latestStatus = (row.entries || [])
    .filter((entry): entry is Extract<TrajectoryEntry, { kind: "status" }> => entry.kind === "status" && entry.detailKind !== "tool_end")
    .at(-1);

  return {
    activity: row.activity,
    detail: row.detail,
    detailKind: normalizeActivityDetailKind(latestStatus?.detailKind),
    updatedAt: new Date(row.createdAt).getTime(),
  };
}

const DEFAULT_ACTIVITY_LOG_LIMIT = 50;
const MAX_ENTRIES_PER_EVENT = 100;

export async function appendAgentActivityEvent(
  agentId: string,
  activity: string,
  detail: string,
  entries: TrajectoryEntry[],
  createdAt: Date,
  dedupeKey?: string,
): Promise<boolean> {
  if (entries.length === 0) return false;
  const persistedActivity: AgentActivity = isAgentActivity(activity) ? activity : "working";
  if (persistedActivity !== activity) {
    console.warn(`[ActivityLog ${agentId}] Invalid activity "${activity}" — coercing to "${persistedActivity}" for persistence`);
  }
  const persistedEntries = entries.length > MAX_ENTRIES_PER_EVENT
    ? entries.slice(0, MAX_ENTRIES_PER_EVENT)
    : entries;
  if (persistedEntries.length !== entries.length) {
    console.warn(`[ActivityLog ${agentId}] Truncating oversized event from ${entries.length} entries to ${persistedEntries.length}`);
  }
  const db = getDb();
  const inserted = await db.insert(agentActivityEvents).values({
    agentId,
    activity: persistedActivity,
    detail,
    entries: persistedEntries,
    dedupeKey,
    createdAt,
  }).onConflictDoNothing().returning({ id: agentActivityEvents.id });
  return inserted.length > 0;
}

/** The subset of `dedupeKeys` already recorded for this agent. */
export async function listExistingAgentActivityDedupeKeys(
  agentId: string,
  dedupeKeys: readonly string[],
): Promise<Set<string>> {
  if (dedupeKeys.length === 0) return new Set();
  const db = getDb();
  const rows = await db.select({ dedupeKey: agentActivityEvents.dedupeKey })
    .from(agentActivityEvents)
    .where(and(eq(agentActivityEvents.agentId, agentId), inArray(agentActivityEvents.dedupeKey, [...dedupeKeys])));
  return new Set(rows.flatMap((row) => (row.dedupeKey ? [row.dedupeKey] : [])));
}

export async function listRecentAgentTrajectory(
  agentId: string,
  limit = DEFAULT_ACTIVITY_LOG_LIMIT,
): Promise<PersistedTrajectoryLogEntry[]> {
  const db = getDb();
  const rows = await db.select({
    createdAt: agentActivityEvents.createdAt,
    entries: agentActivityEvents.entries,
  })
    .from(agentActivityEvents)
    .where(eq(agentActivityEvents.agentId, agentId))
    .orderBy(desc(agentActivityEvents.createdAt))
    .limit(limit);

  return rows
    .reverse()
    .flatMap((row) => {
      const timestamp = new Date(row.createdAt).getTime();
      return (row.entries || []).map((entry) => ({ timestamp, entry }));
    });
}

/**
 * getLatestAgentActivityHint for many agents in one query: one index probe per
 * agent on (agent_id, created_at) through a LATERAL top-1, never a scan of the
 * agents' whole history (the table is hundreds of millions of rows).
 */
export async function getLatestAgentActivityHints(
  agentIds: readonly string[],
): Promise<Map<string, PersistedAgentActivityHint | null>> {
  const hints = new Map<string, PersistedAgentActivityHint | null>();
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return hints;
  for (const id of ids) hints.set(id, null);
  const result = await getDb().execute(sql`
    SELECT input.agent_id::text AS "agentId", latest.activity, latest.detail, latest.entries, latest.created_at AS "createdAt"
    FROM unnest(${sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`}) AS input(agent_id)
    CROSS JOIN LATERAL (
      SELECT e.activity, e.detail, e.entries, e.created_at
      FROM ${agentActivityEvents} e
      WHERE e.agent_id = input.agent_id
      ORDER BY e.created_at DESC
      LIMIT 1
    ) latest
  `);
  for (const row of result.rows as Array<{ agentId: string; activity: string; detail: string | null; entries: unknown; createdAt: Date | string }>) {
    hints.set(row.agentId, projectAgentActivityHintFromPersistedEvent({
      activity: row.activity as never,
      detail: row.detail as never,
      entries: row.entries as never,
      createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    }));
  }
  return hints;
}

export async function getLatestAgentActivityHint(
  agentId: string,
): Promise<PersistedAgentActivityHint | null> {
  const db = getDb();
  const [row] = await db.select({
    activity: agentActivityEvents.activity,
    detail: agentActivityEvents.detail,
    entries: agentActivityEvents.entries,
    createdAt: agentActivityEvents.createdAt,
  })
    .from(agentActivityEvents)
    .where(eq(agentActivityEvents.agentId, agentId))
    .orderBy(desc(agentActivityEvents.createdAt))
    .limit(1);

  if (!row) return null;
  return projectAgentActivityHintFromPersistedEvent(row);
}

/**
 * Upsert per-turn summaries (task #17). `turnKey` names the turn for its
 * producer, so a rebuilt turn (late external events) replaces its row.
 *
 * Where agent_usage_v0 is on for the agent's server, the turns' `tokens` are
 * also added into the usage tables in the same transaction: the rows are
 * locked and read first, so only the change against what each row held is
 * added and a replayed or rebuilt turn never counts twice (agentUsageService).
 */
export async function upsertAgentTurnSummaries(
  agentId: string,
  turns: readonly { turnKey: string; summary: ActivityTurnSummary }[],
): Promise<void> {
  if (turns.length === 0) return;
  const db = getDb();
  const now = new Date();
  const usageAgent = turns.some(({ summary }) => summary.tokens) ? await usageAgentFor(agentId) : null;
  await db.transaction(async (tx) => {
    const before = new Map<string, TurnTokensState>();
    if (usageAgent) {
      const keys = turns.map(({ turnKey }) => turnKey);
      const existing = await tx.select({ turnKey: agentActivitySummaryV2.turnKey, endedAt: agentActivitySummaryV2.endedAt, summary: agentActivitySummaryV2.summary })
        .from(agentActivitySummaryV2)
        .where(and(eq(agentActivitySummaryV2.agentId, agentId), inArray(agentActivitySummaryV2.turnKey, keys)))
        .for("update");
      for (const row of existing) before.set(row.turnKey, { tokens: row.summary.tokens, endedAt: row.endedAt.getTime() });
    }
    await tx.insert(agentActivitySummaryV2)
      .values(turns.map(({ turnKey, summary }) => ({
        agentId,
        turnKey,
        startedAt: new Date(summary.startedAt),
        endedAt: new Date(summary.endedAt),
        outcome: summary.outcome,
        summary,
        updatedAt: now,
      })))
      .onConflictDoUpdate({
        target: [agentActivitySummaryV2.agentId, agentActivitySummaryV2.turnKey],
        set: {
          startedAt: sql`excluded.started_at`,
          endedAt: sql`excluded.ended_at`,
          outcome: sql`excluded.outcome`,
          summary: sql`excluded.summary`,
          updatedAt: now,
        },
      });
    if (usageAgent) {
      await applyTurnUsage(tx, usageAgent, turns.map(({ turnKey, summary }) => ({
        before: before.get(turnKey),
        after: { tokens: summary.tokens, endedAt: summary.endedAt },
      })), now);
    }
  });
}

/** The agent's server and runtime when usage is on for that server; null otherwise. */
async function usageAgentFor(agentId: string): Promise<{ id: string; serverId: string; runtime: string | null } | null> {
  const [agent] = await getDb().select({ serverId: agents.serverId, runtime: agents.runtime })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) return null;
  try {
    if (!await appEnabled(agent.serverId as ServerId, AGENT_USAGE_FEATURE_FLAG_KEY)) return null;
  } catch {
    return null;
  }
  return { id: agentId, serverId: agent.serverId, runtime: agent.runtime };
}

const DEFAULT_TURN_SUMMARY_LIMIT = 30;
const MAX_TURN_SUMMARY_LIMIT = 100;

/** A stored turn summary with its row id (a stable key for readers). */
export type StoredTurnSummary = ActivityTurnSummary & { id: string };

/** Page cursor: the last row's end time and id, so turns ending in the same ms are not skipped. */
export interface TurnSummaryCursor {
  endedAt: number;
  id: string;
}

/**
 * Newest turns first; `before` (the previous page's `next`) pages to older
 * ones. An empty wake and the work that followed it come back as one turn
 * (`pageTurnSummaries`); `next` is set only when older rows remain.
 */
export async function listAgentTurnSummaries(
  agentId: string,
  options: { limit?: number; before?: TurnSummaryCursor } = {},
): Promise<{ summaries: StoredTurnSummary[]; next?: TurnSummaryCursor }> {
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_TURN_SUMMARY_LIMIT, MAX_TURN_SUMMARY_LIMIT));
  const db = getDb();
  const before = options.before;
  const rows = await db.select({ id: agentActivitySummaryV2.id, endedAt: agentActivitySummaryV2.endedAt, summary: agentActivitySummaryV2.summary })
    .from(agentActivitySummaryV2)
    .where(and(
      eq(agentActivitySummaryV2.agentId, agentId),
      ...(before ? [or(
        lt(agentActivitySummaryV2.endedAt, new Date(before.endedAt)),
        and(eq(agentActivitySummaryV2.endedAt, new Date(before.endedAt)), lt(agentActivitySummaryV2.id, before.id)),
      )] : []),
    ))
    .orderBy(desc(agentActivitySummaryV2.endedAt), desc(agentActivitySummaryV2.id))
    .limit(limit + 2);
  // A row that does not read as a turn summary (readDaemonTurnSummary) is
  // skipped; the page still moves past it.
  const readable = rows.flatMap((row) => {
    const turn = storedTurn(row);
    return turn ? [{ row, turn }] : [];
  });
  const { summaries, consumed } = pageTurnSummaries(readable.map(({ turn }) => turn), limit);
  const last = consumed < readable.length
    ? readable[consumed - 1]?.row
    // Every readable row was used: more may follow only if the read was full.
    : rows.length > limit + 1 ? rows.at(-1) : undefined;
  return {
    summaries,
    ...(last ? { next: { endedAt: new Date(last.endedAt).getTime(), id: last.id } } : {}),
  };
}

/**
 * A stored row as a finished turn: only what a producer owns
 * (readDaemonTurnSummary), so a row stored before the server narrowed daemon
 * summaries on write reads as narrowly as a new one (no server-owned fields,
 * no `running` that would show a finished turn as in progress, no unknown
 * keys). Null when the row does not read as a turn summary.
 */
function storedTurn(row: { id: string; summary: unknown }): StoredTurnSummary | null {
  const summary = readDaemonTurnSummary(row.summary);
  return summary ? { ...summary, id: row.id } : null;
}

/** One stored turn of the agent by row id, or null. */
export async function getAgentTurnSummary(agentId: string, id: string): Promise<StoredTurnSummary | null> {
  const db = getDb();
  const [row] = await db.select({ id: agentActivitySummaryV2.id, summary: agentActivitySummaryV2.summary })
    .from(agentActivitySummaryV2)
    .where(and(eq(agentActivitySummaryV2.agentId, agentId), eq(agentActivitySummaryV2.id, id)))
    .limit(1);
  return row ? storedTurn(row) : null;
}

/** When the agent's latest stored turn ending before `beforeMs` ended (epoch ms), or null. */
export async function latestAgentTurnEndBefore(agentId: string, beforeMs: number): Promise<number | null> {
  const db = getDb();
  const [row] = await db.select({ endedAt: agentActivitySummaryV2.endedAt })
    .from(agentActivitySummaryV2)
    .where(and(eq(agentActivitySummaryV2.agentId, agentId), lt(agentActivitySummaryV2.endedAt, new Date(beforeMs))))
    .orderBy(desc(agentActivitySummaryV2.endedAt))
    .limit(1);
  return row ? new Date(row.endedAt).getTime() : null;
}

/** Activity rows recorded after `afterMs` (exclusive), oldest first, at most `limit` rows. */
export async function listAgentTrajectoryAfter(agentId: string, afterMs: number, limit: number): Promise<PersistedTrajectoryLogEntry[]> {
  const db = getDb();
  const rows = await db.select({ createdAt: agentActivityEvents.createdAt, entries: agentActivityEvents.entries })
    .from(agentActivityEvents)
    .where(and(eq(agentActivityEvents.agentId, agentId), gt(agentActivityEvents.createdAt, new Date(afterMs))))
    .orderBy(asc(agentActivityEvents.createdAt))
    .limit(limit);
  return rows.flatMap((row) => {
    const timestamp = new Date(row.createdAt).getTime();
    return (row.entries || []).map((entry) => ({ timestamp, entry }));
  });
}

/**
 * The agent's own messages in a time window, newest first, with where each
 * was posted (Activity overview, task #17). A full page means older ones
 * were cut: the caller lists only what it can list completely.
 */
export async function listAgentSentMessagesWithChannelsBetween(
  agentId: string,
  fromMs: number,
  toMs: number,
  limit = 1000,
): Promise<{ at: number; messageId: string; channelId: string }[]> {
  const db = getDb();
  const rows = await db.select({ id: messages.id, createdAt: messages.createdAt, channelId: messages.channelId })
    .from(messages)
    .where(and(
      eq(messages.senderId, agentId),
      eq(messages.senderType, "agent"),
      gte(messages.createdAt, new Date(fromMs)),
      lte(messages.createdAt, new Date(toMs)),
    ))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.map((row) => ({ at: new Date(row.createdAt).getTime(), messageId: row.id, channelId: row.channelId }));
}

/** Messages the agent sent in [fromMs, toMs], oldest first (for turn summaries rebuilt on the server). */
export async function listAgentSentMessagesBetween(
  agentId: string,
  fromMs: number,
  toMs: number,
  limit = 200,
): Promise<{ at: number; messageId: string }[]> {
  const db = getDb();
  const rows = await db.select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(and(
      eq(messages.senderId, agentId),
      eq(messages.senderType, "agent"),
      gte(messages.createdAt, new Date(fromMs)),
      lte(messages.createdAt, new Date(toMs)),
    ))
    .orderBy(asc(messages.createdAt))
    .limit(limit);
  return rows.map((row) => ({ at: new Date(row.createdAt).getTime(), messageId: row.id }));
}
