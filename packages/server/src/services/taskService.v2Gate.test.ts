import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { channels, inboxNotificationFacts, serverMembers, taskEvents, tasks, threadFollows, users } from "../db/schema";
import { addHuman, createChannel } from "./channelService";
import { createServer } from "./serverService";
import * as messageService from "./messageService";
import * as taskService from "./taskService";
import { ensureTaskConversation } from "./taskConversationService";
import { isTaskV2ConversationsEnabled, TaskV2NotEnabledError } from "./taskConversationsGate";
import { loadAgentSourceTasksByMessageId } from "./messageTaskProjection";

// The migration seeds task_v2_conversations_v0 default OFF; each test turns it
// on per server exactly like FFA (a server allow rule).
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}-${randomUUID()}@slock.test`,
    name: `${name}-${randomUUID().slice(0, 8)}`,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user!;
}

async function seedChannel(label: string) {
  const owner = await seedUser(`${label}-owner`);
  const member = await seedUser(`${label}-member`);
  const server = await createServer(`Gate ${label}`, `gate-${label}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, `gate-${label}`);
  await addHuman(channel.id, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" }).onConflictDoNothing();
  await addHuman(channel.id, member.id);
  return { owner, member, server, channel };
}

async function factsForMessage(messageId: string) {
  return getDb().select().from(inboxNotificationFacts).where(eq(inboxNotificationFacts.messageId, messageId));
}

test("flag off (default): createTasks writes the pre-v2 visible host message, recorded as channel activity", async ({ app }) => {
  const { owner, server, channel } = await seedChannel("off");
  assert.equal(await isTaskV2ConversationsEnabled(server.id), false);

  const created = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "visible task body" }]);
  const [task] = created.tasks;
  const [host] = created.hostMessages;
  assert.equal(created.hostMessagesVisible, true);
  assert.equal(host!.messageType, "chat");
  assert.equal(host!.systemSubtype, null);
  assert.equal(host!.content, "visible task body");
  assert.equal(task!.messageId, host!.id);
  assert.equal(task!.sourceMessageId, host!.id, "the host message is also the task's source message");
  assert.equal(task!.conversationAnchored, false);

  const history = await messageService.listMessages(channel.id, 50);
  assert.ok(history.some((row) => row.id === host!.id), "the host message is a visible history row");
  assert.ok((await factsForMessage(host!.id)).length > 0, "the task.body inbox fact is recorded as before");

  // Claim-by-message keeps working for the host-message task.
  const target = await taskService.resolveClaimTargetByMessageId(host!.id);
  assert.equal(target.kind, "task");
  if (target.kind === "task") assert.equal(target.owner.row.id, task!.id);

  // No agent-facing source-task list on a flag-off server.
  assert.equal((await loadAgentSourceTasksByMessageId([host!.id])).size, 0);
});

test("flag off: a source message is refused with task_v2_not_enabled, description is fine", async ({ app }) => {
  const { owner, channel } = await seedChannel("off-source");
  const request = await messageService.createMessage(channel.id, "user", owner.id, "please do it");
  await assert.rejects(
    taskService.createTasks(channel.id, "user", owner.id, [{ title: "linked", sourceMessageId: request.id }]),
    (err: unknown) => err instanceof TaskV2NotEnabledError && err.code === "task_v2_not_enabled" && err.status === 403,
  );
  assert.equal((await getDb().select().from(tasks).where(eq(tasks.channelId, channel.id))).length, 0, "nothing was written");

  const { tasks: [described] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "described", description: "details" }]);
  assert.equal(described!.description, "details");
});

test("flag off: assigned creation writes the visible host message and its inbox facts", async ({ app }) => {
  const { owner, channel } = await seedChannel("off-assigned");
  const result = await taskService.createTasksWithAssignmentReceipt(
    channel.id,
    "user",
    owner.id,
    [{ title: "assigned visible body" }],
    { type: "user", id: owner.id },
    { assigneeName: owner.name },
  );
  const [host] = result.hostMessages;
  assert.equal(result.hostMessagesVisible, true);
  assert.equal(host!.messageType, "chat");
  assert.equal(result.tasks[0]!.messageId, host!.id);
  assert.equal(result.tasks[0]!.sourceMessageId, host!.id);
  assert.ok((await factsForMessage(host!.id)).length > 0);
});

