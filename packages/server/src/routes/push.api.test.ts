import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import argon2 from "argon2";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { featureFlags, pushRegistrations, pushSubscriptions, servers, sessionFamilies, sessions, users, webPushPromptEvents } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { __resetWebPushRuntimeForTests, __setWebPushRuntimeForTests } from "../services/pushService";
import { addMember, createServer } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const RETIRED_MOBILE_PUSH_DELIVERY_FLAG_KEY = "mobile_push_delivery_v0";

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
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
        topic: "build.raft.app",
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
        topic: "build.raft.app",
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
        topic: "build.raft.app",
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
        topic: "build.raft.app",
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
        topic: "build.raft.app",
        deviceToken: "token-1",
        appVersion: "1.0.0",
      }),
    });
    assert.equal(create.status, 200, await create.clone().text());
    const createBody = await create.json() as { revoke_capability: string };

    // Our APNs key pushes only to our own app: another bundle id is refused (FCM is not topic-bound).
    const foreignTopic = await fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        installationId: "foreign-build-install",
        provider: "apns",
        env: "production",
        topic: "dev.vgent.raft.app",
        deviceToken: "token-foreign",
        appVersion: "1.0",
      }),
    });
    assert.equal(foreignTopic.status, 400);
    assert.equal((await foreignTopic.json() as { code?: string }).code, "push_topic_not_allowed");
    assert.equal((await getDb().select().from(pushRegistrations).where(eq(pushRegistrations.installationId, "foreign-build-install"))).length, 0);
    assert.match(createBody.revoke_capability, /^[A-Za-z0-9._-]+$/);

    const update = await fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        installationId: "ios-install-1",
        provider: "apns",
        env: "production",
        topic: "build.raft.app",
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
    assert.equal(rows[0].topic, "build.raft.app");
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
        topic: "build.raft.app",
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
    assert.equal(afterDelete.revokedUserId, other.id, "unbind keeps who the row belonged to");

    const rebind = await fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        installationId: "ios-install-1",
        provider: "apns",
        env: "production",
        topic: "build.raft.app",
        deviceToken: "token-4",
      }),
    });
    assert.equal(rebind.status, 200, await rebind.clone().text());
    const [afterRebind] = await getDb().select().from(pushRegistrations).where(eq(pushRegistrations.installationId, "ios-install-1"));
    assert.equal(afterRebind.userId, owner.id);
    assert.equal(afterRebind.revokedUserId, null, "rebinding clears the diagnostic copy");
  } finally {
    await close();
  }
});

