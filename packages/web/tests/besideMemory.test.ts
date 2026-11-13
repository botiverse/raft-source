import assert from "node:assert/strict";

import {
  BESIDE_MEMORY_MAX_CONVERSATIONS,
  BESIDE_MEMORY_STORAGE_PREFIX,
  forgetBesideMemory,
  nextBesideState,
  normalizeBeside,
  planBesideRestore,
  pruneBesideEntries,
  recallBeside,
  rememberBeside,
  sameBeside,
  onlyBesideKinds,
  withoutBesideKinds,
} from "../src/store/besideMemory";

// What was open beside each conversation (docs/frontend/beside-memory.md):
// the pure rules and the device's storage.

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

const KEY = `${BESIDE_MEMORY_STORAGE_PREFIX}u1:s1`;

test("a state keeps only well-formed parts, and its front is one of the open ones", () => {
  assert.deepEqual(normalizeBeside(null), {});
  assert.deepEqual(normalizeBeside({ thread: "m 1", profile: "external:c:m", artifact: { id: "" }, front: "thread" }), {});
  assert.deepEqual(
    normalizeBeside({ thread: "m1", artifact: { id: "pt_a", version: 3 }, profile: "agent:a1", agentTab: "activity", front: "profile" }),
    { thread: "m1", artifact: { id: "pt_a", version: 3 }, profile: "agent:a1", agentTab: "activity", front: "profile" },
  );
  // A version that is no positive whole number is the latest; a tab belongs to an agent's profile only.
  assert.deepEqual(normalizeBeside({ artifact: { id: "pt_a", version: "2" }, profile: "human:h1", agentTab: "activity", front: "thread" }), {
    artifact: { id: "pt_a", version: null },
    profile: "human:h1",
    front: "artifact",
  });
});

test("what just opened is in front; a picked tab is; closing the front one leaves another in front", () => {
  const thread = nextBesideState(null, { thread: "m1" });
  assert.equal(thread.front, "thread");
  const both = nextBesideState(thread, { thread: "m1", artifact: { id: "pt_a", version: null } });
  assert.equal(both.front, "artifact");
  assert.equal(nextBesideState(both, { thread: "m1", artifact: { id: "pt_a", version: null } }).front, "artifact", "nothing changed: the front stays");
  assert.equal(nextBesideState(both, { thread: "m1", artifact: { id: "pt_a", version: null } }, "thread").front, "thread");
  assert.equal(nextBesideState(both, { thread: "m2", artifact: { id: "pt_a", version: null } }).front, "thread", "another thread took its place");
  assert.deepEqual(nextBesideState(both, { thread: "m1" }), { thread: "m1", front: "thread" });
  assert.deepEqual(nextBesideState(both, {}), {});
  assert.equal(nextBesideState(both, { thread: "m1" }, "profile").front, "thread", "a pick of something not open is ignored");
});

test("the address wins: what it names stays in front, the remembered rest is restored behind", () => {
  const remembered = { thread: "m1", artifact: { id: "pt_a", version: 2 }, profile: "agent:a1", agentTab: "activity", front: "artifact" as const };
  assert.deepEqual(planBesideRestore(remembered, {}), {
    restore: { thread: "m1", artifact: { id: "pt_a", version: 2 }, profile: "agent:a1", agentTab: "activity" },
    front: "artifact",
  });
  assert.deepEqual(planBesideRestore(remembered, { thread: "m9" }), {
    restore: { artifact: { id: "pt_a", version: 2 }, profile: "agent:a1", agentTab: "activity" },
    front: "thread",
  });
  // The address's profile keeps its own tab: the remembered one belongs to the remembered profile.
  assert.deepEqual(planBesideRestore(remembered, { profile: "human:h1" }).restore, { thread: "m1", artifact: { id: "pt_a", version: 2 } });
  assert.deepEqual(planBesideRestore(null, { thread: "m9" }), { restore: {}, front: "thread" });
  assert.deepEqual(planBesideRestore(null, {}), { restore: {}, front: null });
});

