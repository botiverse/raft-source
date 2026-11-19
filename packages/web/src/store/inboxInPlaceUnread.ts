/**
 * #244 (step 2 of the inbox refetch cut): a live message patches its existing
 * Activity row's unread count and mention flag in place, and a persisted read
 * leaves its row as the read already made it. The realtime re-read still runs
 * (step 3 removes it behind a flag); until then each first-window answer is
 * checked against the rows patched in place, so the drift step 3 would leave
 * on screen is measured first.
 *
 * The check is a `slock.state.transition` (domain inbox, event
 * `activity:inplace_check`), one per patched row the answer can judge:
 * outcome `noop` when the answer agrees, `conflict` when it does not, with
 * flat attributes `inbox.inplace.trigger` (message_new / thread_reply /
 * read_persisted), `inbox.inplace.row_existed` (was the row in the list when
 * the event came), `inbox.inplace.result` and `inbox.inplace.sample_rate`
 * (every conflict is sent; one `noop` in 20, so weight noops by 20). An answer still behind the
 * patched row (the RisingWave lag) judges nothing: the row waits for the next
 * answer, up to the stale-list bound; past it the check is `result=expired`
 * (emitExpired).
 *
 * Step 3a (inbox_read_inplace_v1, default off): a persisted read of a listed
 * row that still shows the read sends no re-read (readPersistedSkipsReread).
 * Its row is still noted, so the next first-window answer of the plain All
 * list (another event's re-read, a visibility read) judges it. Such a read is
 * checked with `inbox.inplace.reread` = `skipped` (flag on) or `eligible_sent`
 * (flag off: the same rows, judged by their own re-read), so the two compare.
 *
 * Step 3b (inbox_message_inplace_v1, default off): the same for a live message
 * (message_new, thread_reply) its listed row was patched with in full, on a
 * settled plain All list (liveMessageRereadOutcome); same `inbox.inplace.reread`.
 *
 * Step 2 of the inbox redesign (inbox_row_position_v1, default off,
 * inboxRowPosition.ts): rows the per-row position rule patched are checked
 * the same way, with `inbox.inplace.reread` = `position`. Every check also
 * carries `inbox.inplace.backend`: the judging answer's X-Raft-Inbox-Backend
 * (`risingwave` / `postgres`), copied unchanged; absent when it had none.
 */
import { currentTimeMs } from "@botiverse/raft-shared";
import type { InboxRefreshTrigger } from "@botiverse/raft-shared";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import { hasActivityReadHold } from "./activityReadState";
import { compareActivitySeq, safeSeqToDecimalString } from "./activitySeq";
import { isLateUncounted, noteInboxCounted } from "./inboxCountedIds";
import { getInboxItemKey, inboxItemChannelId } from "./inboxItem";
import type { InboxItem } from "./inboxStore";
import { getPendingReadSeq, loadedProjectionCountsMessage, useMessageStore } from "./messageStore";
import type { Message } from "./messageStore";
import { INBOX_MESSAGE_INPLACE_FLAG_KEY, INBOX_READ_INPLACE_FLAG_KEY, readServerFeatureFlag } from "./serverFeatureFlags";
import { registerServerReset } from "./serverResetRegistry";
import { getAcceptedReadState } from "./readStateSync";
import { useServerStore } from "./serverStore";
import { isOpenThreadReadSaved } from "./openThreadReadSaved";
import { isOwnMessage, liveReplyUnread, threadConversationsOnScreen } from "./visibleConversations";
import { isTaskConversationItem } from "../utils/taskConversation";

export type InPlaceTrigger = Extract<InboxRefreshTrigger, "message_new" | "thread_reply" | "read_persisted">;

/** What a live message does to its row's unread, decided where it arrives (socketBridge). */
export type InboxLiveUnread = {
  trigger: Extract<InPlaceTrigger, "message_new" | "thread_reply">;
  /** One more unread: not the person's own, not read on screen, not under a read hold. */
  counts: boolean;
  /** It counts and @-mentions the person. */
  mention: boolean;
  /**
   * The scope's loaded messages, with this one, gave a complete accepted
   * read-state projection (messageStore addMessage, which runs first): the
   * projection already set the row's unread, so the patch leaves it.
   */
  loaded: boolean;
  /**
   * `sync`: the store already had the message when `message:new` came, from a
   * catch-up (`/messages/sync`, `sync:resume`) or, for my own send, its HTTP
   * answer, so this is its first live patch. `live` otherwise.
   */
  via?: "live" | "sync";
  /** The socket event it came on (`;event=`): `message:new`, or `thread:updated` for a thread reply. */
  event: LiveSocketEvent;
  /** When it came, its scope (the row's channel, DM or thread) was the one on screen (`;open=1`). */
  open: boolean;
};

export type LiveSocketEvent = "message:new" | "thread:updated";

