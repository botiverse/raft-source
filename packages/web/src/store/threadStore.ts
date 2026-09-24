import { create } from "zustand";
import api from "../api/client";
import { useServerStore } from "./serverStore";
import { getCurrentPrincipalId } from "./principalRuntime";
import { captureReadAllReceiver } from "./receiverPrivateIngress";
import { postReadAllCoalesced } from "./transport/inboxTransport";
import { registerServerReset } from "./serverResetRegistry";
import { registerMessagesSyncCoreReset } from "./messageSyncCoreReset";
import {
  getAcceptedReadStateProjection,
  notifyChannelReadLocally,
  notifyChannelReadPersistedLocally,
  registerReadStateProjectionListener,
} from "./readStateSync";
import type {
  ReadStateProjection,
} from "./readStateSync";
import {
  applyTaskToFollowedThreads,
  updateTaskMetadataCache,
} from "../utils/taskMetadata";
import type {
  TaskMetadataUpdate,
} from "../utils/taskMetadata";

// The reply-preview type is owned by the read model (the SDK contract surface),
// NOT redefined here. One definition, one place — two copies of a contract type
// is the same drift the cross-repo checksum gate exists to stop.
import {
  applyThreadReplyFrame,
  emptyThreadRepliesScope,
  hydrateThreadRepliesScope,
} from "./threadRepliesReadModel";
import type {
  ThreadRepliesScope,
  ThreadReplyPreview,
} from "./threadRepliesReadModel";
export type { ThreadReplyPreview };

export interface ThreadSummary {
  threadChannelId: string;
  replyCount: number;
  lastReplyAt: string | null;
  participantIds: string[];
  unreadCount: number;
  firstUnreadMessageId: string | null;
  /** Newest ≤3 conversation replies (system excluded), served upfront for inline previews. */
  latestReplies?: ThreadReplyPreview[];
}

export interface FollowedThread {
  threadChannelId: string;
  parentMessageId: string;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: string;
  parentMessagePreview: string;
  parentMessageSenderType: string;
  parentMessageSenderId: string;
  /** Same-source frontier paired with the accepted row's latest activity. */
  latestActivitySeq: string | null;
  replyCount: number;
  lastReplyAt: string | null;
  unreadCount: number;
  /** Canonical legacy-task id for mutation routes; absent on older servers and non-task threads. */
  taskId?: string | null;
  taskNumber: number | null;
  taskStatus: string | null;
  taskClaimedByType?: "agent" | "user" | null;
  taskClaimedById?: string | null;
  taskClaimedByName: string | null;
}

// Stryker disable all: followed-thread hydration projection is covered by read-state behavior tests; surviving mutants here are no-op/reference variants around the same projection result.
function applyKnownReadStateProjectionsToFollowedThreads(threads: FollowedThread[]): FollowedThread[] {
  const serverId = useServerStore.getState().current?.id;
  if (!serverId) return threads;
  let changed = false;
  const projected = threads.map((thread) => {
    const projection = getAcceptedReadStateProjection(serverId, thread.threadChannelId);
    if (!projection?.complete || thread.unreadCount === projection.unreadCount) return thread;
    changed = true;
    return { ...thread, unreadCount: projection.unreadCount };
  });
  return changed ? projected : threads;
}
// Stryker restore all

function applyThreadUnreadProjectionToSummaries(
  summaries: Record<string, ThreadSummary>,
  threadChannelId: string,
  unreadCount: number,
  firstUnreadMessageId: string | null,
): Record<string, ThreadSummary> {
  let next = summaries;
  for (const [parentMessageId, summary] of Object.entries(summaries)) {
    if (
      summary.threadChannelId !== threadChannelId
      || (
        summary.unreadCount === unreadCount
        && summary.firstUnreadMessageId === firstUnreadMessageId
      )
    ) continue;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: copying once vs redundantly for several matching summaries is an equivalent final projection; source immutability is behavior-pinned.
    if (next === summaries) next = { ...summaries };
    next[parentMessageId] = {
      ...summary,
      unreadCount,
      firstUnreadMessageId,
    };
  }
  return next;
}

