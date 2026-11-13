import { SidebarItemContent, SidebarItemCount, SidebarItemMeta, SidebarItemMetaIcon, SidebarItemSubtitle, SidebarItemTitle } from "@botiverse/raft-ui";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Pencil } from "lucide-react";
import { getDmUnreadIndicatorState } from "../../../utils/channelUnreadIndicator";
import { QuietUnreadDot } from "../../../components/layout/QuietUnreadDot";
import { SIDEBAR_ROW_TRAILING_CLASS } from "./sidebarRowClasses";
import { SidebarActivityMutedMark } from "./SidebarActivityMutedMark";

/**
 * What every person or agent conversation row shows, in whichever section it
 * is listed (Direct Messages, Pinned, a custom section): the identity sticker,
 * then raft-ui's row content (the name on one line with an ellipsis, its
 * description after it, the name capped at 70% so the description still
 * shows), then the unread count, or the draft mark and the agent's meta. DmRow
 * and AgentDmRow differ only in what they subscribe to and draw through this,
 * so the same conversation cannot look different from one section to another.
 * An App's row carries the App badge right after its name (`nameBadge`):
 * beside the title, not inside it, so a long name truncates and the badge stays. It runs on no runtime, so its
 * caller passes no agent meta. The name wins over the description: the
 * description (raft-ui: flex-1 from no basis, shrink-1000) only takes the room
 * the name leaves, and with a badge the name keeps at least 3ch, so the badge
 * can never squeeze it to nothing. A muted DM (only one with an App bot can be
 * muted) carries a muted channel row's bell-off and grey count.
 */
export function SidebarPeerRowBody({ avatar, displayName, nameBadge, description, unread, markedUnread = false, hasDraft, agentMeta, activityMuted = false }: {
  avatar: ReactNode;
  displayName: ReactNode;
  nameBadge?: ReactNode;
  description: string | null | undefined;
  unread: number;
  /** Marked unread with nothing countable: the quiet pixel in place of a count. */
  markedUnread?: boolean;
  hasDraft: boolean;
  agentMeta: ReactNode;
  activityMuted?: boolean;
}) {
  const { formatMessage } = useIntl();
  // Muted unread is a grey mono number (`.rf-count`), not the pink badge.
  const { showQuietUnreadCount, showMarkedUnreadDot } = getDmUnreadIndicatorState({ unread, markedUnread, activityMuted });
  const UnreadCount = showQuietUnreadCount ? SidebarItemMeta : SidebarItemCount;
  return (
    <>
      {avatar}
      <SidebarItemContent>
        {/* Unread is the row's `tone="unread"` (raft-ui SidebarItem): a 700 name. */}
        <SidebarItemTitle className={nameBadge ? "min-w-[3ch]" : undefined}>{displayName}</SidebarItemTitle>
        {nameBadge}
        {activityMuted && <SidebarActivityMutedMark />}
        {description ? <SidebarItemSubtitle data-sidebar-row-description="">{description}</SidebarItemSubtitle> : null}
      </SidebarItemContent>
      <span className={SIDEBAR_ROW_TRAILING_CLASS}>
        {unread > 0 ? (
          <UnreadCount>
            {/* Stryker disable all: pre-existing unread cap is outside the workspace mutation corpus. */}
            {unread > 99 ? "99+" : unread}
            {/* Stryker restore all */}
          </UnreadCount>
        ) : showMarkedUnreadDot ? (
          <QuietUnreadDot
            data-testid="sidebar-marked-unread-dot"
            aria-label={formatMessage({ id: "layout.sidebar.markedUnreadAria" })}
          />
        ) : (
          <>
            {hasDraft && <SidebarItemMetaIcon><Pencil /></SidebarItemMetaIcon>}
            {agentMeta}
          </>
        )}
      </span>
    </>
  );
}