/** The scope on screen: the current channel or DM, or an open thread (panel or task modal). */
function scopeOnScreen(channelId: string): boolean {
  return useMessageStore.getState().currentChannelId === channelId || threadConversationsOnScreen().includes(channelId);
}

type ConversationRow = Exclude<InboxItem, { kind: "mention_action" | "object" }>;
type UnreadFields = Pick<ConversationRow, "unreadCount" | "hasMention" | "firstUnreadMessageId" | "firstMentionMessageId">;

/**
 * The same guards the followed-thread list counts a live reply with
 * (liveReplyUnread: a thread read on screen, own message), plus a read hold
 * still covering the scope, and a read already queued up to the message: the
 * open channel or DM at its bottom auto-reads a live append (messageStore
 * addMessage, which runs first), and that read is what decides it. Call after
 * the hold is released for the message.
 */
export function liveActivityUnread(
  msg: Message,
  trigger: InboxLiveUnread["trigger"],
  event: LiveSocketEvent = trigger === "thread_reply" ? "thread:updated" : "message:new",
): InboxLiveUnread {
  const principalId = useMessageStore.getState().currentUserId;
  const identity = { serverId: useServerStore.getState().current?.id ?? null, principalId };
  const readQueued = typeof msg.seq === "number" && getPendingReadSeq(msg.channelId) >= msg.seq;
  // A conversation shown read counts only while its read will be saved (in use, at the bottom):
  // otherwise it stays unread here until the read is persisted (read_persisted clears it).
  const shown = liveReplyUnread(msg.channelId, msg);
  const unread = shown === "unread" || (shown === "read" && !isOwnMessage(msg) && !isOpenThreadReadSaved(msg.channelId));
  const counts = unread && !readQueued && !hasActivityReadHold(identity, msg.channelId);
  const mention = counts && !!principalId
    && (msg.mentions ?? []).some((mention) => mention.type === "user" && mention.id === principalId);
  return { trigger, counts, mention, loaded: loadedProjectionCountsMessage(msg), event, open: scopeOnScreen(msg.channelId) };
}

// The followed-thread unread rule (infra/risingwave/sql/070-followed-thread-stats-v3.sql):
// these system lines never count.
const UNCOUNTED_THREAD_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set(["channel.self_unfollow_thread", "task.deleted_summary"]);

/** A system message's provenance columns, on `message:new` as the persisted row carries them. */
type SystemMessageProvenance = { causalActorType?: string | null; causalActorId?: string | null; systemSubtype?: string | null };

/**
 * Does a system message count on a thread row? As the server counts it: yes,
 * unless the person caused it or it is one of the uncounted subtypes; never on
 * a task conversation's row (its count is chat replies only,
 * rw_task_conversation_unread_v1). A message without its provenance
 * (`systemSubtype` absent, not null) cannot be judged, and does not count (the
 * re-read brings the server's count). The provenance is on `message:new` as
 * the persisted row's columns; it is not yet a declared field of the event.
 */
function threadSystemMessageCounts(row: ConversationRow, message: Message): boolean {
  if (isTaskConversationItem(row as Parameters<typeof isTaskConversationItem>[0])) return false;
  const provenance = message as Message & SystemMessageProvenance;
  if (!("systemSubtype" in provenance)) return false;
  if (provenance.systemSubtype != null && UNCOUNTED_THREAD_SYSTEM_SUBTYPES.has(provenance.systemSubtype)) return false;
  const viewer = useMessageStore.getState().currentUserId;
  return !(provenance.causalActorType === "user" && !!viewer && provenance.causalActorId === viewer);
}

/**
 * The unread fields of a row a live message advanced. A thread row counts a
 * system line only as the server does (threadSystemMessageCounts); a mention
 * on one still lights the @. An unfollowed thread row counts nothing (the
 * server counts none for it), and a thread row or reply without a seq is left
 * to the re-read: its recency guard is by message id only, so a late older
 * reply would count twice. A message the loaded messages' read-state
 * projection already counted (`live.loaded`) is not counted again.
 */
export function liveUnreadFields(row: ConversationRow, message: Message, live: InboxLiveUnread | undefined): Partial<UnreadFields> {
  if (!live?.counts || live.loaded) return {};
  if (row.kind === "thread" && (row.isFollowing === false || row.latestActivitySeq == null || typeof message.seq !== "number")) return {};
  const counts = !(row.kind === "thread" && message.messageType === "system" && !threadSystemMessageCounts(row, message));
  return {
    ...(counts ? { unreadCount: row.unreadCount + 1 } : {}),
    ...(counts && row.unreadCount === 0 ? { firstUnreadMessageId: message.id } : {}),
    ...(live.mention ? { hasMention: true } : {}),
    ...(live.mention && !row.hasMention ? { firstMentionMessageId: message.id } : {}),
  };
}

