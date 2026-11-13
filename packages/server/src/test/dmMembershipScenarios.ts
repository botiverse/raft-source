// Shared with the focused Node probe: these exercise production services and
// HTTP auth without depending on a particular test runner.
import { randomUUID } from "node:crypto";
import { asServerId } from "@botiverse/raft-shared";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db";
import { channelHumans, channels, inboxNotificationFacts, messages, serverMembers, tasks, threadFollows, userChannelReadCursors } from "../db/schema";
import { createAgent } from "../services/agentService";
import * as channelService from "../services/channelService";
import { DmPeerNotMemberError } from "../services/dmSendPolicy";
import { broadcastAndDeliver, getHumanThreadFollowerIds } from "../services/messageService";
import { addMember, removeMember } from "../services/serverService";
import { canView, visibleRootChannelIds } from "../services/visibilityService";
import type { createSeed } from "./integration/seed";
import type { createHttpClient } from "./integration/http";
import type { openTestApp } from "./integration/app";
import type { AgentOrchestrator } from "../services/agentOrchestrator";

type Fixtures = { app: Awaited<ReturnType<typeof openTestApp>>; db: Database; seed: ReturnType<typeof createSeed>; http: ReturnType<typeof createHttpClient> };
const json = { "Content-Type": "application/json" };

