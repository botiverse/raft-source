// Agent API auth suite: task create, assignment, mine, claim, status (incl.
// forced status), delete, convert and lifecycle system messages.
// Shared fixtures: ./internalAgentApi.auth.testkit.ts.
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import {
  __resetFailpointsForTests,
  __setFailpointsForTests,
  BasicTracer,
  InMemoryFailpointRegistry,
  MemoryTraceSink,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  channelAgents,
  channelHumans,
  channels,
  inboxNotificationFacts,
  inboxTargetMuteStates,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
  notificationOutbox,
  reminders,
  serverAgentMembers,
  serverMembers,
  servers as serversTable,
  taskEvents,
  tasks,
  userChannelInboxStates,
  users,
} from "../db/schema";
import { drainNotificationTasksForTests } from "../services/notifications/dispatcher";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import {
  archiveChannel,
  createChannel,
  addAgent,
  addHuman,
  findOrCreateAgentDM,
  findOrCreateDM,
  getOrCreateThread,
} from "../services/channelService";
import { createMessage, getMaxSeq } from "../services/messageService";
import * as taskService from "../services/taskService";
import { buildSearchText } from "../services/searchTokenizer";
import { jsonHeaders, mintAgentKey, seedAuthFixture } from "./internalAgentApi.auth.testkit";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("agent-api task routes use the bound runner identity without legacy agent id paths", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const channelRef = `#${fixture.channelName}`;

  const create = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: channelRef,
      tasks: [{ title: "native task route" }],
    }),
  });
  assert.equal(create.status, 200);
  const createBody = await create.json() as {
    tasks?: Array<{
      taskNumber?: number;
      messageId?: string;
      title?: string;
      status?: string;
      claimedByType?: string | null;
      claimedById?: string | null;
      claimedAt?: string | null;
    }>;
  };
  assert.equal(createBody.tasks?.[0]?.taskNumber, 1);
  assert.equal(createBody.tasks?.[0]?.title, "native task route");
  assert.ok(createBody.tasks?.[0]?.messageId);
  assert.deepEqual({
    status: createBody.tasks?.[0]?.status,
    claimedByType: createBody.tasks?.[0]?.claimedByType,
    claimedById: createBody.tasks?.[0]?.claimedById,
    claimedAt: createBody.tasks?.[0]?.claimedAt,
  }, {
    status: "todo",
    claimedByType: null,
    claimedById: null,
    claimedAt: null,
  });

  const list = await fetch(`${app.baseUrl}/internal/agent-api/tasks?channel=${encodeURIComponent(channelRef)}&status=all`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  const listText = await list.text();
  assert.equal(list.status, 200, listText);
  const listBody = JSON.parse(listText) as { tasks?: Array<{ taskNumber?: number; title?: string }> };
  assert.deepEqual(listBody.tasks?.map((task) => [task.taskNumber, task.title]), [[1, "native task route"]]);

  const amend = await fetch(`${app.baseUrl}/internal/agent-api/tasks/amend`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: channelRef,
      task_number: 1,
      title: "native task route — current",
      description: "acceptance: field + display + opposing mutations",
    }),
  });
  const amendText = await amend.text();
  assert.equal(amend.status, 200, amendText);
  const amendBody = JSON.parse(amendText) as {
    task?: { taskNumber?: number; title?: string; description?: string | null; revision?: number };
    event?: { seq?: number; eventType?: string; actorName?: string | null; payload?: Record<string, unknown> };
  };
  assert.deepEqual(amendBody.task, {
    taskNumber: 1,
    title: "native task route — current",
    description: "acceptance: field + display + opposing mutations",
    revision: 1,
  });
  assert.equal(amendBody.event?.eventType, "amended");
  assert.equal(amendBody.event?.actorName, "AgentApiAuthBot");
  assert.equal(typeof amendBody.event?.seq, "number");

  const listAfterAmend = await fetch(`${app.baseUrl}/internal/agent-api/tasks?channel=${encodeURIComponent(channelRef)}&status=all`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(listAfterAmend.status, 200);
  const listAfterAmendBody = await listAfterAmend.json() as {
    tasks?: Array<{ title?: string; description?: string | null; revision?: number }>;
  };
  assert.deepEqual(listAfterAmendBody.tasks?.map((task) => ({
    title: task.title,
    description: task.description,
    revision: task.revision,
  })), [{
    title: "native task route — current",
    description: "acceptance: field + display + opposing mutations",
    revision: 1,
  }]);

  const history = await fetch(
    `${app.baseUrl}/internal/agent-api/tasks/history?channel=${encodeURIComponent(channelRef)}&task_number=1`,
    { headers: jsonHeaders(fixture.agentApiKey) },
  );
  const historyText = await history.text();
  assert.equal(history.status, 200, historyText);
  const historyBody = JSON.parse(historyText) as {
    task?: { revision?: number };
    events?: Array<{ eventType?: string; actorName?: string | null; seq?: number }>;
  };
  assert.equal(historyBody.task?.revision, 1);
  assert.deepEqual(historyBody.events?.map((event) => event.eventType), ["created", "amended"]);
  assert.equal(historyBody.events?.[1]?.actorName, "AgentApiAuthBot");
  assert.ok((historyBody.events?.[0]?.seq ?? 0) < (historyBody.events?.[1]?.seq ?? 0));

  const emptyAmend = await fetch(`${app.baseUrl}/internal/agent-api/tasks/amend`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: channelRef, task_number: 1 }),
  });
  assert.equal(emptyAmend.status, 400, "amend must reject an empty patch before mutation");

  const claim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: channelRef, task_numbers: [1] }),
  });
  assert.equal(claim.status, 200);
  const claimBody = await claim.json() as { results?: Array<{ taskNumber?: number; success?: boolean }> };
  assert.deepEqual(claimBody.results, [{ taskNumber: 1, messageId: createBody.tasks?.[0]?.messageId, title: "native task route — current", success: true }]);

  const update = await fetch(`${app.baseUrl}/internal/agent-api/tasks/update-status`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: channelRef, task_number: 1, status: "in_review" }),
  });
  assert.equal(update.status, 200);
  assert.deepEqual(await update.json(), { ok: true, status: "in_review", title: "native task route — current" });

  const close = await fetch(`${app.baseUrl}/internal/agent-api/tasks/update-status`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: channelRef, task_number: 1, status: "closed" }),
  });
  assert.equal(close.status, 200);
  assert.deepEqual(await close.json(), { ok: true, status: "closed", title: "native task route — current" });

  const directResume = await fetch(`${app.baseUrl}/internal/agent-api/tasks/update-status`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: channelRef, task_number: 1, status: "in_progress" }),
  });
  assert.equal(directResume.status, 200);
  assert.deepEqual(await directResume.json(), { ok: true, status: "in_progress", title: "native task route — current" });

  const unclaim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/unclaim`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: channelRef, task_number: 1 }),
  });
  assert.equal(unclaim.status, 200);
  assert.deepEqual(await unclaim.json(), { ok: true, title: "native task route — current" });
});

test("agent-api resource task requires a structured receipt and creates an owner-anchored expiry reminder", async ({ app }) => {
  const fixture = await seedAuthFixture();
  let reminderSyncs = 0;
  const orchestrator = app.app.get("agentOrchestrator") as {
    pushReminderUpsert: (agentId: string, reminder: unknown) => Promise<boolean>;
  };
  orchestrator.pushReminderUpsert = async (agentId) => {
    assert.equal(agentId, fixture.agentId);
    reminderSyncs += 1;
    return true;
  };
  const channelRef = `#${fixture.channelName}`;
  const create = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: channelRef,
      tasks: [{ title: "Create staging bucket", creates_resource: true }],
    }),
  });
  const created = await create.json() as {
    tasks?: Array<{ taskNumber: number; messageId: string; requiresResourceReceipt: boolean }>;
  };
  assert.equal(create.status, 200);
  assert.equal(created.tasks?.[0]?.requiresResourceReceipt, true);
  const taskNumber = created.tasks![0]!.taskNumber;
  const messageId = created.tasks![0]!.messageId;

  const claim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: channelRef, task_numbers: [taskNumber] }),
  });
  assert.equal(claim.status, 200);
  const review = await fetch(`${app.baseUrl}/internal/agent-api/tasks/update-status`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: channelRef, task_number: taskNumber, status: "in_review" }),
  });
  assert.equal(review.status, 200);
  const prematureDone = await fetch(`${app.baseUrl}/internal/agent-api/tasks/update-status`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: channelRef, task_number: taskNumber, status: "done" }),
  });
  assert.equal(prematureDone.status, 409);
  assert.deepEqual(await prematureDone.json(), {
    error: "This task creates a resource, so it needs a resource receipt before it can move to done: record the receipt first, then mark it done.",
    code: "task_resource_receipt_required",
    errorCode: "task_resource_receipt_required",
  });

  const invalidReceipt = await fetch(`${app.baseUrl}/internal/agent-api/tasks/resource-receipt`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: channelRef,
      task_number: taskNumber,
      receipt: {
        object: "staging bucket",
        purpose: "restore acceptance",
        teardown_owner: "@AgentApiAuthBot",
        security_privacy: "internal; no secrets",
        expiry: "2099-09-01T00:00:00.000Z",
        runbook: "   ",
        tracking: `task #${taskNumber}`,
      },
    }),
  });
  assert.equal(invalidReceipt.status, 400);
  assert.equal((await getDb().select().from(reminders)).length, 0);

  const receipt = await fetch(`${app.baseUrl}/internal/agent-api/tasks/resource-receipt`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: channelRef,
      task_number: taskNumber,
      receipt: {
        object: "staging bucket",
        purpose: "restore acceptance",
        teardown_owner: "@AgentApiAuthBot",
        security_privacy: "internal; no secrets",
        expiry: "2099-09-01T00:00:00.000Z",
        runbook: "runbooks/staging-bucket.md",
        tracking: `task #${taskNumber}`,
      },
    }),
  });
  const receiptBody = await receipt.json() as {
    expiryFollowup?: { ownerAgentId: string; owner: string; msgId: string; targetChannelId: string };
  };
  assert.equal(receipt.status, 200);
  assert.deepEqual(receiptBody.expiryFollowup, {
    ...receiptBody.expiryFollowup,
    ownerAgentId: fixture.agentId,
    owner: "@AgentApiAuthBot",
    msgId: messageId,
    targetChannelId: fixture.channelId,
  });
  assert.equal(reminderSyncs, 1, "the committed expiry reminder must be synced to its owner Computer");

  const completed = await fetch(`${app.baseUrl}/internal/agent-api/tasks/update-status`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: channelRef, task_number: taskNumber, status: "done" }),
  });
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { ok: true, status: "done", title: "Create staging bucket" });
});

