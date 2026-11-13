import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { and, eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { onSocketAccessRevoked } from "../socket/accessRevocation";
import { channelHumans, messages } from "../db/schema";
import { createMessage } from "../services/messageService";
import { addHuman, createChannel, markThreadDone, unfollowThread } from "../services/channelService";
import { emitTaskCreated } from "../services/taskRealtimeEvents";
import { headers, recordTestInboxFact, seedThreadFixture, type Fixtures } from "./channels.api.fixtures";
import { seedBoundGuest } from "../test/guestFixture";

const requireWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client");
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// A Guest reads only its one bound channel, while it is a member (#wg-rbac:#15).
// "Hidden": the follower is a Guest of another channel, and a member of the
// parent channel all the same, which grants it nothing.
async function bindGuestElsewhere(f: Fixtures, opts: { memberOfParent?: boolean } = {}) {
  const home = await createChannel(f.serverId, `guest-home-${randomUUID().slice(0, 8)}`, undefined, "private");
  await seedBoundGuest({ serverId: f.serverId, userId: f.followerId, channelId: home.id });
  if (opts.memberOfParent !== false) await addHuman(f.parentChannelId, f.followerId);
  return home;
}
// "Visible": the follower is a Guest of the parent channel itself.
async function bindGuestToParent(f: Fixtures) {
  await seedBoundGuest({ serverId: f.serverId, userId: f.followerId, channelId: f.parentChannelId });
}
// Revocation: the owner removes the Guest from its channel.
function removeGuestFromParent(baseUrl: string, f: Fixtures) {
  return fetch(`${baseUrl}/api/channels/${f.parentChannelId}/members/user/${f.followerId}`, { method: "DELETE", headers: headers(f.ownerToken, f.serverId) });
}
/** Archiving the Guest's channel ends its server membership too (owner decision 2026-11-03). */
function archiveGuestParent(baseUrl: string, f: Fixtures) {
  return fetch(`${baseUrl}/api/channels/${f.parentChannelId}/archive`, { method: "POST", headers: headers(f.ownerToken, f.serverId) });
}
/**
 * Cuts the Guest off while it stays a Guest of the server: its channel row
 * goes, its binding stays (every product path that does this, removal and
 * archive, now ends the membership as well).
 */
async function cutGuestOffParent(f: Fixtures): Promise<void> {
  await getDb().delete(channelHumans).where(and(eq(channelHumans.channelId, f.parentChannelId), eq(channelHumans.userId, f.followerId)));
}
const waitEvent = (socket: any, event: string, timeoutMs = 500) => new Promise<any>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no ${event}`)), timeoutMs);
  socket.once(event, (value: any) => { clearTimeout(timer); resolve(value); });
});

test("Guest cannot read metadata, subscribe, or receive task content for a hidden public channel", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await bindGuestElsewhere(f);
  const guestHeaders = headers(f.followerToken, f.serverId);
  for (const suffix of ["", "/members", "/agents"]) {
    const response = await fetch(`${app.baseUrl}/api/channels/${f.parentChannelId}${suffix}`, { headers: guestHeaders });
    assert.equal(response.status, 404, `${suffix || "details"} must cloak the hidden channel`);
  }
  const socket = clientIo(app.baseUrl, { auth: { token: f.followerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  const ownerSocket = clientIo(app.baseUrl, { auth: { token: f.ownerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  try {
    const ready = waitEvent(socket, "rooms:joined", 4_000); socket.connect(); await ready;
    const ownerReady = waitEvent(ownerSocket, "rooms:joined", 4_000); ownerSocket.connect(); await ownerReady;
    const serverSocket = app.io.sockets.sockets.get(socket.id)!;
    assert.equal(serverSocket.rooms.has(`channel:${f.parentChannelId}`), false);
    const taskEvent = waitEvent(socket, "task:created");
    const ownerTaskEvent = waitEvent(ownerSocket, "task:created", 4_000);
    emitTaskCreated(app.io, { channelId: f.parentChannelId, channelType: "channel", serverId: f.serverId }, { channelId: f.parentChannelId, tasks: [{ id: randomUUID(), title: "hidden-task-title", description: "hidden-task-description" }] });
    await assert.rejects(taskEvent, /no task:created/);
    assert.equal((await ownerTaskEvent).tasks[0].description, "hidden-task-description", "authorized channel member must still receive task content");
    socket.emit("join:channel", f.parentChannelId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(serverSocket.rooms.has(`channel:${f.parentChannelId}`), false);
  } finally { socket.disconnect(); ownerSocket.disconnect(); }
});

test("Guest broad sync omits hidden public-channel content", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await bindGuestElsewhere(f);
  const response = await fetch(`${app.baseUrl}/api/messages/sync?since_seq=0`, { headers: headers(f.followerToken, f.serverId) });
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(await response.json()).includes(f.parentMessageId), false);
});

test("Guest cannot mutate read state on a hidden public channel", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  // Not a member of it either: a member row would be a prior relationship,
  // whose own residue read-all retires without saying anything of the channel.
  await bindGuestElsewhere(f, { memberOfParent: false });
  const guestHeaders = headers(f.followerToken, f.serverId);
  const statuses = await Promise.all([["read", { seq: 1 }], ["read-all", {}], ["unread", {}]].map(async ([suffix, body]) => (
    await fetch(`${app.baseUrl}/api/channels/${f.parentChannelId}/${suffix}`, {
      method: "POST", headers: guestHeaders, body: JSON.stringify(body),
    })
  ).status));
  assert.deepEqual(statuses, [404, 404, 404]);
});

test("Guest does not receive metadata-bearing server-room events", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await bindGuestElsewhere(f);
  const guestSocket = clientIo(app.baseUrl, { auth: { token: f.followerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  const ownerSocket = clientIo(app.baseUrl, { auth: { token: f.ownerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  try {
    const guestReady = waitEvent(guestSocket, "rooms:joined", 4_000); guestSocket.connect(); await guestReady;
    const ownerReady = waitEvent(ownerSocket, "rooms:joined", 4_000); ownerSocket.connect(); await ownerReady;
    assert.equal(app.io.sockets.sockets.get(guestSocket.id)!.rooms.has(`server:${f.serverId}`), false);
    const guestEvent = waitEvent(guestSocket, "channel:updated");
    const ownerEvent = waitEvent(ownerSocket, "channel:updated", 4_000);
    app.io.to(`server:${f.serverId}`).emit("channel:updated", { channel: { id: f.parentChannelId, name: "hidden-metadata" } });
    await assert.rejects(guestEvent, /no channel:updated/);
    assert.equal((await ownerEvent).channel.name, "hidden-metadata");
  } finally { guestSocket.disconnect(); ownerSocket.disconnect(); }
});

test("a member is never downgraded to Guest: the change is refused and its socket stays", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const socket = clientIo(app.baseUrl, { auth: { token: f.followerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  try {
    const ready = waitEvent(socket, "rooms:joined", 4_000); socket.connect(); await ready;
    assert.equal(app.io.sockets.sockets.get(socket.id)!.rooms.has(`channel:${f.parentChannelId}`), true);
    const disconnected = waitEvent(socket, "disconnect", 500);
    const response = await fetch(`${app.baseUrl}/api/servers/${f.serverId}/members/${f.followerId}`, {
      method: "PATCH", headers: headers(f.ownerToken, f.serverId), body: JSON.stringify({ role: "guest" }),
    });
    // Guests are invited to a channel (#wg-rbac:#15), never made from members.
    assert.equal(response.status, 403);
    await assert.rejects(disconnected, /no disconnect/);
    assert.equal(app.io.sockets.sockets.get(socket.id)!.rooms.has(`channel:${f.parentChannelId}`), true);
  } finally { socket.disconnect(); }
});

test("removing a Guest from its channel evicts its connected socket from the channel room", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await bindGuestToParent(f);
  const socket = clientIo(app.baseUrl, { auth: { token: f.followerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  try {
    const ready = waitEvent(socket, "rooms:joined", 4_000); socket.connect(); await ready;
    const serverSocket = app.io.sockets.sockets.get(socket.id)!;
    assert.equal(serverSocket.rooms.has(`channel:${f.parentChannelId}`), true);
    const response = await removeGuestFromParent(app.baseUrl, f);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(serverSocket.rooms.has(`channel:${f.parentChannelId}`), false);
  } finally { socket.disconnect(); }
});

test("archiving a Guest's channel drops its live connection after commit (#wg-rbac:#15)", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await bindGuestToParent(f);
  const socket = clientIo(app.baseUrl, { auth: { token: f.followerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  try {
    const ready = waitEvent(socket, "rooms:joined", 4_000); socket.connect(); await ready;
    const serverSocket = app.io.sockets.sockets.get(socket.id)!;
    assert.equal(serverSocket.rooms.has(`channel:${f.parentChannelId}`), true);
    // The archive ends the Guest's server membership: after commit its
    // connections are revoked as a removal from the server.
    const revoked: unknown[] = [];
    const stop = onSocketAccessRevoked(async (revocation) => { revoked.push(revocation); });
    try {
      const response = await archiveGuestParent(app.baseUrl, f);
      assert.equal(response.status, 200, await response.clone().text());
    } finally { stop(); }
    assert.equal(serverSocket.rooms.has(`channel:${f.parentChannelId}`), false);
    assert.ok(revoked.some((revocation) => {
      const r = revocation as { userId?: string; removedFromServerId?: string };
      return r.userId === f.followerId && r.removedFromServerId === f.serverId;
    }), "the archive revokes the Guest as a removal from the server");
  } finally { socket.disconnect(); }
});

for (const state of ["followed", "done", "unfollowed"] as const) test(`Guest revoked visibility removes ${state} parent preview`, async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await bindGuestToParent(f);
  const old = await createMessage(f.threadId, "user", f.ownerId, "old-visible-reply");
  await recordTestInboxFact({ serverId: f.serverId, receiverId: f.followerId, kind: "thread", sourceChannelId: f.threadId, message: old });
  if (state === "done") await markThreadDone(f.followerId, f.threadId, String(old.seq));
  if (state === "unfollowed") await unfollowThread(f.followerId, f.threadId);
  const guestHeaders = headers(f.followerToken, f.serverId);
  const path = state === "followed" ? "channels/threads/followed" : `channels/inbox/${state}`;
  const before = await fetch(`${app.baseUrl}/api/${path}`, { headers: guestHeaders }); assert.equal(before.status, 200); assert.ok(JSON.stringify(await before.json()).includes(f.threadId));
  await cutGuestOffParent(f);
  await getDb().update(messages).set({ content: "new-parent-content-after-visibility-revocation" }).where(eq(messages.id, f.parentMessageId));
  const after = await fetch(`${app.baseUrl}/api/${path}`, { headers: guestHeaders }); assert.equal(after.status, 200); assert.equal(JSON.stringify(await after.json()).includes("new-parent-content-after-visibility-revocation"), false);
});

test("Guest cannot save or read saved messages from a hidden public channel", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await bindGuestToParent(f);
  const reply = await createMessage(f.threadId, "user", f.ownerId, "saved-thread-reply");
  const guestHeaders = headers(f.followerToken, f.serverId);
  const save = (messageId: string) => fetch(`${app.baseUrl}/api/channels/saved`, { method: "POST", headers: guestHeaders, body: JSON.stringify({ messageId }) });
  const list = async () => (await fetch(`${app.baseUrl}/api/channels/saved`, { headers: guestHeaders })).json();
  const check = async () => (await fetch(`${app.baseUrl}/api/channels/saved/check`, { method: "POST", headers: guestHeaders, body: JSON.stringify({ messageIds: [f.parentMessageId, reply.id] }) })).json();

  // Visible to the guest: both the channel message and its thread reply save and list.
  assert.equal((await save(f.parentMessageId)).status, 200);
  assert.equal((await save(reply.id)).status, 200);
  const visible = await list();
  assert.equal(visible.total, 2);
  assert.deepEqual(new Set((await check()).savedIds), new Set([f.parentMessageId, reply.id]));

  // Hidden from the guest (cut off from its channel; it stays a Guest): earlier
  // saves stop listing, counting and checking, and new saves are refused.
  await cutGuestOffParent(f);
  await getDb().update(messages).set({ content: "hidden-content-after-revocation" }).where(eq(messages.id, f.parentMessageId));
  const hidden = await list();
  assert.equal(hidden.total, 0);
  assert.equal(hidden.saved.length, 0);
  assert.equal(JSON.stringify(hidden).includes("hidden-content-after-revocation"), false);
  assert.deepEqual((await check()).savedIds, []);
  await fetch(`${app.baseUrl}/api/channels/saved/${f.parentMessageId}`, { method: "DELETE", headers: guestHeaders });
  await fetch(`${app.baseUrl}/api/channels/saved/${reply.id}`, { method: "DELETE", headers: guestHeaders });
  assert.equal((await save(f.parentMessageId)).status, 404);
  assert.equal((await save(reply.id)).status, 404);

  // A member keeps saving public-channel messages unchanged.
  const ownerSave = await fetch(`${app.baseUrl}/api/channels/saved`, { method: "POST", headers: headers(f.ownerToken, f.serverId), body: JSON.stringify({ messageId: f.parentMessageId }) });
  assert.equal(ownerSave.status, 200);
  assert.equal((await (await fetch(`${app.baseUrl}/api/channels/saved`, { headers: headers(f.ownerToken, f.serverId) })).json()).total, 1);
});
