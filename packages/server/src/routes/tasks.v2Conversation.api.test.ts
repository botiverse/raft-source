import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 (flag on): a task's discussion is its own task conversation
 * (`channels.type = 'task'`), and it follows the thread rules end to end — for
 * agents and people alike. One scenario, step by step, on an ordinary channel
 * and on a joint channel shared by two servers:
 *
 *  1. agent A creates a task assigned to agent B → no message in the channel;
 *     the assignment line in the task conversation creates that conversation
 *     (lazy, like a thread), and its creation makes A follow (authored) and B
 *     follow (assigned); B is woken once (mentioned), nobody else hears.
 *  2. B replies in the task conversation through `raft task reply` (agent API
 *     POST /tasks/reply) at the target its delivery named — the task ref
 *     `#channel:#7` — → A (follower) is woken. `message send` / `message read`
 *     at that ref are refused with `task_target_use_task_command`.
 *  3. A replies → B is woken.
 *  4. A @mentions a person → that person gets a personal-mention inbox fact
 *     (kind `task`) and follows; the channel's other person hears nothing.
 *  5. B replies → the mentioned person gets a follower fact (kind `task`).
 *  6. the person replies from the web (POST /api/messages to the task
 *     conversation) → A and B are both woken.
 *  7. `raft task read` / `raft task view` (A) show the discussion under the
 *     ref; `raft task unfollow` (B) stops B's wakes, `raft task follow`
 *     restarts them.
 *  The channel's bystander agent and bystander person never hear any of it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { asServerId, formatAgentMessageTarget, parseAgentTaskRef } from "@botiverse/raft-shared";

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
import { canView } from "../services/visibilityService";

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

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 300));
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

async function agentKey(agentId: string) {
  const { apiKey } = await mintAgentCredential({
    agentId,
    scopes: ["send", "read", "tasks", "channels"],
    name: `conv-${randomUUID().slice(0, 6)}`,
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

/** Task v2: a task always has a source; the creating agent's own message in the task's (storage) channel. */
async function ownSource(channelId: string, agentId: string, content: string) {
  return (await createMessage(channelId, "agent", agentId, content)).id;
}

async function agentSend(baseUrl: string, apiKey: string, target: string, content: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ target, content }),
  });
  const body = await res.json() as { state?: string; messageId?: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.state, "sent", JSON.stringify(body));
  return body.messageId!;
}

/** `raft task reply <ref>`: the agent API reply route, addressed by the ref's board + number. */
async function agentTaskReply(baseUrl: string, apiKey: string, ref: string, content: string) {
  const parsed = parseAgentTaskRef(ref);
  assert.ok(parsed, `${ref} is a task ref`);
  const res = await agentPost(baseUrl, apiKey, "tasks/reply", { channel: parsed!.target, task_number: parsed!.taskNumber, content });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.state, "sent", JSON.stringify(res.body));
  return res.body.messageId as string;
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

async function userFacts(messageId: string) {
  return getDb().select().from(inboxNotificationFacts).where(and(
    eq(inboxNotificationFacts.messageId, messageId),
    eq(inboxNotificationFacts.receiverType, "user"),
  ));
}

type Actor = { id: string; name: string };
type ScenarioInput = {
  baseUrl: string;
  deliveries: Delivery[];
  /** Agent A's channel ref, the channel A creates the task in. */
  channelRefForA: string;
  /** The same channel as agent B's server names it. */
  channelRefForB: string;
  storageChannelId: string;
  /** `localChannelId`: the channel as the actor's server sees it. */
  agentA: Actor & { key: string; serverId: string; localChannelId: string };
  agentB: Actor & { key: string; serverId: string; localChannelId: string };
  bystanderAgent: Actor;
  /** The person A @mentions; they reply from the web on `serverId`. */
  member: { id: string; name: string; email: string; serverId: string; localChannelId: string };
  bystanders: string[];
  /** Every server whose surface shows the channel (one for ordinary, two for joint). */
  serverIds: string[];
};

/** The task conversation a server's surface sees: the one under its local channel. */
async function localConversation(taskId: string, localChannelId: string) {
  const [row] = await getDb().select().from(channels).where(and(
    eq(channels.taskId, taskId),
    eq(channels.parentChannelId, localChannelId),
    eq(channels.type, "task"),
  ));
  assert.ok(row, `the task has a conversation under ${localChannelId}`);
  return row!;
}

