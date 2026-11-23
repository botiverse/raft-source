import type { ResolvedInlineQuote } from "@botiverse/raft-shared";

export type QuoteReplyAuthorType = ResolvedInlineQuote["author"]["type"];

/**
 * Selection-quote v0 (#proj-chat task #32) & Quote Reply v0 (#proj-chat task #34).
 *
 * When `quote_reply_v0` is off on the current server, quoting highlighted text
 * wraps it as a markdown blockquote (`> ...`) and appends it to the target
 * composer draft. When `quote_reply_v0` is on and `source` carries `messageId`,
 * the target composer attaches a structured, jumpable pending quote that
 * serializes as `> <excerpt>\n> msg=<shortId>` on send.
 */

export const SELECTED_TEXT_QUOTE_EVENT = "slock:selected-text-quote";

export interface SelectedTextQuoteSource {
  messageId: string;
  authorName?: string;
  authorType?: QuoteReplyAuthorType;
  createdAt?: string;
  isPartial?: boolean;
}

export interface SelectedTextQuoteDetail {
  /** Composer channelId the quote should land in. */
  channelId: string;
  /** Markdown blockquote (no surrounding blank lines), used when quote_reply_v0 is off. */
  quote: string;
  /** Raw selected text (or whole-message excerpt), used when quote_reply_v0 is on. */
  rawText?: string;
  /** Source message metadata for structured jumpable quote replies. */
  source?: SelectedTextQuoteSource;
}

/**
 * Wrap selected plain text as a markdown blockquote: every line gets a
 * `> ` prefix; blank lines become a bare `>` (no trailing space) so the
 * blockquote stays a single contiguous block in markdown. CRLF/CR are
 * normalized to LF and trailing whitespace is trimmed.
 */
export function formatSelectedTextQuote(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  return normalized
    .split("\n")
    .map((line) => (line.trim().length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * Returns true if the selection has any non-whitespace content worth quoting.
 */
export function hasQuotableSelection(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * Format the selection and notify the live composer for `channelId` to attach
 * or append it + focus. Returns false (no-op) when the selection is effectively empty.
 */
export function emitSelectedTextQuote(
  channelId: string,
  selectedText: string,
  source?: SelectedTextQuoteSource,
): boolean {
  if (!hasQuotableSelection(selectedText) && !source?.messageId) return false;
  if (typeof window === "undefined") return false;
  const quote = hasQuotableSelection(selectedText) ? formatSelectedTextQuote(selectedText) : "";
  const CustomEventCtor = window.CustomEvent ?? CustomEvent;
  window.dispatchEvent(
    new CustomEventCtor<SelectedTextQuoteDetail>(SELECTED_TEXT_QUOTE_EVENT, {
      detail: {
        channelId,
        quote,
        ...(source ? { rawText: selectedText, source } : {}),
      },
    }),
  );
  return true;
}

/**
 * Append a quote block to existing composer content with the canonical
 * spacing: blank line before (if there's prior content) and a trailing blank
 * line so the user types below the quote. Pure string fn — unit-testable and
 * shared by the MessageInput event handler.
 */
export function appendQuoteToComposer(existing: string, quote: string): string {
  const base = existing.replace(/\s*$/, "");
  return base ? `${base}\n\n${quote}\n\n` : `${quote}\n\n`;
}
