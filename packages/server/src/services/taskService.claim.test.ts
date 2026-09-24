import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import {
  __resetFailpointsForTests,
  __setFailpointsForTests,
  InMemoryFailpointRegistry,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import { channels, messages, serverMembers, tasks, users } from "../db/schema.js";
import { createChannel, addHuman } from "./channelService.js";
import { createServer } from "./serverService.js";
import * as messageService from "./messageService.js";
import * as taskService from "./taskService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// Force is an admin override; the actor is now required so the audit trail can
// name who overrode the state machine. These call sites are arrangement, not
// the property under test.
const ADMIN_FORCE_ACTOR_ID = "00000000-0000-0000-0000-0000000000ad";

async function seedUser(name: string) {
  const db = getDb();
  const suffix = randomUUID();
  const [user] = await db.insert(users).values({
    email: `${name}-${suffix}@slock.test`,
    name: `${name}-${suffix}`,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user;
}

/**
 * Unwrap a successful mutation and assert it was routed to the canonical
 * `tasks` table. v1.4 creates every new task there, so a "message"-sourced
 * result here would mean the ownership routing silently fell back to the
 * legacy columns — which is exactly the failure this suite must not pass.
 */
function canonicalMutation(result: taskService.TaskMutationResult): taskService.TaskRow {
  assert.notEqual(typeof result, "string", `expected a committed mutation, got ${String(result)}`);
  const owned = result as Exclude<taskService.TaskMutationResult, string>;
  assert.equal(owned.source, "tasks", "v1.4 tasks must be routed to the canonical tasks table");
  return (owned as { source: "tasks"; row: taskService.TaskRow }).row;
}

test("claimTask reports already claimed by you for self-claim", async ({ app }) => {
  const owner = await seedUser("task-self-claim-owner");
  const server = await createServer("Task Self Claim", `task-self-claim-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "task-self-claim");
  await addHuman(channel.id, owner.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "self claim" }]);

  const firstClaim = await taskService.claimTask(task.id, "user", owner.id);
  assert.notEqual(typeof firstClaim, "string");

  const secondClaim = await taskService.claimTask(task.id, "user", owner.id);
  assert.equal(secondClaim, "already claimed by you");

  const other = await seedUser("task-self-claim-other");
  const otherClaim = await taskService.claimTask(task.id, "user", other.id);
  assert.equal(otherClaim, `already assigned to @${owner.name}`);
});

test("batchClaimTasks reports already claimed by you for self-claim", async ({ app }) => {
  const owner = await seedUser("task-batch-self-owner");
  const server = await createServer("Task Batch Self Claim", `task-batch-self-claim-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "task-batch-self-claim");
  await addHuman(channel.id, owner.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "batch self claim" }]);

  const firstClaim = await taskService.batchClaimTasks(channel.id, [task.taskNumber!], "user", owner.id);
  assert.equal(firstClaim[0]?.success, true);

  const secondClaim = await taskService.batchClaimTasks(channel.id, [task.taskNumber!], "user", owner.id);
  assert.equal(secondClaim[0]?.success, false);
  assert.equal(secondClaim[0]?.reason, "already claimed by you");

  const other = await seedUser("task-batch-self-other");
  const otherClaim = await taskService.batchClaimTasks(channel.id, [task.taskNumber!], "user", other.id);
  assert.equal(otherClaim[0]?.success, false);
  assert.equal(otherClaim[0]?.reason, `already assigned to @${owner.name}`);
});

test("createTasks starts self-assignment but reserves assign-other todo work", async ({ app }) => {
  const owner = await seedUser("task-create-assignment-owner");
  const other = await seedUser("task-create-assignment-other");
  const server = await createServer("Task Creation Assignment", `task-create-assignment-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "task-create-assignment");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: other.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, other.id);

  const { tasks: [selfAssigned] } = await taskService.createTasksWithAssignmentReceipt(
    channel.id,
    "user",
    owner.id,
    [{ title: "self-assigned" }],
    { type: "user", id: owner.id },
    { assigneeName: owner.name },
  );
  assert.equal(selfAssigned.status, "in_progress");
  assert.equal(selfAssigned.claimedById, owner.id);
  assert.equal(selfAssigned.claimedByType, "user");
  assert.match(selfAssigned.claimedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

  const { tasks: [reserved] } = await taskService.createTasksWithAssignmentReceipt(
    channel.id,
    "user",
    owner.id,
    [{ title: "reserved for other" }],
    { type: "user", id: other.id },
    { assigneeName: other.name },
  );
  assert.equal(reserved.status, "todo");
  assert.equal(reserved.claimedById, other.id);
  assert.equal(reserved.claimedByType, "user");
  assert.equal(reserved.claimedAt, null);

  assert.equal(await taskService.claimTask(reserved.id, "user", owner.id), `already assigned to @${other.name}`);
  const started = canonicalMutation(await taskService.claimTask(reserved.id, "user", other.id));
  assert.equal(started.status, "in_progress");
  assert.equal(started.claimedById, other.id);
  assert.ok(started.claimedAt instanceof Date);
  assert.equal(await taskService.claimTask(reserved.id, "user", other.id), "already claimed by you");
});

test("batch claim and status-start stamp preassigned todo work exactly once", async ({ app }) => {
  const owner = await seedUser("task-preassigned-batch-owner");
  const other = await seedUser("task-preassigned-batch-other");
  const server = await createServer("Task Preassigned Batch", `task-preassigned-batch-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "task-preassigned-batch");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: other.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, other.id);

  const { tasks: [batchTask, statusTask] } = await taskService.createTasksWithAssignmentReceipt(
    channel.id,
    "user",
    owner.id,
    [{ title: "batch start" }, { title: "status start" }],
    { type: "user", id: other.id },
    { assigneeName: other.name },
  );

  const competitor = await taskService.batchClaimTasks(channel.id, [batchTask.taskNumber], "user", owner.id);
  assert.deepEqual(competitor.map(({ task: _task, conflict, ...result }) => result), [{
    taskNumber: batchTask.taskNumber,
    success: false,
    reason: `already assigned to @${other.name}`,
  }]);
  // Assignment-held failure carries the writer-built effect boundary from
  // the same observed row as the prose reason.
  assert.equal(competitor[0]?.conflict?.kind, "claim_conflict");
  assert.equal(competitor[0]?.conflict?.currentAssignee?.name, other.name);

  const first = await taskService.batchClaimTasks(channel.id, [batchTask.taskNumber], "user", other.id);
  assert.equal(first[0]?.success, true);
  const firstClaimed = canonicalMutation(first[0]!.task!);
  assert.equal(firstClaimed.status, "in_progress");
  assert.ok(firstClaimed.claimedAt instanceof Date);
  const second = await taskService.batchClaimTasks(channel.id, [batchTask.taskNumber], "user", other.id);
  assert.equal(second[0]?.success, false);
  assert.equal(second[0]?.reason, "already claimed by you");

  const statusStarted = canonicalMutation(await taskService.updateTaskStatus(statusTask.id, "in_progress", other.id));
  assert.equal(statusStarted.status, "in_progress");
  assert.ok(statusStarted.claimedAt instanceof Date);
});

