/** Stable fallback copy for generic Activity system entries, including older Servers. */
export const PI_RESPONSE_NOTICE_TITLE = "Pi response notice";
export const PI_RESPONSE_NOTICE_TEXT = {
  empty_response: "This model response contained no text or tool calls.",
  whitespace_response: "This model response contained only whitespace.",
} as const;
export type PiResponseNoticeKind = keyof typeof PI_RESPONSE_NOTICE_TEXT;

export function piResponseNoticeKind(title: string, text: string): PiResponseNoticeKind | null {
  if (title !== PI_RESPONSE_NOTICE_TITLE) return null;
  if (text === PI_RESPONSE_NOTICE_TEXT.empty_response) return "empty_response";
  if (text === PI_RESPONSE_NOTICE_TEXT.whitespace_response) return "whitespace_response";
  return null;
}