/**
 * #244: a live message at or below its row's seq (it came after a newer one,
 * or the row moved past it without counting it): the unread fields to apply
 * when the row has not counted it since its last served answer
 * (inboxCountedIds), else null. Only the unread fields: the row's preview,
 * order and seq stay. A message the loaded projection counted is left to it,
 * and one at or below the scope's accepted read cursor is read.
 */
export function lateLiveUnreadFields(row: ConversationRow, message: Message, live: InboxLiveUnread | undefined): Partial<UnreadFields> | null {
  const scopeId = inboxItemChannelId(row);
  const seq = safeSeqToDecimalString(message.seq);
  if (!live || live.loaded || !scopeId || seq == null || !isLateUncounted(scopeId, message.id, seq)) return null;
  // Read already (another device's read, accepted here): the row's count does not include it.
  const read = getAcceptedReadState(useServerStore.getState().current?.id, scopeId);
  if (read && typeof message.seq === "number" && message.seq <= read.maxReadSeq) return null;
  const fields = liveUnreadFields(row, message, live);
  return Object.keys(fields).length > 0 ? fields : null;
}

/** A live message applied to its row; false when the row's counted set is full (ask for a re-read). */
export function noteLiveApplied(row: ConversationRow, message: Message, live: InboxLiveUnread | undefined): boolean {
  const scopeId = inboxItemChannelId(row);
  const seq = safeSeqToDecimalString(message.seq);
  if (!live || !scopeId || seq == null) return true;
  return noteInboxCounted(scopeId, message.id, seq);
}

/**
 * `skipped` / `eligible_sent`: steps 3a/3b (flag on / off). `position`: the
 * per-row position rule took it (inbox_row_position_v1, inboxRowPosition.ts):
 * no list re-read, at most a re-read of its row.
 */
export type RereadOutcome = "skipped" | "eligible_sent" | "position";

type InPlaceExpectation = {
  /** What patched the row (a list check); for a row check, the trigger of the row re-read. */
  trigger: InboxRefreshTrigger;
  existed: boolean;
  /** The row's seq once patched; the answer is judged only at this seq. */
  seq: string | null;
  /** An event a listed row settled (read_persisted, step 3a; a live message, step 3b): `skipped` its re-read (flag on), or `eligible_sent` (flag off). */
  reread: RereadOutcome | null;
  until: number;
  /** When the event came (`age_ms` at the check). */
  at: number;
  /** What the event was, for outcomeDetail (causeDetail); empty for a read. */
  cause: string;
  /** A read state for the scope arrived after the event (`read_state=1`). */
  readState: boolean;
  /** Answers not judged on: their read cursor was behind the accepted read (`read_behind=`, inboxServedReadBehind). */
  readBehind: number;
  /**
   * A live message's `loaded` (`loaded=1`: the loaded messages' read-state
   * projection had already counted it, so the patch left the unread as
   * projected); null for a read.
   */
  loaded: boolean | null;
  /** A live message's counts / late / via / open / event (`;counts=`, `;late=`, `;via=`, `;open=`, `;event=`); null for a read. */
  live: { counts: boolean; late: boolean; via: "live" | "sync"; open: boolean; event: LiveSocketEvent } | null;
};

// The stale-list bound (inboxStore INBOX_LOCAL_MUTATION_HOLD_MS): an answer
// later than this is not lag any more, and the row is not judged.
const IN_PLACE_CHECK_TTL_MS = 90_000;
// A page whose list is never re-read (Activity not loaded) still notes rows:
// past this many, expired notes go, then the oldest.
const IN_PLACE_EXPECTATIONS_CAP = 200;
const expectations = new Map<string, InPlaceExpectation>();
// Agreements are most checks (~150k-450k a day at full rate): one in this many is sent.
const IN_PLACE_NOOP_SAMPLE = 20;
let noopChecks = 0;
let expiredAbsentChecks = 0;
registerServerReset(() => expectations.clear());

function remember(scopeId: string, expected: Omit<InPlaceExpectation, "until" | "at" | "readState" | "readBehind">): void {
  const now = currentTimeMs();
  expectations.delete(scopeId);
  expectations.set(scopeId, { ...expected, until: now + IN_PLACE_CHECK_TTL_MS, at: now, readState: false, readBehind: 0 });
  if (expectations.size <= IN_PLACE_EXPECTATIONS_CAP) return;
  for (const [key, known] of expectations) if (now > known.until) expectations.delete(key);
  while (expectations.size > IN_PLACE_EXPECTATIONS_CAP) expectations.delete(expectations.keys().next().value!);
}

/**
 * The event, for classifying a drift: `own` (the person sent it),
 * `sender_type`, `message_type`, and on a thread row `following` (as listed
 * here: 1, 0, or - when the row does not say).
 */