test("mobile push registrations store a preview mode that re-registering without it keeps; unknown modes fail closed to hidden", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedVerifiedUser("push-preview-owner@slock.test", "push-preview-owner");
    const server = await createServer("Push Preview API", "push-preview-api", owner.id);
    const ownerToken = await login(baseUrl, owner.email);
    const register = (installationId: string, body: Record<string, unknown> = {}) => fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        installationId,
        provider: "apns",
        env: "production",
        topic: "build.raft.app",
        deviceToken: "preview-token",
        ...body,
      }),
    });
    const storedMode = async (installationId: string) => {
      const [row] = await getDb().select().from(pushRegistrations).where(eq(pushRegistrations.installationId, installationId));
      return row?.previewMode;
    };

    for (const invalid of [1, true, ["hidden"], { mode: "hidden" }]) {
      const res = await register("ios-preview-invalid", { previewMode: invalid });
      assert.equal(res.status, 400, `non-string previewMode ${JSON.stringify(invalid)} must be rejected`);
    }
    assert.equal(await storedMode("ios-preview-invalid"), undefined, "a rejected registration writes nothing");

    const legacy = await register("ios-preview-legacy");
    assert.equal(legacy.status, 200, await legacy.clone().text());
    assert.equal((await legacy.json() as { registration: { previewMode: string } }).registration.previewMode, "full");
    assert.equal(await storedMode("ios-preview-legacy"), "full", "a new row without previewMode defaults to full");

    const hidden = await register("ios-preview-1", { previewMode: "hidden" });
    assert.equal(hidden.status, 200, await hidden.clone().text());
    assert.equal(await storedMode("ios-preview-1"), "hidden");

    const reRegister = await register("ios-preview-1", { deviceToken: "preview-token-2" });
    assert.equal(reRegister.status, 200, await reRegister.clone().text());
    assert.equal((await reRegister.json() as { registration: { previewMode: string } }).registration.previewMode, "hidden");
    assert.equal(await storedMode("ios-preview-1"), "hidden", "re-registering without previewMode keeps the stored mode");

    const nullMode = await register("ios-preview-1", { previewMode: null });
    assert.equal(nullMode.status, 200, await nullMode.clone().text());
    assert.equal(await storedMode("ios-preview-1"), "hidden", "previewMode null is treated as omitted");
    const nullNew = await register("ios-preview-null-new", { previewMode: null });
    assert.equal(nullNew.status, 200, await nullNew.clone().text());
    assert.equal(await storedMode("ios-preview-null-new"), "full", "a new row with previewMode null defaults to full");

    const senderOnly = await register("ios-preview-1", { previewMode: "sender_only" });
    assert.equal(senderOnly.status, 200, await senderOnly.clone().text());
    assert.equal(await storedMode("ios-preview-1"), "sender_only");

    const backToFull = await register("ios-preview-1", { previewMode: "full" });
    assert.equal(backToFull.status, 200, await backToFull.clone().text());
    assert.equal(await storedMode("ios-preview-1"), "full");

    const rejectedUpdate = await register("ios-preview-1", { previewMode: 7 });
    assert.equal(rejectedUpdate.status, 400);
    assert.equal(await storedMode("ios-preview-1"), "full", "a rejected registration never overwrites the stored mode");

    for (const unknown of ["future_mode", "FULL", ""]) {
      const res = await register("ios-preview-1", { previewMode: "full" });
      assert.equal(res.status, 200, await res.clone().text());
      const future = await register("ios-preview-1", { previewMode: unknown });
      assert.equal(future.status, 200, await future.clone().text());
      assert.equal((await future.json() as { registration: { previewMode: string } }).registration.previewMode, "hidden");
      assert.equal(await storedMode("ios-preview-1"), "hidden", `unknown previewMode ${JSON.stringify(unknown)} fails closed to hidden`);
    }
  } finally {
    await close();
  }
});

test("mobile push registrations accept the FCM tuple: colon tokens, production only", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedVerifiedUser("push-fcm-owner@slock.test", "push-fcm-owner");
    const server = await createServer("Push FCM API", "push-fcm-api", owner.id);
    const ownerToken = await login(baseUrl, owner.email);
    const fcmToken = `dGVzdA:APA91b${"x".repeat(150)}`;
    const register = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        installationId: "android-install-1",
        provider: "fcm",
        env: "production",
        topic: "build.raft.app",
        deviceToken: fcmToken,
        ...body,
      }),
    });

    const sandbox = await register({ env: "sandbox" });
    assert.equal(sandbox.status, 400, "FCM has no sandbox environment");

    const malformed = await register({ deviceToken: "token with spaces" });
    assert.equal(malformed.status, 400);

    const apnsWithColon = await register({ provider: "apns", deviceToken: fcmToken });
    assert.equal(apnsWithColon.status, 400, "APNs tokens keep their stricter shape");

    const create = await register({});
    assert.equal(create.status, 200, await create.clone().text());
    const body = await create.json() as { registration: { provider: string; env: string } };
    assert.equal(body.registration.provider, "fcm");
    assert.equal(body.registration.env, "production");

    const [row] = await getDb().select().from(pushRegistrations).where(and(
      eq(pushRegistrations.installationId, "android-install-1"),
      eq(pushRegistrations.provider, "fcm"),
    ));
    assert.equal(row?.deviceToken, fcmToken);
    assert.equal(row?.userId, owner.id);
  } finally {
    await close();
  }
});

