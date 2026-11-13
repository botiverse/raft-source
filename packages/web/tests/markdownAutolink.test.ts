import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { afterEach, beforeEach, describe, vi } from "vitest";
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

test("keeps CJK comma outside bare URL autolinks", () => {
  const html = renderMarkdown("slock 深度用户 https://x.com/Trader_Pheneck，给了些反馈，在");

  assert.match(html, /<a href="https:\/\/x\.com\/Trader_Pheneck"/);
  assert.match(html, />https:\/\/x\.com\/Trader_Pheneck<\/a>，给了些反馈，在/);
  assert.doesNotMatch(html, /href="https:\/\/x\.com\/Trader_Pheneck，/);
});

test("bold around a bare URL closes when CJK text follows without a space", () => {
  const html = renderMarkdown("**1. https://github.com/botiverse/holt-platform**（平台本身，约 2,100 行");

  assert.match(html, /<strong>1\. <a href="https:\/\/github\.com\/botiverse\/holt-platform">https:\/\/github\.com\/botiverse\/holt-platform<\/a><\/strong>（平台本身，约 2,100 行/);
  assert.doesNotMatch(html, /\*\*/);
});

test("the same with Han text right after the marks, and for italics and strikethrough", () => {
  assert.match(renderMarkdown("**https://x.com/a**说明"), /<strong><a href="https:\/\/x\.com\/a">https:\/\/x\.com\/a<\/a><\/strong>说明/);
  assert.match(renderMarkdown("*https://x.com/a*说明"), /<em><a href="https:\/\/x\.com\/a">https:\/\/x\.com\/a<\/a><\/em>说明/);
  assert.match(renderMarkdown("请看**https://x.com/a**（说明"), /请看<strong><a href="https:\/\/x\.com\/a">https:\/\/x\.com\/a<\/a><\/strong>（说明/);
  assert.match(renderMarkdown("~~https://x.com/a~~说明"), /<del><a href="https:\/\/x\.com\/a">https:\/\/x\.com\/a<\/a><\/del>说明/);
});

test("two bold URLs in one paragraph each close", () => {
  const html = renderMarkdown("**https://a.com/x**（甲）和 **https://b.com/y**（乙）");

  assert.match(html, /<strong><a href="https:\/\/a\.com\/x">[^<]*<\/a><\/strong>（甲）和 <strong><a href="https:\/\/b\.com\/y">[^<]*<\/a><\/strong>（乙）/);
});

test("keeps marks in a URL when nothing opened them before it", () => {
  assert.match(renderMarkdown("见 https://x.com/a**b"), /href="https:\/\/x\.com\/a\*\*b"/);
  assert.match(renderMarkdown("\\*\\*见 https://x.com/a**b"), /href="https:\/\/x\.com\/a\*\*b"/);
  assert.match(renderMarkdown("2 * 3 见 https://x.com/a*b"), /href="https:\/\/x\.com\/a\*b"/);
  assert.match(renderMarkdown("2*3 见 https://x.com/a*b"), /href="https:\/\/x\.com\/a\*b"/);
  assert.match(renderMarkdown("a*b https://x.com/c*d"), /href="https:\/\/x\.com\/c\*d"/);
  assert.match(renderMarkdown("file_*.txt https://x.com/q?a=*b"), /href="https:\/\/x\.com\/q\?a=\*b"/);
  assert.match(renderMarkdown("\\*见 https://x.com/a*b"), /href="https:\/\/x\.com\/a\*b"/);
  assert.match(renderMarkdown("&ast;见 https://x.com/a*。"), /href="https:\/\/x\.com\/a\*"/);
  assert.match(renderMarkdown("*见 https://x.com/q?a=*b"), /href="https:\/\/x\.com\/q\?a=\*b"/);
  assert.match(renderMarkdown("**[https://x.com/a**b](https://x.com/a**b)"), /href="https:\/\/x\.com\/a\*\*b"/);
});

test("keeps URL-internal ASCII punctuation while splitting on CJK punctuation", () => {
  const html = renderMarkdown("see https://example.com/a,b?x=1&y=2，后续");

  assert.match(html, /href="https:\/\/example\.com\/a,b\?x=1&amp;y=2"/);
  assert.match(html, />https:\/\/example\.com\/a,b\?x=1&amp;y=2<\/a>，后续/);
});

test("keeps ASCII comma outside bare URL autolinks when followed by CJK text", () => {
  const html = renderMarkdown("https://cua.ai, 稍后输出机会评分卡。");

  assert.match(html, /<a href="https:\/\/cua\.ai"/);
  assert.match(html, />https:\/\/cua\.ai<\/a>, 稍后输出机会评分卡。/);
  assert.doesNotMatch(html, /href="https:\/\/cua\.ai,/);
});

test("keeps a trailing underscore or tilde in bare URL autolinks", () => {
  const login = "https://claude.ai/oauth/authorize?client_id=9d1c&code_challenge=Ab_cD&state=xY_z__";
  for (const source of [login, `点这里登录：${login}`, `Open ${login}.`, `Open ${login})`]) {
    const html = renderMarkdown(source);
    assert.match(html, /href="https:\/\/claude\.ai\/oauth\/authorize\?client_id=9d1c&amp;code_challenge=Ab_cD&amp;state=xY_z__"/, source);
    assert.match(html, />https:\/\/claude\.ai\/[^<]*state=xY_z__<\/a>/, source);
  }
  assert.match(renderMarkdown("see https://example.com/~a~ now"), /href="https:\/\/example\.com\/~a~">https:\/\/example\.com\/~a~<\/a> now/);
  assert.match(renderMarkdown("https://example.com/x=__init__"), /href="https:\/\/example\.com\/x=__init__"/);
});

test("still lets underscore and tilde marks wrap a bare URL", () => {
  assert.match(renderMarkdown("_see https://example.com/x_"), /<em>see <a href="https:\/\/example\.com\/x">https:\/\/example\.com\/x<\/a><\/em>/);
  assert.match(renderMarkdown("__https://example.com/x__"), /<strong><a href="https:\/\/example\.com\/x">/);
  assert.match(renderMarkdown("~~https://example.com/x~~"), /<del><a href="https:\/\/example\.com\/x">/);
});

test("leaves links that mark their own end alone when text after them starts with _", () => {
  assert.match(renderMarkdown("<https://example.com/x>_foo"), /href="https:\/\/example\.com\/x">https:\/\/example\.com\/x<\/a>_foo/);
  assert.match(renderMarkdown("[https://example.com/x](https://example.com/x)__init"), /href="https:\/\/example\.com\/x">https:\/\/example\.com\/x<\/a>__init/);
});

describe("raft:// links to a server route", () => {
  const ROUTE = "/s/botiverse/channel/11111111-1111-1111-1111-111111111111?msg=aaaaaaaa";
  beforeEach(() => {
    vi.stubGlobal("window", { location: { origin: "https://app.raft.build" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a bare one links to the same route on the web and keeps its text; CJK punctuation stays outside", () => {
    const html = renderMarkdown(`看这条 raft://${ROUTE}，还有 raft://s/botiverse/dm/2222`);

    assert.match(html, new RegExp(`<a href="https://app\\.raft\\.build${ROUTE.replace(/[?.]/g, "\\$&")}">raft://${ROUTE.replace(/[?.]/g, "\\$&")}</a>，还有`));
    assert.match(html, /<a href="https:\/\/app\.raft\.build\/s\/botiverse\/dm\/2222">raft:\/\/s\/botiverse\/dm\/2222<\/a>/);
  });

  test("a written link and an angle autolink point at the web route too", () => {
    const html = renderMarkdown(`[那条消息](raft://${ROUTE}) 和 <raft://${ROUTE}>`);

    assert.match(html, /<a href="https:\/\/app\.raft\.build\/s\/botiverse\/channel\/[^"]+">那条消息<\/a>/);
    assert.match(html, /<a href="https:\/\/app\.raft\.build\/s\/botiverse\/channel\/[^"]+">raft:\/\/\/s\/botiverse/);
  });

  test("a sentence's closing punctuation and quotes stay outside, as GFM leaves them outside an http link", () => {
    const html = renderMarkdown('see raft:///s/acme/channel/general. and "raft:///s/acme/dm/d1"! (raft:///s/acme/channel/c1).');

    assert.match(html, /<a href="https:\/\/app\.raft\.build\/s\/acme\/channel\/general">raft:\/\/\/s\/acme\/channel\/general<\/a>\. and/);
    assert.match(html, /&quot;<a href="https:\/\/app\.raft\.build\/s\/acme\/dm\/d1">raft:\/\/\/s\/acme\/dm\/d1<\/a>&quot;!/);
    assert.match(html, /\(<a href="https:\/\/app\.raft\.build\/s\/acme\/channel\/c1">raft:\/\/\/s\/acme\/channel\/c1<\/a>\)\./);
  });

  test("a reference definition to a raft:// route points at the web route", () => {
    const html = renderMarkdown("[那条消息][r]\n\n[r]: raft:///s/acme/channel/c1");

    assert.match(html, /<a href="https:\/\/app\.raft\.build\/s\/acme\/channel\/c1">那条消息<\/a>/);
  });

  test("other raft:// links stay text; a raft:// inside a word or in code is not a link", () => {
    const html = renderMarkdown("raft:///login?code=x raft:///servers xraft:///s/a/channel/1 éraft:///s/a/channel/1 `raft:///s/a/channel/1`");

    assert.doesNotMatch(html, /<a /);
    assert.match(html, /raft:\/\/\/login\?code=x raft:\/\/\/servers/);
  });
});
