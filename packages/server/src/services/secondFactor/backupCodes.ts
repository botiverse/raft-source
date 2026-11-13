/**
 * Backup codes: 10 single-use codes shown once when two-step verification is
 * turned on (or the set is regenerated). Each is 10 Crockford base32
 * characters (50 bits), shown as `XXXXX-XXXXX`; typed back case-insensitive,
 * hyphen and spaces optional, I/L read as 1 and O as 0. Only argon2 hashes of
 * the normalized form are stored
 * (`user_backup_codes`). Using one marks it used by compare-and-set, so of
 * two concurrent uses of the same code exactly one wins.
 *
 * Used by the management routes (routes/secondFactor.ts) and sign-in's
 * second step (signIn.ts). Every code used is audited in the transaction that
 * used it (recordBackupCodeUse) and emailed after it commits
 * (sendBackupCodeUsedEmail), with how many are left.
 */
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../../db/index";
import { userBackupCodes, users } from "../../db/schema";
import { sendSecondFactorBackupCodeUsedEmail, type SecondFactorBackupCodeUsedEmailContext } from "../emailService";
import { recordIntegrationAuditEvent } from "../integrationAuditService";
import type { FirstFactorFlow } from "../sessionIssueGate";

/** Crockford base32: no I, L, O or U. */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_CHARS = 10;
const BACKUP_CODE_GROUP = 5;

/** One fresh code, `XXXXX-XXXXX` (Crockford base32). */
export function generateBackupCode(): string {
  // One byte per character, low 5 bits: uniform, since 256 is a multiple of 32.
  const chars = Array.from(randomBytes(BACKUP_CODE_CHARS), (byte) => CROCKFORD_ALPHABET[byte & 31]).join("");
  return `${chars.slice(0, BACKUP_CODE_GROUP)}-${chars.slice(BACKUP_CODE_GROUP)}`;
}

/**
 * What is hashed and compared: upper case, without spaces or hyphens, with
 * Crockford's aliases resolved (I and L to 1, O to 0). Null when it cannot be a code.
 */
export function normalizeBackupCode(input: string): string | null {
  const normalized = input.replace(/[\s-]/g, "").toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(normalized) ? normalized : null;
}

/**
 * Backup codes are 10 random Crockford characters (50 bits), not something a
 * person chose, so they need no memory-hard work beyond OWASP's argon2id
 * minimum: 19 MiB, 2 iterations, 1 lane (Tenny, #wg-rbac:#69). The default
 * (64 MiB, 3 iterations) made turning two-step on take ~7.6 s on staging.
 * Each hash records its own parameters, so codes hashed before still verify.
 */
export const BACKUP_CODE_ARGON2 = { type: argon2.argon2id, memoryCost: 19 * 1024, timeCost: 2, parallelism: 1 } as const;

/**
 * Replace the person's backup codes with a fresh set and return the plaintext
 * codes (the only time they exist). Earlier codes, used or not, are deleted
 * in the same transaction: the caller's `executor` when given (so the new
 * set commits with, say, turning two-step verification on), else its own.
 */
export async function replaceBackupCodes(
  userId: string,
  now: Date = currentDate(),
  executor?: DatabaseExecutor,
): Promise<string[]> {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);
  // One argon2 hash at a time: each takes argon2's default 64 MiB, so ten at
  // once took several hundred MiB and got a staging task OOM-killed on every
  // two-step enable (#wg-rbac:#69, 1.23.0 cut). Sequential costs ~1 s.
  const hashes: string[] = [];
  for (const code of codes) hashes.push(await argon2.hash(normalizeBackupCode(code)!, BACKUP_CODE_ARGON2));
  const replace = async (tx: DatabaseExecutor) => {
    await tx.delete(userBackupCodes).where(eq(userBackupCodes.userId, userId));
    await tx.insert(userBackupCodes).values(hashes.map((codeHash) => ({ userId, codeHash, createdAt: now })));
  };
  if (executor) await replace(executor);
  else await getDb().transaction(replace);
  return codes;
}

/**
 * Whether `input` is one of the person's backup codes that was already used
 * (to tell `backup_code_used` from a wrong code). Read-only.
 */
