import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { dbTest as test } from "../../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../../test/integration/database";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { authChallenges, secondFactorAttemptWindows, sessionFamilies, users, userTotp } from "../../db/schema";
import { createSession } from "../sessionService";
import { proofForSecondFactorVerified } from "../sessionIssueGate";
import { claimAuthChallengeAttempt, consumeAuthChallenge, createAuthChallenge } from "./authChallenges";
import { claimSecondFactorAttempt, releaseSecondFactorAttempt } from "./attemptWindow";
import { consumeBackupCode, countUnusedBackupCodes, replaceBackupCodes } from "./backupCodes";
import { recordTotpStep } from "./totp";

// Every second-step write takes the caller's executor, so a sign-in's
// challenge use, replay guard, backup code and new session commit together
// or not at all. The attempt claims are committed first, on their own: a
// claim rolled back with a failed answer would not count.
afterEach(async () => { await closeTestDatabase(); });

const NOW = new Date("2026-10-31T12:00:00Z");

async function seed() {
  const db = getDb();
  const [user] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "test-only" }).returning();
  const userId = user!.id;
  await db.insert(userTotp).values({ userId, secretCiphertext: "v1:test", confirmedAt: NOW, lastUsedStep: 10 });
  const [code] = await replaceBackupCodes(userId, NOW);
  const challenge = await createAuthChallenge({ kind: "second_factor_login", userId, flow: "password_login", ttlMs: 5 * 60_000, now: NOW });
  return { userId, code: code!, challenge };
}

async function state(userId: string, challengeId: string) {
  const db = getDb();
  const [challenge] = await db.select({ attempts: authChallenges.attempts, consumedAt: authChallenges.consumedAt }).from(authChallenges).where(eq(authChallenges.id, challengeId));
  const [totp] = await db.select({ step: userTotp.lastUsedStep }).from(userTotp).where(eq(userTotp.userId, userId));
  const families = await db.select({ id: sessionFamilies.id }).from(sessionFamilies).where(eq(sessionFamilies.userId, userId));
  return { challenge, step: totp!.step, families: families.length, unusedCodes: await countUnusedBackupCodes(userId) };
}

async function claimAttempts(seeded: Awaited<ReturnType<typeof seed>>) {
  assert.deepEqual(await claimSecondFactorAttempt(getDb(), seeded.userId, NOW), { ok: true });
  assert.ok(await claimAuthChallengeAttempt(getDb(), seeded.challenge.challenge, "second_factor_login", NOW));
}

async function secondStep(tx: DatabaseExecutor, seeded: Awaited<ReturnType<typeof seed>>) {
  const consumed = await consumeAuthChallenge(tx, seeded.challenge.challenge, "second_factor_login", NOW);
  assert.ok(consumed);
  assert.equal(await recordTotpStep(tx, seeded.userId, 11, "v1:test"), true);
  assert.deepEqual(await consumeBackupCode(tx, seeded.userId, seeded.code, NOW), { ok: true, remaining: 9 });
  await releaseSecondFactorAttempt(tx, seeded.userId, NOW);
  return createSession(proofForSecondFactorVerified(consumed, "totp"), tx);
}

test("the second step and the new session commit together", async () => {
  await openTestDatabase("pglite://");
  const seeded = await seed();
  await claimAttempts(seeded);
  const session = await getDb().transaction((tx) => secondStep(tx, seeded));
  const [family] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.id, session.familyId));
  assert.equal(family!.secondFactorMethod, "totp", "the verified proof marks the new family");
  assert.ok(family!.secondFactorVerifiedAt);
  assert.deepEqual(await state(seeded.userId, seeded.challenge.id), {
    challenge: { attempts: 1, consumedAt: NOW }, step: 11, families: 1, unusedCodes: 9,
  });
  const [window] = await getDb().select({ attempts: secondFactorAttemptWindows.attempts }).from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, seeded.userId));
  assert.equal(window!.attempts, 0, "the right answer gave its claim back");
});

test("when the transaction fails after them, none of the second step's writes persist (the claims do)", async () => {
  await openTestDatabase("pglite://");
  const seeded = await seed();
  await claimAttempts(seeded);
  await assert.rejects(getDb().transaction(async (tx) => {
    await secondStep(tx, seeded);
    throw new Error("later step failed");
  }), /later step failed/);
  assert.deepEqual(await state(seeded.userId, seeded.challenge.id), {
    challenge: { attempts: 1, consumedAt: null }, step: 10, families: 0, unusedCodes: 10,
  });
  const [window] = await getDb().select({ attempts: secondFactorAttemptWindows.attempts }).from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, seeded.userId));
  assert.equal(window!.attempts, 1, "the rolled-back release did not give the claim back");
  // Nothing was used up: the same answers work afterwards.
  assert.ok(await getDb().transaction((tx) => secondStep(tx, seeded)));
});
