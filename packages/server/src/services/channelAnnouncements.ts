/**
 * Channel announcements (#proj-chat:#29, flag channel_announcement_v0).
 *
 * A channel's announcement is one object homed in that channel, of the one
 * registered kind that declares `channelAnnouncement` (an Artifact): its id
 * is `channels.announcement_artifact_id`, the same on every projection of a
 * joint. Nothing else is stored: its versions are the edit history, its
 * comments the discussion, and who sees it is the home's rule.
 *
 * - A joint has an announcement only while every server sharing it has the
 *   flag (and the announcement's app) on (`jointsWithoutAnnouncements`): the
 *   id is one value on every side's copy, so it is every side's or nobody's.
 *   With one side off it reads as none everywhere, binds no push, tells no
 *   agent, and can't be set.
 * - Read (`resolveChannelAnnouncements`): only while the flag is on for the
 *   reader's server; an id stands only while the reader can see the object
 *   (core's object visibility, both servers' app flag included) and it is
 *   still homed in that channel (for a joint, the joint's canonical channel
 *   or a projection of it). Anything else (deleted, taken down, moved out)
 *   reads as none, so a stale id never shows.
 * - Write (`channelAnnouncementChange`): the channel's owner (its channel
 *   admin) or a server owner or admin: editChannelMetadata, the capability
 *   PATCH /channels/:id and `raft channel update` check for the name. The
 *   object must be one the actor can see, homed in this channel.
 * - The object deleted or moved out: the app clears it in its own transaction
 *   (`clearChannelAnnouncementsOf`, through platform/channelAnnouncements).
 * - A new version: the app tells the channel's agents
 *   (`channelAnnouncementAudience`, the same entry point).
 */
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY,
  RAFT_HINTS,
  asArtifactId,
  channelTypeSupportsAnnouncement,
  type ChannelAnnouncement,
  type ChannelAnnouncementForPerson,
  type ServerId,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { channelAgents, channels } from "../db/schema";
import { actorKey, actorNames } from "../platform/actors";
import { appEnabledOn, appEnabledOnLiveServers } from "../platform/flags";
import { channelAnnouncementObjectKind } from "../apps/firstPartyApps";
import type { RefusalInput, RefusalStatus } from "../lib/refusal";
import { actorHasChannelCapability } from "../lib/channelActorPermissions";
import { evaluateFeatureFlag, evaluateFeatureFlags } from "./featureFlagService";
import { visibleObjectsOf } from "./objectSummaries";
import { jointHomeProjections, jointHomeRecords, type ServerViewActor } from "./visibilityService";

/** Whether channel announcements are on for this server; an evaluation failure reads as off. */
export async function channelAnnouncementsEnabled(serverId: string, executor?: DatabaseExecutor): Promise<boolean> {
  try {
    return (await evaluateFeatureFlag({ key: CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY, serverId }, executor)).enabled;
  } catch {
    return false;
  }
}

/** Each of these channel ids' joint canonical channel when it is a joint projection, else itself. One query. */
async function canonicalOf(ids: readonly string[], executor: DatabaseExecutor = getDb()): Promise<(id: string) => string> {
  const distinct = [...new Set(ids)];
  const records = distinct.length === 0 ? [] : await jointHomeRecords("any", { localChannelIds: distinct, executor });
  const canonical = new Map(records.map((record) => [record.localChannelId, record.canonicalChannelId]));
  return (id) => canonical.get(id) ?? id;
}

/**
 * The joints among `jointChannelIds` (a projection of one, or its canonical
 * channel) that have no announcement now: a server sharing the joint has
 * announcements off, or the announcement's app off (or is gone). A joint's
 * announcement is one id on every side's copy. A side with it off could
 * neither see nor remove it, yet its members were refused their own pushes
 * to the Artifact, and read its title in the channel's event line (security
 * review v1.21.63, L1 and L2); so it is every sharing server's or nobody's.
 * An evaluation failure reads as off. A joint with no active projection is
 * not in the answer: only its own server's flag applies, as for any channel.
 * Two queries and one batched evaluation per flag; none for no ids.
 */
