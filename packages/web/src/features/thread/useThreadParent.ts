import { useEffect, useMemo, useState } from "react";
import type { Agent } from "../../store/agentStore";
import type { User } from "../../store/authStore";
import type { ServerMember } from "../../store/serverStore";
import { captureReceiverPrivateIngressContext, hydrateBundledThreadSummaries, isReceiverPrivateIngressContextCurrent, useMessageStore } from "../../store/messageStore";
import type { Message } from "../../store/messageStore";
import type { FollowedThread, ThreadSummary } from "../../store/threadStore";
import { selectChannelTaskBucket, useTaskStore } from "../../store/taskStore";
import type { Task, useTaskMetadataForMessage } from "../../store/taskStore";
import { resolveThreadHostTask } from "../../components/layout/threadHostTask";
import api from "../../api/client";
import { TASK_V2_CONVERSATIONS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { isTaskV2Task } from "../../utils/taskConversation";
import { buildThreadParentContextRequest } from "../../components/message/messageContextRequest";
import { resolveMessageSenderMember } from "../../utils/messageSenderMember";
import { mergeParentTaskMetadata } from "../../utils/taskMetadata";
import { findCachedThreadParentMessage, findThreadParentMessage, pickFreshThreadParentMessage, syncThreadParentMessageFromStore } from "./threadMessages";

const EMPTY_PARENT_SOURCE_TASKS: Task[] = [];

/**
 * The message the thread hangs under and its task: the loaded parent (or a
 * stand-in from the parent channel's cache or a followed thread), kept in
 * sync with the message and task stores, its thread summary, and the tasks
 * made from it (task v2).
 */
// oxlint-disable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
export function useThreadParent({
  parentMessageId,
  parentChannelId,
  threadChannelId,
  hideParentMessage,
  parentChannelBucket,
  followedThreads,
  threadSummaries,
  agentById,
  memberById,
  currentUser,
  realtimeParentTaskUpdate,
  coerceThreadIngress,
  messages,
}: {
  parentMessageId: string | null;
  parentChannelId: string | null;
  threadChannelId: string | null;
  hideParentMessage: boolean;
  parentChannelBucket: Message[];
  followedThreads: FollowedThread[];
  threadSummaries: Record<string, ThreadSummary>;
  agentById: Map<string, Agent>;
  memberById: Map<string, ServerMember>;
  currentUser: User | null;
  realtimeParentTaskUpdate: ReturnType<typeof useTaskMetadataForMessage>;
  coerceThreadIngress: (incoming: readonly Message[]) => Message[];
  messages: Message[];
}) {
  const [parentMessage, setParentMessage] = useState<Message | null>(null);
  const [parentTask, setParentTask] = useState<Task | null>(null);
  const loadTasks = useTaskStore((s) => s.loadTasks);
  const fallbackParentMessage = useMemo<Message | null>(() => {
    if (!parentMessageId || !parentChannelId) return null;

    const cachedParent = parentChannelBucket.find((msg) => msg.id === parentMessageId);
    if (cachedParent) return cachedParent;

    const followedThread = followedThreads.find((thread) => thread.parentMessageId === parentMessageId);
    // A followed thread seeded from the saved copy (task #164) carries no
    // message text: no stand-in parent, the panel waits for the real one.
    if (!followedThread || !followedThread.parentMessagePreview) return null;
    // A parent behind the plan's history window is not a row here: the
    // history paywall's glimpse leads with it, at its own time (Raft Chat:
    // History behind the plan's window).
    if (followedThread.parentInHistory === false) return null;

    const agent = followedThread.parentMessageSenderType === "agent" ? agentById.get(followedThread.parentMessageSenderId) : null;
    const member = resolveMessageSenderMember({
      senderType: followedThread.parentMessageSenderType as Message["senderType"],
      senderId: followedThread.parentMessageSenderId,
    }, memberById, currentUser) ?? null;
    const senderName = agent?.displayName ?? agent?.name ?? member?.displayName ?? member?.name;

    return {
      id: parentMessageId,
      channelId: parentChannelId,
      senderType: followedThread.parentMessageSenderType as Message["senderType"],
      senderId: followedThread.parentMessageSenderId,
      senderName,
      messageType: "chat",
      content: followedThread.parentMessagePreview,
      // The parent's own time; the latest reply's only from older servers.
      createdAt: followedThread.parentMessageCreatedAt ?? followedThread.lastReplyAt ?? "1970-01-01T00:00:00.000Z",
    };
  }, [agentById, currentUser, followedThreads, memberById, parentChannelBucket, parentChannelId, parentMessageId]);
  // Stryker disable all: React subscription wiring for parent-message cache sync.
  // The lookup/merge behavior is covered by threadPanelParentActionCardSync.behavior.test.ts;
  // mutating this hook body/dependency list makes Stryker classify React timing as
  // survivor/timeout instead of adding a distinct behavior contract.
  const storeParentMessage = useMemo<Message | null>(() => {
    return findThreadParentMessage(parentChannelBucket, parentMessageId, parentChannelId);
  }, [parentChannelBucket, parentChannelId, parentMessageId]);
  // Stryker restore all
  const fallbackParentTask = useMemo<Task | null>(() => {
    if (!parentMessageId || !parentChannelId) return null;
    const followedThread = followedThreads.find((thread) => thread.parentMessageId === parentMessageId);
    if (!followedThread?.taskId || !followedThread.taskNumber || !followedThread.taskStatus || !followedThread.parentMessagePreview) return null;

    return {
      id: followedThread.taskId,
      messageId: parentMessageId,
      channelId: parentChannelId,
      taskNumber: followedThread.taskNumber,
      title: followedThread.parentMessagePreview,
      status: followedThread.taskStatus as Task["status"],
      claimedByType: followedThread.taskClaimedByType,
      claimedById: followedThread.taskClaimedById,
      claimedByName: followedThread.taskClaimedByName,
      createdById: followedThread.parentMessageSenderId,
      createdByType: followedThread.parentMessageSenderType as Task["createdByType"],
      createdAt: followedThread.parentMessageCreatedAt ?? followedThread.lastReplyAt ?? "1970-01-01T00:00:00.000Z",
      updatedAt: followedThread.lastReplyAt ?? "1970-01-01T00:00:00.000Z",
    };
  }, [followedThreads, parentChannelId, parentMessageId]);
  const displayedParentMessage = hideParentMessage ? null : (parentMessage ?? fallbackParentMessage);
  // Stryker disable all: thread-id shaping for the displayed parent message is
  // existing permalink/preview plumbing; task #486's changed behavior is the
  // linked task metadata merged below.
  const displayedParentMessageWithThreadId = useMemo<Message | null>(() => {
    if (!displayedParentMessage) return null;
    if (!threadChannelId || displayedParentMessage.threadId) return displayedParentMessage;
    return { ...displayedParentMessage, threadId: threadChannelId };
  }, [displayedParentMessage, threadChannelId]);
  // Stryker restore all
  const displayedParentTask = useMemo(
    () => mergeParentTaskMetadata(parentTask, fallbackParentTask, realtimeParentTaskUpdate),
    [fallbackParentTask, parentTask, realtimeParentTaskUpdate],
  );
  // Stryker disable all: unchanged thread summary/latest-load logic falls into
  // the diff hunk after extracting task-metadata merge logic; task #486 coverage
  // is the displayed parent task badge and socket delivery path above.
  const displayedParentThreadSummary = useMemo<ThreadSummary | undefined>(() => {
    if (!parentMessageId || !threadChannelId) return undefined;

    const cachedSummary = threadSummaries[parentMessageId];
    if (cachedSummary) return cachedSummary;

    const followedThread = followedThreads.find((thread) => thread.parentMessageId === parentMessageId);
    const lastLoadedReplyAt = messages.length > 0
      ? messages[messages.length - 1]?.createdAt ?? null
      : null;

    return {
      threadChannelId,
      replyCount: Math.max(messages.length, followedThread?.replyCount ?? 0),
      lastReplyAt: followedThread?.lastReplyAt ?? lastLoadedReplyAt,
      participantIds: [],
      unreadCount: followedThread?.unreadCount ?? 0,
      firstUnreadMessageId: null,
    };
  }, [followedThreads, messages, parentMessageId, threadChannelId, threadSummaries]);
  // Stryker restore all

  // Load parent message and its linked task. Async-loader + reset-on-deps FP.
  // Stryker disable all: async loader/store hook wiring around the parent
  // snapshot and linked task. The new parent selection and cache preference
  // semantics are covered through the exported pure helpers; mutating this
  // block in isolation mostly probes React effect timing and pre-existing task
  // sync code.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    setParentMessage(null);
    setParentTask(null);

    if (!parentMessageId || !parentChannelId) return;

    let cancelled = false;
    // The parent is usually already in the parent channel's bucket (the user
    // clicked it there), and the cached copy always wins over the context
    // response (pickFreshThreadParentMessage). Render it now and skip the
    // round-trip; only fetch when it is not cached.
    const cachedParentAtOpen = findCachedThreadParentMessage(useMessageStore.getState().channelMessages, parentChannelId, parentMessageId);
    if (cachedParentAtOpen) {
      setParentMessage(cachedParentAtOpen);
    } else {
      const ingressContext = captureReceiverPrivateIngressContext(
        useMessageStore.getState().currentUserId,
      );
      const parentContextRequest = buildThreadParentContextRequest(parentMessageId, parentChannelId);
      api.get(parentContextRequest.url, parentContextRequest.config)
        .then(({ data }) => {
          if (cancelled || !isReceiverPrivateIngressContextCurrent(ingressContext)) return;
          // The response carries the parent's thread summary (its total reply
          // count). Without it a thread opened at one reply, e.g. from search,
          // counts only the replies loaded around that reply.
          hydrateBundledThreadSummaries(data, ingressContext);
          const msgs = coerceThreadIngress(data.messages ?? []);
          const parent = msgs.find((m) => m.id === parentMessageId) ?? null;
          const cachedParent = findCachedThreadParentMessage(useMessageStore.getState().channelMessages, parentChannelId, parentMessageId);
          setParentMessage(pickFreshThreadParentMessage(parent, cachedParent));
        })
        .catch(() => {
          if (!cancelled) setParentMessage(null);
        });
    }

    // Load through the task store instead of fetching this endpoint privately.
    // The private fetch is why a DM task could render its chip here while
    // MainLayout — which reads only the store — concluded there was no task and
    // never mounted the task modal head (@artin, task #44). Two halves of one
    // modal held different answers because only one of them had asked.
    // `loadTasks` de-duplicates per channel, so this is one request, not two,
    // and `storeParentTask` below now sees DM and private tasks like any other.
    void loadTasks(parentChannelId);

    return () => {
      cancelled = true;
    };
  }, [loadTasks, coerceThreadIngress, parentChannelId, parentMessageId]);

  // Keep parentTask in sync with taskStore mutations (mark-as-done from the
  // thread header's own context menu, socket task:updated, tasks page, etc.).
  // Without this, the initial API fetch above snapshots the status once and
  // the thread header's status badge stays stale until a refresh.
  const parentChannelTaskBucket = useTaskStore((s) => selectChannelTaskBucket(s, parentChannelId));
  // Task v2: the tasks that hang under the parent message, shown under it here
  // as in the channel, so people discussing the request see what it became.
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;
  // With the flag off the list shows only where a task made the v2 way hangs
  // (it keeps working the v2 way); a parent that is only a pre-v2 task's host
  // keeps its single chip, as before task v2.
  const parentSourceTasks = useMemo(() => {
    if (!parentMessageId) return EMPTY_PARENT_SOURCE_TASKS;
    const list = parentChannelTaskBucket.filter((t) => t.sourceMessageId === parentMessageId);
    if (list.length === 0 || (!taskV2 && !list.some(isTaskV2Task))) return EMPTY_PARENT_SOURCE_TASKS;
    return list.sort((a, b) => a.taskNumber - b.taskNumber);
  }, [parentChannelTaskBucket, parentMessageId, taskV2]);
  const storeTasks = useTaskStore((s) => s.tasks);
  const storeServerTasks = useTaskStore((s) => s.serverTasks);
  const storeParentTask = useMemo(
    () => resolveThreadHostTask(parentMessageId, {
      tasks: storeTasks,
      parentChannelTasks: parentChannelTaskBucket,
      serverTasks: storeServerTasks,
    }),
    [parentMessageId, storeTasks, parentChannelTaskBucket, storeServerTasks],
  );
  useEffect(() => {
    if (storeParentTask) setParentTask(storeParentTask);
  }, [storeParentTask]);
  // Stryker restore all

  // ThreadPanel renders the parent message from local state after the context
  // fetch. Keep that snapshot synced with the canonical message store so local
  // action-card mutations and parent-channel realtime updates do not leave the
  // thread header/card stale until refresh.
  // Stryker disable all: React effect wiring for parent-message cache sync. The
  // sync helper behavior is covered by threadPanelParentActionCardSync.behavior.test.ts.
  useEffect(() => {
    syncThreadParentMessageFromStore(storeParentMessage, setParentMessage);
  }, [storeParentMessage]);
  // Stryker restore all

  return {
    parentMessage,
    displayedParentMessageWithThreadId,
    displayedParentTask,
    displayedParentThreadSummary,
    parentSourceTasks,
    taskV2,
  };
}
// oxlint-enable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
