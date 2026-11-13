import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * tasks.last_activity_at, the Tasks page's activity time: stamped when a task
 * is created and when its status, assignee, title or description changes (in
 * the same statement as the change), and when a chat message is posted in its
 * own conversation (at most once per TASK_ACTIVITY_MESSAGE_THROTTLE).
 * Bookkeeping writes (the conversation link) leave it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { getDb } from "../db/index";
import { serverMembers, tasks, users } from "../db/schema";
import { mintAgentCredential } from "./agentCredentialService";
import { createAgent } from "./agentService";
import { addAgent, addHuman, createChannel } from "./channelService";
import { createMessage } from "./messageService";
import { createServer } from "./serverService";
import { ensureTaskConversation } from "./taskConversationService";
import * as taskService from "./taskService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/** Long before any write a test makes: a stamp moves it to "now". */
const AGED = new Date("2020-01-01T00:00:00.000Z");

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function setup(slug: string) {
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const server = await createServer(`Activity ${slug}`, `${slug}-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" }).onConflictDoNothing();
  const channel = await createChannel(server.id, `${slug}-room`);
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  return { owner, member, server, channel };
}

async function lastActivityAt(taskId: string): Promise<Date | null> {
  const [row] = await getDb().select({ lastActivityAt: tasks.lastActivityAt }).from(tasks).where(eq(tasks.id, taskId));
  return row!.lastActivityAt;
}

async function age(taskId: string) {
  await getDb().update(tasks).set({ lastActivityAt: AGED }).where(eq(tasks.id, taskId));
}

async function assertStamped(taskId: string, label: string) {
  const at = await lastActivityAt(taskId);
  assert.ok(at, `${label}: last_activity_at is set`);
  assert.ok(at.getTime() > AGED.getTime(), `${label}: last_activity_at moved (${at.toISOString()})`);
  assert.ok(Math.abs(Date.now() - at.getTime()) < 5 * 60_000, `${label}: stamped with the database's now()`);
}

/** Age the task, run `write`, and require that it stamped last_activity_at. */
async function expectStamp(taskId: string, label: string, write: () => Promise<unknown>) {
  await age(taskId);
  const result = await write();
  assert.notEqual(typeof result, "string", `${label}: ${String(result)}`);
  await assertStamped(taskId, label);
}

test("creating a task stamps last_activity_at: createTasks, with an assignee, and convert", async ({ app: _app }) => {
  const { owner, member, channel } = await setup("act-create");
  const { tasks: [created] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "plain" }]);
  assert.ok(created!.lastActivityAt, "returned row carries it");
  await assertStamped(created!.id, "createTasks");

  const { tasks: [assigned] } = await taskService.createTasksWithAssignmentReceipt(
    channel.id, "user", owner.id, [{ title: "assigned" }],
    { type: "user", id: member.id }, { assigneeName: member.name },
  );
  await assertStamped(assigned!.id, "createTasksWithAssignmentReceipt");

  const message = await createMessage(channel.id, "user", owner.id, "turn me into a task");
  const converted = await taskService.convertMessageToTask(message.id, "user", owner.id);
  assert.notEqual(typeof converted, "string", String(converted));
  if (typeof converted === "string") return;
  await assertStamped(converted.id, "convertMessageToTask");
});

test("status, assignee, title and description changes stamp last_activity_at", async ({ app: _app }) => {
  const { owner, member, channel } = await setup("act-mutate");
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "mutable", description: "first" }]);
  const id = task!.id;

  await expectStamp(id, "claim", () => taskService.claimTask(id, "user", owner.id));
  await expectStamp(id, "unclaim", () => taskService.unclaimTask(id, "user", owner.id));
  await expectStamp(id, "assign", () => taskService.assignTask(id, { type: "user", id: member.id }, "user", owner.id));
  await expectStamp(id, "unassign", () => taskService.assignTask(id, null, "user", owner.id));
  await expectStamp(id, "status", () => taskService.updateTaskStatus(id, "done", owner.id, "user"));
  await expectStamp(id, "reopen", () => taskService.updateTaskStatus(id, "todo", owner.id, "user"));
  await expectStamp(id, "title", () => taskService.amendTask(id, { title: "renamed" }, "user", owner.id));
  await expectStamp(id, "description", () => taskService.amendTask(id, { description: "second" }, "user", owner.id));

  // A refused write stamps nothing.
  await age(id);
  assert.equal(typeof await taskService.amendTask(id, { title: "renamed" }, "user", owner.id), "string", "no change is refused");
  assert.deepEqual(await lastActivityAt(id), AGED);
});

test("touchTaskConversationActivity stamps a stale or missing value and skips one younger than the throttle", async ({ app: _app }) => {
  const { owner, channel } = await setup("act-touch");
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "chatty" }]);
  const id = task!.id;

  await getDb().update(tasks).set({ lastActivityAt: null }).where(eq(tasks.id, id));
  assert.equal(await taskService.touchTaskConversationActivity(id), true);
  await assertStamped(id, "a row without a stamp");

  await age(id);
  assert.equal(await taskService.touchTaskConversationActivity(id), true);
  await assertStamped(id, "a stale stamp");

  // Younger than the throttle: left as it is.
  const recent = new Date(Date.now() - 10_000);
  await getDb().update(tasks).set({ lastActivityAt: sql`now() - interval '10 seconds'` }).where(eq(tasks.id, id));
  const before = await lastActivityAt(id);
  assert.equal(await taskService.touchTaskConversationActivity(id), false);
  assert.deepEqual(await lastActivityAt(id), before, `stamp from ~${recent.toISOString()} kept`);
  // An unknown task: nothing to stamp, no error.
  assert.equal(await taskService.touchTaskConversationActivity(randomUUID()), false);
});

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("a chat message in the task's own conversation stamps last_activity_at; creating the conversation does not", async ({ app }) => {
  const { owner, server, channel } = await setup("act-conversation");
  await enableTaskV2ConversationsForServer(server.id);
  const agent = await createAgent(server.id, `act-bot-${randomUUID().slice(0, 4)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  app.app.set("agentOrchestrator", {
    deliverMessage: async () => ({ status: "queued" as const }),
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<unknown>) => batch.map(async () => ({ status: "queued" as const })),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  });
  const { apiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read", "tasks", "channels"],
    name: `act-${randomUUID().slice(0, 6)}`,
    issuedVia: "computer", createdByUserId: null,
  });
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "discussed" }]);
  const id = task!.id;

  // Bookkeeping: linking the conversation is not activity.
  await age(id);
  const ensured = await ensureTaskConversation(id);
  assert.ok(ensured, "the conversation exists");
  assert.deepEqual(await lastActivityAt(id), AGED, "creating the conversation leaves the stamp");

  const reply = async (content: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/tasks/reply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: `#${channel.name}`, task_number: task!.taskNumber, content }),
    });
    const body = await res.json() as { state?: string };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.state, "sent", JSON.stringify(body));
  };

  await reply("first word");
  const stamped = await waitFor("the message's stamp", async () => {
    const at = await lastActivityAt(id);
    return at && at.getTime() > AGED.getTime() ? at : null;
  });
  // Within the throttle a second message writes nothing more. The send does
  // not wait for its stamp: give the background statement time to run.
  await reply("second word");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(await lastActivityAt(id), stamped, "throttled");
  // Past it (aged), the next message stamps again.
  await age(id);
  await reply("third word");
  await waitFor("the next stamp", async () => {
    const at = await lastActivityAt(id);
    return at && at.getTime() > AGED.getTime() ? at : null;
  });
});
