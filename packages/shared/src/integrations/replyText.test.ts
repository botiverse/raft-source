import assert from "node:assert/strict";
import { test } from "vitest";
import { APP_REPLY_TEXT_MAX_LENGTH, appReplyText, formatAppReplyTextBlock } from "./replyText";

test("appReplyText: only a JSON object's non-blank string `text` counts", () => {
  for (const body of [null, "text", [{ text: "in an array" }], {}, { text: 3 }, { text: { line: "x" } }, { text: " \n\t " }]) {
    assert.equal(appReplyText(body), null, JSON.stringify(body));
  }
  assert.deepEqual(appReplyText({ text: "  Done.  \n" }), { text: "Done." });
});

test("appReplyText: every line break becomes \\n, controls a space, invisible marks nothing", () => {
  assert.equal(appReplyText({ text: "a\r\nb\rc d\u0085e" })?.text, "a\nb\nc\nd\ne");
  assert.equal(appReplyText({ text: "red\u001b[31m bell\u0007" })?.text, "red [31m bell");
  assert.equal(appReplyText({ text: "zero​width ‮flip﻿" })?.text, "zerowidth flip");
});

test("appReplyText: redaction sees the cleaned text, so an invisible mark cannot split a secret", () => {
  const redact = (value: string) => value.replace(/\bsk_agent_[A-Za-z0-9]+/g, "sk_agent_<redacted>").replaceAll("cookie-value", "<redacted>");
  assert.equal(appReplyText({ text: "key sk_agent_​ABCDEF123 and cookie-‍value" }, redact)?.text, "key sk_agent_<redacted> and <redacted>");
});

test("appReplyText: cut at the limit, never inside a surrogate pair, and the full length is kept", () => {
  const long = appReplyText({ text: "x".repeat(APP_REPLY_TEXT_MAX_LENGTH + 10) });
  assert.deepEqual(long, { text: `${"x".repeat(APP_REPLY_TEXT_MAX_LENGTH)}…`, cutFrom: APP_REPLY_TEXT_MAX_LENGTH + 10 });
  const emoji = appReplyText({ text: `${"x".repeat(APP_REPLY_TEXT_MAX_LENGTH - 1)}😀tail` });
  assert.equal(emoji?.text, `${"x".repeat(APP_REPLY_TEXT_MAX_LENGTH - 1)}…`);
});

test("formatAppReplyTextBlock: every line quoted; the cut note's second sentence is the caller's", () => {
  assert.deepEqual(formatAppReplyTextBlock({ text: "one\ntwo" }), ["  │ one\n  │ two"]);
  const cut = { text: "x…", cutFrom: 5000 };
  assert.equal(formatAppReplyTextBlock(cut)[1], "text cut at 4000 of 5000 characters. The action already ran: do not run it again to see the rest. A read action can be rerun with --json.");
  assert.equal(formatAppReplyTextBlock(cut, "")[1], "text cut at 4000 of 5000 characters.");
});
