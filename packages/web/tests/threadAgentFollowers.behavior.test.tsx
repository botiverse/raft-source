import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test as nodeTest } from "node:test";
import { THREAD_AGENT_FOLLOWER_MANAGEMENT_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "raft-ui";
import "./helpers/domSetup";

import api from "../src/api/client";
import ThreadAgentFollowers from "../src/components/thread/ThreadAgentFollowers";
import {
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import { useProfileStore } from "../src/store/profileStore";
import { getCachedAgentProfile } from "../src/components/profile/profileFallbackCache";
import {
  buildMainLayoutSocketBindings,
  installSocketBridge,
} from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket } from "../src/store/socketBridge";
import { useThreadAgentFollowerStore } from "../src/store/threadAgentFollowerStore";
import { TestIntlProvider } from "./helpers/intl";

const SERVER_ID = "server-thread-agent-followers";
const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_THREAD_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const PEER_AGENT_ID = "44444444-4444-4444-8444-444444444444";
const LONG_AGENT_NAME = "A very long Agent display name that must stay contained in the roster row";

const originalGet = api.get.bind(api);
const originalDelete = api.delete.bind(api);
const originalPost = api.post.bind(api);
const test = ((name: string, fn: Parameters<typeof nodeTest>[1]) =>
  nodeTest(name, { concurrency: false }, fn)) as typeof nodeTest;

function setupServer(enabled = true) {
  useServerStore.setState({
    current: {
      id: SERVER_ID,
      name: "Thread Followers Server",
      slug: "botiverse",
      ownerId: "user-owner",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "founder",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-08-25T00:00:00.000Z",
    },
  } as never);
  setServerFeatureFlagForTests(
    SERVER_ID,
    THREAD_AGENT_FOLLOWER_MANAGEMENT_FEATURE_FLAG_KEY,
    enabled,
  );
}

function renderFollower(threadChannelId = THREAD_ID, variant: "card" | "header" = "card") {
  return render(
    <TestIntlProvider>
      <ThreadAgentFollowers threadChannelId={threadChannelId} variant={variant} />
    </TestIntlProvider>,
  );
}

function responseRow(threadChannelId: string, canManage: boolean, includeAgent = true) {
  return {
    threadChannelId,
    canManage,
    agents: includeAgent ? [{
      id: AGENT_ID,
      name: "long-agent-handle",
      displayName: LONG_AGENT_NAME,
      status: "online",
      avatarUrl: null,
    }] : [],
  };
}

function mixedManagedResponseRow() {
  return {
    threadChannelId: THREAD_ID,
    canManage: true,
    agents: [
      {
        id: AGENT_ID,
        name: "local-agent",
        displayName: "Local Agent",
        status: "online",
        avatarUrl: null,
        serverId: SERVER_ID,
        serverName: "Thread Followers Server",
        serverSlug: "botiverse",
        isCurrentServer: true,
        canRemove: true,
      },
      {
        id: PEER_AGENT_ID,
        name: "peer-agent",
        displayName: "Peer Agent",
        status: "online",
        avatarUrl: null,
        serverId: "peer-server-id",
        serverName: "Peer East",
        serverSlug: "peer-east",
        isCurrentServer: false,
        canRemove: false,
      },
    ],
  };
}

function installFollowerUpdateBridge() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const socket: MainLayoutSocketBridgeSocket = {
    connected: true,
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const eventHandlers = handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
      eventHandlers.add(handler);
      handlers.set(event, eventHandlers);
    },
    off: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.get(event)?.delete(handler);
    },
    onAny: () => undefined,
    offAny: () => undefined,
    disconnect: () => undefined,
    connect: () => undefined,
  };
  const bindings = buildMainLayoutSocketBindings(
    socket,
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  return { socket, uninstall: installSocketBridge(socket, "thread-followers-mounted-test", bindings) };
}

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  api.delete = originalDelete as typeof api.delete;
  api.post = originalPost as typeof api.post;
  resetServerFeatureFlagsForTests();
  useThreadAgentFollowerStore.getState().reset();
  useProfileStore.getState().closeProfile();
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("disabled servers render neither thread follower entry nor roster request", async () => {
  setupServer(false);
  let getCalls = 0;
  api.get = (async () => {
    getCalls += 1;
    throw new Error("disabled surface must not load");
  }) as typeof api.get;

  renderFollower();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(screen.queryByTestId("thread-followers-card-trigger"), null);
  assert.equal(getCalls, 0);
});

