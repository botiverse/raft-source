// An App's reply text: the top-level string `text` of its JSON answer, success
// or error (docs/raft-app/README.md#reply-text-what-an-agent-reads). The App
// writes it for the agent (what was done, the state now, the next command), so
// `raft integration invoke` and the SDK show it instead of the JSON; the whole
// answer stays available as data (`--json`, the SDK's `data.body`).

import { AGENT_BODY_CONTINUATION_PREFIX, indentAgentBodyContinuationLines, replaceAgentLineBreaks } from "../agentMessageText";

export const APP_REPLY_TEXT_MAX_LENGTH = 4_000;
// Once every line break is `\n`: the controls left (ANSI escapes, backspace,
// C1) are not text for a reader and become a space. Tab and `\n` stay.
const APP_REPLY_TEXT_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Zero-width and bidi marks are invisible: dropped, so they cannot split a
// word (or a credential the redactor has to recognise).
const APP_REPLY_TEXT_INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

export interface AppReplyText {
  /** Clean text: `\n` line breaks only, no controls, at most APP_REPLY_TEXT_MAX_LENGTH characters plus `…` when cut. */
  text: string;
  /** The cleaned text's full length, present only when it was cut. */
  cutFrom?: number;
}

/**
 * The App's reply text, cleaned and capped, or null when the answer has none
 * (not a JSON object, `text` missing, not a string, or blank). `redact` runs on
 * the cleaned string, before the cut, for values the caller must never show
 * (session cookies).
 */
export function appReplyText(body: unknown, redact: (raw: string) => string = (raw) => raw): AppReplyText | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = (body as { text?: unknown }).text;
  if (typeof raw !== "string") return null;
  // Clean, then redact (as appErrorNote does), then cut.
  const cleaned = replaceAgentLineBreaks(raw, "\n").replace(APP_REPLY_TEXT_INVISIBLE, "").replace(APP_REPLY_TEXT_CONTROLS, " ");
  const text = redact(cleaned)
    .replace(/[ \t]+$/gm, "")
    .trim();
  if (!text) return null;
  if (text.length <= APP_REPLY_TEXT_MAX_LENGTH) return { text };
  // Never split a surrogate pair.
  const end = /[\ud800-\udbff]/.test(text[APP_REPLY_TEXT_MAX_LENGTH - 1] ?? "")
    ? APP_REPLY_TEXT_MAX_LENGTH - 1
    : APP_REPLY_TEXT_MAX_LENGTH;
  return { text: `${text.slice(0, end).trimEnd()}…`, cutFrom: text.length };
}

/** What a cut note says after "text cut at N of M characters." on a successful answer. */
export const APP_REPLY_TEXT_CUT_AFTER_RUN = "The action already ran: do not run it again to see the rest. A read action can be rerun with --json.";

/**
 * The App's text as a quoted block: every line, the first too, starts with
 * `  │ ` (free text never starts a line). A cut text gets one note after it;
 * `afterCut` is that note's second sentence (empty for none, as on a refusal,
 * where the action did not run).
 */
export function formatAppReplyTextBlock(reply: AppReplyText, afterCut: string = APP_REPLY_TEXT_CUT_AFTER_RUN): string[] {
  const lines = [`${AGENT_BODY_CONTINUATION_PREFIX}${indentAgentBodyContinuationLines(reply.text)}`];
  if (reply.cutFrom !== undefined) {
    lines.push(`text cut at ${APP_REPLY_TEXT_MAX_LENGTH} of ${reply.cutFrom} characters.${afterCut ? ` ${afterCut}` : ""}`);
  }
  return lines;
}
