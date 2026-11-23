import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The title-bar rules (drag regions, the window controls' corners) are shared
// by the desktop app and the installed web app, both under the Window Controls
// Overlay (#triage:#104). The web loads the rules, asks the browser for the
// overlay, and reserves the window controls' corners from the overlay's
// geometry, only where the shell says the controls are (apps/desktop's
// desktopAssets test pins the layer guard's rules it relies on).

const css = () => readFile(new URL("../src/components/topbar/titleBar.css", import.meta.url), "utf8");

test("the web stylesheet loads the shared title-bar rules", async () => {
  const index = await readFile(new URL("../src/index.css", import.meta.url), "utf8");
  assert.match(index, /@import "\.\/components\/topbar\/titleBar\.css";/);
});

test("the manifest asks for the Window Controls Overlay, standalone as the fallback", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/site.webmanifest", import.meta.url), "utf8")) as Record<string, unknown>;
  assert.deepEqual(manifest.display_override, ["window-controls-overlay"]);
  assert.equal(manifest.display, "standalone");
});

test("the left corner comes from the overlay's geometry, only while the controls take it", async () => {
  const rules = await css();
  assert.match(rules, /html\[data-title-bar-start="overlay"\]:not\(\[data-fullscreen\]\)\s*\{\s*--raft-frame-inset-start: env\(titlebar-area-x, 0px\);/);
  assert.match(rules, /html\[data-title-bar-start="overlay"\]:not\(\[data-fullscreen\]\) \[data-raft-titlebar\]\s*\{\s*padding-left: var\(--raft-frame-inset-start\);\s*--raft-titlebar-inset-start: var\(--raft-frame-inset-start\);/);
  assert.match(rules, /html\[data-title-bar-start="overlay"\]:not\(\[data-fullscreen\]\) \[data-raft-overlay-titlebar\]\s*\{\s*--raft-titlebar-inset-start: var\(--raft-frame-inset-start\);/);
  assert.equal(/(^|\n)\[data-raft-titlebar\]\s*\{[^}]*padding/.test(rules), false, "no unconditional inset");
  // Declarations only: the comments may name a width to say why it is not here.
  const declarations = rules.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/82px/.test(declarations), false, "no fixed traffic-light corner: the geometry gives it, on the desktop too");
});

test("the right corner (caption buttons) comes from the overlay's geometry too, windowed only", async () => {
  const rules = await css();
  assert.match(rules, /html\[data-title-bar="overlay"\]:not\(\[data-fullscreen\]\)\s*\{\s*--raft-frame-inset-end: max\(0px, calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, calc\(100vw - 138px\)\)\)\);\s*--raft-frame-inset-top: env\(titlebar-area-height, 44px\);/);
  assert.match(rules, /html\[data-title-bar="overlay"\]:not\(\[data-fullscreen\]\) \[data-raft-titlebar\]\s*\{\s*padding-right: var\(--raft-frame-inset-end\);/);
  assert.match(rules, /html\[data-title-bar="overlay"\]:not\(\[data-fullscreen\]\) \[data-raft-overlay-titlebar\]\s*\{\s*--raft-titlebar-inset-end: var\(--raft-frame-inset-end\);/);
  assert.equal(/(^|\n)\[data-raft-titlebar\]\s*\{[^}]*padding-right/.test(rules), false, "no platform-blind right inset");
});

test("desktop macOS: a held traffic-light corner overrides the live geometry, declared after it so it wins (#proj-deskop:#12)", async () => {
  const rules = await css();
  const steady = rules.search(/html\[data-title-bar-steady\]\[data-title-bar-start="overlay"\]:not\(\[data-fullscreen\]\)\s*\{\s*--raft-frame-inset-start: var\(--raft-desktop-titlebar-start\);\s*--raft-frame-inset-end: 0px;/);
  assert.ok(steady > 0, "steady rule present");
  assert.ok(steady > rules.indexOf('html[data-title-bar="overlay"]:not([data-fullscreen]) {'), "after the end-inset rule");
  assert.ok(steady > rules.indexOf('html[data-title-bar-start="overlay"]:not([data-fullscreen]) {'), "after the start-inset rule");
});
