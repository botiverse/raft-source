import { useCallback } from "react";
import { useIntl } from "react-intl";
import { MessageSquareCheck, MessageSquareDot } from "lucide-react";
import { useMessageStore } from "../../store/messageStore";
import { useScopeMarkedUnread } from "../../store/markedUnreadStore";
import { useParentThreadUnread } from "../../hooks/useParentThreadUnread";
import MenuItem from "../ui/MenuItem";

export function SidebarReadToggleMenuItem({
  channelId,
  hasUnread,
  onDone,
  includeThreads = false,
}: {
  channelId: string;
  hasUnread: boolean;
  onDone: () => void;
  includeThreads?: boolean;
}) {
  const { formatMessage } = useIntl();
  const markRead = useMessageStore((s) => s.markRead);
  const markConversationRead = useMessageStore((s) => s.markConversationRead);
  const threadUnread = useParentThreadUnread(includeThreads ? channelId : null);
  // Marked unread with no count reads as unread: Mark as Read clears the mark.
  const markedUnread = useScopeMarkedUnread(channelId);
  const anyUnread = hasUnread || markedUnread || threadUnread.count > 0;
  const markUnread = useMessageStore((s) => s.markUnread);
  const toggleRead = useCallback(() => {
    onDone();
    const action = anyUnread
      ? (includeThreads ? markConversationRead(channelId) : markRead(channelId))
      : markUnread(channelId);
    void action.catch(() => {
      void useMessageStore.getState().loadUnreadCounts();
    });
  }, [channelId, anyUnread, includeThreads, markConversationRead, markRead, markUnread, onDone]);
  return (
    <MenuItem
      icon={anyUnread ? <MessageSquareCheck size={14} /> : <MessageSquareDot size={14} />}
      onClick={toggleRead}
    >
      {anyUnread
        ? formatMessage({ id: includeThreads ? "layout.sidebar.markAllAsRead" : "layout.sidebar.markAsRead" })
        : formatMessage({ id: "layout.sidebar.markAsUnread" })}
    </MenuItem>
  );
}
