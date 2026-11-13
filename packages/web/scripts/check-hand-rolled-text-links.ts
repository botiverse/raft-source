#!/usr/bin/env node
/**
 * An underlined-text control is raft-ui's `TextLink`, never a hand-rolled one.
 *
 * Why: Raft Chat used to draw this control three ways (its own TextLink,
 * raft-ui's Button variant="link", and about 25 buttons and links with their
 * own `underline decoration-[1.5px] underline-offset-[3px]` classes). That is
 * how "Later" ended up a dashed mono one-off while Log out stayed grey. raft-ui
 * 0.8.0 owns the control (raft-design text-link.md): muted on its own, strong
 * inside a sentence.
 *
 * Heuristic: a line that underlines at rest (a bare `underline`, not
 * `hover:underline`) together with the TextLink signature
 * (`decoration-[1.5px]` or `underline-offset-[3px]`). Prose links in rendered
 * content use the link blue and a 2px underline, so they don't match.
 *
 * What it can't see (known limits, not silent passes):
 * - a bare `underline` with no signature, such as the plain underlined Edit
 *   that BulkChangeModelDialog had;
 * - classes split across lines, e.g. a multi-line `cn()` or array;
 * - anything in an ALLOWED file: those are skipped whole, not line by line.
 * Review still has to catch those.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(new URL(".", import.meta.url).pathname, "..", "src");

// Underlined text that is not a control, each with its reason.
const ALLOWED = new Map([
  ["components/channel/ChannelDescription.tsx", "a URL shown as data, with a hint-coloured underline"],
  ["features/apps/connected-apps/ConnectedAppUrlLink.tsx", "ConnectedAppUrlLink: an app's URL shown as data"],
]);
const SKIP_DIRS = new Set(["raftbench"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...walk(p));
    } else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

const AT_REST_UNDERLINE = /(?:^|[\s"'`])underline(?=[\s"'`]|$)/;
const SIGNATURE = /decoration-\[1\.5px\]|underline-offset-\[3px\]/;

const offenders = [];
for (const file of walk(SRC)) {
  const rel = file.slice(SRC.length + 1);
  if (ALLOWED.has(rel)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
    if (AT_REST_UNDERLINE.test(line) && SIGNATURE.test(line)) {
      offenders.push(`${rel}:${index + 1}`);
    }
  });
}

if (offenders.length) {
  console.error(
    "✗ hand-rolled underlined-text control; use raft-ui <TextLink> (muted on its own, variant=\"strong\" in a sentence):\n" +
      offenders.map((o) => `  ${o}`).join("\n"),
  );
  process.exit(1);
}
console.log("✓ text link check: no hand-rolled underlined-text controls");
