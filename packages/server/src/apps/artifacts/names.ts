// Looking an Artifact up by its title, and the old names (#proj-workspace:98241a2e:
// an Artifact is its id and its title; Artifacts made since have no name).
//
// A lookup by title or by old name searches one namespace: every home of the
// caller's server, and each joint it is in, whichever server published there
// (lookupScope), then answers only among the Artifacts the caller can see
// (apiCommon resolveVisibleItem). A joint's namespace is every id one of its
// Artifacts may name: the canonical channel and each server's projection of
// it (an Artifact homed before publish stored the canonical channel, or in a
// channel converted to a joint since; platform/visibility jointHomeAliases).
//
// Old names: an Artifact from before titles, or imported from
// raft-artifacts.com, keeps the name it had, unique among the live Artifacts
// of one home that have one (the idx_items_live_name_* indexes; NULLs never
// collide). Whoever may put an Artifact into a home can already see every
// Artifact there, so "this name is taken here" tells them nothing new
// (Tenny). The unique index is per home_channel_id, so it cannot see across a
// joint's ids: the check does (liveInConversationHomes). A move (manage.ts),
// a restore (takedown.ts) and an import check their target home the same way.
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { AGENT_API_ARTIFACT_RESERVED_NAMES, decodeArtifactShortId, type ServerId } from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../../platform/db";
import { jointHomeAliases, jointCanonicalChannelIds } from "../../platform/visibility";
import { artifactItems, type ArtifactItemRow } from "./schema";

/** Raft Artifacts' names: lowercase letters, digits and inner hyphens, up to 63 (as parseArtifactRef). */
export const ARTIFACT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const RESERVED: ReadonlySet<string> = new Set(AGENT_API_ARTIFACT_RESERVED_NAMES);
/**
 * Never an Artifact's name (an import refuses one): a route word under
 * `/artifacts/` (AGENT_API_ARTIFACT_RESERVED_NAMES), or a name that reads as
 * a short id (22 characters of Base58 that fit 16 bytes: a digit 1-9, then
 * only digits and lowercase letters other than `l`, no `0` or `-`), which
 * every reader of a reference takes as an id first (resolveVisibleItem looks
 * it up as a title or name only when no Artifact has that id), so a lookup by
 * that name could find the id's Artifact instead.
 */
export const isReservedArtifactName = (name: string): boolean => RESERVED.has(name) || decodeArtifactShortId(name) !== null;

export type ArtifactHomeRef = { kind: "conversation"; channelId: string } | { kind: "server" | "public" };

const live = (): SQL => and(isNull(artifactItems.deletedAt), isNull(artifactItems.revokedAt))!;

/**
 * The live items of one home of a server: an old name's namespace. A
 * conversation home's is the conversation's, whatever the item's server: a
 * joint's canonical channel is one home for every server in the joint, with
 * every server's projection of it (liveInConversationHomes). A server or
 * public home's is the server's. One query for a conversation home.
 */
export async function liveInHome(executor: DatabaseExecutor, serverId: ServerId, home: ArtifactHomeRef): Promise<SQL> {
  if (home.kind === "conversation") return liveInConversationHomes(executor, [home.channelId]);
  return and(eq(artifactItems.serverId, serverId), eq(artifactItems.homeKind, home.kind), live())!;
}

/**
 * The live items of these conversation homes, each with all its aliases: a
 * joint's canonical channel and every server's projection of it
 * (jointHomeAliases; any other conversation is its own only). The one
 * namespace both the uniqueness check (liveInHome) and the lookups
 * (lookupScope) search. One query.
 */
async function liveInConversationHomes(executor: DatabaseExecutor, channelIds: readonly string[]): Promise<SQL> {
  const ids = await jointHomeAliases(channelIds, { executor });
  return and(eq(artifactItems.homeKind, "conversation"), sql`${artifactItems.homeChannelId} = ANY(${`{${ids.join(",")}}`}::uuid[])`, live())!;
}

/**
 * The live items a title or an old name of the caller's server is looked up
 * among: every home of `serverId`, and each joint `serverId` is in, whichever
 * server published there. Visibility is the caller's to apply (apiCommon
 * resolveVisibleItem). Two queries.
 */
async function lookupScope(executor: DatabaseExecutor, serverId: ServerId): Promise<SQL> {
  const joints = await jointCanonicalChannelIds(serverId, { executor });
  const ownServer = and(eq(artifactItems.serverId, serverId), live())!;
  return joints.length === 0 ? ownServer : or(ownServer, await liveInConversationHomes(executor, joints))!;
}

/**
 * The live items titled `title` (trimmed and compared in any case, as
 * Postgres folds it: lower(btrim(title))) in lookupScope. No index: a
 * server's Artifacts are scanned (a lookup by title is the agent's
 * convenience; ids are what links and answers carry). Three queries.
 */
export async function titledForLookup(executor: DatabaseExecutor, serverId: ServerId, title: string): Promise<ArtifactItemRow[]> {
  return executor.select().from(artifactItems).where(and(
    sql`lower(btrim(${artifactItems.title})) = lower(${title.trim()})`,
    await lookupScope(executor, serverId),
  ));
}

/** The live items with the old name `name` in lookupScope. Three queries. */
export async function namedForLookup(executor: DatabaseExecutor, serverId: ServerId, name: string): Promise<ArtifactItemRow[]> {
  return executor.select().from(artifactItems).where(and(
    eq(artifactItems.name, name),
    await lookupScope(executor, serverId),
  ));
}

/** A unique index refused the write (Postgres 23505, anywhere in the cause chain): an old name another live Artifact of the home has. */
export const isUniqueViolation = (error: unknown): boolean => {
  for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
    if ((cause as { code?: unknown }).code === "23505") return true;
  }
  return false;
};

/** Whether a live Artifact of `home` has the old name `name` (callers ask only for an Artifact that has one). */
export async function isNameTakenInHome(executor: DatabaseExecutor, serverId: ServerId, home: ArtifactHomeRef, name: string): Promise<boolean> {
  const [row] = await executor.select({ id: artifactItems.id }).from(artifactItems)
    .where(and(await liveInHome(executor, serverId, home), eq(artifactItems.name, name))).limit(1);
  return row !== undefined;
}
