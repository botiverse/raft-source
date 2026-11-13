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
 * answer, up to the stale-list bound.
 *
 * Step 3a (inbox_read_inplace_v1, default off): a persisted read of a listed
 * row that still shows the read sends no re-read (readPersistedSkipsReread).
 * Its row is still noted, so the next first-window answer of the plain All
 * list (another event's re-read, a visibility read) judges it. Such a read is
 * checked with `inbox.inplace.reread` = `skipped` (flag on) or `eligible_sent`
 * (flag off: the same rows, judged by their own re-read), so the two compare.
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
import { INBOX_READ_INPLACE_FLAG_KEY, readServerFeatureFlag } from "./serverFeatureFlags";
import { registerServerReset } from "./serverResetRegistry";
import { getAcceptedReadState } from "./readStateSync";
import { useServerStore } from "./serverStore";
import { isOpenThreadReadSaved } from "./openThreadReadSaved";
import { isOwnMessage, liveReplyUnread } from "./visibleConversations";
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
};

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
export function liveActivityUnread(msg: Message, trigger: InboxLiveUnread["trigger"]): InboxLiveUnread {
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
  return { trigger, counts, mention, loaded: loadedProjectionCountsMessage(msg) };
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

type RereadOutcome = "skipped" | "eligible_sent";

type InPlaceExpectation = {
  trigger: InPlaceTrigger;
  existed: boolean;
  /** The row's seq once patched; the answer is judged only at this seq. */
  seq: string | null;
  /** read_persisted a listed row settled (step 3a): `skipped` its re-read (flag on), or `eligible_sent` (flag off). */
  reread: RereadOutcome | null;
  until: number;
  /** When the event came (`age_ms` at the check). */
  at: number;
  /** What the event was, for outcomeDetail (causeDetail); empty for a read. */
  cause: string;
  /** A read state for the scope arrived after the event (`read_state=1`). */
  readState: boolean;
  /**
   * A live message's `loaded` (`loaded=1`: the loaded messages' read-state
   * projection had already counted it, so the patch left the unread as
   * projected); null for a read.
   */
  loaded: boolean | null;
  /** A live message's counts / late / via (`;counts=`, `;late=`, `;via=`); null for a read. */
  live: { counts: boolean; late: boolean; via: "live" | "sync" } | null;
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
registerServerReset(() => expectations.clear());

function remember(scopeId: string, expected: Omit<InPlaceExpectation, "until" | "at" | "readState">): void {
  const now = currentTimeMs();
  expectations.delete(scopeId);
  expectations.set(scopeId, { ...expected, until: now + IN_PLACE_CHECK_TTL_MS, at: now, readState: false });
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
  return live ? { counts: live.counts, late, via: live.via ?? "live" } : null;
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
 * the row listed and showing the read. A row not listed (the Unread filter
 * took it away, or it never was), or one showing unread again (a reply past
 * the read, or an answer from before it), re-reads as before.
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
  const eligible = listSettled && row.unreadCount === 0;
  const skip = eligible && readServerFeatureFlag(serverId, INBOX_READ_INPLACE_FLAG_KEY);
  noteInPlaceRow(row, "read_persisted", undefined, skip ? "skipped" : eligible ? "eligible_sent" : null);
  return skip;
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
 * the store's local holds) and the list shown now (`local`).
 */
export function checkInPlaceDrift(local: readonly InboxItem[], served: readonly InboxItem[]): void {
  if (expectations.size === 0) return;
  const now = currentTimeMs();
  const ahead = aheadOfServed(local, served);
  const localKeys = new Set(local.map(getInboxItemKey).filter((key) => !ahead.has(key)));
  const servedKeys = new Set(served.map(getInboxItemKey).filter((key) => !ahead.has(key)));
  for (const [scopeId, expected] of expectations) {
    if (now > expected.until) {
      expectations.delete(scopeId);
      continue;
    }
    const ofScope = (item: InboxItem): item is ConversationRow => isConversationRow(item) && inboxItemChannelId(item) === scopeId;
    const servedRow = served.find(ofScope);
    const localRow = local.find(ofScope);
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
      const key = getInboxItemKey(localRow);
      const localIndex = sharedIndex(local, servedKeys, key);
      const servedIndex = sharedIndex(served, localKeys, key);
      const drift = [
        ...(seqOrder > 0 ? ["served_ahead"] : []),
        ...(servedRow.unreadCount !== localRow.unreadCount ? ["unread"] : []),
        ...(servedRow.hasMention !== localRow.hasMention ? ["mention"] : []),
        ...(localIndex !== servedIndex ? ["order"] : []),
      ];
      result = drift.length > 0 ? drift.join("+") : "match";
      detail = `;unread=${localRow.unreadCount}/${servedRow.unreadCount};mention=${localRow.hasMention ? 1 : 0}/${servedRow.hasMention ? 1 : 0};order=${localIndex}/${servedIndex};ahead=${ahead.size}`;
    }
    expectations.delete(scopeId);
    const agrees = result === "match" || result === "appeared";
    // Every conflict; one agreement in IN_PLACE_NOOP_SAMPLE (counted, so it is exact over a session).
    if (agrees && noopChecks++ % IN_PLACE_NOOP_SAMPLE !== 0) continue;
    emitStateTransitionTrace({
      domain: "inbox",
      event: "activity:inplace_check",
      entityId: localRow ? getInboxItemKey(localRow) : servedRow ? getInboxItemKey(servedRow) : scopeId,
      outcome: agrees ? "noop" : "conflict",
      // As before step 3a, then `;reread=<outcome>` for a read that could skip its re-read, then the
      // event's cause, its age, whether a read state arrived meanwhile, and for a live message
      // whether the loaded messages' projection had already counted it, whether it counted, came
      // late (below the row's seq) and was first stored by a catch-up (#244 diagnostics).
      outcomeDetail: `trigger=${expected.trigger};existed=${expected.existed ? 1 : 0};result=${result}${detail}${expected.reread ? `;reread=${expected.reread}` : ""}${expected.cause};age_ms=${now - expected.at};read_state=${expected.readState ? 1 : 0}${expected.loaded === null ? "" : `;loaded=${expected.loaded ? 1 : 0}`}${expected.live ? `;counts=${expected.live.counts ? 1 : 0};late=${expected.live.late ? 1 : 0};via=${expected.live.via}` : ""}`,
      touched: 1,
      timestamp: now,
    }, {
      "inbox.inplace.trigger": expected.trigger,
      "inbox.inplace.row_existed": expected.existed ? "true" : "false",
      "inbox.inplace.result": result,
      "inbox.inplace.sample_rate": String(agrees ? IN_PLACE_NOOP_SAMPLE : 1),
      ...(expected.reread ? { "inbox.inplace.reread": expected.reread } : {}),
    });
  }
}

export function resetInPlaceDriftForTests(): void {
  expectations.clear();
  noopChecks = 0;
}
