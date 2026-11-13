import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
import { seedBoundGuest } from "../test/guestFixture";
import { seedJointChannel } from "../test/integration/jointFixture";
/**
 * Forward into a thread or task conversation (#proj-chat:#20): a destination
 * may be a thread / task conversation id, admitted exactly like a reply there
 * and delivered like one; the picker lists and searches only the threads and
 * task conversations the person can see and post in; a task source names
 * its task title only when the source is public.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { vi } from "vitest";

import { getDb } from "../db/index";
import { channelHumans, inboxNotificationFacts, jointMembershipDepartures, jointMembershipRemovals, messages, servers, serverMembers, threadFollows, users } from "../db/schema";
import {
  addHuman,
  archiveChannel,
  createChannel,
  findOrCreateUserDM,
  getActiveJointThreadProjectionsByCanonicalThread,
  getOrCreateThread,
  getOrCreateThreadForChannel,
  getThreadInfo,
  recordThreadFollow,
} from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import { createTasks } from "../services/taskService";
import { ensureTaskConversation, getTaskConversation } from "../services/taskConversationService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// A one-shot hook run when a writer opens its persistence transaction: after
// every route check, before the commit-time ones. Unarmed, a pass-through.
const writerFence = vi.hoisted(() => ({ beforeNext: null as null | (() => Promise<void>) }));
vi.mock("../services/channelConversionFenceService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/channelConversionFenceService")>();
  return {
    ...actual,
    withChannelWriterFence: async (...args: Parameters<typeof actual.withChannelWriterFence>) => {
      const hook = writerFence.beforeNext;
      writerFence.beforeNext = null;
      await hook?.();
      return actual.withChannelWriterFence(...args);
    },
  };
});

type EmittedEvent = { room: string; event: string; payload: { parentMessageId?: string; replyCount?: number } };
type TargetRow = { type: string; channelId: string; title: string; current?: boolean; taskNumber?: number };
type ForwardedItem = {
  contentSnapshot: string;
  sourceTaskId?: string;
  sourceTaskNumber?: number;
  sourceTaskTitle?: string;
  sourceTargetSnapshot: { labelVisibility: string };
};

function installFakeIo(app: { app: { set(key: string, value: unknown): void } }): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  const joiner = (room: string) => ({
    socketsJoin(_joinRoom: string) {
      events.push({ room, event: "socketsJoin", payload: {} });
    },
  });
  app.app.set("io", {
    to(room: string) {
      return { emit(event: string, payload: unknown) { events.push({ room, event, payload: payload as EmittedEvent["payload"] }); } };
    },
    in(room: string) {
      return { ...joiner(room), in: () => joiner(room) };
    },
  });
  return events;
}

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 6)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  }).returning();
  return user!;
}

function headers(token: string, serverId: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Server-Id": serverId };
}

/**
 * A server with an owner (the forwarder) and a member, both in a public
 * `room` and a `source` channel holding the message that gets forwarded.
 */
async function fixture(slug: string) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const server = await createServer(`Forward thread ${slug}`, `${slug}-${randomUUID().slice(0, 8)}`, owner.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" }).onConflictDoNothing();
  const room = await createChannel(server.id, `${slug}-room`);
  const source = await createChannel(server.id, `${slug}-source`);
  for (const channel of [room, source]) {
    await addHuman(channel.id, owner.id);
    await addHuman(channel.id, member.id);
  }
  await enableTaskV2ConversationsForServer(server.id);
  const sourceMessage = await createMessage(source.id, "user", owner.id, "the forwarded decision");
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
  return { owner, member, server, room, source, sourceMessage, ownerToken, memberToken };
}

async function threadIn(channelId: string, authorId: string, content: string) {
  const parent = await createMessage(channelId, "user", authorId, content);
  const thread = await getOrCreateThread(parent.id, authorId, "user");
  return { parent, threadId: thread.id };
}

async function taskConversationIn(channelId: string, creatorId: string, title: string, serverId: string) {
  const created = await createTasks(channelId, "user", creatorId, [{ title }], { initiatingServerId: serverId });
  const task = created.tasks[0]!;
  await ensureTaskConversation(task.id, { initiatingServerId: serverId, createdByUserId: creatorId });
  const conversation = await getTaskConversation(task.id);
  assert.ok(conversation);
  return { task, conversationId: conversation!.canonicalChannelId };
}

