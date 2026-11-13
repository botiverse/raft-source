// A public Artifact's readable text, as the signed-out `meta` and `index.md`
// answer it (publicRoutes.ts), stored in `app_artifacts.version_texts` so
// those routes answer without reading object storage (task #110; Tenny's
// decisions):
//
// - One row per version (its id the key, going with the version). Written
//   only for a version of a public Artifact: after a push's commit when the
//   committed home is public (from the entry's inline bytes when it came
//   inline: no storage read), after the Artifact is made public
//   (manage.ts widenArtifactHome), and by a signed-out view that finds none
//   (lazy), only after publicItemOf passed and only for the current version
//   it returned. Save and import never make a public version. No backfill.
// - Always after a commit, in the background (never under the item's lock,
//   never failing the request that made the version): a failed fill writes
//   nothing and the next view tries again. Nothing is written when the entry
//   couldn't be read: that view answers the stub, as before.
// - A row of an older READABLE_TEXT_EXTRACTOR, or whose `kind` isn't the
//   entry's kind now, is a miss: computed again and written over
//   (`INSERT … ON CONFLICT … WHERE`), so a newer row is never replaced by an
//   older process's.
// - One computation per version at once in this process (single-flight):
//   the Worker asks meta and index.md together, and they share one read.
// - Rows stay when the Artifact stops being public, is narrowed or taken
//   down: every request checks visibility first (publicItemOf), and only
//   then reads the row of the current version it returned.
//
// Counted in `slock_app_operations_total{app="artifacts",operation="public_text"}`:
// hit, miss (a signed-out read), filled, fill_failed (a write, or a read
// that couldn't be made).
import { Readable } from "node:stream";
import { eq, sql } from "drizzle-orm";
import { ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES, artifactFileType, type ArtifactKind } from "@botiverse/raft-shared";
import { getDb } from "../../platform/db";
import { countAppOperation } from "../../platform/tracing";
import { currentVersionOf, readTextPrefix, versionFileOf } from "./apiCommon";
import type { ArtifactBlobBytes } from "./blobStore";
import { READABLE_TEXT_EXTRACTOR, describe, htmlReadableText, markdownPlainText, withoutTitleHeading } from "./readableText";
import { artifactVersionTexts, type ArtifactItemRow, type ArtifactVersionRow } from "./schema";

/** The entry kinds index.md and meta read text from. */
export const PUBLIC_TEXT_KINDS: ReadonlySet<ArtifactKind> = new Set(["markdown", "text", "csv", "html"]);

/** How much of the entry is read (bytes): HTML more, as its markup and inline assets aren't text. */
const ENTRY_READ = { text: ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES, html: 2 * 1024 * 1024 };

/** What meta and index.md say of a version's entry. */
export interface PublicText {
  kind: ArtifactKind;
  /** meta's description; "" when there is none (the route says the kind's stub line). */
  description: string;
  /**
   * The entry's readable text, trimmed, at most ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES
   * of UTF-8; null for a kind with no text, or an entry that can't be read now.
   */
  body: string | null;
  /** The entry was cut on reading, or its text on keeping. */
  truncated: boolean;
}

/** At most `maxBytes` of `text` as UTF-8, never splitting a character. */
export function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

const noText = (kind: ArtifactKind): PublicText => ({ kind, description: "", body: null, truncated: false });

/**
 * The version's text, computed from its entry: the inline bytes a push
 * brought (`entry`), else the entry read from storage. `read: false` when it
 * couldn't be read now (no such blob, storage not configured, the bytes
 * missing): the stub, never stored.
 */
async function computePublicText(item: ArtifactItemRow, version: ArtifactVersionRow, entry?: Buffer): Promise<{ text: PublicText; read: boolean }> {
  const kind = artifactFileType(version.entry).kind;
  if (!PUBLIC_TEXT_KINDS.has(kind)) return { text: noText(kind), read: false };
  let bytes: ArtifactBlobBytes | null;
  if (entry) {
    bytes = { stream: Readable.from([entry]), size: entry.length };
  } else {
    const file = await versionFileOf(item, version, version.entry);
    bytes = file.kind === "found" ? await file.reader.read(file.blob) : null;
  }
  if (!bytes) return { text: noText(kind), read: false };
  const prefix = await readTextPrefix(bytes, kind === "html" ? ENTRY_READ.html : ENTRY_READ.text);
  const readable = kind === "html" ? htmlReadableText(prefix.content) : prefix.content;
  // Markdown and HTML's readable text (whose headings and list items are Markdown) without their markers, nor a heading repeating the title.
  const description = describe(kind === "markdown" || kind === "html"
    ? markdownPlainText(withoutTitleHeading(readable, version.title ?? item.title))
    : readable);
  const trimmed = readable.trim();
  const body = utf8Prefix(trimmed, ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES);
  return { text: { kind, description, body, truncated: prefix.truncated || body.length < trimmed.length }, read: true };
}