test("the flag is per server: on → task conversations (lazy) + source messages and no message, another server stays pre-v2", async ({ app }) => {
  const on = await seedChannel("on");
  const off = await seedChannel("other");
  await enableTaskV2ConversationsForServer(on.server.id);
  assert.equal(await isTaskV2ConversationsEnabled(on.server.id), true);
  assert.equal(await isTaskV2ConversationsEnabled(off.server.id), false);

  const request = await messageService.createMessage(on.channel.id, "user", on.owner.id, "ship it");
  const created = await taskService.createTasks(on.channel.id, "user", on.owner.id, [
    { title: "hero", sourceMessageId: request.id },
    { title: "pricing", sourceMessageId: request.id },
  ]);
  assert.equal(created.hostMessagesVisible, false);
  assert.deepEqual(created.hostMessages, [], "creating a task v2 task writes no message at all");
  assert.deepEqual(created.tasks.map((t) => t.sourceMessageId), [request.id, request.id]);
  assert.deepEqual(created.tasks.map((t) => t.conversationAnchored), [true, true]);
  assert.deepEqual(created.tasks.map((t) => t.hostMessageId), [null, null]);
  assert.deepEqual(created.tasks.map((t) => t.conversationChannelId), [null, null], "conversations are created lazily");
  for (const task of created.tasks) {
    const ensured = await ensureTaskConversation(task.id, { initiatingServerId: on.server.id });
    assert.equal(ensured?.created, true, "the first use creates it");
    const [conversation] = await getDb().select().from(channels).where(eq(channels.id, ensured!.conversation.canonicalChannelId));
    assert.equal(conversation!.type, "task");
    assert.equal(conversation!.taskId, task.id);
    assert.equal(conversation!.parentChannelId, on.channel.id, "the conversation's parent is the task's channel");
    const [follow] = await getDb().select().from(threadFollows).where(eq(threadFollows.threadChannelId, conversation!.id));
    assert.deepEqual(
      [follow!.followerType, follow!.followerId, follow!.reason, follow!.parentTaskId, follow!.parentMessageId],
      ["user", on.owner.id, "authored", task.id, null],
      "the creator follows its task from the moment its conversation exists",
    );
  }
  const history = await messageService.listMessages(on.channel.id, 50);
  assert.deepEqual(history.map((row) => row.id), [request.id]);

  // Agents see every task hanging under the request.
  const sourceTasks = await loadAgentSourceTasksByMessageId([request.id]);
  assert.deepEqual(sourceTasks.get(request.id)?.map((t) => [t.number, t.status]), [[1, "todo"], [2, "todo"]]);

  const other = await taskService.createTasks(off.channel.id, "user", off.owner.id, [{ title: "pre-v2" }]);
  assert.equal(other.hostMessagesVisible, true);
  assert.equal(other.hostMessages[0]!.messageType, "chat");
  assert.equal(other.tasks[0]!.conversationChannelId, null);
});

test("flag on: assigned creation — nothing is posted in the channel; the first ensure makes the creator (authored) and the assignee (assigned) follow", async ({ app }) => {
  const { owner, member, server, channel } = await seedChannel("on-assigned");
  await enableTaskV2ConversationsForServer(server.id);
  const result = await taskService.createTasksWithAssignmentReceipt(
    channel.id,
    "user",
    owner.id,
    [{ title: "assigned v2" }],
    { type: "user", id: member.id },
    { assigneeName: member.name },
  );
  assert.equal(result.hostMessagesVisible, false);
  assert.equal(result.assignmentReceipt, null);
  assert.deepEqual(result.hostMessages, []);
  assert.equal(result.tasks[0]!.conversationChannelId, null, "creation creates no conversation");
  assert.deepEqual(await taskConversationsOf(result.tasks[0]!.id), []);
  const ensured = await ensureTaskConversation(result.tasks[0]!.id, { initiatingServerId: server.id });
  assert.equal(ensured?.created, true);
  const conversationId = ensured!.conversation.canonicalChannelId;
  const follows = await getDb().select().from(threadFollows).where(eq(threadFollows.threadChannelId, conversationId));
  assert.deepEqual(
    follows.map((row) => [row.followerId, row.reason]).sort(),
    [[owner.id, "authored"], [member.id, "assigned"]].sort(),
  );
  assert.deepEqual(await messageService.listMessages(channel.id, 50), []);
});