async function forward(baseUrl: string, token: string, serverId: string, destinationChannelId: string, sourceMessageIds: string[]) {
  return fetch(`${baseUrl}/api/messages/forward`, {
    method: "POST",
    headers: headers(token, serverId),
    body: JSON.stringify({ destinationChannelId, sourceMessageIds, note: "" }),
  });
}

async function messagesIn(channelId: string) {
  return getDb().select().from(messages).where(eq(messages.channelId, channelId));
}

async function factFor(receiverId: string, sourceChannelId: string, messageId: string) {
  const [fact] = await getDb().select().from(inboxNotificationFacts).where(and(
    eq(inboxNotificationFacts.receiverId, receiverId),
    eq(inboxNotificationFacts.sourceChannelId, sourceChannelId),
    eq(inboxNotificationFacts.messageId, messageId),
  ));
  return fact ?? null;
}

async function followOf(userId: string, channelId: string) {
  const [row] = await getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, channelId),
    eq(threadFollows.followerType, "user"),
    eq(threadFollows.followerId, userId),
  ));
  return row ?? null;
}

test("forwarding into a thread lands as a reply: reply count, thread summary, follow, and a follower's notification", async ({ app }) => {
  const events = installFakeIo(app);
  const { owner, member, server, room, sourceMessage, ownerToken } = await fixture("fwdthr");
  const { parent, threadId } = await threadIn(room.id, member.id, "release plan");
  const follower = await seedUser("fwdthr-follower");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: follower.id, role: "member" });
  await addHuman(room.id, follower.id);
  await recordThreadFollow("user", follower.id, threadId, parent.id, "manual");

  const res = await forward(app.baseUrl, ownerToken, server.id, threadId, [sourceMessage.id]);
  assert.equal(res.status, 200, await res.clone().text());
  // "View in chat" opens the thread from the answer's conversation context.
  const answer = (await res.json()) as { conversationContext?: { channelType: string; parentMessageId?: string; parentChannelId?: string } };
  assert.equal(answer.conversationContext?.channelType, "thread");
  assert.equal(answer.conversationContext?.parentMessageId, parent.id);
  assert.equal(answer.conversationContext?.parentChannelId, room.id);

  const [forwarded, ...rest] = await messagesIn(threadId);
  assert.equal(rest.length, 0);
  assert.equal((forwarded!.actionMetadata as { kind: string }).kind, "forwarded-bundle");
  assert.equal((await getThreadInfo(parent.id))?.replyCount, 1, "counted as the thread's reply");
  const summary = events.find((event) => event.event === "thread:updated" && event.room === `channel:${room.id}`);
  assert.equal(summary?.payload.parentMessageId, parent.id, "the parent channel gets the thread summary update");
  assert.equal(summary?.payload.replyCount, 1);
  assert.equal((await followOf(owner.id, threadId))?.reason, "replied", "the forwarder follows, as a replier does");
  const fact = await factFor(follower.id, threadId, forwarded!.id);
  assert.equal(fact?.kind, "thread", "a follower is notified as for a reply");
  assert.equal(fact?.unreadEligible, true);
});

test("forwarding into a task conversation lands there and notifies the task's creator", async ({ app }) => {
  installFakeIo(app);
  const { owner, member, server, room, sourceMessage, ownerToken } = await fixture("fwdtask");
  const { task, conversationId } = await taskConversationIn(room.id, member.id, "ship the forward picker", server.id);

  const res = await forward(app.baseUrl, ownerToken, server.id, conversationId, [sourceMessage.id]);
  assert.equal(res.status, 200, await res.clone().text());
  const answer = (await res.json()) as { conversationContext?: { channelType: string; taskId?: string; parentChannelId?: string } };
  assert.equal(answer.conversationContext?.channelType, "task");
  assert.equal(answer.conversationContext?.taskId, task.id);
  assert.equal(answer.conversationContext?.parentChannelId, room.id);

  const [forwarded] = await messagesIn(conversationId);
  assert.ok(forwarded, "the bundle is in the task conversation");
  assert.equal((await factFor(member.id, conversationId, forwarded!.id))?.kind, "task");
  assert.equal((await followOf(owner.id, conversationId))?.reason, "replied");
});

