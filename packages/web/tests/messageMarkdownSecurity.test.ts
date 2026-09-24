import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import MarkdownContent from "../src/components/markdown/MarkdownContent";
import {
  escapeUserRawHtmlForMessageMarkdown,
  messageMarkdownSanitizeSchema,
} from "../src/components/message/messageMarkdownSecurity";

function renderMessageMarkdown(source: string) {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      children: source,
      rehypePlugins: [rehypeRaw, [rehypeSanitize, messageMarkdownSanitizeSchema]],
    }),
  );
}

function renderStyledMessageMarkdown(source: string) {
  return renderToStaticMarkup(
    createElement(MarkdownContent, {
      source,
      rehypePlugins: [rehypeRaw, [rehypeSanitize, messageMarkdownSanitizeSchema]],
    }),
  );
}

function renderDefaultMarkdown(source: string) {
  return renderToStaticMarkup(
    createElement(MarkdownContent, {
      source,
    }),
  );
}

function renderEscapedUserMarkdown(source: string) {
  return renderStyledMessageMarkdown(escapeUserRawHtmlForMessageMarkdown(source));
}

test("message markdown renders incomplete raw HTML tags as visible text", () => {
  assert.match(renderEscapedUserMarkdown("<s"), /&lt;s/);
  assert.match(renderEscapedUserMarkdown("<script"), /&lt;script/);
});

test("message markdown renders user raw HTML as text instead of DOM", () => {
  const html = renderEscapedUserMarkdown([
    '<button onclick="alert(1)">Start audio call</button>',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="javascript:alert(1)">bad link</a>',
    '<img src=x onerror="alert(1)">',
    '<input type="checkbox" checked>',
  ].join("\n"));

  assert.match(html, /&lt;button/);
  assert.match(html, /Start audio call/);
  assert.match(html, /&lt;iframe/);
  assert.match(html, /&lt;a href=&quot;javascript:alert\(1\)&quot;&gt;bad link&lt;\/a&gt;/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;input type=&quot;checkbox&quot; checked&gt;/);
  assert.doesNotMatch(html, /<button\b/);
  assert.doesNotMatch(html, /<iframe\b/);
  assert.doesNotMatch(html, /<img\b/);
  assert.doesNotMatch(html, /<input\b/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /<[^>]+\sonerror=/);
  assert.doesNotMatch(html, /<[^>]+\sonclick=/);
});

test("message markdown keeps normal markdown links", () => {
  const html = renderEscapedUserMarkdown("[Slock](https://slock.ai)");

  assert.match(html, /<a href="https:\/\/slock\.ai"/);
  assert.match(html, />Slock<\/a>/);
});

