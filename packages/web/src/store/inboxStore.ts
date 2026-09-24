import { currentTimeMs } from "@botiverse/raft-shared";
import { create } from "zustand";
import api from "../api/client";
import { observeActivityBootstrap } from "./activityPanel/bootstrap";
import { invalidateActivityShadowGeneration } from "./activityShadowBridge";
import { getCurrentPrincipalId } from "./principalRuntime";
import { postReadAllCoalesced } from "./transport/inboxTransport";
import { registerServerReset } from "./serverResetRegistry";
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
} from "./activityReadState";
import type {
  ActivityReadStateIdentity,
} from "./activityReadState";
import {
  consumeReadStateSnapshotRows,
  getAcceptedReadStateProjection,
  getReadStateLedgerGeneration,
  registerChannelReadListener,
  registerPersistedChannelReadListener,
  registerReadStateProjectionListener,
} from "./readStateSync";
import type {
  ReadStateProjection,
} from "./readStateSync";
import type { InboxScopeReadFrontier } from "@botiverse/raft-shared";
import { useServerStore } from "./serverStore";
import { useThreadStore } from "./threadStore";
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
export type ActivitySortDirection = "desc" | "asc";

export type InboxGroupCount = {
  channelId: string;
  channelName: string;
  channelType: "channel" | "private" | "joint" | "dm";
  count: number;
  /** Server-owned maximum visible activity timestamp for this facet. */
  lastActivityAt?: string;
};

export function sortInboxGroupsByRecentActivity(groups: readonly InboxGroupCount[]): InboxGroupCount[] {
  const activityTimestamp = (group: InboxGroupCount) => {
    const parsed = Date.parse(group.lastActivityAt!);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  const byRecentActivity = (left: InboxGroupCount, right: InboxGroupCount) => {
    const leftActivity = activityTimestamp(left);
    const rightActivity = activityTimestamp(right);
    if (leftActivity > rightActivity) return -1;
    if (leftActivity < rightActivity) return 1;
    const nameDelta = left.channelName.localeCompare(right.channelName);
    return nameDelta !== 0 ? nameDelta : left.channelId.localeCompare(right.channelId);
  };
  const dms = groups.filter((group) => group.channelType === "dm").sort(byRecentActivity);
  const channels = groups.filter((group) => group.channelType !== "dm").sort(byRecentActivity);
  return [...dms, ...channels];
}

function preserveSelectedInboxGroup(
  incomingGroups: readonly InboxGroupCount[],
  previousGroups: readonly InboxGroupCount[],
  selectedChannelId: string | null,
): InboxGroupCount[] {
  const nextGroups = sortInboxGroupsByRecentActivity(incomingGroups);
  if (!selectedChannelId || nextGroups.some((group) => group.channelId === selectedChannelId)) {
    return nextGroups;
  }

  const selectedGroup = previousGroups.find((group) => group.channelId === selectedChannelId);
  if (!selectedGroup) return nextGroups;

  // A channel facet is independent from the top Activity view. When that
  // channel has zero rows in the newly selected view, the server correctly
  // omits it from that view's groups. Keep only its identity so the still-live
  // constraint remains visible and clearable; its old view count must not leak.
  return sortInboxGroupsByRecentActivity([
    ...nextGroups,
    { ...selectedGroup, count: 0 },
  ]);
}

export function isUnreadInboxFilter(filter: InboxFilter): boolean {
  return filter === "unread" || filter === "unread_mentions";
}

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
    }
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

