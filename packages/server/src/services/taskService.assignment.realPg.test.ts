import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";

import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import * as schema from "../db/schema.js";
import { agents, channelAgents, channels, messages, tasks, users } from "../db/schema.js";
import { addAgent, addHuman, createChannel } from "./channelService.js";
import { createAgent, deleteAgent } from "./agentService.js";
import { createServer } from "./serverService.js";
import {
  batchClaimTasks,
  claimTask,
  createTasks,
  createTasksWithAssignmentReceipt,
  forceUpdateTaskStatus,
  TaskCreationAssigneeEligibilityError,
  unclaimTask,
  updateTaskStatus,
} from "./taskService.js";

// Force is an admin override; the actor is now required so the audit trail can
// name who overrode the state machine. These call sites are arrangement, not
// the property under test.
const ADMIN_FORCE_ACTOR_ID = "00000000-0000-0000-0000-0000000000ad";

const REAL_PG_URL_ENV = "TASK_ASSIGNMENT_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.TASK_ASSIGNMENT_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

async function waitForLockWaiter(observer: pg.Client, minimumCount = 1, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // The observer is deliberately inside the blocker transaction. PostgreSQL
    // caches cumulative-statistics snapshots per transaction unless cleared,
    // which would otherwise hide a second waiter queued after the first poll.
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const result = await observer.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `);
    if ((result.rows[0]?.count ?? 0) >= minimumCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${minimumCount} backends did not reach a lock wait: deterministic race was not exercised`);
}

