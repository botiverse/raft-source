// Task v2, per-task mode: a task made the v2 way (its DTO says its discussion
// is its own conversation: `conversationAnchored`, a `conversationChannelId`,
// or no real host message) opens its task dialog whatever the
// `task_v2_conversations_v0` flag says now — rollback, the flag-off side of a
// joint channel, a client that has not refreshed the flag. Its `messageId` is
// only the task id (a compatibility fallback), so opening it as a message
// thread would land on a message that does not exist. A pre-v2 task with the
// flag off opens its host message's thread exactly as before task v2.

import assert from "node:assert/strict";

import api from "../src/api/client";
import type { Task } from "../src/store/taskStore";
import { useThreadStore } from "../src/store/threadStore";
import type { OpenThreadRequest } from "../src/store/threadStore";
import { openTaskByChannelNumber } from "../src/utils/openTaskRef";
import type { OpenTaskRefDeps } from "../src/utils/openTaskRef";
import { openTaskConversationDialog } from "../src/components/task/useOpenTask";
import {
  formatTaskConversationParam,
  isTaskV2Task,
  opensAsTaskConversation,
} from "../src/utils/taskConversation";

const CHANNEL_ID = "channel-1";
const originalGet = api.get.bind(api);
const initialThreadState = useThreadStore.getState();

afterEach(() => {
  api.get = originalGet;
  useThreadStore.setState(initialThreadState, true);
});

function makeTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    messageId: overrides.id,
    channelId: CHANNEL_ID,
    channelType: "channel",
    taskNumber: 7,
    title: "Ship it",
    status: "todo",
    createdById: "user-1",
    createdByType: "user",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

// The shapes the server's enrichTaskRows sends.
const v2WithConversation = makeTask({
  id: "task-v2", messageId: "task-v2", hostMessageId: null, sourceMessageId: "source-1",
  conversationAnchored: true, conversationChannelId: "conv-1", isLegacy: false,
});
const v2Lazy = makeTask({
  id: "task-lazy", messageId: "task-lazy", hostMessageId: null, sourceMessageId: null,
  conversationAnchored: true, conversationChannelId: null, isLegacy: false,
});
const preV2 = makeTask({
  id: "task-old", messageId: "host-1", hostMessageId: "host-1", sourceMessageId: "host-1",
  conversationAnchored: false, conversationChannelId: null, isLegacy: false,
});
const preV2WrittenSinceV2 = makeTask({
  id: "task-old-conv", messageId: "host-2", hostMessageId: "host-2", sourceMessageId: "host-2",
  conversationAnchored: true, conversationChannelId: "conv-2", isLegacy: false,
});
const legacyOrphan = makeTask({ id: "task-legacy", messageId: "task-legacy", isLegacy: true });
// An older server's DTO: none of the task v2 fields.
const oldServerShape = makeTask({ id: "task-older", messageId: "host-3" });

test("isTaskV2Task reads the task's own mode from its DTO", () => {
  assert.equal(isTaskV2Task(v2WithConversation), true);
  assert.equal(isTaskV2Task(v2Lazy), true);
  assert.equal(isTaskV2Task(preV2WrittenSinceV2), true);
  // No conversationAnchored field, but no real host message either.
  assert.equal(isTaskV2Task({ hostMessageId: null }), true);
  assert.equal(isTaskV2Task(preV2), false);
  assert.equal(isTaskV2Task(legacyOrphan), false);
  assert.equal(isTaskV2Task(oldServerShape), false);
});

test("opensAsTaskConversation: flag off only a v2 task opens its dialog; flag on every non-legacy task does", () => {
  for (const task of [v2WithConversation, v2Lazy, preV2WrittenSinceV2]) {
    assert.equal(opensAsTaskConversation(task, false), true, task.id);
    assert.equal(opensAsTaskConversation(task, true), true, task.id);
  }
  assert.equal(opensAsTaskConversation(preV2, false), false);
  assert.equal(opensAsTaskConversation(preV2, true), true);
  assert.equal(opensAsTaskConversation(oldServerShape, false), false);
  assert.equal(opensAsTaskConversation(legacyOrphan, false), false);
  assert.equal(opensAsTaskConversation(legacyOrphan, true), false);
});

