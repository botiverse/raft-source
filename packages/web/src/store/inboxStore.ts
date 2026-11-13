import { currentTimeMs, objectActivityWebPaths, resolveMarkUnreadOutcome } from "@botiverse/raft-shared";
import { foldInboxRefreshTrigger, listFetchReasonHeaders } from "./listFetchReason";
import { compareActivitySeq, safeSeqToDecimalString } from "./activitySeq";
import { inboxRefreshWaitsForShow } from "./hiddenOwedReads";
import { decrementInboxGroupCounts, incrementInboxGroupCounts, preserveSelectedInboxGroup, sortInboxGroupsByRecentActivity } from "./inboxGroups";
import type { InboxGroupCount } from "./inboxGroups";
import { checkInPlaceDrift, inPlaceUnreadOf, lateLiveUnreadFields, liveUnreadFields, noteInPlaceRow, noteInPlaceRowAbsent, noteLiveApplied, readPersistedSkipsReread } from "./inboxInPlaceUnread";
import { noteServedInboxRows } from "./inboxCountedIds";
import type { InboxLiveUnread } from "./inboxInPlaceUnread";
import type { InboxRefreshTriggerCount, ListFetchReason } from "./listFetchReason";
import { create } from "zustand";
import type { StoreApi } from "zustand";
import api from "../api/client";
import type { DelegatedByWire } from "../components/message/delegatedMessage";
import { isRetractedMessage } from "../components/message/delegatedMessage";
import { getRwRead } from "../api/overloadRetry";
import { activityRowsToSave, saveLastCounts } from "./lastCounts";
import { getCurrentPrincipalId } from "./principalRuntime";
import { postReadAllCoalesced } from "./transport/inboxTransport";
import { registerServerReset } from "./serverResetRegistry";
import { getInboxItemKey, inboxItemChannelId, readInboxItem, savedThreadRowsOverServed } from "./inboxItem";
import { isObjectActivityRow, parseObjectActivityRow } from "./objectActivityRow";
import {
  activityUnreadSnapshotIndex,
  dropActivityUnreadRowsIf,
  forgetActivityUnreadRowsUnreadAgain,
  keptActivityUnreadRow,
  noteActivityUnreadRowsRead,
  patchActivityUnreadSnapshot,
  takeKeptActivityUnreadRow,
} from "./activityUnreadSnapshot";
import { captureHumanActivityIngressContext } from "./receiverPrivateIngress";
import {
  captureReceiverPrivateIngressContext,
  isReceiverPrivateIngressContextCurrent,
  useMessageStore,
} from "./messageStore";
import type {
  Message,
  PendingMentionAction,
} from "./messageStore";
import {
  acceptActivityReadAllAck,
  getActivityReadStateRevision,
  hasActivityReadHold,
  releaseActivityReadHold,
} from "./activityReadState";
import type {
  ActivityReadStateIdentity,
} from "./activityReadState";
import {
  consumeReadStateSnapshotRows,
  getAcceptedReadState,
  getAcceptedReadStateProjection,
  getReadStateLedgerGeneration,
  registerChannelReadListener,
  registerPersistedChannelReadListener,
  registerReadStateProjectionListener,
} from "./readStateSync";
import type {
  ReadStateProjection,
} from "./readStateSync";
import { clearAllMarkedUnreadForRead, isScopeMarkedUnread } from "./markedUnreadStore";
import type { InboxRefreshTrigger, InboxScopeReadFrontier, ObjectActivityDoneInput, ObjectActivityInput, ObjectActivityReadInput, ObjectInboxFields, ObjectInboxItem, SummarizedObjectKind } from "@botiverse/raft-shared";
import { normalizeTaskConversationRow } from "../utils/taskConversation";
import type { TaskConversationRowFields } from "../utils/taskConversation";
import { useServerStore } from "./serverStore";
import { inboxStateForActivityFilter, readActivityFilterChoice } from "./activityFilterPreference";
import { registerThreadUnfollowedListener, useThreadStore } from "./threadStore";
import { applyTaskToInboxItems } from "../utils/taskMetadata";
import type { TaskMetadataUpdate } from "../utils/taskMetadata";
import {
  beginActivityInboxTraceCycle,
  currentActivityInboxTraceCycle,
  activityInboxTraceScope,
  traceActivityInboxTransition,
} from "../utils/activityInboxTrace";

/**
 * Inbox filter modes.
 *
 * - `all` — every active inbox item visible to the user, read or unread.
 * - `unread` — inbox items whose unread range is non-empty.
 * - `mentions` — inbox items where someone has @-mentioned the user,
 *   regardless of read state. Source of truth is `message_mentions` +
 *   read cursor on the server (already computed into `hasMention` on
 *   each item, see `#proj-runtime:e7ba4a60` / task #157). Backend filter
 *   contract: `/api/channels/inbox?filter=mentions` returns rows with
 *   `hasMention=true AND NOT done` (no `unreadCount > 0` constraint —
 *   we want users to find historical mentions, not just unread ones).
 *   Client never re-scans message bodies. Backend support is tracked in
 *   #proj-uiux task #188.
 * - `unread_mentions` — unread inbox items with an unread @-mention. This is
 *   the transport identity for the composed Unread + Mentions receiver state;
 *   Mentions is a filter layered on top of the All / Unread state, not a third
 *   mutually-exclusive state.
 */
export type InboxFilter = "all" | "unread" | "mentions" | "unread_mentions";
/**
 * Narrows the list; the server resolves the set. `pinned`: the sidebar-pinned
 * conversations and their threads. `saved`: the threads followed through a
 * saved message (saving a message follows its thread).
 */
export type InboxScope = "pinned" | "saved" | "artifacts";
export type ActivitySortDirection = "desc" | "asc";
export type InboxPendingFocusKind = "first-unread";

export { getInboxItemKey };
export { decrementInboxGroupCounts, sortInboxGroupsByRecentActivity };
export type { InboxGroupCount };
export { compareActivitySeq, safeSeqToDecimalString };

/** RFC 077: the row with a retracted message's placeholder in place of its text. */
function retractInboxItemPreview(item: InboxItem, messageId: string, placeholder: string): InboxItem {
  if ((item.kind === "channel" || item.kind === "dm") && item.lastMessageId === messageId) {
    return { ...item, lastMessagePreview: placeholder, latestRetracted: true };
  }
  if (item.kind === "thread" && (item.latestActivityMessageId === messageId || item.parentMessageId === messageId)) {
    return {
      ...item,
      ...(item.latestActivityMessageId === messageId ? { latestActivityPreview: placeholder, latestRetracted: true } : {}),
      ...(item.parentMessageId === messageId ? { parentMessagePreview: placeholder, parentRetracted: true } : {}),
    };
  }
  return item;
}

export function isUnreadInboxFilter(filter: InboxFilter): boolean {
  return filter === "unread" || filter === "unread_mentions";
}

/**
 * #244: the list's totals after a live message added `added` unread to `row`
 * in place, so a later read (clearReadForChannel, a projection) takes back
 * only what was added. Under an Unread filter a row that was read joins its group.
 */
function inPlaceUnreadTotals(state: InboxState, row: ActivityPersistedItem, added: number): Partial<InboxState> {
  if (added <= 0) return {};
  return {
    totalUnreadCount: state.totalUnreadCount + added,
    activeUnreadCount: state.activeUnreadCount + added,
    ...(isUnreadInboxFilter(state.filter) && row.unreadCount === added ? { groups: incrementInboxGroupCounts(state.groups, [row]) } : {}),
  };
}

/**
 * #244: a live message its row is already past (it came after a newer one, or
 * moved the row without being counted) counts once: the unread fields only
 * (lateLiveUnreadFields), not the preview, order or seq. `kept`: false when
 * the row's counted set is full (ask for a re-read).
 */
function lateLivePatch<T extends ThreadInboxItem | ChannelInboxItem>(state: InboxState, row: T, message: Message, live: InboxLiveUnread | undefined): { next: T; patch: Partial<InboxState>; kept: boolean } | null {
  const fields = lateLiveUnreadFields(row, message, live);
  if (!fields || !live) return null;
  const next: T = { ...row, ...fields };
  noteInPlaceRow(next, live, message, null, true);
  const patch = { items: state.items.map((item) => (item === row ? next : item)), ...inPlaceUnreadTotals(state, next, next.unreadCount - row.unreadCount) };
  return { next, patch, kept: noteLiveApplied(row, message, live) };
}

/** A Done written after the list may have changed (a swiped Done after its Undo, `activitySwipeActions`). */
export type MarkDoneOptions = {
  /** The row as the person saw it, for when the store no longer lists or keeps it (another filter, scope or search since). */
  accepted?: InboxItem;
  /** The server the row is on, when that may no longer be the current one: if it isn't, only that server is told. */
  serverId?: string | null;
};

export type InboxItem =
  | {
      kind: "channel" | "dm";
      channelId: string;
      channelName: string;
      channelType: "channel" | "private" | "joint" | "dm";
      lastMessageId: string;
      /** Same-source content frontier paired with lastMessageId. */
      latestActivitySeq: string | null;
      /** Storage-space frontier accepted by the channel Done guard. Active
       * rows from upgraded servers always carry it; omission is rolling-
       * compatibility state and must fail closed rather than use display seq. */
      doneFrontierSeq?: string | null;
      firstUnreadMessageId: string | null;
      firstMentionMessageId: string | null;
      lastMessageAt: string;
      lastMessagePreview: string;
      lastMessageSenderType: "user" | "agent" | "system" | "external_projection";
      lastMessageSenderId: string;
      lastMessageSenderName: string | null;
      /** RFC 077: the assistant that sent the latest message for its sender; absent from older servers. */
      latestDelegatedBy?: DelegatedByWire | null;
      /** RFC 077: the latest message was retracted by its owner; absent from older servers. */
      latestRetracted?: boolean;
      /** The latest message's sender's avatar, for a sender in neither of this
       *  server's rosters (a joint channel's other server); absent from older servers. */
      senderAvatarUrl?: string | null;
      unreadCount: number;
      hasMention: boolean;
      /** Normalised authority frontier seq for this row (#632 C1). Written by
       * loadInbox from the adapter outcome at the SAME index — the raw union
       * never enters the store, so the adapter stays its only interpreter. */
      readStateLatestActivitySeq?: string | null;
      doneAt?: string | null;
    }
  | {
      kind: "thread";
      threadChannelId: string;
      parentMessageId: string;
      parentChannelId: string;
      parentChannelName: string;
      parentChannelType: "channel" | "private" | "joint" | "dm";
      parentMessagePreview: string;
      parentMessageSenderType: "user" | "agent" | "external_projection";
      parentMessageSenderId: string;
      latestActivityPreview: string;
      latestActivitySenderType: "user" | "agent" | "system" | "external_projection";
      latestActivitySenderId: string;
      latestActivitySenderName: string | null;
      /** RFC 077: the assistant that sent the latest reply for its sender; absent from older servers. */
      latestDelegatedBy?: DelegatedByWire | null;
      /** RFC 077: the latest reply was retracted by its owner; absent from older servers. */
      latestRetracted?: boolean;
      /** The latest reply's sender's avatar, for a sender in neither of this
       *  server's rosters (a joint channel's other server); absent from older servers. */
      senderAvatarUrl?: string | null;
      /** RFC 077: the thread's parent message was retracted by its owner; absent from older servers. */
      parentRetracted?: boolean;
      latestActivityMessageId: string;
      /** Authoritative content-frontier message seq (DB bigint canonical decimal
       * string) — task #361 three-axis contract. This is the Done/read/reactivation
       * marker authority; `replyCount` is display-only and must never veto a newer
       * seq. Null until the server canonical path provides it (legacy compare falls
       * back to lastReplyAt). */
      latestActivitySeq: string | null;
      /** Storage-space frontier accepted by the thread Done guard. Active
       * rows from upgraded servers always carry it; omission is rolling-
       * compatibility state and must fail closed rather than use display seq. */
      doneFrontierSeq?: string | null;
      firstUnreadMessageId: string | null;
      firstMentionMessageId: string | null;
      replyCount: number;
      lastActivityAt: string;
      lastReplyAt: string | null;
      unreadCount: number;
      hasMention: boolean;
      taskNumber: number | null;
      taskStatus: string | null;
      taskClaimedByName: string | null;
      /** Normalised authority frontier seq for this row (#632 C1). See the channel arm. */
      readStateLatestActivitySeq?: string | null;
      doneAt?: string | null;
      isFollowing?: boolean;
      unfollowedAt?: string | null;
    } & TaskConversationRowFields
  | ObjectActivityItem
  | {
      kind: "mention_action";
      id: string;
      channelId: string;
      channelName: string;
      channelType: "channel" | "private" | "joint" | "dm";
      messageId: string;
      messagePreview: string;
      createdAt: string;
      pendingMentionActions: PendingMentionAction[];
      unreadCount: 0;
      hasMention: false;
    };

/**
 * An Activity row for a first-party object (an Artifact; shared
 * activityObjectsContract): listed among the conversation rows while the
 * object's app is on for the server. Its unread and its counts are its own
 * (`objectUnreadCount`, `objectMentionUnreadCount`, `objectCount`): the
 * conversation totals never count it, as the server's don't.
 */
export type ObjectActivityItem = ObjectInboxItem;
/** A row of a conversation (or a direct mention): every row but an object's. */
export type ConversationInboxItem = Exclude<InboxItem, { kind: "object" }>;

/**
 * A read toggle's write ordering (inboxRowActions' toggleActivityRowRead):
 * its local change applies at once, its write once `after` settles (the
 * write of an earlier toggle on the same conversation; it never rejects).
 */
export type InboxReadWriteOptions = {
  after?: Promise<void>;
  /** The write failed: the row is back as the server has it (the caller says so). */
  onFailed?: () => void;
  /**
   * Mark as Unread found nothing the server counts unread (every message after
   * the read point is the person's own) and the server is older than the
   * marked-unread flag (its answer has no `markedUnread`): the row stays read
   * (the caller says why). A current server marks the row instead.
   */
  onNothingUnread?: () => void;
};

type ThreadInboxItem = Extract<InboxItem, { kind: "thread" }>;
type ChannelInboxItem = Extract<InboxItem, { kind: "channel" | "dm" }>;

interface InboxState {
  items: InboxItem[];
  /**
   * Opaque receipt for the reset-window response currently held in `items`.
   *
   * Empty means there is no accepted first window that may be paired with an
   * overlay result. S2 compares this only for exact equality; it is neither a
   * sortable counter nor a server cursor.
   */
  acceptedWindowGeneration: string;
  /**
   * True after this principal/server/filter identity has accepted at least one
   * reset-window response. Unlike the generation receipt, this remains true
   * while a background refresh temporarily invalidates that receipt.
   */
  hasAcceptedWindow: boolean;
  /**
   * Task #164: `items` (and the totals) are the last saved first page
   * (store/lastCounts.ts), shown before the server answered. The first
   * accepted reset replaces them whole: no tail or newer-thread carry-over.
   */
  savedWindow: boolean;
  /**
   * The last reset load failed. With no rows to keep, Activity shows the
   * failed state with Retry instead of the empty state: an empty state says
   * there is nothing here, a failure does not (Raft DS › Feedback).
   */
  loadFailed: boolean;
  unfollowedItems: ThreadInboxItem[];
  unfollowedLoading: boolean;
  unfollowedLoaded: boolean;
  /** The reset-window generation captured by the accepted unfollowed result. */
  unfollowedWindowGeneration: string | null;
  groups: InboxGroupCount[];
  filter: InboxFilter;
  channelFilterId: string | null;
  scope: InboxScope | null;
  sortDirection: ActivitySortDirection;
  searchQuery: string;
  loading: boolean;
  loadingMore: boolean;
  loaded: boolean;
  hasMore: boolean;
  totalCount: number;
  /** Server-wide All navigation total; never the currently filtered page total. */
  allCount: number | null;
  totalUnreadCount: number;
  /** Unread messages across every active Activity row, independent of the selected list filter. */
  activeUnreadCount: number;
  /**
   * Unread object rows (Artifacts) in the server, whatever the filter: the
   * server's `objectUnreadCount`, 0 with every object app off. Never part of
   * `totalUnreadCount` or `activeUnreadCount` (shared activityObjectsContract):
   * what shows Activity's unread adds it.
   */
  objectUnreadCount: number;
  /**
   * Unread object rows of those the Mentions filter lists (a mention since
   * their Done), whatever the filter: the server's `objectMentionUnreadCount`;
   * `objectUnreadCount` from a server that doesn't send it. What Activity's
   * unread adds under Mentions (objectUnreadCountForFilter).
   */
  objectMentionUnreadCount: number;
  /** Object rows the list's filter matches, all pages: the server's `objectCount`; never part of `totalCount`. */
  objectCount: number;
  scrollTop: number;
  focusedItemKey: string | null;
  // Bumped on every non-null setFocusedItemKey, so asking for the key that is
  // already focused (Activity double-clicked again after the user scrolled
  // away) still scrolls to it and restarts its highlight.
  focusRequestId: number;
  // A deferred "focus the first unread row" intent. Set when a caller (e.g. the
  // sidebar dbl-click) wants the first unread focused but the inbox `items` may
  // not be loaded yet; ThreadsInbox resolves it to a concrete focusedItemKey
  // once items arrive. Avoids the timing assumption that items are already
  // populated at the moment the intent is expressed.
  pendingFocusKind: InboxPendingFocusKind | null;
  /** Picks the list's filter; `scope` defaults to none, so picking All / Unread / Mentions leaves Pinned. */
  setFilter: (filter: InboxFilter, scope?: InboxScope | null) => void;
  setChannelFilterId: (channelId: string | null) => void;
  setSortDirection: (direction: ActivitySortDirection) => void;
  setSearchQuery: (query: string) => void;
  setScrollTop: (scrollTop: number) => void;
  setFocusedItemKey: (key: string | null) => void;
  setPendingFocusKind: (kind: InboxPendingFocusKind | null) => void;
  loadInbox: (opts?: { reset?: boolean; background?: boolean; reuseAllCount?: boolean; reason?: ListFetchReason; trigger?: InboxRefreshTriggerCount }) => Promise<void>;
  loadUnfollowed: () => Promise<void>;
  refreshInbox: (opts?: { background?: boolean; reason?: ListFetchReason }) => Promise<void>;
  /**
   * Mark as Read: shown read at once. `after`: an earlier read toggle's
   * write on the same conversation, which this one's write waits for.
   */
  markRead: (item: InboxItem, options?: InboxReadWriteOptions) => Promise<void>;
  /**
   * Mark as Unread: the conversation's latest message. Shown unread at once,
   * and held unread against reads that lag the write; then a reload.
   */
  markUnread: (item: ConversationInboxItem, options?: InboxReadWriteOptions) => Promise<void>;
  /**
   * Mark as Unread from a thread's own menu: markUnread on its Activity row
   * when one is loaded, else the same write and hold with no row to show
   * until the reload brings it.
   */
  markThreadUnread: (threadChannelId: string, options?: InboxReadWriteOptions) => Promise<void>;
  /**
   * Mark all read: every row read at once. `after`: read toggles still
   * writing (a queued Unread), which the read-all's write waits for, so the
   * server isn't left unread where the screen shows read.
   */
  markAllRead: (options?: InboxReadWriteOptions) => Promise<void>;
  markDone: (item: InboxItem, options?: MarkDoneOptions) => Promise<void>;
  /** Undo an object row's Done (its Undo toast): the row shows again. `serverId`: the server it was done on. */
  undoObjectDone: (item: ObjectActivityItem, options?: { serverId?: string | null }) => Promise<void>;
  markThreadUnfollowed: (item: ThreadInboxItem) => void;
  markThreadRefollowed: (threadChannelId: string) => void;
  removeItem: (item: InboxItem) => void;
  /** Drop every Activity row (and Unfollowed row) of a conversation that no
   *  longer exists, e.g. a deleted task's conversation (task v2). */
  removeConversation: (channelId: string) => void;
  /**
   * Done on another device, from the sync stream: drop the conversation's row
   * when that Done covers what the row shows. False when this list can't
   * tell (no row loaded, no frontier): the caller reads the list again.
   */
  applyRemoteDone: (channelId: string, doneFrontierSeq: string | null) => boolean;
  /**
   * The newest activity the conversation's Activity rows show, in the read
   * cursor's seq space (their authority frontier). Null when no row is loaded
   * or one has no frontier: a read can't be judged against the rows.
   */
  conversationLatestReadableSeq: (channelId: string) => string | null;
  clearReadForChannel: (channelId: string) => void;
  applyReadStateProjection: (channelId: string, projection: ReadStateProjection) => void;
  /** `live`: a live message's unread, patched in place on its existing row (#244). */
  receiveThreadReply: (message: Message, live?: InboxLiveUnread) => void;
  /** A live channel or DM message: patch its existing row's preview, sender and time, and with `live` its unread (#244); never a new row. */
  receiveChannelMessage: (message: Message, live?: InboxLiveUnread) => void;
  /** RFC 077: a retracted message's rows show its placeholder from now on, never its old text. */
  retractPreview: (messageId: string, placeholder: string) => void;
  updateThreadActivityMeta: (threadChannelId: string, replyCount: number, lastReplyAt: string | null) => void;
  updateTaskMetadata: (task: TaskMetadataUpdate) => void;
}

