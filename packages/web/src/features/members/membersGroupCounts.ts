import { useEffect, useMemo } from "react";

// How many humans and agents the Members page listed the last time it loaded
// on a server, so while it loads again its tiles' skeleton draws both groups,
// each under its heading with that many tiles, and the loaded tiles land where
// their placeholders were (skeleton-vs-layout audit round 2: 8 tiles under one
// heading put the Agents group's first row 30px off). One entry per person and
// server: `slock:membersGroupCounts:{userId}:{serverId}` = {"humans":4,"agents":4}.
// Only counts are stored; anything else read back is ignored.

export type MembersGroupCounts = { humans: number; agents: number };

const STORAGE_PREFIX = "slock:membersGroupCounts";

/** More tiles than a group shows on one screen: the rest is below the fold. */
export const MEMBERS_GROUP_PLACEHOLDER_MAX = 24;

type GroupCountStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): GroupCountStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function membersGroupCountsStorageKey(userId: string, serverId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(serverId)}`;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000;
}

/** The remembered counts; null when never loaded here, or unreadable. */
export function readMembersGroupCounts(
  userId: string | null | undefined,
  serverId: string | null | undefined,
  storage: GroupCountStorage | undefined = defaultStorage(),
): MembersGroupCounts | null {
  if (!userId || !serverId || !storage) return null;
  try {
    const raw = storage.getItem(membersGroupCountsStorageKey(userId, serverId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { humans, agents } = parsed as Record<string, unknown>;
    return isCount(humans) && isCount(agents) ? { humans, agents } : null;
  } catch {
    return null;
  }
}

export function writeMembersGroupCounts(
  userId: string | null | undefined,
  serverId: string | null | undefined,
  counts: MembersGroupCounts | null,
  storage: GroupCountStorage | undefined = defaultStorage(),
): void {
  if (!userId || !serverId || !storage || !counts) return;
  const key = membersGroupCountsStorageKey(userId, serverId);
  const value = JSON.stringify({ humans: counts.humans, agents: counts.agents });
  try {
    if (storage.getItem(key) !== value) storage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private/embedded browser contexts.
  }
}

/** The tiles a loading group draws: as many as last time, up to a screenful. */
export function membersGroupPlaceholders(remembered: number): number {
  return Math.min(remembered, MEMBERS_GROUP_PLACEHOLDER_MAX);
}

/**
 * The page's remembered counts, for its skeleton while it loads (null when
 * never loaded here), and the counts it `loaded` (null while loading)
 * remembered for next time.
 */
export function useRememberedMembersGroupCounts({ userId, serverId, loaded }: {
  userId: string | null | undefined;
  serverId: string | null | undefined;
  loaded: MembersGroupCounts | null;
}): MembersGroupCounts | null {
  const remembered = useMemo(() => readMembersGroupCounts(userId, serverId), [userId, serverId]);
  const humans = loaded?.humans;
  const agents = loaded?.agents;
  useEffect(() => {
    if (humans === undefined || agents === undefined) return;
    writeMembersGroupCounts(userId, serverId, { humans, agents });
  }, [humans, agents, userId, serverId]);
  return remembered;
}