test("card and header entries coalesce roster loading and keep ordinary viewers read-only", async () => {
  setupServer();
  const gets: Array<{ url: string; ids: string }> = [];
  api.get = (async (url: string, config?: { params?: { threadChannelIds?: string } }) => {
    const ids = config?.params?.threadChannelIds ?? "";
    gets.push({ url, ids });
    return {
      data: {
        threads: ids.split(",").map((threadChannelId) => responseRow(threadChannelId, false)),
      },
    };
  }) as typeof api.get;

  render(
    <TestIntlProvider>
      <ThreadAgentFollowers threadChannelId={THREAD_ID} variant="card" />
      <ThreadAgentFollowers threadChannelId={OTHER_THREAD_ID} variant="header" />
    </TestIntlProvider>,
  );

  await waitFor(() => {
    assert.equal(screen.getByTestId("thread-followers-card-trigger").textContent, "1");
    assert.equal(screen.getByTestId("thread-followers-header-trigger").textContent, "1");
  });
  assert.equal(gets.length, 1, "entries mounted in one render must share one bulk roster request");
  assert.equal(gets[0]?.url, "/channels/threads/followers");
  assert.deepEqual(new Set(gets[0]?.ids.split(",")), new Set([THREAD_ID, OTHER_THREAD_ID]));

  fireEvent.click(screen.getByTestId("thread-followers-card-trigger"));
  assert.ok(await screen.findByText(LONG_AGENT_NAME));
  assert.equal(screen.getByText(LONG_AGENT_NAME).getAttribute("title"), LONG_AGENT_NAME);
  assert.equal(screen.queryByTestId("thread-follower-remove"), null, "read-only viewers must not get a removal control");
});

test("every follower row opens the corresponding Agent profile", async () => {
  setupServer();
  api.get = (async () => ({
    data: {
      threads: [{
        threadChannelId: THREAD_ID,
        canManage: false,
        agents: [
          {
            id: AGENT_ID,
            name: "local-agent",
            displayName: "Local Agent",
            status: "online",
            avatarUrl: null,
            serverId: SERVER_ID,
          },
          {
            id: PEER_AGENT_ID,
            name: "peer-agent",
            displayName: "Peer Agent",
            status: "online",
            avatarUrl: null,
            serverId: "peer-server-id",
            serverName: "Peer East",
            serverSlug: "peer-east",
            isCurrentServer: false,
          },
        ],
      }],
    },
  })) as typeof api.get;

  renderFollower();
  await waitFor(() => assert.equal(screen.getByTestId("thread-followers-card-trigger").textContent, "2"));

  fireEvent.click(screen.getByTestId("thread-followers-card-trigger"));

  const profileRows = await screen.findAllByTestId("thread-follower-profile-row");
  assert.equal(profileRows.length, 2);
  for (const [index, profileRow] of profileRows.entries()) {
    assert.equal(profileRow.tagName, "BUTTON", "the profile target must be a native button");
    assert.equal(profileRow.getAttribute("aria-label"), index === 0 ? "Local Agent" : "Peer Agent");
    fireEvent.click(profileRow);
    await waitFor(() => {
      const profile = useProfileStore.getState();
      assert.equal(profile.profileType, "agent");
      assert.equal(profile.profileId, index === 0 ? AGENT_ID : PEER_AGENT_ID);
      assert.equal(profile.defaultAgentTabIntent, null);
      assert.ok(profile.openedAt > 0, "opening a profile records an open timestamp");
    });
  }

  assert.equal(getCachedAgentProfile(SERVER_ID, AGENT_ID)?.status, "active");
  assert.equal(getCachedAgentProfile(SERVER_ID, PEER_AGENT_ID)?.status, "active");
});