async function jointsWithoutAnnouncements(jointChannelIds: readonly string[], executor: DatabaseExecutor = getDb()): Promise<Set<string>> {
  const ids = [...new Set(jointChannelIds)];
  if (ids.length === 0) return new Set();
  const canonical = await canonicalOf(ids, executor);
  const projections = await jointHomeProjections("any", { canonicalChannelIds: [...new Set(ids.map(canonical))], executor });
  const sharing = new Map<string, Set<ServerId>>();
  for (const projection of projections) {
    const servers = sharing.get(projection.canonicalChannelId) ?? new Set<ServerId>();
    servers.add(projection.serverId);
    sharing.set(projection.canonicalChannelId, servers);
  }
  const servers = [...new Set(projections.map((projection) => projection.serverId))];
  const appFlag = channelAnnouncementObjectKind()?.app.flag;
  const on = new Set<ServerId>();
  try {
    const [announcements, app] = await Promise.all([
      appEnabledOn(servers, CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY, { executor }),
      appFlag ? appEnabledOnLiveServers(servers, appFlag, { executor }) : Promise.resolve(servers.map(() => false)),
    ]);
    servers.forEach((serverId, index) => {
      if (announcements[index] && app[index]) on.add(serverId);
    });
  } catch {
    // Off for every server.
  }
  return new Set(ids.filter((id) => [...(sharing.get(canonical(id)) ?? [])].some((serverId) => !on.has(serverId))));
}

/**
 * Whether this channel has announcements now: the flag on for its server
 * and, for a joint, for every server sharing it (jointsWithoutAnnouncements).
 * False for a channel that does not exist.
 */
export async function channelAnnouncementsInForce(channelId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  const [channel] = await executor.select({ serverId: channels.serverId, type: channels.type }).from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!channel || !await channelAnnouncementsEnabled(channel.serverId, executor)) return false;
  return channel.type !== "joint" || !(await jointsWithoutAnnouncements([channelId], executor)).has(channelId);
}

/** A channel row as the announcement reads it. */
export interface ChannelAnnouncementRow {
  id: string;
  type: string;
  announcementArtifactId: string | null;
}

/**
 * The announcement of each of these channels as `viewer` sees it, null for
 * none; channels that can't have one (a DM, a thread) are absent. Null (not
 * a map) while the flag is off for the viewer's server: callers then add no
 * `announcement` field at all. A person gets ChannelAnnouncementForPerson
 * (who made the current version and its note, whether they have seen it, and
 * the first line of its text); an agent the plain one. A constant
 * number of queries however many channels.
 */
export async function resolveChannelAnnouncements(
  viewer: ServerViewActor,
  rows: readonly ChannelAnnouncementRow[],
): Promise<Map<string, ChannelAnnouncement | null> | null> {
  if (!await channelAnnouncementsEnabled(viewer.serverId)) return null;
  const result = new Map<string, ChannelAnnouncement | null>();
  const candidates: Array<ChannelAnnouncementRow & { announcementArtifactId: string }> = [];
  for (const row of rows) {
    if (!channelTypeSupportsAnnouncement(row.type)) continue;
    result.set(row.id, null);
    if (row.announcementArtifactId) candidates.push(row as ChannelAnnouncementRow & { announcementArtifactId: string });
  }
  const registered = channelAnnouncementObjectKind();
  if (candidates.length === 0 || !registered) return result;
  // A joint another side of which has announcements off has none here either.
  const withoutOne = await jointsWithoutAnnouncements(candidates.filter((row) => row.type === "joint").map((row) => row.id));
  if (withoutOne.size > 0) candidates.splice(0, candidates.length, ...candidates.filter((row) => !withoutOne.has(row.id)));
  if (candidates.length === 0) return result;
  const ids = [...new Set(candidates.map((row) => row.announcementArtifactId))];
  const [homes, visible] = await Promise.all([registered.objectKind.homes(ids), visibleObjectsOf(viewer, registered, ids)]);
  const canonical = await canonicalOf([
    ...candidates.filter((row) => row.type === "joint").map((row) => row.id),
    ...[...homes.values()].flatMap((home) => (home.homeChannelId ? [home.homeChannelId] : [])),
  ]);
  const homedHere = candidates.filter((row) => {
    const home = homes.get(row.announcementArtifactId);
    return visible.has(row.announcementArtifactId)
      && home?.homeKind === "conversation"
      && home.homeChannelId !== null
      && canonical(home.homeChannelId) === canonical(row.id);
  });
  if (homedHere.length === 0) return result;
  const person = viewer.type === "user" ? { type: "user" as const, id: viewer.id } : undefined;
  const headlines = await registered.objectKind.channelAnnouncement.headlines([...new Set(homedHere.map((row) => row.announcementArtifactId))], person);
  const names = person ? await actorNames([...headlines.values()].map((headline) => headline.updatedBy)) : new Map<string, string>();
  for (const row of homedHere) {
    const headline = headlines.get(row.announcementArtifactId);
    if (!headline) continue;
    const base: ChannelAnnouncement = {
      artifactId: asArtifactId(row.announcementArtifactId),
      title: headline.title,
      version: headline.version,
      updatedAt: headline.updatedAt.toISOString(),
    };
    if (!person) {
      result.set(row.id, base);
      continue;
    }
    const forPerson: ChannelAnnouncementForPerson = {
      ...base,
      updatedBy: { ...headline.updatedBy, name: names.get(actorKey(headline.updatedBy)) ?? null },
      note: headline.note,
      seen: headline.seen === true,
      // What the strip shows once the person has seen this version (a Markdown version's excerpt, its first line).
      excerpt: headline.excerpt,
    };
    result.set(row.id, forPerson);
  }
  return result;
}