test("a thread whose parent message was deleted is refused and nothing is written", async ({ app }) => {
  const { server, room, member, sourceMessage, ownerToken } = await fixture("fwddel");
  const { parent, threadId } = await threadIn(room.id, member.id, "retracted");
  await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, parent.id));

  const res = await forward(app.baseUrl, ownerToken, server.id, threadId, [sourceMessage.id]);
  assert.equal(res.status, 404, await res.clone().text());
  assert.equal(((await res.json()) as { code: string }).code, "destination_unavailable");
  assert.equal((await messagesIn(threadId)).length, 0);
});

test("a thread of an archived channel is refused like a reply there, and nothing is written", async ({ app }) => {
  const { owner, server, room, sourceMessage, ownerToken } = await fixture("fwdarch");
  const { threadId } = await threadIn(room.id, owner.id, "before archive");
  await archiveChannel(room.id, owner.id);

  const res = await forward(app.baseUrl, ownerToken, server.id, threadId, [sourceMessage.id]);
  assert.equal(res.status, 409, await res.clone().text());
  assert.equal(((await res.json()) as { code: string }).code, "channel_archived");
  assert.equal((await messagesIn(threadId)).length, 0);
});

test("a thread of a private channel the forwarder is not in is refused, and nothing is written", async ({ app }) => {
  const { owner, server, sourceMessage, memberToken } = await fixture("fwdpriv");
  const privateRoom = await createChannel(server.id, `fwdpriv-secret-${randomUUID().slice(0, 6)}`, undefined, "private");
  await addHuman(privateRoom.id, owner.id);
  const { threadId } = await threadIn(privateRoom.id, owner.id, "private plan");

  const res = await forward(app.baseUrl, memberToken, server.id, threadId, [sourceMessage.id]);
  assert.equal(res.status, 403, await res.clone().text());
  assert.equal(((await res.json()) as { code: string }).code, "destination_unavailable");
  assert.equal((await messagesIn(threadId)).length, 0);
});

test("a guest forwards into a thread of its own channel, never into a thread of another channel", async ({ app }) => {
  installFakeIo(app);
  const { owner, server, room } = await fixture("fwdguest");
  const guest = await seedUser("fwdguest-guest");
  const guestRoom = await createChannel(server.id, `fwdguest-own-${randomUUID().slice(0, 6)}`);
  await addHuman(guestRoom.id, owner.id);
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: guestRoom.id });
  // Even a stale membership row in another channel grants a guest nothing.
  await getDb().insert(channelHumans).values({ channelId: room.id, userId: guest.id }).onConflictDoNothing();
  const guestToken = await tokenForHuman(guest.email);
  const sourceMessage = await createMessage(guestRoom.id, "user", guest.id, "guest note");
  const own = await threadIn(guestRoom.id, owner.id, "own thread");
  const other = await threadIn(room.id, owner.id, "other thread");

  const refused = await forward(app.baseUrl, guestToken, server.id, other.threadId, [sourceMessage.id]);
  assert.equal(refused.status, 403, await refused.clone().text());
  assert.equal((await messagesIn(other.threadId)).length, 0);

  const allowed = await forward(app.baseUrl, guestToken, server.id, own.threadId, [sourceMessage.id]);
  assert.equal(allowed.status, 200, await allowed.clone().text());
  assert.equal((await messagesIn(own.threadId)).length, 1);
});

