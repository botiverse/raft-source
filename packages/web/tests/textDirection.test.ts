import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownContent from "../src/components/markdown/MarkdownContent";
import { MESSAGE_MARKDOWN_REHYPE_PLUGINS, messageMarkdownRemarkPlugins } from "../src/components/message/messageMarkdownSecurity";
import { messageTokenNode } from "../src/components/message/remarkMessageTokens";
import { textDirection } from "../src/utils/textDirection";

// Hands 82e3ca69: Hebrew paragraphs were laid out left to right.
test("a right-to-left script decides rtl, any other letter ltr, none nothing", () => {
  assert.equal(textDirection("אפשר לבדוק את TASK-123 היום?"), "rtl");
  assert.equal(textDirection("مرحبا بالعالم"), "rtl");
  assert.equal(textDirection("Can you check TASK-123 today?"), "ltr");
  assert.equal(textDirection("你好"), "ltr");
  assert.equal(textDirection("123 ?!"), null);
});

test("mentions, refs, links and inline code do not decide the direction", () => {
  assert.equal(textDirection("@alice אפשר לבדוק את TASK-123 היום?"), "rtl");
  assert.equal(textDirection("#general https://example.com `code` שלום"), "rtl");
  assert.equal(textDirection("@alice"), null);
});

// Through the message markdown pipeline as chat renders it: a mention is a
// token `a` node with no href (and a two-word name), inline code goes through
// MarkdownContent's own `code` component.
function renderMessage(source: string, mentionLabel: string) {
  const prependMention = () => (tree: { children: Array<{ type: string; children: unknown[] }> }) => {
    const first = tree.children[0];
    if (first?.type === "paragraph") first.children.unshift(messageTokenNode("a", mentionLabel, { dataMention: "alice", dataMentionType: "user", dataMentionId: "u1" }), { type: "text", value: " " });
  };
  return renderToStaticMarkup(createElement(MarkdownContent, {
    source,
    remarkPlugins: messageMarkdownRemarkPlugins(prependMention),
    rehypePlugins: MESSAGE_MARKDOWN_REHYPE_PLUGINS,
  }));
}

test("a rendered message paragraph skips its mention and inline code: Hebrew after them is rtl", () => {
  assert.match(renderMessage("`npm run` אפשר לבדוק את TASK-123 היום?", "@Alice Smith"), /<p dir="rtl"/);
  assert.match(renderMessage("Can you check TASK-123 today?", "@Alice Smith"), /<p dir="ltr"/);
});

test("a list takes its direction from its text; each item lays out its own", () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, { source: "- פריט ראשון\n- second item" }));
  assert.match(html, /<ul dir="rtl"/);
  assert.match(html, /<li [^>]*class="[^"]*\[unicode-bidi:plaintext\]/);
});