test("closed work resumes and refreshes the claim epoch", async ({ app }) => {
  const owner = await seedUser("task-closed-resume-owner");
  const other = await seedUser("task-closed-resume-other");
  const server = await createServer("Task Closed Resume", `task-closed-resume-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "task-closed-resume");
  await addHuman(channel.id, owner.id);
  const oldClaimedAt = new Date("2026-01-01T00:00:00.000Z");

  const { tasks: [owned, unassigned] } = await taskService.createTasks(
    channel.id,
    "user",
    owner.id,
    [{ title: "owned closed task" }, { title: "unassigned closed task" }],
  );
  assert.notEqual(typeof await taskService.claimTask(owned.id, "user", owner.id), "string");
  await getDb().update(tasks)
    .set({ claimedAt: oldClaimedAt })
    .where(eq(tasks.id, owned.id));

  const closed = canonicalMutation(await taskService.updateTaskStatus(owned.id, "closed", owner.id));
  assert.equal(closed.status, "closed");
  assert.equal(closed.claimedAt?.toISOString(), oldClaimedAt.toISOString());
  // The former assertion here required `other` to be refused with
  // "only the assignee can update status". That restriction is gone --
  // @stdrc ruled status is member-level ("人都可以做"), so a non-assignee
  // resuming closed work is now legitimate and is verified instead.
  // Channel membership is still enforced at the route; this is the service
  // layer, which trusts that check.
  const byOther = canonicalMutation(await taskService.updateTaskStatus(owned.id, "in_progress", other.id));
  assert.equal(byOther.status, "in_progress", "a non-assignee may resume closed work");
  assert.equal(byOther.claimedById, owner.id, "resuming must not steal the assignee");

  // Put it back to closed so the epoch property below is still exercised
  // from the same starting state the test was written for.
  canonicalMutation(await taskService.updateTaskStatus(owned.id, "closed", other.id));
  await getDb().update(tasks).set({ claimedAt: oldClaimedAt }).where(eq(tasks.id, owned.id));

  const resumed = canonicalMutation(await taskService.updateTaskStatus(owned.id, "in_progress", owner.id));
  assert.equal(resumed.status, "in_progress");
  assert.equal(resumed.claimedById, owner.id);
  assert.ok(resumed.claimedAt instanceof Date);
  assert.ok(resumed.claimedAt.getTime() > oldClaimedAt.getTime());

  assert.notEqual(typeof await taskService.forceUpdateTaskStatus(unassigned.id, "closed", "user", ADMIN_FORCE_ACTOR_ID), "string");
  assert.equal(
    await taskService.claimTask(unassigned.id, "user", owner.id),
    "task is closed; reopen it before claiming",
  );
  const batchClaim = await taskService.batchClaimTasks(
    channel.id,
    [unassigned.taskNumber!],
    "user",
    owner.id,
  );
  assert.deepEqual(batchClaim.map(({ task: _task, ...result }) => result), [{
    taskNumber: unassigned.taskNumber,
    success: false,
    reason: "task is closed; reopen it before claiming",
  }]);

  // Numbers 1-2 are already taken by the canonical tasks created above — v1.4
  // allocates from the `tasks` table, so these fixtures start at 3.
  const [legacyOwned, legacyUnassigned] = await getDb().insert(tasks).values([
    {
      channelId: channel.id,
      taskNumber: 3,
      title: "legacy owned closed task",
      status: "closed",
      createdByType: "user",
      createdById: owner.id,
      claimedByType: "user",
      claimedById: owner.id,
      claimedAt: oldClaimedAt,
    },
    {
      channelId: channel.id,
      taskNumber: 4,
      title: "legacy unassigned closed task",
      status: "closed",
      createdByType: "user",
      createdById: owner.id,
    },
  ]).returning();
  // Same removal as above: a non-assignee resuming closed work is legitimate
  // now. Verify it works and does not steal the assignee, then restore the
  // closed state so the epoch assertions below start where they expect.
  const legacyByOther = canonicalMutation(
    await taskService.updateTaskStatus(legacyOwned.id, "in_progress", other.id),
  );
  assert.equal(legacyByOther.status, "in_progress");
  assert.equal(legacyByOther.claimedById, owner.id, "resuming must not steal the assignee");
  canonicalMutation(await taskService.updateTaskStatus(legacyOwned.id, "closed", other.id));
  await getDb().update(tasks).set({ claimedAt: oldClaimedAt }).where(eq(tasks.id, legacyOwned.id));

  const legacyResumed = canonicalMutation(
    await taskService.updateTaskStatus(legacyOwned.id, "in_progress", owner.id),
  );
  assert.equal(legacyResumed.status, "in_progress");
  assert.equal(legacyResumed.claimedById, owner.id);
  assert.ok(legacyResumed.claimedAt instanceof Date);
  assert.ok(legacyResumed.claimedAt.getTime() > oldClaimedAt.getTime());
  assert.equal(
    await taskService.claimTask(legacyUnassigned.id, "user", owner.id),
    "task is closed; reopen it before claiming",
  );
});

test("closed work advances the claim epoch when the wall clock repeats the same millisecond", async ({ app }) => {

  const originalDateNow = Date.now;
  try {
    const owner = await seedUser("task-same-tick-resume-owner");
    const server = await createServer("Task Same Tick Resume", `task-same-tick-resume-${randomUUID()}`, owner.id);
    const channel = await createChannel(server.id, "task-same-tick-resume");
    await addHuman(channel.id, owner.id);
    const frozenMs = Date.parse("2026-01-02T03:04:05.678Z");
    const oldClaimedAt = new Date(frozenMs);

    // P3: the message-task half of this test is gone. It used to seed a
    // `messages.task_*` row and assert the epoch rule held there too, because
    // un-backfilled channels still carried that shape. After the 2026-07-31
    // backfill no task exists on the message side, `resolveTaskById` is
    // canonical-only, and the message-side writer it exercised has been
    // deleted -- so that arm now asserts nothing about reachable code.
    //
    // The PROPERTY it guarded is unchanged and still asserted below on the
    // canonical shape: resuming closed work must advance the claim epoch even
    // when the wall clock returns the same millisecond, so a same-tick resume
    // cannot be mistaken for the previous claim.
    const [legacyOwned] = await getDb().insert(tasks).values({
      channelId: channel.id,
      taskNumber: 1,
      title: "same-tick legacy owned closed task",
      status: "closed",
      createdByType: "user",
      createdById: owner.id,
      claimedByType: "user",
      claimedById: owner.id,
      claimedAt: oldClaimedAt,
    }).returning();

    Date.now = () => frozenMs;

    const legacyResumed = canonicalMutation(
      await taskService.updateTaskStatus(legacyOwned.id, "in_progress", owner.id),
    );
    assert.equal(legacyResumed.claimedAt?.getTime(), frozenMs + 1);
  } finally {
    Date.now = originalDateNow;
    await app.close();
  }
});

test("legacy closed resume fails closed when assignment is removed after authorization", async ({ app }) => {

  try {
    const owner = await seedUser("task-legacy-resume-race-owner");
    const server = await createServer(
      "Task Legacy Resume Race",
      `task-legacy-resume-race-${randomUUID()}`,
      owner.id,
    );
    const channel = await createChannel(server.id, "task-legacy-resume-race");
    await addHuman(channel.id, owner.id);
    const [legacyOwned] = await getDb().insert(tasks).values({
      channelId: channel.id,
      taskNumber: 1,
      title: "legacy owned closed task with concurrent unclaim",
      status: "closed",
      createdByType: "user",
      createdById: owner.id,
      claimedByType: "user",
      claimedById: owner.id,
      claimedAt: new Date("2026-01-01T00:00:00.000Z"),
    }).returning();

    const registry = new InMemoryFailpointRegistry({
      sleep: async () => {
        await getDb().update(tasks)
          .set({
            claimedByType: null,
            claimedById: null,
            claimedAt: null,
          })
          .where(eq(tasks.id, legacyOwned.id));
      },
    });
    registry.configure("server.task.canonicalStatus.afterAuthorizationRead", {
      effect: "delay",
      payload: 0,
      mode: "once",
    });
    __setFailpointsForTests(registry);

    let result: taskService.TaskMutationResult;
    try {
      result = await taskService.updateTaskStatus(legacyOwned.id, "in_progress", owner.id);
    } finally {
      __resetFailpointsForTests();
    }

    // The refusal is unchanged in EFFECT -- the write still fails closed and
    // nothing is persisted -- but its reason string is now honest. Status is
    // member-level, so this was never a permission refusal; it is the
    // assignment-CAS catching an assignment that vanished inside the
    // authorize-then-write window, which would otherwise REVIVE a dead claim
    // via the `claimedAt` stamp.
    assert.equal(result, "task assignment changed concurrently");
    const [persisted] = await getDb().select().from(tasks).where(eq(tasks.id, legacyOwned.id));
    assert.equal(persisted.status, "closed");
    assert.equal(persisted.claimedByType, null);
    assert.equal(persisted.claimedById, null);
    assert.equal(persisted.claimedAt, null);
  } finally {
    __resetFailpointsForTests();
    await app.close();
  }
});

test("assigned creation rejects thread/joint before any row and executor-backed facts fail closed", async ({ app }) => {
  const owner = await seedUser("task-assigned-channel-owner");
  const server = await createServer("Task Assigned Channel Guard", `task-assigned-channel-${randomUUID()}`, owner.id);
  const threadLike = await createChannel(server.id, "assigned-thread-guard");
  const jointLike = await createChannel(server.id, "assigned-joint-guard");
  await addHuman(threadLike.id, owner.id);
  await addHuman(jointLike.id, owner.id);
  await getDb().update(channels).set({ type: "thread" }).where(eq(channels.id, threadLike.id));
  await getDb().update(channels).set({ type: "joint" }).where(eq(channels.id, jointLike.id));

  for (const [channelId, title] of [
    [threadLike.id, "assigned thread must fail"],
    [jointLike.id, "assigned joint must fail"],
  ] as const) {
    await assert.rejects(
      taskService.createTasksWithAssignmentReceipt(
        channelId,
        "user",
        owner.id,
        [{ title }],
        { type: "user", id: owner.id },
        { assigneeName: owner.name },
      ),
      taskService.AssignedTaskCreationChannelError,
    );
    assert.deepEqual(
      await getDb().select({ id: messages.id }).from(messages).where(eq(messages.content, title)),
      [],
    );

    const [channel] = await getDb().select().from(channels).where(eq(channels.id, channelId));
    const [persisted] = await getDb().insert(messages).values({
      channelId,
      senderType: "user",
      senderId: owner.id,
      messageType: "chat",
      content: `executor fact guard: ${title}`,
      taskStatus: "todo",
      taskNumber: 1,
    }).returning();
    assert.ok(channel && persisted);
    await assert.rejects(
      messageService.recordInboxFactsForPersistedMessages([persisted], {
        inboxFactPolicy: {
          mode: "record",
          producer: "task.body",
          reason: "test executor-backed fact target guard",
        },
        executor: getDb(),
        channel,
      }),
      channel.type === "joint"
        ? /Executor-backed persisted facts for joint channels require frozen projections/
        : new RegExp(`Executor-backed persisted facts do not support ${channel.type} channels`),
    );
  }
});

test("claim rejection: writer builds the conflict from the same observed row as the reason", async ({ app }) => {
  const owner = await seedUser("claim-conflict-owner");
  const server = await createServer("Claim Conflict", `claim-conflict-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "claim-conflict");
  await addHuman(channel.id, owner.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "conflict projection" }]);
  const claimed = await taskService.claimTask(task.id, "user", owner.id);
  assert.notEqual(typeof claimed, "string");

  const rival = await seedUser("claim-conflict-rival");
  const outcome = await taskService.claimTaskDetailed(task.id, "user", rival.id);
  assert.equal(typeof outcome.result, "string");
  const conflict = outcome.conflict;
  assert.ok(conflict, "held-by-other failure must carry a claim_conflict from the writer");
  assert.equal(conflict.kind, "claim_conflict");
  assert.equal(conflict.conflictScope, "implementation_execution");
  // blockedActions is the authoritative CLOSED set; the examples list is
  // advisory and must include the request path without granting it.
  assert.deepEqual(conflict.blockedActions, ["start_conflicting_execution"]);
  assert.deepEqual(
    conflict.unblockedActionExamples,
    ["read", "coordinate", "review", "request_reassign", "handoff"],
  );
  // Snapshot congruence: the prose reason and the structured assignee are
  // projections of one observation — the @name in the reason IS the
  // conflict assignee, not a second read.
  assert.equal(outcome.result, `already assigned to @${conflict.currentAssignee?.name}`);
  assert.equal(conflict.currentAssignee?.type, "user");
  assert.equal(conflict.currentAssignee?.name, owner.name);
  assert.equal(typeof conflict.taskStatus, "string");
  assert.ok(conflict.claimedAt && !Number.isNaN(Date.parse(conflict.claimedAt)));
  assert.ok(!Number.isNaN(Date.parse(conflict.observedAt)));

  // Snapshot, not live reference: post-failure unclaim must not mutate the
  // already-returned conflict object.
  const frozenAssignee = conflict.currentAssignee?.name;
  const unclaimed = await taskService.unclaimTask(task.id, "user", owner.id);
  assert.notEqual(typeof unclaimed, "string");
  assert.equal(conflict.currentAssignee?.name, frozenAssignee);

  // After the holder released the lock, a fresh attempt succeeds — the
  // conflict was a property of the failed observation, not of the task.
  const retried = await taskService.claimTaskDetailed(task.id, "user", rival.id);
  assert.notEqual(typeof retried.result, "string");
  assert.equal(retried.conflict, undefined);

  // Self-claim failure is not a conflict with someone else: prose-only.
  const selfOutcome = await taskService.claimTaskDetailed(task.id, "user", rival.id);
  assert.equal(selfOutcome.result, "already claimed by you");
  assert.equal(selfOutcome.conflict, undefined);

  // Unknown task refs stay prose-only through the detailed path too.
  const missing = await taskService.claimTaskDetailed(randomUUID(), "user", rival.id);
  assert.equal(missing.result, "task not found");
  assert.equal(missing.conflict, undefined);
});

