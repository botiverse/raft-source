#!/usr/bin/env node
/**
 * raft-perf advise: what to change first, and how much it could save here.
 *
 *   pnpm --filter @botiverse/raft-perf load -- --project projects/landing.json --env production --net slow --out load.json
 *   pnpm --filter @botiverse/raft-perf advise -- --load load.json [--page home] [--snapshot snap.json|<origin>] [--diff diff.json]
 *
 * Without --snapshot it reads only the report: no network.
 *
 * Reads a `load` report (one scenario), optionally the first-screen snapshot
 * and a release diff, and prints findings ranked by the most each could save
 * in that scenario (src/advice.ts). JSON on stdout, the ranked list and the
 * next command on stderr. Exit 0, or 2 on error. It advises; it never fails a build.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { type PageSummary, advise } from "./advice";
import { cliArgs } from "./args";
import type { FirstScreenDiff, FirstScreenSnapshot } from "./firstScreen";
import { takeSnapshot } from "./takeSnapshot";

const HELP = `raft-perf advise --load <load-report.json> [--page <name>] [--snapshot <file|origin>] [--diff <diff.json>]

  --load      a report from \`raft-perf load --out\` (one project, env, state and net)
  --page      which page of the report (default: its only page)
  --snapshot  the first screen's files, for per-file evidence and the no-store finding: a \`snapshot\` file, or
              an origin to snapshot now (a network fetch; the site may have been redeployed since the load ran)
  --diff      a \`diff\` report (production against the candidate), for the release finding
`;

interface LoadReport {
  tool?: string;
  project: string;
  env: string;
  origin: string;
  state: string;
  net: string;
  pages: Record<string, PageSummary>;
  /** The command line that produced the report (written by load since 0.6). */
  command?: string;
}

async function main(): Promise<number> {
  const { values: args } = parseArgs({ args: cliArgs(), options: { load: { type: "string" }, page: { type: "string" }, snapshot: { type: "string" }, diff: { type: "string" }, help: { type: "boolean" } } });
  if (args.help || !args.load) {
    process.stdout.write(HELP);
    return args.help ? 0 : 2;
  }
  const report = JSON.parse(readFileSync(args.load, "utf8")) as LoadReport;
  if (report.tool !== "raft-perf load" || !report.pages) throw new Error(`${args.load}: not a raft-perf load report`);
  const names = Object.keys(report.pages);
  const pageName = args.page ?? (names.length === 1 ? names[0] : undefined);
  if (!pageName || !Object.hasOwn(report.pages, pageName)) throw new Error(`pick a page with --page (the report has: ${names.join(", ")})`);
  const page = report.pages[pageName];
  // a report from before the time ledger has nothing to value findings on: "0 findings" would read as "nothing to fix"
  if (page.ledger_download_ms == null && page.ledger_main_thread_ms == null && page.ledger_network_wait_ms == null) throw new Error(`${args.load}: page "${pageName}" has no time ledger (the page never became ready, or the report is from before raft-perf 0.5): run load again`);
  let snapshot: FirstScreenSnapshot | undefined;
  if (args.snapshot) {
    snapshot = /^https?:\/\//.test(args.snapshot) ? await takeSnapshot(args.snapshot) : (JSON.parse(readFileSync(args.snapshot, "utf8")) as FirstScreenSnapshot);
    if (snapshot.schema !== "raft-perf/first-screen@1") throw new Error(`${args.snapshot}: not a raft-perf snapshot (schema ${String(snapshot.schema)})`);
  }
  let diff: FirstScreenDiff | undefined;
  if (args.diff) {
    diff = JSON.parse(readFileSync(args.diff, "utf8")) as FirstScreenDiff;
    if (diff.schema !== "raft-perf/first-screen-diff@1") throw new Error(`${args.diff}: not a raft-perf diff (schema ${String(diff.schema)})`);
  }
  const scenario = { project: report.project, env: report.env, page: pageName, state: report.state, net: report.net };
  // the report's own command line when it has one; older reports get a description of the scenario instead of a guessed command
  const loadCommand = report.command ?? `raft-perf load for ${report.project}/${report.env}, page ${pageName}, --state ${report.state} --net ${report.net}`;
  const advice = advise({ scenario, page, snapshot, diff, loadCommand });
  if (snapshot && /^https?:\/\//.test(args.snapshot!)) advice.notes.push("the snapshot was taken now, not when the load ran: if the site was redeployed in between, the files listed are the newer ones");
  process.stdout.write(`${JSON.stringify({ tool: "raft-perf advise", ...advice }, null, 2)}\n`);
  process.stderr.write(`raft-perf advise ${scenario.project}/${scenario.env}/${scenario.page} ${scenario.state}/${scenario.net}: ready ${advice.readyMs} ms, ${advice.findings.length} finding(s)\n`);
  advice.findings.forEach((f, i) => process.stderr.write(`  ${i + 1}. ${f.title} [${f.segment}] ${f.upperBoundMs != null ? `up to ${f.upperBoundMs} ms` : f.costBytes != null ? `${Math.round(f.costBytes / 1024)} KB downloaded again (other visits)` : "no bound"}${f.shareOfReady != null ? ` (${Math.round(f.shareOfReady * 100)}% of ready)` : ""}\n`));
  const first = advice.findings[0];
  if (first) process.stderr.write(`next: change one thing for finding 1, then run: ${first.verify}\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`raft-perf advise: ${(error as Error).message}\n`);
    process.exitCode = 2;
  },
);
