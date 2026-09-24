import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import type { Message } from "../src/store/messageStore.js";
import type { User } from "../src/store/authStore.js";
import type { Server, ServerMember } from "../src/store/serverStore.js";
import type { Agent } from "../src/store/agentStore.js";
import type { Channel } from "../src/store/channelStore.js";

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
Object.defineProperty(globalThis, "sessionStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

const { default: MessageItem, buildMentionMap } = await import("../src/components/message/MessageItem");
const { default: ProfilePreviewCardContent } = await import("../src/components/message/ProfilePreviewCardContent");
const { useAuthStore } = await import("../src/store/authStore");
const { useServerStore } = await import("../src/store/serverStore");
const { useAgentStore } = await import("../src/store/agentStore");
const { useChannelStore } = await import("../src/store/channelStore");

const authAvatarUrl = "/api/avatars/users/0123456789abcdef.webp";
const otherAvatarUrl = "/api/avatars/users/fedcba9876543210.webp";
const agentAvatarUrl = "/api/avatars/agents/abcdef0123456789.webp";
const previewAgentAvatarUrl = "/api/avatars/agents/9999999999999999.webp";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "current@example.com",
    gravatarHash: "currenthash",
    name: "current",
    displayName: "Current User",
    description: "Auth profile description",
    avatarUrl: authAvatarUrl,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: null,
    autoTranslationEnabled: false,
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
    ...overrides,
  };
}

function makeMember(overrides: Partial<ServerMember> = {}): ServerMember {
  return {
    userId: "user-1",
    email: "member@example.com",
    gravatarHash: "memberhash",
    name: "member",
    displayName: "Cached Member",
    description: "Cached description",
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-05-20T00:00:00.000Z",
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "agent-one",
    displayName: "Agent One",
    avatarUrl: agentAvatarUrl,
    description: "Agent description",
    status: "active",
    model: "test-model",
    runtime: "codex",
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
    createdAt: "2026-05-20T00:00:00.000Z",
    ...overrides,
  };
}

function makeAgentDmChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-1",
    name: "jinc",
    description: null,
    type: "dm",
    createdAt: "2026-05-20T00:00:00.000Z",
    peerType: "agent",
    peerId: "agent-1",
    peerName: "jinc",
    peerDisplayName: "Jinc Display",
    peerDescription: null,
    peerAvatarUrl: null,
    peerGravatarHash: null,
    ...overrides,
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-general",
    name: "general",
    description: null,
    type: "channel",
    createdAt: "2026-05-20T00:00:00.000Z",
    ...overrides,
  };
}

function makeServer(overrides: Partial<Server> = {}): Server {
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
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
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

function resetStores(options: { user?: User | null; currentServer?: Server; members?: ServerMember[]; agents?: Agent[]; dmChannels?: Channel[] } = {}) {
  const authState = {
    user: options.user === undefined ? makeUser() : options.user,
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  };
  const serverState = {
    current: options.currentServer ?? makeServer(),
    members: options.members ?? [],
  };
  const agentState = {
    agents: options.agents ?? [],
    agentActivities: {},
  };
  const channelState = {
    dmChannels: options.dmChannels ?? [],
  };

  useAuthStore.setState({
    ...authState,
  });
  useServerStore.setState({
    ...serverState,
  });
  useAgentStore.setState({
    ...agentState,
  });
  useChannelStore.setState({
    ...channelState,
  });

  // React's server renderer reads Zustand's captured initial snapshot through
  // useSyncExternalStore. Mutate that snapshot for this SSR-style render test
  // so MessageItem still exercises its real store selectors.
  Object.assign(useAuthStore.getInitialState(), authState);
  Object.assign(useServerStore.getInitialState(), serverState);
  Object.assign(useAgentStore.getInitialState(), agentState);
  Object.assign(useChannelStore.getInitialState(), channelState);
}

function renderMessage(message: Message, props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        TestIntlProvider,
        null,
        createElement(MessageItem, {
          message,
          mentionMap: new Map(),
          channels: [],
          hideThreadActions: true,
          ...props,
        }),
      ),
    ),
  );
}

