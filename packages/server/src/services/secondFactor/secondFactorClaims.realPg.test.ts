// Real-PostgreSQL teeth for the second-step attempt limits: claims are one
// conditional write each, so however many answers arrive at once, a challenge
// gives out exactly AUTH_CHALLENGE_MAX_ATTEMPTS claims and a person exactly
// SECOND_FACTOR_MAX_ATTEMPTS per window; and the whole second step of a
// sign-in (verifySecondFactorSignIn, what POST /second-factor/verify runs)
// issues at most one session per challenge; and finishing a two-step
// verification recovery (recovery.ts) completes at most once however many
// sign-ins finish it at once. PGlite serializes every statement on
// one connection, so the race only means something on a multi-connection
// Postgres. CI runs this in the hosted Test workflow
// (`pnpm --filter @botiverse/raft-server test:second-factor-claims-real-pg`);
// locally: docker postgres + SECOND_FACTOR_CLAIMS_REAL_PG_URL. Skipped
// without the URL.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import pg from "pg";

import { migrateRealPgTestDatabase } from "../../test/integration/realPgMigrate";
import { closeDatabase, getDb, initDatabase } from "../../db/index";
import { authChallenges, secondFactorAttemptWindows, secondFactorRecoveryRequests, sessionFamilies, users, userTotp } from "../../db/schema";
import { createSession } from "../sessionService";
import { AUTH_CHALLENGE_MAX_ATTEMPTS, claimAuthChallengeAttempt, createAuthChallenge } from "./authChallenges";
import { claimSecondFactorAttempt, SECOND_FACTOR_MAX_ATTEMPTS } from "./attemptWindow";
import { hashRecoveryToken } from "./recovery";
import { completeSecondFactorRecoverySignIn, SecondFactorSignInError, startSecondFactorSignIn, verifySecondFactorSignIn } from "./signIn";
import { base32Decode, generateTotpSecret, hotp, totpStepAt } from "./totp";
import { encryptTotpSecret, TOTP_SECRET_KEY_ENV } from "./totpSecretCrypto";

const REAL_PG_URL = process.env.SECOND_FACTOR_CLAIMS_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.SECOND_FACTOR_CLAIMS_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const TEST_TIMEOUT_MS = 60_000;

async function withRealPg(run: () => Promise<void>): Promise<void> {
  if (!REAL_PG_URL) {
    if (REAL_PG_REQUIRED) throw new Error("SECOND_FACTOR_CLAIMS_REAL_PG_REQUIRED=1 but SECOND_FACTOR_CLAIMS_REAL_PG_URL is unset");
    return;
  }
  const pool = new pg.Pool({ connectionString: REAL_PG_URL, max: 2 });
  await migrateRealPgTestDatabase(pool, MIGRATIONS_FOLDER);
  await initDatabase(REAL_PG_URL);
  try {
    await run();
  } finally {
    await closeDatabase();
    await pool.end();
  }
}

async function seedUser(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({ email: `second-factor-${suffix}@raft.test`, name: `second-factor-${suffix}`, passwordHash: "x" }).returning();
  return user!.id;
}

test("1000 concurrent claims on one challenge: exactly the limit get through", { timeout: TEST_TIMEOUT_MS }, async () => {
  await withRealPg(async () => {
    const now = new Date();
    const created = await createAuthChallenge({ kind: "second_factor_login", userId: await seedUser(), ttlMs: 5 * 60_000, now });
    const claims = await Promise.all(Array.from({ length: 1000 }, () => claimAuthChallengeAttempt(getDb(), created.challenge, "second_factor_login", now)));
    assert.equal(claims.filter(Boolean).length, AUTH_CHALLENGE_MAX_ATTEMPTS);
    const [row] = await getDb().select({ attempts: authChallenges.attempts }).from(authChallenges).where(eq(authChallenges.id, created.id));
    assert.equal(row!.attempts, AUTH_CHALLENGE_MAX_ATTEMPTS);
  });
});

test("1000 concurrent claims for one person: exactly the window's limit get through, one starts the lock", { timeout: TEST_TIMEOUT_MS }, async () => {
  await withRealPg(async () => {
    const now = new Date();
    const userId = await seedUser();
    const claims = await Promise.all(Array.from({ length: 1000 }, () => claimSecondFactorAttempt(getDb(), userId, now)));
    assert.equal(claims.filter((claim) => claim.ok).length, SECOND_FACTOR_MAX_ATTEMPTS);
    assert.equal(claims.filter((claim) => !claim.ok && claim.lockStarted).length, 1);
    const [row] = await getDb().select().from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, userId));
    assert.equal(row!.attempts, SECOND_FACTOR_MAX_ATTEMPTS + 1);
    assert.ok(row!.lockedUntil && row!.lockedUntil > now);
  });
});

/** A person with a confirmed authenticator app, and a password sign-in waiting for its second step. */
async function seedSecondStep() {
  process.env[TOTP_SECRET_KEY_ENV] ||= randomBytes(32).toString("base64");
  const userId = await seedUser();
  const secret = generateTotpSecret();
  await getDb().insert(userTotp).values({ userId, secretCiphertext: encryptTotpSecret(secret, userId), confirmedAt: new Date() });
  const started = await startSecondFactorSignIn(userId, { flow: "password_login", passwordFingerprint: "fingerprint", pendingLinkTokenHash: null });
  const codeAt = (offset: number) => hotp(base32Decode(secret)!, totpStepAt(new Date()) + offset);
  const right = codeAt(0);
  const accepted = new Set([-2, -1, 0, 1, 2].map(codeAt));
  let wrong = "000000";
  for (let n = 1; accepted.has(wrong); n += 1) wrong = String(n).padStart(6, "0");
  return { userId, challenge: started.challenge, right, wrong };
}

