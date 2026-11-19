import assert from "node:assert/strict";
import { ARTIFACT_SPLASH_APPEAR_AFTER_MS, ARTIFACT_SPLASH_CYCLE_MS, artifactSplashUntilNextCycle } from "../src/apps/artifacts/artifactSplash";
import { ARTIFACT_SPLASH_HOST_SETTLE_MS, artifactSplashDone, holdArtifactSplashCover, resetArtifactSplashHostForTests } from "../src/apps/artifacts/artifactSplashHost";
import { __embedTestInternals, __setEmbedModeForTests, getEmbedMode, markHostPageShown } from "../src/embed";

// #proj-workspace:#302: in the App, one splash. The App draws it natively over the WebView and plays its ending
// when the page writes `hostLoaded=1`; a new icon (the kind learned from a bare link) waits for the cycle's end.

function stubAddress(href: string): { href: () => string; writes: () => number } {
  let current = href;
  let writes = 0;
  vi.stubGlobal("window", {
    location: { get href() { return current; }, get search() { return new URL(current).search; } },
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, url: URL | string) => {
        writes += 1;
        current = String(url);
      },
    },
  });
  return { href: () => current, writes: () => writes };
}

function hostShell(): () => void {
  __embedTestInternals.reset();
  resetArtifactSplashHostForTests();
  return __setEmbedModeForTests({ embedded: true, shell: "host", chromeless: true });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __embedTestInternals.reset();
  resetArtifactSplashHostForTests();
});

test("hostLoaded=1 is written once, with the host shell only, keeping the rest of the address", () => {
  const address = stubAddress("https://app.raft.build/artifacts/a1?embed=raft-settings-v1&shell=host&chrome=none#panel=comments");
  const restore = hostShell();
  try {
    assert.equal(markHostPageShown(), true);
    assert.equal(markHostPageShown(), false, "once per document");
    const url = new URL(address.href());
    assert.equal(url.searchParams.get("hostLoaded"), "1");
    assert.equal(url.searchParams.get("chrome"), "none");
    assert.equal(url.hash, "#panel=comments");
    assert.equal(address.writes(), 1);
  } finally {
    restore();
  }

  __embedTestInternals.reset();
  const page = stubAddress("https://app.raft.build/artifacts/a1");
  const plain = __setEmbedModeForTests({ embedded: false, shell: "web" });
  try {
    assert.equal(markHostPageShown(), false, "a browser tab is never told anything");
    assert.equal(page.writes(), 0);
  } finally {
    plain();
  }
});

test("a document that starts with hostLoaded=1 in its address (a reload) drops it, so the App sees only this load's", () => {
  __embedTestInternals.reset();
  const address = stubAddress("https://app.raft.build/artifacts/a1?embed=raft-settings-v1&shell=host&hostLoaded=1&chrome=none");
  assert.equal(getEmbedMode().chromeless, true);
  const url = new URL(address.href());
  assert.equal(url.searchParams.has("hostLoaded"), false);
  assert.equal(url.searchParams.get("chrome"), "none");
  assert.equal(markHostPageShown(), true, "and this load writes it again when it is done");
  assert.equal(new URL(address.href()).searchParams.get("hostLoaded"), "1");

  __embedTestInternals.reset();
  const tab = stubAddress("https://app.raft.build/artifacts/a1?hostLoaded=1");
  assert.equal(getEmbedMode().embedded, false);
  assert.equal(tab.writes(), 0, "outside the App the address is never touched");
});

test("the App is told when a splash is done, at once", () => {
  const address = stubAddress("https://app.raft.build/artifacts/a1?embed=raft-settings-v1&shell=host");
  const restore = hostShell();
  try {
    const release = holdArtifactSplashCover();
    assert.equal(address.writes(), 0, "loading");
    release();
    artifactSplashDone();
    assert.equal(new URL(address.href()).searchParams.get("hostLoaded"), "1");
  } finally {
    restore();
  }
});

test("the App is told when no splash is left on screen (a failure drew its own), but not between two parts handing over", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const address = stubAddress("https://app.raft.build/artifacts/a1?embed=raft-settings-v1&shell=host");
  const restore = hostShell();
  try {
    // Stage 0 hands over to stage 1: the next cover holds before the wait is up.
    const first = holdArtifactSplashCover();
    first();
    const second = holdArtifactSplashCover();
    vi.advanceTimersByTime(ARTIFACT_SPLASH_HOST_SETTLE_MS * 2);
    assert.equal(address.writes(), 0, "still loading");
    // Releasing twice counts once.
    second();
    second();
    vi.advanceTimersByTime(ARTIFACT_SPLASH_HOST_SETTLE_MS - 1);
    assert.equal(address.writes(), 0);
    vi.advanceTimersByTime(1);
    assert.equal(new URL(address.href()).searchParams.get("hostLoaded"), "1", "no splash left: told");
  } finally {
    restore();
  }
});

test("a new icon waits for the end of the cycle it arrives in; before the splash appears it takes over at once", () => {
  const start = 1_000_000;
  const appear = start + ARTIFACT_SPLASH_APPEAR_AFTER_MS;
  assert.equal(artifactSplashUntilNextCycle(start, start + 10), 0, "nothing on screen yet");
  assert.equal(artifactSplashUntilNextCycle(start, appear), 0, "on a boundary");
  assert.equal(artifactSplashUntilNextCycle(start, appear + 400), ARTIFACT_SPLASH_CYCLE_MS - 400);
  assert.equal(artifactSplashUntilNextCycle(start, appear + ARTIFACT_SPLASH_CYCLE_MS + 1), ARTIFACT_SPLASH_CYCLE_MS - 1, "in a later cycle");
  assert.equal(artifactSplashUntilNextCycle(start, appear + 2 * ARTIFACT_SPLASH_CYCLE_MS), 0);
});