/** The stored text of `versionId`, when its row is of this extractor (or newer) and of the entry's `kind` now. */
async function storedTextOf(versionId: string, kind: ArtifactKind): Promise<PublicText | null> {
  const [row] = await getDb().select().from(artifactVersionTexts).where(eq(artifactVersionTexts.versionId, versionId)).limit(1);
  if (!row || row.kind !== kind || row.extractor < READABLE_TEXT_EXTRACTOR) return null;
  return { kind, description: row.description, body: row.body, truncated: row.truncated };
}

/** Store the version's text; an existing row only when it is of an older extractor or another kind. */
async function storeText(versionId: string, text: PublicText): Promise<void> {
  await getDb().insert(artifactVersionTexts).values({
    versionId,
    extractor: READABLE_TEXT_EXTRACTOR,
    kind: text.kind,
    description: text.description,
    body: text.body ?? "",
    truncated: text.truncated,
  }).onConflictDoUpdate({
    target: artifactVersionTexts.versionId,
    set: {
      extractor: sql`excluded.extractor`,
      kind: sql`excluded.kind`,
      description: sql`excluded.description`,
      body: sql`excluded.body`,
      truncated: sql`excluded.truncated`,
      createdAt: sql`now()`,
    },
    setWhere: sql`${artifactVersionTexts.extractor} < excluded.extractor OR ${artifactVersionTexts.kind} <> excluded.kind`,
  });
}

/** The computation running for each version id (single-flight), until its row is written. */
const flights = new Map<string, Promise<PublicText>>();
/** Background work not yet settled (fills): what __settlePublicTextFillsForTests waits for. */
const pending = new Set<Promise<void>>();

function inBackground(work: () => Promise<void>): void {
  const task = work().catch((error: unknown) => {
    countAppOperation("artifacts", "public_text", "fill_failed");
    console.warn("artifacts public text fill failed", error instanceof Error ? error.message : error);
  }).finally(() => pending.delete(task));
  pending.add(task);
}

/**
 * The version's text, computed once at a time in this process: a call while
 * one runs (until its row is written) shares it. Its row is written after,
 * in the background, only when the entry was read.
 */
function computeOnce(item: ArtifactItemRow, version: ArtifactVersionRow, entry?: Buffer): Promise<PublicText> {
  const running = flights.get(version.id);
  if (running) return running;
  const computed = computePublicText(item, version, entry);
  const flight = computed.then((result) => result.text);
  // Whoever awaits it sees a failure; nobody waiting (a fill) is no unhandled rejection.
  flight.catch(() => {});
  flights.set(version.id, flight);
  inBackground(async () => {
    try {
      const result = await computed;
      if (!result.read) {
        countAppOperation("artifacts", "public_text", "fill_failed");
        return;
      }
      await storeText(version.id, result.text);
      countAppOperation("artifacts", "public_text", "filled");
    } finally {
      if (flights.get(version.id) === flight) flights.delete(version.id);
    }
  });
  return flight;
}

/**
 * What meta and index.md say of `version`, the current version of `item`
 * that publicItemOf just returned (never any other): its stored text, else
 * computed from storage as before and stored (lazy fill).
 */
export async function publicTextOf(item: ArtifactItemRow, version: ArtifactVersionRow): Promise<PublicText> {
  const kind = artifactFileType(version.entry).kind;
  // A kind with no text never read storage: nothing to store.
  if (!PUBLIC_TEXT_KINDS.has(kind)) return noText(kind);
  const stored = await storedTextOf(version.id, kind);
  if (stored) {
    countAppOperation("artifacts", "public_text", "hit");
    return stored;
  }
  countAppOperation("artifacts", "public_text", "miss");
  return computeOnce(item, version);
}

/**
 * Store `version`'s text in the background, `item` being public now: after
 * a push's commit (with the entry's bytes when they came inline, so no
 * storage read) or once it is made public. Never throws, never waits: a
 * failure is counted and the next signed-out view fills it.
 */
export function fillPublicText(item: ArtifactItemRow, version: ArtifactVersionRow, opts: { entry?: Buffer } = {}): void {
  if (item.homeKind !== "public") return;
  const kind = artifactFileType(version.entry).kind;
  if (!PUBLIC_TEXT_KINDS.has(kind)) return;
  inBackground(async () => {
    // Without the bytes, skip the storage read when its row is already there (made public again).
    if (!opts.entry && await storedTextOf(version.id, kind)) return;
    // Its own background write counts how it went.
    void computeOnce(item, version, opts.entry);
  });
}

/** fillPublicText for `item`'s current version (just made public). */
export function fillCurrentPublicText(item: ArtifactItemRow): void {
  if (item.homeKind !== "public") return;
  inBackground(async () => {
    const version = await currentVersionOf(item);
    if (version) fillPublicText(item, version);
  });
}

/** Wait until every fill started so far (and those they start) has settled. Tests only. */
export async function __settlePublicTextFillsForTests(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}
