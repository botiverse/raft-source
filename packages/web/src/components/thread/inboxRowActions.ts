import { toast } from "@botiverse/raft-ui";
import type { IntlShape } from "react-intl";
import api from "../../api/client";
import { trackActivityMark } from "../../analytics/activity";
import { toggleChannelActivityMute } from "../../store/channelActivityMuteToggle";
import { canToggleActivityMute } from "../../store/channelDomain";
import type { Channel } from "../../store/channelStore";
import { getInboxItemKey, useInboxStore } from "../../store/inboxStore";
import { inboxItemChannelId } from "../../store/inboxItem";
import { useServerStore } from "../../store/serverStore";
import type { InboxItem, InboxReadWriteOptions } from "../../store/inboxStore";
import { useThreadStore } from "../../store/threadStore";

// An Activity row's own actions besides Done, shared by its press-and-hold /
// right-click menu (InboxContextMenu) and a phone's swipe buttons
// (ThreadsInbox), so an action is the same in both places (Raft DS ›
// Responsive layout › Touch screens).

export type ThreadInboxItem = Extract<InboxItem, { kind: "thread" }>;

/** A followed thread row: it can be unfollowed. */
export function canUnfollowActivityRow(item: InboxItem): item is ThreadInboxItem {
  return item.kind === "thread" && item.isFollowing !== false;
}

/**
 * A row whose Activity can be muted now: a joined `channel` row, or a `dm`
 * row the server says can be muted (a DM with an App bot), whose activity
 * isn't muted. A `mention_action` row is a direct mention, which a mute does
 * not hold back.
 */
export function canMuteActivityRow(item: InboxItem, channel: Channel | undefined): channel is Channel {
  return (item.kind === "channel" || item.kind === "dm") && canToggleActivityMute(channel) && channel?.activityMuted !== true;
}

/** The server the stores hold now: an action that awaited checks it is still the one it started on. */
export type ServerIdentity = { serverId: string | null; serverEpoch: number };

export function serverIdentity(): ServerIdentity {
  const state = useServerStore.getState();
  return { serverId: state.current?.id ?? null, serverEpoch: state.serverEpoch };
}

export function onSameServer(identity: ServerIdentity): boolean {
  const now = serverIdentity();
  return now.serverId === identity.serverId && now.serverEpoch === identity.serverEpoch;
}

/**
 * Unfollow changes future delivery, not Activity history: the row stays,
 * marked unfollowed. Resolves to whether the server took it. If the person
 * switched servers while it saved, the inbox store is another server's:
 * nothing local is touched.
 */
export async function unfollowActivityThread(item: ThreadInboxItem): Promise<boolean> {
  const threads = useThreadStore.getState();
  const identity = serverIdentity();
  try {
    // Task v2: a task conversation row has no parent message.
    if (item.conversationKind === "task") await threads.unfollowTaskConversation(item.threadChannelId);
    else await threads.unfollowThread(item.threadChannelId);
    // Keep this exact row and expose its new follow state.
    if (onSameServer(identity)) useInboxStore.getState().markThreadUnfollowed(item);
    return true;
  } catch {
    // Persistence failed; preserve the canonical followed row and
    // reconcile any unrelated concurrent Activity changes.
    if (onSameServer(identity)) await useInboxStore.getState().refreshInbox();
    return false;
  }
}

/**
 * An Unfollow written after it was asked for (a swipe's, once its Undo toast
 * closes), on the server it was asked on. Still on that server: as
 * `unfollowActivityThread`. On another one now: written to it by name, and
 * nothing local is touched (the stores are the other server's).
 */
export async function unfollowActivityThreadOn(item: ThreadInboxItem, identity: ServerIdentity): Promise<boolean> {
  if (onSameServer(identity)) return unfollowActivityThread(item);
  if (!identity.serverId) return false;
  try {
    await api.post("/channels/threads/unfollow", { threadChannelId: item.threadChannelId }, { headers: { "X-Server-Id": identity.serverId } });
    return true;
  } catch (err) {
    console.error("Failed to unfollow a thread on its server:", err);
    return false;
  }
}

/** Refollow preserves the row as an active followed thread (on the server it started on, as unfollow). */
export async function followActivityThread(item: ThreadInboxItem): Promise<void> {
  const threads = useThreadStore.getState();
  const identity = serverIdentity();
  try {
    if (item.conversationKind === "task") await threads.followTaskConversation(item.threadChannelId);
    else await threads.followThread(item.parentMessageId);
    if (onSameServer(identity)) useInboxStore.getState().markThreadRefollowed(item.threadChannelId);
  } catch {
    // Persistence failed; keep the unfollowed row and reconcile the
    // rest of Activity without fabricating a successful refollow.
    if (onSameServer(identity)) await useInboxStore.getState().refreshInbox();
  }
}

/**
 * A row whose read state can change: every row but an unfollowed thread's
 * (it no longer counts unread), and an object row only while it is unread
 * (it can be read, but the contract has no Mark as unread for it). The menu
 * then has no Mark as Read or Unread.
 */
export function canToggleActivityRowRead(item: InboxItem): boolean {
  if (item.kind === "object") return item.unreadCount > 0;
  return item.kind !== "thread" || item.isFollowing !== false;
}

/**
 * A row a phone's right swipe marks read or unread (raft-design #793): one
 * whose read state can change, switch back, and be seen to. Not an object
 * row (it can't be marked unread again), a direct mention's (it has no read
 * state of its own: Mark as Read leaves it as it is), nor a muted
 * conversation's (`muted`: it is drawn quiet, read or not, so a swipe could
 * never show a change).
 */