/** What the route does, minus HTTP: the second step, finishing with a session. */
function verifyCall(challenge: Awaited<ReturnType<typeof seedSecondStep>>["challenge"], totp: string) {
  return verifySecondFactorSignIn({ challenge, answer: { totp } }, async () => (tx, proof) => createSession(proof, tx))
    .then(() => "signed_in", (err: unknown) => {
      if (err instanceof SecondFactorSignInError) return err.code;
      throw err;
    });
}

async function familiesOf(userId: string): Promise<number> {
  return (await getDb().select({ id: sessionFamilies.id }).from(sessionFamilies).where(eq(sessionFamilies.userId, userId))).length;
}

test("1000 concurrent wrong answers to one sign-in challenge: at most its five attempts are used, no session", { timeout: TEST_TIMEOUT_MS }, async () => {
  await withRealPg(async () => {
    const seeded = await seedSecondStep();
    const outcomes = await Promise.all(Array.from({ length: 1000 }, () => verifyCall(seeded.challenge, seeded.wrong)));
    const [row] = await getDb().select({ attempts: authChallenges.attempts, consumedAt: authChallenges.consumedAt })
      .from(authChallenges).where(eq(authChallenges.userId, seeded.userId));
    assert.ok(row!.attempts <= AUTH_CHALLENGE_MAX_ATTEMPTS, `attempts ${row!.attempts}`);
    assert.equal(row!.consumedAt, null);
    assert.equal(outcomes.filter((outcome) => outcome === "second_factor_code_invalid").length, row!.attempts);
    assert.equal(outcomes.includes("signed_in"), false);
    assert.equal(await familiesOf(seeded.userId), 0);
  });
});

test("1000 concurrent right answers to one sign-in challenge: exactly one session", { timeout: TEST_TIMEOUT_MS }, async () => {
  await withRealPg(async () => {
    const seeded = await seedSecondStep();
    const outcomes = await Promise.all(Array.from({ length: 1000 }, () => verifyCall(seeded.challenge, seeded.right)));
    assert.equal(outcomes.filter((outcome) => outcome === "signed_in").length, 1);
    assert.equal(await familiesOf(seeded.userId), 1);
    const [row] = await getDb().select({ attempts: authChallenges.attempts, consumedAt: authChallenges.consumedAt })
      .from(authChallenges).where(eq(authChallenges.userId, seeded.userId));
    assert.ok(row!.consumedAt);
    assert.ok(row!.attempts <= AUTH_CHALLENGE_MAX_ATTEMPTS);
  });
});

test("50 concurrent sign-ins finishing one recovery request: exactly one completes, one session, every factor gone", { timeout: TEST_TIMEOUT_MS }, async () => {
  await withRealPg(async () => {
    const seeded = await seedSecondStep();
    const { userId } = seeded;
    const now = new Date();
    await getDb().update(users).set({ secondFactorRequiredAt: now }).where(eq(users.id, userId));
    await getDb().insert(secondFactorRecoveryRequests).values({
      userId,
      status: "waiting",
      linkTokenHash: hashRecoveryToken(randomBytes(32).toString("base64url")),
      linkExpiresAt: new Date(now.getTime() - 72 * 60 * 60_000),
      cancelTokenHash: hashRecoveryToken(randomBytes(32).toString("base64url")),
      requestedAt: new Date(now.getTime() - 73 * 60 * 60_000),
      confirmedAt: new Date(now.getTime() - 73 * 60 * 60_000),
      eligibleAt: new Date(now.getTime() - 60 * 60_000),
    });
    const challenges = [seeded.challenge];
    for (let n = 1; n < 50; n += 1) {
      challenges.push((await startSecondFactorSignIn(userId, { flow: "password_login", passwordFingerprint: "fingerprint", pendingLinkTokenHash: null })).challenge);
    }
    const outcomes = await Promise.all(challenges.map((challenge) =>
      completeSecondFactorRecoverySignIn({ challenge }, async () => (tx, proof) => createSession(proof, tx))
        .then(() => "completed", (err: unknown) => {
          if (err instanceof SecondFactorSignInError) return err.code;
          throw err;
        })));
    assert.equal(outcomes.filter((outcome) => outcome === "completed").length, 1);
    assert.ok(outcomes.every((outcome) => outcome === "completed" || outcome === "recovery_not_found"), outcomes.join(","));
    const families = await getDb().select({ revokedAt: sessionFamilies.revokedAt }).from(sessionFamilies).where(eq(sessionFamilies.userId, userId));
    assert.equal(families.filter((family) => !family.revokedAt).length, 1);
    const [request] = await getDb().select().from(secondFactorRecoveryRequests).where(eq(secondFactorRecoveryRequests.userId, userId));
    assert.equal(request!.status, "completed");
    assert.equal((await getDb().select().from(userTotp).where(eq(userTotp.userId, userId))).length, 0);
    const [user] = await getDb().select({ requiredAt: users.secondFactorRequiredAt }).from(users).where(eq(users.id, userId));
    assert.equal(user!.requiredAt, null);
  });
});
