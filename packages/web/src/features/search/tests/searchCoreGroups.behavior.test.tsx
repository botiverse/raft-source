// Web search draws core's channels and people groups (docs/contracts/web-search.md):
// the local rows paint at once, the server's answer replaces them (order and
// status), offline or a failed request keeps them with a note (Retry for a
// failure); both groups are asked whatever the app flags (useAppSearchEnabled
// gates the app groups only); rows show one mark of the server's status and
// say "Not joined" (Join is the channel preview's); a group pages on with its
// cursor (Load more, a failed page inline with Retry); an Artifact whose home
// is archived says so.
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ChannelSearchHit, PersonSearchHit } from "@botiverse/raft-shared";
import api from "../../../api/client";
import { ArtifactSearchHit } from "../../../apps/artifacts";
import { useChannelStore } from "../../../store/channelStore";
import type { Channel } from "../../../store/channelStore";
import { useServerStore } from "../../../store/serverStore";
import { TestIntlProvider, renderWithIntl } from "../../../../tests/helpers/intl";
import { EntityResultRow } from "../EntityResultRow";
import { channelHitToEntity, personHitToEntity } from "../searchEntities";
import { SearchEntityResultsIncompleteNote, SearchEntityResultsSection } from "../SearchEntityResultsSection";
import { useSearchAppResults } from "../useSearchAppResults";
import { useSearchEntityResults } from "../useSearchEntityResults";

type Params = { q?: string; app?: string; cursor?: string; limit?: number };
type Handler = (params: Params, signal: AbortSignal | undefined) => Promise<unknown>;

const calls: Params[] = [];
let answer: Handler = async () => ({ groups: [] });

function channelHit(id: string, overrides: Partial<ChannelSearchHit> = {}): ChannelSearchHit {
  return { id, name: id, description: null, type: "channel", archived: false, joined: true, external: false, guest: false, canPost: true, requiredAction: null, ...overrides };
}
function personHit(id: string, overrides: Partial<PersonSearchHit> = {}): PersonSearchHit {
  return { kind: "human", id, name: id, displayName: null, avatarUrl: null, role: "member", guest: false, dmChannelId: null, canPost: false, requiredAction: "create_dm", ...overrides };
}
function localChannel(id: string, name: string): Channel {
  return { id, name, description: null, type: "channel", createdAt: "2026-11-01T00:00:00.000Z", archivedAt: null, joined: true } as Channel;
}

beforeEach(() => {
  calls.length = 0;
  answer = async () => ({ groups: [] });
  vi.spyOn(api, "get").mockImplementation(((url: string, config?: { params?: Params; signal?: AbortSignal }) => {
    // Only core's search here; anything else (the feature flags) fails, so every app flag reads off.
    if (url !== "/search") return Promise.reject(Object.assign(new Error("not in this test"), { response: { status: 500 } }));
    const params = config?.params ?? {};
    calls.push(params);
    const signal = config?.signal;
    return new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("canceled"), { name: "CanceledError", code: "ERR_CANCELED" })));
      answer(params, signal).then((data) => resolve({ data }), reject);
    });
  }) as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const location = { pathname: "/s/server/search", search: "", hash: "", state: null, key: "k" };

function useBoth({ query, isComposing = false, scoped = false }: { query: string; isComposing?: boolean; scoped?: boolean }) {
  const entities = useSearchEntityResults({
    query,
    isComposing,
    serverId: "server-1",
    scope: scoped ? { kind: "channel", id: "c" } as never : null,
    overlayHome: false,
    location: location as never,
    searchEntityUsage: {},
    channels: [localChannel("local-alpha", "alpha-local"), localChannel("local-alpha-2", "alpha-two")],
    members: [],
    agents: [],
    machines: [],
    currentUser: null,
    dmChannels: [],
  });
  const apps = useSearchAppResults({
    query,
    isComposing,
    scope: null,
    serverId: "server-1",
    searchSurface: "",
    activateResultsInChat: false,
    formatMessageRef: { current: (() => "") as never },
  });
  return { entities, apps };
}

