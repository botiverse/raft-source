/**
 * #244 (inbox redesign, step 2; flag `inbox_row_position_v1`, default off):
 * each listed Activity row is kept by the per-row position rule, the shared
 * `reduceActivityRow` and `activityLiveUnread` (packages/shared,
 * activityRowPosition.ts / activityUnreadPredicate.ts, pinned by the
 * contract cases in contract-cases/activity-row/).
 *
 * - A live message on a listed row (inboxStore receiveThreadReply /
 *   receiveChannelMessage, socketBridge) is applied, ignored as a repeat, or
 *   ambiguous: then that one row is re-read, never the list.
 * - An answer (a list read, or a row re-read) merges per row: one older than
 *   the row's delivered position leaves the row; otherwise the row takes it
 *   and the live seqs applied above it count again (mergeAnswerByPosition).
 *   A row shown at a newer message than the answer keeps what it shows.
 * - A persisted read of a listed row clears it, or re-reads the row when the
 *   read cannot be split here (readPersistedByPosition).
 *
 * Per row (by its conversation: the channel, DM, thread or task conversation)
 * the client keeps what the reducer needs beyond the row the store shows: the
 * position its last answer delivered, the seqs applied above it since, and
 * whether a commit-order inversion was seen. It is valid only while the row
 * still shows the position it implies (another path moved the row: start
 * again from the row as shown).
 *
 * Row re-reads (`GET /api/channels/inbox?ids=`, `X-Raft-Fetch-Reason:
 * position_reread`, the trigger in `X-Raft-Fetch-Trigger`): at most one in
 * flight per row; rows asked for meanwhile wait and go together in one read.
 * Each waits ROW_REREAD_DELAY_MS first, so a row the view is a moment behind
 * on (RisingWave lags the write by ~1-2 s) comes back with the message, and
 * the two deliveries of one reply (message:new, thread:updated) ask once.
 * A row read's answer judges its rows (the drift check, `inbox.inplace.scope`
 * = `row`, trigger = why it was read); an asked-for row it leaves out is no
 * longer the list's: the list is re-read (`row_missing`). One live message in
 * POSITION_AUDIT_EVERY applied with no re-read is audited the same way
 * (`position_audit`), Tenny's acceptance number. Every audit scheduled ends
 * in exactly one check: judged (noop / conflict), or `result=not_judged` with
 * its cause (AuditNotJudgedCause), so the audits' denominator is known.
 *
 * Not handled here (the list re-read stays): a row not listed, a joint
 * conversation (its frontiers are in another server's seq space), a message
 * in a muted conversation's range, my own message with mentions (it may add a
 * mention_action row), and the thread-replies rebaseline. Flag off: nothing
 * here runs, every path is as before.
 */
import {
  INBOX_BACKEND_HEADER,
  INBOX_REFRESH_COALESCED_HEADER,
  INBOX_REFRESH_TRIGGER_HEADER,
  activityLiveUnread,
  activityRowDisplayPosition,
  compareActivityRowSeq,
  currentTimeMs,
  isCanonicalActivitySeq,
  reduceActivityRow,
} from "@botiverse/raft-shared";
import type {
  ActivityRowAppliedSeq,
  ActivityRowRereadReason,
  ActivityRowState,
  ActivityUnreadMessage,
  ActivityUnreadScope,
  InboxRefreshTrigger,
  InboxScopeReadFrontier,
} from "@botiverse/raft-shared";
import type { StoreApi } from "zustand";
import api from "../api/client";
import { isRetractedMessage } from "../components/message/delegatedMessage";
import type { DelegatedByWire } from "../components/message/delegatedMessage";
import { isTaskConversationItem, normalizeTaskConversationRow } from "../utils/taskConversation";
import { isPageHidden } from "../utils/visiblePoll";
import { getActivityReadStateRevision, hasActivityReadHold } from "./activityReadState";
import { CHANNEL_DETAIL_REASON_HEADER } from "./channelDetailReason";
import { isMessageInMutedActivityRange } from "./channelRealtimeSync";
import { safeSeqToDecimalString } from "./activitySeq";
import { touchInboxGroupActivity } from "./inboxGroups";
import { checkRowAnswerDrift, noteInPlaceRow, readPersistedSkipsReread, recordAuditNotJudged, skippedRereadFrontiers } from "./inboxInPlaceUnread";
import type { AuditNotJudgedCause, InboxLiveUnread } from "./inboxInPlaceUnread";
import { getInboxItemKey } from "./inboxItem";
import { inPlaceUnreadTotals } from "./inboxLivePatch";
import type { ChannelInboxItem, InboxItem, InboxState, ThreadInboxItem } from "./inboxStore";
import { getPendingReadSeq, useMessageStore } from "./messageStore";
import type { Message } from "./messageStore";
import { consumeReadStateSnapshotRows, getAcceptedReadState, getReadStateLedgerGeneration } from "./readStateSync";
import { INBOX_ROW_POSITION_FLAG_KEY, readServerFeatureFlag } from "./serverFeatureFlags";
import { registerServerReset } from "./serverResetRegistry";
import { useServerStore } from "./serverStore";

