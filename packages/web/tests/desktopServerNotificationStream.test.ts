// Raft Desktop's server notification stream (`notification:desktop` v1):
// payload validation, staleness, membership, and following the app socket
// across replacements. There is no flag and no local path: every valid
// payload is handed on from the first one.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DESKTOP_NOTIFICATION_EVENT } from "@botiverse/raft-shared";
import {
  STALE_AFTER_MS,
  adaptServerNotification,
  createServerNotificationSource,
} from "../src/notifications/desktopNative/serverNotificationStream";
import { createRecentIds } from "../src/notifications/desktopNative/notificationGate";
import type { DesktopNotificationRequest } from "@botiverse/raft-shared";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const ctx = { now: NOW, isMemberOf: (id: string) => id === "srv1" };

function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    id: "message:m1",
    kind: "mention",
    event: "message",
    title: "Thread in #eng",
    subtitle: "Acme",
    body: "Ann mentioned you: ship it",
    serverId: "srv1",
    serverName: "Acme",
    channelId: "t1",
    threadId: "t1",
    parentChannelId: "pc",
    parentMessageId: "pm",
    messageId: "m1",
    mentioned: true,
    sender: { id: "u2", type: "user", name: "Ann" },
    url: "/s/acme/channel/pc?thread=pc%3Apm&msg=m1",
    route: { type: "thread", serverId: "srv1", parentChannelId: "pc", parentChannelType: "channel", parentMessageId: "pm", messageId: "m1" },
    groupKey: "srv1:pc",
    createdAt: new Date(NOW - 1000).toISOString(),
    ...over,
  };
}

test("adapter: a v1 payload becomes the main-process request unchanged in meaning", () => {
  assert.deepEqual(adaptServerNotification(payload(), ctx), {
    id: "message:m1",
    kind: "mention",
    title: "Thread in #eng",
    subtitle: "Acme",
    body: "Ann mentioned you: ship it",
    groupTitle: "Acme",
    groupKey: "srv1:pc",
    route: "/s/acme/channel/pc?thread=pc%3Apm&msg=m1",
    mentioned: true,
    source: "server",
  });
  const task = adaptServerNotification(payload({ kind: "task", event: "task_status", title: "#12 Fix login", subtitle: "#eng · Acme", replaceKey: "srv1:task:t", groupKey: "srv1:task:t" }), ctx);
  assert.equal(task?.replaceKey, "srv1:task:t");
  assert.equal(task?.subtitle, "#eng · Acme");
});

test("adapter: keyed phrases are localized; names, untranslatable keys and malformed localization keep the English", () => {
  const localize = (key: string, args: readonly string[]) => (
    key === "push.title.thread_in_channel" ? `「#${args[0]}」のスレッド`
      : key === "push.subtitle.dm_server" ? `DM · ${args[0]}`
        : null
  );
  const localized = adaptServerNotification(payload({
    title: "Thread in #eng",
    subtitle: "DM · Acme",
    body: "Ann: Sent an attachment",
    localization: {
      titleKey: "push.title.thread_in_channel",
      titleArgs: ["eng"],
      subtitleKey: "push.subtitle.dm_server",
      subtitleArgs: ["Acme"],
      bodyKey: "push.body.sender_attachment",
      bodyArgs: ["Ann"],
    },
  }), { ...ctx, localize });
  assert.equal(localized?.title, "「#eng」のスレッド");
  assert.equal(localized?.subtitle, "DM · Acme");
  assert.equal(localized?.body, "Ann: Sent an attachment", "a key the localizer lacks keeps the server's English");

  const malformed = adaptServerNotification(payload({ localization: "push.title.thread" }), { ...ctx, localize });
  assert.equal(malformed?.title, "Thread in #eng");
  // The default localizer reads the shown locale's catalog (en here): the same English.
  const defaults = adaptServerNotification(payload({ localization: { titleKey: "push.title.thread_in_channel", titleArgs: ["eng"] } }), ctx);
  assert.equal(defaults?.title, "Thread in #eng");
});

test("adapter: drops unknown versions, kinds, bad routes, stale items and servers I'm not in", () => {
  const drops: Array<[string, Record<string, unknown>]> = [
    ["v2", { v: 2 }],
    ["kind", { kind: "system" }],
    ["no title", { title: "" }],
    ["external url", { url: "https://evil.test/s/acme" }],
    ["non-app path", { url: "/settings" }],
    ["stale", { createdAt: new Date(NOW - STALE_AFTER_MS - 1).toISOString() }],
    ["bad date", { createdAt: "yesterday" }],
    ["left server", { serverId: "srv-left" }],
  ];
  for (const [name, over] of drops) assert.ok(adaptServerNotification(payload(over), ctx) === null, name);
  assert.ok(adaptServerNotification(null, ctx) === null);
  assert.ok(adaptServerNotification("x", ctx) === null);
});

