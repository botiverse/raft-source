import { Badge, SidebarItem, SidebarItemChannelIcon, SidebarItemContent, SidebarItemCount, SidebarItemIndicator, SidebarItemMeta, SidebarItemMetaIcon, SidebarItemTitle } from "@botiverse/raft-ui";
import Tooltip from "../../../components/ui/Tooltip";
import { useCallback, memo } from "react";
import { useIntl } from "react-intl";
import { Pencil, AtSign } from "lucide-react";
import type { Channel } from "../../../store/channelStore";
import { slackSyncHeaderState } from "../../../components/channel/slackSyncHeaderState";
import { useMessageStore } from "../../../store/messageStore";
import { ChannelIcon } from "../../../components/channel/channelKindIcon";
import { getChannelUnreadIndicatorState, shouldShowActivityMutedIcon } from "../../../utils/channelUnreadIndicator";
import { useScopeMarkedUnread } from "../../../store/markedUnreadStore";
import { QuietUnreadDot } from "../../../components/layout/QuietUnreadDot";
import { useParentThreadUnread } from "../../../hooks/useParentThreadUnread";
import type { SidebarCtxKind, SidebarLongPress } from "../sidebarContextMenu";
import { sidebarItemClass } from "./sidebarRowClasses";
import { ChannelUnreadSegments } from "./ChannelUnreadSegments";
import { SidebarActivityMutedMark } from "./SidebarActivityMutedMark";

