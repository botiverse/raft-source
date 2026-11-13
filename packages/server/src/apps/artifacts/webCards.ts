// Cards: the one builder of ArtifactCard (the viewer's `card`, the dashboard's
// rows and the summaries'), and the Artifact's references and summarize
// (AppObjectKind parseRef and summarize, for core's `POST
// /api/objects/summaries`: an id and the version it pins). The web reads its
// message cards there (the links in a message's text, until messages carry
// `artifactRefs`).
//
// Who sees what is core's: the summaries route filters the ids through the
// platform rule (services/objectSummaries.ts, over the homes the registration
// reports: visibility.ts artifactHomes) before summarize sees any; the cards
// are then built by visibleCards, pinned versions alike, with the version as
// shownVersionOf answers it (a reader outside a members-only-history
// Artifact's server reads only the current one), and what changed since the
// reader last looked (`unseen`, artifactCardUnseen: summaries only). Nothing
// here writes or moves a read position (the viewer does, when the current
// version is opened). A constant number of queries however many references.
//
// A deleted Artifact's card (summarizeDeletedArtifacts, AppObjectKind.deleted)
// is the same split: core decides who could see it, by the same rule on the
// home it had (visibility.ts deletedArtifactHomes, never a revoked one), and
// only then is it built here, of the few things that say what it was.
import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  artifactFileType,
  asArtifactCommentId,
  asArtifactId,
  type ArtifactActor,
  type ArtifactCard,
  type ArtifactCardUnseen,
  type ArtifactDeletedReference,
  type ArtifactHome,
  type ArtifactObjectRef,
  type ArtifactPreview,
} from "@botiverse/raft-shared";
import { conversationNames, type ConversationName, type ConversationType } from "../../platform/conversations";
import { getDb } from "../../platform/db";
import { accessOf, artifactAppUrl, readsAsOutsider, type ArtifactActorRef } from "./apiCommon";
import { cardCheckShots, cardShotKey, type CardCheckShots, type CardShotAsk } from "./checks";
import { profiler, shownActorOf, type ArtifactWebReader } from "./webCommon";
import { artifactAudit, artifactComments, artifactItems, artifactReadPositions, artifactVersions, type ArtifactItemRow, type ArtifactVersionRow } from "./schema";

/** A visible Artifact at the version a card shows. */
export interface ShownArtifact {
  item: ArtifactItemRow;
  version: ArtifactVersionRow;
  current: ArtifactVersionRow | null;
  /** The request named a version (`?version=`, `/v/<n>`), even the current one. */
  pinned: boolean;
}

/**
 * atCurrentVersions' rule as a condition on items (an unaliased
 * app_artifacts.items in the statement): a current version that is
 * published and not revoked. For a ranked, limited query, so a row with no
 * card is never counted into a page and dropped after it.
 */
export function hasReadableCurrentVersion(): SQL {
  return sql`EXISTS (SELECT 1 FROM ${artifactVersions}
    WHERE ${artifactVersions.id} = ${artifactItems.currentVersionId}
      AND ${artifactVersions.revokedAt} IS NULL
      AND ${artifactVersions.position} IS NOT NULL)`;
}

/**
 * Items at their current version, for their cards (one query), in input
 * order; an item without a readable current version (unpublished, revoked)
 * is left out.
 */
export async function atCurrentVersions(items: readonly ArtifactItemRow[]): Promise<ShownArtifact[]> {
  const currentIds = items.flatMap((item) => (item.currentVersionId ? [item.currentVersionId] : []));
  const currents = currentIds.length > 0
    ? await getDb().select().from(artifactVersions)
      .where(and(inArray(artifactVersions.id, currentIds), isNull(artifactVersions.revokedAt), isNotNull(artifactVersions.position)))
    : [];
  const currentById = new Map(currents.map((version) => [version.id, version]));
  return items.flatMap((item) => {
    const current = item.currentVersionId ? currentById.get(item.currentVersionId) : undefined;
    return current ? [{ item, version: current, current, pinned: false }] : [];
  });
}

/** The address of an Artifact: `/v/<n>` when a version is pinned. */
const artifactUrl = (id: string, version: number | undefined): string =>
  artifactAppUrl(id, version ?? null);