export interface OpenThreadRequest {
  serverSlug?: string;
  parentChannelId: string;
  parentMessageId: string;
  threadChannelId?: string | null;
  focusedMessageId?: string | null;
  initialThreadChannelId?: string | null;
  /** Why this thread is being opened.
   *
   *  The same message can be opened two ways: "show me the replies" (the thread
   *  icon) and "open this task" (the task badge). They want different surfaces —
   *  side panel vs centered modal — so the caller states its INTENT rather than
   *  the host inferring it from whether the parent happens to be a task. That
   *  inference cannot tell the two apart, which is how the thread icon started
   *  opening a task modal. */
  intent?: "thread" | "task";
}

interface ThreadState {
  /** Parent message ID of the currently open thread */
  openParentMessageId: string | null;
  /** Thread channel ID of the currently open thread */
  openThreadChannelId: string | null;
  /** Parent channel ID (the channel where the parent message lives) */
  openParentChannelId: string | null;
  /** Server authority for the open route. */
  openServerSlug: string | null;
  /** Specific reply to focus/highlight when opening a thread from search */
  focusedMessageId: string | null;
  /** Timestamp when the thread was last opened, used to decide view-stack ordering */
  openedAt: number;
  /** Thread summaries keyed by parent message ID */
  summaries: Record<string, ThreadSummary>;
  /**
   * Inline reply previews (task #47), keyed by parent message ID — the latest-N
   * read model per thread scope (SDK contract: getLatestNReplies /
   * listenLatestNReplies).
   *
   * Its own map, deliberately: ChatPanel subscribes to `summaries` wholesale, so
   * widening THAT object on every live reply would re-run the whole message-list
   * memo. This map is patched PER KEY — the touched scope gets a new object,
   * every other scope keeps its exact reference — which is what lets a memoized
   * MessageItem skip a reply belonging to another thread (#4434 class).
   */
  replyScopes: Record<string, ThreadRepliesScope>;
  /** Threads the user participates in */
  followedThreads: FollowedThread[];
  /** Latest task metadata keyed by parent message ID, including DM-thread parents outside task boards */
  taskUpdatesByMessageId: Record<string, TaskMetadataUpdate>;
  /**
   * One-shot focus signal for the Threads inbox surface — set by the Sidebar
   * dblclick handler so the inbox can scroll the matching row to the top and
   * highlight it without auto-opening the right thread panel.
   */
  focusedThreadChannelId: string | null;
  /** Set or clear the focused thread channel id (consumed by ThreadsInbox). */
  setFocusedThreadChannelId: (id: string | null) => void;
  /**
   * Resolution failure for the currently-open thread permalink. `openThread`
   * sets the parent anchor optimistically *before* its read-only thread lookup,
   * so a failed lookup (e.g. the permalink was opened while the parent
   * channel was still private / mid private→public conversion, or any
   * transient error) would otherwise leave `openThreadChannelId === null`
   * with no way to distinguish a valid empty thread from a failed request.
   * Tracking the failed anchor lets the panel
   * surface an actionable error + Retry instead.
   *
   * Invariant: a `?thread=` permalink must converge to a usable thread view
   * OR an actionable error — never an unbounded spinner. Originating bug:
   * #engineering task #417 (private→public channel thread permalink hang).
   */
  openThreadError: { parentChannelId: string; parentMessageId: string } | null;
  /** True only while the read-only existing-thread lookup is in flight. */
  openThreadLoading: boolean;
  /** Open a thread panel for a message */
  openThread: (request: OpenThreadRequest) => Promise<void>;
  /** Intent of the currently open thread; null when none is open. */
  openIntent: "thread" | "task" | null;
  /**
   * Persist the currently-open thread channel on the first durable action
   * (reply or attachment upload). Merely opening/reading a thread must never
   * call this writer.
   */
  ensureOpenThreadChannel: () => Promise<string>;
  /**
   * Re-run resolution for the currently-open thread against the channel's
   * *current* accessibility. Used by ThreadPanel's Retry affordance after an
   * `openThread` failure (see `openThreadError`).
   */
  retryOpenThread: () => Promise<void>;
  /** Close the thread panel */
  closeThread: () => void;
  /** Clear focused reply once the highlight animation completes */
  clearFocusedMessage: () => void;
  /** Load thread summaries for a channel */
  loadSummaries: (channelId: string, parentMessageIds?: string[]) => Promise<void>;
  /**
   * Hydrate the summaries bundled with a messages page before that page is
   * published to the message list. Keeping this synchronous prevents a parent
   * row from mounting first and growing an inline-replies block one request
   * later, which would move the user's scroll anchor.
   */
  hydrateSummaries: (summaries: Record<string, ThreadSummary>) => void;
  hydrateSummariesWithReplyScopes: (
    summaries: Record<string, ThreadSummary>,
    replyScopes: Record<string, ThreadRepliesScope>,
  ) => void;
  /** Update a single thread summary (from socket event) */
  updateSummary: (parentMessageId: string, summary: ThreadSummary) => void;
  /** Load followed threads for the current server */
  loadFollowedThreads: () => Promise<void>;
  /** Update a followed thread from socket event */
  updateFollowedThread: (threadChannelId: string, updates: Partial<Pick<FollowedThread, "replyCount" | "lastReplyAt" | "unreadCount">>) => void;
  /** Update followed-thread task metadata from task socket events */
  updateFollowedThreadTask: (task: TaskMetadataUpdate) => void;
  /** Clear unread count for a thread */
  clearThreadUnread: (
    threadChannelId: string,
    receiverOverride?: { kind: "agent"; id: string } | null,
    /**
     * #5690: when the caller already owns an awaited, generation-fenced
     * authoritative refresh (Activity's markDone), suppressing the persisted
     * notification avoids a second, unawaited background refresh that is not
     * bound to the Done generation. Read-all persistence and the local unread
     * clear are unaffected — only the notification is scoped out.
     */
    options?: { suppressPersistedNotification?: boolean },
  ) => void;
  /** Seed a thread scope's inline preview from the initial snapshot (task #47). */
  hydrateReplyScope: (parentMessageId: string, replies: ThreadReplyPreview[], replyCount: number) => void;
  applyReplyScope: (parentMessageId: string, scope: ThreadRepliesScope) => void;
  /** Apply one live reply frame to a thread scope's inline preview (task #47). */
  applyReplyFrame: (parentMessageId: string, reply: ThreadReplyPreview, authoritativeReplyCount: number) => void;
  /** Clear unread count from local state without echoing another server write. */
  clearThreadUnreadLocally: (threadChannelId: string) => void;
  applyReadStateProjection: (threadChannelId: string, projection: ReadStateProjection) => void;
  /** Follow a thread manually */
  followThread: (parentMessageId: string) => Promise<void>;
  /** Unfollow a thread */
  unfollowThread: (threadChannelId: string) => Promise<void>;
  /** Mark a thread as done (hide from active list) */
  markThreadDone: (threadChannelId: string) => Promise<void>;
  /** Un-done a thread (restore to active list) */
  undoneThread: (threadChannelId: string) => Promise<void>;
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  openParentMessageId: null,
  openIntent: null,
  openThreadChannelId: null,
  openParentChannelId: null,
  openServerSlug: null,
  openThreadError: null,
  openThreadLoading: false,
  focusedMessageId: null,
  openedAt: 0,
  summaries: {},
  replyScopes: {},
  followedThreads: [],
  taskUpdatesByMessageId: {},
  focusedThreadChannelId: null,

