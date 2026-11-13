import { SidebarItemCountSeparator, SidebarItemThreadCount } from "@botiverse/raft-ui";
import { getChannelUnreadSegments } from "../../../utils/channelUnreadIndicator";

const capUnread = (count: number) => (count > 99 ? "99+" : count);

// `5 · [thread] 1`: the channel's own unread, then followed threads with new
// replies. With no thread unread this is exactly the old bare count.
export function ChannelUnreadSegments({ unread, threads, threadLabel }: { unread: number; threads: number; threadLabel: string }) {
  const segments = getChannelUnreadSegments(unread, threads);
  if (segments.threads === undefined) return <>{capUnread(unread)}</>;
  return (
    <>
      {segments.unread !== undefined && capUnread(segments.unread)}
      {segments.unread !== undefined && <SidebarItemCountSeparator />}
      <SidebarItemThreadCount data-testid="sidebar-thread-unread" label={threadLabel}>{capUnread(segments.threads)}</SidebarItemThreadCount>
    </>
  );
}
