import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import type { Options } from "react-markdown";
import MarkdownContent from "../src/components/markdown/MarkdownContent";
import InlineMarkdownPreview from "../src/components/markdown/InlineMarkdownPreview";
import { MESSAGE_MARKDOWN_REHYPE_PLUGINS, messageMarkdownRemarkPlugins } from "../src/components/message/messageMarkdownSecurity";

// `**` between a CJK letter and CJK punctuation is emphasis (task #54,
// remark-cjk-friendly). Strict CommonMark refused it: `**` followed by
// punctuation only opens after a space or punctuation, and in Chinese or
// Japanese it usually follows a letter. Mobile ports the same rules
// (botiverse/mobile#3483), so both render these the same.

const CJK_CASES: [source: string, strong: string][] = [
  ["你说**“副作用放进 --help 而不只是 PR 正文”这个判断对**——我同意", "“副作用放进 --help 而不只是 PR 正文”这个判断对"],
  ["**中文，**中文", "中文，"],
  ["这是**“重点”**。", "“重点”"],
  ["日本語の**「強調」**です", "「強調」"],
];

// MessageItem always passes its ref matchers, which takes the list with a refs
// plugin in it; render through that one, as chat does.
const noopRefsPlugin = () => () => undefined;

function renderMessage(source: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    children: source,
    remarkPlugins: messageMarkdownRemarkPlugins(noopRefsPlugin) as Options["remarkPlugins"],
    rehypePlugins: MESSAGE_MARKDOWN_REHYPE_PLUGINS,
  }));
}

test("a message bolds ** next to CJK punctuation", () => {
  for (const [source, strong] of CJK_CASES) {
    const html = renderMessage(source);
    assert.ok(html.includes(`<strong>${strong}</strong>`), `${source} → ${html}`);
    assert.ok(!html.includes("**"), `no literal ** in ${html}`);
  }
});

test("Latin text keeps CommonMark's rule: ** between letters and quotes stays literal", () => {
  const html = renderMessage('a**"b"**c');
  assert.ok(!html.includes("<strong>"), html);
  assert.ok(html.includes('a**&quot;b&quot;**c') || html.includes('a**"b"**c'), html);
  assert.ok(renderMessage("plain **bold** text").includes("<strong>bold</strong>"));
});

test("the message list without ref matchers bolds them too", () => {
  const [source, strong] = CJK_CASES[2];
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    children: source,
    remarkPlugins: messageMarkdownRemarkPlugins() as Options["remarkPlugins"],
    rehypePlugins: MESSAGE_MARKDOWN_REHYPE_PLUGINS,
  }));
  assert.ok(html.includes(`<strong>${strong}</strong>`), html);
});

test("documents and inline previews bold the same CJK cases", () => {
  const [source, strong] = CJK_CASES[2];
  const doc = renderToStaticMarkup(createElement(MarkdownContent, { source, density: "document" }));
  assert.ok(doc.includes(`<strong>${strong}</strong>`), doc);
  const inline = renderToStaticMarkup(createElement(InlineMarkdownPreview, { markdown: source }));
  assert.ok(inline.includes(`<strong>${strong}</strong>`), inline);
});
