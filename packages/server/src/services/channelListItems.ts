// The GET /api/channels item for one human: the channel list
// (channelService.listChannels), its bridge metadata, the latest conversion
// job, the viewer's channel authority, whether the channel is external
// (`hasExternalRelation`: non-guest members; a Guest on its own channel only) and their stored
// notification level. The route and GET /api/sync/changes
// (rebuilding a changed channel's row for that viewer) both build it here, so
// a synced row is the list row.
import { CHANNEL_MANAGEMENT_CAPABILITIES, type ServerRole } from "@botiverse/raft-shared";
import * as channelService from "./channelService";
import { withLoungeAgentIds } from "./agentLoungeService";
import * as channelConversionService from "./channelConversionService";
import { channelActorHasCapability, resolveChannelActorContextsMany, type ChannelActorContext } from "../lib/channelActorPermissions";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace";
import { withNotificationLevels } from "./notifications/settings";
import { withVisitorVisible } from "./channelVisitorVisibility";
import { getActorServerRoleInServer } from "../lib/actorPermissions";

/**
 * attachHumanChannelAuthorization for a whole list: the actor contexts in three
 * queries total (resolveChannelActorContextsMany) instead of three per channel.
 */
export async function attachHumanChannelAuthorizations<T extends { id: string }>(
  channelList: readonly T[],
  serverId: string,
  userId: string,
) {
  const contexts = await resolveChannelActorContextsMany(serverId, channelList.map((channel) => channel.id), "user", userId);
  return channelList.map((channel) => withHumanChannelAuthorization(channel, contexts.get(channel.id) ?? null));
}

export function withHumanChannelAuthorization<T extends { id: string }>(channel: T, context: ChannelActorContext | null) {
  return {
    ...channel,
    channelRole: context?.channelRole ?? null,
    channelAdminBasis: context?.channelAdminBasis ?? null,
    channelCapabilities: Object.fromEntries(
      CHANNEL_MANAGEMENT_CAPABILITIES.map((capability) => [
        capability,
        context ? channelActorHasCapability(context, capability) : false,
      ]),
    ),
    channelAuthorityRevision: context?.channelAuthorityRevision ?? null,
  };
}

export type HumanChannelListOptions = {
  archived?: channelService.ArchivedFilter;
  /** Only these channels (see listChannels). */
  channelIds?: readonly string[];
  traceQuery?: DbQueryTracer;
};

/** The list rows with their bridge metadata (the route traces this part as `channels.loaded`). */
export async function loadHumanChannelList(serverId: string, userId: string, opts: HumanChannelListOptions = {}) {
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const channels = await channelService.listChannels(serverId, userId, {
    archived: opts.archived,
    channelIds: opts.channelIds,
    traceQuery,
  });
  // `loungeAgentId` (Agent Lounge): the web keeps lounges out of the channel
  // list by it. The full list holds none; a lookup by id (sync) can.
  return withLoungeAgentIds(await channelService.attachExternalBridgeMetadata(channels, traceQuery));
}

/**
 * The rest of the item: latest conversion job, the viewer's channel authority,
 * `hasExternalRelation` (channelService.attachExternalRelations; one batched
 * read, omitted for joint participant projections and, for a Guest, on all
 * but its own channel), then
 * `notificationLevel` (the stored setting, docs/contracts/notifications.md
 * §2.2; one batched read).
 */
export async function finishHumanChannelListItems(
  list: Awaited<ReturnType<typeof loadHumanChannelList>>,
  serverId: string,
  userId: string,
) {
  return (await withNotificationLevels(userId, await attachHumanChannelAuthorizations(
    await attachViewerExternalRelations(await channelConversionService.attachLatestChannelConversionJobs(list), serverId, userId),
    serverId,
    userId,
  ))).map(withVisitorVisible);
}

/** channelService.attachExternalRelations for this human in the Server (GET /api/channels). */
export async function attachViewerExternalRelations<T extends { id: string; type: string; jointRole?: "host" | "participant" | null }>(
  rows: readonly T[],
  serverId: string,
  userId: string,
) {
  if (rows.length === 0) return [...rows];
  return channelService.attachExternalRelations(rows, await resolveExternalRelationViewer(serverId, userId));
}

/**
 * The human as attachExternalRelations reads them: their role in the Server
 * (`role`, when the caller has read it already) and, for a Guest, the
 * channel they are bound to.
 */
export async function resolveExternalRelationViewer(
  serverId: string,
  userId: string,
  role?: ServerRole | null,
): Promise<channelService.ExternalRelationViewer> {
  const serverRole = role === undefined ? await getActorServerRoleInServer(serverId, "user", userId) : role;
  return serverRole === "guest"
    ? { role: "guest", guestChannelId: await channelService.getGuestChannelId(serverId, userId) }
    : { role: serverRole };
}

export type HumanChannelListItem = Awaited<ReturnType<typeof finishHumanChannelListItems>>[number];

/** The GET /api/channels items (of `channelIds` only, when given) for this human. */
export async function listHumanChannelItems(serverId: string, userId: string, opts: HumanChannelListOptions = {}): Promise<HumanChannelListItem[]> {
  return finishHumanChannelListItems(await loadHumanChannelList(serverId, userId, opts), serverId, userId);
}
