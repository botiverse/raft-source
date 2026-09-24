import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import type { TaskResourceReceipt } from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import { agents, reminders, taskEvents, tasks, users } from "../db/schema.js";
import { taskResourceExpiryFollowups } from "../registry.manifest.js";
import { addAgent, addHuman, createChannel } from "./channelService.js";
import { createServer } from "./serverService.js";
import * as taskService from "./taskService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seed() {
  const db = getDb();
  const suffix = randomUUID();
  const [user] = await db.insert(users).values({
    email: `resource-receipt-${suffix}@slock.test`,
    name: `resource-owner-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Resource Receipt", `resource-receipt-${suffix}`, user.id);
  const channel = await createChannel(server.id, "resource-receipt");
  await addHuman(channel.id, user.id);
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `teardown-${suffix}`,
    status: "active",
    model: "sonnet",
    runtime: "claude",
    executionMode: "byoc",
  }).returning();
  await addAgent(channel.id, agent.id);
  return { user, server, channel, agent };
}

function unwrap(result: taskService.TaskMutationResult): taskService.TaskRow {
  assert.notEqual(typeof result, "string", `expected mutation, got ${String(result)}`);
  return (result as Exclude<taskService.TaskMutationResult, string>).row;
}

test("resource-creating tasks cannot complete until an atomic owner-anchored receipt is recorded", async ({ app }) => {
  const { user, server, channel, agent } = await seed();
  const { tasks: [marked, ordinary] } = await taskService.createTasks(
    channel.id,
    "user",
    user.id,
    [
      { title: "Create staging bucket", createsResource: true },
      { title: "Document command" },
    ],
  );
  assert.equal(marked.requiresResourceReceipt, true);
  assert.equal(ordinary.requiresResourceReceipt, false);

  unwrap(await taskService.updateTaskStatus(marked.id, "in_progress", user.id, "user"));
  unwrap(await taskService.updateTaskStatus(marked.id, "in_review", user.id, "user"));
  assert.equal(
    await taskService.updateTaskStatus(marked.id, "done", user.id, "user"),
    "resource receipt required before task can move to done",
  );
  assert.equal(
    await taskService.forceUpdateTaskStatus(marked.id, "done", "user", user.id),
    "resource receipt required before task can move to done",
    "admin force must cross the same completion invariant",
  );
  await assert.rejects(
    getDb().update(tasks).set({ status: "done" }).where(eq(tasks.id, marked.id)),
    (error: unknown) => {
      const cause = error && typeof error === "object" && "cause" in error
        ? String((error as { cause?: unknown }).cause)
        : "";
      assert.match(cause, /tasks_resource_receipt_completion_check/);
      return true;
    },
    "a direct database writer must not bypass the completion invariant",
  );
  await assert.rejects(
    getDb().update(tasks).set({ resourceReceiptRecordedAt: new Date() }).where(eq(tasks.id, ordinary.id)),
    (error: unknown) => {
      const cause = error && typeof error === "object" && "cause" in error
        ? String((error as { cause?: unknown }).cause)
        : "";
      assert.match(cause, /tasks_resource_receipt_state_check/);
      return true;
    },
    "receipt metadata must be written atomically even for a direct database writer",
  );

  const receipt: TaskResourceReceipt = {
    object: `s3://raft-staging-${marked.taskNumber}`,
    purpose: "staging restore acceptance",
    teardown_owner: `@${agent.name}`,
    security_privacy: "internal; encrypted; no credentials stored here",
    expiry: "2099-09-01T00:00:00.000Z",
    runbook: "runbooks/staging-resource.md",
    tracking: `task #${marked.taskNumber}`,
  };
  assert.equal(
    await taskService.recordTaskResourceReceipt({
      taskId: marked.id,
      receipt: { ...receipt, runbook: "   " },
      actorType: "user",
      actorId: user.id,
      teardownOwnerAgentId: agent.id,
      teardownOwnerServerId: server.id,
      teardownOwnerTargetChannelId: channel.id,
      expiryFollowups: taskResourceExpiryFollowups,
    }),
    "resource receipt field runbook must be nonblank",
  );
  assert.equal((await getDb().select().from(reminders)).length, 0, "invalid receipt must create no reminder");

  const recorded = await taskService.recordTaskResourceReceipt({
    taskId: marked.id,
    receipt,
    actorType: "user",
    actorId: user.id,
    teardownOwnerAgentId: agent.id,
    teardownOwnerServerId: server.id,
    teardownOwnerTargetChannelId: channel.id,
    expiryFollowups: taskResourceExpiryFollowups,
  });
  assert.notEqual(typeof recorded, "string");
  const first = recorded as taskService.TaskResourceReceiptResult;
  assert.equal(first.idempotent, false);
  assert.equal(first.task.resourceTeardownOwnerAgentId, agent.id);
  assert.equal(first.task.resourceExpiryFollowupId, first.expiryFollowup.id);
  assert.equal(first.expiryFollowup.ownerAgentId, agent.id);
  assert.equal(first.expiryFollowup.serverId, server.id);
  assert.equal(first.expiryFollowup.targetChannelId, channel.id);
  assert.equal(first.expiryFollowup.msgId, marked.messageId);
  assert.equal(first.expiryFollowup.fireAt.toISOString(), receipt.expiry);
  assert.deepEqual(first.expiryFollowup.payload, {
    kind: "task_resource_expiry",
    taskId: marked.id,
    taskNumber: marked.taskNumber,
    object: receipt.object,
    teardownOwner: receipt.teardown_owner,
    receiptRecordedAt: first.task.resourceReceiptRecordedAt!.toISOString(),
  });
  await assert.rejects(
    getDb().update(tasks).set({ resourceExpiryFollowupId: randomUUID() }).where(eq(tasks.id, marked.id)),
    (error: unknown) => {
      const cause = error && typeof error === "object" && "cause" in error
        ? String((error as { cause?: unknown }).cause)
        : "";
      assert.match(cause, /tasks_resource_expiry_followup_id_reminders_id_fk/);
      return true;
    },
    "the expiry follow-up identity must reference a durable scheduled row",
  );
  await assert.rejects(
    getDb().update(tasks).set({
      resourceReceipt: { ...receipt, runbook: "   " },
    }).where(eq(tasks.id, marked.id)),
    (error: unknown) => {
      const cause = error && typeof error === "object" && "cause" in error
        ? String((error as { cause?: unknown }).cause)
        : "";
      assert.match(cause, /tasks_resource_receipt_shape_check/);
      return true;
    },
    "all seven receipt fields must remain nonblank for a direct database writer",
  );

  const retry = await taskService.recordTaskResourceReceipt({
    taskId: marked.id,
    receipt,
    actorType: "user",
    actorId: user.id,
    teardownOwnerAgentId: agent.id,
    teardownOwnerServerId: server.id,
    teardownOwnerTargetChannelId: channel.id,
    expiryFollowups: taskResourceExpiryFollowups,
  });
  assert.notEqual(typeof retry, "string");
  assert.equal((retry as taskService.TaskResourceReceiptResult).idempotent, true);
  assert.equal((retry as taskService.TaskResourceReceiptResult).expiryFollowup.id, first.expiryFollowup.id);
  assert.equal((await getDb().select().from(reminders)).length, 1, "retry must not duplicate reminder");

  assert.equal(
    await taskService.recordTaskResourceReceipt({
      taskId: marked.id,
      receipt: { ...receipt, purpose: "different purpose" },
      actorType: "user",
      actorId: user.id,
      teardownOwnerAgentId: agent.id,
      teardownOwnerServerId: server.id,
      teardownOwnerTargetChannelId: channel.id,
      expiryFollowups: taskResourceExpiryFollowups,
    }),
    "resource receipt is already recorded",
  );

  assert.equal(unwrap(await taskService.updateTaskStatus(marked.id, "done", user.id, "user")).status, "done");
  unwrap(await taskService.updateTaskStatus(ordinary.id, "in_progress", user.id, "user"));
  unwrap(await taskService.updateTaskStatus(ordinary.id, "in_review", user.id, "user"));
  assert.equal(unwrap(await taskService.updateTaskStatus(ordinary.id, "done", user.id, "user")).status, "done");

  const events = await getDb().select().from(taskEvents).where(eq(taskEvents.taskId, marked.id));
  assert.equal(events.filter((event) => event.eventType === "resource_receipt_recorded").length, 1);
  const [persisted] = await getDb().select().from(tasks).where(eq(tasks.id, marked.id));
  assert.deepEqual(persisted.resourceReceipt, receipt);
});
