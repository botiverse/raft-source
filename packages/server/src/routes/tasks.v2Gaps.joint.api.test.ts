import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 coverage gaps — joint channels (coverage matrix C12, C13, C14;
 * RFC 078 "Joint channels"):
 *  - C12: a channel converted to joint while a task v2 task had no
 *    conversation yet: the first use after the conversion creates a joint
 *    conversation directly (canonical on the storage side + the host's local
 *    conversation, linked like a joint thread), and replies land canonically;
 *  - C13: a server that joins a joint channel which already has task
 *    conversations gets its own local conversation for each; its people read
 *    the earlier discussion and write into it, and the other side hears them;
 *  - C14: on the invited side, a task from before the conversion is
 *    read-only — `raft task reply` is refused (403 joint_task_read_only) and
 *    writes nothing, and so are `message send` at its ref (which creates no
 *    conversation) and the web send into its conversation; a task created
 *    after the conversion is writable.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  channelConversionJobs,
  channels,
  inboxNotificationFacts,
  jointChannels,
  jointChannelServers,
  messages,
  servers as serversTable,
  tasks,
  threadFollows,
  users,
} from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { acceptJointChannelInvite, addAgent, addHuman, createChannel, createJointChannel } from "../services/channelService";
import { runChannelConversionJob, startChannelToJointConversion } from "../services/channelConversionService";
import { createServer } from "../services/serverService";
import { isTaskConversationReadOnly } from "../services/taskChannelSurface";
import * as taskService from "../services/taskService";

const test = createApiTest({
  humanActivityMuteFlagDefaultEnabled: true,
});

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

async function createFounderServer(name: string, slug: string, ownerId: string) {
  const server = await createServer(name, slug, ownerId);
  await getDb().update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, server.id));
  return server;
}

function humanHeaders(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId };
}