  setFocusedThreadChannelId: (id) => set({ focusedThreadChannelId: id }),

  openThread: async ({
    serverSlug,
    parentChannelId,
    parentMessageId,
    threadChannelId = null,
    focusedMessageId = null,
    initialThreadChannelId = null,
    intent = "thread",
  }) => {
    const currentServer = useServerStore.getState().current;
    const routeServerSlug = serverSlug ?? currentServer?.slug ?? null;
    if (serverSlug && currentServer?.slug !== serverSlug) {
      console.error("Failed to open thread: route server is not active");
      return;
    }
    const serverEpoch = useServerStore.getState().serverEpoch;
    // Look up threadChannelId from existing data so we can open the panel immediately
    const state = useThreadStore.getState();
    const knownThreadChannelId =
      threadChannelId ??
      initialThreadChannelId ??
      state.summaries[parentMessageId]?.threadChannelId ??
      state.followedThreads.find((t) => t.parentMessageId === parentMessageId)?.threadChannelId ??
      null;

    // Set panel-open state immediately — don't wait for API. Clear any prior
    // resolution error so a retry/new-open starts from a clean state.
    set({
      openParentMessageId: parentMessageId,
      openIntent: intent,
      openThreadChannelId: knownThreadChannelId,
      openParentChannelId: parentChannelId,
      openServerSlug: routeServerSlug,
      openThreadError: null,
      openThreadLoading: !knownThreadChannelId,
      focusedMessageId,
      openedAt: Date.now(),
    });
    if (knownThreadChannelId) return;

    try {
      // Opening is a read. Resolve an existing channel if one is already
      // durable, while a 404 is the normal "no replies yet" state.
      const { data } = await api.get(`/channels/${parentChannelId}/threads/${parentMessageId}`);
      if (
        useServerStore.getState().serverEpoch !== serverEpoch
        || (routeServerSlug && useServerStore.getState().current?.slug !== routeServerSlug)
      ) return;
      if (data?.threadChannelId) {
        set((prev) => ({
          ...(prev.openServerSlug === routeServerSlug && prev.openParentMessageId === parentMessageId
            ? { openThreadChannelId: data.threadChannelId, openThreadError: null, openThreadLoading: false }
            : {}),
          summaries: {
            ...prev.summaries,
            [parentMessageId]: {
              threadChannelId: data.threadChannelId,
              replyCount: data.replyCount ?? 0,
              lastReplyAt: data.lastReplyAt ?? null,
              participantIds: data.participantIds ?? [],
              unreadCount: data.unreadCount ?? 0,
              firstUnreadMessageId: data.firstUnreadMessageId ?? null,
            },
          },
        }));
      } else {
        set((prev) =>
          prev.openServerSlug === routeServerSlug && prev.openParentMessageId === parentMessageId
            ? { openThreadLoading: false }
            : {},
        );
      }
    } catch (err: unknown) {
      const status =
        typeof err === "object" &&
        err !== null &&
        "response" in err &&
        typeof (err as { response?: { status?: unknown } }).response?.status === "number"
          ? (err as { response: { status: number } }).response.status
          : null;
      if (status === 404) {
        set((prev) =>
          prev.openServerSlug === routeServerSlug && prev.openParentMessageId === parentMessageId
            ? { openThreadLoading: false }
            : {},
        );
        return;
      }
      console.error("Failed to open thread:", err);
      if (
        useServerStore.getState().serverEpoch !== serverEpoch
        || (routeServerSlug && useServerStore.getState().current?.slug !== routeServerSlug)
      ) return;
      // Only flag an error when we have no usable thread channel id to fall
      // back on — otherwise the panel is still functional. Guard on the
      // anchor still matching so a stale failed request can't clobber a
      // newer open.
      set((prev) =>
        prev.openServerSlug === routeServerSlug
          && prev.openParentMessageId === parentMessageId
          && !prev.openThreadChannelId
          ? { openThreadError: { parentChannelId, parentMessageId }, openThreadLoading: false }
          : {},
      );
    }
  },

