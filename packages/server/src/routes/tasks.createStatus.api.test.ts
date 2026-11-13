import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * A task's status can be chosen when it is created (stdrc 2026-10-31
 * #wg-task-v2 bb4f4de7; raft-design #926 Create Task): `todo` or
 * `in_progress`, and on a server with task conversations `backlog`
 * (`TASK_CREATE_STATUSES`), for every task of the create, on
 * the Agent API and the web route. In Review, Done and Closed can't be chosen
 * (400 `task_create_status_not_allowed`). No status needs an assignee.
 * Omitted, creation behaves as before: self-assignment starts the work,
 * anything else is todo.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/index";
import { messages, serverMembers, taskEvents, tasks, users } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";

const test = createApiTest();

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
  assert.equal(res.status, 200);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function setup(slug: string) {
  const owner = await seedUser(`${slug}-o`);
  const member = await seedUser(`${slug}-m`);
  const server = await createServer(`Create status ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, `${slug}-${randomUUID().slice(0, 6)}`);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const agent = await createAgent(server.id, `${slug}-bot-${randomUUID().slice(0, 4)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  const { apiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read", "tasks", "channels"],
    name: `create-status-${randomUUID().slice(0, 6)}`,
    issuedVia: "computer",
    createdByUserId: null,
  });
  return { owner, member, agent, server, channel, apiKey, board: `#${channel.name}` };
}

type CreatedTask = {
  taskNumber: number;
  status: string;
  claimedByType: string | null;
  claimedById: string | null;
  claimedAt: string | null;
};

/** Task v2: a task always has a source; the creating agent's own channel message. */
async function agentSource(fx: { channel: { id: string }; agent: { id: string } }, content: string) {
  return (await createMessage(fx.channel.id, "agent", fx.agent.id, content)).id;
}

async function agentCreate(baseUrl: string, apiKey: string, body: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: await res.json() as {
      tasks: CreatedTask[];
      assignmentReceipt?: { state: string; content: string };
      code?: string;
      error?: string;
    },
  };
}