function causeDetail(message: Message | undefined, row: ConversationRow | undefined): string {
  if (!message) return "";
  const viewer = useMessageStore.getState().currentUserId;
  const own = message.senderType === "user" && !!viewer && message.senderId === viewer;
  const following = row?.kind !== "thread" ? "" : `;following=${row.isFollowing === undefined ? "-" : row.isFollowing ? 1 : 0}`;
  return `;own=${own ? 1 : 0};sender_type=${message.senderType};message_type=${message.messageType ?? "chat"}${following}`;
}

/** A row patched in place (live message: its `live`), or left as the read made it (read_persisted). */
export function noteInPlaceRow(
  row: ConversationRow,
  event: InboxLiveUnread | "read_persisted",
  message?: Message,
  reread: RereadOutcome | null = null,
  late = false,
): void {
  const scopeId = inboxItemChannelId(row);
  if (!scopeId) return;
  const live = event === "read_persisted" ? undefined : event;
  const trigger = live ? live.trigger : "read_persisted";
  remember(scopeId, { trigger, existed: true, seq: row.latestActivitySeq ?? null, reread, cause: causeDetail(message, row), loaded: live ? live.loaded : null, live: liveDetail(live, late) });
}

function noteAbsent(scopeId: string, trigger: InPlaceTrigger, seq: string | null, message?: Message, live?: InboxLiveUnread): void {
  if (expectations.get(scopeId)?.existed) return;
  remember(scopeId, { trigger, existed: false, seq, reread: null, cause: causeDetail(message, undefined), loaded: live ? live.loaded : null, live: liveDetail(live, false) });
}

function liveDetail(live: InboxLiveUnread | undefined, late: boolean): InPlaceExpectation["live"] {
  return live ? { counts: live.counts, late, via: live.via ?? "live", open: live.open, event: live.event } : null;
}

/** A read state for the scope arrived (read_state:updated): the next check says so. */
export function noteInPlaceReadState(scopeId: string): void {
  const expected = expectations.get(scopeId);
  if (expected) expected.readState = true;
}

/**
 * A live message for a row the list does not show: nothing changes (the
 * re-read brings the row); the check notes whether it came. Every message
 * also goes past the thread rows (receiveThreadReply), so there only a thread
 * or task conversation's own reply is noted.
 */
export function noteInPlaceRowAbsent(message: Message, live: InboxLiveUnread, row: "thread" | "channel"): void {
  const channelType = message.conversationContext?.channelType;
  const subConversation = live.trigger === "thread_reply" || channelType === "thread" || channelType === "task";
  if (row === "thread" && !subConversation) return;
  noteAbsent(message.channelId, live.trigger, safeSeqToDecimalString(message.seq), message, live);
}

/**
 * read_persisted: the read already cleared its row here (inboxStore
 * clearReadForChannel); a reply past the read's boundary may count again, so
 * the row stays as it is and is only noted for the check.
 *
 * Step 3a (#244): returns whether the re-read can be skipped, which needs
 * inbox_read_inplace_v1 on for the read's server, a settled list
 * (`listSettled`: a first window accepted and not the saved page from the
 * last session, and no Activity read in flight: a read-state change drops an
 * answer in flight, and one sent before the read may carry the old count) and
 * the row listed and showing the read (no unread, no @). A row not listed
 * (the Unread filter took it away, or it never was), or one showing unread or
 * an @ again (a reply past the read, or an answer from before it), re-reads
 * as before.
 */
export function readPersistedSkipsReread(
  items: readonly InboxItem[],
  scopeId: string,
  serverId: string | null,
  listSettled: boolean,
): boolean {
  const row = items.find((item): item is ConversationRow => isConversationRow(item) && inboxItemChannelId(item) === scopeId);
  if (!row) {
    noteAbsent(scopeId, "read_persisted", null);
    return false;
  }
  // Showing the read: nothing unread and no @ (a mention-only row keeps its
  // @ through a read: the server's answer is what shows it).
  const eligible = listSettled && row.unreadCount === 0 && !row.hasMention;
  const skip = eligible && readServerFeatureFlag(serverId, INBOX_READ_INPLACE_FLAG_KEY);
  noteInPlaceRow(row, "read_persisted", undefined, skip ? "skipped" : eligible ? "eligible_sent" : null);
  return skip;
}

/**
 * Step 3b (#244): does the in-place patch of `row` (as listed before the live
 * message) leave it as the re-read would serve it? The patch sets the order,
 * the unread and mention fields, the preview and its sender; these are what
 * it does not, so they keep the re-read:
 * - a joint conversation: its frontiers are in the canonical storage's seq
 *   domain, and its senders' names and faces come from another server;
 * - a row whose read-state or Done frontier is not at its display seq (a
 *   zero-reply thread's parent seq, an older server's row): the patch moves
 *   the display seq only, and a Done or a read hold would use the old one;
 * - the person's own message with mentions: it may add a mention_action row;
 * - the person's own message on a row showing unread or a mention: the send
 *   reads the row on the server, and no read state comes to say so;
 * - a system line on a channel or DM row: the server does not count one the
 *   person caused, which the live unread rule (liveReplyUnread) counts;
 * - a system line on a task conversation's row: it may move the task's
 *   status or claimer, which the patch does not set;
 * - a thread row: not followed (the server may follow it now), without a seq,
 *   a reply from another sender (the row's sender name is not patched), or a
 *   counted system line without its provenance (liveUnreadFields leaves it).
 */
