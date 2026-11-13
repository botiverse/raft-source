import assert from "node:assert/strict";
import "./helpers/domSetup";

import {
  CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
  WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY,
  CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY,
  AGENT_USAGE_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import api from "../src/api/client";
import { connectSocket, getSocket, resetSocket } from "../src/api/socket";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import {
  REGISTERED_SERVER_FEATURE_FLAG_KEYS,
  getServerFeatureFlagSnapshot,
  prefetchServerFeatureFlags,
  publishServerFeatureFlagValuesFromLabsReadback,
  readServerFeatureFlag,
  readServerFeatureFlagState,
  refreshServerFeatureFlags,
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
  setServerFeatureFlagRetryBackoffForTests,
  INTERACTIVE_LINK_CARDS_FEATURE_FLAG_KEY,
  WEB_PREVIEW_FLAG_KEY,
  DESKTOP_WEB_PREVIEW_VIEW_FLAG_KEY,
  INBOX_READ_INPLACE_FLAG_KEY,
  DEEP_LINKS_FLAG_KEY,
  DRAFTS_SECTION_FLAG_KEY,
  AGENT_READ_PROGRESS_FEATURE_FLAG_KEY,
  HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY,
} from "../src/store/serverFeatureFlags";

const originalPost = api.post.bind(api);
const originalAuthState = useAuthStore.getState();
const originalServerState = useServerStore.getState();

test("provider connections are registered and fail closed before server evaluation", () => {
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY), false);
});

test("flag state distinguishes loading from a resolved disabled result", async () => {
  assert.equal(
    readServerFeatureFlagState("server-a", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY),
    "loading",
  );
  api.post = (async () => ({ data: { evaluations: [] } })) as typeof api.post;

  await prefetchServerFeatureFlags("server-a");

  assert.equal(
    readServerFeatureFlagState("server-a", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY),
    "disabled",
  );
});

test("Slack Bridge master gate is registered and fail-closed before server evaluation", () => {
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master));
  assert.equal(readServerFeatureFlag("server-a", SLACK_BRIDGE_FEATURE_FLAG_KEYS.master), false);
});

test("retired flags are not registered: the web never asks for them (#raft-architecture:#32)", () => {
  for (const key of ["activity_overview_web_v0", "app_bot_ui_v0", "bulk_change_model_web_v0", "thread_unread_badge_v0", "sidebar_mark_all_read_v0", "computers_rack_overview_v0", "agent_upgrade_card"]) {
    assert.equal((REGISTERED_SERVER_FEATURE_FLAG_KEYS as readonly string[]).includes(key), false, key);
  }
});

test("interactive link cards are registered under the server's key and fail closed before server evaluation", () => {
  assert.equal(INTERACTIVE_LINK_CARDS_FEATURE_FLAG_KEY, "interactive_link_cards");
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(INTERACTIVE_LINK_CARDS_FEATURE_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", INTERACTIVE_LINK_CARDS_FEATURE_FLAG_KEY), false);
});

test("action_card_spec is not registered: the web renders every card from its spec and never asks for the flag", () => {
  assert.equal((REGISTERED_SERVER_FEATURE_FLAG_KEYS as readonly string[]).includes("action_card_spec"), false);
});

test("workspace artifacts is registered and fail closed before server evaluation", () => {
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY), false);
});