test("push delivery status lists every server of the user as FCM-active and reports whether this installation is registered", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedVerifiedUser("push-status-owner@slock.test", "push-status-owner");
    const other = await seedVerifiedUser("push-status-other@slock.test", "push-status-other");
    const serverA = await createServer("Push Status A", "push-status-a", owner.id);
    const serverB = await createServer("Push Status B", "push-status-b", owner.id);
    const foreign = await createServer("Push Status Foreign", "push-status-foreign", other.id);
    const ownerToken = await login(baseUrl, owner.email);
    const status = async (installationId: string | null) => {
      const query = installationId === null ? "" : `?installationId=${encodeURIComponent(installationId)}`;
      return fetch(`${baseUrl}/api/push/delivery-status${query}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    };
    const read = async (installationId: string) => {
      const res = await status(installationId);
      assert.equal(res.status, 200, await res.clone().text());
      return await res.json() as { servers: Record<string, { fcmActive: boolean }>; fcmRegistered: boolean };
    };
    const servers = async (installationId: string) => (await read(installationId)).servers;
    const fcmRegistered = async (installationId: string) => (await read(installationId)).fcmRegistered;
    const setFlag = (key: string, values: { defaultEnabled?: boolean; killSwitch?: boolean }) =>
      getDb().update(featureFlags).set(values).where(eq(featureFlags.key, key));

    assert.equal((await fetch(`${baseUrl}/api/push/delivery-status?installationId=a`)).status, 401);
    assert.equal((await status(null)).status, 400);
    assert.equal((await status("bad id with spaces")).status, 400);

    // mobile_push_fcm_v0 is retired: no flag or FCM configuration is read.

    // FCM is fully rolled out: every server the user belongs to reads active
    // (older Android builds leave their own tray notifications to the server);
    // other servers are absent. Registration is reported separately.
    assert.deepEqual(await servers("android-status-1"), {
      [serverA.id]: { fcmActive: true },
      [serverB.id]: { fcmActive: true },
    });
    assert.equal(Object.hasOwn(await servers("android-status-1"), foreign.id), false);
    assert.equal(await fcmRegistered("android-status-1"), false, "no registration");

    const register = await fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(ownerToken, serverA.id),
      body: JSON.stringify({
        installationId: "android-status-1",
        provider: "fcm",
        env: "production",
        topic: "build.raft.app",
        deviceToken: "android-status-fid",
      }),
    });
    assert.equal(register.status, 200, await register.clone().text());

    // Registered while bound to server A, but delivery is per user: both servers are covered.
    assert.deepEqual(await read("android-status-1"), {
      servers: {
        [serverA.id]: { fcmActive: true },
        [serverB.id]: { fcmActive: true },
      },
      fcmRegistered: true,
    });
    assert.deepEqual(await servers("android-status-other-install"), {
      [serverA.id]: { fcmActive: true },
      [serverB.id]: { fcmActive: true },
    }, "another installation: servers still active");
    assert.equal(await fcmRegistered("android-status-other-install"), false);

    await setFlag(RETIRED_MOBILE_PUSH_DELIVERY_FLAG_KEY, { killSwitch: true });
    assert.equal((await servers("android-status-1"))[serverA.id]?.fcmActive, true, "the retired master switch no longer gates FCM");

    await getDb().delete(featureFlags).where(eq(featureFlags.key, RETIRED_MOBILE_PUSH_DELIVERY_FLAG_KEY));
    assert.equal((await servers("android-status-1"))[serverA.id]?.fcmActive, true, "removing the retired row keeps FCM active");

    assert.deepEqual(await read("android-status-1"), {
      servers: {
        [serverA.id]: { fcmActive: true },
        [serverB.id]: { fcmActive: true },
      },
      fcmRegistered: true,
    }, "still active, the registration still reported");

    await getDb().update(pushRegistrations)
      .set({ revokedAt: new Date(), userId: null, serverId: null })
      .where(eq(pushRegistrations.installationId, "android-status-1"));
    assert.equal((await servers("android-status-1"))[serverA.id]?.fcmActive, true, "a revoked registration does not change fcmActive");
    assert.equal(await fcmRegistered("android-status-1"), false, "revoked registration is not registered");
  } finally {
    await close();
  }
});

test("family revoke capability is unauthenticated, idempotent for 30 days, and terminal-invalid after retention", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
        topic: "build.raft.app",
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
        topic: "build.raft.app",
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
      body: JSON.stringify({ capability: `${capability.slice(0, -1)}${capability.endsWith("x") ? "y" : "x"}` }),
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
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
        topic: "build.raft.app",
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

test("web push subscribe stores only public HTTPS endpoints on a known push service", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  __setWebPushRuntimeForTests({ enabled: true });
  try {
    const owner = await seedVerifiedUser("push-subscribe@slock.test", "push-subscribe");
    const token = await login(baseUrl, owner.email);
    const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
    const subscribe = (endpoint: unknown) => fetch(`${baseUrl}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint, keys }),
    });

    const rejected = [
      "http://fcm.googleapis.com/fcm/send/plain-http",
      "https://8.8.8.8/push/ip-literal",
      "https://127.0.0.1:8080/push/loopback",
      "https://[::1]/push/loopback-v6",
      "https://10.0.0.5/push/private-range",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/push",
      "https://printer.local/push",
      "https://vault.internal/push",
      "https://user:secret@fcm.googleapis.com/fcm/send/userinfo",
      "not a url",
      ["https://fcm.googleapis.com/fcm/send/array"],
      // Public, but not a browser push service: never a host of the subscriber's choosing.
      "https://push.vgent.dev/push/abc",
      "https://fcm.googleapis.com.evil.example/fcm/send/abc",
      "https://test.push.service/push/abc",
      "https://permanently-removed.invalid/fcm/send/abc",
    ];
    for (const endpoint of rejected) {
      const res = await subscribe(endpoint);
      assert.equal(res.status, 400, `${JSON.stringify(endpoint)} must be refused`);
    }
    const unknownHost = await (await subscribe("https://push.vgent.dev/push/abc")).json() as { code?: string };
    assert.equal(unknownHost.code, "push_endpoint_host_not_allowed");
    assert.equal((await getDb().select().from(pushSubscriptions)).length, 0, "refused endpoints store nothing");

    const accepted = [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://db5p.notify.windows.com/w/?token=abc",
      "https://jmt17.google.com/fcm/send/abc",
    ];
    for (const endpoint of accepted) {
      const res = await subscribe(endpoint);
      assert.equal(res.status, 200, `${endpoint} must be accepted: ${await res.clone().text()}`);
    }
    const stored = (await getDb().select({ endpoint: pushSubscriptions.endpoint }).from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, owner.id))).map((row) => row.endpoint).sort();
    assert.deepEqual(stored, [...accepted].sort());
  } finally {
    __resetWebPushRuntimeForTests();
    await close();
  }
});

