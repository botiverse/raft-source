import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { taskEvents, tasks, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { mintAgentCredential } from "../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { registerMachine } from "../services/machineService";
import { createServer } from "../services/serverService";
import * as taskService from "../services/taskService";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import * as featureFlagService from "../services/featureFlagService";

const test = createApiTest();
const statuses = ["todo", "in_progress", "in_review", "done", "closed"] as const;

async function setup() {
  const id = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `task-complete-${id}@slock.test`, name: `task-complete-${id}`,
    displayName: "Owner", passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Task completeness", `task-complete-${id}`, owner!.id);
  const channel = await createChannel(server.id, `board-${id.slice(0, 8)}`);
  await addHuman(channel.id, owner!.id);
  const agent = await createAgent(server.id, `Reader-${id.slice(0, 8)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  const credential = await mintAgentCredential({ agentId: agent.id, scopes: ["tasks"], name: "task-list", issuedVia: "computer", createdByUserId: null });
  const machine = await registerMachine(server.id, owner!.id, "task-list-machine");
  await placeAgentOnMachine(agent.id, machine.machine.id);
  return { owner: owner!, server, channel, agent, apiKey: credential.apiKey, machineKey: machine.apiKey, ref: `#${channel.name}` };
}

async function agentList(baseUrl: string, key: string, ref: string, status = "all") {
  return fetch(`${baseUrl}/internal/agent-api/tasks?${new URLSearchParams({ channel: ref, status })}`, { headers: { Authorization: `Bearer ${key}` } });
}

async function seedRows(f: Awaited<ReturnType<typeof setup>>, count: number) {
  await getDb().insert(tasks).values(Array.from({ length: count }, (_, i) => ({
    channelId: f.channel.id, taskNumber: i + 1, title: `task ${i + 1}`,
    description: i === 0 ? null : `description ${i + 1}`,
    status: statuses[i % statuses.length]!, createdByType: "user" as const, createdById: f.owner.id, ownConversation: true,
  })));
}

test("channel task list asserts a complete filtered result, including >100 rows, terminal statuses and descriptions", async ({ app }) => {
  const f = await setup();
  const empty = await agentList(app.baseUrl, f.apiKey, f.ref);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { tasks: [], scope: "channel", pagination: { mode: "complete", truncated: false } });
  await seedRows(f, 126);
  const all = await agentList(app.baseUrl, f.apiKey, f.ref);
  assert.equal(all.status, 200, await all.clone().text());
  const body = await all.json() as { tasks: Array<{ taskNumber: number; status: string; description: string | null }>; scope: string; pagination: unknown };
  assert.equal(body.scope, "channel");
  assert.deepEqual(body.pagination, { mode: "complete", truncated: false });
  assert.equal(body.tasks.length, 126);
  assert.deepEqual(new Set(body.tasks.map(t => t.status)), new Set(statuses));
  assert.equal(body.tasks[0]!.description, null);
  assert.equal(body.tasks[125]!.description, "description 126");
  const done = await agentList(app.baseUrl, f.apiKey, f.ref, "done");
  assert.equal(done.status, 200);
  const filtered = await done.json() as { tasks: Array<{ status: string }>; pagination: unknown };
  assert.equal(filtered.tasks.length, 25);
  assert.ok(filtered.tasks.every(t => t.status === "done"));
  assert.deepEqual(filtered.pagination, { mode: "complete", truncated: false });

  const secret = await createChannel(f.server.id, `hidden-${randomUUID().slice(0, 6)}`, undefined, "private");
  const denied = await agentList(app.baseUrl, f.apiKey, `#${secret.name}`);
  assert.equal(denied.status, 404);
  assert.equal((await denied.json() as { pagination?: unknown }).pagination, undefined);
});

test("a base task query failure is an error for all three list callers, never a complete empty board", async ({ app }) => {
  const f = await setup();
  await seedRows(f, 1);
  const human = await tokenForHuman(f.owner.email);
  await getDb().execute(sql`ALTER TABLE tasks RENAME TO task_list_failure_fixture`);
  try {
    const requests = [
      () => agentList(app.baseUrl, f.apiKey, f.ref),
      () => fetch(`${app.baseUrl}/internal/agent/${f.agent.id}/tasks?${new URLSearchParams({ channel: f.ref })}`, { headers: { Authorization: `Bearer ${f.machineKey}` } }),
      () => fetch(`${app.baseUrl}/api/tasks/channel/${f.channel.id}`, { headers: { Authorization: `Bearer ${human}`, "X-Server-Id": f.server.id } }),
    ];
    for (const request of requests) {
      const res = await request();
      assert.equal(res.status, 500, await res.clone().text());
      const body = await res.json() as { tasks?: unknown; pagination?: unknown };
      assert.equal(body.tasks, undefined);
      assert.equal(body.pagination, undefined);
    }
  } finally {
    await getDb().execute(sql`ALTER TABLE task_list_failure_fixture RENAME TO tasks`);
  }
});

test("later enrichment and projection errors cannot become a complete channel response", async ({ app }) => {
  const f = await setup();
  await seedRows(f, 1);
  await getDb().execute(sql`ALTER TABLE users RENAME TO task_list_users_fixture`);
  try {
    const failed = await agentList(app.baseUrl, f.apiKey, f.ref);
    assert.equal(failed.status, 500, await failed.clone().text());
    const body = await failed.json() as { tasks?: unknown; pagination?: unknown };
    assert.equal(body.tasks, undefined);
    assert.equal(body.pagination, undefined);
  } finally {
    await getDb().execute(sql`ALTER TABLE task_list_users_fixture RENAME TO users`);
  }
  const projection = vi.spyOn(taskService, "projectTasksToChannel").mockImplementationOnce(() => { throw new Error("projection fixture failure"); });
  try {
    const failed = await agentList(app.baseUrl, f.apiKey, f.ref);
    assert.equal(failed.status, 500, await failed.clone().text());
    const body = await failed.json() as { tasks?: unknown; pagination?: unknown };
    assert.equal(body.tasks, undefined);
    assert.equal(body.pagination, undefined);
  } finally { projection.mockRestore(); }
  const view = vi.spyOn(taskService, "listTasks").mockRejectedValueOnce(new Error("task view list fixture failure"));
  try {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/tasks/view?${new URLSearchParams({ channel: f.ref, task_number: "1" })}`, { headers: { Authorization: `Bearer ${f.apiKey}` } });
    assert.equal(res.status, 500, await res.clone().text());
  } finally { view.mockRestore(); }
});

test("a failed task-conversation flag read after the task query is an error, not a complete projection", async ({ app }) => {
  const f = await setup();
  await seedRows(f, 1);
  const originalList = taskService.listTasks;
  let listed = false;
  const list = vi.spyOn(taskService, "listTasks").mockImplementation(async (...args) => {
    const rows = await originalList(...args);
    listed = true;
    return rows;
  });
  const originalEvaluate = featureFlagService.evaluateFeatureFlag;
  let injected = false;
  const flag = vi.spyOn(featureFlagService, "evaluateFeatureFlag").mockImplementation(async (...args) => {
    if (listed && args[0].key === TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY) {
      injected = true;
      throw new Error("task conversation flag fixture failure");
    }
    return originalEvaluate(...args);
  });
  try {
    const res = await agentList(app.baseUrl, f.apiKey, f.ref);
    assert.equal(injected, true, "the flag failed after the task query completed");
    assert.equal(res.status, 500, await res.clone().text());
    const body = await res.json() as { tasks?: unknown; pagination?: unknown };
    assert.equal(body.tasks, undefined);
    assert.equal(body.pagination, undefined);
  } finally { list.mockRestore(); flag.mockRestore(); }
});

test("a failed amendment provenance read cannot be returned as a complete board", async ({ app }) => {
  const f = await setup();
  await seedRows(f, 1);
  await getDb().execute(sql`ALTER TABLE task_events RENAME TO task_list_events_fixture`);
  try {
    const res = await agentList(app.baseUrl, f.apiKey, f.ref);
    assert.equal(res.status, 500, await res.clone().text());
    const body = await res.json() as { tasks?: unknown; pagination?: unknown };
    assert.equal(body.tasks, undefined);
    assert.equal(body.pagination, undefined);
  } finally {
    await getDb().execute(sql`ALTER TABLE task_list_events_fixture RENAME TO task_events`);
  }
});

test("a failed amendment actor read cannot be returned as a complete board", async ({ app }) => {
  const f = await setup();
  await seedRows(f, 1);
  const [task] = await getDb().select({ id: tasks.id }).from(tasks).where(eq(tasks.channelId, f.channel.id));
  // actor_id is historical text; a malformed agent id makes the actual UUID
  // actor lookup fail after the amendment event was read.
  await getDb().insert(taskEvents).values({ taskId: task!.id, eventType: "amended", actorType: "agent", actorId: "not-a-uuid", payload: {} });
  const res = await agentList(app.baseUrl, f.apiKey, f.ref);
  assert.equal(res.status, 500, await res.clone().text());
  const body = await res.json() as { tasks?: unknown; pagination?: unknown };
  assert.equal(body.tasks, undefined);
  assert.equal(body.pagination, undefined);
});