test("conversations: at most 4 visible, postable threads and tasks, the current one first, newest activity next", async ({ app }) => {
  const { owner, member, server, room, memberToken } = await fixture("fwdconv");
  const threads: string[] = [];
  for (const index of [1, 2, 3, 4, 5]) {
    const { parent, threadId } = await threadIn(room.id, owner.id, `topic ${index}`);
    await recordThreadFollow("user", member.id, threadId, parent.id, "manual");
    threads.push(threadId);
  }
  // A followed thread of a private channel the member is not in, and one of an
  // archived channel: both newer than every other thread, neither listed.
  const privateRoom = await createChannel(server.id, `fwdconv-secret-${randomUUID().slice(0, 6)}`, undefined, "private");
  await addHuman(privateRoom.id, owner.id);
  const hidden = await threadIn(privateRoom.id, owner.id, "hidden topic");
  await recordThreadFollow("user", member.id, hidden.threadId, hidden.parent.id, "manual");
  const archivedRoom = await createChannel(server.id, `fwdconv-archived-${randomUUID().slice(0, 6)}`);
  await addHuman(archivedRoom.id, owner.id);
  await addHuman(archivedRoom.id, member.id);
  const archived = await threadIn(archivedRoom.id, owner.id, "archived topic");
  await recordThreadFollow("user", member.id, archived.threadId, archived.parent.id, "manual");
  for (const threadId of threads) await createMessage(threadId, "user", owner.id, "activity");
  await createMessage(hidden.threadId, "user", owner.id, "newest, but hidden");
  await createMessage(archived.threadId, "user", owner.id, "newest, but archived");
  await archiveChannel(archivedRoom.id, owner.id);

  const res = await fetch(
    `${app.baseUrl}/api/messages/forward/targets/conversations?limit=10&currentChannelId=${threads[0]}`,
    { headers: headers(memberToken, server.id) },
  );
  assert.equal(res.status, 200, await res.clone().text());
  const { targets } = (await res.json()) as { targets: TargetRow[] };
  assert.deepEqual(
    targets.map((target) => [target.channelId, target.current === true]),
    [[threads[0], true], [threads[4], false], [threads[3], false], [threads[2], false]],
  );
  assert.deepEqual(targets[1], {
    type: "thread",
    channelType: "thread",
    id: threads[4],
    channelId: threads[4],
    title: `#${room.name} › topic 5`,
    subtitle: "",
    avatarUrl: null,
    parentChannelId: room.id,
    parentChannelName: room.name,
    parentChannelType: "channel",
    parentMessagePreview: "topic 5",
    joined: true,
    dmExists: null,
    canForwardNow: true,
    requiredAction: null,
  });
  assert.ok(!JSON.stringify(targets).includes("hidden topic"));
});

test("search returns thread and task rows only for conversations the caller can see", async ({ app }) => {
  const { owner, member, server, room, memberToken } = await fixture("fwdsrch");
  const visible = await threadIn(room.id, owner.id, "zephyr rollout notes\nsecond line");
  await recordThreadFollow("user", member.id, visible.threadId, visible.parent.id, "manual");
  const privateRoom = await createChannel(server.id, `fwdsrch-secret-${randomUUID().slice(0, 6)}`, undefined, "private");
  await addHuman(privateRoom.id, owner.id);
  const hidden = await threadIn(privateRoom.id, owner.id, "zephyr private plans");
  await recordThreadFollow("user", member.id, hidden.threadId, hidden.parent.id, "manual");
  const { task, conversationId } = await taskConversationIn(room.id, member.id, "zephyr picker task", server.id);
  const hiddenTask = await taskConversationIn(privateRoom.id, owner.id, "zephyr private task", server.id);
  await recordThreadFollow("user", member.id, hiddenTask.conversationId, null, "manual", { parentTaskId: hiddenTask.task.id });

  const search = async (q: string) => {
    const res = await fetch(`${app.baseUrl}/api/messages/forward/targets/search?q=${encodeURIComponent(q)}`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { targets: TargetRow[] }).targets;
  };

  const rows = (await search("zephyr")).filter((target) => target.type === "thread" || target.type === "task");
  assert.deepEqual(rows.map((row) => row.channelId).sort(), [visible.threadId, conversationId].sort());
  const taskRow = rows.find((row) => row.type === "task")!;
  assert.equal(taskRow.title, `#${room.name}:#${task.taskNumber} zephyr picker task`);
  assert.equal(taskRow.taskNumber, task.taskNumber);
  const body = JSON.stringify(await search("zephyr"));
  assert.ok(!body.includes("private plans") && !body.includes("private task"), "nothing of a hidden conversation leaks");

  const byNumber = (await search(`#${task.taskNumber}`)).filter((target) => target.type === "task");
  assert.ok(byNumber.some((row) => row.channelId === conversationId), "a task matches its number");
});