test("agent-api task mine is untruncated, identity-bound, and hides inaccessible channel tasks", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();

  // More than the common accidental 100-row cap: the response contract is
  // explicitly unpaginated and must return every visible match.
  await db.insert(tasks).values(Array.from({ length: 105 }, (_, index) => ({
    channelId: fixture.channelId,
    taskNumber: index + 1,
    title: `visible assignment ${index + 1}`,
    status: "todo" as const,
    createdByType: "user" as const,
    createdById: fixture.ownerId,
    claimedByType: "agent" as const,
    claimedById: fixture.agentId,
  })));
  await db.insert(tasks).values({
    channelId: fixture.channelId,
    taskNumber: 106,
    title: "done history",
    status: "done",
    createdByType: "user",
    createdById: fixture.ownerId,
    claimedByType: "agent",
    claimedById: fixture.agentId,
  });

  const sameServerOtherAgent = await createAgent(
    fixture.serverId,
    `MineOtherAgent${randomUUID().slice(0, 8)}`,
    { runtime: "claude", model: "sonnet" },
  );
  await db.insert(tasks).values({
    channelId: fixture.channelId,
    taskNumber: 107,
    title: "same server, different assignee",
    status: "todo",
    createdByType: "user",
    createdById: fixture.ownerId,
    claimedByType: "agent",
    claimedById: sameServerOtherAgent.id,
  });

  const visiblePrivate = await createChannel(
    fixture.serverId,
    `mine-private-${randomUUID().slice(0, 8)}`,
    undefined,
    "private",
  );
  await addAgent(visiblePrivate.id, fixture.agentId);
  await db.insert(tasks).values({
    channelId: visiblePrivate.id,
    taskNumber: 1,
    title: "visible private assignment",
    status: "todo",
    createdByType: "user",
    createdById: fixture.ownerId,
    claimedByType: "agent",
    claimedById: fixture.agentId,
  });

  const [jointStorageServer] = await db.insert(serversTable).values({
    name: "Mine Joint Storage",
    slug: `mine-joint-storage-${randomUUID()}`,
    kind: "joint_storage",
    ownerId: fixture.ownerId,
    plan: "founder",
    agentAllChannelGreetingEnabled: false,
  }).returning();
  const jointStorageChannel = await createChannel(
    jointStorageServer.id,
    `mine-joint-storage-${randomUUID().slice(0, 8)}`,
  );
  const visibleJoint = await createChannel(
    fixture.serverId,
    `mine-joint-${randomUUID().slice(0, 8)}`,
    undefined,
    "joint",
  );
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: jointStorageChannel.id,
    createdByServerId: fixture.serverId,
    createdByUserId: fixture.ownerId,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: fixture.serverId,
    localChannelId: visibleJoint.id,
    role: "host",
    status: "active",
    joinedByUserId: fixture.ownerId,
  });
  await addAgent(visibleJoint.id, fixture.agentId);
  await db.insert(tasks).values({
    channelId: visibleJoint.id,
    taskNumber: 1,
    title: "visible joint assignment",
    status: "todo",
    createdByType: "user",
    createdById: fixture.ownerId,
    claimedByType: "agent",
    claimedById: fixture.agentId,
  });

  const archived = await createChannel(fixture.serverId, `mine-archived-${randomUUID().slice(0, 8)}`);
  await archiveChannel(archived.id, fixture.ownerId);
  await db.insert(tasks).values({
    channelId: archived.id,
    taskNumber: 1,
    title: "archived but visible assignment",
    status: "in_review",
    createdByType: "user",
    createdById: fixture.ownerId,
    claimedByType: "agent",
    claimedById: fixture.agentId,
  });

  const dm = await findOrCreateDM(fixture.serverId, fixture.ownerId, fixture.agentId);
  assert.ok(dm);
  await db.insert(tasks).values({
    channelId: dm.id,
    taskNumber: 1,
    title: "DM assignment",
    status: "in_progress",
    createdByType: "user",
    createdById: fixture.ownerId,
    claimedByType: "agent",
    claimedById: fixture.agentId,
  });

  // Historical counterexample to assigned => currently visible: assignment
  // survives membership removal. The query must neither return the task nor
  // disclose the hidden channel's identity/count, and coverage stays
  // explicitly incomplete for every response on this carrier.
  const hidden = await createChannel(
    fixture.serverId,
    `mine-hidden-${randomUUID().slice(0, 8)}`,
    undefined,
    "private",
  );
  await addAgent(hidden.id, fixture.agentId);
  await db.insert(tasks).values({
    channelId: hidden.id,
    taskNumber: 1,
    title: "must remain invisible",
    status: "todo",
    createdByType: "user",
    createdById: fixture.ownerId,
    claimedByType: "agent",
    claimedById: fixture.agentId,
  });
  await db.delete(channelAgents).where(and(
    eq(channelAgents.channelId, hidden.id),
    eq(channelAgents.agentId, fixture.agentId),
  ));

  // Same display handle on another server is a different actor. Filtering is
  // by the authenticated agent id + server, never by rendered name.
  const otherServer = await createServer("Mine Other Server", `mine-other-${randomUUID()}`, fixture.ownerId);
  const sameNameAgent = await createAgent(otherServer.id, "AgentApiAuthBot", { runtime: "claude", model: "sonnet" });
  const otherChannel = await createChannel(otherServer.id, "mine-other-channel");
  await db.insert(tasks).values({
    channelId: otherChannel.id,
    taskNumber: 1,
    title: "same name, different actor",
    status: "todo",
    createdByType: "user",
    createdById: fixture.ownerId,
    claimedByType: "agent",
    claimedById: sameNameAgent.id,
  });

  const mine = await fetch(`${app.baseUrl}/internal/agent-api/tasks?mine=true`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  const mineText = await mine.text();
  assert.equal(mine.status, 200, mineText);
  const mineBody = JSON.parse(mineText) as {
    tasks: Array<{ title: string; channelRef?: string }>;
    scope?: string;
    coverage?: { status?: string; includesArchived?: boolean; inaccessibleScope?: string };
    pagination?: { mode?: string; truncated?: boolean };
  };
  assert.equal(
    mineBody.tasks.length,
    109,
    "105 regular + visible private + visible joint + archived + DM unfinished tasks must all be returned",
  );
  assert.equal(mineBody.tasks.some((task) => task.title === "done history"), false);
  assert.equal(mineBody.tasks.some((task) => task.title === "same server, different assignee"), false);
  assert.equal(mineBody.tasks.some((task) => task.title === "must remain invisible"), false);
  assert.equal(mineBody.tasks.some((task) => task.title === "same name, different actor"), false);
  assert.equal(
    mineBody.tasks.find((task) => task.title === "visible private assignment")?.channelRef,
    `#${visiblePrivate.name}`,
  );
  assert.equal(
    mineBody.tasks.find((task) => task.title === "visible joint assignment")?.channelRef,
    `#${visibleJoint.name}`,
  );
  assert.equal(mineBody.tasks.find((task) => task.title === "archived but visible assignment")?.channelRef, `#${archived.name}`);
  assert.equal(mineBody.tasks.find((task) => task.title === "DM assignment")?.channelRef, `dm:@${fixture.ownerName}`);
  assert.deepEqual({
    scope: mineBody.scope,
    coverage: mineBody.coverage,
    pagination: mineBody.pagination,
  }, {
    scope: "mine",
    coverage: {
      status: "incomplete",
      visibleChannelTypes: ["channel", "private", "joint", "dm"],
      includesArchived: true,
      inaccessibleScope: "not_asserted",
      reason: "Channel membership can change after assignment; inaccessible task scope is not asserted.",
    },
    pagination: { mode: "complete", truncated: false },
  });

  const all = await fetch(`${app.baseUrl}/internal/agent-api/tasks?mine=true&status=all`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(all.status, 200);
  const allBody = await all.json() as { tasks: Array<{ title: string }> };
  assert.equal(allBody.tasks.length, 110);
  assert.equal(allBody.tasks.some((task) => task.title === "done history"), true);

  const conflicting = await fetch(
    `${app.baseUrl}/internal/agent-api/tasks?mine=true&channel=${encodeURIComponent(`#${fixture.channelName}`)}`,
    { headers: jsonHeaders(fixture.agentApiKey) },
  );
  assert.equal(conflicting.status, 400, "mine and channel selectors must be mutually exclusive");

  const missingSelector = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(missingSelector.status, 400, "one task-list selector is required");
});

test("agent-api task mine resolves channel visibility in a constant number of queries", async ({ app }) => {
  type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };
  const fixture = await seedAuthFixture();
  const db = getDb();
  const assign = async (channelId: string, title: string) => {
    await db.insert(tasks).values({
      channelId,
      taskNumber: 1,
      title,
      status: "todo",
      createdByType: "user",
      createdById: fixture.ownerId,
      claimedByType: "agent",
      claimedById: fixture.agentId,
    });
  };
  const seedJoint = async (label: string) => {
    const [storageServer] = await db.insert(serversTable).values({
      name: `Count Joint Storage ${label}`,
      slug: `count-joint-storage-${randomUUID()}`,
      kind: "joint_storage",
      ownerId: fixture.ownerId,
      plan: "founder",
      agentAllChannelGreetingEnabled: false,
    }).returning();
    const storage = await createChannel(storageServer.id, `count-joint-storage-${randomUUID().slice(0, 8)}`);
    const local = await createChannel(fixture.serverId, `count-joint-${randomUUID().slice(0, 8)}`, undefined, "joint");
    const [joint] = await db.insert(jointChannels).values({
      canonicalChannelId: storage.id,
      createdByServerId: fixture.serverId,
      createdByUserId: fixture.ownerId,
    }).returning();
    await db.insert(jointChannelServers).values({
      jointChannelId: joint.id,
      serverId: fixture.serverId,
      localChannelId: local.id,
      role: "host",
      status: "active",
      joinedByUserId: fixture.ownerId,
    });
    await addAgent(local.id, fixture.agentId);
    await assign(local.id, `joint ${label}`);
  };
  const seedBatch = async (label: string, size: number) => {
    for (let i = 0; i < size; i += 1) {
      const open = await createChannel(fixture.serverId, `count-open-${randomUUID().slice(0, 8)}`);
      await assign(open.id, `open ${label} ${i}`);
      const closed = await createChannel(fixture.serverId, `count-private-${randomUUID().slice(0, 8)}`, undefined, "private");
      await addAgent(closed.id, fixture.agentId);
      await assign(closed.id, `private ${label} ${i}`);
      await seedJoint(`${label} ${i}`);
    }
  };
  const countMine = async () => {
    const pg = (db as unknown as { $client: PgliteLike }).$client;
    const originalQuery = pg.query.bind(pg);
    let count = 0;
    pg.query = ((...args: unknown[]) => {
      count += 1;
      return originalQuery(...args);
    }) as PgliteLike["query"];
    try {
      const res = await fetch(`${app.baseUrl}/internal/agent-api/tasks?mine=true`, {
        headers: jsonHeaders(fixture.agentApiKey),
      });
      const text = await res.text();
      assert.equal(res.status, 200, text);
      return { count, body: JSON.parse(text) as { tasks: Array<{ title: string; channelRef?: string }> } };
    } finally {
      pg.query = originalQuery;
    }
  };

  const dm = await findOrCreateDM(fixture.serverId, fixture.ownerId, fixture.agentId);
  assert.ok(dm);
  await assign(dm.id, "dm assignment");
  await seedBatch("few", 1);
  await countMine();
  const few = await countMine();
  await seedBatch("many", 8);
  await countMine();
  const many = await countMine();

  assert.ok(few.count > 0, "the counter must observe queries");
  assert.equal(many.body.tasks.length, few.body.tasks.length + 24);
  // Each channel used to cost several channel/membership/surface queries.
  assert.equal(many.count, few.count, `${few.body.tasks.length} tasks: ${few.count} queries, ${many.body.tasks.length} tasks: ${many.count}`);
  for (const task of many.body.tasks) {
    if (task.title === "dm assignment") assert.equal(task.channelRef, `dm:@${fixture.ownerName}`);
    else assert.match(task.channelRef ?? "", /^#count-(open|private|joint)-/, task.title);
  }
});

