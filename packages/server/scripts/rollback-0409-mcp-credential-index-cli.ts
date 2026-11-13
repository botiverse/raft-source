#!/usr/bin/env -S node --import @oxc-node/core/register
// Usage (see docs/operations/server-release.md, "Rolling back past 0409"):
//   db:rollback-0409-mcp-credential-index            status only (read-only)
//   db:rollback-0409-mcp-credential-index --restore  before pressing rollback (see runbook)
//   db:rollback-0409-mcp-credential-index --drop     rollback called off, or before rolling forward
import "dotenv/config";
import pg from "pg";
import { describeScriptError } from "./channels-thread-parent-channel-index";
import {
  describeRollback0409Status,
  dropRollback0409Index,
  findAppsWithSeveralConnections,
  readRollback0409IndexStatus,
  restoreRollback0409Index,
} from "./rollback-0409-managed-mcp-credential-index";

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter((arg) => arg !== "--restore" && arg !== "--drop");
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(" ")}; use --restore or --drop`);
  const restore = args.has("--restore");
  const drop = args.has("--drop");
  if (restore && drop) throw new Error("pass at most one of --restore / --drop");
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required");

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (restore) {
      const outcome = await restoreRollback0409Index(client);
      if (outcome.kind === "refused_duplicates") {
        console.error(describeRollback0409Status(await readRollback0409IndexStatus(client), outcome.duplicates));
        console.error("REFUSED: some Apps have several connections; decide which non-default connections to remove first. Nothing was changed.");
        return 2;
      }
      console.error(outcome.kind === "created" ? "RESTORED" : "ALREADY_PRESENT");
    } else if (drop) {
      const outcome = await dropRollback0409Index(client);
      console.error(outcome.kind === "dropped" ? "DROPPED" : "ALREADY_ABSENT");
    }
    console.error(describeRollback0409Status(await readRollback0409IndexStatus(client), await findAppsWithSeveralConnections(client)));
    return 0;
  } finally {
    await client.end().catch(() => {});
  }
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(describeScriptError(error));
  process.exitCode = 1;
});
