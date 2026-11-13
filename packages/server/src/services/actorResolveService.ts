import { DEPRECATED_GRAVATAR_HASH } from "@botiverse/raft-shared";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ActorResolveRef, ResolvedActor } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, channelAgents, channelHumans, jointChannels, jointChannelServers, serverMembers, servers, users } from "../db/schema";
import { getComputedJointVisibleHuman, getHumanIdsVisibleThroughLocalChannels } from "./channelService";
import { resolveJointHumanEntrySql, jointMembershipRemovalPendingSql } from "./jointHumanMembershipAccess";
import { shouldExposeHumanInHiddenDirectory, shouldHideHumanDirectoryFromRequester } from "./serverService";
import { agentFindableBy } from "./agentMemberListPolicy";

/**
 * Batched display identity for POST /api/actors/resolve.
 *
 * Four resolution queries at most, each skipped when its id list is empty:
 *   1. external humans  — peers in an active joint channel the requester is in
 *   2. external agents  — same joint path, ending in channel_agents
 *   3. same-server humans — server_members, filtered by the hidden directory
 *   4. same-server agents — including deleted ones (old message authors)
 * The hidden-directory check (and, only when it applies, the requester's
 * local-channel visibility set) adds the lookups the profile route uses.
 *
 * An actor the requester may not see is simply absent, exactly like an id
 * that does not exist. Output is identity-only: a subset of the joint-channel
 * profiles (toChannelScopedHumanProfile / toJointAgentProfile). The
 * deprecated `gravatarHash` is "" for same-server humans and null otherwise.
 */
export async function resolveActors(input: {
  serverId: string;
  requesterId: string;
  actors: readonly ActorResolveRef[];
}): Promise<ResolvedActor[]> {
  const { serverId, requesterId } = input;
  const refs = dedupeRefs(input.actors);
  const humanIds = refs.filter((ref) => ref.kind === "human").map((ref) => ref.id);
  const agentIds = refs.filter((ref) => ref.kind === "agent").map((ref) => ref.id);

  // Two rounds of two, so one request holds at most a few pool connections (Ray).
  const [localHumans, localAgents] = await Promise.all([
    humanIds.length ? loadVisibleLocalHumans(serverId, requesterId, humanIds) : { members: new Set<string>(), visible: [] },
    agentIds.length ? loadLocalAgents(serverId, requesterId, agentIds) : [],
  ]);
  const peerHumanIds = humanIds.filter((id) => !localHumans.members.has(id));
  const [externalHumans, externalAgents] = await Promise.all([
    // This server's members (visible or hidden) are never resolved as peers, so skip them.
    peerHumanIds.length ? loadJointPeerHumans(serverId, requesterId, peerHumanIds) : [],
    agentIds.length ? loadJointPeerAgents(serverId, requesterId, agentIds) : [],
  ]);

  const humans = new Map<string, ResolvedActor>();
  for (const row of localHumans.visible) humans.set(row.id, row);
  // A member of this server is resolved as one (or not at all, when the
  // hidden directory filters them), never as a joint peer of another server.
  for (const row of externalHumans) if (!localHumans.members.has(row.id)) humans.set(row.id, row);
  const agentsById = new Map<string, ResolvedActor>();
  for (const row of localAgents) agentsById.set(row.id, row);
  for (const row of externalAgents) if (!agentsById.has(row.id)) agentsById.set(row.id, row);

  const resolved: ResolvedActor[] = [];
  for (const ref of refs) {
    const actor = ref.kind === "human" ? humans.get(ref.id) : agentsById.get(ref.id);
    if (actor) resolved.push(actor);
  }
  return resolved;
}