test("on a Free server, a thread whose parent is behind the history window shows and matches only its 40-character glimpse", async ({ app }) => {
  const { owner, member, server, room, memberToken } = await fixture("fwdwin");
  const db = getDb();
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  // The glimpse is the first 39 characters and an ellipsis; "quasar" sits past it.
  const oldText = "kestrel budget review for the next year with quasar secret numbers";
  const old = await threadIn(room.id, owner.id, oldText);
  await db.update(messages).set({ createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) }).where(eq(messages.id, old.parent.id));
  await recordThreadFollow("user", member.id, old.threadId, old.parent.id, "manual");
  const recent = await threadIn(room.id, owner.id, "kestrel recent topic with quasar inside");
  await recordThreadFollow("user", member.id, recent.threadId, recent.parent.id, "manual");
  const glimpse = `${Array.from(oldText).slice(0, 39).join("")}…`;

  const listed = await fetch(
    `${app.baseUrl}/api/messages/forward/targets/conversations?limit=4&currentChannelId=${old.threadId}`,
    { headers: headers(memberToken, server.id) },
  );
  assert.equal(listed.status, 200, await listed.clone().text());
  const { targets } = (await listed.json()) as { targets: Array<TargetRow & { parentMessagePreview?: string }> };
  const current = targets.find((target) => target.channelId === old.threadId && target.current === true);
  assert.equal(current?.parentMessagePreview, glimpse, "the current thread: only the glimpse");
  assert.ok(!JSON.stringify(targets).includes("secret numbers"), "nothing past the glimpse is listed");
  assert.equal(targets.find((target) => target.channelId === recent.threadId)?.parentMessagePreview, "kestrel recent topic with quasar inside");

  const search = async (q: string) => {
    const res = await fetch(`${app.baseUrl}/api/messages/forward/targets/search?q=${encodeURIComponent(q)}`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { targets: Array<TargetRow & { parentMessagePreview?: string }> }).targets
      .filter((target) => target.type === "thread");
  };
  // Text past the glimpse finds only the thread inside the window.
  assert.deepEqual((await search("quasar")).map((row) => row.channelId), [recent.threadId]);
  // Text inside the glimpse still finds the old thread, shown as the glimpse.
  const byGlimpse = (await search("kestrel budget")).find((row) => row.channelId === old.threadId);
  assert.equal(byGlimpse?.parentMessagePreview, glimpse);
});

test("a forwarded task source carries its title when public, and not when private", async ({ app }) => {
  installFakeIo(app);
  const { owner, server, room, ownerToken } = await fixture("fwdsrc");
  const destination = await createChannel(server.id, `fwdsrc-dest-${randomUUID().slice(0, 6)}`);
  await addHuman(destination.id, owner.id);
  const privateRoom = await createChannel(server.id, `fwdsrc-secret-${randomUUID().slice(0, 6)}`, undefined, "private");
  await addHuman(privateRoom.id, owner.id);

  const itemFor = async (channelId: string, title: string) => {
    const { task, conversationId } = await taskConversationIn(channelId, owner.id, title, server.id);
    const reply = await createMessage(conversationId, "user", owner.id, `reply in ${title}`);
    const res = await forward(app.baseUrl, ownerToken, server.id, destination.id, [reply.id]);
    assert.equal(res.status, 200, await res.clone().text());
    const items = (await messagesIn(destination.id))
      .map((message) => (message.actionMetadata as { forwardedItems: ForwardedItem[] }).forwardedItems[0]);
    return { task, item: items.find((item) => item?.contentSnapshot === reply.content)! };
  };

  const pub = await itemFor(room.id, "public task title");
  assert.equal(pub.item.sourceTaskTitle, "public task title");
  assert.equal(pub.item.sourceTaskNumber, pub.task.taskNumber);

  const priv = await itemFor(privateRoom.id, "private task title");
  assert.equal(priv.item.sourceTaskTitle, undefined);
  assert.equal(priv.item.sourceTaskId, undefined);
  assert.equal(priv.item.sourceTargetSnapshot.labelVisibility, "restricted");
});

type ReadItem = ForwardedItem & {
  sourceMessageId: string | null;
  sourceServerId: string | null;
  sourceTargetId: string | null;
  sourceThreadId?: string | null;
  parentChannelId?: string | null;
  provenanceState?: string;
  sourceTargetSnapshot: { id: string | null; label: string; labelVisibility: string };
};

/** The forwarded items of `channelId`'s page, as `token` reads it through the ordinary message read. */
async function readForwardedItems(baseUrl: string, token: string, serverId: string, channelId: string) {
  const res = await fetch(`${baseUrl}/api/messages/channel/${channelId}?limit=50`, { headers: headers(token, serverId) });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.text();
  const { messages: page } = JSON.parse(body) as { messages: Array<{ actionMetadata?: { kind?: string; forwardedItems?: ReadItem[] } }> };
  const items = page
    .filter((message) => message.actionMetadata?.kind === "forwarded-bundle")
    .flatMap((message) => message.actionMetadata!.forwardedItems ?? []);
  return { items, body };
}

