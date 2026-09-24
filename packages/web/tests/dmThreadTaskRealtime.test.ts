import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { useInboxStore } from "../src/store/inboxStore";
import type { InboxItem } from "../src/store/inboxStore";
import { registerTaskRealtimeHandlers } from "../src/store/taskRealtimeSync";
import { useThreadStore } from "../src/store/threadStore";
import type { FollowedThread } from "../src/store/threadStore";
import { useTaskStore } from "../src/store/taskStore";
import type { Task } from "../src/store/taskStore";
import {
  applyTaskToFollowedThreads,
  applyTaskToInboxItems,
  updateTaskMetadataCache,
} from "../src/utils/taskMetadata";

function task(overrides: Partial<Pick<Task, "messageId" | "taskNumber" | "status" | "claimedByName">> = {}) {
  return {
    messageId: "dm-parent-message-1",
    taskNumber: 34,
    status: "closed",
    claimedByName: "Cody",
    ...overrides,
  } as Pick<Task, "messageId" | "taskNumber" | "status" | "claimedByName">;
}

function fullTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-34",
    messageId: "dm-parent-message-1",
    channelId: "dm-channel-1",
    channelName: "Cindy DM",
    channelType: "dm",
    taskNumber: 34,
    title: "please handle this",
    status: "closed",
    claimedByType: "agent",
    claimedById: "agent-cody",
    claimedByName: "Cody",
    claimedAt: "2026-07-04T00:00:00.000Z",
    completedAt: null,
    createdById: "user-1",
    createdByType: "user",
    createdByName: "Cindy",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:01:00.000Z",
    ...overrides,
  };
}

class FakeTaskSocket {
  private readonly emitter = new EventEmitter();

  on(event: string, handler: (data: any) => void) {
    this.emitter.on(event, handler);
  }

  off(event: string, handler: (data: any) => void) {
    this.emitter.off(event, handler);
  }

  emit(event: string, data: any) {
    this.emitter.emit(event, data);
  }
}

function followedThread(overrides: Partial<FollowedThread> = {}): FollowedThread {
  return {
    threadChannelId: "dm-thread-channel-1",
    parentMessageId: "dm-parent-message-1",
    parentChannelId: "dm-channel-1",
    parentChannelName: "Cindy DM",
    parentChannelType: "dm",
    parentMessagePreview: "please handle this",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    replyCount: 3,
    lastReplyAt: "2026-07-04T00:00:00.000Z",
    unreadCount: 1,
    taskNumber: 34,
    taskStatus: "in_review",
    taskClaimedByName: null,
    ...overrides,
  };
}

function inboxThread(overrides: Partial<Extract<InboxItem, { kind: "thread" }>> = {}): Extract<InboxItem, { kind: "thread" }> {
  return {
    kind: "thread",
    threadChannelId: "dm-thread-channel-1",
    parentMessageId: "dm-parent-message-1",
    parentChannelId: "dm-channel-1",
    parentChannelName: "Cindy DM",
    parentChannelType: "dm",
    parentMessagePreview: "please handle this",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    latestActivityPreview: "moved task to Closed",
    latestActivitySenderType: "system",
    latestActivitySenderId: "system",
    latestActivityMessageId: "system-message-1",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    replyCount: 3,
    lastActivityAt: "2026-07-04T00:00:00.000Z",
    lastReplyAt: "2026-07-04T00:00:00.000Z",
    unreadCount: 1,
    hasMention: false,
    taskNumber: 34,
    taskStatus: "in_review",
    taskClaimedByName: null,
    ...overrides,
  };
}

test("task realtime update refreshes followed DM thread task metadata", () => {
  const unchanged = followedThread({ threadChannelId: "other-thread", parentMessageId: "other-parent" });
  const updated = applyTaskToFollowedThreads([followedThread(), unchanged], task());

  assert.equal(updated[0]?.taskStatus, "closed");
  assert.equal(updated[0]?.taskClaimedByName, "Cody");
  assert.equal(updated[1], unchanged, "unrelated followed threads should keep their object identity");
});

test("followed thread task metadata update preserves unchanged rows and caches", () => {
  const current = followedThread({ taskStatus: "closed", taskClaimedByName: null });
  const threads = [current];
  const unchangedThreads = applyTaskToFollowedThreads(threads, task({ claimedByName: null }));

  assert.equal(unchangedThreads, threads, "unchanged followed thread metadata should keep array identity");
  assert.equal(unchangedThreads[0], current, "unchanged followed thread metadata should keep row identity");

  const cache = { "dm-parent-message-1": task({ claimedByName: null }) };
  const unchangedCache = updateTaskMetadataCache(cache, task({ claimedByName: null }));

  assert.equal(unchangedCache, cache, "unchanged realtime parent task metadata should keep cache identity");

  const changedCache = updateTaskMetadataCache(cache, task({ status: "in_review", claimedByName: null }));
  assert.notEqual(changedCache, cache, "changed realtime parent task metadata should replace cache identity");
  assert.equal(changedCache["dm-parent-message-1"]?.status, "in_review");
});

