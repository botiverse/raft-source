import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isNotificationQuiet,
  isWithinQuietHours,
  legacyNotificationRoute,
  notificationBadgeCount,
  notificationRoutePath,
  parseNotificationEnvelopeFields,
  parseNotificationRetractPayload,
  parseNotificationRoute,
  parsePresenceActivityReport,
  resolveEffectiveLevel,
  strictestPreviewMode,
  type NotificationLevel,
  type NotificationLevelSetting,
  type NotificationRoute,
} from "./notifications";

type LevelCase = {
  name: string;
  server: NotificationLevel;
  channel: NotificationLevelSetting | null;
  thread: NotificationLevelSetting | null;
  muted: boolean;
  effective: NotificationLevel;
};

const fixture = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../../docs/contracts/fixtures/notification-levels.json"), "utf8"),
) as { cases: LevelCase[] };

describe("resolveEffectiveLevel", () => {
  for (const c of fixture.cases) {
    test(c.name, () => {
      assert.equal(resolveEffectiveLevel({ server: c.server, channel: c.channel, thread: c.thread, muted: c.muted }), c.effective);
    });
  }
});

test("routes build the app paths the web parses, and survive a JSON round trip", () => {
  const routes: Array<[NotificationRoute, string]> = [
    [{ type: "channel", serverId: "s", channelId: "c", messageId: "m" }, "/s/acme/channel/c?msg=m"],
    [{ type: "dm", serverId: "s", channelId: "d", messageId: null }, "/s/acme/dm/d"],
    [
      { type: "thread", serverId: "s", parentChannelId: "c", parentChannelType: "channel", parentMessageId: "pm", messageId: "m" },
      "/s/acme/channel/c?thread=c%3Apm&msg=m",
    ],
    [
      { type: "task", serverId: "s", parentChannelId: "c", parentChannelType: "dm", taskId: "t", messageId: "m" },
      "/s/acme/dm/c?task=c%3Atask%3At",
    ],
    [{ type: "agent", serverId: "s", agentId: "a" }, "/s/acme/agent/a"],
  ];
  for (const [route, path] of routes) {
    assert.equal(notificationRoutePath(route, "acme"), path);
    assert.deepEqual(parseNotificationRoute(JSON.parse(JSON.stringify(route))), route);
  }
  assert.equal(parseNotificationRoute({ type: "task", serverId: "s" }), null);
  assert.equal(parseNotificationRoute({ type: "nope", serverId: "s" }), null);
});

test("the legacy route of a task opens its parent conversation", () => {
  assert.deepEqual(
    legacyNotificationRoute({ type: "task", serverId: "s", parentChannelId: "c", parentChannelType: "channel", taskId: "t", messageId: "m" }),
    { type: "channel", serverId: "s", channelId: "c", messageId: "m" },
  );
});

test("quiet hours span midnight in the given time zone", () => {
  const quiet = { enabled: true, startMinute: 22 * 60, endMinute: 8 * 60, timeZone: "Asia/Tokyo" };
  // 23:30 in Tokyo = 14:30 UTC
  assert.equal(isWithinQuietHours(quiet, new Date("2026-10-30T14:30:00Z")), true);
  // 07:59 in Tokyo
  assert.equal(isWithinQuietHours(quiet, new Date("2026-10-30T22:59:00Z")), true);
  // 08:00 in Tokyo: end is exclusive
  assert.equal(isWithinQuietHours(quiet, new Date("2026-10-30T23:00:00Z")), false);
  assert.equal(isWithinQuietHours({ ...quiet, enabled: false }, new Date("2026-10-30T14:30:00Z")), false);
  assert.equal(isWithinQuietHours({ ...quiet, timeZone: "Not/AZone" }, new Date("2026-10-30T14:30:00Z")), false);
  const daytime = { enabled: true, startMinute: 9 * 60, endMinute: 17 * 60, timeZone: "UTC" };
  assert.equal(isWithinQuietHours(daytime, new Date("2026-10-30T12:00:00Z")), true);
  assert.equal(isWithinQuietHours(daytime, new Date("2026-10-30T18:00:00Z")), false);
});

test("pause is quiet until it ends", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  const quietHours = { enabled: false, startMinute: 0, endMinute: 0, timeZone: "UTC" };
  assert.equal(isNotificationQuiet({ pausedUntil: "2026-10-30T12:30:00Z", quietHours }, now), true);
  assert.equal(isNotificationQuiet({ pausedUntil: "2026-10-30T11:30:00Z", quietHours }, now), false);
  assert.equal(isNotificationQuiet({ pausedUntil: null, quietHours }, now), false);
});

test("the badge sums Activity unread over servers that are not set to none", () => {
  assert.equal(notificationBadgeCount([
    { level: "all", activityUnreadCount: 3 },
    { level: "mentions", activityUnreadCount: 2 },
    { level: "none", activityUnreadCount: 10 },
    { level: "all", activityUnreadCount: -1 },
  ]), 5);
});

test("strictest preview mode wins", () => {
  assert.equal(strictestPreviewMode(["full", "hidden", "sender_only"]), "hidden");
  assert.equal(strictestPreviewMode(["full", "sender_only"]), "sender_only");
  assert.equal(strictestPreviewMode([]), null);
});

test("payload parsers are closed", () => {
  assert.deepEqual(parseNotificationRetractPayload({ serverId: "s", groupKey: "s:c", conversationId: "c", throughSeq: 4 }), {
    serverId: "s", groupKey: "s:c", conversationId: "c", throughSeq: 4,
  });
  assert.equal(parseNotificationRetractPayload({ serverId: "s", groupKey: "s:c", conversationId: "c", throughSeq: "4" }), null);
  assert.deepEqual(parsePresenceActivityReport({ active: true, idleSeconds: 3 }), { active: true, idleSeconds: 3 });
  assert.deepEqual(parsePresenceActivityReport({ active: false }), { active: false, idleSeconds: null });
  assert.equal(parsePresenceActivityReport({ active: "yes" }), null);
  // The computer-active protocol: locked and attended ride along; anything but a boolean is absent (older-client rules).
  assert.deepEqual(parsePresenceActivityReport({ active: true, idleSeconds: 3, locked: false, attended: false }), {
    active: true, idleSeconds: 3, locked: false, attended: false,
  });
  assert.deepEqual(parsePresenceActivityReport({ active: false, idleSeconds: 3, locked: "yes", attended: 1 }), { active: false, idleSeconds: 3 });
  assert.deepEqual(parsePresenceActivityReport({ active: true, idleSeconds: 0, locked: false, ackAlerts: true, pushSubscribed: true, pushEndpointHash: "AbCdEfGh_-123456" }), {
    active: true, idleSeconds: 0, locked: false, ackAlerts: true, pushSubscribed: true, pushEndpointHash: "AbCdEfGh_-123456",
  });
  assert.deepEqual(parsePresenceActivityReport({ active: true, idleSeconds: 0, ackAlerts: "yes", pushEndpointHash: "short" }), { active: true, idleSeconds: 0 }, "malformed capability / hash are absent");
  assert.deepEqual(parseNotificationEnvelopeFields({ category: "dm", priority: "high", seq: 9, silent: true, previewMode: "hidden", bogus: 1 }), {
    category: "dm", priority: "high", seq: 9, silent: true, previewMode: "hidden",
  });
  assert.deepEqual(parseNotificationEnvelopeFields({ category: "nope" }), {});
});
