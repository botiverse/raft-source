/**
 * Read retraction (design §5.3, contract §5): when a reader's read position
 * in a conversation moves forward on any device, the notifications of that
 * conversation are withdrawn everywhere else.
 *
 * - Every desktop, web and mobile socket of the reader gets
 *   `notification:retract {serverId, groupKey, conversationId, throughSeq}`.
 * - Phones get an APNs background push / FCM data `retract` only for the
 *   conversations that actually alerted on them in the last 3 days (Redis set
 *   `notif-shown:<uid>`, filled by the dispatcher). Ordinary reading of quiet
 *   conversations therefore sends no background push (APNs throttles them).
 * - Web Push gets no retract push: browsers require every push to show a
 *   notification. A same-conversation notification replaces the last one
 *   (tag = groupKey) instead.
 *
 * Reads of one user are coalesced for 2 s (marking a dozen channels read in a
 * row sends one retract per conversation and one push per phone).
 *
 * A phone alert held by the "Phone alerts" delay (mobileDeferral.ts) for a
 * conversation just read is cancelled at once, not coalesced: `skipped` /
 * `read` up to the read position.
 */
import type { Server as SocketServer } from "socket.io";
import {
  NOTIFICATION_RETRACT_EVENT,
  clearClockTimeout,
  desktopNotificationConversationGroupKey,
  setClockTimeout,
  type NotificationRetractPayload,
} from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { userChannelReadCursors } from "../../db/schema";
import { notificationRetractsTotal } from "../../metrics";
import { getRedis, isRedisAvailable } from "../../redis";
import { emitPlatformScopedUserEvent } from "../../socket/platformScope";
import { addTraceEvent } from "../../tracing/semanticTrace";
import { loadNotificationBadges, serverBadgeOf } from "./badge";
import { loadMobileRegistrations, sendMobileBackgroundPush } from "./dispatcher";
import { mayHaveHeldPhoneAlerts, skipReadMobileDeferrals } from "./mobileDeferral";

export const RETRACTION_COALESCE_MS = 2_000;
export const SHOWN_GROUPS_TTL_SECONDS = 3 * 24 * 60 * 60;
const SHOWN_KEY_PREFIX = "notif-shown:";

export interface ReadScope {
  conversationId: string;
  /** The read position; notifications with seq <= it close. */
  throughSeq: number | null;
}

// ---------------------------------------------------------------------------
// Shown groups
// ---------------------------------------------------------------------------

const localShown = new Map<string, Map<string, number>>();

function shownKey(userId: string): string {
  return `${SHOWN_KEY_PREFIX}${userId}`;
}

/** The dispatcher recorded a successful phone alert for these groups. */
export async function recordShownGroups(userId: string, groupKeys: readonly string[], now: number = Date.now()): Promise<void> {
  if (groupKeys.length === 0) return;
  if (!isRedisAvailable()) {
    let groups = localShown.get(userId);
    if (!groups) localShown.set(userId, groups = new Map());
    for (const key of groupKeys) groups.set(key, now + SHOWN_GROUPS_TTL_SECONDS * 1000);
    return;
  }
  try {
    await getRedis().multi().sadd(shownKey(userId), ...groupKeys).expire(shownKey(userId), SHOWN_GROUPS_TTL_SECONDS).exec();
  } catch (err) {
    console.warn("[NotificationRetraction] could not record shown groups:", err instanceof Error ? err.message : String(err));
  }
}

