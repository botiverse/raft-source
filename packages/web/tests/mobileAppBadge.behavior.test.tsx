// @ts-nocheck
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import { LeftRail } from "../src/components/layout/LeftRail";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { mobileAppSeenStorageKey } from "../src/components/layout/mobileAppBadge";
import { TestIntlProvider } from "./helpers/intl";
import {
  prefetchServerFeatureFlags,
  resetServerFeatureFlagsForTests,
} from "../src/store/serverFeatureFlags";

const originalPost = api.post;

/** Resolve the remaining server flags without returning the retired mobile key. */
async function prefetchWithoutMobileFlag() {
  resetServerFeatureFlagsForTests();
  api.post = (async () => ({
    data: { evaluations: [] },
  })) as typeof api.post;
  await prefetchServerFeatureFlags("server-1");
}

/**
 * The one-shot dot announcing the mobile app.
 *
 * Two properties are easy to get wrong and neither is visible by inspection:
 * the dot must clear on *using the mobile app row*, not on opening the Help
 * menu (someone who opened Help to reach Feedback has not been told about the
 * app), and the "seen" mark is keyed per user, so a shared device does not let
 * one person's dismissal silence it for the next.
 */

const originalApiGet = api.get;
const originalServerState = useServerStore.getState();
const originalAuthState = useAuthStore.getState();

function renderRail(userId: string | null) {
  api.get = (() => new Promise(() => {})) as typeof api.get;
  useAuthStore.setState({
    ...originalAuthState,
    user: userId ? ({ id: userId, name: "Tester" } as never) : null,
  });
  useServerStore.setState({
    ...originalServerState,
    current: { id: "server-1", name: "Botiverse", slug: "botiverse", avatarUrl: null } as never,
    servers: [{ id: "server-1", name: "Botiverse", slug: "botiverse", avatarUrl: null } as never],
    settings: {
      ...originalServerState.settings,
      feedbackSettings: { enabled: true },
    } as never,
  });
  return render(
    <MemoryRouter initialEntries={["/s/botiverse/channel/general"]}>
      <TestIntlProvider>
        <LeftRail side="left" workspaceModeAvailable={false} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

/**
 * The rail dot is RailTabButton's built-in one (so it matches every other rail
 * tab), which carries no testid of its own — select it structurally, inside the
 * Help trigger, rather than reintroducing a bespoke marker just for tests.
 */
function railDots() {
  const help = screen.queryByTestId("left-rail-help");
  return help ? help.querySelectorAll("span.rounded-full") : [];
}

function openHelp() {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
  });
}

afterEach(() => {
  cleanup();
  api.post = originalPost;
  resetServerFeatureFlagsForTests();
  window.localStorage.clear();
  api.get = originalApiGet;
  useServerStore.setState(originalServerState, true);
  useAuthStore.setState(originalAuthState, true);
});

test("a user who has not seen the mobile app gets a dot on Help and on the row", async () => {
  await prefetchWithoutMobileFlag();
  renderRail("user-a");

  assert.equal(railDots().length, 1);
  openHelp();
  // The row carries its own dot: the rail dot only says "something in here",
  // and Help holds four rows. Exact count, not "at least one" — a duplicated
  // dot is as wrong as a missing one, and `>= 1` cannot tell them apart.
  const rowDot = screen.getByTestId("help-menu-mobile-app-badge");
  // The canonical dot is 10×10 (`lg`). `sm` (4×4) means "the parent physically
  // cannot fit 10×10" — a menu row can. I had used `sm` to make it feel less
  // prominent, which is the priority axis the design system does not have, and
  // at 4×4 it read as a rendering artefact rather than a signal (@wenyi).
  // `size-2.5` is AttentionDot's `lg`; `size-1` is `sm`. (CLAUDE.md documents
  // these as `h-2.5 w-2.5` / `h-1 w-1` — the primitive emits the `size-*`
  // shorthand, which is the same box. Asserting the doc's spelling failed
  // against correct markup, so this pins what the component actually renders.)
  assert.ok(
    rowDot.className.includes("size-2.5"),
    `the menu-row dot must be the canonical 10px: ${rowDot.className}`,
  );
  assert.ok(
    !rowDot.className.includes("size-1 "),
    `the menu-row dot must not fall back to the compact 4px: ${rowDot.className}`,
  );
});

test("opening the mobile app row clears the dot and keeps it cleared", async () => {
  await prefetchWithoutMobileFlag();
  renderRail("user-a");
  openHelp();

  act(() => {
    fireEvent.click(screen.getByTestId("help-menu-mobile-app"));
  });
  assert.equal(railDots().length, 0);
  assert.equal(window.localStorage.getItem(mobileAppSeenStorageKey("user-a")), "1");

  // Survives a remount — a dot that returns on refresh is not "one-shot".
  cleanup();
  await prefetchWithoutMobileFlag();
  renderRail("user-a");
  assert.equal(railDots().length, 0);
});

test("reaching Help for something else does not count as being told", async () => {
  await prefetchWithoutMobileFlag();
  renderRail("user-a");
  openHelp();

  // Feedback is a sibling row in the same menu. If dismissal were wired to the
  // menu opening, this would silently consume the announcement.
  act(() => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Feedback" }));
  });
  cleanup();
  await prefetchWithoutMobileFlag();
  renderRail("user-a");
  assert.equal(railDots().length, 1);
});

test("one person's dismissal does not silence the dot for the next on a shared device", async () => {
  window.localStorage.setItem(mobileAppSeenStorageKey("user-a"), "1");

  await prefetchWithoutMobileFlag();
  renderRail("user-b");
  assert.equal(
    railDots().length,
    1,
    "user-b must still be told, even though user-a dismissed it on this device",
  );
});

test("the dot still appears when the user arrives after the rail mounts", async () => {
  // Cold load: the rail renders before the auth store hydrates. The mount-time
  // value is computed with no user, so the badge depends entirely on reacting
  // to the id landing. The effect that does this is deliberately a no-op on
  // mount (it is on the rail's commit budget) — this pins that the skip did not
  // also skip the real transition.
  await prefetchWithoutMobileFlag();
  renderRail(null);
  assert.equal(railDots().length, 0);

  act(() => {
    useAuthStore.setState({ user: { id: "user-late", name: "Tester" } as never });
  });
  assert.equal(
    railDots().length,
    1,
    "a user who signs in after mount must still be told about the mobile app",
  );
});

test("no dot before the signed-in user is known", async () => {
  // On a cold load `currentUserId` is null for the first render. Showing the
  // dot then would mark it seen against a key that belongs to nobody.
  await prefetchWithoutMobileFlag();
  renderRail(null);
  assert.equal(railDots().length, 0);
});

test("an empty feature evaluation cannot hide the default-on mobile entry", async () => {
  await prefetchWithoutMobileFlag();
  renderRail("user-a");

  assert.equal(railDots().length, 1, "the announcement is no longer server-flag gated");
  openHelp();
  assert.ok(screen.getByTestId("help-menu-mobile-app"));
  assert.ok(screen.getByRole("menuitem", { name: "Feedback" }));
});

test("rendering the default-on entry does not mark it seen before use", async () => {
  await prefetchWithoutMobileFlag();
  renderRail("user-a");
  openHelp();

  const seenKeys = Object.keys(window.localStorage).filter((k) => k.startsWith("slock:mobile-app:seen"));
  assert.deepEqual(seenKeys, [], "opening Help alone must not consume the announcement");
  assert.equal(window.localStorage.getItem(mobileAppSeenStorageKey("user-a")), null);
});
