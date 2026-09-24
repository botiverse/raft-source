import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import { Bookmark, MessageSquare, SmilePlus } from "lucide-react";
import { useMediaQuery } from "../../hooks/effectPrimitives";

/**
 * MessageHoverToolbar — the "骑线按钮组" (stdrc, task #44).
 *
 * A compact square pill that rides on a message row's top border (Slack-style),
 * revealed on row hover. Modelled on the theme-poc `themes/skins/regular`
 * MessageRow hover pill: straddles the row's top edge (`-top-3.5`) and floats
 * off the line with a hard `shadow-brutal-sm`. Buttons sit flush (no gap / no
 * padding) so their hover background reaches the pill border — `overflow-hidden`
 * clips it to the border — and the hover tint follows SegmentedControl
 * (`bg-soft-signal/30`).
 *
 * The parent row must be `position: relative` (this renders absolutely against
 * it) and must allow vertical overflow (ChatPanel / ThreadPanel:
 * `overflow: clip visible`) so the pill isn't clipped above the row.
 */
export interface MessageHoverToolbarProps {
  /** Whether the message is currently saved/bookmarked. */
  isSaved: boolean;
  /** Whether the reaction picker is open (keeps the reaction button lit). */
  reactionActive: boolean;
  /** Hide the thread-reply action (e.g. inside a thread panel). */
  hideThreadActions?: boolean;
  /** System messages get no reaction action. */
  isSystem?: boolean;
  /** Read access does not imply reaction mutation authority. */
  canReact?: boolean;
  onReplyInThread: (e: MouseEvent) => void;
  onReactionClick: (e: MouseEvent<HTMLButtonElement>) => void;
  onToggleSave: (e: MouseEvent) => void;
}

// Flush square buttons; hover tint matches SegmentedControl's hover.
const BUTTON = "flex size-6 items-center justify-center hover:bg-soft-signal/30";

export function MessageHoverToolbar({
  isSaved,
  reactionActive,
  hideThreadActions,
  isSystem,
  canReact = true,
  onReplyInThread,
  onReactionClick,
  onToggleSave,
}: MessageHoverToolbarProps) {
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const { formatMessage } = useIntl();

  if (coarsePointer) return null;

  return (
    <div
      // Keep the transparent toolbar hit-testable. Half of it sits above the
      // row; disabling its pointer events makes the row lose :hover while the
      // cursor crosses that edge, so the controls can disappear under a click.
      className={`absolute -top-3.5 right-2 z-20 flex items-center overflow-hidden border-2 border-black bg-white shadow-brutal-sm transition-opacity ${
        reactionActive
          ? "opacity-100"
          : "opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100"
      }`}
      data-message-affordance="toolbar"
    >
      {!hideThreadActions && (
        <button
          type="button"
          onClick={onReplyInThread}
          aria-label={formatMessage({ id: "message.messageItem.replyInThread" })}
          data-message-affordance="thread"
          className={`${BUTTON} text-black/50 hover:text-black`}
        >
          <MessageSquare size={13} />
        </button>
      )}
      {!isSystem && canReact && (
        <button
          type="button"
          onClick={onReactionClick}
          aria-label={formatMessage({ id: "message.messageItem.addReaction" })}
          aria-expanded={reactionActive}
          data-message-affordance="reaction"
          className={`${BUTTON} ${reactionActive ? "text-black" : "text-black/50 hover:text-black"}`}
        >
          <SmilePlus size={13} strokeWidth={2} />
        </button>
      )}
      <button
        type="button"
        onClick={onToggleSave}
        aria-label={isSaved ? formatMessage({ id: "message.messageItem.removeFromSaved" }) : formatMessage({ id: "message.messageItem.saveMessage" })}
        data-message-affordance="bookmark"
        className={`${BUTTON} ${isSaved ? "text-brutal-orange" : "text-black/50 hover:text-black"}`}
      >
        <Bookmark size={13} fill={isSaved ? "currentColor" : "none"} />
      </button>
    </div>
  );
}