/**
 * The cards for visible Artifacts, in input order: comment counts in one
 * query, homes in one conversations lookup and the shown versions'
 * screenshots in one query, read at once (artifactCardFacts). `actorOf`
 * names the authors (the caller's one profile lookup, which must include
 * each cardAuthorRef). A pinned card shows its version: kind, facts,
 * preview, and its publisher and publishing time as `author` and
 * `updatedAt`; the rest is the item's.
 */
export async function artifactCards(
  reader: ArtifactWebReader,
  shown: readonly ShownArtifact[],
  actorOf: (actor: ArtifactActorRef) => ArtifactActor,
): Promise<ArtifactCard[]> {
  if (shown.length === 0) return [];
  const showing = shown.map(({ item, version, pinned }) => ({ item, number: pinned ? version.number : null }));
  return cardsOf(reader, shown, actorOf, await artifactCardFacts(reader, shown.map(({ item }) => item), showing));
}

/**
 * What artifactCards reads beside the versions: the items' comment counts,
 * the reader's names of their homes, and the screenshots of the versions the
 * cards show (checks.ts cardCheckShots, by cardShotKey).
 */
export interface ArtifactCardFacts {
  commentCounts: ReadonlyMap<string, number>;
  conversations: ReadonlyMap<string, ConversationName>;
  screenshots: ReadonlyMap<string, CardCheckShots>;
}

/**
 * artifactCards' reads, which need the items and only the number of the
 * version each card shows (`showing`: null for the current one), so a caller
 * may run them beside its own reading of the versions: the live comments of
 * the items the reader may read comments of (one query), the home
 * conversations' names as the reader sees them, and those versions'
 * publish-check screenshots (one query; the flag only when there are some),
 * at once.
 */
export async function artifactCardFacts(reader: ArtifactWebReader, items: readonly ArtifactItemRow[], showing: readonly CardShotAsk[]): Promise<ArtifactCardFacts> {
  const counted = [...new Set(items.filter((item) => accessOf(reader, item).comments).map((item) => item.id))];
  const channelIds = [...new Set(items.flatMap((item) => (item.homeKind === "conversation" && item.homeChannelId ? [item.homeChannelId] : [])))];
  const [counts, conversations, screenshots] = await Promise.all([
    counted.length > 0
      ? getDb().select({ itemId: artifactComments.itemId, count: sql<number>`count(*)::int` }).from(artifactComments)
        .where(and(inArray(artifactComments.itemId, counted), isNull(artifactComments.deletedAt)))
        .groupBy(artifactComments.itemId)
      : [],
    channelIds.length > 0 ? conversationNames(reader, channelIds) : new Map<string, ConversationName>(),
    cardCheckShots(reader.serverId, showing),
  ]);
  return { commentCounts: new Map(counts.map((row) => [row.itemId, row.count])), conversations, screenshots };
}

/**
 * A card's preview: the publish check's screenshots of the version it shows
 * when there are (ArtifactPreview `screenshot`, cardCheckShots' rule; a
 * Markdown version from before it stopped being checked keeps them), else its
 * excerpt (excerpt.ts; `excerpt`, on the version's row, so no query), its
 * blocks with it when it has them, else none (no cover is made yet). The excerpt is of the version the reader may
 * read, whoever they are: shownVersionOf's rule has chosen it, and another
 * server's reader of a public Artifact reads its current version's words.
 */
function previewOf(facts: ArtifactCardFacts, item: ArtifactItemRow, version: ArtifactVersionRow): ArtifactPreview {
  const shots = facts.screenshots.get(cardShotKey(item.id, version.number));
  if (shots) return { kind: "screenshot", desktop: shots.desktop, phone: shots.phone };
  if (!version.excerpt) return { kind: "none" };
  return { kind: "excerpt", text: version.excerpt, ...(version.excerptBlocks ? { blocks: version.excerptBlocks } : {}) };
}