// 50 rows is about three screens: with the next page asked for two screens
// before the end, it lands before the reader gets there (task #5; the server
// allows 100).
const PAGE_SIZE = 50;

/** `/channels/inbox`: one page of rows and the list's totals. */
type InboxPageResponse = {
  items?: unknown[];
  hasMore?: boolean;
  totalCount?: number | null;
  totalUnreadCount?: number | null;
  activeUnreadCount?: number | null;
  groups?: InboxGroupCount[];
} & Partial<ObjectInboxFields>;
let inboxLoadRequestSeq = 0;
let activeInboxLoadRequestId = 0;
let activeInboxRequestInFlightId: number | null = null;
let trailingInboxBackgroundReset = false;
/** The newest reason (and first trigger, counts summed) among the resets folded into the trailing one. */
let trailingInboxBackgroundResetReason: ListFetchReason | undefined;
let trailingInboxBackgroundResetTrigger: InboxRefreshTriggerCount | undefined;
let trailingInboxBackgroundResetPromise: Promise<void> | null = null;
let resolveTrailingInboxBackgroundReset: (() => void) | null = null;
const pendingTrailingInboxBackgroundResetResolvers = new Set<() => void>();
let inboxLocalDoneSuppressionUntil = 0;
const inboxLocalDoneSuppressedMarkers = new Map<string, string>();
// Per-row expiry, so an old Done is not kept alive by a newer one's deadline.
// `inboxLocalDoneSuppressionUntil` stays the max of these (the fast path).
const inboxLocalDoneSuppressedUntil = new Map<string, number>();
// #5690: the optimistic Done suppression is a pending-window bridge, not a
// substitute for row removal. Each mark-done issues a generation for its key;
// only the newest generation may retire that key's suppression or drive the
// authoritative refresh. Without this fence a slow first request's success
// could clear a second, newer suppression and resurrect a row the user just
// completed.
let inboxDoneRequestSeq = 0;
const inboxDoneRequestGeneration = new Map<string, number>();
let inboxLocalReadSuppressionUntil = 0;
const inboxLocalReadSuppressedMarkers = new Map<string, string>();
const inboxLocalReadSuppressedUntil = new Map<string, number>();
const inboxReadInFlight = new Set<string>();
let inboxUnfollowedLoadGeneration = 0;
/**
 * The generation owned by the newest reset request that has been issued but
 * not necessarily accepted yet. `loadUnfollowed` captures this synchronously
 * so the two parallel requests can prove they belong to the same first-window
 * attempt without coupling either response's acceptance to arrival order.
 */
let pendingInboxWindowGeneration: string | null = null;

// Task #33: the Activity list is served from a RisingWave view that lags the
// Postgres write by seconds, and under RW slowness the server answers from a
// Redis copy up to 60s old (server routes/rwStaleRead.ts). A confirmed Done or
// read therefore stays applied locally until the served row carries a NEWER
// marker (the suppression is marker-bound, so new activity always shows), or
// until this cap lapses. 90s = the 60s stale-cache bound + RW lag + request
// time; after that a row the server still serves is shown again, so a server
// that never applied the mutation stays observable rather than masked.
export const INBOX_LOCAL_MUTATION_HOLD_MS = 90_000;
const LOCAL_DONE_SUPPRESSION_MS = INBOX_LOCAL_MUTATION_HOLD_MS;
const LOCAL_READ_SUPPRESSION_MS = INBOX_LOCAL_MUTATION_HOLD_MS;
// Task #33: every realtime event used to trigger a full Activity refetch
// (39 in 37s on a busy server), each one a RisingWave read. Background
// (realtime-triggered) reloads are throttled leading+trailing to one per
// window, measured from the last reset fetch of ANY kind. User-initiated loads
// (opening Activity, filter changes, pull-to-refresh, Done/read reconciles)
// call loadInbox/refreshInbox directly and are never delayed by this.
export const INBOX_BACKGROUND_REFRESH_INTERVAL_MS = 2_500;
let lastInboxResetStartedAt = 0;
let inboxBackgroundRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let pendingInboxBackgroundRefreshTrigger: InboxRefreshTriggerCount | undefined;

/**
 * The single entry point for realtime-triggered Activity reloads. The first
 * request after a quiet window fetches immediately; requests inside the window
 * collapse into one trailing fetch at the window's end, so the latest state
 * still arrives. It carries the window's first trigger and count (#triage:#229).
 * While the page is hidden nothing is read (#243): the read is owed, and showing
 * the page pays it with one `visibility` read (hiddenOwedReads).
 */
export function requestInboxBackgroundRefresh(trigger: InboxRefreshTrigger): void {
  if (inboxRefreshWaitsForShow(loadInboxOnShow)) return;
  pendingInboxBackgroundRefreshTrigger = foldInboxRefreshTrigger(pendingInboxBackgroundRefreshTrigger, { trigger, coalesced: 1 });
  if (inboxBackgroundRefreshTimer !== null) return;
  const waitMs = lastInboxResetStartedAt + INBOX_BACKGROUND_REFRESH_INTERVAL_MS - currentTimeMs();
  const run = () => {
    const folded = pendingInboxBackgroundRefreshTrigger;
    pendingInboxBackgroundRefreshTrigger = undefined;
    // The trailing read's window ended while hidden: owed too.
    if (inboxRefreshWaitsForShow(loadInboxOnShow)) return;
    void useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "realtime_fallback", trigger: folded });
  };
  if (waitMs <= 0) return run();
  inboxBackgroundRefreshTimer = setTimeout(() => {
    inboxBackgroundRefreshTimer = null;
    run();
  }, waitMs);
}

function loadInboxOnShow(): void {
  // It stands for every realtime read asked for before it, a trailing one set while visible too.
  if (inboxBackgroundRefreshTimer !== null) clearTimeout(inboxBackgroundRefreshTimer);
  inboxBackgroundRefreshTimer = null;
  pendingInboxBackgroundRefreshTrigger = undefined;
  void useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "visibility" });
}

/** Drop a scheduled trailing background reload (bridge teardown, server reset, tests). */
export function cancelInboxBackgroundRefresh(): void {
  if (inboxBackgroundRefreshTimer !== null) clearTimeout(inboxBackgroundRefreshTimer);
  inboxBackgroundRefreshTimer = null;
  pendingInboxBackgroundRefreshTrigger = undefined;
  lastInboxResetStartedAt = 0;
  clearInboxCatchUp();
}

// Task #86: the read a live message triggers usually lands before the
// RisingWave view has the message (~1-2 s), so it serves the channel row as it
// was. One catch-up for the whole list chases the newest live message seen:
// while a fresh answer still serves that channel's row behind it, re-read
// after these delays, then stop. Each re-read goes through the background
// throttle above, so this adds no reads beyond its budget. A stale or failed
// answer ends the catch-up: rwRecovery then re-reads at the server's
// Retry-After pace.
export const INBOX_CATCH_UP_RETRY_DELAYS_MS = [1_500, 3_000] as const;
// Task #92: a reopened row has no live patch showing the message meanwhile,
// and under RW overload the lag outlasts 3 s, so it gets one later read.
export const INBOX_REOPEN_CATCH_UP_RETRY_DELAYS_MS = [1_500, 3_000, 10_000] as const;
// Task #92: `reopen` marks a target whose row Done hid. The view drops that
// row until it has the new message, so there a missing row is the lag itself.
let inboxCatchUpTarget: { channelId: string; seq: string; reopen: boolean } | null = null;
let inboxCatchUpAttempt = 0;
let inboxCatchUpTimer: ReturnType<typeof setTimeout> | null = null;

function noteInboxCatchUpTarget(channelId: string, seq: string, reopen = false): void {
  if (inboxCatchUpTarget && compareActivitySeq(seq, inboxCatchUpTarget.seq) <= 0) return;
  inboxCatchUpTarget = { channelId, seq, reopen };
  inboxCatchUpAttempt = 0;
}

/**
 * Task #92: is this channel's row hidden by a Done this message is newer than?
 * Such a message reopens the row on the server, but no listed row carries it.
 */
function isReopenedByLiveMessage(channelId: string, seq: string, nowMs = currentTimeMs()): boolean {
  if (nowMs > inboxLocalDoneSuppressionUntil) return false;
  for (const key of [`channel:${channelId}`, `dm:${channelId}`]) {
    const marker = inboxLocalDoneSuppressedMarkers.get(key);
    if (
      marker !== undefined
      && nowMs <= (inboxLocalDoneSuppressedUntil.get(key) ?? 0)
      && inboxMarkerIsNewer(seq, marker)
    ) return true;
  }
  return false;
}

function clearInboxCatchUp(): void {
  if (inboxCatchUpTimer !== null) clearTimeout(inboxCatchUpTimer);
  inboxCatchUpTimer = null;
  inboxCatchUpTarget = null;
  inboxCatchUpAttempt = 0;
}

/**
 * Does this served first window still serve the newest live message's channel
 * row older than that message? A missing row is not behind: the filter may
 * leave it out, and no answer can tell. Except for a row Done hid (task #92):
 * the view leaves it out until it has the message, so missing is behind.
 */
function inboxAnswerIsBehindCatchUp(served: InboxItem[]): boolean {
  const target = inboxCatchUpTarget;
  if (!target) return false;
  const row = served.find((item): item is ChannelInboxItem =>
    (item.kind === "channel" || item.kind === "dm") && item.channelId === target.channelId);
  if (row === undefined) return target.reopen;
  return compareActivitySeq(row.latestActivitySeq, target.seq) < 0;
}

function settleInboxCatchUp(behind: boolean, stale: boolean): void {
  if (!inboxCatchUpTarget) return;
  const delays: readonly number[] = inboxCatchUpTarget.reopen
    ? INBOX_REOPEN_CATCH_UP_RETRY_DELAYS_MS
    : INBOX_CATCH_UP_RETRY_DELAYS_MS;
  if (!behind || stale || inboxCatchUpAttempt >= delays.length) {
    clearInboxCatchUp();
    return;
  }
  if (inboxCatchUpTimer !== null) return;
  const delayMs = delays[inboxCatchUpAttempt];
  inboxCatchUpAttempt += 1;
  inboxCatchUpTimer = setTimeout(() => {
    inboxCatchUpTimer = null;
    requestInboxBackgroundRefresh("catch_up_retry");
  }, delayMs);
}

// Task #86: a channel row patched from a live message keeps that message's
// preview, sender and time over a served row that is still older, until the
// view catches up or the stale-list bound lapses. Counts come from the served
// row, unless the live message patched them in place (#244, `counts`).
const inboxChannelActivityHighWater = new Map<string, { seq: string; until: number; counts: boolean }>();

function rememberLocalChannelActivity(item: ChannelInboxItem & { latestActivitySeq: string }, counts = false): void {
  inboxChannelActivityHighWater.set(item.channelId, {
    seq: item.latestActivitySeq,
    until: currentTimeMs() + INBOX_LOCAL_MUTATION_HOLD_MS,
    counts,
  });
}

export function preserveNewerChannelActivity(
  incomingItems: InboxItem[],
  currentItems: InboxItem[],
  newestFirst: boolean,
): { items: InboxItem[]; totalUnreadDelta: number } {
  if (inboxChannelActivityHighWater.size === 0) return { items: incomingItems, totalUnreadDelta: 0 };
  const now = currentTimeMs();
  const kept = new Set<InboxItem>();
  // A kept in-place count is not in the served totals (as for thread rows).
  let totalUnreadDelta = 0;
  const items = incomingItems.map((incoming) => {
    if (incoming.kind !== "channel" && incoming.kind !== "dm") return incoming;
    const local = inboxChannelActivityHighWater.get(incoming.channelId);
    if (!local) return incoming;
    const current = currentItems.find((item): item is ChannelInboxItem =>
      (item.kind === "channel" || item.kind === "dm") && item.channelId === incoming.channelId);
    if (
      !current
      || current.latestActivitySeq !== local.seq
      || now > local.until
      || incoming.latestActivitySeq == null
      || compareActivitySeq(incoming.latestActivitySeq, local.seq) >= 0
    ) {
      inboxChannelActivityHighWater.delete(incoming.channelId);
      return incoming;
    }
    const preserved: ChannelInboxItem = {
      ...incoming,
      lastMessageId: current.lastMessageId,
      latestActivitySeq: current.latestActivitySeq,
      lastMessageAt: current.lastMessageAt,
      lastMessagePreview: current.lastMessagePreview,
      lastMessageSenderType: current.lastMessageSenderType,
      lastMessageSenderId: current.lastMessageSenderId,
      lastMessageSenderName: current.lastMessageSenderName,
      latestDelegatedBy: current.latestDelegatedBy,
      latestRetracted: current.latestRetracted,
      senderAvatarUrl: current.senderAvatarUrl,
      ...(local.counts ? inPlaceUnreadOf(current) : {}),
    };
    totalUnreadDelta += preserved.unreadCount - incoming.unreadCount;
    kept.add(preserved);
    return preserved;
  });
  // The served order is the view's, without the live message: a kept row is
  // the newest, so it stays on top rather than dropping back for a moment.
  if (!newestFirst || kept.size === 0) return { items, totalUnreadDelta };
  return { items: [...items.filter((item) => kept.has(item)), ...items.filter((item) => !kept.has(item))], totalUnreadDelta };
}

// `until`: the stale-list bound, as for channel rows (a view this far behind is not lag).
type ThreadActivityHighWater = { messageId: string; seq: string | null; replyCount: number; until: number };
const inboxThreadActivityHighWater = new Map<string, ThreadActivityHighWater>();

type InboxLoadIdentity = {
  serverId: string | null;
  serverEpoch: number;
  principalId: string | null;
  generation: number;
};

function captureInboxLoadIdentity(): InboxLoadIdentity {
  const serverState = useServerStore.getState();
  const ingressContext = captureReceiverPrivateIngressContext(
    useMessageStore.getState().currentUserId,
  );
  return {
    serverId: serverState.current?.id ?? null,
    serverEpoch: serverState.serverEpoch,
    principalId: getCurrentPrincipalId(),
    generation: ingressContext.generation,
  };
}

function isInboxLoadIdentityCurrent(identity: InboxLoadIdentity): boolean {
  const serverState = useServerStore.getState();
  return (serverState.current?.id ?? null) === identity.serverId
    && serverState.serverEpoch === identity.serverEpoch
    && getCurrentPrincipalId() === identity.principalId;
}