async function runScenario(input: ScenarioInput) {
  const db = getDb();
  const { deliveries, agentA, agentB, member } = input;
  const woken = async (messageId: string, expected: string[]) => {
    await waitFor(`wake for ${messageId}`, async () => expected.every((id) => deliveries.some((d) => d.agentId === id && d.payload.message_id === messageId)));
    await settle();
    return deliveries.filter((d) => d.payload.message_id === messageId);
  };
  // A task always has a source: A's own message, already in the channel.
  const source = await ownSource(input.storageChannelId, agentA.id, "the hero needs shipping");
  const messagesBefore = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, input.storageChannelId));

  // 1. A creates a task for B: no message anywhere in the channel.
  const created = await agentPost(input.baseUrl, agentA.key, "tasks", {
    channel: input.channelRefForA, tasks: [{ title: "ship the hero", source_message_id: source }], assignee: `@${agentB.name}`,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const [task] = await db.select().from(tasks).where(and(eq(tasks.channelId, input.storageChannelId), eq(tasks.title, "ship the hero")));
  assert.ok(task);
  assert.equal(task!.messageId, null, "a task v2 task has no host message");
  assert.equal(task!.ownConversation, true, "a task v2 task owns its conversation");
  // Lazy, like a thread: assigned creation announces the assignment in the
  // task conversation before answering, and that first line created it.
  assert.ok(task!.conversationChannelId, "the assignment line created the task's canonical conversation");
  const messagesAfter = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, input.storageChannelId));
  assert.equal(messagesAfter.length, messagesBefore.length, "creating the task posts nothing in the channel");
  const [canonical] = await db.select().from(channels).where(eq(channels.id, task!.conversationChannelId!));
  assert.equal(canonical!.type, "task");
  assert.equal(canonical!.taskId, task!.id);
  assert.equal(canonical!.parentMessageId, null);
  assert.equal(canonical!.parentChannelId, input.storageChannelId, "the canonical conversation's parent is the task's channel");

  const conversationOfA = await localConversation(task!.id, agentA.localChannelId);
  const conversationOfB = await localConversation(task!.id, agentB.localChannelId);
  const conversationOfMember = await localConversation(task!.id, member.localChannelId);
  assert.equal((await followRow(conversationOfA.id, "agent", agentA.id))?.reason, "authored", "the creator follows from the conversation's creation");

  const [notice] = await waitFor("assignment line", async () => {
    const rows = await db.select().from(messages).where(and(
      eq(messages.channelId, task!.conversationChannelId!),
      eq(messages.systemSubtype, "task.assignment_receipt"),
    ));
    return rows.length > 0 ? rows : null;
  });
  const toNotice = await woken(notice!.id, [agentB.id]);
  assert.deepEqual(toNotice.map((d) => d.agentId), [agentB.id], "only the assignee hears the assignment");
  assert.equal(toNotice[0]!.payload.mentioned, true);
  assert.equal((await followRow(conversationOfB.id, "agent", agentB.id))?.reason, "assigned", "the assignee follows");

  // 2. B replies where the assignment reached it → A hears it.
  const targetForB = formatAgentMessageTarget(toNotice[0]!.payload);
  assert.equal(toNotice[0]!.payload.task_conversation_number, task!.taskNumber);
  assert.equal(targetForB, `${input.channelRefForB}:#${task!.taskNumber}`, "the task conversation reaches agents as its task ref, in their local channel's name");
  // Clients from before task v2 render a thread as `#${parent}:${channel_name}`:
  // the delivery names the conversation by the ref's tail, so they show the ref too.
  assert.equal(toNotice[0]!.payload.channel_type, "thread");
  assert.equal(toNotice[0]!.payload.channel_name, `#${task!.taskNumber}`);
  // The old path (message send / history read at the ref) reaches the task
  // conversation too, with a hint naming the new command.
  const oldStyleRead = await agentGet(input.baseUrl, agentB.key, `history?channel=${encodeURIComponent(targetForB)}`);
  assert.equal(oldStyleRead.status, 200, JSON.stringify(oldStyleRead.body));
  assert.equal(oldStyleRead.body.target, targetForB);
  assert.ok((oldStyleRead.body.messages as Array<{ id: string }>).some((m) => m.id === notice!.id), "history at the ref reads the task conversation");
  assert.ok(String(oldStyleRead.body.taskCommandHint).includes(`raft task read "${targetForB}"`), oldStyleRead.body.taskCommandHint);
  // Those clients print each row's reply target as `#parent:#7:<msg>`; reading
  // it is the same conversation, as sending to it is.
  const rowTargetRead = await agentGet(input.baseUrl, agentB.key, `history?channel=${encodeURIComponent(`${targetForB}:${notice!.id.slice(0, 8)}`)}`);
  assert.equal(rowTargetRead.status, 200, JSON.stringify(rowTargetRead.body));
  assert.equal(rowTargetRead.body.target, targetForB);
  assert.ok((rowTargetRead.body.messages as Array<{ id: string }>).some((m) => m.id === notice!.id), "history at a row's reply target reads the task conversation");
  const reply1 = await agentTaskReply(input.baseUrl, agentB.key, targetForB, "on it — which copy?");
  const [reply1Row] = await db.select().from(messages).where(eq(messages.id, reply1));
  assert.equal(reply1Row!.channelId, task!.conversationChannelId, "replies are stored in the canonical conversation");
  const toReply1 = await woken(reply1, [agentA.id]);
  assert.deepEqual(toReply1.map((d) => d.agentId).sort(), [agentA.id], "the creator hears the assignee; nobody else");

  // 3. A replies (the target it was handed) → B hears it.
  const targetForA = formatAgentMessageTarget(toReply1[0]!.payload);
  assert.equal(targetForA, `${input.channelRefForA}:#${task!.taskNumber}`);
  // A replies the old way: `message send` to the delivered target.
  const oldStyleSend = await agentPost(input.baseUrl, agentA.key, "send", { target: targetForA, content: "the v2 copy from the spec" });
  assert.equal(oldStyleSend.status, 200, JSON.stringify(oldStyleSend.body));
  assert.equal(oldStyleSend.body.state, "sent");
  assert.ok(String(oldStyleSend.body.taskCommandHint).includes(`raft task reply "${targetForA}"`), oldStyleSend.body.taskCommandHint);
  const reply2 = oldStyleSend.body.messageId as string;
  const [reply2Row] = await db.select().from(messages).where(eq(messages.id, reply2));
  assert.equal(reply2Row!.channelId, task!.conversationChannelId, "message send at the ref posts in the task conversation");
  const toReply2 = await woken(reply2, [agentB.id]);
  assert.deepEqual(toReply2.map((d) => d.agentId), [agentB.id]);

  // 4. A brings a person in with an @mention.
  const reply3 = await agentTaskReply(input.baseUrl, agentA.key, targetForA, `@${member.name} can you confirm the copy?`);
  const toReply3 = await woken(reply3, [agentB.id]);
  assert.deepEqual(toReply3.map((d) => d.agentId), [agentB.id]);
  const mentionFacts = await waitFor("mention fact", async () => {
    const rows = await userFacts(reply3);
    return rows.length > 0 ? rows : null;
  });
  assert.deepEqual(
    mentionFacts.map((f) => [f.receiverId, f.kind, f.personalMention, f.sourceChannelId]),
    [[member.id, "task", true, conversationOfMember.id]],
    "the mentioned person gets a personal-mention task entry; nobody else",
  );
  assert.equal((await followRow(conversationOfMember.id, "user", member.id))?.reason, "mentioned", "being mentioned follows");

  // 5. B replies → the person, now a follower, hears it.
  const reply4 = await agentTaskReply(input.baseUrl, agentB.key, targetForB, "draft is in the PR");
  await woken(reply4, [agentA.id]);
  const followerFacts = await waitFor("follower fact", async () => {
    const rows = await userFacts(reply4);
    return rows.length > 0 ? rows : null;
  });
  assert.deepEqual(followerFacts.map((f) => [f.receiverId, f.kind, f.personalMention]), [[member.id, "task", false]]);

  // 6. The person replies from the web → both agents hear it.
  const memberToken = await login(input.baseUrl, member.email);
  const web = await fetch(`${input.baseUrl}/api/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json", "X-Server-Id": member.serverId },
    body: JSON.stringify({ channelId: conversationOfMember.id, content: "confirmed, ship it" }),
  });
  assert.equal(web.status, 200, await web.clone().text());
  const { id: humanReply } = await web.json() as { id: string };
  const toHuman = await woken(humanReply, [agentA.id, agentB.id]);
  assert.deepEqual(toHuman.map((d) => d.agentId).sort(), [agentA.id, agentB.id].sort());
  assert.deepEqual(toHuman.map((d) => formatAgentMessageTarget(d.payload)).sort(), [targetForA, targetForB].sort());

  // 7. Reading, viewing and (un)following by ref.
  const boardA = parseAgentTaskRef(targetForA)!;
  const read = await agentGet(input.baseUrl, agentA.key, `tasks/read?channel=${encodeURIComponent(boardA.target)}&task_number=${boardA.taskNumber}&after=0&limit=50`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.target, targetForA, "the read window is named by the task ref");
  const readContents = (read.body.messages as Array<{ content: string }>).map((m) => m.content);
  for (const content of ["on it — which copy?", "the v2 copy from the spec", "draft is in the PR", "confirmed, ship it"]) {
    assert.ok(readContents.some((c) => c.includes(content)), `task read shows "${content}"`);
  }
  const viewA = await agentGet(input.baseUrl, agentA.key, `tasks/view?channel=${encodeURIComponent(boardA.target)}&task_number=${boardA.taskNumber}`);
  assert.equal(viewA.status, 200, JSON.stringify(viewA.body));
  assert.equal(viewA.body.taskRef, targetForA);
  assert.equal(viewA.body.following, true);
  assert.equal(viewA.body.followReason, "authored", "replying keeps why the creator's active follow began");
  assert.equal(viewA.body.conversation.exists, true);
  assert.ok((viewA.body.recentMessages as Array<{ content: string }>).some((m) => m.content.includes("confirmed, ship it")));

  const boardB = parseAgentTaskRef(targetForB)!;
  const unfollowed = await agentPost(input.baseUrl, agentB.key, "tasks/unfollow", { channel: boardB.target, task_number: boardB.taskNumber });
  assert.equal(unfollowed.status, 200, JSON.stringify(unfollowed.body));
  assert.deepEqual([unfollowed.body.taskRef, unfollowed.body.following, unfollowed.body.changed], [targetForB, false, true]);
  const reply5 = await agentTaskReply(input.baseUrl, agentA.key, targetForA, "B has left the conversation");
  await settle();
  assert.equal(deliveries.some((d) => d.agentId === agentB.id && d.payload.message_id === reply5), false, "an unfollowed task does not wake B");
  const followed = await agentPost(input.baseUrl, agentB.key, "tasks/follow", { channel: boardB.target, task_number: boardB.taskNumber });
  assert.deepEqual([followed.status, followed.body.following, followed.body.changed], [200, true, true]);
  const reply6 = await agentTaskReply(input.baseUrl, agentA.key, targetForA, "welcome back");
  await woken(reply6, [agentB.id]);

  // Bystanders never heard any of it; nothing surfaced in the channel itself.
  assert.equal(deliveries.some((d) => d.agentId === input.bystanderAgent.id), false, "the bystander agent is never woken");
  const conversationIds = (await db.select({ id: channels.id }).from(channels).where(eq(channels.taskId, task!.id))).map((row) => row.id);
  const bystanderFacts = await db.select().from(inboxNotificationFacts).where(and(
    eq(inboxNotificationFacts.receiverType, "user"),
    inArray(inboxNotificationFacts.receiverId, input.bystanders),
    inArray(inboxNotificationFacts.sourceChannelId, conversationIds),
  ));
  assert.deepEqual(bystanderFacts, [], "bystanders have no entries for the task conversation");
  return { task: task!, conversationIds };
}

test("task v2 conversation: agents and people hear each other by the thread rules", async ({ app }) => {
  const db = getDb();
  const slug = "v2conv";
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const bystander = await seedUser(`${slug}-bystander`);
  const server = await createServer(`Conv ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, slug);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: member.id, role: "member" },
    { serverId: server.id, userId: bystander.id, role: "member" },
  ]);
  for (const user of [owner, member, bystander]) await addHuman(channel.id, user.id);
  const agentA = await createAgent(server.id, `${slug}-a-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const agentB = await createAgent(server.id, `${slug}-b-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const agentC = await createAgent(server.id, `${slug}-c-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  for (const agent of [agentA, agentB, agentC]) await addAgent(channel.id, agent.id);
  await enableTaskV2ConversationsForServer(server.id);
  const deliveries = installRecordingOrchestrator(app.app);

  const { conversationIds } = await runScenario({
    baseUrl: app.baseUrl,
    deliveries,
    channelRefForA: `#${channel.name}`,
    channelRefForB: `#${channel.name}`,
    storageChannelId: channel.id,
    agentA: { id: agentA.id, name: agentA.name, key: await agentKey(agentA.id), serverId: server.id, localChannelId: channel.id },
    agentB: { id: agentB.id, name: agentB.name, key: await agentKey(agentB.id), serverId: server.id, localChannelId: channel.id },
    bystanderAgent: { id: agentC.id, name: agentC.name },
    member: { id: member.id, name: member.name, email: member.email, serverId: server.id, localChannelId: channel.id },
    bystanders: [owner.id, bystander.id],
    serverIds: [server.id],
  });
  assert.equal(conversationIds.length, 1, "an ordinary channel's task has exactly one conversation");
});

