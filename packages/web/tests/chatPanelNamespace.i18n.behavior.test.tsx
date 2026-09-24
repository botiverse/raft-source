import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { act } from "react";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createIntl } from "react-intl";
import { TestIntlProvider, renderWithIntl } from "./helpers/intl";
import api from "../src/api/client";
import ChatPanel, {
  ActivityMutedBadge,
  ActivityMuteToggleButton,
} from "../src/components/message/ChatPanel";
import HistoryTopState from "../src/components/message/HistoryTopState";
import { mergedMessages } from "../src/i18n/messages";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";

// Behavior gate for the message.chatPanel migration (ChatPanel + the exported
// ActivityMutedBadge / ActivityMuteToggleButton, B2). Rendered under zh-cn, the
// panel chrome must reach the DOM with no pre-migration English leak. These are
// real-DOM teeth on purpose: reverting the ChatPanel wiring back to English
// literals turns them RED — a catalog-only assertion would be a false green
// (@铁根). The ICU plural cases are format checks via the zh catalog.

const originalGet = api.get;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  window.history.pushState({}, "", "/");
});

// Stub the channel-members GET so ChatPanel renders don't hit the network (avoids
// async Axios noise in these render teeth). Callers that need a specific
// notification-settings response override api.get after this.
function stubMembersEmpty() {
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    return { data: {} };
  }) as typeof api.get;
}

function flushAsyncWork() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-chatpanel-i18n",
    serverId: "server-chatpanel-i18n",
    name: "chatpanel-i18n",
    description: null,
    type: "channel",
    createdAt: "2026-07-24T00:00:00.000Z",
    joined: true,
    activityMuteSupported: true,
    ...overrides,
  };
}

function seedReadOnlyChatPanel(channel: Channel) {
  useServerStore.setState({ current: null, billing: null, members: [] });
  useChannelStore.setState({
    channels: channel.type === "dm" ? [] : [channel],
    dmChannels: channel.type === "dm" ? [channel] : [],
    channelActivity: { [channel.id]: null },
  });
  useTaskStore.setState({ tasks: [], currentChannelId: channel.id, loadTasks: async () => {} });
  useMessageStore.setState({
    messages: [],
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    highlightedMessageId: null,
    contextLoadError: null,
    transientFocusRequest: null,
    loadMessages: async () => {},
    loadMessageContext: async () => {},
    loadMessageWindowSilent: async () => {},
    loadOlderMessages: async () => {},
    loadNewerMessages: async () => {},
  });
}

test("read-only ChatPanel renders the zh-cn unavailable notice", () => {
  stubMembersEmpty();
  seedReadOnlyChatPanel(makeChannel());
  renderWithIntl(
    <MemoryRouter>
      <ChatPanel channel={makeChannel()} readOnly />
    </MemoryRouter>,
    { locale: "zh-cn" },
  );

  assert.ok(screen.getByText("聊天不可用"), "read-only composer renders the zh unavailable notice");
  const body = document.body.textContent ?? "";
  assert.doesNotMatch(body, /Chat is unavailable/, "no English unavailable leak");
});

test("Guest visible-but-not-joinable channel renders a persistent read-only banner instead of composer or Join", () => {
  stubMembersEmpty();
  const channel = makeChannel({ joined: false, guestVisible: true, guestJoinable: false });
  seedReadOnlyChatPanel(channel);
  useServerStore.setState({
    current: {
      id: channel.serverId,
      slug: "guest-preview",
      name: "Guest Preview",
      role: "guest",
    },
  } as never);

  renderWithIntl(
    <MemoryRouter><ChatPanel channel={channel} /></MemoryRouter>,
    { locale: "en" },
  );

  assert.ok(screen.getByTestId("guest-readonly-channel-banner"));
  assert.ok(screen.getByText("This channel is read-only for guests. You can read messages, but you cannot join or post."));
  assert.equal(screen.queryByRole("button", { name: `Join #${channel.name}` }), null);
  assert.equal(screen.queryByRole("textbox"), null);
});

