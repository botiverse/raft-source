#!/usr/bin/env node
// Memory regression check for the Computer bundles: has this commit made
// loading a runner (or the service) cost more JS heap than the last stable
// release did? Meant for CI's unit-computer job (.github/workflows/test.yml),
// which runs after merge to staging, on the daily cron and on merge-queue
// candidates, through scripts/ci/computer-heap-gate.sh.
//
//   node heap-gate.mjs measure --dir <build.mjs --bundle-only output> [--runs 3] --out <json> \
//     [--release <tag> --commit <sha> --allowance <that tree's heap-allowance.json>]
//   node heap-gate.mjs compare --head <json> --base <json> --base-release <tag> \
//     [--allowance heap-allowance.json] [--summary "$GITHUB_STEP_SUMMARY"]
//
// `measure` loads each bundle `--runs` times with measure-load-heap and keeps
// the median heap after its last load phase: the runner bundle
// (computer-bundle.cjs, through the daemon core) and the lite bundle
// (computer-lite-bundle.cjs, what the service and Computer commands run,
// through the CLI module).
//
// `compare` fails when a bundle's median grew over the release's by more than
// its limit (runner 8 MB, lite 3 MB), plus the allowances in this commit's
// heap-allowance.json that the release does not contain yet. The CI job builds
// the release from its own tag and lockfile and measures both on the same
// machine and Node, so the limit is always "growth since the last release".
// Once a release contains an allowance entry, it also contains the change the
// entry was for, so the entry stops counting: an allowance counts until the
// first release that includes it, however that release was cut.
//
// What stays unverified: the same as measure-load-heap (memory a runner
// accumulates after it connects, native memory, anything reached only at
// runtime).
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { measure, selectPhases } from "./measure-load-heap.mjs";

// The lite bundle is ~13 MB, so it gets a tighter limit than the ~45 MB runner.
export const BUNDLES = [
  { name: "runner", file: "computer-bundle.cjs", phases: "cli,daemon", allowanceKey: "runnerMB", limitMB: 8 },
  { name: "lite", file: "computer-lite-bundle.cjs", phases: "cli", allowanceKey: "liteMB", limitMB: 3 },
];
export const ALLOWANCE_FILE = "packages/computer/scripts/native/heap-allowance.json";
const STABLE_TAG = /^computer-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;

const round1 = (n) => Math.round(n * 10) / 10;
const signed = (n) => (n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1));
// Entries are matched by content: key order and whitespace do not matter.
const entryKey = (entry) => JSON.stringify(Object.keys(entry).sort().map((k) => [k, entry[k]]));