test("MessageItem renders auth avatar for current user when member cache avatar is stale", () => {
  resetStores({ members: [makeMember({ avatarUrl: null })] });

  const html = renderMessage(makeMessage());

  assert.match(html, new RegExp(authAvatarUrl));
  assert.doesNotMatch(html, /www\.gravatar\.com/);
});

test("MessageItem renders Slock angle refs and named links while preserving code and escapes", () => {
  resetStores({ members: [makeMember({ userId: "user-2", name: "alice", displayName: "Alice" })] });
  const mentionMap = new Map([
    ["alice", { type: "user" as const, id: "user-2", displayName: "Alice" }],
  ]);

  const html = renderMessage(
    makeMessage({ content: "go <#general> and [Alice](<@alice>) see #general msg=abc12345 `#general` \\<#general>" }),
    { channels: [makeChannel()], mentionMap },
  );

  assert.match(html, />#general<\/a>/);
  assert.match(html, />Alice<\/a>/);
  assert.match(html, />#general msg=abc12345<\/a>/);
  assert.match(html, /<code[^>]*>#general<\/code>/);
  assert.match(html, /&lt;#general&gt;/);
});

test("cross-server bare thread refs do not capture a same-named local channel projection", () => {
  resetStores({
    currentServer: makeServer({ slug: "guest-server" }),
    members: [makeMember({
      userId: "host-user",
      name: "host-user",
      serverSlug: "host-server",
    })],
  });

  const html = renderMessage(
    makeMessage({
      senderId: "host-user",
      senderName: "Host User",
      content: "see #src:abcdef12",
    }),
    { channels: [makeChannel({ id: "guest-src", name: "src" })] },
  );

  assert.match(html, /<a\b[^>]*><span>#src:abcdef12<\/span><\/a>/, "the origin-authoritative ref remains actionable");
  assert.doesNotMatch(
    html,
    /data-thread-parent="guest-src"/,
    "the participant's same-named local channel must never become route authority",
  );
});

test("mention handles remain case-sensitive when agent names differ only by case", () => {
  const map = buildMentionMap(
    [
      makeAgent({ id: "agent-upper", name: "Baoyu", displayName: "Baoyu" }),
      makeAgent({ id: "agent-lower", name: "baoyu", displayName: "baoyu" }),
    ],
    [],
  );

  assert.equal(map.get("Baoyu")?.id, "agent-upper");
  assert.equal(map.get("baoyu")?.id, "agent-lower");
  assert.equal(map.get("BAOYU"), undefined);
});

test("structured mention facts do not link a visible handle with different case", () => {
  resetStores();

  const html = renderMessage(
    makeMessage({
      content: "ask @baoyu",
      mentions: [{ type: "agent", id: "agent-upper", name: "Baoyu" }],
    }),
  );

  assert.match(html, />ask @baoyu<\/p>/);
  assert.doesNotMatch(html, /<a[^>]*>@baoyu<\/a>/);
});

test("structured mention facts render the send-time name while the directory is cold", () => {
  resetStores();

  const html = renderMessage(
    makeMessage({
      content: "ask @baoyu",
      mentions: [{ type: "agent", id: "agent-lower", name: "baoyu" }],
    }),
  );

  assert.match(html, /data-slot="preview-card-trigger"[^>]*>@baoyu<\/a>/);
});

test("structured mention facts render the display name on the first frame when the directory is warm", () => {
  resetStores();
  const mentionMap = buildMentionMap([
    makeAgent({ id: "agent-lower", name: "baoyu", displayName: "宝玉" }),
  ], []);

  const html = renderMessage(
    makeMessage({
      content: "ask @baoyu",
      mentions: [{ type: "agent", id: "agent-lower", name: "baoyu" }],
    }),
    { mentionMap },
  );

  assert.match(html, /<a\b(?=[^>]*href="#")[^>]*>@宝玉<\/a>/);
  assert.doesNotMatch(html, />@baoyu<\/a>/);
});

test("a stale directory entry with the same handle cannot label a different canonical mention id", () => {
  resetStores();
  const staleMentionMap = buildMentionMap([
    makeAgent({ id: "agent-old", name: "baoyu", displayName: "Old Account" }),
  ], []);

  const html = renderMessage(
    makeMessage({
      content: "ask @baoyu",
      mentions: [{ type: "agent", id: "agent-new", name: "baoyu" }],
    }),
    { mentionMap: staleMentionMap },
  );

  assert.match(html, />@baoyu<\/a>/);
  assert.doesNotMatch(html, /Old Account/);
});

test("known mentions with an empty display name use the handle as the final fallback", () => {
  resetStores();
  const mentionMap = buildMentionMap([
    makeAgent({ id: "agent-lower", name: "baoyu", displayName: null }),
  ], []);

  const html = renderMessage(
    makeMessage({
      content: "ask @baoyu",
      mentions: [{ type: "agent", id: "agent-lower", name: "baoyu" }],
    }),
    { mentionMap },
  );

  assert.match(html, /<a\b(?=[^>]*href="#")[^>]*>@baoyu<\/a>/);
});

test("structured mention facts render named-link handles without fallback lookup", () => {
  resetStores();

  const html = renderMessage(
    makeMessage({
      content: "[ask](<@baoyu>)",
      mentions: [{ type: "agent", id: "agent-lower", name: "baoyu" }],
    }),
  );

  assert.match(html, /<a\b(?=[^>]*href="#")[^>]*>ask<\/a>/);
});

test("MessageItem fail-opens unauthorized named Slock refs without leaking the target", () => {
  resetStores();

  const html = renderMessage(makeMessage({ content: "[look here](<#secret-channel>)" }));

  assert.match(html, />look here<\/span>/);
  assert.doesNotMatch(html, /secret-channel/);
  assert.doesNotMatch(html, /<a[^>]*>look here<\/a>/);
});

test("MessageItem renders auth avatar for current user when member cache is missing", () => {
  resetStores({ members: [] });

  const html = renderMessage(makeMessage());

  assert.match(html, new RegExp(authAvatarUrl));
});

test("MessageItem renders current server role when current-user member cache is missing", () => {
  resetStores({
    user: makeUser({ description: null }),
    currentServer: makeServer({ role: "admin" }),
    members: [],
  });

  const html = renderMessage(makeMessage());

  // The role badge renders through the catalog now (member.role.*) — the raw
  // enum badge was English in zh UI (DOM sweep 2026-08-04). en locale → "Admin".
  assert.match(html, /title="Admin"/);
  assert.match(html, />Admin<\/span>/);
  assert.doesNotMatch(html, /title="member"/);
});

test("MessageItem renders auth gravatar hash for current user when member cache and uploaded avatar are missing", () => {
  resetStores({ user: makeUser({ avatarUrl: null }), members: [] });

  const html = renderMessage(makeMessage());

  assert.match(html, /www\.gravatar\.com\/avatar\/currenthash/);
});

test("MessageItem keeps an email fallback diagnostic for old-session current users without auth gravatar hash", () => {
  resetStores({
    user: { ...makeUser({ avatarUrl: null }), gravatarHash: undefined as unknown as string },
    members: [],
  });

  const html = renderMessage(makeMessage());

  assert.match(html, /data-avatar-source="email-fallback"/);
  assert.match(html, /data-avatar-has-email-fallback="true"/);
});

test("MessageItem renders other users from member cache instead of auth profile", () => {
  resetStores({
    members: [
      makeMember({
        userId: "user-2",
        email: "other@example.com",
        name: "other",
        displayName: "Other User",
        avatarUrl: otherAvatarUrl,
      }),
    ],
  });

  const html = renderMessage(makeMessage({
    senderId: "user-2",
    senderName: "Other User",
  }));

  assert.match(html, new RegExp(otherAvatarUrl));
  assert.doesNotMatch(html, new RegExp(authAvatarUrl));
});

test("MessageItem resolves agent sender identity from agent store", () => {
  resetStores({ agents: [makeAgent()] });

  const html = renderMessage(makeMessage({
    senderType: "agent",
    senderId: "agent-1",
    senderName: "agent-one",
  }));

  assert.match(html, new RegExp(agentAvatarUrl));
  assert.match(html, />Agent One</);
  assert.doesNotMatch(html, />agent-one</);
  assert.match(html, /Agent description/);
});

test("MessageItem prefers live agent identity over a stale channel preview", () => {
  resetStores({
    agents: [makeAgent({
      displayName: "Current Agent",
      avatarUrl: agentAvatarUrl,
      description: "Current description",
    })],
  });

  const html = renderMessage(
    makeMessage({
      senderType: "agent",
      senderId: "agent-1",
      senderName: "agent-one",
    }),
    {
      previewSenderAgent: makeAgent({
        displayName: "Stale Agent",
        avatarUrl: previewAgentAvatarUrl,
        description: "Stale description",
      }),
    },
  );

  assert.match(html, new RegExp(agentAvatarUrl));
  assert.match(html, />Current Agent</);
  assert.match(html, /Current description/);
  assert.doesNotMatch(html, new RegExp(previewAgentAvatarUrl));
  assert.doesNotMatch(html, /Stale Agent|Stale description/);
});

test("MessageItem uses agent DM peer display name when agent profile displayName is missing", () => {
  resetStores({
    agents: [makeAgent({ displayName: null, name: "jinc" })],
    dmChannels: [makeAgentDmChannel()],
  });

  const html = renderMessage(makeMessage({
    channelId: "channel-1",
    senderType: "agent",
    senderId: "agent-1",
    senderName: "jinc",
  }));

  assert.match(html, />Jinc Display</);
  assert.doesNotMatch(html, />jinc</);
});

test("MessageItem preview sender override supports non-store preview agents", () => {
  resetStores({ agents: [] });

  const html = renderMessage(
    makeMessage({
      senderType: "agent",
      senderId: "preview-agent",
      senderName: "Preview Agent",
    }),
    {
      previewSenderAgent: makeAgent({
        id: "preview-agent",
        name: "preview-agent",
        displayName: "Preview Agent",
        avatarUrl: previewAgentAvatarUrl,
        description: "Preview-only sender",
      }),
    },
  );

  assert.match(html, new RegExp(previewAgentAvatarUrl));
  assert.match(html, /Preview-only sender/);
});

test("profile hover card renders a fallback preview agent missing from the local store", () => {
  resetStores({ agents: [] });
  const fallbackAgent = makeAgent({
    id: "preview-agent",
    name: "preview-agent",
    displayName: "Remote Preview Agent",
    avatarUrl: previewAgentAvatarUrl,
    description: "Remote profile fallback",
    status: "active",
  });

  const emptyHtml = renderToStaticMarkup(
    createElement(
      TestIntlProvider,
      null,
      createElement(ProfilePreviewCardContent, {
        mentionType: "agent",
        mentionId: "preview-agent",
      }),
    ),
  );
  const fallbackHtml = renderToStaticMarkup(
    createElement(
      TestIntlProvider,
      null,
      createElement(ProfilePreviewCardContent, {
        mentionType: "agent",
        mentionId: "preview-agent",
        fallbackAgent,
      }),
    ),
  );

  // A missing agent with no fallback profile now renders a minimal graceful
  // card (never empty) instead of `null`. The previous empty render was the
  // source of the empty-hover-card black bar for cross-server @mentions.
  assert.match(emptyHtml, /Profile unavailable/);
  assert.doesNotMatch(emptyHtml, /Remote Preview Agent/);
  assert.match(fallbackHtml, new RegExp(previewAgentAvatarUrl));
  assert.match(fallbackHtml, /Remote Preview Agent/);
  assert.match(fallbackHtml, /@preview-agent/);
  assert.match(fallbackHtml, /Remote profile fallback/);
  assert.match(fallbackHtml, /Online/);
});
