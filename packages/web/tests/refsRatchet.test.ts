/**
 * Required-Test Admission evidence (docs/sops/ci-check-maintenance.md)
 *
 * - Test/check: packages/web app lint and `react/refs` ratchet
 *   (scripts/lint-app.ts, chained into `lint`)
 * - Adjudicated decision: the React Compiler lint rules come back one at a
 *   time; `react/refs` has too many findings to fix at once, so new code is
 *   held to a per-file count that can only shrink, read from the lint's one
 *   oxlint run.
 * - RED proof (minimal production mutation): add `const seen = useRef(0);
 *   seen.current += 1;` to the component in src/components/ConfirmDialog.tsx
 *   → "src/components/ConfirmDialog.tsx: 1 react/refs finding(s), not in the
 *   baseline (0)"; restored file → OK.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  OXLINT_ARGS,
  RULE,
  countByFile,
  expectedExitCode,
  findGrowth,
  findMalformed,
  findStale,
  formatDiagnostic,
  judge,
  locationOf,
  parseReport,
  readBaseline,
  serializeBaseline,
  splitDiagnostics,
  total,
} from "../scripts/lint-app";
import type { Diagnostic } from "../scripts/lint-app";
import { parseOxlintConfig } from "../scripts/check-scroll-area-debt";

const WEB_ROOT = resolve(import.meta.dirname, "..");

function refsAt(filename: string, line: number, column = 3): Diagnostic {
  return {
    message: "Cannot access refs during render",
    code: "react(refs)",
    severity: "warning",
    help: "React refs are values that are not needed for rendering.",
    filename,
    labels: [{ label: "Cannot update ref value during render", span: { line, column } }, { label: "This value is a ref", span: { line, column: 1 } }],
  };
}

function other(filename: string, severity: "error" | "warning", code = "react-doctor(no-eval)"): Diagnostic {
  return { message: "no eval", code, severity, filename, labels: [{ span: { line: 4, column: 9 } }] };
}

const reportOf = (diagnostics: Diagnostic[], files = 10) => JSON.stringify({ diagnostics, number_of_files: files, number_of_rules: 200 });

test("the report's react/refs findings are counted per file, the rest kept apart", () => {
  const report = parseReport(reportOf([refsAt("src/b.tsx", 9), other("src/a.tsx", "error"), refsAt("src/a.tsx", 20), refsAt("src/b.tsx", 2), refsAt("./src/b.tsx", 5)]));
  assert.equal(report.numberOfFiles, 10);
  const { refs, others } = splitDiagnostics(report.diagnostics);
  assert.deepEqual(refs.map(locationOf), ["src/a.tsx:20:3", "src/b.tsx:2:3", "src/b.tsx:5:3", "src/b.tsx:9:3"]);
  assert.deepEqual(others.map(locationOf), ["src/a.tsx:4:9"]);
  assert.deepEqual(countByFile(refs), { "src/a.tsx": 1, "src/b.tsx": 3 });
});

test("another react rule, or the same rule name in another plugin, is not the ratcheted rule", () => {
  const { refs, others } = splitDiagnostics([other("src/a.tsx", "warning", "react(purity)"), other("src/a.tsx", "warning", "react-doctor(refs)"), { message: "Unexpected token", severity: "error", filename: "src/a.tsx" }]);
  assert.equal(refs.length, 0);
  assert.equal(others.length, 3);
});

test("output that is not oxlint's report fails closed", () => {
  assert.throws(() => parseReport("Failed to parse configuration file."), /not JSON/);
  assert.throws(() => parseReport("null"), /no diagnostics list/);
  assert.throws(() => parseReport(JSON.stringify({ number_of_files: 3 })), /no diagnostics list/);
  assert.throws(() => parseReport(JSON.stringify({ diagnostics: [] })), /covers no files/);
  assert.throws(() => parseReport(reportOf([], 0)), /covers no files/);
  assert.throws(() => parseReport(reportOf([{ message: "x", severity: "warning" } as Diagnostic])), /no filename or severity/);
});

test("a file over its baseline fails, with both counts and where the findings are", () => {
  const refs = [refsAt("src/a.tsx", 12), refsAt("src/a.tsx", 40, 7), refsAt("src/b.tsx", 3)];
  const growth = findGrowth(countByFile(refs), { "src/a.tsx": 1, "src/b.tsx": 1 }, refs);
  assert.equal(growth.length, 1);
  assert.match(growth[0] ?? "", /^src\/a\.tsx: 2 react\/refs finding\(s\), baseline 1\. Now at line:column 12:3, 40:7\./);
});

test("a file that is not in the baseline may not have a finding", () => {
  const refs = [refsAt("src/new.tsx", 5)];
  const growth = findGrowth(countByFile(refs), { "src/a.tsx": 1 }, refs);
  assert.match(growth.join(), /^src\/new\.tsx: 1 react\/refs finding\(s\), not in the baseline \(0\)\. Now at line:column 5:3\./);
});

test("at or under the baseline is not growth", () => {
  assert.deepEqual(findGrowth({ "src/a.tsx": 2 }, { "src/a.tsx": 2, "src/b.tsx": 4 }), []);
  assert.deepEqual(findGrowth({ "src/a.tsx": 1 }, { "src/a.tsx": 2 }), []);
});

test("a count that went down, or a file that is clean or gone, must be lowered in the baseline", () => {
  const stale = findStale({ "src/a.tsx": 1, "src/c.tsx": 2 }, { "src/a.tsx": 3, "src/b.tsx": 1, "src/c.tsx": 2 });
  assert.equal(stale.length, 2);
  assert.match(stale[0] ?? "", /^src\/a\.tsx: down to 1 from 3; lower the baseline \(pnpm --filter @botiverse\/raft-web run lint:refs-baseline\)/);
  assert.match(stale[1] ?? "", /^src\/b\.tsx: down to 0 from 1;/);
});

test("one file's drop does not pay for another file's rise", () => {
  const refs = [refsAt("src/b.tsx", 1), refsAt("src/b.tsx", 2)];
  const verdict = judge(parseReport(reportOf(refs)), { "src/a.tsx": 1, "src/b.tsx": 1 });
  assert.equal(total(verdict.counts), 2);
  assert.equal(verdict.growth.length, 1);
  assert.equal(verdict.ratchet.length, 2);
  assert.match(verdict.ratchet.join("\n"), /src\/b\.tsx: 2 react\/refs finding\(s\), baseline 1[\s\S]*src\/a\.tsx: down to 0 from 1/);
});

test("a report that matches the baseline passes; any other diagnostic is kept for the lint to fail on", () => {
  const baseline = { "src/a.tsx": 1 };
  const clean = judge(parseReport(reportOf([refsAt("src/a.tsx", 3)])), baseline);
  assert.deepEqual([clean.others, clean.ratchet], [[], []]);
  const warned = judge(parseReport(reportOf([refsAt("src/a.tsx", 3), other("src/z.tsx", "warning")])), baseline);
  assert.equal(warned.others.length, 1);
  assert.deepEqual(warned.ratchet, []);
});

test("react/refs counts through the ratchet whatever its severity", () => {
  const asError = { ...refsAt("src/a.tsx", 3), severity: "error" };
  const verdict = judge(parseReport(reportOf([asError])), {});
  assert.equal(verdict.others.length, 0);
  assert.equal(verdict.growth.length, 1);
});

test("a baseline count that is not a whole number above 0 fails", () => {
  assert.deepEqual(findMalformed({ "src/a.tsx": 2 }), []);
  assert.equal(findMalformed({ "src/a.tsx": 0, "src/b.tsx": -1, "src/c.tsx": 1.5, "src/d.tsx": "2" }).length, 4);
  assert.equal(findMalformed([]).length, 1);
  assert.equal(judge(parseReport(reportOf([])), { "src/a.tsx": 0 }).ratchet.length, 1);
});

test("the exit code oxlint must give: 1 with an error, 0 with warnings alone", () => {
  assert.equal(expectedExitCode(parseReport(reportOf([refsAt("src/a.tsx", 3)]))), 0);
  assert.equal(expectedExitCode(parseReport(reportOf([refsAt("src/a.tsx", 3), other("src/a.tsx", "error")]))), 1);
});

test("a diagnostic prints its rule, message, place and help", () => {
  assert.equal(
    formatDiagnostic(refsAt("src/a.tsx", 12, 5)),
    "  ! react(refs): Cannot access refs during render\n      src/a.tsx:12:5\n      Cannot update ref value during render\n      help: React refs are values that are not needed for rendering.",
  );
  assert.equal(formatDiagnostic({ message: "Unexpected token", severity: "error", filename: "src/a.tsx" }), "  x error: Unexpected token\n      src/a.tsx");
});

test("the baseline is written sorted, one file per line", () => {
  assert.equal(serializeBaseline({ "src/b.tsx": 1, "src/a.tsx": 2 }), '{\n  "src/a.tsx": 2,\n  "src/b.tsx": 1\n}\n');
});

test("the committed baseline is well formed, sorted, and names files that exist under the linted directories", () => {
  const baseline = readBaseline();
  assert.deepEqual(findMalformed(baseline), []);
  assert.equal(readFileSync(resolve(WEB_ROOT, "scripts/refs-ratchet-baseline.json"), "utf8"), serializeBaseline(baseline));
  for (const path of Object.keys(baseline)) {
    assert.match(path, /^(?:src|visual-testing)\//);
    assert.ok(existsSync(resolve(WEB_ROOT, path)), `${path} is in the baseline but is not a file`);
  }
});

test("the config keeps the rule at warn, and lint runs oxlint over the app once, through the script", () => {
  const config = parseOxlintConfig(readFileSync(resolve(WEB_ROOT, ".oxlintrc.json"), "utf8"));
  assert.equal(config?.rules?.[RULE], "warn");
  for (const override of config?.overrides ?? []) assert.ok(!(RULE in (override.rules ?? {})), "an override must not change react/refs");
  const scripts = (JSON.parse(readFileSync(resolve(WEB_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  const steps = (scripts.lint ?? "").split("&&").map((step) => step.trim());
  assert.equal(steps.filter((step) => step === "node --import @oxc-node/core/register scripts/lint-app.ts").length, 1);
  // The only other oxlint run in `lint` is the test config's, over the test folders.
  assert.deepEqual(steps.filter((step) => /(?:^|\s)oxlint(?:\s|$)/.test(step)), ["oxlint -c scripts/oxlint-tests.json --disable-nested-config --max-warnings=0 tests src/features/*/tests"]);
  assert.equal(scripts["lint:refs-baseline"], "node --import @oxc-node/core/register scripts/lint-app.ts --write");
  assert.deepEqual(OXLINT_ARGS, ["--react-plugin", "-f", "json", "src", "visual-testing"]);
});