test("recent ids: a repeat is refused, the window is bounded", () => {
  const recent = createRecentIds(2);
  assert.equal(recent.claim("a"), true);
  assert.equal(recent.claim("a"), false);
  recent.claim("b");
  recent.claim("c");
  assert.equal(recent.has("a"), false, "oldest evicted");
  assert.equal(recent.claim("c"), false);
});

test("source: every valid payload is handed on at once, with no flag read; dispose stops listening", () => {
  const socket = new EventEmitter();
  const received: DesktopNotificationRequest[] = [];
  const stop = createServerNotificationSource({
    sockets: { current: () => socket, onReplaced: () => () => {} },
    now: () => NOW,
    isMemberOf: ctx.isMemberOf,
    onRequest: (r) => received.push(r),
  });
  socket.emit(DESKTOP_NOTIFICATION_EVENT, payload());
  socket.emit(DESKTOP_NOTIFICATION_EVENT, payload({ id: "message:m2", serverId: "srv-left" }));
  socket.emit(DESKTOP_NOTIFICATION_EVENT, payload({ id: "reminder:r1:t", kind: "reminder", event: "reminder_fired" }));
  assert.deepEqual(received.map((r) => r.id), ["message:m1", "reminder:r1:t"], "synchronously, before any connect or flag read");
  assert.equal(socket.listenerCount("connect"), 0, "nothing re-evaluates on reconnect");
  stop();
  socket.emit(DESKTOP_NOTIFICATION_EVENT, payload({ id: "message:m3" }));
  assert.equal(received.length, 2, "disposed");
  assert.equal(socket.listenerCount(DESKTOP_NOTIFICATION_EVENT), 0);
});

test("source: a delivered notification is acked with this socket's id; a dropped or undelivered one is not", () => {
  const socket = Object.assign(new EventEmitter(), { id: "sock-1" });
  const acks: string[] = [];
  let delivered = true;
  const stop = createServerNotificationSource({
    sockets: { current: () => socket, onReplaced: () => () => {} },
    now: () => NOW,
    isMemberOf: ctx.isMemberOf,
    onRequest: () => delivered,
  });
  socket.emit(DESKTOP_NOTIFICATION_EVENT, payload(), (response: unknown) => acks.push(JSON.stringify(response)));
  socket.emit(DESKTOP_NOTIFICATION_EVENT, payload({ id: "message:m9", serverId: "srv-left" }), () => acks.push("left server"));
  delivered = false; // show() threw
  socket.emit(DESKTOP_NOTIFICATION_EVENT, payload({ id: "message:m11" }), () => acks.push("show threw"));
  socket.emit(DESKTOP_NOTIFICATION_EVENT, payload({ id: "message:m10" })); // an emit without an ack still works
  assert.deepEqual(acks, ['{"received":true,"socketId":"sock-1"}'], "acked once, for the notification it delivered");
  stop();
});

test("source: a replaced socket still delivers (MainLayout's boot replaces the one seen at mount)", () => {
  const first = new EventEmitter();
  const second = new EventEmitter();
  let current = first;
  const replaced = new Set<(socket: EventEmitter) => void>();
  const received: DesktopNotificationRequest[] = [];
  const stop = createServerNotificationSource({
    sockets: {
      current: () => current,
      onReplaced: (listener) => { replaced.add(listener); return () => { replaced.delete(listener); }; },
    },
    now: () => NOW,
    isMemberOf: ctx.isMemberOf,
    onRequest: (r) => received.push(r),
  });
  // api/socket.ts resetSocket(): removeAllListeners on the old instance, then a new one.
  first.removeAllListeners();
  current = second;
  for (const listener of [...replaced]) listener(second);
  second.emit(DESKTOP_NOTIFICATION_EVENT, payload());
  assert.equal(received.length, 1, "the stream is heard on the new socket");
  stop();
  assert.equal(second.listenerCount(DESKTOP_NOTIFICATION_EVENT), 0);
  assert.equal(replaced.size, 0);
});

test("adapter: the envelope additions carry through (silent, seq, testId); unknown values are dropped", () => {
  const request = adaptServerNotification(payload({ silent: true, seq: 17, category: "message", priority: "high", previewMode: "full" }), ctx);
  assert.equal(request?.silent, true);
  assert.equal(request?.seq, 17);
  assert.equal(request?.testId, undefined);
  assert.equal(request?.test, undefined);
  const nullSeq = adaptServerNotification(payload({ seq: null }), ctx);
  assert.ok(nullSeq !== null && nullSeq.seq === null);
  const junk = adaptServerNotification(payload({ silent: "yes", seq: "4" }), ctx);
  assert.ok(junk !== null && !("silent" in junk) && !("seq" in junk));
});

test("adapter: a test notification is never dropped as stale and asks the shell to skip its throttle", () => {
  const old = { createdAt: new Date(NOW - STALE_AFTER_MS - 60_000).toISOString() };
  assert.ok(adaptServerNotification(payload(old), ctx) === null, "a real one this old is dropped");
  const test = adaptServerNotification(payload({ ...old, id: "test:t1", testId: "t1", category: "test" }), ctx);
  assert.equal(test?.testId, "t1");
  assert.equal(test?.test, true);
});
