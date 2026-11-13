/**
 * Email recovery of two-step verification (rollout PR 6): a person who lost
 * every second factor (authenticator app, passkeys, backup codes) gets back
 * in by email, after a 72-hour wait every signed-in device is told about.
 * Only for a person with two-step verification on (the `auth_second_factor_v1`
 * flag is retired, #raft-architecture:#32); nobody else is touched (no row, no email, no extra answer).
 *
 *   1. Start (POST /api/auth/second-factor/recovery { email }, unauthenticated):
 *      always the same 200, the work done after the answer (no account
 *      enumeration, no timing difference). Only such a person gets an email
 *      with a link (`link_token_hash`, 30 minutes, single use); at most
 *      RECOVERY_REQUESTS_PER_HOUR requests per person per hour (rows counted,
 *      as password reset does) and the route's per-address limiter.
 *   2. Confirm (POST /recovery/confirm { token }): the link starts the wait
 *      (`waiting`, eligible_at = now + 72 hours) and mails the "someone asked"
 *      email with a cancel link (`cancel_token_hash`). Not email alone (the
 *      mailbox may be the attacker's): every session reads it from GET
 *      /status and GET /recovery (getRecoveryView) to show a banner with
 *      Cancel, and one mobile push goes (system_notice).
 *   3. During the wait sign-in still asks for the second factor. Any right
 *      second-factor answer by the person cancels the request
 *      (autoCancelRecoveryInTransaction, called in the transaction of each
 *      place a second-factor answer succeeds: the second step of a sign-in,
 *      withSecondFactorAnswer for step-up and factor management, and passkey
 *      sign-in), then mails it.
 *   4. Cancel: DELETE /recovery from any signed-in session of the person, or
 *      the emailed cancel link (POST /recovery/cancel { token }) while the
 *      request waits.
 *   5. Finish: after eligible_at and within RECOVERY_FINISH_WINDOW_MS, a
 *      first-factor sign-in (password or social) offers `recovery` in its
 *      challenge's methods; POST /verify { challenge, recovery: true }
 *      (signIn.ts completeSecondFactorRecoverySignIn) runs
 *      completeRecoveryInTransaction in the sign-in's transaction: the
 *      request `waiting` -> `completed` by compare-and-set (two finishes at
 *      once: one wins), every factor removed, two-step verification off,
 *      every family revoked `revoke_all`, then the new session. After commit
 *      (runRecoveryCompletedEffects) the same security-revoke cascade a
 *      password reset runs, and the "reset" email.
 *      A person with neither a password nor a connected sign-in method has no
 *      first factor: there is no email-only finish; they set a password with
 *      forgot-password first (`firstFactorRequired: "set_password"`).
 *   6. Expiry: a link not used in 30 minutes, a request not finished within
 *      7 days of eligible_at, are `expired` lazily (at start, read and finish)
 *      and by the hourly sweep (sweepRecoveryRequests), which also mails the
 *      "you can finish now" email once per request.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../../db/index";
import {
  secondFactorRecoveryRequests,
  userAuthIdentities,
  userBackupCodes,
  users,
  userTotp,
  webauthnCredentials,
  type SecondFactorRecoveryCancelledBy,
} from "../../db/schema";
import { serializeErrorForLog } from "../../tracing/safeErrorLog";
import { normalizeEmail } from "../emailNormalization";
import { sendSecondFactorRecoveryEmail, type SecondFactorRecoveryEmailEvent } from "../emailService";
import { recordIntegrationAuditEvent, type IntegrationAuditEventType } from "../integrationAuditService";
import type { NotificationNoticePayload } from "../notifications/envelope";
import { enqueueNotificationRows } from "../notifications/enqueue";
import { listServerLevels } from "../notifications/settings";
import { revokeAllUserSessionsInTransaction } from "../sessionService";

export const RECOVERY_LINK_TTL_MS = 30 * 60_000;
export const RECOVERY_DELAY_MS = 72 * 60 * 60_000;
export const RECOVERY_FINISH_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Requests (each one an email) a person gets per hour. */
export const RECOVERY_REQUESTS_PER_HOUR = 3;

