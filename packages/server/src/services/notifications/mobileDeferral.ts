/**
 * Phone alerts held back while the person is on a computer (account setting
 * mobileDelay `1m`-`10m`, contract §1.3; #proj-raft-ui:#186).
 *
 * The outbox row is delivered at once to every other device and the phones get
 * the badge sync; only the phone alert waits, as one row here (durable, so a
 * deploy or restart keeps it; claimed with FOR UPDATE SKIP LOCKED, so two
 * replicas never alert twice). At `due_at` the dispatcher re-checks it
 * (dispatcher.ts fireMobileDeferral): read, mute, level, pause, a computer
 * active again (moved to the new last input + delay, never past
 * `deadline_at`), then alerts the phones or gives up. Reading the
 * conversation cancels it at once (skipReadMobileDeferrals, from the read
 * retraction); the fire-time read check stays for a read that raced it.
 * Terminal rows are swept after 7 days.
 */
import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/index";
import { getRedis, isRedisAvailable } from "../../redis";
import { notificationMobileDeferrals, notificationOutbox } from "../../db/schema";
import type { NotificationOutboxRow } from "./types";

/** A held alert gives up this long after the message, plus its delay. */
export const MOBILE_DEFERRAL_GRACE_MS = 20 * 60 * 1000;
/** And never later than this after the message. */
export const MOBILE_DEFERRAL_MAX_MS = 30 * 60 * 1000;
/** Terminal rows are kept this long (the outbox keeps 14 days). */
export const MOBILE_DEFERRAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** A claim older than this is taken again (a replica died mid-send). */
export const MOBILE_DEFERRAL_STALE_LOCK_MS = 2 * 60 * 1000;
export const MOBILE_DEFERRAL_BATCH_SIZE = 100;
export const MOBILE_DEFERRAL_MAX_ATTEMPTS = 3;

export type MobileDeferralRow = typeof notificationMobileDeferrals.$inferSelect;

/** The give-up time: message time + delay + 20 minutes, at most message time + 30 minutes. */
export function mobileDeferralDeadline(activityAt: number, delayMs: number): number {
  return activityAt + Math.min(delayMs + MOBILE_DEFERRAL_GRACE_MS, MOBILE_DEFERRAL_MAX_MS);
}

/** Records the held phone alerts of one dispatch (an outbox row is held at most once). */
export async function recordMobileDeferrals(
  executor: DatabaseExecutor,
  deferrals: ReadonlyArray<{ row: NotificationOutboxRow; deferUntil: number; delayMs: number }>,
): Promise<void> {
  if (deferrals.length === 0) return;
  await executor
    .insert(notificationMobileDeferrals)
    .values(deferrals.map(({ row, deferUntil, delayMs }) => {
      const deadline = mobileDeferralDeadline(row.activityAt.getTime(), delayMs);
      return {
        outboxId: row.id,
        receiverId: row.receiverId,
        dueAt: new Date(Math.min(deferUntil, deadline)),
        deadlineAt: new Date(deadline),
      };
    }))
    .onConflictDoNothing({ target: notificationMobileDeferrals.outboxId });
}

function claimablePredicate(now: Date, staleBefore: Date) {
  return and(
    lte(notificationMobileDeferrals.dueAt, now),
    or(
      eq(notificationMobileDeferrals.status, "pending"),
      and(eq(notificationMobileDeferrals.status, "processing"), lt(notificationMobileDeferrals.lockedAt, staleBefore)),
    ),
  );
}

/**
 * Claims the held alerts that are due (and stale claims), oldest due first,
 * as the outbox claims its rows: one UPDATE over a SKIP LOCKED candidate read
 * (partial index idx_notification_mobile_deferrals_due).
 */
export async function claimDueMobileDeferrals(
  executor: DatabaseExecutor,
  now: number,
  batchSize = MOBILE_DEFERRAL_BATCH_SIZE,
): Promise<MobileDeferralRow[]> {
  const nowDate = new Date(now);
  const staleBefore = new Date(now - MOBILE_DEFERRAL_STALE_LOCK_MS);
  const candidates = executor
    .select({ id: notificationMobileDeferrals.id })
    .from(notificationMobileDeferrals)
    .where(claimablePredicate(nowDate, staleBefore))
    .orderBy(notificationMobileDeferrals.dueAt)
    .limit(batchSize)
    .for("update", { skipLocked: true });
  return executor
    .update(notificationMobileDeferrals)
    .set({
      status: "processing",
      lockedAt: nowDate,
      attemptCount: sql`${notificationMobileDeferrals.attemptCount} + 1`,
      updatedAt: nowDate,
    })
    .where(and(inArray(notificationMobileDeferrals.id, candidates), claimablePredicate(nowDate, staleBefore)))
    .returning();
}

/** Ends a held alert: sent, failed, or skipped with the reason. */
export async function finishMobileDeferral(
  executor: DatabaseExecutor,
  id: string,
  status: "sent" | "skipped" | "failed",
  outcome: string,
  now: number,
): Promise<void> {
  const at = new Date(now);
  await executor
    .update(notificationMobileDeferrals)
    .set({ status, outcome, lockedAt: null, processedAt: at, updatedAt: at })
    .where(eq(notificationMobileDeferrals.id, id));
}

