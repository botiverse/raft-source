#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Fill core `object_references` for the Artifacts published before an
 * Artifact's links were stored, or read with an older extractor
 * (#proj-workspace:#336; src/apps/artifacts/references.ts). For each live
 * Artifact (not deleted, not taken down) whose current version has no
 * references of this CONTENT_LINKS_EXTRACTOR, ensureArtifactReferences reads
 * its current version's Markdown and HTML from the app-content bucket and
 * stores its links, exactly as the lazy fill does: in one short transaction,
 * only while that version is still current, so it is safe beside a live
 * server, and running it again is a no-op for the Artifacts already filled.
 * A failed read (storage, time) is counted and left for the next run.
 *
 * NOT AGAINST PRODUCTION WITHOUT A HUMAN'S CONFIRMATION: run it on
 * production (or any shared environment) only after a human has confirmed
 * that run, in its thread; `--dry-run` first (counts only, reads and writes
 * nothing). Docs: docs/development/first-party-apps.md, "object_references".
 *
 * Walks the Artifacts by (created_at, id); each batch's last cursor is
 * printed, and `--after <created_at>/<id>` resumes after it. Reads up to
 * `--concurrency` Artifacts at once (default 4). Needs DATABASE_URL and the
 * app-content bucket (APP_STORAGE_R2_*), as the server has them.
 */
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import { closeDatabase, getDb, initDatabase } from "../src/db/index";
import { firstPartyApps } from "../src/apps/firstPartyApps";
import { artifactR2Store } from "../src/apps/artifacts/blobStore";
import { CONTENT_LINKS_EXTRACTOR } from "../src/apps/artifacts/contentLinks";
import { ensureArtifactReferences } from "../src/apps/artifacts/references";
import { artifactItems, artifactVersions } from "../src/apps/artifacts/schema";

export interface ArtifactReferencesBackfillOptions {
  dryRun: boolean;
  serverId: string | null;
  batchSize: number;
  concurrency: number;
  limit: number | null;
  after: { createdAt: string; id: string } | null;
}

const USAGE = `Usage:
  pnpm --filter @botiverse/raft-server db:backfill-artifact-references -- [--dry-run] [--server <uuid>] [--batch-size 200] [--concurrency 4] [--limit <n>] [--after <created_at>/<id>]

Not against production without a human's confirmation of the run; --dry-run first.

Options:
  --dry-run          Count the Artifacts that would be filled; read and write nothing
  --server <uuid>    Only this server's Artifacts
  --batch-size <n>   Artifacts per batch (default 200)
  --concurrency <n>  Artifacts read at once (default 4, at most 16)
  --limit <n>        Stop after this many Artifacts
  --after <c>/<id>   Resume after this cursor (a progress line's "cursor")`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function positive(flag: string, value: string | undefined, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${flag} needs a whole number from 1 to ${max}\n${USAGE}`);
  return n;
}

/** `<created_at>/<id>`, as the progress lines print it. */
export function parseCursor(value: string | undefined): { createdAt: string; id: string } {
  const at = value?.lastIndexOf("/") ?? -1;
  const createdAt = at > 0 ? value!.slice(0, at) : "";
  const id = at > 0 ? value!.slice(at + 1) : "";
  if (!createdAt || Number.isNaN(Date.parse(createdAt)) || !id) throw new Error(`--after needs <created_at>/<id>\n${USAGE}`);
  return { createdAt, id };
}

export function parseArtifactReferencesBackfillArgs(argv: readonly string[]): ArtifactReferencesBackfillOptions {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const options: ArtifactReferencesBackfillOptions = { dryRun: false, serverId: null, batchSize: 200, concurrency: 4, limit: null, after: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--server") {
      const id = args[++i];
      if (!id || !UUID.test(id)) throw new Error(`--server needs a server id\n${USAGE}`);
      options.serverId = id;
    } else if (arg === "--batch-size") options.batchSize = positive(arg, args[++i], 5000);
    else if (arg === "--concurrency") options.concurrency = positive(arg, args[++i], 16);
    else if (arg === "--limit") options.limit = positive(arg, args[++i]);
    else if (arg === "--after") options.after = parseCursor(args[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  return options;
}

/** Run `work` over `items`, at most `concurrency` at once. */
async function eachLimited<T>(items: readonly T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(workers);
}

/** One batch of live Artifacts whose current version has no references of this extractor, after `cursor`. */
async function candidates(options: ArtifactReferencesBackfillOptions, cursor: { createdAt: string; id: string } | null, size: number) {
  return getDb()
    .select({ item: artifactItems, createdAtText: sql<string>`${artifactItems.createdAt}::text` })
    .from(artifactItems)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifactItems.currentVersionId))
    .where(and(
      isNull(artifactItems.deletedAt),
      isNull(artifactItems.revokedAt),
      or(isNull(artifactVersions.referencesExtractor), lt(artifactVersions.referencesExtractor, CONTENT_LINKS_EXTRACTOR)),
      options.serverId ? eq(artifactItems.serverId, asServerId(options.serverId)) : undefined,
      // The text cursor keeps created_at's microseconds (a Date would drop them and read a row again).
      cursor ? sql`(${artifactItems.createdAt}, ${artifactItems.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id})` : undefined,
    ))
    .orderBy(asc(artifactItems.createdAt), asc(artifactItems.id))
    .limit(size);
}

export async function backfillArtifactReferences(options: ArtifactReferencesBackfillOptions): Promise<{ scanned: number; filled: number; failed: number }> {
  const stats = { scanned: 0, filled: 0, failed: 0 };
  let cursor = options.after;
  for (;;) {
    const size = options.limit === null ? options.batchSize : Math.min(options.batchSize, options.limit - stats.scanned);
    if (size <= 0) break;
    const batch = await candidates(options, cursor, size);
    if (batch.length === 0) break;
    stats.scanned += batch.length;
    if (!options.dryRun) {
      await eachLimited(batch, options.concurrency, async ({ item }) => {
        if (await ensureArtifactReferences(item)) stats.filled += 1;
        else stats.failed += 1;
      });
    }
    const last = batch[batch.length - 1]!;
    cursor = { createdAt: last.createdAtText, id: last.item.id };
    console.log(JSON.stringify({ ...stats, dryRun: options.dryRun, cursor: `${cursor.createdAt}/${cursor.id}` }));
    if (batch.length < size) break;
  }
  return stats;
}

async function main(): Promise<void> {
  const options = parseArtifactReferencesBackfillArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  await initDatabase(url, undefined, { log: () => {} });
  try {
    // Reading the app registry is what hands Artifacts its object storage (the app-content bucket), as in the server.
    firstPartyApps();
    if (!options.dryRun && !artifactR2Store()) throw new Error("the app-content bucket isn't configured here (APP_STORAGE_R2_*): run it with the server's environment; nothing was filled");
    const stats = await backfillArtifactReferences(options);
    console.log(JSON.stringify({ done: true, dryRun: options.dryRun, ...stats }));
  } finally {
    await closeDatabase();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
