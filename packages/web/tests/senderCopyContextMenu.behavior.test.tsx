import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";
import MessageItem from "../src/components/message/MessageItem";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import { useMessageStore } from "../src/store/messageStore";
import { useSavedStore } from "../src/store/savedStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import { useServerStore } from "../src/store/serverStore";

const CHANNEL_ID = "channel-sender-copy";

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, value);
  }

  removeItem(key: string) {
    this.map.delete(key);
  }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

function installClipboardSpy() {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (text: string) => {
        writes.push(text);
      },
    },
    configurable: true,
  });
  return writes;
}

function makeUser(): User {
  return {
    id: "user-current",
    email: "current@example.com",
    gravatarHash: "",
    name: "current-user",
    displayName: "Current User",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: null,
    autoTranslationEnabled: false,
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
    name: "Server",
    avatarUrl: null,
    slug: "server",
    ownerId: "user-current",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "owner",
    createdAt: "2026-07-09T00:00:00.000Z",
  };
}

function makeAgent(): Agent {
  return {
    id: "agent-1",
    name: "agent-handle",
    displayName: "Agent Display",
    avatarUrl: null,
    description: null,
    status: "idle",
    model: "gpt-5",
    runtime: "codex",
    serverRole: "member",
    runtimeConfig: null,
    lastRuntimeError: null,
    reasoningEffort: null,
    executionMode: "cloud",
    envVars: null,
    machineId: null,
    runtimeProfile: null,
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-07-09T00:00:00.000Z",
  };
}

function makeHuman(): ServerMember {
  return {
    userId: "human-1",
    email: "human@example.com",
    gravatarHash: "",
    name: "human-handle",
    displayName: "Human Display",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-09T00:00:00.000Z",
  };
}

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: "message-1",
    channelId: CHANNEL_ID,
    senderType: "agent",
    senderId: "agent-1",
    senderName: "Agent Display",
    messageType: "chat",
    content: "hello",
    createdAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

function setupStores(agent = makeAgent(), human = makeHuman()) {
  useAuthStore.setState({ user: makeUser(), accessToken: "token", refreshToken: "refresh", loading: false, initialized: true } as never);
  useServerStore.setState({ current: makeServer(), members: [human] } as never);
  useAgentStore.setState({ agents: [agent], agentActivities: {} } as never);
  useChannelStore.setState({
    channels: [{
      id: CHANNEL_ID,
      serverId: "server-1",
      name: "general",
      type: "regular",
      description: null,
      archived: false,
      archivedAt: null,
      archivedBy: null,
      isDefault: false,
      createdAt: "2026-07-09T00:00:00.000Z",
    }],
    dmChannels: [] as Channel[],
  } as never);
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false } as never);
  useMessageStore.setState({
    drafts: {},
    channelMessages: { [CHANNEL_ID]: [] },
    currentChannelId: CHANNEL_ID,
    messages: [],
  } as never);
}

function renderMessage(message: Message, preview: { agent?: Agent; human?: ServerMember }) {
  setupStores(preview.agent ?? makeAgent(), preview.human ?? makeHuman());
  return render(
    <MemoryRouter>
      <MessageItem
        message={message}
        mentionMap={new Map()}
        channels={[]}
        hideThreadActions
        previewSenderAgent={preview.agent}
        previewSenderMember={preview.human}
        mentionComposerChannelId={CHANNEL_ID}
        senderAvatarTestId={`message-sender-avatar-${message.id}`}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useSavedStore.setState(useSavedStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
});

test("right-clicking a sender name opens a sender copy menu instead of the message menu", async () => {
  const writes = installClipboardSpy();
  const agent = makeAgent();
  renderMessage(
    makeMessage({ senderType: "agent", senderId: agent.id, senderName: "Agent Display" }),
    { agent },
  );

  await act(async () => {
    fireEvent.contextMenu(screen.getByTestId("message-sender-mention-message-1"), {
      clientX: 140,
      clientY: 90,
    });
  });

  const senderMenu = screen.getByRole("menu", { name: "Sender context menu" }) as HTMLElement;
  assert.equal(senderMenu.style.left, "140px");
  assert.equal(senderMenu.style.top, "90px");
  assert.equal(screen.queryByRole("menu", { name: "Message context menu" }), null);
  const backdrop = document.body.querySelector("div.fixed.inset-0");
  assert.ok(backdrop);
  await act(async () => {
    fireEvent.click(backdrop);
  });
  assert.equal(screen.queryByRole("menu", { name: "Sender context menu" }), null);

  await act(async () => {
    fireEvent.contextMenu(screen.getByTestId("message-sender-mention-message-1"), {
      clientX: 140,
      clientY: 90,
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByText("Copy Name"));
    await Promise.resolve();
  });

  assert.deepEqual(writes, ["Agent Display"]);
  assert.equal(screen.queryByRole("menu", { name: "Sender context menu" }), null);
});

test("sender copy menu can copy the mention handle", async () => {
  const writes = installClipboardSpy();
  const agent = makeAgent();
  renderMessage(
    makeMessage({ senderType: "agent", senderId: agent.id, senderName: "Agent Display" }),
    { agent },
  );

  await act(async () => {
    fireEvent.contextMenu(screen.getByTestId("message-sender-mention-message-1"), {
      clientX: 140,
      clientY: 90,
    });
  });
  assert.ok(screen.getByText("Copy Handle"));
  await act(async () => {
    fireEvent.click(screen.getByText("Copy Handle"));
    await Promise.resolve();
  });

  assert.deepEqual(writes, ["@agent-handle"]);
  assert.equal(screen.queryByRole("menu", { name: "Sender context menu" }), null);
});

test("right-clicking a sender avatar opens the sender copy menu", async () => {
  const writes = installClipboardSpy();
  const human = makeHuman();
  renderMessage(
    makeMessage({
      senderType: "user",
      senderId: human.userId,
      senderName: "Human Display",
    }),
    { human },
  );

  await act(async () => {
    fireEvent.contextMenu(screen.getByTestId("message-sender-avatar-message-1"), {
      clientX: 80,
      clientY: 90,
    });
  });

  const senderMenu = screen.getByRole("menu", { name: "Sender context menu" }) as HTMLElement;
  assert.equal(senderMenu.style.left, "80px");
  assert.equal(senderMenu.style.top, "90px");
  assert.equal(screen.queryByRole("menu", { name: "Message context menu" }), null);
  await act(async () => {
    fireEvent.click(screen.getByText("Copy Name"));
    await Promise.resolve();
  });

  assert.deepEqual(writes, ["Human Display"]);
});

test("sender copy menu omits handle copy when the sender cannot be mentioned", async () => {
  installClipboardSpy();
  const agent = { ...makeAgent(), deletedAt: "2026-07-11T00:00:00.000Z" };
  renderMessage(
    makeMessage({ senderType: "agent", senderId: agent.id, senderName: "Deleted Agent" }),
    { agent },
  );

  await act(async () => {
    fireEvent.contextMenu(screen.getByTestId("message-sender-avatar-message-1"), {
      clientX: 120,
      clientY: 90,
    });
  });

  assert.ok(screen.getByText("Copy Name"));
  assert.equal(screen.queryByText("Copy Handle"), null);
});
