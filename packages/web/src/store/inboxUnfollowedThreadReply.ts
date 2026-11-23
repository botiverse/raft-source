/**
 * #244 (inbox_row_position_v1, Tenny #triage:#244 ce3b0870): a
 * `thread:updated` for a thread this person does not follow, and the loaded
 * Activity list does not show, re-reads nothing. The frame goes to the whole
 * parent-channel room (public parent) or to every member's user room
 * (private / DM parent), followers or not (server
 * packages/server/src/services/messageService.ts:3184-3227,
 * emitPlainThreadUpdated), and such a reply cannot list the thread for a
 * non-follower: its full first-page re-read (`realtime_fallback`,
 * `thread_reply`, `not_listed`) changed nothing. Everything else the handler
 * does (summary, followed list, read holds) is unchanged; only the re-read
 * goes.
 *
 * threadReplyMayListUnfollowed says when the server's Activity query could
 * still list (or move) the thread for this person after this reply; then, and
 * whenever anything is not known, the list re-reads as before. Citations are
 * packages/server/src/... at the #15286 base (18975b7565).
 *
 * Skipped re-reads are counted (`activity:unfollowed_reread_skipped`), and
 * the row's absent note says `reread=unfollowed`, so a later list answer that
 * does show the row is a conflict (`result=appeared`), not an agreement. A
 * skipped thread that turns out followed (the followed-thread list the
 * handler already reloads names it: say a follow from another device the
 * summary does not know yet) re-reads then (`activity:unfollowed_reread_recovered`).
 */
import { currentTimeMs } from "@botiverse/raft-shared";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import { noteAbsentRereadSkipped } from "./inboxInPlaceUnread";
import type { LiveRowReceipt } from "./inboxInPlaceUnread";
import type { ThreadUpdatedFrame } from "./inboxInsertedThreadRow";
import { rowPositionOn } from "./inboxRowPosition";
import { hasInboxLocalRowHold, inboxListSettled, requestInboxBackgroundRefresh, useInboxStore } from "./inboxStore";
import type { InboxFilter } from "./inboxStore";
import { isScopeMarkedUnread } from "./markedUnreadStore";
import { useMessageStore } from "./messageStore";
import type { Message } from "./messageStore";
import { registerServerReset } from "./serverResetRegistry";
import { useServerStore } from "./serverStore";
import { useThreadStore } from "./threadStore";
import type { FollowedThread } from "./threadStore";

type ThreadState = ReturnType<typeof useThreadStore.getState>;

/**
 * This person's follow of the thread as this client knows it: `followed`
 * (followed here, in the followed-thread list, or served `followed: true`),
 * `unfollowed_here` (an Unfollow in this session: the server keeps the row
 * with unfollowed_at), `not_followed` (served `followed: false`: no active
 * follow, which is either no row or an explicit unfollow, channelService.ts:11222-11229)
 * or `unknown` (no served answer: an older server, no summary).
 */
export type KnownThreadFollow = "followed" | "unfollowed_here" | "not_followed" | "unknown";

/** Why the thread may be listed, so the list re-reads; null: it cannot be, no re-read. */
export type UnfollowedListingCause =
  | "follow_unknown" | "followed" | "joint" | "system" | "own_reply" | "mentioned" | "parent_unknown" | "authored" | "overlay";

export type UnfollowedReplyFacts = {
  viewerId: string | null;
  reply: Pick<Message, "senderType" | "senderId" | "messageType" | "mentions" | "conversationContext">;
  follow: KnownThreadFollow;
  /** The parent message as loaded here (its channel's messages), if it is. */
  parent: Pick<Message, "senderType" | "senderId" | "messageType"> | undefined;
  filter: InboxFilter;
  /** The loaded list is settled and has every row of its query (no more pages). */
  listComplete: boolean;
};

const PLAIN_PARENT_TYPES: ReadonlySet<string> = new Set(["channel", "private", "dm"]);