/** A pre-v2 task: created while the server's flag was off (visible host message). */
async function seedPreV2Task(label: string) {
  const seeded = await seedChannel(label);
  const { tasks: [task], hostMessages: [host] } = await taskService.createTasks(
    seeded.channel.id, "user", seeded.owner.id, [{ title: `${label} old task` }],
  );
  return { ...seeded, task: task!, host: host! };
}

async function taskConversationsOf(taskId: string) {
  return getDb().select().from(channels).where(and(eq(channels.taskId, taskId), eq(channels.type, "task")));
}

test("ensureTaskConversation, flag off: a no-op; the discussion stays the host message's thread", async ({ app }) => {
  const { task, host } = await seedPreV2Task("ensure-off");
  assert.equal(await ensureTaskConversation(task.id), null);
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
  assert.equal(row!.messageId, host.id);
  assert.equal(row!.conversationChannelId, null);
  assert.deepEqual(await taskConversationsOf(task.id), []);
});

test("ensureTaskConversation, flag on: a pre-v2 task gets its own conversation once; the host stays", async ({ app }) => {
  const { server, channel, task, host } = await seedPreV2Task("ensure-on");
  const [before] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
  await enableTaskV2ConversationsForServer(server.id);

  const first = await ensureTaskConversation(task.id);
  assert.equal(first?.created, true);
  const [moved] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
  assert.equal(moved!.conversationChannelId, first!.conversation.canonicalChannelId);
  assert.equal(moved!.messageId, host.id, "the old host message (earlier discussion) is kept");
  assert.equal(moved!.sourceMessageId, host.id, "the task still hangs under its old host message");
  assert.equal(moved!.revision, before!.revision, "creating the conversation is not a task change");
  const [listed] = (await taskService.listTasks(channel.id)).filter((row) => row.id === task.id);
  assert.equal(listed!.conversationAnchored, true);
  assert.equal(listed!.conversationChannelId, first!.conversation.canonicalChannelId);
  assert.deepEqual((await messageService.listMessages(channel.id, 50)).map((row) => row.id), [host.id], "no message is written");

  const again = await ensureTaskConversation(task.id);
  assert.deepEqual([again?.created, again?.conversation.canonicalChannelId], [false, first!.conversation.canonicalChannelId], "idempotent");
  assert.equal((await taskConversationsOf(task.id)).length, 1);
});

test("ensureTaskConversation, flag on: concurrent callers converge on one conversation", async ({ app }) => {
  const { server, task } = await seedPreV2Task("ensure-race");
  await enableTaskV2ConversationsForServer(server.id);
  const results = await Promise.all(Array.from({ length: 6 }, () => ensureTaskConversation(task.id)));
  assert.equal(new Set(results.map((r) => r?.conversation.canonicalChannelId)).size, 1, "every caller sees the same conversation");
  assert.equal(results.filter((r) => r?.created).length, 1, "exactly one caller created it");
  assert.equal((await taskConversationsOf(task.id)).length, 1);
});

test("ensureTaskConversation: a task created with the flag on gets its conversation on first use, once", async ({ app }) => {
  const { owner, server, channel } = await seedChannel("ensure-v2");
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "born v2" }]);
  assert.equal(task!.conversationChannelId, null);
  const first = await ensureTaskConversation(task!.id);
  assert.equal(first?.created, true);
  const again = await ensureTaskConversation(task!.id);
  assert.deepEqual([again?.created, again?.conversation.canonicalChannelId], [false, first!.conversation.canonicalChannelId]);
});

// ── Lazy task conversations (decided 2026-10-21) ────────────────────────────

async function followsOf(conversationId: string) {
  return getDb().select().from(threadFollows).where(eq(threadFollows.threadChannelId, conversationId));
}

test("lazy: flag on, createTasks creates only the task — no conversation, yet it owns one and is not an orphan", async ({ app }) => {
  const { owner, server, channel } = await seedChannel("lazy-create");
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "lazy task" }]);
  assert.equal(task!.conversationChannelId, null);
  assert.equal(task!.conversationAnchored, true, "its discussion is its own conversation");
  assert.equal(task!.isLegacy, false, "never mistaken for a pre-thread orphan");
  assert.deepEqual(await taskConversationsOf(task!.id), [], "no task conversation channel");
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, task!.id));
  assert.equal(row!.ownConversation, true);
  assert.equal(row!.conversationChannelId, null);
  assert.equal(row!.messageId, null);
  const found = await taskService.getTaskByNumber(channel.id, task!.taskNumber);
  assert.equal(found?.id, task!.id, "lookups by number still find it");
  const [listed] = (await taskService.listTasks(channel.id)).filter((t) => t.id === task!.id);
  assert.ok(listed, "listed on the board");
  assert.equal(listed!.conversationAnchored, true);
  assert.equal(listed!.isLegacy, false);
});

