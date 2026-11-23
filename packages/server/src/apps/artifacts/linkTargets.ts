// A version's links to other Artifacts, and what each names for the reader
// who asks (#proj-workspace:#336, step 1's read route): the viewer labels a
// page's bare links with the target's live title, matching the page's links
// by `href`. Signed in, `GET /api/artifacts/:id/links?version=` (createLinkOperations,
// webRoutes.ts); signed out, `GET /api/public/artifacts/:id/links`
// (publicRoutes.ts, the current version only). Contracts: shared
// webArtifactsContract.ts ArtifactWebLinks, publicArtifactsContract.ts
// ArtifactPublicLinks. Reads only, moves no read position.
//
// The links (versionLinksOf), at most ARTIFACT_CONTENT_LINKS_MAX:
// - the current version's: core's object_references rows (references.ts),
//   filled first when they aren't this extractor's (ensureArtifactReferences,
//   lazily, within its 5 s), read with the version's mark in one snapshot so
//   they are that version's: a push since (which drops the rows and the
//   mark) reads the version as an older one;
// - an older version's: read from its files on the fly (extractVersionLinks,
//   the same limits, nothing stored), one read per version at a time in this
//   process.
// A read that fails or runs out of time is 503 CONTENT_UNAVAILABLE (nothing
// half-answered; the next ask tries again).
//
// What each target is for the reader, decided per ask (never stored, so a
// rename or a move shows at once), in a constant number of queries however
// many links (one for the targets, the visibility checks batched, one for
// their versions, one for deletes on record):
// - a signed-in reader (readerTargets): `ok` exactly when opening the link
//   would (webCommon readableItemFor: canViewArtifacts, the target's server
//   answering for it, apiCommon itemsReadable; the reader's own flag was
//   checked with the source) and the target has a published current version
//   (a message card's rule, webCards.ts visibleCards; otherwise
//   `unavailable`); a pinned version exists as the viewer reads one
//   (webViewer.ts shownVersionOf: readable, and only the current one for a
//   reader outside a public target's server). `deleted` exactly when a
//   message card for it says so (core's services/objectSummaries.ts
//   deletedSummaries, visibility.ts deletedArtifactHomes, webCards.ts
//   summarizeDeletedArtifacts): deleted, never revoked, the reader seeing
//   the home it had (a public one read as its own server's: homeWhenDeleted),
//   its server answering for it on that home, a delete on record. The
//   viewer, open and locate answer such a target the one 404, as before;
//   this says only `deleted`, never its title, who or when.
// - a signed-out visitor (anonymousTargets): `ok` exactly when the target is
//   itself one the public routes show (publicRoutes publicItemOf's checks:
//   canViewArtifactsAnonymously, a published current version, itemsReadable),
//   a pinned version existing only when it is that current one (the public
//   view's current version only); `unavailable` otherwise, never `deleted`.
// Anything else is `unavailable`, the same for every reason: one the reader
// can't see and one that doesn't exist answer alike.
//
// And whether the version's author sees each target now (`authorSees`,
// authorSight): the page's scripts are its author's and read every label the
// viewer gives it, so the viewer labels a link only where the author, too,
// could know what the label says (Tenny's review). The author is the
// version's publisher (`versions.publisher_type`/`publisher_id`), read in
// the source's own server (as manage.ts reads an item's author), by the
// reader's own notion of sight (artifactSight: live and seen, or deleted and
// seen on the home it had), and only while the account is there (a public
// home is anyone's, so sight alone would say yes for a gone author). Two
// lookups more, at once with the reader's, however many links. A signed-out
// visitor's targets are public ones: `authorSees` is true there.
import { and, eq, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import {
  ARTIFACT_CONTENT_LINKS_MAX,
  artifactFileType,
  asArtifactId,
  type ArtifactContentLink,
  type ArtifactLinkTarget,
  type ArtifactWebLinks,
} from "@botiverse/raft-shared";
import { actorKey, actorProfiles } from "../../platform/actors";
import { getDb } from "../../platform/db";
import { referencesOfSource, type ObjectReference } from "../../platform/references";
import type { ServerViewActor } from "../../platform/visibility";
import { accessOf, itemsReadable, json, type ArtifactApiJson } from "./apiCommon";
import { CONTENT_LINKS_EXTRACTOR, type ContentLink } from "./contentLinks";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import { ensureArtifactReferences, extractVersionLinks } from "./references";
import { artifactAudit, artifactItems, artifactVersions, type ArtifactItemRow, type ArtifactVersionRow } from "./schema";
import { artifactSight, canViewArtifactsAnonymously, homeWhenDeleted } from "./visibility";
import { answerWeb, readableItemFor, readerViewActor, webFail, type ArtifactWebApiError, type ArtifactWebReader } from "./webCommon";
import { parseVersionQuery, shownVersionOf } from "./webViewer";

/** A version's links not readable now: the web's and the public route's one answer for it. */
export const linksUnavailable = (): ArtifactWebApiError => webFail(503, {
  code: "CONTENT_UNAVAILABLE",
  error: "This artifact's links to other artifacts couldn't be read just now: show the page without them, and ask again in a moment.",
});

/** A stored reference as the link it was read from, or null for a row that isn't one (another kind, malformed facts). */
function storedLink(row: ObjectReference): ContentLink | null {
  if (row.kind !== ARTIFACT_OBJECT_KIND) return null;
  const { href, path, bare, version } = row.detail;
  if (typeof href !== "string" || typeof path !== "string" || typeof bare !== "boolean") return null;
  const targetVersion = version === null ? null : typeof version === "number" && Number.isSafeInteger(version) && version > 0 ? version : undefined;
  if (targetVersion === undefined) return null;
  return { path, href, targetId: asArtifactId(row.id), targetVersion, bare };
}

/**
 * The current version's stored links, read with its mark in one snapshot:
 * null when the rows are no longer that version's (a push since dropped them
 * and the mark, or another version's are there now).
 */
async function storedLinksOf(item: ArtifactItemRow, version: ArtifactVersionRow): Promise<ContentLink[] | null> {
  return getDb().transaction(async (tx) => {
    const [marked] = await tx.select({ extractor: artifactVersions.referencesExtractor }).from(artifactVersions)
      .where(eq(artifactVersions.id, version.id)).limit(1);
    if (!marked || marked.extractor === null || marked.extractor < CONTENT_LINKS_EXTRACTOR) return null;
    const rows = await referencesOfSource(tx, ARTIFACT_OBJECT_KIND, item.id);
    return rows.flatMap((row) => {
      const link = storedLink(row);
      return link ? [link] : [];
    }).slice(0, ARTIFACT_CONTENT_LINKS_MAX);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** The on-the-fly read running for each version id (one at a time per version in this process). */
const reads = new Map<string, Promise<ContentLink[] | null>>();

/** An older version's links, read from its files (extractVersionLinks); null when they can't be read now. Never throws. */
function readLinksOf(item: ArtifactItemRow, version: ArtifactVersionRow): Promise<ContentLink[] | null> {
  const running = reads.get(version.id);
  if (running) return running;
  const read = extractVersionLinks(item, version)
    .then((links) => links?.links.slice(0, ARTIFACT_CONTENT_LINKS_MAX) ?? null)
    .catch((error: unknown) => {
      // Its class only: a message may quote the page.
      console.warn("[artifacts] a version's links were not read", { versionId: version.id, errorClass: error instanceof Error ? error.name : typeof error });
      return null;
    })
    .finally(() => {
      if (reads.get(version.id) === read) reads.delete(version.id);
    });
  reads.set(version.id, read);
  return read;
}

/**
 * The links of `version` of `item` (the header): the current version's
 * stored rows, filled first when they aren't this extractor's; an older
 * version's (or the current one's, should a push have made it older since)
 * read from its files. Null when they can't be read now. The caller has
 * checked the reader may read this version.
 */
export async function versionLinksOf(item: ArtifactItemRow, version: ArtifactVersionRow): Promise<ContentLink[] | null> {
  if (version.id === item.currentVersionId) {
    if (!(await ensureArtifactReferences(item))) return null;
    const stored = await storedLinksOf(item, version);
    if (stored) return stored;
  }
  return readLinksOf(item, version);
}

/** A target the reader may open: its row, its current version, and its versions the links pin that the reader may open. */
interface OpenTarget {
  item: ArtifactItemRow;
  current: Pick<ArtifactVersionRow, "number" | "entry">;
  /** A pinned version by number, as the reader may open it; undefined: none. */
  pinned: (number: number) => Pick<ArtifactVersionRow, "number" | "entry"> | undefined;
}

const UNAVAILABLE: ArtifactLinkTarget = { state: "unavailable" };
const DELETED: ArtifactLinkTarget = { state: "deleted" };
const versionKey = (itemId: string, number: number) => `${itemId}@${number}`;
const distinctTargets = (links: readonly ContentLink[]) => [...new Set(links.map((link) => link.targetId))];

/** The targets' rows, in one query. */
async function targetRows(ids: readonly string[]): Promise<ArtifactItemRow[]> {
  return ids.length === 0 ? [] : getDb().select().from(artifactItems).where(inArray(artifactItems.id, [...ids]));
}

/**
 * The readable versions of `items` the links may open, in one query: each
 * item's current version (published, not revoked: as currentVersionOf), and
 * the pinned ones `pins` asks for by number (as shownVersionOf reads one).
 */
async function versionsOf(items: readonly ArtifactItemRow[], pins: ReadonlyArray<{ itemId: string; number: number }>) {
  const currentIds = items.flatMap((item) => (item.currentVersionId ? [item.currentVersionId] : []));
  const asked: SQL[] = [
    ...(currentIds.length > 0 ? [inArray(artifactVersions.id, currentIds)] : []),
    ...pins.map((pin) => and(eq(artifactVersions.itemId, pin.itemId), eq(artifactVersions.number, pin.number))!),
  ];
  const rows = asked.length === 0 ? [] : await getDb()
    .select({ id: artifactVersions.id, itemId: artifactVersions.itemId, number: artifactVersions.number, entry: artifactVersions.entry })
    .from(artifactVersions)
    .where(and(isNull(artifactVersions.revokedAt), isNotNull(artifactVersions.position), or(...asked)));
  const currentIdOf = new Map(items.map((item) => [item.id, item.currentVersionId]));
  return {
    currentOf: new Map(rows.filter((row) => currentIdOf.get(row.itemId) === row.id).map((row) => [row.itemId, row])),
    byNumber: new Map(rows.map((row) => [versionKey(row.itemId, row.number), row])),
  };
}

/** What a link names, from the targets the reader may open and those it may be told were deleted. */
function targetOf(link: ContentLink, open: ReadonlyMap<string, OpenTarget>, deleted: ReadonlySet<string>): ArtifactLinkTarget {
  const target = open.get(link.targetId);
  if (!target) return deleted.has(link.targetId) ? DELETED : UNAVAILABLE;
  const kindOf = (version: Pick<ArtifactVersionRow, "entry">) => artifactFileType(version.entry).kind;
  if (link.targetVersion === null) return { state: "ok", title: target.item.title, kind: kindOf(target.current) };
  const pinned = target.pinned(link.targetVersion);
  return { state: "ok", title: target.item.title, kind: kindOf(pinned ?? target.current), versionExists: pinned !== undefined };
}

/** The answer's links: each as read, with what it names and whether the version's author sees it. */
const answerLinks = (
  links: readonly ContentLink[],
  targetOfLink: (link: ContentLink) => ArtifactLinkTarget,
  authorSees: (link: ContentLink) => boolean,
): ArtifactContentLink[] =>
  links.map((link) => ({ href: link.href, path: link.path, bare: link.bare, id: link.targetId, version: link.targetVersion, target: targetOfLink(link), authorSees: authorSees(link) }));

/** Who published `version` of `source`, as visibility reads them: in the source's own server (manage.ts reads an item's author so). */
const authorOf = (source: ArtifactItemRow, version: ArtifactVersionRow): ServerViewActor =>
  ({ type: version.publisherType, id: version.publisherId, serverId: source.serverId });

/**
 * The targets (`items`) the version's author sees now (the header's rule):
 * artifactSight's `visible` or `deleted` for the author, and the author's
 * account still there (actorProfiles: a person's row, a live agent's). In two
 * lookups at once however many targets; none for no targets.
 */
async function authorSight(author: ServerViewActor, items: readonly ArtifactItemRow[]): Promise<ReadonlySet<string>> {
  if (items.length === 0) return new Set();
  const ref = { type: author.type, id: author.id };
  const [sight, profiles] = await Promise.all([artifactSight(author, items), actorProfiles([ref])]);
  if (!profiles.has(actorKey(ref))) return new Set();
  return new Set(items.filter((_, index) => sight[index] !== null).map((item) => item.id));
}

/** The targets of `links` (their rows, `items`) for a signed-in reader (the header's rule). */
async function readerTargets(reader: ArtifactWebReader, items: readonly ArtifactItemRow[], links: readonly ContentLink[]): Promise<(link: ContentLink) => ArtifactLinkTarget> {
  if (items.length === 0) return () => UNAVAILABLE;
  // Sight and whether each target's server answers for it, at once; a deleted one on the home it is judged by.
  const [sight, readable] = await Promise.all([
    artifactSight(readerViewActor(reader), items),
    itemsReadable(items.map((item) => (item.deletedAt !== null ? homeWhenDeleted(item) : item))),
  ]);
  const seen = items.filter((_, index) => sight[index] === "visible" && readable[index]);
  const deletedSeen = items.filter((_, index) => sight[index] === "deleted" && readable[index]);
  // Pinned versions other than the current one: never for a reader limited to it (an outsider of a public target).
  const seenById = new Map(seen.map((item) => [item.id, item]));
  const pins = [...new Map(links.flatMap((link) => {
    const item = seenById.get(link.targetId);
    if (!item || link.targetVersion === null || accessOf(reader, item).historyLimited) return [];
    return [[versionKey(item.id, link.targetVersion), { itemId: item.id, number: link.targetVersion }] as const];
  })).values()];
  const [{ currentOf, byNumber }, onRecord] = await Promise.all([
    versionsOf(seen, pins),
    // A delete on record (manage.ts writes it with the delete), as the deleted card needs one.
    deletedSeen.length === 0 ? [] : getDb().selectDistinct({ itemId: artifactAudit.itemId }).from(artifactAudit)
      .where(and(inArray(artifactAudit.itemId, deletedSeen.map((item) => item.id)), eq(artifactAudit.action, "deleted"))),
  ]);
  const open = new Map(seen.flatMap((item): Array<[string, OpenTarget]> => {
    const current = currentOf.get(item.id);
    if (!current) return [];
    const limited = accessOf(reader, item).historyLimited;
    return [[item.id, {
      item,
      current,
      pinned: (number) => (number === current.number ? current : limited ? undefined : byNumber.get(versionKey(item.id, number))),
    }]];
  }));
  const deleted = new Set(onRecord.map((row) => row.itemId));
  return (link) => targetOf(link, open, deleted);
}

/** The targets of `links` for a signed-out visitor (the header's rule: publicItemOf's checks, batched). */
async function anonymousTargets(links: readonly ContentLink[]): Promise<(link: ContentLink) => ArtifactLinkTarget> {
  const items = await targetRows(distinctTargets(links));
  const shown = canViewArtifactsAnonymously(items);
  const candidates = items.filter((_, index) => shown[index]);
  if (candidates.length === 0) return () => UNAVAILABLE;
  const [readable, { currentOf }] = await Promise.all([itemsReadable(candidates), versionsOf(candidates, [])]);
  const open = new Map(candidates.flatMap((item, index): Array<[string, OpenTarget]> => {
    const current = currentOf.get(item.id);
    if (!readable[index] || !current) return [];
    // The public view reads the current version only.
    return [[item.id, { item, current, pinned: (number) => (number === current.number ? current : undefined) }]];
  }));
  return (link) => targetOf(link, open, new Set());
}

/**
 * `version` of `source`'s links as a signed-in reader (`reader`) or a
 * signed-out visitor (null) is answered them: each target for the reader, and
 * whether the version's author sees it (always, for a visitor: their targets
 * are public ones).
 */
export async function linksAnswer(reader: ArtifactWebReader | null, source: ArtifactItemRow, version: ArtifactVersionRow, links: readonly ContentLink[]): Promise<ArtifactWebLinks> {
  if (!reader) return { version: version.number, links: answerLinks(links, await anonymousTargets(links), () => true) };
  const items = await targetRows(distinctTargets(links));
  const [targetOfLink, seenByAuthor] = await Promise.all([readerTargets(reader, items, links), authorSight(authorOf(source, version), items)]);
  return { version: version.number, links: answerLinks(links, targetOfLink, (link) => seenByAuthor.has(link.targetId)) };
}

export function createLinkOperations() {
  return {
    /**
     * `GET /:id/links?version=`: the Artifact and the version as the viewer
     * reads them (readableItemFor: 403 ARTIFACTS_NOT_ENABLED, the one 404;
     * shownVersionOf: 400 INVALID_REQUEST, 404 VERSION_NOT_FOUND), then its
     * links (503 CONTENT_UNAVAILABLE when they can't be read now), what
     * each names for the reader, and whether the version's author sees it
     * (`authorSees`: the viewer labels no other).
     */
    links: (reader: ArtifactWebReader, id: string, query: { version?: unknown }): Promise<ArtifactApiJson<ArtifactWebLinks> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await readableItemFor(reader, id);
      const { version } = await shownVersionOf(reader, item, parseVersionQuery(query.version));
      const links = await versionLinksOf(item, version);
      if (!links) return linksUnavailable();
      return json(await linksAnswer(reader, item, version, links));
    }),
  };
}
