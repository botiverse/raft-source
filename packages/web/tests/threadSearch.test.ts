import test from "node:test";
import assert from "node:assert/strict";

import {
  buildThreadSearchMatches,
  getThreadSearchableMessages,
  highlightThreadSearchMarkdownFragments,
  isThreadSearchShortcut,
  normalizeThreadSearchQuery,
  normalizeThreadSearchSelectionText,
} from "../src/components/message/threadSearch";

test("thread search shortcut uses Command+F on Apple platforms", () => {
  assert.equal(isThreadSearchShortcut({ key: "f", metaKey: true }, "MacIntel"), true);
  assert.equal(isThreadSearchShortcut({ key: "F", metaKey: true }, "MacIntel"), true);
  assert.equal(isThreadSearchShortcut({ key: "f", ctrlKey: true }, "MacIntel"), false);
  assert.equal(isThreadSearchShortcut({ key: "f", metaKey: true, shiftKey: true }, "MacIntel"), false);
});

test("thread search shortcut uses Ctrl+F on non-Apple platforms", () => {
  assert.equal(isThreadSearchShortcut({ key: "f", ctrlKey: true }, "Win32"), true);
  assert.equal(isThreadSearchShortcut({ key: "f", ctrlKey: true }, "Linux x86_64"), true);
  assert.equal(isThreadSearchShortcut({ key: "f", metaKey: true }, "Win32"), false);
  assert.equal(isThreadSearchShortcut({ key: "k", ctrlKey: true }, "Win32"), false);
});

test("thread search matches content and sender names in thread order", () => {
  const matches = buildThreadSearchMatches(
    [
      { id: "parent", senderName: "Alice", content: "Initial design note" },
      { id: "reply-1", senderName: "Bob", content: "Follow-up about keyboard search" },
      { id: "reply-2", senderName: "Cindy", content: "Lazy loading should be handled" },
    ],
    "search",
  );

  assert.deepEqual(matches, [{ messageId: "reply-1" }]);

  const senderMatches = buildThreadSearchMatches(
    [
      { id: "parent", senderName: "Alice", content: "Initial design note" },
      { id: "reply-1", senderName: "Bob", content: "Follow-up" },
    ],
    "alice",
  );
  assert.deepEqual(senderMatches, [{ messageId: "parent" }]);
});

test("thread search normalizes whitespace and combines parent with replies", () => {
  assert.equal(normalizeThreadSearchQuery("  NeedLe  "), "needle");
  assert.equal(normalizeThreadSearchSelectionText("  selected\n thread\ttext  "), "selected thread text");
  assert.deepEqual(buildThreadSearchMatches([{ id: "a", content: "needle" }], "   "), []);

  const searchable = getThreadSearchableMessages(
    {
      id: "parent",
      channelId: "channel",
      senderType: "user",
      senderId: "user",
      content: "Parent",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    [
      {
        id: "reply",
        channelId: "thread",
        senderType: "user",
        senderId: "user",
        content: "Reply",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ],
  );

  assert.deepEqual(searchable.map((message) => message.id), ["parent", "reply"]);
});

test("thread search fragment highlighting marks visible text only", () => {
  assert.equal(
    highlightThreadSearchMarkdownFragments("Before Needle after needle", " needle "),
    "Before <mark>Needle</mark> after <mark>needle</mark>",
  );
  assert.equal(
    highlightThreadSearchMarkdownFragments("<a data-channel=\"general\">#general</a> needle", "general"),
    "<a data-channel=\"general\">#general</a> needle",
  );
  assert.equal(
    highlightThreadSearchMarkdownFragments("visible needle \x00CODE0\x00", "needle"),
    "visible <mark>needle</mark> \x00CODE0\x00",
  );
  assert.equal(
    highlightThreadSearchMarkdownFragments("safe &amp; &lt;needle&gt;", "<needle>"),
    "safe &amp; <mark>&lt;needle&gt;</mark>",
  );
  assert.equal(
    highlightThreadSearchMarkdownFragments("safe &amp; text", "amp"),
    "safe &amp; text",
  );
});