test("lazy: flag off, a pre-v2 task does not own a conversation", async ({ app }) => {
  const { task } = await seedPreV2Task("lazy-off-owner");
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
  assert.equal(row!.ownConversation, false);
});

test("lazy: the first ensureTaskConversation creates it and the creator follows (authored)", async ({ app }) => {
  const { owner, server, channel } = await seedChannel("lazy-first");
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "first use" }]);
  const ensured = await ensureTaskConversation(task!.id, { initiatingServerId: server.id });
  assert.equal(ensured?.created, true);
  const conversationId = ensured!.conversation.canonicalChannelId;
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, task!.id));
  assert.equal(row!.conversationChannelId, conversationId);
  assert.deepEqual(
    (await followsOf(conversationId)).map((f) => [f.followerType, f.followerId, f.reason, f.parentTaskId, f.unfollowedAt]),
    [["user", owner.id, "authored", task!.id, null]],
  );
  assert.deepEqual(await messageService.listMessages(channel.id, 50), [], "creating the conversation posts nothing in the channel");
});

test("lazy: assigned to someone else → creator authored + assignee assigned; self-assigned → only the creator (authored)", async ({ app }) => {
  const { owner, member, server, channel } = await seedChannel("lazy-assigned");
  await enableTaskV2ConversationsForServer(server.id);

  const other = await taskService.createTasksWithAssignmentReceipt(
    channel.id, "user", owner.id, [{ title: "for the member" }],
    { type: "user", id: member.id }, { assigneeName: member.name },
  );
  assert.equal(other.tasks[0]!.conversationChannelId, null);
  const forOther = await ensureTaskConversation(other.tasks[0]!.id, { initiatingServerId: server.id });
  assert.deepEqual(
    (await followsOf(forOther!.conversation.canonicalChannelId)).map((f) => [f.followerId, f.reason]).sort(),
    [[owner.id, "authored"], [member.id, "assigned"]].sort(),
  );

  const self = await taskService.createTasksWithAssignmentReceipt(
    channel.id, "user", owner.id, [{ title: "mine" }],
    { type: "user", id: owner.id }, { assigneeName: owner.name },
  );
  const forSelf = await ensureTaskConversation(self.tasks[0]!.id, { initiatingServerId: server.id });
  assert.deepEqual(
    (await followsOf(forSelf!.conversation.canonicalChannelId)).map((f) => [f.followerId, f.reason]),
    [[owner.id, "authored"]],
    "the creator who took it stays authored, once",
  );
});

test("lazy: a pre-v2 task claimed by someone, conversation created after the flag goes on → creator authored + claimer assigned", async ({ app }) => {
  const { member, server, task } = await seedPreV2Task("lazy-prev2-claimed");
  const claimed = await taskService.claimTask(task.id, "user", member.id);
  assert.notEqual(typeof claimed, "string", String(claimed));
  await enableTaskV2ConversationsForServer(server.id);

  const ensured = await ensureTaskConversation(task.id, { initiatingServerId: server.id });
  assert.equal(ensured?.created, true);
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
  assert.deepEqual(
    (await followsOf(ensured!.conversation.canonicalChannelId)).map((f) => [f.followerId, f.reason]).sort(),
    [[row!.createdById, "authored"], [member.id, "assigned"]].sort(),
    "pre-v2 tasks get the same automatic followers",
  );
});

// ── in_review retired for task v2 tasks (#wg-task-v2:f7043517) ──

function stored(result: taskService.TaskMutationResult, label: string) {
  assert.notEqual(typeof result, "string", `${label}: ${String(result)}`);
  return result as Exclude<taskService.TaskMutationResult, string>;
}

async function statusEventsOf(taskId: string) {
  return (await getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)))
    .filter((event) => event.eventType === "status_changed" || event.eventType === "reopened" || event.eventType === "closed")
    .sort((a, b) => a.seq - b.seq);
}