test("deep links v1 is registered under the migration's key and fail closed before server evaluation", () => {
  assert.equal(DEEP_LINKS_FLAG_KEY, "deep_links_v1");
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(DEEP_LINKS_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", DEEP_LINKS_FLAG_KEY), false);
});

test("drafts section is registered under the migration's key and fail closed before server evaluation", () => {
  assert.equal(DRAFTS_SECTION_FLAG_KEY, "drafts_section_v0");
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(DRAFTS_SECTION_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", DRAFTS_SECTION_FLAG_KEY), false);
});

test("auth_second_factor_v1 is retired: the web no longer registers or reads it", () => {
  assert.ok(!REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes("auth_second_factor_v1"));
});

test("account deletion is not a web flag any more: account_deletion_v0 was retired (#raft-architecture:#32)", () => {
  assert.equal(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes("account_deletion_v0" as never), false);
});

test("agent read progress is registered under the migration's key and fail closed before server evaluation", () => {
  assert.equal(AGENT_READ_PROGRESS_FEATURE_FLAG_KEY, "agent_read_progress_v0");
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(AGENT_READ_PROGRESS_FEATURE_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", AGENT_READ_PROGRESS_FEATURE_FLAG_KEY), false);
});

test("web preview is registered under the migration's key and fail closed before server evaluation", () => {
  assert.equal(WEB_PREVIEW_FLAG_KEY, "web_preview_v0");
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(WEB_PREVIEW_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", WEB_PREVIEW_FLAG_KEY), false);
});

test("desktop web preview view is registered under the migration's key and fail closed before server evaluation", () => {
  assert.equal(DESKTOP_WEB_PREVIEW_VIEW_FLAG_KEY, "desktop_web_preview_view_v0");
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(DESKTOP_WEB_PREVIEW_VIEW_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", DESKTOP_WEB_PREVIEW_VIEW_FLAG_KEY), false);
});

test("inbox read in place is registered under the migration's key and fail closed before server evaluation", () => {
  assert.equal(INBOX_READ_INPLACE_FLAG_KEY, "inbox_read_inplace_v1");
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(INBOX_READ_INPLACE_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", INBOX_READ_INPLACE_FLAG_KEY), false);
});

test("Claude limit resets are registered under the shared key and fail closed before server evaluation", () => {
  assert.equal(CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY, "claude_limit_reset");
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY), false);
});

test("agent usage is registered under the shared key and fail closed before server evaluation", () => {
  assert.equal(AGENT_USAGE_FEATURE_FLAG_KEY, "agent_usage_v0");
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(AGENT_USAGE_FEATURE_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", AGENT_USAGE_FEATURE_FLAG_KEY), false);
});

test("the human avatar builder is registered under the shared key and fail closed before server evaluation", () => {
  assert.equal(HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY, "human_avatar_builder_v0");
  assert.ok(REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY));
  assert.equal(readServerFeatureFlag("server-a", HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY), false);
});

afterEach(() => {
  api.post = originalPost as typeof api.post;
  resetSocket();
  resetServerFeatureFlagsForTests();
  useAuthStore.setState(originalAuthState, true);
  useServerStore.setState(originalServerState, true);
  localStorage.clear();
});

test("registered server flags evaluate once as one batch and repeated consumers reuse the result", async () => {
  let postCalls = 0;
  api.post = (async (url: string, body?: unknown) => {
    postCalls += 1;
    assert.equal(url, "/feature-flags/evaluate");
    assert.deepEqual(body, {
      serverId: "server-a",
      platform: "web",
      keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
    });
    return {
      data: {
        evaluations: REGISTERED_SERVER_FEATURE_FLAG_KEYS.map((key) => ({
          key,
          enabled: key === CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY,
        })),
      },
    };
  }) as typeof api.post;

  for (let index = 0; index < 100; index += 1) {
    assert.equal(
      readServerFeatureFlag("server-a", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY),
      false,
      "message consumers stay fail-closed while the one batch is pending",
    );
  }
  assert.equal(postCalls, 0, "message-time reads must never own feature-flag I/O");

  const [first, second] = await Promise.all([
    prefetchServerFeatureFlags("server-a"),
    prefetchServerFeatureFlags("server-a"),
  ]);
  const third = await prefetchServerFeatureFlags("server-a");

  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(postCalls, 1);
  assert.equal(first.resolved, true);
  assert.equal(first.values[CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY], true);
  assert.equal(
    readServerFeatureFlagState("server-a", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY),
    "enabled",
  );
  assert.equal(
    getServerFeatureFlagSnapshot("server-a").values[CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY],
    true,
  );
  for (let index = 0; index < 100; index += 1) {
    assert.equal(
      readServerFeatureFlag("server-a", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY),
      true,
      "new message consumers read the resolved cache without another request",
    );
  }
  assert.equal(postCalls, 1);
});

test("transient batch evaluate failures retry once before resolving the server cache", async () => {
  setServerFeatureFlagRetryBackoffForTests(0);
  let postCalls = 0;
  api.post = (async (url: string, body?: unknown) => {
    postCalls += 1;
    assert.equal(url, "/feature-flags/evaluate");
    assert.deepEqual(body, {
      serverId: "server-a",
      platform: "web",
      keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
    });
    if (postCalls === 1) throw new Error("transient feature flag failure");
    return {
      data: {
        evaluations: [{ key: CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY, enabled: true }],
      },
    };
  }) as typeof api.post;

  const [first, second] = await Promise.all([
    prefetchServerFeatureFlags("server-a"),
    prefetchServerFeatureFlags("server-a"),
  ]);
  const third = await prefetchServerFeatureFlags("server-a");

  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(postCalls, 2);
  assert.equal(first.resolved, true);
  assert.equal(first.values[CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY], true);
  assert.equal(
    readServerFeatureFlag("server-a", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY),
    true,
    "one transient failure must not pin registered flags false for the session",
  );
});

test("retry backoff does not re-evaluate after the session cache is invalidated", async () => {
  setServerFeatureFlagRetryBackoffForTests(0);
  let postCalls = 0;
  api.post = (async () => {
    postCalls += 1;
    throw new Error("feature flag service unavailable before logout");
  }) as typeof api.post;

  const request = prefetchServerFeatureFlags("server-a");
  resetServerFeatureFlagsForTests();
  const snapshot = await request;

  assert.equal(postCalls, 1);
  assert.equal(snapshot.resolved, true);
  for (const key of REGISTERED_SERVER_FEATURE_FLAG_KEYS) {
    assert.equal(snapshot.values[key], false);
  }
  assert.equal(
    getServerFeatureFlagSnapshot("server-a").resolved,
    false,
    "stale retry completion must not publish into the new session generation",
  );
});

test("server flag cache is scoped per server and repeated request failures resolve fail-closed", async () => {
  setServerFeatureFlagRetryBackoffForTests(0);
  const requestedServers: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  api.post = (async (_url: string, body?: unknown) => {
    const serverId = (body as { serverId: string }).serverId;
    requestedServers.push(serverId);
    if (serverId === "server-b") throw new Error("feature flag service unavailable");
    return {
      data: {
        evaluations: [{ key: CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY, enabled: true }],
      },
    };
  }) as typeof api.post;

  const serverA = await prefetchServerFeatureFlags("server-a");
  const serverB = await prefetchServerFeatureFlags("server-b");
  await prefetchServerFeatureFlags("server-a");
  await prefetchServerFeatureFlags("server-b");

  assert.deepEqual(requestedServers, ["server-a", "server-b", "server-b"]);
  assert.equal(serverA.values[CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY], true);
  assert.equal(serverB.resolved, true);
  assert.equal(serverB.resolution, "undetermined");
  assert.equal(
    readServerFeatureFlagState("server-b", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY),
    "undetermined",
    "a terminal evaluation failure must not masquerade as a disabled flag",
  );
  assert.equal(
    readServerFeatureFlag("server-b", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY),
    false,
    "undetermined flags remain fail-closed for existing boolean consumers",
  );
  for (const key of REGISTERED_SERVER_FEATURE_FLAG_KEYS) {
    assert.equal(serverB.values[key], false);
  }
  assert.equal(warn.mock.calls.length, 1);
  assert.match(String(warn.mock.calls[0][0]), /evaluation failed/);
  assert.deepEqual(warn.mock.calls[0][1], { serverId: "server-b" });
});

test("Lab readback stays determinate when the batch evaluator is undetermined", async () => {
  setServerFeatureFlagRetryBackoffForTests(0);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  api.post = (async () => {
    throw new Error("feature flag service unavailable");
  }) as typeof api.post;

  await prefetchServerFeatureFlags("server-a");
  publishServerFeatureFlagValuesFromLabsReadback({
    serverId: "server-a",
    serverLabVersion: 1,
    masterEnabled: true,
    labs: [{
      key: CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY,
      name: "Attachment comments",
      description: "Attachment comments.",
      state: "open",
      enrolled: true,
      effective: true,
    }],
  });

  assert.equal(
    readServerFeatureFlagState("server-a", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY),
    "enabled",
  );
  assert.equal(
    readServerFeatureFlagState("server-a", PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY),
    "undetermined",
  );
});

test("Lab readback stays determinate while the batch evaluator is still loading", () => {
  publishServerFeatureFlagValuesFromLabsReadback({
    serverId: "server-enabled",
    serverLabVersion: 1,
    masterEnabled: true,
    labs: [{
      key: CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY,
      name: "Attachment comments",
      description: "Attachment comments.",
      state: "open",
      enrolled: true,
      effective: true,
    }],
  });
  publishServerFeatureFlagValuesFromLabsReadback({
    serverId: "server-disabled",
    serverLabVersion: 1,
    masterEnabled: true,
    labs: [{
      key: CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY,
      name: "Attachment comments",
      description: "Attachment comments.",
      state: "open",
      enrolled: false,
      effective: false,
    }],
  });

  assert.equal(
    readServerFeatureFlagState("server-enabled", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY),
    "enabled",
  );
  assert.equal(
    readServerFeatureFlagState("server-disabled", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY),
    "disabled",
  );
  assert.equal(
    readServerFeatureFlagState("server-enabled", PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY),
    "loading",
  );
});

test("Lab readback-derived flag values win over slower evaluator responses", async () => {
  let postCalls = 0;
  api.post = (async (url: string, body?: unknown) => {
    postCalls += 1;
    assert.equal(url, "/feature-flags/evaluate");
    const request = body as { serverId: string; keys: string[] };
    assert.equal(request.serverId, "server-a");
    return {
      data: {
        evaluations: request.keys.map((key) => ({
          key,
          enabled: false,
        })),
      },
    };
  }) as typeof api.post;

  await prefetchServerFeatureFlags("server-a");
  publishServerFeatureFlagValuesFromLabsReadback({
    serverId: "server-a",
    serverLabVersion: 3,
    masterEnabled: true,
    labs: [{
      key: CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY,
      name: "Attachment comments",
      description: "Attachment comments.",
      state: "open",
      enrolled: true,
      effective: true,
    }],
  });

  assert.equal(readServerFeatureFlag("server-a", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY), true);

  await refreshServerFeatureFlags("server-a");

  assert.equal(postCalls, 2);
  assert.equal(
    readServerFeatureFlag("server-a", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY),
    true,
    "a delayed evaluator refresh must not resurrect the older Lab gate result",
  );
  assert.equal(
    readServerFeatureFlagState("server-a", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY),
    "enabled",
    "the Lab-derived state stays authoritative after batch evaluation resolves",
  );
});

test("socket lifecycle prefetches the registered server flags", async () => {
  useServerStore.setState({
    current: {
      id: "server-socket-flags",
      name: "Socket Flags",
      slug: "socket-flags",
      avatarUrl: null,
      ownerId: "owner-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: new Date(0).toISOString(),
    },
  } as never);
  let postCalls = 0;
  api.post = (async (url: string, body?: unknown) => {
    postCalls += 1;
    assert.equal(url, "/feature-flags/evaluate");
    assert.deepEqual(body, {
      serverId: "server-socket-flags",
      platform: "web",
      keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
    });
    return { data: { evaluations: [] } };
  }) as typeof api.post;

  const socket = getSocket();
  vi.spyOn(socket, "connect").mockImplementation(() => socket);
  connectSocket();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(postCalls, 1, "the explicit connect path owns one registry prefetch");

  resetServerFeatureFlagsForTests();
  postCalls = 0;
  const connected = socket.listeners("connect");
  assert.equal(connected.length, 1, "connectSocket installs one connect lifecycle listener");
  connected[0]?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(postCalls, 1, "the successful socket lifecycle refreshes the registry cache");
});

test("logout invalidates the resolved server feature-flag session cache", () => {
  setServerFeatureFlagForTests(
    "server-before-logout",
    CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY,
    true,
  );
  assert.equal(getServerFeatureFlagSnapshot("server-before-logout").resolved, true);
  assert.equal(
    readServerFeatureFlag("server-before-logout", CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY),
    true,
  );
  useAuthStore.setState({
    user: { id: "user-before-logout" } as never,
    accessToken: "access-before-logout",
    refreshToken: null,
    initialized: true,
  });

  useAuthStore.getState().logout();

  assert.equal(
    getServerFeatureFlagSnapshot("server-before-logout").resolved,
    false,
    "a new login must not inherit the previous session's evaluated flags",
  );
});
