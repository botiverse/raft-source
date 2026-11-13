// task #45: when the early-exit breaker pauses an agent's automatic wakes,
// its owner gets one notice in their DM with the agent, listing the open
// tasks it holds in channels the owner can see (others only counted).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, like } from "drizzle-orm";

import { getDb } from "../db/index";
import { agents, messages, serverMembers, tasks, users } from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { withChannelDelivery } from "../test/orchestratorStub";
import { createAgent } from "./agentService";
import { postAutomaticWakePausedNotice } from "./automaticWakePausedNotice";
import { addAgent, findOrCreateDM } from "./channelService";
import * as taskService from "./taskService";

function noopIo() {
  const chain = { in: () => chain, to: () => chain, socketsJoin() {}, emit() {} };
  return chain as any;
}

const orchestrator = () => withChannelDelivery({ deliverMessage: async () => {} }) as any;

async function fixture(seed: ReturnType<typeof createSeed>) {
  const admin = await seed.human();
  const owner = await seed.human();
  const other = await seed.human();
  const server = await seed.server({ owner: admin, members: [owner, other] });
  const shared = await seed.channel({ server, members: [owner, other], name: `ops-${randomUUID().slice(0, 6)}` });
  const hidden = await seed.channel({ server, members: [other], name: `secret-${randomUUID().slice(0, 6)}`, visibility: "private" });
  const agent = await createAgent(server.id, `crashy-${randomUUID().slice(0, 6)}`, { runtime: "claude", creatorType: "user", creatorId: owner.id });
  await addAgent(shared.id, agent.id);
  await addAgent(hidden.id, agent.id);
  return { admin, owner, other, server, shared, hidden, agent };
}

async function assignedTask(channelId: string, creatorId: string, agentId: string, title: string, status: "todo" | "in_progress" | "done" = "in_progress") {
  const { tasks: [created] } = await taskService.createTasks(channelId, "user", creatorId, [{ title }]);
  await getDb().update(tasks).set({ status, claimedByType: "agent", claimedById: agentId }).where(eq(tasks.id, created!.id));
  return created!;
}

async function dmNotices(serverId: string, userId: string, agentId: string) {
  const dm = await findOrCreateDM(serverId, userId, agentId);
  assert.ok(dm);
  return (await getDb().select({ content: messages.content }).from(messages)
    .where(and(eq(messages.channelId, dm.id), eq(messages.messageType, "system"))))
    .map((row) => row.content);
}

test("the owner is told in their DM with the agent, with the open tasks they can see; a hidden channel's tasks are only counted", async ({ seed }) => {
  const fx = await fixture(seed);
  const t1 = await assignedTask(fx.shared.id, fx.owner.id, fx.agent.id, "Ship the breaker notice");
  await assignedTask(fx.shared.id, fx.owner.id, fx.agent.id, "Already finished", "done");
  await assignedTask(fx.hidden.id, fx.other.id, fx.agent.id, "Private plans");

  assert.equal(await postAutomaticWakePausedNotice(noopIo(), orchestrator(), { agentId: fx.agent.id, earlyExits: 3 }), true);

  const [notice, ...rest] = await dmNotices(fx.server.id, fx.owner.id, fx.agent.id);
  assert.deepEqual(rest, []);
  assert.ok(notice);
  const lines = notice.split("\n");
  assert.equal(lines[0], `@${fx.agent.name} is no longer woken automatically: it exited early 3 times in a row.`);
  assert.equal(lines[1], "Open tasks assigned to it:");
  assert.equal(lines[2], `- #${fx.shared.name}:#${t1.taskNumber} Ship the breaker notice`);
  assert.equal(lines[3], "Also 1 open task assigned to it in channels you can't see.");
  assert.equal(lines[4], "Restarting it from its page resumes automatic wakes. Its tasks can be reassigned.");
  assert.doesNotMatch(notice, /Private plans|secret-|Already finished/);
});