/**
 * resolveChannelAnnouncements for channels whose rows the caller holds
 * without the stored id (the agent directory): reads it, in one query, only
 * while the flag is on.
 */
export async function resolveChannelAnnouncementsOf(
  viewer: ServerViewActor,
  rows: ReadonlyArray<{ id: string; type: string }>,
): Promise<Map<string, ChannelAnnouncement | null> | null> {
  if (!await channelAnnouncementsEnabled(viewer.serverId)) return null;
  const supported = rows.filter((row) => channelTypeSupportsAnnouncement(row.type));
  const stored = supported.length === 0 ? [] : await getDb().select({ id: channels.id, announcementArtifactId: channels.announcementArtifactId }).from(channels)
    .where(and(inArray(channels.id, supported.map((row) => row.id)), isNotNull(channels.announcementArtifactId)));
  const storedOf = new Map(stored.map((row) => [row.id, row.announcementArtifactId]));
  return resolveChannelAnnouncements(viewer, supported.map((row) => ({ id: row.id, type: row.type, announcementArtifactId: storedOf.get(row.id) ?? null })));
}

/**
 * The row as a payload: without the stored id, with `announcement` (as
 * `viewer` sees it) only while the flag is on and the channel can have one.
 */
export function withChannelAnnouncement<T extends { id: string; announcementArtifactId?: string | null }>(
  row: T,
  announcements: ReadonlyMap<string, ChannelAnnouncement | null> | null,
): Omit<T, "announcementArtifactId"> & { announcement?: ChannelAnnouncement | null } {
  const { announcementArtifactId: _stored, ...rest } = row;
  return announcements?.has(row.id) ? { ...rest, announcement: announcements.get(row.id) ?? null } : rest;
}

/** One channel's payload with its announcement (withChannelAnnouncement). */
export async function attachChannelAnnouncement<T extends { id: string; type: string; announcementArtifactId?: string | null }>(
  viewer: ServerViewActor,
  row: T,
): Promise<Omit<T, "announcementArtifactId"> & { announcement?: ChannelAnnouncement | null }> {
  const announcements = await resolveChannelAnnouncements(viewer, [{ id: row.id, type: row.type, announcementArtifactId: row.announcementArtifactId ?? null }]);
  return withChannelAnnouncement(row, announcements);
}

export type ChannelAnnouncementChange =
  | { ok: true; artifactId: string | null }
  | { ok: false; status: RefusalStatus; refusal: RefusalInput };

const refused = (status: RefusalStatus, refusal: RefusalInput): ChannelAnnouncementChange => ({ ok: false, status, refusal });

/**
 * Whether `actor` may set (`raw` an object id) or remove (`raw` null) this
 * channel's announcement, and the id to store. In order: the value, the
 * channel's type (no DM or thread), the flag for the actor's server, the
 * permission (`canEditChannelMetadata`, the caller's editChannelMetadata
 * check), then for a set: on a joint, the flag for every server sharing it,
 * and the object, which the actor must see, homed in this channel. Each
 * refusal says why and what to do instead.
 */
