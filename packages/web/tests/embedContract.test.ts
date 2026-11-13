import assert from "node:assert/strict";
import { __embedTestInternals, __setEmbedModeForTests, markHostToolbarDrawn, needsEmbedRepair, readHostDesktop, withEmbedParams } from "../src/embed";

const { parseEmbedMode } = __embedTestInternals;

// ── The contract ────────────────────────────────────────────────────────────
// ?embed=raft-settings-v1&shell=host|web
//
// Two dimensions on purpose (@MingQi): `embed` says "I am embedded", `shell` says
// "who owns the title bar". A bare `embed=1` collapses them and silently assumes
// every embed is host-shell.

test("host-shell embed is recognised", () => {
  const mode = parseEmbedMode("?embed=raft-settings-v1&shell=host");
  assert.equal(mode.embedded, true);
  assert.equal(mode.shell, "host");
});

test("web-shell embed keeps the header (no native title bar to duplicate)", () => {
  const mode = parseEmbedMode("?embed=raft-settings-v1&shell=web");
  assert.equal(mode.embedded, true);
  assert.equal(mode.shell, "web");
});

test("shell defaults to host when embedded and unspecified", () => {
  assert.equal(parseEmbedMode("?embed=raft-settings-v1").shell, "host");
});

test("an UNKNOWN embed version falls back to a normal page, never a broken one", () => {
  // Forward-compat: a future client shipping `raft-settings-v2` against an older web
  // build must get a plain page — not a half-applied contract.
  assert.equal(parseEmbedMode("?embed=raft-settings-v2&shell=host").embedded, false);
  assert.equal(parseEmbedMode("?embed=whatever").embedded, false);
});

test("legacy embed=1 is NOT honoured (@artin: 不用兼容)", () => {
  // Deliberate. An old client falls back to a normal page — one extra web header,
  // NOT the double header we are fixing. This assertion exists so that dropping
  // legacy support is a decision on the record, not an accident someone re-adds.
  assert.equal(parseEmbedMode("?embed=1").embedded, false);
  assert.equal(parseEmbedMode("?embed=1&shell=host").embedded, false);
});

test("no query string ⇒ not embedded", () => {
  assert.equal(parseEmbedMode("").embedded, false);
  assert.equal(parseEmbedMode("?foo=bar").embedded, false);
});

// ── The gate that matters most: this must be decided BEFORE the first paint ──
//
// If the embed decision lived in a `useEffect`, the first frame would render the
// header and the second would remove it — a visible flash — while every functional
// test stayed green, because the header IS gone by the time the assertion runs.
// `parseEmbedMode` is a pure sync function over the URL precisely so that the
// decision is available at module load. This test pins that it needs nothing async.
test("the decision is synchronous — no async, no effect, no store", () => {
  const before = Date.now;
  // If parseEmbedMode ever reached for a timer/микro-task, this would not be a pure
  // value by the time we read it. It returns immediately, from the string alone.
  const mode = parseEmbedMode("?embed=raft-settings-v1&shell=host");
  assert.equal(typeof mode.embedded, "boolean");
  assert.equal(Date.now, before);
});

test("chrome=none with the host shell: the native shell draws the page's toolbar too (#proj-workspace:#127)", () => {
  assert.equal(parseEmbedMode("?embed=raft-settings-v1&shell=host&chrome=none").chromeless, true);
  // Without it, or with the web shell (which keeps its own header), the page draws its toolbar.
  assert.equal(parseEmbedMode("?embed=raft-settings-v1&shell=host").chromeless, undefined);
  assert.equal(parseEmbedMode("?embed=raft-settings-v1&shell=web&chrome=none").chromeless, undefined);
  assert.equal(parseEmbedMode("?chrome=none").embedded, false);
});

test("back=host with the host shell: the page draws Back for the App, which closes it on #host=close (#proj-workspace:#264)", () => {
  assert.equal(parseEmbedMode("?embed=raft-settings-v1&shell=host&back=host").hostBack, true);
  assert.equal(parseEmbedMode("?embed=raft-settings-v1&shell=host&back=host&chrome=none").chromeless, true, "kept with chrome=none");
  // Without it, with another value, with the web shell (its own header has Back) or not embedded: nothing.
  assert.equal(parseEmbedMode("?embed=raft-settings-v1&shell=host").hostBack, undefined);
  assert.equal(parseEmbedMode("?embed=raft-settings-v1&shell=host&back=1").hostBack, undefined);
  assert.equal(parseEmbedMode("?embed=raft-settings-v1&shell=web&back=host").hostBack, undefined);
  assert.equal(parseEmbedMode("?back=host").embedded, false);
});

