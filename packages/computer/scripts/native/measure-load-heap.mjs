#!/usr/bin/env node
// Measure what loading the raft-computer bundle costs in memory, without
// starting a runner or connecting anywhere.
//
// When to run: before/after a change meant to shrink a runner's resident
// memory (lazy-loading a dependency, bundling changes, schema changes), on the
// actual `computer-bundle.cjs` artifact:
//
//   pnpm --filter @botiverse/raft-computer build:deps
//   node packages/computer/scripts/native/build.mjs --bundle-only --work-dir /tmp/sea
//   node packages/computer/scripts/native/measure-load-heap.mjs \
//     --bundle /tmp/sea/computer-bundle.cjs [--json out.json] \
//     [--baseline before.json [--max-regress-mb 8]] [--top 25]
//
// The service process and Computer commands run `computer-lite-bundle.cjs`,
// which has no daemon: measure it with `--phases cli`.
//
// heap-gate.mjs (with scripts/ci/computer-heap-gate.sh) uses it to check a
// commit's bundles against the last stable release's, failing on more than 8 MB.
//
// What it proves: for each load phase (bundle evaluated -> `raft-computer` CLI
// module -> daemon core module, i.e. what a `__run` runner loads before it
// connects), the JS heap after a full GC, and how many zod schema instances
// were created, attributed to the module that created them (the first stack
// frame outside zod). It also reports the bundle's source-string cost: V8 keeps
// the whole script source on the heap, at one byte per char only when every
// char is Latin-1, otherwise two.
//
// What stays unverified: memory a runner accumulates after it connects
// (sessions, caches, lazily built schemas such as the shared contract
// schemas), native/malloc memory, and anything only reached at runtime. Node
// and V8 versions matter: compare numbers produced by the same Node major.
//
// How: a copy of the bundle gets a counter in every zod `$constructor` and an
// export of the `__esm` init functions of the phase modules. A child process
// with `--expose-gc` and a throwaway HOME requires that copy (the entry's main
// guard does not fire outside a SEA), then runs the phases in order.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// `module` may list alternatives: the SEA build bundles the daemon either from
// its prebuilt dist or from source.
export const DEFAULT_PHASES = [
  { name: "cli", module: "packages/computer/src/cli.ts" },
  { name: "daemon", module: ["packages/daemon/src/core.ts", "packages/daemon/dist/core.js"] },
];

/** `--phases cli,daemon` -> the matching DEFAULT_PHASES, in their load order. */
export function selectPhases(spec) {
  if (spec === undefined) return DEFAULT_PHASES;
  const names = String(spec).split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !DEFAULT_PHASES.some((p) => p.name === name));
  if (unknown.length > 0) throw new Error(`unknown phase(s): ${unknown.join(", ")}; known: ${DEFAULT_PHASES.map((p) => p.name).join(", ")}`);
  return DEFAULT_PHASES.filter((p) => names.includes(p.name));
}

// esbuild's (non-minified) module boundary comment, e.g. `// packages/shared/src/x.ts`.
const MODULE_MARKER = /^\/\/ ((?:packages|node_modules|\.\.)\/\S+\.(?:[cm]?[jt]sx?))$/;
// zod v4 core's `$constructor(name, initializer, params)`: every schema and
// check instance is created through the inner constructor holding ZOD_CTOR.
// Whitespace-tolerant: the SEA build minifies whitespace (identifiers stay,
// `new Definition()` prints as `new Definition`). zod 4.6 builds the Parent
// case through a helper (`newError(Definition)`), so either form matches.
const ZOD_CTOR = /const inst\s*=\s*params\?\.Parent\s*\?\s*(?:new Definition(?:\(\))?|[\w$]+\(Definition\))\s*:\s*this;/g;
const ZOD_SIGNATURE = /function \$constructor\d*\(([\w$]+),/g;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const toMB = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

export function sourceStringCost(src) {
  let nonLatin1 = 0;
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) > 0xff) nonLatin1++;
  const bytesPerChar = nonLatin1 > 0 ? 2 : 1;
  return { chars: src.length, nonLatin1, bytesPerChar, mb: toMB(src.length * bytesPerChar) };
}