/** artifactCards from facts already read (artifactCardFacts of these items): no query. */
export function cardsOf(
  reader: ArtifactWebReader,
  shown: readonly ShownArtifact[],
  actorOf: (actor: ArtifactActorRef) => ArtifactActor,
  facts: ArtifactCardFacts,
): ArtifactCard[] {
  const { commentCounts, conversations } = facts;
  // The reader's view of the home: a conversation by its id and name as the
  // reader sees it (a joint by the reader's server's projection; none for an
  // orphan, and no id once its channel row is gone).
  const homeOf = (item: ArtifactItemRow): ArtifactHome => {
    if (item.homeKind !== "conversation") return { kind: item.homeKind };
    const channelId = item.homeChannelId;
    const conversation = channelId ? conversations.get(channelId) : undefined;
    return { kind: "conversation", conversation: { id: conversation?.id ?? channelId, name: conversation?.name ?? "", type: conversation?.type ?? "channel", ...(conversation?.peerDisplayName ? { peerDisplayName: conversation.peerDisplayName } : {}) } };
  };
  return shown.map(({ item, version, current, pinned }) => ({
    id: asArtifactId(item.id),
    url: artifactUrl(item.id, pinned ? version.number : undefined),
    title: item.title,
    description: item.description,
    kind: artifactFileType(version.entry).kind,
    facts: { sizeBytes: version.sizeBytes, fileCount: version.fileCount },
    preview: previewOf(facts, item, version),
    version: version.number,
    pinned,
    latestVersion: current?.number ?? version.number,
    author: shownActorOf(reader, item, actorOf(cardAuthorRef({ item, version, pinned }))),
    createdAt: item.createdAt.toISOString(),
    updatedAt: (pinned ? version.createdAt : item.updatedAt).toISOString(),
    commentCount: commentCounts.get(item.id) ?? 0,
    home: homeOf(item),
    ...(readsAsOutsider(reader.serverId, item) ? { fromAnotherServer: true as const } : {}),
  }));
}

/** The actor a card names as its `author`: a pinned version's publisher, else the item's author (for the caller's profile lookup). */
export const cardAuthorRef = ({ item, version, pinned }: Pick<ShownArtifact, "item" | "version" | "pinned">): ArtifactActorRef =>
  pinned ? { type: version.publisherType, id: version.publisherId } : { type: item.createdByType, id: item.createdById };

const keyOf = (id: string, version: number | undefined) => `${id}@${version ?? ""}`;

const textList = (values: readonly string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);

/**
 * ArtifactCard `unseen` for each of `items` the reader has a read position
 * on (#proj-workspace:#141): whether a version by someone else was
 * published past it, and how many live comments by others lie past it. The
 * read position is the one the viewer moves when the current version is
 * opened and Activity's read moves (activity.ts markArtifactsRead), so it
 * is the badge's notion of read; the reader's own versions and comments
 * never count (as shownThrough, and Activity's unreadFor). An item with no
 * read position (never opened) is left out, and so is one the reader reads
 * as an outsider (it keeps none): the card marks nothing. One query however
 * many items, from the read positions' primary key, each count (and the
 * first new comment, where the card opens the list) a range of
 * idx_versions_item_position and idx_comments_item_position.
 */
export async function artifactCardUnseen(reader: ArtifactWebReader, items: readonly ArtifactItemRow[]): Promise<ReadonlyMap<string, ArtifactCardUnseen>> {
  const ids = [...new Set(items.filter((item) => !readsAsOutsider(reader.serverId, item)).map((item) => item.id))];
  if (ids.length === 0) return new Map();
  const me = sql`${reader.userId}::uuid`;
  const rows = (await getDb().execute(sql`
    SELECT rp.item_id,
      EXISTS (
        SELECT 1 FROM ${artifactVersions} v
        WHERE v.item_id = rp.item_id AND v.revoked_at IS NULL AND v.position IS NOT NULL AND v.position > rp.position
          AND NOT (v.publisher_type = 'user' AND v.publisher_id = ${me})
      ) AS newer_version,
      (
        SELECT count(*)::int FROM ${artifactComments} c
        WHERE c.item_id = rp.item_id AND c.deleted_at IS NULL AND c.position > rp.position
          AND NOT (c.author_type = 'user' AND c.author_id = ${me})
      ) AS new_comments,
      (
        SELECT c.id FROM ${artifactComments} c
        WHERE c.item_id = rp.item_id AND c.deleted_at IS NULL AND c.position > rp.position
          AND NOT (c.author_type = 'user' AND c.author_id = ${me})
        ORDER BY c.position LIMIT 1
      ) AS first_new_comment
    FROM ${artifactReadPositions} rp
    WHERE rp.actor_type = 'user' AND rp.actor_id = ${me} AND rp.item_id IN (${textList(ids)})`)).rows as Array<Record<string, unknown>>;
  return new Map(rows.map((row) => [String(row.item_id), {
    newerVersion: row.newer_version === true,
    newComments: Number(row.new_comments),
    firstNewComment: row.first_new_comment == null ? null : asArtifactCommentId(String(row.first_new_comment)),
  }]));
}