test("removing a follower keeps the roster open so several can be removed in a row", async (t) => {
  setupServer();
  api.get = (async () => ({
    data: {
      threads: [{
        threadChannelId: THREAD_ID,
        canManage: true,
        agents: [
          { id: AGENT_ID, name: "first-agent", displayName: "First Agent", status: "online", avatarUrl: null, serverId: SERVER_ID },
          { id: PEER_AGENT_ID, name: "second-agent", displayName: "Second Agent", status: "online", avatarUrl: null, serverId: SERVER_ID },
        ],
      }],
    },
  })) as typeof api.get;
  const deletes: string[] = [];
  api.delete = (async (url: string) => {
    deletes.push(url);
    return { data: { ok: true, removed: true, undoToken: null } };
  }) as typeof api.delete;
  t.mock.method(toast, "success", () => "toast-id");

  renderFollower();
  await waitFor(() => assert.equal(screen.getByTestId("thread-followers-card-trigger").textContent, "2"));
  fireEvent.click(screen.getByTestId("thread-followers-card-trigger"));

  const removeButtons = await screen.findAllByTestId("thread-follower-remove");
  assert.equal(removeButtons.length, 2);
  fireEvent.click(removeButtons[0]!);

  // Removal is an in-place edit of the list, not a navigation away from it:
  // the roster must still be on screen afterwards so the next row can be
  // removed without reopening the trigger.
  await waitFor(() => assert.equal(deletes.length, 1));
  assert.ok(
    screen.queryAllByTestId("thread-follower-row").length > 0,
    "removing a follower must not close the roster",
  );
});

test("the roster opts out of the design system's disabled anchor tracking", () => {
  const source = readFileSync(
    new URL("../src/components/thread/ThreadAgentFollowers.tsx", import.meta.url),
    "utf8",
  );
  // raft-ui ships `disableAnchorTracking = true` for every Popover, so this
  // roster would stay at the trigger's old coordinates whenever the thread
  // header reflows. jsdom performs no floating-element layout, so this is a
  // source-level pin rather than a rendered assertion: it cannot prove the
  // popover repositions, only that the opt-out has not silently disappeared.
  assert.match(source, /disableAnchorTracking=\{false\}/);
});

test("roster failure is explicit and Retry can resolve to the empty state", async () => {
  setupServer();
  let calls = 0;
  api.get = (async () => {
    calls += 1;
    if (calls === 1) throw new Error("offline");
    return { data: { threads: [responseRow(THREAD_ID, true, false)] } };
  }) as typeof api.get;

  renderFollower();
  assert.equal(
    screen.queryByTestId("thread-followers-card-trigger"),
    null,
    "unknown/loading follower counts must not flash as zero",
  );
  fireEvent.click(await screen.findByTestId("thread-followers-card-trigger"));
  assert.ok(await screen.findByTestId("thread-followers-error"));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));

  await waitFor(() => {
    const roster = useThreadAgentFollowerStore.getState().rosters[THREAD_ID];
    assert.equal(calls, 2);
    assert.equal(roster?.loaded, true, "Retry must commit the successful roster before checking absence");
    assert.equal(roster?.loading, false);
    assert.equal(roster?.error, false);
    assert.deepEqual(roster?.agents, []);
  });
  const emptyRosterTrigger = screen.queryByTestId("thread-followers-card-trigger");
  assert.equal(calls, 2);
  assert.equal(
    emptyRosterTrigger === null,
    true,
    "a successfully loaded empty roster must not render an entry button",
  );
});

