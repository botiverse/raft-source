import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter, useLocation } from "react-router-dom";
import api from "../src/api/client";
import type { Agent } from "../src/store/agentStore";
import type { Channel } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="route-location">{`${location.pathname}${location.search}`}</output>;
}

function makeServer(): Server {
  return {
    id: "server-1",
    name: "Server",
    avatarUrl: null,
    slug: "server",
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "member",
    createdAt: "2026-07-14T00:00:00.000Z",
  };
}

const channel: Channel = {
  id: "channel-src",
  name: "src",
  description: null,
  type: "channel",
  createdAt: "2026-07-14T00:00:00.000Z",
};

const message: Message = {
  id: "message-1",
  channelId: channel.id,
  senderType: "user",
  senderId: "user-1",
  senderName: "Current User",
  messageType: "chat",
  content: "see #src:deadbeef",
  createdAt: "2026-07-14T00:00:00.000Z",
};

async function renderMessage(options: {
  currentServer?: Server;
  members?: ServerMember[];
  agents?: Agent[];
  channels?: Channel[];
  message?: Message;
  previewSenderAgent?: Agent;
  previewSenderMember?: ServerMember;
} = {}) {
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useChannelStore } = await import("../src/store/channelStore");

  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "current@example.com",
      gravatarHash: "hash",
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
    },
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  });
  useServerStore.setState({ current: options.currentServer ?? makeServer(), members: options.members ?? [] });
  useAgentStore.setState({ agents: options.agents ?? [], agentActivities: {} });
  const channels = options.channels ?? [channel];
  useChannelStore.setState({ channels, dmChannels: [] });
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
    openServerSlug: null,
    openThreadError: null,
    summaries: {},
    followedThreads: [],
  });

  const renderItem = (previewSenderAgent = options.previewSenderAgent, previewSenderMember = options.previewSenderMember) => (
    <MemoryRouter>
      <MessageItem
        message={options.message ?? message}
        mentionMap={new Map()}
        channels={channels}
        previewSenderAgent={previewSenderAgent}
        previewSenderMember={previewSenderMember}
        hideThreadActions
      />
      <LocationProbe />
    </MemoryRouter>
  );
  const rendered = render(renderItem());
  return {
    ...rendered,
    rerenderSenderPreview(previewSenderAgent?: Agent, previewSenderMember?: ServerMember) {
      rendered.rerender(renderItem(previewSenderAgent, previewSenderMember));
    },
  };
}

/**
 * The ONE create-or-get spy installer.
 *
 * Defined once on purpose: the invariant these tests assert is "no create-or-get
 * write", not "no POST at all", and an unfiltered spy also captures unrelated
 * traffic that merely lands in the same window (a `useServerStore.setState`
 * fires `void prefetchServerFeatureFlags` -> POST /feature-flags/evaluate, a
 * floating promise whose resolution order is timing).
 *
 * A second copy of this predicate would be worse than none: deleting the filter
 * here must break every test that depends on it, and a duplicate lets the
 * attribution tooth stay green while the real assertion loses its scope.
 */
function installCreateOrGetSpy(): { calls: string[]; createOrGetUrl: string } {
  const calls: string[] = [];
  const createOrGetUrl = `/channels/${channel.id}/threads`;
  api.post = (async (url: string) => {
    if (url === createOrGetUrl) {
      calls.push(url);
    }
    return { data: {} };
  }) as typeof api.post;
  return { calls, createOrGetUrl };
}

afterEach(() => {
  api.get = originalGet;
  api.post = originalPost;
  cleanup();
});

