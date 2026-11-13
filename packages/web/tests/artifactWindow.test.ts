import assert from "node:assert/strict";

import { artifactWindowFeatures, artifactWindowName, artifactWindowRect, opensArtifactWindows } from "../src/apps/artifacts/artifactWindow";

// #proj-workspace:#253: installed on a computer, Open in new page is a
// document-sized window beside the app (artifactWindow.ts): at most 1100 wide
// (60% of the screen), 85% tall, right of the app's window where it fits, else
// against the screen's right edge (Jasper: never centred), its top at the app
// window's top, always on the screen. The installed-app behaviour itself (Chrome/Edge
// honouring the features, Safari's Add to Dock) is checked by a person.

const laptop = { availLeft: 0, availTop: 0, availWidth: 1440, availHeight: 900 };

test("size: 60% of the screen's width up to 1100, 85% of its height", () => {
  const { width, height } = artifactWindowRect(laptop, { left: 0, top: 0, width: 1440, height: 900 });
  assert.deepEqual({ width, height }, { width: 864, height: 765 });
  const wide = artifactWindowRect({ availLeft: 0, availTop: 0, availWidth: 3840, availHeight: 2160 }, { left: 0, top: 0, width: 1200, height: 1000 });
  assert.equal(wide.width, 1100, "capped at 1100 on a large screen");
  assert.equal(wide.height, 1836);
});

test("beside: right of the app's window, at its top, where the whole window fits", () => {
  const screen = { availLeft: 0, availTop: 25, availWidth: 2560, availHeight: 1415 };
  assert.deepEqual(artifactWindowRect(screen, { left: 40, top: 60, width: 1200, height: 1000 }), { left: 1248, top: 60, width: 1100, height: 1203 });
  // Its top is kept on the screen even when the app's window sits low.
  assert.equal(artifactWindowRect(screen, { left: 40, top: 900, width: 1200, height: 500 }).top, 25 + 1415 - 1203);
});

test("no room: an app window at the right edge, or maximised, gets it against the screen's right edge, its top at the app's (never centred)", () => {
  const atRightEdge = artifactWindowRect(laptop, { left: 840, top: 0, width: 600, height: 900 });
  assert.deepEqual(atRightEdge, { left: 576, top: 0, width: 864, height: 765 });
  assert.deepEqual(artifactWindowRect(laptop, { left: 0, top: 0, width: 1440, height: 900 }), atRightEdge, "maximised: the same, at the right edge");
  // A maximised app on a 1920 screen: the Artifact's window leaves its left 820 px (the sidebar, the conversation's start) in view.
  assert.deepEqual(
    artifactWindowRect({ availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 }, { left: 0, top: 0, width: 1920, height: 1040 }),
    { left: 820, top: 0, width: 1100, height: 884 },
  );
  // The app window's top, kept: a window lower on the screen gets the Artifact's at the same height (clamped onto the screen).
  assert.equal(artifactWindowRect(laptop, { left: 600, top: 80, width: 840, height: 700 }).top, 80);
  assert.equal(artifactWindowRect(laptop, { left: 600, top: 400, width: 840, height: 500 }).top, 900 - 765);
  // One pixel short of room beside goes to the right edge too, never cut off there.
  const nearly = artifactWindowRect(laptop, { left: 0, top: 0, width: 1440 - 864 - 8 + 1, height: 900 });
  assert.equal(nearly.left, 576);
});

test("a small screen: still on it, inside its available area", () => {
  const small = { availLeft: 0, availTop: 0, availWidth: 800, availHeight: 560 };
  const rect = artifactWindowRect(small, { left: 100, top: 50, width: 700, height: 500 });
  assert.deepEqual(rect, { left: 320, top: 50, width: 480, height: 476 });
  assert.ok(rect.left >= 0 && rect.left + rect.width <= 800 && rect.top >= 0 && rect.top + rect.height <= 560);
});