test("agent-api bulk task create wakes each recipient once while preserving every inbox fact (task v2 off: visible task bodies)", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const target = await createAgent(fixture.serverId, `batch-wake-${randomUUID().slice(0, 8)}`, {
    runtime: "claude",
    model: "sonnet",
  });
  await addAgent(fixture.channelId, target.id);

  let targetAwake = false;
  let wakeCount = 0;
  const deliveredMessageIds: string[] = [];
  const eventOrder: string[] = [];
  const adapter = app.io.of("/").adapter as unknown as {
    broadcast(packet: { data?: unknown[] }, opts: unknown): void;
  };
  const originalBroadcast = adapter.broadcast.bind(adapter);
  adapter.broadcast = (packet, opts) => {
    if (packet.data?.[0] === "task:created") eventOrder.push("task:created");
    originalBroadcast(packet, opts);
  };
  const orchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: (
      agentId: string,
      message: { message_id?: string },
      options?: unknown,
    ) => Promise<{ status: "queued"; reason: string }>;
  };
  orchestrator.deliverMessage = async (agentId, message) => {
    if (agentId === target.id) {
      if (deliveredMessageIds.length === 0) eventOrder.push("agent-delivery");
      deliveredMessageIds.push(message.message_id ?? "");
      if (!targetAwake) {
        // Keep the inactive window open long enough that concurrent per-task
        // fanout would deterministically attempt multiple wakes.
        await new Promise((resolve) => setTimeout(resolve, 10));
        wakeCount += 1;
        targetAwake = true;
      }
    }
    return { status: "queued", reason: "test" };
  };

  const create = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: `#${fixture.channelName}`,
      tasks: [
        { title: "batch wake one" },
        { title: "batch wake two" },
        { title: "batch wake three" },
      ],
    }),
  });
  const createText = await create.text();
  assert.equal(create.status, 200, createText);
  const createBody = JSON.parse(createText) as { tasks: Array<{ messageId: string }> };
  const createdIds = createBody.tasks.map((task) => task.messageId);

  for (let attempt = 0; attempt < 40 && deliveredMessageIds.length < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(wakeCount, 1, "one bulk create must cause at most one inactive-recipient wake");
  assert.ok(
    eventOrder.indexOf("task:created") >= 0
    && eventOrder.indexOf("task:created") < eventOrder.indexOf("agent-delivery"),
    "human task-board realtime must not wait for agent delivery",
  );
  assert.deepEqual(
    deliveredMessageIds.filter((messageId) => createdIds.includes(messageId)),
    createdIds,
    "all task bodies must still deliver in persisted sequence order",
  );

  const durableFacts = await getDb()
    .select({ messageId: inboxNotificationFacts.messageId })
    .from(inboxNotificationFacts)
    .where(and(
      eq(inboxNotificationFacts.receiverType, "agent"),
      eq(inboxNotificationFacts.receiverId, target.id),
      inArray(inboxNotificationFacts.messageId, createdIds),
    ));
  assert.deepEqual(
    new Set(durableFacts.map((fact) => fact.messageId)),
    new Set(createdIds),
    "wake coalescing must not collapse the N durable inbox rows",
  );
});

test("agent-api bulk task create on a task v2 server delivers nothing to channel agents: no message, no created summary", async ({ app }) => {
  const fixture = await seedAuthFixture();
  await enableTaskV2ConversationsForServer(fixture.serverId);
  const target = await createAgent(fixture.serverId, `batch-wake-${randomUUID().slice(0, 8)}`, {
    runtime: "claude",
    model: "sonnet",
  });
  await addAgent(fixture.channelId, target.id);

  let targetAwake = false;
  let wakeCount = 0;
  const deliveredMessageIds: string[] = [];
  const eventOrder: string[] = [];
  const adapter = app.io.of("/").adapter as unknown as {
    broadcast(packet: { data?: unknown[] }, opts: unknown): void;
  };
  const originalBroadcast = adapter.broadcast.bind(adapter);
  adapter.broadcast = (packet, opts) => {
    if (packet.data?.[0] === "task:created") eventOrder.push("task:created");
    originalBroadcast(packet, opts);
  };
  const orchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: (
      agentId: string,
      message: { message_id?: string },
      options?: unknown,
    ) => Promise<{ status: "queued"; reason: string }>;
  };
  orchestrator.deliverMessage = async (agentId, message) => {
    if (agentId === target.id) {
      if (deliveredMessageIds.length === 0) eventOrder.push("agent-delivery");
      deliveredMessageIds.push(message.message_id ?? "");
      if (!targetAwake) {
        // Keep the inactive window open long enough that concurrent per-task
        // fanout would deterministically attempt multiple wakes.
        await new Promise((resolve) => setTimeout(resolve, 10));
        wakeCount += 1;
        targetAwake = true;
      }
    }
    return { status: "queued", reason: "test" };
  };

  // Task v2: a task always has a source; here the agent's own message.
  const source = await createMessage(fixture.channelId, "agent", fixture.agentId, "splitting this into three tasks");
  const create = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: `#${fixture.channelName}`,
      tasks: [
        { title: "batch wake one", source_message_id: source.id },
        { title: "batch wake two", source_message_id: source.id },
        { title: "batch wake three", source_message_id: source.id },
      ],
    }),
  });
  const createText = await create.text();
  assert.equal(create.status, 200, createText);
  // Task v2 tasks have no message: `messageId` is the ref's tail (`#1`) for
  // pre-v2 clients, so the facts check below covers every fact of the agent.
  const createBody = JSON.parse(createText) as { tasks: Array<{ taskNumber: number; messageId: string }> };
  assert.deepEqual(createBody.tasks.map((task) => task.messageId), createBody.tasks.map((task) => `#${task.taskNumber}`));

  await new Promise((resolve) => setTimeout(resolve, 300));

  // Task v2: creating a task posts nothing in the channel — no host message
  // (each task owns its lazily created conversation) and no created summary — so a
  // channel agent is neither delivered anything nor woken.
  assert.equal(wakeCount, 0, "creating tasks does not wake channel agents");
  assert.deepEqual(deliveredMessageIds, [], "no task message and no created summary is delivered");
  assert.ok(eventOrder.includes("task:created"), "the task board still hears about the tasks");
  const summaries = await getDb().select({ id: messages.id }).from(messages).where(and(
    eq(messages.channelId, fixture.channelId),
    eq(messages.systemSubtype, "task.created_summary"),
  ));
  assert.deepEqual(summaries, [], "no created summary in the channel");

  const durableFacts = await getDb()
    .select({ messageId: inboxNotificationFacts.messageId })
    .from(inboxNotificationFacts)
    .where(and(
      eq(inboxNotificationFacts.receiverType, "agent"),
      eq(inboxNotificationFacts.receiverId, target.id),
    ));
  assert.deepEqual(
    durableFacts.map((fact) => fact.messageId),
    [],
    "task v2 creation records no inbox fact",
  );
});

test("agent-api task create stores description and a short-id source message (task v2)", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const source = await createMessage(fixture.channelId, "user", fixture.ownerId, "ship the launch page");
  // Task v2 off (default): a source message is refused, nothing is created.
  const refused = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, tasks: [{ title: "hero", source_message_id: source.id }] }),
  });
  assert.equal(refused.status, 403);
  const refusedBody = await refused.json() as { code?: string; error?: string };
  assert.equal(refusedBody.code, "task_v2_not_enabled");
  assert.match(refusedBody.error ?? "", /not available on this server/);
  assert.equal((await getDb().select().from(tasks).where(eq(tasks.channelId, fixture.channelId))).length, 0);
  // A description alone is fine while off.
  const described = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, tasks: [{ title: "plain", description: "details" }] }),
  });
  assert.equal(described.status, 200, await described.clone().text());
  assert.equal((await getDb().select().from(tasks).where(eq(tasks.title, "plain")))[0]?.description, "details");

  await enableTaskV2ConversationsForServer(fixture.serverId);
  const create = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: `#${fixture.channelName}`,
      tasks: [
        { title: "hero", description: "countdown + CTA", source_message_id: source.id.slice(0, 8) },
        { title: "pricing", source_message_id: source.id },
      ],
    }),
  });
  const createText = await create.text();
  assert.equal(create.status, 200, createText);
  const rows = await getDb().select().from(tasks).where(eq(tasks.sourceMessageId, source.id));
  assert.deepEqual(rows.map((row) => row.title).sort(), ["hero", "pricing"]);
  assert.equal(rows.find((row) => row.title === "hero")?.description, "countdown + CTA");
  // Task v2: each task owns its conversation, created lazily (like a thread)
  // by the first action that needs it, so none exists right after creation.
  assert.ok(rows.every((row) => row.ownConversation && row.conversationChannelId === null), "each task owns its (not yet created) conversation");
  assert.ok(rows.every((row) => row.messageId === null), "task v2 tasks have no host message");

  const missing = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, tasks: [{ title: "x", source_message_id: "00000000" }] }),
  });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json() as { code?: string }).code, "invalid_source_message");

  // A malformed id (a line break, a flag, an over-long value) is never echoed into
  // the sentence: still a 400 with the same code, a one-line sentence, no task.
  for (const malformed of ["bad\nid", "--message-id", "x".repeat(400)]) {
    const answer = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
      method: "POST",
      headers: jsonHeaders(fixture.agentApiKey),
      body: JSON.stringify({ channel: `#${fixture.channelName}`, tasks: [{ title: "malformed source", source_message_id: malformed }] }),
    });
    const body = await answer.json() as { code?: string; error?: string };
    assert.equal(answer.status, 400, `${JSON.stringify(malformed)}: ${JSON.stringify(body)}`);
    assert.equal(body.code, "invalid_source_message");
    assert.ok(body.error && !/[\r\n]/.test(body.error) && !body.error.includes(malformed), body.error);
  }
  assert.equal((await getDb().select().from(tasks).where(eq(tasks.title, "malformed source"))).length, 0, "no task was created");
});

