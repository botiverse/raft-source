import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";

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

const { mentionStillAppears } = await import("../src/components/message/MessageInput");
const { default: MessageItem } = await import("../src/components/message/MessageItem");
const { useAgentStore } = await import("../src/store/agentStore");
const { useAuthStore } = await import("../src/store/authStore");
const { useChannelStore } = await import("../src/store/channelStore");
const { useServerStore } = await import("../src/store/serverStore");
const { useMachineStore } = await import("../src/store/machineStore");

function makeUser(): User {
  return {
    id: "user-1",
    email: "current@example.com",
    gravatarHash: "currenthash",
    name: "current",
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
    slug: "server",
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "member",
    createdAt: "2026-05-20T00:00:00.000Z",
  };
}

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: "message-1",
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Current User",
    messageType: "chat",
    content: "hello",
    createdAt: "2026-05-20T00:00:00.000Z",
    ...overrides,
  };
}

function resetStores() {
  const authState = {
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  };
  const serverState: Pick<ReturnType<typeof useServerStore.getState>, "current" | "members"> = {
    current: makeServer(),
    members: [] as ServerMember[],
  };
  const agentState: Pick<ReturnType<typeof useAgentStore.getState>, "agents" | "agentActivities"> = {
    agents: [] as Agent[],
    agentActivities: {},
  };
  const channelState: Pick<ReturnType<typeof useChannelStore.getState>, "dmChannels"> = {
    dmChannels: [] as Channel[],
  };

  useAuthStore.setState(authState);
  useServerStore.setState(serverState);
  useAgentStore.setState(agentState);
  useChannelStore.setState(channelState);
  useMachineStore.setState({
    machines: [{
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Desk",
      description: null,
      status: "online",
      statusVersion: 1,
      apiKeyPrefix: null,
      runtimes: [],
      hostname: null,
      os: null,
      daemonVersion: null,
      isComputer: true,
      lastHeartbeat: null,
      createdAt: "2026-05-20T00:00:00.000Z",
    }],
  } as never);

  Object.assign(useAuthStore.getInitialState(), authState);
  Object.assign(useServerStore.getInitialState(), serverState);
  Object.assign(useAgentStore.getInitialState(), agentState);
  Object.assign(useChannelStore.getInitialState(), channelState);
}

function renderMessage(message: Message) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TestIntlProvider>
        <MessageItem
          message={message}
          mentionMap={new Map()}
          channels={[]}
          hideThreadActions
        />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("composer retains identity-backed mentions after left-boundary edits", () => {
  assert.equal(
    mentionStillAppears("ask @baoyu", { type: "agent", id: "agent-lower", name: "baoyu" }),
    true,
  );
  assert.equal(
    mentionStillAppears("ask @Baoyu", { type: "agent", id: "agent-lower", name: "baoyu" }),
    false,
  );
  assert.equal(
    mentionStillAppears("ask nobody", { type: "agent", id: "agent-lower", name: "baoyu" }),
    false,
  );
  assert.equal(
    mentionStillAppears("ask @a-b", { type: "agent", id: "agent-hyphen", name: "a-b" }),
    true,
  );
  assert.equal(
    mentionStillAppears("ask `@Mona`", { type: "agent", id: "agent-mona", name: "Mona" }),
    false,
  );
  assert.equal(
    mentionStillAppears("先给个草案@Mona", { type: "agent", id: "agent-mona", name: "Mona" }),
    true,
  );
  assert.equal(
    mentionStillAppears("先给个草案 @Mona", { type: "agent", id: "agent-mona", name: "Mona" }),
    true,
  );
  assert.equal(
    mentionStillAppears("draft-@Mona", { type: "agent", id: "agent-mona", name: "Mona" }),
    true,
  );
  assert.equal(
    mentionStillAppears("先给个草案@Mona继续", { type: "agent", id: "agent-mona", name: "Mona" }),
    false,
  );
});

test("structured mention facts show the send-time name without fallback lookup", () => {
  resetStores();

  const bare = renderMessage(makeMessage({
    content: "ask @baoyu",
    mentions: [{ type: "agent", id: "agent-lower", name: "baoyu" }],
  }));
  assert.match(bare, /<a\b(?=[^>]*href="#")[^>]*>@baoyu<\/a>/);

  const named = renderMessage(makeMessage({
    content: "[ask](<@baoyu>)",
    mentions: [{ type: "agent", id: "agent-lower", name: "baoyu" }],
  }));
  assert.match(named, /<a\b(?=[^>]*href="#")[^>]*>ask<\/a>/);

  const embedded = renderMessage(makeMessage({
    content: "先给个草案@baoyu",
    mentions: [{ type: "agent", id: "agent-lower", name: "baoyu" }],
  }));
  assert.match(embedded, /先给个草案[\s\S]*?<a\b(?=[^>]*href="#")[^>]*>@baoyu<\/a>/);

  const plain = renderMessage(makeMessage({ content: "先给个草案@baoyu" }));
  assert.doesNotMatch(plain, /<a\b(?=[^>]*href="#")[^>]*>@baoyu<\/a>/);
});

test("Computer and App refs render as typed chips without becoming mentions", () => {
  resetStores();

  const html = renderMessage(makeMessage({
    content: "Use [@Desk](<computer:550e8400-e29b-41d4-a716-446655440000>) with [@system.reminder](<app:system.reminder>)",
  }));

  assert.match(html, /data-testid="computer-reference-550e8400-e29b-41d4-a716-446655440000"/);
  assert.match(html, /bg-brutal-cyan/);
  assert.match(html, /data-testid="app-reference-system.reminder"/);
  assert.match(html, />@system\.reminder<\/span>/);
  assert.doesNotMatch(html, /data-mention=/);
});

test("generated bullet labels tolerate whitespace before the closing strong delimiter", () => {
  resetStores();

  const html = renderMessage(makeMessage({
    content: [
      "- **注册 / 创建： **203 个新用户",
      "- **Twitter 线索继续很强： **89 人填写来源",
      "- 正常的 **inline bold** 保持不变",
      "- `**代码： **不应修复`",
    ].join("\n"),
  }));

  assert.match(html, /<strong>注册 \/ 创建：<\/strong> 203 个新用户/);
  assert.match(html, /<strong>Twitter 线索继续很强：<\/strong> 89 人填写来源/);
  assert.match(html, /正常的 <strong>inline bold<\/strong> 保持不变/);
  assert.match(html, /<code[^>]*>\*\*代码： \*\*不应修复<\/code>/);
  assert.doesNotMatch(html, /\*\*注册 \/ 创建： \*\*/);
});