test("more than five visible tasks: the five most recently updated are named, the rest counted", async ({ seed }) => {
  const fx = await fixture(seed);
  const base = Date.now() - 60 * 60_000;
  for (let i = 1; i <= 7; i++) {
    const task = await assignedTask(fx.shared.id, fx.owner.id, fx.agent.id, `Task ${i}`);
    // Task 1 is the most recently updated, task 7 the least.
    await getDb().update(tasks).set({ updatedAt: new Date(base - i * 60_000) }).where(eq(tasks.id, task.id));
  }
  assert.equal(await postAutomaticWakePausedNotice(noopIo(), orchestrator(), { agentId: fx.agent.id, earlyExits: 3 }), true);
  const [notice] = await dmNotices(fx.server.id, fx.owner.id, fx.agent.id);
  const named = notice!.split("\n").filter((line) => line.startsWith("- #")).map((line) => line.replace(/^- #\S+ /, ""));
  assert.deepEqual(named, ["Task 1", "Task 2", "Task 3", "Task 4", "Task 5"]);
  assert.match(notice!, /\nand 2 more\n/);
});

async function wakePausedNoticeCount(agentName: string) {
  return (await getDb().select({ id: messages.id }).from(messages)
    .where(and(eq(messages.messageType, "system"), like(messages.content, `@${agentName} is no longer woken automatically%`)))).length;
}

test("owner retired: no notice", async ({ seed }) => {
  const fx = await fixture(seed);
  await assignedTask(fx.shared.id, fx.owner.id, fx.agent.id, "Ship it");
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, fx.owner.id));
  assert.equal(await postAutomaticWakePausedNotice(noopIo(), orchestrator(), { agentId: fx.agent.id, earlyExits: 3 }), false);
  assert.equal(await wakePausedNoticeCount(fx.agent.name), 0);
});

test("owner no longer a member of the agent's server: no notice", async ({ seed }) => {
  const fx = await fixture(seed);
  await assignedTask(fx.shared.id, fx.owner.id, fx.agent.id, "Ship it");
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, fx.server.id), eq(serverMembers.userId, fx.owner.id)));
  assert.equal(await postAutomaticWakePausedNotice(noopIo(), orchestrator(), { agentId: fx.agent.id, earlyExits: 3 }), false);
  assert.equal(await wakePausedNoticeCount(fx.agent.name), 0);
});

test("a personal assistant's notice goes to the person it assists, not its creator", async ({ seed }) => {
  const fx = await fixture(seed);
  await getDb().update(agents).set({ assistantOwnerUserId: fx.other.id }).where(eq(agents.id, fx.agent.id));
  const task = await assignedTask(fx.hidden.id, fx.other.id, fx.agent.id, "Private plans");
  assert.equal(await postAutomaticWakePausedNotice(noopIo(), orchestrator(), { agentId: fx.agent.id, earlyExits: 3 }), true);
  const [notice] = await dmNotices(fx.server.id, fx.other.id, fx.agent.id);
  assert.match(notice!, new RegExp(`- #${fx.hidden.name}:#${task.taskNumber} Private plans`), "the assisted person sees their private channel's task");
  const posted = await getDb().select({ channelId: messages.channelId }).from(messages)
    .where(and(eq(messages.messageType, "system"), like(messages.content, `@${fx.agent.name} is no longer woken automatically%`)));
  assert.equal(posted.length, 1, "only the assisted person is told, not the creator");
});

test("no owner (an agent created by another agent): no notice", async ({ seed }) => {
  const fx = await fixture(seed);
  const orphan = await createAgent(fx.server.id, `orphan-${randomUUID().slice(0, 6)}`, { runtime: "claude", creatorType: "agent", creatorId: fx.agent.id });
  assert.equal(await postAutomaticWakePausedNotice(noopIo(), orchestrator(), { agentId: orphan.id, earlyExits: 3 }), false);
});