function wrapper({ children }: { children: ReactNode }) {
  return <TestIntlProvider>{children}</TestIntlProvider>;
}

function keysOf(groups: ReturnType<typeof useSearchEntityResults>["entityGroups"], id: string): string[] {
  return groups.find((group) => group.id === id)?.results.map((row) => row.key) ?? [];
}

test("local rows first; the server's answer then replaces channels and people, in its order with its status; both are asked with every app flag off", async () => {
  answer = async (params) => (params.app === "channels"
    ? { groups: [{ app: "channels", items: [channelHit("srv-archived", { name: "alpha-old", archived: true, canPost: false }), channelHit("srv-live", { name: "alpha" })], nextCursor: null, total: 2 }] }
    : { groups: [{ app: "people", items: [personHit("u-guest", { name: "alpha-guest", guest: true, role: "guest" })], nextCursor: null, total: 1 }] });
  const hook = renderHook(() => useBoth({ query: "alpha" }), { wrapper });

  // First paint: the local channels, before any request has answered.
  assert.deepEqual(keysOf(hook.result.current.entities.entityGroups, "channels").sort(), ["channel:local-alpha", "channel:local-alpha-2"]);
  assert.equal(hook.result.current.entities.entityGroups[0]?.source, "local");

  await waitFor(() => assert.equal(hook.result.current.entities.entityGroups[0]?.source, "server"));
  await waitFor(() => assert.equal(hook.result.current.entities.entityGroups.find((group) => group.id === "people")?.source, "server"));
  const groups = hook.result.current.entities.entityGroups;
  assert.deepEqual(keysOf(groups, "channels"), ["channel:srv-archived", "channel:srv-live"], "the server's order, the local rows gone");
  assert.equal(groups[0]?.results[0]?.status?.archived, true);
  assert.deepEqual(keysOf(groups, "people"), ["human:u-guest"]);
  assert.equal(groups.find((group) => group.id === "people")?.results[0]?.status?.guest, true);
  assert.equal(hook.result.current.entities.entityResultsIncomplete, false);

  // The app groups' gate is closed (no app flag on), the core groups were asked anyway.
  assert.equal(hook.result.current.apps.appSearch.state.status, "idle");
  assert.deepEqual(calls.map((params) => params.app).sort(), ["channels", "people"]);
  assert.ok(calls.every((params) => params.q === "alpha"));
});

test("a failed request: the local rows stay, the groups are incomplete, and Retry asks again for the failed ones only", async () => {
  let fail = true;
  answer = async (params) => {
    if (fail && params.app === "channels") throw Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
    return { groups: [{ app: params.app, items: params.app === "channels" ? [channelHit("srv-alpha", { name: "alpha" })] : [], nextCursor: null, total: params.app === "channels" ? 1 : 0 }] };
  };
  const hook = renderHook(() => useBoth({ query: "alpha" }), { wrapper });
  await waitFor(() => assert.equal(hook.result.current.entities.entityResultsIncomplete, true));
  await waitFor(() => assert.equal(hook.result.current.entities.entityResultsPending, false));
  assert.deepEqual(keysOf(hook.result.current.entities.entityGroups, "channels").sort(), ["channel:local-alpha", "channel:local-alpha-2"]);
  assert.equal(hook.result.current.entities.entityGroups[0]?.pending, false, "failed: the local count is the count");

  fail = false;
  const before = calls.length;
  act(() => hook.result.current.entities.retryEntityGroups());
  assert.equal(hook.result.current.entities.entityResultsPending, true);
  assert.equal(hook.result.current.entities.entityResultsRetrying, true, "the line says Searching… in Retry's place");
  assert.equal(hook.result.current.entities.entityResultsIncomplete, false);
  await waitFor(() => assert.deepEqual(keysOf(hook.result.current.entities.entityGroups, "channels"), ["channel:srv-alpha"]));
  assert.deepEqual(calls.slice(before).map((params) => params.app), ["channels"], "people answered, so it isn't asked again");
  assert.equal(hook.result.current.entities.entityResultsIncomplete, false);
});

