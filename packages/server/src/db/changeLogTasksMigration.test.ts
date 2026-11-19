import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { tasks, users } from "./schema";
import { createServer } from "../services/serverService";
import { addHuman, createChannel } from "../services/channelService";
import * as taskService from "../services/taskService";

// change_log: the `task` entity (0710_change_log_tasks.sql). Every create,
// delete and change the task list shows is one row in the task's channel
// scope; bookkeeping is not; a move is a delete in the old channel and an
// upsert in the new one; the status cleanup's switch logs nothing.

type Row = { scope_kind: string; scope_id: string; server_id: string | null; entity: string; entity_id: string; op: string };

test("change_log logs a task's create, shown changes, move and delete in its channel's scope; not bookkeeping, not under the cleanup switch", async ({ db }) => {
  const watermark = async () => Number((await db.execute(sql`SELECT COALESCE(max(seq), 0) AS m FROM change_log`)).rows[0]!.m);
  const since = async (from: number) => ((await db.execute(sql`
    SELECT scope_kind, scope_id::text, server_id::text, entity, entity_id, op
    FROM change_log WHERE seq > ${from} ORDER BY seq`)).rows as Row[]).filter((r) => r.entity === "task");
  const [owner] = await db.insert(users).values({ email: "clt-owner@test.com", name: "cltOwner", passwordHash: "x", emailVerified: true }).returning();
  const server = await createServer("Tasks", "clt-tasks", owner!.id);
  const channel = await createChannel(server.id, "clt-one");
  const other = await createChannel(server.id, "clt-two");
  await addHuman(channel.id, owner!.id);
  await addHuman(other.id, owner!.id);

  let mark = await watermark();
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner!.id, [{ title: "Ship it" }]);
  const created = (await since(mark)).map((r) => [r.scope_kind, r.scope_id, r.server_id, r.entity_id, r.op]);
  assert.ok(created.length >= 1, "a create is logged");
  // (Flag off, the create also links its host message: a second upsert, the same.)
  for (const row of created) assert.deepEqual(row, ["channel", channel.id, server.id, task!.id, "upsert"], "an upsert in its channel's scope");

  mark = await watermark();
  await db.update(tasks).set({ status: "in_progress" }).where(sql`id = ${task!.id}`);
  await db.update(tasks).set({ title: "Ship it now" }).where(sql`id = ${task!.id}`);
  assert.deepEqual((await since(mark)).map((r) => [r.entity_id, r.op]), [[task!.id, "upsert"], [task!.id, "upsert"]]);

  mark = await watermark();
  await db.update(tasks).set({ updatedAt: new Date(), lastActivityAt: new Date() }).where(sql`id = ${task!.id}`);
  await db.update(tasks).set({ status: "in_progress" }).where(sql`id = ${task!.id}`);
  assert.deepEqual(await since(mark), [], "bookkeeping and a write that changes nothing are not logged");

  mark = await watermark();
  await db.update(tasks).set({ channelId: other.id }).where(sql`id = ${task!.id}`);
  assert.deepEqual((await since(mark)).map((r) => [r.scope_id, r.entity_id, r.op]), [
    [channel.id, task!.id, "delete"],
    [other.id, task!.id, "upsert"],
  ], "a move leaves the old channel's list and joins the new one");

  mark = await watermark();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL slock.task_status_cleanup = 'on'`);
    await tx.update(tasks).set({ status: "done" }).where(sql`id = ${task!.id}`);
  });
  assert.deepEqual(await since(mark), [], "the status cleanup's switch: no per-task row");
  await db.update(tasks).set({ status: "todo" }).where(sql`id = ${task!.id}`);
  assert.equal((await since(mark)).length, 1, "the switch ended with its transaction");

  mark = await watermark();
  await db.delete(tasks).where(sql`id = ${task!.id}`);
  assert.deepEqual((await since(mark)).map((r) => [r.scope_id, r.entity_id, r.op]), [[other.id, task!.id, "delete"]]);
});