type ConversationRow = Exclude<InboxItem, { kind: "mention_action" | "object" }>;

/** The rows' read/Done holds of a list answer (inboxStore), for a row re-read's rows. */
/** `sentAt`: the open-read clock when the read was sent (a row opened here since holds read against it). */
type ServedRowHolds = (serverId: string | null, items: InboxItem[], frontiers: readonly (InboxScopeReadFrontier | undefined)[], sentAt: number) => InboxItem[];

/** What the inbox store hands this module (it imports this one, so it registers rather than being imported). */
type InboxStorePort = {
  store: StoreApi<InboxState>;
  holds: ServedRowHolds;
  /** The open-read clock (currentInboxOpenReadClock): a row read captures it when sent. */
  openReadClock: () => number;
  /** The throttled list re-read (requestInboxBackgroundRefresh): a hidden page owes it, a failed row read falls back to it. */
  listReread: (trigger: InboxRefreshTrigger) => void;
};

let port: InboxStorePort | null = null;

export function registerInboxRowPositionStore(next: InboxStorePort): void {
  port = next;
}

/** The flag, for the current server. */
export function rowPositionOn(serverId: string | null = useServerStore.getState().current?.id ?? null): boolean {
  return readServerFeatureFlag(serverId, INBOX_ROW_POSITION_FLAG_KEY);
}

// ---- Per-row client state -----------------------------------------------------

type RowClientState = Pick<ActivityRowState, "position" | "applied" | "inversionObserved">;

// Rows with a state; a page whose Activity is never re-read still notes rows, so past this the oldest go.
const ROW_STATE_CAP = 500;
const rowStates = new Map<string, RowClientState>();

function scopeOf(row: ConversationRow): string {
  return row.kind === "thread" ? row.threadChannelId : row.channelId;
}

function canonicalOrNull(seq: string | null | undefined): string | null {
  return isCanonicalActivitySeq(seq) ? seq : null;
}

/** The reducer's row: the store's row, with the client state kept for it while the row still shows its position. */
export function rowPositionStateOf(row: ConversationRow): ActivityRowState {
  const kept = rowStates.get(scopeOf(row));
  const shown = row.latestActivitySeq ?? null;
  const valid = kept && activityRowDisplayPosition({ ...kept, unreadCount: 0, hasMention: false, mentionOnly: false }) === shown;
  return {
    unreadCount: row.unreadCount,
    hasMention: row.hasMention,
    mentionOnly: row.unreadCount === 0 && row.hasMention,
    position: valid ? kept.position : canonicalOrNull(shown),
    applied: valid ? kept.applied : [],
    inversionObserved: valid ? kept.inversionObserved : false,
  };
}

function keepRowState(scopeId: string, row: ActivityRowState): void {
  rowStates.delete(scopeId);
  rowStates.set(scopeId, { position: row.position, applied: row.applied, inversionObserved: row.inversionObserved });
  while (rowStates.size > ROW_STATE_CAP) rowStates.delete(rowStates.keys().next().value!);
}

/**
 * What only this screen knows of a read the reducer has not been given: a
 * read hold on the scope (`all`), or a read still queued here (its seq). The
 * reducer's own read event (shared applyRead) takes the applied seqs a read
 * covers out of the count; a read made here but not yet persisted is not a
 * reducer event yet, so the applied seqs it covers do not count again on an
 * answer.
 *
 * Seqs are exact decimal strings everywhere in this module except here and in
 * readPersistedByPosition: the queued read and the accepted read state are
 * stored as Numbers (messageStore, readStateSync). This is the one non-exact
 * place: a seq past 2^53 would compare wrongly.
 */
function readThrough(scopeId: string): bigint | "all" | null {
  const serverId = useServerStore.getState().current?.id ?? null;
  if (hasActivityReadHold({ serverId, principalId: useMessageStore.getState().currentUserId }, scopeId)) return "all";
  const pending = getPendingReadSeq(scopeId);
  return pending > 0 ? BigInt(pending) : null;
}

function withReadApplied(scopeId: string, row: ActivityRowState): ActivityRowState {
  if (row.applied.length === 0) return row;
  const read = readThrough(scopeId);
  if (read === null) return row;
  const covered = (entry: ActivityRowAppliedSeq) => read === "all" || BigInt(entry.seq) <= read;
  if (!row.applied.some((entry) => covered(entry) && (entry.counts || entry.mention))) return row;
  return { ...row, applied: row.applied.map((entry) => (covered(entry) ? { ...entry, counts: false, mention: false } : entry)) };
}

// ---- Live messages --------------------------------------------------------------

