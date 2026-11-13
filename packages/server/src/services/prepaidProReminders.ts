// Prepaid Pro reminder emails (task #19; docs/billing/prepaid-pro.md).
// Prepaid time does not renew, so the hourly maintenance tells each Server's
// owners (every member whose role is owner now, not the creator in
// `servers.owner_id`) 7 days and 1 day before it
// ends, and when it ends (only during the grace days). Each owner gets their
// own email, in their language; one row still stands for the reminder. A reminder belongs to the last purchase of the paid chain: a
// renewal makes a newer last purchase, so the old end is never announced
// again. A window the job missed is not caught up: only the current one goes,
// and an unsent claim is retried only while its tier is still the current one.
//
// Delivery, at least once and in practice exactly once: claim the row
// (unique per purchase and kind), send to each owner with the provider
// idempotency key `prepaid-pro-reminder:{purchase}:{kind}:{user}`, then record
// `sent_at`. A failed
// send leaves the claim; a claim still unsent after 15 minutes (a failure, or
// a process that died mid-send) is claimed again and resent, and the
// provider drops the duplicate if the first send had gone out.
//
// `pro_prepaid` is read for the Server right before each send, so turning
// the flag off (audited, in FFA) also stops reminders.
import { and, desc, eq, gt, isNull, lt, lte } from "drizzle-orm";
import { PRO_PREPAID_FEATURE_FLAG_KEY, PRO_PREPAID_GRACE_DAYS } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { prepaidProPurchases, prepaidProReminders, serverMembers, servers, users } from "../db/schema";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { addTraceEvent } from "../tracing/semanticTrace";
import { sendPrepaidProReminderEmail, type PrepaidProReminderKind } from "./emailService";
import { evaluateFeatureFlag } from "./featureFlagService";
import { getServerBillingEntitlement } from "./planService";
import { getActivePrepaidGrants } from "./prepaidProService";

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = PRO_PREPAID_GRACE_DAYS * DAY_MS;
const FIRST_REMINDER_MS = 7 * DAY_MS;
/** An unsent claim older than this is taken to have failed, and is sent again. */
export const PREPAID_REMINDER_RETRY_AFTER_MS = 15 * 60 * 1000;
/** A missed window is never caught up, so a lasting failure loses reminders: say so early. */
const ALERT_AFTER_FAILED_RUNS = 3;
let consecutiveFailedRuns = 0;

export function __resetPrepaidReminderFailuresForTests(): void {
  consecutiveFailedRuns = 0;
}

/** Which reminder is due for paid time ending at `endsAt` (still granted at `now`), if any. */
export function prepaidReminderKind(endsAt: Date, now: Date): PrepaidProReminderKind | null {
  const left = endsAt.getTime() - now.getTime();
  if (left <= 0) return "ended";
  if (left <= DAY_MS) return "ends_in_1_day";
  if (left <= FIRST_REMINDER_MS) return "ends_in_7_days";
  return null;
}

export interface PrepaidReminderRunResult {
  sent: number;
  failed: number;
  /** Runs in a row with a failure (0 after a clean one). */
  consecutiveFailedRuns: number;
}

/**
 * Claim this reminder: a new row, or a stale unsent one. Null when it is sent
 * or another run holds it. The clock is read here, not at the run's start: a
 * long run on one replica must not make its own fresh claims look stale to
 * another replica's.
 */
async function claimReminder(purchaseId: string, kind: PrepaidProReminderKind, recipientUserId: string, clock: () => Date): Promise<string | null> {
  const db = getDb();
  const now = clock();
  const [created] = await db.insert(prepaidProReminders)
    .values({ purchaseId, kind, recipientUserId, claimedAt: now })
    .onConflictDoNothing().returning({ id: prepaidProReminders.id });
  if (created) return created.id;
  const [reclaimed] = await db.update(prepaidProReminders).set({ claimedAt: now, recipientUserId }).where(and(
    eq(prepaidProReminders.purchaseId, purchaseId),
    eq(prepaidProReminders.kind, kind),
    isNull(prepaidProReminders.sentAt),
    lt(prepaidProReminders.claimedAt, new Date(now.getTime() - PREPAID_REMINDER_RETRY_AFTER_MS)),
  )).returning({ id: prepaidProReminders.id });
  return reclaimed?.id ?? null;
}

