// Import-cycle ratchet (decycle R0, #wg-raft-computer:18ab6541).
//
// The package once carried a single 21-module / 210-pair strongly-connected
// component through the lib/api facade (facade importing presenter files that
// import the facade back). ESM tolerates such cycles until an
// initialization-order access bites (partially-initialized module during
// circular init), and every lib consumer (Electron app, future SDK)
// transitively drags the whole presenter layer in. This test pins the
// remaining co-cycle set and only lets it SHRINK.
//
// Policy:
//   - Edges are ALL static `from`-imports/re-exports, including `import type`
//     (type-only coupling is still architecture; put shared types in the pure
//     layer — see ChildExitClass in lib/runnerStateMachine.ts).
//   - The baseline is asserted with strict set equality:
//       * a pair found but not baselined  → you introduced a cycle. Break it
//         by sinking shared logic below both modules (never by re-exporting
//         through the presenter layer).
//       * a pair baselined but not found  → you broke a cycle. Tighten the
//         ratchet: delete the pair from BASELINE_PAIRS in the same PR.
//
// The remaining baseline is the setup flagship family — scheduled to dissolve
// in the setup→services/setup.ts rework (PR-2 of the decycle plan).
import assert from "node:assert/strict";
import { test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";

const SRC = resolve(import.meta.dirname);

const BASELINE_PAIRS: readonly string[] = [
  "attach <-> lib/api",
  "attach <-> login",
  "attach <-> setup",
  "attach <-> startStop",
  "lib/api <-> login",
  "lib/api <-> setup",
  "lib/api <-> startStop",
  "login <-> setup",
  "login <-> startStop",
  "setup <-> startStop",
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSourceFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function moduleId(absPath: string): string {
  return relative(SRC, absPath).split(sep).join("/").replace(/\.ts$/, "");
}

function buildGraph(): Map<string, string[]> {
  const files = listSourceFiles(SRC);
  const known = new Set(files.map(moduleId));
  const graph = new Map<string, string[]>();
  const IMPORT_RE = /^\s*(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']/gm;
  for (const file of files) {
    const id = moduleId(file);
    const text = readFileSync(file, "utf8");
    const deps = new Set<string>();
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = (m[1] as string).replace(/\.js$/, "");
      const target = relative(SRC, resolve(dirname(file), spec)).split(sep).join("/");
      if (known.has(target)) deps.add(target);
    }
    graph.set(id, [...deps]);
  }
  return graph;
}

/** Tarjan SCC — returns co-cycle pairs "a <-> b" (a < b) for every pair of
 *  modules sharing a strongly-connected component of size > 1. */
function coCyclePairs(graph: Map<string, string[]>): string[] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const sccs: string[][] = [];

  function strongconnect(v: string): void {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) sccs.push(scc.sort());
    }
  }

  for (const v of graph.keys()) if (!idx.has(v)) strongconnect(v);

  const pairs: string[] = [];
  for (const scc of sccs) {
    for (let i = 0; i < scc.length; i++) {
      for (let j = i + 1; j < scc.length; j++) pairs.push(`${scc[i]} <-> ${scc[j]}`);
    }
  }
  return pairs.sort();
}

test("import-cycle ratchet: co-cycle pairs exactly match the shrinking baseline", () => {
  const found = coCyclePairs(buildGraph());
  const baseline = new Set(BASELINE_PAIRS);
  const foundSet = new Set(found);

  const introduced = found.filter((p) => !baseline.has(p));
  const broken = BASELINE_PAIRS.filter((p) => !foundSet.has(p));

  assert.deepEqual(
    introduced,
    [],
    `NEW import cycle(s) introduced:\n  ${introduced.join("\n  ")}\n` +
      `Break the cycle by sinking the shared logic below both modules ` +
      `(lib/ pure state or services/ domain service) — do NOT baseline it. ` +
      `See the decycle doctrine in #wg-raft-computer:18ab6541.`,
  );
  assert.deepEqual(
    broken,
    [],
    `Cycle(s) broken (good!) but the ratchet is stale — remove from BASELINE_PAIRS:\n  ${broken.join("\n  ")}`,
  );
});

test("import-cycle ratchet: detector sees the package (anti-empty-glob guard)", () => {
  const graph = buildGraph();
  // The scan must cover the real tree — a broken path/glob would silently
  // pass the ratchet with zero modules (same disease as the #3652 empty-skip
  // false-green). 40 non-test modules is far below the real count (~60) but
  // far above any plausible misconfiguration.
  assert.ok(graph.size >= 40, `expected >=40 modules, saw ${graph.size}`);
  assert.ok(graph.has("lib/api") && graph.has("setup"), "known hub modules missing from scan");
});