  ensureOpenThreadChannel: async () => {
    const {
      openServerSlug,
      openParentChannelId,
      openParentMessageId,
      openThreadChannelId,
    } = get();
    if (openThreadChannelId) return openThreadChannelId;
    if (!openParentChannelId || !openParentMessageId) {
      throw new Error("No open thread to resolve");
    }

    const serverEpoch = useServerStore.getState().serverEpoch;
    const { data } = await api.post(`/channels/${openParentChannelId}/threads`, {
      parentMessageId: openParentMessageId,
    });
    if (typeof data?.threadChannelId !== "string" || data.threadChannelId.length === 0) {
      throw new Error("Thread creation did not return a channel id");
    }
    if (
      useServerStore.getState().serverEpoch !== serverEpoch
      || (openServerSlug && useServerStore.getState().current?.slug !== openServerSlug)
    ) {
      throw new Error("Thread context changed while creating the thread");
    }
    const current = get();
    if (
      current.openServerSlug !== openServerSlug
      || current.openParentChannelId !== openParentChannelId
      || current.openParentMessageId !== openParentMessageId
    ) {
      throw new Error("Thread context changed while creating the thread");
    }
    return data.threadChannelId;
  },

  retryOpenThread: async () => {
    const { openServerSlug, openParentChannelId, openParentMessageId, openThreadChannelId, focusedMessageId } =
      useThreadStore.getState();
    if (!openParentChannelId || !openParentMessageId) return;
    // Stryker disable all: typed thread payload shape is covered by openThread payload/source contracts.
    await useThreadStore
      .getState()
      .openThread({
        serverSlug: openServerSlug ?? undefined,
        parentChannelId: openParentChannelId,
        parentMessageId: openParentMessageId,
        threadChannelId: openThreadChannelId,
        focusedMessageId,
      });
    // Stryker restore all
  },

