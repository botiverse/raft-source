// notification:retract (contract §5): Raft Desktop asks the shell to close the
// group up to throughSeq; the web closes the group's Web Push notifications
// through the service worker registration (getNotifications({tag}) + close),
// or forwards it to the controlling worker without one. Heard on
// every socket that replaces the current one; malformed payloads are ignored.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { NOTIFICATION_RETRACT_EVENT, SW_NOTIFICATION_RETRACT_MESSAGE } from "@botiverse/raft-shared";
import { closeGroupNotifications, desktopRetract, startRetractConsumer, webRetract } from "../src/notifications/retractConsumer";
import type { NotificationRegistrationLike, Retract } from "../src/notifications/retractConsumer";

function sockets() {
  let current = new EventEmitter();
  const replaced = new Set<(s: EventEmitter) => void>();
  return {
    source: {
      current: () => current,
      onReplaced: (l: (s: EventEmitter) => void) => { replaced.add(l); return () => { replaced.delete(l); }; },
    },
    current: () => current,
    replace() {
      current.removeAllListeners();
      current = new EventEmitter();
      for (const l of [...replaced]) l(current);
    },
    replaced,
  };
}

const retraction = { serverId: "s1", groupKey: "s1:c1", conversationId: "c1", throughSeq: 41 };

test("desktop: clearGroup(groupKey, throughSeq), also after the socket is replaced", () => {
  const s = sockets();
  const cleared: Array<[string, number | null | undefined]> = [];
  const stop = startRetractConsumer(s.source, desktopRetract({
    notifications: { show: () => {}, clearGroup: (groupKey, throughSeq) => { cleared.push([groupKey, throughSeq]); } },
  }));
  s.current().emit(NOTIFICATION_RETRACT_EVENT, retraction);
  s.replace();
  s.current().emit(NOTIFICATION_RETRACT_EVENT, { ...retraction, groupKey: "s2:d1", serverId: "s2", conversationId: "d1", throughSeq: null });
  assert.deepEqual(cleared, [["s1:c1", 41], ["s2:d1", null]]);
  stop();
  assert.equal(s.current().listenerCount(NOTIFICATION_RETRACT_EVENT), 0);
  assert.equal(s.replaced.size, 0);
});

test("web: the page posts RAFT_NOTIFICATION_RETRACT to the controlling service worker", () => {
  const s = sockets();
  const messages: unknown[] = [];
  let controller: { postMessage(m: unknown): void } | null = { postMessage: (m) => messages.push(m) };
  const stop = startRetractConsumer(s.source, webRetract(() => ({ controller })));
  s.current().emit(NOTIFICATION_RETRACT_EVENT, retraction);
  assert.deepEqual(messages, [{ type: SW_NOTIFICATION_RETRACT_MESSAGE, groupKey: "s1:c1", throughSeq: 41 }]);
  controller = null;
  s.current().emit(NOTIFICATION_RETRACT_EVENT, retraction);
  assert.equal(messages.length, 1, "no controlling worker: nothing to close");
  stop();
  const none = webRetract(() => undefined);
  none(retraction); // no service worker support at all: harmless
});

function shown(groupKey: string, seq: number | null) {
  return { data: { groupKey, seq }, closed: false, close() { this.closed = true; } };
}

test("web: closes the group's notifications through the registration, by tag, up to throughSeq", async () => {
  const notifications = [shown("s1:c1", 40), shown("s1:c1", 41), shown("s1:c1", 42), shown("s1:c1", null), shown("s1:other", 1)];
  const filters: unknown[] = [];
  const registration: NotificationRegistrationLike = {
    getNotifications: async (filter) => {
      filters.push(filter);
      return notifications;
    },
  };
  const messages: unknown[] = [];
  const s = sockets();
  const stop = startRetractConsumer(s.source, webRetract(() => ({
    controller: { postMessage: (m) => messages.push(m) },
    getRegistration: async () => registration,
  })));
  s.current().emit(NOTIFICATION_RETRACT_EVENT, retraction);
  await vi.waitFor(() => assert.equal(notifications[1]!.closed, true));
  assert.deepEqual(filters, [{ tag: "s1:c1" }]);
  assert.deepEqual(notifications.map((n) => n.closed), [true, true, false, false, false]);
  assert.deepEqual(messages, [], "closed directly: the worker is not asked");
  assert.equal(await closeGroupNotifications(registration, "s1:c1", null), 4, "null closes every notification of the group");
  stop();
});

test("web: no registration, or a failing lookup, falls back to the controlling worker", async () => {
  const messages: unknown[] = [];
  const controller = { postMessage: (m: unknown) => messages.push(m) };
  webRetract(() => ({ controller, getRegistration: async () => undefined }))(retraction);
  webRetract(() => ({ controller, getRegistration: () => Promise.reject(new Error("blocked")) }))(retraction);
  await vi.waitFor(() => assert.equal(messages.length, 2));
  assert.deepEqual(messages[0], { type: SW_NOTIFICATION_RETRACT_MESSAGE, groupKey: "s1:c1", throughSeq: 41 });
});

test("malformed payloads are ignored; a throwing target is contained", () => {
  const s = sockets();
  const seen: unknown[] = [];
  const stop = startRetractConsumer(s.source, (p) => seen.push(p));
  for (const bad of [null, "x", { groupKey: "s1:c1" }, { ...retraction, throughSeq: "4" }]) s.current().emit(NOTIFICATION_RETRACT_EVENT, bad);
  assert.equal(seen.length, 0);
  stop();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const throwing: Retract = () => { throw new Error("gone"); };
  const stop2 = startRetractConsumer(s.source, throwing);
  s.current().emit(NOTIFICATION_RETRACT_EVENT, retraction);
  assert.equal(warn.mock.calls.length, 1);
  warn.mockRestore();
  stop2();
});
