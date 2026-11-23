import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  buildWholeMessageQuoteExcerpt,
  QUOTE_REPLY_FEATURE_FLAG_KEY,
  serializeInlineQuoteReply,
  type ResolvedInlineQuotesMap,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  channels,
  featureFlagRules,
  featureFlags,
  jointChannels,
  jointChannelServers,
  messages,
  serverMembers,
  servers,
  tasks,
  users,
} from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import {
  addAgent,
  addHuman,
  createChannel,
  findOrCreateUserDM,
  getOrCreateThread,
} from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createApiTest } from "../test/integration/apiTest";
import { accessTokenForTest, fixturePasswordHash } from "../test/integration/credentials";
import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";

const test = createApiTest();

interface EmittedEvent {
  room: string;
  event: string;
  payload: unknown;
}

function installFakeIo(app: { app: { set(key: string, value: unknown): void } }): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  app.app.set("io", {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          events.push({ room, event, payload });
        },
      };
    },
    in(room: string) {
      return {
        in() {
          return {
            socketsJoin(joinRoom: string) {
              events.push({ room, event: "socketsJoin", payload: { room: joinRoom } });
            },
          };
        },
        socketsJoin(joinRoom: string) {
          events.push({ room, event: "socketsJoin", payload: { room: joinRoom } });
        },
      };
    },
    sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
  });
  return events;
}

async function seedUser(tag: string, displayName: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email: `qrv9-${tag}@slock.test`,
    name: `qrv9${tag.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`,
    displayName,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function enableQuoteReplyFlag(serverIds: string[]) {
  const db = getDb();
  await db.insert(featureFlags)
    .values({
      key: QUOTE_REPLY_FEATURE_FLAG_KEY,
      randomizationUnit: "server",
      salt: "quote-reply-v9-test",
      defaultEnabled: false,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: featureFlags.key,
      set: { enabled: true, defaultEnabled: false, killSwitch: false },
    });
  await db.insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: QUOTE_REPLY_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: serverIds,
  });
}

function humanHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
    "Content-Type": "application/json",
  };
}

test("flag off: server omits resolvedQuotes on channel read, send response, and /resolved-quotes", async ({ app }) => {
  const db = getDb();
  const alice = await seedUser("flagoff-a", "Alice");
  const server = await createServer("QR Flag Off", `qr-flagoff-${randomUUID().slice(0, 6)}`, alice.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: alice.id, role: "owner" }).onConflictDoNothing();
  const ch = await createChannel(server.id, "general");
  await addHuman(ch.id, alice.id);
  const token = await accessTokenForTest(alice.id);

  const src = await createMessage(ch.id, "user", alice.id, "Original target message.");

  const postRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: humanHeaders(token, server.id),
    body: JSON.stringify({
      channelId: ch.id,
      content: serializeInlineQuoteReply("Original target", src.id, "Replying while flag is off."),
    }),
  });
  assert.equal(postRes.status, 200);
  const posted = await postRes.json() as { id: string; resolvedQuotes?: ResolvedInlineQuotesMap };
  assert.equal(posted.resolvedQuotes, undefined);

  const listRes = await fetch(`${app.baseUrl}/api/messages/channel/${ch.id}`, {
    headers: humanHeaders(token, server.id),
  });
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as { messages: Array<{ id: string; resolvedQuotes?: ResolvedInlineQuotesMap }> };
  const row = listed.messages.find((m) => m.id === posted.id);
  assert.ok(row);
  assert.equal(row.resolvedQuotes, undefined);

  const singleRes = await fetch(`${app.baseUrl}/api/messages/${posted.id}/resolved-quotes`, {
    headers: humanHeaders(token, server.id),
  });
  assert.equal(singleRes.status, 200);
  const single = await singleRes.json() as { resolvedQuotes: ResolvedInlineQuotesMap };
  assert.deepEqual(single.resolvedQuotes, {});
});

