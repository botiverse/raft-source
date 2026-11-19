// A thread reply's inline preview (latestReplies[].preview) is a one-row
// glimpse under its parent message. By default it carries the reply's full
// content, which made up most of a thread-heavy channel page. A client that
// renders it as a preview only declares so with `?threadPreviewChars=N`
// (1..THREAD_REPLY_PREVIEW_MAX_CHARS); the server then cuts each preview to N
// user-perceived characters and marks the cut ones `truncated: true`.
// Clients that don't ask (older mobile builds render the preview as a reply's
// first-frame body) get exactly what they got before.
//
// Cut on grapheme boundaries (Intl.Segmenter), so an emoji, a flag, a ZWJ
// sequence or a surrogate pair is never split, and mark the cut with "…".
// The ellipsis counts toward the limit.

export const THREAD_REPLY_PREVIEW_MAX_CHARS = 200;
export const THREAD_PREVIEW_CHARS_PARAM = "threadPreviewChars";
const ELLIPSIS = "…";
// A single grapheme can be arbitrarily long (stacked combining marks); bound
// the kept text in UTF-16 code units too, so one such cluster cannot carry
// the page's bytes back in.
const CODE_UNITS_PER_CHAR = 4;

/**
 * The preview length a request asked for: an integer from 1 up is honoured,
 * capped at THREAD_REPLY_PREVIEW_MAX_CHARS; anything else (absent, repeated,
 * not an integer) means "not asked", i.e. full previews.
 */
export function parseThreadPreviewChars(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw)) return undefined;
  const value = Number(raw);
  if (value < 1) return undefined;
  return Math.min(value, THREAD_REPLY_PREVIEW_MAX_CHARS);
}

let segmenter: Intl.Segmenter | null = null;

/** `content` cut to at most `maxChars` characters, "…" included; unchanged when it fits. */
export function truncateThreadReplyPreview(content: string, maxChars: number): string {
  // Fast path: this many code units can never exceed the grapheme limit.
  if (content.length <= maxChars) return content;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const maxCodeUnits = maxChars * CODE_UNITS_PER_CHAR;
  // `end` is where the kept text stops if a cut is needed: after the first
  // maxChars - 1 graphemes, leaving room for the ellipsis.
  let count = 0;
  let end = 0;
  for (const { segment, index } of segmenter.segment(content)) {
    count += 1;
    const next = index + segment.length;
    if (count > maxChars || next > maxCodeUnits) return content.slice(0, end).trimEnd() + ELLIPSIS;
    if (count < maxChars) end = next;
  }
  return content;
}