/**
 * Whether the server's Activity query could list this thread for the viewer,
 * or move it, after this reply although the viewer does not follow it.
 * Server code (packages/server/src):
 *
 * - `follow_unknown` / `followed`: no served follow state, or followed. A
 *   followed thread is listed while its parent is visible (the followed arm,
 *   services/channelService.ts:16716-16730), and the reply clears a Done for
 *   every active follower (clearThreadDoneForAll, channelService.ts:17829-17841):
 *   #15286 inserts it or the list re-reads.
 * - `joint`: a joint (or unknown) parent: its own emit and per-projection
 *   follows (messageService.ts:3490-3612): not judged, re-read.
 * - `system`: a system line comes with follows of its own: an action card's
 *   result reply follows its requester (services/actionCardsService.ts:3292-3300,
 *   reason `mentioned`, reactivating an unfollow), the task-created notice its
 *   source author (services/taskConversationNotice.ts:538).
 * - `own_reply`: the replier follows (`replied`, reactivateUnfollowed:
 *   messageService.ts:3643-3652; joint 3514-3522), before the emit
 *   (messageService.ts:3765-3774).
 * - `mentioned`: a mention of the viewer follows a parent-channel member
 *   (`mentioned`, reactivating an unfollow: messageService.ts:12274-12290,
 *   planDirectMentionThreadFollow 961-971; joint 10040-10060) and lists a
 *   public thread for an outsider (the notified outsider-mention arm,
 *   channelService.ts:16236-16290). Its own event also updates Activity; the
 *   re-read stays for the follow.
 * - `parent_unknown` / `authored`: the parent's author follows on another's
 *   reply (`authored`, no row needed, before the emit: messageService.ts:3655-3671,
 *   isFollowableThreadAuthor 1008-1013; joint 1358-1394, 3536-3560). Only the
 *   loaded parent says who wrote it.
 * - `overlay`: Activity All lists explicitly unfollowed, not-Done threads
 *   too (getActiveUnfollowedInboxItems state `unfollowed_active`,
 *   channelService.ts:14040-14070, 12366-12376; merged by
 *   getUnifiedActivityAllInboxItems 15634-15730, for `filter === "all"` only,
 *   routes/channels.ts:1735), placed by their latest reply, so a reply moves
 *   one past the loaded window to the top. A served `followed: false` does
 *   not say whether such a row exists, so on All only a complete list (no
 *   more pages, settled) proves there is none: the overlay is capped at
 *   max(101, offset + limit + 1) rows (15655-15657), and a capped overlay
 *   makes the page longer than its limit, so hasMore (15727). A row Done
 *   before an unfollow keeps its Done (writeThreadUnfollowRows 17625-17652;
 *   clearThreadDoneForAll skips unfollowed rows) and stays off it. An
 *   Unfollow in this session (`unfollowed_here`) may be such a row: re-read.
 *   Unread / Mentions lists have no overlay: an unfollowed thread has no
 *   unread there (unread joins active follows, channelService.ts:11232-11237)
 *   and an outsider-mention row is anchored to its mention (16254), not to
 *   later replies.
 *
 * A private or DM parent needs nothing more: its frame goes to every member
 * (messageService.ts:3216-3221), and the Activity query lists a thread there
 * only for a following member (channelService.ts:16112-16117). Task
 * conversations have no `thread:updated` (messageService.ts:3765, thread
 * only); their assignment follows (taskConversationService.ts:495) are theirs.
 */
export function threadReplyMayListUnfollowed(facts: UnfollowedReplyFacts): UnfollowedListingCause | null {
  const { viewerId, reply, follow, parent, filter, listComplete } = facts;
  if (!viewerId || follow === "unknown") return "follow_unknown";
  if (follow === "followed") return "followed";
  const parentType = reply.conversationContext?.parentChannelType;
  if (reply.conversationContext?.channelType !== "thread" || !parentType || !PLAIN_PARENT_TYPES.has(parentType)) return "joint";
  if (reply.messageType === "system" || reply.senderId === "system") return "system";
  if (reply.senderType === "user" && reply.senderId === viewerId) return "own_reply";
  if ((reply.mentions ?? []).some((mention) => mention.type === "user" && mention.id === viewerId)) return "mentioned";
  if (!parent) return "parent_unknown";
  if (parent.messageType !== "system" && parent.senderType === "user" && parent.senderId === viewerId) return "authored";
  if (filter === "all" && (follow === "unfollowed_here" || !listComplete)) return "overlay";
  return null;
}

/** As isThreadFollowed, but saying when it is not known. */
export function knownThreadFollow(
  state: Pick<ThreadState, "followOverrides" | "summaries" | "followedThreads">,
  parentMessageId: string,
  threadChannelId: string,
): KnownThreadFollow {
  const override = state.followOverrides[parentMessageId];
  if (override !== undefined) return override ? "followed" : "unfollowed_here";
  if (state.followedThreads.some((thread) => thread.threadChannelId === threadChannelId || thread.parentMessageId === parentMessageId)) return "followed";
  const served = state.summaries[parentMessageId]?.followed;
  return served === undefined ? "unknown" : served ? "followed" : "not_followed";
}