test("task v2 conversation on a joint channel: two servers' agents and people hear each other", async ({ app }) => {
  const db = getDb();
  const slug = "v2joint";
  const hostOwner = await seedUser(`${slug}-host-owner`);
  const peerOwner = await seedUser(`${slug}-peer-owner`);
  const member = await seedUser(`${slug}-member`);
  const hostBystander = await seedUser(`${slug}-host-bystander`);
  const hostServer = await createServer("Joint Host", `${slug}-host-${randomUUID().slice(0, 6)}`, hostOwner.id);
  const peerServer = await createServer("Joint Peer", `${slug}-peer-${randomUUID().slice(0, 6)}`, peerOwner.id);
  const roomName = `${slug}-room`;
  const canonical = await createChannel(hostServer.id, `${roomName}-storage`, undefined, "channel");
  const hostProjection = await createChannel(hostServer.id, roomName, undefined, "joint");
  // The peer server names the shared channel differently: each agent sees the
  // task ref in its own server's channel name.
  const peerProjection = await createChannel(peerServer.id, `${roomName}-peer`, undefined, "joint");
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host", joinedByUserId: hostOwner.id },
    { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant", joinedByUserId: peerOwner.id },
  ]);
  await db.insert(serverMembers).values([
    { serverId: peerServer.id, userId: member.id, role: "member" },
    { serverId: hostServer.id, userId: hostBystander.id, role: "member" },
  ]);
  await addHuman(hostProjection.id, hostOwner.id);
  await addHuman(hostProjection.id, hostBystander.id);
  await addHuman(peerProjection.id, peerOwner.id);
  await addHuman(peerProjection.id, member.id);
  const agentA = await createAgent(hostServer.id, `${slug}-a-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const agentB = await createAgent(peerServer.id, `${slug}-b-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const agentC = await createAgent(peerServer.id, `${slug}-c-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(hostProjection.id, agentA.id);
  await addAgent(peerProjection.id, agentB.id);
  await addAgent(peerProjection.id, agentC.id);
  // The flag is read for the INITIATING server (agent A's), never the storage server's.
  await enableTaskV2ConversationsForServer(hostServer.id);
  const deliveries = installRecordingOrchestrator(app.app);

  const { conversationIds } = await runScenario({
    baseUrl: app.baseUrl,
    deliveries,
    channelRefForA: `#${roomName}`,
    channelRefForB: `#${roomName}-peer`,
    storageChannelId: canonical.id,
    agentA: { id: agentA.id, name: agentA.name, key: await agentKey(agentA.id), serverId: hostServer.id, localChannelId: hostProjection.id },
    agentB: { id: agentB.id, name: agentB.name, key: await agentKey(agentB.id), serverId: peerServer.id, localChannelId: peerProjection.id },
    bystanderAgent: { id: agentC.id, name: agentC.name },
    member: { id: member.id, name: member.name, email: member.email, serverId: peerServer.id, localChannelId: peerProjection.id },
    bystanders: [hostOwner.id, peerOwner.id, hostBystander.id],
    serverIds: [hostServer.id, peerServer.id],
  });
  // One canonical conversation + one local conversation per server; the local
  // faces name their own server's local channel as parent.
  assert.equal(conversationIds.length, 3, "canonical + two local task conversations");
  const faces = await db.select().from(channels).where(inArray(channels.id, conversationIds));
  const hostFace = faces.find((face) => face.serverId === hostServer.id && face.parentChannelId === hostProjection.id);
  const peerFace = faces.find((face) => face.serverId === peerServer.id && face.parentChannelId === peerProjection.id);
  assert.ok(hostFace && peerFace, "each server has a local task conversation under its local channel");
});