test("agent-api task create distinguishes self-start from member dispatch and preserves claim ownership", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();
  const target = await createAgent(fixture.serverId, `atomic-${randomUUID().slice(0, 8)}`, {
    runtime: "claude",
    model: "sonnet",
  });
  const competitor = await createAgent(fixture.serverId, `competitor-${randomUUID().slice(0, 8)}`, {
    runtime: "claude",
    model: "sonnet",
  });
  await addAgent(fixture.channelId, target.id);
  await addAgent(fixture.channelId, competitor.id);

  const selfCreate = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: `#${fixture.channelName}`,
      tasks: [{ title: "self starts atomically" }],
      assignee: "@AgentApiAuthBot",
    }),
  });
  const selfText = await selfCreate.text();
  assert.equal(selfCreate.status, 200, selfText);
  const selfBody = JSON.parse(selfText) as {
    tasks: Array<{
      taskNumber: number;
      messageId: string;
      status: string;
      claimedById: string | null;
      claimedByType: string | null;
      claimedAt: string | null;
      [key: string]: unknown;
    }>;
    assignmentReceipt?: { messageId: string; content: string; assignee: string; state: string };
  };
  assert.deepEqual(selfBody.tasks.map((task) => ({
    status: task.status,
    claimedById: task.claimedById,
    claimedByType: task.claimedByType,
    claimedAt: typeof task.claimedAt,
  })), [{
    status: "in_progress",
    claimedById: fixture.agentId,
    claimedByType: "agent",
    claimedAt: "string",
  }]);
  assert.equal(selfBody.assignmentReceipt?.state, "started");
  assert.equal(selfBody.assignmentReceipt?.assignee, "@AgentApiAuthBot");
  assert.match(selfBody.assignmentReceipt?.content ?? "", /@AgentApiAuthBot started task #1/);
  assert.equal("agentSendKey" in selfBody.tasks[0]!, false, "Agent API response must not leak storage fields");
  assert.equal("searchText" in selfBody.tasks[0]!, false, "Agent API response must not leak search storage");

  const secondSelfClaim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, task_numbers: [1] }),
  });
  assert.equal(secondSelfClaim.status, 200);
  assert.deepEqual((await secondSelfClaim.json() as { results: unknown[] }).results, [{
    taskNumber: 1,
    success: false,
    reason: "already claimed by you",
  }]);

  // @stdrc (2026-08-03): create-with-assignee carries the same permission as
  // create and as assign. A plain member dispatching to somebody else used to
  // be 403 `assignee_assignment_forbidden`; that gate is gone, and the acting
  // agent below is deliberately NOT an admin.
  const unresolvableDispatch = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: `#${fixture.channelName}`,
      tasks: [{ title: "unknown handle still fails, but honestly" }],
      assignee: "@missing-handle",
    }),
  });
  assert.equal(unresolvableDispatch.status, 404);
  assert.equal(
    (await unresolvableDispatch.json() as { code?: string }).code,
    "assignee_not_found",
    "with no dispatch gate the opaque 403 becomes an accurate, actionable error",
  );

  const outsiderName = `outsider-${randomUUID().slice(0, 8)}`;
  const outsider = await createAgent(fixture.serverId, outsiderName, { runtime: "claude", model: "sonnet" });
  const outsiderTitle = "assignee outside the channel is still refused";
  const outsiderDispatch = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: `#${fixture.channelName}`,
      tasks: [{ title: outsiderTitle }],
      assignee: `@${outsider.name}`,
    }),
  });
  assert.equal(outsiderDispatch.status, 403, "channel membership is still a real boundary");
  assert.equal((await outsiderDispatch.json() as { code?: string }).code, "assignee_cannot_claim");
  assert.deepEqual(
    await db.select({ id: messages.id }).from(messages).where(eq(messages.content, outsiderTitle)),
    [],
    "a refused assignment must not leave a half-created task behind",
  );
  assert.equal(outsider.id.length > 0, true);

  const assignedTitles = ["reserved for target by number", "reserved for target by message id"];
  const dispatch = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: `#${fixture.channelName}`,
      tasks: assignedTitles.map((title) => ({ title })),
      assignee: `@${target.name}`,
    }),
  });
  const dispatchText = await dispatch.text();
  assert.equal(dispatch.status, 200, dispatchText);
  const dispatchBody = JSON.parse(dispatchText) as {
    tasks: Array<{
      taskNumber: number;
      messageId: string;
      title: string;
      status: string;
      claimedById: string | null;
      claimedByType: string | null;
      claimedAt: string | null;
    }>;
    assignmentReceipt: { messageId: string; content: string; assignee: string; state: string };
  };
  assert.deepEqual(dispatchBody.tasks.map((task) => ({
    status: task.status,
    claimedById: task.claimedById,
    claimedByType: task.claimedByType,
    claimedAt: task.claimedAt,
  })), [
    { status: "todo", claimedById: target.id, claimedByType: "agent", claimedAt: null },
    { status: "todo", claimedById: target.id, claimedByType: "agent", claimedAt: null },
  ]);
  assert.equal(dispatchBody.assignmentReceipt.state, "assigned");
  assert.equal(dispatchBody.assignmentReceipt.assignee, `@${target.name}`);
  assert.match(dispatchBody.assignmentReceipt.content, new RegExp(`Assigned @${target.name} to 2 new tasks`));

  // v1.4: the reserved state lives on the canonical task row; the host
  // message is a plain chat message carrying only the title.
  const createdIds = dispatchBody.tasks.map((task) => task.messageId);
  const persistedHosts = await db
    .select({ id: messages.id, content: messages.content, status: messages.taskStatus })
    .from(messages)
    .where(inArray(messages.id, createdIds));
  assert.deepEqual(new Set(persistedHosts.map((row) => row.content)), new Set(assignedTitles));
  assert.equal(
    persistedHosts.every((row) => row.status === null),
    true,
    "assign-other host messages must stay plain messages",
  );

  const persisted = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      assigneeType: tasks.claimedByType,
      assigneeId: tasks.claimedById,
      claimedAt: tasks.claimedAt,
    })
    .from(tasks)
    .where(inArray(tasks.messageId, createdIds));
  assert.deepEqual(new Set(persisted.map((row) => row.title)), new Set(assignedTitles));
  assert.equal(persisted.every((row) => (
    row.status === "todo"
    && row.assigneeType === "agent"
    && row.assigneeId === target.id
    && row.claimedAt === null
  )), true, "assign-other INSERT must publish reserved todo state without a false start timestamp");

  const competitorKey = await mintAgentKey(competitor.id, ["tasks", "send"]);
  const competitorClaim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(competitorKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, task_numbers: [dispatchBody.tasks[0]!.taskNumber] }),
  });
  assert.equal(competitorClaim.status, 200);
  const competitorResults = (await competitorClaim.json() as {
    results: Array<{
      taskNumber?: number;
      success: boolean;
      reason?: string;
      conflict?: {
        kind: string;
        conflictScope: string;
        blockedActions: string[];
        unblockedActionExamples: string[];
        currentAssignee: { type: string; name: string | null } | null;
        taskStatus: string | null;
        claimedAt: string | null;
        observedAt: string;
      };
    }>;
  }).results;
  assert.equal(competitorResults.length, 1);
  const competitorResult = competitorResults[0]!;
  assert.equal(competitorResult.taskNumber, dispatchBody.tasks[0]!.taskNumber);
  assert.equal(competitorResult.success, false);
  assert.equal(competitorResult.reason, `already assigned to @${target.name}`);
  // Effect-boundary projection: the failure declares exactly which effects
  // this conflict blocks, as a closed set, without ruling on lane ownership.
  const conflict = competitorResult.conflict;
  assert.ok(conflict, "assignment-held claim failure must carry a structured claim_conflict");
  assert.equal(conflict.kind, "claim_conflict");
  assert.equal(conflict.conflictScope, "implementation_execution");
  assert.deepEqual(conflict.blockedActions, ["start_conflicting_execution"]);
  assert.deepEqual(
    conflict.unblockedActionExamples,
    ["read", "coordinate", "review", "request_reassign", "handoff"],
  );
  assert.deepEqual(conflict.currentAssignee, { type: "agent", name: target.name });
  assert.equal(conflict.taskStatus, "todo");
  assert.equal(conflict.claimedAt, null, "reserved todo assignment has no start timestamp");
  assert.ok(!Number.isNaN(Date.parse(conflict.observedAt)));

  // Call-site outcome tooth: the conflict blocks conflicting execution and
  // nothing else. A coordination action from the same conflicted agent must
  // actually succeed against the live route — not merely be described as
  // unblocked — while a repeat execution claim stays blocked.
  const [latestSeqRow] = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(eq(messages.channelId, fixture.channelId))
    .orderBy(desc(messages.seq))
    .limit(1);
  const competitorCoordination = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: jsonHeaders(competitorKey),
    body: JSON.stringify({
      target: `#${fixture.channelName}`,
      content: "coordination after claim conflict: evidence handoff for the assignee",
      seenUpToSeq: latestSeqRow?.seq ?? 0,
    }),
  });
  assert.equal(competitorCoordination.status, 200, await competitorCoordination.clone().text());
  const persistedCoordination = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.content, "coordination after claim conflict: evidence handoff for the assignee"));
  assert.equal(persistedCoordination.length, 1, "post-conflict coordination send must persist");

  const competitorRepeatClaim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(competitorKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, task_numbers: [dispatchBody.tasks[0]!.taskNumber] }),
  });
  assert.equal(competitorRepeatClaim.status, 200);
  const repeatResults = (await competitorRepeatClaim.json() as { results: Array<{ success: boolean }> }).results;
  assert.equal(repeatResults[0]!.success, false, "conflicting execution claim must stay blocked");

  // Cross-channel non-disclosure: a known task host-message UUID from a
  // DIFFERENT channel, claimed under this channel, must be indistinguishable
  // from a nonexistent message — prose "message not found", zero conflict
  // fields, zero assignee/status/claimedAt leakage.
  const outsideChannel = await createChannel(fixture.serverId, `claim-conflict-outside-${randomUUID().slice(0, 8)}`);
  const outsideOwner = await createAgent(fixture.serverId, `OutsideOwner-${randomUUID().slice(0, 8)}`, { description: "outside lane owner" });
  await addAgent(outsideChannel.id, outsideOwner.id);
  const { tasks: [outsideTask] } = await taskService.createTasks(
    outsideChannel.id, "agent", outsideOwner.id, [{ title: "outside-channel secret task" }],
  );
  const outsideClaim = await taskService.claimTask(outsideTask.id, "agent", outsideOwner.id);
  assert.notEqual(typeof outsideClaim, "string");
  const crossChannelClaim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(competitorKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, message_ids: [outsideTask.messageId] }),
  });
  assert.equal(crossChannelClaim.status, 200);
  const crossChannelBody = await crossChannelClaim.text();
  const crossChannelResults = (JSON.parse(crossChannelBody) as {
    results: Array<Record<string, unknown>>;
  }).results;
  assert.equal(crossChannelResults.length, 1);
  assert.equal(crossChannelResults[0]!.success, false);
  assert.equal(crossChannelResults[0]!.reason, "message not found");
  assert.equal("conflict" in crossChannelResults[0]!, false, "cross-channel ref must not carry a conflict projection");
  assert.doesNotMatch(crossChannelBody, new RegExp(outsideOwner.name), "cross-channel assignee identity must not leak");

  const targetKey = await mintAgentKey(target.id, ["tasks"]);
  const claimByNumber = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(targetKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, task_numbers: [dispatchBody.tasks[0]!.taskNumber] }),
  });
  assert.equal(claimByNumber.status, 200);
  assert.deepEqual((await claimByNumber.json() as { results: unknown[] }).results, [{
    taskNumber: dispatchBody.tasks[0]!.taskNumber,
    messageId: dispatchBody.tasks[0]!.messageId,
    title: dispatchBody.tasks[0]!.title,
    success: true,
  }]);
  // v1.4: resolve by host message id, then read the state off the owning row.
  const claimedByNumber = await taskService.resolveTaskByMessageId(dispatchBody.tasks[0]!.messageId);
  assert.equal(claimedByNumber?.source, "tasks");
  assert.equal(claimedByNumber?.source === "tasks" ? claimedByNumber.row.status : null, "in_progress");
  assert.ok(claimedByNumber?.source === "tasks" && claimedByNumber.row.claimedAt instanceof Date);

  const repeatedTargetClaim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(targetKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, task_numbers: [dispatchBody.tasks[0]!.taskNumber] }),
  });
  assert.equal(repeatedTargetClaim.status, 200);
  assert.deepEqual((await repeatedTargetClaim.json() as { results: unknown[] }).results, [{
    taskNumber: dispatchBody.tasks[0]!.taskNumber,
    success: false,
    reason: "already claimed by you",
  }]);

  const claimByMessageId = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(targetKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, message_ids: [dispatchBody.tasks[1]!.messageId] }),
  });
  assert.equal(claimByMessageId.status, 200);
  assert.deepEqual((await claimByMessageId.json() as { results: unknown[] }).results, [{
    messageId: dispatchBody.tasks[1]!.messageId,
    success: true,
    taskNumber: dispatchBody.tasks[1]!.taskNumber,
  }]);
});