const REREAD_TRIGGER: Record<ActivityRowRereadReason, InboxRefreshTrigger> = {
  ambiguous_seq: "ambiguous_seq",
  inversion: "row_inversion",
  null_position: "row_null_position",
  unjudged: "row_unjudged",
  partial_read: "row_partial_read",
};

function isOwn(message: Message): boolean {
  const viewer = useMessageStore.getState().currentUserId;
  return message.senderType === "user" && !!viewer && message.senderId === viewer;
}

/**
 * The shared predicate's verdict for `message` on `row`. `live` brings what
 * only the screen knows: it does not count (`live.counts` false) because it is
 * read as it arrives (the open conversation at its bottom, a queued read, a
 * read hold) or is the person's own; `live.loaded`: the loaded messages'
 * read-state projection already set the row's unread, so it adds nothing
 * (receiveLiveByPosition asks with `loaded: false` and keeps the projected
 * count instead, so the record still says whether the message counts).
 */
export function rowPositionVerdict(row: ConversationRow, message: Message, live: Pick<InboxLiveUnread, "counts" | "loaded">): { counts: boolean | null; mention: boolean } {
  if (live.loaded) return { counts: false, mention: false };
  const viewer = useMessageStore.getState().currentUserId;
  if (!viewer) return { counts: null, mention: false };
  const scope: ActivityUnreadScope = row.kind === "thread"
    ? { rowKind: isTaskConversationItem(row) ? "task" : "thread", threadFollowed: row.isFollowing !== false, readOnArrival: !live.counts }
    : { rowKind: row.kind, activityMuted: isMessageInMutedActivityRange(message), readOnArrival: !live.counts };
  return activityLiveUnread(message as unknown as ActivityUnreadMessage, { type: "user", id: viewer }, scope);
}

function isJoint(row: ConversationRow): boolean {
  return (row.kind === "thread" ? row.parentChannelType : row.channelType) === "joint";
}

/** The row at a newer message: its preview, sender and seq (not its unread). */
function advancedRow(row: ConversationRow, message: Message, seq: string): ConversationRow {
  const delegatedBy = (message as { delegatedBy?: DelegatedByWire | null }).delegatedBy ?? null;
  if (row.kind === "thread") {
    const sameSender = message.senderId === row.latestActivitySenderId && message.senderType === row.latestActivitySenderType;
    return {
      ...row,
      latestActivityPreview: message.content,
      latestActivitySenderType: message.senderType,
      latestActivitySenderId: message.senderId,
      latestActivitySenderName: sameSender ? row.latestActivitySenderName : message.senderName ?? null,
      latestActivityMessageId: message.id,
      senderAvatarUrl: sameSender ? row.senderAvatarUrl : null,
      latestDelegatedBy: delegatedBy,
      latestRetracted: isRetractedMessage(message),
      latestActivitySeq: seq,
      replyCount: row.replyCount + 1,
      lastActivityAt: message.createdAt,
      lastReplyAt: message.createdAt,
    } satisfies ThreadInboxItem;
  }
  return {
    ...row,
    lastMessageId: message.id,
    latestActivitySeq: seq,
    lastMessageAt: message.createdAt,
    lastMessagePreview: message.content,
    lastMessageSenderType: message.senderType,
    lastMessageSenderId: message.senderId,
    lastMessageSenderName: message.senderName ?? null,
    latestDelegatedBy: delegatedBy,
    latestRetracted: isRetractedMessage(message),
    senderAvatarUrl: message.senderId === row.lastMessageSenderId ? row.senderAvatarUrl : null,
  } satisfies ChannelInboxItem;
}

/** The frontiers move with the display seq when they were at it (as step 3b's skipped re-read). */
function movedFrontiers(row: ConversationRow, seq: string): Partial<ConversationRow> {
  const shown = row.latestActivitySeq;
  if (row.readStateLatestActivitySeq !== shown || (row.doneFrontierSeq !== undefined && row.doneFrontierSeq !== shown)) return {};
  return skippedRereadFrontiers(row, seq);
}

function unreadFields(before: ConversationRow, after: ActivityRowState, messageId: string): Partial<ConversationRow> {
  return {
    unreadCount: after.unreadCount,
    hasMention: after.hasMention,
    firstUnreadMessageId: after.unreadCount === 0 ? null : before.unreadCount === 0 ? messageId : before.firstUnreadMessageId,
    firstMentionMessageId: !after.hasMention ? null : before.hasMention ? before.firstMentionMessageId : messageId,
  };
}

/**
 * Flag on: a live message for a listed row, by the per-row rule. True: taken
 * (applied, a repeat, or its row re-read): no list re-read. False: not this
 * path's (flag off, no live verdict, the row not listed or not handled here,
 * see the header); the caller goes on as before.
 */
