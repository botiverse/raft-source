import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import api from "../src/api/client";
import { useSavedStore } from "../src/store/savedStore";

/**
 * Behavior: the saved badge/count comes from the server's `total` (the true
 * count), NOT the loaded-page length that used to cap it at PAGE_SIZE=20
 * (task #420). Also covers the backward-compat fallback for an older server
 * that omits `total`.
 *
 * Run: `pnpm --filter @botiverse/raft-web test`.
 */

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);
const originalDelete = api.delete.bind(api);

afterEach(() => {
  api.get = originalGet;
  api.post = originalPost;
  api.delete = originalDelete;
  useSavedStore.setState({
    saved: [],
    savedIds: new Set(),
    loading: false,
    hasMore: false,
    total: 0,
    resultTotal: 0,
    query: "",
    sortDirection: "desc",
  });
});

function mockSavedResponse(body: unknown) {
  api.get = (async (url: string) => {
    assert.equal(url, "/channels/saved");
    return { data: body };
  }) as typeof api.get;
}

/** Make the next write hang, so we can observe the *optimistic* state before
 *  the request resolves (and before any loadSaved reconcile runs). */
function hangNextWrite() {
  const pending = new Promise<{ data: unknown }>(() => {});
  api.post = (() => pending) as typeof api.post;
  api.delete = (() => pending) as typeof api.delete;
}

test("loadSaved sets total from the server response, not the loaded-page length", async () => {
  // Only 2 rows loaded this page, but the server reports 247 saved overall —
  // the badge must reflect 247, not 2 (and not the old 20 cap).
  mockSavedResponse({
    saved: [{ messageId: "a" }, { messageId: "b" }],
    hasMore: true,
    total: 247,
  });
  await useSavedStore.getState().loadSaved();
  assert.equal(useSavedStore.getState().total, 247);
  assert.equal(useSavedStore.getState().saved.length, 2);
});

test("loadSaved falls back to the loaded length when an older server omits total", async () => {
  mockSavedResponse({
    saved: [{ messageId: "a" }, { messageId: "b" }, { messageId: "c" }],
    hasMore: false,
    // no `total` field
  });
  await useSavedStore.getState().loadSaved();
  assert.equal(useSavedStore.getState().total, 3);
});

test("a zero total leaves the badge count at 0 (distinct from the omitted-total fallback)", async () => {
  mockSavedResponse({ saved: [], hasMore: false, total: 0 });
  await useSavedStore.getState().loadSaved();
  assert.equal(useSavedStore.getState().total, 0);
});

test("filtered Saved loads send q + sort while preserving the canonical badge total", async () => {
  useSavedStore.setState({ total: 47 });
  api.get = (async (url: string, config?: { params?: Record<string, unknown> }) => {
    assert.equal(url, "/channels/saved");
    assert.equal(config?.params?.q, "layout");
    assert.equal(config?.params?.sort, "asc");
    return { data: { saved: [{ messageId: "matching" }], hasMore: false, total: 1, globalTotal: 47 } };
  }) as typeof api.get;

  await useSavedStore.getState().loadSaved({ query: "layout", sortDirection: "asc" });

  assert.equal(useSavedStore.getState().resultTotal, 1);
  assert.equal(useSavedStore.getState().total, 47, "a filtered result count must not replace the global Saved badge count");
});

test("a stale Saved search response cannot overwrite a newer filter", async () => {
  const resolvers = new Map<string, (value: { data: unknown }) => void>();
  api.get = ((_url: string, config?: { params?: Record<string, unknown> }) => new Promise((resolve) => {
    resolvers.set(String(config?.params?.q ?? ""), resolve);
  })) as typeof api.get;

  const first = useSavedStore.getState().loadSaved({ query: "first", sortDirection: "desc" });
  const second = useSavedStore.getState().loadSaved({ query: "second", sortDirection: "desc" });
  resolvers.get("second")?.({ data: { saved: [{ messageId: "new" }], hasMore: false, total: 1 } });
  await second;
  resolvers.get("first")?.({ data: { saved: [{ messageId: "stale" }], hasMore: false, total: 1 } });
  await first;

  assert.equal(useSavedStore.getState().query, "second");
  assert.deepEqual(useSavedStore.getState().saved.map((entry) => entry.messageId), ["new"]);
});

