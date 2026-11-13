import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { Bell, BellOff, Check, MessageSquareCheck, MessageSquareDot } from "lucide-react";
import { ContextMenuPopup, ScrollArea } from "@botiverse/raft-ui";
import { FollowThreadIcon, UnfollowThreadIcon } from "@botiverse/ricons";
import { canToggleActivityMute } from "../../store/channelDomain";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import type { InboxItem } from "../../store/inboxStore";
import { inboxItemChannelId } from "../../store/inboxItem";
import { useScopeMarkedUnread } from "../../store/markedUnreadStore";
import { canToggleActivityRowRead, followActivityThread, toggleActivityMuteReporting, toggleActivityRowRead } from "./inboxRowActions";
import type { ThreadInboxItem } from "./inboxRowActions";
import { itemFilterChannelLabel } from "./inboxChannelFilter";
import { loungeTitleNow } from "../agent/agentLounge";
import MenuItem from "../ui/MenuItem";
import type { InboxContextMenuPosition } from "./inboxContextMenuPosition";

export function InboxContextMenu({ ctxMenu, onClose, onDone, onUnfollow }: {
  ctxMenu: InboxContextMenuPosition;
  onClose: () => void;
  /** The row's Mark as Done handler (with its Undo toast), so the menu, the row's button and the swipe do the same thing. */
  onDone: (item: InboxItem) => void;
  /** The swipe's Unfollow (with its Undo toast); `conversation` names where the thread is. */
  onUnfollow: (item: ThreadInboxItem, conversation: string) => void;
}) {
  const { formatMessage } = useIntl();
  const item = ctxMenu.item;
  // A channel row "stops being followed" the way a thread row's Unfollow
  // does: Activity mute. The design system puts it in every device's row
  // menu, and among a phone's swipe buttons (raft-design #785).
  // `channel` and `dm` rows: only a DM with an App bot can be muted (the
  // server's `activityMuteSupported`), and a `mention_action` row is a
  // direct mention, which a mute does not hold back. The state comes from
  // the channel and DM lists the sidebar already loaded; an unjoined or
  // unknown conversation gets no item rather than a guess.
  const muteChannel = useChannelStore((s) => (
    item.kind === "channel" ? findStoredChannel(s, item.channelId)
      : item.kind === "dm" ? s.dmChannels.find((dm) => dm.id === item.channelId)
        : undefined
  ));
  const canMute = canToggleActivityMute(muteChannel);

  // Marked unread with no count is unread too: its item is Mark as Read.
  const markedUnread = useScopeMarkedUnread(inboxItemChannelId(item));
  const showsUnread = item.unreadCount > 0 || markedUnread;

  const style = useMemo(() => ({
    left: ctxMenu.x,
    top: ctxMenu.y,
    width: 184,
    maxWidth: ctxMenu.maxWidth,
    maxHeight: ctxMenu.maxHeight,
  }), [ctxMenu.x, ctxMenu.y, ctxMenu.maxWidth, ctxMenu.maxHeight]);

  // The same action as a phone's right swipe (inboxRowActions). The menu
  // closes at once, as every other item's does: the row already shows the
  // change, and the save (with its reload) can take seconds (xxchan,
  // #triage:#101: "I click it and the menu doesn't go away").
  const handleToggleRead = useCallback(() => {
    onClose();
    void toggleActivityRowRead(item, showsUnread, formatMessage);
  }, [formatMessage, item, onClose, showsUnread]);

  const handleDone = useCallback(() => {
    onDone(item);
    onClose();
  }, [item, onClose, onDone]);

  // The row leaves the list, so it waits out an Undo toast as the swipe's does.
  const handleUnfollow = useCallback(() => {
    onClose();
    if (item.kind !== "thread") return;
    const { channels, dmChannels } = useChannelStore.getState();
    // A thread in an agent's Lounge is labelled with the Lounge's name, as its row is.
    onUnfollow(item, loungeTitleNow(formatMessage, item.parentChannelId, item.parentChannelName)
      ?? itemFilterChannelLabel(item, channels, dmChannels));
  }, [formatMessage, item, onClose, onUnfollow]);

  const handleFollow = useCallback(async () => {
    onClose();
    if (item.kind === "thread") await followActivityThread(item);
  }, [item, onClose]);

  const handleToggleMute = useCallback(async () => {
    onClose();
    if (!muteChannel) return;
    await toggleActivityMuteReporting(muteChannel, formatMessage);
  }, [formatMessage, muteChannel, onClose]);

  return (
    <ContextMenuPopup
      className="fixed z-popup select-none p-0"
      style={style}
      data-testid="activity-context-menu"
    >
      {/* The popup is the frame (max height, rounded clip); the items scroll
          in a raft-ui ScrollArea inside it, with the popup's 4px padding on
          its content. The items take focus themselves: no tab stop. */}
      <ScrollArea tabIndex={-1} className="min-h-0 flex-1" contentClassName="flex flex-col p-1">
      {/* An object row has no Mark as unread (the contract has no such route). */}
      {canToggleActivityRowRead(ctxMenu.item) && (
        <MenuItem
          icon={showsUnread ? <MessageSquareCheck size={14} /> : <MessageSquareDot size={14} />}
          onClick={handleToggleRead}
        >
          {showsUnread ? formatMessage({ id: "thread.contextMenu.markAsRead" }) : formatMessage({ id: "thread.contextMenu.markAsUnread" })}
        </MenuItem>
      )}
      <MenuItem
        icon={<Check size={14} />}
        onClick={handleDone}
      >
        {formatMessage({ id: "thread.row.markAsDone" })}
      </MenuItem>
      {ctxMenu.item.kind === "thread" && ctxMenu.item.isFollowing !== false && (
        <MenuItem
          // The message menu's Unfollow/Follow icons: bell is Mute's, and the
          // swipe shows the menu's icon (raft-design responsive.md, #782).
          icon={<UnfollowThreadIcon width={14} height={14} />}
          onClick={handleUnfollow}
        >
          {formatMessage({ id: "thread.contextMenu.unfollow" })}
        </MenuItem>
      )}
      {ctxMenu.item.kind === "thread" && ctxMenu.item.isFollowing === false && (
        <MenuItem
          icon={<FollowThreadIcon width={14} height={14} />}
          onClick={handleFollow}
        >
          {formatMessage({ id: "thread.contextMenu.follow" })}
        </MenuItem>
      )}
      {canMute && muteChannel && (
        <MenuItem
          icon={muteChannel.activityMuted === true ? <Bell size={14} /> : <BellOff size={14} />}
          onClick={handleToggleMute}
        >
          {muteChannel.activityMuted === true
            ? formatMessage({ id: "thread.contextMenu.unmuteActivity" })
            : formatMessage({ id: "thread.contextMenu.muteActivity" })}
        </MenuItem>
      )}
      </ScrollArea>
    </ContextMenuPopup>
  );
}
