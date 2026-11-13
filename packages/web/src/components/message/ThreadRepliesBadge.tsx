import { Pencil } from "lucide-react";
import { useIntl } from "react-intl";
import { Badge } from "@botiverse/raft-ui";
import { ThreadIcon } from "@botiverse/ricons";

interface ThreadRepliesBadgeProps {
  replyCount: number;
  unreadCount: number;
  hasDraft: boolean;
  onClick: () => void;
}

export function ThreadRepliesBadge({
  replyCount,
  unreadCount,
  hasDraft,
  onClick,
}: ThreadRepliesBadgeProps) {
  const { formatMessage } = useIntl();
  const hasReplies = replyCount > 0;
  const hasUnreadReplies = unreadCount > 0;
  const shouldShowDraftSeparator = hasReplies || hasUnreadReplies;

  if (!hasReplies && !hasDraft) return null;

  return (
    <Badge
      render={<button type="button" />}
      data-testid="message-thread-replies-badge"
      onClick={onClick}
      appearance={hasUnreadReplies ? "soft" : "solid"}
      variant={hasUnreadReplies ? "information" : "default"}
      className="transition-colors"
    >
      {hasReplies ? (
        <>
          <ThreadIcon width={12} height={12} className="shrink-0" />
          {formatMessage({ id: "message.inlineThreadReplies.replyCount" }, { count: replyCount })}
        </>
      ) : (
        <Pencil size={12} className="shrink-0" />
      )}
      {hasUnreadReplies ? (
        <>
          <span className="opacity-60">·</span>
          <span>
            {formatMessage({ id: "message.inlineThreadReplies.newReplyCount" }, { count: unreadCount })}
          </span>
        </>
      ) : null}
      {hasDraft ? (
        <>
          {shouldShowDraftSeparator ? (
            <span className="opacity-60">·</span>
          ) : null}
          {hasReplies ? (
            <Pencil size={12} className="shrink-0" />
          ) : null}
          <span className="opacity-80">
            {formatMessage({ id: "message.threadRepliesBadge.draft" })}
          </span>
        </>
      ) : null}
    </Badge>
  );
}