test("hostMenu with the host shell: the App's own items for the page's ⋯, known names only, in its order (mobile #4635)", () => {
  assert.deepEqual(parseEmbedMode("?embed=raft-settings-v1&shell=host&hostMenu=desktop-mode,open-in-browser").hostMenu, ["desktop-mode", "open-in-browser"]);
  assert.deepEqual(parseEmbedMode("?embed=raft-settings-v1&shell=host&hostMenu=open-in-browser,desktop-mode").hostMenu, ["open-in-browser", "desktop-mode"], "the App's order");
  assert.deepEqual(parseEmbedMode("?embed=raft-settings-v1&shell=host&hostMenu=print,desktop-mode,desktop-mode").hostMenu, ["desktop-mode"], "an unknown name dropped, a repeat once");
  assert.equal(parseEmbedMode("?embed=raft-settings-v1&shell=host&hostMenu=print").hostMenu, undefined, "none known: none");
  assert.equal(parseEmbedMode("?embed=raft-settings-v1&shell=host&hostMenu=").hostMenu, undefined);
  assert.equal(parseEmbedMode("?embed=raft-settings-v1&shell=web&hostMenu=desktop-mode").hostMenu, undefined, "only with the host shell");
  assert.equal(parseEmbedMode("?hostMenu=desktop-mode").embedded, false);
});

test("the keeper keeps the one bar: hostToolbar=1 once drawn, the App's hostMenu as it wrote it, hostDesktop only where the query lost it", () => {
  __embedTestInternals.reset();
  const restore = __setEmbedModeForTests({ embedded: true, shell: "host", hostMenu: ["desktop-mode", "open-in-browser"] });
  try {
    const entry = "?embed=raft-settings-v1&shell=host&hostMenu=desktop-mode,open-in-browser,print&hostDesktop=on";
    assert.equal(needsEmbedRepair(entry), false, "as the App opened it: nothing to write");
    assert.equal(readHostDesktop(entry), true);
    assert.equal(markHostToolbarDrawn(), true);
    assert.equal(markHostToolbarDrawn(), false, "once");
    // A navigation that kept the query but not the flag (it was written outside the router): put back, alone.
    assert.equal(needsEmbedRepair(entry), true, "hostToolbar missing");
    const repaired = withEmbedParams(new URLSearchParams(entry));
    assert.equal(repaired.get("hostToolbar"), "1");
    assert.equal(repaired.get("hostMenu"), "desktop-mode,open-in-browser,print", "the App's own value, never rewritten");
    assert.equal(repaired.get("hostDesktop"), "on");
    // A navigation that dropped the query: all of it back, Desktop mode as last seen.
    const all = withEmbedParams(new URLSearchParams("tab=1"));
    assert.deepEqual([all.get("tab"), all.get("hostMenu"), all.get("hostToolbar"), all.get("hostDesktop")], ["1", "desktop-mode,open-in-browser", "1", "on"]);
    // The App switched it off: its value stands; nothing older is written over it.
    assert.equal(withEmbedParams(new URLSearchParams(`${entry.replace("hostDesktop=on", "hostDesktop=off")}&hostToolbar=1`)).get("hostDesktop"), "off");
  } finally {
    restore();
    __embedTestInternals.reset();
  }
});

test("without hostMenu the page never says it draws the only bar", () => {
  __embedTestInternals.reset();
  const restore = __setEmbedModeForTests({ embedded: true, shell: "host" });
  try {
    assert.equal(markHostToolbarDrawn(), false);
    assert.equal(withEmbedParams(new URLSearchParams("?embed=raft-settings-v1&shell=host")).has("hostToolbar"), false);
    assert.equal(readHostDesktop("?hostDesktop=on"), null, "no desktop-mode item: no Desktop mode");
  } finally {
    restore();
    __embedTestInternals.reset();
  }
});