test("thread author removal updates the roster immediately and five-second Undo restores it", async (t) => {
  setupServer();
  const deletes: string[] = [];
  const posts: Array<{ url: string; body: unknown }> = [];
  let rosterLoads = 0;
  api.get = (async () => {
    rosterLoads += 1;
    return { data: { threads: [responseRow(THREAD_ID, true)] } };
  }) as typeof api.get;
  api.delete = (async (url: string) => {
    deletes.push(url);
    return { data: { ok: true, removed: true, undoToken: "2026-08-25T00:00:00.000Z" } };
  }) as typeof api.delete;
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    return { data: { ok: true, restored: true } };
  }) as typeof api.post;
  const successToast = t.mock.method(toast, "success", () => "toast-id");

  renderFollower();
  await waitFor(() => assert.equal(screen.getByTestId("thread-followers-card-trigger").textContent, "1"));
  fireEvent.click(screen.getByTestId("thread-followers-card-trigger"));
  fireEvent.click(await screen.findByTestId("thread-follower-remove"));

  await waitFor(() => assert.equal(deletes.length, 1));
  assert.deepEqual(deletes, [`/channels/threads/${THREAD_ID}/followers/agents/${AGENT_ID}`]);
  const entryHiddenAfterRemoval = screen.queryByTestId("thread-followers-card-trigger") === null;
  assert.equal(successToast.mock.calls.length, 1);
  assert.equal(successToast.mock.calls[0]?.arguments[0], `Removed ${LONG_AGENT_NAME} from this thread's followers.`);
  const options = successToast.mock.calls[0]?.arguments[1] as {
    timeout: number;
    dismissible: boolean;
    contentClassName: string;
    action: { label: string; onClick: () => void };
  };
  assert.equal(options.timeout, 5_000);
  assert.equal(options.dismissible, false);
  assert.equal(options.contentClassName, "thread-follower-removal-toast");
  assert.equal(options.action.label, "Undo");

  options.action.onClick();
  await waitFor(() => {
    assert.deepEqual(posts, [{
      url: `/channels/threads/${THREAD_ID}/followers/agents/${AGENT_ID}/restore`,
      body: { undoToken: "2026-08-25T00:00:00.000Z" },
    }]);
    assert.equal(screen.getByTestId("thread-followers-card-trigger").textContent, "1");
    assert.equal(rosterLoads, 2, "successful Undo must re-read the authoritative roster");
  });
  assert.equal(successToast.mock.calls.length, 2);
  assert.equal(successToast.mock.calls[1]?.arguments[0], `Restored ${LONG_AGENT_NAME} as a follower.`);
  assert.equal(
    entryHiddenAfterRemoval,
    true,
    "the entry must disappear instead of presenting a zero-count button",
  );
});

test("managed rosters keep peer-server Agents read-only while local Agents can remove and Undo", async (t) => {
  setupServer();
  const deletes: string[] = [];
  const posts: Array<{ url: string; body: unknown }> = [];
  let rosterLoads = 0;
  api.get = (async () => {
    rosterLoads += 1;
    return { data: { threads: [mixedManagedResponseRow()] } };
  }) as typeof api.get;
  api.delete = (async (url: string) => {
    deletes.push(url);
    return { data: { ok: true, removed: true, undoToken: "2026-08-25T00:00:00.000Z" } };
  }) as typeof api.delete;
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    return { data: { ok: true, restored: true } };
  }) as typeof api.post;
  const successToast = t.mock.method(toast, "success", () => "toast-id");

  renderFollower(THREAD_ID, "header");
  await waitFor(() => assert.equal(screen.getByTestId("thread-followers-header-trigger").textContent, "2"));
  fireEvent.click(screen.getByTestId("thread-followers-header-trigger"));

  assert.ok(await screen.findByText("Local Agent"));
  assert.ok(await screen.findByText("Peer Agent"));
  assert.equal(
    screen.queryByText("Thread Followers Server"),
    null,
    "current-server followers must not repeat the current server name",
  );
  assert.equal(screen.queryByText("Server: Peer East"), null, "peer provenance must use a badge, not a second text row");
  const peerName = screen.getByText("Peer Agent");
  const peerBadge = screen.getByText("Peer East");
  assert.equal(peerBadge.parentElement?.parentElement, peerName.parentElement, "peer server badge must sit beside the Agent name");
  const localRemove = screen.getByRole("button", { name: "Remove Local Agent from followers" });
  const peerRemove = screen.getByRole("button", {
    name: "Peer Agent follows from Peer East. Switch to that server to remove them.",
  }) as HTMLButtonElement;
  assert.equal(peerRemove.disabled, true, "peer-server rows must expose a disabled remove control");

  fireEvent.click(peerRemove);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(deletes, [], "disabled peer-server rows must not send DELETE");

  fireEvent.click(localRemove);
  await waitFor(() => assert.deepEqual(deletes, [`/channels/threads/${THREAD_ID}/followers/agents/${AGENT_ID}`]));
  assert.equal(successToast.mock.calls.length, 1);
  const options = successToast.mock.calls[0]?.arguments[1] as {
    timeout: number;
    dismissible: boolean;
    action: { label: string; onClick: () => void };
  };
  assert.equal(options.timeout, 5_000);
  assert.equal(options.dismissible, false);
  assert.equal(options.action.label, "Undo");

  options.action.onClick();
  await waitFor(() => {
    assert.deepEqual(posts, [{
      url: `/channels/threads/${THREAD_ID}/followers/agents/${AGENT_ID}/restore`,
      body: { undoToken: "2026-08-25T00:00:00.000Z" },
    }]);
    assert.equal(rosterLoads, 2, "successful local Undo must re-read the authoritative roster");
  });
  assert.equal(successToast.mock.calls.length, 2);
});

