import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// #bug-triage task #29: a joint thread's local projection has no
// parent_message_id by design (the parent lives on the canonical thread).
// Paths that read the column directly treated every joint thread as having no
// parent. Each case here pins one of them to the projection.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, attachmentObjects, attachments, channels, jointChannels, jointChannelServers, messages, servers, threadFollows, users } from "../db/schema";
import { addMember, createServer, removeMember } from "../services/serverService";
import * as channelService from "../services/channelService";
import { createMessage } from "../services/messageService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@test.invalid`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

function authHeaders(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId };
}

// A joint channel shared by a host and a peer server. `author` is a plain
// (non-admin) member of BOTH servers and roots a thread from the peer side;
// `bystander` is a plain peer member who did not author it.
async function seedJointThread(baseUrl: string) {
  const db = getDb();
  const hostOwner = await seedUser("jtp-host");
  const peerOwner = await seedUser("jtp-peer");
  const author = await seedUser("jtp-author");
  const bystander = await seedUser("jtp-bystander");
  const hostServer = await createServer("JTP Host", `jtp-host-${randomUUID().slice(0, 8)}`, hostOwner.id);
  const peerServer = await createServer("JTP Peer", `jtp-peer-${randomUUID().slice(0, 8)}`, peerOwner.id);
  await addMember(hostServer.id, author.id, "member");
  await addMember(peerServer.id, author.id, "member");
  await addMember(peerServer.id, bystander.id, "member");
  const canonical = await channelService.createChannel(hostServer.id, "jtp-storage", undefined, "channel");
  const hostProjection = await channelService.createChannel(hostServer.id, "jtp", undefined, "joint");
  const peerProjection = await channelService.createChannel(peerServer.id, "jtp", undefined, "joint");
  await channelService.addHuman(hostProjection.id, hostOwner.id);
  await channelService.addHuman(hostProjection.id, author.id);
  await channelService.addHuman(peerProjection.id, peerOwner.id);
  await channelService.addHuman(peerProjection.id, author.id);
  await channelService.addHuman(peerProjection.id, bystander.id);
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical.id, createdByServerId: hostServer.id, createdByUserId: hostOwner.id }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host", joinedByUserId: hostOwner.id },
    { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant", joinedByUserId: peerOwner.id },
  ]);
  await fillJointMembersFromChannelHumans();

  const authorPeerToken = await tokenForHuman(author.email);
  const root = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: authHeaders(authorPeerToken, peerServer.id),
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ channelId: peerProjection.id, content: "joint thread root" }),
  });
  assert.equal(root.status, 200, await root.clone().text());
  const { id: rootId } = await root.json() as { id: string };
  const thread = await fetch(`${baseUrl}/api/channels/${peerProjection.id}/threads`, {
    method: "POST",
    headers: authHeaders(authorPeerToken, peerServer.id),
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ parentMessageId: rootId, content: "first reply" }),
  });
  assert.equal(thread.status, 200, await thread.clone().text());
  const { threadChannelId: peerThreadId } = await thread.json() as { threadChannelId: string };

  const peerThread = await channelService.getJointThreadProjectionByLocalThread(peerThreadId, peerServer.id);
  assert.ok(peerThread, "the peer thread is a joint thread projection");
  assert.equal((await channelService.getChannel(peerThreadId))?.parentMessageId, null, "the projection carries no parent message");
  const hostThread = (await channelService.getActiveJointThreadProjectionsByCanonicalThread(peerThread.canonicalThreadChannelId))
    .find((projection) => projection.localServerId === hostServer.id);
  assert.ok(hostThread, "the host server has its own projection of the same thread");

  return {
    hostServer, peerServer, hostOwner, author, bystander, hostProjection, peerProjection, rootId,
    peerThreadId, hostThreadId: hostThread.localThreadChannelId, canonicalThreadId: peerThread.canonicalThreadChannelId,
    authorPeerToken,
  };
}

