import { MessageItemToolbar, MessageItemToolbarButton } from "@botiverse/raft-ui";
import { ThreadIcon } from "@botiverse/ricons";
import { useCallback, useEffect, useRef } from "react";
import type { MouseEvent, PointerEvent } from "react";
import { useIntl } from "react-intl";
import { Bookmark, Ellipsis, BookmarkMinus } from "lucide-react";
import { ForwardIcon } from "./messageForwardIcon";
import ReactionGlyph from "./ReactionGlyph";
import { DEFAULT_FAVORITE_REACTION } from "./reactionFavorite";
import { QUICK_REACTION_HINT_DELAY_MS, REACTION_HOVER_OPEN_DELAY_MS } from "./reactionConstants";
import Tooltip from "../ui/Tooltip";
import { useMediaQuery } from "../../hooks/effectPrimitives";

/**
 * MessageHoverToolbar — the "骑线按钮组" (stdrc, task #44).
 *
 * The DS hover toolbar: a 36px popover strip of 28px icon buttons (4px from
 * its frame and 4px apart) that rides on a message row's top edge, revealed on row hover. Built on RUI's
 * MessageItemToolbar and MessageItemToolbarButton, whose recipe owns its
 * placement, surface and the saved (active) state.
 *
 * The parent row must be `position: relative` (this renders absolutely against
 * it) and must allow vertical overflow (ChatPanel / ThreadPanel:
 * `overflow: clip visible`) so the pill isn't clipped above the row.
 */
export interface MessageHoverToolbarProps {
  /** Whether the message is currently saved/bookmarked. */
  isSaved: boolean;
  /** Whether the reaction picker is open (keeps the toolbar shown). */
  reactionActive: boolean;
  /** The emoji the reaction button adds: the person's most-used one. */
  quickReaction: string;
  /** Whether the person already reacted with it (the button shows pressed). */
  quickReacted: boolean;
  /** Hide the thread-reply action (e.g. inside a thread panel). */
  hideThreadActions?: boolean;
  /** System messages get no reaction action. */
  isSystem?: boolean;
  /** Read access does not imply reaction mutation authority. */
  canReact?: boolean;
  onReplyInThread: (e: MouseEvent) => void;
  /** A tap on a touch screen: open the reaction picker, as before. */
  onReactionClick: (e: MouseEvent<HTMLButtonElement>) => void;
  /** A mouse click, Enter or Space: toggle `quickReaction` on the message. */
  onQuickReact: (e: MouseEvent<HTMLButtonElement>) => void;
  /** The pointer rested on the button: open the reaction picker there. */
  onReactionHoverOpen: (button: HTMLButtonElement) => void;
  onToggleSave: (e: MouseEvent) => void;
  /** Forward this one message (task #35); absent where it can't be forwarded. */
  onForward?: (e: MouseEvent) => void;
  /** Open this message's context menu from the toolbar; absent where there is none. */
  onMore?: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Whether that menu is open (keeps the toolbar shown). */
  moreActive?: boolean;
}

export type MessageHoverToolbarAction = "reaction" | "thread" | "forward" | "bookmark" | "more";

/**
 * The toolbar's buttons, in order. The order follows the message context menu
 * (reaction row, Reply in Thread, Forward, Save), and More opens that menu.
 */
const QUICK_REACTION_HINT_TRIGGER_PROPS = { delay: QUICK_REACTION_HINT_DELAY_MS };
const QUICK_REACTED_CLASS = "bg-attention-soft hover:bg-attention-soft hover:overlay-medium data-popup-open:bg-attention-soft";

export function messageHoverToolbarActions({
  hideThreadActions,
  isSystem,
  canReact = true,
  canForward,
  canMore = false,
}: {
  hideThreadActions?: boolean;
  isSystem?: boolean;
  canReact?: boolean;
  canForward: boolean;
  canMore?: boolean;
}): MessageHoverToolbarAction[] {
  const actions: MessageHoverToolbarAction[] = [];
  if (!isSystem && canReact) actions.push("reaction");
  if (!hideThreadActions) actions.push("thread");
  if (canForward) actions.push("forward");
  actions.push("bookmark");
  if (canMore) actions.push("more");
  return actions;
}