test("while a group's answer is out its local rows are pending (no count yet)", async () => {
  answer = () => new Promise(() => {});
  const hook = renderHook(() => useBoth({ query: "alpha" }), { wrapper });
  assert.equal(hook.result.current.entities.entityResultsPending, true);
  assert.equal(hook.result.current.entities.entityGroups[0]?.pending, true);
});

test("an open IME composition (no committed words) is not pending: nothing is in flight for it", () => {
  answer = () => new Promise(() => {});
  const hook = renderHook(() => useBoth({ query: "alpha", isComposing: true }), { wrapper });
  assert.equal(hook.result.current.entities.entityResultsPending, false);
  assert.ok(hook.result.current.entities.entityGroups.every((group) => !group.pending));
});

test("the incomplete line: an always-mounted status, empty when complete; offline says so; an error offers Retry, then Searching… in its place", () => {
  const own = Object.getOwnPropertyDescriptor(navigator, "onLine");
  const setOnLine = (value: boolean) => Object.defineProperty(navigator, "onLine", { configurable: true, value });
  const note = (state: "complete" | "failed" | "retrying", onRetry = () => {}, onRetryFocusLost = () => {}) => (
    <TestIntlProvider>
      <SearchEntityResultsIncompleteNote state={state} onRetry={onRetry} onRetryFocusLost={onRetryFocusLost} />
    </TestIntlProvider>
  );
  try {
    setOnLine(true);
    const view = render(note("complete"));
    const line = view.getByTestId("search-entity-incomplete");
    assert.equal(line.getAttribute("role"), "status");
    assert.equal(line.textContent, "", "complete: the status region is there, empty");

    let retried = 0;
    let refocused = 0;
    view.rerender(note("failed", () => { retried += 1; }, () => { refocused += 1; }));
    assert.ok(view.getByTestId("search-entity-incomplete") === line, "the same element is filled: the region announces it");
    assert.equal(line.textContent, "Couldn't search all channels and people, so only those already loaded are shown. Retry");
    const retry = view.getByTestId("search-entity-incomplete-retry");
    retry.focus();
    fireEvent.click(retry);
    assert.deepEqual([retried, refocused], [1, 1], "Retry had focus: it goes to the search field before Retry is replaced");

    view.rerender(note("retrying"));
    assert.ok(view.getByTestId("search-entity-incomplete") === line, "still the same status element");
    assert.equal(line.textContent, "Couldn't search all channels and people, so only those already loaded are shown. Searching…");
    assert.ok(view.queryByTestId("search-entity-incomplete-retry") === null);
    cleanup();

    setOnLine(false);
    const offline = render(note("failed"));
    assert.equal(offline.getByTestId("search-entity-incomplete").textContent, "You're offline, so only channels and people already loaded are shown.");
    assert.ok(offline.queryByTestId("search-entity-incomplete-retry") === null);
  } finally {
    if (own) Object.defineProperty(navigator, "onLine", own);
    else delete (navigator as { onLine?: boolean }).onLine;
  }
});

test("a new query aborts the old one's requests; its answer never replaces the new words' rows", async () => {
  const signals: AbortSignal[] = [];
  answer = (params, signal) => {
    if (signal) signals.push(signal);
    if (params.q === "alp") return new Promise(() => {});
    return Promise.resolve({ groups: [{ app: params.app, items: params.app === "channels" ? [channelHit("srv-alpha", { name: "alpha" })] : [], nextCursor: null, total: params.app === "channels" ? 1 : 0 }] });
  };
  const hook = renderHook(({ query }) => useBoth({ query }), { wrapper, initialProps: { query: "alp" } });
  await waitFor(() => assert.equal(calls.length, 2));
  hook.rerender({ query: "alpha" });
  await waitFor(() => assert.deepEqual(keysOf(hook.result.current.entities.entityGroups, "channels"), ["channel:srv-alpha"]));
  assert.ok(signals.slice(0, 2).every((signal) => signal.aborted), "the stale requests were canceled");
});

