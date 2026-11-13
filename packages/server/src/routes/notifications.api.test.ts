import { apiTest as test } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";

import { pushRegistrations, pushSubscriptions } from "../db/schema";
import {
  __resetApnsPushProviderForTests,
  __setApnsPushProviderForTests,
  type ApnsDeliveryInput,
} from "../services/notifications/transports/apns";
import {
  __resetFcmPushProviderForTests,
  __setFcmPushProviderForTests,
} from "../services/notifications/transports/fcm";
import type { FcmDeliveryInput } from "../services/fcmPushProvider";
import {
  __resetWebPushRuntimeForTests,
  __setWebPushRuntimeForTests,
} from "../services/notifications/transports/webPush";
import {
  __resetTestNotificationStoreForTests,
  __setTestNotificationClockForTests,
  sendTestNotification,
} from "../services/notifications/testNotification";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/notification-test";
const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

type Http = { request(path: string, init: RequestInit): Promise<Response>; get(path: string): Promise<Response> };

function postJson(client: Http, path: string, body: unknown) {
  return client.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function captureWebPush() {
  const sent: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async () => [{ address: "142.250.72.10", family: 4 }],
    sendNotification: async (subscription, payload) => {
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(String(payload)) as Record<string, unknown> });
      return { statusCode: 201, body: "", headers: {} };
    },
  });
  return sent;
}

function withClock() {
  let now = Date.parse("2026-10-30T10:00:00.000Z");
  __setTestNotificationClockForTests(() => now);
  return { advance(ms: number) { now += ms; } };
}

function resetSeams() {
  __resetWebPushRuntimeForTests();
  __resetApnsPushProviderForTests();
  __resetFcmPushProviderForTests();
  __setTestNotificationClockForTests(null);
  __resetTestNotificationStoreForTests();
}

test("a web test notification is sent to that subscription, reads pending, and shown after the ack", async ({ seed, http, db }) => {
  const sent = captureWebPush();
  withClock();
  try {
    const user = await seed.human();
    const server = await seed.server({ owner: user, slug: "notif-test" });
    await db.insert(pushSubscriptions).values([
      { userId: user.id, endpoint: ENDPOINT, ...KEYS },
      { userId: user.id, endpoint: `${ENDPOINT}-other`, ...KEYS },
    ]);
    const client = http.as(user, server);

    const response = await postJson(client, "/api/notifications/test", { device: { kind: "web", endpoint: ENDPOINT } });
    assert.equal(response.status, 200);
    const body = await response.json() as { testId: string; sent: boolean };
    assert.equal(body.sent, true);
    assert.match(body.testId, /^[0-9a-f-]{36}$/);

    assert.equal(sent.length, 1, "only the named subscription gets it");
    assert.equal(sent[0].endpoint, ENDPOINT);
    assert.equal(sent[0].payload.testId, body.testId);
    assert.equal(sent[0].payload.id, `test:${body.testId}`);
    assert.equal(sent[0].payload.category, "test");
    assert.equal(sent[0].payload.title, "Raft test notification", "a caller in one server: no server label");
    assert.equal("subtitle" in sent[0].payload, false);
    assert.match(String(sent[0].payload.url), /^https?:\/\/[^/]+\/s\/notif-test\/activity$/);

    const pending = await client.get(`/api/notifications/test/${body.testId}`);
    assert.equal(pending.status, 200);
    assert.deepEqual(await pending.json(), { status: "pending" });

    const ack = await postJson(client, `/api/notifications/test/${body.testId}/ack`, { shown: true });
    assert.equal(ack.status, 200);
    assert.deepEqual(await ack.json(), { ok: true });
    assert.deepEqual(await (await client.get(`/api/notifications/test/${body.testId}`)).json(), { status: "shown" });
  } finally {
    resetSeams();
  }
});

test("a pending test with no ack for 15 s reads not_shown; an explicit not-shown ack is kept", async ({ seed, http, db }) => {
  captureWebPush();
  const clock = withClock();
  try {
    const user = await seed.human();
    const server = await seed.server({ owner: user });
    await db.insert(pushSubscriptions).values({ userId: user.id, endpoint: ENDPOINT, ...KEYS });
    const client = http.as(user, server);

    const { testId } = await (await postJson(client, "/api/notifications/test", { device: { kind: "web", endpoint: ENDPOINT } })).json() as { testId: string };
    clock.advance(14_999);
    assert.deepEqual(await (await client.get(`/api/notifications/test/${testId}`)).json(), { status: "pending" });
    clock.advance(1);
    assert.deepEqual(await (await client.get(`/api/notifications/test/${testId}`)).json(), { status: "not_shown" });

    const second = await (await postJson(client, "/api/notifications/test", { device: { kind: "web", endpoint: ENDPOINT } })).json() as { testId: string };
    assert.equal((await postJson(client, `/api/notifications/test/${second.testId}/ack`, { shown: false })).status, 200);
    assert.deepEqual(await (await client.get(`/api/notifications/test/${second.testId}`)).json(), { status: "not_shown" });
    assert.equal((await postJson(client, `/api/notifications/test/${second.testId}/ack`, { shown: "yes" })).status, 400);
  } finally {
    resetSeams();
  }
});