export function instrument(src, phases = DEFAULT_PHASES) {
  // A bundle can inline more than one zod copy; count instances from all of them.
  const signatures = [...src.matchAll(ZOD_SIGNATURE)];
  const ctors = [...src.matchAll(ZOD_CTOR)];
  if (ctors.length === 0) throw new Error("zod $constructor not found; is zod v4 bundled?");
  let out = "";
  let from = 0;
  ctors.forEach((ctor, copy) => {
    // esbuild may rename the schema-name parameter; read it from the signature.
    const signature = signatures.filter((s) => s.index < ctor.index).pop();
    if (!signature) throw new Error("zod $constructor shape changed: signature not found");
    const end = ctor.index + ctor[0].length;
    out += `${src.slice(from, end)} globalThis.__zodMeasure?.(${signature[1]}, ${copy});`;
    from = end;
  });
  out += src.slice(from);
  // esbuild names the init functions; find them by the module path they wrap.
  const inits = phases.map(({ name, module }) => {
    const candidates = [module].flat();
    const m = candidates
      .map((mod) => out.match(new RegExp(`(?:var\\s+|,\\s*)(init_[\\w$]+)\\s*=\\s*__esm\\(\\{\\s*"${escapeRegExp(mod)}"\\(\\)`)))
      .find(Boolean);
    if (!m) throw new Error(`phase module ${candidates.join(" | ")} is not lazily wrapped in this bundle`);
    return `${JSON.stringify(name)}: () => ${m[1]}()`;
  });
  return `${out}\n;module.exports.__measurePhases = { ${inits.join(", ")} };\n`;
}

// Two passes, because keeping a stack per instance costs tens of MB of heap:
// MEASURE_STACKS unset only counts (its heap numbers are reported), set
// records the stacks used for attribution (its heap numbers are discarded).
const DRIVER = String.raw`
const fs = require("node:fs");
const records = [];
let count = 0;
globalThis.__zodMeasure = process.env.MEASURE_STACKS
  ? (name, copy) => {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 60;
      const stack = new Error().stack;
      Error.stackTraceLimit = limit;
      records.push([name, copy, stack]);
      count++;
    }
  : () => {
      count++;
    };
const snap = (phase) => {
  gc();
  gc();
  const m = process.memoryUsage();
  return { phase, zod: count, heap: m.heapUsed, rss: m.rss, external: m.external };
};
const phases = [snap("empty")];
const bundle = require(process.env.MEASURE_BUNDLE);
phases.push(snap("evaluate"));
for (const [name, init] of Object.entries(bundle.__measurePhases)) {
  init();
  phases.push(snap(name));
}
fs.writeFileSync(process.env.MEASURE_OUT, JSON.stringify({ phases, records }));
process.exit(0);
`;

export function packageOf(mod) {
  if (mod.startsWith("packages/")) {
    const [, pkg, sub] = mod.split("/");
    return sub === "dist" ? `packages/${pkg} (prebuilt dist)` : `packages/${pkg}`;
  }
  if (!mod.includes("node_modules/")) return mod;
  const segs = mod.split("/node_modules/").pop().split("/");
  return segs[0].startsWith("@") ? `${segs[0]}/${segs[1]}` : segs[0];
}

const hasModuleMarkers = (src) => src.split("\n").some((line) => MODULE_MARKER.test(line));

