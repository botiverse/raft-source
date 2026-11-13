import assert from "node:assert/strict";
import {
  addReactionUsage,
  pickFavoriteReaction,
  REACTION_USAGE_LIMIT,
  recordReactionUsage,
  currentFavoriteReaction,
  resetReactionUsageCacheForTests,
} from "../src/components/message/reactionFavorite";
import type { ReactionUsage } from "../src/components/message/reactionFavorite";

// The toolbar's reaction button shows the most-used reaction (cindyz, Jasper).
test("the favorite reaction is the most used, a tie goes to the most recent, none is 👍", () => {
  assert.equal(pickFavoriteReaction({}), "👍");
  assert.equal(pickFavoriteReaction({ "👍": { count: 2, lastUsedAt: 5 }, "😂": { count: 3, lastUsedAt: 1 } }), "😂");
  assert.equal(pickFavoriteReaction({ "😂": { count: 3, lastUsedAt: 1 }, "🔥": { count: 3, lastUsedAt: 2 } }), "🔥");
});

test("each use adds one, and the map keeps only the most-used emoji", () => {
  let usage: ReactionUsage = {};
  usage = addReactionUsage(usage, "😂", 1);
  usage = addReactionUsage(usage, "😂", 2);
  assert.deepEqual(usage, { "😂": { count: 2, lastUsedAt: 2 } });

  const full: ReactionUsage = {};
  for (let i = 0; i < REACTION_USAGE_LIMIT; i += 1) full[`e${i}`] = { count: 2, lastUsedAt: i };
  const capped = addReactionUsage(full, "new", 100);
  assert.equal(Object.keys(capped).length, REACTION_USAGE_LIMIT);
  assert.ok(capped["e0"] === undefined, "the least-used, oldest other emoji goes");
  assert.deepEqual(capped["new"], { count: 1, lastUsedAt: 100 }, "a new emoji still comes in");
  assert.deepEqual(addReactionUsage(full, "e0", 100)["e0"], { count: 3, lastUsedAt: 100 });
});

function stubStorage(storage: Pick<Storage, "getItem" | "setItem">) {
  vi.stubGlobal("window", { localStorage: storage });
  resetReactionUsageCacheForTests();
}
afterEach(() => {
  vi.unstubAllGlobals();
  resetReactionUsageCacheForTests();
});

test("storage that throws never breaks reacting: 👍 to start, and this tab still learns", () => {
  stubStorage({
    getItem: () => { throw new Error("SecurityError"); },
    setItem: () => { throw new Error("QuotaExceededError"); },
  });
  assert.equal(currentFavoriteReaction("user-1"), "👍", "unreadable storage: 👍");
  assert.doesNotThrow(() => recordReactionUsage("user-1", "😂"));
  assert.equal(currentFavoriteReaction("user-1"), "😂", "this tab still learns");
});

test("each person on the device has their own counts", () => {
  const items = new Map<string, string>();
  stubStorage({ getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); } });
  for (let i = 0; i < 3; i += 1) recordReactionUsage("user-1", "😂");
  recordReactionUsage("user-2", "🔥");
  assert.equal(currentFavoriteReaction("user-1"), "😂");
  assert.equal(currentFavoriteReaction("user-2"), "🔥");
  assert.equal(currentFavoriteReaction("user-3"), "👍", "no usage of their own");
});