test("Show all pages a group on with its cursor; total is the server's", async () => {
  answer = async (params) => {
    if (params.app !== "channels") return { groups: [{ app: params.app, items: [], nextCursor: null, total: 0 }] };
    return params.cursor === "next"
      ? { groups: [{ app: "channels", items: [channelHit("c3"), channelHit("c4")], nextCursor: null, total: 4 }] }
      : { groups: [{ app: "channels", items: [channelHit("c1"), channelHit("c2")], nextCursor: "next", total: 4 }] };
  };
  const hook = renderHook(() => useBoth({ query: "c" }), { wrapper });
  await waitFor(() => assert.equal(hook.result.current.entities.entityGroups[0]?.source, "server"));
  assert.deepEqual({ total: hook.result.current.entities.entityGroups[0]?.total, hasMore: hook.result.current.entities.entityGroups[0]?.hasMore }, { total: 4, hasMore: true });
  let ok = false;
  await act(async () => { ok = await hook.result.current.entities.loadMoreEntityGroup("channels"); });
  assert.equal(ok, true);
  assert.deepEqual(keysOf(hook.result.current.entities.entityGroups, "channels"), ["channel:c1", "channel:c2", "channel:c3", "channel:c4"]);
  assert.equal(hook.result.current.entities.entityGroups[0]?.hasMore, false);
  assert.deepEqual(calls.at(-1), { q: "c", app: "channels", cursor: "next", limit: 50 });
});

test("a conversation's own search asks for no core group", async () => {
  renderHook(() => useBoth({ query: "alpha", scoped: true }), { wrapper });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls.length, 0);
});

test("the section: the count and Show all in the heading, Load more once expanded while the server has more, a failed page inline with Retry", () => {
  const toggled: string[] = [];
  const more: string[] = [];
  const section = (props: { count: number | null; expanded?: boolean; pending?: boolean; pageFailed?: boolean; paging?: boolean }) => (
    <TestIntlProvider>
      <SearchEntityResultsSection group="channels" count={props.count} pending={props.pending} expanded={props.expanded ?? false} hasMore paging={props.paging ?? false} pageFailed={props.pageFailed} onToggleExpanded={(g) => toggled.push(g)} onLoadMore={(g) => more.push(g)}>
        <div />
      </SearchEntityResultsSection>
    </TestIntlProvider>
  );
  const view = render(section({ count: 37 }));
  const showAll = view.getByTestId("search-entity-show-all");
  assert.equal(showAll.textContent, "Show all");
  assert.ok(showAll.closest("[data-slot=search-results-section-heading]"), "the action sits in the heading");
  assert.equal(view.getByTestId("search-entity-group-count").textContent, "37");
  assert.ok(view.queryByTestId("search-entity-load-more") === null, "collapsed: no Load more");
  fireEvent.click(showAll);
  assert.deepEqual(toggled, ["channels"]);

  view.rerender(section({ count: 37, expanded: true }));
  assert.equal(view.getByTestId("search-entity-show-all").textContent, "Show fewer");
  fireEvent.click(view.getByTestId("search-entity-load-more"));
  assert.deepEqual(more, ["channels"]);

  view.rerender(section({ count: 37, expanded: true, pageFailed: true }));
  assert.ok(view.queryByTestId("search-entity-load-more") === null, "the failure takes Load more's place");
  assert.ok(view.getByTestId("search-entity-load-more-failed").textContent?.includes("Could not load more results."));
  fireEvent.click(view.getByTestId("search-entity-load-more-retry"));
  assert.deepEqual(more, ["channels", "channels"]);

  view.rerender(section({ count: null, pending: true, expanded: true }));
  assert.equal(view.getByTestId("search-entity-show-all").textContent, "Show fewer", "expanded and asked again: Show fewer stays");
  assert.ok(view.queryByTestId("search-entity-group-count") === null);

  view.rerender(section({ count: null, pending: true }));
  assert.ok(view.queryByTestId("search-entity-group-count") === null, "pending: no count yet");
  assert.ok(view.queryByTestId("search-entity-show-all") === null, "pending: no Show all yet");
  assert.equal(view.getByTestId("search-entity-group").getAttribute("aria-busy"), "true");
});