/** `send` is injectable for tests; it returns the provider's email id. */
export async function sendPrepaidProReminders(
  clock: () => Date = () => new Date(),
  send: typeof sendPrepaidProReminderEmail = sendPrepaidProReminderEmail,
): Promise<PrepaidReminderRunResult> {
  const db = getDb();
  const now = clock();
  // Paid periods ending between the grace days' start and a week ahead (refunded and conflict rows never count).
  const candidates = (await db.selectDistinct({ serverId: prepaidProPurchases.serverId })
    .from(prepaidProPurchases).innerJoin(servers, eq(servers.id, prepaidProPurchases.serverId)).where(and(
      isNull(servers.deletedAt),
      eq(servers.kind, "normal"),
      eq(prepaidProPurchases.kind, "period"),
      eq(prepaidProPurchases.status, "paid"),
      gt(prepaidProPurchases.endsAt, new Date(now.getTime() - GRACE_MS)),
      lte(prepaidProPurchases.endsAt, new Date(now.getTime() + FIRST_REMINDER_MS)),
    ))).flatMap(row => row.serverId ? [row.serverId] : []);
  if (candidates.length === 0) return { sent: 0, failed: 0, consecutiveFailedRuns: noteRun(false) };
  const grants = await getActivePrepaidGrants(db, candidates, now);
  let sent = 0;
  let failed = 0;
  for (const serverId of candidates) {
    const grant = grants.get(serverId);
    if (!grant) continue;
    const endsAt = new Date(grant.endsAt);
    const kind = prepaidReminderKind(endsAt, now);
    if (!kind) continue; // renewed past the window
    try {
      // Only a Server whose Pro comes from prepaid time (not a founder or partner plan).
      if ((await getServerBillingEntitlement(db, serverId, now)).source !== "prepaid") continue;
      // The chain's last paid period. Not an exact `ends_at` match: the grant's
      // end is in milliseconds, a stored one may carry microseconds.
      const [last] = await db.select({ id: prepaidProPurchases.id }).from(prepaidProPurchases).where(and(
        eq(prepaidProPurchases.serverId, serverId),
        eq(prepaidProPurchases.kind, "period"),
        eq(prepaidProPurchases.status, "paid"),
        lte(prepaidProPurchases.endsAt, new Date(endsAt.getTime() + 1)),
      )).orderBy(desc(prepaidProPurchases.endsAt), desc(prepaidProPurchases.startsAt)).limit(1);
      const [server] = await db.select({ name: servers.name, slug: servers.slug })
        .from(servers).where(eq(servers.id, serverId));
      if (!last || !server) continue;
      // The owners now (an owner can be added or leave after paying), with a usable
      // address (a deleted account's is `deleted+<id>@invalid`). None: write nothing,
      // so a later run can still send it.
      const owners = (await db.select({ id: users.id, email: users.email, name: users.name, displayName: users.displayName, displayLanguage: users.displayLanguage })
        .from(serverMembers).innerJoin(users, eq(users.id, serverMembers.userId))
        .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.role, "owner"))))
        .filter(owner => owner.email.includes("@") && !owner.email.endsWith("@invalid"))
        .sort((a, b) => a.id.localeCompare(b.id));
      if (owners.length === 0) continue;
      if (!(await evaluateFeatureFlag({ key: PRO_PREPAID_FEATURE_FLAG_KEY, serverId, userId: owners[0].id })).enabled) continue;
      const claimId = await claimReminder(last.id, kind, owners[0].id, clock);
      if (!claimId) continue;
      // One email per owner: their name and language, their own address only.
      // A failure leaves the claim; the retry resends to all, and the provider
      // drops what already went (same key per owner).
      let emailId: string | null = null;
      for (const owner of owners) {
        const id = await send(owner.email, owner.displayName ?? owner.name, {
          kind,
          server: { name: server.name, slug: server.slug },
          endsAt,
          graceEndsAt: new Date(grant.graceEndsAt),
          locale: owner.displayLanguage,
        }, `prepaid-pro-reminder:${last.id}:${kind}:${owner.id}`);
        emailId ??= id;
      }
      await db.update(prepaidProReminders).set({ sentAt: clock(), emailId }).where(eq(prepaidProReminders.id, claimId));
      sent += 1;
      addTraceEvent("billing.prepaid.reminder_sent", { server_id: serverId, kind });
    } catch (err) {
      // One Server's failure must not stop the rest; its claim stays and is retried.
      failed += 1;
      console.error(`[Billing] Prepaid reminder failed for server ${serverId}:`, serializeErrorForLog(err));
      addTraceEvent("billing.prepaid.reminder_failed", { server_id: serverId, kind });
    }
  }
  return { sent, failed, consecutiveFailedRuns: noteRun(failed > 0) };
}

function noteRun(failed: boolean): number {
  consecutiveFailedRuns = failed ? consecutiveFailedRuns + 1 : 0;
  if (failed && consecutiveFailedRuns >= ALERT_AFTER_FAILED_RUNS) {
    console.error(`[Billing] ALERT: prepaid reminder emails failed in ${consecutiveFailedRuns} runs in a row; owners miss reminders that are not caught up later`);
    addTraceEvent("billing.prepaid.reminders_failing", { consecutive_failed_runs: consecutiveFailedRuns });
  }
  return consecutiveFailedRuns;
}
