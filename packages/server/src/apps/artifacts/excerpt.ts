// A Markdown version's excerpt: what its card shows (ArtifactPreview `excerpt`,
// webCards.ts previewOf; task #proj-workspace:#217, xxchan: Markdown has no
// publish check and no screenshots, a card shows its text instead). The rules
// are readableText.ts markdownExcerpt; this is where it comes from and goes.
// `excerpt_blocks` beside it is the same start as data (excerptBlocks.ts,
// #proj-workspace:#220): written with the text, cleared with it, and never there
// without it (the CHECK says so). `text` stays: older clients and the Android
// App read only that, and a version from before has only that.
//
// - Stored on the version's own row (`versions.excerpt`), set once: every card
//   already reads that row, so a page of N cards reads nothing more, and
//   nothing reads object storage per card. `version_texts` isn't the place: its
//   rows are only for public Artifacts, with up to 200 KB of body each.
// - A push (publish.ts) fills it after the commit, never under the item's
//   lock, as its warnings are read: from the entry's inline bytes when it came
//   inline, else from storage (the CLI uploads by sha256, so usually). The push
//   waits for it, so a card asked for right after the answer has it, within
//   ARTIFACT_EXCERPT_READ_TIMEOUT_MS. It never fails the push: a failure is
//   counted and logged, and the version goes without one, as a card reads
//   no excerpt (today's look). It isn't tried again.
// - A save (save.ts) has the bytes in hand and writes it with the version
//   (entryExcerpt); an import (import.ts) fills it after its commit.
// - At most ARTIFACT_EXCERPT_READ_BYTES of the entry are read: the excerpt is
//   of its start.
// - No backfill: older versions keep their screenshots, or show as before.
// - Goes with the Artifact: deleting it clears its versions' excerpts
//   (clearItemExcerpts, manage.ts deleteArtifact), as its files and checks go;
//   a takedown leaves them, as it leaves everything for a restore, and cards
//   never read a revoked version.
//
// Counted in `slock_app_operations_total{app="artifacts",operation="excerpt"}`:
// filled, empty (nothing to show), fill_failed, blocks_failed (the text is
// stored, its blocks not: a bug here, as it can't be the input).
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { artifactFileType, type ArtifactExcerptBlock } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import { countAppOperation } from "../../platform/tracing";
import { currentVersionOf, readTextPrefix, versionFileOf } from "./apiCommon";
import { markdownExcerptBlocks } from "./excerptBlocks";
import { markdownExcerpt } from "./readableText";
import { artifactItems, artifactVersions, type ArtifactItemRow, type ArtifactVersionRow } from "./schema";

/** How much of the entry is read: front matter and comments may come first, and the excerpt is at most a few KB of it. */
export const ARTIFACT_EXCERPT_READ_BYTES = 64 * 1024;
/** How long the read may take before the version goes without an excerpt (as the push's warnings, whose reads run beside it). */
export const ARTIFACT_EXCERPT_READ_TIMEOUT_MS = 1_500;

/** A version's excerpt columns; both null without one, and no blocks without text. */
export interface ExcerptColumns {
  excerpt: string | null;
  excerptBlocks: ArtifactExcerptBlock[] | null;
}

/** The columns for this Markdown. A failure of the blocks leaves the text, which a card draws. */
function excerptColumns(markdown: string, title: string | null): ExcerptColumns {
  const excerpt = markdownExcerpt(markdown, title);
  if (excerpt === null) return { excerpt, excerptBlocks: null };
  try {
    return { excerpt, excerptBlocks: markdownExcerptBlocks(markdown, title) };
  } catch (error) {
    countAppOperation("artifacts", "excerpt", "blocks_failed");
    // Its class only: a message may quote what the agent wrote.
    console.warn("[artifacts] an excerpt's blocks were not made; its card shows the text", { errorClass: error instanceof Error ? error.name : typeof error });
    return { excerpt, excerptBlocks: null };
  }
}

