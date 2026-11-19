import "./helpers/domSetup";
import assert from "node:assert/strict";
import { vi } from "vitest";

import { backPastArtifactFrame } from "../src/apps/artifacts/artifactFrameBack";
import { writeArtifactAddress } from "../src/components/layout/artifactOpenAddress";

// cindyz: an Artifact's page navigates inside its iframe (`#edit-vault`, its
// sections), and each step is an entry in the tab's joint history above the
// app's. The page's Back was `navigate(-1)` (history.back()), so it went to
// the Artifact's previous section instead of the chat, and seemed never to
// close. The Navigation API lists only the app's own entries: Back traverses
// to the one before the Artifact, past whatever the frame added.

type Navigable = { navigation?: unknown };

function setNavigation(navigation: unknown) {
  Object.defineProperty(window, "navigation", { value: navigation, configurable: true, writable: true });
}

function installNavigation(appEntries: readonly string[], current: number) {
  const traverseTo = vi.fn((_key: string) => ({ committed: Promise.resolve(), finished: Promise.resolve() }));
  setNavigation({
    currentEntry: { key: appEntries[current], index: current },
    entries: () => appEntries.map((key, index) => ({ key, index })),
    traverseTo,
  });
  return traverseTo;
}

afterEach(() => {
  delete (window as Navigable).navigation;
});

test("Back from an Artifact goes to the app's entry before it, however far the frame navigated", () => {
  const traverseTo = installNavigation(["chat", "artifact"], 1);
  const fallback = vi.fn();
  backPastArtifactFrame(fallback);
  assert.deepEqual(traverseTo.mock.calls, [["chat"]]);
  assert.equal(fallback.mock.calls.length, 0, "not history.back(), which steps through the frame's entries");
});

test("without the Navigation API, or nothing of the app's behind, Back is the history step it was", () => {
  delete (window as Navigable).navigation;
  const noApi = vi.fn();
  backPastArtifactFrame(noApi);
  assert.equal(noApi.mock.calls.length, 1);

  installNavigation(["artifact"], 0);
  const first = vi.fn();
  backPastArtifactFrame(first);
  assert.equal(first.mock.calls.length, 1);
});

test("closing an Artifact opened over a page (its address's Back) goes past the frame's entries too", () => {
  const traverseTo = installNavigation(["artifacts-home", "artifact-open"], 1);
  const navigate = vi.fn();
  writeArtifactAddress(navigate as never, { kind: "back" }, { key: "closing-entry" });
  assert.deepEqual(traverseTo.mock.calls, [["artifacts-home"]]);
  assert.equal(navigate.mock.calls.length, 0);
});
