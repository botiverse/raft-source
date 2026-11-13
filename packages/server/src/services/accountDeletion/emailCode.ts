/**
 * The emailed code that confirms an account deletion request for a person
 * with neither a password nor two-step verification (design §4, decided by
 * Tenny): POST /api/me/account/deletion/email-code sends it, POST
 * /api/me/account/deletion takes it back as `{ emailCode }`.
 *
 * Stored as an `auth_challenges` row (kind `account_deletion_email_code`,
 * flow `account_deletion`), so it shares that table's single use and expiry:
 *   - bound to the person and to the sign-in (session family) that asked;
 *     another sign-in of the same person cannot use it;
 *   - six digits, valid 10 minutes, used at most once (consumed by
 *     compare-and-set in the transaction that records the request);
 *   - sending a new one ends any earlier live one; at most one a minute;
 *   - only a keyed digest of the code is stored (HMAC with a key derived
 *     from JWT_SECRET, salted with the row id): a database read alone does
 *     not give the code;
 *   - every answer claims an attempt first, committed on its own (claim-first,
 *     attemptWindow.ts): one of the person's second-factor attempts (the same
 *     per-person lock as the second step of sign-in, 429
 *     `second_factor_locked`), and one of the code's own five
 *     (AUTH_CHALLENGE_MAX_ATTEMPTS; the code is dead after them). Only a right
 *     code gives the person's attempt back, in the transaction that uses it.
 */
import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";

import { getDb, type DatabaseExecutor } from "../../db/index";
import { authChallenges, users } from "../../db/schema";
import { sendAccountDeletionEmail } from "../emailService";
import { AUTH_CHALLENGE_MAX_ATTEMPTS } from "../secondFactor/authChallenges";
import { claimSecondFactorAttempt, releaseSecondFactorAttempt } from "../secondFactor/attemptWindow";

export const ACCOUNT_DELETION_EMAIL_CODE_TTL_MS = 10 * 60_000;
/** The shortest time between two codes for one person. */
export const ACCOUNT_DELETION_EMAIL_CODE_RESEND_MS = 60_000;
const KIND = "account_deletion_email_code" as const;
const FLOW = "account_deletion";
const CODE_RE = /^[0-9]{6}$/;

function digestKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  return createHash("sha256").update(`raft:account-deletion-email-code:v1:${secret}`).digest();
}

function codeDigest(challengeId: string, code: string): string {
  return createHmac("sha256", digestKey()).update(`${challengeId}:${code}`).digest("hex");
}

/** An answer as typed: six digits, spaces and dashes ignored; null when it cannot be a code. */
export function parseAccountDeletionEmailCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.replace(/[\s-]/g, "");
  return CODE_RE.test(code) ? code : null;
}

export type SendEmailCodeResult =
  | { ok: true; expiresAt: Date }
  | { ok: false; retryAfterSeconds: number };

/**
 * Create a code for this sign-in and email it. Ends the person's earlier live
 * code; refused (with how long to wait) within a minute of the last one.
 */
