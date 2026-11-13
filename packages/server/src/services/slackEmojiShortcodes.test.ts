import assert from "node:assert/strict";
import { renderSlackEmojiShortcodes } from "./slackEmojiShortcodes";

test("Slack standard aliases and adjacent emoji render as Unicode", () => {
  assert.equal(renderSlackEmojiShortcodes(":test_tube::white_check_mark: :+1: :thumbsup: :cn:"), "🧪✅ 👍 👍 🇨🇳");
  assert.equal(renderSlackEmojiShortcodes("中文 🧪 :slightly_smiling_face:"), "中文 🧪 🙂");
});

test("skin tones use the exact provider sequence including ZWJ and mixed-tone variants", () => {
  assert.equal(renderSlackEmojiShortcodes(":+1::skin-tone-4: :female-technologist::skin-tone-4:"), "👍🏽 👩🏽‍💻");
  assert.equal(renderSlackEmojiShortcodes(":handshake::skin-tone-2::skin-tone-6:"), "🫱🏻‍🫲🏿");
});

test("custom, unknown and invalid tone combinations remain readable source text", () => {
  const source = ":workspace_parrot: :future_emoji: :heart::skin-tone-4: :thumbsup::skin-tone-7:";
  assert.equal(renderSlackEmojiShortcodes(source), source);
});

test("code, URLs, Slack tokens and escaped shortcodes retain their literal content", () => {
  const literal = "`const emoji = ':test_tube:'`\n```js\n:test_tube:\n```\nhttps://example.com/:test_tube: <https://example.com|:test_tube:> <@U123> \\:test_tube:";
  assert.equal(renderSlackEmojiShortcodes(`${literal}\n:test_tube:`), `${literal}\n🧪`);
  assert.equal(renderSlackEmojiShortcodes("```unclosed\n:test_tube:"), "```unclosed\n:test_tube:");
});

test("flag expansion cannot overflow the existing message body bound or drop source content", () => {
  const source = ":cn:".repeat(10_000);
  const rendered = renderSlackEmojiShortcodes(source);
  assert.equal(rendered, source);
  assert.equal(Buffer.byteLength(rendered, "utf8"), 40_000);
});


test("escaped tone sequences and case-insensitive HTTP schemes retain literal bytes", () => {
  const literal = "\\:thumbsup::skin-tone-4: \\:handshake::skin-tone-2::skin-tone-6: HTTPS://example.test/:test_tube: HtTp://example.test/:thumbsup:";
  assert.equal(renderSlackEmojiShortcodes(`${literal} :test_tube:`), `${literal} 🧪`);
  assert.equal(renderSlackEmojiShortcodes(":THUMBSUP:"), ":THUMBSUP:");
  const invalid = ":thumbsup::skin-tone-4::skin-tone-5::skin-tone-6:";
  assert.equal(renderSlackEmojiShortcodes(invalid), invalid);
});
