// The open tasks an `agent:start` of a resumed session names: the agent's
// own todo / in_progress tasks, read through its task surfaces, by their
// agent-facing refs; in_review, finished and other agents' tasks are left out.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { tasks } from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { createAgent } from "./agentService";
import { AGENT_RESUME_OPEN_TASKS_LISTED, listAgentResumeOpenTasks } from "./agentResumeOpenTasks";
import { addAgent, findOrCreateDM } from "./channelService";
import * as taskService from "./taskService";

type Status = "todo" | "in_progress" | "in_review" | "done" | "closed" | "backlog";

async function fixture(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner, members: [] });
  const channel = await seed.channel({ server, members: [owner], name: `work-${randomUUID().slice(0, 6)}` });
  const agent = await createAgent(server.id, `resumer-${randomUUID().slice(0, 6)}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  const other = await createAgent(server.id, `other-${randomUUID().slice(0, 6)}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  await addAgent(channel.id, agent.id);
  await addAgent(channel.id, other.id);
  return { owner, server, channel, agent, other };
}

async function assignedTask(channelId: string, creatorId: string, agentId: string, title: string, status: Status, updatedAt?: Date) {
  const { tasks: [created] } = await taskService.createTasks(channelId, "user", creatorId, [{ title }]);
  await getDb().update(tasks)
    .set({ status, claimedByType: "agent", claimedById: agentId, ...(updatedAt ? { updatedAt } : {}) })
    .where(eq(tasks.id, created!.id));
  return created!;
}

test("names the agent's todo and in_progress tasks by ref, most recently updated first; leaves out in_review, finished and others' tasks", async ({ seed }) => {
  const fx = await fixture(seed);
  const base = Date.now() - 60 * 60_000;
  const doing = await assignedTask(fx.channel.id, fx.owner.id, fx.agent.id, "Ship the resume prompt", "in_progress", new Date(base));
  const next = await assignedTask(fx.channel.id, fx.owner.id, fx.agent.id, "Write the follow-up", "todo", new Date(base - 60_000));
  await assignedTask(fx.channel.id, fx.owner.id, fx.agent.id, "Waiting on review", "in_review");
  await assignedTask(fx.channel.id, fx.owner.id, fx.agent.id, "Already finished", "done");
  await assignedTask(fx.channel.id, fx.owner.id, fx.agent.id, "Parked", "backlog");
  await assignedTask(fx.channel.id, fx.owner.id, fx.other.id, "Someone else's", "in_progress");

  const open = await listAgentResumeOpenTasks({ id: fx.agent.id, serverId: fx.server.id });

  assert.deepEqual(open, {
    tasks: [
      { ref: `#${fx.channel.name}:#${doing.taskNumber}`, title: "Ship the resume prompt", status: "in_progress" },
      { ref: `#${fx.channel.name}:#${next.taskNumber}`, title: "Write the follow-up", status: "todo" },
    ],
    more: 0,
  });
});

test("more than five open tasks: five are named, the rest counted", async ({ seed }) => {
  const fx = await fixture(seed);
  const base = Date.now() - 60 * 60_000;
  for (let i = 1; i <= AGENT_RESUME_OPEN_TASKS_LISTED + 2; i++) {
    await assignedTask(fx.channel.id, fx.owner.id, fx.agent.id, `Task ${i}`, i % 2 ? "todo" : "in_progress", new Date(base - i * 60_000));
  }
  // An in_review task is not counted either.
  await assignedTask(fx.channel.id, fx.owner.id, fx.agent.id, "In review", "in_review");

  const open = await listAgentResumeOpenTasks({ id: fx.agent.id, serverId: fx.server.id });

  assert.ok(open);
  assert.deepEqual(open.tasks.map((task) => task.title), ["Task 1", "Task 2", "Task 3", "Task 4", "Task 5"]);
  assert.equal(open.more, 2);
});

test("a task in the agent's DM is named by its DM ref", async ({ seed }) => {
  const fx = await fixture(seed);
  const dm = await findOrCreateDM(fx.server.id, fx.owner.id, fx.agent.id);
  assert.ok(dm);
  const task = await assignedTask(dm.id, fx.owner.id, fx.agent.id, "From the DM", "todo");

  const open = await listAgentResumeOpenTasks({ id: fx.agent.id, serverId: fx.server.id });

  assert.ok(open);
  assert.equal(open.tasks.length, 1);
  assert.match(open.tasks[0]!.ref, new RegExp(`^dm:@\\S+:#${task.taskNumber}$`));
  assert.equal(open.tasks[0]!.title, "From the DM");
});

test("nothing open: null (the start carries no openTasks)", async ({ seed }) => {
  const fx = await fixture(seed);
  await assignedTask(fx.channel.id, fx.owner.id, fx.agent.id, "Already finished", "done");
  await assignedTask(fx.channel.id, fx.owner.id, fx.agent.id, "Waiting on review", "in_review");

  assert.equal(await listAgentResumeOpenTasks({ id: fx.agent.id, serverId: fx.server.id }), null);
});

test("the existing callers' default still counts in_review (the paused-wake notice is unchanged)", async ({ seed }) => {
  const fx = await fixture(seed);
  await assignedTask(fx.channel.id, fx.owner.id, fx.agent.id, "Doing", "in_progress");
  await assignedTask(fx.channel.id, fx.owner.id, fx.agent.id, "Waiting on review", "in_review");
  const surfaceIds = [fx.channel.id];

  const all = await taskService.listRecentTasksAssignedToAgent(surfaceIds, fx.agent.id, 5);
  assert.equal(all.total, 2);
  assert.deepEqual(all.rows.map((row) => row.status).sort(), ["in_progress", "in_review"]);
  assert.equal(await taskService.countTasksAssignedToAgent(surfaceIds, fx.agent.id), 2);
  assert.equal(await taskService.countTasksAssignedToAgent(surfaceIds, fx.agent.id, { statuses: ["todo", "in_progress"] }), 1);
});
