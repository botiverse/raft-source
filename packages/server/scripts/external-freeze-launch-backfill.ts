#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * One-off launch backfill for the free plan's external channel freeze
 * (services/externalChannelFreezeService.ts). Run by a person, once, at the
 * launch of external_channels_v1 freezing.
 *
 * Every free server that is in more than one external channel now, counted
 * exactly as the reconcile counts but with the flag ignored, gets a
 * server_external_freezes row with freeze_at = launch-at + 14 days (a server
 * that already has a row keeps it). Then it writes the
 * external_freeze_launch_backfill marker: until that row exists, no
 * reconcile and no sweep creates a freeze row, so the servers over at launch
 * cannot be frozen before they get their 14 days.
 *
 * Prints counts only (no server ids) and the sha256 of the sorted over
 * server ids, one per line, to compare a dry run with the apply.
 *
 * Usage (dry run by default):
 *   DATABASE_URL=... pnpm --filter @botiverse/raft-server ops:external-freeze-launch-backfill -- [--dry-run] [--launch-at <ISO>]
 *   DATABASE_URL=... pnpm --filter @botiverse/raft-server ops:external-freeze-launch-backfill -- --apply --launch-at <ISO>
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { closeDatabase, initDatabase } from "../src/db";
import { runExternalFreezeLaunchBackfill } from "../src/services/externalChannelFreezeService";

export type BackfillArgs = { apply: boolean; launchAt: Date | null };

const USAGE = "Usage: external-freeze-launch-backfill [--dry-run] | --apply --launch-at <ISO timestamp>";

export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  let apply = false;
  let dryRun = false;
  let launchAt: Date | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--launch-at") {
      const value = args[++i];
      const parsed = value ? new Date(value) : null;
      if (!value || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !parsed || Number.isNaN(parsed.getTime())) {
        throw new Error("--launch-at must be an ISO timestamp, e.g. 2026-11-10T00:00:00Z");
      }
      launchAt = parsed;
    } else throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }
  if (apply && dryRun) throw new Error("--apply and --dry-run are exclusive");
  if (apply && !launchAt) throw new Error(`--apply needs --launch-at\n${USAGE}`);
  return { apply, launchAt };
}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await initDatabase(process.env.DATABASE_URL, undefined, { log: () => {} });
  try {
    const result = await runExternalFreezeLaunchBackfill(args);
    console.log(JSON.stringify(result, null, 2));
    if (!args.apply) console.log("dry-run; pass --apply --launch-at <ISO> to write");
  } finally {
    await closeDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