test("forwarding into a joint thread: the other server's member reads the content, never pointers to a source it can't see", async ({ app }) => {
  installFakeIo(app);
  const { owner, server, source, ownerToken } = await fixture("fwdjoint");
  const peerOwner = await seedUser("fwdjoint-peer-owner");
  const peerMember = await seedUser("fwdjoint-peer-member");
  const peerServer = await createServer("Forward thread joint peer", `fwdjoint-peer-${randomUUID().slice(0, 8)}`, peerOwner.id);
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, peerServer.id));
  await getDb().insert(serverMembers).values({ serverId: peerServer.id, userId: peerMember.id, role: "member" }).onConflictDoNothing();
  const joint = await seedJointChannel({
    name: `fwdjoint-${randomUUID().slice(0, 6)}`,
    serverIds: [server.id, peerServer.id],
    createdByUserId: owner.id,
  });
  const [hostProjection, peerProjection] = joint.projections;
  await addHuman(hostProjection!.id, owner.id);
  await addHuman(peerProjection!.id, peerMember.id);
  const root = await createMessage(joint.canonical.id, "user", owner.id, "joint launch plan");
  const hostThread = await getOrCreateThreadForChannel(hostProjection!.id, root.id, owner.id, "user");
  const peerThreadId = (await getActiveJointThreadProjectionsByCanonicalThread(hostThread.canonicalThreadChannelId))
    .find((projection) => projection.localServerId === peerServer.id)?.localThreadChannelId;
  assert.ok(peerThreadId, "the peer server has its own face of the thread");

  // Public sources on the forwarder's server: a thread reply and a task
  // conversation reply, so the stored items carry every kind of pointer.
  const sourceThread = await threadIn(source.id, owner.id, "source thread root");
  const threadReply = await createMessage(sourceThread.threadId, "user", owner.id, "the thread decision");
  const sourceTask = await taskConversationIn(source.id, owner.id, "confidential source task", server.id);
  const taskReply = await createMessage(sourceTask.conversationId, "user", owner.id, "the task decision");
  for (const reply of [threadReply, taskReply]) {
    const res = await forward(app.baseUrl, ownerToken, server.id, hostThread.id, [reply.id]);
    assert.equal(res.status, 200, await res.clone().text());
  }
  const stored = await messagesIn(hostThread.canonicalThreadChannelId);
  assert.equal(stored.length, 2, "both bundles are stored on the canonical thread");

  // The forwarder (who can see the sources) reads the pointers on its own face.
  const host = await readForwardedItems(app.baseUrl, ownerToken, server.id, hostThread.id);
  const hostThreadItem = host.items.find((item) => item.contentSnapshot === threadReply.content)!;
  const hostTaskItem = host.items.find((item) => item.contentSnapshot === taskReply.content)!;
  assert.equal(hostThreadItem.sourceThreadId, sourceThread.threadId);
  assert.equal(hostThreadItem.parentChannelId, source.id);
  assert.equal(hostTaskItem.sourceTaskId, sourceTask.task.id);
  assert.equal(hostTaskItem.sourceTaskTitle, "confidential source task");

  // The other server's member reads the same bundles through its thread face.
  const peerToken = await tokenForHuman(peerMember.email);
  const peer = await readForwardedItems(app.baseUrl, peerToken, peerServer.id, peerThreadId!);
  assert.deepEqual(
    peer.items.map((item) => item.contentSnapshot).sort(),
    [threadReply.content, taskReply.content].sort(),
    "the forwarded content is what the other server reads",
  );
  for (const item of peer.items) {
    assert.equal(Object.hasOwn(item ?? {}, "sourceMessageId"), false, "sourceMessageId is removed, not null");
    assert.equal(Object.hasOwn(item ?? {}, "sourceServerId"), false, "sourceServerId is removed, not null");
    assert.equal(Object.hasOwn(item ?? {}, "sourceTargetId"), false, "sourceTargetId is removed, not null");
    assert.equal(item.sourceThreadId ?? null, null);
    assert.equal(item.parentChannelId ?? null, null);
    assert.equal(item.sourceTaskId, undefined);
    assert.equal(item.sourceTaskNumber, undefined);
    assert.equal(item.sourceTaskTitle, undefined);
    assert.equal(item.provenanceState, "original_unavailable");
    assert.deepEqual(
      { id: item.sourceTargetSnapshot.id, label: item.sourceTargetSnapshot.label, labelVisibility: item.sourceTargetSnapshot.labelVisibility },
      { id: null, label: "", labelVisibility: "restricted" },
    );
  }
  for (const secret of [source.id, source.name, sourceThread.threadId, sourceTask.task.id, sourceTask.conversationId, "confidential source task"]) {
    assert.ok(!peer.body.includes(secret), `the other server's read names nothing of the source (${secret})`);
  }
});

