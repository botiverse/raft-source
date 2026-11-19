#!/usr/bin/env node
/**
 * raft-perf check: compare measured metrics with their watermarks.
 *
 *   pnpm --filter @botiverse/raft-perf check -- --values interact.json --watermarks watermarks/raft-web.json
 *
 * --values is a raft-perf report with a `metrics` object (interact's), or a flat
 * JSON object of metric -> number. Exit 0 every watermarked metric is at or under
 * its line, 1 one is over or was not measured, 2 the check itself failed or the
 * values are of another page than the lines were set on.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { cliArgs } from "./args";
import { checkWatermarks, parseWatermarkFile, readValues } from "./watermarks";

const HELP = `raft-perf check --values <report.json> --watermarks <watermarks.json>

  Prints a JSON result, then one line per breach on stderr.
  Exit 0 = all at or under their lines, 1 = a breach or an unmeasured metric,
       2 = error, or the report is of another page than the lines were set on.
`;

function main(): number {
  const { values: args } = parseArgs({ args: cliArgs(), options: { values: { type: "string" }, watermarks: { type: "string" }, help: { type: "boolean" } } });
  if (args.help || !args.values || !args.watermarks) {
    process.stdout.write(HELP);
    return args.help ? 0 : 2;
  }
  const { values, page: reportPage } = readValues(JSON.parse(readFileSync(args.values, "utf8")));
  const file = parseWatermarkFile(JSON.parse(readFileSync(args.watermarks, "utf8")), args.watermarks);
  const result = checkWatermarks(values, file, reportPage);
  process.stdout.write(`${JSON.stringify({ tool: "raft-perf check", runner: file.runner ?? null, linesSetOn: file.page ?? null, ...result }, null, 2)}\n`);
  if (result.pageMatch === "different") {
    process.stderr.write(`raft-perf check: NOT COMPARABLE: the lines were set on another page (${result.pageDiffers.map((d) => `${d.key}: lines ${JSON.stringify(d.lines)}, report ${d.values == null ? "none" : JSON.stringify(d.values)}`).join("; ")}). Nothing was checked: measure that page, or set lines for this one.\n`);
    return 2;
  }
  if (result.pageMatch === "unknown") process.stderr.write(`note: ${file.page ? "the values name no page" : "the watermark file does not say which page its lines were set on"}, so the lines were held without knowing they apply\n`);
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