// Skipped threads (thread channel -> its server, until when) the followed-thread list may still name.
const RECOVER_TTL_MS = 10 * 60_000;
const RECOVER_CAP = 200;
const skipped = new Map<string, { serverId: string; until: number }>();
let unwatch: (() => void) | null = null;
registerServerReset(() => { skipped.clear(); unwatch?.(); unwatch = null; });

function recoverFollowed(followedThreads: readonly FollowedThread[]): void {
  const now = currentTimeMs();
  const serverId = useServerStore.getState().current?.id ?? null;
  let recovered = 0;
  for (const [threadChannelId, entry] of skipped) {
    if (now > entry.until || entry.serverId !== serverId) skipped.delete(threadChannelId);
    else if (followedThreads.some((thread) => thread.threadChannelId === threadChannelId)) {
      skipped.delete(threadChannelId);
      recovered += 1;
      emitStateTransitionTrace({
        domain: "inbox", event: "activity:unfollowed_reread_recovered", entityId: `thread:${threadChannelId}`,
        outcome: "applied", outcomeDetail: `trigger=thread_reply;age_ms=${RECOVER_TTL_MS - (entry.until - now)}`, touched: 1, timestamp: now,
      }, { "inbox.inplace.trigger": "thread_reply", "inbox.inplace.reread": "unfollowed" });
    }
  }
  if (recovered > 0) requestInboxBackgroundRefresh("thread_reply", "not_listed");
  if (skipped.size === 0) { unwatch?.(); unwatch = null; }
}

function rememberSkipped(threadChannelId: string, serverId: string): void {
  skipped.delete(threadChannelId);
  skipped.set(threadChannelId, { serverId, until: currentTimeMs() + RECOVER_TTL_MS });
  while (skipped.size > RECOVER_CAP) skipped.delete(skipped.keys().next().value!);
  unwatch ??= useThreadStore.subscribe((state, previous) => {
    if (state.followedThreads !== previous.followedThreads) recoverFollowed(state.followedThreads);
  });
}

/**
 * After receiveUnlistedThreadReply (`receipt`, #15286): true when its
 * `not_listed` re-read is skipped because the thread cannot be listed
 * (threadReplyMayListUnfollowed). Any other receipt, flag off (or another
 * server than the frame's), a list not settled, a local Done / read hold or
 * Mark as Unread on the row, and every cause above keep the re-read.
 * `serverId`: the server the frame came on. The reply gap's re-read comes
 * before this and is not touched.
 */
export function skipUnfollowedThreadReread(frame: ThreadUpdatedFrame, receipt: LiveRowReceipt, serverId: string | null): boolean {
  const reply = frame.latestReply;
  if (receipt.skipped || receipt.refused !== "not_listed" || !reply || reply.channelId !== frame.threadChannelId) return false;
  if (!serverId || serverId !== (useServerStore.getState().current?.id ?? null) || !rowPositionOn(serverId)) return false;
  const inbox = useInboxStore.getState();
  if (!inboxListSettled(inbox)) return false;
  if (hasInboxLocalRowHold(`thread:${frame.threadChannelId}`) || isScopeMarkedUnread(frame.threadChannelId)) return false;
  const follow = knownThreadFollow(useThreadStore.getState(), frame.parentMessageId, frame.threadChannelId);
  const messages = useMessageStore.getState();
  const parentChannelId = reply.conversationContext?.parentChannelId;
  const parent = parentChannelId ? messages.channelMessages[parentChannelId]?.find((message) => message.id === frame.parentMessageId) : undefined;
  const listComplete = !inbox.hasMore;
  const cause = threadReplyMayListUnfollowed({ viewerId: messages.currentUserId, reply, follow, parent, filter: inbox.filter, listComplete });
  if (cause !== null) return false;
  noteAbsentRereadSkipped(frame.threadChannelId);
  rememberSkipped(frame.threadChannelId, serverId);
  emitStateTransitionTrace({
    domain: "inbox", event: "activity:unfollowed_reread_skipped", entityId: `thread:${frame.threadChannelId}`, outcome: "noop",
    outcomeDetail: `trigger=thread_reply;follow=${follow};filter=${inbox.filter};complete=${listComplete ? 1 : 0};parent_type=${reply.conversationContext?.parentChannelType ?? "-"};sender_type=${reply.senderType}`,
    touched: 1, timestamp: currentTimeMs(),
  }, { "inbox.inplace.trigger": "thread_reply", "inbox.inplace.reread": "unfollowed" });
  return true;
}

/** Test seam: forget skipped threads and stop watching the followed-thread list. */
export function resetUnfollowedThreadReplyForTests(): void {
  skipped.clear();
  unwatch?.();
  unwatch = null;
}
