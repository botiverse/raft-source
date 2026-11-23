#!/usr/bin/env node
/**
 * Unified `raft-perf <command> [args...]` entrypoint.
 *
 * Preserves the caller's working directory (unlike `pnpm --filter`, which chdirs
 * into `packages/perf` and breaks relative `--out` / `--project` paths) while
 * registering `@oxc-node/core/register` automatically so TypeScript sources run
 * directly.
 */

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

const COMMANDS = {
  measure: "../src/measure.ts",
  load: "../src/load.ts",
  startup: "../src/startup.ts",
  diagnose: "../src/diagnose.ts",
  "diagnose-backfill": "../src/diagnoseBackfill.ts",
  interact: "../src/interact.ts",
  input: "../src/input.ts",
  resize: "../src/resize.ts",
  soak: "../src/soak.ts",
  ab: "../src/ab.ts",
  advise: "../src/advise.ts",
  graph: "../src/graph.ts",
  snapshot: "../src/snapshot.ts",
  diff: "../src/diff.ts",
  "deploy-record": "../src/deployRecord.ts",
  check: "../src/check.ts",
  claim: "../src/claim.ts",
  "bench-check": "../src/benchCheck.ts",
  suite: "../src/suite.ts",
};

const HELP = `raft-perf <command> [options]

Commands:
  startup            where the time of opening a channel goes (network, preflights, post-fetch script)
  diagnose           source-level V8 CPU profile, SourceMap hotspots, forced-reflow stacks, React commit waterfall and critical-path slack
  diagnose-backfill  convert archived diagnose / interact --trace JSON reports into ScopeDB perf.diagnose_runs JSONL (backfilled=true)
  measure            paired on/off page measurement with a Wilcoxon verdict
  load               time to a page's own content (public or signed-in, shell + ready milestones), driven by a project config
  interact           scroll, channel switch and thread open metrics
  input              real typing and click INP latency (populates perf.page_runs.inp_ms)
  resize             viewport resize sweep measuring jank, CLS, and forced layout
  soak               long-lived multi-round switch/scroll JS heap and DOM node retention slope
  ab                 two local builds compared pair-by-pair against a deployed API
  suite              declarative multi-step collection runner (replaces external shell glue)
  advise             findings valued and ranked on the time ledger
  graph              module and package breakdown of a Vite/Rolldown build
  snapshot           first-screen files and brotli sizes of a deployed origin
  diff               compare two first-screen snapshots (growth and cache invalidation)
  deploy-record      Markdown summary of a deploy's first screen and module diff
  check              hold a report's metrics, page and cohort against watermarks
  claim              open, ship and verify falsifiable optimization predictions
  bench-check        verify a frozen benchmark channel's content hash and counts

Run \`raft-perf <command> --help\` for a command's options.
`;

const raw = process.argv.slice(2);
const args = raw[0] === "--" ? raw.slice(1) : raw;
const cmd = args[0];

if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  const next = cmd === "help" ? args[1] : undefined;
  if (next && Object.hasOwn(COMMANDS, next)) {
    args.splice(0, args.length, next, "--help");
  } else {
    process.stdout.write(HELP);
    process.exit(cmd ? 0 : 2);
  }
}

const sub = args[0];
if (!Object.hasOwn(COMMANDS, sub)) {
  process.stderr.write(`raft-perf: unknown command "${sub}" (run \`raft-perf --help\` for the list)\n`);
  process.exit(2);
}

const registerUrl = import.meta.resolve("@oxc-node/core/register");
const entry = fileURLToPath(new URL(COMMANDS[sub], import.meta.url));

const child = spawn(process.execPath, ["--import", registerUrl, entry, ...args.slice(1)], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    const sigNum = osConstants.signals[signal] ?? 15;
    process.exit(128 + sigNum);
  }
  process.exit(code ?? 2);
});