test("forwarding into a DM thread: only the DM's two people may; a third member is refused and nothing is written", async ({ app }) => {
  installFakeIo(app);
  const { owner, member, server, source, sourceMessage, ownerToken, memberToken } = await fixture("fwddm");
  const peer = await seedUser("fwddm-peer");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: peer.id, role: "member" }).onConflictDoNothing();
  await addHuman(source.id, peer.id);
  const dm = await findOrCreateUserDM(server.id, member.id, peer.id);
  assert.ok(dm);
  const { threadId } = await threadIn(dm!.id, member.id, "between the two of us");

  // The server's owner sees the source but is not in the DM.
  const refused = await forward(app.baseUrl, ownerToken, server.id, threadId, [sourceMessage.id]);
  assert.equal(refused.status, 403, await refused.clone().text());
  assert.equal(((await refused.json()) as { code: string }).code, "destination_unavailable");
  assert.equal((await messagesIn(threadId)).length, 0, "nothing lands in the DM thread");
  assert.equal((await messagesIn(dm!.id)).length, 1, "nor in the DM itself");
  assert.equal(await followOf(owner.id, threadId), null, "the refused forwarder gains no follow");

  const allowed = await forward(app.baseUrl, memberToken, server.id, threadId, [sourceMessage.id]);
  assert.equal(allowed.status, 200, await allowed.clone().text());
  const [forwarded, ...rest] = await messagesIn(threadId);
  assert.equal(rest.length, 0);
  assert.equal(forwarded!.senderId, member.id);
  assert.equal((forwarded!.actionMetadata as { kind: string }).kind, "forwarded-bundle");
});

test("a joint member removed after the route's check: a forward into the joint channel or its thread is refused at commit like a reply into the channel, and nothing is written", async ({ app }) => {
  installFakeIo(app);
  const { owner, server, sourceMessage, ownerToken } = await fixture("fwdjointgone");
  const peerOwner = await seedUser("fwdjointgone-peer-owner");
  const peerServer = await createServer("Forward joint removal peer", `fwdjointgone-peer-${randomUUID().slice(0, 8)}`, peerOwner.id);
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, peerServer.id));
  const joint = await seedJointChannel({
    name: `fwdjointgone-${randomUUID().slice(0, 6)}`,
    serverIds: [server.id, peerServer.id],
    createdByUserId: owner.id,
  });
  const hostProjection = joint.projections[0]!;
  await addHuman(hostProjection.id, owner.id);
  const root = await createMessage(joint.canonical.id, "user", owner.id, "joint plan");
  const hostThread = await getOrCreateThreadForChannel(hostProjection.id, root.id, owner.id, "user");

  // A pending removal is already refused by the route's own membership check
  // (isChannelHuman), so the commit-time check is only observable when the
  // removal lands after it: record the removal (joint_membership_departures +
  // joint_membership_removals, what lockJointPostingAuthority reads) as the
  // request opens its persistence transaction, then undo it for the next one.
  const removedAfterRouteCheck = async (request: () => Promise<Response>): Promise<Response> => {
    let departureId: string | null = null;
    writerFence.beforeNext = async () => {
      const [departure] = await getDb().insert(jointMembershipDepartures).values({
        jointChannelId: joint.jointChannelId,
        serverId: server.id,
        localChannelId: hostProjection.id,
      }).returning();
      await getDb().insert(jointMembershipRemovals).values({ departureId: departure!.id, userId: owner.id });
      departureId = departure!.id;
    };
    try {
      const res = await request();
      assert.ok(departureId, "the request reached its persistence transaction");
      return res;
    } finally {
      writerFence.beforeNext = null;
      if (departureId) await getDb().delete(jointMembershipDepartures).where(eq(jointMembershipDepartures.id, departureId));
    }
  };

  // Admitted while a member: the refusals below are the removal's.
  const admitted = await forward(app.baseUrl, ownerToken, server.id, hostProjection.id, [sourceMessage.id]);
  assert.equal(admitted.status, 200, await admitted.clone().text());
  const storedBefore = (await messagesIn(joint.canonical.id)).length;

  // The control: a reply into the channel is refused at commit (a reply into
  // the Joint thread is covered by the test below).
  const reply = await removedAfterRouteCheck(() => fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ channelId: hostProjection.id, content: "a reply", randomId: randomUUID() }),
  }));
  assert.equal(reply.status, 403, await reply.clone().text());
  assert.equal(((await reply.json()) as { code: string }).code, "channel_access_changed", "a reply there is refused at commit");
  for (const channelId of [hostProjection.id, hostThread.id]) {
    const refused = await removedAfterRouteCheck(() => forward(app.baseUrl, ownerToken, server.id, channelId, [sourceMessage.id]));
    assert.equal(refused.status, 403, await refused.clone().text());
    assert.equal(((await refused.json()) as { code: string }).code, "channel_access_changed", "and so is a forward");
  }
  assert.equal((await messagesIn(joint.canonical.id)).length, storedBefore, "nothing lands in the joint channel");
  assert.equal((await messagesIn(hostThread.canonicalThreadChannelId)).length, 0, "nor in its thread");
});

