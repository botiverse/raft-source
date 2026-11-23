#!/usr/bin/env node
/**
 * raft-perf diagnose-backfill: convert saved `diagnose` and `interact --trace`
 * JSON reports (e.g. daily archives from 2026-11-12 onward) into ScopeDB
 * `perf.diagnose_runs` JSONL rows marked `backfilled: true` with deterministic
 * `run_id`s so re-running is idempotent (#proj-frontend:#78).
 *
 * Pure conversion logic (`backfillReportObject`, `collectJsonFiles`) is exported
 * and pinned by `diagnoseBackfill.test.ts`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { cliArgs } from "./args";
import {
  type DiagnoseReportLike,
  type DiagnoseRunRow,
  type InteractTraceReportLike,
  deterministicBackfillRunId,
  diagnoseReportToRow,
  interactTraceReportToRows,
} from "./diagnoseRuns";

const HELP = `raft-perf diagnose-backfill — convert saved diagnose / interact --trace JSON reports into perf.diagnose_runs JSONL

Options:
  --input <path>        file or directory to scan recursively for JSON reports (repeatable, required)
  --jsonl <file>        output JSONL file path (required)
  --project <name>      product name (default raft-web)
  --env <env>           environment override (default: inferred from origin, else staging)
  --no-backfilled       emit backfilled=false instead of true (for converting freshly run reports)
  -h, --help            show help
`;

export function inferEnvFromOrigin(origin: string | undefined): string {
  if (!origin) return "staging";
  if (/staging/i.test(origin)) return "staging";
  if (/localhost|127\.0\.0\.1/i.test(origin)) return "dev";
  if (/raft\.build/i.test(origin)) return "production";
  return "staging";
}

export function collectJsonFiles(inputs: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (target: string) => {
    const resolved = path.resolve(target);
    if (!existsSync(resolved)) {
      throw new Error(`input path does not exist: ${target}`);
    }
    const st = statSync(resolved);
    if (st.isFile()) {
      if (resolved.endsWith(".json")) out.push(resolved);
      return;
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(resolved).sort()) {
        visit(path.join(resolved, entry));
      }
    }
  };
  for (const input of inputs) visit(input);
  return out;
}

export interface BackfillSiblingMeta {
  hostText?: string | null;
  seriesBreakText?: string | null;
}

const MAX_META_CHARS = 300;

function readTrimmedFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const text = readFileSync(filePath, "utf8").trim().replace(/\s+/g, " ");
    return text.length > 0 ? text.slice(0, MAX_META_CHARS) : null;
  } catch {
    return null;
  }
}

/**
 * Read optional sibling metadata files (`host.txt`, `series-break.txt`) placed
 * next to historical daily JSON reports so machine switches and series breaks
 * stay visible on pre-cohort rows (`extra.backfill_host`, `extra.series_break`,
 * `extra.has_series_break`).
 */
export function readSiblingBackfillMeta(dirPath: string): BackfillSiblingMeta {
  return {
    hostText: readTrimmedFile(path.join(dirPath, "host.txt")),
    seriesBreakText: readTrimmedFile(path.join(dirPath, "series-break.txt")),
  };
}

/**
 * Detect whether a parsed JSON object is a `raft-perf diagnose` or
 * `raft-perf interact --trace` report and convert it into `DiagnoseRunRow[]`.
 * Non-matching JSON files (e.g. `measure`, `snapshot`, `suite-summary`) return `[]`.
 */
