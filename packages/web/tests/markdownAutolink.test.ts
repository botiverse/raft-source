import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkAutolinkBareUrls } from "../src/utils/markdownAutolink";

function renderMarkdown(source: string) {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      children: source,
      remarkPlugins: [remarkGfm, remarkAutolinkBareUrls, remarkBreaks],
    }),
  );
}

test("keeps explicit markdown links ahead of bare-url linkification", () => {
  const html = renderMarkdown(
    "来源：[Meta 官方建广告账户](https://www.facebook.com/business/help/407323696966570)、2026 Business Manager 教程",
  );

  assert.match(html, /<a href="https:\/\/www\.facebook\.com\/business\/help\/407323696966570"/);
  assert.match(html, />Meta 官方建广告账户<\/a>、2026 Business Manager 教程/);
  assert.doesNotMatch(html, /\[Meta 官方建广告账户\]/);
  assert.doesNotMatch(html, /href="https:\/\/www\.facebook\.com\/business\/help\/407323696966570\)/);
});

test("keeps CJK comma outside bare URL autolinks", () => {
  const html = renderMarkdown("slock 深度用户 https://x.com/Trader_Pheneck，给了些反馈，在");

  assert.match(html, /<a href="https:\/\/x\.com\/Trader_Pheneck"/);
  assert.match(html, />https:\/\/x\.com\/Trader_Pheneck<\/a>，给了些反馈，在/);
  assert.doesNotMatch(html, /href="https:\/\/x\.com\/Trader_Pheneck，/);
});

test("keeps URL-internal ASCII punctuation while splitting on CJK punctuation", () => {
  const html = renderMarkdown("see https://example.com/a,b?x=1&y=2，后续");

  assert.match(html, /href="https:\/\/example\.com\/a,b\?x=1&amp;y=2"/);
  assert.match(html, />https:\/\/example\.com\/a,b\?x=1&amp;y=2<\/a>，后续/);
});

test("keeps unmatched ASCII closing parens outside bare URL autolinks", () => {
  const html = renderMarkdown("来源：（https://www.facebook.com/business/help/407323696966570）、教程");

  assert.match(html, /（<a href="https:\/\/www\.facebook\.com\/business\/help\/407323696966570"/);
  assert.match(html, />https:\/\/www\.facebook\.com\/business\/help\/407323696966570<\/a>）、教程/);
  assert.doesNotMatch(html, /href="https:\/\/www\.facebook\.com\/business\/help\/407323696966570\)/);
  assert.doesNotMatch(html, /href="https:\/\/www\.facebook\.com\/business\/help\/407323696966570）/);
});

test("preserves balanced ASCII parens inside bare URL autolinks", () => {
  const html = renderMarkdown("read https://example.com/foo_(bar)、then");

  assert.match(html, /<a href="https:\/\/example\.com\/foo_\(bar\)"/);
  assert.match(html, />https:\/\/example\.com\/foo_\(bar\)<\/a>、then/);
});

test("keeps ASCII comma outside bare URL autolinks when followed by CJK text", () => {
  const html = renderMarkdown("https://cua.ai, 稍后输出机会评分卡。");

  assert.match(html, /<a href="https:\/\/cua\.ai"/);
  assert.match(html, />https:\/\/cua\.ai<\/a>, 稍后输出机会评分卡。/);
  assert.doesNotMatch(html, /href="https:\/\/cua\.ai,/);
});