test("an unknown device answers sent:false no_device and reads failed", async ({ seed, http, db }) => {
  const sent = captureWebPush();
  withClock();
  try {
    const user = await seed.human();
    const other = await seed.human();
    const server = await seed.server({ owner: user });
    // Another user's subscription with the same endpoint is not the caller's device.
    await db.insert(pushSubscriptions).values({ userId: other.id, endpoint: ENDPOINT, ...KEYS });
    const client = http.as(user, server);

    for (const device of [
      { kind: "web", endpoint: ENDPOINT },
      { kind: "web" },
      { kind: "mobile", installationId: "missing-install" },
      { kind: "desktop", socketId: "not-connected" },
    ]) {
      const response = await postJson(client, "/api/notifications/test", { device });
      assert.equal(response.status, 200);
      const body = await response.json() as { testId: string; sent: boolean; reason?: string };
      assert.equal(body.sent, false, JSON.stringify(device));
      assert.equal(body.reason, "no_device");
      assert.deepEqual(await (await client.get(`/api/notifications/test/${body.testId}`)).json(), { status: "failed", reason: "no_device" });
    }
    assert.equal(sent.length, 0);

    assert.equal((await postJson(client, "/api/notifications/test", { device: { kind: "watch" } })).status, 400);
    assert.equal((await postJson(http.as(user), "/api/notifications/test", { device: { kind: "web" } })).status, 400, "the server header is required");
  } finally {
    resetSeams();
  }
});

test("a web subscription whose endpoint is not public is deleted and reported as no_device", async ({ seed, http, db }) => {
  let sends = 0;
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async () => [{ address: "10.0.0.5", family: 4 }],
    sendNotification: async () => {
      sends += 1;
      return { statusCode: 201, body: "", headers: {} };
    },
  });
  try {
    const user = await seed.human();
    const server = await seed.server({ owner: user });
    await db.insert(pushSubscriptions).values({ userId: user.id, endpoint: "https://fcm.googleapis.com/fcm/send/private-range", ...KEYS });

    const body = await (await postJson(http.as(user, server), "/api/notifications/test", {
      device: { kind: "web", endpoint: "https://fcm.googleapis.com/fcm/send/private-range" },
    })).json() as { sent: boolean; reason?: string };
    assert.deepEqual({ sent: body.sent, reason: body.reason }, { sent: false, reason: "no_device" });
    assert.equal(sends, 0);
    assert.deepEqual(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id)), []);
  } finally {
    resetSeams();
  }
});

test("another user's test id is not found for status or ack", async ({ seed, http, db }) => {
  captureWebPush();
  withClock();
  try {
    const owner = await seed.human();
    const intruder = await seed.human();
    const server = await seed.server({ owner, members: [intruder] });
    await db.insert(pushSubscriptions).values({ userId: owner.id, endpoint: ENDPOINT, ...KEYS });

    const { testId } = await (await postJson(http.as(owner, server), "/api/notifications/test", {
      device: { kind: "web", endpoint: ENDPOINT },
    })).json() as { testId: string };

    const intruderClient = http.as(intruder, server);
    assert.equal((await intruderClient.get(`/api/notifications/test/${testId}`)).status, 404);
    assert.equal((await postJson(intruderClient, `/api/notifications/test/${testId}/ack`, { shown: true })).status, 404);
    assert.equal((await intruderClient.get("/api/notifications/test/00000000-0000-4000-8000-000000000000")).status, 404);
    assert.equal((await intruderClient.get("/api/notifications/test/not-a-uuid")).status, 404);
    // The intruder's ack changed nothing.
    assert.deepEqual(await (await http.as(owner).get(`/api/notifications/test/${testId}`)).json(), { status: "pending" });
  } finally {
    resetSeams();
  }
});