async function webCreate(baseUrl: string, token: string, serverId: string, channelId: string, body: unknown) {
  const res = await fetch(`${baseUrl}/api/tasks/channel/${channelId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as { tasks: CreatedTask[]; code?: string; error?: string } };
}

function shape(task: CreatedTask) {
  return {
    status: task.status,
    claimedById: task.claimedById,
    claimedAt: task.claimedAt === null ? null : "stamped",
  };
}

/** The `created` event of each task, in task-number order. */
async function createdEventStatuses(channelId: string, taskNumbers: number[]) {
  const db = getDb();
  const rows = await db.select({ id: tasks.id, taskNumber: tasks.taskNumber }).from(tasks)
    .where(eq(tasks.channelId, channelId))
    .orderBy(asc(tasks.taskNumber));
  const wanted = rows.filter((row) => taskNumbers.includes(row.taskNumber));
  const events = await db.select({ taskId: taskEvents.taskId, eventType: taskEvents.eventType, payload: taskEvents.payload })
    .from(taskEvents)
    .where(inArray(taskEvents.taskId, wanted.map((row) => row.id)));
  return wanted.map((row) => events.find((event) => event.taskId === row.id && event.eventType === "created")?.payload.status);
}

test("agent-api task create without status keeps today's default", async ({ app }) => {
  const { agent, member, channel, apiKey, board } = await setup("cs-default");

  const self = await agentCreate(app.baseUrl, apiKey, { channel: board, tasks: [{ title: "mine now" }], assignee: `@${agent.name}` });
  assert.equal(self.status, 200, JSON.stringify(self.body));
  assert.deepEqual(self.body.tasks.map(shape), [{ status: "in_progress", claimedById: agent.id, claimedAt: "stamped" }]);
  assert.equal(self.body.assignmentReceipt?.state, "started");

  const other = await agentCreate(app.baseUrl, apiKey, { channel: board, tasks: [{ title: "theirs" }], assignee: `@${member.name}` });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.deepEqual(other.body.tasks.map(shape), [{ status: "todo", claimedById: member.id, claimedAt: null }]);
  assert.equal(other.body.assignmentReceipt?.state, "assigned");

  const open = await agentCreate(app.baseUrl, apiKey, { channel: board, tasks: [{ title: "anyone" }] });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  assert.deepEqual(open.body.tasks.map(shape), [{ status: "todo", claimedById: null, claimedAt: null }]);

  assert.deepEqual(
    await createdEventStatuses(channel.id, [self, other, open].map((res) => res.body.tasks[0]!.taskNumber)),
    ["in_progress", "todo", "todo"],
  );
});

test("agent-api task create with status todo and yourself as assignee reserves it without starting", async ({ app }) => {
  const { agent, channel, apiKey, board } = await setup("cs-later");

  const later = await agentCreate(app.baseUrl, apiKey, {
    channel: board,
    tasks: [{ title: "later one" }, { title: "later two" }],
    assignee: `@${agent.name}`,
    status: "todo",
  });
  assert.equal(later.status, 200, JSON.stringify(later.body));
  assert.deepEqual(later.body.tasks.map(shape), [
    { status: "todo", claimedById: agent.id, claimedAt: null },
    { status: "todo", claimedById: agent.id, claimedAt: null },
  ]);
  // Not started, so the receipt does not say "started".
  assert.equal(later.body.assignmentReceipt?.state, "assigned");
  assert.deepEqual(
    await createdEventStatuses(channel.id, later.body.tasks.map((task) => task.taskNumber)),
    ["todo", "todo"],
  );
});

test("agent-api task create with status in_progress and someone else as assignee starts it for them", async ({ app }) => {
  const { member, channel, apiKey, board } = await setup("cs-start-other");

  const started = await agentCreate(app.baseUrl, apiKey, {
    channel: board,
    tasks: [{ title: "already underway" }],
    assignee: `@${member.name}`,
    status: "in_progress",
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual(started.body.tasks.map(shape), [{ status: "in_progress", claimedById: member.id, claimedAt: "stamped" }]);
  // It is still their assignment: "started" would say they started it.
  assert.equal(started.body.assignmentReceipt?.state, "assigned");
  assert.deepEqual(await createdEventStatuses(channel.id, [started.body.tasks[0]!.taskNumber]), ["in_progress"]);
});

test("agent-api task create with status in_progress and no assignee creates an unassigned in_progress task", async ({ app }) => {
  const { channel, apiKey, board } = await setup("cs-start-open");

  const open = await agentCreate(app.baseUrl, apiKey, { channel: board, tasks: [{ title: "moving, nobody on it" }], status: "in_progress" });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  assert.deepEqual(open.body.tasks.map(shape), [{ status: "in_progress", claimedById: null, claimedAt: null }]);
  assert.equal(open.body.assignmentReceipt, undefined);
  assert.deepEqual(await createdEventStatuses(channel.id, [open.body.tasks[0]!.taskNumber]), ["in_progress"]);
});

test("agent-api task create refuses a status a task can't start in, and creates nothing", async ({ app }) => {
  const { agent, channel, apiKey, board } = await setup("cs-refused");

  for (const status of ["in_review", "done", "closed"]) {
    const refused = await agentCreate(app.baseUrl, apiKey, {
      channel: board,
      tasks: [{ title: `as ${status}` }],
      assignee: `@${agent.name}`,
      status,
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "task_create_status_not_allowed");
    assert.match(refused.body.error ?? "", new RegExp(`can't be created as ${status}: choose backlog, todo or in_progress`));
  }
  assert.deepEqual(await getDb().select().from(tasks).where(eq(tasks.channelId, channel.id)), []);
});

test("agent-api task create counts status in the retry key's request", async ({ app }) => {
  const { channel, apiKey, board } = await setup("cs-idem");
  const idempotencyKey = randomUUID();

  const first = await agentCreate(app.baseUrl, apiKey, { channel: board, tasks: [{ title: "keyed" }], status: "in_progress", idempotencyKey });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const replay = await agentCreate(app.baseUrl, apiKey, { channel: board, tasks: [{ title: "keyed" }], status: "in_progress", idempotencyKey });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body.tasks.map((task) => task.taskNumber), first.body.tasks.map((task) => task.taskNumber));

  const changed = await agentCreate(app.baseUrl, apiKey, { channel: board, tasks: [{ title: "keyed" }], status: "todo", idempotencyKey });
  assert.equal(changed.status, 409, JSON.stringify(changed.body));
  assert.equal(changed.body.code, "idempotency_key_reused");
  assert.equal((await getDb().select().from(tasks).where(eq(tasks.channelId, channel.id))).length, 1);
});

