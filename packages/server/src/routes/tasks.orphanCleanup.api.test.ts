import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { users, agents, channelAgents, serverMembers, tasks, taskEvents } from "../db/schema.js";
import { createChannel, addHuman, deleteChannel } from "../services/channelService.js";
import { createServer } from "../services/serverService.js";
import * as taskService from "../services/taskService.js";
import { deleteAgent } from "../services/agentService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// Force is an admin override; the actor is now required so the audit trail can
// name who overrode the state machine. These call sites are arrangement, not
// the property under test.
const ADMIN_FORCE_ACTOR_ID = "00000000-0000-0000-0000-0000000000ad";

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function seedAgent(serverId: string, name: string) {
  const db = getDb();
  const [agent] = await db.insert(agents).values({
    serverId,
    name,
    displayName: name,
    status: "active",
    runtime: "claude_code",
    model: "sonnet",
    reasoningEffort: "medium",
    executionMode: "cloud",
    creatorType: "user",
    creatorId: "00000000-0000-0000-0000-000000000000",
  }).returning();
  return agent;
}



function authHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

test("channel soft-delete auto-closes open tasks", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("channel-orphan-owner@slock.test", "channel-orphan-owner");
  const server = await createServer("Channel Orphan Test", "channel-orphan-test", owner.id);
  const channel = await createChannel(server.id, "doomed-channel");
  await addHuman(channel.id, owner.id);

  const { tasks: [todoTask] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "todo task" }]);
  const { tasks: [inProgressTask] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "in progress task" }]);
  const { tasks: [inReviewTask] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "in review task" }]);
  const { tasks: [doneTask] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "done task" }]);

  await taskService.forceUpdateTaskStatus(inProgressTask.id, "in_progress", "user", ADMIN_FORCE_ACTOR_ID);
  await taskService.forceUpdateTaskStatus(inReviewTask.id, "in_review", "user", ADMIN_FORCE_ACTOR_ID);
  await taskService.forceUpdateTaskStatus(doneTask.id, "done", "user", ADMIN_FORCE_ACTOR_ID);

  await deleteChannel(channel.id);

  const [todoRow] = await db.select().from(tasks).where(eq(tasks.id, todoTask.id));
  assert.equal(todoRow.status, "closed", "todo task should be auto-closed");
  assert.notEqual(todoRow.completedAt, null, "completedAt should be set");
  assert.notEqual(todoRow.closedAt, null, "closedAt should be set");

  const [inProgressRow] = await db.select().from(tasks).where(eq(tasks.id, inProgressTask.id));
  assert.equal(inProgressRow.status, "closed", "in_progress task should be auto-closed");

  const [inReviewRow] = await db.select().from(tasks).where(eq(tasks.id, inReviewTask.id));
  assert.equal(inReviewRow.status, "closed", "in_review task should be auto-closed");

  const [doneRow] = await db.select().from(tasks).where(eq(tasks.id, doneTask.id));
  assert.equal(doneRow.status, "done", "done task should remain done");

  // The auto-close is auditable, not silent.
  const closedEvents = await db.select().from(taskEvents).where(eq(taskEvents.taskId, todoTask.id));
  assert.ok(
    closedEvents.some((event) => event.eventType === "closed" && event.actorType === "system"),
    "channel-delete auto-close should append a system `closed` event",
  );
});

test("agent soft-delete releases task claims", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("agent-orphan-owner@slock.test", "agent-orphan-owner");
  const server = await createServer("Agent Orphan Test", "agent-orphan-test", owner.id);
  const channel = await createChannel(server.id, "agent-task-channel");
  await addHuman(channel.id, owner.id);
  const agent = await seedAgent(server.id, "atlas-test");
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id }).onConflictDoNothing();

  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "agent claimed task" }]);
  await taskService.claimTask(task.id, "agent", agent.id);

  const [beforeRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  assert.equal(beforeRow.claimedById, agent.id);
  assert.equal(beforeRow.claimedByType, "agent");

  await deleteAgent(agent.id);

  const [afterRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  assert.equal(afterRow.claimedById, null, "claim should be released");
  assert.equal(afterRow.claimedByType, null, "assignee type should be null");
  assert.equal(afterRow.claimedAt, null, "claimedAt should be null");
  assert.equal(afterRow.status, "in_progress", "status should be preserved (claim moves todo to in_progress)");
});