test("same-conversation single, multi-point interleaved, whole-message, thread (incl. root), task (incl. source), and DM quotes resolve cleanly", async ({ app }) => {
  const db = getDb();
  const alice = await seedUser("happy-a", "Alice");
  const bob = await seedUser("happy-b", "Bob");
  const server = await createServer("QR Happy", `qr-happy-${randomUUID().slice(0, 6)}`, alice.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: alice.id, role: "owner" },
    { serverId: server.id, userId: bob.id, role: "member" },
  ]).onConflictDoNothing();
  await enableQuoteReplyFlag([server.id]);

  const ch = await createChannel(server.id, "proj-chat");
  await addHuman(ch.id, alice.id);
  await addHuman(ch.id, bob.id);
  const aliceToken = await accessTokenForTest(alice.id);
  const bobToken = await accessTokenForTest(bob.id);

  // 1. Multi-point interleaved + whole-message quotes in channel
  const longRoot = await createMessage(
    ch.id,
    "user",
    alice.id,
    "Point one: keep quote replies in the same conversation.\n\nPoint two: **bold** and `code` stay clean.\n\n" + "x".repeat(140),
  );

  const multiPointContent = [
    "> keep quote replies in the same conversation",
    `> msg=${longRoot.id.slice(0, 8)}`,
    "",
    "Agreed on point 1.",
    "",
    "> bold and code stay clean",
    `> msg=${longRoot.id.slice(0, 8)}`,
    "",
    "Agreed on point 2.",
  ].join("\n");

  const multiRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: humanHeaders(bobToken, server.id),
    body: JSON.stringify({ channelId: ch.id, content: multiPointContent }),
  });
  assert.equal(multiRes.status, 200);
  const multiPosted = await multiRes.json() as { id: string; resolvedQuotes?: ResolvedInlineQuotesMap };
  assert.equal(multiPosted.resolvedQuotes?.["0"]?.messageId, longRoot.id);
  assert.equal(multiPosted.resolvedQuotes?.["0"]?.author.name, "Alice");
  assert.equal(multiPosted.resolvedQuotes?.["0"]?.isPartial, true);
  assert.equal(multiPosted.resolvedQuotes?.["1"]?.messageId, longRoot.id);
  assert.equal(multiPosted.resolvedQuotes?.["1"]?.isPartial, true);

  const wholeExcerpt = buildWholeMessageQuoteExcerpt(longRoot.content).excerpt;
  const wholeRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: humanHeaders(bobToken, server.id),
    body: JSON.stringify({
      channelId: ch.id,
      content: serializeInlineQuoteReply(wholeExcerpt, longRoot.id, "Pulling back the whole message."),
    }),
  });
  assert.equal(wholeRes.status, 200);
  const wholePosted = await wholeRes.json() as { id: string; resolvedQuotes?: ResolvedInlineQuotesMap };
  assert.equal(wholePosted.resolvedQuotes?.["0"]?.messageId, longRoot.id);
  assert.equal(wholePosted.resolvedQuotes?.["0"]?.isPartial, false);

  // 2. Thread reply quoting thread root AND another thread reply
  const thread = await getOrCreateThread(longRoot.id, alice.id, "user");
  const firstThreadReply = await createMessage(thread.id, "user", bob.id, "Thread reply about RBAC boundaries.");
  const threadQuoteContent = [
    "> keep quote replies in the same conversation",
    `> msg=${longRoot.id.slice(0, 8)}`,
    "",
    "Quoting root from inside thread.",
    "",
    "> RBAC boundaries",
    `> msg=${firstThreadReply.id.slice(0, 8)}`,
    "",
    "Quoting earlier thread reply.",
  ].join("\n");
  const threadPost = await createMessage(thread.id, "user", alice.id, threadQuoteContent);

  const threadListRes = await fetch(`${app.baseUrl}/api/messages/channel/${thread.id}`, {
    headers: humanHeaders(bobToken, server.id),
  });
  assert.equal(threadListRes.status, 200);
  const threadList = await threadListRes.json() as { messages: Array<{ id: string; resolvedQuotes?: ResolvedInlineQuotesMap }> };
  const threadRow = threadList.messages.find((m) => m.id === threadPost.id);
  assert.equal(threadRow?.resolvedQuotes?.["0"]?.messageId, longRoot.id);
  assert.equal(threadRow?.resolvedQuotes?.["1"]?.messageId, firstThreadReply.id);

  // 3. Task conversation quoting task sourceMessageId AND same-task reply
  const taskId = randomUUID();
  const [taskRowCreated] = await db.insert(tasks).values({
    id: taskId,
    channelId: ch.id,
    sourceMessageId: longRoot.id,
    taskNumber: 1,
    title: "Quote Reply v0",
    status: "in_progress",
    ownConversation: true,
    createdByType: "user",
    createdById: alice.id,
  }).returning();
  const [taskChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: `task-${randomUUID().slice(0, 8)}`,
    type: "task",
    parentChannelId: ch.id,
    taskId: taskRowCreated!.id,
  }).returning();
  await db.update(tasks)
    .set({ conversationChannelId: taskChannel!.id })
    .where(eq(tasks.id, taskRowCreated!.id));
  const taskFirstMsg = await createMessage(taskChannel!.id, "user", bob.id, "Initial task implementation note.");
  const taskQuoteMsg = await createMessage(
    taskChannel!.id,
    "user",
    alice.id,
    [
      "> Point one: keep quote replies",
      `> msg=${longRoot.id.slice(0, 8)}`,
      "",
      "Quoting task source.",
      "",
      "> implementation note",
      `> msg=${taskFirstMsg.id.slice(0, 8)}`,
      "",
      "Quoting earlier task reply.",
    ].join("\n"),
  );

  const taskListRes = await fetch(`${app.baseUrl}/api/messages/channel/${taskChannel!.id}`, {
    headers: humanHeaders(bobToken, server.id),
  });
  assert.equal(taskListRes.status, 200);
  const taskList = await taskListRes.json() as { messages: Array<{ id: string; resolvedQuotes?: ResolvedInlineQuotesMap }> };
  const taskRow = taskList.messages.find((m) => m.id === taskQuoteMsg.id);
  assert.equal(taskRow?.resolvedQuotes?.["0"]?.messageId, longRoot.id);
  assert.equal(taskRow?.resolvedQuotes?.["1"]?.messageId, taskFirstMsg.id);

  // 4. DM quote using identical `> msg=<id>` works identically for BOTH sides
  const dm = await findOrCreateUserDM(server.id, alice.id, bob.id);
  if (!dm) throw new Error("expected DM channel");
  const dmId = dm.id;
  const dmOrig = await createMessage(dmId, "user", alice.id, "Let's finalize the DM perspective rule.");
  const dmQuote = await createMessage(
    dmId,
    "user",
    bob.id,
    serializeInlineQuoteReply("finalize the DM perspective rule", dmOrig.id, "Clean and symmetric."),
  );

  for (const viewerToken of [aliceToken, bobToken]) {
    const dmRes: Response = await fetch(`${app.baseUrl}/api/messages/channel/${dmId}`, {
      headers: humanHeaders(viewerToken, server.id),
    });
    assert.equal(dmRes.status, 200);
    const dmData = await dmRes.json() as { messages: Array<{ id: string; resolvedQuotes?: ResolvedInlineQuotesMap }> };
    const dmRow = dmData.messages.find((m) => m.id === dmQuote.id);
    assert.equal(dmRow?.resolvedQuotes?.["0"]?.messageId, dmOrig.id);
    assert.equal(dmRow?.resolvedQuotes?.["0"]?.author.name, "Alice");
  }
});

