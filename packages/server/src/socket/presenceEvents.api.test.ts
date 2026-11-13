import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createApiTest } from "../test/integration/apiTest";
import { seedThreadFixture } from "../routes/channels.api.fixtures";
import {
  __resetNotificationPresenceForTests,
  isPresenceActive,
  isPresenceOnline,
  loadNotificationPresence,
} from "../services/notifications/presence";
import type { NotificationDeviceKind } from "../services/notifications/types";

// End to end over a real socket: each client records presence under its own
// connection kind; the legacy desktop alias works only on a desktop socket.

const requireWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client");
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const waitEvent = (socket: any, event: string, timeoutMs = 4_000) => new Promise<any>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no ${event}`)), timeoutMs);
  socket.once(event, (value: any) => { clearTimeout(timer); resolve(value); });
});

async function activeKinds(userId: string): Promise<NotificationDeviceKind[]> {
  const now = Date.now();
  const presence = (await loadNotificationPresence([userId], now)).get(userId) ?? {};
  return (["desktop", "web", "mobile"] as const).filter((kind) => isPresenceActive(presence[kind], now));
}

async function waitForKinds(userId: string, expected: NotificationDeviceKind[], timeoutMs = 2_000): Promise<NotificationDeviceKind[]> {
  const deadline = Date.now() + timeoutMs;
  let kinds = await activeKinds(userId);
  while (JSON.stringify(kinds) !== JSON.stringify(expected) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    kinds = await activeKinds(userId);
  }
  return kinds;
}

async function connect(baseUrl: string, token: string, serverId: string, clientKind: string) {
  const socket = clientIo(baseUrl, { auth: { token, serverId, clientKind }, transports: ["websocket"], autoConnect: false });
  const ready = waitEvent(socket, "rooms:joined");
  socket.connect();
  await ready;
  return socket;
}

test("presence:activity records under the socket's own kind; the desktop alias needs a desktop socket", async ({ app }) => {
  __resetNotificationPresenceForTests();
  const f = await seedThreadFixture(app.baseUrl);
  const browser = await connect(app.baseUrl, f.followerToken, f.serverId, "web");
  const desktop = await connect(app.baseUrl, f.ownerToken, f.serverId, "desktop");
  try {
    // A browser cannot claim to be the desktop app.
    browser.emit("desktop:input-presence", { attended: true, idleSeconds: 0 });
    desktop.emit("desktop:input-presence", { attended: true, idleSeconds: 0 });
    assert.deepEqual(await waitForKinds(f.ownerId, ["desktop"]), ["desktop"]);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await activeKinds(f.followerId), []);

    browser.emit("presence:activity", { active: true, idleSeconds: 0 });
    assert.deepEqual(await waitForKinds(f.followerId, ["web"]), ["web"]);

    desktop.emit("presence:activity", { active: false, idleSeconds: 30 });
    assert.deepEqual(await waitForKinds(f.ownerId, []), [], "a stop clears at once");
  } finally {
    browser.close();
    desktop.close();
    __resetNotificationPresenceForTests();
  }
});

test("a disconnect clears the input of an active socket", async ({ app }) => {
  __resetNotificationPresenceForTests();
  const f = await seedThreadFixture(app.baseUrl);
  const browser = await connect(app.baseUrl, f.ownerToken, f.serverId, "web");
  try {
    browser.emit("presence:activity", { active: true, idleSeconds: 0 });
    assert.deepEqual(await waitForKinds(f.ownerId, ["web"]), ["web"]);
    browser.close();
    assert.deepEqual(await waitForKinds(f.ownerId, []), []);
  } finally {
    browser.close();
    __resetNotificationPresenceForTests();
  }
});

test("two tabs: an idle background tab does not clear the tab in use", async ({ app }) => {
  __resetNotificationPresenceForTests();
  const f = await seedThreadFixture(app.baseUrl);
  const tabA = await connect(app.baseUrl, f.ownerToken, f.serverId, "web");
  const tabB = await connect(app.baseUrl, f.ownerToken, f.serverId, "web");
  try {
    tabA.emit("presence:activity", { active: true, idleSeconds: 0 });
    assert.deepEqual(await waitForKinds(f.ownerId, ["web"]), ["web"]);
    tabB.emit("presence:activity", { active: false, idleSeconds: null });
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(await activeKinds(f.ownerId), ["web"], "tab B's stop is its own");

    tabA.emit("presence:activity", { active: false, idleSeconds: null });
    assert.deepEqual(await waitForKinds(f.ownerId, []), [], "tab A's stop is immediate");

    tabA.close();
    await new Promise((r) => setTimeout(r, 150));
    const now = Date.now();
    const web = (await loadNotificationPresence([f.ownerId], now)).get(f.ownerId)?.web;
    assert.equal(isPresenceOnline(web, now), true, "tab B keeps web online");

    tabB.close();
    const deadline = Date.now() + 2_000;
    let gone = false;
    while (!gone && Date.now() < deadline) {
      gone = (await loadNotificationPresence([f.ownerId], Date.now())).get(f.ownerId)?.web === undefined;
      if (!gone) await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(gone, true, "the last tab going away makes web offline");
  } finally {
    tabA.close();
    tabB.close();
    __resetNotificationPresenceForTests();
  }
});