test("an address that has the thread's place taken restores no thread over it", () => {
  const plan = planBesideRestore({ thread: "m1", profile: "human:h1", front: "thread" }, {}, { threadTaken: true });
  assert.deepEqual(plan, { restore: { profile: "human:h1" }, front: "profile" });
});

test("dropping what is no longer visible moves the front on", () => {
  assert.deepEqual(withoutBesideKinds({ thread: "m1", profile: "agent:a1", agentTab: "activity", front: "profile" }, ["profile"]), { thread: "m1", front: "thread" });
  assert.deepEqual(withoutBesideKinds({ thread: "m1", front: "thread" }, ["thread"]), {});
  assert.deepEqual(onlyBesideKinds({ thread: "m1", profile: "agent:a1", agentTab: "activity", front: "thread" }, ["profile"]), { profile: "agent:a1", agentTab: "activity", front: "profile" });
  assert.deepEqual(onlyBesideKinds(null, ["thread"]), {});
});

test("remembered per person, server and conversation, and read back", () => {
  rememberBeside("u1", "s1", "c1", { thread: "m1", front: "thread" }, 10);
  rememberBeside("u1", "s2", "c1", { profile: "human:h1" }, 11);
  rememberBeside("u2", "s1", "c1", { artifact: { id: "pt_a", version: null } }, 12);
  assert.deepEqual(recallBeside("u1", "s1", "c1"), { thread: "m1", front: "thread" });
  assert.deepEqual(recallBeside("u1", "s2", "c1"), { profile: "human:h1", front: "profile" });
  assert.deepEqual(recallBeside("u2", "s1", "c1"), { artifact: { id: "pt_a", version: null }, front: "artifact" });
  assert.equal(recallBeside("u1", "s1", "c2"), null);
  assert.equal(recallBeside("u3", "s1", "c1"), null);
  assert.deepEqual([...store.items.keys()].sort(), [`${BESIDE_MEMORY_STORAGE_PREFIX}u1:s1`, `${BESIDE_MEMORY_STORAGE_PREFIX}u1:s2`, `${BESIDE_MEMORY_STORAGE_PREFIX}u2:s1`]);
  assert.deepEqual(JSON.parse(store.items.get(KEY)!), { v: 1, conversations: { c1: { thread: "m1", front: "thread", at: 10 } } });
});

test("nothing open is remembered as nothing: the conversation's entry goes, and the last one takes the key with it", () => {
  rememberBeside("u1", "s1", "c1", { thread: "m1" }, 1);
  rememberBeside("u1", "s1", "c2", { thread: "m2" }, 2);
  rememberBeside("u1", "s1", "c1", {}, 3);
  assert.equal(recallBeside("u1", "s1", "c1"), null);
  assert.deepEqual(recallBeside("u1", "s1", "c2"), { thread: "m2", front: "thread" });
  rememberBeside("u1", "s1", "c2", {}, 4);
  assert.equal(store.items.has(KEY), false);
  rememberBeside("u1", "s1", "c3", {}, 5);
  assert.equal(store.items.size, 0, "nothing to forget writes nothing");
});

test("no one signed in, no server, or an id that is no id: nothing is read or written", () => {
  rememberBeside(null, "s1", "c1", { thread: "m1" });
  rememberBeside("u1", undefined, "c1", { thread: "m1" });
  rememberBeside("u1", "s1", "c:1", { thread: "m1" });
  rememberBeside("u:1", "s1", "c1", { thread: "m1" });
  assert.equal(store.items.size, 0);
  assert.equal(recallBeside(null, "s1", "c1"), null);
});

