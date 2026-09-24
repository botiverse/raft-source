import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createIntl } from "react-intl";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import { anchorLabel } from "../src/components/message/attachmentCommentAnchors";
import { AttachmentCommentRefChip } from "../src/components/message/AttachmentCommentRefChip";
import ChatPanel from "../src/components/message/ChatPanel";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import api from "../src/api/client";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";

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

globalThis.ResizeObserver = globalThis.ResizeObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

function makeSidebarOrder() {
  return {
    channelOrder: [],
    agentOrder: [],
    dmOrder: [],
    channelSortMode: "manual" as const,
    jointChannelSortMode: "manual" as const,
    dmSortMode: "manual" as const,
    pinnedSortMode: "manual" as const,
    pinned: [],
    pinnedChannelIds: [],
    pinnedAgentIds: [],
    pinnedOrder: [],
    hiddenDmIds: [],
    channelPanelTabOrder: [],
    agentPanelTabOrder: [],
    pinnedVersion: 0,
  };
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} } as never);
  useMessageStore.setState({
    messages: [],
    loading: false,
    contextLoadError: null,
    loadMessages: async () => undefined,
    loadMessageContext: async () => undefined,
  } as never);
  useTaskStore.setState({ tasks: [], loadTasks: async () => undefined } as never);
  useServerStore.setState({ current: null, members: [], sidebarOrder: { pinned: [] } } as never);
});

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-msg",
    serverId: "server-msg",
    name: "research",
    description: null,
    type: "channel",
    createdAt: "2026-06-28T00:00:00.000Z",
    joined: true,
    ...overrides,
  };
}

function seedChat(channel: Channel) {
  api.get = (async (url: string) => {
    if (url.includes("/tasks")) return { data: { tasks: [] } };
    if (url.includes("/members")) return { data: { members: [] } };
    return { data: {} };
  }) as typeof api.get;
  useServerStore.setState({
    current: {
      id: "server-msg",
      name: "Msg Server",
      slug: "msg",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-06-28T00:00:00.000Z",
    },
    members: [],
    sidebarOrder: makeSidebarOrder(),
  } as never);
  useChannelStore.setState({
    channels: [channel],
    dmChannels: [],
    channelActivity: { [channel.id]: null },
  } as never);
  useTaskStore.setState({
    tasks: [],
    currentChannelId: channel.id,
    loadTasks: async () => undefined,
  } as never);
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
    loadMessages: async () => undefined,
    loadMessageContext: async () => undefined,
    loadMessageWindowSilent: async () => undefined,
    loadOlderMessages: async () => undefined,
    loadNewerMessages: async () => undefined,
  } as never);
}

function renderChat(channel: Channel, readOnly = true) {
  return render(
    <MemoryRouter>
      <TestIntlProvider locale="zh-cn">
        <ChatPanel channel={channel} readOnly={readOnly} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("catalog pins messaging residue MessageIds", () => {
  assert.equal(en["message.chatPanel.archived"], "Archived");
  assert.equal(en["message.chatPanel.joinChannel"], "Join #{channel}");
  assert.equal(en["message.chatPanel.messageNotFound"], "Message not found");
  assert.equal(en["message.messageItem.deletedBadge"], "Deleted");
  assert.equal(en["message.attachmentAnchor.htmlRegion"], "HTML region");
  assert.equal(en["message.attachmentAnchor.rowSingle"], "Row {n}");
  assert.equal(en["message.attachmentAnchor.rowRange"], "Row {start}–{end}");
  assert.match(en["message.attachmentComment.jumpTitle"], /\{detail\}/);
  assert.match(en["message.attachmentComment.commentTitle"], /\{detail\}/);
  assert.match(zh["message.chatPanel.joinChannel"], /\{channel\}/);
  assert.match(zh["message.attachmentAnchor.htmlRegion"], /\p{Script=Han}/u);
});

test("anchorLabel accepts formatMessage and localizes zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(
    anchorLabel({ type: "html-region", data: {} }, zhIntl.formatMessage),
    zh["message.attachmentAnchor.htmlRegion"],
  );
  assert.match(
    anchorLabel({ type: "csv-rows", data: { start: 3, end: 5 } }, zhIntl.formatMessage),
    /\p{Script=Han}/u,
  );
  assert.doesNotMatch(
    anchorLabel({ type: "csv-rows", data: { start: 3, end: 5 } }, zhIntl.formatMessage),
    /Row /,
  );
});

test("mounted ChatPanel archived chrome is Chinese, not English residue", () => {
  const channel = makeChannel({ archivedAt: "2026-08-01T00:00:00.000Z" });
  seedChat(channel);
  renderChat(channel);

  assert.ok(screen.getByText(zh["message.chatPanel.archived"]));
  assert.equal(screen.queryByText("Archived"), null);
});

test("mounted ChatPanel join CTA is Chinese, not English residue", { timeout: 8000 }, () => {
  const channel = makeChannel({ joined: false, name: "research" });
  seedChat(channel);
  renderChat(channel, false);

  assert.ok(screen.getByRole("button", {
    name: zh["message.chatPanel.joinChannel"].replace("{channel}", "research"),
  }));
  assert.equal(screen.queryByRole("button", { name: /Join #/ }), null);
});

test("Guest ChatPanel only offers Join when the channel is guest-joinable", () => {
  const readonlyChannel = makeChannel({
    joined: false,
    name: "guest-readonly",
    guestVisible: true,
    guestJoinable: false,
  });
  seedChat(readonlyChannel);
  useServerStore.setState((state) => ({
    current: state.current ? { ...state.current, role: "guest" } : null,
  }));
  const readonly = renderChat(readonlyChannel, false);
  assert.ok(screen.queryByRole("button", { name: /加入 #guest-readonly/ }) === null);
  readonly.unmount();

  const joinableChannel = makeChannel({
    joined: false,
    name: "guest-joinable",
    guestVisible: true,
    guestJoinable: true,
  });
  seedChat(joinableChannel);
  useServerStore.setState((state) => ({
    current: state.current ? { ...state.current, role: "guest" } : null,
  }));
  renderChat(joinableChannel, false);
  assert.ok(screen.getByRole("button", { name: /加入 #guest-joinable/ }));
});

test("mounted AttachmentCommentRefChip jump title is Chinese", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <AttachmentCommentRefChip
        commentRef={{
          attachmentId: "att-1",
          filename: "notes.txt",
          hostMessageId: "host-1",
          hostSource: "message",
          anchorLabel: null,
          anchorQuote: null,
        }}
        commentsEnabled
        onJumpToHost={() => undefined}
      />
    </TestIntlProvider>,
  );

  const expected = zh["message.attachmentComment.jumpTitle"].replace("{detail}", "notes.txt");
  assert.ok(screen.getByTitle(expected));
  assert.equal(screen.queryByTitle(/Jump to the message with/), null);
});