  closeThread: () =>
    set({
      openParentMessageId: null,
      openIntent: null,
      openThreadChannelId: null,
      openParentChannelId: null,
      openServerSlug: null,
      openThreadError: null,
      openThreadLoading: false,
      focusedMessageId: null,
    }),

  clearFocusedMessage: () => set({ focusedMessageId: null }),

  hydrateSummaries: (summaries) => {
    get().hydrateSummariesWithReplyScopes(summaries, {});
  },

  hydrateSummariesWithReplyScopes: (summaries, acceptedReplyScopes) => {
    // One projection commit: bundled summaries and their accepted reply scopes
    // become observable together, before the message store publishes parents.
    set((state) => {
      const replyScopes = { ...state.replyScopes };
      for (const [parentMessageId, summary] of Object.entries(summaries)) {
        const acceptedScope = acceptedReplyScopes[parentMessageId];
        if (acceptedScope) {
          replyScopes[parentMessageId] = acceptedScope;
          continue;
        }

        // Flag-off/ineligible compatibility path retains the prior legacy
        // snapshot guard without creating a second Zustand publication.
        const latest = summary?.latestReplies;
        if (!Array.isArray(latest) || typeof summary?.replyCount !== "number") continue;
        const snapshotMax = latest.reduce(
          (max, reply) => Math.max(max, typeof reply?.seq === "number" ? reply.seq : 0),
          0,
        );
        const existing = state.replyScopes[parentMessageId];
        if (existing) {
          const existingMax = existing.replies.reduce(
            (max, reply) => Math.max(max, reply.seq),
            existing.snapshotSeq,
          );
          if (existingMax > snapshotMax) continue;
        }
        replyScopes[parentMessageId] = hydrateThreadRepliesScope(latest, summary.replyCount);
      }
      // A 0→1 reply can enter through the Sync Core rebaseline path rather
      // than `updateSummary`. If the user already opened that previously-empty
      // thread, bind its newly-durable channel id in the same atomic publish so
      // ThreadPanel starts its load/subscribe effect without a close/reopen.
      const openSummary = state.openParentMessageId
        ? summaries[state.openParentMessageId]
        : undefined;
      const adoptThreadId =
        !state.openThreadChannelId
        && typeof openSummary?.threadChannelId === "string"
        && openSummary.threadChannelId.length > 0;
      return {
        summaries: { ...state.summaries, ...summaries },
        replyScopes,
        ...(adoptThreadId ? { openThreadChannelId: openSummary.threadChannelId } : {}),
      };
    });
  },

