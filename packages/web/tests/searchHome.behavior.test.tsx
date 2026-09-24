import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { useLayoutEffect } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import api from "../src/api/client";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { DEFAULT_SIDEBAR_ORDER } from "../src/store/events/serverEvents";
import type { Server, ServerMember } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const originalGet = api.get;
let searchEntityUsageStore: typeof import("../src/store/searchEntityUsageStore").useSearchEntityUsageStore | null = null;

function SearchNavigationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/s/server/search")}>
        Reopen search
      </button>
      <textarea aria-label="Outside search composer" />
      <output data-testid="search-location">{location.pathname}{location.search}</output>
    </>
  );
}

function InitialSearchValueProbe({ onValue }: { onValue: (value: string) => void }) {
  useLayoutEffect(() => {
    const input = document.querySelector<HTMLInputElement>('input[placeholder*="Search channels"]');
    onValue(input?.value ?? "");
  }, [onValue]);
  return null;
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
    avatarUrl: null,
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

function makeChannel(): Channel {
  return {
    id: "channel-1",
    serverId: "server-1",
    name: "design",
    description: "Design work",
    type: "channel",
    createdAt: "2026-07-01T00:00:00.000Z",
    joined: false,
  };
}

function makeJointChannel(): Channel {
  return {
    id: "joint-channel-1",
    serverId: "server-1",
    name: "raft-mobile",
    description: "Shared mobile work",
    type: "joint",
    createdAt: "2026-07-01T00:00:00.000Z",
    joined: true,
  };
}

function makePrivateChannel(): Channel {
  return {
    id: "private-channel-1",
    serverId: "server-1",
    name: "private-room",
    description: "Private work",
    type: "private",
    createdAt: "2026-07-01T00:00:00.000Z",
    joined: true,
  };
}

function makePeer(): ServerMember {
  return {
    userId: "user-2",
    email: "peer@example.com",
    gravatarHash: "peerhash",
    name: "design-friend",
    displayName: "Design Friend",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeDmChannel(): Channel {
  return {
    id: "dm-1",
    serverId: "server-1",
    name: "Design Friend",
    description: null,
    type: "dm",
    createdAt: "2026-07-01T00:00:00.000Z",
    peerType: "user",
    peerId: "user-2",
    peerName: "design-friend",
    peerDisplayName: "Design Friend",
    peerDescription: null,
    peerGravatarHash: "peerhash",
    peerAvatarUrl: null,
  };
}

function makeMessageSearchResult(query: string) {
  return {
    id: `message-${query}`,
    channelId: "channel-1",
    threadId: null,
    parentMessageId: null,
    parentMessageContent: null,
    parentChannelId: "channel-1",
    parentChannelName: "design",
    parentChannelType: "channel",
    parentChannelArchivedAt: null,
    senderId: "user-1",
    senderType: "user",
    senderName: "Current User",
    channelName: "design",
    channelType: "channel",
    channelArchivedAt: null,
    content: `${query} release note`,
    snippet: `${query} release note`,
    createdAt: "2026-07-31T08:00:00.000Z",
  };
}

async function renderSearchHome(
  storage: MemoryStorage,
  onInitialSearchValue?: (value: string) => void,
  initialState?: unknown,
) {
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
  });
  storage.setItem("slock_access_token", "token");

  const { default: MessageSearchPage } = await import("../src/components/search/MessageSearchPage");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useMachineStore } = await import("../src/store/machineStore");
  const { useSearchContentStore } = await import("../src/store/searchContentStore");
  const { useSearchEntityUsageStore } = await import("../src/store/searchEntityUsageStore");
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
    members: [makePeer()],
    sidebarOrder: {
      ...DEFAULT_SIDEBAR_ORDER,
      pinned: [{ kind: "channel", id: "channel-1" }],
    },
  });
  useChannelStore.setState({
    channels: [makeChannel(), makePrivateChannel(), makeJointChannel()],
    dmChannels: [makeDmChannel()],
    channelActivity: {
      "channel-1": "2026-07-31T08:00:00.000Z",
      "private-channel-1": "2026-07-31T08:00:00.000Z",
      "joint-channel-1": "2026-07-31T08:00:00.000Z",
    },
  });
  useAgentStore.setState({ agents: [], agentActivities: {} });
  useMachineStore.setState({ machines: [] });
  useSearchContentStore.setState({ slot: null });
  searchEntityUsageStore = useSearchEntityUsageStore;
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
  });

  const renderResult = render(
    <MemoryRouter initialEntries={[{ pathname: "/s/server/search", state: initialState }]}>
      <MessageSearchPage />
      <SearchNavigationProbe />
      {onInitialSearchValue ? <InitialSearchValueProbe onValue={onInitialSearchValue} /> : null}
    </MemoryRouter>,
  );

  return { renderResult, useSearchContentStore, useSearchEntityUsageStore };
}

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");