test("agent-api task assignment fails closed for missing, ambiguous, and private-channel outsider handles", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();
  await db
    .update(serverAgentMembers)
    .set({ role: "admin" })
    .where(and(eq(serverAgentMembers.serverId, fixture.serverId), eq(serverAgentMembers.agentId, fixture.agentId)));

  const privateChannel = await createChannel(
    fixture.serverId,
    `task-private-${randomUUID().slice(0, 8)}`,
    undefined,
    "private",
  );
  await addAgent(privateChannel.id, fixture.agentId);
  const privateOutsider = await createAgent(fixture.serverId, `task-private-outsider-${randomUUID().slice(0, 8)}`, {
    runtime: "claude",
    model: "sonnet",
  });

  const ambiguousName = `task-ambiguous-${randomUUID().slice(0, 8)}`;
  const ambiguousAgent = await createAgent(fixture.serverId, ambiguousName, { runtime: "claude", model: "sonnet" });
  await addAgent(fixture.channelId, ambiguousAgent.id);
  const [ambiguousHuman] = await db.insert(users).values({
    email: `${ambiguousName}@slock.test`,
    name: ambiguousName,
    displayName: "Ambiguous Human",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  await db.insert(serverMembers).values({ serverId: fixture.serverId, userId: ambiguousHuman.id, role: "member" });
  await addHuman(fixture.channelId, ambiguousHuman.id);

  const cases = [
    {
      channel: `#${fixture.channelName}`,
      title: "missing assignment must be zero-write",
      assignee: "@missing-task-assignee",
      status: 404,
      code: "assignee_not_found",
    },
    {
      channel: `#${privateChannel.name}`,
      title: "private outsider assignment must be zero-write",
      assignee: `@${privateOutsider.name}`,
      status: 403,
      code: "assignee_cannot_claim",
    },
    {
      channel: `#${fixture.channelName}`,
      title: "ambiguous assignment must be zero-write",
      assignee: `@${ambiguousName}`,
      status: 409,
      code: "assignee_ambiguous",
    },
  ];

  for (const candidate of cases) {
    const response = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
      method: "POST",
      headers: jsonHeaders(fixture.agentApiKey),
      body: JSON.stringify({
        channel: candidate.channel,
        tasks: [{ title: candidate.title }],
        assignee: candidate.assignee,
      }),
    });
    assert.equal(response.status, candidate.status);
    assert.equal((await response.json() as { code?: string }).code, candidate.code);
  }

  const rejectedRows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(inArray(messages.content, cases.map((candidate) => candidate.title)));
  assert.deepEqual(rejectedRows, [], "all assignment authorization failures must leave zero task/message rows");
});

test("assigned task creation is rollback-atomic and post-commit fanout failures still return success", async ({ app }) => {

  try {
    const fixture = await seedAuthFixture();
    const db = getDb();
    await db
      .update(serverAgentMembers)
      .set({ role: "admin" })
      .where(and(eq(serverAgentMembers.serverId, fixture.serverId), eq(serverAgentMembers.agentId, fixture.agentId)));
    const target = await createAgent(fixture.serverId, `atomic-target-${randomUUID().slice(0, 8)}`, {
      runtime: "claude",
      model: "sonnet",
    });
    await addAgent(fixture.channelId, target.id);
    const originalDoneAt = new Date("2026-07-12T00:00:00.000Z");
    await db.insert(userChannelInboxStates).values({
      userId: fixture.ownerId,
      channelId: fixture.channelId,
      doneAt: originalDoneAt,
    });

    const socketEvents: string[] = [];
    const adapter = app.io.of("/").adapter as unknown as {
      broadcast(packet: { data?: unknown[] }, opts: unknown): void;
    };
    const originalBroadcast = adapter.broadcast.bind(adapter);
    adapter.broadcast = (packet, opts) => {
      if (typeof packet.data?.[0] === "string") socketEvents.push(packet.data[0]);
      originalBroadcast(packet, opts);
    };
    const orchestrator = app.app.get("agentOrchestrator") as {
      deliverMessage: (...args: unknown[]) => Promise<unknown>;
    };
    const originalDeliver = orchestrator.deliverMessage.bind(orchestrator);
    const deliveries: unknown[][] = [];
    orchestrator.deliverMessage = async (...args: unknown[]) => {
      deliveries.push(args);
      return originalDeliver(...args);
    };

    const durableCounts = async () => {
      const [messageRows, taskRows, factRows, mentionRows, inboxRows] = await Promise.all([
        db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, fixture.channelId)),
        // v1.4: the task fact is its own row, so rollback-atomicity has to cover
        // it too — a leaked `tasks` row is exactly the failure this test exists
        // to catch, and counting only messages would no longer see it.
        db.select({ id: tasks.id }).from(tasks).where(eq(tasks.channelId, fixture.channelId)),
        db.select({ id: inboxNotificationFacts.id }).from(inboxNotificationFacts)
          .where(eq(inboxNotificationFacts.sourceChannelId, fixture.channelId)),
        db.select({ id: messageMentions.id }).from(messageMentions)
          .where(eq(messageMentions.channelId, fixture.channelId)),
        db.select({ doneAt: userChannelInboxStates.doneAt }).from(userChannelInboxStates)
          .where(and(
            eq(userChannelInboxStates.userId, fixture.ownerId),
            eq(userChannelInboxStates.channelId, fixture.channelId),
          )),
      ]);
      return {
        messages: messageRows.length,
        tasks: taskRows.length,
        facts: factRows.length,
        mentions: mentionRows.length,
        doneAt: inboxRows[0]?.doneAt?.toISOString() ?? null,
      };
    };
    const createAssigned = (title: string) => fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
      method: "POST",
      headers: jsonHeaders(fixture.agentApiKey),
      body: JSON.stringify({
        channel: `#${fixture.channelName}`,
        tasks: [{ title }],
        assignee: `@${target.name}`,
      }),
    });

    for (const [failpoint, title] of [
      ["server.task.assignedCreate.afterTaskRows", "rollback after task rows"],
      ["server.task.assignedCreate.afterTaskFacts", "rollback after task facts"],
      ["server.task.assignedCreate.afterReceiptRow", "rollback after receipt row"],
      ["server.task.assignedCreate.afterReceiptFacts", "rollback after receipt facts"],
    ] as const) {
      const before = await durableCounts();
      const registry = new InMemoryFailpointRegistry();
      registry.configure(failpoint, { effect: "throw", payload: failpoint });
      __setFailpointsForTests(registry);
      const response = await createAssigned(title);
      __resetFailpointsForTests();
      assert.equal(response.status, 500);
      assert.deepEqual(await durableCounts(), before);
      assert.deepEqual(socketEvents, []);
      assert.deepEqual(deliveries, []);
    }

    const postCommitTitle = "post-commit fanout failure stays successful";
    const postCommitRegistry = new InMemoryFailpointRegistry();
    postCommitRegistry.configure("server.task.assignedCreate.postCommitFanout", {
      effect: "throw",
      payload: "injected post-commit fanout failure",
    });
    __setFailpointsForTests(postCommitRegistry);
    const postCommitResponse = await createAssigned(postCommitTitle);
    __resetFailpointsForTests();
    const postCommitText = await postCommitResponse.text();
    assert.equal(postCommitResponse.status, 200, postCommitText);
    const body = JSON.parse(postCommitText) as {
      tasks: Array<{ messageId: string; status: string; claimedById: string | null; claimedAt: string | null }>;
      assignmentReceipt: { messageId: string; content: string };
    };
    const persisted = await db.select().from(messages).where(eq(messages.channelId, fixture.channelId));
    const postCommitHosts = persisted.filter((row) => row.content === postCommitTitle && row.messageType === "chat");
    assert.equal(postCommitHosts.length, 1);
    assert.equal(postCommitHosts[0]?.taskStatus, null, "the host message stays a plain message under v1.4");
    const postCommitTasks = await db.select().from(tasks)
      .where(eq(tasks.messageId, postCommitHosts[0]!.id));
    assert.equal(postCommitTasks.length, 1, "the committed task fact lives in the tasks table");
    const receiptRows = persisted.filter((row) => row.messageType === "system" && row.content.includes(postCommitTitle));
    assert.equal(receiptRows.length, 1);
    assert.equal(receiptRows[0]?.searchText, buildSearchText(body.assignmentReceipt.content));
    assert.ok(getMaxSeq(fixture.serverId) >= receiptRows[0]!.seq, "heartbeat catch-up must include the committed receipt seq");
    assert.equal(body.tasks[0]?.status, "todo");
    assert.equal(body.tasks[0]?.claimedById, target.id);
    assert.equal(body.tasks[0]?.claimedAt, null);
    assert.equal((await durableCounts()).doneAt, null, "successful assigned creation must clear preexisting done state");

    const targetFacts = (await db.select().from(inboxNotificationFacts)
      .where(eq(inboxNotificationFacts.messageId, body.assignmentReceipt.messageId)))
      .filter((fact) => fact.receiverType === "agent" && fact.receiverId === target.id);
    assert.equal(targetFacts.length, 1, "receipt must create exactly one directed fact for its assignee");
    assert.equal(targetFacts[0]?.personalMention, true);
    const receiptMentions = await db.select().from(messageMentions)
      .where(eq(messageMentions.messageId, body.assignmentReceipt.messageId));
    assert.equal(receiptMentions.length, 1);
    assert.equal(receiptMentions[0]?.targetId, target.id);
    // The notification outbox rows committed with the task, so the unified
    // dispatcher delivers them whatever happened to the realtime fanout: a
    // committed event must not lose its notification because an unrelated
    // post-commit emit failed. Every other assigned-path emit stays absent.
    await drainNotificationTasksForTests();
    const fanoutEvents = socketEvents.filter((event) => !event.startsWith("notification:"));
    assert.deepEqual(fanoutEvents, [], "the injected fanout failure occurs before every assigned-path emit");
    assert.deepEqual(deliveries, []);
    const hostOutbox = await db.select().from(notificationOutbox)
      .where(eq(notificationOutbox.messageId, postCommitHosts[0]!.id));
    assert.ok(hostOutbox.length > 0, "the committed host message has its outbox rows");
    for (const row of hostOutbox) assert.notEqual(row.status, "pending", "the committed notification was dispatched");
  } finally {
    __resetFailpointsForTests();
    await app.close();
  }
});