test("loadSaved preserves known saved IDs that are outside the first page", async () => {
  useSavedStore.setState({
    saved: [],
    savedIds: new Set(["older-thread-reply"]),
    loading: false,
    hasMore: false,
    total: 21,
  });
  mockSavedResponse({
    saved: [{ messageId: "newer-message" }],
    hasMore: true,
    total: 21,
  });

  await useSavedStore.getState().loadSaved();

  assert.deepEqual(
    [...useSavedStore.getState().savedIds].sort(),
    ["newer-message", "older-thread-reply"],
    "a paginated reconcile must not clear saved membership outside page one",
  );
});

test("loadSaved preserves an optimistic save added while the first-page request is in flight", async () => {
  let resolveRequest!: (value: { data: unknown }) => void;
  api.get = (() => new Promise((resolve) => {
    resolveRequest = resolve;
  })) as typeof api.get;

  const loading = useSavedStore.getState().loadSaved();
  useSavedStore.setState((state) => ({ savedIds: new Set([...state.savedIds, "thread-reply"]) }));
  resolveRequest({ data: { saved: [{ messageId: "page-one-message" }], hasMore: true, total: 25 } });
  await loading;

  assert.deepEqual(
    [...useSavedStore.getState().savedIds].sort(),
    ["page-one-message", "thread-reply"],
    "a late first-page response must not erase an optimistic saved badge",
  );
});

test("saveMessage optimistically bumps total immediately (real-time badge, before the request settles)", () => {
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false, total: 5 });
  hangNextWrite();
  void useSavedStore.getState().saveMessage("m1"); // do not await — observe the optimistic set
  assert.equal(useSavedStore.getState().total, 6, "count bumps before the POST resolves");
  assert.ok(useSavedStore.getState().savedIds.has("m1"));
});

test("checkSaved preserves savedIds identity when the server reports no new membership", async () => {
  const initialSavedIds = new Set(["m1"]);
  useSavedStore.setState({ savedIds: initialSavedIds });
  api.post = (async (url: string) => {
    assert.equal(url, "/channels/saved/check");
    return { data: { savedIds: ["m1"] } };
  }) as typeof api.post;

  await useSavedStore.getState().checkSaved(["m1"]);

  assert.equal(useSavedStore.getState().savedIds, initialSavedIds);
});

test("saveMessage does not double-count a message that is already saved", () => {
  useSavedStore.setState({ saved: [], savedIds: new Set(["m1"]), loading: false, hasMore: false, total: 5 });
  hangNextWrite();
  void useSavedStore.getState().saveMessage("m1");
  assert.equal(useSavedStore.getState().total, 5, "already saved -> no increment");
});

test("unsaveMessage optimistically drops total immediately (real-time badge)", () => {
  useSavedStore.setState({
    saved: [{ messageId: "m1" } as never],
    savedIds: new Set(["m1"]),
    loading: false, hasMore: false, total: 5, resultTotal: 1,
  });
  hangNextWrite();
  void useSavedStore.getState().unsaveMessage("m1");
  assert.equal(useSavedStore.getState().total, 4, "count drops before the DELETE resolves");
  assert.equal(useSavedStore.getState().resultTotal, 0, "the current filtered result total drops with its removed row");
  assert.ok(!useSavedStore.getState().savedIds.has("m1"));
});

test("unsaveMessage does not drop the count for a message that was not saved", () => {
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false, total: 5 });
  hangNextWrite();
  void useSavedStore.getState().unsaveMessage("ghost");
  assert.equal(useSavedStore.getState().total, 5, "not saved -> count unchanged");
});
