import assert from "node:assert/strict";
import { createServerViewPreference } from "../src/store/serverViewPreference";

type Choice = "a" | "b" | "c";

function stubStorage({ failWrites = false } = {}): Map<string, string> {
  const items = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error("QuotaExceededError");
      items.set(key, value);
    },
    removeItem: (key: string) => items.delete(key),
  };
  vi.stubGlobal("window", { localStorage, addEventListener: () => {}, removeEventListener: () => {} });
  return items;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("server view preference: each server keeps its own choice; none, or an unknown value, reads as the fallback", () => {
  const items = stubStorage();
  const preference = createServerViewPreference<Choice>({ storagePrefix: "test_pref.", values: ["a", "b", "c"], fallback: "a" });
  preference.write("s1", "b");
  preference.write("s2", "c");
  assert.equal(items.get("test_pref.s1"), "b");
  assert.equal(preference.read("s1"), "b");
  assert.equal(preference.read("s2"), "c");
  assert.equal(preference.read("s3"), "a");
  assert.equal(preference.read(null), "a", "no server yet");
  preference.write(undefined, "c");
  assert.equal(items.size, 2, "nothing kept without a server");
  items.set("test_pref.s4", "zzz");
  assert.equal(preference.read("s4"), "a");
});

test("server view preference: a server with no choice yet reads the browser-wide legacy key", () => {
  const items = stubStorage();
  items.set("test_legacy", "c");
  const preference = createServerViewPreference<Choice>({ storagePrefix: "test_pref.", values: ["a", "b", "c"], fallback: "a", legacyKey: "test_legacy" });
  assert.equal(preference.read("s1"), "c");
  preference.write("s1", "b");
  assert.equal(preference.read("s1"), "b");
});

test("server view preference: a choice storage refuses holds for the page, per server", () => {
  stubStorage({ failWrites: true });
  const preference = createServerViewPreference<Choice>({ storagePrefix: "test_pref.", values: ["a", "b", "c"], fallback: "a" });
  preference.write("s1", "c");
  assert.equal(preference.read("s1"), "c");
  assert.equal(preference.read("s2"), "a");
  preference.resetForTests();
  assert.equal(preference.read("s1"), "a");
});
