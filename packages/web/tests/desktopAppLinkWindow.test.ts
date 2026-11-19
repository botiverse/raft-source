import assert from "node:assert/strict";

import { offersDesktopAppInThisWindow } from "../src/utils/desktopAppLink";

// huxijin, #proj-deskop 197537c8: the web app installed as its own window
// offered "Open in Raft Desktop", and the click opened a second app on the
// same page. The banner is for a computer's browser tab only.
const MAC_CHROME = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36", userAgentData: { platform: "macOS", mobile: false }, maxTouchPoints: 0 };

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

const displayMode = (mode: string | null) => (query: string) => ({ matches: mode !== null && query === `(display-mode: ${mode})` });

test("the Raft Desktop banner: a computer's browser tab, not the installed web app's window", () => {
  assert.equal(withWindow({ location: { search: "", hash: "" }, navigator: {}, matchMedia: displayMode(null) }, () => offersDesktopAppInThisWindow(MAC_CHROME)), true, "a browser tab");
  assert.equal(withWindow({ location: { search: "", hash: "" }, navigator: {}, matchMedia: displayMode("standalone") }, () => offersDesktopAppInThisWindow(MAC_CHROME)), false, "installed (standalone)");
  assert.equal(withWindow({ location: { search: "", hash: "" }, navigator: {}, matchMedia: displayMode("window-controls-overlay") }, () => offersDesktopAppInThisWindow(MAC_CHROME)), false, "installed (Window Controls Overlay)");
  assert.equal(withWindow({ location: { search: "", hash: "" }, navigator: { standalone: true }, matchMedia: displayMode(null) }, () => offersDesktopAppInThisWindow(MAC_CHROME)), false, "Safari Add to Dock");
  assert.equal(withWindow({ location: { search: "", hash: "" }, raftDesktop: { isDesktop: true }, navigator: {}, matchMedia: displayMode(null) }, () => offersDesktopAppInThisWindow(MAC_CHROME)), false, "Raft Desktop itself");
});