test("follower removal toast content class removes button chrome from its status icon", () => {
  const styles = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const followerRemovalSelector =
    '.thread-follower-removal-toast [data-slot="toast-icon"]';

  assert.match(styles, new RegExp(`${followerRemovalSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*border-width:\\s*0;`, "s"));
  assert.match(styles, new RegExp(`${followerRemovalSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*background-color:\\s*transparent;`, "s"));
  assert.match(styles, new RegExp(`${followerRemovalSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*box-shadow:\\s*none;`, "s"));
});

test("follower update events refresh an open roster without a new message", async () => {
  setupServer();
  let rosterLoads = 0;
  api.get = (async (url: string, config?: { params?: { threadChannelIds?: string } }) => {
    assert.equal(url, "/channels/threads/followers");
    assert.equal(config?.params?.threadChannelIds, THREAD_ID);
    rosterLoads += 1;
    return {
      data: {
        threads: [{
          threadChannelId: THREAD_ID,
          canManage: true,
          agents: rosterLoads === 1
            ? [
                {
                  id: AGENT_ID,
                  name: "agent-a",
                  displayName: "Agent A",
                  status: "online",
                  avatarUrl: null,
                },
                {
                  id: PEER_AGENT_ID,
                  name: "agent-b",
                  displayName: "Agent B",
                  status: "online",
                  avatarUrl: null,
                },
              ]
            : [
                {
                  id: PEER_AGENT_ID,
                  name: "agent-b",
                  displayName: "Agent B",
                  status: "online",
                  avatarUrl: null,
                },
              ],
        }],
      },
    };
  }) as typeof api.get;
  const { socket, uninstall } = installFollowerUpdateBridge();

  renderFollower(THREAD_ID, "header");
  await waitFor(() => assert.equal(screen.getByTestId("thread-followers-header-trigger").textContent, "2"));
  fireEvent.click(screen.getByTestId("thread-followers-header-trigger"));
  assert.ok(await screen.findByText("Agent A"));
  assert.ok(await screen.findByText("Agent B"));

  socket.emit("thread:followers-updated", { threadChannelId: OTHER_THREAD_ID });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rosterLoads, 1, "updates for another thread must not refresh the open roster");

  socket.emit("thread:followers-updated", { threadChannelId: THREAD_ID });
  await waitFor(() => {
    assert.equal(rosterLoads, 2);
    assert.equal(screen.getByTestId("thread-followers-header-trigger").textContent, "1");
  });
  assert.equal(screen.queryByText("Agent A"), null);
  assert.ok(screen.getByText("Agent B"));

  uninstall();
  socket.emit("thread:followers-updated", { threadChannelId: THREAD_ID });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rosterLoads, 2, "bridge cleanup must remove the follower-update handler it installed");
});
