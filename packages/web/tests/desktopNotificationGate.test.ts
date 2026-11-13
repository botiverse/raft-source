// Raft Desktop's notification gate: an attended window (visible, focused, not
// away) raises nothing at all, from either source, as Raft Desktop always
// did; otherwise each id is posted once, through the shell's
// notifications.show.
import assert from "node:assert/strict";
import type { DesktopNotificationRequest } from "@botiverse/raft-shared";
import { createNotificationGate, createRecentIds } from "../src/notifications/desktopNative/notificationGate";
import { buildMessagePath } from "../src/utils/messagePath";

function request(over: Partial<DesktopNotificationRequest> = {}): DesktopNotificationRequest {
  return {
    id: "message:m1",
    kind: "channel",
    title: "#eng",
    subtitle: "Acme",
    body: "Ann: ship it",
    groupKey: "s1:c1",
    route: buildMessagePath("/s/acme", "c1", "m1"),
    mentioned: false,
    source: "server",
    ...over,
  };
}

function gate(state: { attended: boolean }) {
  const shown: DesktopNotificationRequest[] = [];
  const g = createNotificationGate({
    bridge: { notifications: { show: (r) => { shown.push(r); }, clearGroup: () => {} } },
    isAttended: () => state.attended,
    recentIds: createRecentIds(),
  });
  return { post: g.post, shown };
}

test("an attended window raises nothing, for any conversation", () => {
  const g = gate({ attended: true });
  assert.equal(g.post(request()), false, "a channel");
  assert.equal(g.post(request({ id: "message:m2", route: buildMessagePath("/s/acme", "c2", "m2"), groupKey: "s1:c2" })), false, "another channel");
  assert.equal(
    g.post(request({ id: "message:m3", route: buildMessagePath("/s/acme", "c1", "m3", { threadParentMessageId: "p1" }) })),
    false,
    "a thread",
  );
  assert.equal(g.post(request({ id: "message:m4", kind: "dm", route: buildMessagePath("/s/acme", "d1", "m4", { routeKind: "dm" }) })), false, "a DM");
  assert.equal(g.post(request({ id: "message:m5", kind: "mention", mentioned: true })), false, "a mention");
  assert.deepEqual(g.shown, []);
});

test("a window not attended posts", () => {
  const g = gate({ attended: false });
  assert.equal(g.post(request()), true);
  assert.equal(g.shown.length, 1);
});

test("each id posts once; a held-back id can still post later", () => {
  const state = { attended: true };
  const g = gate(state);
  assert.equal(g.post(request()), false);
  state.attended = false;
  assert.equal(g.post(request()), true, "held back, not consumed");
  assert.equal(g.post(request()), false, "a repeat");
  assert.equal(g.shown.length, 1);
});

test("a route outside the app is never handed to the shell", () => {
  const g = gate({ attended: false });
  assert.equal(g.post(request({ route: "https://evil.test/s/acme" })), false);
  assert.equal(g.post(request({ id: "message:m9", route: "/settings" })), false);
  assert.equal(g.shown.length, 0);
});

function ackingGate(state: { attended: boolean; location: PageLocation }, show: (r: DesktopNotificationRequest) => Promise<{ shown: boolean; reason?: string }> | void) {
  const acks: Array<[string, boolean]> = [];
  const g = createNotificationGate({
    bridge: { notifications: { show, clearGroup: () => {} } },
    isAttended: () => state.attended,
    location: () => state.location,
    recentIds: createRecentIds(),
    ackTest: (testId, shown) => { acks.push([testId, shown]); },
  });
  return { post: g.post, acks };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("a test notification skips the on-screen rule and acks the shell's show result", async () => {
  const onScreen = { attended: true, location: { pathname: "/s/acme/channel/c1", search: "" } };
  const shown: string[] = [];
  const g = ackingGate(onScreen, (r) => { shown.push(r.id); return Promise.resolve({ shown: r.id !== "test:t2", reason: r.id === "test:t2" ? "timeout" : undefined }); });
  assert.equal(g.post(request({ id: "test:t1", testId: "t1" })), true, "Settings is on screen on purpose");
  assert.equal(g.post(request({ id: "test:t2", testId: "t2" })), true);
  assert.equal(g.post(request({ id: "message:m1" })), false, "a real one is still held back");
  await flush();
  assert.deepEqual(shown, ["test:t1", "test:t2"]);
  assert.deepEqual(g.acks, [["t1", true], ["t2", false]]);
});

test("test ack: a rejected or throwing show acks false; an older shell (undefined) acks nothing", async () => {
  const away = { attended: false, location: { pathname: "/", search: "" } };
  const rejecting = ackingGate(away, () => Promise.reject(new Error("no")));
  rejecting.post(request({ id: "test:r", testId: "r" }));
  const throwing = ackingGate(away, () => { throw new Error("bridge gone"); });
  assert.equal(throwing.post(request({ id: "test:x", testId: "x" })), false);
  const older = ackingGate(away, () => undefined);
  assert.equal(older.post(request({ id: "test:o", testId: "o" })), true);
  const badRoute = ackingGate(away, () => undefined);
  assert.equal(badRoute.post(request({ id: "test:b", testId: "b", route: "/settings" })), false);
  await flush();
  assert.deepEqual(rejecting.acks, [["r", false]]);
  assert.deepEqual(throwing.acks, [["x", false]]);
  assert.deepEqual(older.acks, []);
  assert.deepEqual(badRoute.acks, [["b", false]]);
});

test("a real notification's show result is not acked", async () => {
  const g = ackingGate({ attended: false, location: { pathname: "/", search: "" } }, () => Promise.resolve({ shown: true }));
  g.post(request({ id: "message:m5" }));
  await flush();
  assert.deepEqual(g.acks, []);
});

test("S4: deliver says posted, held (attended, a repeat) or dropped (bad route, show threw); only posted and held are acked upstream", () => {
  const state = { attended: false };
  const shown: DesktopNotificationRequest[] = [];
  let throwOnShow = false;
  const g = createNotificationGate({
    bridge: { notifications: { show: (r) => { if (throwOnShow) throw new Error("shell gone"); shown.push(r); }, clearGroup: () => {} } },
    isAttended: () => state.attended,
    recentIds: createRecentIds(),
  });
  assert.equal(g.deliver(request({ id: "message:a" })), "posted");
  assert.equal(g.deliver(request({ id: "message:a" })), "held", "a repeat");
  state.attended = true;
  assert.equal(g.deliver(request({ id: "message:b" })), "held", "the user is in front of Raft");
  state.attended = false;
  assert.equal(g.deliver(request({ id: "message:c", route: "https://evil.example" })), "dropped");
  throwOnShow = true;
  assert.equal(g.deliver(request({ id: "message:d" })), "dropped", "show() threw: not acked, so the phone alerts");
  assert.equal(shown.length, 1);
});
