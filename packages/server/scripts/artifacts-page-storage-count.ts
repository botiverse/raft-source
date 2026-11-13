#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Count how many live workspace Artifacts' pages use a browser storage API a
 * nested page won't have: read only, and it prints counts alone.
 *
 * Why: Raft's Artifact pages are to move from Porthole's served pages to its
 * nested pages (#proj-workspace:#271). A nested page keeps `localStorage`
 * (through Porthole's store) and has no IndexedDB, no Cache API and no
 * cookie. Before the move we need to know whether the pages that use those
 * number none, a handful, or hundreds.
 *
 * What it reads: for every Artifact that isn't deleted, the files of its
 * CURRENT version whose path ends in .html, .htm, .js or .mjs (the page and
 * the scripts of its own set), from the app-content bucket, one at a time
 * into memory, matched against four patterns, and dropped. A file larger
 * than --max-bytes (default 5 MiB) is counted as skipped, not read.
 *
 * What it prints: one JSON object of counts on stdout. No Artifact id, no
 * server, no path, no person, no byte of content; nothing is written to
 * disk, to the database or to the bucket. A failure prints the kind of error
 * and a fixed line, never the error's own message (which can name a key).
 * The server's own logs (the storage service prints each bucket's name and
 * endpoint as it is set up) are stopped before its modules load: the count
 * and the failure line are all this process ever prints. A match is a word in the source
 * (`indexedDB`, `caches.` or `CacheStorage`, `document.cookie`,
 * `localStorage`): an upper bound on use, since a word in a comment or a
 * vendored library counts.
 *
 *   pnpm --filter @botiverse/raft-server db:artifacts-page-storage-count [-- --max-bytes N] [--concurrency N]
 *
 * Needs DATABASE_URL (a replica is fine, and preferred) and the app-content
 * bucket (APP_STORAGE_R2_*), as the server has them. Who may run it: whoever
 * holds the production database credentials, with a human's approval for the
 * run (it reads people's Artifact sources, though it keeps none).
 */
import { and, eq, isNull, sql } from "drizzle-orm";

/** What a nested page lacks (the first three), and what it keeps (the last, for scale). */
export const STORAGE_PATTERNS = {
  indexedDB: /\bindexedDB\b/u,
  cacheApi: /\bcaches\s*\.|\bCacheStorage\b/u,
  cookie: /\bdocument\s*\.\s*cookie\b/u,
  localStorage: /\blocalStorage\b/u,
} as const;
export type StoragePattern = keyof typeof STORAGE_PATTERNS;

/** Which of the patterns a source text matches. */
export function storageUses(source: string): StoragePattern[] {
  return (Object.keys(STORAGE_PATTERNS) as StoragePattern[]).filter((name) => STORAGE_PATTERNS[name].test(source));
}

/** A file of a page's own set that can hold script: the page, or a script. */
export function isPageSource(path: string): boolean {
  return /\.(?:html?|m?js)$/iu.test(path);
}

export interface StorageCount {
  /** Artifacts that aren't deleted and have a current version. */
  artifacts: number;
  /** Of those, the ones with at least one page or script file. */
  artifactsWithPages: number;
  /** Artifacts with a match of each pattern in at least one such file. */
  uses: Record<StoragePattern, number>;
  /** Artifacts that match IndexedDB, the Cache API or a cookie: what a nested page would break. */
  usesAnyMissing: number;
  filesRead: number;
  bytesRead: number;
  /** Files not read: larger than the cap, missing from the bucket, or whose read failed. */
  filesSkippedLarge: number;
  filesMissing: number;
  filesFailed: number;
}

interface FileRow {
  itemId: string;
  path: string;
  r2Key: string;
  sizeBytes: number;
}

/** Counts over `rows` (every page or script file of every live Artifact's current version), reading each through `read`. */
export async function countStorageUses(
  artifacts: number,
  rows: readonly FileRow[],
  read: (row: FileRow) => Promise<string | null>,
  options: { maxBytes: number; concurrency: number },
): Promise<StorageCount> {
  const perItem = new Map<string, Set<StoragePattern>>();
  const count: StorageCount = {
    artifacts,
    artifactsWithPages: 0,
    uses: { indexedDB: 0, cacheApi: 0, cookie: 0, localStorage: 0 },
    usesAnyMissing: 0,
    filesRead: 0,
    bytesRead: 0,
    filesSkippedLarge: 0,
    filesMissing: 0,
    filesFailed: 0,
  };
  let next = 0;
  const work = async (): Promise<void> => {
    for (;;) {
      const row = rows[next];
      next += 1;
      if (row === undefined) return;
      const seen = perItem.get(row.itemId) ?? new Set<StoragePattern>();
      perItem.set(row.itemId, seen);
      if (row.sizeBytes > options.maxBytes) {
        count.filesSkippedLarge += 1;
        continue;
      }
      let source: string | null;
      try {
        source = await read(row);
      } catch {
        // Counted, never described: a storage error's message can name the object's key.
        count.filesFailed += 1;
        continue;
      }
      if (source === null) {
        count.filesMissing += 1;
        continue;
      }
      count.filesRead += 1;
      count.bytesRead += row.sizeBytes;
      for (const name of storageUses(source)) seen.add(name);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, work));
  count.artifactsWithPages = perItem.size;
  for (const seen of perItem.values()) {
    for (const name of seen) count.uses[name] += 1;
    if (seen.has("indexedDB") || seen.has("cacheApi") || seen.has("cookie")) count.usesAnyMissing += 1;
  }
  return count;
}

function numberFlag(argv: readonly string[], name: string, fallback: number): number {
  const at = argv.indexOf(name);
  if (at === -1) return fallback;
  const value = Number(argv[at + 1]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} takes a positive whole number`);
  return value;
}

/**
 * Nothing but this script's own two lines ever reaches the terminal. The server's modules log as
 * they load and as they are set up (the storage service names each bucket and its endpoint, among
 * others), and none of that belongs in an output that is meant to name nothing. So every console
 * method is stopped before any of them is imported, and the count and the failure line are written
 * to the streams directly.
 */
function silenceServerLogs(): void {
  for (const name of ["log", "info", "warn", "debug", "error", "trace"] as const) {
    console[name] = () => {};
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const maxBytes = numberFlag(argv, "--max-bytes", 5 * 1024 * 1024);
  const concurrency = numberFlag(argv, "--concurrency", 8);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  silenceServerLogs();
  // Imported only now, after the console is stopped: some of these log as they load.
  const { closeDatabase, getDb, initDatabase } = await import("../src/db/index");
  const { firstPartyApps } = await import("../src/apps/firstPartyApps");
  const { artifactR2Store } = await import("../src/apps/artifacts/blobStore");
  const { artifactBlobs, artifactItems, artifactVersionFiles } = await import("../src/apps/artifacts/schema");
  await initDatabase(url, undefined, { log: () => {} });
  try {
    firstPartyApps();
    const store = artifactR2Store();
    if (store === null) throw new Error("the app-content bucket is not configured (APP_STORAGE_R2_*)");
    const db = getDb();
    const [{ artifacts } = { artifacts: 0 }] = await db
      .select({ artifacts: sql<number>`count(*)::int` })
      .from(artifactItems)
      .where(and(isNull(artifactItems.deletedAt), sql`${artifactItems.currentVersionId} IS NOT NULL`));
    const files = await db
      .select({ itemId: artifactItems.id, path: artifactVersionFiles.path, r2Key: artifactBlobs.r2Key, sizeBytes: artifactBlobs.sizeBytes })
      .from(artifactItems)
      .innerJoin(artifactVersionFiles, eq(artifactVersionFiles.versionId, artifactItems.currentVersionId))
      .innerJoin(artifactBlobs, eq(artifactBlobs.id, artifactVersionFiles.blobId))
      .where(and(isNull(artifactItems.deletedAt), eq(artifactBlobs.state, "ready")));
    const rows = files.filter((file) => isPageSource(file.path)).map((file) => ({ ...file, sizeBytes: Number(file.sizeBytes) }));
    const count = await countStorageUses(
      artifacts,
      rows,
      async (row) => {
        const bytes = await store.read({ r2Key: row.r2Key, sizeBytes: row.sizeBytes });
        if (bytes === null) return null;
        const chunks: Buffer[] = [];
        for await (const chunk of bytes.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        return Buffer.concat(chunks).toString("utf8");
      },
      { maxBytes, concurrency },
    );
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), maxBytes, ...count }, null, 2)}\n`);
  } finally {
    await closeDatabase();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // The kind of error and a fixed line, never its message: a database or storage error's
    // message can carry an object key or a path, and this script's output names nothing.
    process.stderr.write(`artifacts-page-storage-count failed (${error instanceof Error ? error.name : "error"}): nothing was written; see the usage at the top of the script\n`);
    process.exit(1);
  });
}
