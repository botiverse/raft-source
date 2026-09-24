import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "raft-ui";

import api from "../src/api/client";
import type { User } from "../src/store/authStore";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import { useMessageStore } from "../src/store/messageStore";
import { useSearchContentStore } from "../src/store/searchContentStore";
import type { Server } from "../src/store/serverStore";
import { useServerStore } from "../src/store/serverStore";
import type { Task } from "../src/store/taskStore";
import { useTaskStore } from "../src/store/taskStore";
import { useProfileStore } from "../src/store/profileStore";
import { useThreadStore } from "../src/store/threadStore";
import MessageItem from "../src/components/message/MessageItem";
import { __testInternals } from "../src/components/layout/MainLayout";
import { TestIntlProvider } from "./helpers/intl";

const { RightPanel } = __testInternals;

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

function installDesktopViewport() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: ((query: string) => ({
      matches: /min-width:\s*768px/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia,
  });
}

function installMobileViewport() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia,
  });
}

function makeUser(): User {
  return {
    id: "user-1",
    email: "owner@example.com",
    gravatarHash: "",
    name: "owner",
    displayName: "Owner",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: "UTC",
    autoTranslationEnabled: false,
    preferredTranslationDisplay: "original",
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
}

function makeServer(): Server {
  return {
    id: "server-1",
    name: "Acme",
    avatarUrl: null,
    slug: "acme",
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "owner",
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}

function makeChannel(): Channel {
  return {
    id: "channel-1",
    serverId: "server-1",
    name: "design",
    description: null,
    type: "channel",
    joined: true,
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}

function makeMessage(): Message {
  return {
    id: "source-message-1",
    seq: 1,
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Owner",
    messageType: "chat",
    content: "Please check task #804 from this search result.",
    createdAt: "2026-08-10T08:00:00.000Z",
  };
}

function makeTask(): Task {
  return {
    id: "task-804",
    messageId: "task-message-1",
    channelId: "channel-1",
    channelName: "design",
    channelType: "channel",
    taskNumber: 804,
    title: "Thread task ref opens task modal",
    description: null,
    status: "in_progress",
    claimedByType: "agent",
    claimedById: "agent-1",
    claimedByName: "Wug",
    claimedAt: "2026-08-10T08:00:00.000Z",
    completedAt: null,
    createdById: "user-1",
    createdByType: "user",
    createdByName: "Owner",
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: "2026-08-10T08:00:00.000Z",
    isLegacy: false,
  };
}

function seedState(channel: Channel) {
  useAuthStore.setState({
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    initialized: true,
    loading: false,
  });
  useServerStore.setState({
    current: makeServer(),
    members: [],
    billing: null,
  });
  useChannelStore.setState({
    channels: [channel],
    dmChannels: [],
    channelActivity: { [channel.id]: null },
    loading: false,
  });
  useMessageStore.setState({
    currentChannelId: channel.id,
    channelMessages: { [channel.id]: [makeMessage()] },
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    drafts: {},
  });
  useTaskStore.setState({
    tasks: [],
    currentChannelId: channel.id,
    taskMetadataByMessageId: {},
  });
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
    openIntent: null,
    summaries: {},
    replyScopes: {},
    followedThreads: [],
  });
  useSearchContentStore.setState({ slot: { kind: "channel", id: channel.id } });
}

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useSearchContentStore.setState(useSearchContentStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  useThreadStore.setState(useThreadStore.getInitialState(), true);
  useProfileStore.setState(useProfileStore.getInitialState(), true);
});