test("at most 200 conversations are kept, the least recently written dropped", () => {
  for (let index = 0; index < BESIDE_MEMORY_MAX_CONVERSATIONS + 5; index += 1) {
    rememberBeside("u1", "s1", `c${index}`, { thread: `m${index}` }, index);
  }
  // Writing an old one again makes it recent.
  rememberBeside("u1", "s1", "c5", { thread: "again" }, 1000);
  rememberBeside("u1", "s1", "new", { thread: "m" }, 1001);
  const kept = Object.keys((JSON.parse(store.items.get(KEY)!) as { conversations: Record<string, unknown> }).conversations);
  assert.equal(kept.length, BESIDE_MEMORY_MAX_CONVERSATIONS);
  assert.equal(recallBeside("u1", "s1", "c0"), null);
  assert.equal(recallBeside("u1", "s1", "c4"), null);
  assert.equal(recallBeside("u1", "s1", "c6"), null, "the new one dropped the then oldest");
  assert.deepEqual(recallBeside("u1", "s1", "c5"), { thread: "again", front: "thread" });
  assert.deepEqual(recallBeside("u1", "s1", "c204"), { thread: "m204", front: "thread" });
  assert.deepEqual(Object.keys(pruneBesideEntries({ a: { at: 1 }, b: { at: 3 }, c: { at: 2 } }, 2)).sort(), ["b", "c"]);
});

test("malformed data and another version read as nothing, and the next write replaces them", () => {
  for (const raw of ["not json", "[]", "null", JSON.stringify({ v: 2, conversations: { c1: { thread: "m1", at: 1 } } }), JSON.stringify({ v: 1, conversations: [] })]) {
    store.items.set(KEY, raw);
    assert.equal(recallBeside("u1", "s1", "c1"), null, raw);
  }
  store.items.set(KEY, JSON.stringify({ v: 1, conversations: { c1: { thread: 7, at: "x" }, "bad id": { thread: "m1", at: 1 }, c2: { thread: "m2" } } }));
  assert.equal(recallBeside("u1", "s1", "c1"), null);
  assert.deepEqual(recallBeside("u1", "s1", "c2"), { thread: "m2", front: "thread" });
  rememberBeside("u1", "s1", "c3", { thread: "m3" }, 9);
  assert.deepEqual(JSON.parse(store.items.get(KEY)!), {
    v: 1,
    conversations: { c2: { thread: "m2", front: "thread", at: 0 }, c3: { thread: "m3", front: "thread", at: 9 } },
  });
});

test("a storage that throws, or none at all, never throws here", () => {
  store.broken = true;
  assert.doesNotThrow(() => rememberBeside("u1", "s1", "c1", { thread: "m1" }));
  assert.equal(recallBeside("u1", "s1", "c1"), null);
  assert.doesNotThrow(() => forgetBesideMemory("u1"));
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("denied"); } });
  assert.doesNotThrow(() => rememberBeside("u1", "s1", "c1", { thread: "m1" }));
  assert.equal(recallBeside("u1", "s1", "c1"), null);
  assert.doesNotThrow(() => forgetBesideMemory("u1"));
});

test("forgetting a person removes their entries on every server, and no one else's", () => {
  rememberBeside("u1", "s1", "c1", { thread: "m1" });
  rememberBeside("u1", "s2", "c1", { thread: "m1" });
  rememberBeside("u10", "s1", "c1", { thread: "m1" });
  store.items.set("slock:conversationWidth", "500");
  forgetBesideMemory("u1");
  assert.deepEqual([...store.items.keys()].sort(), [`${BESIDE_MEMORY_STORAGE_PREFIX}u10:s1`, "slock:conversationWidth"]);
  forgetBesideMemory(null);
  assert.equal(store.items.size, 2);
});

test("two states are the same when what is open, its tab and its front are", () => {
  assert.equal(sameBeside(null, {}), true);
  assert.equal(sameBeside({ thread: "m1", front: "thread" }, { thread: "m1", front: "thread" }), true);
  assert.equal(sameBeside({ artifact: { id: "a", version: 1 } }, { artifact: { id: "a", version: null } }), false);
  assert.equal(sameBeside({ thread: "m1", profile: "human:h", front: "thread" }, { thread: "m1", profile: "human:h", front: "profile" }), false);
});
