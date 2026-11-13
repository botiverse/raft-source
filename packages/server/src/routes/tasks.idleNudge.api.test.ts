// POST /internal/agent-api/tasks/idle-nudge (#wg-task-v2:#9): the idle task
// reminder through the agent API, as a Computer asks it with the agent's
// credential. Flag off it answers `disabled`; on, a task someone assigned to
// the agent through the real assign path is listed once with the notice text.
// The decision rules themselves: services/idleTaskReminderService.*.test.ts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createServer } from "../services/serverService";
import * as taskService from "../services/taskService";
import { getDb } from "../db/index";
import { taskEvents, tasks, users } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";

const test = createApiTest();

async function setup(slug: string, opts: { flag: boolean }) {
  const [owner] = await getDb().insert(users).values({
    email: `${slug}-${randomUUID()}@slock.test`,
    name: `${slug}-${randomUUID().slice(0, 8)}`,
    displayName: slug,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  }).returning();
  const server = await createServer(`Idle ${slug}`, `${slug}-${randomUUID()}`, owner!.id);
  const channel = await createChannel(server.id, slug);
  await addHuman(channel.id, owner!.id);
  const agent = await createAgent(server.id, `${slug}-bot-${randomUUID().slice(0, 4)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  // The reminder shares the task v2 flag.
  if (opts.flag) await enableTaskV2ConversationsForServer(server.id);
  const { apiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read", "tasks", "channels"],
    name: `idle-${randomUUID().slice(0, 6)}`,
    issuedVia: "computer",
    createdByUserId: null,
  });
  return { owner: owner!, server, channel, agent, apiKey };
}

async function idleNudge(baseUrl: string, apiKey: string, body: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api/tasks/idle-nudge`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

test("flag off: 200 send false, reason disabled", async ({ app }) => {
  const { owner, channel, agent, apiKey } = await setup("idle-off", { flag: false });
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "waiting" }]);
  assert.equal(typeof await taskService.assignTask(task!.id, { type: "agent", id: agent.id }, "user", owner.id), "object");

  const res = await idleNudge(app.baseUrl, apiKey, { freshSession: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { send: false, reason: "disabled", items: [], backlog: [], text: "" });
});

test("a bad body is refused before anything runs", async ({ app }) => {
  const { apiKey } = await setup("idle-bad", { flag: true });
  const negative = await idleNudge(app.baseUrl, apiKey, { backgroundTasks: -1 });
  assert.equal(negative.status, 400, JSON.stringify(negative.body));
  const notBoolean = await idleNudge(app.baseUrl, apiKey, { freshSession: "yes" });
  assert.equal(notBoolean.status, 400, JSON.stringify(notBoolean.body));
});

test("#wg-ax:#32: rulesShown leaves the held-task rules out of the notice, and the answer says whether they are in it", async ({ app }) => {
  for (const rulesShown of [false, true]) {
    const { owner, channel, agent, apiKey } = await setup(`idle-rules-${rulesShown}`, { flag: true });
    const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "Rollout checklist" }]);
    assert.equal(typeof await taskService.assignTask(task!.id, { type: "agent", id: agent.id }, "user", owner.id), "object");
    const res = await idleNudge(app.baseUrl, apiKey, rulesShown ? { rulesShown } : {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.send, true);
    assert.equal(res.body.rules, !rulesShown);
    assert.equal(String(res.body.text).includes("\nFor each task:\n"), !rulesShown, res.body.text);
    assert.ok(String(res.body.text).endsWith("\nNo change → no reply needed.]"), res.body.text);
  }
});

test("flag on: a task assigned by someone else is listed once with the notice; the next idle sends nothing", async ({ app }) => {
  const { owner, channel, agent, apiKey } = await setup("idle-on", { flag: true });
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "Rollout checklist" }]);
  assert.equal(typeof await taskService.assignTask(task!.id, { type: "agent", id: agent.id }, "user", owner.id), "object");

  const first = await idleNudge(app.baseUrl, apiKey, {});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.send, true);
  assert.deepEqual(first.body.items, [{
    ref: `#${channel.name}:#${task!.taskNumber}`,
    taskNumber: task!.taskNumber,
    channel: `#${channel.name}`,
    title: "Rollout checklist",
    status: "todo",
    reason: "newly_assigned",
    why: `newly yours (assigned by @${owner.name})`,
  }]);
  assert.deepEqual(first.body.backlog, []);
  assert.ok(String(first.body.text).startsWith("[Raft task notice: 1 task is waiting on you.\n"), first.body.text);

  const second = await idleNudge(app.baseUrl, apiKey, { backgroundTasks: 1 });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(second.body, { send: false, reason: "no_change", items: [], backlog: [], text: "" });

  // A new session lists it again, once.
  const fresh = await idleNudge(app.baseUrl, apiKey, { freshSession: true });
  assert.equal(fresh.body.send, true);
  assert.equal(fresh.body.items[0].reason, "new_session");
});

test("a todo with no assignee the agent created: past 8h it passes the response contract with a known reason and says why in `why`", async ({ app }) => {
  const { channel, agent, apiKey } = await setup("idle-unassigned", { flag: true });
  const { tasks: [task] } = await taskService.createTasks(channel.id, "agent", agent.id, [{ title: "Split-off work" }]);
  const fresh = await idleNudge(app.baseUrl, apiKey, {});
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.deepEqual(fresh.body, { send: false, reason: "no_open_tasks", items: [], backlog: [], text: "" });

  const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1000);
  await getDb().update(tasks).set({ createdAt: nineHoursAgo, updatedAt: nineHoursAgo }).where(eq(tasks.id, task!.id));
  await getDb().update(taskEvents).set({ createdAt: nineHoursAgo }).where(eq(taskEvents.taskId, task!.id));

  const due = await idleNudge(app.baseUrl, apiKey, {});
  assert.equal(due.status, 200, JSON.stringify(due.body));
  assert.equal(due.body.send, true);
  assert.deepEqual(due.body.items, [{
    ref: `#${channel.name}:#${task!.taskNumber}`,
    taskNumber: task!.taskNumber,
    channel: `#${channel.name}`,
    title: "Split-off work",
    status: "todo",
    reason: "stale",
    why: "no assignee, you created it (untouched for 9h)",
  }]);
  assert.ok(String(due.body.text).includes("raft task claim"), due.body.text);
});