/**
 * jsdom ships no matchMedia, so the search home reads as desktop by default.
 * This makes the touch viewport an explicit, reversible opt-in per test.
 */
function setTouchViewport() {
  Object.defineProperty(window, "matchMedia", {
    value: ((query: string) => ({
      matches: /max-width:\s*767px/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia,
    configurable: true,
  });
}

afterEach(async () => {
  api.get = originalGet;
  if (originalMatchMedia) {
    Object.defineProperty(window, "matchMedia", originalMatchMedia);
  } else {
    delete (window as { matchMedia?: unknown }).matchMedia;
  }
  cleanup();
  if (searchEntityUsageStore) {
    searchEntityUsageStore.setState({ scopes: {} });
    await searchEntityUsageStore.persist.clearStorage();
  }
});

test("first empty search keeps the previous centered empty state", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  await renderSearchHome(new MemoryStorage());

  assert.ok(screen.getByTestId("search-home"));
  assert.ok(screen.getByText("Search everything"));
  assert.ok(screen.getByText("Search channels, DMs, people, agents, and message history."));
  assert.equal(screen.queryByText("Search History"), null);
  assert.equal(screen.queryByText("Your recent searches will appear here."), null);
  assert.equal(screen.queryByText("Frequently Used"), null);
  assert.equal(screen.queryByTestId("search-common-channel:channel-1"), null);
});

test("empty search shows local history and common channels as actionable sections", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  const storage = new MemoryStorage();
  storage.setItem("raft:search-history:server-1:user-1", JSON.stringify(["roadmap"]));
  storage.setItem("raft:search-entity-usage:server-1:user-1", JSON.stringify({
    "channel:channel-1": [Date.now()],
    "channel:private-channel-1": [Date.now() - 1],
    "channel:joint-channel-1": [Date.now() - 2],
  }));
  const { useSearchContentStore, useSearchEntityUsageStore } = await renderSearchHome(storage);

  assert.ok(screen.getByTestId("search-home"));
  assert.ok(screen.getByText("Search History"));
  assert.ok(screen.getByText("Frequently Used"));
  assert.ok(screen.getByText("roadmap"));
  assert.ok(screen.getByTestId("search-common-channel:channel-1"));
  assert.ok(screen.getByTestId("search-common-channel:channel-1").querySelector(".lucide-hash"));
  assert.ok(screen.getByTestId("search-common-channel:private-channel-1").querySelector(".lucide-lock"));
  assert.ok(screen.getByTestId("search-common-channel:joint-channel-1").querySelector(".lucide-git-branch"));
  assert.equal(screen.queryByText("Search everything"), null);

  fireEvent.click(screen.getByTestId("search-common-channel:channel-1"));
  await waitFor(() => {
    assert.deepEqual(useSearchContentStore.getState().slot, {
      kind: "channel",
      id: "channel-1",
    });
  });
  const usage = useSearchEntityUsageStore.getState().scopes["server-1:user-1"]?.usage ?? {};
  assert.equal(usage["channel:channel-1"].length, 2);
  assert.equal(typeof usage["channel:channel-1"][0], "number");

  fireEvent.click(screen.getByText("roadmap"));
  assert.equal((screen.getByPlaceholderText(/Search channels/) as HTMLInputElement).value, "roadmap");
});

test("search results distinguish public, private, and joint channel icons", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  await renderSearchHome(new MemoryStorage());
  const input = screen.getByPlaceholderText(/Search channels/) as HTMLInputElement;

  fireEvent.change(input, { target: { value: "design" } });
  const regularResult = await screen.findByTestId("search-channel-result-channel-1");
  assert.ok(regularResult.querySelector(".lucide-hash"));
  assert.equal(regularResult.querySelector(".lucide-lock"), null);
  assert.equal(regularResult.querySelector(".lucide-git-branch"), null);

  fireEvent.change(input, { target: { value: "private-room" } });
  const privateResult = await screen.findByTestId("search-channel-result-private-channel-1");
  assert.ok(privateResult.querySelector(".lucide-lock"));
  assert.equal(privateResult.querySelector(".lucide-hash"), null);
  assert.equal(privateResult.querySelector(".lucide-git-branch"), null);

  fireEvent.change(input, { target: { value: "raft-mobile" } });
  const jointResult = await screen.findByTestId("search-channel-result-joint-channel-1");
  assert.ok(jointResult.querySelector(".lucide-git-branch"));
  assert.equal(jointResult.querySelector(".lucide-hash"), null);
  assert.equal(jointResult.querySelector(".lucide-lock"), null);
});