const ACTIVE = ["pending_confirmation", "waiting"] as const;

/** What a person with no first factor must do before they can finish. */
export type RecoveryFirstFactorRequired = "set_password" | null;

/**
 * The person's active (confirmed) request as every session reads it (GET
 * /status `recovery`, GET /recovery): `waiting` until `eligibleAt`, then
 * `ready` until `expiresAt`. A request whose link was never used is not
 * shown (anyone can type an email address).
 */
export type RecoveryView = {
  status: "waiting" | "ready";
  requestedAt: string;
  eligibleAt: string;
  expiresAt: string;
  firstFactorRequired: RecoveryFirstFactorRequired;
};

export type RecoveryErrorCode =
  | "invalid_request"
  | "recovery_token_invalid"
  | "recovery_not_found"
  | "recovery_not_ready";

const STATUS_OF: Record<RecoveryErrorCode, number> = {
  invalid_request: 400,
  recovery_token_invalid: 400,
  recovery_not_found: 409,
  recovery_not_ready: 409,
};

/** A refusal the route sends as `status` with `{ error, code, ...extra }`. */
export class RecoveryError extends Error {
  readonly status: number;
  constructor(readonly code: RecoveryErrorCode, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "RecoveryError";
    this.status = STATUS_OF[code];
  }
}

const tokenInvalid = () => new RecoveryError("recovery_token_invalid", "This link is invalid or has expired.");