test("in_review retired: a task v2 task asked for in_review stores in_progress, assignee unchanged, and the event records in_progress", async ({ app }) => {
  const { owner, member, server, channel } = await seedChannel("retire-v2");
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasksWithAssignmentReceipt(
    channel.id, "user", owner.id, [{ title: "v2 work" }],
    { type: "user", id: member.id }, { assigneeName: member.name },
  );
  const before = (await getDb().select().from(tasks).where(eq(tasks.id, task!.id)))[0]!;
  assert.equal(before.ownConversation, true, "created the v2 way");
  assert.equal(before.status, "todo");

  const moved = stored(await taskService.updateTaskStatus(task!.id, "in_review", member.id, "user", server.id), "todo → in_review");
  assert.equal(moved.row.status, "in_progress", "in_review is not used for task v2 tasks");
  assert.equal(moved.unchanged, undefined, "it was written");
  assert.equal(moved.row.claimedById, member.id, "assignee unchanged");
  assert.equal(moved.row.revision, before.revision + 1);
  assert.ok(moved.row.claimedAt, "starting the work stamps its epoch, as in_progress does");
  assert.deepEqual((await statusEventsOf(task!.id)).map((e) => [e.eventType, e.actorType, e.actorId, e.payload]), [
    ["status_changed", "user", member.id, { from: "todo", to: "in_progress", forced: false, reason: "in_review_retired_for_task_v2" }],
  ]);

  // Already in_progress: what in_review asks for already holds. A success that
  // writes nothing, not the "already in_progress" refusal.
  const again = stored(await taskService.updateTaskStatus(task!.id, "in_review", member.id, "user", server.id), "in_progress → in_review");
  assert.equal(again.unchanged, true);
  assert.equal(again.row.status, "in_progress");
  assert.equal(again.row.revision, moved.row.revision, "nothing written");
  assert.equal((await statusEventsOf(task!.id)).length, 1, "no event");
  // Asking for in_progress itself is still the same-status refusal.
  assert.equal(await taskService.updateTaskStatus(task!.id, "in_progress", member.id, "user", server.id), "already in_progress");

  // From done, and on the admin force path, the same.
  stored(await taskService.updateTaskStatus(task!.id, "done", member.id, "user", server.id), "→ done");
  const reopened = stored(await taskService.forceUpdateTaskStatus(task!.id, "in_review", "user", owner.id, server.id), "forced done → in_review");
  assert.equal(reopened.row.status, "in_progress");
  assert.equal(reopened.row.completedAt, null);
  assert.deepEqual((await statusEventsOf(task!.id)).at(-1)!.payload, { from: "done", to: "in_progress", forced: true, reason: "in_review_retired_for_task_v2" });
});

test("in_review retired: per task, a task created the v2 way keeps it retired on a server without the flag (rollback)", async ({ app }) => {
  const { owner, server, channel } = await seedChannel("retire-rollback");
  assert.equal(await isTaskV2ConversationsEnabled(server.id), false);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "made the v2 way" }]);
  // The shape a task created the v2 way keeps after the flag is rolled back.
  await getDb().update(tasks).set({ ownConversation: true }).where(eq(tasks.id, task!.id));

  const moved = stored(await taskService.updateTaskStatus(task!.id, "in_review", owner.id, "user", server.id), "→ in_review");
  assert.equal(moved.row.status, "in_progress");
});

test("in_review retired: a pre-v2 task on a flag-on server counts as task v2 (its conversation comes with the write)", async ({ app }) => {
  const { owner, server, task } = await seedPreV2Task("retire-prev2-on");
  await enableTaskV2ConversationsForServer(server.id);
  const moved = stored(await taskService.updateTaskStatus(task.id, "in_review", owner.id, "user", server.id), "→ in_review");
  assert.equal(moved.row.status, "in_progress");
});

test("in_review retired only for task v2: a pre-v2 task on a server without the flag still stores in_review", async ({ app }) => {
  const { owner, member, server, task } = await seedPreV2Task("retire-prev2-off");
  const claimed = await taskService.claimTask(task.id, "user", member.id);
  assert.notEqual(typeof claimed, "string", String(claimed));

  const review = stored(await taskService.updateTaskStatus(task.id, "in_review", member.id, "user", server.id), "→ in_review");
  assert.equal(review.row.status, "in_review", "exactly as before task v2");
  assert.equal(review.row.claimedById, member.id);
  assert.deepEqual((await statusEventsOf(task.id)).at(-1)!.payload, { from: "in_progress", to: "in_review", forced: false });
  // The same-status refusal is unchanged for it.
  assert.equal(await taskService.updateTaskStatus(task.id, "in_review", owner.id, "user", server.id), "already in_review");
});

