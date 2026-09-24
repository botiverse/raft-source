import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import api from "../src/api/client";
import { NavigationDepthTracker } from "../src/hooks/useAppNavigate";
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
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

const originalGet = api.get;

interface SearchTestWorkerRequest {
  requestId: number;
  query: string;
  entries?: Array<{ index: number; fields: Array<{ raw: string }> }>;
}

class SearchTestWorker {
  static requests: Array<{ worker: SearchTestWorker; payload: SearchTestWorkerRequest }> = [];

  private readonly listeners = new Set<(event: MessageEvent) => void>();

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(payload: SearchTestWorkerRequest) {
    SearchTestWorker.requests.push({ worker: this, payload });
  }

  respondWithQueryMatches() {
    const payload = SearchTestWorker.requests.findLast((request) => request.worker === this)?.payload;
    if (!payload) throw new Error("No worker request to respond to");
    const query = payload.query.trim().replace(/^[@#]/, "").toLowerCase();
    const indexes = (payload.entries ?? [])
      .filter((entry) => entry.fields.some((field) => field.raw.toLowerCase().includes(query)))
      .map((entry) => entry.index);
    const event = {
      data: { type: "ranked", requestId: payload.requestId, indexes },
    } as MessageEvent;
    for (const listener of this.listeners) listener(event);
  }

  terminate() {}
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function installBrowserStubs() {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
  });
}

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
    role: "owner",
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeChannel(id = "channel-1"): Channel {
  return {
    id,
    serverId: "server-1",
    name: "design",
    description: null,
    type: "channel",
    createdAt: "2026-07-01T00:00:00.000Z",
    archivedAt: null,
    joined: true,
  };
}

function makeAgent(id: string, name: string, displayName: string | null = null): Agent {
  return {
    id,
    serverId: "server-1",
    serverName: "Server",
    serverSlug: "server",
    name,
    displayName,
    avatarUrl: null,
    description: null,
    status: "active",
    model: "gpt-5",
    runtime: "codex",
    external: false,
    serverRole: null,
    runtimeConfig: null,
    lastRuntimeError: null,
    reasoningEffort: null,
    executionMode: "cloud",
    envVars: null,
    machineId: null,
    sessionId: null,
    runtimeProfile: null,
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeManyAgents(): Agent[] {
  return [
    makeAgent("agent-cody", "cody", "Cody"),
    ...Array.from({ length: 205 }, (_, i) => makeAgent(`agent-${i}`, `zulu-agent-${i.toString().padStart(3, "0")}`, `Zulu Agent ${i.toString().padStart(3, "0")}`)),
  ];
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function ChannelSearchEntry() {
  const navigate = useNavigate();
  return (
    <>
      <LocationProbe />
      <button
        type="button"
        onClick={() => navigate("/s/server/search?channelId=channel-1&defer=1")}
      >
        Open channel search
      </button>
    </>
  );
}

async function prepareSearchPage(options: { agents?: Agent[] } = {}) {
  installBrowserStubs();
  localStorage.setItem("slock_access_token", "token");
  localStorage.removeItem("raft:search-state:server-1:user-1");
  const { default: MessageSearchPage } = await import("../src/components/search/MessageSearchPage");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useSearchContentStore } = await import("../src/store/searchContentStore");
  const { useServerStore } = await import("../src/store/serverStore");
  const { useThreadStore } = await import("../src/store/threadStore");

  useAuthStore.setState({
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  });
  useServerStore.setState({
    current: makeServer(),
    members: [] as ServerMember[],
  });
  useChannelStore.setState({
    channels: [makeChannel("channel-1"), makeChannel("channel-2")] as Channel[],
    dmChannels: [] as Channel[],
  });
  useAgentStore.setState({
    agents: options.agents ?? [] as Agent[],
    agentActivities: {},
  });
  useSearchContentStore.setState({ slot: null });
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
  });
  return MessageSearchPage;
}

async function renderSearchPage(initialEntry: string | string[], options: { agents?: Agent[] } = {}) {
  const MessageSearchPage = await prepareSearchPage(options);
  const initialEntries = Array.isArray(initialEntry) ? initialEntry : [initialEntry];
  return render(
    <MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.length - 1}>
      <NavigationDepthTracker />
      <MessageSearchPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

async function renderChannelSearchJourney() {
  const MessageSearchPage = await prepareSearchPage();
  return render(
    <MemoryRouter initialEntries={["/s/server/channel/channel-1"]}>
      <NavigationDepthTracker />
      <Routes>
        <Route path="/s/server/channel/:channelId" element={<ChannelSearchEntry />} />
        <Route
          path="/s/server/search"
          element={(
            <>
              <MessageSearchPage />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  api.get = originalGet;
  cleanup();
});

test("Search keeps entity results visible while same-query worker reranks after agent refresh", async () => {
  const holder = globalThis as { Worker?: unknown };
  const originalWorker = holder.Worker;
  SearchTestWorker.requests = [];
  holder.Worker = SearchTestWorker as unknown as typeof Worker;
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  try {
    const agents = makeManyAgents();
    await renderSearchPage("/s/server/search?q=Cody", { agents });
    await waitFor(() => {
      assert.equal(SearchTestWorker.requests.length, 1);
    });
    act(() => {
      SearchTestWorker.requests[0]?.worker.respondWithQueryMatches();
    });
    assert.ok(screen.getByRole("button", { name: /Cody/i }));

    const { useAgentStore } = await import("../src/store/agentStore");
    act(() => {
      useAgentStore.setState({
        agents: [
          makeAgent("agent-aaron", "aaron", "Aaron"),
          ...agents.map((agent) => agent.id === "agent-cody" ? { ...agent, status: "stopped" } : { ...agent }),
        ],
      });
    });
    await waitFor(() => {
      assert.equal(SearchTestWorker.requests.length, 2);
    });
    assert.ok(
      screen.getByRole("button", { name: /Cody/i }),
      "Search should keep the current entity card mounted while the unchanged query is reranked after refreshed agent state inserts a new earlier entity",
    );
    assert.equal(
      screen.queryByRole("button", { name: /Aaron/i }),
      null,
      "Search must not reinterpret the retained worker index through the refreshed entries while the rerank is still pending",
    );

    act(() => {
      SearchTestWorker.requests[1]?.worker.respondWithQueryMatches();
    });
    assert.ok(screen.getByRole("button", { name: /Cody/i }));
  } finally {
    if (originalWorker === undefined) delete holder.Worker;
    else holder.Worker = originalWorker;
  }
});

test("Search keeps the keyboard-selected result when the same query reranks", async () => {
  const holder = globalThis as { Worker?: unknown };
  const originalWorker = holder.Worker;
  SearchTestWorker.requests = [];
  holder.Worker = SearchTestWorker as unknown as typeof Worker;
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  try {
    const agents = makeManyAgents();
    await renderSearchPage("/s/server/search?q=Zulu", { agents });
    await waitFor(() => {
      assert.equal(SearchTestWorker.requests.length, 1);
    });
    act(() => {
      SearchTestWorker.requests[0]?.worker.respondWithQueryMatches();
    });

    const searchInput = screen.getByRole("textbox");
    assert.ok(screen.getByRole("button", { name: /Zulu Agent 000/i }));
    assert.ok(screen.getByRole("button", { name: /Zulu Agent 001/i }));
    fireEvent.keyDown(searchInput, { key: "ArrowDown" });

    const { useAgentStore } = await import("../src/store/agentStore");
    act(() => {
      useAgentStore.setState({
        agents: [makeAgent("agent-new", "zulu-agent-new", "Zulu Agent -1"), ...agents],
      });
    });
    await waitFor(() => {
      assert.equal(SearchTestWorker.requests.length, 2);
    });
    act(() => {
      SearchTestWorker.requests[1]?.worker.respondWithQueryMatches();
    });

    fireEvent.keyDown(searchInput, { key: "Enter" });
    const { useSearchContentStore } = await import("../src/store/searchContentStore");
    await waitFor(() => {
      assert.deepEqual(useSearchContentStore.getState().slot, {
        kind: "agent",
        id: "agent-1",
      });
    });
  } finally {
    if (originalWorker === undefined) delete holder.Worker;
    else holder.Worker = originalWorker;
  }
});

test("Search keeps the nearest survivor selected through a later insertion after the selected result disappears", async () => {
  let resolveSearch!: (value: { data: { hasMore: false; results: [] } }) => void;
  const searchResponse = new Promise<{ data: { hasMore: false; results: [] } }>((resolve) => {
    resolveSearch = resolve;
  });
  api.get = (async () => searchResponse) as typeof api.get;
  const agents = [
    makeAgent("agent-alpha", "test-alpha", "Test Alpha"),
    makeAgent("agent-beta", "test-beta", "Test Beta"),
    makeAgent("agent-gamma", "test-gamma", "Test Gamma"),
  ];
  await renderSearchPage("/s/server/search?q=Test", { agents });
  await screen.findByText("Searching…");
  await act(async () => {
    resolveSearch({ data: { hasMore: false, results: [] } });
    await searchResponse;
  });
  await screen.findByText("3 results");

  const searchInput = screen.getByRole("textbox");
  fireEvent.keyDown(searchInput, { key: "ArrowDown" });

  const { useAgentStore } = await import("../src/store/agentStore");
  act(() => {
    useAgentStore.setState({ agents: agents.filter((agent) => agent.id !== "agent-alpha") });
  });
  await waitFor(() => {
    assert.equal(screen.queryByRole("button", { name: /Test Alpha/i }), null);
    assert.ok(screen.getByRole("button", { name: /Test Gamma/i }));
  });

  act(() => {
    useAgentStore.setState({
      agents: [
        makeAgent("agent-before", "test-before", "Test -1"),
        ...agents.filter((agent) => agent.id !== "agent-alpha"),
      ],
    });
  });
  await waitFor(() => {
    assert.ok(screen.getByRole("button", { name: /Test -1/i }));
  });

  fireEvent.keyDown(searchInput, { key: "Enter" });
  const { useSearchContentStore } = await import("../src/store/searchContentStore");
  await waitFor(() => {
    assert.deepEqual(useSearchContentStore.getState().slot, {
      kind: "agent",
      id: "agent-gamma",
    });
  });
});

test("deferred channel search handoff waits for typed query before requesting messages", async () => {
  const calls: Array<{ url: string; params: Record<string, unknown> }> = [];
  api.get = (async (url: string, config?: { params?: Record<string, unknown> }) => {
    calls.push({ url, params: config?.params ?? {} });
    return { data: { hasMore: false, results: [] } };
  }) as typeof api.get;

  await renderSearchPage("/s/server/search?channelId=channel-1&defer=1");

  await delay(260);
  assert.equal(calls.length, 0, "deferred channel handoff should not search while q is empty");

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "roadmap" } });

  await waitFor(() => {
    assert.equal(calls.length, 1);
  });
  assert.equal(calls[0]?.url, "/messages/search");
  assert.equal(calls[0]?.params.q, "roadmap");
  assert.equal(calls[0]?.params.channelId, "channel-1");
});

test("non-deferred filter-only search still requests messages", async () => {
  const calls: Array<{ url: string; params: Record<string, unknown> }> = [];
  api.get = (async (url: string, config?: { params?: Record<string, unknown> }) => {
    calls.push({ url, params: config?.params ?? {} });
    return { data: { hasMore: false, results: [] } };
  }) as typeof api.get;

  await renderSearchPage("/s/server/search?channelId=channel-2");

  await waitFor(() => {
    assert.equal(calls.length, 1);
  });
  assert.equal(calls[0]?.url, "/messages/search");
  assert.equal(calls[0]?.params.q, "");
  assert.equal(calls[0]?.params.channelId, "channel-2");
});

test("direct empty Search returns to the current server root on Escape", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;

  await renderSearchPage(["/s/server/channel/channel-1", "/s/server/search"]);

  assert.equal(screen.getByTestId("location").textContent, "/s/server/search");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  assert.equal(screen.getByTestId("location").textContent, "/s/server");
});