export async function channelAnnouncementChange(input: {
  actor: ServerViewActor;
  channel: { id: string; name: string; type: string };
  raw: unknown;
  canEditChannelMetadata: boolean;
}): Promise<ChannelAnnouncementChange> {
  const { actor, channel, raw } = input;
  const target = `#${channel.name}`;
  if (raw !== null && (typeof raw !== "string" || raw.trim() === "")) {
    return refused(400, { code: "channel_announcement_invalid", error: "The announcement must be an Artifact's id, or null to remove it." });
  }
  if (!channelTypeSupportsAnnouncement(channel.type)) {
    return refused(400, {
      code: "channel_announcement_unsupported_channel",
      error: "Only a public, private or joint channel has an announcement; a DM or a thread has none.",
      suggestedNextAction: "Post it as a message in that conversation instead, or set it as the announcement of the channel it belongs to.",
    });
  }
  if (!await channelAnnouncementsEnabled(actor.serverId)) {
    return refused(403, {
      code: "channel_announcement_disabled",
      error: "Channel announcements are not turned on for this server, so nothing was changed.",
      suggestedNextAction: `Post the standing rules or links as a message in ${target} instead.`,
    });
  }
  if (!input.canEditChannelMetadata) {
    return refused(403, {
      code: "channel_announcement_forbidden",
      error: `Only the owner of ${target} (one of its channel admins) or a server owner or admin can set or remove its announcement.`,
      suggestedNextAction: `Ask one of them to set it, or post what you wanted to announce as a message in ${target}.`,
    });
  }
  // Removing stays possible: it only ever takes away what the other side can't see.
  if (raw === null) return { ok: true, artifactId: null };
  if (channel.type === "joint" && (await jointsWithoutAnnouncements([channel.id])).has(channel.id)) {
    return refused(403, {
      code: "channel_announcement_disabled",
      error: `Channel announcements are not turned on for every server that shares ${target}, so nothing was changed.`,
      suggestedNextAction: `Post the standing rules or links as a message in ${target} instead.`,
    });
  }
  const id = (raw as string).trim();
  const registered = channelAnnouncementObjectKind();
  const [homes, visible] = registered
    ? await Promise.all([registered.objectKind.homes([id]), visibleObjectsOf(actor, registered, [id])])
    : [new Map(), new Set<string>()];
  const home = homes.get(id);
  if (!home || !visible.has(id)) {
    return refused(404, {
      code: "channel_announcement_artifact_not_found",
      error: `No Artifact you can see has that id, so ${target}'s announcement was not changed.`,
      next: RAFT_HINTS.artifactList({ target }),
    });
  }
  const canonical = await canonicalOf(home.homeChannelId ? [channel.id, home.homeChannelId] : [channel.id]);
  if (home.homeKind !== "conversation" || home.homeChannelId === null || canonical(home.homeChannelId) !== canonical(channel.id)) {
    return refused(400, {
      code: "channel_announcement_not_in_channel",
      error: `That Artifact is not homed in ${target}: a channel's announcement must be an Artifact that lives in that channel, so its readers are the channel's.`,
      suggestedNextAction: `Pick one homed in ${target} (raft artifact list --target "${target}"), or push a new one there with raft artifact push <dir> --target "${target}" --title "<title>" --announcement.`,
    });
  }
  return { ok: true, artifactId: id };
}

/**
 * The channel ids an object homed in `homeChannelId` may be the announcement
 * of: the home itself and, for a joint, its canonical channel and every
 * active projection. Two queries.
 */
async function channelAnnouncementChannelIdsOf(homeChannelId: string, executor: DatabaseExecutor): Promise<string[]> {
  const canonical = (await canonicalOf([homeChannelId], executor))(homeChannelId);
  const projections = await jointHomeProjections("any", { canonicalChannelIds: [canonical], executor });
  return [...new Set([homeChannelId, canonical, ...projections.map((projection) => projection.localChannelId)])];
}

/**
 * The agents to tell that this object, homed in `homeChannelId`, got a new
 * version, because it is the announcement of a live channel of theirs whose
 * server has the flag on: each agent member once, with that channel as it
 * names it (`#name`). Empty when it is no channel's announcement. Who may
 * see the object is the caller's check.
 */
