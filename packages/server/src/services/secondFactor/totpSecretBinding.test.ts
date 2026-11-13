import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { vi } from "vitest";

import { openTestDatabase, closeTestDatabase } from "../../test/integration/database";
import { getDb } from "../../db/index";
import * as database from "../../db/index";
import { users, userTotp, sessionFamilies } from "../../db/schema";
import { createSession } from "../sessionService";
import { createAuthChallenge } from "./authChallenges";
import { withSecondFactorAnswer } from "./management";
import { verifySecondFactorSignIn } from "./signIn";
import { encryptTotpSecret, TOTP_SECRET_KEY_ENV } from "./totpSecretCrypto";
import { base32Decode, generateTotpSecret, hotp, totpStepAt } from "./totp";

const previousKey = process.env[TOTP_SECRET_KEY_ENV];
beforeAll(() => { process.env[TOTP_SECRET_KEY_ENV] = randomBytes(32).toString("base64"); });
afterAll(() => {
  if (previousKey === undefined) delete process.env[TOTP_SECRET_KEY_ENV];
  else process.env[TOTP_SECRET_KEY_ENV] = previousKey;
});
afterEach(async () => { vi.restoreAllMocks(); await closeTestDatabase(); });

async function seed() {
  await openTestDatabase("pglite://");
  const now = new Date();
  const step = totpStepAt(now);
  const [person] = await getDb().insert(users).values({
    email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "fixture",
    secondFactorRequiredAt: now, displayName: "unchanged",
  }).returning();
  const userId = person!.id;
  const oldSecret = generateTotpSecret();
  await getDb().insert(userTotp).values({
    userId, secretCiphertext: encryptTotpSecret(oldSecret, userId), confirmedAt: now, lastUsedStep: step - 2,
  });
  return { now, step, userId, code: hotp(base32Decode(oldSecret)!, step + 1) };
}

async function replaceSecret(input: Awaited<ReturnType<typeof seed>>) {
  await getDb().update(userTotp).set({
    secretCiphertext: encryptTotpSecret(generateTotpSecret(), input.userId),
    lastUsedStep: input.step, confirmedAt: input.now,
  }).where(eq(userTotp.userId, input.userId));
}

for (const swap of [false, true]) {
  test(`sign-in checks the same TOTP secret when recording its answer (swap=${swap})`, async () => {
    const input = await seed();
    const challenge = await createAuthChallenge({
      kind: "second_factor_login", userId: input.userId, flow: "password_login",
      payload: { passwordFingerprint: "fixture", pendingLinkTokenHash: null }, ttlMs: 300_000, now: input.now,
    });
    const verify = () => verifySecondFactorSignIn({
      challenge: challenge.challenge, answer: { totp: input.code }, now: input.now,
    }, async () => {
      // This real write commits after pure verification but before sign-in's
      // transaction. The existing prepare boundary makes the interleaving exact.
      if (swap) await replaceSecret(input);
      return async (tx, proof) => createSession(proof, tx);
    });
    if (swap) await assert.rejects(verify, { code: "second_factor_code_invalid" });
    else await verify();
    const families = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, input.userId));
    assert.equal(families.length, swap ? 0 : 1, "a replaced secret cannot issue a verified session");
  });

  test(`management checks the same TOTP secret before its sensitive write (swap=${swap})`, async () => {
    const input = await seed();
    const db = getDb();
    const transaction = db.transaction.bind(db);
    // Keep the real database and real transactions. Schedule the other commit
    // at transaction entry, after verification; no production hook is needed.
    let entries = 0;
    const entry = vi.spyOn(database, "getDb").mockReturnValue(new Proxy(db, {
      get(target, property) {
        if (property === "transaction") return async (...args: Parameters<typeof transaction>) => {
          entries += 1;
          if (swap) await replaceSecret(input);
          return transaction(...args);
        };
        return Reflect.get(target, property);
      },
    }));
    const verify = () => withSecondFactorAnswer(input.userId, { code: input.code }, input.now, { allowBackupCode: false }, async (tx) => {
      await tx.update(users).set({ displayName: "sensitive action ran" }).where(eq(users.id, input.userId));
    });
    if (swap) await assert.rejects(verify, { code: "second_factor_code_invalid" });
    else await verify();
    entry.mockRestore();
    assert.equal(entries, 1, "the transaction-entry interleaving was exercised");
    const [stored] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, input.userId));
    assert.equal(stored!.name, swap ? "unchanged" : "sensitive action ran");
  });
}
