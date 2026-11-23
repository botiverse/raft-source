#!/usr/bin/env node
/**
 * raft-perf suite: declarative multi-step performance collection runner (#proj-frontend:#74).
 *
 * Replaces fragile external bash scripts (`daily/run.sh`) that checked out or mutated
 * shared git trees: a suite JSON manifest declares ordered `raft-perf` steps, shares a
 * single `runId` across all `--jsonl` steps, runs each step directly via `bin/raft-perf.mjs`
 * without a shell, records structured exit codes and durations in `<out-dir>/suite-summary.json`,
 * and appends collected JSONL rows atomically when `--jsonl <file>` is given.
 *
 * Exit codes: 0 all steps exited 0, 2 one or more steps emitted warnings or failed.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cliArgs } from "./args";

const HELP = `raft-perf suite — run a declarative multi-step performance collection without shell glue

Options:
  --suite <name|file>   built-in suite name (daily-staging, daily-stamp) or path to suite JSON (required)
  --out-dir <dir>       directory where step outputs and suite-summary.json are written (required)
  --fixture <name|file> override {{fixture}} placeholder (default: suite's defaults.fixture or bench-v1)
  --browser <where>     override {{browser}} placeholder: local | browser-run (default: suite's defaults.browser or local)
  --origin <url>        override {{origin}} placeholder (default: suite's defaults.origin or https://raft-app-staging.botiverse.dev)
  --dist <dir>          forward --dist <dir> to diagnose steps (serves local source-mapped build for TypeScript hotspot resolution)
  --sourcemaps <dir>    forward --sourcemaps <dir> to diagnose steps
  --commit-sha <sha>    forward --commit-sha <sha> to diagnose steps (stamps commit_sha on local --dist builds)
  --only <id1,id2>      run only the named step IDs in suite order
  --jsonl <file>        append all rows from steps marked collectJsonl=true (perf.page_runs, sharing one --run-id)
  --diagnose-jsonl <f>  append all rows from steps marked collectDiagnoseJsonl=true (perf.diagnose_runs, sharing one --run-id)
  --run-id <id>         shared run_id across steps (default: a new UUID)
  --dry-run             validate manifest and print resolved step commands without executing them
  --out <file>          also write suite-summary.json to this path
  -h, --help            show help
`;

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const ALLOWED_STEP_COMMANDS = new Set([
  "startup",
  "diagnose",
  "diagnose-backfill",
  "measure",
  "load",
  "interact",
  "input",
  "resize",
  "soak",
  "ab",
  "advise",
  "graph",
  "snapshot",
  "diff",
  "deploy-record",
  "check",
  "claim",
  "bench-check",
]);

export interface SuiteStepSpec {
  id: string;
  command: string;
  args: string[];
  required?: boolean;
  collectJsonl?: boolean;
  collectDiagnoseJsonl?: boolean;
}

export interface SuiteDefaults {
  fixture?: string;
  browser?: string;
  origin?: string;
}

export interface SuiteSpec {
  suite: string;
  description: string;
  defaults: SuiteDefaults;
  steps: SuiteStepSpec[];
}

export interface SuiteVariables {
  outDir: string;
  runId: string;
  fixture: string;
  browser: string;
  origin?: string;
  dist?: string;
  sourcemaps?: string;
  commitSha?: string;
}

export interface PlannedSuiteStep {
  id: string;
  command: string;
  args: string[];
  required: boolean;
  collectJsonl: boolean;
  stepJsonlPath: string | null;
  collectDiagnoseJsonl: boolean;
  stepDiagnoseJsonlPath: string | null;
}

export interface SuiteStepResult {
  id: string;
  command: string;
  args: string[];
  required: boolean;
  status: "ok" | "warn_or_failed" | "skipped_after_abort" | "dry_run";
  exitCode: number | null;
  durationMs: number;
  jsonlRows: number;
  diagnoseJsonlRows: number;
}

class SuiteError extends Error {}
const fail = (message: string): never => {
  throw new SuiteError(message);
};

/** Parse and validate a suite JSON manifest. Pure, pinned by `suite.test.ts`. */
export function parseSuiteSpec(raw: unknown, source = "suite config"): SuiteSpec {
  const bad = (why: string): never => {
    throw new Error(`${source}: ${why}`);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("not a JSON object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.suite !== "string" || !NAME.test(obj.suite)) {
    bad(`"suite" must be a lowercase name like daily-staging`);
  }
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  const rawDefaults = obj.defaults;
  let defaults: SuiteDefaults = {};
  if (rawDefaults !== undefined) {
    if (!rawDefaults || typeof rawDefaults !== "object" || Array.isArray(rawDefaults)) {
      bad(`"defaults" must be an object`);
    }
    const d = rawDefaults as Record<string, unknown>;
    if (d.fixture !== undefined && (typeof d.fixture !== "string" || !d.fixture.trim())) {
      bad(`"defaults.fixture" must be a non-empty string`);
    }
    if (d.browser !== undefined && d.browser !== "local" && d.browser !== "browser-run") {
      bad(`"defaults.browser" must be "local" or "browser-run"`);
    }
    if (d.origin !== undefined && (typeof d.origin !== "string" || !d.origin.trim())) {
      bad(`"defaults.origin" must be a non-empty URL string`);
    }
    defaults = {
      ...(typeof d.fixture === "string" ? { fixture: d.fixture.trim() } : {}),
      ...(typeof d.browser === "string" ? { browser: d.browser } : {}),
      ...(typeof d.origin === "string" ? { origin: d.origin.trim() } : {}),
    };
  }

  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    bad(`"steps" must be a non-empty array`);
  }
  const seenIds = new Set<string>();
  const steps = (obj.steps as unknown[]).map((rawStep, idx): SuiteStepSpec => {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
      bad(`step ${idx}: must be an object`);
    }
    const s = rawStep as Record<string, unknown>;
    if (typeof s.id !== "string" || !NAME.test(s.id)) {
      bad(`step ${idx}: "id" must be a lowercase name`);
    }
    const stepId = s.id as string;
    if (seenIds.has(stepId)) bad(`step "${stepId}" is listed twice`);
    seenIds.add(stepId);
    if (typeof s.command !== "string" || !ALLOWED_STEP_COMMANDS.has(s.command)) {
      bad(`step "${stepId}": unknown or disallowed command ${JSON.stringify(s.command)}`);
    }
    if (!Array.isArray(s.args) || (s.args as unknown[]).some((a) => typeof a !== "string")) {
      bad(`step "${stepId}": "args" must be an array of strings`);
    }
    return {
      id: stepId,
      command: s.command as string,
      args: (s.args as string[]).slice(),
      ...(s.required === true ? { required: true } : {}),
      ...(s.collectJsonl === true ? { collectJsonl: true } : {}),
      ...(s.collectDiagnoseJsonl === true ? { collectDiagnoseJsonl: true } : {}),
    };
  });

  return {
    suite: obj.suite as string,
    description,
    defaults,
    steps,
  };
}

