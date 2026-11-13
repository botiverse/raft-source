import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./index";
import { taskEvents, tasks } from "./schema";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
import * as taskService from "../services/taskService";
import { ensureTaskConversation } from "../services/taskConversationService";

// Task v2: in_review is retired for task v2 tasks (#wg-task-v2:f7043517). The
// migration moves the task v2 tasks already in in_review to in_progress. This
// executes the MIGRATION FILE ITSELF, read off disk, so the shipped SQL and
// what is tested cannot drift apart (see deferRemovalBackfill.test.ts).
const MIGRATION_FILE = "0554_task_v2_retire_in_review.sql";
const MIGRATION_PATH = fileURLToPath(new URL(`../../drizzle/${MIGRATION_FILE}`, import.meta.url));

function readMigrationStatements(path = MIGRATION_PATH): string[] {
  const body = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const statements = body.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  assert.ok(statements.some((s) => /UPDATE\s+"tasks"/i.test(s)), `${MIGRATION_FILE} no longer updates tasks`);
  return statements;
}

/** One migration run: drizzle runs a migration's statements in one transaction. */
async function runMigration() {
  const statements = readMigrationStatements();
  await getDb().transaction(async (tx) => {
    for (const statement of statements) await tx.execute(sql.raw(statement));
  });
}

async function rowOf(taskId: string) {
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
  assert.ok(row, `task ${taskId} exists`);
  return row;
}

async function eventsOf(taskIds: string[]) {
  return getDb().select().from(taskEvents).where(inArray(taskEvents.taskId, taskIds));
}

test("in_review retired for task v2: the migration moves task v2 tasks in in_review to in_progress, with one system event each; pre-v2 tasks keep in_review", async ({ seed }) => {
  const db = getDb();
  const owner = await seed.human({ name: "retire-owner" });
  const worker = await seed.human({ name: "retire-worker" });
  const server = await seed.server({ owner, members: [worker] });
  const channel = await seed.channel({ server, members: [owner, worker], name: "retire" });

  // Pre-v2 tasks (flag off): one keeps its host thread, one gets its conversation below.
  const { tasks: [preV2, preV2WithConversation] } = await taskService.createTasks(
    channel.id, "user", owner.id, [{ title: "pre-v2 in review" }, { title: "pre-v2, conversation since" }],
  );
  await enableTaskV2ConversationsForServer(server.id);
  assert.ok(await ensureTaskConversation(preV2WithConversation!.id, { initiatingServerId: server.id }));
  // Created the v2 way: one in review (no conversation yet), one still to do.
  const { tasks: [v2InReview, v2Todo] } = await taskService.createTasks(
    channel.id, "user", owner.id, [{ title: "v2 in review" }, { title: "v2 todo" }],
  );
  assert.equal((await rowOf(v2InReview!.id)).ownConversation, true);
  assert.equal((await rowOf(v2InReview!.id)).conversationChannelId, null);

  const inReview = [preV2!.id, preV2WithConversation!.id, v2InReview!.id];
  // The shape the previous release left: in_review, assigned, revision moved on.
  const longAgo = new Date("2026-10-01T00:00:00.000Z");
  await db.update(tasks)
    .set({ status: "in_review", claimedByType: "user", claimedById: worker.id, claimedAt: longAgo, revision: 3, updatedAt: longAgo })
    .where(inArray(tasks.id, inReview));
  const before = new Map(await Promise.all([...inReview, v2Todo!.id].map(async (id) => [id, await rowOf(id)] as const)));
  const eventsBefore = (await eventsOf([...inReview, v2Todo!.id])).length;

  await runMigration();

  for (const id of [v2InReview!.id, preV2WithConversation!.id]) {
    const row = await rowOf(id);
    const was = before.get(id)!;
    assert.equal(row.status, "in_progress", "a task v2 task leaves in_review");
    assert.equal(row.revision, was.revision + 1, "revision bumped, as every task write does");
    assert.ok(row.updatedAt.getTime() > was.updatedAt.getTime(), "updated_at stamped");
    assert.equal(row.claimedById, worker.id, "assignee unchanged");
    assert.equal(row.claimedAt?.getTime(), was.claimedAt?.getTime(), "start epoch unchanged");
    const events = (await eventsOf([id])).filter((e) => e.payload?.reason === "in_review_retired_for_task_v2");
    assert.equal(events.length, 1, "one event per task");
    assert.equal(events[0]!.eventType, "status_changed");
    assert.equal(events[0]!.actorType, "system");
    assert.equal(events[0]!.actorId, null);
    assert.deepEqual(events[0]!.payload, { from: "in_review", to: "in_progress", reason: "in_review_retired_for_task_v2" });
  }

  const preV2Row = await rowOf(preV2!.id);
  assert.equal(preV2Row.status, "in_review", "a pre-v2 task without a conversation keeps in_review");
  assert.equal(preV2Row.revision, before.get(preV2!.id)!.revision);
  const todoRow = await rowOf(v2Todo!.id);
  assert.equal(todoRow.status, "todo", "only in_review moves");
  assert.equal(todoRow.revision, before.get(v2Todo!.id)!.revision);
  assert.equal((await eventsOf([...inReview, v2Todo!.id])).length, eventsBefore + 2, "events only for the two moved tasks");

  // Idempotent: a second run finds nothing to move.
  await runMigration();
  assert.equal((await eventsOf([...inReview, v2Todo!.id])).length, eventsBefore + 2);
  assert.equal((await rowOf(v2InReview!.id)).revision, before.get(v2InReview!.id)!.revision + 1);
});

test("in_review retired for task v2: the rerun (0593) is the same statements as 0554", () => {
  const rerun = fileURLToPath(new URL("../../drizzle/0593_task_v2_retire_in_review_rerun.sql", import.meta.url));
  assert.deepEqual(readMigrationStatements(rerun), readMigrationStatements());
});