export async function dmMembershipLifecycle({ app, db, seed, http }: Fixtures): Promise<void> {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  // Membership in another server must not grant access to the departed one.
  await seed.server({ owner: peer });
  const privateChannel = await seed.channel({ server, members: [owner, peer], visibility: "private" });
  const dm = await channelService.findOrCreateUserDM(server.id, owner.id, peer.id);
  assert.ok(dm);
  const parent = await seed.message({ channel: (await channelService.getChannel(dm.id))!, author: peer, content: "dm membership history" });
  const [thread] = await db.insert(channels).values({ serverId: server.id, type: "thread", name: "DM thread", parentMessageId: parent.id, parentChannelId: dm.id }).returning();
  await db.insert(userChannelReadCursors).values({ userId: peer.id, channelId: dm.id, lastReadSeq: parent.seq });
  const participant = await db.select().from(channelHumans).where(and(eq(channelHumans.channelId, dm.id), eq(channelHumans.userId, peer.id)));
  const cursor = await db.select().from(userChannelReadCursors).where(and(eq(userChannelReadCursors.channelId, dm.id), eq(userChannelReadCursors.userId, peer.id)));

  await removeMember(server.id, peer.id);
  assert.deepEqual(await db.select().from(channelHumans).where(and(eq(channelHumans.channelId, dm.id), eq(channelHumans.userId, peer.id))), participant);
  assert.deepEqual(await db.select().from(userChannelReadCursors).where(and(eq(userChannelReadCursors.channelId, dm.id), eq(userChannelReadCursors.userId, peer.id))), cursor);
  assert.equal(await channelService.isChannelHuman(privateChannel.id, peer.id), false, "ordinary channel cleanup still happens");
  assert.equal(await channelService.canUserAccessChannel(dm.id, peer.id, asServerId(server.id)), false);
  assert.equal(await channelService.canUserPostToChannel(dm.id, peer.id), false);
  assert.equal(await channelService.canUserAccessChannel(thread.id, peer.id, asServerId(server.id)), false);
  assert.equal(await channelService.canUserPostToChannel(thread.id, peer.id), false);
  assert.deepEqual([...await channelService.filterUserAccessibleChannelIds([dm.id, thread.id, privateChannel.id], peer.id, asServerId(server.id))], []);
  assert.deepEqual(await canView({ type: "user", id: peer.id, serverId: asServerId(server.id) }, [{ kind: "conversation", channelId: dm.id }]), [false]);
  assert.deepEqual((await visibleRootChannelIds({ type: "user", id: peer.id, serverId: asServerId(server.id) })).roots, []);
  assert.deepEqual(await channelService.listDMChannels(server.id, peer.id), []);
  assert.deepEqual((await channelService.getChannelHumans(dm.id)).map((human) => human.id), [owner.id]);

  // A late/restored follow must not turn a retained DM participant into a
  // recipient. Parent authors can be auto-followed again by the send path.
  await db.insert(threadFollows).values({ threadChannelId: thread.id, followerType: "user", followerId: peer.id, parentMessageId: parent.id, reason: "authored" });
  assert.deepEqual(await getHumanThreadFollowerIds(thread.id), []);
  const departed = http.as(peer, server);
  for (const path of [`/api/channels/${dm.id}`, `/api/messages/channel/${dm.id}`, `/api/messages/search?q=membership&channelId=${dm.id}`, "/api/channels/dms"]) {
    const response = await departed.get(path);
    assert.equal(response.status, 403, `${path}: ${await response.text()}`);
  }
  const refused = await departed.request("/api/messages", { method: "POST", headers: json, body: JSON.stringify({ channelId: dm.id, content: "must not be stored" }) });
  assert.equal(refused.status, 403);

  const sender = http.as(owner, server);
  const rowsBefore = await db.select({ id: messages.id }).from(messages).where(eq(messages.serverId, server.id));
  for (const channelId of [dm.id, thread.id]) {
    for (const [path, randomId] of [["/api/messages", undefined], ["/api/v2/messages", randomUUID()]] as const) {
      const response = await sender.request(path, { method: "POST", headers: json, body: JSON.stringify({ channelId, randomId, content: "dm membership while absent" }) });
      assert.equal(response.status, 403, await response.clone().text());
      assert.equal((await response.json()).code, "peer_not_member");
    }
  }
  const forward = await sender.request("/api/messages/forward", { method: "POST", headers: json, body: JSON.stringify({ destinationChannelId: dm.id, sourceMessageIds: [parent.id], randomId: randomUUID() }) });
  assert.equal(forward.status, 403, await forward.clone().text());
  assert.equal((await forward.json()).code, "peer_not_member");
  assert.deepEqual(await db.select({ id: messages.id }).from(messages).where(eq(messages.serverId, server.id)), rowsBefore, "refused sends and forwards leave no message rows");
  assert.deepEqual(await db.select().from(inboxNotificationFacts).where(and(eq(inboxNotificationFacts.receiverId, peer.id), eq(inboxNotificationFacts.serverId, server.id))), [], "no DM or thread notification facts for departed peer");

  // Durable identity must still block a legacy DM whose departed participant
  // row was deleted before the retention fix.
  await db.delete(channelHumans).where(and(eq(channelHumans.channelId, dm.id), eq(channelHumans.userId, peer.id)));
  const legacy = await sender.request("/api/messages", { method: "POST", headers: json, body: JSON.stringify({ channelId: dm.id, content: "legacy missing peer" }) });
  assert.equal(legacy.status, 403, await legacy.clone().text());
  assert.equal((await legacy.json()).code, "peer_not_member");

  // Human/agent DMs and their task conversations inherit the same policy.
  const agent = await createAgent(server.id, "dm-peer-agent", { runtime: "codex" });
  const humanAgent = await channelService.findOrCreateDM(server.id, peer.id, agent.id);
  assert.ok(humanAgent);
  const [taskRow] = await db.insert(tasks).values({ channelId: humanAgent.id, taskNumber: 1, title: "DM task", createdByType: "agent", createdById: agent.id }).returning();
  const [task] = await db.insert(channels).values({ serverId: server.id, type: "task", taskId: taskRow.id, name: "DM task", parentChannelId: humanAgent.id }).returning();
  const sendAgent = (channelId: string, content: string) => broadcastAndDeliver(app.io, app.app.get("agentOrchestrator") as AgentOrchestrator, {
    channelId, senderType: "agent", senderId: agent.id, senderName: agent.name, content,
  });
  for (const channelId of [humanAgent.id, task.id]) {
    await assert.rejects(sendAgent(channelId, "agent while peer absent"), DmPeerNotMemberError);
  }
  const self = await channelService.findOrCreateUserDM(server.id, owner.id, owner.id);
  assert.ok(self);
  for (const channelId of [self.id, privateChannel.id]) {
    const response = await sender.request("/api/messages", { method: "POST", headers: json, body: JSON.stringify({ channelId, content: "unaffected conversation" }) });
    assert.equal(response.status, 200, await response.clone().text());
  }

  await addMember(server.id, peer.id);
  assert.equal((await channelService.findOrCreateUserDM(server.id, peer.id, owner.id))?.id, dm.id);
  assert.deepEqual(await db.select().from(userChannelReadCursors).where(and(eq(userChannelReadCursors.channelId, dm.id), eq(userChannelReadCursors.userId, peer.id))), cursor, "rejoin/reuse must not move read position");
  assert.equal(await channelService.canUserAccessChannel(dm.id, peer.id, asServerId(server.id)), true);
  assert.equal(await channelService.canUserPostToChannel(dm.id, peer.id), true);
  for (const [author, content] of [[owner, "owner after rejoin"], [peer, "peer after rejoin"]] as const) {
    const response = await http.as(author, server).request("/api/messages", { method: "POST", headers: json, body: JSON.stringify({ channelId: dm.id, content }) });
    assert.equal(response.status, 200, await response.clone().text());
  }
  for (const channelId of [thread.id, humanAgent.id, task.id]) {
    await sendAgent(channelId, "agent after peer rejoin");
  }
  for (const reader of [owner, peer]) {
    const response = await http.as(reader, server).get(`/api/messages/channel/${dm.id}`);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.text();
    assert.ok(body.includes("owner after rejoin") && body.includes("peer after rejoin"), body);
    const search = await http.as(reader, server).get(`/api/messages/search?q=membership&channelId=${dm.id}`);
    assert.equal(search.status, 200, await search.clone().text());
    assert.ok((await search.text()).includes("dm membership history"));
  }
  const recipients = new Set((await db.select({ userId: inboxNotificationFacts.receiverId }).from(inboxNotificationFacts).where(eq(inboxNotificationFacts.sourceChannelId, dm.id))).map((fact) => fact.userId));
  assert.ok(recipients.has(owner.id) && recipients.has(peer.id), "notification recipients recover in both directions");
}