export function receiveLiveByPosition(message: Message, live: InboxLiveUnread | undefined, kind: "thread" | "channel"): boolean {
  if (!port || !live || !rowPositionOn()) return false;
  const { store } = port;
  const state = store.getState();
  const existing = state.items.find((item): item is ConversationRow => kind === "thread"
    ? item.kind === "thread" && item.threadChannelId === message.channelId
    : (item.kind === "channel" || item.kind === "dm") && item.channelId === message.channelId);
  if (!existing || isJoint(existing)) return false;
  if (isOwn(message) && (message.mentions ?? []).length > 0) return false;
  if (existing.kind !== "thread" && isMessageInMutedActivityRange(message)) return false;
  const scopeId = scopeOf(existing);
  const seq = canonicalOrNull(safeSeqToDecimalString(message.seq));
  // A message the loaded messages' read-state projection already counted
  // (`live.loaded`: addMessage set the row's unread first) is recorded with
  // its real verdict, so a later answer behind it adds it back; only this
  // patch does not add it again (#triage:#244: recorded as not counting, a
  // lagging answer's merge dropped it, 4 of 4 on staging).
  const preCounted = live.loaded;
  const verdict = rowPositionVerdict(existing, message, { counts: live.counts, loaded: false });
  const before = rowPositionStateOf(existing);
  const applied = reduceActivityRow(before, { type: "live", seq: seq ?? "", counts: verdict.counts, mentionsViewer: verdict.mention });
  if (applied.reread) {
    requestRowReread(scopeId, REREAD_TRIGGER[applied.rereadReason ?? "ambiguous_seq"]);
    return true;
  }
  let after = preCounted ? { ...applied.row, unreadCount: before.unreadCount, hasMention: before.hasMention, mentionOnly: before.mentionOnly } : applied.row;
  let rereadAsked = false;
  // My own send reads the conversation on the server, and no read state comes to say so.
  if (seq && isOwn(message) && (after.unreadCount > 0 || after.hasMention)) {
    const read = reduceActivityRow(after, { type: "read", seq });
    rereadAsked = read.reread;
    if (read.reread) requestRowReread(scopeId, REREAD_TRIGGER[read.rereadReason ?? "partial_read"]);
    else after = read.row;
  }
  if (after === before) return true;
  keepRowState(scopeId, after);
  const shown = existing.latestActivitySeq;
  const advances = seq !== null && (shown == null || !isCanonicalActivitySeq(shown) || compareActivityRowSeq(seq, shown) > 0);
  const next = {
    ...(advances ? { ...advancedRow(existing, message, seq), ...movedFrontiers(existing, seq) } : existing),
    ...unreadFields(existing, after, message.id),
  } as ConversationRow;
  noteInPlaceRow(next, live, message, "position", !advances);
  store.setState((current) => {
    const listed = current.items.find((item) => item === existing);
    if (!listed) return current;
    const others = current.items.filter((item) => item !== existing);
    const toTop = advances && (kind === "thread" || current.sortDirection === "desc");
    return {
      items: toTop ? [next, ...others] : current.items.map((item) => (item === existing ? next : item)),
      ...inPlaceUnreadTotals(current, next, next.unreadCount - existing.unreadCount),
      ...(advances ? { groups: touchInboxGroupActivity(current.groups, next, message.createdAt) } : {}),
    };
  });
  if (!rereadAsked && store.getState().items.includes(next)) auditLiveApplied(scopeId, next);
  return true;
}

// ---- Persisted reads --------------------------------------------------------------

/**
 * Flag on: a persisted read of a listed row (`row`). The read already cleared
 * the row here (inboxStore clearReadForChannel); one that still shows unread
 * or an @ (a reply past the read, a mention-only row) re-reads that row when
 * the read cannot be split (the reducer's partial_read), else is cleared.
 * Always taken: no list re-read.
 */
export function readPersistedByPosition(row: ConversationRow): void {
  const scopeId = scopeOf(row);
  const before = withReadApplied(scopeId, rowPositionStateOf(row));
  // A Number (readStateSync): see readThrough on the one non-exact place.
  const accepted = getAcceptedReadState(useServerStore.getState().current?.id ?? null, scopeId)?.maxReadSeq;
  if (!accepted) {
    if (before.unreadCount === 0 && !before.hasMention) keepRowState(scopeId, before);
    // Its seq not known here: the read cannot be placed against the row.
    else requestRowReread(scopeId, "row_partial_read");
    return;
  }
  const result = reduceActivityRow(before, { type: "read", seq: String(accepted) });
  if (result.reread) {
    requestRowReread(scopeId, REREAD_TRIGGER[result.rereadReason ?? "partial_read"]);
    return;
  }
  keepRowState(scopeId, result.row);
  if (result.row.unreadCount === row.unreadCount && result.row.hasMention === row.hasMention) return;
  port?.store.setState((current) => ({
    items: current.items.map((item) => (item === row ? { ...row, ...unreadFields(row, result.row, "") } as ConversationRow : item)),
  }));
}

/**
 * The persisted-read listener's decision (inboxStore): flag on, a listed row
 * is the reducer's (readPersistedByPosition), noted for the drift check with
 * `inbox.inplace.reread=position`, and no list re-read. Otherwise step 3a's
 * readPersistedSkipsReread, as before (an unlisted row re-reads the list).
 */
