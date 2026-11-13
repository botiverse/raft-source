import { memo, useCallback } from "react";
import { useIntl } from "react-intl";
import { AtSign } from "lucide-react";
import {
  SidebarItem,
  SidebarItemContent,
  SidebarItemCount,
  SidebarItemIndicator,
  SidebarItemMeta,
  SidebarItemTitle,
} from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";
import { useMessageStore } from "../../store/messageStore";
import { useScopeMarkedUnread } from "../../store/markedUnreadStore";
import { getDmUnreadIndicatorState } from "../../utils/channelUnreadIndicator";
import { LoungeAvatar } from "../agent/LoungeAvatar";
import { QuietUnreadDot } from "./QuietUnreadDot";
import { SidebarActivityMutedMark } from "../../features/sidebar/rows/SidebarActivityMutedMark";
import type { SidebarCtxKind, SidebarLongPress } from "../../features/sidebar/sidebarContextMenu";

/**
 * Agent Lounge v0: the Lounge's own row, in Direct Messages (sorted with the
 * DMs) or in Pinned once pinned, whether or not its agent's DM row is shown.
 * Listed in Direct Messages only once you joined the Lounge or were mentioned
 * there; the caller decides that (agentLoungeSidebarEntry).
 *
 * It leads with the Lounge's face: its agent's, with the Lounge mark in the
 * corner (LoungeAvatar), as everywhere the Lounge is shown, and is titled
 * "{Name}'s Lounge". Its menu is a DM row's (right-click or long-press, the
 * `lounge` menu): Mark read / unread, Pin, Mute, Close.
 *
 * Unread: the live count once the client has one for the Lounge, else what
 * the DM row's `lounge` summary said.
 */
/** The sidebar caps a count at 99+, like the other rows (a plain expression, not a JSX literal). */
const capUnread = (count: number) => (count > 99 ? "99+" : count);

export const AgentLoungeRow = memo(function AgentLoungeRow({
  channelId,
  agentId,
  title,
  summaryUnread,
  summaryMentioned,
  activityMuted,
  selected,
  className,
  onSelect,
  onContextMenu,
  makeLongPress,
}: {
  channelId: string;
  agentId: string;
  /** "{Name}'s Lounge". */
  title: string;
  summaryUnread: number;
  summaryMentioned: boolean;
  activityMuted: boolean;
  selected: boolean;
  className?: string;
  onSelect: (channelId: string) => void;
  onContextMenu: (e: React.MouseEvent, type: SidebarCtxKind, id: string) => void;
  makeLongPress: (type: SidebarCtxKind, id: string) => SidebarLongPress;
}) {
  const { formatMessage } = useIntl();
  const liveUnread = useMessageStore((s) => s.unreadCounts[channelId]);
  const liveMention = useMessageStore((s) => s.mentionFlags[channelId] === true);
  const markedUnread = useScopeMarkedUnread(channelId);
  const unread = liveUnread ?? summaryUnread;
  const mentioned = liveMention || (liveUnread === undefined && summaryMentioned);
  const { showQuietUnreadCount, showMarkedUnreadDot, unreadTone } = getDmUnreadIndicatorState({ unread, markedUnread, activityMuted });
  const UnreadCount = showQuietUnreadCount ? SidebarItemMeta : SidebarItemCount;
  const handleClick = useCallback(() => onSelect(channelId), [channelId, onSelect]);
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => onContextMenu(event, "lounge", channelId),
    [channelId, onContextMenu],
  );
  return (
    <SidebarItem
      data-sidebar-channel-id={channelId}
      data-sidebar-lounge-row=""
      data-slot="sidebar-item"
      active={selected}
      tone={activityMuted ? "muted" : unreadTone ? "unread" : "default"}
      aria-label={title}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      {...makeLongPress("lounge", channelId)}
      className={className}
    >
      <LoungeAvatar agentId={agentId} context="sidebar-list" />
      <SidebarItemContent className="items-center">
        <SidebarItemTitle>{title}</SidebarItemTitle>
        {activityMuted && <SidebarActivityMutedMark />}
      </SidebarItemContent>
      {mentioned && (
        <Tooltip content={formatMessage({ id: "layout.sidebar.mentionedYouTitle" })}>
          <SidebarItemIndicator
            className="ml-1"
            data-slot="sidebar-item-indicator"
            role="img"
            data-testid="sidebar-lounge-mention-marker"
            aria-label={formatMessage({ id: "layout.sidebar.mentionedYouAria" })}
          >
            <AtSign />
          </SidebarItemIndicator>
        </Tooltip>
      )}
      {unread > 0 ? (
        <UnreadCount className="ml-auto" data-testid="sidebar-lounge-unread">
          {capUnread(unread)}
        </UnreadCount>
      ) : showMarkedUnreadDot ? (
        <QuietUnreadDot
          className="ml-auto"
          data-testid="sidebar-marked-unread-dot"
          aria-label={formatMessage({ id: "layout.sidebar.markedUnreadAria" })}
        />
      ) : null}
    </SidebarItem>
  );
});
