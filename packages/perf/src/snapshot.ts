/**
 * raft-perf snapshot: what a cold load of a deployed web downloads before boot.
 *
 *   pnpm --filter @botiverse/raft-perf snapshot --origin https://raft-app-staging.botiverse.dev
 *
 * Reads the deployed index.html (no build, no sign-in), follows the entry's
 * static imports, and records each first-screen file's size and brotli size.
 * Output: one snapshot JSON (default), or --jsonl: one row per file, the
 * columns of ScopeDB `perf.first_screen_files` (needs --project). Exit 0, or 2 on error.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cliArgs } from "./args";
import { takeSnapshot, toRows } from "./takeSnapshot";

const HELP = `raft-perf snapshot --origin <url> [--out <file>] [--jsonl --project <name> [--env <env>] [--run-id <id>]]

  --origin   a deployed web, e.g. https://raft-app-staging.botiverse.dev
  --out      write to this file instead of stdout
  --jsonl    one JSON row per file (ScopeDB perf.first_screen_files columns)
             instead of one snapshot document
  --project  with --jsonl, required: the product this web belongs to (raft-web, landing, ...)
  --env      with --jsonl: overrides the environment read from the page (required when the page names none)
  --run-id   with --jsonl: shared by every row of one collection run (default: a new UUID)
`;

const toolVersion = (): string => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

async function main() {
  const { values } = parseArgs({ args: cliArgs(), options: { origin: { type: "string" }, out: { type: "string" }, jsonl: { type: "boolean" }, project: { type: "string" }, env: { type: "string" }, "run-id": { type: "string" }, help: { type: "boolean" } } });
  if (values.help || !values.origin) {
    process.stdout.write(HELP);
    process.exitCode = values.help ? 0 : 2;
    return;
  }
  if (values.jsonl && !values.project) throw new Error("--jsonl needs --project (which product this web belongs to)");
  const snap = await takeSnapshot(values.origin);
  if (values.jsonl && !values.env && !snap.release.deploymentEnvironment) throw new Error(`${snap.origin} names no environment in its page; pass --env`);
  const text = values.jsonl
    ? toRows(snap, { project: values.project!, env: values.env, runId: values["run-id"] ?? randomUUID(), toolVersion: toolVersion() }).map((r) => JSON.stringify(r)).join("\n") + "\n"
    : JSON.stringify(snap, null, 2) + "\n";
  if (values.out) writeFileSync(values.out, text);
  else process.stdout.write(text);
  const t = snap.totals;
  const skipped = snap.skipped?.length ? `; skipped ${snap.skipped?.length} 404 import(s)` : "";
  process.stderr.write(`snapshot ${snap.origin} ${snap.release.commitSha?.slice(0, 8) ?? "?"}: ${t.files} files, js ${t.jsBrBytes} br, css ${t.cssBrBytes} br${skipped}\n`);
}

main().catch((e) => {
  process.stderr.write(`raft-perf snapshot: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
});