/** Load a suite manifest by built-in name (`daily-staging` -> `suites/daily-staging.json`) or file path. */
export function loadSuiteSpec(nameOrPath: string): SuiteSpec {
  const trimmed = nameOrPath.trim();
  if (!trimmed) throw new Error("--suite needs a suite name (e.g. daily-staging) or a JSON file path");
  if (NAME.test(trimmed)) {
    const builtin = new URL(`../suites/${trimmed}.json`, import.meta.url);
    if (existsSync(builtin)) {
      return parseSuiteSpec(JSON.parse(readFileSync(builtin, "utf8")), `suite ${trimmed}`);
    }
  }
  const full = path.resolve(trimmed);
  if (!existsSync(full)) {
    throw new Error(`--suite ${trimmed}: no built-in suite "${trimmed}" and no file at ${full}`);
  }
  return parseSuiteSpec(JSON.parse(readFileSync(full, "utf8")), trimmed);
}

const PLACEHOLDER_RE = /\{\{([A-Za-z]+)\}\}/g;

/** Substitute safe suite placeholders (`{{outDir}}`, `{{runId}}`, `{{fixture}}`, `{{browser}}`) and wire per-step JSONL collection. */
export function planSuiteSteps(
  spec: SuiteSpec,
  vars: SuiteVariables,
  onlyIds?: readonly string[],
): PlannedSuiteStep[] {
  const filterSet = onlyIds && onlyIds.length > 0 ? new Set(onlyIds) : null;
  if (filterSet) {
    const validIds = new Set(spec.steps.map((s) => s.id));
    for (const requested of filterSet) {
      if (!validIds.has(requested)) {
        throw new Error(
          `suite "${spec.suite}" has no step "${requested}" (available: ${spec.steps.map((s) => s.id).join(", ")})`,
        );
      }
    }
  }

  const resolvedOrigin = vars.origin ?? spec.defaults.origin ?? "https://raft-app-staging.botiverse.dev";
  const mapToken = (arg: string, stepId: string): string =>
    arg.replace(PLACEHOLDER_RE, (_full, key: string) => {
      if (key === "outDir") return vars.outDir;
      if (key === "runId") return vars.runId;
      if (key === "fixture") return vars.fixture;
      if (key === "browser") return vars.browser;
      if (key === "origin") return resolvedOrigin;
      throw new Error(`step "${stepId}": unknown placeholder {{${key}}}`);
    });

  return spec.steps
    .filter((s) => !filterSet || filterSet.has(s.id))
    .map((s): PlannedSuiteStep => {
      const resolvedArgs = s.args.map((a) => mapToken(a, s.id));
      if (s.command === "diagnose") {
        if (vars.dist && !resolvedArgs.includes("--dist")) {
          resolvedArgs.push("--dist", vars.dist);
        }
        if (vars.sourcemaps && !resolvedArgs.includes("--sourcemaps")) {
          resolvedArgs.push("--sourcemaps", vars.sourcemaps);
        }
        if (vars.commitSha && !resolvedArgs.includes("--commit-sha")) {
          resolvedArgs.push("--commit-sha", vars.commitSha);
        }
      }
      let stepJsonlPath: string | null = null;
      if (s.collectJsonl) {
        const jsonlIdx = resolvedArgs.indexOf("--jsonl");
        if (jsonlIdx >= 0 && resolvedArgs[jsonlIdx + 1]) {
          stepJsonlPath = resolvedArgs[jsonlIdx + 1]!;
        } else {
          stepJsonlPath = path.join(vars.outDir, `${s.id}.jsonl`);
          resolvedArgs.push("--jsonl", stepJsonlPath);
        }
        if (!resolvedArgs.includes("--run-id")) {
          resolvedArgs.push("--run-id", vars.runId);
        }
      }
      let stepDiagnoseJsonlPath: string | null = null;
      if (s.collectDiagnoseJsonl) {
        const flag = s.command === "interact" ? "--diagnose-jsonl" : "--jsonl";
        const diagIdx = resolvedArgs.indexOf(flag);
        if (diagIdx >= 0 && resolvedArgs[diagIdx + 1]) {
          stepDiagnoseJsonlPath = resolvedArgs[diagIdx + 1]!;
        } else {
          stepDiagnoseJsonlPath = path.join(vars.outDir, `${s.id}.diagnose.jsonl`);
          resolvedArgs.push(flag, stepDiagnoseJsonlPath);
        }
        if (!resolvedArgs.includes("--run-id")) {
          resolvedArgs.push("--run-id", vars.runId);
        }
      }
      return {
        id: s.id,
        command: s.command,
        args: resolvedArgs,
        required: Boolean(s.required),
        collectJsonl: Boolean(s.collectJsonl),
        stepJsonlPath,
        collectDiagnoseJsonl: Boolean(s.collectDiagnoseJsonl),
        stepDiagnoseJsonlPath,
      };
    });
}