export async function sendAccountDeletionEmailCode(input: { userId: string; familyId: string; now: Date }): Promise<SendEmailCodeResult> {
  const { userId, familyId, now } = input;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + ACCOUNT_DELETION_EMAIL_CODE_TTL_MS);
  const created = await getDb().transaction(async (tx) => {
    const [user] = await tx.select({ email: users.email, displayName: users.displayName, name: users.name, retiredAt: users.retiredAt })
      .from(users).where(eq(users.id, userId)).for("update");
    if (!user || user.retiredAt) throw new Error("sendAccountDeletionEmailCode: the account is not active");
    const [last] = await tx.select({ createdAt: authChallenges.createdAt }).from(authChallenges)
      .where(and(eq(authChallenges.userId, userId), eq(authChallenges.kind, KIND)))
      .orderBy(desc(authChallenges.createdAt))
      .limit(1);
    const wait = last ? last.createdAt.getTime() + ACCOUNT_DELETION_EMAIL_CODE_RESEND_MS - now.getTime() : 0;
    if (wait > 0) return { ok: false as const, retryAfterSeconds: Math.ceil(wait / 1000) };
    await tx.update(authChallenges).set({ consumedAt: now })
      .where(and(eq(authChallenges.userId, userId), eq(authChallenges.kind, KIND), isNull(authChallenges.consumedAt)));
    await tx.insert(authChallenges).values({
      id,
      kind: KIND,
      userId,
      flow: FLOW,
      payload: { familyId, digest: codeDigest(id, code) },
      // Never handed out: the code is the answer, the row is found by person and sign-in.
      challengeHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
      expiresAt,
      createdAt: now,
    });
    return { ok: true as const, email: user.email, name: user.displayName || user.name };
  });
  if (!created.ok) return created;
  await sendAccountDeletionEmail(created.email, created.name, {
    kind: "email_code",
    code,
    expiresInMinutes: Math.round(ACCOUNT_DELETION_EMAIL_CODE_TTL_MS / 60_000),
  });
  return { ok: true, expiresAt };
}

export type ClaimEmailCodeResult =
  | { ok: true; challengeId: string }
  | { ok: false; reason: "locked"; lockedUntil: Date }
  | { ok: false; reason: "invalid" };

/**
 * Check an answer, claim first: the person's attempt, then one of the live
 * code's own (this sign-in's newest unexpired, unconsumed code with attempts
 * left), each committed on its own whatever the answer. A right answer is
 * not used yet: consumeAccountDeletionEmailCode uses it, in the transaction
 * that records the request.
 */
export async function claimAccountDeletionEmailCode(input: { userId: string; familyId: string; code: string; now: Date }): Promise<ClaimEmailCodeResult> {
  const { userId, familyId, code, now } = input;
  const db = getDb();
  const claim = await claimSecondFactorAttempt(db, userId, now);
  if (!claim.ok) return { ok: false, reason: "locked", lockedUntil: claim.lockedUntil };
  const live = db.select({ id: authChallenges.id }).from(authChallenges)
    .where(and(
      eq(authChallenges.userId, userId),
      eq(authChallenges.kind, KIND),
      eq(authChallenges.flow, FLOW),
      isNull(authChallenges.consumedAt),
      gt(authChallenges.expiresAt, now),
      sql`${authChallenges.payload}->>'familyId' = ${familyId}`,
    ))
    .orderBy(desc(authChallenges.createdAt))
    .limit(1);
  const [row] = await db.update(authChallenges)
    .set({ attempts: sql`${authChallenges.attempts} + 1` })
    .where(and(sql`${authChallenges.id} = (${live})`, lt(authChallenges.attempts, AUTH_CHALLENGE_MAX_ATTEMPTS)))
    .returning({ id: authChallenges.id, payload: authChallenges.payload });
  const stored = typeof row?.payload?.digest === "string" ? row.payload.digest : null;
  if (!row || !stored) return { ok: false, reason: "invalid" };
  const expected = Buffer.from(codeDigest(row.id, code), "hex");
  const actual = Buffer.from(stored, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: "invalid" };
  return { ok: true, challengeId: row.id };
}

/**
 * Use a right code in the caller's transaction: the one call that finds it
 * still live marks it consumed and gives the person's attempt back. False
 * when it was used or ended in between (refuse; nothing else may commit).
 */
export async function consumeAccountDeletionEmailCode(tx: DatabaseExecutor, input: { userId: string; challengeId: string; now: Date }): Promise<boolean> {
  const used = await tx.update(authChallenges).set({ consumedAt: input.now })
    .where(and(
      eq(authChallenges.id, input.challengeId),
      eq(authChallenges.userId, input.userId),
      eq(authChallenges.kind, KIND),
      isNull(authChallenges.consumedAt),
      gt(authChallenges.expiresAt, input.now),
    ))
    .returning({ id: authChallenges.id });
  if (used.length !== 1) return false;
  await releaseSecondFactorAttempt(tx, input.userId, input.now);
  return true;
}
