import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import MessageInput from "../src/components/message/MessageInput";
import MessageItem from "../src/components/message/MessageItem";
import { insertMentionAtCursor } from "../src/components/message/senderMentionInsert";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Message, MessageMention, SendMessageResult } from "../src/store/messageStore";
import { useMessageStore } from "../src/store/messageStore";
import { useSavedStore } from "../src/store/savedStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import { useServerStore } from "../src/store/serverStore";

const CHANNEL_ID = "channel-sender-mention";

const originalApiGet = api.get;

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

function makeSendSpy() {
  const details: Array<{
    content: string;
    mentions: MessageMention[] | undefined;
  }> = [];
  const send = async (
    _channelId: string,
    content: string,
    _attachmentIds: string[] = [],
    _asTask?: boolean,
    _optimisticId?: string,
    _randomId?: string,
    mentions?: MessageMention[],
  ): Promise<SendMessageResult> => {
    details.push({ content, mentions });
    return { messageId: `message-${details.length}`, pendingMentionActions: [], unresolvedMentionHandles: [] };
  };
  return Object.assign(send, { details });
}

function setupStores(sendMessage: ReturnType<typeof makeSendSpy>, agent = makeAgent(), human = makeHuman()) {
  api.get = (async () => ({ data: { agents: [agent], humans: [{ ...human, id: human.userId }] } })) as typeof api.get;

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
    sendMessage,
  } as never);
}

function renderComposerWithMessage(message: Message, sendMessage: ReturnType<typeof makeSendSpy>, preview: { agent?: Agent; human?: ServerMember }) {
  setupStores(sendMessage, preview.agent ?? makeAgent(), preview.human ?? makeHuman());
  const view = render(
    <MemoryRouter>
      <MessageItem
        message={message}
        mentionMap={new Map()}
        channels={[]}
        hideThreadActions
        previewSenderAgent={preview.agent}
        previewSenderMember={preview.human}
        senderAvatarTestId={`message-sender-avatar-${message.id}`}
        mentionComposerChannelId={CHANNEL_ID}
      />
      <MessageInput channelId={CHANNEL_ID} channelName="#general" />
    </MemoryRouter>,
  );
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
  return { ...view, textarea };
}

function renderComposerWithMessages(messages: Message[], sendMessage: ReturnType<typeof makeSendSpy>, preview: { agent?: Agent; human?: ServerMember }) {
  setupStores(sendMessage, preview.agent ?? makeAgent(), preview.human ?? makeHuman());
  const view = render(
    <MemoryRouter>
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          mentionMap={new Map()}
          channels={[]}
          hideThreadActions
          previewSenderAgent={message.senderType === "agent" ? preview.agent : undefined}
          previewSenderMember={message.senderType === "user" ? preview.human : undefined}
          mentionComposerChannelId={CHANNEL_ID}
        />
      ))}
      <MessageInput channelId={CHANNEL_ID} channelName="#general" />
    </MemoryRouter>,
  );
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
  return { ...view, textarea };
}

async function submitComposer() {
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
  const form = textarea.closest("form");
  assert.ok(form);
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useSavedStore.setState(useSavedStore.getInitialState(), true);
});

test("sender mention insertion preserves surrounding text spacing", () => {
  assert.deepEqual(insertMentionAtCursor("", 0, "handle"), { newContent: "@handle ", newCursor: 8 });
  assert.deepEqual(insertMentionAtCursor("ask", 3, "handle"), { newContent: "ask @handle ", newCursor: 12 });
  assert.deepEqual(insertMentionAtCursor("ask now", 4, "handle"), { newContent: "ask @handle now", newCursor: 12 });
});

test("clicking an agent display name inserts the agent handle as a structured mention", async () => {
  const sendMessage = makeSendSpy();
  const agent = makeAgent();
  const { textarea } = renderComposerWithMessage(
    makeMessage({ senderType: "agent", senderId: agent.id, senderName: "Agent Display" }),
    sendMessage,
    { agent },
  );

  await act(async () => {
    fireEvent.click(screen.getByTestId("message-sender-mention-message-1"));
  });
  assert.equal(screen.getByTestId("message-sender-mention-message-1").getAttribute("title"), "Mention @agent-handle");
  await waitFor(() => assert.equal(textarea.value, "@agent-handle "));
  await submitComposer();

  await waitFor(() => assert.equal(sendMessage.details.length, 1));
  assert.deepEqual(sendMessage.details[0], {
    content: "@agent-handle ",
    mentions: [{ type: "agent", id: "agent-1", name: "agent-handle" }],
  });
});