test("assigned task creation keeps enabled #all as the virtual server audience", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();
  await db
    .update(serverAgentMembers)
    .set({ role: "admin" })
    .where(and(eq(serverAgentMembers.serverId, fixture.serverId), eq(serverAgentMembers.agentId, fixture.agentId)));
  const target = await createAgent(fixture.serverId, `all-target-${randomUUID().slice(0, 8)}`, {
    runtime: "claude",
    model: "sonnet",
  });
  const [allChannel] = await db.select().from(channels).where(and(
    eq(channels.serverId, fixture.serverId),
    eq(channels.name, "all"),
  ));
  assert.equal(allChannel?.type, "channel");
  assert.deepEqual(
    await db.select().from(channelAgents).where(and(
      eq(channelAgents.channelId, allChannel!.id),
      eq(channelAgents.agentId, target.id),
    )),
    [],
  );

  const response = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: "#all",
      tasks: [{ title: "virtual all assignment" }],
      assignee: `@${target.name}`,
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text) as { assignmentReceipt: { messageId: string } };
  const receiptFacts = await db.select().from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, body.assignmentReceipt.messageId));
  assert.ok(receiptFacts.some((fact) => (
    fact.receiverType === "agent"
    && fact.receiverId === target.id
    && fact.personalMention
  )));
});

test("assignment receipts give only the muted human or agent assignee durable personal attention", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();
  await db
    .update(serverAgentMembers)
    .set({ role: "admin" })
    .where(and(eq(serverAgentMembers.serverId, fixture.serverId), eq(serverAgentMembers.agentId, fixture.agentId)));

  const targetAgent = await createAgent(fixture.serverId, `muted-target-${randomUUID().slice(0, 8)}`, {
    runtime: "claude",
    model: "sonnet",
  });
  const unrelatedAgent = await createAgent(fixture.serverId, `muted-unrelated-${randomUUID().slice(0, 8)}`, {
    runtime: "claude",
    model: "sonnet",
  });
  await addAgent(fixture.channelId, targetAgent.id);
  await addAgent(fixture.channelId, unrelatedAgent.id);

  const makeHuman = async (prefix: string) => {
    const name = `${prefix}-${randomUUID().slice(0, 8)}`;
    const [human] = await db.insert(users).values({
      email: `${name}@slock.test`,
      name,
      displayName: name,
      passwordHash: await argon2.hash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    await db.insert(serverMembers).values({ serverId: fixture.serverId, userId: human.id, role: "member" });
    await addHuman(fixture.channelId, human.id);
    return human;
  };
  const targetHuman = await makeHuman("muted-human-target");
  const unrelatedHuman = await makeHuman("muted-human-unrelated");

  await db.insert(inboxTargetMuteStates).values([
    {
      receiverType: "agent",
      receiverId: targetAgent.id,
      serverId: fixture.serverId,
      sourceChannelId: fixture.channelId,
      muteFromSeq: 1,
    },
    {
      receiverType: "agent",
      receiverId: unrelatedAgent.id,
      serverId: fixture.serverId,
      sourceChannelId: fixture.channelId,
      muteFromSeq: 1,
    },
    {
      receiverType: "user",
      receiverId: targetHuman.id,
      serverId: fixture.serverId,
      sourceChannelId: fixture.channelId,
      muteFromSeq: 1,
    },
    {
      receiverType: "user",
      receiverId: unrelatedHuman.id,
      serverId: fixture.serverId,
      sourceChannelId: fixture.channelId,
      muteFromSeq: 1,
    },
  ]);

  const createAssigned = async (title: string, assignee: string) => {
    const response = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
      method: "POST",
      headers: jsonHeaders(fixture.agentApiKey),
      body: JSON.stringify({
        channel: `#${fixture.channelName}`,
        tasks: [{ title }],
        assignee: `@${assignee}`,
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text) as {
      assignmentReceipt: { messageId: string; content: string; assignee: string; state: string };
    };
  };

  const agentAssignment = await createAssigned("muted agent directed work", targetAgent.name);
  const humanAssignment = await createAssigned("muted human directed work", targetHuman.name);

  for (const expected of [
    { receipt: agentAssignment.assignmentReceipt, type: "agent" as const, id: targetAgent.id, name: targetAgent.name },
    { receipt: humanAssignment.assignmentReceipt, type: "user" as const, id: targetHuman.id, name: targetHuman.name },
  ]) {
    assert.equal(expected.receipt.state, "assigned");
    assert.equal(expected.receipt.assignee, `@${expected.name}`);
    assert.match(expected.receipt.content, new RegExp(`@${expected.name}`));

    const facts = await db
      .select({
        receiverType: inboxNotificationFacts.receiverType,
        receiverId: inboxNotificationFacts.receiverId,
        personalMention: inboxNotificationFacts.personalMention,
        unreadEligible: inboxNotificationFacts.unreadEligible,
      })
      .from(inboxNotificationFacts)
      .where(eq(inboxNotificationFacts.messageId, expected.receipt.messageId));
    assert.deepEqual(facts.filter((fact) => fact.receiverType === expected.type && fact.receiverId === expected.id), [{
      receiverType: expected.type,
      receiverId: expected.id,
      personalMention: true,
      unreadEligible: true,
    }]);
    assert.equal(
      facts.some((fact) => (
        (fact.receiverType === "agent" && fact.receiverId === unrelatedAgent.id)
        || (fact.receiverType === "user" && fact.receiverId === unrelatedHuman.id)
      )),
      false,
      "unrelated muted members must not be pierced by somebody else's assignment",
    );

    const mentions = await db
      .select({
        targetType: messageMentions.targetType,
        targetId: messageMentions.targetId,
        handle: messageMentions.handleAtSendTime,
        notifiedAt: messageMentions.notifiedAt,
      })
      .from(messageMentions)
      .where(eq(messageMentions.messageId, expected.receipt.messageId));
    assert.deepEqual(mentions.map((mention) => ({
      targetType: mention.targetType,
      targetId: mention.targetId,
      handle: mention.handle,
      notified: mention.notifiedAt instanceof Date,
    })), [{
      targetType: expected.type,
      targetId: expected.id,
      handle: expected.name,
      notified: true,
    }]);
  }
});

test("agent-api task claim reports already claimed by you for self-claim", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const fixture = await seedAuthFixture();
  const { tasks: [task] } = await taskService.createTasks(fixture.channelId, "user", fixture.ownerId, [{ title: "self claim route" }]);

  const firstClaim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, task_numbers: [task.taskNumber] }),
  });
  assert.equal(firstClaim.status, 200);
  assert.deepEqual((await firstClaim.json() as { results?: unknown[] }).results, [
    { taskNumber: task.taskNumber, messageId: task.messageId, title: "self claim route", success: true },
  ]);

  const secondClaim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, task_numbers: [task.taskNumber] }),
  });
  assert.equal(secondClaim.status, 200);
  assert.deepEqual((await secondClaim.json() as { results?: unknown[] }).results, [
    { taskNumber: task.taskNumber, success: false, reason: "already claimed by you" },
  ]);

  const messageClaim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    // v1.4: claiming by message id must use the HOST message id, not the task id.
    body: JSON.stringify({ channel: `#${fixture.channelName}`, message_ids: [task.messageId.slice(0, 8)] }),
  });
  assert.equal(messageClaim.status, 200);
  assert.deepEqual((await messageClaim.json() as { results?: unknown[] }).results, [
    { messageId: task.messageId, success: false, reason: "already claimed by you", taskNumber: task.taskNumber },
  ]);

  const claimSpans = sink.getAllSpans().filter((candidate) =>
    candidate.name === "server.db.query"
    && candidate.attrs?.query_name === "tasks.claim"
    && candidate.attrs?.phase === "agent_api_task_claim"
  );
  assert.equal(claimSpans.length, 3);
  assert.deepEqual(claimSpans.map((span) => span.attrs?.claim_mode), ["task_number", "task_number", "message_id"]);
  assert.deepEqual(claimSpans.map((span) => span.attrs?.successful_claim_count), [1, 0, 0]);
  assert.equal(claimSpans.every((span) => span.context.parentSpanId != null), true);
  assert.equal(JSON.stringify(claimSpans).includes(fixture.channelName), false);
});

test("agent-api can claim an agent-DM task and reply using the DM task thread target", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const peerAgent = await createAgent(fixture.serverId, "庄天翼", { runtime: "claude", model: "sonnet" });
  const dm = await findOrCreateAgentDM(fixture.serverId, fixture.agentId, peerAgent.id);
  assert.ok(dm, "expected agent-to-agent DM");
  const taskParent = await createMessage(dm.id, "agent", peerAgent.id, "agent DM task parent");

  const claim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: `dm:@${peerAgent.name}`, message_ids: [taskParent.id.slice(0, 8)] }),
  });
  assert.equal(claim.status, 200);
  assert.deepEqual((await claim.json() as { results?: unknown[] }).results, [
    { messageId: taskParent.id, success: true, taskNumber: 1 },
  ]);

  const followUpTarget = `dm:@${peerAgent.name}:${taskParent.id.slice(0, 8)}`;
  const send = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      target: followUpTarget,
      content: "following up in the DM task thread",
      seenUpToSeq: taskParent.seq,
    }),
  });
  assert.equal(send.status, 200);
  const sendBody = await send.json() as { messageId?: string; state?: string };
  assert.equal(sendBody.state, "sent");
  assert.ok(sendBody.messageId);

  const db = getDb();
  const [sentMessage] = await db
    .select({ channelType: channels.type })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(eq(messages.id, sendBody.messageId));
  assert.equal(sentMessage?.channelType, "thread");
});