for (const taskV2 of [false, true]) {
  test(`web task create takes a status for every task (task v2 ${taskV2 ? "on" : "off"})`, async ({ app }) => {
    const { owner, server, channel } = await setup(taskV2 ? "cs-web-v2" : "cs-web");
    if (taskV2) await enableTaskV2ConversationsForServer(server.id);
    const token = await login(app.baseUrl, owner.email);

    const plain = await webCreate(app.baseUrl, token, server.id, channel.id, { tasks: [{ title: "default" }] });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.deepEqual(plain.body.tasks.map(shape), [{ status: "todo", claimedById: null, claimedAt: null }]);

    const moving = await webCreate(app.baseUrl, token, server.id, channel.id, {
      tasks: [{ title: "moving one" }, { title: "moving two" }],
      status: "in_progress",
    });
    assert.equal(moving.status, 200, JSON.stringify(moving.body));
    assert.deepEqual(moving.body.tasks.map(shape), [
      { status: "in_progress", claimedById: null, claimedAt: null },
      { status: "in_progress", claimedById: null, claimedAt: null },
    ]);
    assert.deepEqual(
      await createdEventStatuses(channel.id, moving.body.tasks.map((task) => task.taskNumber)),
      ["in_progress", "in_progress"],
    );

    const explicitTodo = await webCreate(app.baseUrl, token, server.id, channel.id, { tasks: [{ title: "todo" }], status: "todo" });
    assert.equal(explicitTodo.status, 200, JSON.stringify(explicitTodo.body));
    assert.equal(explicitTodo.body.tasks[0]!.status, "todo");

    for (const status of ["done", "in_review", "closed", 7]) {
      const refused = await webCreate(app.baseUrl, token, server.id, channel.id, { tasks: [{ title: "refused" }], status });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.equal(refused.body.code, "task_create_status_not_allowed");
    }
    assert.equal(
      (await getDb().select().from(tasks).where(eq(tasks.channelId, channel.id))).length,
      4,
      "a refused status creates nothing",
    );
  });
}

// ── Backlog: task v2 only, created without a reason, moved into with an optional one ──

async function agentUpdateStatus(baseUrl: string, apiKey: string, body: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api/tasks/update-status`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as { status?: string; code?: string; error?: string } };
}

async function webUpdateStatus(baseUrl: string, token: string, serverId: string, taskId: string, body: unknown) {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/status`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as { task?: { status: string }; code?: string; error?: string } };
}

async function taskRow(channelId: string, taskNumber: number) {
  const [row] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, channelId), eq(tasks.taskNumber, taskNumber)));
  return row!;
}

/** The latest status event's payload. */
async function lastStatusPayload(taskId: string) {
  const events = await getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId));
  return events
    .filter((event) => event.eventType === "status_changed" || event.eventType === "reopened")
    .sort((a, b) => a.seq - b.seq)
    .at(-1)?.payload;
}