function livePatchComplete(row: ConversationRow, message: Message, live: InboxLiveUnread): boolean {
  const joint = row.kind === "thread" ? row.parentChannelType === "joint" : row.channelType === "joint";
  const seq = row.latestActivitySeq;
  if (joint || seq == null || safeSeqToDecimalString(message.seq) == null) return false;
  if (row.readStateLatestActivitySeq !== seq) return false;
  if (row.doneFrontierSeq !== undefined && row.doneFrontierSeq !== seq) return false;
  const viewer = useMessageStore.getState().currentUserId;
  const own = message.senderType === "user" && !!viewer && message.senderId === viewer;
  if (own && ((message.mentions ?? []).length > 0 || row.unreadCount > 0 || row.hasMention)) return false;
  const system = message.messageType === "system";
  if (row.kind !== "thread") {
    // A sender in no roster takes the face the row carries, which the patch drops.
    return !system && (message.senderType !== "external_projection" || message.senderId === row.lastMessageSenderId);
  }
  const taskRow = row.taskNumber != null || isTaskConversationItem(row as Parameters<typeof isTaskConversationItem>[0]);
  if (system && taskRow) return false;
  if (row.isFollowing === false) return false;
  if (message.senderId !== row.latestActivitySenderId || message.senderType !== row.latestActivitySenderType) return false;
  const unprovenancedSystem = system && !("systemSubtype" in message);
  return !(live.counts && unprovenancedSystem);
}

/**
 * Step 3b (#244, inbox_message_inplace_v1): a live message on a listed row
 * (`row`, before the patch) on a settled plain All list (`listSettled`: as
 * step 3a's, and no filter, channel, scope or search, newest first; the channel
 * facet lists the row's channel, which a re-read would add). If the
 * patch leaves the row complete (livePatchComplete), `skipped` (flag on for
 * the current server: no re-read) or `eligible_sent` (flag off: the same
 * message re-reads, the baseline); else null, and it re-reads.
 */
export function liveMessageRereadOutcome(
  row: ConversationRow,
  message: Message,
  live: InboxLiveUnread | undefined,
  listSettled: boolean,
): RereadOutcome | null {
  if (!live || !listSettled || !livePatchComplete(row, message, live)) return null;
  const serverId = useServerStore.getState().current?.id ?? null;
  return readServerFeatureFlag(serverId, INBOX_MESSAGE_INPLACE_FLAG_KEY) ? "skipped" : "eligible_sent";
}

/**
 * Step 3b: the same message again on a row it already moved (a reply comes as
 * message_new and as thread_reply). Skips its re-read only if the first one
 * did, on a list still settled.
 */
export function liveMessageRepeatSkipsReread(row: ConversationRow, listSettled: boolean): boolean {
  const scopeId = inboxItemChannelId(row);
  const expected = scopeId ? expectations.get(scopeId) : undefined;
  return listSettled && !!expected && expected.existed && expected.trigger !== "read_persisted"
    && expected.reread === "skipped" && expected.seq === (row.latestActivitySeq ?? null);
}

/**
 * Step 3b, a skipped re-read: the frontiers move with the display seq
 * (livePatchComplete checked they were at it), so a Done or a read hold
 * covers the new message, as after the re-read.
 */
export function skippedRereadFrontiers(row: ConversationRow, seq: string): Pick<ConversationRow, "readStateLatestActivitySeq" | "doneFrontierSeq"> {
  return { readStateLatestActivitySeq: seq, ...(row.doneFrontierSeq !== undefined ? { doneFrontierSeq: seq } : {}) };
}

/** The unread fields of a row, for a served row still behind one patched in place. */
export function inPlaceUnreadOf(row: ConversationRow): UnreadFields {
  return {
    unreadCount: row.unreadCount,
    hasMention: row.hasMention,
    firstUnreadMessageId: row.firstUnreadMessageId,
    firstMentionMessageId: row.firstMentionMessageId,
  };
}

function isConversationRow(item: InboxItem): item is ConversationRow {
  return item.kind !== "mention_action" && item.kind !== "object";
}

/** Index of `key` among the rows both lists have, so a row only one side lists does not shift it. */
function sharedIndex(rows: readonly InboxItem[], others: ReadonlySet<string>, key: string): number {
  return rows.map(getInboxItemKey).filter((other) => others.has(other)).indexOf(key);
}

/**
 * Keys of the rows listed here at a newer message than the answer has (a live
 * message the view has not caught up with). The answer still sorts them at
 * their old place, so they are left out of the order comparison: a lagging
 * neighbour does not move the judged row.
 */
