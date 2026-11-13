/**
 * The external-agent half of "unread is not owed" (unowedReadBacklog.ts).
 *
 * A hosted agent has no start whose input shows the unread counts; it sees
 * them when it lists its inbox (`inbox.list`). Each listing records what it
 * showed, per target, into the agent's current snapshot and returns that
 * snapshot's id; listings until the turn ends merge into the same snapshot,
 * keeping the seq a target had when it was first shown. The agent's end-of-turn
 * report (`POST /activity` `turnEnded`) names the snapshot; the first report for
 * it consumes it, and only `completed` settles the shown targets it holds.
 *
 * Agent API requests reach any replica, so the snapshot lives in Redis (one key
 * per agent, TTL); without Redis (single replica) it is kept in memory.
 */
import { randomUUID } from "node:crypto";
import { getRedis, isRedisAvailable } from "../redis";
import type { UnreadSummarySnapshotTargets } from "./turnEndUnreadSnapshot";
import { TURN_END_UNREAD_SNAPSHOT_TTL_MS } from "./turnEndUnreadSnapshot";

export interface ExternalTurnEndSnapshot {
  snapshotId: string;
  targets: UnreadSummarySnapshotTargets;
}

type Stored = { snapshotId: string; targets: Record<string, Array<{ channelId: string; latestSeq: number }>> };

const TTL_SECONDS = Math.round(TURN_END_UNREAD_SNAPSHOT_TTL_MS / 1000);
const key = (agentId: string) => `slock:agent:${agentId}:turn-end-unread`;
const memory = new Map<string, { stored: Stored; expiresAtMs: number }>();

/** Delete and return the snapshot only when its id matches (compare-and-delete). */
const TAKE_IF_MATCHES = `
local raw = redis.call("GET", KEYS[1])
if not raw then return false end
local ok, decoded = pcall(cjson.decode, raw)
if not ok or decoded.snapshotId ~= ARGV[1] then return "mismatch" end
redis.call("DEL", KEYS[1])
return raw`;

function toStored(targets: UnreadSummarySnapshotTargets, snapshotId: string): Stored {
  return { snapshotId, targets: Object.fromEntries([...targets].map(([target, list]) => [target, [...list]])) };
}

function merge(previous: Stored | null, shown: UnreadSummarySnapshotTargets): Stored {
  const next: Stored = previous ? { snapshotId: previous.snapshotId, targets: { ...previous.targets } } : toStored(new Map(), randomUUID());
  for (const [target, list] of shown) {
    // A target keeps the seq of its first listing in the turn: later rows were not shown then.
    if (!Object.hasOwn(next.targets, target)) next.targets[target] = [...list];
  }
  return next;
}

function parse(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Stored;
    return typeof value?.snapshotId === "string" && value.targets && typeof value.targets === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Record the targets an inbox listing showed (with their latest seq) and return
 * the snapshot id the agent reports at the end of its turn. Read-modify-write:
 * a racing listing may drop the other's additions, which only settles less. A
 * listing that read the snapshot just before a report's take deleted it writes
 * it back under the same id, so a second report could settle it again. That is
 * harmless: settling is raise-only and capped at the same recorded seqs.
 */
export async function recordExternalTurnEndSnapshot(agentId: string, shown: UnreadSummarySnapshotTargets, nowMs = Date.now()): Promise<string> {
  if (!isRedisAvailable()) {
    const current = memory.get(agentId);
    const merged = merge(current && current.expiresAtMs > nowMs ? current.stored : null, shown);
    memory.set(agentId, { stored: merged, expiresAtMs: nowMs + TURN_END_UNREAD_SNAPSHOT_TTL_MS });
    return merged.snapshotId;
  }
  const redis = getRedis();
  const merged = merge(parse(await redis.get(key(agentId))), shown);
  await redis.set(key(agentId), JSON.stringify(merged), "EX", TTL_SECONDS);
  return merged.snapshotId;
}

/** The agent's snapshot when `snapshotId` is current (consumed), `mismatch` for another one, null when there is none. */
export async function takeExternalTurnEndSnapshot(agentId: string, snapshotId: string, nowMs = Date.now()): Promise<ExternalTurnEndSnapshot | "mismatch" | null> {
  let stored: Stored | null;
  if (!isRedisAvailable()) {
    const current = memory.get(agentId);
    if (!current || current.expiresAtMs <= nowMs) return null;
    if (current.stored.snapshotId !== snapshotId) return "mismatch";
    memory.delete(agentId);
    stored = current.stored;
  } else {
    const result = await getRedis().eval(TAKE_IF_MATCHES, 1, key(agentId), snapshotId);
    if (result === "mismatch") return "mismatch";
    stored = parse(typeof result === "string" ? result : null);
    if (!stored) return null;
  }
  return { snapshotId: stored.snapshotId, targets: new Map(Object.entries(stored.targets)) };
}

/** Test seam: forget in-memory snapshots. */
export function __resetExternalTurnEndSnapshotsForTests(): void {
  memory.clear();
}