test("opening an Agent profile from a thread keeps the thread mounted underneath", async () => {
  installDesktopViewport();
  const channel = makeChannel();
  seedState(channel);
  useThreadStore.setState({
    openParentChannelId: channel.id,
    openParentMessageId: "source-message-1",
    openThreadChannelId: "thread-channel-1",
    openIntent: "thread",
    openedAt: 1,
  });
  useProfileStore.setState({
    profileType: "agent",
    profileId: "agent-1",
    openedAt: 2,
  });

  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url === "/messages/channel/thread-channel-1?limit=50") {
      return { data: { messages: [], hasOlder: false, hasNewer: false } };
    }
    if (url === "/tasks/channel/channel-1") return { data: { tasks: [] } };
    if (url === "/channels/channel-1/members") return { data: { humans: [], agents: [] } };
    if (url === "/agents/agent-1") return { data: {} };
    return { data: {} };
  }) as typeof api.get;
  api.post = (async () => ({ data: {} })) as typeof api.post;

  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/acme/channel/channel-1"]}>
        <ToastProvider>
          <RightPanel />
        </ToastProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );

  const retainedThreadPanel = screen.getByTestId("thread-side-column");
  const profilePanel = await screen.findByTestId("profile-panel");
  assert.equal(
    screen.getByTestId("thread-profile-side-column").getAttribute("data-collapse-channel"),
    "true",
    "a profile opened from a normal channel + thread layout must fold the channel on desktop",
  );
  assert.ok(
    retainedThreadPanel.compareDocumentPosition(profilePanel) & Node.DOCUMENT_POSITION_FOLLOWING,
    "a profile opened from a thread must be mounted after the retained thread so it is the right desktop pane and upper mobile layer",
  );

  // The profile is the upper layer. Closing it must reveal the same mounted
  // thread instead of returning to (or reconstructing) the channel page.
  fireEvent.click(screen.getByTestId("agent-mobile-back"));
  await waitFor(() => {
    assert.equal(screen.queryByTestId("profile-panel"), null);
    assert.equal(screen.getByTestId("thread-side-column"), retainedThreadPanel);
  });
});

test("inline task refs opened from a content route preserve task intent through the store and render a task modal", async () => {
  installDesktopViewport();
  const channel = makeChannel();
  const task = makeTask();
  seedState(channel);

  api.get = (async (url: string) => {
    if (url === "/tasks/channel/channel-1/number/804") return { data: { task } };
    if (url === "/channels/channel-1/threads/task-message-1") {
      return {
        data: {
          threadChannelId: "thread-task-804",
          replyCount: 0,
          lastReplyAt: null,
          participantIds: [],
          unreadCount: 0,
          firstUnreadMessageId: null,
        },
      };
    }
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url === "/messages/channel/thread-task-804?limit=50") {
      return { data: { messages: [], hasOlder: false, hasNewer: false } };
    }
    if (url === "/messages/context/task-message-1") {
      return { data: { messages: [], hasOlder: false, hasNewer: false } };
    }
    if (url === "/tasks/channel/channel-1") return { data: { tasks: [task] } };
    if (url === "/channels/channel-1/members") return { data: { humans: [], agents: [] } };
    return { data: {} };
  }) as typeof api.get;

  api.post = (async (url: string) => {
    if (url === "/channels/thread-task-804/read-all") return { data: {} };
    return { data: {} };
  }) as typeof api.post;

  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/acme/search"]}>
        <ToastProvider>
          <MessageItem message={makeMessage()} mentionMap={new Map()} channels={[channel]} />
          <RightPanel />
        </ToastProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );

  fireEvent.click(await screen.findByRole("link", { name: "#804" }));

  await screen.findByTestId("task-thread-modal");
  await waitFor(() => {
    assert.equal(useThreadStore.getState().openIntent, "task");
    assert.equal(screen.queryByTestId("thread-side-column"), null);
  });
});

test("mobile task sheet has a real back affordance that closes to its underlying context", async () => {
  installMobileViewport();
  const channel = makeChannel();
  const task = makeTask();
  seedState(channel);
  useTaskStore.setState({ tasks: [task] });
  useThreadStore.setState({
    openParentChannelId: task.channelId,
    openParentMessageId: task.messageId,
    openThreadChannelId: "thread-task-804",
    openIntent: "task",
    openedAt: Date.now(),
  });

  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url === "/messages/channel/thread-task-804?limit=50") {
      return { data: { messages: [], hasOlder: false, hasNewer: false } };
    }
    if (url === "/tasks/channel/channel-1") return { data: { tasks: [task] } };
    if (url === "/channels/channel-1/members") return { data: { humans: [], agents: [] } };
    return { data: {} };
  }) as typeof api.get;
  api.post = (async () => ({ data: {} })) as typeof api.post;

  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/acme/channel/channel-1?msg=origin-reply"]}>
        <ToastProvider>
          <RightPanel />
        </ToastProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );

  await screen.findByTestId("task-thread-modal");
  assert.ok(screen.getByTestId("task-modal-mobile-back"));
  assert.equal(screen.queryByTestId("task-modal-close"), null);

  fireEvent.click(screen.getByTestId("task-modal-mobile-back"));

  await waitFor(() => {
    assert.equal(useThreadStore.getState().openParentMessageId, null);
    assert.equal(screen.queryByTestId("task-thread-modal"), null);
  });
});