export async function dmIdentityRepair({ db, seed }: Pick<Fixtures, "db" | "seed">): Promise<void> {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const agent = await createAgent(server.id, "dm-repair-agent", { runtime: "codex" });
  const pair = await channelService.findOrCreateUserDM(server.id, owner.id, peer.id);
  const self = await channelService.findOrCreateUserDM(server.id, peer.id, peer.id);
  const humanAgent = await channelService.findOrCreateDM(server.id, peer.id, agent.id);
  assert.ok(pair && self && humanAgent);
  await db.insert(userChannelReadCursors).values({ userId: peer.id, channelId: pair.id, lastReadSeq: 17, readStateVersion: 3 });
  const cursor = await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.channelId, pair.id));
  const ownerMembership = await db.select().from(channelHumans).where(and(eq(channelHumans.channelId, pair.id), eq(channelHumans.userId, owner.id)));
  // Reproduce legacy damage: identity survives but a human participant is gone.
  await db.delete(channelHumans).where(eq(channelHumans.userId, peer.id));
  await db.delete(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, peer.id)));
  assert.equal((await channelService.findOrCreateUserDM(server.id, owner.id, peer.id))?.id, pair.id);
  assert.equal(await channelService.isChannelHuman(pair.id, peer.id), false, "absent peer is not repaired");
  await channelService.findOrCreateUserDM(server.id, peer.id, peer.id);
  await channelService.findOrCreateDM(server.id, peer.id, agent.id);
  assert.equal(await channelService.isChannelHuman(self.id, peer.id), false);
  assert.equal(await channelService.isChannelHuman(humanAgent.id, peer.id), false);

  await addMember(server.id, peer.id);
  assert.equal((await channelService.findOrCreateUserDM(server.id, owner.id, peer.id))?.id, pair.id);
  assert.equal((await channelService.findOrCreateUserDM(server.id, peer.id, peer.id))?.id, self.id);
  assert.equal((await channelService.findOrCreateDM(server.id, peer.id, agent.id))?.id, humanAgent.id);
  for (const id of [pair.id, self.id, humanAgent.id]) assert.equal(await channelService.canUserAccessChannel(id, peer.id, asServerId(server.id)), true);
  const repaired = await db.select().from(channelHumans).where(eq(channelHumans.channelId, pair.id));
  await channelService.findOrCreateUserDM(server.id, peer.id, owner.id);
  assert.deepEqual(await db.select().from(channelHumans).where(eq(channelHumans.channelId, pair.id)), repaired, "repeated reuse preserves participant metadata");
  assert.deepEqual(await db.select().from(channelHumans).where(and(eq(channelHumans.channelId, pair.id), eq(channelHumans.userId, owner.id))), ownerMembership);
  assert.deepEqual(await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.channelId, pair.id)), cursor);
  // Repair both missing sides using the identity, not mutable membership shape.
  await db.delete(channelHumans).where(eq(channelHumans.channelId, pair.id));
  assert.equal((await channelService.findOrCreateUserDM(server.id, peer.id, owner.id))?.id, pair.id);
  assert.deepEqual(new Set((await db.select().from(channelHumans).where(eq(channelHumans.channelId, pair.id))).map((row) => row.userId)), new Set([owner.id, peer.id]));
}