export function readPersistedSkipsListReread(items: readonly InboxItem[], scopeId: string, serverId: string | null, listSettled: boolean): boolean {
  const row = rowPositionOn(serverId) ? items.find((item): item is ConversationRow => isConversation(item) && scopeOf(item) === scopeId) : undefined;
  if (!row || isJoint(row)) return readPersistedSkipsReread(items, scopeId, serverId, listSettled);
  noteInPlaceRow(row, "read_persisted", undefined, "position");
  readPersistedByPosition(row);
  return true;
}

// ---- Answers ------------------------------------------------------------------------

/**
 * One answered row (`served`, after the store's read and Done holds) against
 * the row shown (`current`): the row to show, by the reducer's merge. `pa`:
 * the position the answer delivered (its own latestActivitySeq). Null: the
 * answer is older than the row's delivered position, keep `current` whole.
 */
function mergeServedRow(current: ConversationRow, served: ConversationRow, pa: string | null): { row: ConversationRow; kept: boolean; note: string } {
  const scopeId = scopeOf(current);
  const state = rowPositionStateOf(current);
  const before = withReadApplied(scopeId, state);
  // #triage:#244 (a lagging answer merged one short, 2 of 2 on staging): what the merge started from, for the audit detail.
  const read = readThrough(scopeId);
  const above = (row: ActivityRowState) => (pa === null ? [] : row.applied.filter((entry) => isCanonicalActivitySeq(entry.seq) && compareActivityRowSeq(entry.seq, pa) > 0));
  const note = `;kept_state=${rowStates.get(scopeId)?.applied === state.applied ? 1 : 0};row_position=${state.position ?? "-"};applied=${state.applied.length};above=${above(state).length};above_counts=${above(state).filter((entry) => entry.counts).length}/${above(before).filter((entry) => entry.counts).length};read_through=${read === null ? "-" : String(read)}`;
  const answer = { unreadCount: served.unreadCount, hasMention: served.hasMention, position: pa, mentionOnly: served.unreadCount === 0 && served.hasMention };
  const result = reduceActivityRow(before, { type: "answer", row: answer });
  if (result.reread) requestRowReread(scopeId, REREAD_TRIGGER[result.rereadReason ?? "inversion"]);
  if (result.row === before) return { row: current, kept: true, note };
  keepRowState(scopeId, result.row);
  // A row shown at a newer message than the answer keeps what it shows (preview, order, frontiers).
  const shown = canonicalOrNull(current.latestActivitySeq);
  const newer = shown !== null && pa !== null && compareActivityRowSeq(shown, pa) > 0;
  const base = newer ? current : served;
  const extra = result.row.unreadCount !== served.unreadCount || result.row.hasMention !== served.hasMention;
  return {
    kept: newer,
    note,
    row: {
      ...base,
      unreadCount: result.row.unreadCount,
      hasMention: result.row.hasMention,
      firstUnreadMessageId: result.row.unreadCount === 0 ? null : extra ? served.firstUnreadMessageId ?? current.firstUnreadMessageId : served.firstUnreadMessageId,
      firstMentionMessageId: !result.row.hasMention ? null : extra ? served.firstMentionMessageId ?? current.firstMentionMessageId : served.firstMentionMessageId,
    } as ConversationRow,
  };
}

