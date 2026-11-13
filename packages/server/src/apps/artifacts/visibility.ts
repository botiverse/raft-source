// Who can see an Artifact: exactly who can see its home (§3.1, one home). The
// rules are the platform's (platform/visibility: standing in the server,
// top-level homes of the item's server, a joint channel's canonical channel
// seen from every participating server through its own projection, another
// server's item only so or when public, and orphans, an item whose home
// conversation was deleted or whose home_channel_id the foreign key
// cleared); this file only maps an item to its home (homeOf, over the
// standard home columns) and adds what is Artifact-specific: deleted and
// revoked items are never visible. For core's
// own filter (the summaries route) it
// reports the live items' homes instead (artifactHomes), and the deleted
// ones' for their deleted cards (deletedArtifactHomes: never a revoked one).
import { and, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { AppObjectHome } from "../../platform/apps";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import {
  canViewHomes,
  canViewHomesAnonymously,
  homeOf,
  serverViewersLost,
  viewersOfHome,
  visibleHomes,
  visibleHomesSql,
  type HomeColumns,
  type HomeNarrowing,
  type ServerViewActor,
  type ViewActor,
} from "../../platform/visibility";
import { artifactItems, type ArtifactItemRow } from "./schema";

/** What visibility reads of an item. */
export type ArtifactVisibilitySubject = Pick<
  ArtifactItemRow,
  "serverId" | "homeKind" | "homeChannelId" | "deletedAt" | "revokedAt" | "createdByType" | "createdById"
>;

/** The item as the platform's visibility reads it. */
const homedObject = (item: ArtifactVisibilitySubject) => ({ serverId: item.serverId, home: homeOf(item), author: { type: item.createdByType, id: item.createdById } });

/**
 * canView for many items: one boolean per item, in input order, in a constant
 * number of queries however many items are passed.
 *
 * - deleted or revoked: nobody (a revoked Artifact is "not found" for
 *   everyone, as in Raft Artifacts today);
 * - otherwise canViewHomes: the home decides, for an actor who stands in its
 *   own server: a top-level conversation of the item's server for its
 *   actors, a joint channel's canonical channel for the joint's members on
 *   every participating server; another server's actor is otherwise an
 *   outsider, public homes only (C8); an orphan is the platform's to decide
 *   (its author, the author agent's manager, the server's owners and admins).
 */
export async function canViewArtifacts(
  actor: ViewActor,
  items: readonly ArtifactVisibilitySubject[],
  opts?: { executor?: DatabaseExecutor },
): Promise<boolean[]> {
  const asked = items.flatMap((item, index) => (item.deletedAt !== null || item.revokedAt !== null ? [] : [{ index, object: homedObject(item) }]));
  const answers = await canViewHomes(actor, asked.map((entry) => entry.object), opts);
  const visible = items.map(() => false);
  asked.forEach((entry, position) => { visible[entry.index] = answers[position]!; });
  return visible;
}

/**
 * canViewArtifacts for a signed-out visitor (publicRoutes.ts, and the content
 * Worker's anonymous authorize): a live (not deleted or revoked) item whose
 * home is public (platform/visibility canViewHomesAnonymously), nothing else.
 * No query.
 */
export function canViewArtifactsAnonymously(items: readonly ArtifactVisibilitySubject[]): boolean[] {
  const answers = canViewHomesAnonymously(items.map(homedObject));
  return items.map((item, index) => item.deletedAt === null && item.revokedAt === null && answers[index]!);
}

/**
 * canViewArtifacts turned the other way: which of many actors, each in its
 * own server, can see one item, one boolean per actor in input order, in a
 * fixed number of queries per server however many actors (viewersOfHome).
 * The same answers as canViewArtifacts. `requireStanding`: only actors who
 * stand in the item's server, whatever the home (people and agents a
 * mention, presence or notice names: never another server's, a joint's
 * other members included).
 */
export async function actorsWhoCanViewArtifact(
  actors: readonly ServerViewActor[],
  item: ArtifactVisibilitySubject,
  opts?: { requireStanding?: boolean },
): Promise<boolean[]> {
  if (item.deletedAt !== null || item.revokedAt !== null) return actors.map(() => false);
  return viewersOfHome(homedObject(item), actors, opts);
}

/**
 * What moving a live item to `to` takes from its own server: how many of the
 * server's people and agents (at most `maxCounted` of them) see it now and
 * wouldn't there (platform/visibility serverViewersLost; `capped` past
 * `maxCounted`, the counts then a lower bound). Nobody outside the server is
 * counted.
 */
export function artifactViewersLost(
  item: ArtifactVisibilitySubject,
  to: { kind: "conversation"; channelId: string } | { kind: "server" | "public" },
  opts: { maxCounted: number },
): Promise<{ people: number; agents: number; capped: boolean }> {
  const moved = { ...item, homeKind: to.kind, homeChannelId: to.kind === "conversation" ? to.channelId : null };
  return serverViewersLost(homedObject(item), homeOf(moved), opts);
}

/**
 * The list form of canViewArtifacts, as a condition on `app_artifacts.items`:
 * the live items of the actor's server, and of any server in the actor's
 * joints that has workspace_artifacts_v0 on (a list follows each item's own
 * server's flag, as reading one by id does), whose home the actor can see
 * (platform/visibility visibleHomesSql on the items' home columns, the same
 * homes canViewArtifacts accepts), in a constant number of queries per
 * request. The actor's own server's flag is the caller's to check first. Orphans are never listed (the platform's rule); those who may
 * still see one reach it by id through canViewArtifacts. `narrow` keeps only
 * some homes (the dashboard's `home` filter; platform/visibility
 * HomeNarrowing).
 */
export async function visibleArtifactsSql(actor: ViewActor, opts?: { executor?: DatabaseExecutor; narrow?: HomeNarrowing }): Promise<SQL> {
  return liveArtifactsIn(await visibleHomesSql(actor, ARTIFACT_HOME_COLUMNS, { ...opts, appFlag: WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY }));
}

/**
 * visibleArtifactsSql with the `home` narrowing (`narrowed`) and without it
 * (`everywhere`), the homes read once: for a list that also counts everything
 * the reader can see (webDashboard.ts `dashboardAll`).
 */
export async function visibleArtifactsNarrowed(actor: ViewActor, narrow: HomeNarrowing | undefined): Promise<{ narrowed: SQL; everywhere: SQL }> {
  const homes = await visibleHomes(actor, { appFlags: [WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY] });
  const everywhere = liveArtifactsIn(homes.sql(ARTIFACT_HOME_COLUMNS, { appFlag: WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY }));
  return { everywhere, narrowed: narrow ? liveArtifactsIn(homes.sql(ARTIFACT_HOME_COLUMNS, { appFlag: WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, narrow })) : everywhere };
}

/** The items' standard home columns, for a visible-homes condition (platform/visibility HomeColumns). */
export const ARTIFACT_HOME_COLUMNS: HomeColumns = {
  serverId: artifactItems.serverId,
  homeKind: artifactItems.homeKind,
  homeChannelId: artifactItems.homeChannelId,
};

/**
 * Of the items a visible-homes condition on ARTIFACT_HOME_COLUMNS lets
 * through (visibleHomesSql's, or the one core's search hands the app; both
 * asked for workspace_artifacts_v0, so another server's joint item passes
 * only while its server has it on), the live ones: what visibleArtifactsSql
 * adds of its own.
 */
export function liveArtifactsIn(homes: SQL): SQL {
  return sql`(${homes}
    AND ${artifactItems.deletedAt} IS NULL
    AND ${artifactItems.revokedAt} IS NULL)`;
}

/**
 * The registration's homes (AppObjectKind.homes): where each live item of
 * these ids lives, for core's visibility (services/objectSummaries.ts).
 * Deleted, revoked and unknown ids are left out: nobody sees them. One query.
 */
export async function artifactHomes(ids: readonly string[]): Promise<ReadonlyMap<string, AppObjectHome>> {
  return homesWhere(ids, and(isNull(artifactItems.deletedAt), isNull(artifactItems.revokedAt))!);
}

/**
 * The registration's deleted homes (AppObjectKind.deleted.homes): where each
 * deleted item of these ids lived, for core's visibility before a deleted
 * card (webCards.ts summarizeDeletedArtifacts), so that card goes only to who
 * could see the item were it not deleted. A delete only sets `deleted_at`
 * (manage.ts) and a deleted item is never moved, so the home columns are the
 * ones it had then (a home channel deleted since makes it an orphan, as for
 * a live item). A public item's card is its own server's only (its home read
 * as the whole server): deleting withdraws what publishing opened to
 * outsiders. A revoked item is left out, deleted or not: taken down, it is
 * nobody's to see, a deleted card included. One query.
 */
export async function deletedArtifactHomes(ids: readonly string[]): Promise<ReadonlyMap<string, AppObjectHome>> {
  const homes = await homesWhere(ids, and(isNotNull(artifactItems.deletedAt), isNull(artifactItems.revokedAt))!);
  // A public item is open to outsiders only while its author keeps it public; deleting takes that
  // back, so its card is for its own server's people: a public home is read as the whole server (Tenny, #11590).
  return new Map([...homes].map(([id, home]) => [id, home.homeKind === "public" ? { ...home, homeKind: "server" as const, homeChannelId: null } : home]));
}

async function homesWhere(ids: readonly string[], state: SQL): Promise<ReadonlyMap<string, AppObjectHome>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb().select({
    id: artifactItems.id,
    serverId: artifactItems.serverId,
    homeKind: artifactItems.homeKind,
    homeChannelId: artifactItems.homeChannelId,
    createdByType: artifactItems.createdByType,
    createdById: artifactItems.createdById,
  }).from(artifactItems).where(and(inArray(artifactItems.id, [...ids]), state));
  return new Map(rows.map((row) => [row.id, {
    serverId: row.serverId,
    homeKind: row.homeKind,
    homeChannelId: row.homeChannelId,
    author: { type: row.createdByType, id: row.createdById },
  }]));
}