test("a Joint thread reply preview names a participant server's agent for the other server's members (wg-rbac #56)", async ({ app }) => {
  const fx = await seedJointThread(app.baseUrl);
  const peerAvatar = `/api/avatars/${fx.peerServer.id}/${"e".repeat(32)}.webp`;
  const [peerAgent] = await getDb().insert(agents).values({
    serverId: fx.peerServer.id,
    name: "jtp-peer-agent",
    displayName: "Peer Server Agent",
    avatarUrl: peerAvatar,
  }).returning();
  await createMessage(fx.canonicalThreadId, "agent", peerAgent!.id, "peer agent reply");

  const res = await fetch(`${app.baseUrl}/api/messages/channel/${fx.hostProjection.id}`, {
    headers: authHeaders(await tokenForHuman(fx.hostOwner.email), fx.hostServer.id),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as {
    threadSummariesByParentMessageId: Record<string, { latestReplies: Array<{ preview: string; senderDisplayName: string; senderAvatarUrl: string | null }> }>;
  };
  const reply = body.threadSummariesByParentMessageId[fx.rootId]?.latestReplies.find((item) => item.preview === "peer agent reply");
  assert.deepEqual(reply && [reply.senderDisplayName, reply.senderAvatarUrl], ["Peer Server Agent", peerAvatar],
    "a host member still sees the participant server's agent in a Joint thread preview");
});

test("a non-admin author manages the followers of their own Joint thread", async ({ app }) => {
  const fx = await seedJointThread(app.baseUrl);
  const roster = async (token: string) => {
    const res = await fetch(`${app.baseUrl}/api/channels/threads/followers?threadChannelIds=${fx.peerThreadId}`, {
      headers: authHeaders(token, fx.peerServer.id),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json() as { threads: Array<{ threadChannelId: string; canManage: boolean }> }).threads[0];
  };

  assert.equal((await roster(fx.authorPeerToken))?.canManage, true, "the thread author resolves through the projection's canonical parent");
  assert.equal((await roster(await tokenForHuman(fx.bystander.email)))?.canManage, false, "a non-author member still cannot manage");
});

test("removing a member drops the follows held through that server's Joint thread projection only", async ({ app }) => {
  const fx = await seedJointThread(app.baseUrl);
  const db = getDb();
  await channelService.recordThreadFollow("user", fx.author.id, fx.peerThreadId, fx.rootId, "manual");
  await channelService.recordThreadFollow("user", fx.author.id, fx.hostThreadId, fx.rootId, "manual");
  const follows = async () => (await db
    .select({ threadChannelId: threadFollows.threadChannelId })
    .from(threadFollows)
    .where(and(eq(threadFollows.followerType, "user"), eq(threadFollows.followerId, fx.author.id))))
    .map((row) => row.threadChannelId)
    .sort();
  assert.deepEqual(await follows(), [fx.peerThreadId, fx.hostThreadId].sort());

  await removeMember(fx.peerServer.id, fx.author.id);

  assert.deepEqual(
    await follows(),
    [fx.hostThreadId],
    "the peer projection follow is removed; the same thread followed through the host server the author still belongs to stays",
  );
});

test("message context resolves a Joint thread projection id to its canonical parent message", async ({ app }) => {
  const fx = await seedJointThread(app.baseUrl);
  for (const threadRef of [fx.peerThreadId, fx.peerThreadId.slice(0, 8)]) {
    const res = await fetch(`${app.baseUrl}/api/messages/context/${threadRef}?channelId=${fx.peerProjection.id}`, {
      headers: authHeaders(fx.authorPeerToken, fx.peerServer.id),
    });
    assert.equal(res.status, 200, `${threadRef}: ${await res.clone().text()}`);
    const body = await res.json() as { channelId: string; targetMessageId: string };
    assert.equal(body.targetMessageId, fx.rootId, `${threadRef} opens the thread's parent message`);
    assert.equal(body.channelId, fx.peerProjection.id, "the context is served on the caller's local projection");
  }

  // A thread row with no parent and no projection still resolves nothing.
  const [unmapped] = await getDb().insert(channels).values({ serverId: fx.peerServer.id, name: "jtp-unmapped", type: "thread" }).returning();
  const unmappedRes = await fetch(`${app.baseUrl}/api/messages/context/${unmapped!.id}?channelId=${fx.peerProjection.id}`, {
    headers: authHeaders(fx.authorPeerToken, fx.peerServer.id),
  });
  assert.equal(unmappedRes.status, 404);
});

test("a Joint thread reply behind a Free server's history window names the reader's own projection", async ({ app }) => {
  const fx = await seedJointThread(app.baseUrl);
  const db = getDb();
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, fx.peerServer.id));
  const [reply] = await db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.channelId, fx.canonicalThreadId), eq(messages.content, "first reply")));
  assert.ok(reply, "the first reply lives on the canonical thread");
  await db.update(messages).set({ createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) }).where(eq(messages.id, reply.id));

  const res = await fetch(`${app.baseUrl}/api/messages/context/${reply.id}?channelId=${fx.peerProjection.id}`, {
    headers: authHeaders(fx.authorPeerToken, fx.peerServer.id),
  });
  assert.equal(res.status, 404, await res.clone().text());
  const body = await res.json() as {
    code?: string;
    canonicalTarget?: { kind: string; channelId: string; messageId: string; threadParentMessageId: string; threadChannelId: string | null };
    hiddenTarget?: { target: { id: string } };
  };
  assert.equal(body.code, "history_limited");
  assert.equal(body.hiddenTarget?.target.id, reply.id);
  assert.deepEqual(body.canonicalTarget, {
    kind: "thread",
    channelId: fx.peerProjection.id,
    messageId: reply.id,
    threadParentMessageId: fx.rootId,
    threadChannelId: fx.peerThreadId,
  }, "local ids, never the storage channel or the canonical thread");
});

