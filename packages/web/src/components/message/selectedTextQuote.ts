/**
 * Selection-quote v0 (#proj-chat task #32).
 *
 * When a user highlights part of a message and picks "Quote" from the
 * floating selected-text shortcut, the highlighted plain text is wrapped as a
 * markdown blockquote and appended to the composer draft of the surface the
 * message lives in (channel timeline composer, or the thread composer when the
 * message is a thread reply / thread parent rendered in ThreadPanel).
 *
 * Routing is by `channelId`: the selected-text shortcut resolves the correct
 * composer channelId from message metadata, and the live MessageInput for that
 * channelId pulls the quote in + focuses.
 *
 * v0 known limitation (tracked for v1): the quoted text is
 * `Selection.toString()` — the rendered plain text. Source markdown
 * (bold/links/code) is NOT preserved; `Hello **world**` quotes as
 * `Hello world`. v1 will do DOM→markdown roundtrip or source-offset slicing.
 */

export const SELECTED_TEXT_QUOTE_EVENT = "slock:selected-text-quote";

export interface SelectedTextQuoteDetail {
  /** Composer channelId the quote should land in. */
  channelId: string;
  /** Markdown blockquote (no surrounding blank lines). */
  quote: string;
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
 * Format the selection and notify the live composer for `channelId` to append
 * it + focus. Returns false (no-op) when the selection is effectively empty.
 */
export function emitSelectedTextQuote(channelId: string, selectedText: string): boolean {
  if (!hasQuotableSelection(selectedText)) return false;
  if (typeof window === "undefined") return false;
  const quote = formatSelectedTextQuote(selectedText);
  window.dispatchEvent(
    new CustomEvent<SelectedTextQuoteDetail>(SELECTED_TEXT_QUOTE_EVENT, {
      detail: { channelId, quote },
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