/** Which of these groups alerted on the user's phones; they are removed from the set. */
export async function takeShownGroups(userId: string, groupKeys: readonly string[], now: number = Date.now()): Promise<string[]> {
  if (groupKeys.length === 0) return [];
  if (!isRedisAvailable()) {
    const groups = localShown.get(userId);
    if (!groups) return [];
    const taken = groupKeys.filter((key) => (groups.get(key) ?? 0) > now);
    for (const key of groupKeys) groups.delete(key);
    return taken;
  }
  try {
    const redis = getRedis();
    const flags = await redis.smismember(shownKey(userId), ...groupKeys);
    const taken = groupKeys.filter((_, index) => flags[index] === 1);
    if (taken.length > 0) await redis.srem(shownKey(userId), ...taken);
    return taken;
  } catch (err) {
    console.warn("[NotificationRetraction] shown-group lookup failed; no phone retract:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

export interface RetractionRuntime {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Ends the reader's held phone alerts of these conversations (mobileDeferral.ts). */
  cancelReadDeferrals(userId: string, scopes: readonly ReadScope[]): Promise<number>;
}

const defaultRetractionRuntime: RetractionRuntime = {
  setTimer: (fn, ms) => setClockTimeout(fn, ms),
  clearTimer: (handle) => clearClockTimeout(handle as ReturnType<typeof setClockTimeout>),
  // A reader who never had an alert held (mobileDelay inactive / always, or
  // nothing held in the last 30 minutes) costs no query.
  cancelReadDeferrals: async (userId, scopes) => (await mayHaveHeldPhoneAlerts(userId))
    ? skipReadMobileDeferrals(getDb(), userId, scopes, Date.now())
    : 0,
};

let retractionRuntime: RetractionRuntime = defaultRetractionRuntime;

export function __setRetractionRuntimeForTests(overrides: Partial<RetractionRuntime> | null): void {
  retractionRuntime = overrides ? { ...defaultRetractionRuntime, ...overrides } : defaultRetractionRuntime;
}

type Pending = {
  io: SocketServer;
  timer: unknown;
  scopes: Map<string, NotificationRetractPayload>;
};

const pendingByUser = new Map<string, Pending>();
const flushesInFlight = new Set<Promise<void>>();

function mergeThroughSeq(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return Math.max(a, b);
}

/**
 * The reader's read position moved forward (routes/channels.ts
 * emitReadStateUpdated / emitReadStateUpdatedBulk, `state.changed`).
 */
export function onConversationsRead(io: SocketServer | undefined, userId: string, serverId: string, scopes: readonly ReadScope[]): void {
  if (scopes.length === 0) return;
  cancelHeldPhoneAlerts(userId, scopes);
  if (!io) return;
  let pending = pendingByUser.get(userId);
  if (!pending) {
    pending = { io, timer: null, scopes: new Map() };
    pendingByUser.set(userId, pending);
    const entry = pending;
    entry.timer = retractionRuntime.setTimer(() => {
      pendingByUser.delete(userId);
      const flush = flushRetraction(entry.io, userId, [...entry.scopes.values()]).catch((err) => {
        console.error("[NotificationRetraction] retract failed:", err);
      });
      flushesInFlight.add(flush);
      void flush.finally(() => flushesInFlight.delete(flush));
    }, RETRACTION_COALESCE_MS);
  }
  for (const scope of scopes) {
    const groupKey = desktopNotificationConversationGroupKey(serverId, scope.conversationId);
    const previous = pending.scopes.get(groupKey);
    pending.scopes.set(groupKey, {
      serverId,
      groupKey,
      conversationId: scope.conversationId,
      throughSeq: previous ? mergeThroughSeq(previous.throughSeq, scope.throughSeq) : scope.throughSeq,
    });
  }
}

function cancelHeldPhoneAlerts(userId: string, scopes: readonly ReadScope[]): void {
  const cancel = (async () => {
    const ended = await retractionRuntime.cancelReadDeferrals(userId, scopes);
    if (ended > 0) addTraceEvent("notification.mobile_deferral", { outcome: "read_cancelled", count: ended });
  })().catch((err) => {
    // The fire-time read check still skips it.
    console.warn("[NotificationRetraction] could not cancel held phone alerts:", err instanceof Error ? err.message : String(err));
  });
  flushesInFlight.add(cancel);
  void cancel.finally(() => flushesInFlight.delete(cancel));
}

/** Test-only: run every pending coalesced retraction now and wait for it. */
export async function flushPendingRetractionsForTests(): Promise<void> {
  for (const [userId, pending] of [...pendingByUser]) {
    retractionRuntime.clearTimer(pending.timer);
    pendingByUser.delete(userId);
    const flush = flushRetraction(pending.io, userId, [...pending.scopes.values()]).catch((err) => {
      console.error("[NotificationRetraction] retract failed:", err);
    });
    flushesInFlight.add(flush);
    void flush.finally(() => flushesInFlight.delete(flush));
  }
  while (flushesInFlight.size) await Promise.allSettled([...flushesInFlight]);
}

export function __resetRetractionForTests(): void {
  for (const pending of pendingByUser.values()) retractionRuntime.clearTimer(pending.timer);
  pendingByUser.clear();
  localShown.clear();
  retractionRuntime = defaultRetractionRuntime;
}

async function flushRetraction(io: SocketServer, userId: string, payloads: NotificationRetractPayload[]): Promise<void> {
  for (const payload of payloads) emitPlatformScopedUserEvent(io, userId, NOTIFICATION_RETRACT_EVENT, payload);
  notificationRetractsTotal.inc({ transport: "socket", outcome: "sent" }, payloads.length);
  const shown = new Set(await takeShownGroups(userId, payloads.map((payload) => payload.groupKey)));
  addTraceEvent("notification.retract", { transport: "socket", group_count: payloads.length, shown_count: shown.size });
  if (shown.size === 0) return;
  const db = getDb();
  const registrations = (await loadMobileRegistrations([userId], db)).get(userId) ?? [];
  if (registrations.length === 0) return;
  const userBadge = (await loadNotificationBadges([userId], db)).get(userId);
  for (const payload of payloads) {
    if (!shown.has(payload.groupKey)) continue;
    for (const registration of registrations) {
      const outcome = await sendMobileBackgroundPush(registration, {
        type: "retract",
        badge: userBadge?.total,
        serverBadge: serverBadgeOf(userBadge, payload.serverId),
        serverId: payload.serverId,
        groupKey: payload.groupKey,
        conversationId: payload.conversationId,
        throughSeq: payload.throughSeq,
      }, db);
      addTraceEvent("notification.retract", { transport: registration.provider, outcome: outcome.outcome });
      notificationRetractsTotal.inc({ transport: registration.provider, outcome: outcome.outcome });
    }
  }
}

/**
 * The read rule the retraction applies (a notification with seq <= the read
 * position closes), as a check: a held phone alert (mobileDeferral.ts) that
 * the retraction would have closed is not sent. One rule, so the two never
 * disagree.
 */
export async function isNotificationReadThrough(
  executor: DatabaseExecutor,
  userId: string,
  conversationId: string | null | undefined,
  seq: number | null | undefined,
): Promise<boolean> {
  if (!conversationId || typeof seq !== "number") return false;
  const [cursor] = await executor
    .select({ lastReadSeq: userChannelReadCursors.lastReadSeq })
    .from(userChannelReadCursors)
    .where(and(eq(userChannelReadCursors.userId, userId), eq(userChannelReadCursors.channelId, conversationId)));
  return (cursor?.lastReadSeq ?? 0) >= seq;
}