async function agentKey(agentId: string) {
  const { apiKey } = await mintAgentCredential({
    agentId,
    scopes: ["send", "read", "tasks", "channels"],
    name: `gaps-joint-${randomUUID().slice(0, 6)}`,
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

async function taskRow(taskId: string) {
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
  return row!;
}

async function taskFaces(taskId: string) {
  return getDb().select().from(channels).where(and(eq(channels.taskId, taskId), eq(channels.type, "task")));
}

/** The joint link of a canonical task conversation: its per-server local conversations. */
async function jointLocals(canonicalConversationId: string) {
  const [joint] = await getDb().select().from(jointChannels).where(eq(jointChannels.canonicalChannelId, canonicalConversationId));
  if (!joint) return [];
  return getDb().select().from(jointChannelServers).where(eq(jointChannelServers.jointChannelId, joint.id));
}

async function openConversation(baseUrl: string, token: string, serverId: string, taskId: string) {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/conversation`, { method: "POST", headers: humanHeaders(token, serverId) });
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as { conversationChannelId: string; canonicalConversationChannelId: string; created: boolean };
}

// ── C12 ──

test("C12 convert to joint before a lazy task's conversation exists: the first use creates a joint conversation (canonical + host local)", async ({ app }) => {
  const db = getDb();
  const prefix = `c12-${randomUUID().slice(0, 8)}`;
  const owner = await seedUser(`${prefix}-owner`);
  const server = await createFounderServer(`${prefix} host`, `${prefix}-host`, owner.id);
  const channel = await createChannel(server.id, `${prefix}-room`, "convert me", "channel");
  await addHuman(channel.id, owner.id);
  const agent = await createAgent(server.id, `${prefix}-agent`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  await enableTaskV2ConversationsForServer(server.id);
  installRecordingOrchestrator(app.app);

  const { tasks: [created] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "discuss after the move" }]);
  const lazy = await taskRow(created!.id);
  assert.equal(lazy.ownConversation, true);
  assert.equal(lazy.conversationChannelId, null, "no conversation before the conversion");

  const job = await startChannelToJointConversion({ serverId: server.id, sourceChannelId: channel.id, createdByUserId: owner.id });
  const completed = await runChannelConversionJob(job.id);
  assert.equal(completed.status, "done");
  const [parentProjection] = await db
    .select({ canonicalChannelId: jointChannels.canonicalChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(eq(jointChannelServers.localChannelId, channel.id));
  assert.ok(parentProjection, "the channel is now the host's projection of a joint channel");
  const canonicalParentId = parentProjection!.canonicalChannelId;
  const moved = await taskRow(created!.id);
  assert.equal(moved.channelId, canonicalParentId, "the task moved to the canonical channel");
  assert.equal(moved.ownConversation, true, "still a task v2 task");
  assert.equal(moved.conversationChannelId, null, "still no conversation after the conversion");
  assert.deepEqual(await taskFaces(created!.id), []);

  // First use after the conversion: the host owner opens it to write.
  const ownerToken = await tokenForHuman(owner.email);
  const opened = await openConversation(app.baseUrl, ownerToken, server.id, created!.id);
  assert.equal(opened.created, true);
  const faces = await taskFaces(created!.id);
  assert.deepEqual(faces.map((face) => face.parentChannelId).sort(), [canonicalParentId, channel.id].sort(), "canonical + the host's local conversation");
  const canonicalFace = faces.find((face) => face.parentChannelId === canonicalParentId)!;
  const hostFace = faces.find((face) => face.parentChannelId === channel.id)!;
  assert.equal(opened.canonicalConversationChannelId, canonicalFace.id);
  assert.equal(opened.conversationChannelId, hostFace.id, "the host reader gets its local conversation");
  assert.equal(hostFace.serverId, server.id);
  assert.notEqual(canonicalFace.serverId, server.id, "the canonical conversation lives on the joint storage server");
  assert.equal((await taskRow(created!.id)).conversationChannelId, canonicalFace.id);
  assert.deepEqual(
    (await jointLocals(canonicalFace.id)).map((local) => [local.serverId, local.localChannelId, local.role]),
    [[server.id, hostFace.id, "host"]],
    "linked like a joint thread",
  );
  const [creatorFollow] = await db.select().from(threadFollows).where(and(
    eq(threadFollows.followerType, "user"),
    eq(threadFollows.followerId, owner.id),
    eq(threadFollows.parentTaskId, created!.id),
  ));
  assert.deepEqual([creatorFollow?.threadChannelId, creatorFollow?.reason], [hostFace.id, "authored"], "the creator follows on the host's local conversation");

  // A reply from the host's agent lands in the canonical conversation.
  const reply = await agentPost(app.baseUrl, await agentKey(agent.id), "tasks/reply", {
    channel: `#${channel.name}`, task_number: created!.taskNumber, content: "first word after the move",
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const [stored] = await db.select().from(messages).where(eq(messages.id, reply.body.messageId));
  assert.equal(stored!.channelId, canonicalFace.id, "replies are stored in the canonical conversation");
});

// ── C13 ──

test("C13 a server joining a joint channel that already has a task conversation gets its local conversation, reads the discussion and writes into it", async ({ app }) => {
  const db = getDb();
  const prefix = `c13-${randomUUID().slice(0, 8)}`;
  const hostOwner = await seedUser(`${prefix}-host-owner`);
  const targetOwner = await seedUser(`${prefix}-target-owner`);
  const hostServer = await createFounderServer(`${prefix} host`, `${prefix}-host`, hostOwner.id);
  const targetServer = await createFounderServer(`${prefix} target`, `${prefix}-target`, targetOwner.id);
  await enableTaskV2ConversationsForServer(hostServer.id);
  await enableTaskV2ConversationsForServer(targetServer.id);
  installRecordingOrchestrator(app.app);

  const hosted = await createJointChannel({
    hostServerId: hostServer.id,
    createdByUserId: hostOwner.id,
    name: `${prefix}-room`,
    jointInvites: [{ targetServerSlug: targetServer.slug, invitedPeople: [targetOwner.email] }],
  });
  const hostProjection = hosted.channel;
  const canonicalParentId = hosted.jointChannel.canonicalChannelId;
  const hostToken = await tokenForHuman(hostOwner.email);
  const createRes = await fetch(`${app.baseUrl}/api/tasks/channel/${hostProjection.id}`, {
    method: "POST",
    headers: humanHeaders(hostToken, hostServer.id),
    body: JSON.stringify({ tasks: [{ title: "already discussed" }] }),
  });
  assert.equal(createRes.status, 200, await createRes.clone().text());
  const createdTask = (await createRes.json() as { tasks: Array<{ id: string; taskNumber: number }> }).tasks[0]!;
  const opened = await openConversation(app.baseUrl, hostToken, hostServer.id, createdTask.id);
  const hostFaceId = opened.conversationChannelId;
  const canonicalId = opened.canonicalConversationChannelId;
  const earlier = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: humanHeaders(hostToken, hostServer.id),
    body: JSON.stringify({ channelId: hostFaceId, content: "discussed before the target joined" }),
  });
  assert.equal(earlier.status, 200, await earlier.clone().text());
  assert.deepEqual((await jointLocals(canonicalId)).map((local) => local.serverId), [hostServer.id], "only the host has a local conversation so far");

  const targetProjection = await acceptJointChannelInvite({
    inviteId: hosted.invites[0]!.id,
    targetServerId: targetServer.id,
    acceptedByUserId: targetOwner.id,
  });
  assert.equal(targetProjection.type, "joint");

  // The joining server got a local conversation under its local channel.
  const faces = await taskFaces(createdTask.id);
  const targetFace = faces.find((face) => face.parentChannelId === targetProjection.id);
  assert.ok(targetFace, "the joining server has a local task conversation under its local channel");
  assert.equal(targetFace!.serverId, targetServer.id);
  assert.deepEqual(
    faces.map((face) => face.parentChannelId).sort(),
    [canonicalParentId, hostProjection.id, targetProjection.id].sort(),
    "still one canonical conversation; one local conversation per server",
  );
  assert.deepEqual(
    (await jointLocals(canonicalId)).map((local) => local.serverId).sort(),
    [hostServer.id, targetServer.id].sort(),
    "the joining server's conversation is linked to the canonical one",
  );

  // The joining side resolves, reads and writes it.
  const targetToken = await tokenForHuman(targetOwner.email);
  const reopened = await openConversation(app.baseUrl, targetToken, targetServer.id, createdTask.id);
  assert.deepEqual([reopened.created, reopened.conversationChannelId, reopened.canonicalConversationChannelId], [false, targetFace!.id, canonicalId]);
  const history = await fetch(`${app.baseUrl}/api/messages/channel/${targetFace!.id}?limit=10`, { headers: humanHeaders(targetToken, targetServer.id) });
  assert.equal(history.status, 200, await history.clone().text());
  const historyBody = await history.json() as { messages: Array<{ content: string }> };
  assert.ok(historyBody.messages.some((message) => message.content === "discussed before the target joined"), "the joining side reads the earlier discussion");
  const write = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: humanHeaders(targetToken, targetServer.id),
    body: JSON.stringify({ channelId: targetFace!.id, content: "hello from the new server" }),
  });
  assert.equal(write.status, 200, await write.clone().text());
  const { id: written } = await write.json() as { id: string };
  const [stored] = await db.select().from(messages).where(eq(messages.id, written));
  assert.equal(stored!.channelId, canonicalId, "stored in the canonical conversation");
  // The host-side creator (following on the host's local conversation) hears it.
  const facts = await waitFor("host creator entry", async () => {
    const rows = await db.select().from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.messageId, written),
      eq(inboxNotificationFacts.receiverType, "user"),
      eq(inboxNotificationFacts.receiverId, hostOwner.id),
    ));
    return rows.length > 0 ? rows : null;
  });
  assert.deepEqual(facts.map((fact) => [fact.kind, fact.sourceChannelId]), [["task", hostFaceId]]);
});

