/**
 * The one badge number (design §6, contract §1.4):
 *
 *   badge = Σ over the user's servers whose level is not `none` of the
 *           server's Activity unread (Activity rows + object rows)
 *
 * the same numbers the in-app Activity shows (getActivityUnreadTotalsBatch,
 * objectActivityUnreadBatch). It reads RisingWave, so callers load it before
 * opening a Postgres transaction (the dispatcher does it before the channel
 * writer fence). An unreadable badge is `undefined`: the push goes out
 * without one and the device keeps its current badge.
 */
import { and, inArray, ne } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { serverMembers } from "../../db/schema";
import { getRedis, isRedisAvailable } from "../../redis";
import { getActivityUnreadTotalsBatch } from "../channelService";
import { objectActivityUnreadBatch } from "../objectActivity";

export const NOTIFICATION_BADGE_MAX = 9_999;
const BADGE_CONCURRENCY = 8;
const LAST_BADGE_KEY_PREFIX = "notif-badge:";
const LAST_BADGE_TTL_SECONDS = 3 * 24 * 60 * 60;

/** One user's badge: the total and each notifying server's term (servers at `none` are absent). */
export interface NotificationBadge {
  total: number;
  byServer: ReadonlyMap<string, number>;
}

/** The term of one server (`serverBadge`): 0 when it is at `none` or unknown. */
export function serverBadgeOf(badge: NotificationBadge | undefined, serverId: string): number | undefined {
  return badge === undefined ? undefined : badge.byServer.get(serverId) ?? 0;
}

/** Per-server Activity unread (rows + object rows) for these servers of one user. */
export type BadgeLoader = (userId: string, serverIds: readonly string[]) => Promise<ReadonlyMap<string, number>>;

const defaultBadgeLoader: BadgeLoader = async (userId, serverIds) => {
  const terms = new Map<string, number>();
  if (serverIds.length === 0) return terms;
  const inputs = serverIds.map((serverId) => ({ serverId }));
  const [totals, objects] = await Promise.all([
    getActivityUnreadTotalsBatch(inputs, userId),
    objectActivityUnreadBatch(inputs, userId).catch(() => new Map<string, number>()),
  ]);
  for (const serverId of serverIds) {
    const activity = totals.get(serverId)?.totalUnreadCount ?? 0;
    const object = objects.get(serverId) ?? 0;
    terms.set(serverId, (Number.isFinite(activity) && activity > 0 ? activity : 0) + (Number.isFinite(object) && object > 0 ? object : 0));
  }
  return terms;
};

let badgeLoader: BadgeLoader = defaultBadgeLoader;

export function __setNotificationBadgeLoaderForTests(loader: BadgeLoader | null): void {
  badgeLoader = loader ?? defaultBadgeLoader;
}

function clampBadge(value: number): number {
  return Math.min(NOTIFICATION_BADGE_MAX, Math.max(0, Number.isFinite(value) ? Math.floor(value) : 0));
}

/** Badge of each user (undefined = unreadable). One membership query for all of them. */
export async function loadNotificationBadges(
  userIds: readonly string[],
  executor: DatabaseExecutor = getDb(),
  /** Called as each user's badge is ready (the dispatcher attaches badges as they come). */
  onEach?: (userId: string, badge: NotificationBadge | undefined) => void,
): Promise<Map<string, NotificationBadge | undefined>> {
  const result = new Map<string, NotificationBadge | undefined>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return result;
  const memberships = await executor
    .select({ userId: serverMembers.userId, serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(and(inArray(serverMembers.userId, unique), ne(serverMembers.serverPushMode, "none")));
  const serversByUser = new Map<string, string[]>();
  for (const row of memberships) {
    const list = serversByUser.get(row.userId);
    if (list) list.push(row.serverId);
    else serversByUser.set(row.userId, [row.serverId]);
  }
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const userId = unique[next++]!;
      const serverIds = serversByUser.get(userId) ?? [];
      try {
        const terms = await badgeLoader(userId, serverIds);
        const byServer = new Map<string, number>();
        let total = 0;
        for (const serverId of serverIds) {
          const term = clampBadge(terms.get(serverId) ?? 0);
          byServer.set(serverId, term);
          total += term;
        }
        result.set(userId, { total: clampBadge(total), byServer });
      } catch (err) {
        console.warn(`[NotificationBadge] badge unavailable, sending without badge: ${err instanceof Error ? err.message : String(err)}`);
        result.set(userId, undefined);
      }
      onEach?.(userId, result.get(userId));
    }
  };
  await Promise.all(Array.from({ length: Math.min(BADGE_CONCURRENCY, unique.length) }, worker));
  return result;
}

/** The badge an alert carries: never 0 (the alert itself is unread activity). */
export function alertBadge(badge: number | undefined): number | undefined {
  return badge === undefined ? undefined : Math.max(1, badge);
}

// The last badge a user's phones were sent, so a `sync` goes out only when it changed.
const localLastBadge = new Map<string, number>();

export async function loadLastSentBadges(userIds: readonly string[]): Promise<Map<string, number>> {
  const unique = [...new Set(userIds)];
  const result = new Map<string, number>();
  if (unique.length === 0) return result;
  if (!isRedisAvailable()) {
    for (const userId of unique) {
      const value = localLastBadge.get(userId);
      if (value !== undefined) result.set(userId, value);
    }
    return result;
  }
  try {
    const values = await getRedis().mget(unique.map((userId) => `${LAST_BADGE_KEY_PREFIX}${userId}`));
    values.forEach((value, index) => {
      const parsed = value === null ? NaN : Number(value);
      if (Number.isFinite(parsed)) result.set(unique[index]!, parsed);
    });
  } catch {
    // Unknown: every sync goes out.
  }
  return result;
}

export async function rememberSentBadge(userId: string, badge: number | undefined): Promise<void> {
  if (badge === undefined) return;
  if (!isRedisAvailable()) {
    localLastBadge.set(userId, badge);
    return;
  }
  try {
    await getRedis().set(`${LAST_BADGE_KEY_PREFIX}${userId}`, String(badge), "EX", LAST_BADGE_TTL_SECONDS);
  } catch {
    // Best effort: the next sync is simply sent again.
  }
}

export function __resetNotificationBadgesForTests(): void {
  localLastBadge.clear();
  badgeLoader = defaultBadgeLoader;
}
