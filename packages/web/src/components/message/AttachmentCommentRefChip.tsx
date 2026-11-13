import { useCallback } from "react";
import { CommentIcon } from "@botiverse/ricons";
import { useIntl } from "react-intl";
import type { Message } from "../../store/messageStore";
import { ReferenceChip } from "./ReferenceChip";

export function AttachmentCommentRefChip({
  commentRef,
  onJumpToHost,
  bodyFontSizeClass,
}: {
  commentRef: Message["commentRef"] | null | undefined;
  onJumpToHost: () => void;
  // The chip box (RUI message-reference recipe, via
  // ReferenceChip) renders at its container's font size, so its size comes
  // from this wrapper. Pass the same `messageBodyFontSizeClass`
  // the message body uses so the comment-ref chip scales with the user's
  // font-size preference instead of the outer base size (stdrc task #463: chip
  // looked larger than the body when the preference shrank the body but not the
  // chip).
  bodyFontSizeClass?: string;
}) {
  const { formatMessage } = useIntl();
  const handleJumpToHost = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    onJumpToHost();
  }, [onJumpToHost]);
  if (!commentRef) return null;

  const detail = `${commentRef.filename}${commentRef.anchorLabel ? ` · ${commentRef.anchorLabel}` : ""}`;
  const label = formatMessage({ id: "message.attachment.rePrefix" }, { name: detail });

  return (
    <>
      <div className={`mb-0.5 ${bodyFontSizeClass ?? ""}`}>
        {commentRef.hostSource ? (
          <ReferenceChip
            as="a"
            href="#"
            onClick={handleJumpToHost}
            data-message-affordance="attachment-comment-ref-chip"
            icon={CommentIcon}
            variant="muted"
            label={label}
            title={formatMessage({ id: "message.attachmentComment.jumpTitle" }, { detail })}
          />
        ) : (
          <ReferenceChip
            as="span"
            data-message-affordance="attachment-comment-ref-chip"
            icon={CommentIcon}
            variant="muted"
            label={label}
            title={formatMessage({ id: "message.attachmentComment.commentTitle" }, { detail })}
          />
        )}
      </div>
      {commentRef.anchorQuote ? (
        <div className="mb-1 whitespace-pre-wrap break-words border-l-2 border-line-seam pl-2.5 text-caption font-normal text-foreground-muted">
          {commentRef.anchorQuote}
        </div>
      ) : null}
    </>
  );
}