test("the production click handler hands off cross-server authority instead of probing a same-named local channel", async () => {
  const guestChannel = { ...channel, id: "guest-src" };
  const hostMember: ServerMember = {
    userId: "host-user",
    serverId: "host-server-id",
    serverName: "Host Server",
    serverSlug: "host-server",
    email: null,
    gravatarHash: "host-hash",
    name: "host-user",
    displayName: "Host User",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-14T00:00:00.000Z",
  };
  const getCalls: string[] = [];
  api.get = (async (url: string) => {
    getCalls.push(url);
    throw new Error("same-named local channel must not be probed");
  }) as typeof api.get;

  await renderMessage({
    currentServer: { ...makeServer(), slug: "guest-server" },
    members: [],
    channels: [guestChannel],
    previewSenderMember: hostMember,
    message: {
      ...message,
      channelId: guestChannel.id,
      senderId: hostMember.userId,
      senderName: hostMember.displayName ?? hostMember.name,
      content: "see #src:abcdef12",
    },
  });

  fireEvent.click(screen.getByRole("link", { name: "#src:abcdef12" }));
  await act(async () => { await Promise.resolve(); });
  assert.deepEqual(getCalls, [], "cross-server click must switch by authority rather than probe guest-src");
  assert.equal(useThreadStore.getState().openParentMessageId, null);
});

test("a joint message with unknown sender origin cannot bind a participant same-name channel", async () => {
  const jointFeed = { ...channel, id: "joint-feed", name: "joint-feed", type: "joint" as const };
  const guestChannel = { ...channel, id: "guest-src" };
  const hostMember: ServerMember = {
    userId: "remote-sender-not-yet-hydrated",
    serverId: "host-server-id",
    serverName: "Host Server",
    serverSlug: "host-server",
    email: null,
    gravatarHash: "host-hash",
    name: "remote-sender",
    displayName: "Remote Sender",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-14T00:00:00.000Z",
  };
  const getCalls: string[] = [];
  api.get = (async (url: string) => {
    getCalls.push(url);
    throw new Error("unknown joint origin must not probe participant state");
  }) as typeof api.get;

  const rendered = await renderMessage({
    currentServer: { ...makeServer(), slug: "guest-server" },
    members: [],
    channels: [jointFeed, guestChannel],
    message: {
      ...message,
      channelId: jointFeed.id,
      senderId: "remote-sender-not-yet-hydrated",
      senderName: "Remote Sender",
      content: "see #src:cafebabe",
    },
  });

  fireEvent.click(screen.getByText("#src:cafebabe"));
  await act(async () => { await Promise.resolve(); });
  assert.deepEqual(getCalls, [], "unknown joint origin must not inherit participant authority");
  assert.equal(screen.queryByRole("link", { name: "#src:cafebabe" }), null, "the unresolved ref has no handoff action");
  assert.equal(useThreadStore.getState().openParentMessageId, null);

  await act(async () => {
    rendered.rerenderSenderPreview(undefined, hostMember);
  });
  await waitFor(() => {
    assert.ok(
      screen.getByRole("link", { name: "#src:cafebabe" }),
      "hydrating sender origin must reactivate the same rendered ref",
    );
  });
  assert.deepEqual(getCalls, [], "metadata hydration must not probe participant state");
});

test("a non-joint local message may still use current-server thread authority", async () => {
  const getCalls: string[] = [];
  api.get = (async (url: string) => {
    getCalls.push(url);
    throw new Error("expected fail-closed context miss");
  }) as typeof api.get;

  await renderMessage({
    members: [],
    channels: [channel],
    message: {
      ...message,
      senderId: "local-sender-not-yet-hydrated",
      senderName: "Local Sender",
      content: "see #src:facefeed",
    },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("link", { name: "#src:facefeed" }));
  });
  assert.deepEqual(getCalls, ["/messages/context/facefeed"]);
  assert.equal(useThreadStore.getState().openParentMessageId, null);
});

test("a joint message from a current-server store member keeps local thread authority", async () => {
  const jointFeed = { ...channel, id: "joint-feed", name: "joint-feed", type: "joint" as const };
  const guestChannel = { ...channel, id: "guest-src" };
  const localMember: ServerMember = {
    userId: "local-member",
    email: "local@example.com",
    gravatarHash: "local-hash",
    name: "local-member",
    displayName: "Local Member",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-14T00:00:00.000Z",
  };
  const getCalls: Array<{ url: string; channelId?: string }> = [];
  api.get = (async (url: string, config?: { params?: { channelId?: string } }) => {
    getCalls.push({ url, channelId: config?.params?.channelId });
    throw new Error("expected fail-closed context miss");
  }) as typeof api.get;

  await renderMessage({
    currentServer: { ...makeServer(), slug: "guest-server" },
    members: [localMember],
    channels: [jointFeed, guestChannel],
    message: {
      ...message,
      channelId: jointFeed.id,
      senderId: localMember.userId,
      senderName: localMember.displayName ?? localMember.name,
      content: "see #src:aa11bb22",
    },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("link", { name: "#src:aa11bb22" }));
  });
  assert.deepEqual(getCalls, [{ url: "/messages/context/aa11bb22", channelId: guestChannel.id }]);
  assert.equal(useThreadStore.getState().openParentMessageId, null);
});