test("focus follows Load more and Retry as they take each other's place", () => {
  const section = (props: { paging?: boolean; pageFailed?: boolean }) => (
    <TestIntlProvider>
      <SearchEntityResultsSection group="channels" count={37} expanded hasMore paging={props.paging ?? false} pageFailed={props.pageFailed} onToggleExpanded={() => {}} onLoadMore={() => {}}>
        <div />
      </SearchEntityResultsSection>
    </TestIntlProvider>
  );
  const view = render(section({}));
  const loadMore = view.getByTestId("search-entity-load-more");
  loadMore.focus();
  fireEvent.click(loadMore);
  view.rerender(section({ paging: true }));
  view.rerender(section({ pageFailed: true }));
  assert.ok(document.activeElement === view.getByTestId("search-entity-load-more-retry"), "the page failed: focus on Retry");
  fireEvent.click(view.getByTestId("search-entity-load-more-retry"));
  view.rerender(section({ paging: true }));
  assert.ok(document.activeElement === view.getByTestId("search-entity-load-more"), "Retry pressed: focus back on Load more");
  view.rerender(section({}));
  assert.ok(document.activeElement === view.getByTestId("search-entity-load-more"), "the page landed: focus stays on Load more");
});

function renderRow(result: ReturnType<typeof channelHitToEntity>) {
  return renderWithIntl(
    <EntityResultRow result={result} returnHint={false} selected={false} agentAvatarUrl={null} humanMember={undefined} onResultContextMenu={() => {}} onResultClick={() => {}} />,
  );
}

const MARK_IDS = ["search-entity-archived", "search-entity-external", "search-entity-agent", "search-entity-guest"];
/** The row's marks; and no kind tag (Channel / Human / Computer) after the title. */
function marksOf(view: ReturnType<typeof renderRow>): string[] {
  const header = view.container.querySelector("[data-slot=search-entity-result-header]") ?? view.container;
  const text = header.textContent ?? "";
  assert.ok(!/Channel|Human|Computer/.test(text), `no kind tag: ${text}`);
  return Array.from(view.container.querySelectorAll(MARK_IDS.map((id) => `[data-testid=${id}]`).join(","))).map((node) => node.textContent ?? "");
}

