import { useEffect, useMemo, useState } from "react";
import { TASK_STATUSES } from "@botiverse/raft-shared";
import type { TaskStatus } from "../../store/taskStore";

// How many cards each status lane of a Tasks board or list held the last time
// it loaded, so while it loads again each open lane draws that many card
// placeholders (or keeps its empty box, as when never loaded) and the cards land where their
// placeholders were (skeleton-vs-layout audit, #proj-raft-ui:#231). One entry
// per person, server and board (a channel's, or the server's):
// `slock:taskLaneCounts:{userId}:{serverId}:{scope}` = {"todo":2,...}. Only
// counts are stored; anything else read back is ignored.

export type TaskLaneCounts = Partial<Record<TaskStatus, number>>;

const STORAGE_PREFIX = "slock:taskLaneCounts";

/** More cards than a lane shows on one screen: the rest is below the fold. */
export const TASK_LANE_PLACEHOLDER_MAX = 4;
/**
 * A lane never loaded here keeps its empty box, as one that had none: a
 * placeholder card in every lane put the first card a lane off wherever a lane
 * turned out empty (skeleton-vs-layout audit round 2: +130px on a phone, +272px
 * sideways on a desktop); with empty boxes the lanes stay where they are and a
 * lane's cards land in it, growing it downwards.
 */
export const TASK_LANE_PLACEHOLDER_DEFAULT = 0;

type LaneCountStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): LaneCountStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function taskLaneCountsStorageKey(userId: string, serverId: string, scope: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(serverId)}:${encodeURIComponent(scope)}`;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000;
}

/** The remembered counts; empty when never loaded here, or unreadable. */
export function readTaskLaneCounts(
  userId: string | null | undefined,
  serverId: string | null | undefined,
  scope: string,
  storage: LaneCountStorage | undefined = defaultStorage(),
): TaskLaneCounts {
  if (!userId || !serverId || !storage) return {};
  try {
    const raw = storage.getItem(taskLaneCountsStorageKey(userId, serverId, scope));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const counts: TaskLaneCounts = {};
    for (const status of TASK_STATUSES) {
      const value = (parsed as Record<string, unknown>)[status];
      if (isCount(value)) counts[status] = value;
    }
    return counts;
  } catch {
    return {};
  }
}

export function writeTaskLaneCounts(
  userId: string | null | undefined,
  serverId: string | null | undefined,
  scope: string,
  counts: TaskLaneCounts | null,
  storage: LaneCountStorage | undefined = defaultStorage(),
): void {
  if (!userId || !serverId || !storage || !counts) return;
  const clean: TaskLaneCounts = {};
  for (const status of TASK_STATUSES) {
    const value = counts[status];
    if (isCount(value)) clean[status] = value;
  }
  const key = taskLaneCountsStorageKey(userId, serverId, scope);
  const value = JSON.stringify(clean);
  try {
    if (storage.getItem(key) !== value) storage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private/embedded browser contexts.
  }
}

/** The placeholders a loading lane draws: as many cards as last time, up to a screenful; none (the empty box) when never loaded. */
export function taskLanePlaceholders(remembered: number | undefined): number {
  return remembered === undefined ? TASK_LANE_PLACEHOLDER_DEFAULT : Math.min(remembered, TASK_LANE_PLACEHOLDER_MAX);
}

/**
 * A board's remembered counts, for its placeholders while it loads ({} when
 * not `enabled`, as for a filtered view, whose lanes hold less), and the
 * counts it `loaded` (null while loading) remembered for next time.
 */
export function useRememberedTaskLaneCounts({ userId, serverId, scope, enabled, loading, loaded }: {
  userId: string | null | undefined;
  serverId: string | null | undefined;
  scope: string;
  enabled: boolean;
  /** The board is loading for this key; counts are remembered only after a load seen for it. */
  loading: boolean;
  loaded: TaskLaneCounts | null;
}): TaskLaneCounts {
  const remembered = useMemo(
    () => (enabled ? readTaskLaneCounts(userId, serverId, scope) : {}),
    [enabled, userId, serverId, scope],
  );
  // Counts belong to a key only once a load for that key has been seen to finish:
  // right after a switch (another channel, another server, a cold mount) the board
  // still shows what it had, or nothing yet, and saving that would give the new key
  // the old shape, or wipe it (#14158 review).
  const key = [userId ?? "", serverId ?? "", scope].join("\u0000");
  const [loadingSeenFor, setLoadingSeenFor] = useState<string | null>(null);
  if (loading && loadingSeenFor !== key) setLoadingSeenFor(key);
  const toRemember = enabled && !loading && loadingSeenFor === key ? loaded : null;
  useEffect(() => {
    writeTaskLaneCounts(userId, serverId, scope, toRemember);
  }, [toRemember, userId, serverId, scope]);
  return remembered;
}