test("clicking a human display name inserts the human handle, not the display name", async () => {
  const sendMessage = makeSendSpy();
  const human = makeHuman();
  const { textarea } = renderComposerWithMessage(
    makeMessage({
      senderType: "user",
      senderId: human.userId,
      senderName: "Human Display",
    }),
    sendMessage,
    { human },
  );

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "hello world" } });
  });
  textarea.setSelectionRange(5, 5);
  await act(async () => {
    fireEvent.click(screen.getByTestId("message-sender-mention-message-1"));
  });
  await waitFor(() => assert.equal(textarea.value, "hello @human-handle world"));
  await waitFor(() => assert.equal(document.activeElement, textarea));
  assert.equal(textarea.selectionStart, 19);
  assert.equal(textarea.selectionEnd, 19);
  assert.doesNotMatch(textarea.value, /Human Display/);
  await submitComposer();

  await waitFor(() => assert.equal(sendMessage.details.length, 1));
  assert.deepEqual(sendMessage.details[0], {
    content: "hello @human-handle world",
    mentions: [{ type: "user", id: "human-1", name: "human-handle" }],
  });
});

test("long-pressing a mobile sender avatar inserts a structured mention and focuses the composer", async () => {
  const sendMessage = makeSendSpy();
  const human = makeHuman();
  const { textarea } = renderComposerWithMessage(
    makeMessage({
      senderType: "user",
      senderId: human.userId,
      senderName: "Human Display",
    }),
    sendMessage,
    { human },
  );
  const avatar = screen.getByTestId("message-sender-avatar-message-1");
  const focusCalls: Array<FocusOptions | undefined> = [];
  const nativeFocus = textarea.focus.bind(textarea);
  textarea.focus = (options?: FocusOptions) => {
    focusCalls.push(options);
    nativeFocus(options);
  };

  await act(async () => {
    fireEvent.touchStart(avatar, { touches: [{ clientX: 24, clientY: 24 }] });
    await new Promise((resolve) => setTimeout(resolve, 520));
    fireEvent.touchEnd(avatar, { changedTouches: [{ clientX: 24, clientY: 24 }] });
  });

  await waitFor(() => assert.equal(textarea.value, "@human-handle "));
  assert.equal(document.activeElement, textarea);
  assert.equal(focusCalls[0], undefined, "gesture focus matches a direct textarea tap so the browser can reveal it");
  assert.deepEqual(focusCalls.at(-1), { preventScroll: true }, "post-commit cursor restore must not scroll twice");
  assert.equal(screen.queryByRole("menu", { name: "Message context menu" }), null);
  assert.equal(screen.queryByRole("menu", { name: "Sender context menu" }), null);
  await submitComposer();

  await waitFor(() => assert.equal(sendMessage.details.length, 1));
  assert.deepEqual(sendMessage.details[0], {
    content: "@human-handle ",
    mentions: [{ type: "user", id: "human-1", name: "human-handle" }],
  });
});

test("touching a sender avatar exposes immediate pressed feedback until release or cancellation", async () => {
  const human = makeHuman();
  renderComposerWithMessage(
    makeMessage({
      senderType: "user",
      senderId: human.userId,
      senderName: "Human Display",
    }),
    makeSendSpy(),
    { human },
  );
  const avatar = screen.getByTestId("message-sender-avatar-message-1");

  await act(async () => {
    fireEvent.touchStart(avatar, { touches: [{ clientX: 24, clientY: 24 }] });
  });
  assert.equal(avatar.getAttribute("data-avatar-pressed"), "true");
  assert.match(avatar.className, /scale-90/);
  assert.match(avatar.className, /brightness-75/);

  await act(async () => {
    fireEvent.touchCancel(avatar);
  });
  assert.equal(avatar.getAttribute("data-avatar-pressed"), "false");
  assert.doesNotMatch(avatar.className, /scale-90/);

  await act(async () => {
    fireEvent.touchStart(avatar, { touches: [{ clientX: 24, clientY: 24 }] });
    fireEvent.touchEnd(avatar, { changedTouches: [{ clientX: 24, clientY: 24 }] });
  });
  assert.equal(avatar.getAttribute("data-avatar-pressed"), "false");
});

