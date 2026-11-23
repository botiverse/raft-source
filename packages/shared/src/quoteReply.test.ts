import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildWholeMessageQuoteExcerpt,
  extractSameConversationQuoteBlocks,
  formatPlainBlockquote,
  hasSameConversationQuoteRef,
  parseMessageQuoteSegments,
  serializeInlineQuoteReply,
  stripLeadingQuoteReplyBlocks,
  verifyQuoteExcerptInContent,
} from "./quoteReply";

test("parseMessageQuoteSegments parses single top quote and multi-point interleaved quotes", () => {
  const content = [
    "> first quoted sentence",
    "> msg=54a733de",
    "",
    "Reply to point 1.",
    "",
    "> second quoted sentence",
    "> second line of quote",
    "> msg=91C2B8AA",
    "",
    "Reply to point 2.",
  ].join("\n");

  assert.equal(hasSameConversationQuoteRef(content), true);
  const segments = parseMessageQuoteSegments(content);
  assert.deepEqual(segments, [
    {
      kind: "quote_block",
      blockIndex: 0,
      excerpt: "first quoted sentence",
      refId: "54a733de",
      rawMarkdown: "> first quoted sentence\n> msg=54a733de",
    },
    { kind: "text", text: "Reply to point 1." },
    {
      kind: "quote_block",
      blockIndex: 1,
      excerpt: "second quoted sentence\nsecond line of quote",
      refId: "91c2b8aa",
      rawMarkdown: "> second quoted sentence\n> second line of quote\n> msg=91C2B8AA",
    },
    { kind: "text", text: "Reply to point 2." },
  ]);
});

test("parseMessageQuoteSegments ignores plain blockquotes, cross-channel refs, bare msg=, and fenced code blocks", () => {
  const content = [
    "> legacy plain quote",
    "",
    "> #proj-frontend msg=f901c2d3",
    "",
    "> msg=54a733de",
    "",
    "```markdown",
    "> code example quote",
    "> msg=54a733de",
    "```",
    "",
    "~~~txt",
    "> tilde fence quote",
    "> msg=deadbeef",
    "~~~",
  ].join("\n");

  const blocks = extractSameConversationQuoteBlocks(content);
  assert.deepEqual(blocks, []);
});

test("serializeInlineQuoteReply produces canonical 8-char shortId unified format", () => {
  const serialized = serializeInlineQuoteReply(
    "Line one\nLine two",
    "54a733de-0001-4000-8000-000000000001",
    "Sounds good.",
  );
  assert.equal(serialized, "> Line one\n> Line two\n> msg=54a733de\n\nSounds good.");
  const blocks = extractSameConversationQuoteBlocks(serialized);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.excerpt, "Line one\nLine two");
  assert.equal(blocks[0]?.refId, "54a733de");
});

test("formatPlainBlockquote strips nothing from excerpt and adds > markers", () => {
  assert.equal(formatPlainBlockquote("hello\nworld"), "> hello\n> world");
  assert.equal(formatPlainBlockquote("hello\n\nworld"), "> hello\n>\n> world");
});

test("buildWholeMessageQuoteExcerpt uses 120-char first-line truncation and strips leading quote blocks", () => {
  const longFirstLine = "a".repeat(140) + "\nsecond line";
  const res = buildWholeMessageQuoteExcerpt(longFirstLine);
  assert.equal(res.truncated, true);
  assert.equal(res.excerpt, `${"a".repeat(120)}…`);

  const replyWithQuote = "> ancestor quote\n> msg=11111111\n\nMy own answer here.";
  assert.equal(stripLeadingQuoteReplyBlocks(replyWithQuote), "My own answer here.");
  assert.deepEqual(buildWholeMessageQuoteExcerpt(replyWithQuote), {
    excerpt: "My own answer here.",
    truncated: false,
  });
});

test("verifyQuoteExcerptInContent verifies verbatim, stripped Markdown, whole truncated opening, and rejects spoofing", () => {
  const target = "First line with **bold** and `code` and [a link](https://example.com).\n\nSecond paragraph has key detail.";

  assert.deepEqual(verifyQuoteExcerptInContent("key detail", target), {
    verified: true,
    isPartial: true,
  });

  // Rendered HTML text selection strips markdown syntax
  assert.deepEqual(verifyQuoteExcerptInContent("with bold and code and a link", target), {
    verified: true,
    isPartial: true,
  });

  // Whole-message 120-char truncated opening
  const whole = buildWholeMessageQuoteExcerpt(target).excerpt;
  assert.deepEqual(verifyQuoteExcerptInContent(whole, target), {
    verified: true,
    isPartial: false,
  });

  // Spoofed/paraphrased quote MUST fail verification
  assert.deepEqual(verifyQuoteExcerptInContent("words never written here", target), {
    verified: false,
    isPartial: false,
  });
});