export function MessageHoverToolbar({
  isSaved,
  reactionActive,
  quickReaction,
  quickReacted,
  hideThreadActions,
  isSystem,
  canReact = true,
  onReplyInThread,
  onReactionClick,
  onQuickReact,
  onReactionHoverOpen,
  onToggleSave,
  onForward,
  onMore,
  moreActive = false,
}: MessageHoverToolbarProps) {
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const { formatMessage } = useIntl();
  const actions = messageHoverToolbarActions({ hideThreadActions, isSystem, canReact, canForward: !!onForward, canMore: !!onMore });
  const hoverOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHoverOpen = useCallback(() => {
    if (hoverOpenTimerRef.current) clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = null;
  }, []);
  useEffect(() => cancelHoverOpen, [cancelHoverOpen]);
  // Only a pointer that stays on the button opens the picker; one passing over doesn't.
  const handleReactionPointerEnter = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "touch" || reactionActive) return;
    const button = event.currentTarget;
    cancelHoverOpen();
    hoverOpenTimerRef.current = setTimeout(() => {
      hoverOpenTimerRef.current = null;
      onReactionHoverOpen(button);
    }, REACTION_HOVER_OPEN_DELAY_MS);
  }, [cancelHoverOpen, onReactionHoverOpen, reactionActive]);
  // A tap opens the picker (no quick reaction by touch); a mouse click, Enter
  // or Space (no pointer down at all) reacts.
  const pressPointerTypeRef = useRef<string | null>(null);
  // A press is a click, not a rest: it stops the hover timer, and only leaving
  // and coming back starts it again.
  const handleReactionPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    cancelHoverOpen();
    pressPointerTypeRef.current = event.pointerType;
  }, [cancelHoverOpen]);
  // A press that never became a click (cancelled) leaves no trace, and a key
  // is never a tap, so the next Enter or Space reacts. Not on pointerleave: a
  // tap's pointerleave comes before its click.
  const forgetPress = useCallback(() => {
    pressPointerTypeRef.current = null;
  }, []);
  const handleReactionButtonClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    cancelHoverOpen();
    const byTouch = pressPointerTypeRef.current === "touch";
    pressPointerTypeRef.current = null;
    if (byTouch) onReactionClick(event);
    else onQuickReact(event);
  }, [cancelHoverOpen, onQuickReact, onReactionClick]);
  const isLike = quickReaction === DEFAULT_FAVORITE_REACTION;
  const quickReactionLabel = isLike
    ? formatMessage({ id: quickReacted ? "message.messageItem.quickReaction.unlike" : "message.messageItem.quickReaction.like" })
    : formatMessage({ id: quickReacted ? "message.messageItem.quickReaction.remove" : "message.messageItem.quickReaction.react" }, { emoji: quickReaction });

  if (coarsePointer) return null;

  return (
    <MessageItemToolbar
      data-message-affordance="toolbar"
      // Clear of the conversation outline's rail, while it shows (ConversationOutline).
      className="!right-[calc((--spacing(3))+var(--message-rail-inset,0px))]"
      // No pointer-events override: raft-ui's recipe gates them with the
      // opacity. The row turns both on the moment it is hovered or holds
      // focus, or a popup inside it is open (the reaction and More buttons
      // carry data-popup-open), so the pointer can cross onto the toolbar's
      // upper half without dropping row hover. A hidden toolbar takes no
      // hits, so it can't catch clicks or selection aimed at the end of the
      // previous message, which its upper half overlaps.
    >
      {actions.map((action) => {
        switch (action) {
          case "reaction":
            // Feishu-style (cindyz, Jasper): the person's most-used reaction;
            // a click toggles it like its chip, resting on it opens the picker.
            return (
              <Tooltip
                key={action}
                // The picker replaces the hint: closed while it is open, and it
                // doesn't come back until the picker closes.
                disabled={reactionActive}
                // Sooner than the app's tooltips, so the hint shows before the picker does.
                triggerProps={QUICK_REACTION_HINT_TRIGGER_PROPS}
                content={formatMessage({ id: "message.messageItem.quickReaction.tooltip" }, { action: quickReactionLabel })}
              >
                <MessageItemToolbarButton
                  onClick={handleReactionButtonClick}
                  onPointerEnter={handleReactionPointerEnter}
                  onPointerLeave={cancelHoverOpen}
                  onPointerCancel={forgetPress}
                  onKeyDown={forgetPress}
                  onPointerDown={handleReactionPointerDown}
                  aria-label={quickReactionLabel}
                  aria-pressed={quickReacted}
                  // Pressed reads as the chip of a reaction you added (attention-soft).
                  className={quickReacted ? QUICK_REACTED_CLASS : undefined}
                  data-popup-open={reactionActive ? "" : undefined}
                  data-message-affordance="reaction"
                  data-quick-reaction={quickReaction}
                >
                  <ReactionGlyph emoji={quickReaction} size={16} className="block" />
                </MessageItemToolbarButton>
              </Tooltip>
            );
          case "thread":
            return (
              <MessageItemToolbarButton
                key={action}
                onClick={onReplyInThread}
                aria-label={formatMessage({ id: "message.messageItem.replyInThread" })}
                data-message-affordance="thread"
              >
                <ThreadIcon width={16} height={16} />
              </MessageItemToolbarButton>
            );
          case "forward":
            return (
              <MessageItemToolbarButton
                key={action}
                onClick={onForward}
                aria-label={formatMessage({ id: "message.messageItem.forward" })}
                data-message-affordance="forward"
              >
                <ForwardIcon />
              </MessageItemToolbarButton>
            );
          case "bookmark":
            return (
              <MessageItemToolbarButton
                key={action}
                active={isSaved}
                onClick={onToggleSave}
                aria-label={isSaved ? formatMessage({ id: "message.messageItem.removeFromSaved" }) : formatMessage({ id: "message.messageItem.saveMessage" })}
                data-message-affordance="bookmark"
              >
                {isSaved ? <BookmarkMinus size={16} /> : <Bookmark size={16} />}
              </MessageItemToolbarButton>
            );
          case "more":
            // The whole context menu, so its menu-only actions (Copy Link,
            // Convert to Task…) are findable without opening it by hand.
            return (
              <MessageItemToolbarButton
                key={action}
                onClick={onMore}
                aria-label={formatMessage({ id: "message.messageItem.moreActions" })}
                aria-haspopup="menu"
                aria-expanded={moreActive}
                data-popup-open={moreActive ? "" : undefined}
                data-message-affordance="more"
              >
                <Ellipsis size={16} strokeWidth={2} />
              </MessageItemToolbarButton>
            );
        }
      })}
    </MessageItemToolbar>
  );
}
