import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2, per-task mode on a joint channel with mixed flags (W4): the
 * storage / host server has task_v2_conversations_v0 on, the peer server has
 * it off. A task created the v2 way through the host is a v2 task on both
 * sides: the flag-off peer can create the conversation (its own local face
 * included) by replying, assigning or changing status, its lines go to the
 * task conversation, both sides' agents are woken at their own ref, and the
 * peer's people see the conversation in their followed list. A task created
 * through the flag-off peer is a pre-v2 task (host message thread), as before.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  channels,
  inboxNotificationFacts,
  jointChannels,
  jointChannelServers,
  messages,
  serverMembers,
  tasks,
  threadFollows,
  users,
} from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import * as taskService from "../services/taskService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type Delivery = { agentId: string; payload: Record<string, unknown> };

function installRecordingOrchestrator(app: { set: (key: string, value: unknown) => void }): Delivery[] {
  const deliveries: Delivery[] = [];
  const deliverMessage = async (agentId: string, payload: Record<string, unknown>) => {
    deliveries.push({ agentId, payload });
    return { status: "queued" as const };
  };
  app.set("agentOrchestrator", {
    deliverMessage,
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<{ agentId: string; message: Record<string, unknown> }>) =>
      batch.map(({ agentId, message }) => deliverMessage(agentId, message)),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  });
  return deliveries;
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  }).returning();
  return user!;
}