test("an unassigned todo moved to in_progress can still be claimed, and stays without a start epoch until then", async ({ app }) => {
  const { owner, member, server, channel } = await seedChannel("claim-unassigned-started");
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "nobody holds it" }]);

  const moved = stored(await taskService.updateTaskStatus(task!.id, "in_progress", owner.id, "user", server.id), "→ in_progress");
  assert.equal(moved.row.status, "in_progress");
  assert.equal(moved.row.claimedById, null);
  assert.equal(moved.row.claimedAt, null, "no holder, so no ownership epoch");

  const claimed = await taskService.claimTask(task!.id, "user", member.id);
  assert.notEqual(typeof claimed, "string", String(claimed));
  const after = (await getDb().select().from(tasks).where(eq(tasks.id, task!.id)))[0]!;
  assert.equal(after.claimedById, member.id);
  assert.equal(after.status, "in_progress");
  assert.ok(after.claimedAt, "the claim stamps it");
});

test("a row left with a start epoch and no holder by the older write can still be claimed", async ({ app }) => {
  const { owner, member, server, channel } = await seedChannel("claim-unassigned-stale-epoch");
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "stamped earlier" }]);
  const stamped = new Date(Date.now() - 60_000);
  await getDb().update(tasks).set({ status: "in_progress", claimedAt: stamped }).where(eq(tasks.id, task!.id));

  const claimed = await taskService.claimTask(task!.id, "user", member.id);
  assert.notEqual(typeof claimed, "string", String(claimed));
  const after = (await getDb().select().from(tasks).where(eq(tasks.id, task!.id)))[0]!;
  assert.equal(after.claimedById, member.id);
  assert.ok(after.claimedAt! > stamped, "the epoch advances");
});

test("a todo left with a start epoch and no holder by the older write can still move to in_progress", async ({ app }) => {
  const { owner, server, channel } = await seedChannel("start-guard-no-holder");
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "stamped todo" }]);
  await getDb().update(tasks).set({ claimedAt: new Date(Date.now() - 60_000) }).where(eq(tasks.id, task!.id));

  const moved = stored(await taskService.updateTaskStatus(task!.id, "in_progress", owner.id, "user", server.id), "→ in_progress");
  assert.equal(moved.row.status, "in_progress");
  assert.equal(moved.row.claimedById, null);
});

// ── Backlog is task v2 only ──

test("backlog: per task, a task created the v2 way can be parked on a server without the flag (rollback)", async ({ app }) => {
  const { owner, server, channel } = await seedChannel("backlog-rollback");
  assert.equal(await isTaskV2ConversationsEnabled(server.id), false);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "made the v2 way" }]);
  // The shape a task created the v2 way keeps after the flag is rolled back.
  await getDb().update(tasks).set({ ownConversation: true }).where(eq(tasks.id, task!.id));
  const moved = stored(await taskService.updateTaskStatus(task!.id, "backlog", owner.id, "user", server.id, { backlogReason: "after the launch" }), "→ backlog");
  assert.equal(moved.row.status, "backlog");
  assert.deepEqual((await statusEventsOf(task!.id)).at(-1)!.payload, { from: "todo", to: "backlog", forced: false, reason: "after the launch" });
});

test("backlog: a pre-v2 task on a flag-on server counts as task v2", async ({ app }) => {
  const { owner, server, task } = await seedPreV2Task("backlog-prev2-on");
  await enableTaskV2ConversationsForServer(server.id);
  const moved = stored(await taskService.updateTaskStatus(task.id, "backlog", owner.id, "user", server.id), "→ backlog");
  assert.equal(moved.row.status, "backlog");
});

test("backlog: a pre-v2 task on a server without the flag is refused on every writer, the force path included", async ({ app }) => {
  const { owner, server, task } = await seedPreV2Task("backlog-prev2-off");
  await assert.rejects(() => taskService.updateTaskStatus(task.id, "backlog", owner.id, "user", server.id), taskService.TaskStatusNotAvailableError);
  await assert.rejects(() => taskService.forceUpdateTaskStatus(task.id, "backlog", "user", owner.id, server.id), taskService.TaskStatusNotAvailableError);
  assert.deepEqual(await statusEventsOf(task.id), []);
});