test("empty deferred channel Search returns to its channel on Escape", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;

  await renderChannelSearchJourney();
  fireEvent.click(screen.getByRole("button", { name: "Open channel search" }));
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/server/search?channelId=channel-1&defer=1",
    );
  });

  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/server/channel/channel-1",
    );
  });
});

test("empty Search opened by the global shortcut returns to its exact source route on Escape", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  const MessageSearchPage = await prepareSearchPage();
  const sourcePath = "/s/server/channel/channel-1?msg=message-1";

  render(
    <MemoryRouter
      initialEntries={[
        sourcePath,
        {
          pathname: "/s/server/search",
          state: { searchFrom: sourcePath },
        },
      ]}
      initialIndex={1}
    >
      <NavigationDepthTracker />
      <Routes>
        <Route path="/s/server/channel/:channelId" element={<LocationProbe />} />
        <Route
          path="/s/server/search"
          element={(
            <>
              <MessageSearchPage />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );

  assert.equal(screen.getByTestId("location").textContent, "/s/server/search");
  const searchInput = screen.getByRole("textbox");
  fireEvent.change(searchInput, { target: { value: "roadmap" } });
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/server/search?q=roadmap");
  });
  fireEvent.change(searchInput, { target: { value: "" } });
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/server/search");
  });

  fireEvent.keyDown(searchInput, { key: "Escape" });
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, sourcePath);
  });
});

test("empty non-deferred channel filter Search returns to the current server root", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;

  await renderSearchPage([
    "/s/server/channel/channel-1",
    "/s/server/search?channelId=channel-2",
  ]);

  assert.equal(
    screen.getByTestId("location").textContent,
    "/s/server/search?channelId=channel-2",
  );
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  assert.equal(screen.getByTestId("location").textContent, "/s/server");
});

test("non-empty Search keeps the existing Escape back behavior", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;

  await renderSearchPage(["/s/server/channel/channel-1", "/s/server/search?q=roadmap"]);

  assert.equal(screen.getByTestId("location").textContent, "/s/server/search?q=roadmap");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  assert.equal(screen.getByTestId("location").textContent, "/s/server");
});