test("agent-api rejects thread-target task claims without throwing 5xx", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const parent = await createMessage(fixture.channelId, "user", fixture.ownerId, "thread parent for invalid task claim");
  const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
  const reply = await createMessage(thread.id, "agent", fixture.agentId, "thread reply should not become a task");

  const claim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: `#${fixture.channelName}:${parent.id.slice(0, 8)}`,
      message_ids: [reply.id.slice(0, 8)],
    }),
  });

  assert.equal(claim.status, 409);
  const body = await claim.json() as { error?: string };
  assert.equal(body.error, "A thread holds no tasks, so its messages can't be claimed as tasks: claim tasks in the thread's channel instead.");

  const [unchangedReply] = await getDb().select().from(messages).where(eq(messages.id, reply.id));
  assert.equal(unchangedReply?.taskStatus, null);
  assert.equal(unchangedReply?.taskNumber, null);
});

test("agent-api DM task thread target scopes short parent ids to the requested DM", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const peerAgent = await createAgent(fixture.serverId, "庄天翼", { runtime: "claude", model: "sonnet" });
  const dm = await findOrCreateAgentDM(fixture.serverId, fixture.agentId, peerAgent.id);
  assert.ok(dm, "expected agent-to-agent DM");
  const db = getDb();
  const decoyId = "21d61198-0000-4000-8000-000000000001";
  const taskParentId = "21d61198-0000-4000-8000-000000000002";
  await db.insert(messages).values({
    id: decoyId,
    channelId: fixture.channelId,
    senderType: "agent",
    senderId: fixture.agentId,
    content: "same-prefix decoy outside the DM",
    searchText: "same-prefix decoy outside the DM",
  });
  const [taskParent] = await db.insert(messages).values({
    id: taskParentId,
    channelId: dm.id,
    senderType: "agent",
    senderId: peerAgent.id,
    content: "same-prefix agent DM task parent",
    searchText: "same-prefix agent DM task parent",
  }).returning();

  const claim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: `dm:@${peerAgent.name}`, message_ids: [taskParent.id.slice(0, 8)] }),
  });
  assert.equal(claim.status, 200);
  assert.deepEqual((await claim.json() as { results?: unknown[] }).results, [
    { messageId: taskParent.id, success: true, taskNumber: 1 },
  ]);

  const send = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      target: `dm:@${peerAgent.name}:${taskParent.id.slice(0, 8)}`,
      content: "following up despite a server-wide short-id collision",
      seenUpToSeq: taskParent.seq,
    }),
  });
  assert.equal(send.status, 200);
  const sendBody = await send.json() as { messageId?: string; state?: string };
  assert.equal(sendBody.state, "sent");
  assert.ok(sendBody.messageId);
});

/**
 * @Stone, reviewing `a22a1bcf9`: the agent `taskAssign` handle resolver leaked
 * the public-channel outsider-human case that its own comment promises is opaque.
 *
 * `resolveTaskAssignAssignee` pre-checked humans with `canUserAccessChannel`,
 * which returns true for ANY public channel (`channel.type === "channel"`) —
 * not only for members. So a known server member who is NOT in `channel_humans`
 * sailed past the pre-check, reached `assignTask`, and came back with a
 * distinguishable `409 assignee is not a member of this channel`. That tells a
 * caller the handle exists AND is a server member: exactly the directory oracle
 * the resolver exists to close.
 *
 * The pre-existing opacity test covers CREATE-time assignment
 * (`POST /internal/agent-api/tasks`) and a PRIVATE channel, so neither the
 * `taskAssign` route nor the public-channel case was pinned.
 */
test("agent-api taskAssign stays opaque for a public-channel outsider human", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();

  // A real server member who is deliberately NOT in the (public) channel.
  const [outsiderHuman] = await db.insert(users).values({
    email: `taskassign-outsider-${randomUUID()}@slock.test`,
    name: `taskassign-outsider-${randomUUID().slice(0, 8)}`,
    displayName: "Task Assign Outsider",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  await db.insert(serverMembers).values({
    serverId: fixture.serverId,
    userId: outsiderHuman.id,
    role: "member",
  });
  const [wronglyMember] = await db
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, fixture.channelId), eq(channelHumans.userId, outsiderHuman.id)));
  assert.equal(wronglyMember, undefined, "precondition: outsider must NOT be a channel human");

  const created = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, tasks: [{ title: "opaque assign target" }] }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const { tasks: [createdTask] } = await created.json() as {
    tasks: Array<{ taskNumber: number; id: string }>;
  };

  const [before] = await db.select().from(tasks).where(eq(tasks.taskNumber, createdTask.taskNumber));

  const res = await fetch(`${app.baseUrl}/internal/agent-api/tasks/assign`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: `#${fixture.channelName}`,
      task_number: createdTask.taskNumber,
      assignee: `@${outsiderHuman.name}`,
    }),
  });

  // Must be the SAME answer a missing/ambiguous handle gets — never the
  // downstream 409 that confirms the person exists.
  assert.equal(res.status, 404, `outsider human must not be distinguishable: ${await res.clone().text()}`);
  assert.equal((await res.json() as { code?: string }).code, "assignee_not_assignable");

  const [after] = await db.select().from(tasks).where(eq(tasks.taskNumber, createdTask.taskNumber));
  assert.equal(after.claimedById, before.claimedById, "refused assign must not change the assignee");
  assert.equal(after.revision, before.revision, "refused assign must not burn a revision");
});

// stdrc 2026-10-31 (#wg-task-v2 msg=ad820421): any status from any status, for
// people and agents alike. A member moving someone else's started work back to
// todo is allowed; what must hold is that the assignment survives the move and
// the assignee's next claim stamps a fresh start epoch.
test("agent-api moving started work back to todo keeps the assignment, and the assignee's claim restarts it", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();

  const peer = await createAgent(fixture.serverId, `task-demote-peer-${randomUUID().slice(0, 8)}`, {
    runtime: "claude",
    model: "sonnet",
  });
  await addAgent(fixture.channelId, peer.id);
  const peerKey = await mintAgentKey(peer.id, ["tasks"]);

  const created = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: `#${fixture.channelName}`,
      tasks: [{ title: "undo an accidental self-start" }],
      assignee: "@AgentApiAuthBot",
    }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const { tasks: [createdTask] } = await created.json() as {
    tasks: Array<{ taskNumber: number; status: string; claimedAt: string | null }>;
  };
  assert.equal(createdTask.status, "in_progress", "self-assigned create still means start work");
  assert.ok(createdTask.claimedAt, "self-assigned create stamps its start epoch");

  const setStatus = (apiKey: string, status: string) =>
    fetch(`${app.baseUrl}/internal/agent-api/tasks/update-status`, {
      method: "POST",
      headers: jsonHeaders(apiKey),
      body: JSON.stringify({ channel: `#${fixture.channelName}`, task_number: createdTask.taskNumber, status }),
    });

  const peerDemotion = await setStatus(peerKey, "todo");
  assert.equal(peerDemotion.status, 200, `any member may set any status: ${await peerDemotion.clone().text()}`);

  const unchanged = await setStatus(fixture.agentApiKey, "todo");
  assert.equal(unchanged.status, 409, "setting the status a task already has is the one refusal");
  assert.match((await unchanged.json() as { error: string }).error, /already todo/);

  const [reserved] = await db.select().from(tasks).where(eq(tasks.taskNumber, createdTask.taskNumber));
  assert.equal(reserved.status, "todo");
  assert.equal(reserved.claimedByType, "agent", "undoing start preserves the reservation");
  assert.equal(reserved.claimedById, fixture.agentId, "undoing start must not unlock the task");
  assert.equal(reserved.claimedAt, null, "todo carries no stale work-start epoch");

  const events = await db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, reserved.id))
    .orderBy(taskEvents.seq);
  const demotion = events.filter((event) => event.eventType === "status_changed").at(-1)!;
  assert.equal(demotion.actorType, "agent");
  assert.equal(demotion.actorId, peer.id);
  assert.deepEqual(demotion.payload, { from: "in_progress", to: "todo", forced: false });

  const resumed = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, task_numbers: [createdTask.taskNumber] }),
  });
  assert.equal(resumed.status, 200, await resumed.clone().text());
  assert.equal((await resumed.json() as { results: Array<{ success: boolean }> }).results[0]?.success, true);
  const [restarted] = await db.select().from(tasks).where(eq(tasks.taskNumber, createdTask.taskNumber));
  assert.equal(restarted.status, "in_progress");
  assert.ok(restarted.claimedAt, "claiming the reserved todo work stamps a fresh start epoch");
});

/**
 * stdrc 2026-10-31 (#wg-task-v2 msg=ad820421): "所有的状态之间切换的限制其实都不需要了".
 * `todo -> done` used to be the probe for the transition table (and for the
 * admin-agent force override that skipped it). With the table gone a plain
 * member agent makes the same jump, and back; only a write of the status the
 * task already has is refused, under its own code.
 */
test("agent-api task status: a member agent moves any status to any status; the same status is refused", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();

  const created = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, tasks: [{ title: "jump straight to done" }] }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const { tasks: [{ taskNumber }] } = await created.json() as { tasks: Array<{ taskNumber: number }> };
  const setStatus = (status: string) =>
    fetch(`${app.baseUrl}/internal/agent-api/tasks/update-status`, {
      method: "POST",
      headers: jsonHeaders(fixture.agentApiKey),
      body: JSON.stringify({ channel: `#${fixture.channelName}`, task_number: taskNumber, status }),
    });

  const [memberRole] = await db
    .select({ role: serverAgentMembers.role })
    .from(serverAgentMembers)
    .where(and(eq(serverAgentMembers.serverId, fixture.serverId), eq(serverAgentMembers.agentId, fixture.agentId)));
  assert.equal(memberRole.role, "member", "precondition: the fixture agent is a plain member");

  for (const status of ["done", "todo", "in_review", "closed", "in_progress"]) {
    const res = await setStatus(status);
    assert.equal(res.status, 200, `${status}: ${await res.clone().text()}`);
    const [row] = await db.select().from(tasks).where(eq(tasks.taskNumber, taskNumber));
    assert.equal(row.status, status, "the status write must land");
  }

  const same = await setStatus("in_progress");
  assert.equal(same.status, 409, await same.clone().text());
  assert.match((await same.json() as { error: string }).error, /already in_progress/);
});