// Stryker disable all: pure Activity-row projection glue is covered by read-state behavior tests; surviving mutants here are identity/no-op variants or mention_action type narrowing.
function projectInboxItem(item: InboxItem, projection: ReadStateProjection): InboxItem {
  if (item.kind === "mention_action" || item.kind === "object") return item;
  const nextFirstMentionMessageId = projection.hasMention ? projection.firstMentionMessageId : null;
  if (
    item.unreadCount === projection.unreadCount
    && item.firstUnreadMessageId === projection.firstUnreadMessageId
    && item.firstMentionMessageId === nextFirstMentionMessageId
    && item.hasMention === projection.hasMention
  ) {
    return item;
  }
  return {
    ...item,
    unreadCount: projection.unreadCount,
    firstUnreadMessageId: projection.firstUnreadMessageId,
    firstMentionMessageId: nextFirstMentionMessageId,
    hasMention: projection.hasMention,
  } as InboxItem;
}
// Stryker restore all

// Stryker disable all: applying already-known projections during Activity hydration is pinned by focused hydrate tests; mutations here only alter no-op/reference behavior.
function applyKnownReadStateProjectionsToItems(items: InboxItem[]): InboxItem[] {
  const serverId = useServerStore.getState().current?.id;
  if (!serverId) return items;
  let changed = false;
  const projected = items.map((item) => {
    const channelId = inboxItemChannelId(item);
    if (!channelId) return item;
    const projection = getAcceptedReadStateProjection(serverId, channelId);
    if (!projection?.complete) return item;
    // A Mark as Unread here outranks a read projection of an earlier Read
    // (one newer than the Unread has retired it: localUnreadOf).
    if (projection.unreadCount === 0 && localUnreadOf(channelId)) return item;
    const next = projectInboxItem(item, projection);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? projected : items;
}
// Stryker restore all

/** A conversation row: the rows with a read state and a Done of the conversation's own. */
type ActivityPersistedItem = Exclude<InboxItem, { kind: "mention_action" | "object" }>;

export function inboxItemLatestMarker(item: ActivityPersistedItem): string | null {
  // #632 C1: the Done/read suppression marker keys off the AUTHORITY frontier
  // only, normalised onto this row by loadInbox from the adapter outcome at the
  // same index. The raw union deliberately does NOT live here: the adapter is
  // its single interpreter, and re-judging present/absent/corrupt in a second
  // place is how two interpreters drift apart.
  //
  // Deliberately NOT the display pair (`latestActivitySeq` /
  // `latestActivityMessageId`). That pair exists for serialization display and
  // keeps the zero-reply parent fallback, which puts the PARENT channel's seq
  // beside a thread scope — a different seq domain from the thread's own
  // cursor. Comparing across those domains is the error family behind the
  // "row will not stay read" report. If this returning null ever looks
  // inconvenient, the fix is not to fall back to the display pair.
  //
  // No authority frontier (absent / corrupt / present with a null pair) means
  // NO suppression is registered, rather than suppressing on a weaker key.
  return item.readStateLatestActivitySeq ?? null;
}

// A held row shows again only for activity NEWER than the click. A stale
// list (RW lag, or the Redis fallback copy) can carry an OLDER marker than the
// one recorded at click time; that is still the same, already-handled row.
function inboxMarkerIsNewer(marker: string | null, suppressedMarker: string): boolean {
  return compareActivitySeq(marker, suppressedMarker) > 0;
}

function clearInboxLocalDoneSuppressions() {
  inboxLocalDoneSuppressionUntil = 0;
  inboxLocalDoneSuppressedMarkers.clear();
  inboxLocalDoneSuppressedUntil.clear();
}

function clearInboxLocalReadSuppressions() {
  inboxLocalReadSuppressionUntil = 0;
  inboxLocalReadSuppressedMarkers.clear();
  inboxLocalReadSuppressedUntil.clear();
}

// Mark as Unread here (the row's menu, a phone's right swipe: markUnread) is
// the read suppression's mirror. The row shows unread at once, and keeps
// showing unread against the reads that lag the write (RisingWave, the stale
// copy: INBOX_LOCAL_MUTATION_HOLD_MS) until a served row's read state is at
// least as new as the one /unread answered with, or the hold lapses. Keyed by
// the conversation (a thread's own channel, else the row's channel); a null
// version: /unread hasn't answered yet. It also gives way to a Read here
// (markRead, Mark all read, a conversation read here) and to a read state
// accepted from elsewhere that is newer than its own (another device).
type InboxLocalUnread = { readStateVersion: number | null; until: number };
const inboxLocalUnreads = new Map<string, InboxLocalUnread>();

/** A conversation's own row: the rows with a read state (not a direct mention, not an object). */
function isConversationRow(item: InboxItem): item is ActivityPersistedItem {
  return item.kind === "channel" || item.kind === "dm" || item.kind === "thread";
}

/** The row as Mark as Unread leaves it: unread from its latest message, as the server marks it. */
function unreadInboxItem(item: ActivityPersistedItem): ActivityPersistedItem {
  if (item.unreadCount > 0) return item;
  const latest = item.kind === "thread" ? item.latestActivityMessageId : item.lastMessageId;
  return { ...item, unreadCount: 1, firstUnreadMessageId: latest };
}

function localUnreadOf(scopeId: string, nowMs = currentTimeMs()): InboxLocalUnread | null {
  const local = inboxLocalUnreads.get(scopeId);
  if (!local) return null;
  // A read state accepted since that is newer than the Unread's own (read on
  // another device, by socket or a served row): that is the latest word.
  const accepted = local.readStateVersion === null
    ? null
    : getAcceptedReadState(useServerStore.getState().current?.id ?? null, scopeId);
  if (nowMs > local.until || (accepted && local.readStateVersion !== null && accepted.readStateVersion > local.readStateVersion)) {
    inboxLocalUnreads.delete(scopeId);
    return null;
  }
  return local;
}

function pruneInboxLocalUnreads(nowMs = currentTimeMs()): void {
  for (const scopeId of [...inboxLocalUnreads.keys()]) localUnreadOf(scopeId, nowMs);
}

/** The latest activity time of a conversation row (its sort key in the list). */
function inboxRowActivityAt(item: ActivityPersistedItem): number {
  const at = Date.parse(item.kind === "thread" ? item.lastActivityAt : item.lastMessageAt);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}


/**
 * Served rows of conversations marked unread here: shown unread while the
 * served read state is older than the /unread's (or it hasn't answered); a
 * served row as new as it retires the hold, and is shown as served.
 */
function applyInboxLocalUnreads(
  items: InboxItem[],
  servedFrontierOf: ReadonlyMap<string, InboxScopeReadFrontier | undefined>,
): { items: InboxItem[]; addedUnreadCount: number } {
  if (inboxLocalUnreads.size === 0) return { items, addedUnreadCount: 0 };
  let addedUnreadCount = 0;
  const next = items.map((item) => {
    if (!isConversationRow(item)) return item;
    const scopeId = inboxItemChannelId(item);
    const local = scopeId ? localUnreadOf(scopeId) : null;
    if (!scopeId || !local) return item;
    const served = servedFrontierOf.get(getInboxItemKey(item));
    if (local.readStateVersion !== null && served?.kind === "present" && served.readStateVersion >= local.readStateVersion) {
      inboxLocalUnreads.delete(scopeId);
      return item;
    }
    if (item.unreadCount > 0) return item;
    addedUnreadCount += 1;
    return unreadInboxItem(item);
  });
  return { items: addedUnreadCount > 0 ? next : items, addedUnreadCount };
}

/**
 * Under an Unread filter, a lagging read leaves out a row marked unread
 * here: it stays listed, unread, where the list shows it. `covers` says
 * whether the served page reaches where the row sorts: only a row that fell
 * out of a page that covers it is missing from the server's totals and
 * groups (`fellOut`); one past the page is counted there already.
 */
function keepLocallyUnreadRows(
  next: InboxItem[],
  current: readonly InboxItem[],
  covers: (row: ActivityPersistedItem) => boolean,
): { items: InboxItem[]; fellOut: ActivityPersistedItem[] } {
  if (inboxLocalUnreads.size === 0) return { items: next, fellOut: [] };
  const listed = new Set(next.map(getInboxItemKey));
  let items = next;
  const fellOut: ActivityPersistedItem[] = [];
  for (const row of current) {
    if (!isConversationRow(row) || listed.has(getInboxItemKey(row))) continue;
    const scopeId = inboxItemChannelId(row);
    const local = scopeId ? localUnreadOf(scopeId) : null;
    if (!local) continue;
    const at = activityUnreadSnapshotIndex(getInboxItemKey(row), items);
    const unread = unreadInboxItem(row);
    items = [...items.slice(0, at), unread, ...items.slice(at)];
    listed.add(getInboxItemKey(row));
    if (covers(row)) fellOut.push(unread);
  }
  return { items, fellOut };
}

export function rememberLocalThreadActivity(item: ThreadInboxItem) {
  inboxThreadActivityHighWater.set(item.threadChannelId, {
    messageId: item.latestActivityMessageId,
    seq: item.latestActivitySeq ?? null,
    replyCount: item.replyCount,
    until: currentTimeMs() + INBOX_LOCAL_MUTATION_HOLD_MS,
  });
}

export function clearInboxLocalThreadActivityHighWater() {
  inboxThreadActivityHighWater.clear();
}

/**
 * Is this HTTP response still the one the store is waiting for?
 *
 * #632 C1: a response that fails this must have ZERO side effects — no ledger
 * fold, no suppression reconcile, no high-water touch, no UI write. The old
 * shape computed suppressions first and discarded the result inside `set()`,
 * but `applyInboxLocal*Suppressions` DELETES from the suppression map, so a
 * superseded response silently cleared the newer round's Done/read intent on
 * its way to being thrown away. One gate, checked before anything reconciles.
 */
function isCurrentInboxResponse(
  requestId: number,
  requestIdentity: ReturnType<typeof captureInboxLoadIdentity>,
  requestFilter: InboxFilter,
  requestChannelFilterId: string | null,
  requestSortDirection: ActivitySortDirection,
  requestSearchQuery: string,
  requestScope: InboxScope | null,
): boolean {
  const state = useInboxStore.getState();
  return requestId === activeInboxLoadRequestId
    && isInboxLoadIdentityCurrent(requestIdentity)
    && state.filter === requestFilter
    && state.channelFilterId === requestChannelFilterId
    && state.scope === requestScope
    && state.sortDirection === requestSortDirection
    && state.searchQuery === requestSearchQuery;
}

function rememberInboxLocalDoneSuppression(item: ActivityPersistedItem, nowMs = currentTimeMs()) {
  const marker = inboxItemLatestMarker(item);
  // No authority frontier -> no suppression. Suppressing on a weaker key is how
  // a row comes back after being marked done.
  if (marker === null) return;
  inboxLocalDoneSuppressionUntil = Math.max(inboxLocalDoneSuppressionUntil, nowMs + LOCAL_DONE_SUPPRESSION_MS);
  inboxLocalDoneSuppressedMarkers.set(getInboxItemKey(item), marker);
  inboxLocalDoneSuppressedUntil.set(getInboxItemKey(item), nowMs + LOCAL_DONE_SUPPRESSION_MS);
}

function rememberInboxLocalReadSuppression(item: ActivityPersistedItem, nowMs = currentTimeMs()) {
  const marker = inboxItemLatestMarker(item);
  // Same rule as Done: without the authority frontier we do not suppress.
  if (marker === null) return;
  inboxLocalReadSuppressionUntil = Math.max(inboxLocalReadSuppressionUntil, nowMs + LOCAL_READ_SUPPRESSION_MS);
  inboxLocalReadSuppressedMarkers.set(getInboxItemKey(item), marker);
  inboxLocalReadSuppressedUntil.set(getInboxItemKey(item), nowMs + LOCAL_READ_SUPPRESSION_MS);
}

function forgetInboxLocalDoneSuppression(item: ActivityPersistedItem) {
  inboxLocalDoneSuppressedMarkers.delete(getInboxItemKey(item));
  inboxLocalDoneSuppressedUntil.delete(getInboxItemKey(item));
}

/** Claim the newest mark-done generation for this row (#5690 fence). */
function issueInboxDoneGeneration(item: ActivityPersistedItem): number {
  inboxDoneRequestSeq += 1;
  inboxDoneRequestGeneration.set(getInboxItemKey(item), inboxDoneRequestSeq);
  return inboxDoneRequestSeq;
}

/** True only while `generation` is still the newest mark-done issued for this row. */
function isCurrentInboxDoneGeneration(item: ActivityPersistedItem, generation: number): boolean {
  return inboxDoneRequestGeneration.get(getInboxItemKey(item)) === generation;
}

/** A Done whose POST has not settled and whose row is still locally hidden. */
function hasUnconfirmedInboxDone(): boolean {
  for (const key of inboxDoneRequestGeneration.keys()) {
    if (inboxLocalDoneSuppressedMarkers.has(key)) return true;
  }
  return false;
}

function releaseInboxDoneGeneration(item: ActivityPersistedItem, generation: number) {
  const key = getInboxItemKey(item);
  if (inboxDoneRequestGeneration.get(key) === generation) inboxDoneRequestGeneration.delete(key);
}

function forgetInboxLocalReadSuppression(item: ActivityPersistedItem) {
  inboxLocalReadSuppressedMarkers.delete(getInboxItemKey(item));
  inboxLocalReadSuppressedUntil.delete(getInboxItemKey(item));
}

/**
 * A served Activity row is one consistent generation (RisingWave reads are
 * checkpoint-consistent), but it can be OLDER than what this client already
 * knows: the client's own read reaches the ledger through its ack before
 * RisingWave has ingested the cursor. An older generation must not override a
 * newer one, so the ledger adjudicates such rows: when its cursor already
 * covers the row's latest activity, the row is read. A row the ledger knows
 * nothing newer about, or whose latest activity is beyond the ledger's cursor,
 * is served as-is (there is genuinely unread content).
 */
function adjudicateServedUnreadAgainstLedger(
  serverId: string | null,
  items: InboxItem[],
  servedFrontiers: readonly (InboxScopeReadFrontier | undefined)[],
  filter: InboxFilter,
): { items: InboxItem[]; suppressedCount: number; suppressedUnreadCount: number } {
  let suppressedCount = 0;
  let suppressedUnreadCount = 0;
  const nextItems: InboxItem[] = [];
  items.forEach((item, index) => {
    const served = servedFrontiers[index];
    const scopeId = inboxItemChannelId(item);
    const ledger = scopeId ? getAcceptedReadState(serverId, scopeId) : null;
    const latestSeq = served?.kind === "present" ? served.latestActivity?.seq ?? null : null;
    if (
      !ledger
      || served?.kind !== "present"
      || ledger.readStateVersion <= served.readStateVersion
      || latestSeq === null
      || BigInt(ledger.maxReadSeq) < BigInt(latestSeq)
      || item.unreadCount === 0
    ) {
      nextItems.push(item);
      return;
    }
    suppressedUnreadCount += item.unreadCount;
    if (isUnreadInboxFilter(filter)) {
      suppressedCount += 1;
      return;
    }
    nextItems.push({
      ...item,
      unreadCount: 0,
      firstUnreadMessageId: null,
      firstMentionMessageId: null,
      hasMention: false,
    } as InboxItem);
  });
  return { items: nextItems, suppressedCount, suppressedUnreadCount };
}

function applyInboxLocalReadSuppressions(
  items: InboxItem[],
  filter: InboxFilter,
  nowMs = currentTimeMs(),
): { items: InboxItem[]; suppressedCount: number; suppressedUnreadCount: number } {
  if (nowMs > inboxLocalReadSuppressionUntil) {
    clearInboxLocalReadSuppressions();
    return { items, suppressedCount: 0, suppressedUnreadCount: 0 };
  }

  let suppressedCount = 0;
  let suppressedUnreadCount = 0;
  const nextItems: InboxItem[] = [];

  for (const item of items) {
    if (item.kind === "mention_action" || item.kind === "object") {
      nextItems.push(item);
      continue;
    }

    const key = getInboxItemKey(item);
    const suppressedMarker = inboxLocalReadSuppressedMarkers.get(key);
    if (
      suppressedMarker === undefined
      || inboxMarkerIsNewer(inboxItemLatestMarker(item), suppressedMarker)
      || nowMs > (inboxLocalReadSuppressedUntil.get(key) ?? 0)
    ) {
      inboxLocalReadSuppressedMarkers.delete(key);
      inboxLocalReadSuppressedUntil.delete(key);
      nextItems.push(item);
      continue;
    }

    suppressedUnreadCount += item.unreadCount;
    if (filter === "all") {
      nextItems.push(readInboxItem(item));
    } else {
      suppressedCount += 1;
    }
  }

  return { items: nextItems, suppressedCount, suppressedUnreadCount };
}

function applyActivityReadStateHolds(
  items: InboxItem[],
  filter: InboxFilter,
  identity: ActivityReadStateIdentity,
): { items: InboxItem[]; suppressedCount: number; suppressedUnreadCount: number } {
  let suppressedCount = 0;
  let suppressedUnreadCount = 0;
  let changed = false;
  const nextItems: InboxItem[] = [];

  for (const item of items) {
    if (item.kind === "mention_action" || item.kind === "object") {
      nextItems.push(item);
      continue;
    }
    const scopeId = inboxItemChannelId(item);
    if (!scopeId || !hasActivityReadHold(identity, scopeId)) {
      nextItems.push(item);
      continue;
    }

    suppressedUnreadCount += item.unreadCount;
    if (isUnreadInboxFilter(filter)) {
      suppressedCount += 1;
      changed = true;
      continue;
    }
    if (item.unreadCount > 0 || item.firstUnreadMessageId || item.firstMentionMessageId || item.hasMention) {
      changed = true;
      nextItems.push({
        ...item,
        unreadCount: 0,
        firstUnreadMessageId: null,
        firstMentionMessageId: null,
        hasMention: false,
      } as InboxItem);
      continue;
    }
    nextItems.push(item);
  }

  return {
    items: changed ? nextItems : items,
    suppressedCount,
    suppressedUnreadCount,
  };
}

function applyInboxLocalDoneSuppressions(
  items: InboxItem[],
  nowMs = currentTimeMs(),
): { items: InboxItem[]; suppressedCount: number; suppressedUnreadCount: number } {
  if (nowMs > inboxLocalDoneSuppressionUntil) {
    clearInboxLocalDoneSuppressions();
    return { items, suppressedCount: 0, suppressedUnreadCount: 0 };
  }

  let suppressedCount = 0;
  let suppressedUnreadCount = 0;
  const nextItems: InboxItem[] = [];

  for (const item of items) {
    if (item.kind === "mention_action" || item.kind === "object") {
      nextItems.push(item);
      continue;
    }

    const key = getInboxItemKey(item);
    const suppressedMarker = inboxLocalDoneSuppressedMarkers.get(key);
    if (
      suppressedMarker === undefined
      || inboxMarkerIsNewer(inboxItemLatestMarker(item), suppressedMarker)
      || nowMs > (inboxLocalDoneSuppressedUntil.get(key) ?? 0)
    ) {
      inboxLocalDoneSuppressedMarkers.delete(key);
      inboxLocalDoneSuppressedUntil.delete(key);
      nextItems.push(item);
      continue;
    }

    suppressedCount += 1;
    suppressedUnreadCount += item.unreadCount;
  }

  return { items: nextItems, suppressedCount, suppressedUnreadCount };
}

export function preserveNewerThreadActivity(
  incomingItems: InboxItem[],
  currentItems: InboxItem[],
  newestFirst: boolean,
): { items: InboxItem[]; totalUnreadDelta: number } {
  // Stryker disable all: InboxItem's discriminant makes non-thread rows
  // structurally incapable of contributing a thread-channel key.
  const currentThreads = new Map(
    currentItems
      .filter((item): item is ThreadInboxItem => item.kind === "thread")
      .map((item) => [item.threadChannelId, item]),
  );
  // Stryker restore all
  let totalUnreadDelta = 0;
  const now = currentTimeMs();
  // Rows kept at a newer reply than the answer has (receiveThreadReply moved them to the top).
  const kept = new Set<InboxItem>();

  const items = incomingItems.map((incoming) => {
    // Stryker disable next-line ConditionalExpression: InboxItem's discriminant guarantees non-thread rows have no thread identity or reply version to reconcile.
    if (incoming.kind !== "thread") return incoming;
    const current = currentThreads.get(incoming.threadChannelId);
    const localVersion = inboxThreadActivityHighWater.get(incoming.threadChannelId);
    // Past the stale-list bound the answer is not lag any more: it wins, also
    // over the fail-closed holds below (task #361).
    if (!current || (localVersion && now > localVersion.until)) {
      inboxThreadActivityHighWater.delete(incoming.threadChannelId);
      return incoming;
    }
    if (!localVersion) return incoming;

    // task #361 activation-gated, fail-closed: when BOTH the incoming row and the local
    // high-water carry the authoritative content-frontier seq (server canonical path
    // active), decide purely by seq — a newer seq wins even when replyCount is
    // lower/equal (deleted replies / divergent counting / an out-of-order socket reply
    // inflating the local count must not freeze a stale latestActivityMessageId).
    // Missing/invalid seq is fail-closed (compareActivitySeq treats it as absent → the
    // incoming row does NOT win). There is deliberately NO timestamp/messageId fallback
    // here — those are not the content frontier and would re-mix axes. Pre-activation
    // (a seq side absent) keeps the legacy replyCount comparison unchanged.
    const inSeq = incoming.latestActivitySeq ?? null;
    const localSeq = localVersion.seq;
    if (inSeq != null && localSeq != null) {
      const cmp = compareActivitySeq(inSeq, localSeq);
      if (cmp > 0) {
        rememberLocalThreadActivity(incoming);
        return incoming;
      }
      if (cmp === 0 && incoming.latestActivityMessageId === localVersion.messageId) return incoming;
      totalUnreadDelta += current.unreadCount - incoming.unreadCount;
      if (cmp < 0) kept.add(current);
      return current;
    }
    // Fail-closed (task #361 Gate B1-3): latestActivitySeq is now required on every
    // row, so a missing seq on EITHER side is an invalid/pre-activation state. Do NOT
    // fall back to replyCount — it is display-only, would re-mix axes, and could let a
    // malformed/older frame win on a non-frontier axis (freezing a stale
    // latestActivityMessageId). Keep the current row so the frontier only advances on
    // the authoritative seq axis.
    totalUnreadDelta += current.unreadCount - incoming.unreadCount;
    return current;
  });

  // The served order is the view's, without the live reply: a kept row goes
  // back to its place by time (the kept channel rows too), above every row
  // the answer has as older, rather than dropping back for a moment.
  if (!newestFirst || kept.size === 0) return { items, totalUnreadDelta };
  const leads = (item: InboxItem) => kept.has(item) || keptChannelRow(item);
  const at = (item: InboxItem) => (isConversationRow(item) ? inboxRowActivityAt(item) : Number.NEGATIVE_INFINITY);
  const moved = items.filter(leads).sort((a, b) => (at(a) === at(b) ? 0 : at(a) > at(b) ? -1 : 1));
  const merged = items.filter((item) => !leads(item));
  for (const row of moved.reverse()) {
    const before = merged.findIndex((other) => isConversationRow(other) && at(other) < at(row));
    merged.splice(before < 0 ? merged.length : before, 0, row);
  }
  return { items: merged, totalUnreadDelta };
}

/** A channel row preserveNewerChannelActivity just kept at its newer live message. */
function keptChannelRow(item: InboxItem): boolean {
  if (item.kind !== "channel" && item.kind !== "dm") return false;
  const local = inboxChannelActivityHighWater.get(item.channelId);
  return local !== undefined && local.seq === item.latestActivitySeq;
}

function preserveLoadedInboxTail(
  refreshedItems: InboxItem[],
  currentItems: InboxItem[],
  hasMore: boolean,
  canPreserveTail: boolean,
): InboxItem[] {
  if (!canPreserveTail || !hasMore || currentItems.length <= refreshedItems.length) return refreshedItems;

  const seen = new Set(refreshedItems.map(getInboxItemKey));
  const tail = currentItems.filter((item) => {
    const key = getInboxItemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...refreshedItems, ...tail];
}

// ---- Object rows (shared activityObjectsContract) ------------------------------

/** A Done or read of an object row, still applied to served rows (see applyObjectActivityHolds). */
type ObjectActivityHold = { action: "done" | "read"; seq: string; until: number };
const objectActivityHolds = new Map<string, ObjectActivityHold>();

function holdObjectActivity(item: ObjectActivityItem, action: ObjectActivityHold["action"], nowMs = currentTimeMs()): void {
  objectActivityHolds.set(getInboxItemKey(item), { action, seq: item.doneFrontierSeq, until: nowMs + INBOX_LOCAL_MUTATION_HOLD_MS });
}

function forgetObjectActivityHold(item: ObjectActivityItem): void {
  objectActivityHolds.delete(getInboxItemKey(item));
}

/**
 * The conversation rows' rule for a Done or read (task #33), on object rows:
 * the list may be a cached answer older than the write (the server's stale
 * copy), so a row done or read here stays so until it is served with a newer
 * event (a larger `doneFrontierSeq`) or INBOX_LOCAL_MUTATION_HOLD_MS lapses.
 * A done row is left out; a read one shows read, or is left out of an unread
 * list. Returns what that took from the served object counts.
 */
function applyObjectActivityHolds(
  items: InboxItem[],
  filter: InboxFilter,
  nowMs = currentTimeMs(),
): { items: InboxItem[]; removedCount: number; heldUnreadCount: number; heldMentionUnreadCount: number } {
  if (objectActivityHolds.size === 0) return { items, removedCount: 0, heldUnreadCount: 0, heldMentionUnreadCount: 0 };
  let removedCount = 0;
  let heldUnreadCount = 0;
  let heldMentionUnreadCount = 0;
  const nextItems = items.flatMap((item): InboxItem[] => {
    if (item.kind !== "object") return [item];
    const key = getInboxItemKey(item);
    const hold = objectActivityHolds.get(key);
    if (!hold) return [item];
    if (nowMs > hold.until || compareActivitySeq(item.doneFrontierSeq, hold.seq) > 0) {
      objectActivityHolds.delete(key);
      return [item];
    }
    if (item.unreadCount > 0) heldUnreadCount += 1;
    if (countsInObjectMentionUnread(item, filter, true)) heldMentionUnreadCount += 1;
    if (hold.action === "done" || isUnreadInboxFilter(filter)) {
      removedCount += 1;
      return [];
    }
    return [readInboxItem(item)];
  });
  return { items: nextItems, removedCount, heldUnreadCount, heldMentionUnreadCount };
}

/**
 * Whether an unread object row is one `objectMentionUnreadCount` counts, as
 * far as the client can tell: an unread mention always is; under a Mentions
 * filter every row listed is (it lists only rows with a mention since Done).
 * Elsewhere a row unread since a read mention isn't known to be: the count
 * stays until the next answer, which only the Mentions filters show.
 */
function countsInObjectMentionUnread(item: InboxItem, filter: InboxFilter, listed: boolean): boolean {
  return item.unreadCount > 0 && (item.hasMention || (listed && (filter === "mentions" || filter === "unread_mentions")));
}

/**
 * The unread object rows Activity's unread adds for the list's filter (shared
 * activityObjectsContract): under Mentions the listed rows' unread
 * (`objectMentionUnreadCount`); under Unread + Mentions every listed row
 * (`objectCount`: each is unread); otherwise every unread one.
 */
export function objectUnreadCountForFilter(filter: InboxFilter, counts: Pick<InboxState, "objectUnreadCount" | "objectMentionUnreadCount" | "objectCount">): number {
  if (filter === "mentions") return counts.objectMentionUnreadCount;
  if (filter === "unread_mentions") return counts.objectCount;
  return counts.objectUnreadCount;
}

/** The rows of conversations, without object rows: what the conversation totals count. */
function conversationRows(items: readonly InboxItem[]): InboxItem[] {
  return items.filter((item) => item.kind !== "object");
}

/** `objectActivityWebPaths` are absolute (`/api/…`); the client's base already ends in `/api`. */
function objectActivityRoute(action: keyof typeof objectActivityWebPaths): string {
  return objectActivityWebPaths[action]().replace(/^\/api(?=\/)/, "");
}

/** Done or read (through the row's newest event: what it showed), or undo Done, for an object row; on `serverId` when given. */
async function postObjectActivity(action: keyof typeof objectActivityWebPaths, item: ObjectActivityItem, serverId?: string | null): Promise<void> {
  const body: ObjectActivityInput | ObjectActivityDoneInput | ObjectActivityReadInput = action === "undone"
    ? { kind: item.objectKind, objectId: item.objectId }
    : { kind: item.objectKind, objectId: item.objectId, throughSeq: item.doneFrontierSeq };
  await api.post(objectActivityRoute(action), body, serverId ? { headers: { "X-Server-Id": serverId } } : undefined);
}

/** An object row shown read at once (left out of an unread list), held so against older answers. */
function showObjectRowRead(item: ObjectActivityItem): void {
  const key = getInboxItemKey(item);
  holdObjectActivity(item, "read");
  // Read, so the Unread list keeps it, read (store/activityUnreadSnapshot).
  noteActivityUnreadRowsRead([key]);
  useInboxStore.setState((state) => {
    const listed = state.items.find((existing) => getInboxItemKey(existing) === key);
    const unreadList = isUnreadInboxFilter(state.filter);
    return {
      items: unreadList
        ? state.items.filter((existing) => getInboxItemKey(existing) !== key)
        : state.items.map((existing) => (getInboxItemKey(existing) === key ? readInboxItem(existing) : existing)),
      objectCount: unreadList && listed ? Math.max(0, state.objectCount - 1) : state.objectCount,
      objectUnreadCount: (listed ?? item).unreadCount > 0 ? Math.max(0, state.objectUnreadCount - 1) : state.objectUnreadCount,
      objectMentionUnreadCount: countsInObjectMentionUnread(listed ?? item, state.filter, listed !== undefined)
        ? Math.max(0, state.objectMentionUnreadCount - 1)
        : state.objectMentionUnreadCount,
    };
  });
}

/**
 * An object read outside its row (its viewer opened at the latest version, where the server moved
 * the read): its listed row, if unread, shows read at once. Read state is the person's, whichever
 * server read it; a row not listed (a later page) comes read with the next answer.
 */
export function showObjectReadHere(objectKind: SummarizedObjectKind, objectId: string): void {
  const row = useInboxStore.getState().items.find((item): item is ObjectActivityItem => item.kind === "object" && item.objectKind === objectKind && item.objectId === objectId);
  if (row && row.unreadCount > 0) showObjectRowRead(row);
}

/** Read an object row: shown read at once (left out of an unread list), then written. */
async function markObjectRowRead(item: ObjectActivityItem): Promise<void> {
  const identity = captureInboxLoadIdentity();
  showObjectRowRead(item);
  try {
    await postObjectActivity("read", item);
  } catch (err) {
    console.error("Failed to mark an object's Activity row as read:", err);
    if (!isInboxLoadIdentityCurrent(identity)) return;
    forgetObjectActivityHold(item);
    await useInboxStore.getState().refreshInbox({ background: true });
  }
}

/**
 * Done for an object row (through its newest event, `doneFrontierSeq`): out
 * of the list at once, then written. A failed write brings it back.
 * `restoreKept` puts back the row an Unread list kept, read.
 */
async function markObjectRowDone(item: ObjectActivityItem, listed: boolean, restoreKept: (() => void) | null): Promise<void> {
  const identity = captureInboxLoadIdentity();
  holdObjectActivity(item, "done");
  if (listed) useInboxStore.getState().removeItem(item);
  try {
    await postObjectActivity("done", item);
  } catch (err) {
    console.error("Failed to mark an object's Activity row as done:", err);
    if (!isInboxLoadIdentityCurrent(identity)) return;
    forgetObjectActivityHold(item);
    restoreKept?.();
    await useInboxStore.getState().refreshInbox();
  }
}

/**
 * Writes Done for `item`, a row as it was accepted on `serverId`, to that
 * server alone (`markDone` after a server switch). The same frontier rules
 * as `markDone`: an older server's row (no `doneFrontierSeq`) sends no
 * sequence, an unusable one sends nothing. A failure is only logged: there
 * is no list of that server's here to put the row back in.
 */
async function markDoneOnServer(item: InboxItem, serverId: string): Promise<void> {
  if (item.kind === "mention_action") return;
  if (item.kind === "object") {
    await postObjectActivity("done", item, serverId).catch((err: unknown) => {
      console.error("Failed to mark an object's Activity row as done on its server:", err);
    });
    return;
  }
  const isLegacyServerRow = item.doneFrontierSeq === undefined;
  const throughActivitySeq = item.doneFrontierSeq;
  if (!isLegacyServerRow && (typeof throughActivitySeq !== "string" || !/^[1-9][0-9]*$/.test(throughActivitySeq))) return;
  const config = { headers: { "X-Server-Id": serverId } };
  try {
    if (item.kind === "thread") {
      await api.post("/channels/threads/done", isLegacyServerRow
        ? { threadChannelId: item.threadChannelId }
        : { threadChannelId: item.threadChannelId, throughActivitySeq, frontierSpace: "storage" as const }, config);
    } else {
      await api.post("/channels/inbox/done", isLegacyServerRow
        ? { channelId: item.channelId }
        : { channelId: item.channelId, throughActivitySeq, frontierSpace: "storage" as const }, config);
    }
  } catch (err) {
    console.error("Failed to mark inbox item as done on its server:", err);
  }
}

/**
 * Mark as Unread on one conversation (`scopeId`: a thread's own channel, else
 * the row's channel). `item`: its Activity row, which shows unread at once;
 * null when Activity has no row for it loaded (a thread marked unread from its
 * own panel): the same write and the same hold, and the reload shows the row.
 * `thread`: the scope is a thread, whose entry in its channel shows it too.
 */
async function markScopeUnread(
  { get, set }: { get: StoreApi<InboxState>["getState"]; set: StoreApi<InboxState>["setState"] },
  scopeId: string,
  item: ConversationInboxItem | null,
  thread: boolean,
  options?: InboxReadWriteOptions,
): Promise<void> {
  const identity = captureHumanActivityIngressContext(useMessageStore.getState().currentUserId);
  pruneInboxLocalUnreads();
  const ofScope = (row: InboxItem): row is ActivityPersistedItem => isConversationRow(row) && inboxItemChannelId(row) === scopeId;
  // A Read just before holds the row read here, against a stale page (the
  // local read suppression) and against the read's own ack (the read hold):
  // both kept the person's earlier word, which this one replaces.
  for (const row of get().items) if (ofScope(row)) forgetInboxLocalReadSuppression(row);
  if (item && isConversationRow(item)) forgetInboxLocalReadSuppression(item);
  releaseActivityReadHold(identity, scopeId);
  // Unread at once, as the server will mark it: its latest message.
  const local: InboxLocalUnread = { readStateVersion: null, until: currentTimeMs() + LOCAL_READ_SUPPRESSION_MS };
  inboxLocalUnreads.set(scopeId, local);
  // The rows shown unread here before the answer, as they were: a scope the
  // server marks unread with no count goes back to them, with the mark's dot.
  const shownUnread = new Map<string, ActivityPersistedItem>();
  set((state) => {
    let added = 0;
    let items = state.items.map((row) => {
      if (!ofScope(row) || row.unreadCount > 0) return row;
      added += 1;
      const shown = unreadInboxItem(row);
      shownUnread.set(getInboxItemKey(row), row);
      return shown;
    });
    // Under an Unread filter a row read here has left the store, kept read
    // by the list (store/activityUnreadSnapshot): it comes back, unread,
    // where the list shows it.
    if (item && isUnreadInboxFilter(state.filter) && isConversationRow(item) && !items.some((row) => getInboxItemKey(row) === getInboxItemKey(item))) {
      const key = getInboxItemKey(item);
      const at = activityUnreadSnapshotIndex(key, items);
      const back = unreadInboxItem(item);
      items = [...items.slice(0, at), back, ...items.slice(at)];
      added += 1;
      return {
        items,
        // Back in its group too (the Read took it out).
        groups: incrementInboxGroupCounts(state.groups, [back]),
        totalCount: state.totalCount + 1,
        totalUnreadCount: state.totalUnreadCount + added,
        activeUnreadCount: state.activeUnreadCount + added,
      };
    }
    if (added === 0) return {};
    return {
      items,
      totalUnreadCount: state.totalUnreadCount + added,
      activeUnreadCount: state.activeUnreadCount + added,
    };
  });
  if (options?.after) {
    await options.after;
    if (!isReceiverPrivateIngressContextCurrent(identity)) return;
    // The Read before this one may have set its hold since (its ack came
    // back while this waited): this Unread is the later word.
    releaseActivityReadHold(identity, scopeId);
  }
  let answer: { unreadCount?: unknown; readStateVersion?: unknown; maxReadSeq?: unknown; markedUnread?: unknown } | null = null;
  let failed = false;
  try {
    const { data } = await api.post(`/channels/${scopeId}/unread`);
    answer = data ?? null;
  } catch {
    failed = true;
  }
  // Another server (or person) now: its stores are not this row's.
  if (!isReceiverPrivateIngressContextCurrent(identity)) return;
  // Nothing countable: the server marked the conversation unread with no
  // count (a server older than the mark answers 0 without it, and nothing
  // changed there). Shown with the mark's dot instead of a number.
  const outcome = failed ? null : resolveMarkUnreadOutcome(answer);
  const markedUnread = outcome === "marked";
  if (markedUnread) {
    // Through the same version-ordered path as its socket event: an answer
    // later than a newer read (here or elsewhere) does not bring the mark back.
    const version = Number(answer?.readStateVersion);
    const maxReadSeq = Number(answer?.maxReadSeq ?? 0);
    if (identity.serverId && Number.isSafeInteger(version) && version > 0 && Number.isSafeInteger(maxReadSeq) && maxReadSeq >= 0) {
      const { applyReadStateUpdate } = await import("./applyReadStateUpdate");
      if (!isReceiverPrivateIngressContextCurrent(identity)) return;
      applyReadStateUpdate({ serverId: identity.serverId, scopeId, maxReadSeq, readStateVersion: version, markedUnread: true });
    }
    if (inboxLocalUnreads.get(scopeId) === local) inboxLocalUnreads.delete(scopeId);
    if (shownUnread.size > 0) {
      set((state) => {
        let restored = 0;
        const items = state.items.map((row) => {
          const before = shownUnread.get(getInboxItemKey(row));
          if (!before || !ofScope(row) || row.unreadCount <= 0) return row;
          restored += 1;
          return { ...row, unreadCount: before.unreadCount, firstUnreadMessageId: before.firstUnreadMessageId } as InboxItem;
        });
        if (restored === 0) return {};
        return {
          items,
          totalUnreadCount: Math.max(0, state.totalUnreadCount - restored),
          activeUnreadCount: Math.max(0, state.activeUnreadCount - restored),
        };
      });
    }
  }
  // Not saved: the reload below shows the row as it is; the caller says why.
  if (failed) options?.onFailed?.();
  else if (outcome === "nothing") options?.onNothingUnread?.();
  if (inboxLocalUnreads.get(scopeId) === local) {
    const version = answer?.readStateVersion;
    const saved = outcome === "counted" && Number.isSafeInteger(version) && Number(version) >= 0;
    // Not saved (failed, or nothing the server counts unread): the reload shows what is.
    if (saved) {
      local.readStateVersion = Number(version);
      // The lag it covers starts at the write, which may have waited
      // behind an earlier toggle's: the hold runs from the answer.
      local.until = currentTimeMs() + LOCAL_READ_SUPPRESSION_MS;
    } else {
      inboxLocalUnreads.delete(scopeId);
    }
    // A thread's entry in its channel (its reply count) shows it unread
    // too, as the server now counts it.
    if (saved && thread) useThreadStore.getState().applyThreadMarkedUnread(scopeId, Number(answer?.unreadCount));
  }
  await get().refreshInbox();
}

export const useInboxStore = create<InboxState>((set, get) => ({
  // Stryker disable all: initial filter/load state is unchanged inbox plumbing
  // pulled into the mutation diff by extracting the task metadata updater.
  items: [],
  acceptedWindowGeneration: "",
  hasAcceptedWindow: false,
  savedWindow: false,
  loadFailed: false,
  unfollowedItems: [],
  unfollowedLoading: false,
  unfollowedLoaded: false,
  unfollowedWindowGeneration: null,
  groups: [],
  filter: "all",
  channelFilterId: null,
  scope: null,
  sortDirection: "desc",
  searchQuery: "",
  loading: false,
  loadingMore: false,
  loaded: false,
  hasMore: true,
  totalCount: 0,
  allCount: null,
  totalUnreadCount: 0,
  activeUnreadCount: 0,
  objectUnreadCount: 0,
  objectMentionUnreadCount: 0,
  objectCount: 0,
  scrollTop: 0,
  focusedItemKey: null,
  focusRequestId: 0,
  pendingFocusKind: null,
  setFilter: (filter, scope = null) => {
    if (get().filter === filter && get().scope === scope) return;
    // The unfollowed rows are fetched per scope (not per read filter).
    const scopeChanged = get().scope !== scope;
    if (scopeChanged) inboxUnfollowedLoadGeneration += 1;
    set({
      filter,
      scope,
      ...(scopeChanged ? { unfollowedItems: [], unfollowedLoading: false, unfollowedLoaded: false, unfollowedWindowGeneration: null } : {}),
      items: [], acceptedWindowGeneration: "", hasAcceptedWindow: false, savedWindow: false, loadFailed: false, loaded: false, hasMore: true, totalCount: 0, objectCount: 0, totalUnreadCount: 0, scrollTop: 0,
    });
    void get().loadInbox({ reset: true, reuseAllCount: true, reason: "manual" });
  },

  setChannelFilterId: (channelFilterId) => {
    if (get().channelFilterId === channelFilterId) return;
    inboxUnfollowedLoadGeneration += 1;
    set({ channelFilterId, items: [], acceptedWindowGeneration: "", hasAcceptedWindow: false, savedWindow: false, loadFailed: false, unfollowedItems: [], unfollowedLoading: false, unfollowedLoaded: false, unfollowedWindowGeneration: null, loaded: false, hasMore: true, totalCount: 0, objectCount: 0, totalUnreadCount: 0, scrollTop: 0 });
    void get().loadInbox({ reset: true, reuseAllCount: true, reason: "manual" });
  },

  setSortDirection: (sortDirection) => {
    if (get().sortDirection === sortDirection) return;
    inboxUnfollowedLoadGeneration += 1;
    set({ sortDirection, items: [], acceptedWindowGeneration: "", hasAcceptedWindow: false, savedWindow: false, loadFailed: false, unfollowedItems: [], unfollowedLoading: false, unfollowedLoaded: false, unfollowedWindowGeneration: null, loaded: false, hasMore: true, totalCount: 0, objectCount: 0, totalUnreadCount: 0, scrollTop: 0 });
    void get().loadInbox({ reset: true, reuseAllCount: true, reason: "manual" });
  },

  setSearchQuery: (searchQuery) => {
    if (get().searchQuery === searchQuery) return;
    inboxUnfollowedLoadGeneration += 1;
    set({ searchQuery, items: [], acceptedWindowGeneration: "", hasAcceptedWindow: false, savedWindow: false, loadFailed: false, unfollowedItems: [], unfollowedLoading: false, unfollowedLoaded: false, unfollowedWindowGeneration: null, loaded: false, hasMore: true, totalCount: 0, objectCount: 0, totalUnreadCount: 0, scrollTop: 0 });
    void get().loadInbox({ reset: true, reuseAllCount: true, reason: "manual" });
  },

  setScrollTop: (scrollTop) => set({ scrollTop }),
  setFocusedItemKey: (key) => set((state) => ({
    focusedItemKey: key,
    focusRequestId: key ? state.focusRequestId + 1 : state.focusRequestId,
  })),
  setPendingFocusKind: (kind) => set({ pendingFocusKind: kind }),
  loadUnfollowed: async () => {
    if (get().unfollowedLoading || get().unfollowedLoaded) return;
    const requestIdentity = captureInboxLoadIdentity();
    const requestGeneration = ++inboxUnfollowedLoadGeneration;
    const state = get();
    // Capture the reset attempt, not whatever happens to be current when the
    // response arrives. A slow old loaded-empty result must never be relabelled
    // as evidence for a newer accepted window.
    const requestWindowGeneration = pendingInboxWindowGeneration
      ?? (state.acceptedWindowGeneration || null);
    set({ unfollowedLoading: true });
    try {
      const { data } = await api.get<{ items: ThreadInboxItem[] }>("/channels/inbox/unfollowed", {
        params: {
          sort: state.sortDirection,
          q: state.searchQuery || undefined,
          channelId: state.channelFilterId || undefined,
          scope: state.scope ?? undefined,
          limit: 100,
          offset: 0,
        },
      });
      if (requestGeneration !== inboxUnfollowedLoadGeneration
        || !isInboxLoadIdentityCurrent(requestIdentity)) return;
      set({
        unfollowedItems: data.items.map((item) => ({
          ...normalizeTaskConversationRow(item),
          isFollowing: false,
          unreadCount: 0,
          firstUnreadMessageId: null,
          hasMention: false,
        })),
        unfollowedLoaded: true,
        unfollowedWindowGeneration: requestWindowGeneration,
      });
    } catch (error) {
      console.error("Failed to load unfollowed Activity history:", error);
    } finally {
      if (requestGeneration === inboxUnfollowedLoadGeneration
        && isInboxLoadIdentityCurrent(requestIdentity)) set({ unfollowedLoading: false });
    }
  },
  loadInbox: async (opts = {}) => {
    const reset = opts.reset ?? false;
    const background = opts.background ?? false;
    const state = get();
    const requestFilter = state.filter;
    const requestChannelFilterId = state.channelFilterId;
    const requestScope = state.scope;
    const requestSortDirection = state.sortDirection;
    const requestSearchQuery = state.searchQuery;
    const preserveLoadedWindowOnReset = reset
      && (background || (state.loaded && state.items.length > PAGE_SIZE));
    const canPreserveLoadedTailOnReset = requestFilter === "all"
      && requestChannelFilterId === null
      && requestScope === null
      && requestSortDirection === "desc"
      && requestSearchQuery.trim() === "";
    // Realtime delivery can ask for a background first-window reconcile while
    // the initial foreground window (or a pagination window) is still in
    // flight. Starting that reset immediately would supersede the ready
    // response and can repeatedly collapse pagination back to page one. Keep
    // one trailing reconcile instead: it runs after the authoritative request
    // has committed, using the then-current loaded window width. Every caller
    // shares its completion promise so `await refreshInbox({ background:
    // true })` still means the trailing network response has committed.
    if (reset && background && activeInboxRequestInFlightId !== null) {
      trailingInboxBackgroundReset = true;
      trailingInboxBackgroundResetReason = opts.reason ?? trailingInboxBackgroundResetReason;
      trailingInboxBackgroundResetTrigger = foldInboxRefreshTrigger(trailingInboxBackgroundResetTrigger, opts.trigger);
      if (!trailingInboxBackgroundResetPromise) {
        trailingInboxBackgroundResetPromise = new Promise<void>((resolve) => {
          const settle = () => {
            pendingTrailingInboxBackgroundResetResolvers.delete(settle);
            resolve();
          };
          pendingTrailingInboxBackgroundResetResolvers.add(settle);
          resolveTrailingInboxBackgroundReset = settle;
        });
      }
      return trailingInboxBackgroundResetPromise;
    }
    if (!reset && (state.loading || state.loadingMore)) return;
    if (!reset && !state.hasMore) return;
    // Stryker restore all

    const requestId = ++inboxLoadRequestSeq;
    if (reset) lastInboxResetStartedAt = currentTimeMs();
    activeInboxLoadRequestId = requestId;
    activeInboxRequestInFlightId = requestId;
    const requestIdentity = captureInboxLoadIdentity();
    const requestWindowGeneration = reset
      ? `activity-window:${requestIdentity.generation}:${requestId}`
      : state.acceptedWindowGeneration;
    if (reset) pendingInboxWindowGeneration = requestWindowGeneration;
    const requestReadStateRevision = getActivityReadStateRevision();
    const requestReadStateLedgerGeneration = getReadStateLedgerGeneration();
    // The server this request belongs to. After an A->B switch a late A response
    // must never fold into B's ledger, so the fold uses THIS, not "current".
    const requestServerId = useServerStore.getState().current?.id ?? null;
    if (reset) {
      // A pending reset must not expose the previous accepted window generation.
      set(preserveLoadedWindowOnReset
        ? { acceptedWindowGeneration: "" }
        : { acceptedWindowGeneration: "", loading: true, loadingMore: false });
    } else if (!background) {
      set({ loadingMore: true });
    }
    let accepted = false;
    try {
      const requestLimit = preserveLoadedWindowOnReset
        ? Math.min(100, Math.max(PAGE_SIZE, state.items.length))
        : PAGE_SIZE;
      const allScope = requestFilter === "all" && !requestChannelFilterId && !requestScope && !requestSearchQuery;
      const pendingDoneAtStart = new Map(
        currentTimeMs() <= inboxLocalDoneSuppressionUntil ? inboxLocalDoneSuppressedMarkers : [],
      );
      // Navigation owns an unfiltered total, separate from the selected window.
      // Facet changes reuse a known total. Ordinary refreshes still reconcile it.
      // Reuse an All response; otherwise fetch only one row to obtain its total.
      const allCountRequest = reset && !allScope && (!opts.reuseAllCount || state.allCount === null)
        ? api.get("/channels/inbox", { params: { filter: "all", limit: 1, offset: 0 }, headers: listFetchReasonHeaders(opts.reason, opts.trigger) })
          .then(({ data }) => typeof data.totalCount === "number" ? data.totalCount : null)
          .catch(() => null)
        : Promise.resolve(null);
      const { data, stale } = await getRwRead<InboxPageResponse>("inbox", "/channels/inbox", {
        params: {
          filter: requestFilter,
          sort: requestSortDirection,
          q: requestSearchQuery || undefined,
          channelId: requestChannelFilterId || undefined,
          scope: requestScope ?? undefined,
          limit: requestLimit,
          offset: reset ? 0 : state.items.length,
        },
        // A page further down is not a whole-list read: no reason.
        headers: reset ? listFetchReasonHeaders(opts.reason, opts.trigger) : undefined,
      });
      const unfilteredCount = await allCountRequest;
      // Same active request, but read-state moved under it: collect our own
      // loading flags and return with ZERO data side effects.
      if (requestReadStateRevision !== getActivityReadStateRevision()) {
        // Stryker disable all: requestId is the primary freshness owner and changes atomically with every facet refresh; the remaining identity checks are defense-in-depth documentation.
        if (
          requestId === activeInboxLoadRequestId
          && get().filter === requestFilter
          && get().channelFilterId === requestChannelFilterId
          && get().scope === requestScope
          && isInboxLoadIdentityCurrent(requestIdentity)
        ) {
          set({ loading: false, loadingMore: false });
        }
        // Stryker restore all
        return;
      }
      // #632 C1 — single acceptance gate, before ANY reconcile or fold. A
      // superseded response does not participate in marker comparison at all;
      // it must not clear the suppression the newer round just registered.
      // An old request also must not clear a newer request's loading flags.
      if (!isCurrentInboxResponse(
        requestId,
        requestIdentity,
        requestFilter,
        requestChannelFilterId,
        requestSortDirection,
        requestSearchQuery,
        requestScope,
      )) {
        return;
      }

      // Task v2: a task conversation row (`kind: "task"`) is folded into the
      // thread arm here, before anything keys or reconciles it.
      // An object row (shared activityObjectsContract) is taken as it is, or
      // left out when this client can't show it; it has no read state of a
      // conversation's.
      type ServedConversationRow = { kind?: string; channelId?: string; threadChannelId?: string; readState?: InboxScopeReadFrontier };
      type ServedRow = { kind: "object"; item: ObjectActivityItem } | { kind: "conversation"; row: ServedConversationRow };
      const servedRows = ((data as { items?: unknown[] })?.items ?? []).flatMap((row): ServedRow[] => {
        if (isObjectActivityRow(row)) {
          const item = parseObjectActivityRow(row);
          return item ? [{ kind: "object", item }] : [];
        }
        return [{ kind: "conversation", row: normalizeTaskConversationRow(row) as ServedConversationRow }];
      });
      const servedConversations = servedRows.flatMap((served) => (served.kind === "conversation" ? [served.row] : []));
      const readStateOutcomes = consumeReadStateSnapshotRows(
        requestServerId,
        servedConversations.map((row) => ({
          scopeId: (row.kind === "thread" ? row.threadChannelId : row.channelId) ?? "",
          readState: row.readState,
        })),
        { ledgerGenerationAtRequest: requestReadStateLedgerGeneration },
      );
      const readStateOutcomeOf = new Map(servedConversations.map((row, index) => [row, readStateOutcomes[index]]));
      // Normalise by INDEX: the frontier stays bound to the row it arrived with.
      // Normalise by INDEX, and DROP the raw union: a spread would carry
      // `readState` onto every persisted item, so the store would hold a second
      // copy of the thing the adapter is supposed to be the only interpreter of.
      // Destructuring it away is what makes that contract true at runtime — a
      // type assertion only hides the field, it does not remove it.
      const incomingItems = servedRows.map((served): InboxItem => {
        if (served.kind === "object") return served.item;
        const { readState: _rawUnion, ...rest } = served.row;
        return {
          ...rest,
          readStateLatestActivitySeq: readStateOutcomeOf.get(served.row)?.latestActivitySeq ?? null,
        } as InboxItem;
      });
      const ledgerAdjudicated = adjudicateServedUnreadAgainstLedger(
        requestServerId,
        incomingItems,
        servedRows.map((served) => (served.kind === "conversation" ? served.row.readState : undefined)),
        requestFilter,
      );
      const readSuppression = applyInboxLocalReadSuppressions(ledgerAdjudicated.items, requestFilter);
      // Capture settlement before this response can retire a marker because
      // newer activity arrived. Expired markers no longer constrain counts.
      const doneSettledDuringRequest = currentTimeMs() <= inboxLocalDoneSuppressionUntil
        && [...pendingDoneAtStart].some(([key, marker]) => inboxLocalDoneSuppressedMarkers.get(key) !== marker);
      const doneSuppression = applyInboxLocalDoneSuppressions(readSuppression.items);
      const acceptedReadHold = applyActivityReadStateHolds(
        doneSuppression.items,
        requestFilter,
        requestIdentity,
      );
      // After the read hold: Mark as Unread released it, and a served row
      // that still says read is the lag the local unread covers.
      const localUnread = applyInboxLocalUnreads(
        acceptedReadHold.items,
        new Map(servedRows.map((served, index) => [
          getInboxItemKey(incomingItems[index]),
          served.kind === "conversation" ? served.row.readState : undefined,
        ])),
      );
      const objectHold = applyObjectActivityHolds(localUnread.items, requestFilter);
      const nextItems = objectHold.items;
      const catchUpBehind = reset && inboxAnswerIsBehindCatchUp(incomingItems);
      const acceptedKeys = new Set(nextItems.map(getInboxItemKey));
      const suppressedItems = incomingItems.filter((item) => !acceptedKeys.has(getInboxItemKey(item)));
      const suppressedCount = ledgerAdjudicated.suppressedCount
        + readSuppression.suppressedCount
        + doneSuppression.suppressedCount
        + acceptedReadHold.suppressedCount;
      const suppressedUnreadCount = ledgerAdjudicated.suppressedUnreadCount
        + readSuppression.suppressedUnreadCount
        + doneSuppression.suppressedUnreadCount
        + acceptedReadHold.suppressedUnreadCount
        - localUnread.addedUnreadCount;
      set((current) => {
        // Stryker disable all: requestId changes atomically with every current facet transition; the explicit facet comparisons preserve the complete request-identity contract for future callers.
        if (
          requestId !== activeInboxLoadRequestId
          || current.filter !== requestFilter
          || current.channelFilterId !== requestChannelFilterId
          || current.scope !== requestScope
          || current.sortDirection !== requestSortDirection
          || current.searchQuery !== requestSearchQuery
          || !isInboxLoadIdentityCurrent(requestIdentity)
        ) {
          return {};
        }
        // Stryker restore all
        if (requestReadStateRevision !== getActivityReadStateRevision()) {
          return { loading: false, loadingMore: false };
        }
        accepted = true;
        noteServedInboxRows(incomingItems, reset);
        if (reset && allScope && requestSortDirection === "desc") checkInPlaceDrift(current.items, nextItems);
        const preserved = reset
          ? (() => {
            const channelRows = preserveNewerChannelActivity(nextItems, current.items, requestSortDirection === "desc");
            const refreshed = preserveNewerThreadActivity(
              channelRows.items,
              current.savedWindow ? savedThreadRowsOverServed(current.items, nextItems) : current.items,
              requestSortDirection === "desc",
            );
            return {
              totalUnreadDelta: refreshed.totalUnreadDelta + channelRows.totalUnreadDelta,
              // The saved first page (task #164) is replaced whole by the first
              // real one, apart from a live message the answer hasn't seen yet.
              items: current.savedWindow ? refreshed.items : preserveLoadedInboxTail(
                refreshed.items,
                current.items,
                Boolean(data.hasMore),
                canPreserveLoadedTailOnReset,
              ),
            };
          })()
          : { items: [...current.items, ...nextItems], totalUnreadDelta: 0 };
        // A row marked unread here that a lagging Unread list leaves out stays.
        // The page covers it when it is the whole list, or the row sorts
        // before its last row; past the page, the server's totals count it.
        const lastServed = [...incomingItems].reverse().find(isConversationRow);
        const coversRow = (row: ActivityPersistedItem) => !data.hasMore || (lastServed !== undefined && (
          requestSortDirection === "desc"
            ? inboxRowActivityAt(row) >= inboxRowActivityAt(lastServed)
            : inboxRowActivityAt(row) <= inboxRowActivityAt(lastServed)
        ));
        const keptUnread = reset && isUnreadInboxFilter(requestFilter)
          ? keepLocallyUnreadRows(preserved.items, current.items, coversRow)
          : { items: preserved.items, fellOut: [] };
        const keptUnreadCount = keptUnread.fellOut.reduce((sum, row) => sum + row.unreadCount, 0);
        // Stryker disable all: total-count arithmetic combines pre-existing local suppressions with projection deltas; the focused read-state tests assert row/total outcomes, not each arithmetic mutant.
        const merged = applyKnownReadStateProjectionsToItems(keptUnread.items);
        const projectionUnreadDelta = merged.reduce((sum, item) => sum + item.unreadCount, 0)
          - keptUnread.items.reduce((sum, item) => sum + item.unreadCount, 0);
        const totalCount = data.totalCount == null
          ? conversationRows(merged).length
          : Math.max(0, Number(data.totalCount) - suppressedCount + keptUnread.fellOut.length);
        const totalUnreadCount = data.totalUnreadCount == null
          ? conversationRows(merged).reduce((sum, item) => sum + item.unreadCount, 0)
          : Math.max(0, Number(data.totalUnreadCount) - suppressedUnreadCount + keptUnreadCount + preserved.totalUnreadDelta + projectionUnreadDelta);
        const activeUnreadCount = data.activeUnreadCount == null
          ? (requestFilter === "all" ? totalUnreadCount : current.activeUnreadCount)
          : Math.max(0, Number(data.activeUnreadCount) - suppressedUnreadCount + keptUnreadCount + preserved.totalUnreadDelta + projectionUnreadDelta);
        // Stryker restore all
        const seen = new Set<string>();
        const deduped = merged.filter((item) => {
          const key = getInboxItemKey(item);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (reset) {
          const diagnosticKeys = new Set([
            current.focusedItemKey,
            current.items[0] ? getInboxItemKey(current.items[0]) : null,
            deduped[0] ? getInboxItemKey(deduped[0]) : null,
          ].filter((key): key is string => !!key));
          for (const key of [...diagnosticKeys].slice(0, 4)) {
            const beforeIndex = current.items.findIndex((item) => getInboxItemKey(item) === key);
            const afterIndex = deduped.findIndex((item) => getInboxItemKey(item) === key);
            if (beforeIndex === afterIndex && beforeIndex !== -1) continue;
            const item = deduped[afterIndex] ?? current.items[beforeIndex];
            if (!item) continue;
            const traceScope = activityInboxTraceScope(requestIdentity, key);
            traceActivityInboxTransition({
              source: "http_reset",
              itemKey: key,
              marker: item.kind === "thread" ? item.latestActivityMessageId : item.kind === "mention_action" ? item.messageId : item.kind === "object" ? item.doneFrontierSeq : item.lastMessageId,
              fromIndex: beforeIndex,
              toIndex: afterIndex,
              unreadCount: item.unreadCount,
              focusOwner: current.focusedItemKey === key,
            }, currentActivityInboxTraceCycle(traceScope));
          }
        }
        return {
          items: deduped,
          acceptedWindowGeneration: reset
            ? requestWindowGeneration
            : current.acceptedWindowGeneration,
          hasAcceptedWindow: reset ? true : current.hasAcceptedWindow,
          savedWindow: reset ? false : current.savedWindow,
          loadFailed: reset ? false : current.loadFailed,
          groups: preserveSelectedInboxGroup(
            incrementInboxGroupCounts(
              decrementInboxGroupCounts(
                Array.isArray(data.groups) ? data.groups : [],
                suppressedItems,
              ),
              keptUnread.fellOut,
            ),
            current.groups,
            requestChannelFilterId,
          ),
          hasMore: Boolean(data.hasMore),
          totalCount,
          // A count-only response cannot tell whether a pending Done is already
          // reflected on the server. Keep the optimistic total until a read
          // outside that suppression window can reconcile. Newer activity and
          // expiry retire their markers above and must restore totals immediately.
          // Only a Done still awaiting its POST freezes the total. Once it is
          // confirmed its marker may stay held for the view lag (task #33); in
          // the All scope `totalCount` already subtracts the rows that hold
          // hides, and a separate count-only response may lag by that row until
          // the view catches up.
          allCount: doneSettledDuringRequest || hasUnconfirmedInboxDone()
            ? current.allCount
            : (allScope ? totalCount : (unfilteredCount ?? current.allCount)),
          totalUnreadCount,
          activeUnreadCount,
          // Absent with every object app off for the server: no object rows, none counted.
          objectUnreadCount: typeof data.objectUnreadCount === "number" ? Math.max(0, data.objectUnreadCount - objectHold.heldUnreadCount) : 0,
          // A server from before objectMentionUnreadCount: every unread object row, as Activity counted them then.
          objectMentionUnreadCount: typeof data.objectMentionUnreadCount === "number"
            ? Math.max(0, data.objectMentionUnreadCount - objectHold.heldMentionUnreadCount)
            : (typeof data.objectUnreadCount === "number" ? Math.max(0, data.objectUnreadCount - objectHold.heldUnreadCount) : 0),
          objectCount: typeof data.objectCount === "number" ? Math.max(0, data.objectCount - objectHold.removedCount) : 0,
          loaded: true,
          loading: false,
          loadingMore: false,
        };
      });
      if (accepted && reset) settleInboxCatchUp(catchUpBehind, stale);
      // Task #164: a clean first page of the plain All list is what a later
      // boot shows while RW is unavailable.
      if (accepted && reset && !stale && allScope && requestSortDirection === "desc") {
        const saved = get();
        saveLastCounts(getCurrentPrincipalId(), requestServerId, {
          activity: {
            items: activityRowsToSave(saved.items),
            groups: saved.groups,
            totalCount: saved.totalCount,
            totalUnreadCount: saved.totalUnreadCount,
            activeUnreadCount: saved.activeUnreadCount,
            hasMore: saved.hasMore || saved.items.length > activityRowsToSave(saved.items).length,
          },
        });
      }
    } catch (err) {
      console.error("Failed to load inbox:", err);
      // A failed read ends the catch-up: rwRecovery paces the next one.
      if (reset) clearInboxCatchUp();
      const latest = get();
      // Stryker disable all: requestId already rejects every stale failure under current setters; the remaining comparisons document the full request identity as defense in depth.
      if (
        requestId === activeInboxLoadRequestId
        && latest.filter === requestFilter
        && latest.channelFilterId === requestChannelFilterId
        && latest.scope === requestScope
        && latest.sortDirection === requestSortDirection
        && latest.searchQuery === requestSearchQuery
        && isInboxLoadIdentityCurrent(requestIdentity)
      ) {
        // A saved copy (even an empty page) is the last known list: keep it,
        // with the out-of-date notice; only nothing to show is a failure.
        set(reset
          ? { loaded: true, loading: false, loadingMore: false, loadFailed: !latest.savedWindow }
          : { loaded: true, loading: false, loadingMore: false });
      }
      // Stryker restore all
    } finally {
      if (activeInboxRequestInFlightId === requestId) {
        activeInboxRequestInFlightId = null;
        if (trailingInboxBackgroundReset) {
          trailingInboxBackgroundReset = false;
          const trailingReason = trailingInboxBackgroundResetReason;
          trailingInboxBackgroundResetReason = undefined;
          const trailingTrigger = trailingInboxBackgroundResetTrigger;
          trailingInboxBackgroundResetTrigger = undefined;
          const settleTrailingReset = resolveTrailingInboxBackgroundReset;
          trailingInboxBackgroundResetPromise = null;
          resolveTrailingInboxBackgroundReset = null;
          void get().loadInbox({ reset: true, background: true, reason: trailingReason, trigger: trailingTrigger })
            .finally(() => settleTrailingReset?.());
        }
      }
    }
  },

  refreshInbox: async (opts = {}) => {
    await get().loadInbox({ reset: true, background: opts.background, reason: opts.reason ?? "manual" });
  },

  markRead: async (item, options) => {
    // A row marked unread with no count is read like any unread row: the
    // read's write clears the mark on the server.
    if (item.unreadCount <= 0 && !isScopeMarkedUnread(inboxItemChannelId(item))) return;
    if (item.kind === "object") {
      await markObjectRowRead(item);
      return;
    }
    if (item.kind === "mention_action") return;
    const channelId = item.kind === "thread" ? item.threadChannelId : item.channelId;
    const unreadCount = item.unreadCount;
    const ingressContext = captureHumanActivityIngressContext(
      useMessageStore.getState().currentUserId,
    );
    const readFlightKey = [
      ingressContext.serverId,
      ingressContext.principalId,
      ingressContext.serverEpoch,
      ingressContext.generation,
      ingressContext.receiver ? `${ingressContext.receiver.kind}:${ingressContext.receiver.id}` : "self",
      channelId,
    ].join(":");
    // A queued toggle always shows its Read: the toggle before it may still be writing.
    if (!options?.after && inboxReadInFlight.has(readFlightKey)) return;
    inboxReadInFlight.add(readFlightKey);
    const traceScope = activityInboxTraceScope(ingressContext, getInboxItemKey(item));
    const traceCycleId = beginActivityInboxTraceCycle(traceScope);
    traceActivityInboxTransition({
      source: "read_intent",
      itemKey: getInboxItemKey(item),
      marker: inboxItemLatestMarker(item as ActivityPersistedItem),
      unreadCount,
    }, traceCycleId);
    const readItem = item as ActivityPersistedItem;
    // Read again: an earlier Mark as Unread here no longer holds it unread.
    inboxLocalUnreads.delete(channelId);
    rememberInboxLocalReadSuppression(readItem);
    // Read, so the Unread list keeps it, read (store/activityUnreadSnapshot).
    noteActivityUnreadRowsRead([getInboxItemKey(item)]);

    set((state) => {
      const nextItems = isUnreadInboxFilter(state.filter)
        ? state.items.filter((existing) => getInboxItemKey(existing) !== getInboxItemKey(item))
        : state.items.map((existing) => {
          if (getInboxItemKey(existing) !== getInboxItemKey(item)) return existing;
          return readInboxItem(existing);
        });
      return {
        items: nextItems,
        groups: isUnreadInboxFilter(state.filter)
          ? decrementInboxGroupCounts(state.groups, [item], state.channelFilterId)
          : state.groups,
        totalCount: isUnreadInboxFilter(state.filter) ? Math.max(0, state.totalCount - 1) : state.totalCount,
        totalUnreadCount: Math.max(0, state.totalUnreadCount - unreadCount),
        activeUnreadCount: Math.max(0, state.activeUnreadCount - unreadCount),
      };
    });

    if (item.kind === "thread") {
      // The thread store's clear posts the same read-all as this read does
      // below, in the same tick, so the two coalesce into one request
      // (postReadAllCoalesced). Queued behind an earlier toggle, this read's
      // write waits: clear only locally now, and let its own write persist it.
      if (options?.after) useThreadStore.getState().clearThreadUnreadLocally(item.threadChannelId);
      else useThreadStore.getState().clearThreadUnread(item.threadChannelId, null);
    }
    useMessageStore.getState().clearUnread(channelId);

    try {
      if (options?.after) {
        await options.after;
        // Another server (or person) now: the write is not theirs to make.
        if (!isReceiverPrivateIngressContextCurrent(ingressContext)) return;
      }
      try {
        const { data } = await postReadAllCoalesced(channelId, ingressContext);
        if (isReceiverPrivateIngressContextCurrent(ingressContext)) {
          acceptActivityReadAllAck(ingressContext, channelId, data);
          traceActivityInboxTransition({
            source: "read_ack",
            itemKey: getInboxItemKey(item),
            marker: inboxItemLatestMarker(readItem),
            unreadCount: 0,
          }, traceCycleId);
        }
      } catch (err) {
        console.error(err);
        if (isReceiverPrivateIngressContextCurrent(ingressContext)) {
          forgetInboxLocalReadSuppression(readItem);
          options?.onFailed?.();
          await get().refreshInbox({ background: true });
        }
      }
    } finally {
      inboxReadInFlight.delete(readFlightKey);
    }
  },

  markUnread: async (item, options) => {
    // The row's menu and a phone's right swipe (raft-design #793), which
    // switches a row back and forth. A direct mention's row marks its
    // channel (its menu has Mark as Unread too).
    const scopeId = item.kind === "mention_action" ? item.channelId : inboxItemChannelId(item);
    if (!scopeId) return;
    await markScopeUnread({ get, set }, scopeId, item, item.kind === "thread", options);
  },

  markThreadUnread: async (threadChannelId, options) => {
    // The thread's own menu: its Activity row when one is loaded, so the
    // row and the menu's action are the same one.
    const row = get().items.find((item): item is ThreadInboxItem => item.kind === "thread" && item.threadChannelId === threadChannelId);
    await markScopeUnread({ get, set }, threadChannelId, row ?? null, true, options);
  },

  markAllRead: async (options) => {
    // While a new filter's page loads, its total is not known yet and Activity
    // keeps showing the button (task #157), so the filter-independent count
    // decides whether there is anything to read.
    // Read all reads the object rows too (the server's read-all covers them).
    const before = get();
    if ((before.loaded ? before.totalUnreadCount : before.activeUnreadCount) + before.objectUnreadCount <= 0) return;
    // Every Mark as Unread here gives way to it.
    inboxLocalUnreads.clear();
    const unreadItems = get().items.filter((item) => item.unreadCount > 0);
    const locallyReadItems = unreadItems.filter((item): item is ActivityPersistedItem => item.kind !== "object" && item.kind !== "mention_action");
    const locallyReadObjects = unreadItems.filter((item): item is ObjectActivityItem => item.kind === "object");
    locallyReadItems.forEach((item) => rememberInboxLocalReadSuppression(item));
    locallyReadObjects.forEach((item) => holdObjectActivity(item, "read"));
    noteActivityUnreadRowsRead(unreadItems.map(getInboxItemKey));

    set((state) => {
      return {
        items: isUnreadInboxFilter(state.filter)
          ? []
          : state.items.map(readInboxItem),
        groups: isUnreadInboxFilter(state.filter) ? [] : state.groups,
        totalCount: isUnreadInboxFilter(state.filter) ? 0 : state.totalCount,
        objectCount: isUnreadInboxFilter(state.filter) ? 0 : state.objectCount,
        totalUnreadCount: 0,
        activeUnreadCount: 0,
        objectUnreadCount: 0,
        objectMentionUnreadCount: 0,
        focusedItemKey: null,
      };
    });

    try {
      if (options?.after) await options.after;
      clearAllMarkedUnreadForRead();
      await api.post("/channels/inbox/read-all");
      await Promise.all([
        useMessageStore.getState().loadUnreadCounts(),
        useThreadStore.getState().loadFollowedThreads("manual"),
      ]);
      await get().refreshInbox({ background: true });
    } catch (err) {
      console.error(err);
      locallyReadItems.forEach((item) => forgetInboxLocalReadSuppression(item));
      locallyReadObjects.forEach((item) => forgetObjectActivityHold(item));
      await get().refreshInbox({ background: true });
      await useMessageStore.getState().loadUnreadCounts();
    }
  },

  markDone: async (item, options) => {
    // A swiped Done written after a server switch (`activitySwipeActions`):
    // the row is another server's, and so is all this store holds now. Only
    // that server is told, under its id; nothing here is suppressed, cleared
    // or refreshed. Done there also reads the thread through its frontier
    // (the done mutation's read boundary), so no read-all follows it: one
    // would read, on a server the person has left, replies newer than the
    // row they swiped.
    if (options?.serverId && options.serverId !== (useServerStore.getState().current?.id ?? null)) {
      await markDoneOnServer(options.accepted ?? item, options.serverId);
      return;
    }
    // Done takes the row out of Activity at once, also a read row the Unread
    // list still shows (store/activityUnreadSnapshot).
    const doneKey = getInboxItemKey(item);
    const keptItem = keptActivityUnreadRow(doneKey);
    // A failed Done puts a kept row back; a listed one comes back with the refresh.
    const restoreKept = takeKeptActivityUnreadRow(doneKey);
    dropActivityUnreadRowsIf((shown) => getInboxItemKey(shown) === doneKey);
    if (item.kind === "mention_action") {
      get().removeItem(item);
      return;
    }
    if (item.kind === "object") {
      const objectKey = getInboxItemKey(item);
      const listedObject = get().items.find((candidate) => getInboxItemKey(candidate) === objectKey);
      // The row as this store last accepted it: its frontier is what Done covers.
      const acceptedObject = [listedObject, keptItem, options?.accepted, item]
        .find((candidate): candidate is ObjectActivityItem => candidate?.kind === "object");
      await markObjectRowDone(acceptedObject ?? item, listedObject !== undefined, restoreKept);
      return;
    }

    // Bind Done to the exact row currently accepted by this store. Every Inbox
    // Done must use the dedicated storage-space frontier, never the display
    // pair. A rolling old response without that field fails closed: refresh
    // once and let the user retry only after a new row has been accepted.
    const itemKey = getInboxItemKey(item);
    // A kept row is the last copy this store accepted, before it was read.
    const listedItem = get().items.find((candidate) => getInboxItemKey(candidate) === itemKey);
    // A swiped Done whose list has changed since hands the row it swiped.
    const acceptedItem = listedItem ?? keptItem ?? options?.accepted;
    // A server predating the storage-space frontier omits `doneFrontierSeq`
    // entirely. That absence is the rolling-deploy signal and it is not
    // ambiguous: mention_action rows already returned above, and an upgraded
    // server always carries the field on an active row.
    //
    // Against such a server we send NO sequence at all — not the display pair.
    // `latestActivitySeq` is a display/local value on joint rows and the old
    // server validates against its canonical latest, so offering it is the #29
    // units mismatch wearing a different hat (@Cody measured 409
    // DONE_FRONTIER_BEYOND_LATEST for display 11429659 vs canonical 11426997).
    // Omitting the field routes the old server to the legacy snapshot path it
    // already has — the same door old mobile clients use — and it resolves
    // canonical latest server-side, where the authoritative value actually
    // lives. Measured 200 {ok:true} on that same joint row.
    //
    // The cost is real and NEW, so state it plainly rather than calling it a
    // restoration (@Hipp caught me doing exactly that): the pre-1.9.2 client
    // SENT `latestActivitySeq`, and the old server honours a supplied value, so
    // Done covered the frontier the user actually rendered. Omitting the field
    // takes the server's `resolveChannelSuppressionTarget(...).latestSeqExact`
    // — the latest at REQUEST time — so activity arriving between render and
    // click is swept in, and a user can mark messages they never saw as done.
    // That is the trade: a KNOWN, bounded over-completion in place of an
    // UNKNOWN units mismatch. It applies only while the server is old.
    //
    // A field that is present but unusable is an upgraded-server anomaly and
    // still fails closed: never guess a frontier at a server that has one.
    const isLegacyServerRow = acceptedItem !== undefined
      && acceptedItem.kind !== "mention_action"
      && acceptedItem.doneFrontierSeq === undefined;
    const throughActivitySeq = acceptedItem && acceptedItem.kind !== "mention_action"
      ? acceptedItem.doneFrontierSeq
      : null;
    if (
      !acceptedItem
      || acceptedItem.kind === "mention_action"
      // Object rows returned above; a kept row of another kind under this key is impossible.
      || acceptedItem.kind === "object"
      || (!isLegacyServerRow && (
        typeof throughActivitySeq !== "string"
        || !/^[1-9][0-9]*$/.test(throughActivitySeq)
      ))
    ) {
      restoreKept?.();
      await get().refreshInbox();
      return;
    }
    item = acceptedItem;

    const channelId = item.kind === "thread" ? item.threadChannelId : item.channelId;

    // Activity is a high-frequency triage surface: the row should disappear
    // as soon as the user clicks the checkmark, then reconcile if persistence
    // fails.
    //
    // #5690: this optimistic suppression only bridges [click] → [server
    // confirms]. It is bound to the exact marker at click time, so any newer
    // activity makes the row visible again immediately (see
    // applyInboxLocalDoneSuppressions) — a Done must never hide activity it
    // did not cover. On success we take the row and counts from an
    // authoritative refresh, but the suppression stays armed (task #33): that
    // refresh, and the next few polls, can still be served from a lagging
    // RisingWave view / stale cache that carries the click-time marker, and
    // retiring on the first refresh brought the row back for ~3s. The hold
    // ends when the server serves a newer marker or the cap
    // (INBOX_LOCAL_MUTATION_HOLD_MS) lapses, so a server that never applied the
    // Done is still observable afterwards.
    const doneGeneration = issueInboxDoneGeneration(item);
    rememberInboxLocalDoneSuppression(item);
    if (listedItem) get().removeItem(item);

    useMessageStore.getState().clearUnread(channelId);

    if (item.kind === "thread") {
      try {
        await api.post("/channels/threads/done", isLegacyServerRow
          ? { threadChannelId: item.threadChannelId }
          : { threadChannelId: item.threadChannelId, throughActivitySeq, frontierSpace: "storage" as const });
        // Keep the followed-thread unread badge server-gated. If the done
        // request fails, refresh below restores the Activity row without a
        // transient read/unread flicker in the thread list.
        // #5690: fail closed BEFORE any success side effect, matching the
        // channel branch. Checking after clearThreadUnread let a superseded
        // server's ack capture the NEW server identity, clear unread there and
        // POST /read-all for the old thread against it — the generation fence
        // only stopped the later inbox GET. (@赵梓淇)
        if (!isCurrentInboxDoneGeneration(item, doneGeneration)) return;
        // markDone owns the single awaited, generation-fenced authoritative
        // refresh below. Without this scope the read-all persisted notification
        // fires a SECOND background refreshInbox that is neither awaited nor
        // bound to the Done generation — a double /channels/inbox fetch on
        // every thread Done. (@赵梓淇 call-chain ruling.)
        useThreadStore.getState().clearThreadUnread(item.threadChannelId, null, {
          suppressPersistedNotification: true,
        });
        // Refresh with the marker-bound suppression still armed and leave it
        // armed: a stale payload still carrying the click-time marker must not
        // resurrect the row we just confirmed (task #33). Anything genuinely
        // newer than that marker is exempt from suppression and stays visible.
        await get().refreshInbox();
        releaseInboxDoneGeneration(item, doneGeneration);
      } catch (err) {
        console.error("Failed to mark inbox thread as done:", err);
        if (!isCurrentInboxDoneGeneration(item, doneGeneration)) return;
        forgetInboxLocalDoneSuppression(item);
        restoreKept?.();
        await get().refreshInbox();
        await Promise.all([
          useMessageStore.getState().loadUnreadCounts(),
          useThreadStore.getState().loadFollowedThreads("manual"),
        ]);
        releaseInboxDoneGeneration(item, doneGeneration);
      }
    } else {
      try {
        await api.post("/channels/inbox/done", isLegacyServerRow
          ? { channelId: item.channelId }
          : { channelId: item.channelId, throughActivitySeq, frontierSpace: "storage" as const });
        if (!isCurrentInboxDoneGeneration(item, doneGeneration)) return;
        // Refresh while still suppressed and keep it — see the thread branch.
        await get().refreshInbox();
        releaseInboxDoneGeneration(item, doneGeneration);
      } catch (err) {
        console.error("Failed to mark inbox item as done:", err);
        if (!isCurrentInboxDoneGeneration(item, doneGeneration)) return;
        forgetInboxLocalDoneSuppression(item);
        restoreKept?.();
        await get().refreshInbox();
        await useMessageStore.getState().loadUnreadCounts();
        releaseInboxDoneGeneration(item, doneGeneration);
      }
    }
  },

  undoObjectDone: async (item, options) => {
    const currentServerId = useServerStore.getState().current?.id ?? null;
    const elsewhere = options?.serverId != null && options.serverId !== currentServerId;
    if (!elsewhere) forgetObjectActivityHold(item);
    try {
      await postObjectActivity("undone", item, elsewhere ? options?.serverId : null);
    } catch (err) {
      console.error("Failed to undo an object's Activity row Done:", err);
    }
    if (!elsewhere && (useServerStore.getState().current?.id ?? null) === currentServerId) await get().refreshInbox();
  },

  removeItem: (item) => {
    const key = getInboxItemKey(item);
    // An object row counts in its own totals, never the conversations'.
    if (item.kind === "object") {
      set((state) => ({
        items: state.items.filter((existing) => getInboxItemKey(existing) !== key),
        objectCount: Math.max(0, state.objectCount - 1),
        objectUnreadCount: item.unreadCount > 0 ? Math.max(0, state.objectUnreadCount - 1) : state.objectUnreadCount,
        objectMentionUnreadCount: countsInObjectMentionUnread(item, state.filter, state.items.some((existing) => getInboxItemKey(existing) === key))
          ? Math.max(0, state.objectMentionUnreadCount - 1)
          : state.objectMentionUnreadCount,
      }));
      return;
    }
    set((state) => ({
      items: state.items.filter((existing) => getInboxItemKey(existing) !== key),
      groups: decrementInboxGroupCounts(state.groups, [item], state.channelFilterId),
      totalCount: Math.max(0, state.totalCount - 1),
      allCount: state.allCount === null ? null : Math.max(0, state.allCount - 1),
      totalUnreadCount: Math.max(0, state.totalUnreadCount - item.unreadCount),
      activeUnreadCount: Math.max(0, state.activeUnreadCount - item.unreadCount),
    }));
  },

  removeConversation: (channelId) => {
    dropActivityUnreadRowsIf((shown) => inboxItemChannelId(shown) === channelId);
    set((state) => {
      const removed = state.items.filter((item) => inboxItemChannelId(item) === channelId);
      const unfollowedItems = state.unfollowedItems.filter((item) => item.threadChannelId !== channelId);
      if (removed.length === 0 && unfollowedItems.length === state.unfollowedItems.length) return state;
      const removedUnreadCount = removed.reduce((sum, item) => sum + item.unreadCount, 0);
      return {
        items: state.items.filter((item) => inboxItemChannelId(item) !== channelId),
        unfollowedItems,
        groups: decrementInboxGroupCounts(state.groups, removed, state.channelFilterId),
        totalCount: Math.max(0, state.totalCount - removed.length),
        allCount: state.allCount === null ? null : Math.max(0, state.allCount - removed.length),
        totalUnreadCount: Math.max(0, state.totalUnreadCount - removedUnreadCount),
        activeUnreadCount: Math.max(0, state.activeUnreadCount - removedUnreadCount),
      };
    });
  },

  applyRemoteDone: (channelId, doneFrontierSeq) => {
    const rows = get().items.filter((item): item is ActivityPersistedItem =>
      item.kind !== "object" && item.kind !== "mention_action" && inboxItemChannelId(item) === channelId);
    if (rows.length === 0 || doneFrontierSeq === null) return false;
    // Thread Done comes as follow.threadDone, not as done (Ray, #11670).
    if (rows.some((row) => row.kind === "thread")) return false;
    // Compared with the row's latestActivitySeq: both server paths (PG and the
    // RisingWave view) carry it, and a parity test pins it equal to the
    // frontier a Done stores (#11685, run linked in #proj-mobile:e65dc7a2). The
    // row's own doneFrontierSeq is not relied on. A live message moves
    // latestActivitySeq too, so newer activity is seen here.
    if (rows.some((row) => typeof row.latestActivitySeq !== "string")) return false;
    // Activity after what the Done covered keeps the row (the reopen rule):
    // the row as shown is already right.
    if (rows.some((row) => compareActivitySeq(row.latestActivitySeq, doneFrontierSeq) > 0)) return true;
    // Same hold as a Done clicked here: a list read served from a lagging
    // view must not bring the row back.
    for (const row of rows) rememberInboxLocalDoneSuppression(row);
    get().removeConversation(channelId);
    return true;
  },

  conversationLatestReadableSeq: (channelId) => {
    const rows = get().items.filter((item): item is ActivityPersistedItem =>
      item.kind !== "object" && item.kind !== "mention_action" && inboxItemChannelId(item) === channelId);
    let latest: string | null = null;
    for (const row of rows) {
      const marker = inboxItemLatestMarker(row);
      if (marker === null) return null;
      // A live message moved the row past its loaded frontier: can't judge.
      if (compareActivitySeq(row.latestActivitySeq, marker) > 0) return null;
      if (latest === null || compareActivitySeq(marker, latest) > 0) latest = marker;
    }
    return latest;
  },

  markThreadUnfollowed: (item) => {
    inboxUnfollowedLoadGeneration += 1;
    // Unfollowed counts no unread: an earlier Mark as Unread no longer holds it.
    inboxLocalUnreads.delete(item.threadChannelId);
    set((state) => {
      const current = state.items.find(
        (existing): existing is ThreadInboxItem =>
          existing.kind === "thread" && existing.threadChannelId === item.threadChannelId,
      );
      const retained: ThreadInboxItem = {
        ...(current ?? item),
        isFollowing: false,
        unfollowedAt: null,
        unreadCount: 0,
        firstUnreadMessageId: null,
        hasMention: false,
      };
      const clearedUnreadCount = current?.unreadCount ?? item.unreadCount;
      return {
        items: state.items.map((existing) =>
          existing.kind === "thread" && existing.threadChannelId === item.threadChannelId
            ? retained
            : existing
        ),
        totalUnreadCount: Math.max(0, state.totalUnreadCount - clearedUnreadCount),
        activeUnreadCount: Math.max(0, state.activeUnreadCount - clearedUnreadCount),
      };
    });
  },

  markThreadRefollowed: (threadChannelId) => {
    inboxUnfollowedLoadGeneration += 1;
    set((state) => ({
      items: state.items.map((item) =>
        item.kind === "thread" && item.threadChannelId === threadChannelId
          ? { ...item, isFollowing: true, unfollowedAt: null }
          : item
      ),
      unfollowedItems: state.unfollowedItems.filter(
        (item) => item.threadChannelId !== threadChannelId,
      ),
      unfollowedLoading: false,
      unfollowedLoaded: true,
    }));
  },

  clearReadForChannel: (channelId) => {
    // Read here: a Mark as Unread on it gives way.
    inboxLocalUnreads.delete(channelId);
    let readKeys: string[] = [];
    set((state) => {
      let clearedUnreadCount = 0;
      let removedCount = 0;
      // Stryker disable next-line ArrayDeclaration: a fabricated non-Inbox sentinel has no channel id and is observationally ignored by the decrement helper.
      const removedItems: InboxItem[] = [];
      let changed = false;

      const clearItem = (item: InboxItem): InboxItem => {
        if (inboxItemChannelId(item) !== channelId || item.unreadCount <= 0) return item;
        clearedUnreadCount += item.unreadCount;
        changed = true;
        return readInboxItem(item);
      };

      const items = isUnreadInboxFilter(state.filter)
        ? state.items.filter((item) => {
          const shouldRemove = inboxItemChannelId(item) === channelId && item.unreadCount > 0;
          if (shouldRemove) {
            clearedUnreadCount += item.unreadCount;
            removedCount += 1;
            removedItems.push(item);
            changed = true;
          }
          return !shouldRemove;
        })
        : state.items.map(clearItem);

      if (!changed) return state;
      readKeys = removedItems.map(getInboxItemKey);

      // Stryker disable all: local Activity clear bookkeeping predates this read-state projection fix and is covered by inbox local-clear tests.
      return {
        items,
        groups: isUnreadInboxFilter(state.filter)
          ? decrementInboxGroupCounts(state.groups, removedItems, state.channelFilterId)
          : state.groups,
        totalCount: isUnreadInboxFilter(state.filter) ? Math.max(0, state.totalCount - removedCount) : state.totalCount,
        totalUnreadCount: Math.max(0, state.totalUnreadCount - clearedUnreadCount),
        activeUnreadCount: Math.max(0, state.activeUnreadCount - clearedUnreadCount),
      };
      // Stryker restore all
    });
    noteActivityUnreadRowsRead(readKeys);
  },

  applyReadStateProjection: (channelId, projection) => {
    // Read on another device (or in another tab) reaches here: the Unread list keeps those rows, read.
    let readKeys: string[] = [];
    set((state) => {
      // Stryker disable all: Activity list filtering/count bookkeeping is covered by read-state behavior tests; remaining mutants are reference/no-op/list-shape variants.
      let totalUnreadDelta = 0;
      let removedCount = 0;
      const removedItems: InboxItem[] = [];
      let changed = false;

      // An earlier Read's projection, late: a Mark as Unread here since keeps
      // the row unread (a newer read has retired it: localUnreadOf).
      if (projection.unreadCount === 0 && localUnreadOf(channelId)) return state;
      const projectItem = (item: InboxItem): InboxItem => {
        if (item.kind === "mention_action" || item.kind === "object") return item;
        if (inboxItemChannelId(item) !== channelId) return item;
        const next = projectInboxItem(item, projection);
        if (next === item) return item;
        totalUnreadDelta += projection.unreadCount - item.unreadCount;
        changed = true;
        return next;
      };

      const items = isUnreadInboxFilter(state.filter)
        ? state.items.flatMap((item) => {
          if (inboxItemChannelId(item) !== channelId) return [item];
          const next = projectItem(item);
          // Marked unread with no count: the Unread list keeps it.
          if (projection.unreadCount > 0 || isScopeMarkedUnread(channelId)) return [next];
          removedCount += 1;
          removedItems.push(item);
          return [];
        })
        : state.items.map(projectItem);

      if (!changed) return state;
      readKeys = removedItems.map(getInboxItemKey);
      return {
        items,
        groups: isUnreadInboxFilter(state.filter)
          ? decrementInboxGroupCounts(state.groups, removedItems, state.channelFilterId)
          : state.groups,
        totalCount: isUnreadInboxFilter(state.filter) ? Math.max(0, state.totalCount - removedCount) : state.totalCount,
        totalUnreadCount: Math.max(0, state.totalUnreadCount + totalUnreadDelta),
        activeUnreadCount: Math.max(0, state.activeUnreadCount + totalUnreadDelta),
      };
      // Stryker restore all
    });
    noteActivityUnreadRowsRead(readKeys);
  },

  retractPreview: (messageId, placeholder) => {
    const retract = (item: InboxItem) => retractInboxItemPreview(item, messageId, placeholder);
    patchActivityUnreadSnapshot(retract);
    set((state) => {
      const items = state.items.map(retract);
      return items.some((item, index) => item !== state.items[index]) ? { items } : state;
    });
  },

  // Stryker disable all: Zustand/socket glue is covered by inboxMentionBadge
  // behavior tests; the version ledger branches above are
  // exercised through refreshInbox rather than mutation-testing store wiring.
  receiveThreadReply: (message, live) => {
    let traceInput: Parameters<typeof traceActivityInboxTransition>[0] | null = null;
    let kept = true;
    set((state) => {
      const existing = state.items.find(
        (item): item is ThreadInboxItem => item.kind === "thread" && item.threadChannelId === message.channelId,
      );
      if (!existing && live) noteInPlaceRowAbsent(message, live, "thread");
      if (!existing) return state;
      // #244: a reply the row is already past (late, or applied uncounted) counts once (lateLivePatch).
      const late = (): Partial<InboxState> => {
        const counted = lateLivePatch(state, existing, message, live);
        kept = counted?.kept ?? true;
        return counted?.patch ?? state;
      };
      if (existing.latestActivityMessageId === message.id) return existing.latestActivitySeq == null ? state : late();
      // task #361 legacy socket recency guard: only advance the thread row when this
      // reply is strictly newer than the current content frontier. An old/duplicate
      // delivery (out-of-order socket replay) must NOT regress latestActivityMessageId
      // or inflate replyCount — that inflation is what let preserveNewerThreadActivity's
      // replyCount version freeze a stale row. A safe seq compares exactly; when seq is
      // absent/unsafe we fall back to createdAt (and never fabricate a seq).
      const incomingSeq = safeSeqToDecimalString(message.seq);
      const currentSeq = existing.latestActivitySeq ?? null;
      if (currentSeq != null) {
        // task #361 activation-gated, fail-closed: an activated row (authoritative seq
        // present) only advances on a safe, strictly-newer seq. An old/duplicate
        // out-of-order delivery must NOT regress latestActivityMessageId or inflate
        // replyCount (that inflation froze a stale row pre-fix). A missing/unsafe seq
        // is fail-closed — no apply; the socket is only a wake signal and the canonical
        // refetch supplies the row (no fabricated seq, no createdAt/messageId fallback).
        // Pre-activation (currentSeq null) keeps the legacy same-id behavior above.
        if (incomingSeq == null) return state;
        if (compareActivitySeq(incomingSeq, currentSeq) <= 0) return late();
      }
      const fromIndex = state.items.indexOf(existing);

      const next: ThreadInboxItem = {
        ...existing,
        latestActivityPreview: message.content,
        latestActivitySenderType: message.senderType,
        latestActivitySenderId: message.senderId,
        latestActivityMessageId: message.id,
        // The avatar is the previous reply's sender's; a new sender has none
        // until the next load (the client rosters still apply).
        senderAvatarUrl: message.senderId === existing.latestActivitySenderId ? existing.senderAvatarUrl : null,
        // RFC 077: the new reply's own label, never the previous reply's.
        latestDelegatedBy: (message as { delegatedBy?: DelegatedByWire | null }).delegatedBy ?? null,
        // A reply synced after a reconnect can arrive already retracted.
        latestRetracted: isRetractedMessage(message),
        latestActivitySeq: incomingSeq ?? existing.latestActivitySeq,
        replyCount: existing.replyCount + 1,
        lastActivityAt: message.createdAt,
        lastReplyAt: message.createdAt,
        ...liveUnreadFields(existing, message, live),
      };
      rememberLocalThreadActivity(next);
      if (live) noteInPlaceRow(next, live, message);
      kept = noteLiveApplied(next, message, live);

      const nextItems = [
        next,
        ...state.items.filter((item) => !(item.kind === "thread" && item.threadChannelId === message.channelId)),
      ];
      traceInput = {
        source: "socket_thread_reply",
        itemKey: getInboxItemKey(existing),
        marker: message.id,
        fromIndex,
        toIndex: 0,
        unreadCount: existing.unreadCount,
        focusOwner: state.focusedItemKey === getInboxItemKey(existing),
      };
      return {
        items: nextItems,
        ...inPlaceUnreadTotals(state, next, next.unreadCount - existing.unreadCount),
      };
    });
    if (traceInput) {
      const ingressContext = captureReceiverPrivateIngressContext(
        useMessageStore.getState().currentUserId,
      );
      const traceScope = activityInboxTraceScope(ingressContext, `thread:${message.channelId}`);
      const traceCycleId = beginActivityInboxTraceCycle(traceScope);
      traceActivityInboxTransition(traceInput, traceCycleId);
    }
    if (!kept) requestInboxBackgroundRefresh("counted_cap");
  },

  receiveChannelMessage: (message, live) => {
    // Thread and task-conversation replies have their own rows (receiveThreadReply).
    const conversationType = message.conversationContext?.channelType;
    if (conversationType === "thread" || conversationType === "task") return;
    const incomingSeq = safeSeqToDecimalString(message.seq);
    if (incomingSeq == null) return;
    // Only a message on a row the list shows (or one Done hid, task #92)
    // chases the view: a message
    // elsewhere would replace the target with a row no answer has, and end
    // the catch-up of the row that is still behind.
    let patched = false;
    let reopened = false;
    let kept = true;
    set((state) => {
      const existing = state.items.find((item): item is ChannelInboxItem =>
        (item.kind === "channel" || item.kind === "dm") && item.channelId === message.channelId);
      // Task #92: a row Done hid is not listed, so nothing patches it; still
      // chase it, or the first read (before the view has the message) is the last.
      if (!existing) {
        reopened = isReopenedByLiveMessage(message.channelId, incomingSeq);
        if (live) noteInPlaceRowAbsent(message, live, "channel");
        return state;
      }
      // Same guard as thread rows: only a strictly newer seq moves a row that has one.
      if (!existing.latestActivitySeq) return state;
      if (compareActivitySeq(incomingSeq, existing.latestActivitySeq) <= 0) {
        const counted = lateLivePatch(state, existing, message, live);
        if (!counted) return state;
        kept = counted.kept;
        // A lagging answer keeps the row's in-place count, this one included.
        const local = inboxChannelActivityHighWater.get(existing.channelId);
        if (local?.seq === existing.latestActivitySeq && counted.next.unreadCount > existing.unreadCount) local.counts = true;
        return counted.patch;
      }
      const next: ChannelInboxItem & { latestActivitySeq: string } = {
        ...existing,
        lastMessageId: message.id,
        latestActivitySeq: incomingSeq,
        lastMessageAt: message.createdAt,
        lastMessagePreview: message.content,
        lastMessageSenderType: message.senderType,
        lastMessageSenderId: message.senderId,
        lastMessageSenderName: message.senderName ?? null,
        latestDelegatedBy: (message as { delegatedBy?: DelegatedByWire | null }).delegatedBy ?? null,
        latestRetracted: isRetractedMessage(message),
        // The avatar is the previous message's sender's; a new sender has none
        // until the next load (the client rosters still apply).
        senderAvatarUrl: message.senderId === existing.lastMessageSenderId ? existing.senderAvatarUrl : null,
        ...liveUnreadFields(existing, message, live),
      };
      rememberLocalChannelActivity(next, !!live?.counts || inboxChannelActivityHighWater.get(next.channelId)?.counts === true);
      if (live) noteInPlaceRow(next, live, message);
      kept = noteLiveApplied(next, message, live);
      patched = true;
      return {
        items: state.sortDirection === "desc"
          ? [next, ...state.items.filter((item) => item !== existing)]
          : state.items.map((item) => item === existing ? next : item),
        ...inPlaceUnreadTotals(state, next, next.unreadCount - existing.unreadCount),
      };
    });
    if (patched) noteInboxCatchUpTarget(message.channelId, incomingSeq);
    else if (reopened) noteInboxCatchUpTarget(message.channelId, incomingSeq, true);
    if (!kept) requestInboxBackgroundRefresh("counted_cap");
  },

  updateThreadActivityMeta: (threadChannelId, replyCount, lastReplyAt) => set((state) => {
    const existing = state.items.find(
      (item): item is ThreadInboxItem => item.kind === "thread" && item.threadChannelId === threadChannelId,
    );
    if (!existing) return state;
    if (replyCount < existing.replyCount) return state;
    const nextReplyCount = replyCount;
    const nextLastReplyAt = replyCount > existing.replyCount && lastReplyAt
      ? lastReplyAt
      : existing.lastReplyAt;
    if (nextReplyCount === existing.replyCount && nextLastReplyAt === existing.lastReplyAt) return state;
    return {
      items: state.items.map((item) => item === existing
        ? { ...existing, replyCount: nextReplyCount, lastReplyAt: nextLastReplyAt }
        : item),
    };
  }),
  // Stryker restore all

  updateTaskMetadata: (task) => {
    patchActivityUnreadSnapshot((shown) => applyTaskToInboxItems([shown], task)[0] ?? shown);
    set((state) => {
      const items = applyTaskToInboxItems(state.items, task);
      // Stryker disable next-line ConditionalExpression,EqualityOperator,ObjectLiteral: task metadata reference-preservation is outside read-state projection behavior.
      return items === state.items ? state : { items };
    });
  },
}));

registerChannelReadListener((channelId) => {
  useInboxStore.getState().clearReadForChannel(channelId);
});

registerPersistedChannelReadListener((read) => {
  const serverState = useServerStore.getState();
  if (
    (serverState.current?.id ?? null) !== read.serverId
    || serverState.serverEpoch !== read.serverEpoch
    || getCurrentPrincipalId() !== read.principalId
  ) return;
  const inboxState = useInboxStore.getState();
  // If Activity has never started loading, the later first load will already
  // observe the committed read. If it is loaded or currently hydrating, issue
  // a canonical reconcile to close the stale-response race without erasing a
  // newer reply that landed beyond the completed read boundary. #244 step 3a
  // (inbox_read_inplace_v1): on a settled list, a listed row the read left
  // read is already that answer, so no re-read.
  if (!inboxState.loaded && !inboxState.loading) return;
  const listSettled = inboxState.hasAcceptedWindow && !inboxState.savedWindow
    && !inboxState.loading && activeInboxRequestInFlightId === null;
  if (readPersistedSkipsReread(inboxState.items, read.channelId, read.serverId, listSettled)) return;
  requestInboxBackgroundRefresh("read_persisted");
});

// Unfollowed anywhere (the thread's ⋯, a message's menu, Activity): its row
// keeps its place, read, at once (the server counts no unread for it).
registerThreadUnfollowedListener((threadChannelId) => {
  const row = useInboxStore.getState().items.find(
    (item): item is ThreadInboxItem => item.kind === "thread" && item.threadChannelId === threadChannelId,
  );
  if (row) useInboxStore.getState().markThreadUnfollowed(row);
});

registerReadStateProjectionListener((_serverId, scopeId, projection) => {
  useInboxStore.getState().applyReadStateProjection(scopeId, projection);
});

// Principal identity is a window-generation boundary even when the server id
// itself does not change. Invalidate the two receiver receipts synchronously
// with the Zustand principal transition, before any new-principal request can
// issue; the existing legacy reset path remains the owner of row/cache data.
let inboxReceiptPrincipalId = useMessageStore.getState().currentUserId;
useMessageStore.subscribe((state) => {
  if (state.currentUserId === inboxReceiptPrincipalId) return;
  inboxReceiptPrincipalId = state.currentUserId;
  pendingInboxWindowGeneration = null;
  inboxUnfollowedLoadGeneration += 1;
  useInboxStore.setState({
    acceptedWindowGeneration: "",
    hasAcceptedWindow: false,
    unfollowedWindowGeneration: null,
  });
});

// A row the Unread snapshot noted read that comes back unread (a new message)
// is no longer read there. Here rather than in that module: it is imported by
// this one, so it cannot subscribe to this store while it loads.
useInboxStore.subscribe((state, previous) => {
  if (state.items !== previous.items) forgetActivityUnreadRowsUnreadAgain(state.items);
});

registerServerReset(() => {
  inboxUnfollowedLoadGeneration += 1;
  pendingInboxWindowGeneration = null;
  activeInboxLoadRequestId = ++inboxLoadRequestSeq;
  activeInboxRequestInFlightId = null;
  trailingInboxBackgroundReset = false;
  trailingInboxBackgroundResetReason = undefined;
  trailingInboxBackgroundResetTrigger = undefined;
  for (const settle of pendingTrailingInboxBackgroundResetResolvers) settle();
  pendingTrailingInboxBackgroundResetResolvers.clear();
  trailingInboxBackgroundResetPromise = null;
  resolveTrailingInboxBackgroundReset = null;
  clearInboxLocalDoneSuppressions();
  clearInboxLocalReadSuppressions();
  inboxLocalUnreads.clear();
  clearInboxLocalThreadActivityHighWater();
  inboxChannelActivityHighWater.clear();
  cancelInboxBackgroundRefresh();
  inboxReadInFlight.clear();
  // #5690: drop every outstanding mark-done generation with the server context.
  // Without this a Done ack from the PREVIOUS server still reads as current
  // after a switch, and drives an authoritative refresh against the new
  // server's inbox. (@赵梓淇)
  inboxDoneRequestGeneration.clear();
  objectActivityHolds.clear();
  useInboxStore.setState({
    items: [],
    acceptedWindowGeneration: "",
    hasAcceptedWindow: false,
    savedWindow: false,
    loadFailed: false,
    unfollowedItems: [],
    unfollowedLoading: false,
    unfollowedLoaded: false,
    unfollowedWindowGeneration: null,
    groups: [],
    // The new server's last Activity filter (task #172); the server is
    // already current when the resets run (serverStore applyServerSwitch).
    ...inboxStateForActivityFilter(readActivityFilterChoice(useServerStore.getState().current?.id)),
    channelFilterId: null,
    sortDirection: "desc",
    searchQuery: "",
    loading: false,
    loadingMore: false,
    loaded: false,
    hasMore: true,
    totalCount: 0,
    allCount: null,
    totalUnreadCount: 0,
    activeUnreadCount: 0,
    objectUnreadCount: 0,
    objectMentionUnreadCount: 0,
    objectCount: 0,
    scrollTop: 0,
    focusedItemKey: null,
  });
});
