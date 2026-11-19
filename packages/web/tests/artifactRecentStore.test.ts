// The Artifacts recently opened beside each conversation (#proj-workspace:#291, artifactRecentStore.ts): the side
// card's title lists them. Kept per person, server and conversation on this device, most recent first, at most 5;
// closing one keeps it; anything unreadable reads as nothing. The title is the menu's trigger from two on.
import assert from "node:assert/strict";

import {
  ARTIFACT_RECENT_MAX,
  ARTIFACT_RECENT_STORAGE_PREFIX,
  forgetRecentArtifacts,
  isRecentTitleTrigger,
  recallRecentArtifacts,
  recentArtifactsOf,
  recentArtifactsStorageKey,
  rememberRecentArtifact,
  subscribeRecentArtifacts,
} from "../src/apps/artifacts/artifactRecentStore";
import type { RecentArtifact } from "../src/apps/artifacts/artifactRecentStore";

class FakeStorage {
  items = new Map<string, string>();
  broken = false;
  get length() {
    return this.items.size;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string) {
    if (this.broken) throw new Error("blocked");
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.broken) throw new Error("full");
    this.items.set(key, value);
  }
  removeItem(key: string) {
    if (this.broken) throw new Error("blocked");
    this.items.delete(key);
  }
}

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let store: FakeStorage;

