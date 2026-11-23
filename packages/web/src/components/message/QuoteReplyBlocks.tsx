import { memo, useMemo } from "react";
import {
  formatPlainBlockquote,
  hasSameConversationQuoteRef,
  parseMessageQuoteSegments,
} from "@botiverse/raft-shared";
import type { ResolvedInlineQuotesMap } from "@botiverse/raft-shared";
import { useHydratedResolvedQuotes } from "../../store/resolvedQuotesHydrationStore";
import { MessageMarkdownBody } from "./MessageMarkdownBody";
import type { MessageMarkdownBodyProps } from "./MessageMarkdownBody";
import { QuoteReplyPreview } from "./QuoteReplyPreview";

export interface QuoteReplyBlocksProps extends MessageMarkdownBodyProps {
  messageId: string;
  quoteReplyEnabled: boolean;
  resolvedQuotes?: ResolvedInlineQuotesMap;
  readOnly?: boolean;
}

/**
 * Renders a message's Markdown content with same-conversation inline Quote
 * Reply (`> <excerpt>\n> msg=<id>`) support when `quote_reply_v0` is enabled:
 * - Verified blocks (present in per-viewer `resolvedQuotes`) render as
 *   interactive `QuoteReplyPreview` bars with author, timestamp, and jump.
 * - Unresolved / degraded blocks (retracted, cross-conversation, behind history
 *   window, spoofed excerpt, or unknown ID) hide the trailing `msg=<id>` line
 *   in Web display and render as clean plain Markdown blockquotes while
 *   `messages.content` and agent reads stay verbatim.
 * - Supports interleaved multi-point quotes in one message with zero overhead
 *   when `content` has no `msg=<id>` quote line or the flag is off.
 */
export const QuoteReplyBlocks = memo(function QuoteReplyBlocks({
  messageId,
  quoteReplyEnabled,
  resolvedQuotes,
  readOnly = false,
  content,
  ...markdownProps
}: QuoteReplyBlocksProps) {
  const mightHaveInlineQuote = quoteReplyEnabled && hasSameConversationQuoteRef(content);
  const hydratedQuotes = useHydratedResolvedQuotes(messageId);
  const effectiveResolvedQuotes = resolvedQuotes ?? hydratedQuotes;

  const segments = useMemo(
    () => (mightHaveInlineQuote ? parseMessageQuoteSegments(content) : null),
    [content, mightHaveInlineQuote],
  );

  if (!segments || !segments.some((seg) => seg.kind === "quote_block")) {
    return <MessageMarkdownBody {...markdownProps} content={content} />;
  }

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "quote_block") {
          const resolved = effectiveResolvedQuotes?.[String(segment.blockIndex)];
          if (resolved) {
            return (
              <QuoteReplyPreview
                key={`quote-${segment.blockIndex}`}
                messageId={messageId}
                blockIndex={segment.blockIndex}
                excerpt={segment.excerpt}
                quote={resolved}
                readOnly={readOnly}
              />
            );
          }
          // Degraded same-conversation quote block: strip trailing `msg=<id>`
          // in Web display and render as a clean plain Markdown blockquote.
          return (
            <div
              key={`quote-degraded-${segment.blockIndex}`}
              data-quote-reply-degraded="true"
              className="my-1.5 first:mt-0"
            >
              <MessageMarkdownBody
                {...markdownProps}
                content={formatPlainBlockquote(segment.excerpt)}
              />
            </div>
          );
        }
        return (
          <MessageMarkdownBody
            key={`text-${index}`}
            {...markdownProps}
            content={segment.text}
          />
        );
      })}
    </>
  );
});