test("RBAC & anti-spoofing: mismatch, cross-conv, private, retracted, nonexistent, and behind-history-window targets all omit identically", async ({ app }) => {
  const db = getDb();
  const alice = await seedUser("rbac-a", "Alice");
  const bob = await seedUser("rbac-b", "Bob");
  const server = await createServer("QR RBAC", `qr-rbac-${randomUUID().slice(0, 6)}`, alice.id);
  // Ensure server is on Free plan (30-day history window)
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: alice.id, role: "owner" },
    { serverId: server.id, userId: bob.id, role: "member" },
  ]).onConflictDoNothing();
  await enableQuoteReplyFlag([server.id]);

  const pubCh = await createChannel(server.id, "public-room");
  const otherPubCh = await createChannel(server.id, "other-public");
  const privCh = await createChannel(server.id, "secret-room", undefined, "private");
  await addHuman(pubCh.id, alice.id);
  await addHuman(pubCh.id, bob.id);
  await addHuman(otherPubCh.id, alice.id);
  await addHuman(otherPubCh.id, bob.id);
  await addHuman(privCh.id, alice.id); // Bob NOT in privCh

  const bobToken = await accessTokenForTest(bob.id);

  const visibleMsg = await createMessage(pubCh.id, "user", alice.id, "Real words spoken by Alice.");
  const otherChMsg = await createMessage(otherPubCh.id, "user", alice.id, "Words in another public channel.");
  const secretMsg = await createMessage(privCh.id, "user", alice.id, "Top secret salary numbers.");
  const retractedMsg = await createMessage(pubCh.id, "user", alice.id, "Soon to be retracted.");
  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, retractedMsg.id));

  const oldMsg = await createMessage(pubCh.id, "user", alice.id, "Message from 45 days ago behind Free 30d window.");
  await db.update(messages)
    .set({ createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) })
    .where(eq(messages.id, oldMsg.id));

  const cases = [
    { name: "spoofed excerpt mismatch", content: serializeInlineQuoteReply("Forged words Alice never said", visibleMsg.id, "Try spoof.") },
    { name: "cross-channel readable target", content: serializeInlineQuoteReply("Words in another public channel", otherChMsg.id, "Cross ch.") },
    { name: "private channel unreadable target", content: serializeInlineQuoteReply("Top secret salary numbers", secretMsg.id, "Probe secret.") },
    { name: "retracted same-channel target", content: serializeInlineQuoteReply("Soon to be retracted", retractedMsg.id, "Retracted.") },
    { name: "behind 30d history window target", content: serializeInlineQuoteReply("Message from 45 days ago", oldMsg.id, "Old msg.") },
    { name: "nonexistent id", content: serializeInlineQuoteReply("Whatever text", "deadbeef", "Nonexistent.") },
  ];

  const postedIds: Array<{ name: string; id: string }> = [];
  for (const c of cases) {
    const res = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: humanHeaders(bobToken, server.id),
      body: JSON.stringify({ channelId: pubCh.id, content: c.content }),
    });
    assert.equal(res.status, 200, `${c.name}: send must never error`);
    const body = await res.json() as { id: string; resolvedQuotes?: ResolvedInlineQuotesMap };
    assert.equal(Object.hasOwn(body, "resolvedQuotes"), false, `${c.name}: POST response must omit resolvedQuotes`);
    postedIds.push({ name: c.name, id: body.id });
  }

  const pageRes = await fetch(`${app.baseUrl}/api/messages/channel/${pubCh.id}`, {
    headers: humanHeaders(bobToken, server.id),
  });
  assert.equal(pageRes.status, 200);
  const page = await pageRes.json() as { messages: Array<Record<string, unknown>> };
  for (const item of postedIds) {
    const row = page.messages.find((m) => m.id === item.id);
    assert.ok(row, `${item.name}: row must exist`);
    assert.equal(Object.hasOwn(row, "resolvedQuotes"), false, `${item.name}: GET /channel must omit resolvedQuotes identically`);

    const singleRes = await fetch(`${app.baseUrl}/api/messages/${item.id}/resolved-quotes`, {
      headers: humanHeaders(bobToken, server.id),
    });
    assert.equal(singleRes.status, 200);
    const single = await singleRes.json() as { resolvedQuotes: ResolvedInlineQuotesMap };
    assert.deepEqual(single.resolvedQuotes, {}, `${item.name}: /resolved-quotes must return identical empty map`);
  }

  // Thread reply posted today quoting a 45-day-old thread root behind Free 30d cutoff -> omitted!
  const oldThread = await getOrCreateThread(oldMsg.id, bob.id, "user");
  const replyToOldRoot = await createMessage(
    oldThread.id,
    "user",
    bob.id,
    serializeInlineQuoteReply("Message from 45 days ago", oldMsg.id, "Quoting expired root."),
  );
  const oldThreadRes = await fetch(`${app.baseUrl}/api/messages/channel/${oldThread.id}`, {
    headers: humanHeaders(bobToken, server.id),
  });
  assert.equal(oldThreadRes.status, 200);
  const oldThreadBody = await oldThreadRes.json() as { messages: Array<Record<string, unknown>> };
  const oldThreadRow = oldThreadBody.messages.find((m) => m.id === replyToOldRoot.id);
  assert.ok(oldThreadRow);
  assert.equal(Object.hasOwn(oldThreadRow, "resolvedQuotes"), false);
});