export async function isUsedBackupCode(executor: DatabaseExecutor, userId: string, input: string): Promise<boolean> {
  const code = normalizeBackupCode(input);
  if (!code) return false;
  const used = await executor
    .select({ codeHash: userBackupCodes.codeHash })
    .from(userBackupCodes)
    .where(and(eq(userBackupCodes.userId, userId), isNotNull(userBackupCodes.usedAt)));
  for (const row of used) {
    if (await argon2.verify(row.codeHash, code)) return true;
  }
  return false;
}

/** Codes the person has not used yet. */
export async function countUnusedBackupCodes(userId: string): Promise<number> {
  return countUnused(getDb(), userId);
}

/** Codes the person has not used yet, read through `executor` (inside a transaction: as it will commit). */
export async function countUnused(executor: DatabaseExecutor, userId: string): Promise<number> {
  const rows = await executor
    .select({ id: userBackupCodes.id })
    .from(userBackupCodes)
    .where(and(eq(userBackupCodes.userId, userId), isNull(userBackupCodes.usedAt)));
  return rows.length;
}

export type ConsumeBackupCodeResult = { ok: true; remaining: number } | { ok: false };

/**
 * Use one backup code. Ok only for the call that marks a matching unused
 * code used, with how many unused codes the person has left after it; a
 * used, unknown or malformed code (or a lost race for the same code) is not.
 * Reads and writes through `executor`, so it commits or rolls back with the
 * sign-in that uses it.
 */
export async function consumeBackupCode(
  executor: DatabaseExecutor,
  userId: string,
  input: string,
  now: Date,
): Promise<ConsumeBackupCodeResult> {
  const code = normalizeBackupCode(input);
  if (!code) return { ok: false };
  const unused = await executor
    .select({ id: userBackupCodes.id, codeHash: userBackupCodes.codeHash })
    .from(userBackupCodes)
    .where(and(eq(userBackupCodes.userId, userId), isNull(userBackupCodes.usedAt)));
  for (const row of unused) {
    if (!await argon2.verify(row.codeHash, code)) continue;
    const claimed = await executor
      .update(userBackupCodes)
      .set({ usedAt: now })
      .where(and(eq(userBackupCodes.id, row.id), isNull(userBackupCodes.usedAt)))
      .returning({ id: userBackupCodes.id });
    if (claimed.length !== 1) return { ok: false };
    return { ok: true, remaining: await countUnused(executor, userId) };
  }
  return { ok: false };
}

/** What a backup code answered: the second step of a sign-in, or step-up for a change. */
export type BackupCodeUseContext = SecondFactorBackupCodeUsedEmailContext;

export type BackupCodeUse = {
  context: BackupCodeUseContext;
  /** Unused codes left once the transaction commits. */
  remaining: number;
  /** The sign-in it stepped up; null at sign-in (the family is created by it). */
  sessionFamilyId: string | null;
  signInFlow?: FirstFactorFlow;
};

/**
 * Inside the transaction that used the code: the audit event (the person's
 * own, no serverId, never on a server's audit page). After commit, call
 * sendBackupCodeUsedEmail.
 */
export async function recordBackupCodeUse(tx: DatabaseExecutor, userId: string, use: BackupCodeUse): Promise<void> {
  await recordIntegrationAuditEvent({
    serverId: null,
    eventType: "account.second_factor_backup_code_used",
    outcome: "success",
    source: "web",
    actor: { type: "human", id: userId },
    subject: { type: "human", id: userId },
    target: { type: "user", id: userId },
    metadata: {
      method: "backup_code",
      context: use.context,
      remaining: use.remaining,
      sessionFamilyId: use.sessionFamilyId,
      ...(use.signInFlow ? { signInFlow: use.signInFlow } : {}),
    },
  }, tx);
}

/** Best effort after commit: tell the person a backup code was used and how many are left. */
export async function sendBackupCodeUsedEmail(userId: string, use: BackupCodeUse): Promise<void> {
  try {
    const [user] = await getDb().select({ email: users.email, name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, userId));
    if (user?.email) {
      await sendSecondFactorBackupCodeUsedEmail(user.email, user.displayName || user.name, { context: use.context, remaining: use.remaining });
    }
  } catch (err) {
    console.error(`[second-factor] backup code used email to ${userId} failed:`, err);
  }
}