test("a joint message from a current-server store agent keeps local thread authority", async () => {
  const jointFeed = { ...channel, id: "joint-feed", name: "joint-feed", type: "joint" as const };
  const guestChannel = { ...channel, id: "guest-src" };
  const localAgent: Agent = {
    id: "local-agent",
    name: "local-agent",
    displayName: "Local Agent",
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
    createdAt: "2026-07-14T00:00:00.000Z",
  };
  const getCalls: Array<{ url: string; channelId?: string }> = [];
  api.get = (async (url: string, config?: { params?: { channelId?: string } }) => {
    getCalls.push({ url, channelId: config?.params?.channelId });
    throw new Error("expected fail-closed context miss");
  }) as typeof api.get;

  await renderMessage({
    currentServer: { ...makeServer(), slug: "guest-server" },
    agents: [localAgent],
    channels: [jointFeed, guestChannel],
    message: {
      ...message,
      channelId: jointFeed.id,
      senderType: "agent",
      senderId: localAgent.id,
      senderName: localAgent.displayName ?? localAgent.name,
      content: "see #src:cc33dd44",
    },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("link", { name: "#src:cc33dd44" }));
  });
  assert.deepEqual(getCalls, [{ url: "/messages/context/cc33dd44", channelId: guestChannel.id }]);
  assert.equal(useThreadStore.getState().openParentMessageId, null);
});

test("the production message click handler fails closed when context is unauthorized or missing", async () => {
  const getCalls: string[] = [];
  api.get = (async (url: string) => {
    getCalls.push(url);
    throw new Error("403 Access denied");
  }) as typeof api.get;

  await renderMessage();
  const link = screen.getByRole("link", { name: "#src:deadbeef" });
  await act(async () => {
    fireEvent.click(link);
  });

  await waitFor(() => {
    assert.match(document.body.textContent ?? "", /Unable to open thread/);
  });
  assert.deepEqual(getCalls, ["/messages/context/deadbeef"]);
  assert.equal(useThreadStore.getState().openParentMessageId, null, "no wrong thread is opened on a 403/miss");
});

test("a same-server context response cannot open a thread after a server epoch round trip", async () => {
  type ContextResponse = {
    data: {
      targetMessageId: string;
      canonicalTarget: {
        kind: "thread";
        channelId: string;
        messageId: string;
        threadParentMessageId: string;
        threadChannelId: string;
      };
    };
  };

  let resolveContext: ((value: ContextResponse) => void) | null = null;
  const getCalls: string[] = [];
  api.get = (async (url: string) => {
    getCalls.push(url);
    return new Promise<ContextResponse>((resolve) => {
      resolveContext = resolve;
    });
  }) as typeof api.get;
  const staleSpy = installCreateOrGetSpy();

  await renderMessage();
  const initialEpoch = useServerStore.getState().serverEpoch + 1;
  useServerStore.setState({ current: makeServer(), serverEpoch: initialEpoch });
  const initialLocation = screen.getByTestId("route-location").textContent;

  const link = screen.getByRole("link", { name: "#src:deadbeef" });
  fireEvent.click(link);
  await waitFor(() => {
    assert.deepEqual(getCalls, ["/messages/context/deadbeef"]);
    assert.equal(screen.getByText("#src:deadbeef").closest("a")?.getAttribute("aria-busy"), "true");
  });

  await act(async () => {
    useServerStore.setState({
      current: { ...makeServer(), id: "server-2", slug: "other-server" },
      serverEpoch: initialEpoch + 1,
    });
    useServerStore.setState({ current: makeServer(), serverEpoch: initialEpoch + 2 });
  });

  assert.ok(resolveContext);
  await act(async () => {
    resolveContext({
      data: {
        targetMessageId: "deadbeef-1111-2222-3333-444444444444",
        canonicalTarget: {
          kind: "thread",
          channelId: channel.id,
          messageId: "deadbeef-1111-2222-3333-444444444444",
          threadParentMessageId: "parent-1111-2222-3333-444444444444",
          threadChannelId: "thread-1111-2222-3333-444444444444",
        },
      },
    });
    await Promise.resolve();
  });
  await waitFor(() => {
    assert.equal(screen.getByText("#src:deadbeef").closest("a")?.getAttribute("aria-busy"), "false");
  });

  assert.deepEqual(staleSpy.calls, [], "stale context completion must not launch thread create-or-get");
  assert.equal(screen.getByTestId("route-location").textContent, initialLocation, "stale context completion must not navigate");
  assert.equal(useThreadStore.getState().openParentMessageId, null, "stale context completion must not open route state");
});

