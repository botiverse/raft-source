// An Artifact's links to other Artifacts, as core's `object_references`
// holds them (platform/references; #proj-workspace:#336, step 1): the links
// of its current version (contentLinks.ts reads them), so the viewer can ask
// which Artifacts a version links to (the next step's route) and, later, an
// Artifact which link to it (backlinks), without reading the page.
//
// - Only the current version's: a new version's links replace the last
//   one's; an older version has no rows (its viewer reads its links on the
//   fly: extractVersionLinks, stores nothing). `versions.references_extractor`
//   marks the version they were read from, and with which CONTENT_LINKS_EXTRACTOR:
//   only that one version of an Artifact has a mark.
// - Read after the commit that made the version current, never under a lock,
//   never failing the request, which waits for it at most
//   ARTIFACT_REFERENCES_COMMIT_TIMEOUT_MS (the push's warnings' and excerpt's
//   time, beside them), so the links are there when the answer is: a push
//   (publish.ts, from the request's inline bytes where it brought them), a
//   save (save.ts, the bytes in hand), an import (import.ts) and a restore
//   (takedown.ts). Then one short transaction writes them, only while that
//   version is still the current one of a live Artifact (the item's shared
//   lock: a push's commit, a delete or a takedown waits, or went first and the
//   write is skipped), and only when no write of this extractor or a newer
//   one got there first (the version's row lock serialises two). Nothing is
//   written when a file couldn't be read now (storage down, out of time): the
//   next ask tries again, with more time.
// - ensureArtifactReferences reads them for the current version when it has
//   none of this extractor (published before, an older extractor, a read that
//   ran out of time): lazily, as publicText.ts fills, for the next step's
//   route, within ARTIFACT_REFERENCES_READ_TIMEOUT_MS. No backfill.
// - What is read: the version's Markdown and HTML files (text only), the
//   entry first, then by path, at most ARTIFACT_REFERENCES_MAX_FILES of them,
//   at most ARTIFACT_REFERENCES_FILE_READ_BYTES of each (a larger file's
//   start) and ARTIFACT_REFERENCES_READ_BYTES in all: past those, the links
//   read so far are stored. Time is a cap of its own: a file not read when it
//   runs out (none is started after) is a failure, nothing stored. A file's
//   parse isn't interrupted: it is linear in its at most 2 MiB
//   (contentLinks.ts, about 75 ms for 2 MiB of hostile text), so its size is
//   its time limit.
// - Gone with the Artifact: a delete (manage.ts) and a takedown (takedown.ts)
//   delete its rows and clear its versions' marks in their transaction; an
//   operator's purge (purge.ts) and a closed server's purge delete the rows
//   (the server's, by server_id: closedServerPurgeClassification.ts).
//
// Counted in `slock_app_operations_total{app="artifacts",operation="references"}`:
// filled, stale (no longer the current version, or a newer write got there),
// fill_failed (a read or a write that couldn't be made).
import { Readable } from "node:stream";
import { and, asc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { artifactFileType } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import { appHosts } from "../../platform/links";
import { deleteReferencesOfSource, replaceReferences } from "../../platform/references";
import { countAppOperation } from "../../platform/tracing";
import { currentVersionOf, readTextPrefix } from "./apiCommon";
import { artifactR2Store, type ArtifactBlobBytes } from "./blobStore";
import { CONTENT_LINKS_EXTRACTOR, contentLinks, type ContentFile, type ContentLink } from "./contentLinks";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import { artifactBlobs, artifactItems, artifactVersionFiles, artifactVersions, type ArtifactItemRow, type ArtifactVersionRow } from "./schema";

/** The most of one file read: a larger file's links past it are not read. */
export const ARTIFACT_REFERENCES_FILE_READ_BYTES = 2 * 1024 * 1024;
/** The most read of one version's files in all. */
export const ARTIFACT_REFERENCES_READ_BYTES = 8 * 1024 * 1024;
/** The most files of one version read. */
export const ARTIFACT_REFERENCES_MAX_FILES = 64;
/** How long a lazy read (or an older version's) may take: past it, nothing is stored. */
export const ARTIFACT_REFERENCES_READ_TIMEOUT_MS = 5_000;
/** How long the request that made the version waits for its read: the push's warnings' time (scrollLock.ts SCROLL_CHECK_TIMEOUT_MS). */
export const ARTIFACT_REFERENCES_COMMIT_TIMEOUT_MS = 1_500;

/** A version's links, and whether every Markdown and HTML file of it was read whole. */
export interface VersionLinks {
  links: ContentLink[];
  complete: boolean;
}

const LINK_KINDS = new Set(["markdown", "html"]);

/** `read`, or null when `ms` pass first; nobody awaits it then, so its failure is no unhandled rejection. */
async function within<T>(read: Promise<T>, ms: number): Promise<T | null> {
  read.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((done) => { timer = setTimeout(() => done(null), Math.max(0, ms)); });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The links of `version` of `item` (the header's limits), from `inline`'s
 * bytes where a request brought a file (the same sha256: the caller's check),
 * else from storage. Null when a file couldn't be read now (storage not
 * configured or failing, out of `timeoutMs`): nothing to store. A file whose
 * blob is gone is left out (`complete` false), as a file past the size limits
 * is. Stores nothing: the viewer of an older version reads these.
 */
export async function extractVersionLinks(
  item: Pick<ArtifactItemRow, "id" | "serverId">,
  version: Pick<ArtifactVersionRow, "id" | "entry">,
  opts: { inline?: ReadonlyMap<string, Buffer>; timeoutMs?: number } = {},
): Promise<VersionLinks | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? ARTIFACT_REFERENCES_READ_TIMEOUT_MS);
  const rows = await getDb()
    .select({ path: artifactVersionFiles.path, sizeBytes: artifactVersionFiles.sizeBytes, r2Key: artifactBlobs.r2Key, blobSize: artifactBlobs.sizeBytes })
    .from(artifactVersionFiles)
    .leftJoin(artifactBlobs, and(
      eq(artifactBlobs.id, artifactVersionFiles.blobId),
      eq(artifactBlobs.state, "ready"),
      eq(artifactBlobs.serverId, item.serverId),
    ))
    .where(eq(artifactVersionFiles.versionId, version.id))
    .orderBy(asc(artifactVersionFiles.path));
  const wanted = rows.filter((row) => LINK_KINDS.has(artifactFileType(row.path).kind));
  // The entry first, then by path.
  wanted.sort((a, b) => Number(b.path === version.entry) - Number(a.path === version.entry));
  const files: ContentFile[] = [];
  let complete = true;
  let budget = ARTIFACT_REFERENCES_READ_BYTES;
  for (const row of wanted) {
    if (files.length >= ARTIFACT_REFERENCES_MAX_FILES || budget <= 0) {
      complete = false;
      break;
    }
    if (Date.now() >= deadline) return null;
    const limit = Math.min(ARTIFACT_REFERENCES_FILE_READ_BYTES, budget);
    const inline = opts.inline?.get(row.path);
    let bytes: ArtifactBlobBytes;
    if (inline) {
      bytes = { stream: Readable.from([inline]), size: inline.length };
    } else {
      if (row.r2Key === null || row.blobSize === null) {
        complete = false;
        continue;
      }
      const store = artifactR2Store();
      if (!store) return null;
      const read = await within(store.read({ r2Key: row.r2Key, sizeBytes: row.blobSize }), deadline - Date.now());
      if (read === null) {
        // Out of time is a failure; a bucket without the object is a file gone.
        if (Date.now() >= deadline) return null;
        complete = false;
        continue;
      }
      bytes = read;
    }
    const prefix = await within(readTextPrefix(bytes, limit), deadline - Date.now());
    if (prefix === null) return null;
    budget -= Math.min(row.sizeBytes, limit);
    if (prefix.truncated) complete = false;
    files.push({ path: row.path, text: prefix.content });
    // Between files, let the event loop run.
    await new Promise<void>((done) => setImmediate(done));
  }
  return { links: contentLinks(files, { selfId: item.id, appHosts: appHosts() }), complete };
}

/** How a fill went. */
type FillOutcome = "filled" | "stale" | "failed";

/**
 * Read `version`'s links and store them as `item`'s references, while it is
 * still the current version of the live Artifact and has none of this
 * extractor or a newer one (the header). Never throws.
 */
async function fill(item: ArtifactItemRow, version: ArtifactVersionRow, read: { inline?: ReadonlyMap<string, Buffer>; timeoutMs: number }): Promise<FillOutcome> {
  try {
    const links = await extractVersionLinks(item, version, read);
    if (!links) {
      countAppOperation("artifacts", "references", "fill_failed");
      return "failed";
    }
    const outcome = await getDb().transaction(async (tx): Promise<FillOutcome> => {
      const [parent] = await tx.select({ id: artifactItems.id }).from(artifactItems).where(and(
        eq(artifactItems.id, item.id),
        eq(artifactItems.currentVersionId, version.id),
        isNull(artifactItems.deletedAt),
        isNull(artifactItems.revokedAt),
      )).for("share");
      if (!parent) return "stale";
      const [marked] = await tx.select({ extractor: artifactVersions.referencesExtractor }).from(artifactVersions)
        .where(eq(artifactVersions.id, version.id)).for("update");
      if (!marked || (marked.extractor !== null && marked.extractor >= CONTENT_LINKS_EXTRACTOR)) return "stale";
      await replaceReferences(tx, { serverId: item.serverId, kind: ARTIFACT_OBJECT_KIND, id: item.id }, links.links.map((link) => ({
        kind: ARTIFACT_OBJECT_KIND,
        id: link.targetId,
        detail: { version: link.targetVersion, href: link.href, bare: link.bare, path: link.path },
      })));
      await tx.update(artifactVersions).set({ referencesExtractor: CONTENT_LINKS_EXTRACTOR }).where(eq(artifactVersions.id, version.id));
      // The rows are this version's alone now: no other version keeps a mark.
      await tx.update(artifactVersions).set({ referencesExtractor: null }).where(and(
        eq(artifactVersions.itemId, item.id),
        ne(artifactVersions.id, version.id),
        isNotNull(artifactVersions.referencesExtractor),
      ));
      return "filled";
    });
    countAppOperation("artifacts", "references", outcome);
    return outcome;
  } catch (error) {
    countAppOperation("artifacts", "references", "fill_failed");
    // Its class only: a message may quote what the agent wrote.
    console.warn("[artifacts] a version's links were not stored", { versionId: version.id, errorClass: error instanceof Error ? error.name : typeof error });
    return "failed";
  }
}

/** The fill running for each version id (single-flight in this process). */
const flights = new Map<string, Promise<FillOutcome>>();

function fillOnce(item: ArtifactItemRow, version: ArtifactVersionRow, read: { inline?: ReadonlyMap<string, Buffer>; timeoutMs: number }): Promise<FillOutcome> {
  const running = flights.get(version.id);
  if (running) return running;
  const flight = fill(item, version, read).finally(() => {
    if (flights.get(version.id) === flight) flights.delete(version.id);
  });
  flights.set(version.id, flight);
  return flight;
}

/** Tests that count storage reads of other steps turn the commit-time fill off (as scrollLock.ts __setScrollLockCheckForTests); undefined: on. */
let filling = true;
export function __setArtifactReferencesFillForTests(on: boolean | undefined): void {
  filling = on ?? true;
}

/**
 * Store the links of `item`'s current version (`version` when the caller
 * has its row, else read), after the commit that made it current: a push, a
 * save, an import, a restore. `inline`: file bytes the request brought, by
 * path, the version's own. Never throws; waits at most
 * ARTIFACT_REFERENCES_COMMIT_TIMEOUT_MS for the read, then one write.
 */
export async function fillArtifactReferences(item: ArtifactItemRow, opts: { version?: ArtifactVersionRow; inline?: ReadonlyMap<string, Buffer> } = {}): Promise<void> {
  if (!filling) return;
  try {
    const version = opts.version ?? await currentVersionOf(item);
    if (version) await fillOnce(item, version, { inline: opts.inline, timeoutMs: ARTIFACT_REFERENCES_COMMIT_TIMEOUT_MS });
  } catch (error) {
    countAppOperation("artifacts", "references", "fill_failed");
    console.warn("[artifacts] a version's links were not stored", { errorClass: error instanceof Error ? error.name : typeof error });
  }
}

/**
 * Make sure `item`'s references are its current version's, read with this
 * extractor: read and stored now when they aren't (lazily; the next step's
 * route asks before it reads them). True when they are by the time it
 * answers; false when there is no readable current version, or the read or
 * write failed (the next ask tries again).
 */
export async function ensureArtifactReferences(item: ArtifactItemRow): Promise<boolean> {
  if (item.deletedAt !== null || item.revokedAt !== null) return false;
  const version = await currentVersionOf(item);
  if (!version) return false;
  if (version.referencesExtractor !== null && version.referencesExtractor >= CONTENT_LINKS_EXTRACTOR) return true;
  const outcome = await fillOnce(item, version, { timeoutMs: ARTIFACT_REFERENCES_READ_TIMEOUT_MS });
  if (outcome === "filled") return true;
  // Another write may have got there first.
  const [now] = await getDb().select({ extractor: artifactVersions.referencesExtractor }).from(artifactVersions).where(eq(artifactVersions.id, version.id)).limit(1);
  return (now?.extractor ?? 0) >= CONTENT_LINKS_EXTRACTOR;
}

/**
 * Forget the Artifact `itemId`'s references and its versions' marks, in the
 * caller's transaction (a delete, a takedown: manage.ts, takedown.ts), so a
 * restore reads them again.
 */
export async function forgetArtifactReferences(executor: DatabaseExecutor, itemId: string): Promise<void> {
  await deleteReferencesOfSource(executor, ARTIFACT_OBJECT_KIND, itemId);
  await executor.update(artifactVersions).set({ referencesExtractor: null })
    .where(and(eq(artifactVersions.itemId, itemId), isNotNull(artifactVersions.referencesExtractor)));
}