test("rows draw one mark of the server's status, no kind tag; an unjoined public channel says Not joined and has no Join", () => {
  const archived = renderRow(channelHitToEntity(channelHit("a", { archived: true, external: true, canPost: false })));
  assert.deepEqual(marksOf(archived), ["Archived"], "Archived wins over External");
  const archivedMark = archived.getByTestId("search-entity-archived").className;
  assert.ok(archivedMark.includes("bg-inactive-soft") && !archivedMark.includes("font-mono"), `soft muted, not the outline look: ${archivedMark}`);
  cleanup();

  const joint = renderRow(channelHitToEntity(channelHit("j", { type: "joint", external: true, guest: true })));
  assert.deepEqual(marksOf(joint), ["External"], "Guests read as External: one tag");
  assert.ok(joint.container.querySelector(".lucide-external-channel"), "the external icon, from the row's status");
  cleanup();

  const guests = renderRow(channelHitToEntity(channelHit("g", { guest: true })));
  assert.deepEqual(marksOf(guests), ["External"]);
  assert.ok(guests.container.querySelector(".lucide-external-channel"));
  cleanup();

  const plain = renderRow(channelHitToEntity(channelHit("p")));
  assert.deepEqual(marksOf(plain), [], "no Channel tag under the Channels heading");
  assert.ok(plain.container.querySelector(".lucide-hash"));
  cleanup();

  const guest = renderRow(personHitToEntity(personHit("g", { guest: true, role: "guest" }), "me"));
  assert.deepEqual(marksOf(guest), ["Guest"], "a Guest, not Human + Guest");
  cleanup();
  const human = renderRow(personHitToEntity(personHit("h"), "me"));
  assert.deepEqual(marksOf(human), []);
  cleanup();
  const agent = renderRow(personHitToEntity(personHit("a", { kind: "agent" }), "me"));
  assert.deepEqual(marksOf(agent), ["Agent"]);
  cleanup();

  const opened: string[] = [];
  const unjoined = renderWithIntl(
    <EntityResultRow
      result={channelHitToEntity(channelHit("n", { name: "design-crit", description: "Weekly design crit", joined: false, canPost: false, requiredAction: "join_channel" }))}
      query="design"
      returnHint={false}
      selected={false}
      agentAvatarUrl={null}
      humanMember={undefined}
      onResultContextMenu={() => {}}
      onResultClick={(_event, result) => opened.push(result.key)}
    />,
  );
  assert.ok(unjoined.queryByTestId("search-entity-join") === null, "no Join in the row");
  assert.equal(unjoined.getByTestId("search-entity-not-joined").textContent, "Not joined");
  const row = unjoined.getByRole("button");
  assert.equal(row.getAttribute("aria-label"), "#design-crit, not joined");
  const describedBy = row.getAttribute("aria-describedby");
  assert.ok(describedBy, "the description stays available to screen readers");
  assert.equal(unjoined.container.ownerDocument.getElementById(describedBy)?.textContent, "Not joined · Weekly design crit");
  assert.ok(row.textContent?.includes("Not joined · Weekly design crit"));
  fireEvent.click(row);
  assert.deepEqual(opened, ["channel:n"], "a click opens the channel (its preview has Join)");
  cleanup();

  // The query hits only the name: the description still follows Not joined, never the "Channel" label.
  const nameOnly = renderRow(channelHitToEntity(channelHit("r", { name: "design-review", description: "Weekly critique", joined: false, canPost: false, requiredAction: "join_channel" })));
  assert.ok(nameOnly.getByRole("button").textContent?.includes("Not joined · Weekly critique"), "the description, though the query hit only the name");
});

test("a channel known only from the server opens as a not-joined channel: its record loads with joined false", async () => {
  const serverState = useServerStore.getState();
  const channelState = useChannelStore.getState();
  useServerStore.setState({ current: { ...(serverState.current ?? {}), id: "server-1" } } as never);
  vi.mocked(api.get).mockImplementation(((url: string) => (url === "/channels/srv-only"
    ? Promise.resolve({ data: { id: "srv-only", name: "design-crit", description: null, type: "channel", createdAt: "2026-11-01T00:00:00.000Z", archivedAt: null, joined: false } })
    : Promise.reject(new Error("not in this test")))) as never);
  try {
    assert.ok(!useChannelStore.getState().channels.some((channel) => channel.id === "srv-only"));
    const channel = await useChannelStore.getState().ensureChannel("srv-only");
    assert.equal(channel?.joined, false);
    assert.equal(useChannelStore.getState().channels.find((row) => row.id === "srv-only")?.joined, false, "the preview reads it from the store and offers Join");
  } finally {
    useChannelStore.setState(channelState, true);
    useServerStore.setState(serverState, true);
  }
});

test("an Artifact whose home conversation is archived is marked archived; absent reads as not archived", () => {
  const card = (archived: boolean) => ({
    card: {
      id: "art-1", title: "Plan", kind: "html", updatedAt: "2026-11-01T00:00:00.000Z",
      author: { type: "user", displayName: "Ann" },
      home: { kind: "conversation", conversation: { id: "c1", name: "old", type: "channel", ...(archived ? { archived: true } : {}) } },
    },
    matches: [],
  }) as never;
  const view = renderWithIntl(<ArtifactSearchHit hit={card(true)} highlight={(text) => text} selected={false} onOpen={() => {}} />);
  assert.equal(view.getByTestId("search-app-hit-archived").textContent, "Archived");
  assert.ok(view.getByTestId("search-app-hit-archived").className.includes("bg-inactive-soft"), "soft muted, as the channel rows");
  cleanup();
  const live = renderWithIntl(<ArtifactSearchHit hit={card(false)} highlight={(text) => text} selected={false} onOpen={() => {}} />);
  assert.ok(live.queryByTestId("search-app-hit-archived") === null);
});
