import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import HistoryPaywall from "../src/components/message/HistoryPaywall";
import type { HistoryPaywallScope } from "../src/components/message/HistoryPaywall";
import { DateDivider } from "../src/components/message/DateDivider";
import { readHiddenTarget, recordHiddenHistory, recordHiddenTarget, useHiddenHistoryStore } from "../src/store/hiddenHistoryStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { useUpgradeDialogStore } from "../src/store/upgradeDialogStore";
import { renderWithIntl } from "./helpers/intl";

/**
 * The 30-day history paywall (task #8): at the start of what a Free server
 * shows, a faded glimpse of the newest hidden messages and a card that says how
 * many the window hides, with Upgrade to Pro.
 */

const CHANNEL_ID = "channel-design-review";

function hiddenMessage(id: string, senderName: string, createdAt: string, preview: string | null) {
  return {
    id,
    senderType: "user",
    senderId: `user-${id}`,
    senderName,
    senderAvatarUrl: null,
    createdAt,
    preview,
  };
}

const PAGE = {
  historyLimited: true,
  hiddenHistory: {
    hiddenCount: 214,
    hiddenCountCapped: false,
    latest: [
      hiddenMessage("m-1", "Lin Mo", "2026-09-12T08:00:00.000Z", "The final design is in Figma, please review it before Friday."),
      hiddenMessage("m-2", "Bugen", "2026-09-12T09:00:00.000Z", null),
    ],
  },
};

function renderPaywall(scope: HistoryPaywallScope = "channel", locale?: "zh-cn", extra: { allHidden?: boolean; recentDivider?: boolean; mode?: "start" | "target"; onOpenReplies?: () => void; channelName?: string } = {}) {
  useServerStore.setState({
    current: { id: "server-1", slug: "acme", name: "Acme", plan: "free", role: "owner", ownerId: "user-owner" } as Server,
    billing: { plan: "free" } as never,
  });
  return renderWithIntl(
    <MemoryRouter>
      <HistoryPaywall channelId={CHANNEL_ID} scope={scope} {...extra} />
    </MemoryRouter>,
    { locale },
  );
}

afterEach(() => {
  cleanup();
  useHiddenHistoryStore.setState({ byChannel: {}, targetByChannel: {} });
  useUpgradeDialogStore.setState({ request: null });
});