test("batchClaimTasks: assignment-held failure rows carry the writer-built conflict", async ({ app }) => {
  const owner = await seedUser("batch-conflict-owner");
  const server = await createServer("Batch Conflict", `batch-conflict-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "batch-conflict");
  await addHuman(channel.id, owner.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "batch conflict" }]);
  const first = await taskService.batchClaimTasks(channel.id, [task.taskNumber!], "user", owner.id);
  assert.equal(first[0]?.success, true);

  const rival = await seedUser("batch-conflict-rival");
  const [failed] = await taskService.batchClaimTasks(channel.id, [task.taskNumber!], "user", rival.id);
  assert.equal(failed?.success, false);
  assert.equal(failed?.reason, `already assigned to @${owner.name}`);
  assert.equal(failed?.conflict?.kind, "claim_conflict");
  assert.equal(failed?.conflict?.currentAssignee?.name, owner.name);

  // Unknown number: prose-only, no conflict fabricated.
  const [missing] = await taskService.batchClaimTasks(channel.id, [999999], "user", rival.id);
  assert.equal(missing?.success, false);
  assert.equal(missing?.reason, "task not found");
  assert.equal(missing?.conflict, undefined);
});

test("claim rejection temporal congruence: within-call state change cannot alter the writer's observation", async ({ app }) => {

  try {
    const owner = await seedUser("congruence-owner");
    const server = await createServer("Claim Congruence", `claim-congruence-${randomUUID()}`, owner.id);
    const channel = await createChannel(server.id, "claim-congruence");
    await addHuman(channel.id, owner.id);
    const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "congruence seam" }]);
    const claimed = await taskService.claimTask(task.id, "user", owner.id);
    assert.notEqual(typeof claimed, "string");

    // At the seam — after the writer formed its rejection, before
    // claimTaskDetailed returns — the holder unclaims. A post-hoc re-read at
    // return time would now find the task unassigned and produce NO conflict
    // (or a different assignee); the writer's own observation must survive.
    const registry = new InMemoryFailpointRegistry({
      sleep: async () => {
        await getDb().update(tasks)
          .set({ claimedByType: null, claimedById: null, claimedAt: null })
          .where(eq(tasks.id, task.id));
      },
    });
    registry.configure("server.task.claimDetailed.afterRejectionFormed", {
      effect: "delay",
      payload: 0,
      mode: "once",
    });
    __setFailpointsForTests(registry);

    const rival = await seedUser("congruence-rival");
    let outcome: taskService.TaskClaimOutcome;
    try {
      outcome = await taskService.claimTaskDetailed(task.id, "user", rival.id);
    } finally {
      __resetFailpointsForTests();
    }

    // The seam mutation really happened: the task is unassigned NOW.
    const [persisted] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
    assert.equal(persisted!.claimedById, null, "seam unclaim must have committed before the call returned");

    // ...and yet the returned outcome is the writer's observation, intact.
    assert.equal(outcome.result, `already assigned to @${owner.name}`);
    const conflict = outcome.conflict;
    assert.ok(conflict, "conflict must be the writer's observation, not a post-hoc re-read of the now-unassigned row");
    assert.equal(conflict.currentAssignee?.name, owner.name);
    assert.equal(conflict.currentAssignee?.type, "user");
    assert.ok(conflict.claimedAt, "writer observed a held claim; a re-read after the seam would have no claimedAt");
  } finally {
    __resetFailpointsForTests();
    await app.close();
  }
});
