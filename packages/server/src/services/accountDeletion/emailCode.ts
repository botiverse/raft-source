/**
 * The emailed code that confirms a sensitive request for a person with
 * neither a password nor two-step verification (design §4, decided by
 * Tenny). One flow per request it confirms, each with its own
 * `auth_challenges` kind, flow and digest key, so a code sent for one never
 * confirms the other:
 *   - account deletion: POST /api/me/account/deletion/email-code sends it,
 *     POST /api/me/account/deletion takes it back as `{ emailCode }`;
 *   - data export (services/sensitiveReauth.ts): POST
 *     /api/me/data-exports/email-code sends it, creating an export takes it
 *     back as `{ emailCode }`.
 *
 * Stored as an `auth_challenges` row (the flow's kind and flow), so it shares
 * that table's single use and expiry. A code is bound to the person and the
 * sign-in that asked, not to what it confirms within its flow: a data export
 * code sent from the personal page also confirms a server export of the same
 * person on the same sign-in (both are "export my data from Raft"; each still
 * runs that request's own permission checks).
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
import { authChallenges, users, type AuthChallengeKind } from "../../db/schema";
import { sendAccountDeletionEmail, sendDataExportEmail } from "../emailService";
import { AUTH_CHALLENGE_MAX_ATTEMPTS } from "../secondFactor/authChallenges";
import { claimSecondFactorAttempt, releaseSecondFactorAttempt } from "../secondFactor/attemptWindow";

export const ACCOUNT_DELETION_EMAIL_CODE_TTL_MS = 10 * 60_000;
/** The shortest time between two codes for one person. */
export const ACCOUNT_DELETION_EMAIL_CODE_RESEND_MS = 60_000;
const CODE_RE = /^[0-9]{6}$/;

/** What a code confirms: its row's kind and flow, its digest key, and its email. */
export interface EmailCodeFlow {
  kind: AuthChallengeKind;
  flow: string;
  digestLabel: string;
  send(to: string, name: string, input: { code: string; expiresInMinutes: number }): Promise<void>;
}

export const ACCOUNT_DELETION_EMAIL_CODE_FLOW: EmailCodeFlow = {
  kind: "account_deletion_email_code",
  flow: "account_deletion",
  digestLabel: "raft:account-deletion-email-code:v1",
  send: (to, name, input) => sendAccountDeletionEmail(to, name, { kind: "email_code", ...input }),
};

export const DATA_EXPORT_EMAIL_CODE_FLOW: EmailCodeFlow = {
  kind: "data_export_email_code",
  flow: "data_export",
  digestLabel: "raft:data-export-email-code:v1",
  send: (to, name, input) => sendDataExportEmail(to, name, { kind: "email_code", ...input }),
};

function digestKey(flow: EmailCodeFlow): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  return createHash("sha256").update(`${flow.digestLabel}:${secret}`).digest();
}

function codeDigest(flow: EmailCodeFlow, challengeId: string, code: string): string {
  return createHmac("sha256", digestKey(flow)).update(`${challengeId}:${code}`).digest("hex");
}

/** An answer as typed: six digits, spaces and dashes ignored; null when it cannot be a code. */
export function parseEmailCode(raw: unknown): string | null {
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
export async function sendEmailCode(flow: EmailCodeFlow, input: { userId: string; familyId: string; now: Date }): Promise<SendEmailCodeResult> {
  const { userId, familyId, now } = input;
  const { kind, flow: flowName } = flow;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + ACCOUNT_DELETION_EMAIL_CODE_TTL_MS);
  const created = await getDb().transaction(async (tx) => {
    const [user] = await tx.select({ email: users.email, displayName: users.displayName, name: users.name, retiredAt: users.retiredAt })
      .from(users).where(eq(users.id, userId)).for("update");
    if (!user || user.retiredAt) throw new Error("sendEmailCode: the account is not active");
    const [last] = await tx.select({ createdAt: authChallenges.createdAt }).from(authChallenges)
      .where(and(eq(authChallenges.userId, userId), eq(authChallenges.kind, kind)))
      .orderBy(desc(authChallenges.createdAt))
      .limit(1);
    const wait = last ? last.createdAt.getTime() + ACCOUNT_DELETION_EMAIL_CODE_RESEND_MS - now.getTime() : 0;
    if (wait > 0) return { ok: false as const, retryAfterSeconds: Math.ceil(wait / 1000) };
    await tx.update(authChallenges).set({ consumedAt: now })
      .where(and(eq(authChallenges.userId, userId), eq(authChallenges.kind, kind), isNull(authChallenges.consumedAt)));
    await tx.insert(authChallenges).values({
      id,
      kind,
      userId,
      flow: flowName,
      payload: { familyId, digest: codeDigest(flow, id, code) },
      // Never handed out: the code is the answer, the row is found by person and sign-in.
      challengeHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
      expiresAt,
      createdAt: now,
    });
    return { ok: true as const, email: user.email, name: user.displayName || user.name };
  });
  if (!created.ok) return created;
  await flow.send(created.email, created.name, {
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
 * not used yet: consumeEmailCode uses it, in the transaction that records
 * the request. Only a code of this flow is looked at.
 */
export async function claimEmailCode(flow: EmailCodeFlow, input: { userId: string; familyId: string; code: string; now: Date }): Promise<ClaimEmailCodeResult> {
  const { userId, familyId, code, now } = input;
  const { kind, flow: flowName } = flow;
  const db = getDb();
  const claim = await claimSecondFactorAttempt(db, userId, now);
  if (!claim.ok) return { ok: false, reason: "locked", lockedUntil: claim.lockedUntil };
  const live = db.select({ id: authChallenges.id }).from(authChallenges)
    .where(and(
      eq(authChallenges.userId, userId),
      eq(authChallenges.kind, kind),
      eq(authChallenges.flow, flowName),
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
  const expected = Buffer.from(codeDigest(flow, row.id, code), "hex");
  const actual = Buffer.from(stored, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: "invalid" };
  return { ok: true, challengeId: row.id };
}

/**
 * Use a right code in the caller's transaction: the one call that finds it
 * still live marks it consumed and gives the person's attempt back. False
 * when it was used or ended in between (refuse; nothing else may commit).
 */
export async function consumeEmailCode(flow: EmailCodeFlow, tx: DatabaseExecutor, input: { userId: string; challengeId: string; now: Date }): Promise<boolean> {
  const used = await tx.update(authChallenges).set({ consumedAt: input.now })
    .where(and(
      eq(authChallenges.id, input.challengeId),
      eq(authChallenges.userId, input.userId),
      eq(authChallenges.kind, flow.kind),
      isNull(authChallenges.consumedAt),
      gt(authChallenges.expiresAt, input.now),
    ))
    .returning({ id: authChallenges.id });
  if (used.length !== 1) return false;
  await releaseSecondFactorAttempt(tx, input.userId, input.now);
  return true;
}