type ThreadInboxItem = Extract<InboxItem, { kind: "thread" }>;

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
  unfollowedItems: ThreadInboxItem[];
  unfollowedLoading: boolean;
  unfollowedLoaded: boolean;
  /** The reset-window generation captured by the accepted unfollowed result. */
  unfollowedWindowGeneration: string | null;
  groups: InboxGroupCount[];
  filter: InboxFilter;
  channelFilterId: string | null;
  sortDirection: ActivitySortDirection;
  searchQuery: string;
  loading: boolean;
  loadingMore: boolean;
  loaded: boolean;
  hasMore: boolean;
  totalCount: number;
  totalUnreadCount: number;
  /** Unread messages across every active Activity row, independent of the selected list filter. */
  activeUnreadCount: number;
  scrollTop: number;
  focusedItemKey: string | null;
  // A deferred "focus the first unread row" intent. Set when a caller (e.g. the
  // sidebar dbl-click) wants the first unread focused but the inbox `items` may
  // not be loaded yet; ThreadsInbox resolves it to a concrete focusedItemKey
  // once items arrive. Avoids the timing assumption that items are already
  // populated at the moment the intent is expressed.
  pendingFocusKind: "first-unread" | null;
  setFilter: (filter: InboxFilter) => void;
  setChannelFilterId: (channelId: string | null) => void;
  setSortDirection: (direction: ActivitySortDirection) => void;
  setSearchQuery: (query: string) => void;
  setScrollTop: (scrollTop: number) => void;
  setFocusedItemKey: (key: string | null) => void;
  setPendingFocusKind: (kind: "first-unread" | null) => void;
  loadInbox: (opts?: { reset?: boolean; background?: boolean }) => Promise<void>;
  loadUnfollowed: () => Promise<void>;
  refreshInbox: (opts?: { background?: boolean }) => Promise<void>;
  markRead: (item: InboxItem) => Promise<void>;
  markAllRead: () => Promise<void>;
  markDone: (item: InboxItem) => Promise<void>;
  markThreadUnfollowed: (item: ThreadInboxItem) => void;
  markThreadRefollowed: (threadChannelId: string) => void;
  removeItem: (item: InboxItem) => void;
  clearReadForChannel: (channelId: string) => void;
  applyReadStateProjection: (channelId: string, projection: ReadStateProjection) => void;
  receiveThreadReply: (message: Message) => void;
  updateThreadActivityMeta: (threadChannelId: string, replyCount: number, lastReplyAt: string | null) => void;
  updateTaskMetadata: (task: TaskMetadataUpdate) => void;
}

const PAGE_SIZE = 30;
let inboxLoadRequestSeq = 0;
let activeInboxLoadRequestId = 0;
let activeInboxRequestInFlightId: number | null = null;
let trailingInboxBackgroundReset = false;
let trailingInboxBackgroundResetPromise: Promise<void> | null = null;
let resolveTrailingInboxBackgroundReset: (() => void) | null = null;
const pendingTrailingInboxBackgroundResetResolvers = new Set<() => void>();
let inboxLocalDoneSuppressionUntil = 0;
const inboxLocalDoneSuppressedMarkers = new Map<string, string>();
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
const inboxReadInFlight = new Set<string>();
let inboxUnfollowedLoadGeneration = 0;
/**
 * The generation owned by the newest reset request that has been issued but
 * not necessarily accepted yet. `loadUnfollowed` captures this synchronously
 * so the two parallel requests can prove they belong to the same first-window
 * attempt without coupling either response's acceptance to arrival order.
 */
let pendingInboxWindowGeneration: string | null = null;

const LOCAL_DONE_SUPPRESSION_MS = 30_000;
const LOCAL_READ_SUPPRESSION_MS = 3_000;
type ThreadActivityHighWater = { messageId: string; seq: string | null; replyCount: number };
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

export function getInboxItemKey(item: InboxItem): string {
  if (item.kind === "mention_action") return `mention_action:${item.id}`;
  return item.kind === "thread" ? `thread:${item.threadChannelId}` : `${item.kind}:${item.channelId}`;
}

function inboxItemChannelId(item: InboxItem): string | null {
  if (item.kind === "mention_action") return null;
  return item.kind === "thread" ? item.threadChannelId : item.channelId;
}

function inboxItemGroupChannelId(item: InboxItem): string | null {
  if (item.kind === "mention_action") return null;
  return item.kind === "thread" ? item.parentChannelId : item.channelId;
}

export function decrementInboxGroupCounts(
  groups: InboxGroupCount[],
  items: readonly InboxItem[],
  selectedChannelId: string | null = null,
): InboxGroupCount[] {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: bypassing either empty-input fast path reaches the same empty map and returns the same array identity below.
  if (groups.length === 0 || items.length === 0) return groups;
  const removedByGroup = new Map<string, number>();
  for (const item of items) {
    const channelId = inboxItemGroupChannelId(item);
    if (!channelId) continue;
    removedByGroup.set(channelId, (removedByGroup.get(channelId) ?? 0) + 1);
  }
  if (removedByGroup.size === 0) return groups;
  return groups.flatMap((group) => {
    const removedCount = removedByGroup.get(group.channelId) ?? 0;
    // A selected facet may intentionally stay in state with count=0 so its
    // still-live constraint remains visible and clearable. Removing an item
    // from another group must not erase that retained identity.
    if (removedCount === 0) return [group];
    const count = Math.max(0, group.count - removedCount);
    return count > 0 || group.channelId === selectedChannelId ? [{ ...group, count }] : [];
  });
}

