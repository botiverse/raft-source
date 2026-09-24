import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import argon2 from "argon2";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { pushRegistrations, sessionFamilies, sessions, users } from "../db/schema.js";
import { openTestApp } from "../test/integration/app.js";
import { addMember, createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function login(baseUrl: string, email: string, password = "password123") {
  return (await loginSession(baseUrl, email, password)).accessToken;
}

async function loginSession(baseUrl: string, email: string, password = "password123") {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `login for ${email} expected 200`);
  return await res.json() as { accessToken: string; refreshToken: string };
}

function headers(token: string, serverId: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
  };
}

async function seedVerifiedUser(email: string, name: string) {
  const passwordHash = await argon2.hash("password123");
  const [user] = await getDb().insert(users).values({
    email,
    name,
    passwordHash,
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

test("mobile push registrations validate the APNs tuple and upsert by installation/provider", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const owner = await seedVerifiedUser("push-owner@slock.test", "push-owner");
    const other = await seedVerifiedUser("push-other@slock.test", "push-other");
    const server = await createServer("Push API", "push-api", owner.id);
    await addMember(server.id, other.id);
    const ownerToken = await login(baseUrl, owner.email);
    const otherToken = await login(baseUrl, other.email);

    const missingEnv = await fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        installationId: "ios-install-1",
        provider: "apns",
        topic: "ai.slock.app",
        deviceToken: "token-1",
      }),
    });
    assert.equal(missingEnv.status, 400);

    const partialTuple = await fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        installationId: "ios-install-1",
        provider: "apns",
        env: "sandbox",
        topic: "ai.slock.app",
      }),
    });
    assert.equal(partialTuple.status, 400);

    const maliciousTuple = await fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        installationId: "alice@example.com secret marker",
        provider: "apns",
        env: "sandbox",
        topic: "ai.slock.app.dev",
        deviceToken: "token-1",
      }),
    });
    assert.equal(maliciousTuple.status, 400, "persistent installation identity must have a bounded safe shape");

    const oversizedTuple = await fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        installationId: "i".repeat(129),
        provider: "apns",
        env: "sandbox",
        topic: "ai.slock.app.dev",
        deviceToken: "token-1",
      }),
    });
    assert.equal(oversizedTuple.status, 400);

    const create = await fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        installationId: "ios-install-1",
        provider: "apns",
        env: "sandbox",
        topic: "ai.slock.app.dev",
        deviceToken: "token-1",
        appVersion: "1.0.0",
      }),
    });
    assert.equal(create.status, 200, await create.clone().text());
    const createBody = await create.json() as { revoke_capability: string };
    assert.match(createBody.revoke_capability, /^[A-Za-z0-9._-]+$/);

    const update = await fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        installationId: "ios-install-1",
        provider: "apns",
        env: "production",
        topic: "ai.slock.app",
        deviceToken: "token-2",
        appVersion: "1.0.1",
      }),
    });
    assert.equal(update.status, 200, await update.clone().text());
    const updateBody = await update.json() as { revoke_capability: string };
    assert.equal(updateBody.revoke_capability, createBody.revoke_capability, "same family registration must return a stable capability");

    const rows = await getDb().select().from(pushRegistrations).where(eq(pushRegistrations.installationId, "ios-install-1"));
    assert.equal(rows.length, 1, "same installation/provider should be idempotently upserted");
    assert.equal(rows[0].provider, "apns");
    assert.equal(rows[0].env, "production");
    assert.equal(rows[0].topic, "ai.slock.app");
    assert.equal(rows[0].deviceToken, "token-2");
    assert.equal(rows[0].appVersion, "1.0.1");
    assert.equal(rows[0].userId, owner.id);
    assert.equal(rows[0].serverId, server.id);
    assert.ok(rows[0].sessionFamilyId);

    const accountSwitch = await fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(otherToken, server.id),
      body: JSON.stringify({
        installationId: "ios-install-1",
        provider: "apns",
        env: "production",
        topic: "ai.slock.app",
        deviceToken: "token-3",
      }),
    });
    assert.equal(accountSwitch.status, 200, await accountSwitch.clone().text());

    const [rebound] = await getDb().select().from(pushRegistrations).where(eq(pushRegistrations.installationId, "ios-install-1"));
    assert.equal(rebound.userId, other.id, "login/account switch mutates only the current binding");
    assert.equal(rebound.serverId, server.id);
    assert.equal(rebound.deviceToken, "token-3");

    const unbind = await fetch(`${baseUrl}/api/push/registrations/ios-install-1`, {
      method: "DELETE",
      headers: headers(otherToken, server.id),
    });
    assert.equal(unbind.status, 200, await unbind.clone().text());
    assert.deepEqual(await unbind.json(), { ok: true, unbound: 1 });

    const [afterDelete] = await getDb().select().from(pushRegistrations).where(and(
      eq(pushRegistrations.installationId, "ios-install-1"),
      eq(pushRegistrations.provider, "apns"),
    ));
    assert.ok(afterDelete, "logout/unbind keeps the installation row");
    assert.equal(afterDelete.userId, null);
    assert.equal(afterDelete.serverId, null);
    assert.equal(afterDelete.revokedAt, null);
  } finally {
    await close();
  }
});

