import { useCallback, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  EllipsisVertical,
  List,
  MapPin,
  MessageSquareDot,
  Search,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  PanelAction,
} from "@botiverse/raft-ui";
import { FollowThreadIcon, UnfollowThreadIcon } from "@botiverse/ricons";
import { useOpenThreadMarkUnread } from "./threadUnreadHold";
import { useThreadFollowCommand } from "./threadFollowCommand";
import type { ConversationFollowCommand } from "./threadFollowCommand";
import Tooltip from "../ui/Tooltip";

/**
 * Thread topbar vertical-ellipsis action menu.
 *
 * A Thread only has a few immediate commands, so a full settings drawer is
 * too heavy. Raft UI's DropdownMenu supplies the correct command-menu
 * semantics (focus management, arrow-key navigation, Escape and outside
 * dismissal); PopSelect would incorrectly imply a selected value. Structural
 * Back / Close stay in the header. Mark as Unread is the thread's Activity
 * row's own (inboxRowActions): the thread shows unread in its channel and in
 * Activity, and stays open and unread while the person is in it
 * (threadUnreadHold). A thread the person doesn't follow has none, as its
 * Activity row has none. Rows whose identity anchor is missing are omitted.
 *
 * Task v2: the task dialog reuses this menu (`subject="task"`), so its rows
 * sit in the same order, with the same icons and behaviour, for a task
 * conversation as for a thread: Search in Task, View in Channel, Follow /
 * Unfollow Task. Focus Mode is not in this menu: it is the header's own
 * button (the row's Expand, RowExpandAction), as every expand-type action is. A task
 * conversation has no parent message, so the caller supplies its follow
 * command (`follow`), and View in Channel is anchored by the task instead.
 */
export type { ConversationFollowCommand };

export interface ThreadOverflowMenuProps {
  /** "task": the task dialog's menu (task labels, `task-overflow-*` test ids). */
  subject?: "thread" | "task";
  /** The thread's own channel id — anchors unfollow. */
  threadChannelId: string | null;
  /** Parent message id — anchors follow/unfollow and View in Channel (a
   *  task's View in Channel is anchored by the task: the caller decides). */
  parentMessageId: string | null;
  /** Replaces the thread follow command (a task conversation's follow). */
  follow?: ConversationFollowCommand;
  viewInChannelLabel?: string;
  onViewInChannel?: () => void;
  onSearch?: () => void;
  /** The thread's outline as a list (ConversationOutline), where the thread has one; it opens under this menu's button. */
  onTimeline?: (trigger: HTMLElement | null) => void;
  /** The head's own actions that didn't fit it, first in the menu (#189 rule 6). */
  leadingItems?: ReactNode;
  /** After the thread's commands: Move Left / Move Right (#189 rule 7). */
  trailingItems?: ReactNode;
}

export default function ThreadOverflowMenu({
  subject = "thread",
  threadChannelId,
  parentMessageId,
  follow,
  viewInChannelLabel,
  onViewInChannel,
  onSearch,
  onTimeline,
  leadingItems,
  trailingItems,
}: ThreadOverflowMenuProps) {
  const { formatMessage } = useIntl();
  const thread = useMemo(() => ({ threadChannelId, parentMessageId }), [threadChannelId, parentMessageId]);
  // The thread's messages' menus in the panel share this command
  // (threadFollowCommand), as they share Mark as Unread.
  const threadFollowCommand = useThreadFollowCommand(thread);
  const markUnread = useOpenThreadMarkUnread(subject === "thread" ? thread : null);
  const task = subject === "task";
  const testIdPrefix = task ? "task-overflow" : "thread-overflow";
  const menuLabel = formatMessage({ id: task ? "task.modal.overflow.open" : "message.threadPanel.overflow.open" });
  const followCommand: ConversationFollowCommand | null = follow ?? threadFollowCommand;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openTimeline = useCallback(() => onTimeline?.(triggerRef.current), [onTimeline]);
  return (
    <DropdownMenu>
      <Tooltip content={menuLabel}>
        <DropdownMenuTrigger
          render={(
            <PanelAction
              ref={triggerRef}
              aria-label={menuLabel}
              data-testid={`${testIdPrefix}-trigger`}
            >
              <EllipsisVertical />
            </PanelAction>
          )}
        />
      </Tooltip>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={4}
        aria-label={menuLabel}
        data-testid={`${testIdPrefix}-menu`}
      >
        {leadingItems}
        {onSearch && (
          <DropdownMenuItem onClick={onSearch} data-testid={`${testIdPrefix}-search`}>
            <Search />
            {formatMessage({ id: task ? "task.modal.overflow.search" : "message.threadPanel.searchInThread" })}
          </DropdownMenuItem>
        )}
        {onTimeline && (
          <DropdownMenuItem onClick={openTimeline} data-testid={`${testIdPrefix}-timeline`}>
            <List />
            {formatMessage({ id: "message.outline.listTitle" })}
          </DropdownMenuItem>
        )}
        {(parentMessageId || task) && onViewInChannel && (
          <DropdownMenuItem
            onClick={onViewInChannel}
            data-testid={`${testIdPrefix}-view-in-channel`}
          >
            <MapPin />
            {viewInChannelLabel}
          </DropdownMenuItem>
        )}
        {markUnread && (
          <DropdownMenuItem onClick={markUnread} data-testid="thread-overflow-mark-unread">
            <MessageSquareDot />
            {formatMessage({ id: "thread.contextMenu.markAsUnread" })}
          </DropdownMenuItem>
        )}
        {followCommand && (
          <DropdownMenuItem
            onClick={followCommand.onFollowAction}
            disabled={followCommand.disabled}
            data-testid={`${testIdPrefix}-follow-action`}
          >
            {followCommand.followed ? <UnfollowThreadIcon /> : <FollowThreadIcon />}
            {formatMessage({
              id: task
                ? followCommand.followed ? "task.follow.unfollow" : "task.follow.follow"
                : followCommand.followed ? "message.messageItem.unfollowThread" : "message.messageItem.followThread",
            })}
          </DropdownMenuItem>
        )}
        {trailingItems}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