/**
 * Agent-side delete, mirroring the browser rule (creator OR `manageServer`).
 *
 * Before this route existed, `raft task delete` did not exist at all: an agent
 * could not remove even a task it had just created by mistake, while a human
 * creator could. This pins all three arms — creator allowed, non-creator member
 * refused, non-creator admin allowed — because a rule proven on one arm is not
 * a rule.
 */
test("agent-api task delete: creator yes, non-creator member no, non-creator admin yes", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();

  // A second agent in the same channel, so "not the creator" is a real state
  // rather than a permission we simply never exercise.
  const otherAgent = await createAgent(fixture.serverId, `task-delete-other-${randomUUID().slice(0, 8)}`, {
    runtime: "claude",
    model: "sonnet",
  });
  await addAgent(fixture.channelId, otherAgent.id);
  const otherAgentKey = await mintAgentKey(otherAgent.id, ["tasks"]);
  const [otherRole] = await db
    .select({ role: serverAgentMembers.role })
    .from(serverAgentMembers)
    .where(and(eq(serverAgentMembers.serverId, fixture.serverId), eq(serverAgentMembers.agentId, otherAgent.id)));
  assert.equal(otherRole.role, "member", "precondition: the second agent starts as a plain member");

  const createTask = async (title: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
      method: "POST",
      headers: jsonHeaders(fixture.agentApiKey),
      body: JSON.stringify({ channel: `#${fixture.channelName}`, tasks: [{ title }] }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const { tasks: [created] } = await res.json() as { tasks: Array<{ taskNumber: number }> };
    return created.taskNumber;
  };
  const deleteTask = (apiKey: string, taskNumber: number) =>
    fetch(`${app.baseUrl}/internal/agent-api/tasks/delete`, {
      method: "POST",
      headers: jsonHeaders(apiKey),
      body: JSON.stringify({ channel: `#${fixture.channelName}`, task_number: taskNumber }),
    });

  // --- non-creator member: refused, and the row survives ---
  const guarded = await createTask("only its creator may remove this");
  const refused = await deleteTask(otherAgentKey, guarded);
  assert.equal(refused.status, 403, `non-creator member must be refused: ${await refused.clone().text()}`);
  assert.equal((await refused.json() as { code?: string }).code, "task_delete_forbidden");
  const survivors = await db.select().from(tasks).where(eq(tasks.taskNumber, guarded));
  assert.equal(survivors.length, 1, "a refused delete must not remove the row");

  // --- creator: allowed, and the row is really gone ---
  const creatorDeleted = await deleteTask(fixture.agentApiKey, guarded);
  assert.equal(creatorDeleted.status, 200, await creatorDeleted.clone().text());
  const afterCreatorDelete = await db.select().from(tasks).where(eq(tasks.taskNumber, guarded));
  assert.equal(afterCreatorDelete.length, 0, "the creator's delete must actually drop the row");

  // --- non-creator admin: allowed on someone else's task ---
  const adminTarget = await createTask("an admin may remove another agent's task");
  await db
    .update(serverAgentMembers)
    .set({ role: "admin" })
    .where(and(eq(serverAgentMembers.serverId, fixture.serverId), eq(serverAgentMembers.agentId, otherAgent.id)));
  const adminDeleted = await deleteTask(otherAgentKey, adminTarget);
  assert.equal(adminDeleted.status, 200, `admin agent must be able to delete: ${await adminDeleted.clone().text()}`);
  const afterAdminDelete = await db.select().from(tasks).where(eq(tasks.taskNumber, adminTarget));
  assert.equal(afterAdminDelete.length, 0, "the admin's delete must actually drop the row");
});

/**
 * Standalone convert: a message becomes a task WITHOUT being claimed.
 *
 * `taskClaim --message-id` already converted, but it assigns the result to the
 * caller — so an agent filing work for someone else had to take it first and
 * hand it back. The assertion that matters is `claimedById === null`: if this
 * route ever starts behaving like claim, that is the field that moves.
 */
test("agent-api task convert turns a message into an UNCLAIMED task", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();

  const message = await createMessage(
    fixture.channelId,
    "user",
    fixture.ownerId,
    "someone should look at the retry storm",
  );

  const [beforeRow] = await db.select().from(tasks).where(eq(tasks.messageId, message.id));
  assert.equal(beforeRow, undefined, "precondition: the message is not already a task");

  const res = await fetch(`${app.baseUrl}/internal/agent-api/tasks/convert`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, message_id: message.id }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const { task } = await res.json() as {
    task: { taskNumber: number; messageId: string; status: string; claimedById: string | null };
  };
  assert.equal(task.messageId, message.id);
  assert.equal(task.status, "todo");
  assert.equal(task.claimedById, null, "convert must NOT assign the task to the calling agent");

  const [row] = await db.select().from(tasks).where(eq(tasks.messageId, message.id));
  assert.equal(row.status, "todo");
  assert.equal(row.claimedById, null, "the persisted row must be unassigned, not just the response");
  assert.equal(row.claimedAt, null, "an unclaimed task must not carry a claim timestamp");
  assert.equal(row.createdByType, "agent");
  assert.equal(row.createdById, fixture.agentId);

  // Converting twice is a conflict, not a second task.
  const again = await fetch(`${app.baseUrl}/internal/agent-api/tasks/convert`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, message_id: message.id }),
  });
  assert.equal(again.status, 409, await again.clone().text());
  const rows = await db.select().from(tasks).where(eq(tasks.messageId, message.id));
  assert.equal(rows.length, 1, "a repeated convert must not create a second task row");
});

/**
 * A forced status change must name WHO forced it.
 *
 * `forceUpdateTaskStatus` took no actor, so `writeCanonicalStatus` fell through
 * to `actorType: "system"` — the one status change that most needs
 * accountability (someone overriding the state machine) was the only one
 * recording nobody. Found by driving a real admin agent against a running
 * server and reading `task_events`, not by any unit test: the suite asserted
 * the 200 and the `forced: true` flag, and never asked who did it.
 *
 * The forced-`closed` case is worse than anonymous. `closed_by_*` falls back to
 * `observed.claimedByType/Id`, so an admin force-closing someone else's task
 * recorded the PREVIOUS ASSIGNEE as the closer — an affirmatively wrong name,
 * not a missing one.
 *
 * Since #12227 (any status from any status) the agent route has no force
 * branch at all; the browser route forces only for orphan tasks. So the forced
 * write is driven through `forceUpdateTaskStatus` directly, and the route's
 * closing write still has to name the agent that made it.
 */
test("forced status records the forcing agent, and the agent route's close names the closer, not the previous assignee", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();

  const victim = await createAgent(fixture.serverId, `force-victim-${randomUUID().slice(0, 8)}`, {
    runtime: "claude",
    model: "sonnet",
  });
  await addAgent(fixture.channelId, victim.id);

  await db
    .update(serverAgentMembers)
    .set({ role: "admin" })
    .where(and(eq(serverAgentMembers.serverId, fixture.serverId), eq(serverAgentMembers.agentId, fixture.agentId)));

  const created = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: `#${fixture.channelName}`,
      tasks: [{ title: "force-close someone else's work" }],
      assignee: `@${victim.name}`,
    }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const { tasks: [createdTask] } = await created.json() as { tasks: Array<{ taskNumber: number }> };

  const [beforeRow] = await db.select().from(tasks).where(eq(tasks.taskNumber, createdTask.taskNumber));
  assert.equal(beforeRow.claimedById, victim.id, "precondition: the task belongs to the other agent");

  const forced = await taskService.forceUpdateTaskStatus(beforeRow.id, "in_review", "agent", fixture.agentId);
  assert.notEqual(typeof forced, "string", `forced write refused: ${String(forced)}`);

  const [row] = await db.select().from(tasks).where(eq(tasks.taskNumber, createdTask.taskNumber));
  const events = await db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, row.id))
    .orderBy(taskEvents.seq);
  const statusEvent = events.filter((e) => e.eventType === "status_changed").at(-1)!;

  assert.equal((statusEvent.payload as { forced?: boolean }).forced, true, "precondition: the forced branch ran");
  assert.equal(statusEvent.actorType, "agent", "a forced change must not be attributed to `system`");
  assert.equal(statusEvent.actorId, fixture.agentId, "the actor must be the agent that forced it");
  assert.notEqual(statusEvent.actorId, victim.id, "the assignee did not do this");

  // And the closed_by_* columns, which had the affirmatively-wrong fallback.
  const closed = await fetch(`${app.baseUrl}/internal/agent-api/tasks/update-status`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      channel: `#${fixture.channelName}`,
      task_number: createdTask.taskNumber,
      status: "closed",
    }),
  });
  assert.equal(closed.status, 200, await closed.clone().text());

  const [closedRow] = await db.select().from(tasks).where(eq(tasks.taskNumber, createdTask.taskNumber));
  assert.equal(closedRow.closedByType, "agent");
  assert.equal(closedRow.closedById, fixture.agentId, "the forcer closed it, not the assignee it was taken from");
  assert.notEqual(closedRow.closedById, victim.id);
});

test("agent task status change posts a task.lifecycle_thread system message with the agent as causal actor", async ({ app, db }) => {
  const fixture = await seedAuthFixture();
  const channelRef = `#${fixture.channelName}`;

  const create = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: channelRef, tasks: [{ title: "lifecycle notice task" }] }),
  });
  assert.equal(create.status, 200);
  const createBody = await create.json() as { tasks?: Array<{ taskNumber?: number }> };
  const taskNumber = createBody.tasks?.[0]?.taskNumber;
  assert.equal(taskNumber, 1);

  const update = await fetch(`${app.baseUrl}/internal/agent-api/tasks/update-status`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ channel: channelRef, task_number: taskNumber, status: "in_progress" }),
  });
  assert.equal(update.status, 200);

  // The lifecycle broadcast is fire-and-forget (void async), so poll with a
  // bounded timeout rather than sleep — assert the message row actually lands.
  const deadline = Date.now() + 5_000;
  let lifecycleMessage: { causalActorType: string | null; causalActorId: string | null } | undefined;
  while (Date.now() < deadline) {
    const [row] = await db.select({ causalActorType: messages.causalActorType, causalActorId: messages.causalActorId })
      .from(messages)
      .where(and(
        eq(messages.messageType, "system"),
        eq(messages.systemSubtype, "task.lifecycle_thread"),
        eq(messages.senderId, "system"),
        like(messages.content, "%lifecycle notice task%"),
      ))
      .orderBy(desc(messages.seq))
      .limit(1);
    if (row) { lifecycleMessage = row; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(lifecycleMessage, "task.lifecycle_thread system message must appear for an agent status change");
  assert.equal(lifecycleMessage.causalActorType, "agent");
  assert.equal(lifecycleMessage.causalActorId, fixture.agentId);
});