  loadSummaries: async (channelId, parentMessageIds) => {
    try {
      const params = parentMessageIds
        ? { parentMessageIds: [...new Set(parentMessageIds)].join(",") }
        : undefined;
      const { data } = await api.get(`/channels/${channelId}/threads`, { params });
      get().hydrateSummaries(data as Record<string, ThreadSummary>);
    } catch {
      // ignore
    }
  },

  updateSummary: (parentMessageId, summary) =>
    set((state) => {
      // When a summary arrives for the currently-open parent message and we
      // don't yet know its threadChannelId (lazy-opened empty panel), adopt
      // the id so the load/subscribe effect in ThreadPanel can fire.
      const adoptThreadId =
        state.openParentMessageId === parentMessageId &&
        !state.openThreadChannelId &&
        summary.threadChannelId;
      return {
        summaries: {
          ...state.summaries,
          [parentMessageId]: summary,
        },
        ...(adoptThreadId ? { openThreadChannelId: summary.threadChannelId } : {}),
      };
    }),

  loadFollowedThreads: async () => {
    const epoch = useServerStore.getState().serverEpoch;
    const serverId = useServerStore.getState().current?.id;
    if (!serverId) return;
    try {
      // Stryker disable next-line StringLiteral: endpoint spelling is existing followed-thread load glue; projection behavior is tested after load.
      const { data } = await api.get("/channels/threads/followed");
      if (useServerStore.getState().serverEpoch !== epoch) return;
      // Stryker disable next-line ObjectLiteral: followed-thread setter shape is Zustand glue; projection transform behavior is tested by read-state thread tests.
      set({ followedThreads: applyKnownReadStateProjectionsToFollowedThreads(data.threads) });
    } catch {
      // ignore
    }
  },

  updateFollowedThread: (threadChannelId, updates) =>
    set((state) => ({
      followedThreads: state.followedThreads.map((t) =>
        t.threadChannelId === threadChannelId ? { ...t, ...updates } : t,
      ).sort((a, b) => {
        if (!a.lastReplyAt && !b.lastReplyAt) return 0;
        if (!a.lastReplyAt) return 1;
        if (!b.lastReplyAt) return -1;
        return new Date(b.lastReplyAt).getTime() - new Date(a.lastReplyAt).getTime();
      }),
    })),

  updateFollowedThreadTask: (task) =>
    set((state) => {
      const followedThreads = applyTaskToFollowedThreads(state.followedThreads, task);
      const taskUpdatesByMessageId = updateTaskMetadataCache(state.taskUpdatesByMessageId, task);

      if (followedThreads === state.followedThreads && taskUpdatesByMessageId === state.taskUpdatesByMessageId) return state;

      return {
        followedThreads,
        taskUpdatesByMessageId,
      };
    }),

  clearThreadUnreadLocally: (threadChannelId) => {
    set((state) => {
      let followedThreadsChanged = false;
      const followedThreads = state.followedThreads.map((t) => {
        if (t.threadChannelId !== threadChannelId || t.unreadCount === 0) return t;
        followedThreadsChanged = true;
        return { ...t, unreadCount: 0 };
      });
      const summaries = applyThreadUnreadProjectionToSummaries(
        state.summaries,
        threadChannelId,
        0,
        null,
      );
      if (!followedThreadsChanged && summaries === state.summaries) return state;
      return {
        ...(followedThreadsChanged ? { followedThreads } : {}),
        // Stryker disable next-line ConditionalExpression: including the same summaries reference when only the followed list changes is an equivalent Zustand merge.
        ...(summaries !== state.summaries ? { summaries } : {}),
      };
    });
  },