test("web push subscribe with oldEndpoint replaces the old subscription", async () => {
  __setWebPushRuntimeForTests({ enabled: true });
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedVerifiedUser("push-rotate@slock.test", "push-rotate");
    const token = await login(baseUrl, owner.email);
    const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
    const subscribe = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ keys, ...body }),
    });
    const endpoints = async () => (await getDb().select({ endpoint: pushSubscriptions.endpoint }).from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, owner.id))).map((row) => row.endpoint).sort();

    assert.equal((await subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/old" })).status, 200);
    assert.equal((await subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/other" })).status, 200);
    assert.equal((await subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/new", oldEndpoint: 7 })).status, 400);
    // Another user's row with the same endpoint is not the caller's to replace.
    const stranger = await seedVerifiedUser("push-rotate-stranger@slock.test", "push-rotate-stranger");
    await getDb().insert(pushSubscriptions).values({ userId: stranger.id, endpoint: "https://fcm.googleapis.com/fcm/send/old", p256dh: keys.p256dh, auth: keys.auth });
    const rotated = await subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/new", oldEndpoint: "https://fcm.googleapis.com/fcm/send/old" });
    assert.equal(rotated.status, 200, await rotated.clone().text());
    assert.deepEqual(await endpoints(), ["https://fcm.googleapis.com/fcm/send/new", "https://fcm.googleapis.com/fcm/send/other"]);
    assert.equal((await getDb().select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, stranger.id))).length, 1);
  } finally {
    __resetWebPushRuntimeForTests();
    await close();
  }
});

test("mobile registrations carry the device's alert switch and OS permission; PATCH updates only the caller's installation", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedVerifiedUser("push-device-owner@slock.test", "push-device-owner");
    const other = await seedVerifiedUser("push-device-other@slock.test", "push-device-other");
    const server = await createServer("Push Device", "push-device", owner.id);
    await addMember(server.id, other.id);
    const ownerToken = await login(baseUrl, owner.email);
    const otherToken = await login(baseUrl, other.email);
    const register = (body: Record<string, unknown> = {}) => fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ installationId: "ios-device-1", provider: "apns", env: "production", topic: "build.raft.app", deviceToken: "device-token", ...body }),
    });
    const stored = async () => {
      const [row] = await getDb().select().from(pushRegistrations).where(eq(pushRegistrations.installationId, "ios-device-1"));
      return row!;
    };

    assert.equal((await register({ alertsEnabled: "no" })).status, 400);
    assert.equal((await register({ osPermission: 1 })).status, 400);
    const first = await register({ alertsEnabled: false, osPermission: "denied" });
    assert.equal(first.status, 200, await first.clone().text());
    const firstBody = await first.json() as { registration: { alertsEnabled: boolean; osPermission: string } };
    assert.equal(firstBody.registration.alertsEnabled, false);
    assert.equal(firstBody.registration.osPermission, "denied");
    const firstRow = await stored();
    assert.ok(firstRow.lastRegisteredAt, "last_registered_at is written");

    assert.equal((firstBody.registration as unknown as { previewKeySet: number }).previewKeySet, 1, "NULL reads as key set 1");
    assert.equal((await register({ previewKeySet: 0 })).status, 400);
    assert.equal((await register({ previewKeySet: "2" })).status, 400);
    const keySet = await register({ previewKeySet: 2 });
    assert.equal(((await keySet.json()) as { registration: { previewKeySet: number } }).registration.previewKeySet, 2);
    await register();
    assert.equal((await stored()).previewKeySet, 2, "omitted keeps the stored key set");

    // Omitted keeps the stored values; an unknown permission reads as unknown.
    await register();
    assert.deepEqual([(await stored()).alertsEnabled, (await stored()).osPermission], [false, "denied"]);
    await register({ osPermission: "ephemeral" });
    assert.equal((await stored()).osPermission, "unknown");

    const patch = (token: string, body: unknown, installationId = "ios-device-1") => fetch(`${baseUrl}/api/push/registrations/${installationId}`, {
      method: "PATCH",
      headers: headers(token, server.id),
      body: JSON.stringify(body),
    });
    assert.equal((await patch(ownerToken, {})).status, 400);
    assert.equal((await patch(ownerToken, { alertsEnabled: "yes" })).status, 400);
    assert.equal((await patch(otherToken, { alertsEnabled: true })).status, 404, "not the caller's installation");
    assert.equal((await patch(ownerToken, { alertsEnabled: true }, "ios-device-missing")).status, 404);
    const updated = await patch(ownerToken, { alertsEnabled: true, osPermission: "granted" });
    assert.equal(updated.status, 200, await updated.clone().text());
    const updatedBody = await updated.json() as { ok: boolean; registration: { installationId: string; alertsEnabled: boolean; osPermission: string } };
    assert.equal(updatedBody.ok, true);
    assert.deepEqual([updatedBody.registration.installationId, updatedBody.registration.alertsEnabled, updatedBody.registration.osPermission], ["ios-device-1", true, "granted"]);
    assert.deepEqual([(await stored()).alertsEnabled, (await stored()).osPermission], [true, "granted"]);
  } finally {
    await close();
  }
});