export async function channelAnnouncementAudience(
  objectId: string,
  homeChannelId: string | null,
  executor: DatabaseExecutor = getDb(),
): Promise<Array<{ agentId: string; channel: string }>> {
  if (homeChannelId === null) return [];
  const ids = await channelAnnouncementChannelIdsOf(homeChannelId, executor);
  const rows = await executor.select({ id: channels.id, serverId: channels.serverId, name: channels.name, type: channels.type }).from(channels).where(and(
    inArray(channels.id, ids),
    eq(channels.announcementArtifactId, objectId),
    isNull(channels.deletedAt),
    isNull(channels.archivedAt),
  ));
  const supported = rows.filter((row) => channelTypeSupportsAnnouncement(row.type));
  if (supported.length === 0) return [];
  const servers = [...new Set(supported.map((row) => row.serverId))];
  const answers = await evaluateFeatureFlags(servers.map((serverId) => ({ key: CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY, serverId })), executor).catch(() => []);
  const on = new Set(servers.filter((_, index) => answers[index]?.enabled === true));
  const withoutOne = await jointsWithoutAnnouncements(supported.filter((row) => row.type === "joint").map((row) => row.id), executor);
  const live = supported.filter((row) => on.has(row.serverId) && !withoutOne.has(row.id));
  if (live.length === 0) return [];
  const nameOf = new Map(live.map((row) => [row.id, `#${row.name}`]));
  const members = await executor.select({ agentId: channelAgents.agentId, channelId: channelAgents.channelId }).from(channelAgents)
    .where(inArray(channelAgents.channelId, live.map((row) => row.id)));
  const audience = new Map<string, string>();
  for (const member of members) if (!audience.has(member.agentId)) audience.set(member.agentId, nameOf.get(member.channelId)!);
  return [...audience].map(([agentId, channel]) => ({ agentId, channel }));
}

/**
 * While an object is a channel's announcement, a new version of it needs the
 * same right as choosing it (Tenny, PR review): editChannelMetadata on that
 * channel, the actor's own server's copy for a joint. Null when the push may
 * go (no live channel has it as its announcement with the flag on there, and
 * for a joint on every side; or
 * the actor may set each such channel's announcement); else the channel (as
 * `#name`) that refuses it. Once it stops being the announcement, the app's
 * own push rule alone applies again.
 */
export async function channelAnnouncementPushRefusal(
  objectId: string,
  homeChannelId: string | null,
  actor: { type: "user" | "agent"; id: string; serverId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<{ channel: string } | null> {
  if (homeChannelId === null) return null;
  const ids = await channelAnnouncementChannelIdsOf(homeChannelId, executor);
  const rows = (await executor.select({ id: channels.id, serverId: channels.serverId, name: channels.name, type: channels.type }).from(channels).where(and(
    inArray(channels.id, ids),
    eq(channels.announcementArtifactId, objectId),
    isNull(channels.deletedAt),
  ))).filter((row) => channelTypeSupportsAnnouncement(row.type));
  if (rows.length === 0) return null;
  const servers = [...new Set(rows.map((row) => row.serverId))];
  const answers = await evaluateFeatureFlags(servers.map((serverId) => ({ key: CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY, serverId })), executor).catch(() => []);
  const on = new Set(servers.filter((_, index) => answers[index]?.enabled === true));
  // A joint with announcements off on one side has none, so it binds nobody's push.
  const withoutOne = await jointsWithoutAnnouncements(rows.filter((row) => row.type === "joint").map((row) => row.id), executor);
  const live = rows.filter((row) => on.has(row.serverId) && !withoutOne.has(row.id));
  if (live.length === 0) return null;
  // Rights are the actor's own server's: on another server's copy of a joint it has none.
  const own = live.filter((row) => row.serverId === actor.serverId);
  if (own.length === 0) return { channel: `#${live[0]!.name}` };
  for (const row of own) {
    if (!await actorHasChannelCapability(row.serverId, row.id, actor.type, actor.id, "editChannelMetadata", executor)) return { channel: `#${row.name}` };
  }
  return null;
}

/**
 * The object, homed in `homeChannelId` until now, left that home (deleted,
 * moved out): no channel has it as its announcement any more. In the
 * caller's transaction; returns the channels cleared.
 */
export async function clearChannelAnnouncementsOf(
  objectId: string,
  homeChannelId: string | null,
  executor: DatabaseExecutor = getDb(),
): Promise<string[]> {
  if (homeChannelId === null) return [];
  const ids = await channelAnnouncementChannelIdsOf(homeChannelId, executor);
  const cleared = await executor.update(channels).set({ announcementArtifactId: null })
    .where(and(inArray(channels.id, ids), eq(channels.announcementArtifactId, objectId)))
    .returning({ id: channels.id });
  return cleared.map((row) => row.id);
}