function aheadOfServed(local: readonly InboxItem[], served: readonly InboxItem[]): Set<string> {
  const servedSeq = new Map(served.filter(isConversationRow).map((row) => [getInboxItemKey(row), row.latestActivitySeq]));
  return new Set(local.filter(isConversationRow)
    .filter((row) => {
      const key = getInboxItemKey(row);
      return servedSeq.has(key) && compareActivitySeq(row.latestActivitySeq, servedSeq.get(key)) > 0;
    })
    .map(getInboxItemKey));
}

/**
 * A first-window answer of the plain All list, newest first: judge each row
 * patched in place against what the answer puts on screen (`served`, after
 * the store's local holds) and the list shown now (`local`). A row of a
 * `readBehind` scope (the answer's read cursor is behind the accepted read,
 * inboxServedReadBehind) is not judged on it: its count is from the older cursor.
 */
export function checkInPlaceDrift(
  local: readonly InboxItem[],
  served: readonly InboxItem[],
  readBehind: ReadonlySet<string> = new Set(),
  backend: string | null = null,
): void {
  if (expectations.size === 0) return;
  const now = currentTimeMs();
  const ahead = aheadOfServed(local, served);
  const localKeys = new Set(local.map(getInboxItemKey).filter((key) => !ahead.has(key)));
  const servedKeys = new Set(served.map(getInboxItemKey).filter((key) => !ahead.has(key)));
  for (const [scopeId, expected] of expectations) {
    const ofScope = (item: InboxItem): item is ConversationRow => isConversationRow(item) && inboxItemChannelId(item) === scopeId;
    const servedRow = served.find(ofScope);
    const localRow = local.find(ofScope);
    if (now > expected.until) {
      expectations.delete(scopeId);
      // Done, read away or moved on since: nothing patched in place was left to judge.
      if (expected.existed && (!localRow || localRow.latestActivitySeq !== expected.seq)) continue;
      emitExpired(localRow ? getInboxItemKey(localRow) : scopeId, expected, now, backend);
      continue;
    }
    let result: string;
    let detail = "";
    if (!expected.existed) {
      // Still absent: maybe the lag; wait. Arrived: the re-read was what showed it.
      if (!servedRow) continue;
      result = "appeared";
      detail = `;served_unread=${servedRow.unreadCount}`;
    } else if (!localRow || localRow.latestActivitySeq !== expected.seq) {
      // Done, read away, or moved on since: nothing patched in place to judge.
      expectations.delete(scopeId);
      continue;
    } else if (!servedRow) {
      result = "absent";
    } else {
      const seqOrder = compareActivitySeq(servedRow.latestActivitySeq, expected.seq);
      if (seqOrder < 0) continue;
      if (readBehind.has(scopeId)) {
        expected.readBehind += 1;
        continue;
      }
      const key = getInboxItemKey(localRow);
      const localIndex = sharedIndex(local, servedKeys, key);
      const servedIndex = sharedIndex(served, localKeys, key);
      const drift = [
        ...(servedRow.unreadCount !== localRow.unreadCount ? ["unread"] : []),
        ...(servedRow.hasMention !== localRow.hasMention ? ["mention"] : []),
        ...(localIndex !== servedIndex ? ["order"] : []),
      ];
      // An answer at a newer message than the patched row, that agrees on
      // the unread, the @ and the order (no row ahead of it here), shows
      // nothing the patch got wrong: a match (`;served_ahead=1`), not drift.
      const servedAheadOnly = seqOrder > 0 && drift.length === 0 && ahead.size === 0;
      if (seqOrder > 0 && !servedAheadOnly) drift.unshift("served_ahead");
      result = drift.length > 0 ? drift.join("+") : "match";
      detail = `;unread=${localRow.unreadCount}/${servedRow.unreadCount};mention=${localRow.hasMention ? 1 : 0}/${servedRow.hasMention ? 1 : 0};order=${localIndex}/${servedIndex};ahead=${ahead.size}${servedAheadOnly ? ";served_ahead=1" : ""}`;
    }
    expectations.delete(scopeId);
    const agrees = result === "match" || result === "appeared";
    // Every conflict; one agreement in IN_PLACE_NOOP_SAMPLE (counted, so it is exact over a session).
    if (agrees && noopChecks++ % IN_PLACE_NOOP_SAMPLE !== 0) continue;
    emitCheck(expected, now, localRow ? getInboxItemKey(localRow) : servedRow ? getInboxItemKey(servedRow) : scopeId, {
      outcome: agrees ? "noop" : "conflict", result, detail, sampleRate: agrees ? IN_PLACE_NOOP_SAMPLE : 1, backend,
    });
  }
}

