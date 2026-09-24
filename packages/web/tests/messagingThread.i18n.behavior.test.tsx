import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createIntl } from "react-intl";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import { ThreadRepliesBadge } from "../src/components/message/ThreadRepliesBadge";
import ThreadPanel from "../src/components/message/ThreadPanel";
import api from "../src/api/client";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import { useThreadStore } from "../src/store/threadStore";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const originalGet = api.get;

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as never;
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useThreadStore.setState(useThreadStore.getInitialState(), true);
});

test("catalog pins messaging-thread MessageIds", () => {
  assert.match(en["message.inlineThreadReplies.replyCount"], /\{count, plural,/);
  assert.equal(en["message.inlineThreadReplies.newReplyCount"], "{count} new");
  assert.equal(en["message.threadRepliesBadge.draft"], "draft");
  assert.equal(en["message.threadPanel.loadingNewerReplies"], "Loading newer replies...");
  assert.equal(en["message.threadPanel.loadFailedTitle"], "Couldn't load this thread");
  assert.equal(
    en["message.threadPanel.loadFailedBody"],
    "The thread couldn't be opened. If this channel just became public, retrying usually fixes it.",
  );
  assert.match(zh["message.threadPanel.loadFailedTitle"], /\p{Script=Han}/u);
  assert.match(zh["message.threadRepliesBadge.draft"], /\p{Script=Han}/u);
});

test("thread reply-count id formats under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.match(
    zhIntl.formatMessage({ id: "message.inlineThreadReplies.replyCount" }, { count: 2 }),
    /\p{Script=Han}/u,
  );
  assert.doesNotMatch(
    zhIntl.formatMessage({ id: "message.threadPanel.loadingNewerReplies" }),
    /Loading newer/,
  );
});

test("mounted ThreadRepliesBadge renders Chinese unread/draft copy and opens the thread", () => {
  let clicks = 0;
  render(
    <TestIntlProvider locale="zh-cn">
      <ThreadRepliesBadge replyCount={2} unreadCount={1} hasDraft onClick={() => { clicks += 1; }} />
    </TestIntlProvider>,
  );

  const badge = screen.getByTestId("message-thread-replies-badge");
  assert.equal(badge.tagName, "BUTTON");
  assert.match(badge.className, /\bbg-brutal-cyan\/20\b/);
  assert.match(badge.className, /\bhover:bg-brutal-cyan\/40\b/);
  assert.ok(screen.getByText(zh["message.threadRepliesBadge.draft"]));
  assert.match(badge.textContent ?? "", /\p{Script=Han}/u);
  assert.equal(screen.queryByText("draft"), null);
  assert.doesNotMatch(document.body.textContent ?? "", /\{unreadCount\} new/);
  fireEvent.click(badge);
  assert.equal(clicks, 1);
});

test("mounted ThreadRepliesBadge handles draft-only and empty states", () => {
  const { rerender } = render(
    <TestIntlProvider>
      <ThreadRepliesBadge replyCount={0} unreadCount={0} hasDraft onClick={() => undefined} />
    </TestIntlProvider>,
  );

  const draftOnly = screen.getByTestId("message-thread-replies-badge");
  assert.equal(draftOnly.textContent?.trim(), en["message.threadRepliesBadge.draft"]);
  assert.equal(draftOnly.querySelectorAll("svg").length, 1, "draft-only uses one pencil affordance");

  rerender(
    <TestIntlProvider>
      <ThreadRepliesBadge replyCount={0} unreadCount={0} hasDraft={false} onClick={() => undefined} />
    </TestIntlProvider>,
  );
  assert.equal(screen.queryByTestId("message-thread-replies-badge"), null);
});

test("mounted ThreadPanel load-failure is Chinese, not English residue", () => {
  api.get = (async (url: string) => {
    if (url.includes("/tasks")) return { data: { tasks: [] } };
    if (url.includes("/members")) return { data: { members: [] } };
    return { data: {} };
  }) as typeof api.get;
  useThreadStore.setState({
    openParentChannelId: "channel-1",
    openParentMessageId: "message-1",
    openThreadChannelId: null,
    openThreadError: { parentChannelId: "channel-1", parentMessageId: "message-1" },
    openThreadLoading: false,
  } as never);

  render(
    <MemoryRouter>
      <TestIntlProvider locale="zh-cn">
        <ThreadPanel
          threadIdentity={{
            parentChannelId: "channel-1",
            parentMessageId: "message-1",
            threadChannelId: null,
          }}
        />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(screen.getByText(zh["message.threadPanel.loadFailedTitle"]));
  assert.ok(screen.getByText(zh["message.threadPanel.loadFailedBody"]));
  assert.ok(screen.getByRole("button", { name: zh["message.threadPanel.retry"] }));
  assert.doesNotMatch(document.body.textContent ?? "", /Couldn't load this thread/);
  assert.doesNotMatch(document.body.textContent ?? "", /Loading newer replies/);
});