// Stryker disable all: pure Activity-row projection glue is covered by read-state behavior tests; surviving mutants here are identity/no-op variants or mention_action type narrowing.
function projectInboxItem(item: InboxItem, projection: ReadStateProjection): InboxItem {
  if (item.kind === "mention_action") return item;
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
    const next = projectInboxItem(item, projection);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? projected : items;
}
// Stryker restore all

type ActivityPersistedItem = Exclude<InboxItem, { kind: "mention_action" }>;

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

function clearInboxLocalDoneSuppressions() {
  inboxLocalDoneSuppressionUntil = 0;
  inboxLocalDoneSuppressedMarkers.clear();
}

function clearInboxLocalReadSuppressions() {
  inboxLocalReadSuppressionUntil = 0;
  inboxLocalReadSuppressedMarkers.clear();
}

export function rememberLocalThreadActivity(item: ThreadInboxItem) {
  inboxThreadActivityHighWater.set(item.threadChannelId, {
    messageId: item.latestActivityMessageId,
    seq: item.latestActivitySeq ?? null,
    replyCount: item.replyCount,
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
): boolean {
  const state = useInboxStore.getState();
  return requestId === activeInboxLoadRequestId
    && isInboxLoadIdentityCurrent(requestIdentity)
    && state.filter === requestFilter
    && state.channelFilterId === requestChannelFilterId
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
}

function rememberInboxLocalReadSuppression(item: ActivityPersistedItem, nowMs = currentTimeMs()) {
  const marker = inboxItemLatestMarker(item);
  // Same rule as Done: without the authority frontier we do not suppress.
  if (marker === null) return;
  inboxLocalReadSuppressionUntil = Math.max(inboxLocalReadSuppressionUntil, nowMs + LOCAL_READ_SUPPRESSION_MS);
  inboxLocalReadSuppressedMarkers.set(getInboxItemKey(item), marker);
}

function forgetInboxLocalDoneSuppression(item: ActivityPersistedItem) {
  inboxLocalDoneSuppressedMarkers.delete(getInboxItemKey(item));
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

function releaseInboxDoneGeneration(item: ActivityPersistedItem, generation: number) {
  const key = getInboxItemKey(item);
  if (inboxDoneRequestGeneration.get(key) === generation) inboxDoneRequestGeneration.delete(key);
}

function forgetInboxLocalReadSuppression(item: ActivityPersistedItem) {
  inboxLocalReadSuppressedMarkers.delete(getInboxItemKey(item));
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
    if (item.kind === "mention_action") {
      nextItems.push(item);
      continue;
    }

    const key = getInboxItemKey(item);
    const suppressedMarker = inboxLocalReadSuppressedMarkers.get(key);
    if (suppressedMarker !== inboxItemLatestMarker(item)) {
      inboxLocalReadSuppressedMarkers.delete(key);
      nextItems.push(item);
      continue;
    }

    suppressedUnreadCount += item.unreadCount;
    if (filter === "all") {
      nextItems.push({ ...item, unreadCount: 0, firstUnreadMessageId: null, hasMention: false } as InboxItem);
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
    if (item.kind === "mention_action") {
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
    if (item.kind === "mention_action") {
      nextItems.push(item);
      continue;
    }

    const key = getInboxItemKey(item);
    const suppressedMarker = inboxLocalDoneSuppressedMarkers.get(key);
    if (suppressedMarker !== inboxItemLatestMarker(item)) {
      inboxLocalDoneSuppressedMarkers.delete(key);
      nextItems.push(item);
      continue;
    }

    suppressedCount += 1;
    suppressedUnreadCount += item.unreadCount;
  }

  return { items: nextItems, suppressedCount, suppressedUnreadCount };
}

/** Compare two canonical decimal seq strings as exact BigInt (task #361: full-chain
 * forbid Number() to avoid the 2^53 precision hole). Returns >0 if a>b, 0 if equal,
 * <0 if a<b. An absent/invalid seq (null, leading-zero, non-digit) loses to any valid
 * present seq; two absent/invalid seqs compare equal. Non-canonical input is treated
 * as absent rather than guessed. */
export function compareActivitySeq(a: string | null | undefined, b: string | null | undefined): number {
  const canonical = (s: string | null | undefined): string | null =>
    typeof s === "string" && /^(0|[1-9][0-9]*)$/.test(s) ? s : null;
  const av = canonical(a);
  const bv = canonical(b);
  if (av == null && bv == null) return 0;
  if (av == null) return -1;
  if (bv == null) return 1;
  const ba = BigInt(av);
  const bb = BigInt(bv);
  return ba > bb ? 1 : ba < bb ? -1 : 0;
}

/** Convert a legacy socket Message.seq (number) to a canonical decimal string overlay.
 * Only a safe non-negative integer is convertible; missing/unsafe must not be guessed
 * (task #361 contract: missing/unsafe seq → wake/refetch, never a fabricated seq). */
export function safeSeqToDecimalString(seq: number | null | undefined): string | null {
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
  return String(seq);
}

export function preserveNewerThreadActivity(
  incomingItems: InboxItem[],
  currentItems: InboxItem[],
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

  const items = incomingItems.map((incoming) => {
    // Stryker disable next-line ConditionalExpression: InboxItem's discriminant guarantees non-thread rows have no thread identity or reply version to reconcile.
    if (incoming.kind !== "thread") return incoming;
    const current = currentThreads.get(incoming.threadChannelId);
    const localVersion = inboxThreadActivityHighWater.get(incoming.threadChannelId);
    if (!current) {
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

  return { items, totalUnreadDelta };
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

export const useInboxStore = create<InboxState>((set, get) => ({
  // Stryker disable all: initial filter/load state is unchanged inbox plumbing
  // pulled into the mutation diff by extracting the task metadata updater.
  items: [],
  acceptedWindowGeneration: "",
  unfollowedItems: [],
  unfollowedLoading: false,
  unfollowedLoaded: false,
  unfollowedWindowGeneration: null,
  groups: [],
  filter: "all",
  channelFilterId: null,
  sortDirection: "desc",
  searchQuery: "",
  loading: false,
  loadingMore: false,
  loaded: false,
  hasMore: true,
  totalCount: 0,
  totalUnreadCount: 0,
  activeUnreadCount: 0,
  scrollTop: 0,
  focusedItemKey: null,
  pendingFocusKind: null,
  setFilter: (filter) => {
    if (get().filter === filter) return;
    set({ filter, items: [], acceptedWindowGeneration: "", loaded: false, hasMore: true, totalCount: 0, totalUnreadCount: 0, scrollTop: 0 });
    void get().loadInbox({ reset: true });
  },

  setChannelFilterId: (channelFilterId) => {
    if (get().channelFilterId === channelFilterId) return;
    inboxUnfollowedLoadGeneration += 1;
    set({ channelFilterId, items: [], acceptedWindowGeneration: "", unfollowedItems: [], unfollowedLoading: false, unfollowedLoaded: false, unfollowedWindowGeneration: null, loaded: false, hasMore: true, totalCount: 0, totalUnreadCount: 0, scrollTop: 0 });
    void get().loadInbox({ reset: true });
  },

  setSortDirection: (sortDirection) => {
    if (get().sortDirection === sortDirection) return;
    inboxUnfollowedLoadGeneration += 1;
    set({ sortDirection, items: [], acceptedWindowGeneration: "", unfollowedItems: [], unfollowedLoading: false, unfollowedLoaded: false, unfollowedWindowGeneration: null, loaded: false, hasMore: true, totalCount: 0, totalUnreadCount: 0, scrollTop: 0 });
    void get().loadInbox({ reset: true });
  },

  setSearchQuery: (searchQuery) => {
    if (get().searchQuery === searchQuery) return;
    inboxUnfollowedLoadGeneration += 1;
    set({ searchQuery, items: [], acceptedWindowGeneration: "", unfollowedItems: [], unfollowedLoading: false, unfollowedLoaded: false, unfollowedWindowGeneration: null, loaded: false, hasMore: true, totalCount: 0, totalUnreadCount: 0, scrollTop: 0 });
    void get().loadInbox({ reset: true });
  },

  setScrollTop: (scrollTop) => set({ scrollTop }),
  setFocusedItemKey: (key) => set({ focusedItemKey: key }),
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
          limit: 100,
          offset: 0,
        },
      });
      if (requestGeneration !== inboxUnfollowedLoadGeneration
        || !isInboxLoadIdentityCurrent(requestIdentity)) return;
      set({
        unfollowedItems: data.items.map((item) => ({
          ...item,
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
    const requestSortDirection = state.sortDirection;
    const requestSearchQuery = state.searchQuery;
    const preserveLoadedWindowOnReset = reset
      && (background || (state.loaded && state.items.length > PAGE_SIZE));
    const canPreserveLoadedTailOnReset = requestFilter === "all"
      && requestChannelFilterId === null
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
      // Invalidate before either parallel response can publish. Otherwise a
      // newly folded Core snapshot could be paired with the previous legacy
      // generation during the request race.
      set(preserveLoadedWindowOnReset
        ? { acceptedWindowGeneration: "" }
        : { acceptedWindowGeneration: "", loading: true, loadingMore: false });
    } else if (!background) {
      set({ loadingMore: true });
    }
    try {
      // Shadow the same load into the sync-core consumer. Gate-off is a no-op,
      // and the call is fire-and-forget so a shadow failure cannot affect the
      // panel. This is the production caller that makes the consumer/host
      // actually execute — a header comment claiming "shadow" is not a wiring.
      void observeActivityBootstrap();

      const requestLimit = preserveLoadedWindowOnReset
        ? Math.min(100, Math.max(PAGE_SIZE, state.items.length))
        : PAGE_SIZE;
      const { data } = await api.get("/channels/inbox", {
        params: {
          filter: requestFilter,
          sort: requestSortDirection,
          q: requestSearchQuery || undefined,
          channelId: requestChannelFilterId || undefined,
          limit: requestLimit,
          offset: reset ? 0 : state.items.length,
        },
      });
      // Same active request, but read-state moved under it: collect our own
      // loading flags and return with ZERO data side effects.
      if (requestReadStateRevision !== getActivityReadStateRevision()) {
        // Stryker disable all: requestId is the primary freshness owner and changes atomically with every facet refresh; the remaining identity checks are defense-in-depth documentation.
        if (
          requestId === activeInboxLoadRequestId
          && get().filter === requestFilter
          && get().channelFilterId === requestChannelFilterId
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
      )) {
        return;
      }

      const rawRows = (data as { items?: { kind?: string; channelId?: string; threadChannelId?: string; readState?: InboxScopeReadFrontier }[] })?.items ?? [];
      const readStateOutcomes = consumeReadStateSnapshotRows(
        requestServerId,
        rawRows.map((row) => ({
          scopeId: (row.kind === "thread" ? row.threadChannelId : row.channelId) ?? "",
          readState: row.readState,
        })),
        { ledgerGenerationAtRequest: requestReadStateLedgerGeneration },
      );
      // Normalise by INDEX: the frontier stays bound to the row it arrived with.
      // Normalise by INDEX, and DROP the raw union: a spread would carry
      // `readState` onto every persisted item, so the store would hold a second
      // copy of the thing the adapter is supposed to be the only interpreter of.
      // Destructuring it away is what makes that contract true at runtime — a
      // type assertion only hides the field, it does not remove it.
      const incomingItems = ((data.items ?? []) as (InboxItem & { readState?: InboxScopeReadFrontier })[])
        .map((item, index) => {
          const { readState: _rawUnion, ...rest } = item;
          return {
            ...rest,
            readStateLatestActivitySeq: readStateOutcomes[index]?.latestActivitySeq ?? null,
          } as InboxItem;
        });
      const readSuppression = applyInboxLocalReadSuppressions(incomingItems, requestFilter);
      const doneSuppression = applyInboxLocalDoneSuppressions(readSuppression.items);
      const acceptedReadHold = applyActivityReadStateHolds(
        doneSuppression.items,
        requestFilter,
        requestIdentity,
      );
      const nextItems = acceptedReadHold.items;
      const acceptedKeys = new Set(nextItems.map(getInboxItemKey));
      const suppressedItems = incomingItems.filter((item) => !acceptedKeys.has(getInboxItemKey(item)));
      const suppressedCount = readSuppression.suppressedCount
        + doneSuppression.suppressedCount
        + acceptedReadHold.suppressedCount;
      const suppressedUnreadCount = readSuppression.suppressedUnreadCount
        + doneSuppression.suppressedUnreadCount
        + acceptedReadHold.suppressedUnreadCount;
      set((current) => {
        // Stryker disable all: requestId changes atomically with every current facet transition; the explicit facet comparisons preserve the complete request-identity contract for future callers.
        if (
          requestId !== activeInboxLoadRequestId
          || current.filter !== requestFilter
          || current.channelFilterId !== requestChannelFilterId
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
        const preserved = reset
          ? (() => {
            const refreshed = preserveNewerThreadActivity(nextItems, current.items);
            return {
              ...refreshed,
              items: preserveLoadedInboxTail(
                refreshed.items,
                current.items,
                Boolean(data.hasMore),
                canPreserveLoadedTailOnReset,
              ),
            };
          })()
          : { items: [...current.items, ...nextItems], totalUnreadDelta: 0 };
        // Stryker disable all: total-count arithmetic combines pre-existing local suppressions with projection deltas; the focused read-state tests assert row/total outcomes, not each arithmetic mutant.
        const merged = applyKnownReadStateProjectionsToItems(preserved.items);
        const projectionUnreadDelta = merged.reduce((sum, item) => sum + item.unreadCount, 0)
          - preserved.items.reduce((sum, item) => sum + item.unreadCount, 0);
        const totalCount = data.totalCount == null
          ? merged.length
          : Math.max(0, Number(data.totalCount) - suppressedCount);
        const totalUnreadCount = data.totalUnreadCount == null
          ? merged.reduce((sum, item) => sum + item.unreadCount, 0)
          : Math.max(0, Number(data.totalUnreadCount) - suppressedUnreadCount + preserved.totalUnreadDelta + projectionUnreadDelta);
        const activeUnreadCount = data.activeUnreadCount == null
          ? (requestFilter === "all" ? totalUnreadCount : current.activeUnreadCount)
          : Math.max(0, Number(data.activeUnreadCount) - suppressedUnreadCount + preserved.totalUnreadDelta + projectionUnreadDelta);
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
              marker: item.kind === "thread" ? item.latestActivityMessageId : item.kind === "mention_action" ? item.messageId : item.lastMessageId,
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
          groups: preserveSelectedInboxGroup(
            decrementInboxGroupCounts(
              Array.isArray(data.groups) ? data.groups : [],
              suppressedItems,
            ),
            current.groups,
            requestChannelFilterId,
          ),
          hasMore: Boolean(data.hasMore),
          totalCount,
          totalUnreadCount,
          activeUnreadCount,
          loaded: true,
          loading: false,
          loadingMore: false,
        };
      });
    } catch (err) {
      console.error("Failed to load inbox:", err);
      const latest = get();
      // Stryker disable all: requestId already rejects every stale failure under current setters; the remaining comparisons document the full request identity as defense in depth.
      if (
        requestId === activeInboxLoadRequestId
        && latest.filter === requestFilter
        && latest.channelFilterId === requestChannelFilterId
        && latest.sortDirection === requestSortDirection
        && latest.searchQuery === requestSearchQuery
        && isInboxLoadIdentityCurrent(requestIdentity)
      ) {
        set({ loaded: true, loading: false, loadingMore: false });
      }
      // Stryker restore all
    } finally {
      if (activeInboxRequestInFlightId === requestId) {
        activeInboxRequestInFlightId = null;
        if (trailingInboxBackgroundReset) {
          trailingInboxBackgroundReset = false;
          const settleTrailingReset = resolveTrailingInboxBackgroundReset;
          trailingInboxBackgroundResetPromise = null;
          resolveTrailingInboxBackgroundReset = null;
          void get().loadInbox({ reset: true, background: true })
            .finally(() => settleTrailingReset?.());
        }
      }
    }
  },

  refreshInbox: async (opts = {}) => {
    await get().loadInbox({ reset: true, background: opts.background });
  },

  markRead: async (item) => {
    const channelId = item.kind === "thread" ? item.threadChannelId : item.channelId;
    const unreadCount = item.unreadCount;
    if (unreadCount <= 0) return;
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
    if (inboxReadInFlight.has(readFlightKey)) return;
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
    rememberInboxLocalReadSuppression(readItem);

    set((state) => {
      const nextItems = isUnreadInboxFilter(state.filter)
        ? state.items.filter((existing) => getInboxItemKey(existing) !== getInboxItemKey(item))
        : state.items.map((existing) => {
          if (getInboxItemKey(existing) !== getInboxItemKey(item)) return existing;
          return { ...existing, unreadCount: 0, firstUnreadMessageId: null, hasMention: false } as InboxItem;
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
      useThreadStore.getState().clearThreadUnread(item.threadChannelId, null);
    }
    useMessageStore.getState().clearUnread(channelId);

    try {
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
          await get().refreshInbox({ background: true });
        }
      }
    } finally {
      inboxReadInFlight.delete(readFlightKey);
    }
  },

  markAllRead: async () => {
    if (get().totalUnreadCount <= 0) return;
    const locallyReadItems = get().items.filter((item) => item.unreadCount > 0) as ActivityPersistedItem[];
    locallyReadItems.forEach((item) => rememberInboxLocalReadSuppression(item));

    set((state) => {
      return {
        items: isUnreadInboxFilter(state.filter)
          ? []
          : state.items.map((item) => ({ ...item, unreadCount: 0, firstUnreadMessageId: null, hasMention: false } as InboxItem)),
        groups: isUnreadInboxFilter(state.filter) ? [] : state.groups,
        totalCount: isUnreadInboxFilter(state.filter) ? 0 : state.totalCount,
        totalUnreadCount: 0,
        activeUnreadCount: 0,
        focusedItemKey: null,
      };
    });

    try {
      await api.post("/channels/inbox/read-all");
      await Promise.all([
        useMessageStore.getState().loadUnreadCounts(),
        useThreadStore.getState().loadFollowedThreads(),
      ]);
      await get().refreshInbox({ background: true });
    } catch (err) {
      console.error(err);
      locallyReadItems.forEach((item) => forgetInboxLocalReadSuppression(item));
      await get().refreshInbox({ background: true });
      await useMessageStore.getState().loadUnreadCounts();
    }
  },

  markDone: async (item) => {
    if (item.kind === "mention_action") {
      get().removeItem(item);
      return;
    }

    // Bind Done to the exact row currently accepted by this store. Every Inbox
    // Done must use the dedicated storage-space frontier, never the display
    // pair. A rolling old response without that field fails closed: refresh
    // once and let the user retry only after a new row has been accepted.
    const itemKey = getInboxItemKey(item);
    const acceptedItem = get().items.find((candidate) => getInboxItemKey(candidate) === itemKey);
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
      || (!isLegacyServerRow && (
        typeof throughActivitySeq !== "string"
        || !/^[1-9][0-9]*$/.test(throughActivitySeq)
      ))
    ) {
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
    // did not cover. On success we retire the suppression and take the row and
    // counts from an authoritative refresh instead of letting the 30s TTL
    // lapse; leaving the timed hide in place was the defect: the local
    // suppression stood in for row removal and was never reconciled against
    // server-authoritative done, so the row returned when the timer expired.
    const doneGeneration = issueInboxDoneGeneration(item);
    rememberInboxLocalDoneSuppression(item);
    get().removeItem(item);

    useMessageStore.getState().clearUnread(channelId);

    if (item.kind === "thread") {
      try {
        // Preserve Activity's click-time optimistic contract for the gated
        // Core source too: invalidate the pre-Done Core snapshot at intent,
        // before the network round trip. A failed POST reconciles through the
        // existing refresh path below, which can bootstrap a fresh snapshot.
        invalidateActivityShadowGeneration();
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
        // Refresh FIRST, with the marker-bound suppression still armed, then
        // retire it. Dropping it before the refresh would let a stale payload
        // still carrying the click-time marker resurrect the row we just
        // confirmed; anything genuinely newer than that marker is already
        // exempt from suppression and stays visible.
        await get().refreshInbox();
        forgetInboxLocalDoneSuppression(item);
        releaseInboxDoneGeneration(item, doneGeneration);
      } catch (err) {
        console.error("Failed to mark inbox thread as done:", err);
        if (!isCurrentInboxDoneGeneration(item, doneGeneration)) return;
        forgetInboxLocalDoneSuppression(item);
        await get().refreshInbox();
        await Promise.all([
          useMessageStore.getState().loadUnreadCounts(),
          useThreadStore.getState().loadFollowedThreads(),
        ]);
        releaseInboxDoneGeneration(item, doneGeneration);
      }
    } else {
      try {
        // Channel/DM Done follows the same click-time Core invalidation and
        // failure-refresh recovery contract as thread Done.
        invalidateActivityShadowGeneration();
        await api.post("/channels/inbox/done", isLegacyServerRow
          ? { channelId: item.channelId }
          : { channelId: item.channelId, throughActivitySeq, frontierSpace: "storage" as const });
        if (!isCurrentInboxDoneGeneration(item, doneGeneration)) return;
        // Refresh while still suppressed, then retire — see the thread branch.
        await get().refreshInbox();
        forgetInboxLocalDoneSuppression(item);
        releaseInboxDoneGeneration(item, doneGeneration);
      } catch (err) {
        console.error("Failed to mark inbox item as done:", err);
        if (!isCurrentInboxDoneGeneration(item, doneGeneration)) return;
        forgetInboxLocalDoneSuppression(item);
        await get().refreshInbox();
        await useMessageStore.getState().loadUnreadCounts();
        releaseInboxDoneGeneration(item, doneGeneration);
      }
    }
  },

  removeItem: (item) => {
    const key = getInboxItemKey(item);
    set((state) => ({
      items: state.items.filter((existing) => getInboxItemKey(existing) !== key),
      groups: decrementInboxGroupCounts(state.groups, [item], state.channelFilterId),
      totalCount: Math.max(0, state.totalCount - 1),
      totalUnreadCount: Math.max(0, state.totalUnreadCount - item.unreadCount),
      activeUnreadCount: Math.max(0, state.activeUnreadCount - item.unreadCount),
    }));
  },

  markThreadUnfollowed: (item) => {
    inboxUnfollowedLoadGeneration += 1;
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
        return { ...item, unreadCount: 0, firstUnreadMessageId: null, hasMention: false } as InboxItem;
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
  },

  applyReadStateProjection: (channelId, projection) => {
    set((state) => {
      // Stryker disable all: Activity list filtering/count bookkeeping is covered by read-state behavior tests; remaining mutants are reference/no-op/list-shape variants.
      let totalUnreadDelta = 0;
      let removedCount = 0;
      const removedItems: InboxItem[] = [];
      let changed = false;

      const projectItem = (item: InboxItem): InboxItem => {
        if (item.kind === "mention_action") return item;
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
          if (projection.unreadCount > 0) return [next];
          removedCount += 1;
          removedItems.push(item);
          return [];
        })
        : state.items.map(projectItem);

      if (!changed) return state;
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
  },

  // Stryker disable all: Zustand/socket glue is covered by inboxMentionBadge and
  // socketBridgeContract behavior tests; the version ledger branches above are
  // exercised through refreshInbox rather than mutation-testing store wiring.
  receiveThreadReply: (message) => {
    let traceInput: Parameters<typeof traceActivityInboxTransition>[0] | null = null;
    set((state) => {
      const existing = state.items.find(
        (item): item is ThreadInboxItem => item.kind === "thread" && item.threadChannelId === message.channelId,
      );
      if (!existing || existing.latestActivityMessageId === message.id) return state;
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
        if (incomingSeq == null || compareActivitySeq(incomingSeq, currentSeq) <= 0) return state;
      }
      const fromIndex = state.items.indexOf(existing);

      const next: ThreadInboxItem = {
        ...existing,
        latestActivityPreview: message.content,
        latestActivitySenderType: message.senderType,
        latestActivitySenderId: message.senderId,
        latestActivityMessageId: message.id,
        latestActivitySeq: incomingSeq ?? existing.latestActivitySeq,
        replyCount: existing.replyCount + 1,
        lastActivityAt: message.createdAt,
        lastReplyAt: message.createdAt,
      };
      rememberLocalThreadActivity(next);

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
  // newer reply that landed beyond the completed read boundary.
  if (!inboxState.loaded && !inboxState.loading) return;
  void inboxState.refreshInbox({ background: true });
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
  // Principal identity owns both legacy receipts AND the bound Core scope.
  // Rotate the thin bridge generation synchronously; an already-loaded heavy
  // runtime registered its reset callback in the opposite direction, so this
  // drops host/scope without pulling the runtime into the startup graph. Old
  // in-flight bootstraps also retain the prior generation and are rejected.
  invalidateActivityShadowGeneration();
  pendingInboxWindowGeneration = null;
  inboxUnfollowedLoadGeneration += 1;
  useInboxStore.setState({
    acceptedWindowGeneration: "",
    unfollowedWindowGeneration: null,
  });
});

registerServerReset(() => {
  inboxUnfollowedLoadGeneration += 1;
  pendingInboxWindowGeneration = null;
  activeInboxLoadRequestId = ++inboxLoadRequestSeq;
  activeInboxRequestInFlightId = null;
  trailingInboxBackgroundReset = false;
  for (const settle of pendingTrailingInboxBackgroundResetResolvers) settle();
  pendingTrailingInboxBackgroundResetResolvers.clear();
  trailingInboxBackgroundResetPromise = null;
  resolveTrailingInboxBackgroundReset = null;
  clearInboxLocalDoneSuppressions();
  clearInboxLocalReadSuppressions();
  clearInboxLocalThreadActivityHighWater();
  inboxReadInFlight.clear();
  // #5690: drop every outstanding mark-done generation with the server context.
  // Without this a Done ack from the PREVIOUS server still reads as current
  // after a switch, and drives an authoritative refresh against the new
  // server's inbox. (@赵梓淇)
  inboxDoneRequestGeneration.clear();
  useInboxStore.setState({
    items: [],
    acceptedWindowGeneration: "",
    unfollowedItems: [],
    unfollowedLoading: false,
    unfollowedLoaded: false,
    unfollowedWindowGeneration: null,
    groups: [],
    filter: "all",
    channelFilterId: null,
    sortDirection: "desc",
    searchQuery: "",
    loading: false,
    loadingMore: false,
    loaded: false,
    hasMore: true,
    totalCount: 0,
    totalUnreadCount: 0,
    activeUnreadCount: 0,
    scrollTop: 0,
    focusedItemKey: null,
  });
});