function activityAt(item: InboxItem): number {
  if (item.kind === "mention_action" || item.kind === "object") return Number.NEGATIVE_INFINITY;
  const at = Date.parse(item.kind === "thread" ? item.lastActivityAt : item.lastMessageAt);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/** Newest first: rows kept at a newer message than the answer go back to their place by time. */
function placeKeptRows(items: InboxItem[], kept: ReadonlySet<InboxItem>, newestFirst: boolean): InboxItem[] {
  if (!newestFirst || kept.size === 0) return items;
  const merged = items.filter((item) => !kept.has(item));
  for (const row of [...kept].sort((a, b) => activityAt(a) - activityAt(b))) {
    const before = merged.findIndex((other) => activityAt(other) < activityAt(row));
    merged.splice(before < 0 ? merged.length : before, 0, row);
  }
  return merged;
}

/**
 * Flag on: a list answer accepted by loadInbox (`merged`: its rows after the
 * store's holds, and the rows kept from before), against the rows shown
 * (`current`) and as served (`served`, for each row's delivered position).
 * Each answered row that is listed merges by the reducer; one first listed
 * by this answer starts its client state. `readBehind`: rows whose answer is
 * from an older read than the one accepted here (inboxServedReadBehind),
 * left as the store kept them. Flag off: `merged` as it is.
 */
export function mergeAnswerByPosition<T extends { items: InboxItem[]; totalUnreadDelta: number }>(
  merged: T,
  current: readonly InboxItem[],
  served: readonly InboxItem[],
  newestFirst: boolean,
  readBehind: ReadonlySet<string> = new Set(),
): T {
  if (!rowPositionOn()) return merged;
  const servedSeq = new Map(served.filter(isConversation).map((row) => [getInboxItemKey(row), canonicalOrNull(row.latestActivitySeq)]));
  const shown = new Map(current.filter(isConversation).map((row) => [getInboxItemKey(row), row]));
  let delta = 0;
  const kept = new Set<InboxItem>();
  const items = merged.items.map((item) => {
    if (!isConversation(item)) return item;
    const key = getInboxItemKey(item);
    if (!servedSeq.has(key)) return item;
    const pa = servedSeq.get(key) ?? null;
    const before = shown.get(key);
    const scopeId = scopeOf(item);
    if (!before) {
      keepRowState(scopeId, { position: pa, applied: [], inversionObserved: false, unreadCount: 0, hasMention: false, mentionOnly: false });
      return item;
    }
    if (readBehind.has(scopeId)) return item;
    const next = mergeServedRow(before, item, pa);
    delta += next.row.unreadCount - item.unreadCount;
    if (next.kept) kept.add(next.row);
    return next.row;
  });
  return { ...merged, items: placeKeptRows(items, kept, newestFirst), totalUnreadDelta: merged.totalUnreadDelta + delta };
}

function isConversation(item: InboxItem): item is ConversationRow {
  return item.kind !== "mention_action" && item.kind !== "object";
}

// ---- Row re-reads -------------------------------------------------------------------

/** How long a row asked for waits before its read (the view's lag behind the write; a batch window). */
export const ROW_REREAD_DELAY_MS = 1_500;
// The route's `ids` limit.
const ROW_IDS_MAX = 50;

/**
 * Rows waiting for a read: the first trigger each was asked for with, how
 * many asks it stands for, and for an audit the row as the patch left it.
 */
type PendingRow = { trigger: InboxRefreshTrigger; asks: number; audit?: ConversationRow; followup?: boolean };
const pendingRows = new Map<string, PendingRow>();
/** The rows of each read in flight, as they were asked for (the answer judges them). */
const inFlightRows = new Set<string>();

// One live message in this many applied in place with no re-read is audited (Tenny's acceptance number).
export const POSITION_AUDIT_EVERY = 20;
let liveAppliedCount = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * An audit whose answer was behind its row is read once more this long after
 * that answer (plus the usual ROW_REREAD_DELAY_MS), and judged in full
 * (Tenny, #triage:#244). Its count is how often the view trails a live
 * message by more than the re-read delay.
 */
export const AUDIT_FOLLOWUP_DELAY_MS = 5_000;
/** Follow-up audits waiting for their delay: each ends in one check (judged, or not_judged). */
const followupTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; row: ConversationRow }>();
let generation = 0;

/** Re-read this one row (`?ids=`), never the list: batched with the rows waiting, never twice in flight. */
export function requestRowReread(scopeId: string, trigger: InboxRefreshTrigger): void {
  const pending = pendingRows.get(scopeId);
  // A re-read supersedes an audit waiting for the row (the row is no longer as the patch left it).
  if (pending?.audit) {
    recordAuditNotJudged(pending.audit, "superseded_by_reread");
    pendingRows.set(scopeId, { trigger, asks: 1 });
  } else if (pending) pending.asks += 1;
  else pendingRows.set(scopeId, { trigger, asks: 1 });
  scheduleFlush();
}

/**
 * A live message applied in place with no re-read: one in
 * POSITION_AUDIT_EVERY (a counter: the 20th, the 40th, ...) reads its row once
 * after the usual delay (`X-Raft-Fetch-Reason: position_audit`, trigger
 * `position_audit`) and the answer judges `row` (the row as the patch left
 * it): scope=row. One that cannot be judged is recorded `not_judged` with its
 * cause (notJudged). Not when the row already waits for a read.
 */
function auditLiveApplied(scopeId: string, row: ConversationRow): void {
  if (++liveAppliedCount % POSITION_AUDIT_EVERY !== 0 || pendingRows.has(scopeId)) return;
  pendingRows.set(scopeId, { trigger: "position_audit", asks: 1, audit: row });
  scheduleFlush();
}

/** The audits among `rows` end not judged, for `cause` (one check each). */
function notJudged(rows: Iterable<readonly [string, PendingRow]>, cause: AuditNotJudgedCause, backend: string | null = null): void {
  for (const [, entry] of rows) if (entry.audit) recordAuditNotJudged(entry.audit, cause, backend, entry.followup ? ";followup=1" : "");
}

/** The follow-up of an audit whose answer was behind `row`: read it once more, after AUDIT_FOLLOWUP_DELAY_MS. */
function scheduleAuditFollowup(scopeId: string, row: ConversationRow): void {
  if (followupTimers.has(scopeId)) return;
  const timer = setTimeout(() => {
    followupTimers.delete(scopeId);
    const current = port?.store.getState().items.find((item) => isConversation(item) && scopeOf(item) === scopeId) as ConversationRow | undefined;
    if (!current) {
      recordAuditNotJudged(row, "row_unlisted", null, ";followup=1");
      return;
    }
    // A re-read already waiting for the row stands in for the follow-up.
    if (pendingRows.has(scopeId)) {
      recordAuditNotJudged(current, "superseded_by_reread", null, ";followup=1");
      return;
    }
    pendingRows.set(scopeId, { trigger: "position_audit", asks: 1, audit: current, followup: true });
    scheduleFlush();
  }, AUDIT_FOLLOWUP_DELAY_MS);
  followupTimers.set(scopeId, { timer, row });
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushRowRereads();
  }, ROW_REREAD_DELAY_MS);
}