export function canSwipeActivityRowRead(item: InboxItem, muted: boolean): boolean {
  return !muted && item.kind !== "object" && item.kind !== "mention_action" && canToggleActivityRowRead(item);
}

/** The last read toggle's write on each conversation, on each server, so the next one's write waits for it. */
const readToggles = new Map<string, Promise<void>>();

/**
 * Mark as Read (`read`) or Mark as Unread: the row's menu item and a phone's
 * right swipe (raft-design #793), so both do the same. The caller decides
 * which, from the row as the person saw it when they acted (the swipe, as
 * the finger lifted). Read goes through the inbox store's markRead, so under
 * an Unread filter the row stays in the list, read, until the list changes
 * (store/activityUnreadSnapshot), and the swipe back always has a row.
 *
 * The row changes at once, every time; only the writes queue. Toggles of
 * one conversation write in order: swiped back while the Read is still
 * saving, the row shows unread at once and the Unread is saved after the
 * Read, never before it. A direct mention's toggle is its channel's. A write
 * still queued when the person switches servers is dropped (the store checks
 * the server it started on); the queue key carries the server too.
 */
export function toggleActivityRowRead(item: InboxItem, read: boolean, formatMessage?: IntlShape["formatMessage"]): Promise<void> {
  const identity = serverIdentity();
  // A write that fails puts the row back as the server has it; with a
  // formatMessage the person is told, as a failed mute is.
  const onFailed = formatMessage
    ? () => {
      if (!onSameServer(identity)) return;
      toast.error(formatMessage({ id: read ? "thread.row.markReadFailed" : "thread.row.markUnreadFailed" }));
    }
    : undefined;
  // Nothing the server counts unread (every message after the read point is
  // the person's own, as in a thread of only their replies under someone
  // else's message). A current server marks such a row unread itself
  // (`markedUnread`, a dot with no number; #triage:#101) and this never
  // fires; a server older than the mark answers 0 and changes nothing: say so
  // rather than let the row slip back to read unexplained.
  const onNothingUnread = formatMessage && !read
    ? () => {
      if (!onSameServer(identity)) return;
      toast.info(formatMessage({ id: "thread.row.markUnreadNothing" }));
    }
    : undefined;
  const conversation = item.kind === "mention_action" ? item.channelId : inboxItemChannelId(item) ?? getInboxItemKey(item);
  trackActivityMark(read ? "read" : "unread");
  return queueReadToggle(identity, conversation, { onFailed, onNothingUnread }, (inbox, options) => (read
    ? inbox.markRead(item, options).then(async () => {
      if (onSameServer(identity)) await useInboxStore.getState().refreshInbox();
    })
    : item.kind === "object" ? Promise.resolve() : inbox.markUnread(item, options)));
}

/**
 * Mark as Unread from a thread's own menu: the same action as its Activity
 * row's (the row when Activity has it loaded, else the same write and hold
 * with no row yet), in the same queue as the row's toggles.
 */
export function markThreadUnreadFromThread(threadChannelId: string): Promise<void> {
  return queueReadToggle(serverIdentity(), threadChannelId, {}, (inbox, options) => inbox.markThreadUnread(threadChannelId, options));
}

function queueReadToggle(
  identity: ServerIdentity,
  conversation: string,
  callbacks: Pick<InboxReadWriteOptions, "onFailed" | "onNothingUnread">,
  run: (inbox: ReturnType<typeof useInboxStore.getState>, options: InboxReadWriteOptions | undefined) => Promise<void>,
): Promise<void> {
  const key = `${identity.serverId ?? ""}:${identity.serverEpoch}:${conversation}`;
  // Only behind a toggle still writing: otherwise the write goes out in the
  // same tick, as a read's always has (the thread store's read-all and this
  // one's coalesce only then). Never rejects: a failed write doesn't stop it.
  const previous = readToggles.get(key);
  const options: InboxReadWriteOptions | undefined = previous || callbacks.onFailed || callbacks.onNothingUnread
    ? { ...(previous ? { after: previous.catch(() => {}) } : {}), ...callbacks }
    : undefined;
  const toggle = run(useInboxStore.getState(), options);
  readToggles.set(key, toggle);
  void toggle.catch(() => {}).then(() => {
    if (readToggles.get(key) === toggle) readToggles.delete(key);
  });
  return toggle;
}

/**
 * Settles once every read toggle still writing has (never rejects; undefined
 * when none is): Mark all read's write waits for them, so a queued Unread
 * can't land after it and leave the server unread where the screen is read.
 */
export function activityReadTogglesSettled(): Promise<void> | undefined {
  if (readToggles.size === 0) return undefined;
  return Promise.all([...readToggles.values()].map((toggle) => toggle.catch(() => {}))).then(() => {});
}

/**
 * Mutes or unmutes a channel's Activity (optimistic, rolled back on a failed
 * save), with an error toast when the save fails, as the sidebar's menu
 * does. Returns whether the new state was saved.
 */
export async function toggleActivityMuteReporting(channel: Channel, formatMessage: IntlShape["formatMessage"]): Promise<boolean> {
  const outcome = await toggleChannelActivityMute(channel);
  if (outcome.status !== "failed") return outcome.status === "saved";
  toast.error(outcome.activityMuted
    ? formatMessage({ id: "layout.sidebar.failedMuteActivity" })
    : formatMessage({ id: "layout.sidebar.failedUnmuteActivity" }));
  return false;
}