/**
 * The cards for Artifacts core found the reader can see (the summaries
 * route's filter, before summarize): for each
 * distinct (id, version) asked, the card of what it shows, or nothing (never
 * published, a version that isn't readable). One query for the items, one
 * for current versions beside one for `unseen` (artifactCardUnseen), one
 * for pinned ones, then artifactCards' own.
 * Visibility is core's, decided before; the items are read again live (a
 * deleted or revoked one shows nothing, should it have gone since).
 */
async function visibleCards(reader: ArtifactWebReader, asked: ReadonlyArray<{ id: string; version?: number | undefined }>): Promise<Map<string, ArtifactCard>> {
  const db = getDb();
  const ids = [...new Set(asked.map((entry) => entry.id))];
  const rows = ids.length > 0
    ? await db.select().from(artifactItems).where(and(inArray(artifactItems.id, ids), isNull(artifactItems.deletedAt), isNull(artifactItems.revokedAt)))
    : [];
  const seen = new Map(rows.map((item) => [item.id, item]));

  // The current version: as currentVersionOf, a published one; beside it, what changed since the reader last looked.
  const currentIds = [...seen.values()].flatMap((item) => (item.currentVersionId ? [item.currentVersionId] : []));
  const [currents, unseen] = await Promise.all([
    currentIds.length > 0
      ? db.select().from(artifactVersions)
        .where(and(inArray(artifactVersions.id, currentIds), isNull(artifactVersions.revokedAt), isNotNull(artifactVersions.position)))
      : [],
    artifactCardUnseen(reader, [...seen.values()]),
  ]);
  const currentOf = new Map(currents.flatMap((version) => {
    const item = seen.get(version.itemId);
    return item && item.currentVersionId === version.id ? [[item.id, version] as const] : [];
  }));

  // Another version by number: as shownVersionOf, never for a reader limited to the current one.
  const pins = [...new Map(asked.flatMap((entry) => {
    const item = seen.get(entry.id);
    if (!item || entry.version === undefined || entry.version === currentOf.get(item.id)?.number) return [];
    if (accessOf(reader, item).historyLimited) return [];
    return [[keyOf(item.id, entry.version), { itemId: item.id, number: entry.version }] as const];
  })).values()];
  const pinned = pins.length > 0
    ? await db.select().from(artifactVersions).where(and(
      isNull(artifactVersions.revokedAt),
      isNotNull(artifactVersions.position),
      or(...pins.map((pin) => and(eq(artifactVersions.itemId, pin.itemId), eq(artifactVersions.number, pin.number)))),
    ))
    : [];
  const pinnedOf = new Map(pinned.map((version) => [keyOf(version.itemId, version.number), version]));

  const shown = new Map<string, ShownArtifact>();
  for (const entry of asked) {
    const item = seen.get(entry.id);
    if (!item) continue;
    const current = currentOf.get(item.id) ?? null;
    const version = entry.version === undefined || entry.version === current?.number ? current : pinnedOf.get(keyOf(item.id, entry.version)) ?? null;
    if (version) shown.set(keyOf(item.id, entry.version), { item, version, current, pinned: entry.version !== undefined });
  }
  const shownList = [...shown.values()];
  const actorOf = await profiler(shownList.map(cardAuthorRef));
  const cards = await artifactCards(reader, shownList, actorOf);
  return new Map([...shown.keys()].map((key, index) => [key, { ...cards[index]!, unseen: unseen.get(shownList[index]!.item.id) ?? null }]));
}