test("search history renders the 15 most recent queries as wrapping tags", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  const storage = new MemoryStorage();
  storage.setItem(
    "raft:search-history:server-1:user-1",
    JSON.stringify(Array.from({ length: 18 }, (_, index) => `query ${index + 1}`)),
  );
  await renderSearchHome(storage);

  const tags = screen.getAllByTestId("search-history-tag");
  assert.equal(tags.length, 15);
  assert.ok(screen.getByText("query 1"));
  assert.ok(screen.getByText("query 15"));
  assert.equal(screen.queryByText("query 16"), null);
  assert.equal(screen.getByTestId("search-history-tags").classList.contains("flex-wrap"), true);

  const firstTag = tags[0];
  const firstRemove = screen.getByLabelText('Remove "query 1" from search history');
  assert.equal(firstTag.classList.contains("group"), true);
  assert.equal(firstTag.classList.contains("hover:bg-black/[0.03]"), true);
  assert.equal(firstRemove.classList.contains("opacity-0"), true);
  assert.equal(firstRemove.classList.contains("group-hover:opacity-100"), true);
  assert.equal(firstRemove.classList.contains("size-5"), true);
  assert.equal(firstRemove.classList.contains("hover:bg-black/10"), true);
  assert.equal(firstRemove.classList.contains("hover:text-black/70"), true);
});

test("desktop search history keeps hover removal and shows no edit toggle", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  const storage = new MemoryStorage();
  storage.setItem("raft:search-history:server-1:user-1", JSON.stringify(["roadmap"]));
  await renderSearchHome(storage);

  assert.equal(screen.queryByTestId("search-history-edit-toggle"), null);
  const remove = screen.getByLabelText('Remove "roadmap" from search history');
  assert.equal(remove.classList.contains("opacity-0"), true);
  assert.equal(remove.classList.contains("group-hover:opacity-100"), true);
});

