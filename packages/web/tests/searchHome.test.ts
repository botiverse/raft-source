import assert from "node:assert/strict";
import test from "node:test";
import {
  FREQUENT_SEARCH_ENTITY_LIMIT,
  SEARCH_HISTORY_LIMIT,
  SEARCH_ENTITY_USAGE_EVENT_LIMIT,
  addSearchHistoryEntry,
  applySearchState,
  captureSearchState,
  getSearchEntityUsageStorageKey,
  getSearchHistoryStorageKey,
  getSearchStateStorageKey,
  persistSearchEntityUsage,
  resolveSearchHistoryEditing,
  shouldRenderSearchHistoryRemove,
  persistSearchHistory,
  persistSearchState,
  readSearchEntityUsage,
  readSearchHistory,
  readSearchState,
  recordSearchEntityOpen,
  removeSearchHistoryEntry,
  searchParamsHaveExplicitState,
  selectFrequentSearchEntities,
} from "../src/components/search/searchHome.js";
import type { SearchEntityResult } from "../src/components/search/searchEntities.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function entity(overrides: Partial<SearchEntityResult> & Pick<SearchEntityResult, "key" | "type" | "title">): SearchEntityResult {
  return {
    subtitle: { kind: "channel" },
    channelId: null,
    channelType: null,
    machineId: null,
    agentId: null,
    userId: null,
    archivedAt: null,
    ...overrides,
  };
}

test("search history is user-and-server scoped, sanitized, deduped, and bounded", () => {
  assert.equal(SEARCH_HISTORY_LIMIT, 15);
  const storage = new MemoryStorage();
  const key = getSearchHistoryStorageKey("server-1", "user-1");
  assert.equal(key, "raft:search-history:server-1:user-1");
  assert.equal(getSearchHistoryStorageKey("server-1", null), null);

  let history: string[] = [];
  for (let index = 0; index < SEARCH_HISTORY_LIMIT + 2; index += 1) {
    history = addSearchHistoryEntry(history, ` query ${index} `);
  }
  history = addSearchHistoryEntry(history, "QUERY 9");
  assert.equal(history.length, SEARCH_HISTORY_LIMIT);
  assert.equal(history[0], "QUERY 9");
  assert.equal(history.filter((entry) => entry.toLowerCase() === "query 9").length, 1);

  persistSearchHistory(storage, key, history);
  assert.deepEqual(readSearchHistory(storage, key), history);
  assert.deepEqual(removeSearchHistoryEntry(history, "query 9"), history.slice(1));
});

test("malformed search history is fail-open and invalid entries are discarded", () => {
  const storage = new MemoryStorage();
  storage.setItem("broken", "{");
  assert.deepEqual(readSearchHistory(storage, "broken"), []);

  storage.setItem("mixed", JSON.stringify([" first ", 7, "", "FIRST", "second"]));
  assert.deepEqual(readSearchHistory(storage, "mixed"), ["first", "second"]);
});

test("the last search state round-trips only search params and preserves layout params", () => {
  const storage = new MemoryStorage();
  const key = getSearchStateStorageKey("server-1", "user-1");
  assert.equal(key, "raft:search-state:server-1:user-1");

  const source = new URLSearchParams("q=roadmap&scope=humans&scope=mentioned&range=7d&sort=recent&open=channel:123&defer=1");
  const snapshot = captureSearchState(source);
  persistSearchState(storage, key, snapshot);
  assert.deepEqual(readSearchState(storage, key), snapshot);
  assert.equal(searchParamsHaveExplicitState(source), true);
  assert.equal(searchParamsHaveExplicitState(new URLSearchParams("open=channel:123")), false);

  const restored = applySearchState(new URLSearchParams("open=channel:123&defer=1"), snapshot);
  assert.equal(restored.get("q"), "roadmap");
  assert.deepEqual(restored.getAll("scope"), ["humans", "mentioned"]);
  assert.equal(restored.get("range"), "7d");
  assert.equal(restored.get("sort"), "recent");
  assert.equal(restored.get("open"), "channel:123");
  assert.equal(restored.get("defer"), "1");
});

test("personal search entity usage is user-and-server scoped, sanitized, and bounded", () => {
  const storage = new MemoryStorage();
  const key = getSearchEntityUsageStorageKey("server-1", "user-1");
  assert.equal(key, "raft:search-entity-usage:server-1:user-1");
  assert.equal(getSearchEntityUsageStorageKey(null, "user-1"), null);
  const now = Date.UTC(2026, 6, 31, 12);

  let usage = {};
  for (let index = 0; index < SEARCH_ENTITY_USAGE_EVENT_LIMIT + 3; index += 1) {
    usage = recordSearchEntityOpen(usage, "channel:one", now - index);
  }
  usage = recordSearchEntityOpen(usage, "computer:ignored", now);
  persistSearchEntityUsage(storage, key, usage);
  assert.equal(readSearchEntityUsage(storage, key, now)["channel:one"]?.length, SEARCH_ENTITY_USAGE_EVENT_LIMIT);
  assert.equal(readSearchEntityUsage(storage, key, now)["computer:ignored"], undefined);

  storage.setItem("broken-usage", "{");
  assert.deepEqual(readSearchEntityUsage(storage, "broken-usage", now), {});
  storage.setItem("mixed-usage", JSON.stringify({
    "channel:valid": [now, "bad", Number.NaN, now - 1],
    malformed: [now],
  }));
  assert.deepEqual(readSearchEntityUsage(storage, "mixed-usage", now), {
    "channel:valid": [now, now - 1],
  });
});