test("an older app's previewMode reaches the account setting only when it changed since that registration's last report", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedVerifiedUser("push-compat@slock.test", "push-compat");
    const server = await createServer("Push Compat", "push-compat", owner.id);
    const token = await login(baseUrl, owner.email);
    const register = (installationId: string, previewMode?: string) => fetch(`${baseUrl}/api/push/registrations`, {
      method: "POST",
      headers: headers(token, server.id),
      body: JSON.stringify({ installationId, provider: "apns", env: "production", topic: "build.raft.app", deviceToken: `t-${installationId}`, ...(previewMode ? { previewMode } : {}) }),
    });
    const account = async () => {
      const res = await fetch(`${baseUrl}/api/me/notification-settings`, { headers: { Authorization: `Bearer ${token}` } });
      return (await res.json() as { settings: { previewMode: string; version: number } }).settings;
    };
    const setAccount = (previewMode: string) => fetch(`${baseUrl}/api/me/notification-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ previewMode }),
    });

    // A first report as loose as the account changes nothing.
    assert.equal((await register("old-ios", "full")).status, 200);
    const untouched = await account();
    assert.deepEqual([untouched.previewMode, untouched.version], ["full", 0]);
    // The user changes it in the old app: adopted.
    await register("old-ios", "hidden");
    assert.equal((await account()).previewMode, "hidden");
    // The new UI loosens it; the old app keeps reporting the same value: ignored.
    assert.equal((await setAccount("full")).status, 200);
    await register("old-ios", "hidden");
    assert.equal((await account()).previewMode, "full", "an unchanged report never overrides the account");
    // A new client omits it.
    await register("old-ios");
    assert.equal((await account()).previewMode, "full");
    // Changed in the old app again: adopted.
    await register("old-ios", "sender_only");
    assert.equal((await account()).previewMode, "sender_only");
    // Another fresh install: a looser first report is not adopted, a stricter one is.
    await register("fresh-1", "full");
    assert.equal((await account()).previewMode, "sender_only");
    await register("fresh-2", "hidden");
    assert.equal((await account()).previewMode, "hidden");
  } finally {
    await close();
  }
});

test("the deprecated POST /push/test answers as before when Web Push is off or the user has no subscription", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedVerifiedUser("push-legacy-test@slock.test", "push-legacy-test");
    await createServer("Push Legacy Test", "push-legacy-test", owner.id);
    const token = await login(baseUrl, owner.email);
    const send = () => fetch(`${baseUrl}/api/push/test`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    __setWebPushRuntimeForTests({ enabled: false });
    assert.equal((await send()).status, 503);
    __setWebPushRuntimeForTests({ enabled: true });
    const none = await send();
    assert.equal(none.status, 409);
    assert.deepEqual(await none.json(), { error: "No push subscription found for this user on this server" });
  } finally {
    __resetWebPushRuntimeForTests();
    await close();
  }
});

// The web push funnel (cindyz, #proj-analytics:fbb8f05c): the banner's Dismiss and Settings link,
// and This device's turn-off and test result, land next to the prompt events; anything else is refused.
test("push prompt events accept the banner and This device events and refuse unknown ones", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const person = await seedVerifiedUser("push-prompt-events@slock.test", "push-prompt-events");
    const token = await login(baseUrl, person.email);
    const post = (body: unknown) => fetch(`${baseUrl}/api/push/prompt-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const accepted = [
      { event: "web_push_prompt_dismissed", trigger: "primary_composer_activation_banner", permissionBefore: "default", permissionAfter: "default" },
      { event: "web_push_prompt_settings_opened", trigger: "primary_composer_activation_banner" },
      { event: "web_push_disabled", trigger: "settings_this_device", result: "ok" },
      { event: "web_push_test_result", trigger: "settings_this_device", result: "failed", detail: "reason=no_device" },
      // A delivery diagnostic keeps its free detail (#13764's failure detail).
      { event: "web_push_subscription_failed", trigger: "settings_this_device", result: "error", detail: "browser=brave;kind=push_subscribe;name=AbortError" },
    ];
    for (const body of accepted) assert.equal((await post(body)).status, 200, body.event);
    assert.equal((await post({ event: "web_push_prompt_clicked_everything", trigger: "x" })).status, 400);
    // Only a test failure's fixed code is kept as an interaction row's detail.
    const strayDetails = [
      { event: "web_push_test_result", trigger: "settings_this_device", result: "failed", detail: "Failed to send test notification" },
      { event: "web_push_prompt_dismissed", trigger: "primary_composer_activation_banner", detail: "reason=no_device" },
      { event: "web_push_test_result", trigger: "settings_this_device", result: "failed", detail: "reason=no_device extra text" },
      { event: "web_push_test_result", trigger: "settings_this_device", result: "failed", detail: "reason=unknown_code" },
    ];
    for (const body of strayDetails) assert.equal((await post(body)).status, 200, `${body.event} stray detail`);

    const rows = await getDb().select().from(webPushPromptEvents).where(eq(webPushPromptEvents.userId, person.id));
    assert.deepEqual(
      rows.map((row) => [row.event, row.trigger, row.result, row.detail]).sort(),
      [...accepted, ...strayDetails.map((body) => ({ ...body, detail: undefined }))]
        .map((body) => [body.event, body.trigger, body.result ?? null, body.detail ?? null]).sort(),
    );
  } finally {
    await close();
  }
});

