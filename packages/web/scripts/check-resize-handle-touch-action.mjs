#!/usr/bin/env node
/**
 * Every pointer-drag resize handle must set `touch-none` (CSS `touch-action: none`).
 *
 * Why: a `cursor-col-resize` / `cursor-row-resize` element wired with Pointer Events
 * (`onPointerDown` + `setPointerCapture`) works with a mouse but NOT with touch unless
 * it also declares `touch-action: none`. Without it, the browser's compositor claims
 * the touch for scrolling BEFORE the JS runs and fires `pointercancel`, so the drag
 * never tracks. `e.preventDefault()` on pointerdown does not help — only the CSS
 * property does. This bit every panel divider on touch devices wide enough to render
 * the `md:` handle (foldable / tablet / landscape) — task #38, @artin.
 *
 * The fix already existed in-repo (the workspace-rails handles had `touch-none`); it
 * just wasn't applied uniformly. This detector makes uniform application mandatory so
 * the next hand-rolled handle can't silently ship the same broken-on-touch state.
 *
 * Heuristic: any JSX className containing `cursor-col-resize` or `cursor-row-resize`
 * must also contain `touch-none` on the same className string. A handle that
 * legitimately wants native touch behavior is not a "resize handle" and should not use
 * the resize cursor; if a real exception arises, annotate it and list it here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(new URL(".", import.meta.url).pathname, "..", "src");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

// Match a className="..."/className={`...`} string containing a resize cursor.
const CLASSNAME_RE = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;

const failures = [];
for (const abs of walk(SRC)) {
  const src = readFileSync(abs, "utf8");
  let m;
  while ((m = CLASSNAME_RE.exec(src)) !== null) {
    const classes = m[1] ?? m[2] ?? "";
    if (!/\bcursor-(?:col|row)-resize\b/.test(classes)) continue;
    if (/\btouch-none\b/.test(classes)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    failures.push(`${abs.slice(SRC.length + 1)}:${line}`);
  }
}

if (failures.length) {
  console.error("✗ resize-handle touch-action check failed — these drag handles are broken on touch:\n");
  for (const f of failures) console.error(`   - src/${f}`);
  console.error("\n   A `cursor-col-resize` / `cursor-row-resize` handle wired with Pointer Events");
  console.error("   MUST also set `touch-none`, or touch devices claim the gesture for scroll and");
  console.error("   the drag never tracks (task #38). Add `touch-none` to the className.");
  process.exit(1);
}
console.log("✓ resize-handle touch-action: every resize handle sets touch-none");