test("human DM header prefers the uploaded peer avatar over Gravatar", () => {
  stubMembersEmpty();
  const channel = makeChannel({
    id: "dm-uploaded-avatar",
    type: "dm",
    peerType: "user",
    peerId: "user-uploaded",
    peerName: "uploaded-peer",
    peerDisplayName: "Uploaded peer",
    peerAvatarUrl: "/avatars/users/fedcba9876543210fedcba9876543210.webp",
    peerGravatarHash: "chat-uploaded-hash",
  });
  seedReadOnlyChatPanel(channel);
  const { container } = renderWithIntl(
    <MemoryRouter><ChatPanel channel={channel} readOnly /></MemoryRouter>,
    { locale: "en" },
  );

  const image = container.querySelector("img");
  assert.ok(image);
  assert.equal(image.getAttribute("src"), "/avatars/users/fedcba9876543210fedcba9876543210.webp");
});

test("human DM header falls back to the peer Gravatar when no upload exists", () => {
  stubMembersEmpty();
  const channel = makeChannel({
    id: "dm-gravatar-avatar",
    type: "dm",
    peerType: "user",
    peerId: "user-gravatar",
    peerName: "gravatar-peer",
    peerDisplayName: "Gravatar peer",
    peerAvatarUrl: null,
    peerGravatarHash: "chat-peer-gravatar-hash",
  });
  seedReadOnlyChatPanel(channel);
  const { container } = renderWithIntl(
    <MemoryRouter><ChatPanel channel={channel} readOnly /></MemoryRouter>,
    { locale: "en" },
  );

  const image = container.querySelector("img");
  assert.ok(image);
  assert.match(image.getAttribute("src") ?? "", /^https:\/\/www\.gravatar\.com\/avatar\/chat-peer-gravatar-hash\?s=\d+&d=404$/);
});

test("human DM header renders the human placeholder when neither avatar source exists", () => {
  stubMembersEmpty();
  const channel = makeChannel({
    id: "dm-placeholder-avatar",
    type: "dm",
    peerType: "user",
    peerId: "user-placeholder",
    peerName: "placeholder-peer",
    peerDisplayName: "Placeholder peer",
    peerAvatarUrl: null,
    peerGravatarHash: null,
  });
  seedReadOnlyChatPanel(channel);
  const { container } = renderWithIntl(
    <MemoryRouter><ChatPanel channel={channel} readOnly /></MemoryRouter>,
    { locale: "en" },
  );

  assert.ok(container.querySelector(".lucide-user"));
  assert.equal(container.querySelector('img[src*="gravatar.com/avatar/"]'), null);
});

test("ActivityMutedBadge renders zh-cn label + tooltip", () => {
  render(<ActivityMutedBadge />, { wrapper: (props) => <TestIntlProvider locale="zh-cn" {...props} /> });

  const badge = screen.getByTestId("activity-muted-badge");
  assert.equal(badge.textContent?.trim(), "已静音", "badge text renders zh");
  assert.equal(badge.getAttribute("title"), "动态已静音。直接提及你时仍会通知。", "badge tooltip renders zh");
  assert.doesNotMatch(document.body.textContent ?? "", /Muted/, "no English badge leak");
});

test("ActivityMuteToggleButton renders zh-cn mute/unmute channel labels", () => {
  const { rerender } = render(
    <ActivityMuteToggleButton activityMuted={false} disabled={false} onToggle={() => {}} />,
    { wrapper: (props) => <TestIntlProvider locale="zh-cn" {...props} /> },
  );
  assert.ok(screen.getByRole("button", { name: "为此频道静音活动" }), "mute label renders zh");
  assert.equal(screen.queryByRole("button", { name: /Mute activity/i }), null, "no English mute leak");

  rerender(<ActivityMuteToggleButton activityMuted={true} disabled={false} onToggle={() => {}} />);
  assert.ok(screen.getByRole("button", { name: "为此频道取消静音活动" }), "unmute label renders zh");
  assert.equal(screen.queryByRole("button", { name: /Unmute activity/i }), null, "no English unmute leak");
});

