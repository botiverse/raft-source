import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

import { getDb } from "../../db/index";
import { featureFlags, users, userTotp } from "../../db/schema";
import { replaceBackupCodes } from "../../services/secondFactor/backupCodes";
import { base32Decode, generateTotpSecret, hotp, totpStepAt } from "../../services/secondFactor/totp";
import { encryptTotpSecret, TOTP_SECRET_KEY_ENV } from "../../services/secondFactor/totpSecretCrypto";

/** The TOTP secret key the server encrypts with; set it for the test file, give back the old one after. */
export function useTotpSecretKey(): void {
  const previous = process.env[TOTP_SECRET_KEY_ENV];
  beforeAll(() => { process.env[TOTP_SECRET_KEY_ENV] = randomBytes(32).toString("base64"); });
  afterAll(() => {
    if (previous === undefined) delete process.env[TOTP_SECRET_KEY_ENV];
    else process.env[TOTP_SECRET_KEY_ENV] = previous;
  });
}

/**
 * A leftover `auth_second_factor_v1` row, switched off (default off, no rules),
 * as a deployment that never deleted the retired flag may still hold
 * (#raft-architecture:#32). Two-step verification ignores it.
 */
export async function leaveRetiredSecondFactorFlagRowOff(): Promise<void> {
  await getDb().insert(featureFlags)
    .values({ key: "auth_second_factor_v1", randomizationUnit: "user", salt: "test", defaultEnabled: false })
    .onConflictDoNothing();
}

/**
 * Two-step verification turned on for `userId` as POST /enable leaves it:
 * a confirmed authenticator app, 10 backup codes, `second_factor_required_at`.
 * Written directly (the management routes have their own tests).
 */
export async function enrollSecondFactor(userId: string, options: { totp?: boolean } = {}): Promise<{ secret: string; backupCodes: string[] }> {
  const now = new Date();
  const secret = generateTotpSecret();
  if (options.totp !== false) {
    await getDb().insert(userTotp).values({ userId, secretCiphertext: encryptTotpSecret(secret, userId), confirmedAt: now, lastUsedStep: null });
  }
  const backupCodes = await replaceBackupCodes(userId, now);
  await getDb().update(users).set({ secondFactorRequiredAt: now }).where(eq(users.id, userId));
  return { secret, backupCodes };
}

/** The code for `offset` steps from now (the server accepts -1..+1). */
export function totpCode(secret: string, offset = 0): string {
  return hotp(base32Decode(secret)!, totpStepAt(new Date()) + offset);
}

/** A six-digit code that matches none of the steps the server would accept. */
export function wrongTotpCode(secret: string): string {
  const valid = new Set([-2, -1, 0, 1, 2].map((offset) => totpCode(secret, offset)));
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, "0");
    if (!valid.has(candidate)) return candidate;
  }
}
