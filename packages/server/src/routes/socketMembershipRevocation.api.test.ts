import { emitTaskCreated, emitTaskUpdated, emitTaskDeleted } from "../services/taskRealtimeEvents.js";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { and, eq } from "drizzle-orm";
import { SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { channels, featureFlagRules, serverMembers, threadFollows } from "../db/schema.js";
import { createApiTest } from "../test/integration/apiTest.js";
import { signAccessToken } from "../middleware/auth.js";
import { getOrCreateThread } from "../services/channelService.js";

const test = createApiTest({ onboardingOpenerFlagDefaultEnabled: false });

function waitForPacket(ws: WebSocket, packets: string[], predicate: (packet: string) => boolean) {
  if (packets.some(predicate) || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", message);
      ws.off("close", closed);
    };
    const closed = () => { cleanup(); resolve(); };
    const message = (data: WebSocket.RawData) => { if (predicate(data.toString())) closed(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Socket observation did not settle")); }, 5_000);
    ws.on("message", message);
    ws.on("close", closed);
  });
}

test("guest socket join and resume enforce hidden-channel and parent visibility", async ({ app, seed, db }) => {
  const owner = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [guest] });
  await db.update(serverMembers).set({ role: "guest" }).where(and(
    eq(serverMembers.serverId, server.id), eq(serverMembers.userId, guest.id),
  ));
  await db.insert(featureFlagRules).values({
    flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0,
    decision: "allow", values: [server.id],
  });
  const hidden = await seed.channel({ server, members: [owner], visibility: "channel" });
  const visible = await seed.channel({ server, members: [owner], visibility: "channel" });
  await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, visible.id));
  const sentinel = await seed.message({ channel: hidden, author: owner, content: "before-sync-cursor" });
  const hiddenMessage = await seed.message({ channel: hidden, author: owner, content: "audit-guest-hidden" });
  const visibleMessage = await seed.message({ channel: visible, author: owner, content: "audit-guest-visible" });
  const threadMessages: { id: string; allowed: boolean }[] = [];
  for (const [parent, allowed] of [[hiddenMessage, false], [visibleMessage, true]] as const) {
    const [thread] = await db.insert(channels).values({
      serverId: server.id, name: "audit-thread", type: "thread", parentMessageId: parent.id,
    }).returning();
    await db.insert(threadFollows).values({ threadChannelId: thread.id, parentMessageId: parent.id, reason: "manual", followerType: "user", followerId: guest.id });
    const message = await seed.message({ channel: thread, author: owner, content: `audit-thread-${allowed}` });
    threadMessages.push({ id: message.id, allowed });
  }
  const packets: string[] = [];
  const ws = new WebSocket(`${app.baseUrl.replace("http:", "ws:")}/socket.io/?EIO=4&transport=websocket`);
  ws.on("message", (data) => {
    const packet = data.toString();
    packets.push(packet);
    if (packet.startsWith("0")) ws.send(`40${JSON.stringify({ token: signAccessToken(guest.id), serverId: server.id })}`);
  });
  try {
    await waitForPacket(ws, packets, (packet) => packet.includes('"rooms:joined"'));
    const connected = packets.find((packet) => packet.startsWith("40"));
    assert.ok(connected);
    const socket = app.io.of("/").sockets.get(JSON.parse(connected.slice(2)).sid);
    assert.ok(socket);
    // Observe completion of the real async handler without a sleep or a mock
    // authorization result. Input still arrives through the Socket.IO wire.
    const handler = socket.listeners("join:channel")[0];
    socket.off("join:channel", handler);
    const joined = new Promise<void>((resolve, reject) => {
      socket.once("join:channel", async (...args) => {
        try { await handler(...args); resolve(); } catch (error) { reject(error); }
      });
    });
    ws.send(`42${JSON.stringify(["join:channel", hidden.id])}`);
    await joined;
    app.io.to(`channel:${hidden.id}`).emit("message:new", { content: "audit-hidden-live-secret" });
    app.io.to(`channel:${visible.id}`).emit("message:new", { content: "audit-visible-live-control" });
    for (const channel of [hidden, visible]) {
      const target = { channelId: channel.id, channelType: "channel" as const, serverId: server.id };
      const marker = channel.id === hidden.id ? "audit-hidden-task" : "audit-visible-task";
      emitTaskCreated(app.io, target, { channelId: channel.id, tasks: [{ id: marker, title: marker }] });
      emitTaskUpdated(app.io, target, { channelId: channel.id, task: { id: marker, description: marker } });
      emitTaskDeleted(app.io, target, { channelId: channel.id, taskId: marker });
    }
    app.io.to(`user:${guest.id}`).emit("audit:barrier");
    await waitForPacket(ws, packets, (packet) => packet.includes('"audit:barrier"'));
    assert.ok(packets.some((packet) => packet.includes("audit-visible-live-control")));
    assert.equal(packets.filter(packet => packet.includes("audit-visible-task")).length, 3);
    assert.equal(packets.some(packet => packet.includes("audit-hidden-task")), false, "hidden tasks must not reach guest through the server room");
    assert.equal(packets.some((packet) => packet.includes("audit-hidden-live-secret")), false);

    ws.send(`42${JSON.stringify(["sync:resume", { lastSeq: sentinel.seq }])}`);
    await waitForPacket(ws, packets, (packet) => packet.includes('"sync:resume:response"'));
    const response = packets.find((packet) => packet.includes('"sync:resume:response"'));
    assert.ok(response);
    const ids = JSON.parse(response.slice(2))[1].messages.map((message: { id: string }) => message.id);
    assert.ok(ids.includes(visibleMessage.id));
    assert.equal(ids.includes(hiddenMessage.id), false);
    for (const message of threadMessages) assert.equal(ids.includes(message.id), message.allowed);
  } finally {
    if (ws.readyState !== WebSocket.CLOSED) {
      const closed = once(ws, "close"); ws.close(); await closed;
    }
  }
});