test("small iOS touch jitter keeps the avatar long press armed while real movement cancels it", async () => {
  const human = makeHuman();
  const { textarea } = renderComposerWithMessage(
    makeMessage({
      senderType: "user",
      senderId: human.userId,
      senderName: "Human Display",
    }),
    makeSendSpy(),
    { human },
  );
  const avatar = screen.getByTestId("message-sender-avatar-message-1");

  await act(async () => {
    fireEvent.touchStart(avatar, { touches: [{ clientX: 24, clientY: 24 }] });
    fireEvent.touchMove(avatar, { touches: [{ clientX: 29, clientY: 27 }] });
  });
  assert.equal(avatar.getAttribute("data-avatar-pressed"), "true");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 520));
    fireEvent.touchEnd(avatar, { changedTouches: [{ clientX: 29, clientY: 27 }] });
  });
  await waitFor(() => assert.equal(textarea.value, "@human-handle "));

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "" } });
  });
  await act(async () => {
    fireEvent.touchStart(avatar, { touches: [{ clientX: 24, clientY: 24 }] });
    fireEvent.touchMove(avatar, { touches: [{ clientX: 42, clientY: 24 }] });
    await new Promise((resolve) => setTimeout(resolve, 520));
    fireEvent.touchEnd(avatar, { changedTouches: [{ clientX: 42, clientY: 24 }] });
  });
  assert.equal(avatar.getAttribute("data-avatar-pressed"), "false");
  assert.equal(textarea.value, "");
});

test("long-pressing while the composer is focused preserves focus and the open keyboard", async () => {
  const sendMessage = makeSendSpy();
  const human = makeHuman();
  const { textarea } = renderComposerWithMessage(
    makeMessage({
      senderType: "user",
      senderId: human.userId,
      senderName: "Human Display",
    }),
    sendMessage,
    { human },
  );
  const avatar = screen.getByTestId("message-sender-avatar-message-1");

  fireEvent.change(textarea, { target: { value: "draft " } });
  textarea.focus();
  textarea.setSelectionRange(6, 6);
  const focusCalls: Array<FocusOptions | undefined> = [];
  const nativeFocus = textarea.focus.bind(textarea);
  textarea.focus = (options?: FocusOptions) => {
    focusCalls.push(options);
    nativeFocus(options);
  };

  await act(async () => {
    const pointerDownAccepted = fireEvent.pointerDown(avatar, {
      cancelable: true,
      pointerType: "touch",
    });
    assert.equal(pointerDownAccepted, false, "focused composer prevents the avatar from stealing keyboard focus");
    fireEvent.touchStart(avatar, {
      touches: [{ clientX: 24, clientY: 24 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 520));
    fireEvent.touchEnd(avatar, { changedTouches: [{ clientX: 24, clientY: 24 }] });
  });

  await waitFor(() => assert.equal(textarea.value, "draft @human-handle "));
  assert.equal(document.activeElement, textarea);
  assert.equal(
    focusCalls.some((options) => options === undefined),
    false,
    "already-focused composer never re-runs native gesture focus",
  );
  assert.deepEqual(focusCalls.at(-1), { preventScroll: true });
});

test("sender mention insertion ignores clicks for another composer channel", async () => {
  const sendMessage = makeSendSpy();
  const agent = makeAgent();
  setupStores(sendMessage, agent, makeHuman());
  render(
    <MemoryRouter>
      <MessageItem
        message={makeMessage({ senderType: "agent", senderId: agent.id, senderName: "Agent Display" })}
        mentionMap={new Map()}
        channels={[]}
        hideThreadActions
        previewSenderAgent={agent}
        mentionComposerChannelId="other-channel"
      />
      <MessageInput channelId={CHANNEL_ID} channelName="#general" />
    </MemoryRouter>,
  );
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;

  await act(async () => {
    fireEvent.click(screen.getByTestId("message-sender-mention-message-1"));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(textarea.value, "");
  assert.equal(sendMessage.details.length, 0);
});

test("re-clicking a sender mention refreshes that mention without dropping other selected senders", async () => {
  const sendMessage = makeSendSpy();
  const agent = makeAgent();
  const human = makeHuman();
  const { textarea } = renderComposerWithMessages([
    makeMessage({ id: "agent-message", senderType: "agent", senderId: agent.id, senderName: "Agent Display" }),
    makeMessage({ id: "human-message", senderType: "user", senderId: human.userId, senderName: "Human Display" }),
  ], sendMessage, { agent, human });

  await act(async () => {
    fireEvent.click(screen.getByTestId("message-sender-mention-agent-message"));
  });
  await waitFor(() => assert.match(textarea.value, /@agent-handle/));
  await act(async () => {
    fireEvent.click(screen.getByTestId("message-sender-mention-human-message"));
  });
  await waitFor(() => assert.match(textarea.value, /@human-handle/));
  await act(async () => {
    fireEvent.click(screen.getByTestId("message-sender-mention-agent-message"));
  });
  await submitComposer();

  await waitFor(() => assert.equal(sendMessage.details.length, 1));
  assert.deepEqual(sendMessage.details[0]?.mentions, [
    { type: "user", id: "human-1", name: "human-handle" },
    { type: "agent", id: "agent-1", name: "agent-handle" },
  ]);
});
