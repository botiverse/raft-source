#!/usr/bin/env node
/**
 * Package-boundary lint (task #30 PR-B, RFC v0.8 contract v3 §2/§10).
 *
 * The agent-facing `@botiverse/raft` and the human/Computer control-plane
 * `@botiverse/raft-computer` are SEPARATE entrypoints and MUST NOT import each
 * other in EITHER direction. PR #1573 was reverted for exactly this class
 * of package-boundary violation — this check is the durable guard so it
 * cannot regress silently. Lightweight static import scan (no heavy
 * tooling), runnable locally + in CI, by design (mirrors the repo's
 * inline-node check pattern, e.g. check-migrations.yml).
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FORBIDDEN = [
  // Matching is exact-or-subpath (`spec === banned || spec.startsWith(banned + "/")`),
  // so banning "@botiverse/raft" does NOT catch the allowed
  // "@botiverse/raft-daemon/core" import — different package, not a subpath.
  { dir: "packages/computer/src", banned: "@botiverse/raft", who: "@botiverse/raft-computer" },
  { dir: "packages/cli/src", banned: "@botiverse/raft-computer", who: "@botiverse/raft" },
];
const IMPORT_RE = /(?:import|export)[^;]*?from\s*["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;

function walk(d) {
  const out = [];
  if (!existsSync(d)) return out;
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(e)) out.push(p);
  }
  return out;
}

let violations = 0;
for (const { dir, banned, who } of FORBIDDEN) {
  for (const file of walk(join(repoRoot, dir))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? "";
      if (spec === banned || spec.startsWith(`${banned}/`)) {
        console.error(`BOUNDARY VIOLATION: ${who} file ${file} imports forbidden "${spec}"`);
        violations += 1;
      }
    }
  }
}
if (violations > 0) {
  console.error(`\n${violations} package-boundary violation(s). @botiverse/raft <-> @botiverse/raft-computer must stay decoupled (see #1573).`);
  process.exit(1);
}
console.log("✓ package boundary: @botiverse/raft <-> @botiverse/raft-computer decoupled (both directions).");
