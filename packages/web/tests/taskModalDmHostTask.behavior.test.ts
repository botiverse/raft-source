import assert from "node:assert/strict";
import test from "node:test";

import {
  loadThreadParentTasksIfNeeded,
  resolveThreadHostTask,
} from "../src/components/layout/threadHostTask";
import type { Task } from "../src/store/taskStore";

/**
 * @artin, task #44: a task created in a DM could not have its status changed.
 *
 * The task modal's status control lives in TaskProperties, which only mounts
 * under TaskModalHead, which only renders when `hostTask` resolves. Two lists
 * fed that lookup and neither could hold a DM task when the thread was opened
 * from somewhere else (Activity):
 *
 *   - `tasks` holds only the channel the user currently has open;
 *   - `serverTasks` comes from listServerTasks, which selects
 *     `type in ('channel','joint')` — dm and private are excluded BY DESIGN,
 *     so a server-wide board does not list what happens in someone's DMs.
 *
 * Neither is wrong alone. Together they left the user a bare thread viewer with
 * no task affordance at all. The fix adds the parent channel's own bucket as a
 * source; these tests hold that source in place.
 */

const task = (id: string, messageId: string): Task => ({
  id,
  messageId,
  channelId: "dm-channel",
  taskNumber: 1,
  title: `task ${id}`,
  status: "todo",
  createdByType: "human",
  createdById: "u1",
} as unknown as Task);

test("a DM task resolves from the parent channel bucket when it is in no other list", () => {
  const dmTask = task("t-dm", "msg-dm");
  // Exactly the production shape: the DM is not the open channel, and
  // serverTasks structurally cannot carry it.
  const resolved = resolveThreadHostTask("msg-dm", {
    tasks: [],
    parentChannelTasks: [dmTask],
    serverTasks: [],
  });
  assert.equal(resolved, dmTask, "DM task must resolve, else TaskModalHead never mounts and status cannot be changed");
});

test("the parent-channel bucket is a real third source, not a duplicate of the other two", () => {
  // Teeth: if someone deletes the parentChannelTasks lookup, this is the case
  // that fails — the other two lists are empty and cannot mask its removal.
  const dmTask = task("t-dm", "msg-dm");
  assert.equal(resolveThreadHostTask("msg-dm", { tasks: [], parentChannelTasks: [], serverTasks: [] }), null);
  assert.equal(resolveThreadHostTask("msg-dm", { tasks: [], parentChannelTasks: [dmTask], serverTasks: [] }), dmTask);
});

test("channel tasks still resolve from the pre-existing sources", () => {
  const openChannelTask = task("t-open", "msg-open");
  const serverTask = task("t-server", "msg-server");
  assert.equal(
    resolveThreadHostTask("msg-open", { tasks: [openChannelTask], parentChannelTasks: [], serverTasks: [] }),
    openChannelTask,
  );
  assert.equal(
    resolveThreadHostTask("msg-server", { tasks: [], parentChannelTasks: [], serverTasks: [serverTask] }),
    serverTask,
  );
});

test("a thread whose parent is not a task resolves to null", () => {
  assert.equal(resolveThreadHostTask("msg-plain", { tasks: [], parentChannelTasks: [], serverTasks: [] }), null);
  assert.equal(resolveThreadHostTask(null, { tasks: [], parentChannelTasks: [], serverTasks: [] }), null);
});

test("the parent channel's tasks are fetched on demand, so the bucket is not always empty", () => {
  const loaded: string[] = [];
  const loadTasks = (channelId: string) => loaded.push(channelId);

  assert.equal(loadThreadParentTasksIfNeeded({
    parentMessageId: "msg-dm",
    parentChannelId: "dm-channel",
    parentLoaded: false,
    parentLoading: false,
    loadTasks,
  }), true);
  assert.deepEqual(loaded, ["dm-channel"]);

  for (const blocked of [
    { parentMessageId: null, parentChannelId: "dm-channel", parentLoaded: false, parentLoading: false },
    { parentMessageId: "msg-dm", parentChannelId: null, parentLoaded: false, parentLoading: false },
    { parentMessageId: "msg-dm", parentChannelId: "dm-channel", parentLoaded: true, parentLoading: false },
    { parentMessageId: "msg-dm", parentChannelId: "dm-channel", parentLoaded: false, parentLoading: true },
  ]) {
    assert.equal(loadThreadParentTasksIfNeeded({ ...blocked, loadTasks }), false);
  }
  assert.deepEqual(loaded, ["dm-channel"], "loaded/loading or unanchored threads must not fetch again");
});