test("common search entities use only personal Search opens and omit untracked entities", () => {
  const now = Date.UTC(2026, 6, 31, 12);
  const entities = [
    entity({ key: "channel:pinned", type: "channel", title: "Pinned", channelId: "pinned" }),
    entity({ key: "agent:agent-1", type: "agentDm", title: "Agent", agentId: "agent-1" }),
    entity({ key: "channel:frequent", type: "channel", title: "Frequent", channelId: "frequent" }),
    entity({ key: "channel:recent", type: "channel", title: "Recent", channelId: "recent" }),
    entity({ key: "channel:untracked", type: "channel", title: "Untracked", channelId: "untracked" }),
    entity({ key: "channel:archived", type: "channel", title: "Archived", channelId: "archived", archivedAt: "2026-01-01T00:00:00.000Z" }),
    entity({ key: "computer:one", type: "computer", title: "Computer", machineId: "one" }),
    entity({ key: "human:self", type: "humanDm", title: "Me", userId: "self" }),
  ];

  const result = selectFrequentSearchEntities({
    entities,
    usage: {
      "channel:frequent": [now - 24 * 60 * 60 * 1_000, now - 25 * 60 * 60 * 1_000],
      "channel:recent": [now - 60 * 60 * 1_000],
      "channel:untracked": [],
      "channel:archived": [now],
      "computer:one": [now],
    },
    currentUserId: "self",
    limit: 4,
    now,
  });

  assert.deepEqual(result.map((item) => item.key), [
    "channel:frequent",
    "channel:recent",
  ]);
});

test("common search entities expose ten ranked entries by default", () => {
  assert.equal(FREQUENT_SEARCH_ENTITY_LIMIT, 10);
  const now = Date.UTC(2026, 6, 31, 12);
  const entities = Array.from({ length: 14 }, (_, index) => entity({
    key: `channel:${index}`,
    type: "channel",
    title: `Channel ${index}`,
    channelId: String(index),
  }));
  const usage = Object.fromEntries(entities.map((item, index) => [
    item.key,
    [now - index * 1_000],
  ]));

  const result = selectFrequentSearchEntities({ entities, usage, now });

  assert.deepEqual(
    result.map((item) => item.key),
    Array.from({ length: 10 }, (_, index) => `channel:${index}`),
  );
});

test("common search entities honor eligibility and rank by personal use", () => {
  const now = Date.UTC(2026, 6, 31, 12);
  const entities = [
    entity({ key: "channel:zeta", type: "channel", title: "Zeta", channelId: "zeta" }),
    entity({ key: "channel:alpha", type: "channel", title: "Alpha", channelId: "alpha" }),
    entity({ key: "human:hidden", type: "humanDm", title: "Hidden", userId: "hidden", channelId: "dm-hidden" }),
  ];
  const usage = {
    "channel:zeta": [now - 2_000],
    "channel:alpha": [now - 1_000],
    "human:hidden": [now],
  };
  const eligibleEntityKeys = new Set(["channel:zeta", "channel:alpha"]);

  assert.deepEqual(selectFrequentSearchEntities({
    entities,
    usage,
    eligibleEntityKeys,
    now,
  }).map((item) => item.key), ["channel:alpha", "channel:zeta"]);
});

test("search history edit mode is confined to touch viewports with a non-empty list", () => {
  // Desktop never enters edit mode, even if a request somehow latched.
  assert.equal(resolveSearchHistoryEditing({ isTouchViewport: false, editRequested: true, historyCount: 3 }), false);
  // Touch requires an explicit request; the default is the clean list.
  assert.equal(resolveSearchHistoryEditing({ isTouchViewport: true, editRequested: false, historyCount: 3 }), false);
  assert.equal(resolveSearchHistoryEditing({ isTouchViewport: true, editRequested: true, historyCount: 3 }), true);
  // An empty list has nothing to edit, so a latched request cannot survive it.
  assert.equal(resolveSearchHistoryEditing({ isTouchViewport: true, editRequested: true, historyCount: 0 }), false);
});

test("search history remove control is hover-revealed on desktop and edit-gated on touch", () => {
  assert.equal(shouldRenderSearchHistoryRemove({ isTouchViewport: false, editing: false }), true);
  assert.equal(shouldRenderSearchHistoryRemove({ isTouchViewport: false, editing: true }), true);
  // The touch default renders no control at all, not a transparent one.
  assert.equal(shouldRenderSearchHistoryRemove({ isTouchViewport: true, editing: false }), false);
  assert.equal(shouldRenderSearchHistoryRemove({ isTouchViewport: true, editing: true }), true);
});
