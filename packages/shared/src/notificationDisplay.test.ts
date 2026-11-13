import assert from "node:assert/strict";
import {
  boundNotificationPreview,
  formatNotificationSurface,
  formatPushBody,
  formatPushServerLabel,
  formatPushSurfaceTitle,
  formatTaskSurface,
  notificationPlainText,
} from "./notificationDisplay";

test("notification display: Slack-style surfaces and bodies", () => {
  const server = formatPushServerLabel("  Acme ", "acme");
  assert.equal(formatPushServerLabel(" ", "acme"), "acme");
  assert.equal(formatPushSurfaceTitle(formatNotificationSurface({ kind: "dm" }), server), "DM · Acme");
  assert.equal(formatPushSurfaceTitle(formatNotificationSurface({ kind: "channel", channelName: "eng" }), server), "#eng · Acme");
  assert.equal(
    formatPushSurfaceTitle(formatNotificationSurface({ kind: "thread", parentKind: "channel", parentChannelName: "eng" }), server),
    "Thread in #eng · Acme",
  );
  assert.equal(formatNotificationSurface({ kind: "thread", parentKind: "dm" }), "Thread in DM");
  assert.equal(formatNotificationSurface({ kind: "thread", parentKind: "channel", parentChannelName: null }), "Thread");
  assert.equal(formatPushBody("Ann", "hi"), "Ann: hi");
  assert.equal(formatTaskSurface({ number: 12, title: "Fix login" }), "#12 Fix login");
});

test("notification display: preview bounds and attachment fallbacks", () => {
  assert.equal(boundNotificationPreview("  a\n\n b ", 0), "a b");
  const long = boundNotificationPreview("x".repeat(200), 0);
  assert.equal(long.length, 140);
  assert.ok(long.endsWith("…"));
  assert.equal(boundNotificationPreview("", 1), "Sent an attachment");
  assert.equal(boundNotificationPreview(" ", 3), "Sent 3 attachments");
  assert.equal(boundNotificationPreview("", 0), "(no text)");
});

test("notification display: markdown never leaks into the plain text", () => {
  assert.equal(notificationPlainText("**bold** and _em_ and `code`"), "bold and em and code");
  assert.equal(notificationPlainText("see [the docs](https://x.test) now"), "see the docs now");
  assert.equal(notificationPlainText("```ts\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(notificationPlainText("# Title\n\n- one\n- two"), "Title\none\ntwo");
  assert.equal(notificationPlainText("a <b>tag</b> ~~gone~~"), "a tag gone");
  assert.equal(notificationPlainText("![chart](x.png)"), "chart");
  assert.equal(notificationPlainText("> quoted"), "quoted");
});

test("notification text drops ** next to CJK punctuation like the message renderer (task #54)", () => {
  assert.equal(notificationPlainText("这是**“重点”**。"), "这是“重点”。");
  assert.equal(notificationPlainText("日本語の**「強調」**です"), "日本語の「強調」です");
  assert.equal(notificationPlainText('a**"b"**c'), 'a**"b"**c');
});

test("notification text reads a table as 'Header: value', a row at a time", () => {
  assert.equal(
    notificationPlainText("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"),
    "a: 1\nb: 2\na: 3\nb: 4",
  );
  assert.equal(notificationPlainText("| **h** | b |\n|---|---|\n| `x` | [l](u) |"), "h: x\nb: l");
});
