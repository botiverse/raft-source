#!/usr/bin/env node
/**
 * The app lint (`.oxlintrc.json` over src and visual-testing) and the
 * `react/refs` ratchet, from ONE oxlint run.
 *
 * `react/refs` reports a ref's `.current` read or written while rendering.
 * There are too many to fix at once, so the rule is "warn" in `.oxlintrc.json`
 * and this script holds each file to its count in refs-ratchet-baseline.json:
 *
 * - a file over its baseline, or a file with findings that is not listed, fails;
 * - a file under its baseline fails until the baseline is lowered in the same
 *   PR (`--write`), so a fixed finding can't be quietly replaced later;
 * - the count only goes down: `--write` refuses while any file is over.
 *
 * The lint used to be `oxlint --react-plugin --max-warnings=0 src
 * visual-testing`. It is the same run here with `-f json`, read by this script
 * instead of a second oxlint pass for the ratchet. Every diagnostic that is
 * not `react/refs` fails, error or warning, as `--max-warnings=0` did; they
 * are printed with file, line, rule and help. A `react/refs` diagnostic fails
 * only through the ratchet, whatever its severity.
 *
 * Fails closed: oxlint exiting with anything but 0 or 1, output that is not
 * its JSON report, a report with no files, and an exit code that disagrees
 * with the report all fail.
 *
 * Required gate: chained into the package `lint` script.
 *
 *   node --import @oxc-node/core/register scripts/lint-app.ts
 *   ... --write          lower the baseline to this run, only when nothing grew
 *   ... --report <file>  read an oxlint JSON report instead of running oxlint
 *
 * A moved or renamed file keeps its findings under a new path: move its entry
 * in the baseline by hand (`--write` won't add a path).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_BASELINE = resolve(SCRIPT_DIR, "refs-ratchet-baseline.json");
/** The rule as `.oxlintrc.json` names it, and as oxlint's report does. */
export const RULE = "react/refs";
export const RULE_CODE = "react(refs)";
/** What `lint` runs the app config on, and the flags it runs it with. */
export const OXLINT_ARGS = ["--react-plugin", "-f", "json", "src", "visual-testing"];
const WRITE_COMMAND = "pnpm --filter @botiverse/raft-web run lint:refs-baseline";
/** oxlint's report is a few hundred KB; this is room, not a target. */
const MAX_REPORT_BYTES = 256 * 1024 * 1024;

export type Baseline = Record<string, number>;

export interface Diagnostic {
  message: string;
  /** `plugin(rule)`; absent on a parse error. */
  code?: string;
  severity: string;
  help?: string;
  filename: string;
  labels?: Array<{ label?: string; span?: { line?: number; column?: number } }>;
}

export interface Report {
  diagnostics: Diagnostic[];
  numberOfFiles: number;
}

/** oxlint's `-f json` output; throws with the reason when it is not that. */
export function parseReport(output: string): Report {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("oxlint's output is not JSON");
  }
  const report = parsed as { diagnostics?: unknown; number_of_files?: unknown } | null;
  if (typeof report !== "object" || report === null || !Array.isArray(report.diagnostics)) {
    throw new Error("oxlint's report has no diagnostics list");
  }
  if (typeof report.number_of_files !== "number" || report.number_of_files <= 0) {
    throw new Error(`oxlint's report covers no files (number_of_files: ${JSON.stringify(report.number_of_files)})`);
  }
  for (const diagnostic of report.diagnostics as Array<Partial<Diagnostic> | null>) {
    if (typeof diagnostic !== "object" || diagnostic === null || typeof diagnostic.filename !== "string" || typeof diagnostic.severity !== "string") {
      throw new Error(`oxlint's report has a diagnostic with no filename or severity: ${JSON.stringify(diagnostic)}`);
    }
  }
  return { diagnostics: report.diagnostics as Diagnostic[], numberOfFiles: report.number_of_files };
}

const posix = (path: string) => path.split("\\").join("/").replace(/^\.\//, "");

/** `path:line:column` of a diagnostic's first label. */
export function locationOf(diagnostic: Diagnostic): string {
  const span = diagnostic.labels?.[0]?.span;
  const path = posix(diagnostic.filename);
  return span?.line === undefined ? path : `${path}:${span.line}:${span.column ?? 1}`;
}

const byLocation = (a: Diagnostic, b: Diagnostic) =>
  posix(a.filename).localeCompare(posix(b.filename)) ||
  (a.labels?.[0]?.span?.line ?? 0) - (b.labels?.[0]?.span?.line ?? 0) ||
  (a.labels?.[0]?.span?.column ?? 0) - (b.labels?.[0]?.span?.column ?? 0);

/** The report split into the ratcheted rule's findings and everything else. */
export function splitDiagnostics(diagnostics: Diagnostic[]): { refs: Diagnostic[]; others: Diagnostic[] } {
  const refs: Diagnostic[] = [];
  const others: Diagnostic[] = [];
  for (const diagnostic of diagnostics) (diagnostic.code === RULE_CODE ? refs : others).push(diagnostic);
  return { refs: refs.sort(byLocation), others: others.sort(byLocation) };
}

/** Findings per package-relative path. */
export function countByFile(diagnostics: Diagnostic[]): Baseline {
  const counts: Baseline = {};
  for (const diagnostic of diagnostics) {
    const path = posix(diagnostic.filename);
    counts[path] = (counts[path] ?? 0) + 1;
  }
  return counts;
}

/** Files over their baseline, or with findings and not listed; each names where its findings are. */
export function findGrowth(current: Baseline, baseline: Baseline, refs: Diagnostic[] = []): string[] {
  return Object.entries(current)
    .filter(([path, count]) => count > (baseline[path] ?? 0))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, count]) => {
      const where = refs.filter((diagnostic) => posix(diagnostic.filename) === path).map((diagnostic) => locationOf(diagnostic).slice(path.length + 1));
      const listed = path in baseline ? `baseline ${baseline[path]}` : "not in the baseline (0)";
      return (
        `${path}: ${count} ${RULE} finding(s), ${listed}.` +
        (where.length > 0 ? ` Now at line:column ${where.join(", ")}.` : "") +
        " Read or write a ref's .current in an effect or an event handler, not while rendering."
      );
    });
}