test("message markdown parses explicit markdown links before bare-url linkification", () => {
  const html = renderEscapedUserMarkdown(
    "来源：[Meta 官方建广告账户](https://www.facebook.com/business/help/407323696966570)、2026 Business Manager 教程",
  );

  assert.match(html, /<a href="https:\/\/www\.facebook\.com\/business\/help\/407323696966570"/);
  assert.match(html, />Meta 官方建广告账户<\/a>、2026 Business Manager 教程/);
  assert.doesNotMatch(html, /\[Meta 官方建广告账户\]/);
  assert.doesNotMatch(html, /href="https:\/\/www\.facebook\.com\/business\/help\/407323696966570\)/);
});

test("message markdown keeps unmatched ASCII closing parens outside bare URL autolinks", () => {
  const html = renderEscapedUserMarkdown(
    "来源：（https://www.facebook.com/business/help/407323696966570）、2026 Business Manager 教程",
  );

  assert.match(html, /（<a href="https:\/\/www\.facebook\.com\/business\/help\/407323696966570"/);
  assert.match(html, />https:\/\/www\.facebook\.com\/business\/help\/407323696966570<\/a>）、2026 Business Manager 教程/);
  assert.doesNotMatch(html, /href="https:\/\/www\.facebook\.com\/business\/help\/407323696966570\)/);
  assert.doesNotMatch(html, /href="https:\/\/www\.facebook\.com\/business\/help\/407323696966570）/);
});

test("message markdown preserves balanced ASCII parens inside bare URL autolinks", () => {
  const html = renderEscapedUserMarkdown("read https://example.com/foo_(bar)、then continue");

  assert.match(html, /<a href="https:\/\/example\.com\/foo_\(bar\)"/);
  assert.match(html, />https:\/\/example\.com\/foo_\(bar\)<\/a>、then continue/);
});

test("message markdown preserves CommonMark autolinks while escaping raw HTML", () => {
  const html = renderEscapedUserMarkdown("see <https://slock.ai> now");

  assert.match(html, /<a href="https:\/\/slock\.ai"/);
  assert.match(html, />https:\/\/slock\.ai<\/a>/);
  assert.doesNotMatch(html, />&lt;https:\/\/slock\.ai/);
  assert.doesNotMatch(html, /https:\/\/slock\.ai&gt;/);
});

test("message markdown autolink boundary excludes trailing CJK punctuation", () => {
  const html = renderEscapedUserMarkdown("测试，<https://slock.ai>，再见");

  assert.match(html, /<a href="https:\/\/slock\.ai"/);
  assert.match(html, />https:\/\/slock\.ai<\/a>，再见/);
  assert.doesNotMatch(html, /href="https:\/\/slock\.ai&gt;/);
  assert.doesNotMatch(html, /href="https:\/\/slock\.ai，/);
});

test("message markdown supports email autolinks", () => {
  const html = renderEscapedUserMarkdown("contact <user@example.com>");

  assert.match(html, /<a href="mailto:user@example\.com"/);
  assert.match(html, />user@example\.com<\/a>/);
});

test("message markdown preserves ordered list start numbers", () => {
  const html = renderEscapedUserMarkdown("2. resumed item");

  assert.match(html, /<ol start="2" translate="no" class="mb-1 pl-5 list-decimal notranslate">/);
  assert.match(html, /<li translate="no" class="mb-0\.5 notranslate">resumed item<\/li>/);
  assert.doesNotMatch(html, /node="\[object Object\]"/);
});

test("message markdown preserves GFM task-list checked state", () => {
  const source = [
    "- [ ] unchecked item",
    "- [x] checked lowercase",
    "- [X] checked uppercase",
  ].join("\n");
  const checkedVector = (html: string) =>
    [...html.matchAll(/<input\b[^>]*>/g)].map(([input]) => /\schecked(?:=|\s|>)/.test(input));

  assert.deepEqual(checkedVector(renderEscapedUserMarkdown(source)), [false, true, true]);
  assert.deepEqual(checkedVector(renderDefaultMarkdown(source)), [false, true, true]);
});

test("shared markdown preserves ordered list start numbers by default", () => {
  const html = renderDefaultMarkdown("2. resumed item");

  assert.match(html, /<ol start="2" translate="no" class="mb-1 pl-5 list-decimal notranslate">/);
  assert.match(html, /<li translate="no" class="mb-0\.5 notranslate">resumed item<\/li>/);
  assert.doesNotMatch(html, /node="\[object Object\]"/);
});

test("message markdown keeps blank-line ordered lists as one list", () => {
  const html = renderEscapedUserMarkdown(["1. first item", "", "2. second item"].join("\n"));

  assert.equal((html.match(/<ol\b/g) || []).length, 1);
  assert.equal((html.match(/<li\b/g) || []).length, 2);
  assert.match(html, />first item<\/p>/);
  assert.match(html, />second item<\/p>/);
  assert.doesNotMatch(html, /node="\[object Object\]"/);
});

test("message markdown keeps invalid angle-bracket text visible", () => {
  const html = renderEscapedUserMarkdown("<not-a-url>");

  assert.match(html, /&lt;not-a-url&gt;/);
  assert.doesNotMatch(html, /<a href=/);
});

test("message markdown keeps controlled injected message anchors", () => {
  const mention = renderMessageMarkdown('<a data-mention="kasei" data-mention-type="user" data-mention-id="user-1">@Kasei</a>');
  assert.match(mention, /data-mention="kasei"/);
  assert.match(mention, /data-mention-type="user"/);
  assert.match(mention, /data-mention-id="user-1"/);

  const channel = renderMessageMarkdown('<a data-channel="general">#general</a>');
  assert.match(channel, /data-channel="general"/);

  const thread = renderMessageMarkdown('<a data-thread-ref="abc123" data-thread-parent="channel-1" data-thread-parent-name="general" data-thread-parent-type="channel">#general:abc123</a>');
  assert.match(thread, /data-thread-ref="abc123"/);
  assert.match(thread, /data-thread-parent="channel-1"/);
  assert.match(thread, /data-thread-parent-name="general"/);
  assert.match(thread, /data-thread-parent-type="channel"/);

  const raftRef = renderMessageMarkdown('<a data-raft-ref-kind="channel" data-raft-ref-target="#general">#general</a>');
  assert.match(raftRef, /data-raft-ref-kind="channel"/);
  assert.match(raftRef, /data-raft-ref-target="#general"/);
});

test("message markdown schema does not allow extra raw HTML tags", () => {
  assert.equal(messageMarkdownSanitizeSchema.tagNames?.includes("button"), false);
  assert.equal(messageMarkdownSanitizeSchema.tagNames?.includes("iframe"), false);
  assert.equal(messageMarkdownSanitizeSchema.tagNames?.includes("section"), false);
  assert.equal(messageMarkdownSanitizeSchema.tagNames?.includes("b"), false);
});
