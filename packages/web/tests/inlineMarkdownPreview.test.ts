import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import InlineMarkdownPreview from "../src/components/markdown/InlineMarkdownPreview";

test("inline markdown preview flattens block markdown for line-clamped cards", () => {
  const html = renderToStaticMarkup(
    createElement(InlineMarkdownPreview, {
      markdown: [
        "完整 8 条 DM 草稿如下：",
        "",
        "1. 第一条很长的内容",
        "2. 第二条也很长",
        "",
        "> quoted block",
      ].join("\n"),
    }),
  );

  assert.match(html, /完整 8 条 DM 草稿如下/);
  assert.match(html, /第一条很长的内容/);
  assert.match(html, /第二条也很长/);
  assert.match(html, /quoted block/);
  assert.doesNotMatch(html, /<(ol|ul|li|blockquote|p|h[1-6]|pre|table|thead|tbody|tr|th|td)\b/);
});
