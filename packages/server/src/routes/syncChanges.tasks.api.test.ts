import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { SyncChange, SyncChangesResponse } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { tasks } from "../db/schema";
import * as taskService from "../services/taskService";

// GET /api/sync/changes, the `task` entity (#wg-task-v2:7b87bf4a; 0710): an
// upsert carries the task as GET /api/tasks/channel/:id lists it to the
// viewer; a delete names its channel; a move is a delete in the old channel
// and an upsert in the new one; a channel's bulk change is one `resnapshot`.

const test = createApiTest();

type Client = { get(path: string): Promise<Response> };

async function sync(client: Client, since?: string): Promise<SyncChangesResponse> {
  const res = await client.get(`/api/sync/changes${since ? `?since=${encodeURIComponent(since)}` : ""}`);
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as SyncChangesResponse;
}

async function listRow(client: Client, channelId: string, taskId: string) {
  const res = await client.get(`/api/tasks/channel/${channelId}`);
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { tasks: Array<{ id: string }> }).tasks.find((task) => task.id === taskId);
}

const taskChanges = (response: SyncChangesResponse) => response.changes.filter((change): change is Extract<SyncChange, { entity: "task" }> => change.entity === "task");

test("a task change is an upsert carrying the GET /api/tasks/channel/:id row; only to viewers of its channel", async ({ seed, http }) => {
  const owner = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner, members: [outsider] });
  const channel = await seed.channel({ server, members: [owner], visibility: "private" });
  const client = http.as(owner, server);
  const outsiderClient = http.as(outsider, server);
  const start = await sync(client);
  const outsiderStart = await sync(outsiderClient);

  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "Write the sync rows" }]);
  await taskService.updateTaskStatus(task!.id, "in_progress", owner.id, "user", server.id);

  const round = await sync(client, start.cursor);
  const changes = taskChanges(round);
  assert.equal(changes.length, 1, "the create and the status change coalesce");
  const change = changes[0]!;
  assert.equal(change.op, "upsert");
  assert.equal(change.id, task!.id);
  assert.deepEqual(change.op === "upsert" ? change.row : null, await listRow(client, channel.id, task!.id), "the row is the list's row");

  assert.deepEqual(taskChanges(await sync(outsiderClient, outsiderStart.cursor)), [], "a private channel's tasks do not reach a non-member");
});

test("a deleted task is a delete naming its channel; a moved task a delete in the old channel and an upsert in the new one", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const other = await seed.channel({ server, members: [owner] });
  const client = http.as(owner, server);
  const { tasks: [moved, deleted] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "moves" }, { title: "goes" }]);
  const start = await sync(client);

  await db.update(tasks).set({ channelId: other.id }).where(sql`id = ${moved!.id}`);
  await db.delete(tasks).where(sql`id = ${deleted!.id}`);

  const changes = taskChanges(await sync(client, start.cursor));
  assert.deepEqual(changes.map((change) => [change.id, change.op, "channelId" in change ? change.channelId : null, change.op === "upsert" ? (change.row as { channelId: string }).channelId : null]), [
    [moved!.id, "delete", channel.id, null],
    [moved!.id, "upsert", null, other.id],
    [deleted!.id, "delete", channel.id, null],
  ]);
});

test("a channel's bulk task change (the status cleanup's task_channel row) is one resnapshot of that channel's tasks", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const hidden = await seed.channel({ server, members: [], visibility: "private" });
  const client = http.as(owner, server);
  const start = await sync(client);

  for (const target of [channel, hidden]) {
    await db.execute(sql`SELECT public.change_log_add(${server.id}::uuid, 'channel', ${target.id}::uuid, NULL, 'task_channel', ${target.id}, 'upsert')`);
  }

  assert.deepEqual(taskChanges(await sync(client, start.cursor)).map((change) => [change.entity, change.id, change.op]), [
    ["task", channel.id, "resnapshot"],
  ], "only for a channel the viewer sees");
});
