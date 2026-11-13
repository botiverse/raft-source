#!/usr/bin/env node
/**
 * A Banner takes no horizontal margin: inset it with padding on a wrapper.
 *
 * Why: raft-ui's Banner root is `w-full`. A margin on it adds to that width
 * instead of taking from it, so `mx-4` pushes the Banner 16px past its
 * container's right edge, where it is clipped (no right corner, no right
 * ring). The search page's 30-day notice shipped like that (task #8): it looks
 * almost right in a screenshot, since only the right edge is missing.
 *
 * Heuristic: a `<Banner` or `<AppBanner` opening tag whose static
 * `className="..."` (before any nested tag) has an `m-`, `mx-`, `ml-`, `mr-`,
 * `ms-` or `me-` class, with any variant prefix, fails. `mx-auto` and
 * `m-auto`, which centre a Banner with a max width, are fine; so are the
 * vertical `mt-`, `mb-` and `my-`. Static, so it cannot see a class built at
 * runtime or a `className` after a nested tag; that is the known limit, not a
 * silent pass.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(new URL(".", import.meta.url).pathname, "..", "src");
const OPENING_CLASS = /<(?:App)?Banner(?=[\s/>])[^<]*?className="([^"]*)"/g;
const HORIZONTAL_MARGIN = /(?:^|\s)!?(?:[^\s:]+:)*-?m[xlrse]?-(?!auto(?:!|\s|$))\S+/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk(SRC)) {
  const source = readFileSync(file, "utf8");
  for (const m of source.matchAll(OPENING_CLASS)) {
    if (!HORIZONTAL_MARGIN.test(m[1])) continue;
    const line = source.slice(0, m.index).split("\n").length;
    offenders.push(`${file.slice(SRC.length + 1)}:${line} — className="${m[1]}"; put the inset on a wrapper (e.g. <div className="px-4">)`);
  }
}

if (offenders.length) {
  console.error("✗ horizontal margin on a Banner (it is w-full, so it overflows):\n" + offenders.map((o) => `  ${o}`).join("\n"));
  process.exit(1);
}
console.log("✓ banner margin check: no horizontal margin on a Banner");