/** The excerpt of an entry named `entry` whose bytes are in hand; none for anything but Markdown. */
export function entryExcerpt(entry: string, bytes: Buffer, title: string | null): ExcerptColumns {
  if (artifactFileType(entry).kind !== "markdown") return { excerpt: null, excerptBlocks: null };
  return excerptColumns(bytes.subarray(0, ARTIFACT_EXCERPT_READ_BYTES).toString("utf8"), title);
}

/** The start of the version's entry from storage, or null when it can't be read. */
async function storedEntryText(item: ArtifactItemRow, version: ArtifactVersionRow): Promise<string | null> {
  const file = await versionFileOf(item, version, version.entry);
  const bytes = file.kind === "found" ? await file.reader.read(file.blob) : null;
  return bytes ? (await readTextPrefix(bytes, ARTIFACT_EXCERPT_READ_BYTES)).content : null;
}

/** `read`, or null past the timeout; nobody awaits it then, so its failure is no unhandled rejection. */
async function withinTimeout<T>(read: Promise<T>): Promise<T | null> {
  read.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((done) => { timer = setTimeout(() => done(null), ARTIFACT_EXCERPT_READ_TIMEOUT_MS); });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Make and store `version`'s excerpt, just committed, its entry Markdown:
 * nothing for any other entry. `entry`: its bytes when the request brought
 * them. Never throws. Waits for the write, at most the read's timeout and one
 * update.
 */
export async function fillVersionExcerpt(item: ArtifactItemRow, version: ArtifactVersionRow, opts: { entry?: Buffer | undefined } = {}): Promise<void> {
  if (artifactFileType(version.entry).kind !== "markdown") return;
  const title = version.title ?? item.title;
  try {
    let columns: ExcerptColumns;
    if (opts.entry) {
      columns = entryExcerpt(version.entry, opts.entry, title);
    } else {
      const text = await withinTimeout(storedEntryText(item, version));
      if (text === null) {
        countAppOperation("artifacts", "excerpt", "fill_failed");
        return;
      }
      columns = excerptColumns(text, title);
    }
    if (columns.excerpt === null) {
      countAppOperation("artifacts", "excerpt", "empty");
      return;
    }
    // Read storage before taking any lock. Deletion locks this same parent
    // before clearing its versions: a late fill must wait and see it deleted,
    // or finish before deletion clears it. A snapshot-only check can miss an
    // uncommitted deletion and restore text after the delete commits.
    const live = await getDb().transaction(async (tx) => {
      const [parent] = await tx.select({ id: artifactItems.id }).from(artifactItems)
        .where(and(eq(artifactItems.id, item.id), isNull(artifactItems.deletedAt))).for("share");
      if (!parent) return false;
      await tx.update(artifactVersions).set(columns).where(and(
        eq(artifactVersions.id, version.id), eq(artifactVersions.itemId, item.id), isNull(artifactVersions.excerpt),
      ));
      return true;
    });
    if (live) countAppOperation("artifacts", "excerpt", "filled");
  } catch (error) {
    countAppOperation("artifacts", "excerpt", "fill_failed");
    // Its class only: a message may quote what the agent wrote.
    console.warn("[artifacts] a version's excerpt was not stored; its card shows none", { versionId: version.id, errorClass: error instanceof Error ? error.name : typeof error });
  }
}

/** fillVersionExcerpt for `item`'s current version (just imported). */
export async function fillCurrentExcerpt(item: ArtifactItemRow): Promise<void> {
  try {
    const version = await currentVersionOf(item);
    if (version) await fillVersionExcerpt(item, version);
  } catch {
    countAppOperation("artifacts", "excerpt", "fill_failed");
  }
}

/** Clear the excerpts of the Artifact `itemId`, in the caller's transaction (manage.ts deleteArtifact). */
export async function clearItemExcerpts(executor: DatabaseExecutor, itemId: string): Promise<void> {
  await executor.update(artifactVersions).set({ excerpt: null, excerptBlocks: null }).where(and(eq(artifactVersions.itemId, itemId), isNotNull(artifactVersions.excerpt)));
}