test("HistoryTopState renders zh-cn message-noun history copy across states", () => {
  const wrapper = (props: { children?: ReactNode }) => <TestIntlProvider locale="zh-cn" {...props} />;
  const { rerender } = render(
    <HistoryTopState hasMore historyLimited={false} loadingOlder noun="messages" />,
    { wrapper },
  );
  assert.match(document.body.textContent ?? "", /正在加载更早的消息/, "loading-older messages renders zh");
  assert.doesNotMatch(document.body.textContent ?? "", /Loading older messages/, "no English leak");

  rerender(<HistoryTopState hasMore={false} historyLimited={false} loadingOlder={false} noun="messages" />);
  assert.match(document.body.textContent ?? "", /消息的开头/, "beginning-of messages renders zh");

  rerender(<HistoryTopState hasMore={false} historyLimited loadingOlder={false} noun="messages" />);
  assert.match(document.body.textContent ?? "", /更早的消息受当前套餐限制/, "history-limited messages renders zh");
});

// HOLD regression tooth (@铁根 review PR #5374): the activity-mute error banner
// persists until dismissed, so it must re-localize in place when the language
// switches — while the load/reset lifecycle must NOT re-run on that switch.
// Reverting to storing the formatted string keeps the banner English → RED.
test("activity-mute error banner re-localizes on a language switch without re-running its load", async () => {
  let settingsLoads = 0;
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    if (url.includes("/notification-settings")) {
      settingsLoads += 1;
      throw new Error("load failed");
    }
    return { data: {} };
  }) as typeof api.get;

  const channel = makeChannel();
  seedReadOnlyChatPanel(channel);
  const tree = (locale: "en" | "zh-cn") => (
    <TestIntlProvider locale={locale}>
      <MemoryRouter>
        <ChatPanel channel={channel} readOnly />
      </MemoryRouter>
    </TestIntlProvider>
  );

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(tree("en"));
    await flushAsyncWork();
  });

  const alert = await screen.findByTestId("activity-mute-error");
  assert.match(alert.textContent ?? "", /Failed to load Activity mute setting\./, "error shows en at trigger time");
  const loadsBeforeSwitch = settingsLoads;

  // Switch language in place on the same mounted ChatPanel.
  await act(async () => {
    view.rerender(tree("zh-cn"));
    await flushAsyncWork();
  });

  const switched = screen.getByTestId("activity-mute-error");
  assert.match(switched.textContent ?? "", /加载活动静音设置失败。/, "banner re-localizes to zh in place");
  assert.doesNotMatch(switched.textContent ?? "", /Failed to load Activity mute setting/, "no stale English banner");
  assert.equal(settingsLoads, loadsBeforeSwitch, "language switch must not re-run the notification-settings load");
});

test("chatPanel ICU plurals resolve through the zh-cn catalog", () => {
  const zh = createIntl({ locale: "zh-cn", messages: mergedMessages("zh-cn") }).formatMessage;
  // zh has a single `other` arm; count only splices the number.
  assert.equal(zh({ id: "message.chatPanel.newMessagesCount" }, { count: 1 }), "1 条新消息");
  assert.equal(zh({ id: "message.chatPanel.newMessagesCount" }, { count: 5 }), "5 条新消息");
  assert.equal(
    zh({ id: "message.chatPanel.unresolvedMessages" }, { count: 3 }),
    "3 条所选消息已不可用。",
  );
  assert.equal(
    zh({ id: "message.chatPanel.historyLimit" }, { days: 30, plan: "Free" }),
    "消息历史在 Free 套餐下仅保留 30 天。",
  );
});