async function flushRowRereads(): Promise<void> {
  const waiting = [...pendingRows].filter(([scopeId]) => !inFlightRows.has(scopeId));
  // Audits and re-reads go in reads of their own, so each read's reason says which.
  const audit = waiting[0]?.[1].audit !== undefined;
  const ready = waiting.filter(([, entry]) => (entry.audit !== undefined) === audit).slice(0, ROW_IDS_MAX);
  if (ready.length === 0 || !port) return;
  for (const [scopeId] of ready) pendingRows.delete(scopeId);
  const trigger = ready[0]![1].trigger;
  const asks = ready.reduce((sum, [, entry]) => sum + entry.asks, 0);
  // A hidden page reads nothing: the list read it owes on show stands for these rows (an audit is not judged).
  if (isPageHidden()) {
    if (audit) notJudged(ready, "page_hidden");
    else port.listReread(trigger);
    if (pendingRows.size > 0) scheduleFlush();
    return;
  }
  if ([...pendingRows.keys()].some((scopeId) => !inFlightRows.has(scopeId))) scheduleFlush();
  const ids = ready.map(([scopeId]) => scopeId);
  for (const scopeId of ids) inFlightRows.add(scopeId);
  const requestGeneration = generation;
  const serverId = useServerStore.getState().current?.id ?? null;
  const serverEpoch = useServerStore.getState().serverEpoch;
  const revision = getActivityReadStateRevision();
  const ledgerGeneration = getReadStateLedgerGeneration();
  const sentAt = port.openReadClock();
  try {
    const response = await api.get<{ items?: unknown[] }>("/channels/inbox", {
      params: { ids: ids.join(",") },
      headers: { [CHANNEL_DETAIL_REASON_HEADER]: audit ? "position_audit" : "position_reread", [INBOX_REFRESH_TRIGGER_HEADER]: trigger, [INBOX_REFRESH_COALESCED_HEADER]: String(asks) },
    });
    const backend = responseHeader(response?.headers, INBOX_BACKEND_HEADER.toLowerCase());
    if (requestGeneration !== generation || useServerStore.getState().serverEpoch !== serverEpoch) {
      notJudged(ready, "server_switched", backend);
      return;
    }
    // A read changed under it: the answer may predate it; ask again (an audit is not judged).
    if (revision !== getActivityReadStateRevision()) {
      if (audit) notJudged(ready, "read_changed", backend);
      else for (const scopeId of ids) requestRowReread(scopeId, trigger);
      return;
    }
    applyRowAnswer(serverId, response?.data?.items ?? [], ledgerGeneration, sentAt, new Map(ready), backend);
  } catch {
    if (audit) notJudged(ready, "request_failed");
    else if (requestGeneration === generation) port.listReread(trigger);
  } finally {
    if (requestGeneration === generation) {
      for (const scopeId of ids) inFlightRows.delete(scopeId);
      if (pendingRows.size > 0) scheduleFlush();
    }
  }
}

/** A response header from axios' AxiosHeaders or a plain (test) object, unchanged; null when absent. */
function responseHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  const getter = (headers as { get?: unknown }).get;
  const value = typeof getter === "function" ? (getter as (key: string) => unknown).call(headers, name) : (headers as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : null;
}

type ServedConversationRow = ConversationRow & { readState?: InboxScopeReadFrontier };

/**
 * An audited row moved before its answer only if what the audit judges
 * changed: its position, unread count or @. A refresh that rebuilds the row
 * with the same values (`thread:updated` setting the reply count and last
 * activity of the reply the patch already counted) is not a move
 * (#triage:#244: 6 of 7 set-aside audits in run 4 were that, on thread rows).
 */
function auditRowMoved(audited: ConversationRow, current: ConversationRow): boolean {
  return audited.latestActivitySeq !== current.latestActivitySeq
    || audited.unreadCount !== current.unreadCount
    || audited.hasMention !== current.hasMention;
}