test("real-time WS broadcast carries NO resolvedQuotes, and out-of-window viewer / unauthorized caller cannot extract author or jump target", async ({ app }) => {
  const emitted = installFakeIo(app);
  const db = getDb();
  const proOwner = await seedUser("rt-pro", "ProOwner");
  const freeOwner = await seedUser("rt-free", "FreeOwner");
  const outsider = await seedUser("rt-out", "Outsider");

  const proServer = await createServer("Pro Server", `qr-pro-${randomUUID().slice(0, 6)}`, proOwner.id);
  const freeServer = await createServer("Free Server", `qr-free-${randomUUID().slice(0, 6)}`, freeOwner.id);
  await db.update(servers).set({ plan: "pro" }).where(eq(servers.id, proServer.id));
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, freeServer.id));
  await db.insert(serverMembers).values([
    { serverId: proServer.id, userId: proOwner.id, role: "owner" },
    { serverId: freeServer.id, userId: freeOwner.id, role: "owner" },
    { serverId: proServer.id, userId: outsider.id, role: "member" },
  ]).onConflictDoNothing();
  await enableQuoteReplyFlag([proServer.id, freeServer.id]);

  // Set up a Joint Channel linking Pro Server (full history) and Free Server (30-day window)
  const [proCh] = await db.insert(channels).values({
    serverId: proServer.id,
    name: "joint-quote",
    type: "joint",
  }).returning();
  const [freeCh] = await db.insert(channels).values({
    serverId: freeServer.id,
    name: "joint-quote",
    type: "joint",
  }).returning();
  const [jc] = await db.insert(jointChannels).values({
    canonicalChannelId: proCh!.id,
    createdByServerId: proServer.id,
    createdByUserId: proOwner.id,
    status: "active",
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: jc!.id, serverId: proServer.id, localChannelId: proCh!.id, role: "host", status: "active" },
    { jointChannelId: jc!.id, serverId: freeServer.id, localChannelId: freeCh!.id, role: "participant", status: "active" },
  ]);
  await addHuman(proCh!.id, proOwner.id);
  await addHuman(freeCh!.id, freeOwner.id);
  await fillJointMembersFromChannelHumans([jc!.id]);

  // Seed a 45-day-old target message in the Joint Channel (visible to Pro, behind 30d window for Free!)
  const oldJointMsg = await createMessage(
    proCh!.id,
    "user",
    proOwner.id,
    "Old joint architecture decision from 45 days ago.",
  );
  await db.update(messages)
    .set({ createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) })
    .where(eq(messages.id, oldJointMsg.id));

  const proToken = await accessTokenForTest(proOwner.id);
  const freeToken = await accessTokenForTest(freeOwner.id);
  const outsiderToken = await accessTokenForTest(outsider.id);

  // Pro user sends a quote reply to the 45-day-old message today
  const postRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: humanHeaders(proToken, proServer.id),
    body: JSON.stringify({
      channelId: proCh.id,
      content: serializeInlineQuoteReply("Old joint architecture decision", oldJointMsg.id, "Following up on Pro."),
    }),
  });
  assert.equal(postRes.status, 200);
  const posted = await postRes.json() as { id: string; resolvedQuotes?: ResolvedInlineQuotesMap };

  // 1. Sender's own HTTP response (Pro) resolves the 45-day-old quote cleanly
  assert.equal(posted.resolvedQuotes?.["0"]?.messageId, oldJointMsg.id);
  assert.equal(posted.resolvedQuotes?.["0"]?.author.name, "ProOwner");

  // 2. Room-wide WS `message:new` broadcasts MUST NEVER contain `resolvedQuotes`!
  const broadcasts = emitted.filter(
    (e) => e.event === "message:new" && (e.payload as { id?: string } | undefined)?.id === posted.id,
  );
  assert.ok(broadcasts.length >= 1, "expected at least one message:new broadcast");
  for (const b of broadcasts) {
    const payload = b.payload as Record<string, unknown>;
    assert.equal(
      Object.hasOwn(payload, "resolvedQuotes"),
      false,
      `WS room broadcast ${b.room} must never leak resolvedQuotes`,
    );
  }

  // 3. Pro viewer calling GET /:id/resolved-quotes gets author + jump target
  const proResolveRes = await fetch(`${app.baseUrl}/api/messages/${posted.id}/resolved-quotes`, {
    headers: humanHeaders(proToken, proServer.id),
  });
  assert.equal(proResolveRes.status, 200);
  const proResolved = await proResolveRes.json() as { resolvedQuotes: ResolvedInlineQuotesMap };
  assert.equal(proResolved.resolvedQuotes["0"]?.messageId, oldJointMsg.id);
  assert.equal(proResolved.resolvedQuotes["0"]?.author.name, "ProOwner");

  // 4. Out-of-window Free viewer calling GET /:id/resolved-quotes gets EMPTY map (no author, no jump target!)
  const freeResolveRes = await fetch(`${app.baseUrl}/api/messages/${posted.id}/resolved-quotes`, {
    headers: humanHeaders(freeToken, freeServer.id),
  });
  assert.equal(freeResolveRes.status, 200);
  const freeResolved = await freeResolveRes.json() as { resolvedQuotes: ResolvedInlineQuotesMap };
  assert.deepEqual(freeResolved.resolvedQuotes, {});

  // 5. Unauthorized caller on a private channel gets 404
  const privCh = await createChannel(proServer.id, "pro-private", undefined, "private");
  await addHuman(privCh.id, proOwner.id);
  const privMsg = await createMessage(privCh.id, "user", proOwner.id, "Private note.");
  const unauthRes = await fetch(`${app.baseUrl}/api/messages/${privMsg.id}/resolved-quotes`, {
    headers: humanHeaders(outsiderToken, proServer.id),
  });
  assert.equal(unauthRes.status, 404);
});