test("task realtime update refreshes Activity thread task metadata", () => {
  const unchanged = {
    kind: "dm",
    channelId: "dm-channel-2",
    channelName: "Other DM",
    channelType: "dm",
    lastMessageId: "message-2",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-07-04T00:00:00.000Z",
    lastMessagePreview: "hello",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-2",
    lastMessageSenderName: "Other",
    unreadCount: 0,
    hasMention: false,
  } satisfies InboxItem;
  const updated = applyTaskToInboxItems([inboxThread(), unchanged], task());

  const row = updated[0] as Extract<InboxItem, { kind: "thread" }>;
  assert.equal(row.taskStatus, "closed");
  assert.equal(row.taskClaimedByName, "Cody");
  assert.equal(updated[1], unchanged, "non-thread Activity rows should keep their object identity");
});

test("Activity task metadata update preserves unrelated and unchanged rows", () => {
  const current = inboxThread({ taskStatus: "closed", taskClaimedByName: null });
  const items = [current];
  const unchangedItems = applyTaskToInboxItems(items, task({ claimedByName: null }));

  assert.equal(unchangedItems, items, "unchanged Activity thread metadata should keep array identity");
  assert.equal(unchangedItems[0], current, "unchanged Activity thread metadata should keep row identity");

  const unrelated = inboxThread({ parentMessageId: "other-parent", threadChannelId: "other-thread" });
  const unrelatedItems = [unrelated];
  const afterUnrelatedTask = applyTaskToInboxItems(unrelatedItems, task());

  assert.equal(afterUnrelatedTask, unrelatedItems, "non-matching Activity thread rows should keep array identity");
  assert.equal(afterUnrelatedTask[0], unrelated, "non-matching Activity thread rows should keep row identity");
});

test("store task metadata wrappers preserve state identity on no-op updates", () => {
  const currentThread = followedThread({ taskStatus: "closed", taskClaimedByName: null });
  useThreadStore.setState({
    followedThreads: [currentThread],
    taskUpdatesByMessageId: {
      "dm-parent-message-1": task({ claimedByName: null }),
    },
  });
  const threadState = useThreadStore.getState();
  useThreadStore.getState().updateFollowedThreadTask(task({ claimedByName: null }));
  assert.equal(useThreadStore.getState(), threadState, "unchanged followed-thread task update should be a store no-op");

  const currentItem = inboxThread({ taskStatus: "closed", taskClaimedByName: null });
  useInboxStore.setState({ items: [currentItem] });
  const inboxState = useInboxStore.getState();
  useInboxStore.getState().updateTaskMetadata(task({ claimedByName: null }));
  assert.equal(useInboxStore.getState(), inboxState, "unchanged Activity task update should be a store no-op");
});

test("followed thread store updates rows even when realtime cache already has the task metadata", () => {
  useThreadStore.setState({
    followedThreads: [followedThread({ taskStatus: "in_review", taskClaimedByName: null })],
    taskUpdatesByMessageId: {
      "dm-parent-message-1": task(),
    },
  });

  useThreadStore.getState().updateFollowedThreadTask(task());

  const row = useThreadStore.getState().followedThreads[0];
  assert.equal(row?.taskStatus, "closed");
  assert.equal(row?.taskClaimedByName, "Cody");
  assert.equal(
    useThreadStore.getState().taskUpdatesByMessageId["dm-parent-message-1"]?.status,
    "closed",
    "existing realtime cache entry should be preserved when it already matches",
  );
});

test("task:updated socket handler refreshes DM thread surfaces outside taskStore lists", () => {
  const socket = new FakeTaskSocket();
  const cleanup = registerTaskRealtimeHandlers(socket);
  try {
    useTaskStore.setState({
      tasks: [],
      currentChannelId: "some-other-channel",
      serverTasks: [],
      taskMetadataByMessageId: {},
      taskMessageIdByTaskId: {},
    });
    useThreadStore.setState({
      followedThreads: [followedThread()],
      taskUpdatesByMessageId: {},
    });
    useInboxStore.setState({
      items: [inboxThread()],
    });

    socket.emit("task:updated", {
      channelId: "dm-channel-1",
      task: fullTask(),
    });

    assert.deepEqual(useTaskStore.getState().tasks, [], "DM task should stay outside the current task list");
    assert.deepEqual(useTaskStore.getState().serverTasks, [], "DM task should stay outside server-wide task list");
    const taskMetadata = useTaskStore.getState().taskMetadataByMessageId["dm-parent-message-1"];
    assert.equal(taskMetadata?.status, "closed");
    assert.equal(taskMetadata?.claimedByName, "Cody");
    assert.equal(
      useThreadStore.getState().followedThreads[0]?.taskStatus,
      "in_review",
      "the decoder must not write the derived followed-thread projection",
    );
    assert.deepEqual(
      useThreadStore.getState().taskUpdatesByMessageId,
      {},
      "the decoder must not repopulate the retired thread-local task cache",
    );
    assert.equal(
      (useInboxStore.getState().items[0] as Extract<InboxItem, { kind: "thread" }>).taskStatus,
      "in_review",
      "the decoder must not write the derived Activity-row projection",
    );

    const projectedThread = applyTaskToFollowedThreads(useThreadStore.getState().followedThreads, taskMetadata!)[0];
    assert.equal(projectedThread?.taskStatus, "closed");
    assert.equal(projectedThread?.taskClaimedByName, "Cody");

    const row = applyTaskToInboxItems(
      useInboxStore.getState().items,
      taskMetadata!,
    )[0] as Extract<InboxItem, { kind: "thread" }>;
    assert.equal(row.taskStatus, "closed");
    assert.equal(row.taskClaimedByName, "Cody");
  } finally {
    cleanup();
  }
});