/** The lifecycle lines of the task's conversation (posted after the response, so waited for). */
async function waitForTaskLine(taskId: string, line: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [row] = await getDb().select({ conversationChannelId: tasks.conversationChannelId }).from(tasks).where(eq(tasks.id, taskId));
    if (row?.conversationChannelId) {
      const lines = await getDb().select({ content: messages.content }).from(messages).where(eq(messages.channelId, row.conversationChannelId));
      if (lines.some((message) => message.content === line)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`no line in the task's conversation: ${line}`);
}

test("agent-api task create in backlog: flag on it parks the task, assigned or not, with no start; flag off it is refused and creates nothing", async ({ app }) => {
  const off = await setup("cs-backlog-off");
  for (const assignee of [undefined, `@${off.agent.name}`]) {
    const refused = await agentCreate(app.baseUrl, off.apiKey, {
      channel: off.board,
      tasks: [{ title: "not now" }],
      status: "backlog",
      ...(assignee && { assignee }),
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "task_create_status_not_allowed");
    assert.match(refused.body.error ?? "", /can't be created as backlog on a server without task conversations/);
  }
  assert.deepEqual(await getDb().select().from(tasks).where(eq(tasks.channelId, off.channel.id)), []);

  const on = await setup("cs-backlog-on");
  await enableTaskV2ConversationsForServer(on.server.id);
  const open = await agentCreate(app.baseUrl, on.apiKey, { channel: on.board, tasks: [{ title: "not now", source_message_id: await agentSource(on, "not now") }], status: "backlog" });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  assert.deepEqual(open.body.tasks.map(shape), [{ status: "backlog", claimedById: null, claimedAt: null }]);
  const mine = await agentCreate(app.baseUrl, on.apiKey, { channel: on.board, tasks: [{ title: "later", source_message_id: await agentSource(on, "later") }], assignee: `@${on.agent.name}`, status: "backlog" });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual(mine.body.tasks.map(shape), [{ status: "backlog", claimedById: on.agent.id, claimedAt: null }], "parked for yourself is not started");
  assert.deepEqual(await createdEventStatuses(on.channel.id, [open.body.tasks[0]!.taskNumber]), ["backlog"]);
  assert.equal((await taskRow(on.channel.id, open.body.tasks[0]!.taskNumber)).ownConversation, true, "a task created in backlog is a task v2 task");
});

test("web task create in backlog: flag off refused like an invalid status, flag on created", async ({ app }) => {
  const off = await setup("cs-backlog-web-off");
  const offToken = await login(app.baseUrl, off.owner.email);
  const refused = await webCreate(app.baseUrl, offToken, off.server.id, off.channel.id, { tasks: [{ title: "not now" }], status: "backlog" });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "task_create_status_not_allowed");
  assert.deepEqual(await getDb().select().from(tasks).where(eq(tasks.channelId, off.channel.id)), []);

  const on = await setup("cs-backlog-web-on");
  await enableTaskV2ConversationsForServer(on.server.id);
  const onToken = await login(app.baseUrl, on.owner.email);
  const created = await webCreate(app.baseUrl, onToken, on.server.id, on.channel.id, { tasks: [{ title: "not now" }], status: "backlog" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(created.body.tasks.map((task) => task.status), ["backlog"]);
});

test("agent-api task update into backlog: the reason is on the event and in the line, exactly; without one the line has none", async ({ app }) => {
  const fx = await setup("cs-backlog-move");
  const { agent, channel, server, apiKey, board } = fx;
  await enableTaskV2ConversationsForServer(server.id);
  const source = await agentSource(fx, "with and without");
  const created = await agentCreate(app.baseUrl, apiKey, { channel: board, tasks: [{ title: "with", source_message_id: source }, { title: "without", source_message_id: source }] });
  const [withReason, withoutReason] = created.body.tasks;
  const speaker = agent.displayName || agent.name;

  const moved = await agentUpdateStatus(app.baseUrl, apiKey, { channel: board, task_number: withReason!.taskNumber, status: "backlog", reason: " waits for the\nserver-side record " });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.status, "backlog");
  const withRow = await taskRow(channel.id, withReason!.taskNumber);
  assert.deepEqual(await lastStatusPayload(withRow.id), { from: "todo", to: "backlog", forced: false, reason: "waits for the server-side record" });
  await waitForTaskLine(withRow.id, `${speaker} moved #${withReason!.taskNumber} to Backlog: waits for the server-side record`);

  const bare = await agentUpdateStatus(app.baseUrl, apiKey, { channel: board, task_number: withoutReason!.taskNumber, status: "backlog" });
  assert.equal(bare.status, 200, JSON.stringify(bare.body));
  const withoutRow = await taskRow(channel.id, withoutReason!.taskNumber);
  assert.deepEqual(await lastStatusPayload(withoutRow.id), { from: "todo", to: "backlog", forced: false });
  await waitForTaskLine(withoutRow.id, `${speaker} moved #${withoutReason!.taskNumber} to Backlog`);

  // Same status is refused as for any status, and a reason can't get around it.
  const again = await agentUpdateStatus(app.baseUrl, apiKey, { channel: board, task_number: withReason!.taskNumber, status: "backlog", reason: "still" });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "task_status_unchanged");
  assert.match(again.body.error ?? "", /^Task #\d+ is already backlog, so there is nothing to change\.$/);
});

test("agent-api and web task update refuse a reason with any other status, and change nothing", async ({ app }) => {
  const fx = await setup("cs-backlog-reason");
  const { owner, channel, server, apiKey, board } = fx;
  await enableTaskV2ConversationsForServer(server.id);
  const created = await agentCreate(app.baseUrl, apiKey, { channel: board, tasks: [{ title: "stays todo", source_message_id: await agentSource(fx, "stays todo") }] });
  const { taskNumber } = created.body.tasks[0]!;

  const agentRefused = await agentUpdateStatus(app.baseUrl, apiKey, { channel: board, task_number: taskNumber, status: "done", reason: "shipped" });
  assert.equal(agentRefused.status, 400, JSON.stringify(agentRefused.body));
  assert.equal(agentRefused.body.code, "task_status_reason_invalid");

  const row = await taskRow(channel.id, taskNumber);
  const token = await login(app.baseUrl, owner.email);
  const webRefused = await webUpdateStatus(app.baseUrl, token, server.id, row.id, { status: "closed", reason: "nope" });
  assert.equal(webRefused.status, 400, JSON.stringify(webRefused.body));
  assert.equal(webRefused.body.code, "task_status_reason_invalid");
  assert.equal((await taskRow(channel.id, taskNumber)).status, "todo");
});

test("web task update into backlog takes a reason; a move out takes none and leaves it behind", async ({ app }) => {
  const { owner, channel, server } = await setup("cs-backlog-web-move");
  await enableTaskV2ConversationsForServer(server.id);
  const token = await login(app.baseUrl, owner.email);
  const created = await webCreate(app.baseUrl, token, server.id, channel.id, { tasks: [{ title: "park me" }] });
  const { taskNumber } = created.body.tasks[0]!;
  const row = await taskRow(channel.id, taskNumber);

  const moved = await webUpdateStatus(app.baseUrl, token, server.id, row.id, { status: "backlog", reason: "after the launch" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.task?.status, "backlog");
  assert.deepEqual(await lastStatusPayload(row.id), { from: "todo", to: "backlog", forced: false, reason: "after the launch" });
  await waitForTaskLine(row.id, `${owner.displayName} moved #${taskNumber} to Backlog: after the launch`);

  const back = await webUpdateStatus(app.baseUrl, token, server.id, row.id, { status: "todo" });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(await lastStatusPayload(row.id), { from: "backlog", to: "todo", forced: false });
});

test("backlog on a pre-v2 task where the flag is off: refused like an invalid status on both routes, nothing written", async ({ app }) => {
  const { owner, channel, server, apiKey, board } = await setup("cs-backlog-legacy");
  const created = await agentCreate(app.baseUrl, apiKey, { channel: board, tasks: [{ title: "old" }] });
  const { taskNumber } = created.body.tasks[0]!;
  const row = await taskRow(channel.id, taskNumber);
  assert.equal(row.ownConversation, false);

  const agentRefused = await agentUpdateStatus(app.baseUrl, apiKey, { channel: board, task_number: taskNumber, status: "backlog", reason: "later" });
  assert.equal(agentRefused.status, 400, JSON.stringify(agentRefused.body));
  assert.equal(agentRefused.body.code, "task_status_not_available");
  assert.match(agentRefused.body.error ?? "", /^valid status is required \(todo, in_progress, in_review, done, closed\)/);

  const token = await login(app.baseUrl, owner.email);
  const webRefused = await webUpdateStatus(app.baseUrl, token, server.id, row.id, { status: "backlog" });
  assert.equal(webRefused.status, 400, JSON.stringify(webRefused.body));
  assert.equal(webRefused.body.code, "task_status_not_available");

  const after = await taskRow(channel.id, taskNumber);
  assert.equal(after.status, "todo");
  assert.equal(after.revision, row.revision, "no write");
});
