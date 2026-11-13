import { useEffect, useMemo } from "react";
import { CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY, channelTypeSupportsThreadSort } from "@botiverse/raft-shared";
import type { Channel } from "../../store/channelStore";
import type { Message } from "../../store/messageStore";
import { buildActivityTimeline, retainWindow, useChannelActivityStore } from "../../store/channelActivityStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useThreadStore } from "../../store/threadStore";

/**
 * Forum-style channels (#proj-chat:#24, flag channel_thread_sort_v0): the
 * timeline of a channel set to `threadSort: "activity"` lists its top-level
 * messages by latest activity, newest at the bottom
 * (store/channelActivityStore.ts). A jump into a seq context window
 * (`hasNewer`: a permalink, a search hit, an unloaded thread parent) shows
 * that window in post order as before; Back to bottom returns to the forum
 * order. In forum order every message stands alone (no merging by sender:
 * neighbours can be far apart in time) and there are no day dividers.
 *
 * Off (flag off, another channel type or `time`): the seq window unchanged,
 * and nothing of the activity store is read or subscribed.
 */
const NO_BUMPS: Readonly<Record<string, string>> = {};

export function useForumTimeline(
  channel: Pick<Channel, "id" | "type" | "threadSort"> | null | undefined,
  seqMessages: Message[],
  meta: { loading: boolean; loadingOlder: boolean; hasMore: boolean; hasNewer: boolean; historyLimited: boolean },
) {
  const channelId = channel?.id ?? null;
  const flag = useServerFeatureFlag(CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY).enabled;
  const forumChannel = flag && channelTypeSupportsThreadSort(channel?.type) && channel?.threadSort === "activity";
  const forumMode = forumChannel && !meta.hasNewer;
  // Only this channel's slice, and only in forum mode: a reply elsewhere
  // re-renders nothing here.
  const forumChannelId = forumChannel ? channelId : null;
  const activityWindow = useChannelActivityStore((s) => (forumChannelId ? s.windows[forumChannelId] : undefined));
  const replyBumps = useChannelActivityStore((s) => (forumChannelId ? s.replyBumps[forumChannelId] : undefined)) ?? NO_BUMPS;
  const summaries = useThreadStore((s) => s.summaries);
  const loadOlderActivity = useChannelActivityStore((s) => s.loadOlder);
  // Opening a forum channel (or the setting turning on while it is open)
  // reads its first activity page; leaving it drops the window. After a
  // reconnect (rooms:joined, where the seq timeline resyncs too) the page is
  // read again: replies sent while the socket was down moved rows.
  useEffect(() => {
    if (!forumChannelId) return;
    const release = retainWindow(forumChannelId);
    const onRoomsJoined = () => {
      const { windows, loadLatest } = useChannelActivityStore.getState();
      if (windows[forumChannelId]?.loading) return;
      void loadLatest(forumChannelId);
    };
    window.addEventListener("slock:rooms-joined", onRoomsJoined);
    return () => {
      window.removeEventListener("slock:rooms-joined", onRoomsJoined);
      release();
    };
  }, [forumChannelId]);
  const forumMessages = useMemo(
    () => (forumMode && channelId ? buildActivityTimeline(channelId, seqMessages, activityWindow, summaries, replyBumps) : null),
    [forumMode, channelId, seqMessages, activityWindow, summaries, replyBumps],
  );
  const messages = forumMessages ?? seqMessages;
  return {
    forumChannel,
    forumMode,
    messages,
    hasMore: forumMode ? activityWindow?.hasMore ?? false : meta.hasMore,
    historyLimited: forumMode ? activityWindow?.historyLimited ?? false : meta.historyLimited,
    loadingOlder: forumMode ? activityWindow?.loadingOlder ?? false : meta.loadingOlder,
    loading: forumMode ? messages.length === 0 && (meta.loading || (activityWindow?.loading ?? true)) : meta.loading,
    loadOlderActivity,
  };
}