test("backlog: a create is task v2 by the flag read in its own transaction, on both create paths", async ({ app }) => {
  const { owner, member, server, channel } = await seedChannel("backlog-create");
  await assert.rejects(
    () => taskService.createTasks(channel.id, "user", owner.id, [{ title: "off" }], { initialStatus: "backlog" }),
    taskService.TaskCreateStatusError,
  );
  await assert.rejects(
    () => taskService.createTasksWithAssignmentReceipt(channel.id, "user", owner.id, [{ title: "off" }], { type: "user", id: owner.id }, { assigneeName: owner.name }, { initialStatus: "backlog" }),
    taskService.TaskCreateStatusError,
  );
  assert.deepEqual(await getDb().select().from(tasks).where(eq(tasks.channelId, channel.id)), []);

  await enableTaskV2ConversationsForServer(server.id);
  await addHuman(channel.id, member.id);
  const { tasks: [open] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "on" }], { initialStatus: "backlog" });
  assert.equal(open!.status, "backlog");
  const { tasks: [assigned] } = await taskService.createTasksWithAssignmentReceipt(
    channel.id, "user", owner.id, [{ title: "on, assigned" }],
    { type: "user", id: member.id }, { assigneeName: member.name }, { initialStatus: "backlog" },
  );
  assert.equal(assigned!.status, "backlog");
  assert.equal(assigned!.claimedAt, null, "reserved, not started");
});

test("backlog: moving in clears the start epoch and keeps the assignee; claiming moves it as claiming a todo does", async ({ app }) => {
  const { owner, member, server, channel } = await seedChannel("backlog-claim");
  await enableTaskV2ConversationsForServer(server.id);
  await addHuman(channel.id, member.id);

  // Unassigned backlog: anyone claims it, and it starts.
  const { tasks: [open] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "open" }], { initialStatus: "backlog" });
  const claimedOpen = stored(await taskService.claimTask(open!.id, "user", member.id), "claim open");
  assert.equal(claimedOpen.row.status, "in_progress");
  assert.equal(claimedOpen.row.claimedById, member.id);
  assert.ok(claimedOpen.row.claimedAt instanceof Date);
  assert.deepEqual((await statusEventsOf(open!.id)).at(-1)!.payload, { from: "backlog", to: "in_progress" });

  // In progress, parked: the assignment stays, its start goes.
  const parked = stored(await taskService.updateTaskStatus(open!.id, "backlog", member.id, "user", server.id), "→ backlog");
  assert.equal(parked.row.status, "backlog");
  assert.equal(parked.row.claimedById, member.id);
  assert.equal(parked.row.claimedAt, null);

  // Someone else is refused; its assignee claims it, as with a reserved todo.
  assert.match(String(await taskService.claimTask(open!.id, "user", owner.id)), /already assigned/);
  const resumed = stored(await taskService.claimTask(open!.id, "user", member.id), "claim parked");
  assert.equal(resumed.row.status, "in_progress");
  assert.ok(resumed.row.claimedAt instanceof Date);
  assert.match(String(await taskService.claimTask(open!.id, "user", member.id)), /already claimed by you/);

  // The status route starts it too, stamping the epoch as from todo.
  stored(await taskService.updateTaskStatus(open!.id, "backlog", member.id, "user", server.id), "→ backlog again");
  const started = stored(await taskService.updateTaskStatus(open!.id, "in_progress", member.id, "user", server.id), "→ in_progress");
  assert.ok(started.row.claimedAt instanceof Date);

  // From closed or done it clears what those set.
  stored(await taskService.updateTaskStatus(open!.id, "closed", member.id, "user", server.id), "→ closed");
  const fromClosed = stored(await taskService.updateTaskStatus(open!.id, "backlog", member.id, "user", server.id, { backlogReason: "maybe next year" }), "closed → backlog");
  assert.equal(fromClosed.row.closedAt, null);
  assert.deepEqual((await statusEventsOf(open!.id)).at(-1)!.payload, { from: "closed", to: "backlog", forced: false, reason: "maybe next year" });
  assert.equal((await statusEventsOf(open!.id)).at(-1)!.eventType, "reopened", "leaving closed is a reopen, whatever the target");
});