function dedupeRefs(actors: readonly ActorResolveRef[]): ActorResolveRef[] {
  const seen = new Set<string>();
  const refs: ActorResolveRef[] = [];
  for (const ref of actors) {
    const key = `${ref.kind}:${ref.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: ref.kind, id: ref.id.toLowerCase() });
  }
  return refs;
}

/**
 * The requester's channel_humans rows → their active local projection of an
 * active joint channel → each active peer projection on another server →
 * that peer's channel members. Deleting a projection channel disconnects its
 * joint_channel_servers row in the same transaction, so `active` excludes it
 * (Ray). Mirrors channelService.getHumanIdsVisibleThroughJointChannels.
 */
function jointPeerPath(serverId: string, requesterId: string) {
  const localProjection = alias(jointChannelServers, "actor_resolve_local_projection");
  const peerProjection = alias(jointChannelServers, "actor_resolve_peer_projection");
  const joins = {
    localProjection: and(
      eq(localProjection.localChannelId, channelHumans.channelId),
      eq(localProjection.serverId, serverId),
      eq(localProjection.status, "active"),
    ),
    jointChannel: and(eq(jointChannels.id, localProjection.jointChannelId), eq(jointChannels.status, "active")),
    peerProjection: and(
      eq(peerProjection.jointChannelId, localProjection.jointChannelId),
      ne(peerProjection.serverId, serverId),
      eq(peerProjection.status, "active"),
    ),
    requester: eq(channelHumans.userId, requesterId),
  };
  return { localProjection, peerProjection, joins };
}

async function loadJointPeerHumans(serverId: string, requesterId: string, humanIds: string[]): Promise<ResolvedActor[]> {
  const computed = await getComputedJointVisibleHuman(serverId, requesterId, humanIds);
  const remaining = humanIds.filter(id => !computed.has(id));
  const computedRows: ResolvedActor[] = [...computed.values()].map(row => ({ kind: "human", id: row.id,
    homeServerId: row.serverId, name: row.name, displayName: row.displayName, avatarUrl: row.avatarUrl, gravatarHash: null }));
  if (remaining.length === 0) return computedRows;
  const permission = await resolveJointHumanEntrySql({ serverId });
  const path = jointPeerPath(serverId, requesterId);
  const peerHumans = alias(channelHumans, "actor_resolve_peer_humans");
  const rows = await getDb()
    .selectDistinctOn([peerHumans.userId], {
      id: peerHumans.userId,
      homeServerId: path.peerProjection.serverId,
      name: users.name,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(channelHumans)
    .innerJoin(path.localProjection, path.joins.localProjection)
    .innerJoin(jointChannels, path.joins.jointChannel)
    .innerJoin(path.peerProjection, path.joins.peerProjection)
    .innerJoin(peerHumans, and(
      eq(peerHumans.channelId, path.peerProjection.localChannelId),
      inArray(peerHumans.userId, remaining),
    ))
    .innerJoin(users, eq(users.id, peerHumans.userId))
    .where(and(path.joins.requester,
      permission(path.localProjection.localChannelId, sql`${requesterId}::uuid`),
      permission(path.peerProjection.localChannelId, peerHumans.userId)))
    .orderBy(peerHumans.userId, path.peerProjection.serverId);
  return [...computedRows, ...rows.map((row) => ({ kind: "human" as const, ...row, gravatarHash: null }))];
}

async function loadJointPeerAgents(serverId: string, requesterId: string, agentIds: string[]): Promise<ResolvedActor[]> {
  const permission = await resolveJointHumanEntrySql({ serverId });
  const path = jointPeerPath(serverId, requesterId);
  const rows = await getDb()
    .selectDistinctOn([agents.id], {
      id: agents.id,
      homeServerId: agents.serverId,
      name: agents.name,
      displayName: agents.displayName,
      avatarUrl: agents.avatarUrl,
    })
    .from(path.localProjection)
    .innerJoin(jointChannels, path.joins.jointChannel)
    .innerJoin(path.peerProjection, path.joins.peerProjection)
    .innerJoin(channelAgents, and(
      eq(channelAgents.channelId, path.peerProjection.localChannelId),
      inArray(channelAgents.agentId, agentIds),
    ))
    .innerJoin(agents, and(
      eq(agents.id, channelAgents.agentId),
      isNull(agents.deletedAt),
      ne(agents.serverId, serverId),
    ))
    .where(and(eq(path.localProjection.serverId,serverId),eq(path.localProjection.status,"active"),
      permission(path.localProjection.localChannelId,sql`${requesterId}::uuid`),
      sql`NOT (${jointMembershipRemovalPendingSql(path.localProjection.jointChannelId, "agent", agents.id)})`))
    .orderBy(agents.id);
  return rows.map((row) => ({ kind: "agent" as const, ...row, gravatarHash: null }));
}

/**
 * Members of this server, as GET /api/servers/:id/members lists them (any
 * server_members row). Under a
 * hidden human directory, the rule of GET /api/servers/:id/members/:id/profile
 * applies: self, the always-exposed humans, and humans sharing a local channel.
 * `members` is every matched member before that filter, so a hidden member is
 * not re-resolved through a joint channel as someone from another server.
 */
async function loadVisibleLocalHumans(serverId: string, requesterId: string, humanIds: string[]): Promise<{
  members: Set<string>;
  visible: ResolvedActor[];
}> {
  const [rows, hideHumanDirectory] = await Promise.all([
    getDb()
      .select({
        id: users.id,
        name: users.name,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        role: serverMembers.role,
        serverSlug: servers.slug,
      })
      .from(serverMembers)
      .innerJoin(users, eq(users.id, serverMembers.userId))
      .innerJoin(servers, eq(servers.id, serverMembers.serverId))
      .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.userId, humanIds))),
    shouldHideHumanDirectoryFromRequester(serverId, requesterId),
  ]);
  const members = new Set(rows.map((row) => row.id));
  let allowed = rows;
  if (hideHumanDirectory) {
    const exposed = rows.filter((row) => shouldExposeHumanInHiddenDirectory(row, requesterId));
    const rest = rows.filter((row) => !shouldExposeHumanInHiddenDirectory(row, requesterId));
    const visibleThroughChannels = rest.length ? await getHumanIdsVisibleThroughLocalChannels(serverId, requesterId, rest.map((row) => row.id)) : new Set<string>();
    allowed = [...exposed, ...rest.filter((row) => visibleThroughChannels.has(row.id))];
  }
  return {
    members,
    visible: allowed.map((row) => ({
      kind: "human" as const,
      id: row.id,
      homeServerId: serverId,
      name: row.name,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      gravatarHash: DEPRECATED_GRAVATAR_HASH,
    })),
  };
}

/**
 * This server's agents, deleted ones included, like GET /api/agents
 * (listAgents(serverId, true)); another person's personal assistant is absent,
 * as GET /api/agents/:id has it (agentFindableBy).
 */
async function loadLocalAgents(serverId: string, requesterId: string, agentIds: string[]): Promise<ResolvedActor[]> {
  const rows = await getDb()
    .select({
      id: agents.id,
      homeServerId: agents.serverId,
      name: agents.name,
      displayName: agents.displayName,
      avatarUrl: agents.avatarUrl,
    })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), inArray(agents.id, agentIds), agentFindableBy({ userId: requesterId })));
  return rows.map((row) => ({ kind: "agent" as const, ...row, gravatarHash: null }));
}