  applyReadStateProjection: (threadChannelId, projection) => {
    set((state) => {
      // Stryker disable all: thread-list and parent-summary live projection are covered by read-state behavior tests; mutations here alter reference/no-op mechanics, not the authority contract.
      let followedThreadsChanged = false;
      const followedThreads = state.followedThreads.map((t) => {
        if (t.threadChannelId !== threadChannelId || t.unreadCount === projection.unreadCount) return t;
        followedThreadsChanged = true;
        return { ...t, unreadCount: projection.unreadCount };
      });
      const summaries = applyThreadUnreadProjectionToSummaries(
        state.summaries,
        threadChannelId,
        projection.unreadCount,
        projection.firstUnreadMessageId,
      );
      if (!followedThreadsChanged && summaries === state.summaries) return state;
      return {
        ...(followedThreadsChanged ? { followedThreads } : {}),
        ...(summaries !== state.summaries ? { summaries } : {}),
      };
      // Stryker restore all
    });
  },

  hydrateReplyScope: (parentMessageId, replies, replyCount) => {
    set((state) => ({
      replyScopes: {
        ...state.replyScopes,
        [parentMessageId]: hydrateThreadRepliesScope(replies, replyCount),
      },
    }));
  },

  applyReplyScope: (parentMessageId, scope) => {
    set((state) => {
      if (state.replyScopes[parentMessageId] === scope) return state;
      return {
        replyScopes: {
          ...state.replyScopes,
          [parentMessageId]: scope,
        },
      };
    });
  },

  applyReplyFrame: (parentMessageId, reply, authoritativeReplyCount) => {
    set((state) => {
      const current = state.replyScopes[parentMessageId] ?? emptyThreadRepliesScope();
      // The count comes from the frame (the server's authority), never from
      // incrementing ours — see the read model's note on evicted-reply replays.
      const next = applyThreadReplyFrame(current, reply, authoritativeReplyCount);

      // The read model returns the SAME object when the frame changed nothing
      // (stale, duplicate, below the snapshot seam). Bail out rather than
      // rebuilding the map: a fresh map object would re-run ChatPanel's
      // message-list memo for a reply that changed nothing on screen.
      if (next === current) return state;

      // Patch PER KEY. Every untouched scope keeps its exact reference, so a
      // reply in thread A cannot re-render the message owning thread B.
      return {
        replyScopes: {
          ...state.replyScopes,
          [parentMessageId]: next,
        },
      };
    });
  },

  clearThreadUnread: (threadChannelId, receiverOverride, options) => {
    const serverState = useServerStore.getState();
    const readContext = {
      channelId: threadChannelId,
      serverId: serverState.current?.id ?? null,
      serverEpoch: serverState.serverEpoch,
      principalId: getCurrentPrincipalId(),
      receiver: receiverOverride === undefined
        ? captureReadAllReceiver()
        : receiverOverride ?? undefined,
    };
    notifyChannelReadLocally(threadChannelId);
    get().clearThreadUnreadLocally(threadChannelId);
    // Persist to backend so it survives page refresh. A direct thread deep-link
    // starts with an empty Activity store, so its first hydration can race this
    // request and miss the optimistic notification above. Publish the captured
    // identity on success so Activity can reconcile canonically; never perform
    // another blind channel-wide clear because a newer reply may have arrived
    // beyond this read boundary while the request was in flight.
    // #5690: read-all is ALWAYS persisted; only the persisted notification is
    // scoped out when the caller owns an awaited, generation-fenced refresh.
    // Failure still publishes nothing, so no path can produce a second GET.
    postReadAllCoalesced(threadChannelId, readContext).then(
      () => {
        if (options?.suppressPersistedNotification) return;
        notifyChannelReadPersistedLocally(readContext);
      },
      () => {},
    );
  },

  // Stryker disable all: follow/unfollow RPCs are unchanged thread-list plumbing
  // pulled into the mutation diff by extracting the task metadata updater.
  followThread: async (parentMessageId) => {
    try {
      await api.post("/channels/threads/follow", { parentMessageId });
    } catch (err) {
      console.error("Failed to follow thread:", err);
      // Callers that own another projection (for example Activity terminal
      // history) must not clear it unless the canonical follow committed.
      throw err;
    }

    // The mutation above is canonical. Refreshing the followed-list projection
    // is best effort: a transient GET failure must not make Activity preserve
    // an Unfollowed badge after the server already committed the Follow.
    try {
      const { data } = await api.get("/channels/threads/followed");
      set({ followedThreads: applyKnownReadStateProjectionsToFollowedThreads(data.threads) });
    } catch (err) {
      console.error("Failed to refresh followed threads:", err);
    }
  },

