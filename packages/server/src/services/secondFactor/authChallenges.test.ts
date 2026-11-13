import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { dbTest as test } from "../../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../../test/integration/database";
import { getDb } from "../../db/index";
import { authChallenges, users } from "../../db/schema";
import {
  AUTH_CHALLENGE_MAX_ATTEMPTS,
  claimAuthChallengeAttempt,
  consumeAuthChallenge,
  createAuthChallenge,
  parseAuthChallengeToken,
} from "./authChallenges";

afterEach(async () => { await closeTestDatabase(); });

const T0 = new Date("2026-10-31T12:00:00Z");
const TTL = 5 * 60_000;

async function seedUser(): Promise<string> {
  const [user] = await getDb().insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "test-only" }).returning();
  return user!.id;
}

test("a challenge is stored only as its hash, keeps its bound context, and is used once", async () => {
  await openTestDatabase("pglite://");
  const db = getDb();
  const userId = await seedUser();
  const created = await createAuthChallenge({
    kind: "second_factor_login", userId, flow: "web", payload: { pendingLoginHash: "abc", clientBinding: "web" }, ttlMs: TTL, now: T0,
  });
  assert.equal(created.expiresAt.getTime(), T0.getTime() + TTL);
  assert.equal(parseAuthChallengeToken(created.challenge), created.challenge);
  assert.equal(parseAuthChallengeToken("short"), null);
  assert.equal(parseAuthChallengeToken(42), null);
  const [stored] = await db.select().from(authChallenges).where(eq(authChallenges.id, created.id));
  assert.notEqual(stored!.challengeHash, created.challenge);
  assert.ok(!JSON.stringify(stored).includes(created.challenge));

  // Another kind does not see or use it.
  assert.equal(await claimAuthChallengeAttempt(db, created.challenge, "webauthn_assertion", T0), null);
  assert.equal(await consumeAuthChallenge(db, created.challenge, "webauthn_assertion", T0), null);

  const claimed = await claimAuthChallengeAttempt(db, created.challenge, "second_factor_login", T0);
  assert.deepEqual(claimed, {
    id: created.id, userId, kind: "second_factor_login", flow: "web",
    payload: { pendingLoginHash: "abc", clientBinding: "web" }, attempts: 1, expiresAt: created.expiresAt,
  });
  const consumed = await consumeAuthChallenge(db, created.challenge, "second_factor_login", T0);
  assert.equal(consumed?.id, created.id);
  assert.equal(consumed?.attempts, 1, "a right answer does not refund its attempt");
  assert.equal(await consumeAuthChallenge(db, created.challenge, "second_factor_login", T0), null, "used once");
  assert.equal(await claimAuthChallengeAttempt(db, created.challenge, "second_factor_login", T0), null, "a used challenge takes no attempts");
});

test("two uses at once: exactly one gets the challenge", async () => {
  await openTestDatabase("pglite://");
  const created = await createAuthChallenge({ kind: "webauthn_assertion", userId: null, ttlMs: TTL, now: T0 });
  const results = await Promise.all([1, 2, 3].map(() => consumeAuthChallenge(getDb(), created.challenge, "webauthn_assertion", T0)));
  assert.equal(results.filter(Boolean).length, 1);
});

test("an expired challenge cannot be claimed or used", async () => {
  await openTestDatabase("pglite://");
  const db = getDb();
  const created = await createAuthChallenge({ kind: "second_factor_login", userId: await seedUser(), ttlMs: TTL, now: T0 });
  const atExpiry = new Date(T0.getTime() + TTL);
  assert.equal(await claimAuthChallengeAttempt(db, created.challenge, "second_factor_login", atExpiry), null);
  assert.equal(await consumeAuthChallenge(db, created.challenge, "second_factor_login", atExpiry), null);
  const [row] = await db.select({ attempts: authChallenges.attempts }).from(authChallenges).where(eq(authChallenges.id, created.id));
  assert.equal(row!.attempts, 0, "a refused claim counts nothing");
  // Just before expiry it was still live.
  const justBefore = new Date(atExpiry.getTime() - 1);
  assert.ok(await claimAuthChallengeAttempt(db, created.challenge, "second_factor_login", justBefore));
  assert.ok(await consumeAuthChallenge(db, created.challenge, "second_factor_login", justBefore));
});

test("attempts are claimed before checking: the sixth claim is refused, the fifth may still answer", async () => {
  await openTestDatabase("pglite://");
  const db = getDb();
  const created = await createAuthChallenge({ kind: "second_factor_login", userId: await seedUser(), ttlMs: TTL, now: T0 });
  for (let attempt = 1; attempt <= AUTH_CHALLENGE_MAX_ATTEMPTS; attempt += 1) {
    assert.equal((await claimAuthChallengeAttempt(db, created.challenge, "second_factor_login", T0))?.attempts, attempt);
  }
  assert.equal(await claimAuthChallengeAttempt(db, created.challenge, "second_factor_login", T0), null, "sixth claim");
  const [row] = await db.select({ attempts: authChallenges.attempts }).from(authChallenges).where(eq(authChallenges.id, created.id));
  assert.equal(row!.attempts, AUTH_CHALLENGE_MAX_ATTEMPTS, "a refused claim does not count past the limit");
  // The fifth claim's answer, if right, still uses the challenge.
  assert.ok(await consumeAuthChallenge(db, created.challenge, "second_factor_login", T0));

  // Claims racing on one challenge: exactly the limit get through.
  const raced = await createAuthChallenge({ kind: "second_factor_login", userId: null, ttlMs: TTL, now: T0 });
  const claims = await Promise.all(Array.from({ length: 20 }, () => claimAuthChallengeAttempt(db, raced.challenge, "second_factor_login", T0)));
  assert.equal(claims.filter(Boolean).length, AUTH_CHALLENGE_MAX_ATTEMPTS);
});

test("challenges go with their user", async () => {
  await openTestDatabase("pglite://");
  const userId = await seedUser();
  const created = await createAuthChallenge({ kind: "webauthn_registration", userId, ttlMs: TTL, now: T0 });
  await getDb().delete(users).where(eq(users.id, userId));
  assert.deepEqual(await getDb().select().from(authChallenges).where(eq(authChallenges.id, created.id)), []);
});
