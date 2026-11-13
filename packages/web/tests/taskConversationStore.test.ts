import assert from "node:assert/strict";
import api from "../src/api/client";
import { isTaskConversationFollowed, useThreadStore } from "../src/store/threadStore";
import type { FollowedThread } from "../src/store/threadStore";
import { useServerStore } from "../src/store/serverStore";
import {
  directTaskConversationChannelId,
  formatTaskConversationRef,
  formatTaskConversationTitle,
  isTaskConversationMessage,
  isTaskConversationRow,
  taskIdOfConversationMessage,
} from "../src/utils/taskConversation";
import { orderParentUnreadThreadsForJump, summarizeParentThreadUnread } from "../src/utils/threadUnreadByParent";

// Task v2 store wiring: the task dialog slot keyed by the task, the first
// durable send creating a pre-v2 task's conversation, follow state of task
// conversations, and the helpers that recognize task conversations.

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

afterEach(() => {
  api.get = originalGet;
  api.post = originalPost;
  useThreadStore.setState(useThreadStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

function seedServer() {
  useServerStore.setState({ current: { id: "server-1", slug: "acme" }, serverEpoch: 1 } as never);
}

test("the task ref is `#channel:#7` (DM `dm:@peer:#7`); the title follows it", () => {
  assert.equal(formatTaskConversationRef({ taskNumber: 7, channelName: "proj", channelType: "channel" }), "#proj:#7");
  assert.equal(formatTaskConversationRef({ taskNumber: 7, channelName: "#proj" }), "#proj:#7");
  assert.equal(formatTaskConversationRef({ taskNumber: 3, channelType: "dm", dmPeerName: "cody" }), "dm:@cody:#3");
  assert.equal(formatTaskConversationRef({ taskNumber: 3, channelType: "dm" }), "#3");
  assert.equal(formatTaskConversationRef({ taskNumber: 3, channelName: null }), "#3");
  assert.equal(formatTaskConversationTitle("#proj:#7", "  Ship it "), "#proj:#7 Ship it");
  assert.equal(formatTaskConversationTitle("#proj:#7", null), "#proj:#7");
});

test("task conversation messages and rows are recognized; threads are not", () => {
  assert.equal(isTaskConversationMessage({ conversationContext: { channelType: "task", taskId: "t-1" } }), true);
  assert.equal(taskIdOfConversationMessage({ conversationContext: { channelType: "task", taskId: "t-1" } }), "t-1");
  assert.equal(isTaskConversationMessage({ conversationContext: { channelType: "thread" } }), false);
  assert.equal(taskIdOfConversationMessage({ conversationContext: { channelType: "thread", taskId: "t-1" } }), null);
  assert.equal(isTaskConversationMessage({}), false);

  assert.equal(isTaskConversationRow({ kind: "task", threadChannelId: "c" }), true);
  assert.equal(isTaskConversationRow({ conversationKind: "task" }), true);
  // A thread under a pre-v2 task's message names the task but is a thread.
  assert.equal(isTaskConversationRow({ kind: "thread", threadChannelId: "c", parentMessageId: "m", taskId: "t" }), false);
  assert.equal(isTaskConversationRow({ kind: "channel", taskId: "t" }), false);
});

test("a joint task's canonical conversation is not used as the local one", () => {
  assert.equal(directTaskConversationChannelId({ conversationChannelId: "conv", channelType: "channel" }), "conv");
  assert.equal(directTaskConversationChannelId({ conversationChannelId: "conv", channelType: "joint" }), null);
  assert.equal(directTaskConversationChannelId({ conversationChannelId: null }), null);
});

test("openTaskConversation fills the task-keyed slot and leaves the side thread alone", () => {
  seedServer();
  useThreadStore.setState({ openParentMessageId: "p", openThreadChannelId: "t", openParentChannelId: "c", openIntent: "thread" });
  useThreadStore.getState().openTaskConversation({ taskId: "task-1", parentChannelId: "channel-1", conversationChannelId: "conv-1" });
  const state = useThreadStore.getState();
  // focusNonce names the jump (new on every open), so only its kind is pinned.
  const { focusNonce, ...slot } = state.taskModal ?? { focusNonce: undefined };
  assert.equal(typeof focusNonce, "number");
  assert.deepEqual(slot, {
    parentMessageId: null,
    taskId: "task-1",
    parentChannelId: "channel-1",
    threadChannelId: "conv-1",
    serverSlug: "acme",
    focusedMessageId: null,
    loading: false,
    error: null,
  });
  assert.equal(state.openParentMessageId, "p");
  assert.equal(state.openThreadChannelId, "t");

  // Re-opening the same task keeps a conversation already bound.
  useThreadStore.getState().openTaskConversation({ taskId: "task-1", parentChannelId: "channel-1" });
  assert.equal(useThreadStore.getState().taskModal?.threadChannelId, "conv-1");
  // Binding only applies to the dialog of that task.
  useThreadStore.getState().bindTaskConversationChannel("other-task", "conv-x");
  assert.equal(useThreadStore.getState().taskModal?.threadChannelId, "conv-1");
});

test("the first durable send of a pre-v2 task creates its conversation and answers the local id", async () => {
  seedServer();
  const posts: string[] = [];
  api.post = (async (url: string) => {
    posts.push(url);
    return { data: { conversationChannelId: "conv-local", canonicalConversationChannelId: "conv-canonical", created: true } };
  }) as typeof api.post;
  useThreadStore.getState().openTaskConversation({ taskId: "task-2", parentChannelId: "channel-1" });

  const channelId = await useThreadStore.getState().ensureTaskModalThreadChannel();
  assert.equal(channelId, "conv-local");
  assert.deepEqual(posts, ["/tasks/task-2/conversation"]);
  // Resolution alone stays local: the panel binds the slot on durable accept.
  assert.equal(useThreadStore.getState().taskModal?.threadChannelId, null);
});

test("a task conversation that changed under the send is refused", async () => {
  seedServer();
  api.post = (async () => {
    useThreadStore.getState().openTaskConversation({ taskId: "task-other", parentChannelId: "channel-1" });
    return { data: { conversationChannelId: "conv-local" } };
  }) as typeof api.post;
  useThreadStore.getState().openTaskConversation({ taskId: "task-2", parentChannelId: "channel-1" });
  await assert.rejects(() => useThreadStore.getState().ensureTaskModalThreadChannel());
});

test("follow state of a task conversation: session override, then served, then the followed list", () => {
  const followed = [{ threadChannelId: "conv-listed", unreadCount: 1 } as FollowedThread];
  const state = { taskFollowOverrides: {} as Record<string, boolean>, followedThreads: followed };
  assert.equal(isTaskConversationFollowed(state, "conv-listed"), true);
  assert.equal(isTaskConversationFollowed(state, "conv-other"), false);
  assert.equal(isTaskConversationFollowed(state, "conv-other", true), true);
  assert.equal(isTaskConversationFollowed({ ...state, taskFollowOverrides: { "conv-other": false } }, "conv-other", true), false);
  assert.equal(isTaskConversationFollowed(state, null), false);
});

test("followed task conversations load into the thread list without a parent message", async () => {
  seedServer();
  api.get = (async () => ({
    data: {
      threads: [
        { threadChannelId: "thread-1", parentMessageId: "m-1", parentChannelId: "channel-1", unreadCount: 1, latestActivitySeq: null },
        { kind: "task", threadChannelId: "conv-1", parentMessageId: null, parentChannelId: "channel-1", taskId: "task-1", taskTitle: "Ship it", taskNumber: 7, unreadCount: 2, latestActivitySeq: null },
      ],
    },
  })) as typeof api.get;
  await useThreadStore.getState().loadFollowedThreads();
  const [thread, conversation] = useThreadStore.getState().followedThreads;
  assert.equal(thread?.conversationKind, undefined);
  assert.equal(conversation?.conversationKind, "task");
  assert.equal(conversation?.parentMessageId, "");
  assert.equal(conversation?.taskId, "task-1");

  // A task conversation's unread shows in Activity only (stdrc): neither the
  // channel's sidebar mark nor the jump pill counts it, so the channel never
  // shows an unread it cannot lead to or mark read.
  const list = useThreadStore.getState().followedThreads;
  assert.equal(summarizeParentThreadUnread(list, "channel-1").count, 1);
  assert.deepEqual(orderParentUnreadThreadsForJump(list, "channel-1").map((t) => t.threadChannelId), ["thread-1"]);
});

test("follow / unfollow a task conversation by its channel id", async () => {
  seedServer();
  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    return { data: {} };
  }) as typeof api.post;
  api.get = (async () => ({ data: { threads: [] } })) as typeof api.get;

  await useThreadStore.getState().followTaskConversation("conv-1");
  assert.equal(useThreadStore.getState().taskFollowOverrides["conv-1"], true);
  await useThreadStore.getState().unfollowTaskConversation("conv-1");
  assert.equal(useThreadStore.getState().taskFollowOverrides["conv-1"], false);
  assert.deepEqual(posts, [
    { url: "/channels/threads/follow", body: { threadChannelId: "conv-1" } },
    { url: "/channels/threads/unfollow", body: { threadChannelId: "conv-1" } },
  ]);
});
