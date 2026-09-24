import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import argon2 from "argon2";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { passwordResets, userAuthIdentities, users } from "../db/schema.js";
import { signAccessToken } from "../middleware/auth.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type Provider = "google" | "github" | "apple";

async function seedUser(params: {
  email: string;
  name: string;
  passwordCredentialEstablishedAt: Date | null;
  password?: string;
}) {
  const [user] = await getDb().insert(users).values({
    email: params.email,
    name: params.name,
    displayName: params.name,
    passwordHash: await argon2.hash(params.password ?? "password123"),
    passwordCredentialEstablishedAt: params.passwordCredentialEstablishedAt,
    emailVerified: true,
  }).returning();
  return user;
}

async function seedIdentity(userId: string, provider: Provider) {
  await getDb().insert(userAuthIdentities).values({
    userId,
    provider,
    providerUserId: `${provider}-${randomUUID()}`,
    providerEmail: `${provider}@example.com`,
  });
}

function bearer(userId: string) {
  return {
    Authorization: `Bearer ${signAccessToken(userId)}`,
    "Content-Type": "application/json",
  };
}

test("identity unlink keeps at least one established login method and is owner-bound + idempotent", async ({ app }) => {
  const passwordUser = await seedUser({
    email: "password-owner@example.com",
    name: "password-owner",
    passwordCredentialEstablishedAt: new Date("2026-08-04T00:00:00.000Z"),
  });
  await seedIdentity(passwordUser.id, "apple");

  const passwordlessUser = await seedUser({
    email: "social-only@example.com",
    name: "social-only",
    passwordCredentialEstablishedAt: null,
    password: `social-placeholder-${randomUUID()}`,
  });
  await seedIdentity(passwordlessUser.id, "github");

  const legacyPasswordUser = await seedUser({
    email: "legacy-password-social@example.com",
    name: "legacy-password-social",
    passwordCredentialEstablishedAt: null,
  });
  await seedIdentity(legacyPasswordUser.id, "github");

  const multiIdentityUser = await seedUser({
    email: "multi-social@example.com",
    name: "multi-social",
    passwordCredentialEstablishedAt: null,
  });
  await seedIdentity(multiIdentityUser.id, "google");
  await seedIdentity(multiIdentityUser.id, "github");

  const concurrentUser = await seedUser({
    email: "concurrent-social@example.com",
    name: "concurrent-social",
    passwordCredentialEstablishedAt: null,
  });
  await seedIdentity(concurrentUser.id, "google");
  await seedIdentity(concurrentUser.id, "github");

  const unrelatedUser = await seedUser({
    email: "unrelated@example.com",
    name: "unrelated",
    passwordCredentialEstablishedAt: new Date("2026-08-04T00:00:00.000Z"),
  });

  const unauthenticated = await fetch(`${app.baseUrl}/api/auth/identities/apple`, {
    method: "DELETE",
  });
  assert.equal(unauthenticated.status, 401, "unlink is authenticated");

  const methodsBefore = await fetch(`${app.baseUrl}/api/auth/identities`, {
    headers: bearer(passwordlessUser.id),
  });
  assert.equal(methodsBefore.status, 200);
  assert.deepEqual(await methodsBefore.json(), {
    identities: [{ provider: "github", providerEmail: "github@example.com" }],
    passwordConfigured: false,
  });

  const knownPlaceholderLogin = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: passwordlessUser.email, password: "password123" }),
  });
  assert.equal(
    knownPlaceholderLogin.status,
    401,
    "a hash without credential provenance is not an email login method",
  );

  const legacyPasswordLogin = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: legacyPasswordUser.email, password: "password123" }),
  });
  assert.equal(
    legacyPasswordLogin.status,
    200,
    "a valid pre-marker password must self-heal even after the human linked a social identity",
  );
  const [healedLegacyPasswordUser] = await getDb().select({
    passwordCredentialEstablishedAt: users.passwordCredentialEstablishedAt,
  }).from(users).where(eq(users.id, legacyPasswordUser.id));
  assert.ok(
    healedLegacyPasswordUser?.passwordCredentialEstablishedAt,
    "successful legacy password verification establishes durable credential provenance",
  );

  const blockedLastIdentity = await fetch(`${app.baseUrl}/api/auth/identities/github`, {
    method: "DELETE",
    headers: bearer(passwordlessUser.id),
  });
  assert.equal(blockedLastIdentity.status, 409);
  assert.deepEqual(await blockedLastIdentity.json(), {
    code: "PASSWORD_CREDENTIAL_REQUIRED",
    error: "Set a password before disconnecting your final sign-in account.",
  });
  assert.equal((await getDb().select({ id: userAuthIdentities.id }).from(userAuthIdentities).where(and(
    eq(userAuthIdentities.userId, passwordlessUser.id),
    eq(userAuthIdentities.provider, "github"),
  ))).length, 1, "failed safety check must not delete the final identity");

  const firstOfTwo = await fetch(`${app.baseUrl}/api/auth/identities/google`, {
    method: "DELETE",
    headers: bearer(multiIdentityUser.id),
  });
  assert.equal(firstOfTwo.status, 200);
  assert.deepEqual(await firstOfTwo.json(), {
    unlinked: true,
    identities: [{ provider: "github", providerEmail: "github@example.com" }],
    passwordConfigured: false,
  });

  const secondOfTwo = await fetch(`${app.baseUrl}/api/auth/identities/github`, {
    method: "DELETE",
    headers: bearer(multiIdentityUser.id),
  });
  assert.equal(secondOfTwo.status, 409, "consecutive unlinks cannot strand the account");

  const concurrentUnlinks = await Promise.all([
    fetch(`${app.baseUrl}/api/auth/identities/google`, {
      method: "DELETE",
      headers: bearer(concurrentUser.id),
    }),
    fetch(`${app.baseUrl}/api/auth/identities/github`, {
      method: "DELETE",
      headers: bearer(concurrentUser.id),
    }),
  ]);
  assert.deepEqual(
    concurrentUnlinks.map((response) => response.status).sort(),
    [200, 409],
    "the account-row lock must serialize concurrent final-method decisions",
  );
  assert.equal((await getDb().select({ id: userAuthIdentities.id }).from(userAuthIdentities).where(
    eq(userAuthIdentities.userId, concurrentUser.id),
  )).length, 1, "concurrent unlinks leave one social login method");

  const cannotDeleteAnotherHumansIdentity = await fetch(`${app.baseUrl}/api/auth/identities/apple`, {
    method: "DELETE",
    headers: bearer(unrelatedUser.id),
  });
  assert.equal(cannotDeleteAnotherHumansIdentity.status, 200);
  assert.deepEqual(await cannotDeleteAnotherHumansIdentity.json(), {
    unlinked: false,
    identities: [],
    passwordConfigured: true,
  });
  assert.equal((await getDb().select({ id: userAuthIdentities.id }).from(userAuthIdentities).where(and(
    eq(userAuthIdentities.userId, passwordUser.id),
    eq(userAuthIdentities.provider, "apple"),
  ))).length, 1, "an unrelated principal cannot remove another human's identity");

  const unlinkedLastIdentity = await fetch(`${app.baseUrl}/api/auth/identities/apple`, {
    method: "DELETE",
    headers: bearer(passwordUser.id),
  });
  assert.equal(unlinkedLastIdentity.status, 200);
  assert.deepEqual(await unlinkedLastIdentity.json(), {
    unlinked: true,
    identities: [],
    passwordConfigured: true,
  });

  const replay = await fetch(`${app.baseUrl}/api/auth/identities/apple`, {
    method: "DELETE",
    headers: bearer(passwordUser.id),
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    unlinked: false,
    identities: [],
    passwordConfigured: true,
  });
});

test("verified password reset establishes the credential that permits final unlink", async ({ app }) => {
  const user = await seedUser({
    email: "password-setup@example.com",
    name: "password-setup",
    passwordCredentialEstablishedAt: null,
  });
  await seedIdentity(user.id, "google");

  const rawResetToken = "verified-password-setup-token";
  await getDb().insert(passwordResets).values({
    userId: user.id,
    tokenHash: createHash("sha256").update(rawResetToken).digest("hex"),
    expiresAt: new Date(Date.now() + 60_000),
  });

  const reset = await fetch(`${app.baseUrl}/api/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: rawResetToken, password: "new-password-123" }),
  });
  assert.equal(reset.status, 200);

  const methodsAfterReset = await fetch(`${app.baseUrl}/api/auth/identities`, {
    headers: bearer(user.id),
  });
  assert.equal(methodsAfterReset.status, 200);
  assert.equal((await methodsAfterReset.json() as { passwordConfigured: boolean }).passwordConfigured, true);

  const unlink = await fetch(`${app.baseUrl}/api/auth/identities/google`, {
    method: "DELETE",
    headers: bearer(user.id),
  });
  assert.equal(unlink.status, 200);
  assert.equal((await unlink.json() as { unlinked: boolean }).unlinked, true);
});