test("an attachment comment in a Joint thread links back through the local projection", async ({ app }) => {
  const fx = await seedJointThread(app.baseUrl);
  const db = getDb();
  const [reply] = await db
    .select({ id: messages.id, channelId: messages.channelId })
    .from(messages)
    .where(and(eq(messages.channelId, fx.canonicalThreadId), eq(messages.content, "first reply")));
  assert.ok(reply, "the reply is stored on the canonical thread");
  const [object] = await db.insert(attachmentObjects).values({
    originServerId: fx.peerServer.id,
    uploaderId: fx.author.id,
    uploaderType: "user",
    storageKey: `${fx.peerServer.id}/jtp-report.html`,
    mimeType: "text/html",
    sizeBytes: 10,
  }).returning();
  const [attachment] = await db.insert(attachments).values({
    objectId: object!.id,
    messageId: reply.id,
    channelId: reply.channelId,
    uploaderId: fx.author.id,
    uploaderType: "user",
    filename: "jtp-report.html",
  }).returning();

  const res = await fetch(`${app.baseUrl}/api/attachments/${attachment!.id}/comments`, {
    method: "POST",
    headers: authHeaders(fx.authorPeerToken, fx.peerServer.id),
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ content: "looks right" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const created = await res.json() as { threadChannelId: string; message: { commentRef: { hostSource: unknown } } };
  assert.equal(created.threadChannelId, fx.peerThreadId, "the comment lands in the commenter's local thread");
  assert.deepEqual(created.message.commentRef.hostSource, {
    type: "thread",
    routeKind: "channel",
    channelId: fx.peerProjection.id,
    parentMessageId: fx.rootId,
    threadChannelId: fx.peerThreadId,
  });
});

test("GET /channels/:id fills a Joint thread projection's parent channel and parent message", async ({ app }) => {
  const fx = await seedJointThread(app.baseUrl);
  const res = await fetch(`${app.baseUrl}/api/channels/${fx.peerThreadId}`, {
    headers: authHeaders(fx.authorPeerToken, fx.peerServer.id),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { id: string; parentChannelId: string | null; parentMessageId: string | null };
  assert.equal(body.id, fx.peerThreadId);
  assert.equal(body.parentChannelId, fx.peerProjection.id, "this server's projection of the parent joint channel");
  assert.equal(body.parentMessageId, fx.rootId, "the canonical parent message");
});

test("attachment comment refs in a Joint thread link back through each reader's own projection", async ({ app }) => {
  const fx = await seedJointThread(app.baseUrl);
  // Upload and send from the peer side, as the client does: the upload names
  // the peer's local thread.
  const upload = new FormData();
  upload.append("channelId", fx.peerThreadId);
  upload.append("files", new Blob(["<p>report</p>"], { type: "text/html" }), "jtp-read.html");
  const uploaded = await fetch(`${app.baseUrl}/api/attachments/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fx.authorPeerToken}`, "X-Server-Id": fx.peerServer.id },
    body: upload,
  });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const { attachments: [attachment] } = await uploaded.json() as { attachments: Array<{ id: string }> };
  const sent = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: authHeaders(fx.authorPeerToken, fx.peerServer.id),
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ channelId: fx.peerThreadId, content: "report attached", attachmentIds: [attachment!.id] }),
  });
  assert.equal(sent.status, 200, await sent.clone().text());
  const commented = await fetch(`${app.baseUrl}/api/attachments/${attachment!.id}/comments`, {
    method: "POST",
    headers: authHeaders(fx.authorPeerToken, fx.peerServer.id),
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ content: "read-side back-link" }),
  });
  assert.equal(commented.status, 200, await commented.clone().text());
  const { message: { id: commentId } } = await commented.json() as { message: { id: string } };

  const hostSourceSeenBy = async (token: string, serverId: string, threadId: string) => {
    const res = await fetch(`${app.baseUrl}/api/messages/channel/${threadId}?limit=50`, { headers: authHeaders(token, serverId) });
    assert.equal(res.status, 200, await res.clone().text());
    const { messages: rows } = await res.json() as { messages: Array<{ id: string; commentRef: { hostSource: unknown } | null }> };
    const comment = rows.find((row) => row.id === commentId);
    assert.ok(comment, "the comment is listed in the reader's local thread");
    return comment.commentRef?.hostSource;
  };
  assert.deepEqual(await hostSourceSeenBy(fx.authorPeerToken, fx.peerServer.id, fx.peerThreadId), {
    type: "thread",
    routeKind: "channel",
    channelId: fx.peerProjection.id,
    parentMessageId: fx.rootId,
    threadChannelId: fx.peerThreadId,
  });
  assert.deepEqual(await hostSourceSeenBy(await tokenForHuman(fx.author.email), fx.hostServer.id, fx.hostThreadId), {
    type: "thread",
    routeKind: "channel",
    channelId: fx.hostProjection.id,
    parentMessageId: fx.rootId,
    threadChannelId: fx.hostThreadId,
  }, "a reader on the other server gets their own projection, never the canonical storage ids");
});

