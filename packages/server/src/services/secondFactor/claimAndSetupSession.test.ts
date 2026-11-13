import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index";
import { passwordResets, sessionFamilies, userBackupCodes, users, userTotp, webauthnCredentials } from "../../db/schema";
import { dbTest } from "../../test/integration/dbTest";
import { resetPassword } from "../userService";
import { lockLiveSetupSession, SecondFactorError } from "./management";

// #raft-architecture:102593c2 (Tenny 43473326): the password reset is the one
// way to claim an account someone else registered with your address, so it
// must leave them nothing; and a change to second factors may be written only
// while the sign-in that asked for it is still live.

async function resetToken(userId: string): Promise<string> {
  const token = randomBytes(24).toString("hex");
  await getDb().insert(passwordResets).values({
    userId,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return token;
}

async function giveSecondFactors(userId: string): Promise<void> {
  await getDb().update(users).set({ secondFactorRequiredAt: new Date() }).where(eq(users.id, userId));
  await getDb().insert(userTotp).values({ userId, secretCiphertext: "sealed", confirmedAt: new Date() });
  await getDb().insert(userBackupCodes).values({ userId, codeHash: "hash" });
  await getDb().insert(webauthnCredentials).values({ userId, credentialId: randomBytes(16), publicKey: randomBytes(32), name: "Attacker key" });
}

dbTest("resetting the password of an account that never verified its email removes every second factor", async ({ seed }) => {
  const squatted = await seed.human({ emailVerified: false });
  await giveSecondFactors(squatted.id);
  assert.deepEqual(await resetPassword(await resetToken(squatted.id), "a-new-password-123"), { success: true, userId: squatted.id });
  const [after] = await getDb().select().from(users).where(eq(users.id, squatted.id));
  assert.equal(after!.emailVerified, true);
  assert.equal(after!.secondFactorRequiredAt, null);
  assert.equal((await getDb().select().from(userTotp).where(eq(userTotp.userId, squatted.id))).length, 0);
  assert.equal((await getDb().select().from(userBackupCodes).where(eq(userBackupCodes.userId, squatted.id))).length, 0);
  const [passkey] = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, squatted.id));
  assert.ok(passkey!.revokedAt, "the passkey is revoked");
});

dbTest("resetting the password of a verified account keeps its second factors", async ({ seed }) => {
  const owner = await seed.human();
  await giveSecondFactors(owner.id);
  assert.equal((await resetPassword(await resetToken(owner.id), "a-new-password-123")).success, true);
  const [after] = await getDb().select().from(users).where(eq(users.id, owner.id));
  assert.ok(after!.secondFactorRequiredAt);
  assert.equal((await getDb().select().from(userTotp).where(eq(userTotp.userId, owner.id))).length, 1);
  const [passkey] = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, owner.id));
  assert.equal(passkey!.revokedAt, null);
});

dbTest("a second-factor change is refused once the sign-in that asked for it is revoked", async ({ seed }) => {
  const person = await seed.human();
  const [family] = await getDb().insert(sessionFamilies).values({ userId: person.id }).returning();
  await getDb().transaction((tx) => lockLiveSetupSession(tx, person.id, family!.id));

  await getDb().update(sessionFamilies).set({ revokedAt: new Date() }).where(eq(sessionFamilies.id, family!.id));
  await assert.rejects(
    getDb().transaction((tx) => lockLiveSetupSession(tx, person.id, family!.id)),
    (err: unknown) => err instanceof SecondFactorError && err.code === "session_family_required",
  );
  const other = await seed.human();
  await assert.rejects(
    getDb().transaction((tx) => lockLiveSetupSession(tx, other.id, family!.id)),
    (err: unknown) => err instanceof SecondFactorError && err.code === "session_family_required",
    "another person's sign-in never counts",
  );
});