test(
  "real PostgreSQL assignment eligibility removal and preassigned-claim CAS each have one winner",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_task73_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "task73-real-pg-admin" });
    let setupPool: pg.Pool | null = null;
    let blocker: pg.Client | null = null;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "task73-real-pg-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = null;

      await initDatabase(testUrl);
      const db = getDb();
      const suffix = randomUUID().slice(0, 8);
      const [owner] = await db.insert(users).values({
        email: `task73-owner-${suffix}@slock.test`,
        name: `task73-owner-${suffix}`,
        passwordHash: "test-only",
        emailVerified: true,
      }).returning();
      const server = await createServer("Task 73 Real PG", `task73-real-pg-${suffix}`, owner.id);
      const channel = await createChannel(server.id, `task73-real-pg-${suffix}`);
      await addHuman(channel.id, owner.id);
      const target = await createAgent(server.id, `task73-target-${suffix}`, { runtime: "external", model: "external" });
      await addAgent(channel.id, target.id);

      blocker = new pg.Client({ connectionString: testUrl, application_name: "task73-real-pg-blocker" });
      await blocker.connect();

      // deleteAgent locks identity before its DM channel. Queue deletion ahead
      // of assigned creation on the same identity and prove creation holds no
      // channel row lock while waiting: deletion wins without deadlock and the
      // assigned transaction leaves no half-product.
      const deletedTarget = await createAgent(server.id, `task73-deleted-target-${suffix}`, {
        runtime: "external",
        model: "external",
      });
      const deletedTargetDm = await createChannel(server.id, `task73-deleted-dm-${suffix}`);
      await addHuman(deletedTargetDm.id, owner.id);
      await addAgent(deletedTargetDm.id, deletedTarget.id);
      await db.update(channels).set({ type: "dm" }).where(eq(channels.id, deletedTargetDm.id));

      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM agents WHERE id = $1 FOR UPDATE", [deletedTarget.id]);
      const pendingDelete = deleteAgent(deletedTarget.id);
      await waitForLockWaiter(blocker);
      const deletedRaceTitle = "assigned DM creation loses to agent deletion";
      const pendingDeletedCreate = createTasksWithAssignmentReceipt(
        deletedTargetDm.id,
        "user",
        owner.id,
        [{ title: deletedRaceTitle }],
        { type: "agent", id: deletedTarget.id },
        { assigneeName: deletedTarget.name },
      );
      const pendingDeletedCreateRejection = assert.rejects(
        pendingDeletedCreate,
        TaskCreationAssigneeEligibilityError,
      );
      await waitForLockWaiter(blocker, 2);
      await blocker.query("COMMIT");
      await pendingDelete;
      await pendingDeletedCreateRejection;
      const [deletedAgentFinal] = await db.select().from(agents).where(eq(agents.id, deletedTarget.id));
      const [deletedDmFinal] = await db.select().from(channels).where(eq(channels.id, deletedTargetDm.id));
      assert.ok(deletedAgentFinal?.deletedAt instanceof Date);
      assert.ok(deletedDmFinal?.deletedAt instanceof Date);
      assert.deepEqual(
        await db.select({ id: messages.id }).from(messages).where(eq(messages.content, deletedRaceTitle)),
        [],
      );
      assert.deepEqual(
        await db.select({ agentId: channelAgents.agentId }).from(channelAgents).where(eq(channelAgents.agentId, deletedTarget.id)),
        [],
      );

      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [channel.id]);

      const pendingCreate = createTasksWithAssignmentReceipt(
        channel.id,
        "user",
        owner.id,
        [{ title: "must not survive eligibility race" }],
        { type: "agent", id: target.id },
        { assigneeName: target.name },
      );

      // createTasks is now queued before its authoritative in-transaction
      // eligibility check. Removing membership first must make it fail closed
      // once the allocator lock is released, with no task/message insertion.
      await blocker.query("DELETE FROM channel_agents WHERE channel_id = $1 AND agent_id = $2", [channel.id, target.id]);
      await blocker.query("COMMIT");

      await assert.rejects(pendingCreate, (error: unknown) => {
        assert.ok(error instanceof TaskCreationAssigneeEligibilityError);
        assert.equal(error.code, "assignee_cannot_claim");
        return true;
      });
      assert.deepEqual(
        await db.select({ id: messages.id }).from(messages).where(eq(messages.content, "must not survive eligibility race")),
        [],
      );
      assert.deepEqual(
        await db.select({ agentId: channelAgents.agentId }).from(channelAgents).where(eq(channelAgents.channelId, channel.id)),
        [],
      );

      await addAgent(channel.id, target.id);
      const { tasks: [reserved] } = await createTasksWithAssignmentReceipt(
        channel.id,
        "user",
        owner.id,
        [{ title: "single winner preassigned claim" }],
        { type: "agent", id: target.id },
        { assigneeName: target.name },
      );
      const concurrentClaims = await Promise.all([
        claimTask(reserved.id, "agent", target.id),
        claimTask(reserved.id, "agent", target.id),
      ]);
      assert.equal(concurrentClaims.filter((result) => typeof result !== "string").length, 1);
      assert.deepEqual(
        concurrentClaims.filter((result): result is string => typeof result === "string"),
        ["already claimed by you"],
      );

      // Direct claim reads without a row lock, then blocks at the shared claim
      // writer. A different winner commits first, proving the helper's CAS (not
      // timing or a duplicated direct-only predicate) rejects the stale read.
      const { tasks: [directRaceTask] } = await createTasks(
        channel.id,
        "user",
        owner.id,
        [{ title: "direct claim stale pre-read" }],
      );
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [directRaceTask.id]);
      const pendingDirect = claimTask(directRaceTask.id, "agent", target.id);
      await waitForLockWaiter(blocker);
      // Bumping `revision` is what the canonical writer CASes on — this is the
      // v1.4 equivalent of the field-by-field message CAS below it.
      await blocker.query(
        "UPDATE tasks SET claimed_by_type = 'user', claimed_by_id = $1, "
          + "status = 'in_progress', claimed_at = now(), revision = revision + 1 WHERE id = $2",
        [owner.id, directRaceTask.id],
      );
      await blocker.query("COMMIT");
      assert.equal(await pendingDirect, `already assigned to @${owner.name}`);

      // Batch keeps SELECT FOR UPDATE serialization, then delegates the actual
      // write to the same helper. This is the honest #4216 negative control:
      // the loser observes the committed winner and never reports success.
      const { tasks: [batchRaceTask] } = await createTasks(
        channel.id,
        "user",
        owner.id,
        [{ title: "batch claim serialized loser" }],
      );
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [batchRaceTask.id]);
      const pendingBatch = batchClaimTasks(
        channel.id,
        [batchRaceTask.taskNumber],
        "agent",
        target.id,
      );
      await waitForLockWaiter(blocker);
      await blocker.query(
        "UPDATE tasks SET claimed_by_type = 'user', claimed_by_id = $1, "
          + "status = 'in_progress', claimed_at = now(), revision = revision + 1 WHERE id = $2",
        [owner.id, batchRaceTask.id],
      );
      await blocker.query("COMMIT");
      // PRE-EXISTING STALENESS, not part of the assignee/permission work:
      // #5559 added a `conflict` payload to batch-claim results and did not
      // update this assertion. It went unnoticed because no workflow runs this
      // real-PG gate -- it is red on `staging` too. Kept green here by asserting
      // the race outcome and the conflict payload separately.
      const batchResults = (await pendingBatch).map(({ task: _task, conflict, ...result }) => ({
        ...result,
        hasConflict: conflict != null,
      }));
      assert.deepEqual(batchResults, [{
        taskNumber: batchRaceTask.taskNumber,
        success: false,
        reason: `already assigned to @${owner.name}`,
        hasConflict: true,
      }]);

      const { tasks: [statusRaceTask] } = await createTasksWithAssignmentReceipt(
        channel.id,
        "user",
        owner.id,
        [{ title: "status start loses to unclaim" }],
        { type: "agent", id: target.id },
        { assigneeName: target.name },
      );
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [statusRaceTask.id]);
      const pendingStatusStart = updateTaskStatus(statusRaceTask.id, "in_progress", target.id);
      await waitForLockWaiter(blocker);
      await blocker.query(
        "UPDATE tasks SET claimed_by_type = NULL, claimed_by_id = NULL, "
          + "claimed_at = NULL, revision = revision + 1, updated_at = now() WHERE id = $1",
        [statusRaceTask.id],
      );
      await blocker.query("COMMIT");
      // Status is member-level now, so this refusal was never a permission
      // check; it is the ownership-integrity CAS catching an assignment that
      // was removed inside the authorize-then-write window. Same reason string
      // as the force path below, which already used it.
      assert.equal(await pendingStatusStart, "task assignment changed concurrently");
      const [statusRaceFinal] = await db.select().from(tasks).where(eq(tasks.id, statusRaceTask.id));
      assert.equal(statusRaceFinal?.status, "todo");
      assert.equal(statusRaceFinal?.claimedById, null);

      const { tasks: [unclaimRaceTask] } = await createTasksWithAssignmentReceipt(
        channel.id,
        "user",
        owner.id,
        [{ title: "unclaim loses to status start" }],
        { type: "agent", id: target.id },
        { assigneeName: target.name },
      );
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [unclaimRaceTask.id]);
      const pendingUnclaim = unclaimTask(unclaimRaceTask.id, "agent", target.id);
      await waitForLockWaiter(blocker);
      await blocker.query(
        "UPDATE tasks SET status = 'in_progress', claimed_at = now(), "
          + "revision = revision + 1, updated_at = now() WHERE id = $1",
        [unclaimRaceTask.id],
      );
      await blocker.query("COMMIT");
      assert.equal(await pendingUnclaim, "task state changed concurrently");
      const [unclaimRaceFinal] = await db.select().from(tasks).where(eq(tasks.id, unclaimRaceTask.id));
      assert.equal(unclaimRaceFinal?.status, "in_progress");
      assert.equal(unclaimRaceFinal?.claimedById, target.id);

      const { tasks: [forceRaceTask] } = await createTasksWithAssignmentReceipt(
        channel.id,
        "user",
        owner.id,
        [{ title: "force start loses to unclaim" }],
        { type: "agent", id: target.id },
        { assigneeName: target.name },
      );
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [forceRaceTask.id]);
      const pendingForceStart = forceUpdateTaskStatus(forceRaceTask.id, "in_progress", "user", ADMIN_FORCE_ACTOR_ID);
      await waitForLockWaiter(blocker);
      await blocker.query(
        "UPDATE tasks SET claimed_by_type = NULL, claimed_by_id = NULL, "
          + "claimed_at = NULL, revision = revision + 1, updated_at = now() WHERE id = $1",
        [forceRaceTask.id],
      );
      await blocker.query("COMMIT");
      assert.equal(await pendingForceStart, "task assignment changed concurrently");
      const [forceRaceFinal] = await db.select().from(tasks).where(eq(tasks.id, forceRaceTask.id));
      assert.equal(forceRaceFinal?.status, "todo");
      assert.equal(forceRaceFinal?.claimedById, null);
    } finally {
      if (blocker) await blocker.end().catch(() => {});
      if (setupPool) await setupPool.end().catch(() => {});
      await closeDatabase().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  },
);