export function median(values) {
  if (values.length === 0) throw new Error("median of no values");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : round1((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Measure every bundle in `dir` `runs` times; keep the median heap of the last phase. */
export function measureDir(dir, runs, measureFn = measure) {
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer, got ${runs}`);
  const bundles = {};
  for (const bundle of BUNDLES) {
    const samples = [];
    let last;
    for (let i = 0; i < runs; i++) {
      const result = measureFn(join(dir, bundle.file), { phases: selectPhases(bundle.phases), top: 0 });
      last = result;
      samples.push(result.phases[result.phases.length - 1].heapMB);
    }
    bundles[bundle.name] = {
      phase: last.phases[last.phases.length - 1].phase,
      heapMB: median(samples),
      samples,
      zod: last.zod.total,
      sourceChars: last.source.chars,
    };
  }
  return { node: process.versions.node, runs, bundles };
}

/** Validate heap-allowance.json: every entry says why and how much. */
export function parseAllowances(json) {
  if (!json || !Array.isArray(json.allowances)) throw new Error(`${ALLOWANCE_FILE}: expected { "allowances": [...] }`);
  return json.allowances.map((entry, i) => {
    const where = `${ALLOWANCE_FILE} allowances[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${where}: expected an object`);
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") throw new Error(`${where}: "reason" is required`);
    for (const { allowanceKey } of BUNDLES) {
      const mb = entry[allowanceKey] ?? 0;
      if (typeof mb !== "number" || !Number.isFinite(mb) || mb < 0) throw new Error(`${where}: "${allowanceKey}" must be a number of MB >= 0`);
    }
    return entry;
  });
}

export function compare(head, base, { baseRelease, allowances = [] }) {
  if (!STABLE_TAG.test(baseRelease)) throw new Error(`--base-release must be a stable tag, got ${baseRelease}`);
  if (base.release !== undefined && base.release !== baseRelease) {
    throw new Error(`base measurement is of ${base.release}, not ${baseRelease}`);
  }
  if (head.node !== base.node) {
    throw new Error(`head was measured on Node ${head.node} but ${baseRelease} on Node ${base.node}; compare on one Node`);
  }
  const inRelease = new Set((base.allowances ?? []).map(entryKey));
  const active = allowances.filter((a) => !inRelease.has(entryKey(a)));
  const absorbed = allowances.filter((a) => inRelease.has(entryKey(a)));
  const rows = BUNDLES.map(({ name, allowanceKey, limitMB }) => {
    const h = head.bundles[name];
    const b = base.bundles[name];
    if (!h || !b) throw new Error(`missing ${name} bundle measurement (head: ${Boolean(h)}, ${baseRelease}: ${Boolean(b)})`);
    const allowanceMB = round1(active.reduce((sum, a) => sum + (a[allowanceKey] ?? 0), 0));
    const deltaMB = round1(h.heapMB - b.heapMB);
    const totalLimitMB = round1(limitMB + allowanceMB);
    return {
      name,
      phase: h.phase,
      baseMB: b.heapMB,
      headMB: h.heapMB,
      deltaMB,
      allowanceMB,
      limitMB: totalLimitMB,
      zodDelta: h.zod - b.zod,
      ok: deltaMB <= totalLimitMB,
    };
  });
  return { baseRelease, baseCommit: base.commit, node: head.node, rows, active, absorbed, ok: rows.every((r) => r.ok) };
}

export function summaryMarkdown(c) {
  const at = c.baseCommit ? ` (${c.baseCommit.slice(0, 10)})` : "";
  const lines = [
    `### Computer bundle heap vs ${c.baseRelease}${at}, Node ${c.node}`,
    "",
    `Loaded JS heap after a full GC, median of each side's runs. The change is cumulative over everything merged since ${c.baseRelease}.`,
    "",
    `| bundle | ${c.baseRelease} | this commit | change | limit | zod instances | result |`,
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of c.rows) {
    const limit = r.allowanceMB > 0 ? `+${r.limitMB} MB (incl. ${r.allowanceMB} allowed)` : `+${r.limitMB} MB`;
    lines.push(
      `| ${r.name} (to ${r.phase}) | ${r.baseMB} MB | ${r.headMB} MB | ${signed(r.deltaMB)} MB | ${limit} | ${r.zodDelta >= 0 ? "+" : ""}${r.zodDelta} | ${r.ok ? "ok" : "**over**"} |`,
    );
  }
  for (const a of c.active) lines.push("", `Allowance in effect: ${a.reason}`);
  if (c.absorbed.length > 0) {
    lines.push("", `${c.absorbed.length} allowance(s) in ${ALLOWANCE_FILE} are already part of ${c.baseRelease} and no longer count; they can be removed.`);
  }
  if (!c.ok) {
    lines.push(
      "",
      `If the increase is intended, the PR that causes it adds an entry to ${ALLOWANCE_FILE} with the size and the reason.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const out = {};
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

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const USAGE = [
  "usage: heap-gate.mjs measure --dir <bundle dir> [--runs 3] --out <json> [--release <tag> --commit <sha> --allowance <json>]",
  "       heap-gate.mjs compare --head <json> --base <json> --base-release <tag> [--allowance <json>] [--summary <file>]",
].join("\n");

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "measure" && typeof args.dir === "string" && typeof args.out === "string") {
    const result = measureDir(resolve(args.dir), Number(args.runs ?? 3));
    for (const [name, b] of Object.entries(result.bundles)) {
      console.log(`${name}: heap ${b.heapMB} MB after ${b.phase} (runs ${b.samples.join(", ")}), zod ${b.zod}`);
    }
    if (typeof args.release === "string") result.release = args.release;
    if (typeof args.commit === "string") result.commit = args.commit;
    // A release from before heap-allowance.json existed contains no allowances.
    if (typeof args.allowance === "string") {
      result.allowances = existsSync(args.allowance) ? parseAllowances(readJson(args.allowance)) : [];
    }
    writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "compare" && typeof args.head === "string" && typeof args.base === "string" && typeof args["base-release"] === "string") {
    const allowances = typeof args.allowance === "string" ? parseAllowances(readJson(args.allowance)) : [];
    const c = compare(readJson(args.head), readJson(args.base), { baseRelease: args["base-release"], allowances });
    const markdown = summaryMarkdown(c);
    console.log(markdown);
    if (typeof args.summary === "string") appendFileSync(args.summary, markdown);
    for (const r of c.rows.filter((row) => !row.ok)) {
      console.log(
        `::error title=Computer ${r.name} heap regression::${r.name} bundle loads ${r.headMB} MB of JS heap vs ${r.baseMB} MB in ${c.baseRelease} ` +
          `(${signed(r.deltaMB)} MB since that release, limit +${r.limitMB} MB${r.allowanceMB > 0 ? ` incl. ${r.allowanceMB} MB allowed` : ""}). ` +
          `If intended, add an allowance to ${ALLOWANCE_FILE} with the size and reason.`,
      );
    }
    return c.ok ? 0 : 1;
  }
  console.error(USAGE);
  return 2;
}

// Compare real paths: on macOS /tmp is a symlink to /private/tmp.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main();
}