/**
 * A check no answer judged within the stale-list bound (only answers behind
 * the patched row or behind the accepted read, or none): `result=expired`,
 * with `read_behind=N` always (0: no answer behind the read), so fewer
 * conflicts are not just fewer checks. Said on the first answer past the
 * bound (a note the cap drops, on a page whose Activity is not re-read, says
 * nothing). Every patched row's (`existed=1`); one unlisted row's in
 * IN_PLACE_NOOP_SAMPLE (an unfollowed thread's replies never list it).
 */
function emitExpired(entityId: string, expected: InPlaceExpectation, now: number, backend: string | null): void {
  if (!expected.existed && expiredAbsentChecks++ % IN_PLACE_NOOP_SAMPLE !== 0) return;
  emitCheck(expected, now, entityId, {
    outcome: "noop", result: "expired", detail: "", sampleRate: expected.existed ? 1 : IN_PLACE_NOOP_SAMPLE, readBehindAlways: true, backend,
  });
}

function emitCheck(
  expected: InPlaceExpectation,
  now: number,
  entityId: string,
  check: { outcome: "noop" | "conflict"; result: string; detail: string; sampleRate: number; readBehindAlways?: boolean; backend: string | null; scope?: "list" | "row"; notJudgedCause?: AuditNotJudgedCause },
): void {
  const readBehind = expected.readBehind > 0 || check.readBehindAlways ? `;read_behind=${expected.readBehind}` : "";
  emitStateTransitionTrace({
    domain: "inbox",
    event: "activity:inplace_check",
    entityId,
    outcome: check.outcome,
    // As before step 3a, then `;reread=<outcome>` for a read that could skip its re-read, then the
    // event's cause, its age, whether a read state arrived meanwhile, and for a live message
    // whether the loaded messages' projection had already counted it, whether it counted, came
    // late (below the row's seq) and was first stored by a catch-up (#244 diagnostics).
    outcomeDetail: `trigger=${expected.trigger};existed=${expected.existed ? 1 : 0};result=${check.result}${check.detail}${expected.reread ? `;reread=${expected.reread}` : ""}${expected.cause};age_ms=${now - expected.at};read_state=${expected.readState ? 1 : 0}${readBehind}${expected.loaded === null ? "" : `;loaded=${expected.loaded ? 1 : 0}`}${expected.live ? `;counts=${expected.live.counts ? 1 : 0};late=${expected.live.late ? 1 : 0};via=${expected.live.via};open=${expected.live.open ? 1 : 0};event=${expected.live.event}` : ""}`,
    touched: 1,
    timestamp: now,
  }, {
    "inbox.inplace.trigger": expected.trigger,
    "inbox.inplace.row_existed": expected.existed ? "true" : "false",
    "inbox.inplace.result": check.result,
    "inbox.inplace.sample_rate": String(check.sampleRate),
    // `list`: judged by a list answer (order included); `row`: by a row re-read's answer (no order).
    "inbox.inplace.scope": check.scope ?? "list",
    ...(expected.reread ? { "inbox.inplace.reread": expected.reread } : {}),
    // The answer's X-Raft-Inbox-Backend (risingwave / postgres), as the server sent it.
    ...(check.backend ? { "inbox.inplace.backend": check.backend } : {}),
    // Why an audit was not judged (result=not_judged): see AuditNotJudgedCause.
    ...(check.notJudgedCause ? { "inbox.inplace.not_judged_cause": check.notJudgedCause } : {}),
  });
}

/**
 * #244 step 2 (inbox_row_position_v1): a row re-read's answer judges its own
 * rows. For each answered row (`served`, after the store's holds) against the
 * row shown when it came (`local`): unread count, @ and position (its
 * latestActivitySeq), no order. Same event and sampling as the list check
 * (every conflict, one agreement in IN_PLACE_NOOP_SAMPLE), with
 * `inbox.inplace.trigger` = the trigger the row was re-read for
 * (`ambiguous_seq`, `row_inversion`, ...), `inbox.inplace.scope` = `row` and
 * the answer's `inbox.inplace.backend`.
 *
 * An audit (`audit` set, trigger `position_audit`) is always sent, agreement
 * or not, so every audit scheduled is one check; one whose row moved again
 * before its answer (`audit.moved`) is `result=not_judged` with cause `moved`
 * (recordAuditNotJudged).
 *
 * An audit answer behind the row (its position below the one the patch left:
 * the view a moment behind the live message) cannot judge the messages above
 * it. It judges `merged`, the row once the answer is taken (the answer plus
 * the live messages above its position), against the patched row: verified
 * only up to the answer's position, so its result says so
 * (`match_up_to_answer`, or the drift with `_up_to_answer`), with
 * `answer_behind=1` (Tenny, #triage:#244). It then returns true: the caller
 * reads the row once more a few seconds later (`audit.followup`), judged in
 * full; a follow-up whose answer is still behind is `not_judged` with cause
 * `answer_behind`.
 */