export function backfillReportObject(
  raw: unknown,
  options: {
    sourceLabel: string;
    project: string;
    envOverride?: string;
    toolVersion: string;
    backfilled: boolean;
    siblingMeta?: BackfillSiblingMeta;
  },
): DiagnoseRunRow[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const obj = raw as Record<string, unknown>;
  const tool = typeof obj.tool === "string" ? obj.tool : "";
  const origin = typeof obj.origin === "string" ? obj.origin : "";
  const measuredAt = typeof obj.measuredAt === "string" ? obj.measuredAt : "";
  const env = options.envOverride ?? inferEnvFromOrigin(origin);

  const extraOverrides: Record<string, number | string | boolean | null> = {};
  if (options.siblingMeta?.hostText) {
    extraOverrides.backfill_host = options.siblingMeta.hostText;
  }
  if (options.siblingMeta?.seriesBreakText) {
    extraOverrides.series_break = options.siblingMeta.seriesBreakText;
    extraOverrides.has_series_break = true;
  }
  const hasOverrides = Object.keys(extraOverrides).length > 0;

  if (tool === "raft-perf diagnose" || (obj.cpuProfile && typeof obj.scenario === "string")) {
    const report = obj as DiagnoseReportLike;
    const runId = deterministicBackfillRunId(`diagnose:${options.sourceLabel}:${measuredAt}:${report.scenario ?? ""}:${report.mode ?? ""}`);
    return [
      diagnoseReportToRow(report, {
        project: options.project,
        env,
        runId,
        toolVersion: options.toolVersion,
        backfilled: options.backfilled,
        ...(hasOverrides ? { extraOverrides } : {}),
      }),
    ];
  }

  if ((tool === "raft-perf interact" || tool === "raft-perf interact --trace") && obj.work && typeof obj.work === "object") {
    const report = obj as InteractTraceReportLike;
    const runId = deterministicBackfillRunId(`interact-trace:${options.sourceLabel}:${measuredAt}`);
    return interactTraceReportToRows(report, {
      project: options.project,
      env,
      runId,
      toolVersion: options.toolVersion,
      backfilled: options.backfilled,
      ...(hasOverrides ? { extraOverrides } : {}),
    });
  }

  return [];
}

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    args: cliArgs(),
    options: {
      input: { type: "string", multiple: true, default: [] },
      jsonl: { type: "string" },
      project: { type: "string", default: "raft-web" },
      env: { type: "string" },
      "no-backfilled": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const inputs = args.input ?? [];
  if (inputs.length === 0) {
    process.stderr.write("raft-perf diagnose-backfill: at least one --input <path> is required\n");
    return 2;
  }
  if (!args.jsonl) {
    process.stderr.write("raft-perf diagnose-backfill: --jsonl <file> is required\n");
    return 2;
  }

  const toolVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const files = collectJsonFiles(inputs);
  const rows: DiagnoseRunRow[] = [];
  let matchedFiles = 0;
  let skippedFiles = 0;

  const dirMetaCache = new Map<string, BackfillSiblingMeta>();
  for (const file of files) {
    try {
      const dir = path.dirname(file);
      let siblingMeta = dirMetaCache.get(dir);
      if (!siblingMeta) {
        siblingMeta = readSiblingBackfillMeta(dir);
        dirMetaCache.set(dir, siblingMeta);
      }
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const converted = backfillReportObject(parsed, {
        sourceLabel: path.basename(dir) + "/" + path.basename(file),
        project: args.project!,
        envOverride: args.env,
        toolVersion,
        backfilled: !args["no-backfilled"],
        siblingMeta,
      });
      if (converted.length > 0) {
        rows.push(...converted);
        matchedFiles += 1;
      } else {
        skippedFiles += 1;
      }
    } catch {
      skippedFiles += 1;
    }
  }

  const outPath = path.resolve(args.jsonl);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));

  const summary = {
    tool: "raft-perf diagnose-backfill",
    filesScanned: files.length,
    filesConverted: matchedFiles,
    filesSkipped: skippedFiles,
    rowsWritten: rows.length,
    backfilled: !args["no-backfilled"],
    out: outPath,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(
    `raft-perf diagnose-backfill: wrote ${rows.length} row(s) from ${matchedFiles}/${files.length} file(s) to ${outPath}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`raft-perf diagnose-backfill: ${(error as Error)?.message ?? String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