/** Ends the held alert of one outbox row if it is still pending (the phone alerted at once instead). */
export async function finishMobileDeferralOfOutbox(
  executor: DatabaseExecutor,
  outboxId: string,
  status: "sent" | "skipped",
  outcome: string,
  now: number,
): Promise<void> {
  const at = new Date(now);
  await executor
    .update(notificationMobileDeferrals)
    .set({ status, outcome, lockedAt: null, processedAt: at, updatedAt: at })
    .where(and(eq(notificationMobileDeferrals.outboxId, outboxId), eq(notificationMobileDeferrals.status, "pending")));
}

/** A computer was active again: wait until `dueAt` (already capped at the deadline). */
export async function extendMobileDeferral(executor: DatabaseExecutor, id: string, dueAt: number, now: number): Promise<void> {
  await executor
    .update(notificationMobileDeferrals)
    .set({
      status: "pending",
      dueAt: new Date(dueAt),
      lockedAt: null,
      extensions: sql`${notificationMobileDeferrals.extensions} + 1`,
      updatedAt: new Date(now),
    })
    .where(eq(notificationMobileDeferrals.id, id));
}

/** Deletes terminal rows past retention (called from the outbox sweep). */
export async function sweepMobileDeferrals(executor: DatabaseExecutor, now: number): Promise<number> {
  const deleted = await executor
    .delete(notificationMobileDeferrals)
    .where(lt(notificationMobileDeferrals.processedAt, new Date(now - MOBILE_DEFERRAL_RETENTION_MS)))
    .returning({ id: notificationMobileDeferrals.id });
  return deleted.length;
}

/**
 * The person read these conversations (read retraction, retraction.ts): their
 * pending held alerts there, up to the read position (null: all of them), end
 * as `skipped` / `read` now instead of at their due time. A claimed
 * (`processing`) one is left to its own fire-time read check. Returns how
 * many ended.
 */
export async function skipReadMobileDeferrals(
  executor: DatabaseExecutor,
  userId: string,
  scopes: ReadonlyArray<{ conversationId: string; throughSeq: number | null }>,
  now: number,
): Promise<number> {
  if (scopes.length === 0) return 0;
  const through = new Map<string, number | null>();
  for (const { conversationId, throughSeq } of scopes) {
    const previous = through.get(conversationId);
    through.set(conversationId, previous === null || throughSeq === null ? null : Math.max(previous ?? throughSeq, throughSeq));
  }
  // The receiver's pending rows are few (receiver index); the outbox row gives conversation and seq.
  const pending = await executor
    .select({ id: notificationMobileDeferrals.id, conversationId: notificationOutbox.sourceChannelId, seq: notificationOutbox.messageSeq })
    .from(notificationMobileDeferrals)
    .innerJoin(notificationOutbox, eq(notificationOutbox.id, notificationMobileDeferrals.outboxId))
    .where(and(
      eq(notificationMobileDeferrals.receiverId, userId),
      eq(notificationMobileDeferrals.status, "pending"),
      inArray(notificationOutbox.sourceChannelId, [...through.keys()]),
    ));
  const ids = pending.filter(({ conversationId, seq }) => {
    if (!conversationId || !through.has(conversationId)) return false;
    const readThrough = through.get(conversationId)!;
    return readThrough === null || (typeof seq === "number" && seq <= readThrough);
  }).map(({ id }) => id);
  if (ids.length === 0) return 0;
  const at = new Date(now);
  const ended = await executor
    .update(notificationMobileDeferrals)
    .set({ status: "skipped", outcome: "read", lockedAt: null, processedAt: at, updatedAt: at })
    .where(and(inArray(notificationMobileDeferrals.id, ids), eq(notificationMobileDeferrals.status, "pending")))
    .returning({ id: notificationMobileDeferrals.id });
  return ended.length;
}

// ---------------------------------------------------------------------------
// "Has held phone alerts" marker: lets a read skip the database entirely
// ---------------------------------------------------------------------------

const HELD_KEY_PREFIX = "notif-held:";
/** Outlives every held alert: a deadline is at most MOBILE_DEFERRAL_MAX_MS after the message. */
export const HELD_MARKER_TTL_MS = MOBILE_DEFERRAL_MAX_MS + 60 * 1000;
const localHeld = new Map<string, number>();

/**
 * The dispatcher held phone alerts for these users (set before the rows are
 * written, so a read that races the insert still finds the marker). Readers
 * with mobileDelay `inactive` / `always` never get one, so their reads cost
 * no query.
 */
export async function markHeldPhoneAlerts(userIds: readonly string[], now: number = Date.now()): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  if (!isRedisAvailable()) {
    // Single-replica fallback (dev, tests; production always has Redis):
    // expired markers are pruned here so the map stays bounded.
    for (const [userId, expiresAt] of localHeld) if (expiresAt <= now) localHeld.delete(userId);
    for (const userId of unique) localHeld.set(userId, now + HELD_MARKER_TTL_MS);
    return;
  }
  const batch = getRedis().multi();
  for (const userId of unique) batch.set(`${HELD_KEY_PREFIX}${userId}`, "1", "PX", HELD_MARKER_TTL_MS);
  await batch.exec();
}

/** Whether the user may have pending held alerts; true when unsure (the query then decides). */
export async function mayHaveHeldPhoneAlerts(userId: string, now: number = Date.now()): Promise<boolean> {
  if (!isRedisAvailable()) return (localHeld.get(userId) ?? 0) > now;
  try {
    return (await getRedis().exists(`${HELD_KEY_PREFIX}${userId}`)) === 1;
  } catch {
    return true;
  }
}

export function __resetHeldPhoneAlertMarkersForTests(): void {
  localHeld.clear();
}