test("pre-existing orphan task can be closed by admin via PATCH status", async ({ app }) => {
  const db = getDb();
  const admin = await seedUser("orphan-admin@slock.test", "orphan-admin");
  const server = await createServer("Orphan Close Test", "orphan-close-test", admin.id);
  const channel = await createChannel(server.id, "will-delete");
  await addHuman(channel.id, admin.id);

  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", admin.id, [{ title: "orphan to close" }]);
  await taskService.forceUpdateTaskStatus(task.id, "in_review", "user", ADMIN_FORCE_ACTOR_ID);

  await deleteChannel(channel.id);

  // Force task back to open state to simulate a pre-fix orphan
  await db.update(tasks)
    .set({ status: "in_review", completedAt: null, closedAt: null })
    .where(eq(tasks.id, task.id));

  const token = await tokenForHuman(admin.email);
  const headers = authHeaders(token, server.id);

  const closeRes = await fetch(`${app.baseUrl}/api/tasks/${task.id}/status`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "done" }),
  });
  assert.equal(closeRes.status, 200, `expected 200, got ${closeRes.status}`);

  const [closedRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  assert.equal(closedRow.status, "done");
});

test("orphan task rejects non-terminal status transitions", async ({ app }) => {
  const db = getDb();
  const admin = await seedUser("orphan-reject-admin@slock.test", "orphan-reject-admin");
  const server = await createServer("Orphan Reject Test", "orphan-reject-test", admin.id);
  const channel = await createChannel(server.id, "will-delete-reject");
  await addHuman(channel.id, admin.id);

  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", admin.id, [{ title: "orphan no reopen" }]);

  await deleteChannel(channel.id);
  // Force task back to open state to simulate a pre-fix orphan
  await db.update(tasks)
    .set({ status: "in_review", completedAt: null, closedAt: null })
    .where(eq(tasks.id, task.id));

  const token = await tokenForHuman(admin.email);
  const headers = authHeaders(token, server.id);

  // Trying to move to in_progress should be rejected (non-terminal)
  const rejectRes = await fetch(`${app.baseUrl}/api/tasks/${task.id}/status`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "in_progress" }),
  });
  assert.equal(rejectRes.status, 409, `expected 409, got ${rejectRes.status}`);
  const body = await rejectRes.json() as { code?: string };
  assert.equal(body.code, "channel_deleted_terminal_only");

  // Claim should also be rejected
  const claimRes = await fetch(`${app.baseUrl}/api/tasks/${task.id}/claim`, {
    method: "PATCH",
    headers,
  });
  assert.equal(claimRes.status, 409, `expected claim 409, got ${claimRes.status}`);
});

test("orphan task can be DELETEd by admin", async ({ app }) => {
  const db = getDb();
  const admin = await seedUser("orphan-delete-admin@slock.test", "orphan-delete-admin");
  const server = await createServer("Orphan Delete Test", "orphan-delete-test", admin.id);
  const channel = await createChannel(server.id, "will-delete-task");
  await addHuman(channel.id, admin.id);

  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", admin.id, [{ title: "orphan to delete" }]);
  await deleteChannel(channel.id);

  const token = await tokenForHuman(admin.email);
  const headers = authHeaders(token, server.id);

  const delRes = await fetch(`${app.baseUrl}/api/tasks/${task.id}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(delRes.status, 200, `expected delete 200, got ${delRes.status}`);
});

test("orphan task DELETE rejects non-creator non-admin", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("orphan-del-owner@slock.test", "orphan-del-owner");
  const member = await seedUser("orphan-del-member@slock.test", "orphan-del-member");
  const server = await createServer("Orphan Delete Reject", "orphan-delete-reject", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "delete-reject-ch");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);

  // Owner creates the task — member is neither creator nor admin
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "owner orphan" }]);
  await deleteChannel(channel.id);

  const memberToken = await tokenForHuman(member.email);
  const headers = authHeaders(memberToken, server.id);

  const delRes = await fetch(`${app.baseUrl}/api/tasks/${task.id}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(delRes.status, 403, `expected delete 403, got ${delRes.status}`);
});