// ── C14 ──

test("C14 invited side of a converted joint channel: raft task reply and message send on a task from before the conversion are refused (read-only); a later task is writable", async ({ app }) => {
  const db = getDb();
  const prefix = `c14-${randomUUID().slice(0, 8)}`;
  const hostOwner = await seedUser(`${prefix}-host-owner`);
  const peerOwner = await seedUser(`${prefix}-peer-owner`);
  const hostServer = await createServer("History Host", `${prefix}-host`, hostOwner.id);
  const peerServer = await createServer("History Peer", `${prefix}-peer`, peerOwner.id);
  const canonical = await createChannel(hostServer.id, `${prefix}-room-storage`, undefined, "channel");
  const hostProjection = await createChannel(hostServer.id, `${prefix}-room`, undefined, "joint");
  const peerProjection = await createChannel(peerServer.id, `${prefix}-room`, undefined, "joint");
  await addHuman(hostProjection.id, hostOwner.id);
  await addHuman(peerProjection.id, peerOwner.id);
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host", joinedByUserId: hostOwner.id },
    { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant", joinedByUserId: peerOwner.id },
  ]);
  await fillJointMembersFromChannelHumans();
  // The channel became joint by a conversion on 2026-08-20: tasks from before
  // it are historical on the participant side.
  await db.insert(channelConversionJobs).values({
    serverId: hostServer.id,
    sourceChannelId: hostProjection.id,
    sourceChannelType: "channel",
    status: "done",
    phase: "done", state: "succeeded",
    canonicalChannelId: canonical.id,
    jointChannelId: joint!.id,
    createdByUserId: hostOwner.id,
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    completedAt: new Date("2026-08-20T00:01:00.000Z"),
  });
  await enableTaskV2ConversationsForServer(hostServer.id);
  await enableTaskV2ConversationsForServer(peerServer.id);
  const peerAgent = await createAgent(peerServer.id, `${prefix}-peer-agent`, { runtime: "claude" });
  await addAgent(peerProjection.id, peerAgent.id);
  installRecordingOrchestrator(app.app);

  const { tasks: [historical] } = await taskService.createTasks(canonical.id, "user", hostOwner.id, [{ title: "from before the conversion" }], { initiatingServerId: hostServer.id });
  const { tasks: [fresh] } = await taskService.createTasks(canonical.id, "user", hostOwner.id, [{ title: "after the conversion" }], { initiatingServerId: hostServer.id });
  await db.update(tasks).set({ createdAt: new Date("2026-08-19T00:00:00.000Z"), updatedAt: new Date("2026-08-19T00:00:00.000Z") }).where(eq(tasks.id, historical!.id));
  await db.update(tasks).set({ createdAt: new Date("2026-08-21T00:00:00.000Z"), updatedAt: new Date("2026-08-21T00:00:00.000Z") }).where(eq(tasks.id, fresh!.id));
  const key = await agentKey(peerAgent.id);
  const board = `#${peerProjection.name}`;

  const refused = await agentPost(app.baseUrl, key, "tasks/reply", { channel: board, task_number: historical!.taskNumber, content: "can I add to this?" });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "joint_task_read_only");
  await settle();
  assert.equal((await taskRow(historical!.id)).conversationChannelId, null, "the refused reply created no conversation");
  assert.deepEqual(await taskFaces(historical!.id), []);
  // `message send` at the task ref, as every CLI from before task v2 posts
  // there, is refused the same way, before a conversation is created.
  const sendRefused = await agentPost(app.baseUrl, key, "send", { target: `${board}:#${historical!.taskNumber}`, content: "or through message send?" });
  assert.equal(sendRefused.status, 403, JSON.stringify(sendRefused.body));
  assert.equal(sendRefused.body.code, "joint_task_read_only");
  await settle();
  assert.equal((await taskRow(historical!.id)).conversationChannelId, null, "the refused send created no conversation");
  assert.deepEqual(await taskFaces(historical!.id), []);
  // The web send's rule: the historical task's conversation is read-only
  // under the participant's channel only.
  assert.equal(await isTaskConversationReadOnly(peerServer.id, { type: "task", taskId: historical!.id, parentChannelId: peerProjection.id }), true);
  assert.equal(await isTaskConversationReadOnly(hostServer.id, { type: "task", taskId: historical!.id, parentChannelId: hostProjection.id }), false);
  assert.equal(await isTaskConversationReadOnly(peerServer.id, { type: "task", taskId: fresh!.id, parentChannelId: peerProjection.id }), false);

  const accepted = await agentPost(app.baseUrl, key, "tasks/reply", { channel: board, task_number: fresh!.taskNumber, content: "joining in" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const canonicalConversationId = (await taskRow(fresh!.id)).conversationChannelId;
  assert.ok(canonicalConversationId, "a task created after the conversion takes replies from the invited side");
  const [stored] = await db.select().from(messages).where(eq(messages.id, accepted.body.messageId));
  assert.equal(stored!.channelId, canonicalConversationId);

  // The web send: the participant's own conversation of the historical task
  // (as a host-side discussion would have given it) is read-only for its people.
  const [peerFace] = await db.insert(channels).values({
    serverId: peerServer.id,
    name: `${prefix}-historical-conversation`,
    type: "task",
    parentChannelId: peerProjection.id,
    taskId: historical!.id,
  }).returning();
  const peerToken = await tokenForHuman(peerOwner.email);
  const web = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: humanHeaders(peerToken, peerServer.id),
    body: JSON.stringify({ channelId: peerFace!.id, content: "from the web, on a historical task" }),
  });
  assert.equal(web.status, 403, await web.clone().text());
  assert.equal(((await web.json()) as { code?: string }).code, "joint_task_read_only");
  await settle();
  assert.deepEqual(await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, peerFace!.id)), [], "nothing was written");
});