test("a page that reached the window's start says how many messages are hidden, and shows the newest of them faded", () => {
  recordHiddenHistory(CHANNEL_ID, PAGE);
  renderPaywall();

  assert.ok(screen.getByRole("heading", { name: "214 earlier messages are older than 30 days" }));
  const preview = screen.getByTestId("history-paywall-preview");
  assert.equal(preview.getAttribute("aria-hidden"), "true");
  // raft-ui Edges fade: the glimpse fades toward the top with the shared
  // 48px content mask, not a hand-written mask-image.
  assert.match(preview.className, /(?:^| )mask-fade-t(?: |$)/);
  assert.doesNotMatch(preview.className, /\[mask-image:/);
  const rows = [...preview.querySelectorAll('[data-slot="message-item"]')];
  assert.equal(rows.length, 2);
  // Oldest first, as they sit in the timeline.
  assert.match(rows[0].textContent ?? "", /Lin Mo[\s\S]*The final design is in Figma/);
  assert.match(rows[1].textContent ?? "", /Bugen[\s\S]*Sent an attachment/);

  fireEvent.click(screen.getByTestId("history-paywall-upgrade"));
  assert.equal(useUpgradeDialogStore.getState().request?.gate, "history_30d");
});

test("Upgrade tells the dialog what the window hides here: a named channel by name, else the conversation, a thread's replies, a jump's date", () => {
  const opened = () => {
    fireEvent.click(screen.getByTestId("history-paywall-upgrade"));
    const request = useUpgradeDialogStore.getState().request;
    useUpgradeDialogStore.setState({ request: null });
    cleanup();
    return request?.historyContext;
  };
  recordHiddenHistory(CHANNEL_ID, PAGE);
  renderPaywall("channel", undefined, { channelName: "#design-review" });
  assert.deepEqual(opened(), { kind: "channel", channel: "#design-review", count: 214, capped: false });
  renderPaywall("dm");
  assert.deepEqual(opened(), { kind: "conversation", count: 214, capped: false });
  // A channel without a name to show (an agent's lounge) reads as a conversation.
  renderPaywall("channel");
  assert.deepEqual(opened(), { kind: "conversation", count: 214, capped: false });
  recordHiddenHistory(CHANNEL_ID, { historyLimited: true, hiddenHistory: { hiddenCount: 1000, hiddenCountCapped: true, latest: [] } });
  renderPaywall("thread");
  assert.deepEqual(opened(), { kind: "thread", count: 1000, capped: true });

  // No count to tell (none carried, or only a thread's first message hides): the dialog's own line.
  recordHiddenHistory(CHANNEL_ID, { historyLimited: true, hiddenHistory: { hiddenCount: 0, hiddenCountCapped: false, parentHidden: true, latest: [] } });
  renderPaywall("thread");
  assert.equal(opened(), undefined);
  useHiddenHistoryStore.setState({ byChannel: {}, targetByChannel: {} });
  renderPaywall("channel", undefined, { channelName: "#design-review" });
  assert.equal(opened(), undefined);

  recordHiddenTarget(CHANNEL_ID, hiddenTarget());
  renderPaywall("channel", undefined, { mode: "target", channelName: "#design-review" });
  assert.deepEqual(opened(), { kind: "target", sentAt: hiddenTarget().target.createdAt });
});

test("above the count cap it says so, and replies use their own sentence", () => {
  recordHiddenHistory(CHANNEL_ID, { historyLimited: true, hiddenHistory: { hiddenCount: 1000, hiddenCountCapped: true, latest: [] } });
  const view = renderPaywall();
  assert.ok(screen.getByRole("heading", { name: "Over 1,000 earlier messages are older than 30 days" }));
  assert.ok(screen.queryByTestId("history-paywall-preview") === null);
  view.unmount();

  recordHiddenHistory(CHANNEL_ID, { historyLimited: true, hiddenHistory: { hiddenCount: 1, hiddenCountCapped: false, latest: [] } });
  renderPaywall("thread");
  assert.ok(screen.getByRole("heading", { name: "1 reply is older than 30 days" }));
});

test("without a count (a page that did not carry one) it still says what is hidden", () => {
  renderPaywall();
  assert.ok(screen.getByRole("heading", { name: "Messages older than 30 days are hidden" }));
  assert.ok(screen.getByText("Free shows only the last 30 days. On Pro, all history can be read and searched."));
});

test("zh-cn puts the count where Chinese puts it", () => {
  recordHiddenHistory(CHANNEL_ID, PAGE);
  renderPaywall("channel", "zh-cn");
  assert.ok(screen.getByRole("heading", { name: "更早的 214 条消息超过了 30 天" }));
});

test("the store follows the pages: kept while still limited, cleared once not, malformed answers ignored", () => {
  recordHiddenHistory(CHANNEL_ID, PAGE);
  // A limited page that did not reach the start (no hiddenHistory) keeps the last answer.
  recordHiddenHistory(CHANNEL_ID, { historyLimited: true });
  assert.equal(useHiddenHistoryStore.getState().byChannel[CHANNEL_ID]?.hiddenCount, 214);
  recordHiddenHistory(CHANNEL_ID, { historyLimited: true, hiddenHistory: { hiddenCount: "many" } });
  assert.equal(useHiddenHistoryStore.getState().byChannel[CHANNEL_ID]?.hiddenCount, 214);
  // A row without the fields the preview needs is dropped, not rendered blank.
  recordHiddenHistory(CHANNEL_ID, { historyLimited: true, hiddenHistory: { hiddenCount: 3, latest: [{ id: "x" }] } });
  assert.deepEqual(useHiddenHistoryStore.getState().byChannel[CHANNEL_ID]?.latest, []);
  recordHiddenHistory(CHANNEL_ID, { historyLimited: false });
  assert.ok(!(CHANNEL_ID in useHiddenHistoryStore.getState().byChannel));
});

test("when every message is hidden, the title says so for where it is, and a line says nothing is newer", () => {
  recordHiddenHistory(CHANNEL_ID, { historyLimited: true, hiddenHistory: { hiddenCount: 13, hiddenCountCapped: false, latest: [] } });
  const channel = renderPaywall("channel", undefined, { allHidden: true });
  assert.ok(screen.getByRole("heading", { name: "All 13 messages in this channel are older than 30 days" }));
  assert.equal(screen.getByTestId("history-paywall-none-recent").textContent, "No new messages in the last 30 days");
  channel.unmount();

  const task = renderPaywall("task", "zh-cn", { allHidden: true });
  assert.ok(screen.getByRole("heading", { name: "这个任务的 13 条消息都超过了 30 天" }));
  task.unmount();

  renderPaywall("dm", "zh-cn", { allHidden: true });
  assert.ok(screen.getByRole("heading", { name: "这里的 13 条消息都超过了 30 天" }));
});

test("a thread whose first message is hidden names it, and its glimpse leads with it", () => {
  recordHiddenHistory(CHANNEL_ID, {
    historyLimited: true,
    hiddenHistory: {
      hiddenCount: 3,
      hiddenCountCapped: false,
      parentHidden: true,
      latest: [
        hiddenMessage("parent", "Bugen", "2026-09-10T02:00:00.000Z", "Could you look at the release note wording?"),
        hiddenMessage("reply", "Lin Mo", "2026-09-11T06:40:00.000Z", "Split the first point in two."),
      ],
    },
  });
  const view = renderPaywall("thread", undefined, { recentDivider: true });
  assert.ok(screen.getByRole("heading", { name: "The first message and 3 replies are older than 30 days" }));
  const rows = [...screen.getByTestId("history-paywall-preview").querySelectorAll('[data-slot="message-item"]')];
  assert.match(rows[0].textContent ?? "", /Bugen[\s\S]*release note wording/);
  // Threads have no date dividers: the window's start is a line of its own.
  assert.equal(screen.getByTestId("history-paywall-recent-divider").textContent, "Last 30 days");
  view.unmount();

  renderPaywall("thread", "zh-cn", { allHidden: true });
  assert.ok(screen.getByRole("heading", { name: "开头的消息和 3 条回复都超过了 30 天" }));
  assert.equal(screen.getByTestId("history-paywall-none-recent").textContent, "最近 30 天还没有新回复");
});

test("when only system lines are hidden there is a count but no glimpse", () => {
  recordHiddenHistory(CHANNEL_ID, { historyLimited: true, hiddenHistory: { hiddenCount: 2, hiddenCountCapped: false, latest: [] } });
  renderPaywall("channel");
  assert.ok(screen.getByRole("heading", { name: "2 earlier messages are older than 30 days" }));
  assert.ok(screen.queryByTestId("history-paywall-preview") === null);
});

test("the first date under the paywall says where the last 30 days start", () => {
  renderWithIntl(<DateDivider createdAt="2026-10-20T02:00:00.000Z" recentHistory testId="first-day" />, { locale: "zh-cn" });
  assert.match(screen.getByTestId("first-day").textContent ?? "", /^最近 30 天的消息 · /);
});

function hiddenTarget(extra: Record<string, unknown> = {}) {
  const target = readHiddenTarget({
    target: { ...hiddenMessage("m-target", "Lin Mo", "2026-09-16T10:30:00.000Z", "The final design is in Figma, please review it before Friday, mostly the right half"), seq: 7 },
    before: [hiddenMessage("m-before", "Bugen", "2026-09-12T09:15:00.000Z", "Agreed. Should older search results")],
    after: [hiddenMessage("m-after", "Zhou", "2026-09-18T02:40:00.000Z", "I rewrote the toast copy")],
    thread: null,
    replies: null,
    ...extra,
  });
  assert.ok(target);
  return target;
}

test("a jump to a message behind the window centers on it: lighter neighbors around it, and a card that says it is the one", () => {
  recordHiddenTarget(CHANNEL_ID, hiddenTarget());
  renderPaywall("channel", undefined, { mode: "target" });
  const paywall = screen.getByTestId("history-paywall");
  assert.equal(paywall.getAttribute("data-mode"), "target");
  assert.ok(screen.getByRole("heading", { name: "The message you're looking for is older than 30 days" }));
  assert.match(paywall.textContent ?? "", /It was sent on September 16; only its start shows here\./);
  assert.match(screen.getByTestId("history-paywall-target").textContent ?? "", /Lin Mo[\s\S]*The final design is in Figma/);
  assert.match(screen.getByTestId("history-paywall-preview").textContent ?? "", /Bugen/);
  assert.match(screen.getByTestId("history-paywall-after").textContent ?? "", /Zhou/);
  assert.ok(screen.queryByTestId("history-paywall-target-replies") === null, "no thread, no reply box");
});

test("a hidden first message whose thread goes on keeps its reply box, the way into the thread (6b)", () => {
  recordHiddenTarget(CHANNEL_ID, hiddenTarget({
    replies: { count: 5, latest: hiddenMessage("m-reply", "Bugen", "2026-10-19T07:12:00.000Z", "Updated, posted in #launch") },
  }));
  let opened = 0;
  renderPaywall("channel", "zh-cn", { mode: "target", onOpenReplies: () => { opened += 1; } });
  assert.ok(screen.getByRole("heading", { name: "这个消息列开头的消息超过了 30 天" }));
  const replies = screen.getByTestId("history-paywall-target-replies");
  assert.match(replies.textContent ?? "", /5[\s\S]*Bugen[\s\S]*Updated, posted in #launch/);
  fireEvent.click(replies);
  assert.equal(opened, 1);
});

test("a reply behind the window names its thread's hidden replies, and when nothing is newer says so", () => {
  recordHiddenTarget(CHANNEL_ID, hiddenTarget({ thread: { hiddenReplyCount: 3, hiddenReplyCountCapped: false, parentHidden: true } }));
  const view = renderPaywall("thread", undefined, { mode: "target", allHidden: true });
  assert.ok(screen.getByRole("heading", { name: "The reply you're looking for is older than 30 days" }));
  assert.match(screen.getByTestId("history-paywall").textContent ?? "", /This thread's first message and 3 replies are older than 30 days/);
  assert.equal(screen.getByTestId("history-paywall-none-recent").textContent, "No new replies in the last 30 days");
  view.unmount();

  recordHiddenTarget(CHANNEL_ID, hiddenTarget({ thread: { hiddenReplyCount: 1000, hiddenReplyCountCapped: true, parentHidden: false } }));
  renderPaywall("thread", "zh-cn", { mode: "target" });
  assert.match(screen.getByTestId("history-paywall").textContent ?? "", /这个消息列有 1,000 多条回复超过了 30 天/);
});