test("a joint member removed after the route's check: a reply into the joint thread is refused at commit like one into the channel, and nothing is written", async ({ app }) => {
  installFakeIo(app);
  const { owner, server, ownerToken } = await fixture("replyjointgone");
  const peerOwner = await seedUser("replyjointgone-peer-owner");
  const peerServer = await createServer("Reply joint removal peer", `replyjointgone-peer-${randomUUID().slice(0, 8)}`, peerOwner.id);
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, peerServer.id));
  const joint = await seedJointChannel({
    name: `replyjointgone-${randomUUID().slice(0, 6)}`,
    serverIds: [server.id, peerServer.id],
    createdByUserId: owner.id,
  });
  const hostProjection = joint.projections[0]!;
  await addHuman(hostProjection.id, owner.id);
  const root = await createMessage(joint.canonical.id, "user", owner.id, "joint plan");
  const hostThread = await getOrCreateThreadForChannel(hostProjection.id, root.id, owner.id, "user");

  // As in the forward test above: the removal lands as the reply opens its
  // persistence transaction, after the route's own membership check, so only
  // the save-time lockJointPostingAuthority can refuse it.
  const removedAfterRouteCheck = async (request: () => Promise<Response>): Promise<Response> => {
    let departureId: string | null = null;
    writerFence.beforeNext = async () => {
      const [departure] = await getDb().insert(jointMembershipDepartures).values({
        jointChannelId: joint.jointChannelId,
        serverId: server.id,
        localChannelId: hostProjection.id,
      }).returning();
      await getDb().insert(jointMembershipRemovals).values({ departureId: departure!.id, userId: owner.id });
      departureId = departure!.id;
    };
    try {
      const res = await request();
      assert.ok(departureId, "the request reached its persistence transaction");
      return res;
    } finally {
      writerFence.beforeNext = null;
      if (departureId) await getDb().delete(jointMembershipDepartures).where(eq(jointMembershipDepartures.id, departureId));
    }
  };
  const reply = (channelId: string, randomId?: string) => fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ channelId, content: "a reply", ...(randomId ? { randomId } : {}) }),
  });

  // Admitted while a member: the refusals below are the removal's.
  const admitted = await reply(hostThread.id, randomUUID());
  assert.equal(admitted.status, 200, await admitted.clone().text());
  const channelBefore = (await messagesIn(joint.canonical.id)).length;
  const threadBefore = (await messagesIn(hostThread.canonicalThreadChannelId)).length;

  // The thread (both the idempotent random-id send and the plain send), and
  // the channel itself as the control.
  for (const [channelId, randomId] of [
    [hostThread.id, randomUUID()],
    [hostThread.id, undefined],
    [hostProjection.id, randomUUID()],
  ] as const) {
    const refused = await removedAfterRouteCheck(() => reply(channelId, randomId));
    assert.equal(refused.status, 403, await refused.clone().text());
    assert.equal(((await refused.json()) as { code: string }).code, "channel_access_changed", `${channelId === hostThread.id ? "thread" : "channel"} reply refused at commit`);
  }
  assert.equal((await messagesIn(joint.canonical.id)).length, channelBefore, "nothing lands in the joint channel");
  assert.equal((await messagesIn(hostThread.canonicalThreadChannelId)).length, threadBefore, "nor in its thread");
});