async function login(baseUrl: string, email: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(res.status, 200, `login failed for ${email}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

function humanHeaders(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId };
}

async function agentKey(agentId: string) {
  const { apiKey } = await mintAgentCredential({
    agentId,
    scopes: ["send", "read", "tasks", "channels"],
    name: `mixed-${randomUUID().slice(0, 6)}`,
    issuedVia: "computer", createdByUserId: null,
  });
  return apiKey;
}

async function agentPost(baseUrl: string, apiKey: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

async function agentGet(baseUrl: string, apiKey: string, path: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  return { status: res.status, body: await res.json() as any };
}

async function followRow(conversationId: string, followerType: "user" | "agent", followerId: string) {
  const [row] = await getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, conversationId),
    eq(threadFollows.followerType, followerType),
    eq(threadFollows.followerId, followerId),
  ));
  return row?.unfollowedAt == null ? row ?? null : null;
}

/** Task v2: a task always has a source; the host agent's own message in the (canonical) channel. */
async function hostSource(fx: Awaited<ReturnType<typeof mixedJoint>>, content: string) {
  return (await createMessage(fx.canonical.id, "agent", fx.hostAgent.id, content)).id;
}

async function messagesIn(channelId: string) {
  return getDb().select().from(messages).where(eq(messages.channelId, channelId));
}

async function localFace(taskId: string, localChannelId: string) {
  const [row] = await getDb().select().from(channels).where(and(
    eq(channels.taskId, taskId),
    eq(channels.parentChannelId, localChannelId),
    eq(channels.type, "task"),
  ));
  return row ?? null;
}

async function mixedJoint(slug: string) {
  const db = getDb();
  const hostOwner = await seedUser(`${slug}-host-owner`);
  const peerOwner = await seedUser(`${slug}-peer-owner`);
  const peerMember = await seedUser(`${slug}-peer-member`);
  const hostServer = await createServer("Mixed Host", `${slug}-host-${randomUUID().slice(0, 6)}`, hostOwner.id);
  const peerServer = await createServer("Mixed Peer", `${slug}-peer-${randomUUID().slice(0, 6)}`, peerOwner.id);
  const canonical = await createChannel(hostServer.id, `${slug}-storage`, undefined, "channel");
  const hostProjection = await createChannel(hostServer.id, `${slug}-room`, undefined, "joint");
  const peerProjection = await createChannel(peerServer.id, `${slug}-peer-room`, undefined, "joint");
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical.id, createdByServerId: hostServer.id }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host" },
    { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant" },
  ]);
  await db.insert(serverMembers).values({ serverId: peerServer.id, userId: peerMember.id, role: "member" });
  await addHuman(hostProjection.id, hostOwner.id);
  await addHuman(peerProjection.id, peerOwner.id);
  await addHuman(peerProjection.id, peerMember.id);
  const hostAgent = await createAgent(hostServer.id, `${slug}-host-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const peerAgent = await createAgent(peerServer.id, `${slug}-peer-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(hostProjection.id, hostAgent.id);
  await addAgent(peerProjection.id, peerAgent.id);
  // Only the host (storage) server has task v2 conversations.
  await enableTaskV2ConversationsForServer(hostServer.id);
  return {
    hostOwner, peerOwner, peerMember, hostServer, peerServer, canonical, hostProjection, peerProjection,
    hostAgent, peerAgent, hostKey: await agentKey(hostAgent.id), peerKey: await agentKey(peerAgent.id),
    hostBoard: `#${slug}-room`, peerBoard: `#${slug}-peer-room`,
  };
}

test("joint, mixed flags: the flag-off side replies to a v2 task, creating the conversation with both local faces; both sides hear it at their own ref", async ({ app }) => {
  const fx = await mixedJoint("mix-reply");
  const deliveries = installRecordingOrchestrator(app.app);
  const created = await agentPost(app.baseUrl, fx.hostKey, "tasks", { channel: fx.hostBoard, tasks: [{ title: "mixed v2 task", source_message_id: await hostSource(fx, "mixed v2 task") }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const [task] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, fx.canonical.id), eq(tasks.title, "mixed v2 task")));
  assert.equal(task!.ownConversation, true);
  assert.equal(task!.conversationChannelId, null, "lazy");

  // The flag-off peer lists it by ref and reads an empty discussion.
  const listed = await agentGet(app.baseUrl, fx.peerKey, `tasks?channel=${encodeURIComponent(fx.peerBoard)}`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.tasks.find((t: { taskNumber: number }) => t.taskNumber === task!.taskNumber)?.messageId, `#${task!.taskNumber}`);
  const emptyRead = await agentGet(app.baseUrl, fx.peerKey, `tasks/read?channel=${encodeURIComponent(fx.peerBoard)}&task_number=${task!.taskNumber}`);
  assert.equal(emptyRead.status, 200, JSON.stringify(emptyRead.body));

  // The flag-off peer's first reply creates the conversation.
  const reply = await agentPost(app.baseUrl, fx.peerKey, "tasks/reply", { channel: fx.peerBoard, task_number: task!.taskNumber, content: "peer here" });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const after = await getDb().select().from(tasks).where(eq(tasks.id, task!.id));
  assert.ok(after[0]!.conversationChannelId, "the flag-off side created the v2 task's conversation");
  const hostFace = await localFace(task!.id, fx.hostProjection.id);
  const peerFace = await localFace(task!.id, fx.peerProjection.id);
  assert.ok(hostFace && peerFace, "both servers have their local conversation");
  assert.equal((await followRow(hostFace!.id, "agent", fx.hostAgent.id))?.reason, "authored", "the creator follows on its own server's face");
  assert.equal((await followRow(peerFace!.id, "agent", fx.peerAgent.id))?.reason, "replied");
  const toHost = await waitFor("host woken", async () => deliveries.find((d) => d.agentId === fx.hostAgent.id && d.payload.message_id === reply.body.messageId));
  assert.equal(toHost.payload.task_conversation_number, task!.taskNumber);

  // The host answers; the flag-off peer is woken and answers the old way (message send to the ref).
  const hostReply = await agentPost(app.baseUrl, fx.hostKey, "tasks/reply", { channel: fx.hostBoard, task_number: task!.taskNumber, content: "host here" });
  assert.equal(hostReply.status, 200, JSON.stringify(hostReply.body));
  await waitFor("peer woken", async () => deliveries.some((d) => d.agentId === fx.peerAgent.id && d.payload.message_id === hostReply.body.messageId));
  const oldSend = await agentPost(app.baseUrl, fx.peerKey, "send", { target: `${fx.peerBoard}:#${task!.taskNumber}`, content: "old cli on the peer" });
  assert.equal(oldSend.status, 200, JSON.stringify(oldSend.body));
  const [oldRow] = await getDb().select().from(messages).where(eq(messages.id, oldSend.body.messageId));
  assert.equal(oldRow!.channelId, after[0]!.conversationChannelId, "stored in the canonical conversation");

  // The flag-off peer's status change: the line goes to the conversation, the receipt names the ref.
  const status = await agentPost(app.baseUrl, fx.peerKey, "tasks/update-status", { channel: fx.peerBoard, task_number: task!.taskNumber, status: "in_progress" });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.taskRef, `${fx.peerBoard}:#${task!.taskNumber}`);
  await waitFor("status line in the conversation", async () => (await messagesIn(after[0]!.conversationChannelId!)).some((row) => row.systemSubtype === "task.lifecycle_thread"));
  assert.equal((await getDb().select().from(channels).where(and(eq(channels.taskId, task!.id), eq(channels.type, "task")))).length, 3, "canonical + two faces, created once");
});