export function hashRecoveryToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A token as a link carries it (base64url, 32 bytes); anything else answers nothing. */
export function parseRecoveryToken(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

type Person = { email: string; name: string; requiredAt: Date | null };

async function lockPerson(tx: DatabaseExecutor, userId: string): Promise<Person | null> {
  const [user] = await tx.select({
    email: users.email, displayName: users.displayName, name: users.name, requiredAt: users.secondFactorRequiredAt, retiredAt: users.retiredAt,
  }).from(users).where(eq(users.id, userId)).for("update");
  if (!user || user.retiredAt) return null;
  return { email: user.email, name: user.displayName || user.name, requiredAt: user.requiredAt };
}

/**
 * `set_password` for a person with no first factor: no password
 * (`password_credential_established_at` null: the hash is a social signup's
 * placeholder) and no connected sign-in method. Such a person (passkey only)
 * cannot finish by email alone.
 */
export async function recoveryFirstFactorRequired(executor: DatabaseExecutor, userId: string): Promise<RecoveryFirstFactorRequired> {
  const [user] = await executor.select({ established: users.passwordCredentialEstablishedAt }).from(users).where(eq(users.id, userId));
  if (user?.established) return null;
  const [identity] = await executor.select({ id: userAuthIdentities.id }).from(userAuthIdentities)
    .where(eq(userAuthIdentities.userId, userId)).limit(1);
  return identity ? null : "set_password";
}

/** Requests past their time are `expired`: a link never used in 30 minutes, a wait not finished within 7 days of eligible_at. */
function staleCondition(now: Date) {
  return or(
    and(eq(secondFactorRecoveryRequests.status, "pending_confirmation"), lte(secondFactorRecoveryRequests.linkExpiresAt, now)),
    and(eq(secondFactorRecoveryRequests.status, "waiting"), lte(secondFactorRecoveryRequests.eligibleAt, new Date(now.getTime() - RECOVERY_FINISH_WINDOW_MS))),
  );
}

async function expireStale(executor: DatabaseExecutor, now: Date, userId?: string): Promise<number> {
  const expired = await executor.update(secondFactorRecoveryRequests)
    .set({ status: "expired", expiredAt: now })
    .where(and(userId ? eq(secondFactorRecoveryRequests.userId, userId) : undefined, staleCondition(now)))
    .returning({ id: secondFactorRecoveryRequests.id });
  return expired.length;
}

async function audit(tx: DatabaseExecutor, userId: string, eventType: IntegrationAuditEventType, metadata: Record<string, unknown>): Promise<void> {
  // The person's own: no serverId, never on a server's audit page.
  await recordIntegrationAuditEvent({
    serverId: null,
    eventType,
    outcome: "success",
    source: "web",
    actor: { type: "human", id: userId },
    subject: { type: "human", id: userId },
    target: { type: "user", id: userId },
    metadata,
  }, tx);
}

async function mail(person: { email: string; name: string }, userId: string, event: SecondFactorRecoveryEmailEvent): Promise<void> {
  if (!person.email) return;
  try {
    await sendSecondFactorRecoveryEmail(person.email, person.name, event);
  } catch (err) {
    console.error(`[second-factor-recovery] ${event.kind} email to ${userId} failed:`, serializeErrorForLog(err));
  }
}

async function personOf(userId: string): Promise<{ email: string; name: string } | null> {
  const [user] = await getDb().select({ email: users.email, displayName: users.displayName, name: users.name }).from(users).where(eq(users.id, userId));
  return user ? { email: user.email, name: user.displayName || user.name } : null;
}

/**
 * Step 1, after the route has answered. Never throws (logged): the caller has
 * already sent the same 200 to everyone. Does nothing for an unknown email,
 * a retired account, a person without two-step verification or with the flag
 * off, over the hourly limit, or while a request already waits (its banner is
 * up). A link not used yet is replaced by the new one.
 */
export async function startRecovery(input: { email: string; now?: Date }): Promise<void> {
  const now = input.now ?? currentDate();
  try {
    const email = normalizeEmail(input.email);
    const [user] = await getDb().select({ id: users.id, requiredAt: users.secondFactorRequiredAt, retiredAt: users.retiredAt })
      .from(users).where(eq(users.email, email)).limit(1);
    if (!user || user.retiredAt || !user.requiredAt) return;
    const userId = user.id;
    const token = newToken();
    const person = await getDb().transaction(async (tx) => {
      const locked = await lockPerson(tx, userId);
      if (!locked?.requiredAt) return null;
      await expireStale(tx, now, userId);
      const [recent] = await tx.select({ n: count() }).from(secondFactorRecoveryRequests)
        .where(and(eq(secondFactorRecoveryRequests.userId, userId), gt(secondFactorRecoveryRequests.requestedAt, new Date(now.getTime() - 60 * 60_000))));
      if ((recent?.n ?? 0) >= RECOVERY_REQUESTS_PER_HOUR) return null;
      const [active] = await tx.select({ id: secondFactorRecoveryRequests.id, status: secondFactorRecoveryRequests.status })
        .from(secondFactorRecoveryRequests)
        .where(and(eq(secondFactorRecoveryRequests.userId, userId), inArray(secondFactorRecoveryRequests.status, [...ACTIVE])));
      if (active?.status === "waiting") return null;
      if (active) {
        // The earlier link is superseded: only the newest one works.
        await tx.update(secondFactorRecoveryRequests).set({ status: "expired", expiredAt: now })
          .where(and(eq(secondFactorRecoveryRequests.id, active.id), eq(secondFactorRecoveryRequests.status, "pending_confirmation")));
      }
      await tx.insert(secondFactorRecoveryRequests).values({
        userId,
        status: "pending_confirmation",
        linkTokenHash: hashRecoveryToken(token),
        linkExpiresAt: new Date(now.getTime() + RECOVERY_LINK_TTL_MS),
        requestedAt: now,
      });
      return locked;
    });
    if (person) await mail(person, userId, { kind: "link", token, expiresInMinutes: Math.round(RECOVERY_LINK_TTL_MS / 60_000) });
  } catch (err) {
    console.error("[second-factor-recovery] starting a recovery failed:", serializeErrorForLog(err));
  }
}

/**
 * Step 2: the emailed link starts the 72-hour wait. Single use (only a
 * `pending_confirmation` row within its 30 minutes answers, compare-and-set);
 * refused alike for an unknown, used or expired link and for a person no
 * longer eligible. After commit: the "someone asked" email with the cancel
 * link and one mobile push.
 */
export async function confirmRecovery(input: { token: string; now?: Date }): Promise<RecoveryView> {
  const now = input.now ?? currentDate();
  const linkTokenHash = hashRecoveryToken(input.token);
  const [row] = await getDb().select({ id: secondFactorRecoveryRequests.id, userId: secondFactorRecoveryRequests.userId })
    .from(secondFactorRecoveryRequests)
    .where(and(
      eq(secondFactorRecoveryRequests.linkTokenHash, linkTokenHash),
      eq(secondFactorRecoveryRequests.status, "pending_confirmation"),
      gt(secondFactorRecoveryRequests.linkExpiresAt, now),
    ));
  if (!row) throw tokenInvalid();
  const { userId } = row;
  const cancelToken = newToken();
  const eligibleAt = new Date(now.getTime() + RECOVERY_DELAY_MS);
  const confirmed = await getDb().transaction(async (tx) => {
    const person = await lockPerson(tx, userId);
    if (!person?.requiredAt) throw tokenInvalid();
    const [updated] = await tx.update(secondFactorRecoveryRequests)
      .set({ status: "waiting", confirmedAt: now, eligibleAt, cancelTokenHash: hashRecoveryToken(cancelToken) })
      .where(and(
        eq(secondFactorRecoveryRequests.id, row.id),
        eq(secondFactorRecoveryRequests.status, "pending_confirmation"),
        gt(secondFactorRecoveryRequests.linkExpiresAt, now),
      ))
      .returning();
    if (!updated) throw tokenInvalid();
    await audit(tx, userId, "account.second_factor_recovery_started", { requestId: updated.id, eligibleAt: eligibleAt.toISOString() });
    return { person, request: updated, firstFactorRequired: await recoveryFirstFactorRequired(tx, userId) };
  });
  await mail(confirmed.person, userId, { kind: "started", eligibleAt, cancelToken, firstFactorRequired: confirmed.firstFactorRequired });
  await pushRecoveryStarted(userId, confirmed.request.id, now);
  return viewOf(confirmed.request, now, confirmed.firstFactorRequired)!;
}

function viewOf(
  row: { requestedAt: Date; eligibleAt: Date | null },
  now: Date,
  firstFactorRequired: RecoveryFirstFactorRequired,
): RecoveryView | null {
  if (!row.eligibleAt) return null;
  const expiresAt = new Date(row.eligibleAt.getTime() + RECOVERY_FINISH_WINDOW_MS);
  if (expiresAt <= now) return null;
  return {
    status: row.eligibleAt <= now ? "ready" : "waiting",
    requestedAt: row.requestedAt.toISOString(),
    eligibleAt: row.eligibleAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    firstFactorRequired,
  };
}

async function findWaiting(executor: DatabaseExecutor, userId: string) {
  const [row] = await executor.select().from(secondFactorRecoveryRequests)
    .where(and(eq(secondFactorRecoveryRequests.userId, userId), eq(secondFactorRecoveryRequests.status, "waiting")));
  return row ?? null;
}

/** The person's confirmed request as sessions show it (RecoveryView), null without one; a request past its 7 days is expired here. */
export async function getRecoveryView(userId: string, now: Date = currentDate(), executor: DatabaseExecutor = getDb()): Promise<RecoveryView | null> {
  const row = await findWaiting(executor, userId);
  if (!row) return null;
  const view = viewOf(row, now, await recoveryFirstFactorRequired(executor, userId));
  if (!view) await expireStale(executor, now, userId);
  return view;
}

/** Whether a sign-in's second step may offer `recovery`: a request past its wait and within its 7 days. */
export async function isRecoveryReady(userId: string, now: Date = currentDate()): Promise<boolean> {
  const row = await findWaiting(getDb(), userId);
  return Boolean(row?.eligibleAt && row.eligibleAt <= now && now.getTime() < row.eligibleAt.getTime() + RECOVERY_FINISH_WINDOW_MS);
}

/**
 * Step 4, from a signed-in session of the person (DELETE /recovery): one
 * step, no step-up (cancelling is the safe direction). Ends a confirmed
 * request or an unused link alike; nothing to cancel is not an error.
 */
export async function cancelRecoveryBySession(input: { userId: string; now?: Date }): Promise<{ cancelled: boolean }> {
  const now = input.now ?? currentDate();
  const { userId } = input;
  const result = await getDb().transaction(async (tx) => {
    const person = await lockPerson(tx, userId);
    if (!person) return null;
    const cancelled = await cancelActive(tx, userId, now, "user");
    return cancelled ? { person, cancelled } : null;
  });
  if (!result) return { cancelled: false };
  if (result.cancelled.confirmed) await mail(result.person, userId, { kind: "cancelled", by: "user" });
  return { cancelled: true };
}

/**
 * Step 4, the emailed cancel link (POST /recovery/cancel { token },
 * unauthenticated): answers while its request waits (also past eligible_at,
 * until it is finished or expires); refused alike otherwise.
 */
export async function cancelRecoveryByToken(input: { token: string; now?: Date }): Promise<void> {
  const now = input.now ?? currentDate();
  const cancelTokenHash = hashRecoveryToken(input.token);
  const [row] = await getDb().select({ id: secondFactorRecoveryRequests.id, userId: secondFactorRecoveryRequests.userId })
    .from(secondFactorRecoveryRequests)
    .where(and(eq(secondFactorRecoveryRequests.cancelTokenHash, cancelTokenHash), eq(secondFactorRecoveryRequests.status, "waiting")));
  if (!row) throw tokenInvalid();
  const person = await getDb().transaction(async (tx) => {
    const locked = await lockPerson(tx, row.userId);
    if (!locked) throw tokenInvalid();
    await expireStale(tx, now, row.userId);
    const [cancelled] = await tx.update(secondFactorRecoveryRequests)
      .set({ status: "cancelled", cancelledAt: now, cancelledBy: "token" })
      .where(and(eq(secondFactorRecoveryRequests.id, row.id), eq(secondFactorRecoveryRequests.status, "waiting")))
      .returning({ id: secondFactorRecoveryRequests.id });
    if (!cancelled) throw tokenInvalid();
    await audit(tx, row.userId, "account.second_factor_recovery_cancelled", { requestId: cancelled.id, cancelledBy: "token" });
    return locked;
  });
  await mail(person, row.userId, { kind: "cancelled", by: "token" });
}

async function cancelActive(
  tx: DatabaseExecutor,
  userId: string,
  now: Date,
  by: SecondFactorRecoveryCancelledBy,
): Promise<{ id: string; confirmed: boolean } | null> {
  const [cancelled] = await tx.update(secondFactorRecoveryRequests)
    .set({ status: "cancelled", cancelledAt: now, cancelledBy: by })
    .where(and(eq(secondFactorRecoveryRequests.userId, userId), inArray(secondFactorRecoveryRequests.status, [...ACTIVE])))
    .returning({ id: secondFactorRecoveryRequests.id, confirmedAt: secondFactorRecoveryRequests.confirmedAt });
  if (!cancelled) return null;
  await audit(tx, userId, "account.second_factor_recovery_cancelled", { requestId: cancelled.id, cancelledBy: by });
  return { id: cancelled.id, confirmed: Boolean(cancelled.confirmedAt) };
}

/** What autoCancelRecoveryInTransaction ended, for the email after commit (afterRecoveryAutoCancel). */
export type RecoveryAutoCancelled = { userId: string; confirmed: boolean } | null;

/**
 * Step 3: a right second-factor answer by the person, in the transaction
 * that accepts it (after the person's `users` row is locked): their active
 * request (or unused link) is cancelled `auto_factor`. One indexed update
 * that finds nothing for everyone without a request. Pass what it returns to
 * afterRecoveryAutoCancel once the transaction has committed.
 */
export async function autoCancelRecoveryInTransaction(tx: DatabaseExecutor, userId: string, now: Date): Promise<RecoveryAutoCancelled> {
  const cancelled = await cancelActive(tx, userId, now, "auto_factor");
  return cancelled ? { userId, confirmed: cancelled.confirmed } : null;
}

/** After commit: the "cancelled" email for a confirmed request (an unused link was never announced). Never throws. */
export async function afterRecoveryAutoCancel(cancelled: RecoveryAutoCancelled): Promise<void> {
  if (!cancelled?.confirmed) return;
  try {
    const person = await personOf(cancelled.userId);
    if (person) await mail(person, cancelled.userId, { kind: "cancelled", by: "auto_factor" });
  } catch (err) {
    console.error(`[second-factor-recovery] auto-cancel email to ${cancelled.userId} failed:`, serializeErrorForLog(err));
  }
}

/** The request is not finishable now: why, for the sign-in's refusal. */
async function notFinishable(tx: DatabaseExecutor, userId: string, now: Date): Promise<RecoveryError> {
  const row = await findWaiting(tx, userId);
  if (row?.eligibleAt && row.eligibleAt > now) {
    return new RecoveryError("recovery_not_ready", "The reset can be finished only after the 72-hour wait.", { eligibleAt: row.eligibleAt.toISOString() });
  }
  return new RecoveryError("recovery_not_found", "There is no two-step verification reset to finish.");
}

/** Refuses before the sign-in's attempt is claimed when nothing could be finished (the transaction checks again). */
export async function assertRecoveryFinishable(userId: string, now: Date): Promise<void> {
  if (!(await isRecoveryReady(userId, now))) throw await notFinishable(getDb(), userId, now);
}

/**
 * Step 5, in the transaction of a first-factor sign-in's second step, before
 * its session is created: under the person's row lock, the request
 * `waiting` -> `completed` by compare-and-set (past eligible_at, within its 7
 * days: of two finishes at once one wins, the other is refused and rolls
 * back), the authenticator app and backup codes deleted, every passkey
 * revoked (`revoked_at`, as removing one does), two-step verification off,
 * and every session family revoked `revoke_all` (the security revoke a
 * password reset makes). Throws RecoveryError to refuse.
 */
export async function completeRecoveryInTransaction(
  tx: DatabaseExecutor,
  input: { userId: string; flow: string; now: Date },
): Promise<{ requestId: string }> {
  const { userId, now } = input;
  const person = await lockPerson(tx, userId);
  if (!person?.requiredAt) throw new RecoveryError("recovery_not_found", "There is no two-step verification reset to finish.");
  const [completed] = await tx.update(secondFactorRecoveryRequests)
    .set({ status: "completed", completedAt: now })
    .where(and(
      eq(secondFactorRecoveryRequests.userId, userId),
      eq(secondFactorRecoveryRequests.status, "waiting"),
      lte(secondFactorRecoveryRequests.eligibleAt, now),
      gt(secondFactorRecoveryRequests.eligibleAt, new Date(now.getTime() - RECOVERY_FINISH_WINDOW_MS)),
    ))
    .returning({ id: secondFactorRecoveryRequests.id });
  if (!completed) throw await notFinishable(tx, userId, now);
  await tx.delete(userTotp).where(eq(userTotp.userId, userId));
  await tx.delete(userBackupCodes).where(eq(userBackupCodes.userId, userId));
  await tx.update(webauthnCredentials).set({ revokedAt: now })
    .where(and(eq(webauthnCredentials.userId, userId), isNull(webauthnCredentials.revokedAt)));
  await tx.update(users).set({ secondFactorRequiredAt: null, updatedAt: now }).where(eq(users.id, userId));
  await revokeAllUserSessionsInTransaction(tx, userId);
  await audit(tx, userId, "account.second_factor_recovery_completed", { requestId: completed.id, signInFlow: input.flow });
  return { requestId: completed.id };
}

/**
 * After the finishing sign-in has committed: the after-commit half of a
 * password reset (userService.revokeAccessAfterCredentialChange: sockets,
 * the keys device sessions handed out, and the security-revoke cascade for
 * what the revoked sessions approved or issued, with its notice email), then
 * the "reset" email. Never throws: hourly maintenance repairs the cascade
 * from state (the families are revoked `revoke_all`).
 */
export async function runRecoveryCompletedEffects(userId: string): Promise<void> {
  try {
    // Imported here: userService imports signIn.ts, which imports this file.
    const { revokeAccessAfterCredentialChange } = await import("../userService");
    await revokeAccessAfterCredentialChange(userId, "second_factor_recovered", null);
  } catch (err) {
    console.error(`[second-factor-recovery] security revoke after recovery of ${userId} failed:`, serializeErrorForLog(err));
  }
  const person = await personOf(userId).catch(() => null);
  if (person) await mail(person, userId, { kind: "completed" });
}

/**
 * The one mobile push when the wait starts: an existing `system_notice`
 * outbox row with plain title and body (no new category or copy key, so
 * current apps show it), tapping into Activity. A security notice: it
 * notifies whatever the person's server level and quiet hours say
 * (`securityNotice`, notifications/policy.ts). The outbox is per server: it
 * goes under the person's first server (as the legacy test push picks one);
 * none without a server.
 * Never throws.
 */
export async function pushRecoveryStarted(userId: string, requestId: string, now: Date): Promise<void> {
  try {
    const serverId = (await listServerLevels(userId))[0]?.serverId;
    if (!serverId) return;
    const payload: NotificationNoticePayload = {
      title: "Someone asked to reset your two-step verification",
      body: "If this wasn't you, open Raft and cancel it.",
      kind: "mention",
      event: "system_notice",
      route: { type: "channel", serverId, channelId: "", messageId: null },
      opensActivity: true,
      // A security notice: past the person's server level and quiet hours (notifications/policy.ts).
      securityNotice: true,
    };
    await enqueueNotificationRows([{
      receiverId: userId,
      serverId,
      kind: null,
      sourceChannelId: null,
      messageId: null,
      messageSeq: null,
      activityAt: now,
      personalMention: true,
      eventKey: `second_factor_recovery:${requestId}`,
      category: "system_notice",
      payload: payload as unknown as Record<string, unknown>,
    }]);
  } catch (err) {
    console.error(`[second-factor-recovery] push to ${userId} failed:`, serializeErrorForLog(err));
  }
}

/**
 * Hourly maintenance: expire requests past their time, and mail the "you can
 * finish now" email once per request whose wait ended (claimed by
 * compare-and-set on `ready_notified_at`, so replicas mail it once). The
 * cancel link is stored only hashed, so this email points at signing in (or
 * the earlier email's cancel link) instead. Bounded per run.
 */
export async function sweepRecoveryRequests(now: Date = currentDate(), limit = 200): Promise<{ expired: number; readyMailed: number }> {
  const expired = await expireStale(getDb(), now);
  const due = await getDb().select({ id: secondFactorRecoveryRequests.id, userId: secondFactorRecoveryRequests.userId, eligibleAt: secondFactorRecoveryRequests.eligibleAt })
    .from(secondFactorRecoveryRequests)
    .where(and(
      eq(secondFactorRecoveryRequests.status, "waiting"),
      lte(secondFactorRecoveryRequests.eligibleAt, now),
      isNull(secondFactorRecoveryRequests.readyNotifiedAt),
    ))
    .limit(limit);
  let readyMailed = 0;
  for (const row of due) {
    const [claimed] = await getDb().update(secondFactorRecoveryRequests)
      .set({ readyNotifiedAt: now })
      .where(and(
        eq(secondFactorRecoveryRequests.id, row.id),
        eq(secondFactorRecoveryRequests.status, "waiting"),
        isNull(secondFactorRecoveryRequests.readyNotifiedAt),
      ))
      .returning({ id: secondFactorRecoveryRequests.id });
    if (!claimed || !row.eligibleAt) continue;
    const person = await personOf(row.userId);
    if (!person) continue;
    await mail(person, row.userId, {
      kind: "ready",
      finishBy: new Date(row.eligibleAt.getTime() + RECOVERY_FINISH_WINDOW_MS),
      firstFactorRequired: await recoveryFirstFactorRequired(getDb(), row.userId),
    });
    readyMailed += 1;
  }
  return { expired, readyMailed };
}
