import assert from "node:assert/strict";
import {
  SIGN_IN_CHUNK_RELOAD_KEY,
  __resetSignInChunkReloadForTest,
  reloadOntoSignInOnce,
} from "../src/components/auth/signInChunkReload";

function tab(stored: Record<string, string> = {}) {
  const reloads: number[] = [];
  return {
    reloads,
    stored,
    deps: (now: number) => ({
      storage: { getItem: (key: string) => stored[key] ?? null, setItem: (key: string, value: string) => { stored[key] = value; } },
      reload: () => { reloads.push(now); },
      now,
    }),
  };
}

beforeEach(() => __resetSignInChunkReloadForTest());

test("a failed sign-in chunk reloads the page once, in place, onto the current release", () => {
  const page = tab();
  assert.equal(reloadOntoSignInOnce(page.deps(1_000)), true);
  assert.deepEqual(page.reloads, [1_000]);
  assert.equal(page.stored[SIGN_IN_CHUNK_RELOAD_KEY], "1000");
  // A second render on the same page finds the reload under way.
  assert.equal(reloadOntoSignInOnce(page.deps(1_001)), true);
  assert.deepEqual(page.reloads, [1_000]);
});

test("after a recent reload for it, no loop: Try again instead", () => {
  const page = tab({ [SIGN_IN_CHUNK_RELOAD_KEY]: "1000" });
  assert.equal(reloadOntoSignInOnce(page.deps(60_000)), false);
  assert.deepEqual(page.reloads, []);
  __resetSignInChunkReloadForTest();
  assert.equal(reloadOntoSignInOnce(page.deps(1000 + 5 * 60_000 + 1)), true, "a later deploy may reload again");
});

test("no sessionStorage: no reload that could repeat", () => {
  const deps = tab().deps(1_000);
  deps.storage.getItem = () => { throw new Error("denied"); };
  assert.equal(reloadOntoSignInOnce(deps), false);
});