test("task v2 on a joint channel: the flag is read for the initiating server, not the storage server", async ({ app }) => {
  const db = getDb();
  const slug = "v2gate";
  const hostOwner = await seedUser(`${slug}-host-owner`);
  const peerOwner = await seedUser(`${slug}-peer-owner`);
  const hostServer = await createServer("Gate Host", `${slug}-host-${randomUUID().slice(0, 6)}`, hostOwner.id);
  const peerServer = await createServer("Gate Peer", `${slug}-peer-${randomUUID().slice(0, 6)}`, peerOwner.id);
  const canonical = await createChannel(hostServer.id, `${slug}-storage`, undefined, "channel");
  const hostProjection = await createChannel(hostServer.id, `${slug}-room`, undefined, "joint");
  const peerProjection = await createChannel(peerServer.id, `${slug}-room`, undefined, "joint");
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical.id, createdByServerId: hostServer.id }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host" },
    { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant" },
  ]);
  const hostAgent = await createAgent(hostServer.id, `${slug}-host-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const peerAgent = await createAgent(peerServer.id, `${slug}-peer-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(hostProjection.id, hostAgent.id);
  await addAgent(peerProjection.id, peerAgent.id);
  // Only the PEER server has task v2; the storage channel lives on the host.
  await enableTaskV2ConversationsForServer(peerServer.id);
  installRecordingOrchestrator(app.app);

  const fromPeer = await agentPost(app.baseUrl, await agentKey(peerAgent.id), "tasks", { channel: `#${slug}-room`, tasks: [{ title: "from the peer", source_message_id: await ownSource(canonical.id, peerAgent.id, "from the peer") }] });
  assert.equal(fromPeer.status, 200, JSON.stringify(fromPeer.body));
  const fromHost = await agentPost(app.baseUrl, await agentKey(hostAgent.id), "tasks", { channel: `#${slug}-room`, tasks: [{ title: "from the host" }] });
  assert.equal(fromHost.status, 200, JSON.stringify(fromHost.body));
  const [peerTask] = await db.select().from(tasks).where(and(eq(tasks.channelId, canonical.id), eq(tasks.title, "from the peer")));
  const [hostTask] = await db.select().from(tasks).where(and(eq(tasks.channelId, canonical.id), eq(tasks.title, "from the host")));
  // Created through the flag-on peer: a task v2 task — no host message, and its
  // conversation is created lazily (not yet: nothing needed it).
  assert.equal(peerTask!.messageId, null);
  assert.equal(peerTask!.ownConversation, true);
  assert.equal(peerTask!.conversationChannelId, null, "creating a task creates only the task");
  // Created through the flag-off host: the pre-v2 visible host message.
  assert.equal(hostTask!.ownConversation, false);
  assert.equal(hostTask!.conversationChannelId, null);
  assert.ok(hostTask!.messageId);

  // The peer's first reply creates the peer task's conversation (initiating
  // server = the flag-on peer), with its creator following.
  const reply = await agentPost(app.baseUrl, await agentKey(peerAgent.id), "tasks/reply", {
    channel: `#${slug}-room`, task_number: peerTask!.taskNumber, content: "first reply",
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const [peerAfter] = await db.select().from(tasks).where(eq(tasks.id, peerTask!.id));
  assert.ok(peerAfter!.conversationChannelId, "the first reply created the conversation");
  const peerLocal = await localConversation(peerTask!.id, peerProjection.id);
  assert.equal((await followRow(peerLocal.id, "agent", peerAgent.id))?.reason, "authored", "its creator follows (and replying keeps that reason)");
});

test("control: an ordinary thread under the same rules — B replies to A's message, A hears it", async ({ app }) => {
  const owner = await seedUser("ctl-owner");
  const server = await createServer("Ctl", `ctl-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "ctl");
  await addHuman(channel.id, owner.id);
  const agentA = await createAgent(server.id, `ctl-a-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const agentB = await createAgent(server.id, `ctl-b-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  for (const agent of [agentA, agentB]) await addAgent(channel.id, agent.id);
  await enableTaskV2ConversationsForServer(server.id);
  const deliveries = installRecordingOrchestrator(app.app);
  const keyA = await agentKey(agentA.id);
  const keyB = await agentKey(agentB.id);
  const root = await agentSend(app.baseUrl, keyA, `#${channel.name}`, "root by A");
  await settle();
  const reply = await agentSend(app.baseUrl, keyB, `#${channel.name}:${root.slice(0, 8)}`, "reply by B");
  await waitFor("thread reply wake", async () => deliveries.some((d) => d.agentId === agentA.id && d.payload.message_id === reply));
  const [thread] = await getDb().select().from(channels).where(and(eq(channels.parentMessageId, root), eq(channels.type, "thread")));
  assert.equal((await followRow(thread!.id, "agent", agentA.id))?.reason, "authored", "a thread's parent author follows at the first reply");
});

test("task refs on a flag-off server: not message targets (existing errors), and no task conversation to reply in", async ({ app }) => {
  const owner = await seedUser("off-owner");
  const server = await createServer("Off", `off-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "off");
  await addHuman(channel.id, owner.id);
  const agent = await createAgent(server.id, `off-a-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  installRecordingOrchestrator(app.app);
  const key = await agentKey(agent.id);
  const created = await agentPost(app.baseUrl, key, "tasks", { channel: `#${channel.name}`, tasks: [{ title: "pre-v2 task" }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;

  const send = await agentPost(app.baseUrl, key, "send", { target: `#${channel.name}:#${taskNumber}`, content: "hi" });
  assert.equal(send.status, 404, JSON.stringify(send.body));
  assert.notEqual(send.body.code, "task_target_use_task_command", "flag off keeps the pre-v2 answer");

  const reply = await agentPost(app.baseUrl, key, "tasks/reply", { channel: `#${channel.name}`, task_number: taskNumber, content: "hi" });
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.code, "task_conversations_not_enabled");
  assert.match(String(reply.body.suggestedNextAction), new RegExp(`^raft message send --target "#${channel.name}:[0-9a-f]{8}"$`));
});

test("a task from before task v2: raft task reply creates its conversation; view names its earlier thread", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("lazy-owner");
  const server = await createServer("Lazy", `lazy-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "lazy");
  await addHuman(channel.id, owner.id);
  const agentA = await createAgent(server.id, `lazy-a-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const agentB = await createAgent(server.id, `lazy-b-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  for (const agent of [agentA, agentB]) await addAgent(channel.id, agent.id);
  const deliveries = installRecordingOrchestrator(app.app);
  const keyA = await agentKey(agentA.id);
  const keyB = await agentKey(agentB.id);

  // Flag off: the task is posted as a message whose thread is its discussion.
  const created = await agentPost(app.baseUrl, keyA, "tasks", { channel: `#${channel.name}`, tasks: [{ title: "old style" }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;
  const [task] = await db.select().from(tasks).where(and(eq(tasks.channelId, channel.id), eq(tasks.taskNumber, taskNumber)));
  assert.ok(task!.messageId);
  await agentSend(app.baseUrl, keyB, `#${channel.name}:${task!.messageId!.slice(0, 8)}`, "earlier discussion in the host thread");
  await settle();

  const contextOff = await agentGet(app.baseUrl, keyA, "context");
  assert.equal(contextOff.body.features?.taskConversations, undefined, "flag off: the features object keeps its shape");
  await enableTaskV2ConversationsForServer(server.id);
  const contextOn = await agentGet(app.baseUrl, keyA, "context");
  assert.equal(contextOn.body.features?.taskConversations, true);
  const ref = `#${channel.name}:#${taskNumber}`;
  const before = await agentGet(app.baseUrl, keyA, `tasks/view?channel=${encodeURIComponent(`#${channel.name}`)}&task_number=${taskNumber}`);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.taskRef, ref);
  assert.equal(before.body.conversation.exists, false, "no conversation until the first write");
  assert.equal(before.body.task.conversationPending, true);
  assert.deepEqual(before.body.earlierDiscussion, { target: `#${channel.name}:${task!.messageId!.slice(0, 8)}`, replyCount: 1 });
  const emptyRead = await agentGet(app.baseUrl, keyA, `tasks/read?channel=${encodeURIComponent(`#${channel.name}`)}&task_number=${taskNumber}`);
  assert.equal(emptyRead.status, 200, JSON.stringify(emptyRead.body));
  assert.deepEqual([emptyRead.body.target, emptyRead.body.messages], [ref, []]);
  const [stillNone] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
  assert.equal(stillNone!.conversationChannelId, null, "reads never create the conversation");

  // The listing names it by ref already (pending conversation).
  const listed = await agentGet(app.baseUrl, keyA, `tasks?channel=${encodeURIComponent(`#${channel.name}`)}&status=all`);
  assert.equal(listed.body.tasks[0].conversationPending, true);
  // Pre-v2 CLIs follow up at `<board>:<messageId[0..8]>`: the ref's tail makes that the ref.
  assert.equal(listed.body.tasks[0].messageId, `#${taskNumber}`);
  assert.equal(listed.body.tasks[0].hostMessageId, task!.messageId);

  // The old path: `message send` at the ref creates the conversation too.
  const oldSend = await agentPost(app.baseUrl, keyB, "send", { target: ref, content: "first reply in the task's own conversation" });
  assert.equal(oldSend.status, 200, JSON.stringify(oldSend.body));
  const reply = oldSend.body.messageId as string;
  const [after] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
  assert.ok(after!.conversationChannelId, "the first reply created the conversation");
  const [row] = await db.select().from(messages).where(eq(messages.id, reply));
  assert.equal(row!.channelId, after!.conversationChannelId);
  assert.equal((await followRow(after!.conversationChannelId!, "agent", agentB.id))?.reason, "replied");
  // Creating it (lazily, for a pre-v2 task too) makes the task's creator follow.
  assert.equal((await followRow(after!.conversationChannelId!, "agent", agentA.id))?.reason, "authored", "the creator follows from the conversation's creation");
  await settle();
  const viewB = await agentGet(app.baseUrl, keyB, `tasks/view?channel=${encodeURIComponent(`#${channel.name}`)}&task_number=${taskNumber}`);
  assert.equal(viewB.body.conversation.exists, true);
  assert.equal(viewB.body.following, true);
  void deliveries;
});

test("canView: an agent sees a task conversation exactly when it sees the task's channel", async ({ app }) => {
  const owner = await seedUser("view-owner");
  const server = await createServer("View", `view-${randomUUID()}`, owner.id);
  const open = await createChannel(server.id, "view-open");
  const closed = await createChannel(server.id, "view-closed", undefined, "private");
  const member = await createAgent(server.id, `view-m-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const outsider = await createAgent(server.id, `view-o-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  for (const channel of [open, closed]) {
    await addHuman(channel.id, owner.id);
    await addAgent(channel.id, member.id);
  }
  await addAgent(open.id, outsider.id);
  await enableTaskV2ConversationsForServer(server.id);
  installRecordingOrchestrator(app.app);
  const key = await agentKey(member.id);
  const conversationOf = async (channel: { id: string; name: string }) => {
    const created = await agentPost(app.baseUrl, key, "tasks", { channel: `#${channel.name}`, tasks: [{ title: `in ${channel.name}`, source_message_id: await ownSource(channel.id, member.id, `in ${channel.name}`) }] });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await agentTaskReply(app.baseUrl, key, `#${channel.name}:#${created.body.tasks[0].taskNumber}`, "first reply");
    const [task] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, channel.id), eq(tasks.taskNumber, created.body.tasks[0].taskNumber)));
    assert.ok(task?.conversationChannelId);
    return task.conversationChannelId;
  };
  const homes = [await conversationOf(open), await conversationOf(closed)].map((channelId) => ({ kind: "conversation" as const, channelId }));
  // The batch entry (filterServerAgentAccessibleChannelIds) answers through
  // the task's channel: a sub-conversation has no membership rows of its own.
  assert.deepEqual(await canView({ type: "agent", id: member.id, serverId: asServerId(server.id) }, homes), [true, true]);
  assert.deepEqual(await canView({ type: "agent", id: outsider.id, serverId: asServerId(server.id) }, homes), [true, false]);
});

test("a task's own conversation holds no tasks: the batch create refuses it like a thread", async ({ app }) => {
  const owner = await seedUser("nest-owner");
  const server = await createServer("Nest", `nest-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "nest");
  await addHuman(channel.id, owner.id);
  const agent = await createAgent(server.id, `nest-a-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  await enableTaskV2ConversationsForServer(server.id);
  installRecordingOrchestrator(app.app);
  const key = await agentKey(agent.id);
  const created = await agentPost(app.baseUrl, key, "tasks", { channel: `#${channel.name}`, tasks: [{ title: "parent", source_message_id: await ownSource(channel.id, agent.id, "parent") }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  await agentTaskReply(app.baseUrl, key, `#${channel.name}:#${created.body.tasks[0].taskNumber}`, "first reply");
  const [task] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, channel.id), eq(tasks.taskNumber, created.body.tasks[0].taskNumber)));
  assert.ok(task?.conversationChannelId);
  const token = await login(app.baseUrl, owner.email);
  const nested = await fetch(`${app.baseUrl}/api/tasks/channel/${task.conversationChannelId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": server.id },
    body: JSON.stringify({ tasks: [{ title: "nested" }] }),
  });
  assert.equal(nested.status, 409, await nested.clone().text());
  const inConversation = await getDb().select().from(tasks).where(eq(tasks.channelId, task.conversationChannelId));
  assert.deepEqual(inConversation, [], "no task was created inside the task conversation");
});

test("raft task list --following: followed task conversations with unread counts; read and unfollow move them", async ({ app }) => {
  const owner = await seedUser("following-owner");
  const server = await createServer("Following", `following-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "following");
  await addHuman(channel.id, owner.id);
  const agentA = await createAgent(server.id, `fol-a-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const agentB = await createAgent(server.id, `fol-b-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  for (const agent of [agentA, agentB]) await addAgent(channel.id, agent.id);
  await enableTaskV2ConversationsForServer(server.id);
  installRecordingOrchestrator(app.app);
  const keyA = await agentKey(agentA.id);
  const keyB = await agentKey(agentB.id);
  const board = `#${channel.name}`;

  const empty = await agentGet(app.baseUrl, keyA, "tasks/following");
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body.tasks, []);

  const sourceId = await ownSource(channel.id, agentA.id, "hero copy");
  const created = await agentPost(app.baseUrl, keyA, "tasks", { channel: board, tasks: [{ title: "hero copy", source_message_id: sourceId }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;
  const ref = `${board}:#${taskNumber}`;
  await agentTaskReply(app.baseUrl, keyB, ref, "which copy?");
  await agentTaskReply(app.baseUrl, keyB, ref, "the v2 one?");
  await settle();

  const listedA = await agentGet(app.baseUrl, keyA, "tasks/following");
  assert.equal(listedA.status, 200, JSON.stringify(listedA.body));
  assert.equal(listedA.body.tasks.length, 1);
  assert.deepEqual(
    (({ taskRef, taskNumber: n, title, status, unread, reason }) => ({ taskRef, taskNumber: n, title, status, unread, reason }))(listedA.body.tasks[0]),
    { taskRef: ref, taskNumber, title: "hero copy", status: "todo", unread: 2, reason: "authored" },
  );
  assert.ok(!Number.isNaN(Date.parse(listedA.body.tasks[0].followedAt)));
  // B replied: it follows, and its own replies are not unread for it.
  const listedB = await agentGet(app.baseUrl, keyB, "tasks/following");
  assert.deepEqual(listedB.body.tasks.map((t: { taskRef: string; unread: number; reason: string }) => [t.taskRef, t.unread, t.reason]), [[ref, 0, "replied"]]);
  // Threads are not listed here, and task conversations are not in the thread
  // list. The only thread A follows is its source message's, where the 📌
  // notice went (A authored that message).
  const threadsA = await agentGet(app.baseUrl, keyA, "threads");
  const threadParents = (threadsA.body.threads as Array<{ parentMessageId: string }>).map((t) => t.parentMessageId);
  assert.deepEqual(threadParents, [sourceId], JSON.stringify(threadsA.body.threads));

  // Reading the unread moves the count; unfollowing drops the row.
  const read = await agentGet(app.baseUrl, keyA, `tasks/read?channel=${encodeURIComponent(board)}&task_number=${taskNumber}&unread=true`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const afterRead = await agentGet(app.baseUrl, keyA, "tasks/following");
  assert.equal(afterRead.body.tasks[0].unread, 0);
  const unfollowed = await agentPost(app.baseUrl, keyA, "tasks/unfollow", { channel: board, task_number: taskNumber });
  assert.equal(unfollowed.status, 200, JSON.stringify(unfollowed.body));
  const afterUnfollow = await agentGet(app.baseUrl, keyA, "tasks/following");
  assert.deepEqual(afterUnfollow.body.tasks, []);
});