for (const transition of ["remove-private-member", "leave-private-channel", "remove-server-member"] as const) {
  test(`socket must stop delivering real private messages after ${transition}`, async ({ app, seed }) => {
    const owner = await seed.human();
    const member = await seed.human();
    const server = await seed.server({ owner, members: [member] });
    const channel = await seed.channel({ server, members: [owner, member], visibility: "private" });
    const parent = await seed.message({ channel, author: owner, content: "audit-private-thread-parent" });
    const thread = await getOrCreateThread(parent.id, member.id, "user");
    const headers = (id: string) => ({
      Authorization: `Bearer ${signAccessToken(id)}`,
      "X-Server-Id": server.id,
      "Content-Type": "application/json",
    });
    const packets: string[] = [];
    const ws = new WebSocket(`${app.baseUrl.replace("http:", "ws:")}/socket.io/?EIO=4&transport=websocket`);
    ws.on("message", (data) => {
      const packet = data.toString();
      packets.push(packet);
      if (packet.startsWith("0")) ws.send(`40${JSON.stringify({ token: signAccessToken(member.id), serverId: server.id })}`);
    });
    try {
      await waitForPacket(ws, packets, (packet) => packet.startsWith("42") && packet.includes('"rooms:joined"'));
      assert.ok(packets.some((packet) => packet.includes('"rooms:joined"')), "control must finish actual room setup");
      app.io.in(`user:${member.id}`).socketsJoin(`channel:${thread.id}`);
      app.io.to(`channel:${thread.id}`).emit("thread:followers-updated", { receipt: "audit-thread-before-removal" });
      await waitForPacket(ws, packets, (packet) => packet.includes("audit-thread-before-removal"));
      assert.ok(packets.some((packet) => packet.includes("audit-thread-before-removal")));
      const send = async (content: string) => {
        const response = await fetch(`${app.baseUrl}/api/messages`, {
          method: "POST", headers: headers(owner.id), body: JSON.stringify({ channelId: channel.id, content }),
        });
        assert.equal(response.status, 200, await response.text());
      };
      await send("audit-private-control-before-removal");
      await waitForPacket(ws, packets, (packet) => packet.includes("audit-private-control-before-removal"));
      assert.ok(packets.some((packet) => packet.includes("audit-private-control-before-removal")));

      const path = transition === "remove-server-member"
        ? `/api/servers/${server.id}/members/${member.id}`
        : transition === "leave-private-channel"
          ? `/api/channels/${channel.id}/leave`
          : `/api/channels/${channel.id}/members/user/${member.id}`;
      const removed = await fetch(`${app.baseUrl}${path}`, {
        method: transition === "leave-private-channel" ? "POST" : "DELETE",
        headers: headers(transition === "leave-private-channel" ? member.id : owner.id),
      });
      assert.equal(removed.status, 200, await removed.text());
      const denied = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}`, { headers: headers(member.id) });
      assert.ok([403, 404].includes(denied.status), `HTTP must deny the removed member, got ${denied.status}`);
      await denied.text();

      await send("audit-private-secret-after-removal");
      for (const event of ["thread:followers-updated", "scope_read:updated", "message:updated"]) {
        app.io.to(`channel:${thread.id}`).emit(event, { receipt: "audit-thread-after-removal" });
      }
      const barrier = waitForPacket(ws, packets, (packet) => packet.includes('"audit:barrier"'));
      app.io.to(`user:${member.id}`).emit("audit:barrier");
      await barrier;
      assert.equal(packets.some((packet) => packet.includes("audit-private-secret-after-removal")), false,
        "HTTP denial must also prevent the old socket from receiving actual message broadcasts");
      assert.equal(packets.some((packet) => packet.includes("audit-thread-after-removal")), false,
        "losing the parent must also remove existing child-room subscriptions");
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) {
        const closed = once(ws, "close");
        ws.close();
        await closed;
      }
    }
  });
}