test("a same-server context response still opens in the captured server epoch", async () => {
  const getCalls: string[] = [];
  api.get = (async (url: string) => {
    getCalls.push(url);
    if (url === "/messages/context/deadbeef") {
      return {
        data: {
          targetMessageId: "deadbeef-1111-2222-3333-444444444444",
          canonicalTarget: {
            kind: "thread",
            channelId: channel.id,
            messageId: "deadbeef-1111-2222-3333-444444444444",
            threadParentMessageId: "parent-1111-2222-3333-444444444444",
            threadChannelId: "thread-1111-2222-3333-444444444444",
          },
        },
      };
    }
    if (url === `/channels/${channel.id}/threads/parent-1111-2222-3333-444444444444`) {
      return {
        data: {
          threadChannelId: "thread-1111-2222-3333-444444444444",
          replyCount: 0,
          lastReplyAt: null,
          participantIds: [],
        },
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  // Record ONLY the create-or-get write this test is about. The invariant is
  // "a known thread id must not trigger create-or-get" — not "no POST happens".
  // An unfiltered spy also captures unrelated traffic that merely lands in this
  // window: the `useServerStore.setState` below fires a server-flag prefetch
  // (`void prefetchServerFeatureFlags` -> POST /feature-flags/evaluate), which
  // is a floating promise, so whether it resolves before or after the assertion
  // is timing. That is CONSISTENT WITH the observed intermittent CI red and MAY
  // explain it; it was not reproduced locally, so it stays a hypothesis rather
  // than a diagnosed cause. What this scoping fixes is the misattribution
  // surface, which holds either way.
  const spy = installCreateOrGetSpy();

  // Guard the SPY THIS TEST ACTUALLY USES, before exercising the flow: an
  // unrelated POST must not be attributed, and a real create-or-get must be.
  // Asserting this against a second, locally-built spy would leave the filter
  // below unguarded — deleting it would not red anything.
  await api.post("/feature-flags/evaluate", {});
  assert.deepEqual(spy.calls, [], "unrelated POSTs must not reach the create-or-get list");
  await api.post(spy.createOrGetUrl, {});
  assert.deepEqual(spy.calls, [spy.createOrGetUrl], "a real create-or-get must still be captured");
  spy.calls.length = 0;

  await renderMessage();
  useServerStore.setState({ current: makeServer(), serverEpoch: useServerStore.getState().serverEpoch + 1 });
  fireEvent.click(screen.getByRole("link", { name: "#src:deadbeef" }));

  await waitFor(() => {
    assert.deepEqual(getCalls, ["/messages/context/deadbeef"]);
    assert.deepEqual(spy.calls, [], "a known thread id must open without any create-or-get write");
    assert.equal(useThreadStore.getState().openParentMessageId, "parent-1111-2222-3333-444444444444");
    assert.match(screen.getByTestId("route-location").textContent ?? "", /msg=parent-1111-2222-3333-444444444444/);
  });
});