test("attachment comments carry no email-derived hash and no provider avatar for any reader", async ({ app }) => {
  const fx = await seedJointThread(app.baseUrl);
  const upload = new FormData();
  upload.append("channelId", fx.peerThreadId);
  upload.append("files", new Blob(["<p>report</p>"], { type: "text/html" }), "jtp-hash.html");
  const uploaded = await fetch(`${app.baseUrl}/api/attachments/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fx.authorPeerToken}`, "X-Server-Id": fx.peerServer.id },
    body: upload,
  });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const { attachments: [attachment] } = await uploaded.json() as { attachments: Array<{ id: string }> };
  const sent = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: authHeaders(fx.authorPeerToken, fx.peerServer.id),
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ channelId: fx.peerThreadId, content: "report attached", attachmentIds: [attachment!.id] }),
  });
  assert.equal(sent.status, 200, await sent.clone().text());
  // The bystander belongs to the peer server only; their avatar is an old
  // provider URL, which chat never shows for a person either.
  await getDb().update(users).set({ avatarUrl: "https://provider.example.test/bystander.png" }).where(eq(users.id, fx.bystander.id));
  const bystanderToken = await tokenForHuman(fx.bystander.email);
  for (const [token, content] of [[bystanderToken, "from the peer side"], [fx.authorPeerToken, "from both sides"]] as const) {
    const res = await fetch(`${app.baseUrl}/api/attachments/${attachment!.id}/comments`, {
      method: "POST",
      headers: authHeaders(token, fx.peerServer.id),
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ content }),
    });
    assert.equal(res.status, 200, await res.clone().text());
  }
  const commentsSeenBy = async (token: string, serverId: string) => {
    const res = await fetch(`${app.baseUrl}/api/attachments/${attachment!.id}/comments`, { headers: authHeaders(token, serverId) });
    assert.equal(res.status, 200, await res.clone().text());
    const { comments } = await res.json() as { comments: Array<{ senderId: string; senderGravatarHash: string | null; senderAvatarUrl: string | null }> };
    return new Map(comments.map((comment) => [comment.senderId, comment]));
  };

  // The deprecated senderGravatarHash is "" for every person, whichever
  // server reads (a host-only reader, and a peer reader sharing the peer
  // server with both).
  const host = await commentsSeenBy(await tokenForHuman(fx.hostOwner.email), fx.hostServer.id);
  assert.equal(host.get(fx.bystander.id)?.senderGravatarHash, "");
  assert.equal(host.get(fx.author.id)?.senderGravatarHash, "");
  assert.equal(host.get(fx.bystander.id)?.senderAvatarUrl, null);

  const peer = await commentsSeenBy(fx.authorPeerToken, fx.peerServer.id);
  assert.equal(peer.get(fx.bystander.id)?.senderGravatarHash, "");
  assert.equal(peer.get(fx.author.id)?.senderGravatarHash, "");
});