// Returns null when the bundle has no module markers (whitespace-minified
// bundles drop them and put everything on one line): totals still hold, but
// per-module attribution needs an unminified build of the same sources.
export function attribute(instrumentedSrc, instrumentedPath, records) {
  const starts = [];
  const names = [];
  instrumentedSrc.split("\n").forEach((line, i) => {
    const m = MODULE_MARKER.exec(line);
    if (m) {
      starts.push(i + 1);
      names.push(m[1]);
    }
  });
  if (starts.length === 0) return null;
  const moduleAt = (line) => {
    let lo = 0;
    let hi = starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= line) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found < 0 ? null : names[found];
  };
  const frameRe = new RegExp(`${escapeRegExp(instrumentedPath)}:(\\d+):\\d+`);
  return records.map(([kind, copy, stack]) => {
    let module = "<unattributed>";
    for (const frame of stack.split("\n").slice(2)) {
      const m = frameRe.exec(frame);
      const mod = m && moduleAt(Number(m[1]));
      if (!mod || /\/zod@[^/]+\/|\/node_modules\/zod\//.test(mod)) continue;
      module = mod;
      break;
    }
    return { kind, copy, module, pkg: packageOf(module) };
  });
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) counts.set(item[key], (counts.get(item[key]) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export function measure(bundlePath, { phases = DEFAULT_PHASES, top = 25 } = {}) {
  const src = readFileSync(bundlePath, "utf8");
  const work = mkdtempSync(join(tmpdir(), "measure-load-heap-"));
  try {
    const instrumentedPath = join(work, "bundle.instrumented.cjs");
    const instrumented = instrument(src, phases);
    writeFileSync(instrumentedPath, instrumented);
    writeFileSync(join(work, "driver.cjs"), DRIVER);
    const runDriver = (stacks) => {
      const home = join(work, "home");
      const outPath = join(work, "out.json");
      const env = { ...process.env, HOME: home, USERPROFILE: home, MEASURE_BUNDLE: instrumentedPath, MEASURE_OUT: outPath };
      if (stacks) env.MEASURE_STACKS = "1";
      else delete env.MEASURE_STACKS;
      const run = spawnSync(process.execPath, ["--expose-gc", join(work, "driver.cjs")], { env, stdio: ["ignore", "inherit", "inherit"] });
      if (run.status !== 0) throw new Error(`measurement child exited with ${run.status ?? run.signal}`);
      return JSON.parse(readFileSync(outPath, "utf8"));
    };
    const out = runDriver(false);
    const attributed = hasModuleMarkers(instrumented)
      ? attribute(instrumented, instrumentedPath, runDriver(true).records)
      : null;
    return {
      bundle: bundlePath,
      node: process.versions.node,
      source: sourceStringCost(src),
      phases: out.phases.map((p) => ({
        phase: p.phase,
        zod: p.zod,
        heapMB: toMB(p.heap),
        rssMB: toMB(p.rss),
        externalMB: toMB(p.external),
      })),
      zod: {
        total: out.phases[out.phases.length - 1].zod,
        byPackage: attributed && Object.fromEntries(countBy(attributed, "pkg")),
        topModules: attributed && countBy(attributed, "module").slice(0, top),
      },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function compare(current, baseline, maxRegressMB) {
  const last = (r) => r.phases[r.phases.length - 1];
  const heapDeltaMB = toMB((last(current).heapMB - last(baseline).heapMB) * 1048576);
  return { heapDeltaMB, zodDelta: current.zod.total - baseline.zod.total, ok: heapDeltaMB <= maxRegressMB };
}

function report(r) {
  const fixed = (n) => n.toFixed(1);
  const s = r.source;
  console.log(`bundle: ${r.bundle} (node ${r.node})`);
  console.log(
    `source string: ${s.chars.toLocaleString("en-US")} chars, ${s.nonLatin1} beyond Latin-1 -> ` +
      `${s.bytesPerChar} byte/char, ~${s.mb} MB on the heap`,
  );
  console.log("\nphase        heap MB    rss MB  external MB  zod instances");
  for (const p of r.phases) {
    console.log(
      `${p.phase.padEnd(10)} ${fixed(p.heapMB).padStart(9)} ${fixed(p.rssMB).padStart(9)} ` +
        `${fixed(p.externalMB).padStart(12)} ${String(p.zod).padStart(14)}`,
    );
  }
  if (!r.zod.byPackage) {
    console.log(`\nzod instances: ${r.zod.total}. No module markers (minified bundle): measure an unminified build for attribution.`);
    return;
  }
  console.log(`\nzod instances by package (total ${r.zod.total}):`);
  for (const [pkg, n] of Object.entries(r.zod.byPackage)) {
    console.log(`${String(n).padStart(7)} ${`${Math.round((100 * n) / r.zod.total)}%`.padStart(5)}  ${pkg}`);
  }
  console.log("\ntop creating modules:");
  for (const [mod, n] of r.zod.topModules) console.log(`${String(n).padStart(7)}  ${mod}`);
}

function parseArgs(argv) {
  const out = { top: "25", "max-regress-mb": "8" };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[argv[i].slice(2)] = next;
      i++;
    } else {
      out[argv[i].slice(2)] = true;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.bundle !== "string") {
    console.error(
      "usage: measure-load-heap.mjs --bundle <computer-bundle.cjs> [--phases cli,daemon] [--json out.json] [--baseline base.json] [--max-regress-mb 8] [--top 25]",
    );
    return 2;
  }
  const result = measure(resolve(args.bundle), { phases: selectPhases(args.phases), top: Number(args.top) });
  report(result);
  if (typeof args.json === "string") writeFileSync(args.json, `${JSON.stringify(result, null, 2)}\n`);
  if (typeof args.baseline !== "string") return 0;
  const max = Number(args["max-regress-mb"]);
  const diff = compare(result, JSON.parse(readFileSync(args.baseline, "utf8")), max);
  const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
  console.log(`\nvs baseline: loaded heap ${sign(diff.heapDeltaMB)} MB, zod instances ${sign(diff.zodDelta)}`);
  if (!diff.ok) {
    console.error(`FAIL: loaded heap grew by ${diff.heapDeltaMB} MB (more than ${max} MB)`);
    return 1;
  }
  return 0;
}

// Compare real paths: on macOS /tmp is a symlink to /private/tmp.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main();
}
