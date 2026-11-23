import { useCallback } from "react";
import { X } from "lucide-react";
import { useIntl } from "react-intl";
import {
  ComposerIconButton,
  MessageQuotedPreview,
  MessageQuotedPreviewAuthor,
  MessageQuotedPreviewAuthorName,
  MessageQuotedPreviewContent,
  MessageQuotedPreviewHeader,
  MessageQuotedPreviewText,
} from "@botiverse/raft-ui";
import Tooltip from "../../components/ui/Tooltip";
import { useJumpToQuotedMessage } from "../../components/message/useJumpToQuotedMessage";
import type { PendingComposerQuote } from "./composerQuoteStore";

export interface ComposerQuoteBarProps {
  pendingQuote: PendingComposerQuote;
  onClear: () => void;
}

/**
 * Compact quote strip inside the top of `<Composer>` (above `<ComposerInput>`),
 * built on raft-ui's `MessageQuotedPreview` and `ComposerIconButton` so it stays
 * inside the composer's single ink border and never collides with the `@`
 * suggestion popover floating above the composer.
 */
export function ComposerQuoteBar({ pendingQuote, onClear }: ComposerQuoteBarProps) {
  const { formatMessage } = useIntl();
  const { jumpToQuotedMessage, jumping } = useJumpToQuotedMessage();

  const excerpt = pendingQuote.excerpt || formatMessage({ id: "message.quoteReply.emptyExcerpt" });

  const handleJump = useCallback(() => {
    void jumpToQuotedMessage(
      pendingQuote.messageId,
      pendingQuote.isPartial ? pendingQuote.excerpt : undefined,
    );
  }, [jumpToQuotedMessage, pendingQuote.excerpt, pendingQuote.isPartial, pendingQuote.messageId]);

  const preventBlur = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
  }, []);

  return (
    <div
      data-testid="composer-quote-bar"
      className="flex items-start gap-2 border-b border-line-hairline px-3 py-2"
    >
      <MessageQuotedPreview
        render={<button type="button" disabled={jumping} />}
        onClick={handleJump}
        aria-label={formatMessage(
          { id: "message.quoteReply.composerJumpAria" },
          { author: pendingQuote.authorName },
        )}
        className="min-w-0 flex-1 cursor-pointer rounded-r-control py-0.5 pr-1 text-left transition-colors hover:bg-fill-subtle outline-none focus-visible:shadow-focus disabled:opacity-60"
      >
        <MessageQuotedPreviewHeader>
          <MessageQuotedPreviewAuthor>
            <MessageQuotedPreviewAuthorName>{pendingQuote.authorName}</MessageQuotedPreviewAuthorName>
          </MessageQuotedPreviewAuthor>
        </MessageQuotedPreviewHeader>
        <MessageQuotedPreviewContent>
          <MessageQuotedPreviewText className="line-clamp-1">
            {excerpt}
          </MessageQuotedPreviewText>
        </MessageQuotedPreviewContent>
      </MessageQuotedPreview>
      <Tooltip content={formatMessage({ id: "message.quoteReply.clearQuote" })}>
        <ComposerIconButton
          type="button"
          onPointerDown={preventBlur}
          onClick={onClear}
          aria-label={formatMessage({ id: "message.quoteReply.clearQuote" })}
          data-testid="composer-quote-clear"
          className="shrink-0"
        >
          <X size={16} />
        </ComposerIconButton>
      </Tooltip>
    </div>
  );
}
