import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channels as channelsTable, jointChannelServers, jointMembershipDepartures } from "../db/schema";
import { cleanJointMembershipDepartureBatch, type JointMembershipDepartureId } from "../services/jointMembershipDeparture";
import { addMember } from "../services/serverService";
import { createServer, installFakeIo, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("a member disconnecting a joint copy they can see still needs the admin capability", async ({ app }) => {
  const tag = randomUUID().slice(0, 8);
  const hostOwner = await seedUser(`orphan-cap-host-${tag}@slock.test`, `orphan-cap-host-${tag}`);
  const peerOwner = await seedUser(`orphan-cap-peer-${tag}@slock.test`, `orphan-cap-peer-${tag}`);
  const peerMember = await seedUser(`orphan-cap-member-${tag}@slock.test`, `orphan-cap-member-${tag}`);
  const hostServer = await createServer("Cap Host", `orphan-cap-host-${tag}`, hostOwner.id);
  const peerServer = await createServer("Cap Peer", `orphan-cap-peer-${tag}`, peerOwner.id);
  await addMember(peerServer.id, peerMember.id, "member");
  const [hostToken, peerOwnerToken, peerMemberToken] = await Promise.all(
    [hostOwner, peerOwner, peerMember].map((user) => tokenForHuman(user.email)),
  );
  installFakeIo(app.app);
  const call = (path: string, token: string, serverId: string, method = "GET", body?: unknown) =>
    fetch(`${app.baseUrl}/api${path}`, {
      method,
      headers: headers(token, serverId),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const created = await (await call("/channels", hostToken, hostServer.id, "POST", {
    name: `cap-room-${tag}`, visibility: "joint", targetServerSlug: peerServer.slug, invitedPeople: [`@${peerOwner.name}`],
  })).json() as { jointInvite: { id: string } };
  const peer = await (await call(`/channels/joint-invites/${created.jointInvite.id}/accept`, peerOwnerToken, peerServer.id, "POST")).json() as { id: string };
  assert.equal((await call(`/channels/${peer.id}/members`, peerOwnerToken, peerServer.id, "POST", { userId: peerMember.id })).status, 200);

  assert.equal((await call(`/channels/${peer.id}/disconnect`, peerMemberToken, peerServer.id, "POST")).status, 403);
});

test("a server that disconnected and rejoins sees the joint channel's existing threads", async ({ app }) => {
  const tag = randomUUID().slice(0, 8);
  const hostOwner = await seedUser(`orphan-thread-host-${tag}@slock.test`, `orphan-thread-host-${tag}`);
  const peerOwner = await seedUser(`orphan-thread-peer-${tag}@slock.test`, `orphan-thread-peer-${tag}`);
  const hostServer = await createServer("Thread Host", `orphan-thread-host-${tag}`, hostOwner.id);
  const peerServer = await createServer("Thread Peer", `orphan-thread-peer-${tag}`, peerOwner.id);
  const [hostToken, peerToken] = await Promise.all([hostOwner, peerOwner].map((user) => tokenForHuman(user.email)));
  installFakeIo(app.app);
  const call = (path: string, token: string, serverId: string, method = "GET", body?: unknown) =>
    fetch(`${app.baseUrl}/api${path}`, {
      method,
      headers: headers(token, serverId),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });

  const host = await (await call("/channels", hostToken, hostServer.id, "POST", {
    name: `thread-room-${tag}`, visibility: "joint", targetServerSlug: peerServer.slug, invitedPeople: [`@${peerOwner.name}`],
  })).json() as { id: string; jointInvite: { id: string } };
  const peer = await (await call(`/channels/joint-invites/${host.jointInvite.id}/accept`, peerToken, peerServer.id, "POST")).json() as { id: string };

  const parentRes = await call("/messages", hostToken, hostServer.id, "POST", { channelId: host.id, content: "thread parent" });
  assert.equal(parentRes.status, 200);
  const parent = await parentRes.json() as { id: string };
  assert.equal((await call(`/channels/${host.id}/threads`, hostToken, hostServer.id, "POST", { parentMessageId: parent.id, content: "first reply" })).status, 200);
  const beforeRes = await call(`/channels/${peer.id}/threads?parentMessageIds=${parent.id}`, peerToken, peerServer.id);
  assert.equal(beforeRes.status, 200);
  const before = await beforeRes.json() as Record<string, { threadChannelId: string }>;
  const peerThreadId = before[parent.id]?.threadChannelId;
  assert.ok(peerThreadId, "the peer sees the thread before disconnecting");

  assert.equal((await call(`/channels/${peer.id}/disconnect`, peerToken, peerServer.id, "POST")).status, 200);
  assert.equal((await call(`/messages/channel/${peerThreadId}?limit=50`, peerToken, peerServer.id)).status, 404,
    "after disconnecting, the server's thread copy is not readable");
  const [threadCopy] = await getDb().select({ status: jointChannelServers.status })
    .from(jointChannelServers)
    .where(and(eq(jointChannelServers.localChannelId, peerThreadId), eq(jointChannelServers.serverId, peerServer.id)));
  assert.equal(threadCopy?.status, "disconnected", "the thread copy is disconnected with its parent");
  const [threadChannel] = await getDb().select({ deletedAt: channelsTable.deletedAt }).from(channelsTable).where(eq(channelsTable.id, peerThreadId));
  assert.ok(threadChannel?.deletedAt, "the thread copy's local channel is soft-deleted");

  // The disconnect's membership cleanup finishes before the server may come back.
  for (const departure of await getDb().select().from(jointMembershipDepartures).where(eq(jointMembershipDepartures.localChannelId, peer.id))) {
    while (!await cleanJointMembershipDepartureBatch(departure.id as JointMembershipDepartureId, { revoke: async () => {} }));
  }
  const reinvite = await (await call(`/channels/${host.id}/joint-invites`, hostToken, hostServer.id, "POST", {
    targetServerSlug: peerServer.slug, invitedPeople: [`@${peerOwner.name}`],
  })).json() as { jointInvite: { id: string } };
  const rejoinRes = await call(`/channels/joint-invites/${reinvite.jointInvite.id}/accept`, peerToken, peerServer.id, "POST");
  assert.equal(rejoinRes.status, 200, await rejoinRes.clone().text());
  const rejoined = await rejoinRes.json() as { id: string };

  const afterRes = await call(`/channels/${rejoined.id}/threads?parentMessageIds=${parent.id}`, peerToken, peerServer.id);
  assert.equal(afterRes.status, 200);
  const after = await afterRes.json() as Record<string, { threadChannelId: string; replyCount: number }>;
  assert.equal(after[parent.id]?.replyCount, 1, "the rejoined server sees the existing thread");
  assert.notEqual(after[parent.id]!.threadChannelId, peerThreadId, "rejoining gives the server a new thread copy");
  const threadMessages = await call(`/messages/channel/${after[parent.id]!.threadChannelId}?limit=50`, peerToken, peerServer.id);
  assert.equal(threadMessages.status, 200, "the rejoined server can read the thread");
  const { messages } = await threadMessages.json() as { messages: Array<{ content: string }> };
  assert.ok(messages.some((message) => message.content === "first reply"));
});