beforeEach(() => {
  store = new FakeStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

const KEY = `${ARTIFACT_RECENT_STORAGE_PREFIX}u1:s1`;
const entry = (id: string, openedAt: number, title = `Title ${id}`, version = 1): RecentArtifact => ({ id, title, version, openedAt });
const ids = (conversationId: string, userId = "u1", serverId = "s1") => recallRecentArtifacts(userId, serverId, conversationId).map((item) => item.id);

test("each opening goes in front; one opened again moves to the front, once, with its new title and version", () => {
  rememberRecentArtifact("u1", "s1", "general", entry("pt_fake-a", 100));
  rememberRecentArtifact("u1", "s1", "general", entry("pt_fake-b", 200));
  rememberRecentArtifact("u1", "s1", "general", entry("pt_fake-c", 300));
  assert.deepEqual(ids("general"), ["pt_fake-c", "pt_fake-b", "pt_fake-a"]);
  rememberRecentArtifact("u1", "s1", "general", entry("pt_fake-a", 400, "Renamed", 3));
  assert.deepEqual(ids("general"), ["pt_fake-a", "pt_fake-c", "pt_fake-b"]);
  assert.deepEqual(recallRecentArtifacts("u1", "s1", "general")[0], entry("pt_fake-a", 400, "Renamed", 3));
});

test("the same opening recorded again (its viewer mounted again, a version picked) keeps its place and time", () => {
  rememberRecentArtifact("u1", "s1", "general", entry("pt_fake-a", 100));
  rememberRecentArtifact("u1", "s1", "general", entry("pt_fake-b", 200));
  let writes = 0;
  const stop = subscribeRecentArtifacts(() => { writes += 1; });
  rememberRecentArtifact("u1", "s1", "general", entry("pt_fake-b", 200));
  assert.equal(writes, 0);
  rememberRecentArtifact("u1", "s1", "general", entry("pt_fake-b", 200, "Title pt_fake-b", 2));
  assert.equal(writes, 1);
  stop();
  assert.deepEqual(recallRecentArtifacts("u1", "s1", "general").map((item) => [item.id, item.version]), [["pt_fake-b", 2], ["pt_fake-a", 1]]);
});

test("at most 5, the oldest openings go", () => {
  for (let index = 0; index < 7; index += 1) rememberRecentArtifact("u1", "s1", "general", entry(`pt_fake-${index}`, 100 + index));
  assert.equal(ARTIFACT_RECENT_MAX, 5);
  assert.deepEqual(ids("general"), ["pt_fake-6", "pt_fake-5", "pt_fake-4", "pt_fake-3", "pt_fake-2"]);
});

test("each conversation, person and server has its own list (reverse: one shared list would show the other's)", () => {
  rememberRecentArtifact("u1", "s1", "general", entry("pt_fake-a", 100));
  rememberRecentArtifact("u1", "s1", "random", entry("pt_fake-b", 200));
  rememberRecentArtifact("u2", "s1", "general", entry("pt_fake-c", 300));
  rememberRecentArtifact("u1", "s2", "general", entry("pt_fake-d", 400));
  assert.deepEqual(ids("general"), ["pt_fake-a"]);
  assert.deepEqual(ids("random"), ["pt_fake-b"]);
  assert.deepEqual(ids("general", "u2"), ["pt_fake-c"]);
  assert.deepEqual(ids("general", "u1", "s2"), ["pt_fake-d"]);
  assert.equal(recentArtifactsStorageKey("u1", "s1", "general"), KEY);
  assert.equal(recentArtifactsStorageKey(null, "s1", "general"), null);
  assert.equal(recentArtifactsStorageKey("u1", "s1", null), null);
  assert.equal(recentArtifactsStorageKey("u1:x", "s1", "general"), null);
});

test("closing keeps it: nothing but a sign-out forgets an entry; another Artifact opened keeps the earlier one", () => {
  rememberRecentArtifact("u1", "s1", "general", entry("pt_fake-a", 100));
  // The side card's close does not write here; the next opening adds beside it.
  rememberRecentArtifact("u1", "s1", "general", entry("pt_fake-b", 200));
  assert.deepEqual(ids("general"), ["pt_fake-b", "pt_fake-a"]);
  store.setItem(`${ARTIFACT_RECENT_STORAGE_PREFIX}u10:s1`, "kept");
  forgetRecentArtifacts("u1");
  assert.deepEqual(ids("general"), []);
  assert.equal(store.getItem(`${ARTIFACT_RECENT_STORAGE_PREFIX}u10:s1`), "kept");
});

test("malformed or foreign data reads as nothing and is replaced; bad entries are dropped, good ones kept", () => {
  for (const raw of ["{", "null", "[]", JSON.stringify({ v: 2, conversations: { general: { at: 1, items: [entry("pt_fake-a", 1)] } } }), JSON.stringify({ v: 1, conversations: [] })]) {
    store.setItem(KEY, raw);
    assert.deepEqual(ids("general"), [], raw);
  }
  store.setItem(KEY, JSON.stringify({
    v: 1,
    conversations: {
      general: { at: 1, items: [entry("pt_fake-a", 5), { id: "not an id", title: "x", version: 1, openedAt: 9 }, { ...entry("pt_fake-b", 6), version: 0 }, { ...entry("pt_fake-c", 7), title: 3 }, entry("pt_fake-g", 1e20), entry("pt_fake-d", 8)] },
      "bad key": { at: 1, items: [entry("pt_fake-e", 1)] },
    },
  }));
  assert.deepEqual(ids("general"), ["pt_fake-d", "pt_fake-a"]);
  rememberRecentArtifact("u1", "s1", "general", entry("pt_fake-f", 10));
  assert.deepEqual(ids("general"), ["pt_fake-f", "pt_fake-d", "pt_fake-a"]);
  assert.deepEqual(recentArtifactsOf("{", "general"), []);
  assert.deepEqual(recentArtifactsOf(null, "general"), []);
});

test("a storage that throws is empty and never written", () => {
  store.broken = true;
  assert.doesNotThrow(() => rememberRecentArtifact("u1", "s1", "general", entry("pt_fake-a", 1)));
  assert.deepEqual(ids("general"), []);
  assert.doesNotThrow(() => forgetRecentArtifacts("u1"));
});

test("the title is the menu's trigger from two Artifacts on, plain with none or one", () => {
  assert.equal(isRecentTitleTrigger([]), false);
  assert.equal(isRecentTitleTrigger([entry("pt_fake-a", 1)]), false);
  assert.equal(isRecentTitleTrigger([entry("pt_fake-a", 1), entry("pt_fake-b", 2)]), true);
});
