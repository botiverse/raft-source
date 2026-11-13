import { create } from "zustand";
import { listFetchReasonHeaders } from "./listFetchReason";
import type { ListFetchReason } from "./listFetchReason";
import { useUIStore } from "./uiStore";
import { forgetSkippedSeenRead } from "./seenReadCatchUp";
import { applyThreadUnreadProjectionToSummaries, isReopenedTaskUnread, isReopenedThreadUnread, keepShownThreadsRead } from "./threadUnreadLocal";
import api from "../api/client";
import { getRwRead } from "../api/overloadRetry";
import { saveLastCounts } from "./lastCounts";
import { useServerStore } from "./serverStore";
import { getCurrentPrincipalId } from "./principalRuntime";
import { captureReadAllReceiver } from "./receiverPrivateIngress";
import { postReadAllCoalesced } from "./transport/inboxTransport";
import { registerServerReset } from "./serverResetRegistry";
import { registerMessagesSyncCoreReset } from "./messageSyncCoreReset";
import {
  getAcceptedReadState,
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
import { isTaskConversationRow, normalizeTaskConversationRow } from "../utils/taskConversation";
import type { SubConversationKind } from "../utils/taskConversation";
import { beginViewSwitch, threadView } from "../observability/viewSwitchSpan";
import { prefetchResolvedThreadReplies, prefetchThreadReplies } from "./threadRepliesPrefetch";

// The reply-preview type is owned by the read model (the SDK contract surface),
// NOT redefined here. One definition, one place — two copies of a contract type
// is the same drift the cross-repo checksum gate exists to stop.
import {
  applyThreadReplyFrame,
  emptyThreadRepliesScope,
  hydrateThreadRepliesScope,
  retainNewerThreadReplyContent,
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
  /**
   * The current user follows this thread (done or not). Served with summaries
   * by servers that have it; absent from live `thread:updated` frames and older
   * servers, so read it through `isThreadFollowed`.
   */
  followed?: boolean;
  /** Newest ≤3 conversation replies (system excluded), served upfront for inline previews. */
  latestReplies?: ThreadReplyPreview[];
}

export interface FollowedThread {
  threadChannelId: string;
  /** The thread's explicit notification level (contract §2.2; absent = default or an older server). */
  notificationLevel?: "default" | "all" | "mentions" | "none" | null;
  parentMessageId: string;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: string;
  parentMessagePreview: string;
  parentMessageSenderType: string;
  parentMessageSenderId: string;
  /** When the parent message was posted (its place in the channel). Absent on older servers. */
  parentMessageCreatedAt?: string;
  /**
   * The server's answers, with the history paywall's own cutoff: whether the
   * parent message is inside the plan's history window, and whether the
   * thread has replies inside it. Absent on older servers.
   */
  parentInHistory?: boolean;
  repliesInHistory?: boolean;
  /** Same-source frontier paired with the accepted row's latest activity. */
  latestActivitySeq: string | null;
  replyCount: number;
  lastReplyAt: string | null;
  unreadCount: number;
  /**
   * An unread reply mentions the user (server: same source as the sidebar
   * summary). Only meaningful while unreadCount > 0; absent on older servers.
   */
  hasMention?: boolean;
  /** First unread reply, the jump target; null when read. Absent on older servers. */
  firstUnreadMessageId?: string | null;
  /** Canonical legacy-task id for mutation routes; absent on older servers and non-task threads. */
  taskId?: string | null;
  taskNumber: number | null;
  taskStatus: string | null;
  taskClaimedByType?: "agent" | "user" | null;
  taskClaimedById?: string | null;
  taskClaimedByName: string | null;
  /** Task v2: a followed task conversation (no parent message; see
   *  utils/taskConversation.ts) rather than a message's thread. */
  conversationKind?: SubConversationKind;
  /** Task v2: the task's title, on a followed task conversation. */
  taskTitle?: string | null;
  /** Task v2: the message the task hangs under and its time, its place in the
   *  channel (null: under no message). Absent on older servers. */
  sourceMessageId?: string | null;
  sourceMessageCreatedAt?: string | null;
}

type ServedFollowedThread = FollowedThread & { maxReadSeq?: number | string | null; readStateVersion?: number | null };

// Stryker disable all: followed-thread hydration projection is covered by read-state behavior tests; surviving mutants here are no-op/reference variants around the same projection result.
/**
 * A served followed-thread row can be older than what this client knows: the
 * read made by opening a thread reaches the ledger through its ack before
 * RisingWave ingests the cursor, so a reload in that gap brings the old unread
 * back (badge and jump pill stop dropping). Same adjudication as the Activity
 * inbox: a row is read when the ledger's newer cursor covers its latest
 * activity, or when it was cleared here and has no activity since.
 */
function applyKnownReadStateProjectionsToFollowedThreads(
  servedThreads: ServedFollowedThread[],
  previous: readonly FollowedThread[] = [],
): FollowedThread[] {
  // Task v2: followed task conversations arrive in the same list; fold them
  // into the thread shape (no parent message) before anything keys them.
  const threads = servedThreads.some(isTaskConversationRow)
    ? servedThreads.map((thread) => normalizeTaskConversationRow(thread))
    : servedThreads;
  const serverId = useServerStore.getState().current?.id;
  if (!serverId) return threads;
  const previousById = new Map(previous.map((thread) => [thread.threadChannelId, thread]));
  let changed = false;
  const projected = threads.map((thread) => {
    if (thread.unreadCount > 0 && isServedThreadRowRead(serverId, thread, previousById.get(thread.threadChannelId))) {
      changed = true;
      return { ...thread, unreadCount: 0, firstUnreadMessageId: null, hasMention: false };
    }
    const projection = getAcceptedReadStateProjection(serverId, thread.threadChannelId);
    if (!projection?.complete || thread.unreadCount === projection.unreadCount) return thread;
    changed = true;
    return { ...thread, unreadCount: projection.unreadCount };
  });
  return changed ? projected : threads;
}
// Stryker restore all

function isServedThreadRowRead(serverId: string, thread: ServedFollowedThread, local: FollowedThread | undefined): boolean {
  const latestSeq = thread.latestActivitySeq;
  if (latestSeq == null) return false;
  if (local && local.unreadCount === 0 && local.latestActivitySeq === latestSeq) return true;
  const ledger = getAcceptedReadState(serverId, thread.threadChannelId);
  if (!ledger || ledger.readStateVersion <= (thread.readStateVersion ?? 0)) return false;
  return BigInt(ledger.maxReadSeq) >= BigInt(latestSeq);
}

/**
 * `GET /channels/:id/threads/:messageId` 404s both when the message genuinely
 * has no thread yet (normal "no replies yet" state) and when the lookup itself
 * failed (channel not visible, server mismatch). Only the former is empty —
 * identified by `code: "THREAD_NOT_FOUND"`, or on servers that predate the code
 * by the exact "No thread found for this message" error text. Every other
 * failure must surface as an error with Retry (task #14).
 */
const THREAD_ABSENT_LOOKUP_CODE = "THREAD_NOT_FOUND";
const THREAD_ABSENT_LOOKUP_ERROR = "No thread found for this message";

export function isThreadAbsentLookupError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("response" in err)) return false;
  const response = (err as { response?: { status?: unknown; data?: unknown } }).response;
  if (response?.status !== 404) return false;
  const data = response.data;
  if (typeof data !== "object" || data === null) return false;
  const body = data as { code?: unknown; error?: unknown };
  if (body.code !== undefined) return body.code === THREAD_ABSENT_LOOKUP_CODE;
  return body.error === THREAD_ABSENT_LOOKUP_ERROR;
}