test("joint, mixed flags: the flag-off side assigns a lazy v2 task to its person, who is notified and sees it in the followed list", async ({ app }) => {
  const fx = await mixedJoint("mix-assign");
  installRecordingOrchestrator(app.app);
  const created = await agentPost(app.baseUrl, fx.hostKey, "tasks", { channel: fx.hostBoard, tasks: [{ title: "for the peer member", source_message_id: await hostSource(fx, "for the peer member") }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;
  const [task] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, fx.canonical.id), eq(tasks.taskNumber, taskNumber)));

  const assign = await agentPost(app.baseUrl, fx.peerKey, "tasks/assign", { channel: fx.peerBoard, task_number: taskNumber, assignee: `@${fx.peerMember.name}` });
  assert.equal(assign.status, 200, JSON.stringify(assign.body));
  const peerFace = await waitFor("peer face", async () => localFace(task!.id, fx.peerProjection.id));
  const line = await waitFor("assignment line", async () => {
    const rows = (await messagesIn((await getDb().select().from(tasks).where(eq(tasks.id, task!.id)))[0]!.conversationChannelId ?? fx.canonical.id))
      .filter((row) => row.systemSubtype === "task.assignment_receipt");
    return rows[0] ?? null;
  });
  const facts = await waitFor("assignee notice", async () => {
    const rows = await getDb().select().from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.messageId, line.id),
      eq(inboxNotificationFacts.receiverId, fx.peerMember.id),
    ));
    return rows.length > 0 ? rows : null;
  });
  assert.deepEqual(facts.map((fact) => [fact.kind, fact.personalMention, fact.sourceChannelId]), [["task", true, peerFace.id]]);
  assert.equal((await followRow(peerFace.id, "user", fx.peerMember.id))?.reason, "assigned");

  // The flag-off peer server's person: the followed list and the web board.
  const token = await login(app.baseUrl, fx.peerMember.email);
  const followed = await fetch(`${app.baseUrl}/api/channels/threads/followed`, { headers: humanHeaders(token, fx.peerServer.id) });
  assert.equal(followed.status, 200);
  const row = ((await followed.json()) as { threads: any[] }).threads.find((thread) => thread.threadChannelId === peerFace.id);
  assert.equal(row?.kind, "task", "listed for the flag-off reader, keyed by its local conversation");
  assert.equal(row?.parentChannelId, fx.peerProjection.id);
  const board = await fetch(`${app.baseUrl}/api/tasks/channel/${fx.peerProjection.id}`, { headers: humanHeaders(token, fx.peerServer.id) });
  assert.equal(board.status, 200, await board.clone().text());
  const boardTask = ((await board.json()) as { tasks: any[] }).tasks.find((t) => t.id === task!.id);
  assert.equal(boardTask.conversationAnchored, true);
  assert.equal(boardTask.conversationFollowed, true, "sent for a v2 task whatever the reader's flag");
});

test("joint, mixed flags: a task created through the flag-off side stays pre-v2 on both sides", async ({ app }) => {
  const fx = await mixedJoint("mix-legacy");
  installRecordingOrchestrator(app.app);
  const created = await agentPost(app.baseUrl, fx.peerKey, "tasks", { channel: fx.peerBoard, tasks: [{ title: "pre-v2 from the peer" }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;
  const [task] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, fx.canonical.id), eq(tasks.taskNumber, taskNumber)));
  assert.equal(task!.ownConversation, false);
  assert.ok(task!.messageId, "a visible host message, as before task v2");
  const reply = await agentPost(app.baseUrl, fx.peerKey, "tasks/reply", { channel: fx.peerBoard, task_number: taskNumber, content: "hi" });
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.code, "task_conversations_not_enabled");
  // The flag-on host may still give it a conversation lazily (pre-v2 tasks on a flag-on server).
  const hostReply = await agentPost(app.baseUrl, fx.hostKey, "tasks/reply", { channel: fx.hostBoard, task_number: taskNumber, content: "host picks it up" });
  assert.equal(hostReply.status, 200, JSON.stringify(hostReply.body));
  // From then on it has a conversation, so the peer uses it too (per-task mode).
  const peerAgain = await agentPost(app.baseUrl, fx.peerKey, "tasks/reply", { channel: fx.peerBoard, task_number: taskNumber, content: "now in the conversation" });
  assert.equal(peerAgain.status, 200, JSON.stringify(peerAgain.body));
  const [row] = await getDb().select().from(messages).where(eq(messages.id, peerAgain.body.messageId));
  const [after] = await getDb().select().from(tasks).where(eq(tasks.id, task!.id));
  assert.equal(row!.channelId, after!.conversationChannelId);
});

test("joint, mixed flags (B14): a resource receipt from the flag-off side on a v2 task without source anchors on a line in the task conversation", async ({ app }) => {
  const fx = await mixedJoint("mix-receipt");
  installRecordingOrchestrator(app.app);
  const { tasks: [task] } = await taskService.createTasks(
    fx.canonical.id, "user", fx.hostOwner.id, [{ title: "joint bucket", createsResource: true }], { initiatingServerId: fx.hostServer.id },
  );
  assert.equal(task!.conversationChannelId, null);
  const res = await agentPost(app.baseUrl, fx.peerKey, "tasks/resource-receipt", {
    channel: fx.peerBoard,
    task_number: task!.taskNumber,
    receipt: {
      object: "s3://raft-mixed",
      purpose: "mixed-flag acceptance",
      teardown_owner: `@${fx.peerAgent.name}`,
      security_privacy: "internal; encrypted",
      expiry: "2099-09-01T00:00:00.000Z",
      runbook: "runbooks/mixed.md",
      tracking: `task #${task!.taskNumber}`,
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const peerFace = await localFace(task!.id, fx.peerProjection.id);
  assert.ok(peerFace, "the flag-off side created the conversation, its own face included");
  assert.equal(res.body.expiryFollowup.targetChannelId, peerFace!.id, "the follow-up fires into the peer owner's local conversation");
  const [line] = await getDb().select().from(messages).where(eq(messages.id, res.body.expiryFollowup.msgId));
  const [after] = await getDb().select().from(tasks).where(eq(tasks.id, task!.id));
  assert.equal(line!.channelId, after!.conversationChannelId, "the receipt line is stored in the canonical conversation");
});
