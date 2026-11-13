import assert from "node:assert/strict";
import {
  boundDesktopNotificationText,
  desktopNotificationMessageKind,
  isDesktopNotificationRoute,
  isDesktopWindowAttended,
  parseDesktopNotificationV1,
  type DesktopNotificationV1,
} from "./desktopNotifications";

const sample: DesktopNotificationV1 = {
  v: 1,
  id: "message:m1",
  kind: "task",
  event: "task_status",
  title: "#12 Fix login",
  subtitle: "#eng · Acme",
  body: "✅ Ferris moved #12 \"Fix login\" to Done",
  serverId: "s1",
  serverName: "Acme",
  channelId: "t1",
  threadId: "t1",
  parentChannelId: "c1",
  parentMessageId: "pm1",
  messageId: "m1",
  mentioned: true,
  sender: { id: "system", type: "system", name: "Raft" },
  task: { id: "task-1", number: 12, title: "Fix login", status: "done" },
  url: "/s/acme/channel/c1?thread=c1%3Apm1&msg=m1",
  route: { type: "thread", serverId: "s1", parentChannelId: "c1", parentChannelType: "channel", parentMessageId: "pm1", messageId: "m1" },
  groupKey: "s1:task:task-1",
  replaceKey: "s1:task:task-1",
  createdAt: "2026-10-20T10:00:00.000Z",
};

test("parseDesktopNotificationV1 round-trips a valid payload and drops unknown fields", () => {
  assert.deepEqual(parseDesktopNotificationV1(sample), sample);
  assert.deepEqual(parseDesktopNotificationV1({ ...sample, extra: "ignored" }), sample);
});

test("parseDesktopNotificationV1 refuses other versions, kinds and malformed routes", () => {
  assert.equal(parseDesktopNotificationV1({ ...sample, v: 2 }), null);
  assert.equal(parseDesktopNotificationV1({ ...sample, kind: "system" }), null);
  assert.equal(parseDesktopNotificationV1({ ...sample, route: { type: "thread", serverId: "s1" } }), null);
  assert.equal(parseDesktopNotificationV1({ ...sample, mentioned: "yes" }), null);
  assert.equal(parseDesktopNotificationV1(null), null);
});

test("message kind: DM stays dm, a mention wins elsewhere", () => {
  assert.equal(desktopNotificationMessageKind("dm", true), "dm");
  assert.equal(desktopNotificationMessageKind("channel", true), "mention");
  assert.equal(desktopNotificationMessageKind("thread", false), "thread");
  assert.equal(desktopNotificationMessageKind("channel", false), "channel");
});

test("bounded text collapses whitespace and truncates with an ellipsis", () => {
  assert.equal(boundDesktopNotificationText("  a \n b  ", 10), "a b");
  assert.equal(boundDesktopNotificationText("abcdefghij", 5), "abcd…");
});

test("notification routes: only in-app server paths open on click", () => {
  for (const route of ["https://evil.test/", "//evil.test/s/x", "/settings", "/s/", "/s/a/../../x", "/s/a/./x", "/s/a\\b", "raft://s/a", 42, null]) {
    assert.equal(isDesktopNotificationRoute(route), false, String(route));
  }
  assert.equal(isDesktopNotificationRoute("/s/acme"), true);
  assert.equal(isDesktopNotificationRoute("/s/acme/channel/c1?msg=m1&thread=c1%3Ap1"), true);
  assert.equal(isDesktopNotificationRoute(`/s/acme/${"x".repeat(2100)}`), false, "bounded");
});

test("window attended: visible, in front, focused and not away", () => {
  const front = { visible: true, minimized: false, focused: true, away: false };
  assert.equal(isDesktopWindowAttended(front), true);
  assert.equal(isDesktopWindowAttended({ ...front, visible: false }), false);
  assert.equal(isDesktopWindowAttended({ ...front, minimized: true }), false);
  assert.equal(isDesktopWindowAttended({ ...front, focused: false }), false);
  assert.equal(isDesktopWindowAttended({ ...front, away: true }), false);
});
