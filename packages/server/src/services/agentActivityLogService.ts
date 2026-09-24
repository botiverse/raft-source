import { desc, eq } from "drizzle-orm";
import {
  isAgentActivity,
  normalizeActivityDetailKind,
  type AgentActivity,
  type AgentActivityDetailKind,
  type TrajectoryEntry,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { agentActivityEvents } from "../db/schema.js";

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
  const latestStatus = (row.entries || [])
    .filter((entry): entry is Extract<TrajectoryEntry, { kind: "status" }> => entry.kind === "status")
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
