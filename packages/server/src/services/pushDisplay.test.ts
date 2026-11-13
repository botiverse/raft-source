import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  formatPushBody,
  formatPushServerLabel,
  formatPushSurfaceTitle,
  summarizePushBody,
  toNotificationPlainText,
} from "./pushDisplay";

test("push display preview normalizes and bounds message content", () => {
  assert.equal(summarizePushBody("  hello\n\nworld  ", 0), "hello world");
  const preview = summarizePushBody("x".repeat(141), 0);
  assert.equal(preview.length, 140);
  assert.equal(preview, `${"x".repeat(139)}…`);
});

test("push display preview uses attachment and empty fallbacks", () => {
  assert.equal(summarizePushBody("", 1), "Sent an attachment");
  assert.equal(summarizePushBody("", 3), "Sent 3 attachments");
  assert.equal(summarizePushBody("", 0), "(no text)");
});

test("notification preview strips common Markdown without losing readable content", () => {
  assert.equal(
    summarizePushBody(
      [
        "## **Release ready**",
        "> - [x] Read the [runbook](https://example.com/runbook).",
        "Reply to @John in #proj-backend-general 🚀",
      ].join("\n"),
      0,
    ),
    "Release ready Read the runbook. Reply to @John in #proj-backend-general 🚀",
  );
});

test("notification preview preserves code, image alt, autolinks, escapes, and CJK", () => {
  assert.equal(
    summarizePushBody(
      [
        "```ts",
        "const ready = true;",
        "```",
        "![架构图](https://example.com/diagram.png)",
        "<https://raft.ai> \\*literal\\* &amp; `inline()`",
      ].join("\n"),
      0,
    ),
    "const ready = true; 架构图 https://raft.ai *literal* & inline()",
  );
  assert.equal(toNotificationPlainText("snake_case and _emphasis_"), "snake_case and emphasis");
});

test("notification preview strips Markdown before applying its length bound", () => {
  const preview = summarizePushBody(`**${"界".repeat(141)}**`, 0);
  assert.equal(preview, `${"界".repeat(139)}…`);
  assert.equal(preview.length, 140);
});

test("notification preview bounds Markdown parser input before parsing", () => {
  const preview = toNotificationPlainText(`${"a".repeat(2_048)}never parsed`);
  assert.equal(preview, "a".repeat(2_048));
});

test("notification preview stays bounded for adversarial max-size Markdown", () => {
  const startedAt = performance.now();
  const preview = summarizePushBody("[".repeat(32_000), 0);
  const elapsedMs = performance.now() - startedAt;

  assert.ok(preview.length <= 140);
  assert.ok(
    elapsedMs < 250,
    `expected bounded Markdown preview under 250ms, received ${elapsedMs.toFixed(1)}ms`,
  );
});

test("push display formatting stays shared by Web and APNs", () => {
  assert.equal(formatPushServerLabel("  Raft Team  ", "fallback"), "Raft Team");
  assert.equal(formatPushServerLabel("  ", "fallback"), "fallback");
  assert.equal(formatPushSurfaceTitle("#general", "Raft Team"), "#general · Raft Team");
  const preview = summarizePushBody("**hello** [team](https://raft.ai)", 0);
  assert.equal(formatPushBody("Alice", preview), "Alice: hello team");
});

// Task #54: Web Push, APNs and socket notifications now share the desktop's
// parser, so ** next to CJK punctuation is stripped and a hard line break keeps
// a space; tables still read "Header: value".
test("push preview strips ** next to CJK punctuation and keeps tables and line breaks readable", () => {
  assert.equal(summarizePushBody("这是**“重点”**。", 0), "这是“重点”。");
  assert.equal(summarizePushBody("日本語の**「強調」**です", 0), "日本語の「強調」です");
  assert.equal(summarizePushBody('a**"b"**c', 0), 'a**"b"**c');
  assert.equal(summarizePushBody("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |", 0), "a: 1 b: 2 a: 3 b: 4");
  assert.equal(summarizePushBody("line1  \nline2", 0), "line1 line2");
});

// The formatters moved to @botiverse/raft-shared (notificationDisplay) so the
// desktop shares them. Web Push and mobile output must be byte-identical to
// the pre-move implementation, pinned here verbatim.
test("push display: shared formatters keep the pre-move web/mobile output", () => {
  const legacySummarize = (content: string, attachmentCount: number) => {
    const normalized = toNotificationPlainText(content).replace(/\s+/g, " ").trim();
    if (normalized) return normalized.length <= 140 ? normalized : `${normalized.slice(0, 139)}…`;
    if (attachmentCount === 1) return "Sent an attachment";
    if (attachmentCount > 1) return `Sent ${attachmentCount} attachments`;
    return "(no text)";
  };
  const corpus = ["", "  ", "hi", "**bold** _em_ `code`", "x".repeat(139), "x".repeat(140), "x".repeat(141), "a\n\nb\tc", "[l](https://x)", "<b>&amp;</b>"];
  for (const content of corpus) {
    for (const attachments of [0, 1, 3]) {
      assert.equal(summarizePushBody(content, attachments), legacySummarize(content, attachments), JSON.stringify([content, attachments]));
    }
  }
  assert.equal(formatPushSurfaceTitle("#eng", formatPushServerLabel(" Acme ", "acme")), "#eng · Acme");
  assert.equal(formatPushServerLabel(null, "acme"), "acme");
  assert.equal(formatPushBody("Ann", "hi"), "Ann: hi");
});