/** Baseline entries above what the run found: lower them with `--write`. */
export function findStale(current: Baseline, baseline: Baseline): string[] {
  return Object.entries(baseline)
    .filter(([path, count]) => (current[path] ?? 0) < count)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, count]) => `${path}: down to ${current[path] ?? 0} from ${count}; lower the baseline (${WRITE_COMMAND}).`);
}

/** Baseline entries that are not a positive whole number. */
export function findMalformed(baseline: unknown): string[] {
  if (typeof baseline !== "object" || baseline === null || Array.isArray(baseline)) return ["the baseline must be an object of path: count"];
  return Object.entries(baseline)
    .filter(([, count]) => !Number.isInteger(count) || (count as number) <= 0)
    .map(([path, count]) => `${path}: baseline count must be a whole number above 0 (found ${JSON.stringify(count)})`);
}

export function total(counts: Baseline): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export function serializeBaseline(counts: Baseline): string {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** One diagnostic as the lint prints it: rule and message, where, help. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const lines = [`  ${diagnostic.severity === "error" ? "x" : "!"} ${diagnostic.code ?? diagnostic.severity}: ${diagnostic.message}`, `      ${locationOf(diagnostic)}`];
  const label = diagnostic.labels?.[0]?.label;
  if (label) lines.push(`      ${label}`);
  if (diagnostic.help) lines.push(`      help: ${diagnostic.help}`);
  return lines.join("\n");
}

export interface Verdict {
  /** Diagnostics of every other rule: each one fails the lint. */
  others: Diagnostic[];
  /** Ratchet failures: malformed baseline, growth, staleness. */
  ratchet: string[];
  /** Growth alone: what stops `--write`. */
  growth: string[];
  counts: Baseline;
}

/** What one report means against one baseline. */
export function judge(report: Report, baseline: Baseline): Verdict {
  const { refs, others } = splitDiagnostics(report.diagnostics);
  const counts = countByFile(refs);
  const malformed = findMalformed(baseline);
  const growth = findGrowth(counts, baseline, refs);
  return { others, growth, counts, ratchet: [...malformed, ...growth, ...findStale(counts, baseline)] };
}

/**
 * The exit code oxlint must have given for this report: 1 when it holds an
 * error, else 0 (no `--max-warnings` is passed, so warnings alone are 0).
 */
export function expectedExitCode(report: Report): number {
  return report.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? 1 : 0;
}

export function readBaseline(path = DEFAULT_BASELINE): Baseline {
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

/** Run oxlint once over the app and return its report. */
function runOxlint(): Report {
  const run = spawnSync(join(PACKAGE_ROOT, "node_modules", ".bin", "oxlint"), OXLINT_ARGS, {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    maxBuffer: MAX_REPORT_BYTES,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (run.error) throw new Error(`oxlint did not run: ${run.error.message}`);
  if (run.status !== 0 && run.status !== 1) {
    process.stdout.write(run.stdout ?? "");
    throw new Error(`oxlint exited with ${run.status ?? `signal ${run.signal}`}`);
  }
  let report: Report;
  try {
    report = parseReport(run.stdout);
  } catch (error) {
    process.stdout.write(run.stdout);
    throw error;
  }
  if (run.status !== expectedExitCode(report)) {
    throw new Error(`oxlint exited with ${run.status} but its report says ${expectedExitCode(report)}`);
  }
  return report;
}

function main(argv: string[]): void {
  const reportFlag = argv.indexOf("--report");
  let report: Report;
  try {
    report = reportFlag === -1 ? runOxlint() : parseReport(readFileSync(argv[reportFlag + 1] ?? "", "utf8"));
  } catch (error) {
    console.error(`app lint: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  const baseline = readBaseline();
  const { others, ratchet, growth, counts } = judge(report, baseline);

  if (argv.includes("--write")) {
    if (growth.length > 0) {
      console.error(`${RULE} ratchet: not writing, the baseline only goes down:`);
      for (const problem of growth) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(DEFAULT_BASELINE, serializeBaseline(counts));
    console.log(`${RULE} ratchet: wrote ${total(counts)} in ${Object.keys(counts).length} files (was ${total(baseline)} in ${Object.keys(baseline).length})`);
    return;
  }

  if (others.length > 0) {
    for (const diagnostic of others) console.error(`${formatDiagnostic(diagnostic)}\n`);
    const errors = others.filter((diagnostic) => diagnostic.severity === "error").length;
    console.error(`app lint: ${errors} error(s) and ${others.length - errors} warning(s) in ${report.numberOfFiles} files; warnings fail too.`);
    process.exitCode = 1;
  }
  if (ratchet.length > 0) {
    console.error(`${RULE} ratchet (scripts/refs-ratchet-baseline.json, ${total(baseline)} listed in ${Object.keys(baseline).length} files):`);
    for (const problem of ratchet) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
  if (process.exitCode) return;
  console.log(`app lint: OK (${report.numberOfFiles} files; ${RULE} ratchet: ${total(counts)} left in ${Object.keys(counts).length} files)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
