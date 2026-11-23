// Agent API auth suite: reactions and thread follow/unfollow.
// Shared fixtures: ./internalAgentApi.auth.testkit.ts.
import { createApiTest } from "../test/integration/apiTest";
import { refusalBody } from "../lib/refusal";
import { MESSAGE_NOT_FOUND_REFUSAL } from "./agentRouteRefusals";
import { tokenForHuman } from "../test/integration/credentials";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { jointChannels, jointChannelServers, messageReactions, messages, threadFollows } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createChannel, addAgent, addHuman, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { seedJointChannel } from "../test/integration/jointFixture";
import { jsonHeaders, installFakeIo, mintAgentKey, seedAuthFixture } from "./internalAgentApi.auth.testkit";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("agent-api reactions cloak private message existence before system-message checks", async ({ app }) => {
  const fixture = await seedAuthFixture();

  const privateChannel = await createChannel(
    fixture.serverId,
    `agent-api-private-reactions-${randomUUID()}`,
    "private reaction probe target",
    "private",
  );
  await addHuman(privateChannel.id, fixture.ownerId);

  const privateChatMessage = await createMessage(
    privateChannel.id,
    "user",
    fixture.ownerId,
    "private chat reaction probe",
  );
  const privateSystemMessage = await createMessage(
    privateChannel.id,
    "user",
    "system",
    "private system reaction probe",
    "system",
  );

  const addChat = await fetch(`${app.baseUrl}/internal/agent-api/messages/${privateChatMessage.id}/reactions`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(addChat.status, 404, `expected private chat add 404, got ${addChat.status}`);

  const removeChat = await fetch(`${app.baseUrl}/internal/agent-api/messages/${privateChatMessage.id}/reactions`, {
    method: "DELETE",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(removeChat.status, 404, `expected private chat remove 404, got ${removeChat.status}`);

  const addSystem = await fetch(`${app.baseUrl}/internal/agent-api/messages/${privateSystemMessage.id}/reactions`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(addSystem.status, 404, `expected private system add 404, got ${addSystem.status}`);

  const removeSystem = await fetch(`${app.baseUrl}/internal/agent-api/messages/${privateSystemMessage.id}/reactions`, {
    method: "DELETE",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(removeSystem.status, 404, `expected private system remove 404, got ${removeSystem.status}`);

  await getDb().insert(messages).values([
    {
      id: "cccccccc-1111-4111-8111-111111111111",
      channelId: privateChannel.id,
      senderType: "user",
      senderId: fixture.ownerId,
      content: "private reaction collision one",
    },
    {
      id: "cccccccc-2222-4222-8222-222222222222",
      channelId: privateChannel.id,
      senderType: "user",
      senderId: fixture.ownerId,
      content: "private reaction collision two",
    },
  ]);
  const privateCollision = await fetch(`${app.baseUrl}/internal/agent-api/messages/cccccccc/reactions`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(privateCollision.status, 404, `expected private collision add 404, got ${privateCollision.status}`);

  const [visibleCollision] = await getDb().insert(messages).values({
    id: "cccccccc-3333-4333-8333-333333333333",
    channelId: fixture.channelId,
    senderType: "user",
    senderId: fixture.ownerId,
    content: "visible reaction collision",
  }).returning();
  const visibleCollisionAdd = await fetch(`${app.baseUrl}/internal/agent-api/messages/cccccccc/reactions`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(visibleCollisionAdd.status, 200, `expected visible collision add 200, got ${visibleCollisionAdd.status}`);
  const persistedCollision = await getDb()
    .select()
    .from(messageReactions)
    .where(eq(messageReactions.messageId, visibleCollision.id));
  assert.equal(persistedCollision.length, 1);
  assert.equal(persistedCollision[0]?.reactorId, fixture.agentId);
});

test("agent-api reactions add idempotently and remove for the bound runner agent", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const message = await createMessage(
    fixture.channelId,
    "user",
    fixture.ownerId,
    "agent-api reaction target",
  );

  const add = async () => fetch(`${app.baseUrl}/internal/agent-api/messages/${message.id}/reactions`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ emoji: "👀" }),
  });

  const first = await add();
  assert.equal(first.status, 200);
  const firstBody = await first.json() as {
    reactions: Array<{ emoji: string; count: number; reactorIds: string[]; reactorNames: string[] }>;
  };
  assert.deepEqual(firstBody.reactions, [{
    emoji: "👀",
    count: 1,
    reactorIds: [fixture.agentId],
    reactorNames: ["AgentApiAuthBot"],
    // Typed for agents (#wg-ax:#26): who reacted, by handle and kind.
    reactors: [{ name: "AgentApiAuthBot", kind: "agent" }],
  }]);

  const second = await add();
  assert.equal(second.status, 200);
  const secondBody = await second.json() as { reactions: Array<{ emoji: string; count: number }> };
  assert.equal(secondBody.reactions.find((reaction) => reaction.emoji === "👀")?.count, 1);

  const persisted = await getDb()
    .select()
    .from(messageReactions)
    .where(eq(messageReactions.messageId, message.id));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.reactorType, "agent");
  assert.equal(persisted[0]?.reactorId, fixture.agentId);

  const remove = await fetch(`${app.baseUrl}/internal/agent-api/messages/${message.id}/reactions`, {
    method: "DELETE",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(remove.status, 200);
  const removeBody = await remove.json() as { reactions: Array<{ emoji: string }> };
  assert.deepEqual(removeBody.reactions, []);
});

test("agent-api reactions reject a joint channel past its over-limit grace", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();
  const jointProjection = await createChannel(
    fixture.serverId,
    `agent-api-over-limit-joint-${randomUUID()}`,
    undefined,
    "joint",
  );
  await addHuman(jointProjection.id, fixture.ownerId);
  // Contract v0.3 §18.8: observed over the free-server cap more than 3 days ago.
  // Same shape as the other agent-api joint fixtures: the projection doubles
  // as the storage channel so the agent's membership check passes first.
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: jointProjection.id,
    createdByServerId: fixture.serverId,
    createdByUserId: fixture.ownerId,
    overLimitSince: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: fixture.serverId,
    localChannelId: jointProjection.id,
    role: "host",
    joinedByUserId: fixture.ownerId,
  });
  await addAgent(jointProjection.id, fixture.agentId);
  const message = await createMessage(
    jointProjection.id,
    "user",
    fixture.ownerId,
    "agent-api over-limit joint reaction target",
  );

  const add = await fetch(`${app.baseUrl}/internal/agent-api/messages/${message.id}/reactions`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(add.status, 403);
  assert.match((await add.json() as { error: string }).error, /read-only because it has more than 2 free servers/);

  const persisted = await db
    .select()
    .from(messageReactions)
    .where(eq(messageReactions.messageId, message.id));
  assert.equal(persisted.length, 0);
});

test("agent-api reactions reach a Joint Channel message through the agent's own server's copy", async ({ app }) => {
  // The fixture's server joins a Joint Channel hosted elsewhere; the message
  // lives in canonical storage, so the agent holds it through its projection.
  const fixture = await seedAuthFixture();
  const hostServer = await createServer("Agent API Joint Host", `agent-api-joint-host-${randomUUID()}`, fixture.ownerId);
  const hostAgent = await createAgent(hostServer.id, "AgentApiJointHostBot", { runtime: "claude", model: "sonnet" });
  const hostAgentKey = await mintAgentKey(hostAgent.id, ["reactions"]);
  const joint = await seedJointChannel({
    name: `agent-api-joint-react-${randomUUID().slice(0, 8)}`,
    serverIds: [hostServer.id, fixture.serverId],
    createdByUserId: fixture.ownerId,
  });
  const [hostCopy, guestCopy] = joint.projections as [typeof joint.projections[number], typeof joint.projections[number]];
  for (const projection of joint.projections) await addHuman(projection.id, fixture.ownerId);
  await addAgent(hostCopy.id, hostAgent.id);
  const message = await createMessage(joint.canonical.id, "user", fixture.ownerId, "agent-api joint reaction target");

  const react = (apiKey: string, messageId = message.id, emoji = "👀") => fetch(`${app.baseUrl}/internal/agent-api/messages/${messageId}/reactions`, {
    method: "POST",
    headers: jsonHeaders(apiKey),
    body: JSON.stringify({ emoji }),
  });
  const reactors = async () => (await getDb().select().from(messageReactions).where(eq(messageReactions.messageId, message.id)))
    .map((row) => row.reactorId).sort();

  // Not a member of its server's copy: refused like any channel it isn't in.
  const outside = await react(fixture.agentApiKey);
  assert.equal(outside.status, 404);
  assert.deepEqual(await outside.json(), refusalBody(MESSAGE_NOT_FOUND_REFUSAL), "the plain message not-found");
  assert.deepEqual(await reactors(), []);

  await addAgent(guestCopy.id, fixture.agentId);
  const guest = await react(fixture.agentApiKey);
  assert.equal(guest.status, 200, await guest.clone().text());
  const guestBody = await guest.json() as { channelId?: string; reactions: Array<{ emoji: string; reactorIds: string[] }> };
  assert.equal(guestBody.channelId, guestCopy.id, "the reply is the agent's own server's copy");
  assert.deepEqual(guestBody.reactions.map((reaction) => [reaction.emoji, reaction.reactorIds]), [["👀", [fixture.agentId]]]);

  // The host server's agent reacts through the host copy, onto the same message.
  const host = await react(hostAgentKey, message.id, "👍");
  assert.equal(host.status, 200, await host.clone().text());
  assert.deepEqual(await reactors(), [fixture.agentId, hostAgent.id].sort());

  // People on both servers see both reactions on their own copy.
  const humanToken = await tokenForHuman(fixture.ownerEmail);
  for (const projection of joint.projections) {
    const page = await fetch(`${app.baseUrl}/api/messages/channel/${projection.id}?limit=10`, {
      headers: { Authorization: `Bearer ${humanToken}`, "X-Server-Id": projection.serverId },
    });
    assert.equal(page.status, 200);
    const row = (await page.json() as { messages: Array<{ id: string; reactions?: Array<{ emoji: string }> }> }).messages
      .find((item) => item.id === message.id);
    assert.deepEqual(row?.reactions?.map((reaction) => reaction.emoji).sort(), ["👀", "👍"].sort(), `seen from ${projection.serverId}`);
  }

  // A message on another server's ordinary channel stays out of reach.
  const elsewhere = await createChannel(hostServer.id, `agent-api-joint-elsewhere-${randomUUID().slice(0, 6)}`);
  const foreign = await createMessage(elsewhere.id, "user", fixture.ownerId, "another server's message");
  const crossServer = await react(fixture.agentApiKey, foreign.id);
  assert.equal(crossServer.status, 404);
  assert.deepEqual(await crossServer.json(), refusalBody(MESSAGE_NOT_FOUND_REFUSAL), "another server's message reads as no message");
  assert.equal((await getDb().select().from(messageReactions).where(eq(messageReactions.messageId, foreign.id))).length, 0);
});

test("agent-api reactions work on thread replies", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const parent = await createMessage(
    fixture.channelId,
    "user",
    fixture.ownerId,
    "agent-api reaction thread parent",
  );
  const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
  const reply = await createMessage(
    thread.id,
    "user",
    fixture.ownerId,
    "agent-api reaction thread reply",
  );

  const add = await fetch(`${app.baseUrl}/internal/agent-api/messages/${reply.id.slice(0, 8)}/reactions`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(add.status, 200);
  const addBody = await add.json() as {
    reactions: Array<{ emoji: string; count: number; reactorIds: string[] }>;
  };
  assert.deepEqual(addBody.reactions, [{
    emoji: "👀",
    count: 1,
    reactorIds: [fixture.agentId],
    reactorNames: ["AgentApiAuthBot"],
    // Typed for agents (#wg-ax:#26): who reacted, by handle and kind.
    reactors: [{ name: "AgentApiAuthBot", kind: "agent" }],
  }]);

  const remove = await fetch(`${app.baseUrl}/internal/agent-api/messages/${reply.id.slice(0, 8)}/reactions`, {
    method: "DELETE",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(remove.status, 200);
  const removeBody = await remove.json() as { reactions: Array<{ emoji: string }> };
  assert.deepEqual(removeBody.reactions, []);
});

test("agent-api reactions reject malformed message ids without a server error", async ({ app }) => {
  const fixture = await seedAuthFixture();

  const res = await fetch(`${app.baseUrl}/internal/agent-api/messages/not-a-message-id/reactions`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error?: string; code?: string };
  assert.deepEqual([body.code, body.error], ["INVALID_ARG", "A message id is a full UUID or the 8-character short id a message line shows (msg=): check the id."]);
});

test("agent-api thread list returns active followed threads for the bound runner identity", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();
  const activeParent = await createMessage(
    fixture.channelId,
    "user",
    fixture.ownerId,
    "agent-api followed thread parent",
  );
  const activeThread = await getOrCreateThread(activeParent.id, fixture.ownerId, "user");
  const unfollowedParent = await createMessage(
    fixture.channelId,
    "user",
    fixture.ownerId,
    "agent-api unfollowed thread parent",
  );
  const unfollowedThread = await getOrCreateThread(unfollowedParent.id, fixture.ownerId, "user");
  const otherAgent = await createAgent(fixture.serverId, `thread-list-other-${randomUUID().slice(0, 8)}`, {
    runtime: "claude",
    model: "sonnet",
  });
  await addAgent(fixture.channelId, otherAgent.id);
  const otherAgentParent = await createMessage(
    fixture.channelId,
    "user",
    fixture.ownerId,
    "agent-api other agent followed thread parent",
  );
  const otherAgentThread = await getOrCreateThread(otherAgentParent.id, fixture.ownerId, "user");
  const privateChannel = await createChannel(
    fixture.serverId,
    `agent-api-thread-list-private-${randomUUID().slice(0, 8)}`,
    undefined,
    "private",
  );
  await addHuman(privateChannel.id, fixture.ownerId);
  const hiddenParent = await createMessage(
    privateChannel.id,
    "user",
    fixture.ownerId,
    "agent-api hidden followed thread parent",
  );
  const hiddenThread = await getOrCreateThread(hiddenParent.id, fixture.ownerId, "user");
  const followedAt = new Date("2026-09-10T12:00:00.000Z");

  await db.insert(threadFollows).values([
    {
      threadChannelId: activeThread.id,
      followerType: "agent",
      followerId: fixture.agentId,
      parentMessageId: activeParent.id,
      reason: "manual",
      createdAt: followedAt,
    },
    {
      threadChannelId: unfollowedThread.id,
      followerType: "agent",
      followerId: fixture.agentId,
      parentMessageId: unfollowedParent.id,
      reason: "mentioned",
      createdAt: new Date("2026-09-10T11:00:00.000Z"),
      unfollowedAt: new Date("2026-09-10T11:30:00.000Z"),
    },
    {
      threadChannelId: otherAgentThread.id,
      followerType: "agent",
      followerId: otherAgent.id,
      parentMessageId: otherAgentParent.id,
      reason: "manual",
      createdAt: new Date("2026-09-10T10:00:00.000Z"),
    },
    {
      threadChannelId: hiddenThread.id,
      followerType: "agent",
      followerId: fixture.agentId,
      parentMessageId: hiddenParent.id,
      reason: "manual",
      createdAt: new Date("2026-09-10T13:00:00.000Z"),
    },
  ]);

  const res = await fetch(`${app.baseUrl}/internal/agent-api/threads`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  const body = await res.json() as {
    error?: string;
    threads: Array<{
      target: string;
      threadChannelId: string;
      parentChannelRef: string;
      parentMessageId: string;
      parentMessageShortId: string;
      followedAt: string;
      reason: string;
      doneAt: string | null;
    }>;
  };

  assert.equal(res.status, 200, body.error);
  assert.deepEqual(body.threads, [{
    target: `#${fixture.channelName}:${activeParent.id.slice(0, 8)}`,
    threadChannelId: activeThread.id,
    parentChannelRef: `#${fixture.channelName}`,
    parentMessageId: activeParent.id,
    parentMessageShortId: activeParent.id.slice(0, 8),
    followedAt: followedAt.toISOString(),
    reason: "manual",
    doneAt: null,
  }]);
});

test("agent-api thread unfollow cloaks inaccessible private thread UUIDs", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const privateChannel = await createChannel(fixture.serverId, "agent-api-private-thread-unfollow", undefined, "private");
  await addHuman(privateChannel.id, fixture.ownerId);
  const parent = await createMessage(
    privateChannel.id,
    "user",
    fixture.ownerId,
    "agent-api private unfollow parent",
  );
  const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");

  const threadRes = await fetch(`${app.baseUrl}/internal/agent-api/threads/unfollow`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ thread: thread.id }),
  });
  assert.equal(threadRes.status, 404);
  // Missing and not visible answer the same body, whatever form the target took.
  const notFound = await threadRes.json() as { code?: string };
  assert.equal(notFound.code, "thread_not_found");

  const shortRefRes = await fetch(`${app.baseUrl}/internal/agent-api/threads/unfollow`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ thread: `#${privateChannel.name}:${parent.id.slice(0, 8)}` }),
  });
  assert.equal(shortRefRes.status, 404);
  assert.deepEqual(await shortRefRes.json(), notFound);

  const privateChannelRes = await fetch(`${app.baseUrl}/internal/agent-api/threads/unfollow`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ thread: privateChannel.id }),
  });
  assert.equal(privateChannelRes.status, 404);
  assert.deepEqual(await privateChannelRes.json(), notFound);
});