export function checkRowAnswerDrift(
  local: ConversationRow,
  served: ConversationRow,
  trigger: InboxRefreshTrigger,
  backend: string | null,
  audit: { moved: boolean; followup?: boolean } | null = null,
  merged: ConversationRow | null = null,
  mergeNote = "",
): boolean {
  const localSeq = local.latestActivitySeq ?? null;
  const servedSeq = served.latestActivitySeq ?? null;
  const followup = audit?.followup ? ";followup=1" : "";
  const detail = `;unread=${local.unreadCount}/${served.unreadCount};mention=${local.hasMention ? 1 : 0}/${served.hasMention ? 1 : 0};position=${localSeq ?? "-"}/${servedSeq ?? "-"}${followup}`;
  // An audited row that moved again before the answer (a newer live message, an answer) is not judged.
  if (audit?.moved) {
    recordAuditNotJudged(local, "moved", backend, detail);
    return false;
  }
  const behind = audit !== null && localSeq !== null && servedSeq !== null && compareActivitySeq(servedSeq, localSeq) < 0;
  if (behind && audit.followup) {
    recordAuditNotJudged(local, "answer_behind", backend, detail);
    return false;
  }
  const judged = behind && merged ? merged : served;
  const judgedSeq = judged.latestActivitySeq ?? null;
  const now = currentTimeMs();
  const drift = [
    ...(judged.unreadCount !== local.unreadCount ? ["unread"] : []),
    ...(judged.hasMention !== local.hasMention ? ["mention"] : []),
    ...(localSeq !== judgedSeq ? ["position"] : []),
  ];
  const agrees = drift.length === 0;
  const sampled = agrees && !audit;
  if (sampled && noopChecks++ % IN_PLACE_NOOP_SAMPLE !== 0) return false;
  const upToAnswer = behind && merged !== null;
  emitCheck(rowCheckExpectation(trigger, localSeq, now), now, getInboxItemKey(local), {
    outcome: agrees ? "noop" : "conflict",
    result: `${agrees ? "match" : drift.join("+")}${upToAnswer ? "_up_to_answer" : ""}`,
    detail: `${detail}${upToAnswer ? `;answer_behind=1;merged=${judged.unreadCount}/${judgedSeq ?? "-"}${mergeNote}` : ""}`,
    sampleRate: sampled ? IN_PLACE_NOOP_SAMPLE : 1,
    backend,
    scope: "row",
  });
  return upToAnswer;
}

/**
 * Why a scheduled audit (`position_audit`) was not judged. Each is the one
 * check its audit ends in, so audits scheduled = checks with trigger
 * `position_audit`:
 * - `moved`: the row moved again before the answer (a newer live message, an answer).
 * - `superseded_by_reread`: a re-read of the row was asked for while the audit waited; it takes the audit's place.
 * - `page_hidden`: the page was hidden when the audit's read was due (a hidden page reads nothing).
 * - `read_changed`: a read changed while the audit's read was in flight (the answer may predate it).
 * - `request_failed`: the audit's read failed.
 * - `row_missing`: the answer left the row out (no longer the viewer's Activity row).
 * - `row_unlisted`: the answer had the row, but it is no longer listed here (taken off meanwhile, or a local Done holds it out).
 * - `server_switched`: the server changed before the audit's read or its answer.
 * - `answer_behind`: a follow-up read (after an audit's answer was behind the row) whose answer is still behind it.
 */
export type AuditNotJudgedCause =
  | "moved"
  | "superseded_by_reread"
  | "page_hidden"
  | "read_changed"
  | "request_failed"
  | "row_missing"
  | "row_unlisted"
  | "server_switched"
  | "answer_behind";

/**
 * An audit that ends without a judgment: `activity:inplace_check`, outcome
 * noop, `result=not_judged`, `inbox.inplace.not_judged_cause` = `cause`,
 * trigger `position_audit`, scope=row, the answer's backend when there was
 * one; always sent (sample_rate 1). `row`: the row as the patch left it.
 */
export function recordAuditNotJudged(row: ConversationRow, cause: AuditNotJudgedCause, backend: string | null = null, detail = ""): void {
  const now = currentTimeMs();
  const seq = row.latestActivitySeq ?? null;
  emitCheck(rowCheckExpectation("position_audit", seq, now), now, getInboxItemKey(row), {
    outcome: "noop",
    result: "not_judged",
    detail: `;cause=${cause}${detail}`,
    sampleRate: 1,
    backend,
    scope: "row",
    notJudgedCause: cause,
  });
}

function rowCheckExpectation(trigger: InboxRefreshTrigger, seq: string | null, now: number): InPlaceExpectation {
  return { trigger, existed: true, seq, reread: "position", until: now, at: now, cause: "", readState: false, readBehind: 0, loaded: null, live: null };
}

export function resetInPlaceDriftForTests(): void {
  expectations.clear();
  noopChecks = 0;
  expiredAbsentChecks = 0;
}
