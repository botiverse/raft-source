import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";

/**
 * COUNT THE WRITES, not the destination.
 *
 * @MingQi found the bug these tests exist for, and the reason the previous gates missed
 * it is the whole lesson: they asserted the FINAL URL, and the final URL was correct.
 * Meanwhile the keeper was issuing a redundant `replace` on every single navigation —
 * including for users who are not embedded at all — because:
 *   - react-router's `setSearchParams` navigates unconditionally (a functional updater
 *     returning `prev` unchanged does NOT skip the write), and
 *   - the setter's identity churns on every location change, so an effect that deps on
 *     it re-fires after its own write.
 * Destination-only assertions are structurally blind to that. So: count.
 *
 * Every location the Router produces has a distinct `key`. Counting distinct keys after
 * the initial one counts Router writes — pushes AND replaces.
 */
function makeWriteCounter() {
  const keys: string[] = [];
  function Counter() {
    const location = useLocation();
    if (keys[keys.length - 1] !== location.key) keys.push(location.key);
    return null;
  }
  // The first key is the initial entry, not a write.
  return { Counter, writes: () => Math.max(0, keys.length - 1) };
}

function Nav() {
  const navigate = useNavigate();
  return <button data-testid="go" onClick={() => navigate("/computers/abc")}>go</button>;
}

/** Another surface writing its OWN param — the keeper must not answer this with a write. */
function OtherSurface() {
  const [, setSearchParams] = useSearchParams();
  return (
    <button
      data-testid="open-thread"
      onClick={() => setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("thread", "c1:m1");
        return next;
      }, { replace: true })}
    >
      open thread
    </button>
  );
}

async function mount(entry: string) {
  const { __embedTestInternals } = await import("../src/embed");
  __embedTestInternals.reset();
  window.history.replaceState({}, "", `/${entry.split("?")[1] ? `?${entry.split("?")[1]}` : ""}`);
  const { useEmbedParamsKeeper } = await import("../src/hooks/useEmbedParamsKeeper");
  function Keeper() {
    useEmbedParamsKeeper();
    return null;
  }
  const { Counter, writes } = makeWriteCounter();
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Counter />
      <Keeper />
      <Nav />
      <OtherSurface />
      <Routes>
        <Route path="/computers" element={null} />
        <Route path="/computers/:id" element={null} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => { await Promise.resolve(); });
  return { writes };
}

async function click(testId: string) {
  await act(async () => {
    screen.getByTestId(testId).click();
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

test("NOT embedded: the keeper never writes to the Router — not on mount, not on navigation", async () => {
  // The regression that mattered most: this hook runs for EVERY user of the app, and the
  // previous version issued a redundant replace on each navigation for all of them.
  const { writes } = await mount("/computers");
  assert.equal(writes(), 0, "no write on mount when not embedded");

  await click("go");
  assert.equal(writes(), 1, "exactly the navigation itself — the keeper adds nothing");
});

test("embedded and already correct: the keeper does not write", async () => {
  const { writes } = await mount("/computers?embed=raft-settings-v1&shell=host");
  assert.equal(writes(), 0, "params already right ⇒ nothing to repair ⇒ no history churn");
});

test("embedded + bare navigation: EXACTLY ONE repair write, not a stream of them", async () => {
  const { writes } = await mount("/computers?embed=raft-settings-v1&shell=host");
  await click("go");
  // 1 = the navigation, 2 = the single repair replace. Anything more is the loop.
  assert.equal(writes(), 2, "the navigation, plus exactly one repair");
});

test("another surface's query-only write does NOT provoke a repair write", async () => {
  // The setter's identity churns on this write, which re-fires the keeper's effect.
  // If the keeper decides to write from inside the updater instead of guarding before
  // it, this is where the extra replace (and the flicker) comes from.
  const { writes } = await mount("/computers?embed=raft-settings-v1&shell=host");
  await click("open-thread");
  assert.equal(writes(), 1, "only the other surface's own write — the keeper stays silent");
});