test("a mobile test goes to that live registration as an alert carrying testId", async ({ seed, http, db }) => {
  const apns: ApnsDeliveryInput[] = [];
  const fcm: FcmDeliveryInput[] = [];
  __setApnsPushProviderForTests({ send: async (input) => { apns.push(input); return { status: "sent" }; } });
  __setFcmPushProviderForTests({ send: async (input) => { fcm.push(input); return { status: "sent" }; } });
  withClock();
  try {
    const user = await seed.human();
    const server = await seed.server({ owner: user });
    const registration = (env: "sandbox" | "production", provider: "apns" | "fcm", installationId: string, revoked = false) => ({
      installationId,
      provider,
      userId: user.id,
      serverId: server.id,
      deviceToken: `${installationId}-token`,
      topic: "build.raft.app",
      env,
      ...(revoked ? { revokedAt: new Date(), revokedReason: "test" } : {}),
    });
    await db.insert(pushRegistrations).values([
      registration("production", "apns", "ios-install"),
      registration("production", "apns", "ios-other"),
      registration("production", "fcm", "android-install"),
      registration("production", "apns", "ios-revoked", true),
    ]);
    const client = http.as(user, server);

    const ios = await (await postJson(client, "/api/notifications/test", { device: { kind: "mobile", installationId: "ios-install" } })).json() as { testId: string; sent: boolean };
    assert.equal(ios.sent, true);
    assert.equal(apns.length, 1);
    assert.equal(apns[0].deviceToken, "ios-install-token");
    assert.equal(apns[0].request.pushType, "alert");
    assert.equal(apns[0].request.body.testId, ios.testId);
    assert.equal(apns[0].request.body.raftCategory, "test");
    assert.equal(apns[0].request.body.id, `test:${ios.testId}`);
    assert.equal((apns[0].request.body.aps as { alert: { title: string } }).alert.title, "Raft test notification");
    assert.equal("badge" in (apns[0].request.body.aps as object), false, "a test leaves the badge alone");

    const android = await (await postJson(client, "/api/notifications/test", { device: { kind: "mobile", installationId: "android-install" } })).json() as { testId: string; sent: boolean };
    assert.equal(android.sent, true);
    assert.equal(fcm.length, 1);
    assert.equal(fcm[0].message.data.testId, android.testId);
    assert.equal(fcm[0].message.data.category, "test");
    assert.equal(fcm[0].message.priority, "HIGH");

    const revoked = await (await postJson(client, "/api/notifications/test", { device: { kind: "mobile", installationId: "ios-revoked" } })).json() as { sent: boolean; reason?: string };
    assert.deepEqual({ sent: revoked.sent, reason: revoked.reason }, { sent: false, reason: "no_device" });
    assert.equal(apns.length, 1);
  } finally {
    resetSeams();
  }
});

test("a provider failure or missing configuration is reported and stored as failed", async ({ seed, http, db }) => {
  let next: () => Promise<{ status: "sent" | "skipped"; reason?: string }> = async () => {
    throw Object.assign(new Error("APNs down"), { statusCode: 503 });
  };
  __setApnsPushProviderForTests({ send: () => next() });
  withClock();
  try {
    const user = await seed.human();
    const server = await seed.server({ owner: user });
    await db.insert(pushRegistrations).values({
      installationId: "ios-install",
      provider: "apns",
      userId: user.id,
      serverId: server.id,
      deviceToken: "token",
      topic: "build.raft.app",
      env: "production",
    });
    const client = http.as(user, server);

    const failed = await (await postJson(client, "/api/notifications/test", { device: { kind: "mobile", installationId: "ios-install" } })).json() as { testId: string; sent: boolean; reason?: string };
    assert.deepEqual({ sent: failed.sent, reason: failed.reason }, { sent: false, reason: "provider_error" });
    assert.deepEqual(await (await client.get(`/api/notifications/test/${failed.testId}`)).json(), { status: "failed", reason: "provider_error" });

    next = async () => ({ status: "skipped", reason: "provider_not_configured" });
    const skipped = await (await postJson(client, "/api/notifications/test", { device: { kind: "mobile", installationId: "ios-install" } })).json() as { sent: boolean; reason?: string };
    assert.deepEqual({ sent: skipped.sent, reason: skipped.reason }, { sent: false, reason: "provider_not_configured" });
  } finally {
    resetSeams();
  }
});

test("a desktop test is emitted only to the caller's connected desktop socket", async ({ seed }) => {
  withClock();
  try {
    const user = await seed.human();
    const server = await seed.server({ owner: user });
    const emitted: Array<{ socketId: string; event: string; payload: Record<string, unknown> }> = [];
    const sockets = [
      { id: "desktop-1", data: { userId: user.id, clientKind: "desktop" } },
      { id: "web-1", data: { userId: user.id, clientKind: "web" } },
      { id: "foreign-desktop", data: { userId: "someone-else", clientKind: "desktop" } },
    ].map((socket) => ({
      ...socket,
      emit(event: string, payload: Record<string, unknown>) {
        emitted.push({ socketId: socket.id, event, payload });
        return true;
      },
    }));
    const io = {
      in(room: string) {
        return { fetchSockets: async () => sockets.filter((socket) => socket.id === room) };
      },
    } as unknown as SocketServer;

    const sent = await sendTestNotification({ io, userId: user.id, serverId: server.id, device: { kind: "desktop", socketId: "desktop-1" } });
    assert.equal(sent.sent, true);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].socketId, "desktop-1");
    assert.equal(emitted[0].event, "notification:desktop");
    assert.equal(emitted[0].payload.testId, sent.testId);
    assert.equal(emitted[0].payload.event, "test");
    assert.equal(emitted[0].payload.url, `/s/${server.slug}/activity`);

    for (const socketId of ["web-1", "foreign-desktop", "gone"]) {
      const result = await sendTestNotification({ io, userId: user.id, serverId: server.id, device: { kind: "desktop", socketId } });
      assert.deepEqual({ sent: result.sent, reason: "reason" in result ? result.reason : undefined }, { sent: false, reason: "no_device" }, socketId);
    }
    assert.equal(emitted.length, 1);
  } finally {
    resetSeams();
  }
});