test("family revoke capability is unauthenticated, idempotent for 30 days, and terminal-invalid after retention", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const owner = await seedVerifiedUser("push-family@slock.test", "push-family");
    const server = await createServer("Push Family API", "push-family-api", owner.id);
    const session = await loginSession(baseUrl, owner.email);

    const registration = await fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(session.accessToken, server.id),
      body: JSON.stringify({
        installationId: "ios-family-install",
        provider: "apns",
        env: "production",
        topic: "ai.slock.app",
        deviceToken: "family-token",
      }),
    });
    assert.equal(registration.status, 200, await registration.clone().text());
    const { revoke_capability: capability } = await registration.json() as { revoke_capability: string };

    const refresh = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    assert.equal(refresh.status, 200, await refresh.clone().text());
    const rotated = await refresh.json() as { accessToken: string; refreshToken: string };
    const afterRotation = await fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(rotated.accessToken, server.id),
      body: JSON.stringify({
        installationId: "ios-family-install",
        provider: "apns",
        env: "production",
        topic: "ai.slock.app",
        deviceToken: "family-token-rotated",
      }),
    });
    assert.equal(afterRotation.status, 200, await afterRotation.clone().text());
    const afterRotationBody = await afterRotation.json() as { revoke_capability: string };
    assert.equal(afterRotationBody.revoke_capability, capability, "refresh rotation must preserve the family capability");

    const revoke = await fetch(`${baseUrl}/api/push/family-revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability }),
    });
    assert.equal(revoke.status, 204);

    const [family] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.revokeCapabilityNonce, capability.split(".")[1]));
    assert.ok(family?.revokedAt);
    assert.ok(family.capabilityRetainUntil);
    assert.ok(family.capabilityRetainUntil.getTime() - family.revokedAt.getTime() >= 30 * 24 * 60 * 60 * 1000);
    const remainingSessions = await getDb().select().from(sessions).where(eq(sessions.familyId, family.id));
    assert.equal(remainingSessions.length, 0, "family revoke must invalidate every refresh session in the family");

    const replay = await fetch(`${baseUrl}/api/push/family-revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability }),
    });
    assert.equal(replay.status, 204, "replay inside retention is terminal idempotent success");

    await getDb().update(sessionFamilies).set({ capabilityRetainUntil: new Date(Date.now() - 1) }).where(eq(sessionFamilies.id, family.id));
    const expiredReplay = await fetch(`${baseUrl}/api/push/family-revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability }),
    });
    assert.equal(expiredReplay.status, 403, "expired capability is terminal-invalid for mobile to clear pending signout");

    const invalid = await fetch(`${baseUrl}/api/push/family-revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: capability.slice(0, -1) + "x" }),
    });
    assert.equal(invalid.status, 403);
    const malformed = await fetch(`${baseUrl}/api/push/family-revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "bad capability" }),
    });
    assert.equal(malformed.status, 400);
  } finally {
    await close();
  }
});

test("online logout marks the entire push family dead while retaining idempotent capability acknowledgement", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const owner = await seedVerifiedUser("push-logout@slock.test", "push-logout");
    const server = await createServer("Push Logout API", "push-logout-api", owner.id);
    const session = await loginSession(baseUrl, owner.email);
    const registration = await fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(session.accessToken, server.id),
      body: JSON.stringify({
        installationId: "ios-logout-install",
        provider: "apns",
        env: "production",
        topic: "ai.slock.app",
        deviceToken: "logout-token",
      }),
    });
    const { revoke_capability: capability } = await registration.json() as { revoke_capability: string };

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    assert.equal(logout.status, 200);

    const [family] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.revokeCapabilityNonce, capability.split(".")[1]));
    assert.ok(family.revokedAt);
    assert.equal(family.revokedReason, "logout");
    assert.equal((await getDb().select().from(sessions).where(eq(sessions.familyId, family.id))).length, 0);

    const capabilityAck = await fetch(`${baseUrl}/api/push/family-revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability }),
    });
    assert.equal(capabilityAck.status, 204);
  } finally {
    await close();
  }
});
