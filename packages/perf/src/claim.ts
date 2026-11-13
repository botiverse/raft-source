#!/usr/bin/env node
/**
 * raft-perf claim: write an optimization down before it ships, and check it after.
 *
 *   claim open     --claims claims.jsonl --id raft-web-0001 --project raft-web --env staging \
 *                  --title "…" --ref "<PR or task>" --author <who> --scenario interact/channel_first_visit \
 *                  --metric channel_first_visit_settled_ms --predicted-delta -350 \
 *                  --before rows.jsonl --runner <machine> --verify-command "<how to measure again>"
 *   claim ship     --claims claims.jsonl --id raft-web-0001 --commit <sha>
 *   claim verify   --claims claims.jsonl --id raft-web-0001 --before rows.jsonl --after rows-after.jsonl
 *   claim withdraw --claims claims.jsonl --id raft-web-0001 --note "why"
 *   claim status   --claims claims.jsonl
 *
 * rows.jsonl are perf.page_runs rows (`--jsonl` of measure, load or interact), one run per row.
 * Each call appends one row to the claims file (ScopeDB perf.claims). The rules are in src/claims.ts.
 * Exit codes: 0 done (verify: verified), 1 verify said refuted or inconclusive, 2 the call failed.
 * docs/frontend/perf-measure.md, "Claims".
 */
import process from "node:process";
import { cliArgs } from "./args";
import { runClaim } from "./claimCommand";

process.exitCode = runClaim(cliArgs(), { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) });