/** Keyed agent writes have a separate insert path; they must roll back too. */
export async function dmPeerAgentPersistence({ db, seed, app }: Pick<Fixtures, "db" | "seed"> & { app: Awaited<ReturnType<typeof openTestApp>> }): Promise<void> {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const agent = await createAgent(server.id, "dm-peer-keyed-agent", { runtime: "codex" });
  const dm = await channelService.findOrCreateDM(server.id, peer.id, agent.id);
  assert.ok(dm);
  const opts = { channelId: dm.id, senderType: "agent" as const, senderId: agent.id, senderName: agent.name, content: "keyed peer policy", agentSendKey: randomUUID() };
  const send = () => broadcastAndDeliver(app.io, app.app.get("agentOrchestrator") as AgentOrchestrator, opts);
  await removeMember(server.id, peer.id);
  await assert.rejects(send(), DmPeerNotMemberError);
  assert.deepEqual(await db.select().from(messages).where(eq(messages.agentSendKey, opts.agentSendKey)), [], "keyed agent insert and facts roll back on refusal");
  await addMember(server.id, peer.id);
  const accepted = await send();
  await removeMember(server.id, peer.id);
  assert.equal((await send()).id, accepted.id, "replaying an already committed send creates no new message");
  assert.equal((await db.select().from(messages).where(eq(messages.agentSendKey, opts.agentSendKey))).length, 1);
}

/** Ordinary conversations must not execute the DM peer query at all. */
export async function nonDmSendSkipsPeerQuery({ app, db, seed, http }: Fixtures): Promise<void> {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const normal = await seed.channel({ server, members: [owner] });
  const privateChannel = await seed.channel({ server, members: [owner], visibility: "private" });
  const parent = await seed.message({ channel: normal, author: owner, content: "normal parent" });
  const [thread] = await db.insert(channels).values({ serverId: server.id, type: "thread", name: "Normal thread", parentChannelId: normal.id, parentMessageId: parent.id }).returning();
  const [taskRow] = await db.insert(tasks).values({ channelId: privateChannel.id, taskNumber: 1, title: "Private task", createdByType: "user", createdById: owner.id }).returning();
  const [task] = await db.insert(channels).values({ serverId: server.id, type: "task", taskId: taskRow.id, name: "Private task", parentChannelId: privateChannel.id }).returning();
  const agent = await createAgent(server.id, "normal-keyed-agent", { runtime: "codex" });
  const self = await channelService.findOrCreateUserDM(server.id, owner.id, owner.id);
  assert.ok(self);
  // Test adapter boundary: the standard fixture's actual PGlite client. Observe
  // executed SQL, rather than asserting a source string or a mock's call list.
  type QueryClient = { query: (...args: unknown[]) => Promise<unknown> };
  const client = (db as unknown as { $client: QueryClient & {
    transaction: (run: (tx: QueryClient) => Promise<unknown>) => Promise<unknown>;
  } }).$client;
  const query = client.query;
  const transaction = client.transaction;
  let peerQueries = 0;
  const observe = (execute: QueryClient["query"]): QueryClient["query"] => function (this: QueryClient, ...args: unknown[]) {
    if (typeof args[0] === "string" && /WITH dm AS[\s\S]*dm_channel_identities/.test(args[0])) peerQueries++;
    return execute.apply(this, args);
  };
  client.query = observe(query);
  client.transaction = (run) => transaction.call(client, async (tx) => {
    const execute = tx.query;
    tx.query = observe(execute);
    try { return await run(tx); } finally { tx.query = execute; }
  });
  try {
    const sender = http.as(owner, server);
    const control = await sender.request("/api/messages", { method: "POST", headers: json, body: JSON.stringify({ channelId: self.id, content: "DM observer control" }) });
    assert.equal(control.status, 200, await control.clone().text());
    assert.equal(peerQueries, 1, "observer must see the real DM peer SQL inside the transaction");
    peerQueries = 0;
    for (const channelId of [normal.id, privateChannel.id, thread.id, task.id]) {
      for (const randomId of [undefined, randomUUID()]) {
        const response = await sender.request("/api/messages", { method: "POST", headers: json, body: JSON.stringify({ channelId, randomId, content: "ordinary send" }) });
        assert.equal(response.status, 200, await response.clone().text());
      }
      await broadcastAndDeliver(app.io, app.app.get("agentOrchestrator") as AgentOrchestrator, {
        channelId, senderType: "agent", senderId: agent.id, senderName: agent.name, content: "ordinary keyed send", agentSendKey: randomUUID(),
      });
    }
    const forward = await sender.request("/api/messages/forward", { method: "POST", headers: json, body: JSON.stringify({ destinationChannelId: normal.id, sourceMessageIds: [parent.id] }) });
    assert.equal(forward.status, 200, await forward.clone().text());
    await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, normal.id));
    await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, privateChannel.id));
    for (const channelId of [normal.id, privateChannel.id, thread.id, task.id]) {
      const response = await sender.request("/api/messages", { method: "POST", headers: json, body: JSON.stringify({ channelId, content: "archived parent must still block" }) });
      assert.equal(response.status, 409, await response.clone().text());
      assert.equal((await response.json()).code, "channel_archived");
    }
    assert.equal(peerQueries, 0, "non-DM sends/forwards must execute zero additional peer checks");
  } finally { client.query = query; client.transaction = transaction; }
}