/**
 * The lookup's answer that this server can't show the thread to this reader
 * (403, or a 404 that isn't "no thread yet"): the channel isn't visible from
 * the current server. A joint channel the reader takes part in only through
 * another server answers this way. Retry can still help right after a
 * private→public conversion (#417), so the panel keeps it; only the copy
 * changes.
 */
export function isThreadUnavailableLookupError(err: unknown): boolean {
  if (isThreadAbsentLookupError(err)) return false;
  const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return status === 403 || status === 404;
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

/**
 * The task modal's identity slot (task #699). A task modal and the side thread
 * are TWO surfaces that used to share the one `open*` slot, so opening a task
 * over a side thread clobbered the side thread's identity and remounted it.
 * The slot is fully independent: opening a task never touches `open*`, and
 * closing the modal is just `taskModal = null` — no capture/restore dance,
 * nothing to re-render underneath.
 */
interface TaskModalAnchor {
  /** The message whose thread is the task's discussion (pre-v2 / flag off).
   *  Null for a task v2 dialog, which is keyed by `taskId` instead. */
  parentMessageId: string | null;
  /** Task v2: the task whose own conversation the dialog shows. Set only by
   *  `openTaskConversation`, so with the flag off it is always absent. */
  taskId?: string | null;
  parentChannelId: string | null;
  threadChannelId: string | null;
  serverSlug: string | null;
  focusedMessageId: string | null;
  /** Names the jump to `focusedMessageId`: new on every open with a focus, so
   *  a second jump to the same reply restarts its located highlight. */
  focusNonce: number;
  loading: boolean;
  error: { parentChannelId: string | null; parentMessageId: string | null; unavailable?: boolean } | null;
}

/** Task v2: open the task dialog for a task's own conversation. */
export interface OpenTaskConversationRequest {
  serverSlug?: string;
  taskId: string;
  /** The (local) channel the task belongs to. */
  parentChannelId: string;
  /** The task conversation as this server sees it (its LOCAL channel id; a
   *  joint channel's canonical id differs). Null while unknown or when the
   *  task has no conversation yet (a pre-v2 task): the first send creates it. */
  conversationChannelId?: string | null;
  focusedMessageId?: string | null;
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
  /** Names the jump to `focusedMessageId` (states.md#located): new on every
   *  focus, so a second jump to the same reply restarts its highlight; the
   *  reply's own id can't, it is the same both times. */
  focusNonce: number;
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
  /**
   * Followed threads with unread replies (`?unreadOnly=1`): the source of the
   * sidebar thread badge and the jump pill. Not every followed thread: a read
   * one is only here until the next load. Ask `isThreadFollowed` for follow state.
   * Must be replaced, not mutated: threadUnreadByParent caches by identity.
   */
  followedThreads: FollowedThread[];
  /** Follow / unfollow done in this session, keyed by parent message ID; wins over summaries. */
  followOverrides: Record<string, boolean>;
  /** Latest task metadata keyed by parent message ID, including DM-thread parents outside task boards */
  taskUpdatesByMessageId: Record<string, TaskMetadataUpdate>;
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
  openThreadError: { parentChannelId: string; parentMessageId: string; unavailable?: boolean } | null;
  /** True only while the read-only existing-thread lookup is in flight. */
  openThreadLoading: boolean;
  /** Open a thread panel for a message */
  openThread: (request: OpenThreadRequest) => Promise<void>;
  /** Intent of the currently open thread; null when none is open. */
  openIntent: "thread" | "task" | null;
  /** The task modal's independent identity slot (task #699). */
  taskModal: TaskModalAnchor | null;
  /**
   * Open a task modal for a message. Never touches `open*` — a side thread
   * that is open underneath keeps its identity, mount, and scroll.
   */
  openTaskModal: (request: OpenThreadRequest) => Promise<void>;
  /**
   * Task v2: open the task dialog keyed by the task (its conversation has no
   * parent message). Like `openTaskModal`, never touches the side thread.
   */
  openTaskConversation: (request: OpenTaskConversationRequest) => void;
  /** Task v2: bind the open task dialog to its (local) conversation channel. */
  bindTaskConversationChannel: (taskId: string, conversationChannelId: string) => void;
  /** Task v2: follow / unfollow overrides for task conversations done in this
   *  session, keyed by the LOCAL conversation channel id. */
  taskFollowOverrides: Record<string, boolean>;
  /** Task v2: follow a task conversation by hand. */
  followTaskConversation: (conversationChannelId: string) => Promise<void>;
  /** Task v2: unfollow a task conversation. */
  unfollowTaskConversation: (conversationChannelId: string) => Promise<void>;
  /**
   * Close the task modal (X, backdrop, ESC, mobile back). Just empties the
   * slot; the side thread was never perturbed, so there is nothing to restore.
   */
  closeTaskModal: () => void;
  /**
   * Task v2: the task was deleted (`task:deleted`). Its conversation is gone
   * server-side, so drop its followed-list row and follow override and close
   * the task dialog open on it (keyed by the task, or bound to that
   * conversation). A pre-v2 task's dialog is its host message's thread, which
   * stays, so it is left alone.
   */
  dropDeletedTaskConversation: (input: { taskId: string; conversationChannelId?: string | null }) => void;
  /**
   * Re-run the task modal's thread lookup against the channel's current
   * accessibility — the slot twin of `retryOpenThread`.
   */
  retryTaskModal: () => Promise<void>;
  /**
   * Persist the currently-open thread channel on the first durable action
   * (reply or attachment upload). Merely opening/reading a thread must never
   * call this writer.
   */
  ensureOpenThreadChannel: () => Promise<string>;
  /**
   * Task-modal twin of `ensureOpenThreadChannel`: resolves (creating on first
   * durable send) the thread anchored in the `taskModal` slot. Reading the
   * side thread's open* slots for a modal send was the task #750 bug — a
   * zero-reply task modal must resolve from its own anchor. Same discipline
   * as the side thread: resolution alone stays local; the slot is bound on
   * durable accept via the panel's `onChannelResolved`.
   */
  ensureTaskModalThreadChannel: () => Promise<string>;
  /**
   * Re-run resolution for the currently-open thread against the channel's
   * *current* accessibility. Used by ThreadPanel's Retry affordance after an
   * `openThread` failure (see `openThreadError`).
   */
  retryOpenThread: () => Promise<void>;
  /** Close the thread panel */
  closeThread: () => void;
  /** Focus a reply in the open side thread (a permalink to it): a new jump. */
  focusMessage: (messageId: string) => void;
  /** Clear focused reply once the highlight animation completes */
  clearFocusedMessage: () => void;
  /** The task modal's own focused reply, cleared the same way: a task modal
   * jump never touches the side thread's focus (task #699). */
  clearTaskModalFocusedMessage: () => void;
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
  loadFollowedThreads: (reason?: ListFetchReason) => Promise<void>;
  /** Update a followed thread from socket event */
  updateFollowedThread: (threadChannelId: string, updates: Partial<Pick<FollowedThread, "replyCount" | "lastReplyAt" | "unreadCount" | "hasMention" | "firstUnreadMessageId">>) => void;
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
  /** Server-reported unread for a thread whose replies are not loaded here. */
  applyServerThreadUnread: (threadChannelId: string, unreadCount: number) => void;
  /**
   * The server's count after Mark as Unread on a thread (a person's own word,
   * so it raises the badge, where a served read only lowers it).
   */
  applyThreadMarkedUnread: (threadChannelId: string, unreadCount: number) => void;
  /** Follow a thread manually */
  followThread: (parentMessageId: string) => Promise<void>;
  /** Unfollow a thread */
  unfollowThread: (threadChannelId: string) => Promise<void>;
  /** Mark a thread as done (hide from active list) */
  markThreadDone: (threadChannelId: string) => Promise<void>;
  /** Un-done a thread (restore to active list) */
  undoneThread: (threadChannelId: string) => Promise<void>;
}

const FOLLOWED_UNREAD_ONLY_PARAMS = { unreadOnly: 1 } as const;

/**
 * The followed threads with unread replies, a RisingWave read like the unread
 * counts: retried once on an overload 503 and recorded in store/rwFreshness
 * (task #164). Every load of the list goes through here.
 */
async function fetchFollowedThreads(reason?: ListFetchReason): Promise<{ threads: FollowedThread[]; stale: boolean }> {
  // Only the followed threads with unread replies: the full list is
  // thousands of threads for some users (p99 4.7 MB). Servers without the
  // filter ignore it and return the full list, which still works.
  const { data, stale } = await getRwRead<{ threads: FollowedThread[] }>("followed", "/channels/threads/followed", {
    params: FOLLOWED_UNREAD_ONLY_PARAMS,
    headers: listFetchReasonHeaders(reason),
  });
  return { threads: data.threads, stale };
}

/** A summary without `followed` (live frame, older server) keeps the one already known. */
function keepKnownFollowed(next: ThreadSummary, previous: ThreadSummary | undefined): ThreadSummary {
  if (next.followed !== undefined || previous?.followed === undefined) return next;
  return { ...next, followed: previous.followed };
}

function withKnownFollowed(
  next: Record<string, ThreadSummary>,
  previous: Record<string, ThreadSummary>,
): Record<string, ThreadSummary> {
  let out: Record<string, ThreadSummary> | null = null;
  for (const [parentMessageId, summary] of Object.entries(next)) {
    const kept = keepKnownFollowed(summary, previous[parentMessageId]);
    if (kept === summary) continue;
    out ??= { ...next };
    out[parentMessageId] = kept;
  }
  return out ?? next;
}

/**
 * Unfollowing a thread clears its unread: the server counts none for a thread
 * the person doesn't follow, so every local count drops to 0 at once rather
 * than on the next list load. This store clears its own (summaries, followed
 * list); stores that import this one (Activity) clear theirs here.
 */
type ThreadUnfollowedListener = (threadChannelId: string) => void;
const threadUnfollowedListeners = new Set<ThreadUnfollowedListener>();

export function registerThreadUnfollowedListener(listener: ThreadUnfollowedListener): () => void {
  threadUnfollowedListeners.add(listener);
  return () => threadUnfollowedListeners.delete(listener);
}

function notifyThreadUnfollowed(threadChannelId: string): void {
  for (const listener of threadUnfollowedListeners) listener(threadChannelId);
}

/**
 * Whether the user follows the thread under `parentMessageId`: a follow or
 * unfollow done in this session, else the summary's `followed`, else (older
 * server, no summary yet) whether it is in the followed-thread list.
 */
export function isThreadFollowed(
  state: Pick<ThreadState, "followOverrides" | "summaries" | "followedThreads">,
  parentMessageId: string,
): boolean {
  const override = state.followOverrides[parentMessageId];
  if (override !== undefined) return override;
  const followed = state.summaries[parentMessageId]?.followed;
  if (followed !== undefined) return followed;
  return state.followedThreads.some((thread) => thread.parentMessageId === parentMessageId);
}

/**
 * Task v2: whether the user follows the task conversation `conversationChannelId`
 * (its local channel id): a follow or unfollow done in this session, else the
 * served answer (`served`, e.g. the task DTO), else whether it is in the
 * followed-thread list.
 */
export function isTaskConversationFollowed(
  state: Pick<ThreadState, "taskFollowOverrides" | "followedThreads">,
  conversationChannelId: string | null,
  served?: boolean,
): boolean {
  if (!conversationChannelId) return served ?? false;
  const override = state.taskFollowOverrides[conversationChannelId];
  if (override !== undefined) return override;
  if (served !== undefined) return served;
  return state.followedThreads.some((thread) => thread.threadChannelId === conversationChannelId);
}

/** Counts focus jumps (the side thread's and the task modal's alike), so each
 * has a nonce of its own. */
let focusSeq = 0;
export function nextFocusNonce(): number {
  focusSeq += 1;
  return focusSeq;
}

let followedThreadsRequestSeq = 0;

export const useThreadStore = create<ThreadState>((set, get) => ({
  openParentMessageId: null,
  openIntent: null,
  taskModal: null,
  taskFollowOverrides: {},
  openThreadChannelId: null,
  openParentChannelId: null,
  openServerSlug: null,
  openThreadError: null,
  openThreadLoading: false,
  focusedMessageId: null,
  focusNonce: 0,
  openedAt: 0,
  summaries: {},
  replyScopes: {},
  followedThreads: [],
  followOverrides: {},
  taskUpdatesByMessageId: {},


  openThread: async ({
    serverSlug,
    parentChannelId,
    parentMessageId,
    threadChannelId = null,
    focusedMessageId = null,
    initialThreadChannelId = null,
    intent = "thread",
  }) => {
    // A task open is a different surface with its own slot — it must never
    // clobber the side thread's identity (task #699).
    if (intent === "task") {
      await get().openTaskModal({
        serverSlug,
        parentChannelId,
        parentMessageId,
        threadChannelId,
        focusedMessageId,
        initialThreadChannelId,
        intent,
      });
      return;
    }
    const currentServer = useServerStore.getState().current;
    const routeServerSlug = serverSlug ?? currentServer?.slug ?? null;
    if (serverSlug && currentServer?.slug !== serverSlug) {
      console.error("Failed to open thread: route server is not active");
      return;
    }
    const previousParentChannelId = get().openParentChannelId;
    if (previousParentChannelId === null) useUIStore.getState().resumeThreadLayout(parentMessageId);
    else if (previousParentChannelId !== parentChannelId) useUIStore.getState().restoreThreadLayout();
    else useUIStore.getState().retargetThreadLayout(parentMessageId);
    const serverEpoch = useServerStore.getState().serverEpoch;
    // Look up threadChannelId from existing data so we can open the panel immediately
    const state = useThreadStore.getState();
    const knownThreadChannelId =
      threadChannelId ??
      initialThreadChannelId ??
      state.summaries[parentMessageId]?.threadChannelId ??
      state.followedThreads.find((t) => t.parentMessageId === parentMessageId)?.threadChannelId ??
      null;

    // The open thread picked again keeps its panel, whose open read won't re-run: read it below.
    const reopenedUnread = isReopenedThreadUnread(state, parentMessageId, knownThreadChannelId);
    // Opened by a click: the replies painted end it (observability/viewSwitchSpan.ts); a thread already on screen is not timed.
    beginViewSwitch({ target: "thread", view: threadView(parentMessageId), matches: [parentMessageId, knownThreadChannelId], requireInput: true });
    // Set panel-open state immediately — don't wait for API. Clear any prior
    // resolution error so a retry/new-open starts from a clean state. Opening
    // a thread replaces whatever task modal was up.
    set({
      openParentMessageId: parentMessageId,
      openIntent: intent,
      openThreadChannelId: knownThreadChannelId,
      openParentChannelId: parentChannelId,
      openServerSlug: routeServerSlug,
      openThreadError: null,
      openThreadLoading: !knownThreadChannelId,
      focusedMessageId,
      focusNonce: nextFocusNonce(),
      openedAt: Date.now(),
      taskModal: null,
    });
    if (reopenedUnread) get().clearThreadUnread(knownThreadChannelId);
    if (knownThreadChannelId && state.openThreadChannelId !== knownThreadChannelId) prefetchThreadReplies(knownThreadChannelId, parentMessageId, focusedMessageId);
    if (knownThreadChannelId) return;

    try {
      // Opening is a read. Resolve an existing channel if one is already
      // durable; only the route's explicit "no thread for this message" 404 is
      // the normal "no replies yet" state (see isThreadAbsentLookupError).
      const { data } = await api.get(`/channels/${parentChannelId}/threads/${parentMessageId}`);
      if (
        useServerStore.getState().serverEpoch !== serverEpoch
        || (routeServerSlug && useServerStore.getState().current?.slug !== routeServerSlug)
      ) return;
      if (data?.threadChannelId) {
        prefetchResolvedThreadReplies(get(), routeServerSlug, parentMessageId, data.threadChannelId);
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
      if (isThreadAbsentLookupError(err)) {
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
          ? {
            openThreadError: { parentChannelId, parentMessageId, unavailable: isThreadUnavailableLookupError(err) },
            openThreadLoading: false,
          }
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

  ensureTaskModalThreadChannel: async () => {
    const slot = get().taskModal;
    if (!slot) {
      throw new Error("No open task modal to resolve");
    }
    if (slot.threadChannelId) return slot.threadChannelId;
    if (slot.taskId && !slot.parentMessageId) {
      // Task v2: a task without its own conversation yet (a pre-v2 task) gets
      // it on the first durable send. The answer is this server's LOCAL
      // conversation; the panel binds the slot on durable accept.
      const taskId = slot.taskId;
      const taskServerSlug = slot.serverSlug;
      const taskServerEpoch = useServerStore.getState().serverEpoch;
      const { data } = await api.post(`/tasks/${taskId}/conversation`);
      const conversationChannelId = (data as { conversationChannelId?: unknown } | null)?.conversationChannelId;
      if (typeof conversationChannelId !== "string" || conversationChannelId.length === 0) {
        throw new Error("Task conversation creation did not return a channel id");
      }
      const currentTaskSlot = get().taskModal;
      if (
        useServerStore.getState().serverEpoch !== taskServerEpoch
        || !currentTaskSlot
        || currentTaskSlot.taskId !== taskId
        || currentTaskSlot.serverSlug !== taskServerSlug
      ) {
        throw new Error("Task context changed while creating its conversation");
      }
      return conversationChannelId;
    }
    const { parentChannelId, parentMessageId, serverSlug } = slot;
    if (!parentChannelId || !parentMessageId) {
      throw new Error("No open task modal to resolve");
    }

    const serverEpoch = useServerStore.getState().serverEpoch;
    const { data } = await api.post(`/channels/${parentChannelId}/threads`, {
      parentMessageId,
    });
    if (typeof data?.threadChannelId !== "string" || data.threadChannelId.length === 0) {
      throw new Error("Thread creation did not return a channel id");
    }
    if (
      useServerStore.getState().serverEpoch !== serverEpoch
      || (serverSlug && useServerStore.getState().current?.slug !== serverSlug)
    ) {
      throw new Error("Thread context changed while creating the thread");
    }
    const current = get().taskModal;
    if (
      !current
      || current.serverSlug !== serverSlug
      || current.parentChannelId !== parentChannelId
      || current.parentMessageId !== parentMessageId
    ) {
      throw new Error("Thread context changed while creating the thread");
    }
    // Same discipline as the side thread: resolution alone stays local; the
    // slot is bound on durable accept (ThreadPanel's onChannelResolved).
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

  closeThread: () => {
    useUIStore.getState().restoreThreadLayout();
    set({
      openParentMessageId: null,
      openIntent: null,
      openThreadChannelId: null,
      openParentChannelId: null,
      openServerSlug: null,
      openThreadError: null,
      openThreadLoading: false,
      focusedMessageId: null,
    });
  },

  openTaskModal: async ({
    serverSlug,
    parentChannelId,
    parentMessageId,
    threadChannelId = null,
    focusedMessageId = null,
    initialThreadChannelId = null,
  }) => {
    const currentServer = useServerStore.getState().current;
    const routeServerSlug = serverSlug ?? currentServer?.slug ?? null;
    if (serverSlug && currentServer?.slug !== serverSlug) {
      console.error("Failed to open task modal: route server is not active");
      return;
    }
    const serverEpoch = useServerStore.getState().serverEpoch;
    const state = useThreadStore.getState();
    const knownThreadChannelId =
      threadChannelId ??
      initialThreadChannelId ??
      state.summaries[parentMessageId]?.threadChannelId ??
      state.followedThreads.find((t) => t.parentMessageId === parentMessageId)?.threadChannelId ??
      null;
    // The task already up picked again: its open read won't re-run (as openThread).
    const reopenedUnread = isReopenedTaskUnread(state, knownThreadChannelId);

    set({
      taskModal: {
        parentMessageId,
        parentChannelId,
        threadChannelId: knownThreadChannelId,
        serverSlug: routeServerSlug,
        focusedMessageId,
        focusNonce: nextFocusNonce(),
        loading: !knownThreadChannelId,
        error: null,
      },
    });
    if (reopenedUnread) get().clearThreadUnread(knownThreadChannelId);
    if (knownThreadChannelId) return;

    try {
      // Same read-only existing-thread lookup as openThread, mirrored into the
      // task-modal slot instead of the side-thread fields.
      const { data } = await api.get(`/channels/${parentChannelId}/threads/${parentMessageId}`);
      if (
        useServerStore.getState().serverEpoch !== serverEpoch
        || (routeServerSlug && useServerStore.getState().current?.slug !== routeServerSlug)
      ) return;
      if (data?.threadChannelId) {
        set((prev) => ({
          ...(prev.taskModal?.serverSlug === routeServerSlug && prev.taskModal.parentMessageId === parentMessageId
            ? {
                taskModal: {
                  ...prev.taskModal,
                  threadChannelId: data.threadChannelId,
                  error: null,
                  loading: false,
                },
              }
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
          prev.taskModal?.serverSlug === routeServerSlug && prev.taskModal.parentMessageId === parentMessageId
            ? { taskModal: { ...prev.taskModal, loading: false } }
            : {},
        );
      }
    } catch (err: unknown) {
      if (isThreadAbsentLookupError(err)) {
        set((prev) =>
          prev.taskModal?.serverSlug === routeServerSlug && prev.taskModal.parentMessageId === parentMessageId
            ? { taskModal: { ...prev.taskModal, loading: false } }
            : {},
        );
        return;
      }
      console.error("Failed to open task modal:", err);
      if (
        useServerStore.getState().serverEpoch !== serverEpoch
        || (routeServerSlug && useServerStore.getState().current?.slug !== routeServerSlug)
      ) return;
      set((prev) =>
        prev.taskModal?.serverSlug === routeServerSlug
          && prev.taskModal.parentMessageId === parentMessageId
          && !prev.taskModal.threadChannelId
          ? {
            taskModal: {
              ...prev.taskModal,
              error: { parentChannelId, parentMessageId, unavailable: isThreadUnavailableLookupError(err) },
              loading: false,
            },
          }
          : {},
      );
    }
  },

  openTaskConversation: ({ serverSlug, taskId, parentChannelId, conversationChannelId = null, focusedMessageId = null }) => {
    const currentServer = useServerStore.getState().current;
    if (serverSlug && currentServer?.slug !== serverSlug) {
      console.error("Failed to open task: route server is not active");
      return;
    }
    const routeServerSlug = serverSlug ?? currentServer?.slug ?? null;
    const current = get().taskModal;
    // Re-opening the dialog that is already up keeps its bound conversation.
    const keptChannelId = current?.taskId === taskId && current.serverSlug === routeServerSlug
      ? current.threadChannelId
      : null;
    const threadChannelId = conversationChannelId ?? keptChannelId;
    const reopenedUnread = isReopenedTaskUnread(get(), threadChannelId);
    set({
      taskModal: {
        parentMessageId: null,
        taskId,
        parentChannelId,
        threadChannelId,
        serverSlug: routeServerSlug,
        focusedMessageId,
        focusNonce: nextFocusNonce(),
        loading: false,
        error: null,
      },
    });
    if (reopenedUnread && threadChannelId) get().clearThreadUnread(threadChannelId);
  },

  bindTaskConversationChannel: (taskId, conversationChannelId) =>
    set((prev) =>
      prev.taskModal?.taskId === taskId && prev.taskModal.threadChannelId !== conversationChannelId
        ? { taskModal: { ...prev.taskModal, threadChannelId: conversationChannelId } }
        : {},
    ),

  followTaskConversation: async (conversationChannelId) => {
    try {
      // A task conversation is named by its (local) channel; thread follows
      // keep sending `parentMessageId`.
      await api.post("/channels/threads/follow", { threadChannelId: conversationChannelId });
    } catch (err) {
      console.error("Failed to follow task:", err);
      throw err;
    }
    set((state) => ({ taskFollowOverrides: { ...state.taskFollowOverrides, [conversationChannelId]: true } }));
    try {
      const data = await fetchFollowedThreads("manual");
      set({ followedThreads: applyKnownReadStateProjectionsToFollowedThreads(data.threads, get().followedThreads) });
    } catch (err) {
      console.error("Failed to refresh followed threads:", err);
    }
  },

  unfollowTaskConversation: async (conversationChannelId) => {
    try {
      await api.post("/channels/threads/unfollow", { threadChannelId: conversationChannelId });
    } catch (err) {
      console.error("Failed to unfollow task:", err);
      throw err;
    }
    set((state) => ({
      followedThreads: state.followedThreads.filter((t) => t.threadChannelId !== conversationChannelId),
      taskFollowOverrides: { ...state.taskFollowOverrides, [conversationChannelId]: false },
      summaries: applyThreadUnreadProjectionToSummaries(state.summaries, conversationChannelId, 0, null),
    }));
    notifyThreadUnfollowed(conversationChannelId);
  },

  closeTaskModal: () => set({ taskModal: null }),

  dropDeletedTaskConversation: ({ taskId, conversationChannelId = null }) =>
    set((state) => {
      const modal = state.taskModal;
      const closesModal = !!modal && !modal.parentMessageId && (
        modal.taskId === taskId
        || (conversationChannelId !== null && modal.threadChannelId === conversationChannelId)
      );
      if (!conversationChannelId) return closesModal ? { taskModal: null } : {};
      const followedThreads = state.followedThreads.filter((thread) => thread.threadChannelId !== conversationChannelId);
      const taskFollowOverrides = { ...state.taskFollowOverrides };
      delete taskFollowOverrides[conversationChannelId];
      return {
        ...(followedThreads.length !== state.followedThreads.length ? { followedThreads } : {}),
        ...(conversationChannelId in state.taskFollowOverrides ? { taskFollowOverrides } : {}),
        ...(closesModal ? { taskModal: null } : {}),
      };
    }),

  /**
   * Re-run the task modal's thread lookup against the channel's current
   * accessibility — the slot twin of `retryOpenThread`.
   */
  retryTaskModal: async () => {
    const slot = get().taskModal;
    // A task v2 dialog has no lookup to retry: its conversation comes with the task.
    if (!slot || !slot.parentChannelId || !slot.parentMessageId) return;
    await get().openTaskModal({
      parentChannelId: slot.parentChannelId,
      parentMessageId: slot.parentMessageId,
      threadChannelId: slot.threadChannelId,
      focusedMessageId: slot.focusedMessageId,
      intent: "task",
    });
  },

  focusMessage: (messageId) => set({ focusedMessageId: messageId, focusNonce: nextFocusNonce() }),
  clearFocusedMessage: () => set({ focusedMessageId: null }),
  clearTaskModalFocusedMessage: () => set((state) => (
    state.taskModal?.focusedMessageId ? { taskModal: { ...state.taskModal, focusedMessageId: null } } : {}
  )),

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
        replyScopes[parentMessageId] = retainNewerThreadReplyContent(hydrateThreadRepliesScope(latest, summary.replyCount), existing ?? null);
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
        summaries: { ...state.summaries, ...withKnownFollowed(keepShownThreadsRead(summaries, state), state.summaries) },
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
          [parentMessageId]: keepKnownFollowed(summary, state.summaries[parentMessageId]),
        },
        ...(adoptThreadId ? { openThreadChannelId: summary.threadChannelId } : {}),
      };
    }),

  loadFollowedThreads: async (reason) => {
    const epoch = useServerStore.getState().serverEpoch;
    const serverId = useServerStore.getState().current?.id;
    if (!serverId) return;
    // Newest-started read wins: an older one landing late must not overwrite
    // a list read after a change (sync/changes, #triage:458d78f1).
    const request = ++followedThreadsRequestSeq;
    try {
      const data = await fetchFollowedThreads(reason);
      if (useServerStore.getState().serverEpoch !== epoch) return;
      if (request !== followedThreadsRequestSeq) return;
      // Stryker disable next-line ObjectLiteral: followed-thread setter shape is Zustand glue; projection transform behavior is tested by read-state thread tests.
      set({ followedThreads: applyKnownReadStateProjectionsToFollowedThreads(data.threads, get().followedThreads) });
      // Task #164: the last clean list is what a later boot shows while RW is unavailable.
      if (!data.stale) saveLastCounts(getCurrentPrincipalId(), serverId, { followed: get().followedThreads });
    } catch {
      // Keep the list shown; store/rwFreshness says it may be out of date.
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
        return { ...t, unreadCount: 0, firstUnreadMessageId: null };
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
        return { ...t, unreadCount: projection.unreadCount, firstUnreadMessageId: projection.firstUnreadMessageId };
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

  applyServerThreadUnread: (threadChannelId, serverUnreadCount) => {
    // A read only lowers unread. The server's count also differs from the
    // badge's own algorithm (it ignores follow state and excludes the
    // reader's messages), so it may lower a badge but never raise one: an
    // unfollowed thread stays at 0.
    set((state) => {
      let followedThreadsChanged = false;
      const followedThreads = state.followedThreads.map((t) => {
        if (t.threadChannelId !== threadChannelId || t.unreadCount <= serverUnreadCount) return t;
        followedThreadsChanged = true;
        return { ...t, unreadCount: serverUnreadCount };
      });
      let summaries = state.summaries;
      for (const [parentMessageId, summary] of Object.entries(state.summaries)) {
        if (summary.threadChannelId !== threadChannelId || summary.unreadCount <= serverUnreadCount) continue;
        if (summaries === state.summaries) summaries = { ...state.summaries };
        summaries[parentMessageId] = {
          ...summary,
          unreadCount: serverUnreadCount,
          // The server sends a count, not a position: keep the old jump target
          // while anything is unread, drop it once nothing is.
          firstUnreadMessageId: serverUnreadCount === 0 ? null : summary.firstUnreadMessageId,
        };
      }
      if (!followedThreadsChanged && summaries === state.summaries) return state;
      return {
        ...(followedThreadsChanged ? { followedThreads } : {}),
        ...(summaries !== state.summaries ? { summaries } : {}),
      };
    });
  },

  applyThreadMarkedUnread: (threadChannelId, unreadCount) => {
    if (!(unreadCount > 0)) return;
    set((state) => {
      let followedThreadsChanged = false;
      const followedThreads = state.followedThreads.map((t) => {
        if (t.threadChannelId !== threadChannelId || t.unreadCount >= unreadCount) return t;
        followedThreadsChanged = true;
        return { ...t, unreadCount };
      });
      let summaries = state.summaries;
      for (const [parentMessageId, summary] of Object.entries(state.summaries)) {
        if (summary.threadChannelId !== threadChannelId || summary.unreadCount >= unreadCount) continue;
        if (summaries === state.summaries) summaries = { ...state.summaries };
        summaries[parentMessageId] = { ...summary, unreadCount };
      }
      if (!followedThreadsChanged && summaries === state.summaries) return state;
      return {
        ...(followedThreadsChanged ? { followedThreads } : {}),
        ...(summaries !== state.summaries ? { summaries } : {}),
      };
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
    forgetSkippedSeenRead(threadChannelId);
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

    set((state) => ({ followOverrides: { ...state.followOverrides, [parentMessageId]: true } }));
    // The mutation above is canonical. Refreshing the followed-list projection
    // is best effort: a transient GET failure must not make Activity preserve
    // an Unfollowed badge after the server already committed the Follow.
    try {
      const data = await fetchFollowedThreads("manual");
      set({ followedThreads: applyKnownReadStateProjectionsToFollowedThreads(data.threads, get().followedThreads) });
    } catch (err) {
      console.error("Failed to refresh followed threads:", err);
    }
  },

  unfollowThread: async (threadChannelId) => {
    try {
      await api.post("/channels/threads/unfollow", { threadChannelId });
      set((state) => {
        const parentMessageId = state.followedThreads.find((t) => t.threadChannelId === threadChannelId)?.parentMessageId
          ?? Object.entries(state.summaries).find(([, summary]) => summary.threadChannelId === threadChannelId)?.[0];
        return {
          followedThreads: state.followedThreads.filter((t) => t.threadChannelId !== threadChannelId),
          ...(parentMessageId ? { followOverrides: { ...state.followOverrides, [parentMessageId]: false } } : {}),
          // No unread once unfollowed (the server counts none): the channel's entry drops it now.
          summaries: applyThreadUnreadProjectionToSummaries(state.summaries, threadChannelId, 0, null),
        };
      });
      notifyThreadUnfollowed(threadChannelId);
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
      await get().loadFollowedThreads("manual");
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
      const data = await fetchFollowedThreads("manual");
      // Stryker disable next-line ObjectLiteral: done-failure reload setter is legacy recovery glue outside read-state projection behavior.
      set({ followedThreads: applyKnownReadStateProjectionsToFollowedThreads(data.threads, get().followedThreads) });
    }
  },

  undoneThread: async (threadChannelId) => {
    try {
      // Stryker disable next-line StringLiteral,ObjectLiteral: undone RPC endpoint/payload predates this read-state projection slice.
      await api.post("/channels/threads/undone", { threadChannelId });
      // Reload to get the full thread data
      // Stryker disable next-line StringLiteral: undone reload endpoint is legacy recovery glue outside read-state projection behavior.
      const data = await fetchFollowedThreads("manual");
      // Stryker disable next-line ObjectLiteral: undone reload setter is legacy recovery glue outside read-state projection behavior.
      set({ followedThreads: applyKnownReadStateProjectionsToFollowedThreads(data.threads, get().followedThreads) });
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
    followOverrides: {},
    taskFollowOverrides: {},
    taskUpdatesByMessageId: {},
  })
);

registerMessagesSyncCoreReset(() =>
  useThreadStore.setState({ replyScopes: {} })
);
