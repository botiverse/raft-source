import assert from "node:assert/strict";
import { useInboxStore } from "../src/store/inboxStore";
import type { InboxGroupCount, InboxItem } from "../src/store/inboxStore";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import { applyTaskDeleted, isTaskDeletedForTarget, registerTaskRealtimeHandlers } from "../src/store/taskRealtimeSync";
import { useThreadStore } from "../src/store/threadStore";
import type { FollowedThread } from "../src/store/threadStore";

// Task v2: deleting a task deletes its conversation server-side, and
// `task:deleted` names it (`conversationChannelId`). The web drops every row
// that still shows it (Activity, Unfollowed, followed list) and closes the
// task dialog open on it; a pop-out task window closes itself.

afterEach(() => {
  useThreadStore.setState(useThreadStore.getInitialState(), true);
  useInboxStore.setState(useInboxStore.getInitialState(), true);
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

function seedServer() {
  useServerStore.setState({ current: { id: "server-1", slug: "acme" }, serverEpoch: 1 } as never);
}

function followed(threadChannelId: string, extra: Partial<FollowedThread> = {}): FollowedThread {
  return {
    threadChannelId, parentMessageId: "", parentChannelId: "channel-1", conversationKind: "task", taskId: "task-1",
    unreadCount: 2, replyCount: 3, lastReplyAt: null, firstUnreadMessageId: null,
    ...extra,
  } as FollowedThread;
}

function activityRow(threadChannelId: string, unreadCount: number): InboxItem {
  return {
    kind: "thread",
    threadChannelId,
    parentMessageId: "",
    parentChannelId: "channel-1",
    parentChannelName: "general",
    parentChannelType: "channel",
    unreadCount,
    hasMention: false,
    replyCount: 1,
    lastActivityAt: "2026-10-21T00:00:00.000Z",
    lastReplyAt: null,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    latestActivitySeq: null,
    taskNumber: 7,
    taskStatus: "todo",
    taskClaimedByName: null,
  } as unknown as InboxItem;
}

const group: InboxGroupCount = { channelId: "channel-1", channelName: "general", channelType: "channel", count: 2 } as InboxGroupCount;

test("task:deleted with its conversation drops the Activity, Unfollowed and followed rows and closes the task dialog", () => {
  seedServer();
  useThreadStore.getState().openTaskConversation({ taskId: "task-1", parentChannelId: "channel-1", conversationChannelId: "conv-1" });
  useThreadStore.setState({
    followedThreads: [followed("conv-1"), followed("conv-2", { taskId: "task-2" })],
    taskFollowOverrides: { "conv-1": true, "conv-2": true },
  });
  useInboxStore.setState({
    items: [activityRow("conv-1", 2), activityRow("conv-2", 1)],
    unfollowedItems: [activityRow("conv-1", 0) as Extract<InboxItem, { kind: "thread" }>],
    groups: [group],
    totalCount: 2,
    allCount: 2,
    totalUnreadCount: 3,
    activeUnreadCount: 3,
  });

  applyTaskDeleted({ channelId: "channel-1", taskId: "task-1", conversationChannelId: "conv-1" });

  const thread = useThreadStore.getState();
  assert.ok(thread.taskModal === null, "the task dialog on the deleted task is closed");
  assert.deepEqual(thread.followedThreads.map((row) => row.threadChannelId), ["conv-2"]);
  assert.deepEqual(thread.taskFollowOverrides, { "conv-2": true });

  const inbox = useInboxStore.getState();
  assert.deepEqual(inbox.items.map((item) => (item.kind === "thread" ? item.threadChannelId : null)), ["conv-2"]);
  assert.deepEqual(inbox.unfollowedItems, []);
  assert.equal(inbox.totalCount, 1);
  assert.equal(inbox.allCount, 1);
  assert.equal(inbox.totalUnreadCount, 1);
  assert.equal(inbox.activeUnreadCount, 1);
  assert.deepEqual(inbox.groups.map((row) => row.count), [1]);
});

test("a dialog bound to the deleted conversation closes; another task's dialog and a pre-v2 thread dialog stay", () => {
  seedServer();
  // Bound to the conversation (as seen from this surface) under another key.
  useThreadStore.getState().openTaskConversation({ taskId: "task-other", parentChannelId: "channel-1", conversationChannelId: "conv-1" });
  applyTaskDeleted({ channelId: "channel-1", taskId: "task-1", conversationChannelId: "conv-1" });
  assert.ok(useThreadStore.getState().taskModal === null);

  useThreadStore.getState().openTaskConversation({ taskId: "task-2", parentChannelId: "channel-1", conversationChannelId: "conv-2" });
  applyTaskDeleted({ channelId: "channel-1", taskId: "task-1", conversationChannelId: "conv-1" });
  assert.equal(useThreadStore.getState().taskModal?.taskId, "task-2", "another task's dialog stays open");

  // A pre-v2 task's dialog is its host message's thread, which stays.
  useThreadStore.setState({
    taskModal: {
      parentMessageId: "host-1", taskId: null, parentChannelId: "channel-1", threadChannelId: "thread-1",
      serverSlug: "acme", focusedMessageId: null, loading: false, error: null,
    },
  });
  applyTaskDeleted({ channelId: "channel-1", taskId: "task-legacy" });
  assert.equal(useThreadStore.getState().taskModal?.parentMessageId, "host-1");
});

test("task:deleted without a conversation closes that task's dialog and leaves the lists alone", () => {
  seedServer();
  useThreadStore.getState().openTaskConversation({ taskId: "task-1", parentChannelId: "channel-1" });
  useThreadStore.setState({ followedThreads: [followed("conv-2", { taskId: "task-2" })] });
  useInboxStore.setState({ items: [activityRow("conv-2", 1)], totalCount: 1, totalUnreadCount: 1, activeUnreadCount: 1 });

  applyTaskDeleted({ channelId: "channel-1", taskId: "task-1" });

  assert.ok(useThreadStore.getState().taskModal === null);
  assert.equal(useThreadStore.getState().followedThreads.length, 1);
  assert.equal(useInboxStore.getState().items.length, 1);
  assert.equal(useInboxStore.getState().totalUnreadCount, 1);
});

test("the socket handler applies task:deleted", () => {
  seedServer();
  const handlers = new Map<string, (data: any) => void>();
  const cleanup = registerTaskRealtimeHandlers({
    on: (event, handler) => handlers.set(event, handler),
    off: (event) => handlers.delete(event),
  });
  useThreadStore.getState().openTaskConversation({ taskId: "task-1", parentChannelId: "channel-1", conversationChannelId: "conv-1" });
  useThreadStore.setState({ followedThreads: [followed("conv-1")] });
  useInboxStore.setState({ items: [activityRow("conv-1", 1)], totalCount: 1, totalUnreadCount: 1, activeUnreadCount: 1 });

  handlers.get("task:deleted")!({ channelId: "channel-1", taskId: "task-1", conversationChannelId: "conv-1" });

  assert.ok(useThreadStore.getState().taskModal === null);
  assert.deepEqual(useThreadStore.getState().followedThreads, []);
  assert.deepEqual(useInboxStore.getState().items, []);
  cleanup();
  assert.equal(handlers.has("task:deleted"), false);
});

test("a task window matches task:deleted by its task or its bound conversation", () => {
  const target = { taskId: "task-1", conversationChannelId: "conv-1" };
  assert.equal(isTaskDeletedForTarget({ channelId: "channel-1", taskId: "task-1" }, target), true);
  assert.equal(isTaskDeletedForTarget({ channelId: "channel-1", taskId: "task-x", conversationChannelId: "conv-1" }, target), true);
  assert.equal(isTaskDeletedForTarget({ channelId: "channel-1", taskId: "task-2", conversationChannelId: "conv-2" }, target), false);
  assert.equal(isTaskDeletedForTarget({ channelId: "channel-1", taskId: "task-2" }, { taskId: "task-1", conversationChannelId: null }), false);
  assert.equal(isTaskDeletedForTarget(null, target), false);
});
