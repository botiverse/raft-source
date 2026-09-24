#!/usr/bin/env node
/**
 * Layout-owner surfaces must NOT import `hostBridge`. Bridge availability is a
 * capability, not a layout property (@MingQi #922 review, #7). Layout embed is
 * governed by `embed=raft-settings-v1&shell=host` and `isHostShell()` in
 * `packages/web/src/embed.ts`. If a layout owner starts branching on
 * `hasRaftHostEventBridge()`, we get two mutually inconsistent authorities on
 * "am I embedded" — a real hazard, not a hypothetical one.
 *
 * Enforced list (surfaces that OWN what web renders):
 *   - packages/web/src/components/layout/**
 *   - packages/web/src/components/ui/PanelHeader.tsx
 *   - packages/web/src/embed.ts  (the layout authority itself)
 *
 * The event-bridge helpers belong to session-mutating call sites (authStore, and
 * later serverService / auth refresh). If a genuine future need for one of the
 * excluded surfaces arises, this file is where the exception lands — with a
 * comment naming the exception, not by silent addition.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const SRC = resolve(ROOT, "src");
const LAYOUT_OWNERS = [
  "components/layout",
  "components/ui/PanelHeader.tsx",
  "embed.ts",
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function underOwner(rel) {
  return LAYOUT_OWNERS.some((owner) =>
    owner.endsWith(".ts") || owner.endsWith(".tsx")
      ? rel === owner
      : rel === owner || rel.startsWith(owner + "/")
  );
}

const failures = [];
for (const abs of walk(SRC)) {
  const rel = abs.slice(SRC.length + 1);
  if (!underOwner(rel)) continue;
  const src = readFileSync(abs, "utf8");
  if (/from ["'][.\/]*(?:embed\/)?hostBridge["']/.test(src)) {
    failures.push(rel);
  }
}

if (failures.length > 0) {
  console.error("✗ host-bridge callers check failed: layout-owner surfaces must not import from embed/hostBridge:");
  for (const f of failures) console.error(`   - src/${f}`);
  console.error("");
  console.error("   Bridge availability is a capability, not a layout property. Layout embed is governed by");
  console.error("   `isHostShell()` from `embed.ts`; using `hasRaftHostEventBridge()` here creates a second");
  console.error("   authority on 'am I embedded' and the two will drift.");
  process.exit(1);
}

console.log("✓ host-bridge callers: no layout owner imports from embed/hostBridge");