test("agent API read preserves `> msg=<id>` verbatim without expanding resolvedQuotes", async ({ app }) => {
  const db = getDb();
  const alice = await seedUser("agent-a", "Alice");
  const server = await createServer("QR Agent", `qr-agent-${randomUUID().slice(0, 6)}`, alice.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: alice.id, role: "owner" }).onConflictDoNothing();
  await enableQuoteReplyFlag([server.id]);

  const ch = await createChannel(server.id, "agent-room");
  await addHuman(ch.id, alice.id);
  const agent = await createAgent(server.id, "QRAgent", { runtime: "claude", model: "sonnet" });
  await addAgent(ch.id, agent.id);
  const apiKey = (await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read"],
    name: "qr-test",
    issuedVia: "human",
    createdByUserId: alice.id,
  })).apiKey;

  const orig = await createMessage(ch.id, "user", alice.id, "Agent verbatim check line.");
  const rawQuote = serializeInlineQuoteReply("Agent verbatim check", orig.id, "Replying verbatim.");
  const reply = await createMessage(ch.id, "user", alice.id, rawQuote);

  const agentRes = await fetch(
    `${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent("#agent-room")}&consume=false`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(agentRes.status, 200);
  const agentData = await agentRes.json() as { messages: Array<Record<string, unknown>> };
  const agentRow = agentData.messages.find((m) => m.id === reply.id);
  assert.ok(agentRow);
  assert.equal(agentRow.content, rawQuote);
  assert.equal(Object.hasOwn(agentRow, "resolvedQuotes"), false);
});