test("touch search history hides removal until edit mode is entered", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  setTouchViewport();
  const storage = new MemoryStorage();
  storage.setItem("raft:search-history:server-1:user-1", JSON.stringify(["roadmap", "changelog"]));
  await renderSearchHome(storage);

  // Default touch state: the tag is still tappable to search, but carries no
  // remove control at all — not a hidden one.
  assert.equal(screen.queryByLabelText('Remove "roadmap" from search history'), null);
  assert.equal(screen.queryByLabelText('Remove "changelog" from search history'), null);
  // queryBy, not getBy: a missing node here must report as a one-line failure
  // rather than a full DOM dump, so a mutation run stays readable.
  const toggle = screen.queryByTestId("search-history-edit-toggle");
  assert.ok(toggle, "touch search home must offer an edit toggle");
  assert.equal(toggle.textContent, "Edit");
  assert.ok(screen.getByText("Clear"));

  fireEvent.click(toggle);

  assert.equal(screen.queryByTestId("search-history-edit-toggle")?.textContent, "Done");
  const remove = screen.queryByLabelText('Remove "roadmap" from search history');
  assert.ok(remove, "edit mode must expose a remove control");
  // Visible without hover: no opacity-0 / group-hover reveal on touch.
  assert.equal(remove.classList.contains("opacity-0"), false);
  assert.equal(remove.classList.contains("group-hover:opacity-100"), false);
  assert.ok(screen.queryByLabelText('Remove "changelog" from search history'));
  assert.ok(screen.getByText("Clear"));

  fireEvent.click(remove);
  await waitFor(() => {
    assert.equal(screen.queryByText("roadmap"), null);
  });
  // Still editing after one removal, so the next item can be removed too.
  assert.equal(screen.queryByTestId("search-history-edit-toggle")?.textContent, "Done");
  assert.ok(screen.queryByLabelText('Remove "changelog" from search history'));

  const doneToggle = screen.queryByTestId("search-history-edit-toggle");
  assert.ok(doneToggle, "edit toggle must stay mounted while editing");
  fireEvent.click(doneToggle);
  assert.equal(screen.queryByTestId("search-history-edit-toggle")?.textContent, "Edit");
  assert.equal(screen.queryByLabelText('Remove "changelog" from search history'), null);
});

test("touch edit mode does not survive history returning after it empties", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  setTouchViewport();
  const storage = new MemoryStorage();
  storage.setItem("raft:search-history:server-1:user-1", JSON.stringify(["roadmap"]));
  await renderSearchHome(storage);

  const editToggle = screen.queryByTestId("search-history-edit-toggle");
  assert.ok(editToggle, "touch search home must offer an edit toggle");
  fireEvent.click(editToggle);
  const removeRoadmap = screen.queryByLabelText('Remove "roadmap" from search history');
  assert.ok(removeRoadmap, "edit mode must expose a remove control");
  fireEvent.click(removeRoadmap);
  await waitFor(() => {
    assert.equal(screen.queryByText("Search History"), null);
  });

  // Same mount, no remount: run a search so history repopulates, then return to
  // the home surface. Edit mode is derived from the live list, so it must be
  // back at rest — not still armed from before the list emptied.
  const input = screen.getByPlaceholderText(/Search channels/) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "design" } });
  const channelResult = await screen.findByTestId("search-channel-result-channel-1");
  const channelButton = channelResult.querySelector("button");
  assert.ok(channelButton);
  fireEvent.click(channelButton);
  await waitFor(() => {
    assert.equal(
      storage.getItem("raft:search-history:server-1:user-1"),
      JSON.stringify(["design"]),
    );
  });
  fireEvent.change(input, { target: { value: "" } });

  await waitFor(() => {
    assert.ok(screen.queryByTestId("search-history-edit-toggle"));
  });
  assert.equal(screen.queryByTestId("search-history-edit-toggle")?.textContent, "Edit");
  assert.equal(screen.queryByLabelText('Remove "design" from search history'), null);
});

test("typing search prefixes does not persist history until a result is opened", async () => {
  const searchedQueries: string[] = [];
  api.get = (async (_url: string, config?: { params?: Record<string, unknown> }) => {
    const q = typeof config?.params?.q === "string" ? config.params.q : "";
    searchedQueries.push(q);
    return {
      data: {
        hasMore: false,
        results: q ? [makeMessageSearchResult(q)] : [],
      },
    };
  }) as typeof api.get;
  const storage = new MemoryStorage();
  await renderSearchHome(storage);
  const input = screen.getByPlaceholderText(/Search channels/) as HTMLInputElement;

  for (const query of ["i", "i1", "i18", "i18n"]) {
    fireEvent.change(input, { target: { value: query } });
    await waitFor(() => {
      assert.ok(searchedQueries.includes(query));
    });
    assert.equal(storage.getItem("raft:search-history:server-1:user-1"), null);
  }

  let resultButton: HTMLButtonElement | undefined;
  await waitFor(() => {
    resultButton = Array.from(document.querySelectorAll("button"))
      .find((button): button is HTMLButtonElement => button.textContent?.includes("i18n release note") ?? false);
    assert.ok(resultButton);
  });
  fireEvent.click(resultButton);

  await waitFor(() => {
    assert.equal(
      storage.getItem("raft:search-history:server-1:user-1"),
      JSON.stringify(["i18n"]),
    );
  });
});

