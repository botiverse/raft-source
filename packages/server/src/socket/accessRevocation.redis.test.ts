import assert from "node:assert/strict";
import { once } from "node:events";
import Redis from "ioredis";
import WebSocket from "ws";
import { vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { featureFlagRules, serverMembers } from "../db/schema.js";
import { createHttpClient } from "../test/integration/http.js";
import { updateChannel } from "../services/channelService.js";
import { dbTest } from "../test/integration/dbTest.js";
import { createTestApp } from "../test/integration/app.js";
import { signAccessToken } from "../middleware/auth.js";
import { createSession, revokeSession, revokeAllUserSessions } from "../services/sessionService.js";
import * as redis from "../redis.js";
import * as revocations from "./accessRevocation.js";

// Opt-in transport integration: point only at a disposable local Redis.
const redisUrl = process.env.RAFT_TEST_REDIS_URL;

dbTest.skipIf(!redisUrl)("Redis peers acknowledge authorized channel subscriptions and family/server revocation", async ({ seed, db }) => {
  const owner = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [guest] });
  await db.update(serverMembers).set({ role: "guest" }).where(and(
    eq(serverMembers.serverId, server.id), eq(serverMembers.userId, guest.id),
  ));
  await db.insert(featureFlagRules).values({
    flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id],
  });
  const firstSession = await createSession(owner.id);
  const secondSession = await createSession(owner.id);
  const clients = Array.from({ length: 5 }, () => new Redis(redisUrl!));
  const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];
  const sockets: WebSocket[] = [];
  const spies: { mockRestore(): void }[] = [];
  try {
    await Promise.all(clients.map((client) => client.ping()));
    spies.push(vi.spyOn(redis, "isRedisAvailable").mockReturnValue(true));
    spies.push(vi.spyOn(redis, "getRedis").mockReturnValue(clients[0]));
    spies.push(vi.spyOn(redis, "getRedisPub").mockReturnValueOnce(clients[1]).mockReturnValue(clients[3]));
    spies.push(vi.spyOn(redis, "getRedisSub").mockReturnValueOnce(clients[2]).mockReturnValue(clients[4]));
    const subscribe = revocations.onSocketAccessRevoked;
    // Only the first app receives the in-process service event. The second app
    // can learn about revocation ONLY through the real Redis adapter, as a peer
    // worker would. Both apps otherwise use the production Socket setup.
    spies.push(vi.spyOn(revocations, "onSocketAccessRevoked")
      .mockImplementationOnce(subscribe).mockImplementation(() => () => {}));
    apps.push(await createTestApp(0, { onboardingOpenerFlagDefaultEnabled: false }));
    apps.push(await createTestApp(0, { onboardingOpenerFlagDefaultEnabled: false }));
    await Promise.all([clients[2].ping(), clients[4].ping()]);

    const guestPackets: string[] = [];
    const tokens = [
      signAccessToken(owner.id, firstSession.familyId),
      signAccessToken(owner.id, secondSession.familyId),
      signAccessToken(guest.id),
    ];
    for (const token of tokens) {
      const socket = new WebSocket(`${apps[1].baseUrl.replace("http:", "ws:")}/socket.io/?EIO=4&transport=websocket`);
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Peer Socket setup timed out")), 5000);
        socket.on("error", reject);
        socket.on("message", (data) => {
          const packet = data.toString();
          if (token === tokens[2]) guestPackets.push(packet);
          if (packet.startsWith("0")) socket.send(`40${JSON.stringify({ token, serverId: server.id })}`);
          if (packet.includes('"rooms:joined"')) { clearTimeout(timer); resolve(); }
        });
      });
    }
    const http = createHttpClient(apps[0].baseUrl).as(owner, server);
    const created = await http.request("/api/channels", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "peer-hidden-channel", description: "peer-confidential-metadata", visibility: "public" }),
    });
    assert.equal(created.status, 200, await created.clone().text());
    const channel = await created.json();
    assert.equal(apps[1].io.of("/").adapter.rooms.get(`channel:${channel.id}`)?.size, 2,
      "HTTP creation acknowledges that both authorized peer sockets have joined; guest is excluded");
    const taskReceived = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Peer missed immediate task")), 5000);
      sockets[1].on("message", (data) => {
        if (data.toString().includes("peer-immediate-task")) { clearTimeout(timer); resolve(); }
      });
    });
    const task = await http.request(`/api/tasks/channel/${channel.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks: [{ title: "peer-immediate-task" }] }),
    });
    assert.equal(task.status, 200, await task.clone().text());
    await taskReceived;
    const barrier = once(sockets[2], "message");
    apps[1].io.to(`user:${guest.id}`).emit("audit:peer-barrier");
    await barrier;
    assert.equal(guestPackets.some(packet => packet.includes("peer-confidential-metadata") || packet.includes("peer-immediate-task")), false);

    const firstClosed = once(sockets[0], "close");
    await revokeSession(firstSession.refreshToken);
    // The acknowledged fanout has already removed the revoked socket on B.
    assert.equal(apps[1].io.of("/").sockets.size, 2);
    await firstClosed;
    assert.equal(sockets[1].readyState, WebSocket.OPEN, "logout must preserve the other session family");
    const received = once(sockets[1], "message");
    apps[1].io.to(`user:${owner.id}`).emit("audit:surviving-session");
    assert.match(String((await received)[0]), /audit:surviving-session/);
    const secondClosed = once(sockets[1], "close");
    await revokeAllUserSessions(owner.id);
    assert.equal(apps[1].io.of("/").sockets.size, 1);
    await secondClosed;
    const guestClosed = once(sockets[2], "close");
    await updateChannel(channel.id, { type: "private" });
    assert.equal(apps[1].io.of("/").sockets.size, 0, "server permission changes evict on the remote adapter too");
    await guestClosed;
  } finally {
    for (const socket of sockets) socket.terminate();
    for (const app of apps.reverse()) await app.close();
    for (const spy of spies.reverse()) spy.mockRestore();
    await Promise.all(clients.map((client) => client.quit()));
  }
});