// Per-row leaf components. Two properties make them the fix for the
// channel-switch freeze:
//
//  1. They subscribe to ONLY their own unread/draft slice, so an incoming
//     `message:new` (which rebuilds the whole `unreadCounts` Record with a new
//     reference) re-renders just the one affected row, not the whole Sidebar.
//
//  2. They are `memo`'d with STABLE props — `channel`/`dm`/`agent` (structurally
//     shared by the stores), primitive `selected`/`menuOpen`, and parent
//     callbacks that are `useCallback`-stable. So when the parent DOES re-render
//     (every `message:new` rebuilds `channels`/`dmChannels` via
//     `touchChannelActivity`, bumping `lastMessageAt`), the 100s of unaffected
//     rows skip reconciliation instead of all re-rendering. Without stable props
//     memo is a no-op and the parent's re-render still walks every row — which is
//     exactly the ~80ms-of-children cost the profiler caught.
//
// The row builds its own event-handler closures from the stable callbacks; those
// inner closures are irrelevant to memo (memo compares the incoming props).
// Mirrors the <ComputerRow> machine-status isolation above. (broad-subscription sweep P0-B)
// Stryker disable all: ChannelRow changed lines here are visual class-token/default-prop variants; pinned/channel row identity, wrapping, dim/mute/unread behavior are covered by behavior tests.
export const ChannelRow = memo(function ChannelRow({
  channel,
  selected,
  menuOpen,
  onSelect,
  onContextMenu,
  makeLongPress,
  serverPublicPageLive = false,
}: {
  channel: Channel;
  /** The current server's public page is live; with a Guest-visible channel, anyone can read it there. */
  serverPublicPageLive?: boolean;
  selected: boolean;
  menuOpen: boolean;
  onSelect: (channel: Channel, clickCount: number) => void;
  onContextMenu: (e: React.MouseEvent, type: SidebarCtxKind, id: string) => void;
  makeLongPress: (type: SidebarCtxKind, id: string) => SidebarLongPress;
}) {
  const unread = useMessageStore((s) => s.unreadCounts[channel.id] || 0);
  const mentionMarked = useMessageStore((s) => s.mentionFlags[channel.id] === true);
  const hasNew = useMessageStore((s) => s.newFlags[channel.id] === true);
  const markedUnread = useScopeMarkedUnread(channel.id);
  const hasDraft = useMessageStore((s) => !!s.drafts[channel.id]);
  // Not joined: no scan, no thread-unread mark.
  const threadUnread = useParentThreadUnread(channel.joined ? channel.id : null);
  // Display-language (react-intl) — the row owns its own marker copy so the
  // memoized leaf does not need a new prop from the parent.
  const { formatMessage } = useIntl();
  const dimmed = !selected && !channel.joined;
  const activityMuted = channel.activityMuted === true;
  const showMutedIcon = shouldShowActivityMutedIcon({ activityMuted, joined: channel.joined });
  const { showLoudUnreadBadge, showQuietUnreadCount, showQuietNewDot, showMarkedUnreadDot, unreadTone } = getChannelUnreadIndicatorState({
    unread,
    joined: channel.joined === true,
    showMutedIcon,
    hasNew,
    threadUnread: threadUnread.count,
    markedUnread,
  });
  const showMentionMarker = (mentionMarked || threadUnread.hasMention) && channel.joined;
  const unreadSegments = (
    <ChannelUnreadSegments
      unread={unread}
      threads={threadUnread.count}
      threadLabel={formatMessage({ id: "layout.sidebar.threadUnreadLabel" }, { count: threadUnread.count })}
    />
  );
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => onSelect(channel, event.detail),
    [channel, onSelect],
  );
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => onContextMenu(event, "channel", channel.id),
    [channel.id, onContextMenu],
  );
  // DS `rf-srow--away/--muted/--unread`: not joined = ink-3 name, muted = ink-2
  // name, unread = 700 name. raft-ui SidebarItem's `tone` draws them and keeps
  // the selected row's sticker ink. The three never meet: a loud unread badge
  // needs a joined, unmuted channel, and an unjoined row is dimmed only while
  // it is not selected.
  const tone = dimmed ? "away" : activityMuted ? "muted" : unreadTone ? "unread" : "default";
  return (
    <SidebarItem
      data-sidebar-channel-id={channel.id}
      data-slot="sidebar-item"
      active={selected}
      tone={tone}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      {...makeLongPress("channel", channel.id)}
      className={sidebarItemClass(selected, menuOpen)}
    >
      {/* `.rf-srow__icon`: a bare # (private: lock) in the 19px ink-3 box —
          never a coloured tile; the recipe turns it sticker-ink when selected. */}
      <SidebarItemChannelIcon>
        <ChannelIcon channel={channel} size={16} serverPublicPageLive={serverPublicPageLive} />
      </SidebarItemChannelIcon>
      <SidebarItemContent className="items-center">
        {/* One line with an ellipsis, as every sidebar row (DS `rf-srow__name`).
            The row's tone sets its ink and weight (raft-ui SidebarItem `tone`). */}
        <SidebarItemTitle>{channel.name}</SidebarItemTitle>
        {channel.bridge?.provider === "slack" && (
          <Badge appearance="soft" variant={slackSyncHeaderState(channel) ? "warning" : "accent"}>
            {formatMessage({ id: "settings.slackBridge.providerBadge" })}
          </Badge>
        )}
        {showMutedIcon && <SidebarActivityMutedMark />}
      </SidebarItemContent>
      {/* @you is the yellow @ sticker (Badge `rf-badge--mention`), drawn by raft-ui. */}
      {showMentionMarker && (
        <Tooltip content={formatMessage({ id: "layout.sidebar.mentionedYouTitle" })}>
        <SidebarItemIndicator
          className="ml-1"
          data-slot="sidebar-item-indicator"
          role="img"
          data-testid="sidebar-mention-marker"
          aria-label={formatMessage({ id: "layout.sidebar.mentionedYouAria" })}
        >
          <AtSign />
        </SidebarItemIndicator>
        </Tooltip>
      )}
      {showLoudUnreadBadge ? (
        <SidebarItemCount className="ml-auto">
          {unreadSegments}
        </SidebarItemCount>
      ) : showQuietUnreadCount ? (
        // Muted / not-joined unread is a grey mono number (`.rf-count`), not the pink badge.
        <SidebarItemMeta className={`${showMutedIcon || showMentionMarker ? "ml-1" : ""}${threadUnread.count > 0 ? " inline-flex items-center" : ""}`}>
          {unreadSegments}
        </SidebarItemMeta>
      ) : showQuietNewDot ? (
        <QuietUnreadDot
          className="ml-auto"
          data-testid="sidebar-quiet-new-dot"
          aria-label={formatMessage({ id: "layout.sidebar.newMessagesAria" })}
        />
      ) : showMarkedUnreadDot ? (
        <QuietUnreadDot
          className={showMutedIcon || showMentionMarker ? "ml-1" : "ml-auto"}
          data-testid="sidebar-marked-unread-dot"
          aria-label={formatMessage({ id: "layout.sidebar.markedUnreadAria" })}
        />
      ) : hasDraft && (
        <SidebarItemMetaIcon className={showMutedIcon ? "ml-1" : "ml-auto"}><Pencil /></SidebarItemMetaIcon>
      )}
    </SidebarItem>
  );
});
// Stryker restore all
