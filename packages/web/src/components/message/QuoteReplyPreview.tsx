import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import {
  MessageQuotedPreview,
  MessageQuotedPreviewAuthor,
  MessageQuotedPreviewAuthorName,
  MessageQuotedPreviewContent,
  MessageQuotedPreviewHeader,
  MessageQuotedPreviewText,
  MessageQuotedPreviewTimestamp,
} from "@botiverse/raft-ui";
import type { ResolvedInlineQuote } from "@botiverse/raft-shared";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useJumpToQuotedMessage } from "./useJumpToQuotedMessage";

export interface QuoteReplyPreviewProps {
  messageId: string;
  blockIndex: number;
  excerpt: string;
  quote: ResolvedInlineQuote;
  /** Read-only share screenshot projection renders non-interactively. */
  readOnly?: boolean;
}

/**
 * Clickable quote bar rendered inline within a message body for each
 * server-verified `> <excerpt>\n> msg=<id>` block, built on raft-ui's
 * `MessageQuotedPreview` (`data-frame="bar"`, 2px `line-seam` bar on the left,
 * no card frame — per Raft Design System `cards-in-messages.md` &
 * `message-quoted-preview.md`).
 *
 * Marks `[data-quote-reply-preview="true"]` so right-clicking inside the quote
 * block hides the redundant "Quote" context-menu item and text-selection
 * quoting ignores selections originating inside the quote preview.
 */
export function QuoteReplyPreview({
  messageId,
  blockIndex,
  excerpt,
  quote,
  readOnly = false,
}: QuoteReplyPreviewProps) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const { jumpToQuotedMessage, jumping } = useJumpToQuotedMessage();

  const formattedTime = useMemo(() => {
    if (!quote.createdAt || Number.isNaN(Date.parse(quote.createdAt))) return "";
    return formatShortDateTime(quote.createdAt).replace(",", " ·");
  }, [formatShortDateTime, quote.createdAt]);

  const displayExcerpt = excerpt || formatMessage({ id: "message.quoteReply.emptyExcerpt" });
  const testId = blockIndex === 0
    ? `message-quote-reply-${messageId}`
    : `message-quote-reply-${messageId}-${blockIndex}`;

  const handleClick = useCallback(() => {
    if (readOnly) return;
    void jumpToQuotedMessage(quote.messageId, quote.isPartial ? excerpt : undefined);
  }, [excerpt, jumpToQuotedMessage, quote.isPartial, quote.messageId, readOnly]);

  if (readOnly) {
    return (
      <MessageQuotedPreview
        data-testid={testId}
        data-quote-reply-preview="true"
        data-quote-target-id={quote.messageId}
        className="my-1.5 first:mt-0 max-w-[560px]"
      >
        <MessageQuotedPreviewHeader>
          <MessageQuotedPreviewAuthor>
            <MessageQuotedPreviewAuthorName>{quote.author.name}</MessageQuotedPreviewAuthorName>
          </MessageQuotedPreviewAuthor>
          {formattedTime ? (
            <MessageQuotedPreviewTimestamp>{formattedTime}</MessageQuotedPreviewTimestamp>
          ) : null}
        </MessageQuotedPreviewHeader>
        <MessageQuotedPreviewContent>
          <MessageQuotedPreviewText>{displayExcerpt}</MessageQuotedPreviewText>
        </MessageQuotedPreviewContent>
      </MessageQuotedPreview>
    );
  }

  return (
    <MessageQuotedPreview
      render={<button type="button" disabled={jumping} />}
      onClick={handleClick}
      data-testid={testId}
      data-quote-reply-preview="true"
      data-quote-target-id={quote.messageId}
      aria-label={formatMessage(
        { id: "message.quoteReply.jumpAria" },
        { author: quote.author.name, excerpt: displayExcerpt.slice(0, 120) },
      )}
      className="my-1.5 first:mt-0 block max-w-[560px] cursor-pointer select-none rounded-r-control py-1 pr-2 text-left transition-colors hover:bg-fill-subtle outline-none focus-visible:shadow-focus disabled:opacity-60"
    >
      <MessageQuotedPreviewHeader>
        <MessageQuotedPreviewAuthor>
          <MessageQuotedPreviewAuthorName>{quote.author.name}</MessageQuotedPreviewAuthorName>
        </MessageQuotedPreviewAuthor>
        {formattedTime ? (
          <MessageQuotedPreviewTimestamp>{formattedTime}</MessageQuotedPreviewTimestamp>
        ) : null}
      </MessageQuotedPreviewHeader>
      <MessageQuotedPreviewContent>
        <MessageQuotedPreviewText>{displayExcerpt}</MessageQuotedPreviewText>
      </MessageQuotedPreviewContent>
    </MessageQuotedPreview>
  );
}