test("multiple monitors: a screen left of or above the main one has negative coordinates, and the window stays on it", () => {
  const left = { availLeft: -1920, availTop: 0, availWidth: 1920, availHeight: 1050 };
  assert.deepEqual(artifactWindowRect(left, { left: -1900, top: 30, width: 700, height: 900 }), { left: -1192, top: 30, width: 1100, height: 893 }, "beside, on the left screen");
  const maximised = artifactWindowRect(left, { left: -1920, top: 0, width: 1920, height: 1050 });
  assert.deepEqual(maximised, { left: -1100, top: 0, width: 1100, height: 893 }, "maximised: at the left screen's right edge, not the main one's");
  const above = { availLeft: 200, availTop: -1080, availWidth: 1920, availHeight: 1040 };
  assert.deepEqual(artifactWindowRect(above, { left: 300, top: -2000, width: 500, height: 600 }), { left: 808, top: -1080, width: 1100, height: 884 }, "beside, its top clamped onto the screen above");
  assert.deepEqual(artifactWindowRect(above, { left: 1500, top: -1000, width: 500, height: 600 }), { left: 1020, top: -1000, width: 1100, height: 884 }, "no room: at the right edge of the screen above, the app's top");
});

test("features: a popup with the rect and no noopener (so the name finds the window again); one window name per Artifact", () => {
  const features = artifactWindowFeatures({ left: -10, top: 20, width: 1100, height: 800 });
  assert.equal(features, "popup,width=1100,height=800,left=-10,top=20");
  assert.doesNotMatch(features, /noopener|noreferrer/);
  assert.equal(artifactWindowName("pt_abc"), "raft-artifact-pt_abc");
  assert.notEqual(artifactWindowName("pt_abc"), artifactWindowName("pt_def"));
});

function withWindow<T>(value: unknown, run: () => T): T {
  const had = "window" in globalThis;
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = value;
  try {
    return run();
  } finally {
    if (had) (globalThis as { window?: unknown }).window = original;
    else delete (globalThis as { window?: unknown }).window;
  }
}

const installed = (query: string) => ({ matches: query === "(display-mode: window-controls-overlay)" });
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

test("opensArtifactWindows: only Raft installed on a computer", () => {
  assert.equal(withWindow(undefined, () => opensArtifactWindows()), false, "no window");
  assert.equal(withWindow({ navigator: { userAgent: MAC_CHROME }, matchMedia: () => ({ matches: false }) }, () => opensArtifactWindows()), false, "a browser tab");
  assert.equal(withWindow({ navigator: { userAgent: MAC_CHROME, maxTouchPoints: 0 }, matchMedia: installed }, () => opensArtifactWindows()), true, "installed on a Mac (Window Controls Overlay)");
  assert.equal(
    withWindow({ navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, matchMedia: (query: string) => ({ matches: query === "(display-mode: standalone)" }) }, () => opensArtifactWindows()),
    true,
    "installed on Windows (standalone)",
  );
  assert.equal(withWindow({ raftDesktop: { isDesktop: true }, navigator: { userAgent: MAC_CHROME }, matchMedia: installed }, () => opensArtifactWindows()), false, "Raft Desktop keeps its own");
  assert.equal(withWindow({ navigator: { standalone: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" } }, () => opensArtifactWindows()), false, "an iPhone home-screen app");
  assert.equal(withWindow({ navigator: { userAgent: MAC_CHROME, maxTouchPoints: 5 }, matchMedia: installed }, () => opensArtifactWindows()), false, "an iPad reporting a Mac");
  assert.equal(withWindow({ navigator: { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)" }, matchMedia: installed }, () => opensArtifactWindows()), false, "installed on Android");
  assert.equal(withWindow({ navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)", userAgentData: { mobile: true } }, matchMedia: installed }, () => opensArtifactWindows()), false, "a tablet with a desktop UA, client hints say mobile");
});