/**
 * A row re-read's answer: each row still listed merges by the reducer (never
 * added, never moved off the list), judged first (the drift check,
 * scope=row). The route answers an `ids` read with only the rows that still
 * qualify for the viewer's Activity All list (`GET /api/channels/inbox?ids=`:
 * rows it cannot see, Done, archived or gone are left out, with no error), so
 * an asked-for row missing from the answer is one the list no longer has:
 * the list is re-read (`row_missing`) rather than keep a row that is stale.
 * An audited row the answer does not judge is recorded not judged
 * (`row_missing`: left out; `row_unlisted`: answered, no longer listed here).
 */
function applyRowAnswer(
  serverId: string | null,
  raw: readonly unknown[],
  ledgerGeneration: number,
  sentAt: number,
  asked: ReadonlyMap<string, PendingRow>,
  backend: string | null,
): void {
  if (!port) return;
  const rows = raw
    .filter((row): row is ServedConversationRow => !!row && typeof row === "object" && (row as InboxItem).kind !== "object")
    .map((row) => normalizeTaskConversationRow(row) as ServedConversationRow);
  const returned = new Set(rows.map(scopeOf));
  const listed = new Set(port.store.getState().items.filter(isConversation).map(scopeOf));
  if ([...asked.keys()].some((scopeId) => !returned.has(scopeId) && listed.has(scopeId))) port.listReread("row_missing");
  const outcomes = consumeReadStateSnapshotRows(serverId, rows.map((row) => ({ scopeId: scopeOf(row), readState: row.readState })), { ledgerGenerationAtRequest: ledgerGeneration });
  const items = rows.map(({ readState: _readState, ...row }, index) => ({ ...row, readStateLatestActivitySeq: outcomes[index]?.latestActivitySeq ?? null }) as InboxItem);
  const held = port.holds(serverId, items, rows.map((row) => row.readState), sentAt);
  const servedSeq = new Map(rows.map((row) => [getInboxItemKey(row), canonicalOrNull(row.latestActivitySeq)]));
  const judged = new Set<string>();
  const followups: Array<[string, ConversationRow]> = [];
  port.store.setState((state) => {
    let delta = 0;
    const kept = new Set<InboxItem>();
    const answered = new Map(held.filter(isConversation).map((row) => [getInboxItemKey(row), row]));
    const items = state.items.map((item) => {
      const served = isConversation(item) ? answered.get(getInboxItemKey(item)) : undefined;
      if (!served || !isConversation(item)) return item;
      // The answer judges the row as shown when it came (AndyLok's drift check, scope=row); an audit, the row the patch left.
      // An audit answer behind the row judges the row once the answer is taken (`merged`).
      const entry = asked.get(scopeOf(item));
      if (entry) judged.add(scopeOf(item));
      const next = mergeServedRow(item, served, servedSeq.get(getInboxItemKey(item)) ?? null);
      const audit = entry?.audit ? { moved: auditRowMoved(entry.audit, item), followup: entry.followup === true } : null;
      if (checkRowAnswerDrift(item, served as ConversationRow, entry?.trigger ?? "ambiguous_seq", backend, audit, next.row, next.note)) followups.push([scopeOf(item), next.row]);
      delta += next.row.unreadCount - item.unreadCount;
      // A served row at a newer message than shown moves to its place by time too.
      if (next.row !== item && !next.kept && activityAt(next.row) !== activityAt(item)) kept.add(next.row);
      return next.row;
    });
    if (items.every((item, index) => item === state.items[index])) return state;
    return {
      items: placeKeptRows(items, kept, state.sortDirection === "desc"),
      totalUnreadCount: Math.max(0, state.totalUnreadCount + delta),
      activeUnreadCount: Math.max(0, state.activeUnreadCount + delta),
    };
  });
  for (const [scopeId, entry] of asked) {
    if (entry.audit && !judged.has(scopeId)) recordAuditNotJudged(entry.audit, returned.has(scopeId) ? "row_unlisted" : "row_missing", backend, entry.followup ? ";followup=1" : "");
  }
  for (const [scopeId, row] of followups) scheduleAuditFollowup(scopeId, row);
}

/** A server switch: the audits still waiting are not judged (one in flight records itself on its answer). */
function resetRowPosition(): void {
  notJudged(pendingRows, "server_switched");
  for (const { row } of followupTimers.values()) recordAuditNotJudged(row, "server_switched", null, ";followup=1");
  clearRowPosition();
}

function clearRowPosition(): void {
  generation += 1;
  rowStates.clear();
  pendingRows.clear();
  inFlightRows.clear();
  liveAppliedCount = 0;
  for (const { timer } of followupTimers.values()) clearTimeout(timer);
  followupTimers.clear();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
}

registerServerReset(resetRowPosition);

export function resetInboxRowPositionForTests(): void {
  clearRowPosition();
}

/** For tests: what the row re-read machinery holds now. */
export function inboxRowRereadsForTests(): { pending: string[]; inFlight: string[]; at: number } {
  return { pending: [...pendingRows.keys()], inFlight: [...inFlightRows], at: currentTimeMs() };
}