/**
 * Output files a step writes (`--jsonl`, `--diagnose-jsonl`, `--out`, `--save-profile`,
 * `--save-profile-gz`, `--save-trace`, `--save-trace-gz`) that must be removed before the
 * step starts so reusing `--out-dir` never re-reads a previous run's file if the step fails.
 */
export function stepOutputFilesToClean(step: PlannedSuiteStep): string[] {
  const files = new Set<string>();
  if (step.stepJsonlPath) files.add(path.resolve(step.stepJsonlPath));
  if (step.stepDiagnoseJsonlPath) files.add(path.resolve(step.stepDiagnoseJsonlPath));
  const outFlags = new Set([
    "--out",
    "--jsonl",
    "--diagnose-jsonl",
    "--save-profile",
    "--save-profile-gz",
    "--save-trace",
    "--save-trace-gz",
  ]);
  for (let i = 0; i < step.args.length - 1; i++) {
    if (outFlags.has(step.args[i]!)) {
      const target = step.args[i + 1];
      if (target && !target.startsWith("-")) files.add(path.resolve(target));
    }
  }
  return [...files];
}

/** Filter step JSONL lines down to rows emitted for THIS suite's `runId`. */
export function filterMatchingRunJsonlLines(rawContent: string, expectedRunId: string): string[] {
  const kept: string[] = [];
  for (const rawLine of rawContent.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { run_id?: unknown };
      if (parsed.run_id === expectedRunId) kept.push(trimmed);
    } catch {
      /* ignore malformed partial line */
    }
  }
  return kept;
}

