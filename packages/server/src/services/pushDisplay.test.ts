import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "vitest";

import {
  formatPushBody,
  formatPushServerLabel,
  formatPushSurfaceTitle,
  summarizePushBody,
  toNotificationPlainText,
} from "./pushDisplay.js";

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
  const preview = toNotificationPlainText(`${"a".repeat(4_096)}never parsed`);
  assert.equal(preview, "a".repeat(4_096));
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
  assert.equal(formatPushBody("Alice", preview, true), "Alice mentioned you: hello team");
});
