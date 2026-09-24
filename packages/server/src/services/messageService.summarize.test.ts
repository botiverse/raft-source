import { test } from "vitest";
import assert from "node:assert/strict";
import { summarizeForSystemMessage } from "./messageService.js";

test("summarizeForSystemMessage: passes short single-line text through", () => {
  assert.equal(summarizeForSystemMessage("Fix the login bug"), "Fix the login bug");
});

test("summarizeForSystemMessage: collapses newlines and tabs into single spaces", () => {
  const input = "first line\n\nsecond line\twith tab\r\nthird";
  assert.equal(summarizeForSystemMessage(input), "first line second line with tab third");
});

test("summarizeForSystemMessage: trims leading and trailing whitespace", () => {
  assert.equal(summarizeForSystemMessage("   hello world   "), "hello world");
});

test("summarizeForSystemMessage: clips overlong content to maxLen with ellipsis", () => {
  const input = "a".repeat(200);
  const result = summarizeForSystemMessage(input);
  assert.equal(result.length, 80);
  assert.ok(result.endsWith("…"));
});

test("summarizeForSystemMessage: respects custom maxLen", () => {
  assert.equal(summarizeForSystemMessage("abcdefghijklmnop", 5), "abcd…");
});

test("summarizeForSystemMessage: clips multi-paragraph task title to single line", () => {
  // Reproduces the original bug: a long message converted to a task became the
  // task title verbatim, then every claim/status notification embedded that
  // wall of text in the system message body.
  const input = [
    "@Bugen @Tenny @xxchan 被我 at 到的人，thread 里先报道一下",
    "然后把你们 workspace 里（注意，一定不要动 workspace 之外的东西）",
    "node modules、已经合并到 staging 的 worktree、缓存清理一下",
  ].join("\n\n");
  const result = summarizeForSystemMessage(input);
  assert.equal(result.includes("\n"), false);
  assert.ok(result.length <= 80);
  assert.ok(result.endsWith("…"));
});