function runSubcommand(binPath: string, command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, command, ...args], {
      stdio: ["ignore", "ignore", "inherit"],
      cwd: process.cwd(),
      env: process.env,
    });
    child.on("exit", (code, signal) => {
      if (signal) resolve(128 + 15);
      else resolve(code ?? 2);
    });
    child.on("error", () => resolve(2));
  });
}

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    args: cliArgs(),
    options: {
      suite: { type: "string" },
      "out-dir": { type: "string" },
      fixture: { type: "string" },
      browser: { type: "string" },
      origin: { type: "string" },
      dist: { type: "string" },
      sourcemaps: { type: "string" },
      "commit-sha": { type: "string" },
      only: { type: "string" },
      jsonl: { type: "string" },
      "diagnose-jsonl": { type: "string" },
      "run-id": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const suiteArg = args.suite ?? fail("--suite <name|file> is required");
  const outDirArg = args["out-dir"] ?? fail("--out-dir <dir> is required");
  if (args.browser !== undefined && args.browser !== "local" && args.browser !== "browser-run") {
    fail('--browser must be "local" or "browser-run"');
  }

  const spec = (() => {
    try {
      return loadSuiteSpec(suiteArg);
    } catch (error) {
      return fail((error as Error).message);
    }
  })();

  const outDir = path.resolve(outDirArg);
  const runId = args["run-id"] ?? randomUUID();
  const vars: SuiteVariables = {
    outDir,
    runId,
    fixture: args.fixture ?? spec.defaults.fixture ?? "bench-v1",
    browser: args.browser ?? spec.defaults.browser ?? "local",
    origin: args.origin ?? spec.defaults.origin ?? "https://raft-app-staging.botiverse.dev",
    ...(args.dist ? { dist: path.resolve(args.dist) } : {}),
    ...(args.sourcemaps ? { sourcemaps: path.resolve(args.sourcemaps) } : {}),
    ...(args["commit-sha"] ? { commitSha: args["commit-sha"] } : {}),
  };
  const onlyIds = args.only
    ? args.only
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const planned = (() => {
    try {
      return planSuiteSteps(spec, vars, onlyIds);
    } catch (error) {
      return fail((error as Error).message);
    }
  })();

  mkdirSync(outDir, { recursive: true });

  const binPath = fileURLToPath(new URL("../bin/raft-perf.mjs", import.meta.url));
  const startedAt = new Date().toISOString();
  const suiteT0 = Date.now();
  const stepResults: SuiteStepResult[] = [];
  const collectedJsonlLines: string[] = [];
  const collectedDiagnoseJsonlLines: string[] = [];
  let abortedByStep: string | null = null;

  for (const step of planned) {
    if (args["dry-run"]) {
      stepResults.push({
        id: step.id,
        command: step.command,
        args: step.args,
        required: step.required,
        status: "dry_run",
        exitCode: null,
        durationMs: 0,
        jsonlRows: 0,
        diagnoseJsonlRows: 0,
      });
      continue;
    }
    if (abortedByStep) {
      stepResults.push({
        id: step.id,
        command: step.command,
        args: step.args,
        required: step.required,
        status: "skipped_after_abort",
        exitCode: null,
        durationMs: 0,
        jsonlRows: 0,
        diagnoseJsonlRows: 0,
      });
      continue;
    }

    for (const staleFile of stepOutputFilesToClean(step)) {
      rmSync(staleFile, { force: true });
    }

    process.stderr.write(`raft-perf suite [${spec.suite}] -> step ${step.id} (${step.command})\n`);
    const t0 = Date.now();
    const exitCode = await runSubcommand(binPath, step.command, step.args);
    const durationMs = Date.now() - t0;

    let jsonlRows = 0;
    if (step.stepJsonlPath && existsSync(step.stepJsonlPath)) {
      const lines = filterMatchingRunJsonlLines(readFileSync(step.stepJsonlPath, "utf8"), runId);
      jsonlRows = lines.length;
      collectedJsonlLines.push(...lines);
    }
    let diagnoseJsonlRows = 0;
    if (step.stepDiagnoseJsonlPath && existsSync(step.stepDiagnoseJsonlPath)) {
      const lines = filterMatchingRunJsonlLines(readFileSync(step.stepDiagnoseJsonlPath, "utf8"), runId);
      diagnoseJsonlRows = lines.length;
      collectedDiagnoseJsonlLines.push(...lines);
    }

    const ok = exitCode === 0;
    stepResults.push({
      id: step.id,
      command: step.command,
      args: step.args,
      required: step.required,
      status: ok ? "ok" : "warn_or_failed",
      exitCode,
      durationMs,
      jsonlRows,
      diagnoseJsonlRows,
    });

    if (!ok && step.required) {
      abortedByStep = step.id;
      process.stderr.write(`raft-perf suite [${spec.suite}]: required step "${step.id}" exited ${exitCode}; aborting remaining steps\n`);
    }
  }

  if (!args["dry-run"] && args.jsonl && collectedJsonlLines.length > 0) {
    const dest = path.resolve(args.jsonl);
    mkdirSync(path.dirname(dest), { recursive: true });
    appendFileSync(dest, `${collectedJsonlLines.join("\n")}\n`);
  }
  if (!args["dry-run"] && args["diagnose-jsonl"] && collectedDiagnoseJsonlLines.length > 0) {
    const dest = path.resolve(args["diagnose-jsonl"]);
    mkdirSync(path.dirname(dest), { recursive: true });
    appendFileSync(dest, `${collectedDiagnoseJsonlLines.join("\n")}\n`);
  }

  const anyProblem = stepResults.some((s) => s.status === "warn_or_failed" || s.status === "skipped_after_abort");
  const summary = {
    tool: "raft-perf suite",
    suite: spec.suite,
    description: spec.description,
    dryRun: Boolean(args["dry-run"]),
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - suiteT0,
    outDir,
    variables: {
      fixture: vars.fixture,
      browser: vars.browser,
    },
    abortedByStep,
    totalJsonlRows: collectedJsonlLines.length,
    totalDiagnoseJsonlRows: collectedDiagnoseJsonlLines.length,
    ok: !anyProblem,
    steps: stepResults,
  };

  const text = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(path.join(outDir, "suite-summary.json"), text);
  if (args.out) writeFileSync(path.resolve(args.out), text);
  process.stdout.write(text);

  process.stderr.write(
    `raft-perf suite ${spec.suite}: ${stepResults.filter((s) => s.status === "ok" || s.status === "dry_run").length}/${stepResults.length} steps clean, jsonlRows=${collectedJsonlLines.length}, diagnoseJsonlRows=${collectedDiagnoseJsonlLines.length}, duration=${summary.durationMs} ms\n`,
  );
  return anyProblem ? 2 : 0;
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `raft-perf suite: ${error instanceof SuiteError ? error.message : `failed: ${(error as Error)?.stack ?? String(error)}`}\n`,
      );
      process.exitCode = 2;
    },
  );
}