test("agent-api thread follow answers a hidden thread exactly as a missing one, by UUID, short ref or channel", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const privateChannel = await createChannel(fixture.serverId, "agent-api-private-thread-follow", undefined, "private");
  await addHuman(privateChannel.id, fixture.ownerId);
  const parent = await createMessage(
    privateChannel.id,
    "user",
    fixture.ownerId,
    "agent-api private follow parent",
  );
  const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");

  const threadRes = await fetch(`${app.baseUrl}/internal/agent-api/threads/follow`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ thread: thread.id }),
  });
  assert.equal(threadRes.status, 404);
  // Missing and not visible answer the same body, whatever form the target took.
  const notFound = await threadRes.json() as { code?: string };
  assert.equal(notFound.code, "thread_not_found");

  const shortRefRes = await fetch(`${app.baseUrl}/internal/agent-api/threads/follow`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ thread: `#${privateChannel.name}:${parent.id.slice(0, 8)}` }),
  });
  assert.equal(shortRefRes.status, 404);
  assert.deepEqual(await shortRefRes.json(), notFound);

  const privateChannelRes = await fetch(`${app.baseUrl}/internal/agent-api/threads/follow`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ thread: privateChannel.id }),
  });
  assert.equal(privateChannelRes.status, 404);
  assert.deepEqual(await privateChannelRes.json(), notFound);
  const missingRes = await fetch(`${app.baseUrl}/internal/agent-api/threads/follow`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ thread: randomUUID() }),
  });
  assert.equal(missingRes.status, 404);
  assert.deepEqual(await missingRes.json(), notFound);
});

