#!/usr/bin/env node
/**
 * raft-perf check: compare measured metrics with their watermarks.
 *
 *   pnpm --filter @botiverse/raft-perf check -- --values interact.json --watermarks watermarks/raft-web.json
 *
 * --values is a raft-perf report with a `metrics` object (interact's), or a flat
 * JSON object of metric -> number. Exit 0 every watermarked metric is at or under
 * its line, 1 one is over or was not measured, 2 the check itself failed.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { cliArgs } from "./args";
import { checkWatermarks, parseWatermarkFile } from "./watermarks";

const HELP = `raft-perf check --values <report.json> --watermarks <watermarks.json>

  Prints a JSON result, then one line per breach on stderr.
  Exit 0 = all at or under their lines, 1 = a breach or an unmeasured metric, 2 = error.
`;

function main(): number {
  const { values: args } = parseArgs({ args: cliArgs(), options: { values: { type: "string" }, watermarks: { type: "string" }, help: { type: "boolean" } } });
  if (args.help || !args.values || !args.watermarks) {
    process.stdout.write(HELP);
    return args.help ? 0 : 2;
  }
  const report = JSON.parse(readFileSync(args.values, "utf8")) as { metrics?: Record<string, number | null> } & Record<string, unknown>;
  const values = (report.metrics && typeof report.metrics === "object" ? report.metrics : report) as Record<string, number | null>;
  const file = parseWatermarkFile(JSON.parse(readFileSync(args.watermarks, "utf8")), args.watermarks);
  const result = checkWatermarks(values, file);
  process.stdout.write(`${JSON.stringify({ tool: "raft-perf check", runner: file.runner ?? null, ...result }, null, 2)}\n`);
  for (const b of result.breaches) process.stderr.write(`over: ${b.metric} = ${b.value} (line ${b.max}, over by ${b.overBy})\n`);
  for (const m of result.missing) process.stderr.write(`not measured: ${m}\n`);
  process.stderr.write(`raft-perf check: ${result.ok ? "ok" : "FAILED"} (${result.checked} checked, ${result.breaches.length} over, ${result.missing.length} not measured)\n`);
  return result.ok ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`raft-perf check: ${(error as Error).message}\n`);
  process.exitCode = 2;
}