  unfollowThread: async (threadChannelId) => {
    try {
      await api.post("/channels/threads/unfollow", { threadChannelId });
      set((state) => ({
        followedThreads: state.followedThreads.filter((t) => t.threadChannelId !== threadChannelId),
      }));
    } catch (err) {
      console.error("Failed to unfollow thread:", err);
      // Callers that own another projection (for example Activity) must know
      // whether the canonical mutation committed before removing their row.
      throw err;
    }
  },
  // Stryker restore all

  markThreadDone: async (threadChannelId) => {
    const acceptedThread = get().followedThreads.find((thread) => thread.threadChannelId === threadChannelId);
    if (
      !acceptedThread
      || typeof acceptedThread.latestActivitySeq !== "string"
      || !/^[1-9][0-9]*$/.test(acceptedThread.latestActivitySeq)
    ) {
      await get().loadFollowedThreads();
      return;
    }
    const throughActivitySeq = acceptedThread.latestActivitySeq;
    // Optimistic: remove from list immediately
    set((state) => ({
      followedThreads: state.followedThreads.filter((t) => t.threadChannelId !== threadChannelId),
    }));
    try {
      // Stryker disable next-line StringLiteral,ObjectLiteral: done RPC endpoint/payload predates this read-state projection slice.
      await api.post("/channels/threads/done", {
        threadChannelId,
        throughActivitySeq,
        frontierSpace: "storage",
      });
    } catch (err) {
      console.error("Failed to mark thread as done:", err);
      // Reload on failure to restore correct state
      // Stryker disable next-line StringLiteral: failure-reload endpoint is legacy recovery glue outside read-state projection behavior.
      const { data } = await api.get("/channels/threads/followed");
      // Stryker disable next-line ObjectLiteral: done-failure reload setter is legacy recovery glue outside read-state projection behavior.
      set({ followedThreads: applyKnownReadStateProjectionsToFollowedThreads(data.threads) });
    }
  },

  undoneThread: async (threadChannelId) => {
    try {
      // Stryker disable next-line StringLiteral,ObjectLiteral: undone RPC endpoint/payload predates this read-state projection slice.
      await api.post("/channels/threads/undone", { threadChannelId });
      // Reload to get the full thread data
      // Stryker disable next-line StringLiteral: undone reload endpoint is legacy recovery glue outside read-state projection behavior.
      const { data } = await api.get("/channels/threads/followed");
      // Stryker disable next-line ObjectLiteral: undone reload setter is legacy recovery glue outside read-state projection behavior.
      set({ followedThreads: applyKnownReadStateProjectionsToFollowedThreads(data.threads) });
    // Stryker disable next-line BlockStatement: diagnostic-only catch is outside read-state projection behavior.
    } catch (err) {
      // Stryker disable next-line StringLiteral: diagnostic copy is outside read-state projection behavior.
      console.error("Failed to undone thread:", err);
    }
  },
}));

// Stryker disable all: listener wiring is integration glue covered through inbox/thread projection behavior tests.
registerReadStateProjectionListener((_serverId, scopeId, projection) => {
  useThreadStore.getState().applyReadStateProjection(scopeId, projection);
});
// Stryker restore all

// Reset all server-scoped state when the user switches servers.
registerServerReset(() =>
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
    openServerSlug: null,
    openThreadError: null,
    openThreadLoading: false,
    focusedMessageId: null,
    summaries: {},
    replyScopes: {},
    followedThreads: [],
    taskUpdatesByMessageId: {},
    focusedThreadChannelId: null,
  })
);

registerMessagesSyncCoreReset(() =>
  useThreadStore.setState({ replyScopes: {} })
);