test("initial search failure renders an error card with a working retry", async () => {
  let attempts = 0;
  let allowSuccess = false;
  api.get = (async (url: string) => {
    if (url !== "/messages/search") {
      return { data: { hasMore: false, results: [] } };
    }
    attempts += 1;
    if (!allowSuccess) {
      throw new Error("search failed");
    }
    return {
      data: {
        hasMore: false,
        results: [makeMessageSearchResult("recovered")],
      },
    };
  }) as typeof api.get;

  await renderSearchHome(new MemoryStorage());
  const input = screen.getByPlaceholderText(/Search channels/) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "recovered" } });

  const errorHeading = await screen.findByText("Search failed");
  assert.ok(errorHeading);
  assert.equal(screen.queryByText("No results found"), null, "failure must not render as an empty result set");

  const failedAttempts = attempts;
  allowSuccess = true;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => {
    assert.match(document.body.textContent ?? "", /recovered release note/);
    assert.equal(screen.queryByText("Search failed"), null);
  });
  assert.equal(attempts, failedAttempts + 1, "Retry must issue exactly one fresh request");
});

test("QUERY_TOO_BROAD renders actionable rejection instead of an empty result set", async () => {
  api.get = (async (url: string) => {
    if (url !== "/messages/search") {
      return { data: { hasMore: false, results: [] } };
    }
    throw {
      response: {
        status: 422,
        data: {
          code: "QUERY_TOO_BROAD",
          error: "Search query is too broad",
        },
      },
    };
  }) as typeof api.get;

  await renderSearchHome(new MemoryStorage());
  const input = screen.getByPlaceholderText(/Search channels/) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "the" } });

  assert.ok(await screen.findByText("Search is too broad"));
  assert.match(document.body.textContent ?? "", /Add a channel, sender, or time filter, or switch the sort to Recent/);
  assert.equal(screen.queryByText("No results found"), null, "typed rejection must not render as an empty result set");
  assert.equal(screen.queryByRole("button", { name: "Retry" }), null, "retrying the same rejected query is not actionable");
});

test("SEARCH_TIMEOUT renders a typed timeout state with guidance and retry instead of an empty result set", async () => {
  api.get = (async (url: string) => {
    if (url !== "/messages/search") {
      return { data: { hasMore: false, results: [] } };
    }
    throw {
      response: {
        status: 503,
        data: {
          code: "SEARCH_TIMEOUT",
          error: "Search timed out",
        },
      },
    };
  }) as typeof api.get;

  await renderSearchHome(new MemoryStorage());
  const input = screen.getByPlaceholderText(/Search channels/) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "underestimated" } });

  assert.ok(await screen.findByText("Search timed out"));
  assert.match(document.body.textContent ?? "", /Add a channel, sender, or time filter, switch the sort to Recent, or retry/);
  assert.equal(screen.queryByText("No results found"), null, "timeout must not render as an empty result set");
  assert.ok(screen.getByRole("button", { name: "Retry" }));
});