test("the interaction rows follow Share usage data and the workspace switch; delivery diagnostics do not", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const sharer = await seedVerifiedUser("push-prompt-sharer@slock.test", "push-prompt-sharer");
    const optedOut = await seedVerifiedUser("push-prompt-optout@slock.test", "push-prompt-optout");
    await getDb().update(users).set({ shareUsageData: false }).where(eq(users.id, optedOut.id));
    const server = await createServer("Prompt events off", "prompt-events-off", sharer.id);
    await getDb().update(servers).set({ productAnalyticsEnabled: false }).where(eq(servers.id, server.id));
    const post = async (email: string, body: unknown, serverId?: string) => {
      const token = await login(baseUrl, email);
      return fetch(`${baseUrl}/api/push/prompt-events`, {
        method: "POST",
        headers: serverId ? headers(token, serverId) : { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    };
    const dismissed = { event: "web_push_prompt_dismissed", trigger: "primary_composer_activation_banner" };
    const shown = { event: "web_push_prompt_shown", trigger: "primary_composer_activation_banner" };

    for (const body of [dismissed, shown]) assert.equal((await post(optedOut.email, body)).status, 200, `opted out: ${body.event}`);
    for (const body of [dismissed, shown]) assert.equal((await post(sharer.email, body, server.id)).status, 200, `workspace off: ${body.event}`);
    assert.equal((await post(sharer.email, dismissed)).status, 200, "sharing, no workspace named");

    const events = async (userId: string) => (await getDb().select().from(webPushPromptEvents).where(eq(webPushPromptEvents.userId, userId)))
      .map((row) => [row.event, row.serverId]).sort();
    assert.deepEqual(await events(optedOut.id), [["web_push_prompt_shown", null]], "opted out: the diagnostic only");
    assert.deepEqual(await events(sharer.id), [
      ["web_push_prompt_dismissed", null],
      ["web_push_prompt_shown", server.id],
    ], "workspace off: the diagnostic only; with no workspace named, the sharer's choice decides");
  } finally {
    await close();
  }
});