test("agent-api thread unfollow suppresses ordinary delivery for the bound runner agent", async ({ app }) => {
  const events = installFakeIo(app.app);
  const fixture = await seedAuthFixture();
  const db = getDb();
  const parent = await createMessage(
    fixture.channelId,
    "user",
    fixture.ownerId,
    "agent-api unfollow parent",
  );
  const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
  await db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "agent",
    followerId: fixture.agentId,
    parentMessageId: parent.id,
    reason: "manual",
  }).onConflictDoNothing();

  const res = await fetch(`${app.baseUrl}/internal/agent-api/threads/unfollow`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ thread: thread.id }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const [row] = await db
    .select({
      threadChannelId: threadFollows.threadChannelId,
      unfollowedAt: threadFollows.unfollowedAt,
    })
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, thread.id),
      eq(threadFollows.followerType, "agent"),
      eq(threadFollows.followerId, fixture.agentId),
    ));
  assert.equal(row?.threadChannelId, thread.id);
  assert.ok(row?.unfollowedAt, "agent unfollow should tombstone the bound agent's ordinary delivery row");
  assert.ok(
    events.some((event) => (
      event.room === `channel:${thread.id}`
      && event.event === "thread:followers-updated"
      && JSON.stringify(event.payload) === JSON.stringify({ threadChannelId: thread.id })
    )),
    "agent-api unfollow must refresh already-open follower rosters without a later message",
  );
});