test("pagination failure keeps results and offers an inline retry", async () => {
  let loadMoreAttempts = 0;
  const loadMoreOffsets: number[] = [];
  api.get = (async (_url: string, config?: { params?: Record<string, unknown> }) => {
    const offset = typeof config?.params?.offset === "number" ? config.params.offset : 0;
    if (offset === 0) {
      return {
        data: {
          hasMore: true,
          results: [makeMessageSearchResult("pagination")],
        },
      };
    }

    loadMoreAttempts += 1;
    loadMoreOffsets.push(offset);
    if (loadMoreAttempts === 1) {
      throw new Error("page failed");
    }
    return {
      data: {
        hasMore: true,
        results: [makeMessageSearchResult("pagination-next")],
      },
    };
  }) as typeof api.get;

  await renderSearchHome(new MemoryStorage());
  const input = screen.getByPlaceholderText(/Search channels/) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "pagination" } });

  const loadMoreButton = await screen.findByRole("button", { name: "Load More" });
  assert.match(document.body.textContent ?? "", /pagination release note/);
  fireEvent.click(loadMoreButton);

  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /Could not load more results/);
  assert.match(document.body.textContent ?? "", /pagination release note/, "the successful page must remain visible");

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => {
    assert.match(document.body.textContent ?? "", /pagination-next release note/);
    assert.equal(screen.queryByRole("alert"), null);
    assert.ok(screen.getByRole("button", { name: "Load More" }), "successful retry must restore hasMore from the response");
  });
  assert.equal(loadMoreAttempts, 2);
  assert.deepEqual(loadMoreOffsets, [1, 1], "retry must request the same failed page offset");
  assert.equal((document.body.textContent ?? "").match(/pagination release note/g)?.length, 1, "retry must not duplicate the loaded page");
  assert.equal((document.body.textContent ?? "").match(/pagination-next release note/g)?.length, 1);
});

test("pinned channels do not populate Frequently Used without a Search open", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  const storage = new MemoryStorage();
  storage.setItem("raft:search-history:server-1:user-1", JSON.stringify(["roadmap"]));
  await renderSearchHome(storage);

  assert.ok(screen.getByText("Frequently Used"));
  assert.ok(screen.getByText("Channels and contacts you open from Search will appear here."));
  assert.equal(screen.queryByTestId("search-common-channel:channel-1"), null);
});

test("rapid channel and DM opens both survive a persisted-store reload", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  const storage = new MemoryStorage();
  const { renderResult, useSearchEntityUsageStore } = await renderSearchHome(storage);
  const input = screen.getByPlaceholderText(/Search channels/) as HTMLInputElement;

  fireEvent.change(input, { target: { value: "design" } });
  const channelResult = await screen.findByTestId("search-channel-result-channel-1");
  const channelButton = channelResult.querySelector("button");
  const dmButton = (await screen.findByText("Design Friend")).closest("button");
  assert.ok(channelButton);
  assert.ok(dmButton);

  fireEvent.click(channelButton, { detail: 1 });
  fireEvent.click(dmButton, { detail: 1 });

  await waitFor(() => {
    const usage = useSearchEntityUsageStore.getState().scopes["server-1:user-1"]?.usage ?? {};
    assert.equal(usage["channel:channel-1"]?.length, 1);
    assert.equal(usage["human:user-2"]?.length, 1);
  });
  const persistedStore = storage.getItem("raft:search-entity-usage-store:v1");
  assert.ok(persistedStore);

  renderResult.unmount();
  storage.removeItem("raft:search-history:server-1:user-1");
  storage.removeItem("raft:search-state:server-1:user-1");
  useSearchEntityUsageStore.setState({ scopes: {} });
  storage.setItem("raft:search-entity-usage-store:v1", persistedStore);
  await useSearchEntityUsageStore.persist.rehydrate();
  await renderSearchHome(storage);

  assert.ok(await screen.findByTestId("search-common-channel:channel-1"));
  assert.ok(screen.getByTestId("search-common-human:user-2"));
  assert.equal(screen.queryByText("Search everything"), null);
});

