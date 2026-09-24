import { MessageSquare, Pencil } from "lucide-react";
import { useIntl } from "react-intl";
import { Badge } from "raft-ui";

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
      uppercase={false}
      appearance="solid"
      variant="default"
      className={`${hasUnreadReplies ? "bg-brutal-cyan/20" : "bg-white"} text-black transition-colors hover:bg-brutal-cyan/40`}
    >
      {hasReplies ? (
        <>
          <MessageSquare size={12} className="shrink-0" />
          {formatMessage({ id: "message.inlineThreadReplies.replyCount" }, { count: replyCount })}
        </>
      ) : (
        <Pencil size={12} className="shrink-0 text-black/55" />
      )}
      {hasUnreadReplies ? (
        <>
          <span className="text-black/45">·</span>
          <span>
            {formatMessage({ id: "message.inlineThreadReplies.newReplyCount" }, { count: unreadCount })}
          </span>
        </>
      ) : null}
      {hasDraft ? (
        <>
          {shouldShowDraftSeparator ? (
            <span className="text-black/45">·</span>
          ) : null}
          {hasReplies ? (
            <Pencil size={12} className="shrink-0 text-black/55" />
          ) : null}
          <span className="text-black/55">
            {formatMessage({ id: "message.threadRepliesBadge.draft" })}
          </span>
        </>
      ) : null}
    </Badge>
  );
}
