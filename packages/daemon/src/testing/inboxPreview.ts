import assert from "node:assert/strict";

// Task #387: a runtime inbox notice may carry one labelled preview line per
// target with the start of that target's LATEST pending message. A body may
// appear in a notice only there. Use these helpers only where the asserted
// body is that latest message; every other "body not in the notice" check
// stays a strict assert.doesNotMatch.
const INBOX_PREVIEW_LINE = /^ {2}latest(?: @\S+)?: ".*" \((?:truncated )?preview; still unread, full text: raft message read --target ".*" --unread\)$/;

export function stripInboxPreviewLines(text: string): string {
  return String(text).split("\n").filter((line) => !INBOX_PREVIEW_LINE.test(line)).join("\n");
}

/**
 * The latest message's body appears exactly once, and only as the labelled
 * preview line: it is previewed, not delivered.
 */
export function assertBodyOnlyInInboxPreview(text: string, body: RegExp): void {
  const lines = String(text).split("\n").filter((line) => body.test(line));
  assert.equal(lines.length, 1, `expected ${body} on exactly one line (the preview), got ${lines.length}`);
  assert.match(lines[0] ?? "", INBOX_PREVIEW_LINE, `${body} may appear only in the inbox preview line`);
}

/**
 * For an assertion line that runs over several notices, where the body is the
 * latest message (and so previewed) in some and absent in others: the body is
 * never delivered outside the preview line. Do not use it for older messages,
 * trace attrs or secrets; those stay strict assert.doesNotMatch.
 */
export function assertNoMatchOutsideInboxPreview(text: string, pattern: RegExp): void {
  assert.doesNotMatch(stripInboxPreviewLines(text), pattern);
}