/** Version numbers a reference may pin: as `?version=` reads them (up to nine digits). */
const MAX_REF_VERSION = 999_999_999;

/**
 * The registration's parseRef (AppObjectKind.parseRef): `{ id, version? }`,
 * the version a whole number from 1; nothing else. The id is any string (one
 * that names nothing is unavailable).
 */
export function parseArtifactObjectRef(value: { id: string } & Record<string, unknown>): ArtifactObjectRef | null {
  const { id, version, ...rest } = value;
  if (Object.keys(rest).length > 0) return null;
  if (version === undefined) return { id: asArtifactId(id) };
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > MAX_REF_VERSION) return null;
  return { id: asArtifactId(id), version };
}

/**
 * The registration's summarize (AppObjectKind.summarize, `POST
 * /api/objects/summaries`): for each reference core found the reader can
 * see, in order, the card of the version it pins or of the current one;
 * none for an Artifact never published, or a version that isn't readable
 * (missing, revoked, or another version of a members-only history for a
 * reader outside its server: shownVersionOf's rule). Each card carries the
 * reader's `unseen` (null without a read position): the viewer's card
 * otherwise.
 */
export async function summarizeArtifacts(reader: ArtifactWebReader, refs: readonly ArtifactObjectRef[]): Promise<Array<ArtifactCard | undefined>> {
  const cards = await visibleCards(reader, refs);
  return refs.map((ref) => cards.get(keyOf(ref.id, ref.version)));
}

/**
 * The registration's deleted summaries (AppObjectKind.deleted.summarize;
 * core answers each `{ ok: false, reason: "deleted", deleted }`): for the ids
 * of deleted Artifacts core found the reader could see (on the home each
 * had: visibility.ts deletedArtifactHomes), each one's
 * ArtifactDeletedReference: its title, who deleted it (the audit's `deleted`
 * row, shown as a card's author is: shownActorOf, no id outside a public
 * Artifact's server) and when. Nothing of its content, versions, files,
 * comments or home. Read again here: an id that isn't a deleted, unrevoked
 * item, or one with no recorded delete (none the web routes make: manage.ts
 * writes the row with the delete), is left out, which core answers as the
 * plain `unavailable`. Three queries however many ids.
 */
export async function summarizeDeletedArtifacts(reader: ArtifactWebReader, ids: readonly string[]): Promise<ReadonlyMap<string, ArtifactDeletedReference>> {
  if (ids.length === 0) return new Map();
  const db = getDb();
  const items = await db.select().from(artifactItems)
    .where(and(inArray(artifactItems.id, [...ids]), isNotNull(artifactItems.deletedAt), isNull(artifactItems.revokedAt)));
  if (items.length === 0) return new Map();
  // The newest `deleted` row of each (a delete is written once; newest first should there be more).
  const audits = await db.select({ itemId: artifactAudit.itemId, actorType: artifactAudit.actorType, actorId: artifactAudit.actorId })
    .from(artifactAudit)
    .where(and(inArray(artifactAudit.itemId, items.map((item) => item.id)), eq(artifactAudit.action, "deleted")))
    .orderBy(desc(artifactAudit.createdAt), desc(artifactAudit.id));
  const deleterOf = new Map<string, ArtifactActorRef>();
  for (const row of audits) if (!deleterOf.has(row.itemId)) deleterOf.set(row.itemId, { type: row.actorType, id: row.actorId });
  if (deleterOf.size === 0) return new Map();
  const actorOf = await profiler([...deleterOf.values()]);
  return new Map(items.flatMap((item): Array<[string, ArtifactDeletedReference]> => {
    const deleter = deleterOf.get(item.id);
    if (!deleter) return [];
    return [[item.id, {
      status: "deleted",
      title: item.title,
      deletedBy: shownActorOf(reader, item, actorOf(deleter)),
      deletedAt: item.deletedAt!.toISOString(),
    }]];
  }));
}
