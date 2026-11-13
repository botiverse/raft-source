/**
 * Per-person limit on the second step of a sign-in (design §4 T2): at most
 * SECOND_FACTOR_MAX_ATTEMPTS failures per window of an hour, then a 15-minute
 * lock (`second_factor_attempt_windows`). Like a challenge's own limit
 * (authChallenges.ts), an attempt is claimed before the code is checked, so
 * the limit holds however many answers arrive at once; a right answer then
 * gives its claim back, so only failures stay counted.
 *
 * Call order for the second step:
 *   1. claimSecondFactorAttempt, committed on its own (before verifying);
 *      refused = stop, verify nothing.
 *   2. Verify the code.
 *   3. Right: releaseSecondFactorAttempt in the sign-in transaction (with the
 *      challenge consume, the TOTP step or backup code, and the new session).
 *      Wrong: nothing; the claim stays counted.
 * Releasing is safe because only a right answer earns it, which a guesser
 * cannot produce, and the claim still came first, so concurrent guesses stay
 * bounded by the claims.
 *
 * The lock blocks only the second step after a first factor (password or
 * OAuth), never passkey sign-in: otherwise anyone who knows the password
 * could keep the person locked out by trying 10 times every 15 minutes.
 *
 * Password re-authentication of a signed-in session (POST /reauth/password)
 * follows the same rules with its own count (`reauth_attempt_windows`,
 * claimReauthAttempt / releaseReauthAttempt): someone holding a stolen
 * session can lock re-authentication with wrong passwords, but not the
 * owner's second step at sign-in, and the other way round.
 *
 * Used by the management routes (management.ts) for inline step-up and by
 * the second step of sign-in (signIn.ts).
 */
import { and, eq, getTableName, gt, sql } from "drizzle-orm";

import type { DatabaseExecutor } from "../../db/index";
import { reauthAttemptWindows, secondFactorAttemptWindows } from "../../db/schema";

/** Failed attempts a person gets per window (second step and re-authentication alike). */
export const SECOND_FACTOR_MAX_ATTEMPTS = 10;
export const SECOND_FACTOR_WINDOW_MS = 60 * 60_000;
export const SECOND_FACTOR_LOCK_MS = 15 * 60_000;

/** The two windows share columns and rules; each is its own count. */
type AttemptWindowTable = typeof secondFactorAttemptWindows | typeof reauthAttemptWindows;

export type SecondFactorAttemptClaim =
  | { ok: true }
  /**
   * Refused until `lockedUntil`. `lockStarted` is true only for the one claim
   * that used up the window and started the lock (the one to send the
   * "someone reached your second step" email for).
   */
  | { ok: false; lockedUntil: Date; lockStarted: boolean };

/**
 * Claim one second-step attempt for the person before checking their code.
 * One conditional upsert: a fresh window (none yet, an hour since it started,
 * or a lock that has ended) starts at 1; otherwise the count goes up, and
 * the claim past the limit sets the lock instead of being allowed. While
 * locked the row is left alone and the claim is refused. Commit the claim
 * whatever the answer turns out to be (claim on its own, before the
 * transaction that signs in): a claim rolled back with a wrong answer does
 * not count.
 */
export async function claimSecondFactorAttempt(
  executor: DatabaseExecutor,
  userId: string,
  now: Date,
): Promise<SecondFactorAttemptClaim> {
  return claimAttempt(secondFactorAttemptWindows, executor, userId, now);
}

/** claimSecondFactorAttempt for password re-authentication, counted in `reauth_attempt_windows`. */
export async function claimReauthAttempt(executor: DatabaseExecutor, userId: string, now: Date): Promise<SecondFactorAttemptClaim> {
  return claimAttempt(reauthAttemptWindows, executor, userId, now);
}

async function claimAttempt(
  t: AttemptWindowTable,
  executor: DatabaseExecutor,
  userId: string,
  now: Date,
): Promise<SecondFactorAttemptClaim> {
  const nowParam = sql`${now.toISOString()}::timestamptz`;
  const windowCutoff = sql`${new Date(now.getTime() - SECOND_FACTOR_WINDOW_MS).toISOString()}::timestamptz`;
  const lockUntil = sql`${new Date(now.getTime() + SECOND_FACTOR_LOCK_MS).toISOString()}::timestamptz`;
  const startsFresh = sql`(${t.windowStartedAt} <= ${windowCutoff} OR ${t.lockedUntil} <= ${nowParam})`;
  for (let tries = 0; tries < 3; tries += 1) {
    const [row] = await executor
      .insert(t)
      .values({ userId, windowStartedAt: now, attempts: 1, lockedUntil: null })
      .onConflictDoUpdate({
        target: t.userId,
        set: {
          windowStartedAt: sql`CASE WHEN ${startsFresh} THEN ${nowParam} ELSE ${t.windowStartedAt} END`,
          attempts: sql`CASE WHEN ${startsFresh} THEN 1 ELSE ${t.attempts} + 1 END`,
          lockedUntil: sql`CASE WHEN ${startsFresh} THEN NULL WHEN ${t.attempts} + 1 > ${SECOND_FACTOR_MAX_ATTEMPTS} THEN ${lockUntil} ELSE NULL END`,
        },
        where: sql`${t.lockedUntil} IS NULL OR ${t.lockedUntil} <= ${nowParam}`,
      })
      .returning({ lockedUntil: t.lockedUntil });
    if (row) return row.lockedUntil ? { ok: false, lockedUntil: row.lockedUntil, lockStarted: true } : { ok: true };
    // Locked: the upsert left the row alone. Read when the lock ends (and
    // claim again in the unlikely case it ended in between).
    const [locked] = await executor
      .select({ lockedUntil: t.lockedUntil })
      .from(t)
      .where(eq(t.userId, userId));
    if (locked?.lockedUntil && locked.lockedUntil > now) return { ok: false, lockedUntil: locked.lockedUntil, lockStarted: false };
  }
  throw new Error(`claimAttempt(${getTableName(t)}): no stable window row`);
}

/**
 * Give back the claim of an attempt whose answer was right (step 3 above):
 * one fewer attempt counted, never below zero. A lock already set stays
 * until it ends. (`_now` keeps the signature in line with the claim; the
 * release does not depend on the time.)
 */
export async function releaseSecondFactorAttempt(executor: DatabaseExecutor, userId: string, _now: Date): Promise<void> {
  await releaseAttempt(secondFactorAttemptWindows, executor, userId);
}

/** releaseSecondFactorAttempt for password re-authentication (`reauth_attempt_windows`). */
export async function releaseReauthAttempt(executor: DatabaseExecutor, userId: string, _now: Date): Promise<void> {
  await releaseAttempt(reauthAttemptWindows, executor, userId);
}

async function releaseAttempt(t: AttemptWindowTable, executor: DatabaseExecutor, userId: string): Promise<void> {
  await executor
    .update(t)
    .set({ attempts: sql`${t.attempts} - 1` })
    .where(and(eq(t.userId, userId), gt(t.attempts, 0)));
}