test("an empty search URL restores and selects the last query once, with filters and sort", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  const storage = new MemoryStorage();
  storage.setItem("raft:search-state:server-1:user-1", JSON.stringify({
    q: "roadmap",
    scopes: ["humans"],
    range: "7d",
    sort: "recent",
  }));
  const initialSearchValues: string[] = [];
  await renderSearchHome(storage, (value) => initialSearchValues.push(value));
  assert.deepEqual(initialSearchValues, ["roadmap"]);

  const input = screen.getByPlaceholderText(/Search channels/) as HTMLInputElement;
  await waitFor(() => {
    assert.equal(input.value, "roadmap");
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, input.value.length);
  });
  fireEvent.change(input, { target: { value: "roadmaps" } });
  await waitFor(() => {
    assert.equal(input.value, "roadmaps");
    assert.equal(input.selectionStart, input.value.length);
    assert.equal(input.selectionEnd, input.value.length);
  });
  assert.ok(screen.getByText("Scope 1"));
  assert.ok(screen.getByText("Last 7 Days"));
  assert.ok(screen.getByText("Recent"));
});

test("rail-open empty Search does not restore a stale persisted query before Escape", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  const storage = new MemoryStorage();
  storage.setItem("raft:search-state:server-1:user-1", JSON.stringify({
    q: "roadmap",
    scopes: ["humans"],
  }));
  const initialSearchValues: string[] = [];
  await renderSearchHome(storage, (value) => initialSearchValues.push(value), { searchEntry: "rail" });

  const input = screen.getByPlaceholderText(/Search channels/) as HTMLInputElement;
  await waitFor(() => {
    assert.equal(input.value, "");
  });
  assert.deepEqual(initialSearchValues, [""]);

  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() => {
    assert.equal(screen.getByTestId("search-location").textContent, "/s/server");
  });
});

test("search Escape navigation is scoped to the mounted search rail", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  await renderSearchHome(new MemoryStorage());

  const searchInput = screen.getByPlaceholderText(/Search channels/);
  fireEvent.change(searchInput, { target: { value: "roadmap" } });
  assert.equal((searchInput as HTMLInputElement).value, "roadmap");
  fireEvent.keyDown(searchInput, { key: "Escape" });
  await waitFor(() => {
    assert.equal(screen.getByTestId("search-location").textContent, "/s/server");
  });

  fireEvent.click(screen.getByRole("button", { name: "Reopen search" }));
  await waitFor(() => {
    assert.equal(screen.getByTestId("search-location").textContent, "/s/server/search");
  });

  const outsideComposer = screen.getByRole("textbox", { name: "Outside search composer" });
  outsideComposer.focus();
  fireEvent.keyDown(outsideComposer, { key: "Escape" });
  assert.equal(screen.getByTestId("search-location").textContent, "/s/server/search");
});

test("reopening an already-mounted search restores state while a user clear stays clear", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
  });
  storage.setItem("slock_access_token", "token");

  const { default: MessageSearchPage } = await import("../src/components/search/MessageSearchPage");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useServerStore } = await import("../src/store/serverStore");
  useAuthStore.setState({
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  });
  useServerStore.setState({ current: makeServer(), members: [] });

  render(
    <MemoryRouter initialEntries={["/s/server/search?q=roadmap&scope=humans"]}>
      <MessageSearchPage />
      <SearchNavigationProbe />
    </MemoryRouter>,
  );
  await waitFor(() => {
    assert.equal(
      storage.getItem("raft:search-state:server-1:user-1"),
      JSON.stringify({ q: "roadmap", scopes: ["humans"] }),
    );
  });

  const input = screen.getByPlaceholderText(/Search channels/) as HTMLInputElement;
  await waitFor(() => {
    assert.equal(input.value, "roadmap");
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, input.value.length);
  });

  fireEvent.click(screen.getByRole("button", { name: "Reopen search" }));
  await waitFor(() => {
    const params = new URLSearchParams(
      screen.getByTestId("search-location").textContent?.split("?")[1] ?? "",
    );
    assert.equal(params.get("q"), "roadmap");
    assert.deepEqual(params.getAll("scope"), ["humans"]);
  });

  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  await waitFor(() => {
    assert.equal(screen.getByTestId("search-location").textContent, "/s/server/search?scope=humans");
    assert.equal((screen.getByPlaceholderText(/Search channels/) as HTMLInputElement).value, "");
  });
});
