import { useState } from "react";
import { useIntl } from "react-intl";
import {
  EllipsisVertical,
  ExternalLink,
  MapPin,
  MessageCircleOff,
  MessageCirclePlus,
  Search,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "raft-ui";
import { useThreadStore } from "../../store/threadStore";
import Button from "../ui/Button";

/**
 * Thread topbar vertical-ellipsis action menu (task #187, gated by
 * `topbar_overflow_v0`).
 *
 * A Thread only has a few immediate commands, so a full settings drawer is
 * too heavy. Raft UI's DropdownMenu supplies the correct command-menu
 * semantics (focus management, arrow-key navigation, Escape and outside
 * dismissal); PopSelect would incorrectly imply a selected value. Structural
 * Back / Close stay in the header. The baseline ThreadPanel had no unread
 * action, so this menu must not invent one. Rows whose identity anchor is
 * missing are omitted.
 */
export interface ThreadOverflowMenuProps {
  /** The thread's own channel id — anchors unfollow. */
  threadChannelId: string | null;
  /** Parent message id — anchors follow/unfollow. */
  parentMessageId: string | null;
  viewInChannelLabel: string;
  onViewInChannel: () => void;
  onOpenInNewTab?: () => void;
  onSearch: () => void;
}

export default function ThreadOverflowMenu({
  threadChannelId,
  parentMessageId,
  viewInChannelLabel,
  onViewInChannel,
  onOpenInNewTab,
  onSearch,
}: ThreadOverflowMenuProps) {
  const { formatMessage } = useIntl();
  const [followBusy, setFollowBusy] = useState(false);
  const followed = useThreadStore((state) =>
    parentMessageId
      ? state.followedThreads.some((thread) => thread.parentMessageId === parentMessageId)
      : false);
  const followThread = useThreadStore((state) => state.followThread);
  const unfollowThread = useThreadStore((state) => state.unfollowThread);

  const handleFollowAction = () => {
    if (followBusy) return;
    const action = followed
      ? threadChannelId ? unfollowThread(threadChannelId) : null
      : parentMessageId ? followThread(parentMessageId) : null;
    if (!action) return;

    // Follow/Unfollow are one-shot commands, matching the message context
    // menu. They are intentionally not modelled as a preference Switch.
    setFollowBusy(true);
    void action.catch(() => {}).finally(() => setFollowBusy(false));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            shape="icon"
            title={formatMessage({ id: "message.threadPanel.overflow.open" })}
            aria-label={formatMessage({ id: "message.threadPanel.overflow.open" })}
            data-testid="thread-overflow-trigger"
          >
            <EllipsisVertical size={14} />
          </Button>
        )}
      />
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={4}
        aria-label={formatMessage({ id: "message.threadPanel.overflow.open" })}
        data-testid="thread-overflow-menu"
      >
        <DropdownMenuItem onClick={onSearch} data-testid="thread-overflow-search">
          <Search />
          {formatMessage({ id: "message.threadPanel.searchInThread" })}
        </DropdownMenuItem>
        {parentMessageId && onOpenInNewTab && (
          <DropdownMenuItem
            onClick={onOpenInNewTab}
            data-testid="thread-overflow-open-new-tab"
          >
            <ExternalLink />
            {formatMessage({ id: "message.threadPanel.openInNewTab" })}
          </DropdownMenuItem>
        )}
        {parentMessageId && (
          <DropdownMenuItem
            onClick={onViewInChannel}
            data-testid="thread-overflow-view-in-channel"
          >
            <MapPin />
            {viewInChannelLabel}
          </DropdownMenuItem>
        )}
        {parentMessageId && (
          <DropdownMenuItem
            onClick={handleFollowAction}
            disabled={followBusy || (followed && !threadChannelId)}
            data-testid="thread-overflow-follow-action"
          >
            {followed ? <MessageCircleOff /> : <MessageCirclePlus />}
            {formatMessage({
              id: followed
                ? "message.messageItem.unfollowThread"
                : "message.messageItem.followThread",
            })}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
