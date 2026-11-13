import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import type { Message } from "../src/store/messageStore";
import type { User } from "../src/store/authStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import type { Agent } from "../src/store/agentStore";
import type { Channel } from "../src/store/channelStore";

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

function renderMessage(message: Message, props: Record<string, unknown> = {}, locale: "en" | "zh-cn" = "en") {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        TestIntlProvider,
        { locale },
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

test("message refs are never the yellow sticker, which means you (#triage:71de6c0b)", () => {
  resetStores({ members: [makeMember()] });
  const html = renderMessage(
    makeMessage({ content: "see #general msg=abc12345 and #general:abcd1234 msg=abc12345" }),
    { channels: [makeChannel()], onOpenThread: () => {} },
  );
  const classOf = (text: string) => {
    const tag = new RegExp(`<(?:a|span)[^>]*class="([^"]*)"[^>]*>${text}</(?:a|span)>`).exec(html);
    assert.ok(tag, `no element for ${text}`);
    return tag[1];
  };

  for (const ref of ["#general msg=abc12345", "#general:abcd1234 msg=abc12345"]) {
    assert.match(classOf(ref), /\bbg-info-soft\b/);
    assert.doesNotMatch(classOf(ref), /\bbg-you\b/);
  }
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

// Member labels (#wg-rbac:#46): the author row writes one role, this server's
// Guest; Owner, Admin and Member are the hover card's.
test("MessageItem renders the current user's Guest role when the current-user member cache is missing", () => {
  resetStores({
    user: makeUser({ description: null }),
    currentServer: makeServer({ role: "guest" }),
    members: [],
  });

  const html = renderMessage(makeMessage());

  // The label renders through the catalog (en locale → "Guest"), never the raw enum.
  // The hover hint is the RUI tooltip trigger, not a native title=.
  assert.match(html, /data-base-ui-tooltip-trigger/);
  assert.match(html, />Guest<\/span>/);
  assert.doesNotMatch(html, /title="guest"/);
});

test("MessageItem writes no Owner, Admin or Member after a sender's name", () => {
  for (const role of ["owner", "admin", "member"] as const) {
    resetStores({
      user: makeUser({ description: null }),
      currentServer: makeServer({ role }),
      members: [],
    });

    const html = renderMessage(makeMessage());

    assert.doesNotMatch(html, />(Owner|Admin|Member)<\/span>/, role);
  }
});

test("MessageItem renders the User placeholder for a current user with no stored avatar, never a gravatar.com image or email hash", () => {
  resetStores({
    // An older server's session still carries a hash: ignored.
    user: { ...makeUser({ avatarUrl: null }), ...({ gravatarHash: "currenthash" } as object) },
    members: [],
  });

  const html = renderMessage(makeMessage());

  assert.match(html, /data-avatar-source="placeholder"/);
  assert.doesNotMatch(html, /gravatar|currenthash/i);
  assert.match(html, /lucide-user/);
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
  // The description follows the name on the author row again (cindyz, #triage:4eb8046c).
  assert.match(html, /Agent description/);
});

test("MessageItem prefers live agent identity over a stale channel preview", () => {
  resetStores({
    agents: [makeAgent({
      displayName: "Current Agent",
      avatarUrl: agentAvatarUrl,
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
      }),
    },
  );

  assert.match(html, new RegExp(agentAvatarUrl));
  assert.match(html, />Current Agent</);
  assert.doesNotMatch(html, new RegExp(previewAgentAvatarUrl));
  // The name and avatar the author row draws of an agent are the live ones.
  assert.doesNotMatch(html, /Stale Agent/);
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
  assert.match(html, />Preview Agent</);
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
  // No state for an agent outside the store: a guess, worded apart (#triage:#97).
  assert.match(fallbackHtml, /Likely online/);
});

// Task #762: refs are recognised on the parsed markdown tree, so the parser
// decides what is code, a link or an escape.
test("MessageItem never turns @ in a ~~~ block, a link label or a URL into a mention", () => {
  resetStores({ members: [makeMember({ userId: "user-2", name: "alice", displayName: "Alice" })] });
  const mentionMap = new Map([["alice", { type: "user" as const, id: "user-2", displayName: "Alice" }]]);
  const html = renderMessage(
    makeMessage({ content: "~~~\n@alice in tilde code\n~~~\n\n[hi @alice](https://e.com) https://x.com/@alice and @alice" }),
    { mentionMap },
  );
  assert.equal((html.match(/data-mention-id|>@Alice</g) ?? []).length > 0, true, "the plain @alice is still a mention");
  assert.match(html, /<code[^>]*>@alice in tilde code\n?<\/code>/);
  assert.match(html, /<a[^>]*href="https:\/\/e\.com"[^>]*>hi @alice<\/a>/);
  assert.match(html, /<a[^>]*href="https:\/\/x\.com\/@alice"[^>]*>https:\/\/x\.com\/@alice<\/a>/);
  assert.equal((html.match(/>@Alice</g) ?? []).length, 1, "only the plain @alice renders as a mention");
});

test("thread search highlight keeps links intact", () => {
  resetStores();
  const html = renderMessage(
    makeMessage({ content: "see [docs](https://example.com/link) and https://example.com/in here" }),
    { threadSearchHighlightQuery: "in" },
  );
  assert.doesNotMatch(html, /LINK\d/);
  assert.match(html, /href="https:\/\/example\.com\/link"/);
  assert.match(html, /href="https:\/\/example\.com\/in"/);
  assert.match(html, /<mark/);
});

test("raw HTML a user types is shown as text", () => {
  resetStores();
  const html = renderMessage(makeMessage({ content: "inline <b>bold</b> and\n\n<div>block</div>" }));
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(html, /&lt;div&gt;block&lt;\/div&gt;/);
  assert.doesNotMatch(html, /<b>bold<\/b>/);
});

test("generated-markdown repairs apply outside code only", () => {
  resetStores();
  const html = renderMessage(makeMessage({
    content: "> quoted\nafter the quote\n\n- **Registration: **203 users\n\nline one\\nline two\n\n```\n> code\nnot lifted\n```",
  }));
  assert.match(html, /<blockquote[^>]*>[\s\S]*quoted[\s\S]*<\/blockquote>\s*<p[^>]*>after the quote<\/p>/, "an unquoted line after a quote leaves the quote");
  assert.match(html, /<strong[^>]*>Registration:<\/strong> 203 users/);
  assert.match(html, /line one<br\/>\s*line two/);
  assert.match(html, /<code[^>]*>[^<]*&gt; code\nnot lifted/, "code keeps its source");
});

test("dm refs with peer kinds are not read as strikethrough", () => {
  resetStores();
  const html = renderMessage(makeMessage({ content: "dm:@Twin~agent and dm:@Twin~human" }));
  assert.doesNotMatch(html, /<del/);
  assert.match(html, /dm:@Twin~agent/);
  assert.match(html, /dm:@Twin~human/);
});

test("an escaped ref stays literal next to an unescaped one and a bare URL", () => {
  resetStores();
  const html = renderMessage(
    // `foohttps://…`: GFM does not link a URL glued to a word, so this one goes
    // through remarkAutolinkBareUrls, which splits the text node around it.
    makeMessage({ content: "<#general> and \\<#general> foohttps://example.com then \\<#general>" }),
    { channels: [makeChannel()] },
  );
  assert.equal((html.match(/>#general<\/a>/g) ?? []).length, 1, "only the unescaped ref is a link");
  assert.equal((html.match(/&lt;#general&gt;/g) ?? []).length, 2);
  assert.match(html, /href="https:\/\/example\.com"/);
});

test("Slack bot author is labeled as a bot without becoming a Raft agent", () => {
  resetStores();
  const externalAuthor = {
    projectionId: "external-1", provider: "slack", appRegistrationId: "app-1", installId: "install-1",
    workspaceId: "workspace-1", workspaceName: "Example Workspace", externalActorId: "B123",
    externalConversationId: "C123", externalMessageId: "123.456", displayName: "Alert Bot",
    actorKind: "bot" as const, avatarUrl: null, avatarDigest: null, actorProjectionRevision: 1,
  };
  const bot = renderMessage(makeMessage({ senderType: "external_projection", senderId: "external-1", externalAuthor }));
  assert.match(bot, /Alert Bot/);
  assert.match(bot, /data-testid="app-bot-badge"/);
  assert.match(bot, /Slack/);
  assert.doesNotMatch(bot, /agent-online-indicator|data-sidebar-avatar-badge/);
  const human = renderMessage(makeMessage({ senderType: "external_projection", senderId: "external-1",
    externalAuthor: { ...externalAuthor, actorKind: "human" } }));
  assert.doesNotMatch(human, /data-testid="app-bot-badge"/);
  assert.match(human, /Slack/, "human external authors use the localized provider name too");
});

test("verified Slack bot profile replaces only a fallback sender label", () => {
  resetStores();
  const base = { projectionId: "external-1", provider: "slack", appRegistrationId: "app-1", installId: "install-1",
    workspaceId: "workspace-1", workspaceName: "Example Workspace", externalActorId: "B123",
    externalConversationId: "C123", externalMessageId: "123.456", displayName: "Slack bot · B123",
    actorKind: "bot" as const, avatarUrl: null, avatarDigest: null, actorProjectionRevision: 1 };
  const fresh = renderMessage(makeMessage({ senderType: "external_projection", senderId: "external-1", externalAuthor: {
    ...base, profileDisplayName: "Formal Bot", profileAvatarUrl: "https://cdn.example/formal.png" } }));
  assert.match(fresh, /Formal Bot/);
  assert.match(fresh, /https:\/\/cdn\.example\/formal\.png/);
  const revoked = renderMessage(makeMessage({ senderType: "external_projection", senderId: "external-1", externalAuthor: base }));
  assert.match(revoked, /Slack bot · B123/);
  assert.doesNotMatch(revoked, /Formal Bot/);
  const historical = renderMessage(makeMessage({ senderType: "external_projection", senderId: "external-1", externalAuthor: {
    ...base, displayName: "Historical name", profileDisplayName: "Formal Bot" } }));
  assert.match(historical, /Historical name/);
});

test("external bot keeps its App attribution in a truncatable badge", () => {
  resetStores();
  const externalAuthor = {
    projectionId: "external-1", provider: "slack", appRegistrationId: "app-1", installId: "install-1",
    workspaceId: "workspace-1", workspaceName: "Example Workspace", externalActorId: "B123",
    externalConversationId: "C123", externalMessageId: "123.456", displayName: "Alert Bot",
    actorKind: "bot" as const, avatarUrl: null, avatarDigest: null, actorProjectionRevision: 1,
    appName: "A very long incident management application",
  };
  const html = renderMessage(makeMessage({ senderType: "external_projection", senderId: "external-1", externalAuthor }));
  assert.match(html, /data-testid="app-bot-badge"/);
  assert.match(html, /class="[^"]*truncate[^"]*">App · A very long incident management application<\/span>/);
  assert.match(html, /Slack/);
});

test("anonymous Slack author renders without a profile or mention control", () => {
  resetStores();
  const marker = `slack-anonymous:${"a".repeat(64)}`;
  const externalAuthor = {
    projectionId: "external-1", provider: "slack", appRegistrationId: "app-1", installId: "install-1",
    workspaceId: "workspace-1", externalActorId: marker, identityKind: "anonymous" as const,
    externalConversationId: "C123", externalMessageId: "123.456", displayName: "Slack",
    actorKind: "unknown" as const, avatarUrl: null, avatarDigest: null, actorProjectionRevision: 1,
  };
  const html = renderMessage(makeMessage({ senderType: "external_projection", senderId: marker, externalAuthor }),
    { senderAvatarTestId: "anonymous-avatar" });
  assert.match(html, /<span data-testid="anonymous-avatar" aria-label="Slack">/);
  assert.doesNotMatch(html, /data-testid="message-sender-mention-/);
  assert.doesNotMatch(html, /<img[^>]*src=["'][^"']*(?:slack-anonymous|slack\.com)/);
});


test("unresolved Slack author is localized only when explicitly marked", () => {
  resetStores();
  const externalAuthor = { projectionId: "external-1", provider: "slack", appRegistrationId: "app-1", installId: "install-1",
    workspaceId: "workspace-1", externalActorId: "U123", externalConversationId: "C123", externalMessageId: "123.456",
    displayName: "Slack user U123", actorKind: "unknown" as const, avatarUrl: null, avatarDigest: null,
    actorProjectionRevision: 1, profileFallback: "unresolved" as const };
  const msg = makeMessage({ senderType: "external_projection", senderId: "external-1", externalAuthor });
  assert.match(renderMessage(msg, {}, "en"), /Slack user U123/);
  assert.match(renderMessage(msg, {}, "zh-cn"), /Slack 用户 U123/);
  const ordinary = makeMessage({ senderType: "external_projection", senderId: "external-1",
    externalAuthor: { ...externalAuthor, profileFallback: undefined, displayName: "Original display" } });
  assert.match(renderMessage(ordinary, {}, "zh-cn"), /Original display/);
});
