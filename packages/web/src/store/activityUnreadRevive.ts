/**
 * Under an Unread filter a row read here leaves the store, and the list keeps
 * its last copy, read, where it was (activityUnreadSnapshot). A live message
 * that makes that conversation unread again finds no listed row to patch: it
 * patches the kept copy instead, which comes back into the store unread, on
 * top, as the All list moves its row (inboxStore receiveChannelMessage /
 * receiveThreadReply). Only a message newer than the copy that counts for
 * this viewer (`live.counts`, liveUnreadFields), on the plain Unread list
 * newest first; anything else is left to the re-read, as before.
 *
 * Its re-read often comes before the read model has the message, and leaves
 * the row out: as for a row Done hid (task #92), the catch-up counts a missing
 * revived row as behind and re-reads (catchUpVerdict), while the list shows
 * its copy read instead of dropping it (`keepShown`, noted read by inboxStore
 * only once that answer is the current one).
 */
import { compareActivitySeq, safeSeqToDecimalString } from "./activitySeq";
import { keptActivityUnreadRow } from "./activityUnreadSnapshot";
import { liveUnreadFields } from "./inboxInPlaceUnread";
import type { InboxLiveUnread } from "./inboxInPlaceUnread";
import type { ChannelInboxItem, InboxItem, InboxState, ThreadInboxItem } from "./inboxStore";
import type { Message } from "./messageStore";

/**
 * The live verdict for a revived row: the loaded messages' read-state
 * projection (`live.loaded`) patches only rows the store lists, so it set
 * nothing on a kept copy, and this message counts on it.
 */
export function reviveLive(live: InboxLiveUnread | undefined): InboxLiveUnread | undefined {
  return live?.loaded ? { ...live, loaded: false } : live;
}

function revives<T extends ChannelInboxItem | ThreadInboxItem>(state: InboxState, row: T | undefined, message: Message, live: InboxLiveUnread | undefined): T | undefined {
  if (!row || !live?.counts || state.sortDirection !== "desc" || state.searchQuery) return undefined;
  if (state.filter !== "unread" && !(state.filter === "unread_mentions" && live.mention)) return undefined;
  const seq = safeSeqToDecimalString(message.seq);
  if (seq == null || row.latestActivitySeq == null || compareActivitySeq(seq, row.latestActivitySeq) <= 0) return undefined;
  return (liveUnreadFields(row, message, reviveLive(live)).unreadCount ?? 0) > 0 ? row : undefined;
}

/** The kept read copy of this message's channel or DM row a live message brings back unread, if any. */
export function keptChannelRowToRevive(state: InboxState, message: Message, live: InboxLiveUnread | undefined): ChannelInboxItem | undefined {
  const kept = keptActivityUnreadRow(`channel:${message.channelId}`) ?? keptActivityUnreadRow(`dm:${message.channelId}`);
  const row = kept && (kept.kind === "channel" || kept.kind === "dm") ? kept : undefined;
  return revives(state, row, message, live);
}

/** The kept read copy of this reply's thread row a live reply brings back unread, if any. */
export function keptThreadRowToRevive(state: InboxState, message: Message, live: InboxLiveUnread | undefined): ThreadInboxItem | undefined {
  const kept = keptActivityUnreadRow(`thread:${message.channelId}`);
  return revives(state, kept?.kind === "thread" ? kept : undefined, message, live);
}

/**
 * The newest live message inboxStore chases with re-reads (its catch-up).
 * `reopen`: a row Done hid (task #92) or a revived one, `revived` its key.
 */
export type InboxCatchUpTarget = { channelId: string; seq: string; reopen: boolean; revived: string | null };

/** An answer's catch-up verdict: re-read again (`behind`), and the revived row it left out (`keepShown`), if any. */
export type CatchUpVerdict = { behind: boolean; keepShown: string | null };

export const NOT_BEHIND: CatchUpVerdict = { behind: false, keepShown: null };

/** The catch-up target's row in a served answer: its channel or DM row, or, for a revived thread row, the thread's row. */
function catchUpRow(served: readonly InboxItem[], target: InboxCatchUpTarget): ChannelInboxItem | ThreadInboxItem | undefined {
  const thread = target.revived?.startsWith("thread:") === true;
  return served.find((item): item is ChannelInboxItem | ThreadInboxItem => thread
    ? item.kind === "thread" && item.threadChannelId === target.channelId
    : (item.kind === "channel" || item.kind === "dm") && item.channelId === target.channelId);
}

/**
 * Does this served first window still serve the catch-up target's row older
 * than its message? A missing row is not behind: the filter may leave it out,
 * and no answer can tell. Except for a row Done hid (task #92) or a revived
 * one: missing is behind. Pure: the answer may yet be superseded.
 */
export function catchUpVerdict(served: readonly InboxItem[], target: InboxCatchUpTarget | null): CatchUpVerdict {
  if (!target) return NOT_BEHIND;
  const row = catchUpRow(served, target);
  if (row === undefined) return { behind: target.reopen, keepShown: target.revived };
  return { behind: compareActivitySeq(row.latestActivitySeq, target.seq) < 0, keepShown: null };
}