function recordingDeps(taskV2Enabled: boolean) {
  const calls = { threads: [] as OpenThreadRequest[], conversations: [] as string[], legacy: [] as string[], tabs: [] as string[] };
  const deps: OpenTaskRefDeps = {
    closeProfile: () => {},
    closeThread: () => {},
    toChannelTasks: (channelId) => { calls.tabs.push(channelId); },
    openLegacyTask: (task) => { calls.legacy.push(task.id); },
    openThread: (request) => { calls.threads.push(request); },
    openTaskConversation: (task) => {
      calls.conversations.push(task.id);
      openTaskConversationDialog(task);
    },
    taskV2Enabled,
  };
  return { calls, deps };
}

function serveTask(task: Task): string[] {
  const urls: string[] = [];
  api.get = (async (url: string) => {
    urls.push(url);
    return { data: { task } };
  }) as typeof api.get;
  return urls;
}

test("flag off, a `#channel:#7` ref to a v2 task opens the task dialog keyed by the task, not a thread on its id", async () => {
  const urls = serveTask(v2WithConversation);
  const { calls, deps } = recordingDeps(false);

  await openTaskByChannelNumber(deps, CHANNEL_ID, 7);

  assert.deepEqual(urls, [`/tasks/channel/${CHANNEL_ID}/number/7`]);
  assert.deepEqual(calls.threads, []);
  assert.deepEqual(calls.conversations, ["task-v2"]);
  const slot = useThreadStore.getState().taskModal;
  assert.equal(slot?.taskId, "task-v2");
  assert.equal(slot?.parentMessageId, null);
  assert.equal(slot?.parentChannelId, CHANNEL_ID);
  assert.equal(slot?.threadChannelId, "conv-1");
  // The slot's deep link (main window and pop-out) is the task-keyed form.
  assert.equal(formatTaskConversationParam(slot?.parentChannelId ?? "", slot?.taskId ?? ""), `${CHANNEL_ID}:task:task-v2`);
});

test("flag off, a ref to a v2 task with no conversation yet opens its (empty) dialog", async () => {
  serveTask(v2Lazy);
  const { calls, deps } = recordingDeps(false);

  await openTaskByChannelNumber(deps, CHANNEL_ID, 7);

  assert.deepEqual(calls.threads, []);
  assert.deepEqual(calls.conversations, ["task-lazy"]);
  assert.equal(useThreadStore.getState().taskModal?.threadChannelId, null);
});

test("flag off, a ref to a pre-v2 task opens its host message's thread with task intent, as before task v2", async () => {
  for (const task of [preV2, oldServerShape]) {
    serveTask(task);
    const { calls, deps } = recordingDeps(false);

    await openTaskByChannelNumber(deps, CHANNEL_ID, 7);

    assert.deepEqual(calls.conversations, [], task.id);
    assert.deepEqual(calls.threads, [{ parentChannelId: CHANNEL_ID, parentMessageId: task.messageId, intent: "task" }], task.id);
  }
});

test("flag on, a pre-v2 task opens its dialog; a legacy orphan keeps the read-only panel either way", async () => {
  serveTask(preV2);
  const on = recordingDeps(true);
  await openTaskByChannelNumber(on.deps, CHANNEL_ID, 7);
  assert.deepEqual(on.calls.conversations, ["task-old"]);
  assert.deepEqual(on.calls.threads, []);

  for (const flag of [false, true]) {
    serveTask(legacyOrphan);
    const { calls, deps } = recordingDeps(flag);
    await openTaskByChannelNumber(deps, CHANNEL_ID, 7);
    assert.deepEqual(calls.legacy, ["task-legacy"]);
    assert.deepEqual(calls.tabs, [CHANNEL_ID]);
    assert.deepEqual(calls.conversations, []);
    assert.deepEqual(calls.threads, []);
  }
});
