import assert from "node:assert/strict";
import {
  isDesktopNotificationRoute,
  parseDesktopNotificationV1,
  parseNotificationEnvelopeFields,
} from "@botiverse/raft-shared";
import { buildTestNotification, parseTestNotificationDevice } from "./testNotification";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

test("the test notification is a valid desktop payload; mobile gets no route and opens Activity", () => {
  const built = buildTestNotification({
    testId: "t-1",
    serverId: SERVER_ID,
    serverName: "Acme",
    serverSlug: "acme",
    createdAt: new Date("2026-10-30T10:00:00.000Z"),
  });
  const parsed = parseDesktopNotificationV1(built.envelope);
  assert.ok(parsed, "older desktops parse it");
  assert.equal(parsed.id, "test:t-1");
  assert.equal(parsed.event, "test");
  assert.equal(parsed.kind, "mention");
  assert.equal(parsed.title, "Raft test notification");
  assert.equal(parsed.url, "/s/acme/activity");
  assert.equal(parsed.mentioned, false);
  assert.ok(isDesktopNotificationRoute(parsed.url));
  assert.deepEqual(parseNotificationEnvelopeFields(built.envelope), {
    category: "test",
    priority: "high",
    seq: null,
    conversationId: null,
    silent: false,
    previewMode: "full",
    testId: "t-1",
    // The title and body are fixed phrases (contract §1.5); the server label subtitle is a name.
    localization: { titleKey: "push.title.test", titleArgs: [], bodyKey: "push.body.test", bodyArgs: [] },
  });
  assert.deepEqual(built.push.localization, { titleKey: "push.title.test", bodyKey: "push.body.test", bodyArgs: [] });
  assert.equal(built.routeUrl, "/s/acme/activity");
  assert.equal(built.route, null);
  assert.equal(built.envelope.groupKey, `${SERVER_ID}:test`);
  assert.equal(built.mobile.channelId, null);
  assert.equal(built.mobile.kind, null);
  assert.equal(built.push.body, "If you can read this, notifications reach this device.");
  // Not knowing the caller's server count, the test names its server (fail safe).
  assert.equal(built.push.title, "Raft test notification");
  assert.equal(built.push.subtitle, "Acme");
  assert.equal(built.envelope.subtitle, "Acme");
});

test("a caller in one server gets no server label; in several, the server subtitle", () => {
  const input = { testId: "t-2", serverId: SERVER_ID, serverName: "Acme", serverSlug: "acme", createdAt: new Date("2026-10-30T10:00:00.000Z") };
  const single = buildTestNotification({ ...input, multiServer: false });
  assert.equal(single.push.title, "Raft test notification");
  assert.equal("subtitle" in single.push, false);
  assert.equal("subtitle" in single.envelope, false);
  assert.equal(single.push.serverName, "Acme");
  assert.ok(parseDesktopNotificationV1(single.envelope));
  const multi = buildTestNotification({ ...input, multiServer: true });
  assert.equal(multi.push.subtitle, "Acme");
  assert.equal(multi.envelope.subtitle, "Acme");
});

test("device parsing keeps only the known kinds and string identifiers", () => {
  assert.deepEqual(parseTestNotificationDevice({ kind: "desktop", socketId: "abc", endpoint: 3 }), { kind: "desktop", socketId: "abc" });
  assert.deepEqual(parseTestNotificationDevice({ kind: "mobile", installationId: "i-1" }), { kind: "mobile", installationId: "i-1" });
  assert.deepEqual(parseTestNotificationDevice({ kind: "web", endpoint: "" }), { kind: "web" });
  assert.equal(parseTestNotificationDevice({ kind: "watch" }), null);
  assert.equal(parseTestNotificationDevice(null), null);
  assert.equal(parseTestNotificationDevice([]), null);
});
