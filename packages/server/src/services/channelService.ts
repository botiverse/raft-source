import { revokeSocketAccess } from "../socket/accessRevocation.js";
import { createHash, randomInt, randomUUID } from "crypto";
import { performance } from "node:perf_hooks";
import type { QueryResultRow } from "pg";
import { eq, and, isNull, isNotNull, sql, inArray, asc, desc, ne, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, getPool, getSqlTraceHash, withDbTraceAttributes, type DatabaseExecutor } from "../db/index.js";
import {
  getRisingWaveConnectionTimeoutMillis,
  getRisingWaveInboxRfc056ServingMode,
  getRisingWaveInboxItemsServingVersion,
  getRisingWavePool,
  getRisingWavePoolState,
  isRisingWaveFollowedThreadStatsEnabled,
  queryRisingWave,
  RISINGWAVE_UNREAD_INBOX_CONTRACT_VERSION,
  type RisingWaveInboxRfc056ServingMode,
  type RisingWaveInboxItemsServingVersion,
} from "../db/risingwave.js";
import { channels, channelAgents, channelHumans, channelMembershipRoleEvents, dmChannelIdentities, agents, users, serverMembers, serverAgentMembers, messages, userChannelReadCursors, userChannelInboxStates, userChannelDisplayPrefs, inboxTargetMuteStates, inboxSuppressionStates, agentChannelReadCursors, servers, threadFollows, agentActivityEvents, tasks, taskEvents, jointChannels, jointChannelServers, jointChannelInvites, readMutationAuthorities, externalMessageAuthorFacts, externalProjectionAvatarArtifacts, externalActorProjections, externalAddressabilityProjections, externalAppRegistrations, externalChannelBindings } from "../db/schema.js";
import { gt, gte } from "drizzle-orm";
import { assertJointChannelCreationCapacity, getJointChannelCreationEntitlement, isChannelReadOnlyByBillingFeature, withServerLock, withServerResourceLock } from "./planService.js";
import { CHANNEL_MANAGEMENT_CAPABILITIES, MAX_JOINT_CHANNEL_SERVERS, PLAN_CONFIG, canAddChannelMembers, canGuestJoinChannel, canGuestPostToChannel, canGuestReadChannel, channelTypeSupportsActivityMute, currentDate, formatInboxScopeCorruptionLine, getChannelAdminBasis, getEffectiveLimits, hasEffectiveChannelCapability, makeInboxScopeReadFrontier, type AgentActivity, type ChannelRole, type InboxScopeCursorCorruption, type InboxScopeReadFrontier, type ServerId, type ServerPlan, type ServerRole, type TraceAttributes, type TrajectoryEntry } from "@botiverse/raft-shared";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace.js";
import { MESSAGE_SHORT_ID_RE } from "../lib/messageId.js";
import { addTraceEvent } from "../tracing/semanticTrace.js";
import { queryFailureReason, queryFailureTraceAttrs } from "../tracing/queryTrace.js";
import {
  isRisingWaveInboxFailSoftError,
  recordRisingWaveInboxBackendFailed,
  recordRisingWaveInboxFallbackCompleted,
  risingWaveInboxFailureAttrs,
  type RisingWaveBreakerState,
  type RisingWaveInboxTraceRoute,
} from "../tracing/risingWaveInboxTrace.js";
import { sendJointChannelInviteEmail } from "./emailService.js";
import { normalizeEmail } from "./emailNormalization.js";
import {
  mapInboxPolicyRowsToItems,
  selectInboxPolicyActiveUnreadCount,
  selectInboxPolicyPageRows,
  type InboxPolicySqlRow,
} from "./inboxPolicyModel.js";
import { rebuildInboxServingRowsForReceiverTargets } from "./inboxNotificationService.js";
import { legacyDoneFrontierFallbacksTotal } from "../metrics.js";
import {
  executeCompatibilityReadMutation,
  resolveReadMutationUnreadBoundary,
  type ReadMutationAck,
} from "./readMutationSequencer.js";
import { activityPromotionAllowedByMuteSql, isActivityPromotionSuppressedByMute } from "./inboxMutePolicy.js";
import { evaluateFeatureFlag, INBOX_VISIBILITY_V3_FEATURE_FLAG_KEY, SERVER_GUEST_FEATURE_FLAG_KEY } from "./featureFlagService.js";
import {
  clearChannelDoneSuppression,
  clearFollowedThreadSuppressionForAll,
  clearFollowedThreadSuppressionForReceiver,
  clearThreadDoneSuppression,
  assertChannelDoneFrontier,
  assertThreadDoneFrontier,
  DoneFrontierBeyondLatestError,
  DoneFrontierRequiredError,
  INBOX_SUPPRESSION_WRITE_SITES,
  parsePositiveCanonicalDecimal,
  resolveChannelSuppressionTarget,
  resolveThreadSuppressionTarget,
  writeThreadDoneSuppression,
} from "./inboxSuppressionWriters.js";
import { emitAppFacingNotificationEvent } from "./appNotificationDeliveryService.js";
import { isAppId } from "./rapRegistry.js";
import {
  getBuiltInConversationChannel,
  listInstalledApps as listInstalledRapApps,
} from "./rapRegistryStore.js";

interface ChannelServiceOptions {
  executor?: DatabaseExecutor;
}

export type RegularChannelType = "channel" | "private";
export type ListableChannelType = RegularChannelType | "joint";
export type ChannelRefType = ListableChannelType | "dm" | "thread";

export type JointChannelMetadata = {
  jointChannelId?: string | null;
  jointRole?: "host" | "participant" | null;
  jointPeerServerId?: string | null;
  jointPeerServerName?: string | null;
  jointPeerServerSlug?: string | null;
  jointPeerStatus?: "pending" | "active" | null;
  jointServers?: JointServerMetadata[];
  jointPendingInvites?: JointPendingInviteMetadata[];
  jointBillingLocked?: boolean | null;
};

export type ExternalBridgeMetadata = {
  bridge?: {
    provider: "slack";
    providerConversationId: string;
    state: "active" | "paused" | "quarantined";
  };
};

export type ChannelExternalMember = {
  id: string;
  provider: "slack";
  displayName: string;
  handles: string[];
  actorKind: "human" | "guest" | "remote" | "bot" | "unknown";
  avatarUrl: string | null;
};

export type JointServerMetadata = {
  serverId: string;
  serverName: string;
  serverSlug: string;
  role: "host" | "participant" | null;
  status: "active" | "pending";
  isCurrentServer?: boolean;
};

export type JointPendingInviteMetadata = {
  id: string;
  fromServerId: string;
  toServerId: string;
  serverName: string;
  serverSlug: string;
  invitedUserId: string;
  status: "pending";
};

export type JointChannelProjection = {
  jointChannelId: string;
  localChannelId: string;
  canonicalChannelId: string;
  serverId: string;
  role: "host" | "participant";
  channel: typeof channels.$inferSelect;
};

export type JointThreadProjection = {
  jointThreadId: string;
  localThreadChannelId: string;
  canonicalThreadChannelId: string;
  localServerId: string;
  localParentChannelId: string;
  canonicalParentChannelId: string;
  canonicalParentMessageId: string;
  role: "host" | "participant";
  threadChannel: typeof channels.$inferSelect;
};

const REGULAR_CHANNEL_TYPES: RegularChannelType[] = ["channel", "private"];
const LISTABLE_CHANNEL_TYPES: ListableChannelType[] = ["channel", "private", "joint"];
const DM_LOCK_NAMESPACE = 5;
export const JOINT_STORAGE_SERVER_SLUG = "__joint_storage__";
const SYSTEM_ALL_CHANNEL_KEY = "all";

type ChannelSystemFields = Pick<typeof channels.$inferSelect, "name" | "type">;

export function isAllSystemChannel(channel: ChannelSystemFields): boolean {
  return channel.name === SYSTEM_ALL_CHANNEL_KEY
    && (channel.type === "channel" || channel.type === "private");
}

/**
 * One wording for every surface that refuses an #all visibility change.
 *
 * @cindyz asked for AX guidance rather than a bare refusal (2026-09-07,
 * #wg-rbac msg=66de07f5): an agent that is told only "forbidden" will retry,
 * or report the product as broken, which is exactly how the original incident
 * was escalated. So the refusal names who can do it and where, and it says
 * "hide", not "make private" -- the human UI has always called this Hide #all,
 * and "private" is the word that led the reporter to expect ordinary
 * private-channel semantics.
 */
export const ALL_CHANNEL_VISIBILITY_REFUSAL =
  "The #all channel cannot be hidden or restored by changing channel visibility. "
  + "Only a human can do it, from channel settings or server settings.";

export function isEnabledAllChannel(channel: ChannelSystemFields): boolean {
  return isAllSystemChannel(channel) && channel.type === "channel";
}

function requiresExplicitMembership(type: string): boolean {
  return type === "private" || type === "joint";
}

async function resolveHumanServerRole(serverId: string, userId: string, executor: DatabaseExecutor = getDb()): Promise<ServerRole | null> {
  const [membership] = await executor
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);
  return membership?.role ?? null;
}

async function isGuestFeatureEnabled(
  serverId: string,
  userId: string,
  executor?: DatabaseExecutor,
): Promise<boolean> {
  return (await evaluateFeatureFlag({
    key: SERVER_GUEST_FEATURE_FLAG_KEY,
    serverId,
    userId,
  }, executor)).enabled;
}

export async function createChannel(
  serverId: string,
  name: string,
  description?: string,
  type: ListableChannelType = "channel",
  creator?: {
    type: "user" | "agent";
    id: string;
    initialUserIds?: readonly string[];
    initialAgentIds?: readonly string[];
  },
) {
  // Atomic quota check + insert under advisory lock (namespace 3 = channels)
  return withServerLock(serverId, 3, async (tx) => {
    const channel = await createChannelWithExecutor(tx, serverId, name, description, type);
    if (creator && type !== "joint") {
      if (creator.type === "user") {
        await tx.insert(channelHumans).values({
          channelId: channel.id,
          userId: creator.id,
          role: "admin",
        });
      } else {
        await tx.insert(channelAgents).values({
          channelId: channel.id,
          agentId: creator.id,
          role: "admin",
        });
      }
      const initialUserIds = [...new Set(creator.initialUserIds ?? [])]
        .filter((userId) => creator.type !== "user" || userId !== creator.id);
      const initialAgentIds = [...new Set(creator.initialAgentIds ?? [])]
        .filter((agentId) => creator.type !== "agent" || agentId !== creator.id);
      if (initialUserIds.length > 0) {
        const validUsers = await tx.select({ id: serverMembers.userId })
          .from(serverMembers)
          .where(and(
            eq(serverMembers.serverId, serverId),
            inArray(serverMembers.userId, initialUserIds),
          ))
          .for("update");
        if (validUsers.length !== initialUserIds.length) {
          throw new Error("One or more initial users are not members of this server");
        }
        await tx.insert(channelHumans).values(initialUserIds.map((userId) => ({
          channelId: channel.id,
          userId,
          role: "member" as const,
        })));
      }
      if (initialAgentIds.length > 0) {
        const validAgents = await tx.select({ id: agents.id })
          .from(agents)
          .where(and(
            eq(agents.serverId, serverId),
            isNull(agents.deletedAt),
            inArray(agents.id, initialAgentIds),
          ))
          .for("update");
        if (validAgents.length !== initialAgentIds.length) {
          throw new Error("One or more initial agents are not active in this server");
        }
        await tx.insert(channelAgents).values(initialAgentIds.map((agentId) => ({
          channelId: channel.id,
          agentId,
          role: "member" as const,
        })));
      }
    }
    return channel;
  });
}

async function createChannelWithExecutor(
  executor: DatabaseExecutor,
  serverId: string,
  name: string,
  description: string | undefined,
  type: ListableChannelType,
) {
  if (name === SYSTEM_ALL_CHANNEL_KEY) {
    throw new Error('Channel name "all" is reserved');
  }

  // Check plan quota. Joint projections are intentionally not counted against
  // ordinary public/private channel quota; they are invite-mediated shared
  // surfaces, not local channels a workspace can freely create.
  const [serverRow] = await executor.select({ plan: servers.plan }).from(servers).where(eq(servers.id, serverId));
  const plan = (serverRow?.plan as ServerPlan) || "free";
  const limits = getEffectiveLimits(plan);
  if (type !== "joint" && limits.maxChannels !== -1) {
    const [countRow] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(channels)
      .where(and(eq(channels.serverId, serverId), inArray(channels.type, REGULAR_CHANNEL_TYPES), isNull(channels.deletedAt)));
    const count = countRow?.count ?? 0;
    if (count >= limits.maxChannels) {
      throw new Error(`Channel limit reached (${count}/${limits.maxChannels} on ${PLAN_CONFIG[plan].displayName} plan). Upgrade for more.`);
    }
  }

  const [existing] = await executor
    .select({ id: channels.id, archivedAt: channels.archivedAt, type: channels.type })
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      inArray(channels.type, LISTABLE_CHANNEL_TYPES),
      eq(channels.name, name),
      isNull(channels.deletedAt)
    ));
  if (existing) {
    if (existing.archivedAt) {
      throw new ArchivedNameCollisionError(name, existing.id, existing.type);
    }
    throw new Error(`Channel name "${name}" is already taken`);
  }

  const [channel] = await executor.insert(channels).values({
    serverId,
    name,
    description,
    type,
  }).returning();
  if (channel.type === "channel") {
    await emitAppFacingNotificationEvent({
      id: channel.id,
      serverId,
      eventType: "server.public_channel_created",
      subjectType: "channel",
      subjectId: channel.id,
      provenance: { source: "channel_service", changed_fields: ["public_channels"] },
    }, executor);
  }
  return channel;
}

async function ensureJointStorageNamespace(executor: DatabaseExecutor, ownerId: string): Promise<string> {
  const [existing] = await executor
    .select({ id: servers.id, kind: servers.kind })
    .from(servers)
    .where(and(eq(servers.slug, JOINT_STORAGE_SERVER_SLUG), isNull(servers.deletedAt)));
  if (existing) {
    if (existing.kind !== "joint_storage") {
      throw new Error("Reserved joint storage namespace slug is already used");
    }
    return existing.id;
  }

  const [inserted] = await executor
    .insert(servers)
    .values({
      name: "Joint Storage Namespace",
      slug: JOINT_STORAGE_SERVER_SLUG,
      kind: "joint_storage",
      ownerId,
      plan: "founder",
      agentAllChannelGreetingEnabled: false,
    })
    .onConflictDoNothing({ target: servers.slug })
    .returning({ id: servers.id });
  if (inserted) return inserted.id;

  const [createdByPeer] = await executor
    .select({ id: servers.id, kind: servers.kind })
    .from(servers)
    .where(and(eq(servers.slug, JOINT_STORAGE_SERVER_SLUG), isNull(servers.deletedAt)));
  if (!createdByPeer || createdByPeer.kind !== "joint_storage") {
    throw new Error("Failed to initialize joint storage namespace");
  }
  return createdByPeer.id;
}

async function createJointStorageChannelWithExecutor(
  executor: DatabaseExecutor,
  storageNamespaceId: string,
): Promise<typeof channels.$inferSelect> {
  const [channel] = await executor.insert(channels).values({
    serverId: storageNamespaceId,
    name: `joint-storage-${randomUUID()}`,
    type: "channel",
  }).returning();
  return channel;
}

const JOINT_CHANNEL_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_JOINT_CHANNEL_INVITE_TARGETS = MAX_JOINT_CHANNEL_SERVERS - 1;
export const MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET = 20;

export function isJointChannelInviteId(value: string): boolean {
  return UUID_RE.test(value);
}

function assertJointChannelInviteId(value: string): void {
  if (!isJointChannelInviteId(value)) {
    throw new Error("Joint channel invite not found");
  }
}

export interface CreateJointChannelInput {
  hostServerId: string;
  createdByUserId: string;
  name: string;
  description?: string;
  userIds?: string[];
  agentIds?: string[];
  targetServerSlug?: string;
  invitedPeople?: string[];
  jointInvites?: JointInviteRequest[];
  /**
   * Clock used for billing entitlements. Defaults to the real clock; routes
   * inject the app clock so subscription and trial boundaries stay deterministic.
   */
  now?: Date;
}

export interface JointInviteRequest {
  targetServerSlug: string;
  invitedPeople: string[];
}

type JointInvitee = {
  userId: string;
  email: string;
  name: string;
  displayName: string | null;
  role: "owner" | "admin";
};

function assertJointChannelServerLimit(serverIds: Iterable<string>) {
  if (new Set(serverIds).size > MAX_JOINT_CHANNEL_SERVERS) {
    throw new Error(`Joint channels support a maximum of ${MAX_JOINT_CHANNEL_SERVERS} servers`);
  }
}

async function getJointChannelServerIdsIncludingPending(executor: DatabaseExecutor, jointChannelId: string): Promise<string[]> {
  const activeRows = await executor
    .select({ serverId: jointChannelServers.serverId })
    .from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.jointChannelId, jointChannelId),
      eq(jointChannelServers.status, "active"),
    ));
  const pendingRows = await executor
    .select({ serverId: jointChannelInvites.toServerId })
    .from(jointChannelInvites)
    .where(and(
      eq(jointChannelInvites.jointChannelId, jointChannelId),
      eq(jointChannelInvites.status, "pending"),
    ));
  return [
    ...activeRows.map((row) => row.serverId),
    ...pendingRows.map((row) => row.serverId),
  ];
}

export async function createJointChannel(input: CreateJointChannelInput) {
  const inviteRequests = normalizeJointInviteRequests(input);
  const db = getDb();
  const entitlement = await getJointChannelCreationEntitlement(
    db,
    input.hostServerId,
    input.now ?? new Date(),
  );

  const result = await withServerLock(input.hostServerId, 3, async (tx) => {
    await assertJointChannelCreationCapacity(tx, input.hostServerId, entitlement);
    const resolvedInviteRequests = [];
    for (const inviteRequest of inviteRequests) {
      const targetServer = await getJointInviteTargetServer(tx, inviteRequest.targetServerSlug, input.hostServerId);
      const invitees = await resolveJointInvitees(tx, targetServer.id, inviteRequest.invitedPeople);
      resolvedInviteRequests.push({ targetServer, invitees });
    }
    assertJointChannelServerLimit([
      input.hostServerId,
      ...resolvedInviteRequests.map((request) => request.targetServer.id),
    ]);

    const storageNamespaceId = await ensureJointStorageNamespace(tx, input.createdByUserId);
    const storageChannel = await createJointStorageChannelWithExecutor(tx, storageNamespaceId);
    const channel = await createChannelWithExecutor(tx, input.hostServerId, input.name, input.description, "joint");
    await tx.insert(channelHumans)
      .values([
        { channelId: channel.id, userId: input.createdByUserId },
        ...(input.userIds ?? []).map((userId) => ({ channelId: channel.id, userId })),
      ])
      .onConflictDoNothing();
    if (input.agentIds?.length) {
      await tx.insert(channelAgents)
        .values(input.agentIds.map((agentId) => ({ channelId: channel.id, agentId })))
        .onConflictDoNothing();
    }

    const [joint] = await tx.insert(jointChannels).values({
      canonicalChannelId: storageChannel.id,
      createdByServerId: input.hostServerId,
      createdByUserId: input.createdByUserId,
    }).returning();
    await tx.insert(jointChannelServers).values({
      jointChannelId: joint.id,
      serverId: input.hostServerId,
      localChannelId: channel.id,
      role: "host",
      joinedByUserId: input.createdByUserId,
    });

    const invites = [];
    for (const inviteRequest of resolvedInviteRequests) {
      for (const invitee of inviteRequest.invitees) {
        const invite = await createJointChannelInvite({
          jointChannelId: joint.id,
          fromServerId: input.hostServerId,
          targetServerId: inviteRequest.targetServer.id,
          invitedUserId: invitee.userId,
          invitedByUserId: input.createdByUserId,
          executor: tx,
        });
        invites.push(invite);
      }
    }

    return { channel, jointChannel: joint, invites };
  });

  await sendJointChannelInviteEmails(result.invites.map((invite) => invite.id));
  return result;
}

function normalizeJointInviteRequests(input: Pick<CreateJointChannelInput, "targetServerSlug" | "invitedPeople" | "jointInvites">): JointInviteRequest[] {
  const rawRequests = Array.isArray(input.jointInvites) && input.jointInvites.length > 0
    ? input.jointInvites
    : [{
        targetServerSlug: input.targetServerSlug ?? "",
        invitedPeople: input.invitedPeople ?? [],
      }];
  if (rawRequests.length > MAX_JOINT_CHANNEL_INVITE_TARGETS) {
    throw new Error(`Joint channels support a maximum of ${MAX_JOINT_CHANNEL_SERVERS} servers`);
  }
  const byTargetSlug = new Map<string, JointInviteRequest>();

  for (const rawRequest of rawRequests) {
    const targetServerSlug = rawRequest.targetServerSlug.trim();
    if (!targetServerSlug) {
      throw new Error("Invite server slug is required");
    }
    const invitedPeople = normalizeJointInvitePeople(rawRequest.invitedPeople);
    if (invitedPeople.length === 0) {
      throw new Error("At least one invited person is required");
    }
    const key = targetServerSlug.toLowerCase();
    const existing = byTargetSlug.get(key);
    if (existing) {
      existing.invitedPeople = normalizeJointInvitePeople([...existing.invitedPeople, ...invitedPeople]);
    } else {
      byTargetSlug.set(key, { targetServerSlug, invitedPeople });
    }
  }

  if (byTargetSlug.size === 0) {
    throw new Error("Invite server slug is required");
  }
  return [...byTargetSlug.values()];
}

export async function inviteServerToJointChannel(input: {
  localChannelId: string;
  fromServerId: string;
  invitedByUserId: string;
  targetServerSlug: string;
  invitedPeople: string[];
}) {
  const targetSlug = input.targetServerSlug.trim();
  if (!targetSlug) {
    throw new Error("Invite server slug is required");
  }
  const invitedPeople = normalizeJointInvitePeople(input.invitedPeople);
  if (invitedPeople.length === 0) {
    throw new Error("At least one invited person is required");
  }

  const result = await withServerResourceLock(input.fromServerId, 3, input.localChannelId, async (tx) => {
    const [projection] = await tx
      .select({ jointChannelId: jointChannelServers.jointChannelId })
      .from(jointChannelServers)
      .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
      .where(and(
        eq(jointChannelServers.localChannelId, input.localChannelId),
        eq(jointChannelServers.serverId, input.fromServerId),
        eq(jointChannelServers.status, "active"),
        eq(jointChannels.status, "active"),
      ));
    if (!projection) {
      throw new Error("Joint channel not found");
    }

    const targetServer = await getJointInviteTargetServer(tx, targetSlug, input.fromServerId);
    const existingServerIds = await getJointChannelServerIdsIncludingPending(tx, projection.jointChannelId);
    assertJointChannelServerLimit([...existingServerIds, targetServer.id]);
    const invitees = await resolveJointInvitees(tx, targetServer.id, invitedPeople);
    const invites = [];
    for (const invitee of invitees) {
      const invite = await createJointChannelInvite({
        jointChannelId: projection.jointChannelId,
        fromServerId: input.fromServerId,
        targetServerId: targetServer.id,
        invitedUserId: invitee.userId,
        invitedByUserId: input.invitedByUserId,
        executor: tx,
      });
      invites.push(invite);
    }
    return { invites };
  });

  await sendJointChannelInviteEmails(result.invites.map((invite) => invite.id));
  return result;
}

function normalizeJointInvitePeople(invitedPeople: string[] | undefined): string[] {
  if ((invitedPeople?.length ?? 0) > MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET) {
    throw new Error(`A joint channel invite can include a maximum of ${MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET} invited people per target server`);
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of invitedPeople ?? []) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.startsWith("@") && !value.includes("@", 1)
      ? value.slice(1).toLowerCase()
      : value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

async function getJointInviteTargetServer(executor: DatabaseExecutor, targetServerSlug: string, fromServerId: string) {
  const [targetServer] = await executor
    .select({ id: servers.id, slug: servers.slug, kind: servers.kind, deletedAt: servers.deletedAt })
    .from(servers)
    .where(eq(servers.slug, targetServerSlug));
  if (!targetServer || targetServer.deletedAt || targetServer.kind === "joint_storage") {
    throw new Error("Target server not found");
  }
  if (targetServer.id === fromServerId) {
    throw new Error("Cannot invite the current server");
  }
  return targetServer;
}

async function resolveJointInvitees(executor: DatabaseExecutor, targetServerId: string, invitedPeople: string[]): Promise<JointInvitee[]> {
  const invitees: JointInvitee[] = [];
  const seenUserIds = new Set<string>();
  for (const invitedPerson of invitedPeople) {
    const token = invitedPerson.trim();
    const isEmail = token.includes("@") && !token.startsWith("@");
    const lookup = isEmail ? normalizeEmail(token) : token.replace(/^@/, "");
    if (!lookup) continue;
    const [invitee] = await executor
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        displayName: users.displayName,
        role: serverMembers.role,
      })
      .from(serverMembers)
      .innerJoin(users, eq(users.id, serverMembers.userId))
      .where(and(
        eq(serverMembers.serverId, targetServerId),
        isEmail ? eq(users.email, lookup) : eq(users.name, lookup),
      ));
    if (!invitee) {
      throw new Error(`Invited person not found in target server: ${invitedPerson}`);
    }
    if (invitee.role !== "owner" && invitee.role !== "admin") {
      throw new Error(`invited person must be a target server admin: ${invitedPerson}`);
    }
    if (seenUserIds.has(invitee.userId)) continue;
    seenUserIds.add(invitee.userId);
    invitees.push({ ...invitee, role: invitee.role });
  }
  if (invitees.length === 0) {
    throw new Error("At least one invited person is required");
  }
  return invitees;
}

export async function sendJointChannelInviteEmails(inviteIds: string[]) {
  if (inviteIds.length === 0) return;
  const db = getDb();
  const fromServer = alias(servers, "joint_email_from_server");
  const toServer = alias(servers, "joint_email_to_server");
  const fromProjection = alias(jointChannelServers, "joint_email_from_projection");
  const displayChannel = alias(channels, "joint_email_display_channel");
  const inviter = alias(users, "joint_email_inviter");
  const invitees = await db
    .select({
      inviteId: jointChannelInvites.id,
      fromServerName: fromServer.name,
      toServerName: toServer.name,
      toServerSlug: toServer.slug,
      channelName: displayChannel.name,
      inviterName: inviter.displayName,
      inviterHandle: inviter.name,
      recipientEmail: users.email,
      recipientName: users.displayName,
      recipientHandle: users.name,
    })
    .from(jointChannelInvites)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelInvites.jointChannelId))
    .innerJoin(fromServer, eq(fromServer.id, jointChannelInvites.fromServerId))
    .innerJoin(toServer, eq(toServer.id, jointChannelInvites.toServerId))
    .innerJoin(fromProjection, and(
      eq(fromProjection.jointChannelId, jointChannelInvites.jointChannelId),
      eq(fromProjection.serverId, jointChannelInvites.fromServerId),
      eq(fromProjection.status, "active"),
    ))
    .innerJoin(displayChannel, eq(displayChannel.id, fromProjection.localChannelId))
    .innerJoin(inviter, eq(inviter.id, jointChannelInvites.invitedByUserId))
    .innerJoin(users, eq(users.id, jointChannelInvites.invitedUserId))
    .where(inArray(jointChannelInvites.id, inviteIds));

  await Promise.all(invitees.map((invitee) => sendJointChannelInviteEmail(invitee.recipientEmail, {
    recipientName: invitee.recipientName || invitee.recipientHandle,
    inviterName: invitee.inviterName || invitee.inviterHandle,
    fromServerName: invitee.fromServerName,
    toServerName: invitee.toServerName,
    toServerSlug: invitee.toServerSlug,
    channelName: invitee.channelName,
    inviteId: invitee.inviteId,
  })));
}

export async function createJointChannelInvite(input: {
  jointChannelId: string;
  fromServerId: string;
  targetServerId: string;
  invitedUserId: string;
  invitedByUserId: string;
  executor?: DatabaseExecutor;
}) {
  const db = input.executor ?? getDb();
  const [existing] = await db
    .select()
    .from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.jointChannelId, input.jointChannelId),
      eq(jointChannelServers.serverId, input.targetServerId),
      eq(jointChannelServers.status, "active"),
    ));
  if (existing) {
    throw new Error("Target server is already in this joint channel");
  }

  const [invite] = await db.insert(jointChannelInvites).values({
    jointChannelId: input.jointChannelId,
    fromServerId: input.fromServerId,
    toServerId: input.targetServerId,
    invitedUserId: input.invitedUserId,
    invitedByUserId: input.invitedByUserId,
    expiresAt: new Date(Date.now() + JOINT_CHANNEL_INVITE_TTL_MS),
  }).onConflictDoUpdate({
    target: [jointChannelInvites.jointChannelId, jointChannelInvites.toServerId, jointChannelInvites.invitedUserId],
    targetWhere: sql`status = 'pending'`,
    set: {
      invitedByUserId: input.invitedByUserId,
      expiresAt: new Date(Date.now() + JOINT_CHANNEL_INVITE_TTL_MS),
      createdAt: new Date(),
    },
  }).returning();
  return invite;
}

export async function resendPendingJointChannelInvites(input: {
  localChannelId: string;
  fromServerId: string;
  requestedByUserId: string;
}) {
  const db = getDb();
  const [projection] = await db
    .select({ jointChannelId: jointChannelServers.jointChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      eq(jointChannelServers.localChannelId, input.localChannelId),
      eq(jointChannelServers.serverId, input.fromServerId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ));
  if (!projection) {
    throw new Error("Joint channel not found");
  }

  const pendingRows = await db
    .select({ id: jointChannelInvites.id })
    .from(jointChannelInvites)
    .where(and(
      eq(jointChannelInvites.jointChannelId, projection.jointChannelId),
      eq(jointChannelInvites.fromServerId, input.fromServerId),
      eq(jointChannelInvites.status, "pending"),
    ));
  const inviteIds = pendingRows.map((row) => row.id);
  if (inviteIds.length === 0) {
    throw new Error("No pending joint channel invite found");
  }

  await db.update(jointChannelInvites)
    .set({
      invitedByUserId: input.requestedByUserId,
      expiresAt: new Date(Date.now() + JOINT_CHANNEL_INVITE_TTL_MS),
      createdAt: new Date(),
    })
    .where(inArray(jointChannelInvites.id, inviteIds));

  await sendJointChannelInviteEmails(inviteIds);
  return { ok: true, resentCount: inviteIds.length };
}

export async function listPendingJointChannelInvites(serverId: string, userId: string) {
  const db = getDb();
  const fromServer = alias(servers, "joint_invite_from_server");
  const fromProjection = alias(jointChannelServers, "joint_invite_from_projection");
  const displayChannel = alias(channels, "joint_invite_display_channel");
  const rows = await db
    .select({
      id: jointChannelInvites.id,
      jointChannelId: jointChannelInvites.jointChannelId,
      fromServerId: jointChannelInvites.fromServerId,
      fromServerName: fromServer.name,
      fromServerSlug: fromServer.slug,
      channelName: displayChannel.name,
      channelDescription: displayChannel.description,
      invitedByUserId: jointChannelInvites.invitedByUserId,
      invitedUserId: jointChannelInvites.invitedUserId,
      expiresAt: jointChannelInvites.expiresAt,
      createdAt: jointChannelInvites.createdAt,
    })
    .from(jointChannelInvites)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelInvites.jointChannelId))
    .innerJoin(fromServer, eq(fromServer.id, jointChannelInvites.fromServerId))
    .innerJoin(fromProjection, and(
      eq(fromProjection.jointChannelId, jointChannelInvites.jointChannelId),
      eq(fromProjection.serverId, jointChannelInvites.fromServerId),
      eq(fromProjection.status, "active"),
    ))
    .innerJoin(displayChannel, eq(displayChannel.id, fromProjection.localChannelId))
    .where(and(
      eq(jointChannelInvites.toServerId, serverId),
      eq(jointChannelInvites.invitedUserId, userId),
      eq(jointChannelInvites.status, "pending"),
      eq(jointChannels.status, "active"),
      isNull(displayChannel.deletedAt),
    ))
    .orderBy(desc(jointChannelInvites.createdAt));
  const now = Date.now();
  return rows.filter((row) => row.expiresAt.getTime() > now);
}

export async function acceptJointChannelInvite(input: {
  inviteId: string;
  targetServerId: string;
  acceptedByUserId: string;
}) {
  assertJointChannelInviteId(input.inviteId);
  return withServerLock(input.targetServerId, 3, async (tx) => {
    const fromProjection = alias(jointChannelServers, "joint_accept_from_projection");
    const displayChannel = alias(channels, "joint_accept_display_channel");
    const [invite] = await tx
      .select({
        id: jointChannelInvites.id,
        jointChannelId: jointChannelInvites.jointChannelId,
        fromServerId: jointChannelInvites.fromServerId,
        toServerId: jointChannelInvites.toServerId,
        invitedUserId: jointChannelInvites.invitedUserId,
        status: jointChannelInvites.status,
        expiresAt: jointChannelInvites.expiresAt,
        canonicalChannelId: jointChannels.canonicalChannelId,
        channelName: displayChannel.name,
        channelDescription: displayChannel.description,
      })
      .from(jointChannelInvites)
      .innerJoin(jointChannels, eq(jointChannels.id, jointChannelInvites.jointChannelId))
      .innerJoin(fromProjection, and(
        eq(fromProjection.jointChannelId, jointChannelInvites.jointChannelId),
        eq(fromProjection.serverId, jointChannelInvites.fromServerId),
        eq(fromProjection.status, "active"),
      ))
      .innerJoin(displayChannel, eq(displayChannel.id, fromProjection.localChannelId))
      .where(and(
        eq(jointChannelInvites.id, input.inviteId),
        eq(jointChannelInvites.toServerId, input.targetServerId),
        eq(jointChannelInvites.invitedUserId, input.acceptedByUserId),
        eq(jointChannelInvites.status, "pending"),
        eq(jointChannels.status, "active"),
        isNull(displayChannel.deletedAt),
      ));
    if (!invite) {
      throw new Error("Joint channel invite not found");
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      await tx.update(jointChannelInvites)
        .set({ status: "expired" })
        .where(eq(jointChannelInvites.id, input.inviteId));
      throw new Error("Joint channel invite expired");
    }
    const [acceptingMember] = await tx
      .select({ role: serverMembers.role })
      .from(serverMembers)
      .where(and(
        eq(serverMembers.serverId, input.targetServerId),
        eq(serverMembers.userId, input.acceptedByUserId),
      ));
    if (!acceptingMember || (acceptingMember.role !== "owner" && acceptingMember.role !== "admin")) {
      throw new Error("Only target server admins can accept joint channel invites");
    }

    const [existingProjection] = await tx
      .select({ localChannelId: jointChannelServers.localChannelId })
      .from(jointChannelServers)
      .where(and(
        eq(jointChannelServers.jointChannelId, invite.jointChannelId),
        eq(jointChannelServers.serverId, input.targetServerId),
        eq(jointChannelServers.status, "active"),
      ));
    if (existingProjection) {
      await tx.insert(channelHumans)
        .values({ channelId: existingProjection.localChannelId, userId: input.acceptedByUserId })
        .onConflictDoNothing();
      await tx.update(jointChannelInvites)
        .set({
          status: "accepted",
          acceptedByUserId: input.acceptedByUserId,
          acceptedAt: new Date(),
        })
        .where(eq(jointChannelInvites.id, input.inviteId));
      const [existingChannel] = await tx
        .select()
        .from(channels)
        .where(and(
          eq(channels.id, existingProjection.localChannelId),
          isNull(channels.deletedAt),
        ));
      if (!existingChannel) throw new Error("Joint channel projection not found");
      return existingChannel;
    }

    const projection = await createChannelWithExecutor(
      tx,
      input.targetServerId,
      invite.channelName,
      invite.channelDescription ?? undefined,
      "joint",
    );
    await tx.insert(channelHumans)
      .values({ channelId: projection.id, userId: input.acceptedByUserId })
      .onConflictDoNothing();
    await tx.insert(jointChannelServers).values({
      jointChannelId: invite.jointChannelId,
      serverId: input.targetServerId,
      localChannelId: projection.id,
      role: "participant",
      joinedByUserId: input.acceptedByUserId,
    });
    await backfillJointThreadProjectionsForLocalParent(tx, {
      jointChannelId: invite.jointChannelId,
      canonicalParentChannelId: invite.canonicalChannelId,
      localParentProjection: {
        serverId: input.targetServerId,
        localChannelId: projection.id,
        role: "participant",
      },
      joinedByUserId: input.acceptedByUserId,
    });
    await tx.update(jointChannelInvites)
      .set({
        status: "accepted",
        acceptedByUserId: input.acceptedByUserId,
        acceptedAt: new Date(),
      })
      .where(eq(jointChannelInvites.id, input.inviteId));
    return projection;
  });
}

export type ArchivedFilter = "exclude" | "include" | "only";

interface ChannelListOptions {
  archived?: ArchivedFilter;
  traceQuery?: DbQueryTracer;
  humanActivityMuteEnabled?: boolean;
}

export type ReadStateSnapshot = {
  maxReadSeq: number;
  readStateVersion: number;
  /** Authoritative per-scope read state (#632 SSOT) — see packages/shared. */
  readState: InboxScopeReadFrontier;
};

export async function getReadStateSnapshot(userId: string, channelId: string): Promise<ReadStateSnapshot> {
  const [row] = await fetchReadStateAuthorityRows(
    [channelId],
    userId,
    untracedDbQuery,
    "channels.read_state_by_channel",
  );
  if (!row) {
    return { maxReadSeq: 0, readStateVersion: 0, readState: makeInboxScopeReadFrontier(null) };
  }
  return {
    maxReadSeq: row.readCursorPresent ? Number(row.maxReadSeq) : 0,
    readStateVersion: row.readCursorPresent ? (row.readStateVersion as number) : 0,
    readState: readFrontierFromAuthorityRow(row),
  };
}

/**
 * The SINGLE authority-table read shared by the list/DM/followed-thread exit
 * (attachReadState) and the unread-summary exit (#632 SSOT): presence is a
 * STRUCTURAL JOIN fact, version/seq stay NULL when the cursor row is absent
 * (never coalesced before the shared constructor decides), and the content
 * frontier is a same-source pair from ONE lateral row over the storage
 * channel (joint channels resolve to canonical storage). The dedicated Done
 * frontier uses that same storage scope, with the parent-message fallback
 * required by zero-reply threads.
 *
 * Executor discipline: pass the CALLER's executor when inside a transaction —
 * the authority read must see the transaction's snapshot, and on
 * single-connection drivers (pglite) a global-getDb() read issued while the
 * caller's transaction holds the connection deadlocks the flow. Today the
 * ONLY transaction-scoped caller is activitySyncService (via getInboxItems);
 * any NEW tx-scoped caller MUST thread its executor — otherwise this
 * silently hangs (no RED).
 */
/**
 * Read-state authority rows for a set of channels.
 *
 * The `deleted_at IS NULL` filter is REDUNDANT for every current caller: all of
 * them already resolve through a query that excludes soft-deleted channels
 * (inbox serving paths, `getChannel` without `includeDeleted`, or a just-created
 * channel). It is kept deliberately.
 *
 * Keeping it turns "no soft-deleted channel reaches this query" from a
 * convention every caller must honour into a property of this function. A fifth
 * caller that forgets to pre-filter is then harmless instead of silently
 * surfacing deleted channels' read state.
 *
 * Because it changes no current behaviour, it is exactly the kind of line that
 * looks safe to delete. It is not: see the boundary test
 * "fetchReadStateAuthorityRows excludes soft-deleted channels regardless of
 * what the caller passes", which goes red if this filter is removed.
 */
async function fetchReadStateAuthorityRows(
  channelIds: string[],
  userId: string,
  traceQuery: DbQueryTracer,
  traceName: string,
  executor: DatabaseExecutor = getDb(),
): Promise<UnreadSummaryReadStateRow[]> {
  if (channelIds.length === 0) return [];
  const result = await traceQuery(
    traceName,
    () => executor.execute(sql`
      SELECT
        c.id::text AS "channelId",
        (rc.user_id IS NOT NULL) AS "readCursorPresent",
        rc.read_state_version::int AS "readStateVersion",
        rc.last_read_seq::text AS "maxReadSeq",
        lm.id::text AS "latestActivityMessageId",
        lm.seq::text AS "latestActivitySeq",
        COALESCE(lm.seq, parent_message.seq)::text AS "doneFrontierSeq"
      FROM channels c
      LEFT JOIN joint_channel_servers joint_projection
        ON joint_projection.local_channel_id = c.id
       AND joint_projection.server_id = c.server_id
       AND joint_projection.status = 'active'
      LEFT JOIN joint_channels joint_storage
        ON joint_storage.id = joint_projection.joint_channel_id
       AND joint_storage.status = 'active'
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id AND rc.user_id = ${userId}
      LEFT JOIN channels storage_scope
        ON storage_scope.id = COALESCE(joint_storage.canonical_channel_id, c.id)
      LEFT JOIN messages parent_message
        ON parent_message.id = storage_scope.parent_message_id
      LEFT JOIN LATERAL (
        SELECT m.id, m.seq
        FROM messages m
        WHERE m.channel_id = COALESCE(joint_storage.canonical_channel_id, c.id)
        ORDER BY m.seq DESC
        LIMIT 1
      ) lm ON TRUE
      WHERE c.id IN (${sql.join(channelIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND c.deleted_at IS NULL
    `),
    (r) => ({ read_state_authority_rows_count: r.rows.length }),
  );
  return result.rows as unknown as UnreadSummaryReadStateRow[];
}

function readFrontierFromAuthorityRow(row: UnreadSummaryReadStateRow): InboxScopeReadFrontier {
  const cursor = row.readCursorPresent
    ? {
      readStateVersion: row.readStateVersion as number,
      maxReadSeq: row.maxReadSeq as string,
      latestActivityMessageId: row.latestActivityMessageId,
      latestActivitySeq: row.latestActivitySeq,
    }
    : null;
  return makeInboxScopeReadFrontier(cursor, (c) => {
    console.error(formatInboxScopeCorruptionLine(row.channelId, c));
  });
}

async function attachReadState<T extends { id: string }>(
  rows: T[],
  userId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<Array<T & ReadStateSnapshot>> {
  if (rows.length === 0) return [];
  const authorityRows = await fetchReadStateAuthorityRows(
    rows.map((row) => row.id),
    userId,
    untracedDbQuery,
    "channels.read_state_by_channels",
    executor,
  );
  const stateByChannel = new Map(authorityRows.map((row) => [row.channelId, row]));
  return rows.map((row) => {
    const state = stateByChannel.get(row.id);
    return {
      ...row,
      // Legacy fields keep their historical coalesce-to-0 shape for existing
      // consumers; the NEW readState union is the authoritative carrier
      // (#632) — absence/corruption stay visible there.
      maxReadSeq: state?.readCursorPresent ? Number(state.maxReadSeq) : 0,
      readStateVersion: state?.readCursorPresent ? (state.readStateVersion as number) : 0,
      readState: state ? readFrontierFromAuthorityRow(state) : makeInboxScopeReadFrontier(null),
    };
  });
}

// `type` is required, not optional: this row set decides whether the API
// announces a mute capability, and an absent type must fail the compile rather
// than silently default to "supported" (that default is what let DMs claim a
// control no surface renders — task #473).
async function attachActivityMuteState<T extends { id: string; type: string }>(
  rows: T[],
  receiverType: "user" | "agent",
  receiverId: string,
  enabled = true,
): Promise<Array<T & { activityMuted?: boolean; muteFromSeq?: number | null; prefsVersion?: number; activityMuteSupported?: boolean }>> {
  if (rows.length === 0) return [];
  if (!enabled) {
    return rows;
  }
  const states = await getDb()
    .select({
      sourceChannelId: inboxTargetMuteStates.sourceChannelId,
      activityMuted: inboxTargetMuteStates.activityMuted,
      muteFromSeq: inboxTargetMuteStates.muteFromSeq,
      prefsVersion: inboxTargetMuteStates.prefsVersion,
    })
    .from(inboxTargetMuteStates)
    .where(and(
      eq(inboxTargetMuteStates.receiverType, receiverType),
      eq(inboxTargetMuteStates.receiverId, receiverId),
      inArray(inboxTargetMuteStates.sourceChannelId, rows.map((row) => row.id)),
    ));
  const stateByChannel = new Map(states.map((state) => [state.sourceChannelId, state]));
  return rows.map((row) => {
    const state = stateByChannel.get(row.id);
    const activityMuted = !!state?.activityMuted && state.muteFromSeq != null;
    const muteFromSeq = activityMuted ? state!.muteFromSeq : null;
    return {
      ...row,
      activityMuted,
      muteFromSeq,
      prefsVersion: state?.prefsVersion ?? 0,
      activityMuteSupported: channelTypeSupportsActivityMute(row.type),
    };
  });
}

// Per-user message display prefs hydration (task #187 collapse-long-messages).
// A missing row means the default: long messages collapse (collapseLongMessages
// = true) at prefsVersion 0.
async function attachUserChannelDisplayPrefs<T extends { id: string }>(
  rows: T[],
  userId: string,
): Promise<Array<T & { collapseLongMessages: boolean; displayPrefsVersion: number }>> {
  if (rows.length === 0) return [];
  const states = await getDb()
    .select({
      channelId: userChannelDisplayPrefs.channelId,
      collapseLongMessages: userChannelDisplayPrefs.collapseLongMessages,
      prefsVersion: userChannelDisplayPrefs.prefsVersion,
    })
    .from(userChannelDisplayPrefs)
    .where(and(
      eq(userChannelDisplayPrefs.userId, userId),
      inArray(userChannelDisplayPrefs.channelId, rows.map((row) => row.id)),
    ));
  const stateByChannel = new Map(states.map((state) => [state.channelId, state]));
  return rows.map((row) => {
    const state = stateByChannel.get(row.id);
    return {
      ...row,
      collapseLongMessages: state?.collapseLongMessages ?? true,
      displayPrefsVersion: state?.prefsVersion ?? 0,
    };
  });
}

export async function isHumanActivityMuteEnabled(
  _serverId: string,
  _userId?: string | null,
): Promise<boolean> {
  // Human activity-mute launched via normal release (2026-06-30, tygg decision):
  // the `human_activity_mute_v0` flag-gating was dropped in favor of a code-level
  // enable, so the feature is unconditionally on for all servers/users. The
  // historyCutoff -> legacy-PG routing (free-plan/historyCutoff cohort) is
  // unaffected — it is handled separately in getInboxItemsFromRisingWave and is
  // out of scope here (long-standing perf tracked in #91). Removing the residual
  // flag infra is the deferred contract cleanup (#78).
  return true;
}

type DmIdentityKind = "human_self" | "human_human" | "human_agent" | "agent_agent";

function dmIdentityKey(participantIds: string[]): string {
  return participantIds.slice().sort().join(":");
}

function dmPairKey(kind: "human-agent" | "user-user" | "agent-agent", participantIds: string[]): string {
  return `${kind}:${participantIds.slice().sort().join(":")}`;
}

interface UnreadCountOptions {
  traceQuery?: DbQueryTracer;
}

export type ChannelUnreadSummaryEntry = {
  unreadCount: number;
  hasMention: boolean;
  hasAnyMention: boolean;
  /**
   * Authoritative per-scope read state (#632 SSOT): constructed from the
   * read-cursor table via the single shared constructor. The badge surface
   * derives read/unread from THIS, not from its own arithmetic.
   */
  readState: InboxScopeReadFrontier;
};

interface SidebarUnreadSummaryOptions {
  traceQuery?: DbQueryTracer;
}

type SidebarUnreadSummaryInput = {
  serverId: string;
  historyCutoff?: Date;
};

const RW_INBOX_ITEMS_V1_SERVING_VIEW = "rw_inbox_items_v1";
const RW_INBOX_ITEMS_V2_SERVING_VIEW = "rw_inbox_items_v2_suppressed_v3_4";
const RW_INBOX_ITEMS_V3_SERVING_VIEW = "rw_inbox_items_v3_2";

async function attachLastMessageAt<T extends { id: string }>(
  rows: T[],
  traceQuery: DbQueryTracer,
  queryName: string,
  countAttrName: string,
): Promise<Array<T & { lastMessageAt?: Date | null }>> {
  if (rows.length === 0) return [];

  const channelIds = rows.map((row) => row.id);
  const lastMessages = await traceQuery(
    queryName,
    () => getDb().execute(sql`
      WITH input_channels(channel_id) AS (
        VALUES ${sql.join(channelIds.map((id) => sql`(${id}::uuid)`), sql`, `)}
      )
      SELECT
        input_channels.channel_id::text AS "channelId",
        latest.created_at AS "lastMessageAt"
      FROM input_channels
      JOIN LATERAL (
        SELECT m.created_at
        FROM messages m
        WHERE m.channel_id = input_channels.channel_id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) latest ON TRUE
    `).then((result) =>
      (result.rows as Array<{ channelId: string; lastMessageAt: Date | string | null }>).map((row) => ({
        channelId: row.channelId,
        lastMessageAt: row.lastMessageAt instanceof Date
          ? row.lastMessageAt
          : row.lastMessageAt
            ? new Date(row.lastMessageAt)
            : null,
      }))
    ),
    (latestRows) => ({
      [countAttrName]: channelIds.length,
      channels_with_messages_count: latestRows.length,
    }),
  );
  const lastMessageMap = new Map(lastMessages.map((row) => [row.channelId, row.lastMessageAt]));
  return rows.map((row) => ({
    ...row,
    lastMessageAt: lastMessageMap.get(row.id) ?? null,
  }));
}

export async function attachJointChannelMetadata<T extends { id: string; type: string; serverId: string }>(
  rows: T[],
): Promise<Array<T & JointChannelMetadata>> {
  const jointRows = rows.filter((row) => row.type === "joint");
  if (jointRows.length === 0) {
    return rows.map((row) => ({
      ...row,
      jointChannelId: null,
      jointRole: null,
      jointPeerServerId: null,
      jointPeerServerName: null,
      jointPeerServerSlug: null,
      jointPeerStatus: null,
      jointServers: [],
      jointPendingInvites: [],
      jointBillingLocked: null,
    }));
  }

  const db = getDb();
  const localIds = jointRows.map((row) => row.id);
  const projections = await db
    .select({
      localChannelId: jointChannelServers.localChannelId,
      jointChannelId: jointChannelServers.jointChannelId,
      serverId: jointChannelServers.serverId,
      role: jointChannelServers.role,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      inArray(jointChannelServers.localChannelId, localIds),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ));
  const projectionByLocalId = new Map(projections.map((projection) => [projection.localChannelId, projection]));
  const jointIds = [...new Set(projections.map((projection) => projection.jointChannelId))];

  if (jointIds.length === 0) {
    return rows.map((row) => ({
      ...row,
      jointChannelId: null,
      jointRole: null,
      jointPeerServerId: null,
      jointPeerServerName: null,
      jointPeerServerSlug: null,
      jointPeerStatus: null,
      jointServers: [],
      jointPendingInvites: [],
      jointBillingLocked: null,
    }));
  }

  const activeServers = await db
    .select({
      jointChannelId: jointChannelServers.jointChannelId,
      serverId: jointChannelServers.serverId,
      serverName: servers.name,
      serverSlug: servers.slug,
      role: jointChannelServers.role,
    })
    .from(jointChannelServers)
    .innerJoin(servers, eq(servers.id, jointChannelServers.serverId))
    .where(and(
      inArray(jointChannelServers.jointChannelId, jointIds),
      eq(jointChannelServers.status, "active"),
    ));

  const pendingInvites = await db
    .select({
      id: jointChannelInvites.id,
      jointChannelId: jointChannelInvites.jointChannelId,
      fromServerId: jointChannelInvites.fromServerId,
      toServerId: jointChannelInvites.toServerId,
      invitedUserId: jointChannelInvites.invitedUserId,
      serverName: servers.name,
      serverSlug: servers.slug,
    })
    .from(jointChannelInvites)
    .innerJoin(servers, eq(servers.id, jointChannelInvites.toServerId))
    .where(and(
      inArray(jointChannelInvites.jointChannelId, jointIds),
      eq(jointChannelInvites.status, "pending"),
    ));

  const billingLockedByLocalId = new Map<string, boolean>();
  await Promise.all(
    projections.map(async (projection) => {
      billingLockedByLocalId.set(
        projection.localChannelId,
        await isChannelReadOnlyByBillingFeature(projection.localChannelId, projection.serverId),
      );
    }),
  );

  return rows.map((row) => {
    if (row.type !== "joint") {
      return {
        ...row,
        jointChannelId: null,
        jointRole: null,
        jointPeerServerId: null,
        jointPeerServerName: null,
        jointPeerServerSlug: null,
        jointPeerStatus: null,
        jointServers: [],
        jointPendingInvites: [],
        jointBillingLocked: null,
      };
    }

    const projection = projectionByLocalId.get(row.id);
    const activePeer = projection
      ? activeServers.find((server) => server.jointChannelId === projection.jointChannelId && server.serverId !== row.serverId)
      : null;
    const pendingPeer = projection
      ? pendingInvites.find((invite) => invite.jointChannelId === projection.jointChannelId && invite.fromServerId === row.serverId)
      : null;
    const activeRows = projection
      ? activeServers.filter((server) => server.jointChannelId === projection.jointChannelId)
      : [];
    const activeServerIds = new Set(activeRows.map((server) => server.serverId));
    const jointPendingInvites = projection
      ? pendingInvites
        .filter((invite) => invite.jointChannelId === projection.jointChannelId)
        .map((invite) => ({
          id: invite.id,
          fromServerId: invite.fromServerId,
          toServerId: invite.toServerId,
          serverName: invite.serverName,
          serverSlug: invite.serverSlug,
          invitedUserId: invite.invitedUserId,
          status: "pending" as const,
        }))
      : [];
    const pendingServerRows = new Map<string, JointServerMetadata>();
    for (const invite of jointPendingInvites) {
      if (activeServerIds.has(invite.toServerId) || pendingServerRows.has(invite.toServerId)) continue;
      pendingServerRows.set(invite.toServerId, {
        serverId: invite.toServerId,
        serverName: invite.serverName,
        serverSlug: invite.serverSlug,
        role: null,
        status: "pending",
      });
    }
    const jointServers: JointServerMetadata[] = [
      ...activeRows.map((server) => ({
        serverId: server.serverId,
        serverName: server.serverName,
        serverSlug: server.serverSlug,
        role: server.role as "host" | "participant",
        status: "active" as const,
        isCurrentServer: server.serverId === row.serverId,
      })),
      ...pendingServerRows.values(),
    ];

    return {
      ...row,
      jointChannelId: projection?.jointChannelId ?? null,
      jointRole: projection?.role ?? null,
      jointPeerServerId: activePeer?.serverId ?? pendingPeer?.toServerId ?? null,
      jointPeerServerName: activePeer?.serverName ?? pendingPeer?.serverName ?? null,
      jointPeerServerSlug: activePeer?.serverSlug ?? pendingPeer?.serverSlug ?? null,
      jointPeerStatus: activePeer ? "active" : pendingPeer ? "pending" : null,
      jointServers,
      jointPendingInvites,
      jointBillingLocked: projection ? billingLockedByLocalId.get(projection.localChannelId) ?? false : null,
    };
  });
}

interface FollowedThreadsOptions {
  traceQuery?: DbQueryTracer;
  executor?: DatabaseExecutor;
  state?: "active" | "done" | "unfollowed" | "unfollowed_active";
  maxRows?: number;
  channelId?: string;
  q?: string;
  sort?: "asc" | "desc";
}

interface ThreadSummaryOptions {
  traceQuery?: DbQueryTracer;
  userId?: string;
  parentMessageIds?: string[];
  parentMessageScopeSource?: "client" | "compat_recent" | "messages_page" | "messages_context";
}

/**
 * Attach secret-free current bridge identity to ordinary channel DTOs. This is
 * presentation metadata only: it does not grant provider or Raft authority.
 */
export async function attachExternalBridgeMetadata<T extends { id: string }>(
  list: T[],
  traceQuery: DbQueryTracer = untracedDbQuery,
): Promise<Array<T & ExternalBridgeMetadata>> {
  if (list.length === 0) return list;
  const rows = await traceQuery(
    "channels.external_bridges_by_channels",
    () => getDb().select({
      channelId: externalChannelBindings.channelId,
      provider: externalAppRegistrations.provider,
      providerConversationId: externalChannelBindings.providerConversationId,
      state: externalChannelBindings.state,
    }).from(externalChannelBindings)
      .innerJoin(
        externalAppRegistrations,
        eq(externalAppRegistrations.id, externalChannelBindings.registrationId),
      )
      .where(and(
        inArray(externalChannelBindings.channelId, list.map((channel) => channel.id)),
        inArray(externalChannelBindings.state, ["active", "paused", "quarantined"]),
        eq(externalAppRegistrations.state, "active"),
      )),
    (result) => ({
      channels_count: list.length,
      bridged_channels_count: result.length,
    }),
  );
  const bridgeByChannelId = new Map(rows.map((row) => [row.channelId, {
    provider: row.provider,
    providerConversationId: row.providerConversationId,
    state: row.state,
  }]));
  return list.map((channel) => {
    const bridge = bridgeByChannelId.get(channel.id);
    return bridge ? { ...channel, bridge } : channel;
  });
}

export async function listChannels(
  serverId: string,
  userId?: string,
  opts?: ChannelListOptions,
) {
  const db = getDb();
  const archivedFilter = opts?.archived ?? "exclude";
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;
  const conditions = [
    eq(channels.serverId, serverId),
    inArray(channels.type, LISTABLE_CHANNEL_TYPES),
    isNull(channels.deletedAt),
  ];
  if (archivedFilter === "exclude") conditions.push(isNull(channels.archivedAt));
  else if (archivedFilter === "only") conditions.push(isNotNull(channels.archivedAt));
  const list = await traceQuery(
    "channels.list_by_server",
    () => db.select().from(channels)
      .where(and(...conditions))
      .orderBy(asc(channels.createdAt)),
    (rows) => ({
      archived_filter: archivedFilter,
      channels_count: rows.length,
    }),
  );

  // Ensure #all channel exists for this server (lazy init for pre-existing servers).
  // Skip in "only" mode — the archived view should not create channels.
  if (archivedFilter === "only") {
    if (userId) {
      const serverRole = await resolveHumanServerRole(serverId, userId);
      const guestGateEnabled = serverRole === "guest" && await isGuestFeatureEnabled(serverId, userId);
      const memberships = await traceQuery(
        "channels.memberships_by_user",
        () => db
          .select({ channelId: channelHumans.channelId })
          .from(channelHumans)
          .where(eq(channelHumans.userId, userId)),
        (rows) => ({
          channels_count: list.length,
          memberships_count: rows.length,
        }),
      );
      const joinedSet = new Set(memberships.map((m) => m.channelId));
      const visibleChannels = list
        .filter((ch) => serverRole === "guest"
          ? canGuestReadChannel({
              gateEnabled: guestGateEnabled,
              serverRole,
              channelType: ch.type,
              channelName: ch.name,
              allChannelHidden: isAllSystemChannel(ch) && !isEnabledAllChannel(ch),
              guestVisible: ch.guestVisible,
              guestJoinable: ch.guestJoinable,
              isChannelMember: joinedSet.has(ch.id),
              archived: ch.archivedAt !== null,
              deleted: ch.deletedAt !== null,
            })
          : !requiresExplicitMembership(ch.type) || joinedSet.has(ch.id))
        .map((ch) => ({
          ...ch,
          joined: serverRole === "guest" && isAllSystemChannel(ch) ? false : joinedSet.has(ch.id),
        }));
      const humanActivityMuteEnabled = opts?.humanActivityMuteEnabled ?? await isHumanActivityMuteEnabled(serverId, userId);
      return attachJointChannelMetadata(
        await attachLastMessageAt(
          await attachReadState(
            await attachUserChannelDisplayPrefs(
              await attachActivityMuteState(visibleChannels, "user", userId, humanActivityMuteEnabled),
              userId,
            ),
            userId,
          ),
          traceQuery,
          "channels.last_messages_by_channels",
          "channels_count",
        ),
      );
    }
    const visibleChannels = list.filter((ch) => ch.type === "channel");
    return attachJointChannelMetadata(
      await attachLastMessageAt(visibleChannels, traceQuery, "channels.last_messages_by_channels", "channels_count"),
    );
  }

  let allChannel = list.find(isAllSystemChannel);
  if (!allChannel) {
    const result = await db.insert(channels).values({
      serverId,
      name: "all",
      description: "General channel for all members",
      type: "channel",
    }).onConflictDoNothing().returning();

    if (result.length > 0) {
      allChannel = result[0];
    } else {
      // Another request created it concurrently — fetch it
      const [existing] = await db.select().from(channels).where(and(
        eq(channels.serverId, serverId),
        eq(channels.name, SYSTEM_ALL_CHANNEL_KEY),
        inArray(channels.type, REGULAR_CHANNEL_TYPES),
        isNull(channels.deletedAt),
      ));
      allChannel = existing;
    }

    list.push(allChannel);
  }

  const visibleList = allChannel && !isEnabledAllChannel(allChannel)
    ? list.filter((channel) => channel.id !== allChannel.id)
    : list;

  // If userId provided, compute joined status for each channel
  if (userId) {
    const serverRole = await resolveHumanServerRole(serverId, userId);
    const guestGateEnabled = serverRole === "guest" && await isGuestFeatureEnabled(serverId, userId);
    const memberships = await traceQuery(
      "channels.memberships_by_user",
      () => db
        .select({ channelId: channelHumans.channelId })
        .from(channelHumans)
        .where(eq(channelHumans.userId, userId)),
      (rows) => ({
        channels_count: visibleList.length,
        memberships_count: rows.length,
      }),
    );
    const joinedSet = new Set(memberships.map((m) => m.channelId));

    const visibleChannels = visibleList
      .filter((ch) => serverRole === "guest"
        ? canGuestReadChannel({
            gateEnabled: guestGateEnabled,
            serverRole,
            channelType: ch.type,
            channelName: ch.name,
            allChannelHidden: isAllSystemChannel(ch) && !isEnabledAllChannel(ch),
            guestVisible: ch.guestVisible,
            guestJoinable: ch.guestJoinable,
            isChannelMember: joinedSet.has(ch.id),
            archived: ch.archivedAt !== null,
            deleted: ch.deletedAt !== null,
          })
        : !requiresExplicitMembership(ch.type) || joinedSet.has(ch.id))
      .map((ch) => ({
        ...ch,
        joined: serverRole === "guest"
          ? !isAllSystemChannel(ch) && joinedSet.has(ch.id)
          : isEnabledAllChannel(ch) || joinedSet.has(ch.id),
      }));
    const humanActivityMuteEnabled = opts?.humanActivityMuteEnabled ?? await isHumanActivityMuteEnabled(serverId, userId);
    return attachJointChannelMetadata(
      await attachLastMessageAt(
        await attachReadState(
          await attachUserChannelDisplayPrefs(
            await attachActivityMuteState(visibleChannels, "user", userId, humanActivityMuteEnabled),
            userId,
          ),
          userId,
        ),
        traceQuery,
        "channels.last_messages_by_channels",
        "channels_count",
      ),
    );
  }

  const visibleChannels = visibleList.filter((ch) => ch.type === "channel");
  return attachJointChannelMetadata(
    await attachLastMessageAt(visibleChannels, traceQuery, "channels.last_messages_by_channels", "channels_count"),
  );
}

export async function getSystemAllChannel(serverId: string) {
  const db = getDb();
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      eq(channels.name, SYSTEM_ALL_CHANNEL_KEY),
      inArray(channels.type, REGULAR_CHANNEL_TYPES),
      isNull(channels.deletedAt),
    ));
  return channel ?? null;
}

export async function updateChannel(
  channelId: string,
  updates: {
    name?: string;
    description?: string;
    type?: RegularChannelType;
    guestVisible?: boolean;
    guestJoinable?: boolean;
  },
  executor?: DatabaseExecutor,
) {
  const db = executor ?? getDb();
  const channel = await getChannel(channelId, { executor: db });
  if (!channel) throw new Error("Channel not found");
  if (!REGULAR_CHANNEL_TYPES.includes(channel.type as RegularChannelType) && channel.type !== "joint") {
    throw new Error("Cannot edit DM channels");
  }
  if (channel.type === "joint" && updates.type !== undefined) {
    throw new Error("Cannot change visibility for joint channels");
  }
  if ((updates.guestVisible !== undefined || updates.guestJoinable !== undefined)
    && channel.type !== "channel" && channel.type !== "private") {
    throw new Error("Guest access is supported only for ordinary channels");
  }
  if (isAllSystemChannel(channel) && updates.name && updates.name !== "all") {
    throw new Error("Cannot rename the #all channel");
  }
  if (isAllSystemChannel(channel) && updates.guestJoinable === true) {
    throw new Error("The #all channel does not support Guest joining");
  }
  if (!isAllSystemChannel(channel) && updates.name === SYSTEM_ALL_CHANNEL_KEY) {
    throw new Error('Channel name "all" is reserved');
  }
  const allSystemVisibilityUpdate = isAllSystemChannel(channel)
    && updates.type !== undefined
    && updates.type !== channel.type;

  const jointProjections = channel.type === "joint"
    ? await getActiveJointChannelProjectionsByLocalChannel(channelId, db)
    : [];

  // If renaming, check uniqueness. Joint channel names are shared metadata, so
  // every active projection's server must be able to accept the new local name
  // before any projection is updated.
  if (updates.name && updates.name !== channel.name) {
    const projectionChannels = jointProjections.length > 0
      ? jointProjections.map((projection) => projection.channel)
      : [channel];
    for (const projectionChannel of projectionChannels) {
      const [existing] = await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(
          eq(channels.serverId, projectionChannel.serverId),
          inArray(channels.type, LISTABLE_CHANNEL_TYPES),
          eq(channels.name, updates.name),
          ne(channels.id, projectionChannel.id),
          isNull(channels.deletedAt)
        ));
      if (existing) {
        throw new Error(`Channel name "${updates.name}" is already taken`);
      }
    }
  }

  const setValues: Record<string, unknown> = {};
  if (updates.name !== undefined) setValues.name = updates.name;
  if (updates.description !== undefined) setValues.description = updates.description || null;
  if (allSystemVisibilityUpdate) {
    setValues.type = updates.type;
  } else if (updates.type !== undefined && updates.type !== channel.type) {
    setValues.type = updates.type;
  }
  const nextType = updates.type ?? channel.type;
  const nextGuestVisible = nextType === "private" && !isAllSystemChannel(channel)
    ? false
    : updates.guestVisible ?? channel.guestVisible;
  const nextGuestJoinable = isAllSystemChannel(channel)
    ? false
    : nextType === "private"
      ? false
      : updates.guestJoinable ?? channel.guestJoinable;
  if (nextGuestJoinable && !nextGuestVisible) {
    throw new Error("Guest-joinable channels must also be guest-visible");
  }
  if (updates.guestVisible !== undefined || (nextType === "private" && !isAllSystemChannel(channel))) {
    setValues.guestVisible = nextGuestVisible;
  }
  if (isAllSystemChannel(channel) || updates.guestJoinable !== undefined || nextType === "private") {
    setValues.guestJoinable = nextGuestJoinable;
  }

  if (Object.keys(setValues).length === 0) {
    if (!executor) await revokeChannelAccessAfterUpdate(updates, channel);
    return channel;
  }

  const applyUpdate = async (tx: DatabaseExecutor) => {
    const projectionIds = channel.type === "joint" && jointProjections.length > 0
      ? jointProjections.map((projection) => projection.localChannelId)
      : [channelId];

    await tx.update(channels)
      .set(setValues)
      .where(inArray(channels.id, projectionIds));

    if (allSystemVisibilityUpdate && updates.type === "private") {
      await Promise.all([
        tx.delete(channelHumans).where(eq(channelHumans.channelId, channelId)),
        tx.delete(channelAgents).where(eq(channelAgents.channelId, channelId)),
      ]);
    }

    const [updated] = await tx.select().from(channels).where(eq(channels.id, channelId));

    if (channel.type === "channel" && updated.type === "private") {
      await pruneThreadFollowsOutsideParentMembership(channelId, tx);
    }

    return updated;
  };
  const updated = await (executor ? applyUpdate(executor) : getDb().transaction(applyUpdate));
  if (!executor) await revokeChannelAccessAfterUpdate(updates, updated);
  return updated;
}

/** Transaction callers invoke this only after commit, before publishing new
 * metadata/messages. Eviction is scoped to the connections that can lose read
 * access (closing a connection also drops its child thread rooms):
 * - `guestVisible: false` evicts the server's guest connections;
 * - `type: "private"` evicts connections of users who are not channel members;
 * - #all enable/disable evicts the whole server, since it changes every
 *   member's audience.
 * Widening changes (`guestVisible: true`, private -> public) revoke nothing.
 * The decision is made from the requested update and the committed row, not
 * a before/after diff, so an idempotent retry after a failed cross-replica
 * notification repairs the eviction instead of skipping it. */
export async function revokeChannelAccessAfterUpdate(
  updates: { type?: RegularChannelType; guestVisible?: boolean },
  after: Pick<typeof channels.$inferSelect, "id" | "serverId" | "type" | "name">,
) {
  if (isAllSystemChannel(after)) {
    if (updates.type !== undefined) await revokeSocketAccess({ serverId: after.serverId });
    return;
  }
  const revocations: Promise<void>[] = [];
  if (updates.guestVisible === false) {
    revocations.push(revokeSocketAccess({ serverId: after.serverId, scope: "guests" }));
  }
  if (updates.type === "private") {
    const memberUserIds = (await getChannelHumans(after.id)).map((human) => human.id);
    revocations.push(revokeSocketAccess({ serverId: after.serverId, scope: "non-members", channelId: after.id, memberUserIds }));
  }
  await Promise.all(revocations);
}

export async function getActiveJointChannelProjectionsByLocalChannel(
  channelId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<JointChannelProjection[]> {
  const db = executor;
  const [projection] = await db
    .select({ jointChannelId: jointChannelServers.jointChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      eq(jointChannelServers.localChannelId, channelId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ));
  let jointChannelId = projection?.jointChannelId ?? null;
  if (!jointChannelId) {
    const [storage] = await db
      .select({ jointChannelId: jointChannels.id })
      .from(jointChannels)
      .where(and(
        eq(jointChannels.canonicalChannelId, channelId),
        eq(jointChannels.status, "active"),
      ));
    jointChannelId = storage?.jointChannelId ?? null;
  }
  if (!jointChannelId) return [];

  const rows = await db
    .select({
      jointChannelId: jointChannelServers.jointChannelId,
      localChannelId: jointChannelServers.localChannelId,
      canonicalChannelId: jointChannels.canonicalChannelId,
      serverId: jointChannelServers.serverId,
      role: jointChannelServers.role,
      channel: channels,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
    .where(and(
      eq(jointChannelServers.jointChannelId, jointChannelId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
      isNull(channels.deletedAt),
    ))
    .orderBy(asc(jointChannelServers.joinedAt));

  return rows.map((row) => ({
    ...row,
    role: row.role as "host" | "participant",
  }));
}

async function ensureJointThreadProjectionForLocalParent(
  executor: DatabaseExecutor,
  input: {
    jointThreadId: string;
    localParentProjection: Pick<JointChannelProjection, "serverId" | "localChannelId" | "role">;
    parentMessageId: string;
    joinedByUserId: string | null;
  },
): Promise<{ localThreadChannelId: string; created: boolean }> {
  const [existingLocal] = await executor
    .select({ localChannelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.jointChannelId, input.jointThreadId),
      eq(jointChannelServers.serverId, input.localParentProjection.serverId),
      eq(jointChannelServers.status, "active"),
    ))
    .limit(1);

  if (existingLocal?.localChannelId) {
    return { localThreadChannelId: existingLocal.localChannelId, created: false };
  }

  const [threadProjection] = await executor.insert(channels).values({
    serverId: input.localParentProjection.serverId,
    name: `thread-${input.parentMessageId.slice(0, 8)}`,
    type: "thread",
    parentMessageId: null,
  }).returning();

  await executor.insert(jointChannelServers).values({
    jointChannelId: input.jointThreadId,
    serverId: input.localParentProjection.serverId,
    localChannelId: threadProjection.id,
    role: input.localParentProjection.role,
    status: "active",
    joinedByUserId: input.joinedByUserId,
  }).onConflictDoNothing();

  return { localThreadChannelId: threadProjection.id, created: true };
}

async function backfillJointThreadProjectionsForLocalParent(
  executor: DatabaseExecutor,
  input: {
    jointChannelId: string;
    canonicalParentChannelId: string;
    localParentProjection: Pick<JointChannelProjection, "serverId" | "localChannelId" | "role">;
    joinedByUserId: string | null;
  },
): Promise<void> {
  const canonicalThread = alias(channels, "joint_backfill_canonical_thread");
  const parentMessage = alias(messages, "joint_backfill_parent_message");
  const rows = await executor
    .select({
      jointThreadId: jointChannels.id,
      parentMessageId: canonicalThread.parentMessageId,
    })
    .from(jointChannels)
    .innerJoin(canonicalThread, eq(canonicalThread.id, jointChannels.canonicalChannelId))
    .innerJoin(parentMessage, eq(parentMessage.id, canonicalThread.parentMessageId))
    .where(and(
      eq(parentMessage.channelId, input.canonicalParentChannelId),
      eq(canonicalThread.type, "thread"),
      eq(jointChannels.status, "active"),
      isNull(canonicalThread.deletedAt),
    ));

  for (const row of rows) {
    if (!row.parentMessageId) continue;
    await ensureJointThreadProjectionForLocalParent(executor, {
      jointThreadId: row.jointThreadId,
      localParentProjection: input.localParentProjection,
      parentMessageId: row.parentMessageId,
      joinedByUserId: input.joinedByUserId,
    });
  }
}

async function listActiveJointThreadProjectionRows(
  input: { localThreadChannelId?: string; canonicalThreadChannelId?: string; serverId?: string },
  executor: DatabaseExecutor = getDb(),
): Promise<JointThreadProjection[]> {
  const db = executor;
  const localThread = alias(channels, "joint_thread_local_thread");
  const canonicalThread = alias(channels, "joint_thread_canonical_thread");
  const parentMessage = alias(messages, "joint_thread_parent_message");
  const parentJoint = alias(jointChannels, "joint_thread_parent_joint");
  const parentProjection = alias(jointChannelServers, "joint_thread_parent_projection");

  const filters = [
    eq(jointChannels.status, "active"),
    eq(jointChannelServers.status, "active"),
    eq(parentJoint.status, "active"),
    eq(parentProjection.status, "active"),
    eq(localThread.type, "thread"),
    eq(canonicalThread.type, "thread"),
    isNull(localThread.deletedAt),
    isNull(canonicalThread.deletedAt),
  ];
  if (input.localThreadChannelId) filters.push(eq(jointChannelServers.localChannelId, input.localThreadChannelId));
  if (input.canonicalThreadChannelId) filters.push(eq(jointChannels.canonicalChannelId, input.canonicalThreadChannelId));
  if (input.serverId) filters.push(eq(jointChannelServers.serverId, input.serverId));

  const rows = await db
    .select({
      jointThreadId: jointChannels.id,
      localThreadChannelId: jointChannelServers.localChannelId,
      canonicalThreadChannelId: jointChannels.canonicalChannelId,
      localServerId: jointChannelServers.serverId,
      localParentChannelId: parentProjection.localChannelId,
      canonicalParentChannelId: parentMessage.channelId,
      canonicalParentMessageId: canonicalThread.parentMessageId,
      role: jointChannelServers.role,
      threadChannel: localThread,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(localThread, eq(localThread.id, jointChannelServers.localChannelId))
    .innerJoin(canonicalThread, eq(canonicalThread.id, jointChannels.canonicalChannelId))
    .innerJoin(parentMessage, eq(parentMessage.id, canonicalThread.parentMessageId))
    .innerJoin(parentJoint, eq(parentJoint.canonicalChannelId, parentMessage.channelId))
    .innerJoin(parentProjection, and(
      eq(parentProjection.jointChannelId, parentJoint.id),
      eq(parentProjection.serverId, jointChannelServers.serverId),
    ))
    .where(and(...filters))
    .orderBy(asc(jointChannelServers.joinedAt));

  return rows
    .filter((row): row is typeof row & { canonicalParentMessageId: string } => Boolean(row.canonicalParentMessageId))
    .map((row) => ({ ...row, role: row.role as "host" | "participant" }));
}

export async function getJointThreadProjectionByLocalThread(
  localThreadChannelId: string,
  serverId?: string,
  executor: DatabaseExecutor = getDb(),
): Promise<JointThreadProjection | null> {
  const [projection] = await listActiveJointThreadProjectionRows({ localThreadChannelId, serverId }, executor);
  return projection ?? null;
}

export async function getActiveJointThreadProjectionsByCanonicalThread(
  canonicalThreadChannelId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<JointThreadProjection[]> {
  return listActiveJointThreadProjectionRows({ canonicalThreadChannelId }, executor);
}

export async function getJointThreadProjectionForMember(
  canonicalThreadChannelId: string,
  followerType: "user" | "agent",
  followerId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<JointThreadProjection | null> {
  const projections = await getActiveJointThreadProjectionsByCanonicalThread(canonicalThreadChannelId, executor);
  for (const projection of projections) {
    const isMember = followerType === "user"
      ? await isChannelHuman(projection.localParentChannelId, followerId, executor)
      : await isChannelAgent(projection.localParentChannelId, followerId, executor);
    if (isMember) return projection;
  }
  return null;
}

export async function canUserSeeAgentThroughJointChannel(serverId: string, userId: string, agentId: string): Promise<boolean> {
  const db = getDb();
  const localProjection = alias(jointChannelServers, "joint_profile_local_projection");
  const peerProjection = alias(jointChannelServers, "joint_profile_peer_projection");
  const [row] = await db
    .select({ jointChannelId: localProjection.jointChannelId })
    .from(localProjection)
    .innerJoin(peerProjection, eq(peerProjection.jointChannelId, localProjection.jointChannelId))
    .innerJoin(jointChannels, eq(jointChannels.id, localProjection.jointChannelId))
    .innerJoin(channelHumans, and(
      eq(channelHumans.channelId, localProjection.localChannelId),
      eq(channelHumans.userId, userId),
    ))
    .innerJoin(channelAgents, and(
      eq(channelAgents.channelId, peerProjection.localChannelId),
      eq(channelAgents.agentId, agentId),
    ))
    .where(and(
      eq(localProjection.serverId, serverId),
      eq(localProjection.status, "active"),
      eq(peerProjection.status, "active"),
      eq(jointChannels.status, "active"),
    ))
    .limit(1);
  return !!row;
}

/**
 * Local-channel counterpart to the joint projection check above. Guest agent
 * profiles are relation-scoped: seeing an Agent in one readable, joined
 * channel grants only its public summary, never the server-wide directory.
 */
export async function canUserSeeAgentThroughLocalChannel(
  serverId: string,
  requesterId: string,
  agentId: string,
): Promise<boolean> {
  return (await getAgentIdsVisibleThroughLocalChannels(serverId, requesterId)).has(agentId);
}

export async function getAgentIdsVisibleThroughLocalChannels(
  serverId: string,
  requesterId: string,
): Promise<Set<string>> {
  const readableChannels = await listChannels(serverId, requesterId, { archived: "include" });
  if (readableChannels.length === 0) return new Set();

  const db = getDb();
  const visibleAgentIds = new Set<string>();
  const explicitChannelIds = readableChannels
    .filter((channel) => !isEnabledAllChannel(channel))
    .map((channel) => channel.id);
  if (explicitChannelIds.length > 0) {
    const rows = await db
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .innerJoin(agents, and(eq(agents.id, channelAgents.agentId), isNull(agents.deletedAt)))
      .where(inArray(channelAgents.channelId, explicitChannelIds));
    for (const row of rows) visibleAgentIds.add(row.agentId);
  }
  if (readableChannels.some(isEnabledAllChannel)) {
    const rows = await db
      .select({ agentId: agents.id })
      .from(agents)
      .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt)));
    for (const row of rows) visibleAgentIds.add(row.agentId);
  }
  return visibleAgentIds;
}

export async function listJointActivityProjectionChannelIdsForAgent(agentId: string, sourceServerId: string): Promise<string[]> {
  const db = getDb();
  const sourceProjection = alias(jointChannelServers, "joint_activity_source_projection");
  const siblingProjection = alias(jointChannelServers, "joint_activity_sibling_projection");

  const rows = await db
    .select({ localChannelId: siblingProjection.localChannelId })
    .from(channelAgents)
    .innerJoin(sourceProjection, and(
      eq(sourceProjection.localChannelId, channelAgents.channelId),
      eq(sourceProjection.status, "active"),
    ))
    .innerJoin(siblingProjection, and(
      eq(siblingProjection.jointChannelId, sourceProjection.jointChannelId),
      eq(siblingProjection.status, "active"),
      ne(siblingProjection.serverId, sourceServerId),
    ))
    .where(eq(channelAgents.agentId, agentId));

  return [...new Set(rows.map((row) => row.localChannelId))];
}

export async function getJointVisibleHumanServerId(serverId: string, requesterId: string, targetUserId: string): Promise<string | null> {
  const db = getDb();
  const localProjection = alias(jointChannelServers, "joint_human_profile_local_projection");
  const peerProjection = alias(jointChannelServers, "joint_human_profile_peer_projection");
  const peerHumans = alias(channelHumans, "joint_human_profile_peer_humans");
  const [row] = await db
    .select({ serverId: peerProjection.serverId })
    .from(localProjection)
    .innerJoin(peerProjection, eq(peerProjection.jointChannelId, localProjection.jointChannelId))
    .innerJoin(jointChannels, eq(jointChannels.id, localProjection.jointChannelId))
    .innerJoin(channelHumans, and(
      eq(channelHumans.channelId, localProjection.localChannelId),
      eq(channelHumans.userId, requesterId),
    ))
    .innerJoin(peerHumans, and(
      eq(peerHumans.channelId, peerProjection.localChannelId),
      eq(peerHumans.userId, targetUserId),
    ))
    .where(and(
      eq(localProjection.serverId, serverId),
      eq(localProjection.status, "active"),
      eq(peerProjection.status, "active"),
      eq(jointChannels.status, "active"),
    ))
    .limit(1);
  return row?.serverId ?? null;
}

export async function canUserSeeHumanThroughLocalChannel(serverId: string, requesterId: string, targetUserId: string): Promise<boolean> {
  if (requesterId === targetUserId) return true;

  const db = getDb();
  const requesterRole = await resolveHumanServerRole(serverId, requesterId);
  const targetHumans = alias(channelHumans, "hidden_profile_target_humans");
  if (requesterRole === "guest") {
    if (!await isGuestFeatureEnabled(serverId, requesterId)) return false;
    const requesterMemberships = new Set((await db
      .select({ channelId: channelHumans.channelId })
      .from(channelHumans)
      .innerJoin(channels, and(
        eq(channels.id, channelHumans.channelId),
        eq(channels.serverId, serverId),
        isNull(channels.deletedAt),
      ))
      .where(eq(channelHumans.userId, requesterId))).map((row) => row.channelId));
    const targetChannels = await db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type,
        guestVisible: channels.guestVisible,
        guestJoinable: channels.guestJoinable,
        archivedAt: channels.archivedAt,
        deletedAt: channels.deletedAt,
      })
      .from(targetHumans)
      .innerJoin(channels, and(
        eq(channels.id, targetHumans.channelId),
        eq(channels.serverId, serverId),
        isNull(channels.deletedAt),
      ))
      .where(eq(targetHumans.userId, targetUserId));
    if (targetChannels.some((channel) => canGuestReadChannel({
      gateEnabled: true,
      serverRole: "guest",
      channelType: channel.type,
      channelName: channel.name,
      allChannelHidden: isAllSystemChannel(channel) && !isEnabledAllChannel(channel),
      guestVisible: channel.guestVisible,
      guestJoinable: channel.guestJoinable,
      isChannelMember: requesterMemberships.has(channel.id),
      archived: channel.archivedAt !== null,
      deleted: channel.deletedAt !== null,
    }))) return true;

    const allChannel = await getSystemAllChannel(serverId);
    return Boolean(
      allChannel
      && await isServerHumanMember(serverId, targetUserId)
      && canGuestReadChannel({
        gateEnabled: true,
        serverRole: "guest",
        channelType: allChannel.type,
        channelName: allChannel.name,
        allChannelHidden: !isEnabledAllChannel(allChannel),
        guestVisible: allChannel.guestVisible,
        guestJoinable: allChannel.guestJoinable,
        isChannelMember: false,
        archived: allChannel.archivedAt !== null,
        deleted: allChannel.deletedAt !== null,
      })
    );
  }
  const rows = await db
    .select({ name: channels.name, type: channels.type })
    .from(channelHumans)
    .innerJoin(targetHumans, and(
      eq(targetHumans.channelId, channelHumans.channelId),
      eq(targetHumans.userId, targetUserId),
    ))
    .innerJoin(channels, and(
      eq(channels.id, channelHumans.channelId),
      eq(channels.serverId, serverId),
      isNull(channels.deletedAt),
    ))
    .where(eq(channelHumans.userId, requesterId));

  return rows.some((channel) => !isAllSystemChannel(channel));
}

export async function getHumanIdsVisibleThroughLocalChannels(serverId: string, requesterId: string): Promise<Set<string>> {
  const db = getDb();
  const visibleHumans = alias(channelHumans, "hidden_directory_visible_humans");
  const rows = await db
    .select({
      userId: visibleHumans.userId,
      name: channels.name,
      type: channels.type,
    })
    .from(channelHumans)
    .innerJoin(visibleHumans, eq(visibleHumans.channelId, channelHumans.channelId))
    .innerJoin(channels, and(
      eq(channels.id, channelHumans.channelId),
      eq(channels.serverId, serverId),
      isNull(channels.deletedAt),
    ))
    .where(eq(channelHumans.userId, requesterId));

  return new Set(rows
    .filter((channel) => !isAllSystemChannel(channel))
    .map((channel) => channel.userId));
}

export async function getHumanIdsVisibleThroughJointChannels(serverId: string, requesterId: string): Promise<Set<string>> {
  const db = getDb();
  const localProjection = alias(jointChannelServers, "hidden_directory_joint_local_projection");
  const peerProjection = alias(jointChannelServers, "hidden_directory_joint_peer_projection");
  const peerHumans = alias(channelHumans, "hidden_directory_joint_peer_humans");
  const rows = await db
    .select({ userId: peerHumans.userId })
    .from(localProjection)
    .innerJoin(peerProjection, and(
      eq(peerProjection.jointChannelId, localProjection.jointChannelId),
      ne(peerProjection.serverId, serverId),
    ))
    .innerJoin(jointChannels, and(
      eq(jointChannels.id, localProjection.jointChannelId),
      eq(jointChannels.status, "active"),
    ))
    .innerJoin(channelHumans, and(
      eq(channelHumans.channelId, localProjection.localChannelId),
      eq(channelHumans.userId, requesterId),
    ))
    .innerJoin(peerHumans, eq(peerHumans.channelId, peerProjection.localChannelId))
    .where(and(
      eq(localProjection.serverId, serverId),
      eq(localProjection.status, "active"),
      eq(peerProjection.status, "active"),
    ));

  return new Set(rows.map((row) => row.userId));
}

export async function canUserSeeHumanThroughJointChannel(serverId: string, requesterId: string, targetUserId: string): Promise<boolean> {
  return !!await getJointVisibleHumanServerId(serverId, requesterId, targetUserId);
}

// Thread follows are delivery/inbox state, not access grants. Member removal
// keeps follows intact; private delivery paths intersect follows with current
// parent membership. Only parent visibility tightening needs a durable snapshot
// cleanup so historical public followers outside the private member set stop
// carrying stale attention state.
async function pruneThreadFollowsOutsideParentMembership(
  parentChannelId: string,
  executor: DatabaseExecutor,
) {
  const start = Date.now();
  const userResult = await executor.execute(sql`
    DELETE FROM ${threadFollows}
    WHERE ${threadFollows.followerType} = 'user'
      AND EXISTS (
        SELECT 1
        FROM ${channels} parent_threads
        INNER JOIN ${messages} parent_messages
          ON parent_messages.id = parent_threads.parent_message_id
        WHERE parent_threads.id = ${threadFollows.threadChannelId}
          AND parent_threads.type = 'thread'
          AND parent_threads.deleted_at IS NULL
          AND parent_messages.channel_id = ${parentChannelId}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ${channelHumans}
        WHERE ${channelHumans.channelId} = ${parentChannelId}
          AND ${channelHumans.userId} = ${threadFollows.followerId}
      )
    RETURNING 1
  `);

  const agentResult = await executor.execute(sql`
    DELETE FROM ${threadFollows}
    WHERE ${threadFollows.followerType} = 'agent'
      AND EXISTS (
        SELECT 1
        FROM ${channels} parent_threads
        INNER JOIN ${messages} parent_messages
          ON parent_messages.id = parent_threads.parent_message_id
        WHERE parent_threads.id = ${threadFollows.threadChannelId}
          AND parent_threads.type = 'thread'
          AND parent_threads.deleted_at IS NULL
          AND parent_messages.channel_id = ${parentChannelId}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ${channelAgents}
        WHERE ${channelAgents.channelId} = ${parentChannelId}
          AND ${channelAgents.agentId} = ${threadFollows.followerId}
      )
    RETURNING 1
  `);
  addTraceEvent("thread_follows.pruned_outside_parent_membership", {
    phase: "channel_visibility.private_conversion",
    user_row_count: userResult.rows.length,
    agent_row_count: agentResult.rows.length,
    row_count: userResult.rows.length + agentResult.rows.length,
    duration_ms: Date.now() - start,
  });
}

export async function getChannel(
  channelId: string,
  opts?: { includeDeleted?: boolean; executor?: DatabaseExecutor },
) {
  const db = opts?.executor ?? getDb();
  const conditions = [eq(channels.id, channelId)];
  if (!opts?.includeDeleted) {
    conditions.push(isNull(channels.deletedAt));
  }
  const [channel] = await db.select().from(channels).where(and(...conditions));
  return channel || null;
}

export async function hasDeletedDmThreadParent(threadChannelId: string, serverId: string): Promise<boolean> {
  const result = await getDb().execute(sql`
    SELECT 1
    FROM channels thread_channel
    INNER JOIN messages parent_message
      ON parent_message.id = thread_channel.parent_message_id
    INNER JOIN channels parent_channel
      ON parent_channel.id = parent_message.channel_id
    WHERE thread_channel.id = ${threadChannelId}::uuid
      AND thread_channel.server_id = ${serverId}::uuid
      AND thread_channel.type = 'thread'
      AND thread_channel.deleted_at IS NULL
      AND parent_channel.server_id = ${serverId}::uuid
      AND parent_channel.type = 'dm'
      AND parent_channel.deleted_at IS NOT NULL
    LIMIT 1
  `);
  return result.rows.length === 1;
}

export async function hasUserThreadResidue(userId: string, serverId: string, threadChannelId: string): Promise<boolean> {
  const result = await getDb().execute(sql`
    SELECT 1
    WHERE EXISTS (
      SELECT 1 FROM user_channel_read_cursors cursor_row
      WHERE cursor_row.user_id = ${userId}::uuid
        AND cursor_row.channel_id = ${threadChannelId}::uuid
    )
    OR EXISTS (
      SELECT 1 FROM inbox_serving_rows serving_row
      WHERE serving_row.receiver_type = 'user'
        AND serving_row.receiver_id = ${userId}::uuid
        AND serving_row.server_id = ${serverId}::uuid
        AND serving_row.source_channel_id = ${threadChannelId}::uuid
    )
    OR EXISTS (
      SELECT 1 FROM inbox_notification_facts fact_row
      WHERE fact_row.receiver_type = 'user'
        AND fact_row.receiver_id = ${userId}::uuid
        AND fact_row.server_id = ${serverId}::uuid
        AND fact_row.source_channel_id = ${threadChannelId}::uuid
    )
  `);
  return result.rows.length === 1;
}

export type ChannelAccessResolution =
  | {
      kind: "local";
      localChannelId: string;
      canonicalChannelId: string;
      serverId: string;
      channel: typeof channels.$inferSelect;
    }
  | {
      kind: "joint";
      localChannelId: string;
      canonicalChannelId: string;
      jointChannelId: string;
      localServerId: string;
      role: "host" | "participant";
      channel: typeof channels.$inferSelect;
    };

/**
 * Resolve a request-scoped channel id into its storage authority.
 *
 * For ordinary channels this is identity. For joint channels, the caller must
 * present the local projection id that belongs to their active server. The
 * canonical channel is storage-only and never grants cross-server access on
 * its own.
 */
export async function resolveChannelAccess(input: {
  serverId: string;
  channelId: string;
  includeDeleted?: boolean;
}): Promise<ChannelAccessResolution | null> {
  const channel = await getChannel(input.channelId, { includeDeleted: input.includeDeleted });
  if (!channel) return null;
  if (channel.serverId !== input.serverId) return null;

  if (channel.type !== "joint") {
    return {
      kind: "local",
      localChannelId: channel.id,
      canonicalChannelId: channel.id,
      serverId: channel.serverId,
      channel,
    };
  }

  const db = getDb();
  const [projection] = await db
    .select({
      jointChannelId: jointChannelServers.jointChannelId,
      localChannelId: jointChannelServers.localChannelId,
      localServerId: jointChannelServers.serverId,
      role: jointChannelServers.role,
      projectionStatus: jointChannelServers.status,
      canonicalChannelId: jointChannels.canonicalChannelId,
      jointStatus: jointChannels.status,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      eq(jointChannelServers.localChannelId, channel.id),
      eq(jointChannelServers.serverId, input.serverId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ));

  if (!projection) return null;

  return {
    kind: "joint",
    localChannelId: projection.localChannelId,
    canonicalChannelId: projection.canonicalChannelId,
    jointChannelId: projection.jointChannelId,
    localServerId: projection.localServerId,
    role: projection.role,
    channel,
  };
}

/**
 * Resolve every message-bearing channel visible through a server's local
 * namespace into canonical storage in one projection-aware query.
 */
export async function resolveServerMessageStorageChannelIds(
  serverId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<string[]> {
  const result = await executor.execute(sql`
    WITH local_channels AS (
      SELECT local_channel.id, local_channel.type
      FROM ${channels} local_channel
      WHERE local_channel.server_id = ${serverId}::uuid
    ), ordinary_local AS (
      SELECT local_channel.id AS storage_channel_id
      FROM local_channels local_channel
      WHERE local_channel.type <> 'joint'
        AND NOT EXISTS (
          SELECT 1
          FROM ${jointChannelServers} mapped_projection
          WHERE mapped_projection.local_channel_id = local_channel.id
        )
    ), active_joint_channels AS (
      SELECT joint_authority.canonical_channel_id AS storage_channel_id
      FROM local_channels local_channel
      INNER JOIN ${jointChannelServers} local_projection
        ON local_projection.local_channel_id = local_channel.id
      INNER JOIN ${jointChannels} joint_authority
        ON joint_authority.id = local_projection.joint_channel_id
      WHERE local_channel.type = 'joint'
        AND local_projection.server_id = ${serverId}::uuid
        AND local_projection.status = 'active'
        AND joint_authority.status = 'active'
    ), active_joint_threads AS (
      SELECT thread_authority.canonical_channel_id AS storage_channel_id
      FROM local_channels local_thread_scope
      INNER JOIN ${jointChannelServers} thread_projection
        ON thread_projection.local_channel_id = local_thread_scope.id
      INNER JOIN ${jointChannels} thread_authority
        ON thread_authority.id = thread_projection.joint_channel_id
      INNER JOIN ${channels} local_thread
        ON local_thread.id = thread_projection.local_channel_id
      INNER JOIN ${channels} canonical_thread
        ON canonical_thread.id = thread_authority.canonical_channel_id
      INNER JOIN ${messages} parent_message
        ON parent_message.id = canonical_thread.parent_message_id
      INNER JOIN ${jointChannels} parent_authority
        ON parent_authority.canonical_channel_id = parent_message.channel_id
      INNER JOIN ${jointChannelServers} parent_projection
        ON parent_projection.joint_channel_id = parent_authority.id
        AND parent_projection.server_id = thread_projection.server_id
      WHERE local_thread_scope.type = 'thread'
        AND thread_projection.server_id = ${serverId}::uuid
        AND thread_projection.status = 'active'
        AND thread_authority.status = 'active'
        AND parent_projection.status = 'active'
        AND parent_authority.status = 'active'
        AND local_thread.deleted_at IS NULL
        AND canonical_thread.type = 'thread'
        AND canonical_thread.deleted_at IS NULL
    )
    SELECT DISTINCT resolved.storage_channel_id::text AS "storageChannelId"
    FROM (
      SELECT storage_channel_id FROM ordinary_local
      UNION ALL
      SELECT storage_channel_id FROM active_joint_channels
      UNION ALL
      SELECT storage_channel_id FROM active_joint_threads
    ) resolved
    ORDER BY "storageChannelId"
  `);

  return (result.rows as Array<{ storageChannelId: string }>).map((row) => row.storageChannelId);
}

/**
 * For a thread channel, return the parent channel's type ("channel" | "private" | "joint" | "dm").
 * Returns null if the channel is not a thread or the parent can't be found.
 */
export async function getThreadParentChannelType(channel: { type: string; parentMessageId: string | null }): Promise<"channel" | "private" | "joint" | "dm" | null> {
  if (channel.type !== "thread" || !channel.parentMessageId) return null;
  const db = getDb();
  const [parentMsg] = await db
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, channel.parentMessageId));
  if (!parentMsg) return null;
  const parentChannel = await getChannel(parentMsg.channelId);
  return (parentChannel?.type as "channel" | "private" | "joint" | "dm") ?? null;
}

/**
 * Archive a channel. Freezes writes but preserves read access and the name.
 * Idempotent: archiving an already-archived channel is a no-op and returns
 * the current row.
 * Refuses to archive the #all channel, DMs, and threads.
 */
export async function archiveChannel(
  channelId: string,
  archivedByUserId: string,
  executor?: DatabaseExecutor,
) {
  const db = executor ?? getDb();
  const channel = await getChannel(channelId, { executor: db });
  if (!channel) throw new Error("Channel not found");
  if (!REGULAR_CHANNEL_TYPES.includes(channel.type as RegularChannelType) && channel.type !== "joint") throw new Error("Only regular channels can be archived");
  if (isAllSystemChannel(channel)) throw new Error("The #all channel cannot be archived");
  if (channel.archivedAt) return channel;

  if (channel.type === "joint") {
    const projections = await getActiveJointChannelProjectionsByLocalChannel(channelId);
    const projectionIds = projections.length > 0
      ? projections.map((projection) => projection.localChannelId)
      : [channelId];
    const [updated] = await db.update(channels)
      .set({ archivedAt: new Date(), archivedByUserId, archivedByAgentId: null })
      .where(inArray(channels.id, projectionIds))
      .returning();
    return updated ?? channel;
  }

  const applyArchive = async (tx: DatabaseExecutor) => {
    const [updated] = await tx.update(channels)
      .set({ archivedAt: currentDate(), archivedByUserId, archivedByAgentId: null })
      .where(and(eq(channels.id, channelId), isNull(channels.archivedAt)))
      .returning();
    if (!updated) {
      const [unchanged] = await tx.select().from(channels).where(eq(channels.id, channelId)).limit(1);
      return unchanged ?? channel;
    }
    await emitPublicChannelArchiveEvents(tx, updated, "human");
    return updated;
  };
  return executor ? applyArchive(executor) : getDb().transaction(applyArchive);
}

async function emitPublicChannelArchiveEvents(
  executor: DatabaseExecutor,
  channel: typeof channels.$inferSelect,
  actorType: "human" | "agent",
): Promise<void> {
  if (channel.type !== "channel") return;
  const provenance = {
    source: "channel_service",
    actor_type: actorType,
    changed_fields: ["archived"],
  };
  await emitAppFacingNotificationEvent({
    serverId: channel.serverId,
    eventType: "server.public_channel_archived",
    subjectType: "channel",
    subjectId: channel.id,
    provenance,
  }, executor);
  await emitAppFacingNotificationEvent({
    serverId: channel.serverId,
    eventType: "channel.archived",
    subjectType: "channel",
    subjectId: channel.id,
    provenance,
  }, executor);
}

/**
 * Atomically archive or unarchive a local public/private channel as an agent.
 *
 * The conditional write is the source of truth for `changed`: concurrent
 * identical requests cannot both claim the transition and therefore cannot
 * emit duplicate lifecycle activity. Agent provenance is stored on the
 * channel row rather than relying on a best-effort system message.
 */
export async function setLocalChannelArchivedByAgent(
  channelId: string,
  archivedByAgentId: string,
  archived: boolean,
  executor?: DatabaseExecutor,
): Promise<{ channel: typeof channels.$inferSelect; changed: boolean }> {
  const db = executor ?? getDb();
  const current = await getChannel(channelId, { executor: db });
  if (!current) throw new Error("Channel not found");
  if (!REGULAR_CHANNEL_TYPES.includes(current.type as RegularChannelType)) {
    throw new Error("Only regular channels can be archived");
  }
  if (isAllSystemChannel(current)) throw new Error("The #all channel cannot be archived");

  const applyArchive = async (tx: DatabaseExecutor) => {
    const [updated] = await tx.update(channels)
      .set(archived
        ? {
            archivedAt: currentDate(),
            archivedByUserId: null,
            archivedByAgentId,
          }
        : {
            archivedAt: null,
            archivedByUserId: null,
            archivedByAgentId: null,
          })
      .where(and(
        eq(channels.id, channelId),
        archived ? isNull(channels.archivedAt) : isNotNull(channels.archivedAt),
      ))
      .returning();

    if (updated) {
      if (archived) await emitPublicChannelArchiveEvents(tx, updated, "agent");
      return { channel: updated, changed: true };
    }
    const [unchanged] = await tx.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!unchanged) throw new Error("Channel not found");
    return { channel: unchanged, changed: false };
  };
  return executor ? applyArchive(executor) : getDb().transaction(applyArchive);
}

/**
 * Unarchive a channel. Idempotent on already-active channels.
 */
export async function unarchiveChannel(channelId: string, executor?: DatabaseExecutor) {
  const db = executor ?? getDb();
  const channel = await getChannel(channelId, { executor: db });
  if (!channel) throw new Error("Channel not found");
  if (!REGULAR_CHANNEL_TYPES.includes(channel.type as RegularChannelType) && channel.type !== "joint") throw new Error("Only regular channels can be unarchived");
  if (!channel.archivedAt) return channel;

  if (channel.type === "joint") {
    const projections = await getActiveJointChannelProjectionsByLocalChannel(channelId);
    const projectionIds = projections.length > 0
      ? projections.map((projection) => projection.localChannelId)
      : [channelId];
    const [updated] = await db.update(channels)
      .set({ archivedAt: null, archivedByUserId: null, archivedByAgentId: null })
      .where(inArray(channels.id, projectionIds))
      .returning();
    return updated ?? channel;
  }

  const [updated] = await db.update(channels)
    .set({ archivedAt: null, archivedByUserId: null, archivedByAgentId: null })
    .where(eq(channels.id, channelId))
    .returning();
  return updated;
}

/**
 * Source of truth for the archive write-gate. Returns true if the channel
 * exists and is archived. Threads inherit their parent's archived state, so
 * archiving a channel also freezes all of its threads.
 */
export async function isChannelArchived(channelId: string): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (!channel) return false;
  if (channel.archivedAt) return true;
  if (channel.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    if (jointThread) {
      return isChannelArchived(jointThread.localParentChannelId);
    }
  }

  if (channel.type === "thread" && channel.parentMessageId) {
    const db = getDb();
    const [parentMsg] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return false;
    return isChannelArchived(parentMsg.channelId);
  }
  return false;
}

export class ChannelArchivedError extends Error {
  constructor(public readonly channelId: string) {
    super("Channel is archived");
    this.name = "ChannelArchivedError";
  }
}

export class ArchivedNameCollisionError extends Error {
  constructor(
    public readonly channelName: string,
    public readonly archivedChannelId: string,
    public readonly archivedChannelType: string,
  ) {
    super(`Channel name "${channelName}" is held by an archived channel`);
    this.name = "ArchivedNameCollisionError";
  }
}

/**
 * Throws ChannelArchivedError if the channel (or its parent, for threads) is
 * archived. Call from write-path code to freeze all mutations on archived
 * channels.
 */
export async function assertChannelNotArchived(channelId: string): Promise<void> {
  if (await isChannelArchived(channelId)) {
    throw new ChannelArchivedError(channelId);
  }
}

export async function deleteChannel(channelId: string) {
  const db = getDb();
  const channel = await getChannel(channelId, { includeDeleted: true });

  if (!channel) return;

  // Prevent deletion of the built-in #all channel
  if (isAllSystemChannel(channel)) {
    throw new Error("The #all channel cannot be deleted");
  }

  const now = currentDate();

  // Channel is soft-deleted, so the FK `onDelete: cascade` never fires.
  // If we leave open tasks behind, users see them in the Tasks panel but
  // `PATCH /tasks/:id/status` 404s because `getChannel()` filters by
  // `deletedAt IS NULL`. Auto-close open tasks to the terminal `closed`
  // state so the panel shows them as "🚫 Closed" instead of stuck open.
  // Done/closed tasks are left as-is (already terminal).
  //
  // v1.4: a channel's open tasks can live on either side during the mixed
  // window — legacy `messages.task_*` or the canonical `tasks` table — so both
  // are closed here. Closing only one side would leave the other stuck open in
  // exactly the state this hook exists to prevent.
  await db.transaction(async (tx) => {
    await tx.update(messages)
      .set({
        taskStatus: "closed",
        taskCompletedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(messages.channelId, channelId),
        inArray(messages.taskStatus, ["todo", "in_progress", "in_review"]),
      ));

    // `closed_by_*` stays null: the enum is user|agent and this close has no
    // human/agent actor. The actor is recorded on the audit event instead.
    const autoClosed = await tx.update(tasks)
      .set({
        status: "closed",
        completedAt: now,
        closedAt: now,
        revision: sql`${tasks.revision} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(tasks.channelId, channelId),
        inArray(tasks.status, ["todo", "in_progress", "in_review"]),
      ))
      .returning({ id: tasks.id });

    if (autoClosed.length > 0) {
      await tx.insert(taskEvents).values(autoClosed.map((task) => ({
        taskId: task.id,
        eventType: "closed" as const,
        actorType: "system" as const,
        actorId: null,
        payload: { status: "closed", reason: "channel_deleted", channelId },
      })));
    }

    await tx.update(channels)
      .set({ deletedAt: now })
      .where(eq(channels.id, channelId));
  });
}

/** Payload reason marking an unassign the disconnect caused, not a person choosing. */
export const TASK_UNASSIGN_REASON_JOINT_DISCONNECTED = "joint_channel_disconnected";

/**
 * Clear assignees that no active projection can reach any more.
 *
 * `disconnectJointChannel` used to touch only the projection row and the local
 * channel, never `tasks`. The leaving side's cards fall into the existing
 * membership checks, but a card on the REMAINING side kept rendering "assigned
 * to X" while X had no active projection left to reach it — an identity claim
 * with nothing behind it.
 *
 * Reachability is re-derived with the same predicate `assignTask` uses
 * (`lockTaskAssigneeEligibility` in taskService): the union of members across
 * projections that are still `active`. A cheaper rule — "unassign everyone from
 * the departing server" — would be wrong, because a human is a GLOBAL logical
 * identity: someone who is a member via both the departing projection and a
 * surviving one is still reachable and must keep the task. Agents are
 * server-owned, so an agent on the departing server is not.
 *
 * Must run inside the disconnect transaction and AFTER the projection/channel
 * rows are updated, so it reads post-disconnect truth.
 *
 * `done` is excluded: its assignee is frozen and rewriting it would rewrite
 * history. `closed` is included — it can transition back to `todo`/
 * `in_progress`, so leaving a dangling assignee there only defers the same bug.
 * That matches `writeCanonicalUnclaim`, which also blocks `done` alone.
 */
async function unassignUnreachableJointTasks(
  tx: DatabaseExecutor,
  jointChannelId: string,
  disconnectedByUserId: string,
  now: Date,
) {
  const [joint] = await tx
    .select({ canonicalChannelId: jointChannels.canonicalChannelId })
    .from(jointChannels)
    .where(eq(jointChannels.id, jointChannelId))
    .limit(1);
  if (!joint) return;

  const assigned = await tx
    .select({
      id: tasks.id,
      claimedByType: tasks.claimedByType,
      claimedById: tasks.claimedById,
    })
    .from(tasks)
    .where(and(
      eq(tasks.channelId, joint.canonicalChannelId),
      isNotNull(tasks.claimedById),
      ne(tasks.status, "done"),
    ))
    .for("update");
  if (assigned.length === 0) return;

  const activeProjection = and(
    eq(jointChannelServers.jointChannelId, jointChannelId),
    eq(jointChannelServers.status, "active"),
  );
  const liveLocalChannel = and(
    eq(channels.id, jointChannelServers.localChannelId),
    eq(channels.serverId, jointChannelServers.serverId),
    isNull(channels.deletedAt),
  );

  const reachableUserRows = await tx
    .select({ id: channelHumans.userId })
    .from(jointChannelServers)
    .innerJoin(channelHumans, eq(channelHumans.channelId, jointChannelServers.localChannelId))
    .innerJoin(channels, liveLocalChannel)
    .where(activeProjection);

  const reachableAgentRows = await tx
    .select({ id: channelAgents.agentId })
    .from(jointChannelServers)
    .innerJoin(channelAgents, eq(channelAgents.channelId, jointChannelServers.localChannelId))
    .innerJoin(channels, liveLocalChannel)
    .innerJoin(agents, and(
      eq(agents.id, channelAgents.agentId),
      eq(agents.serverId, jointChannelServers.serverId),
      isNull(agents.deletedAt),
    ))
    .where(activeProjection);

  const reachableUserIds = new Set(reachableUserRows.map((row) => row.id));
  const reachableAgentIds = new Set(reachableAgentRows.map((row) => row.id));

  for (const task of assigned) {
    const assigneeType = task.claimedByType;
    const assigneeId = task.claimedById;
    if (!assigneeType || !assigneeId) continue;
    const stillReachable = assigneeType === "user"
      ? reachableUserIds.has(assigneeId)
      : reachableAgentIds.has(assigneeId);
    if (stillReachable) continue;

    await tx.update(tasks)
      .set({
        claimedByType: null,
        claimedById: null,
        claimedAt: null,
        revision: sql`${tasks.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id));

    // actorType stays "user" with the disconnecting user's id — a person did
    // cause this, and `system` would lose who. `reason` is what separates it
    // from a manual unclaim, so history never reads "they dropped it themselves".
    await tx.insert(taskEvents).values({
      taskId: task.id,
      eventType: "assignee_changed" as const,
      actorType: "user" as const,
      actorId: disconnectedByUserId,
      payload: {
        assigneeType: null,
        assigneeId: null,
        previousAssigneeType: assigneeType,
        previousAssigneeId: assigneeId,
        reason: TASK_UNASSIGN_REASON_JOINT_DISCONNECTED,
      },
    });
  }
}

export async function disconnectJointChannel(channelId: string, disconnectedByUserId: string) {
  const db = getDb();
  const channel = await getChannel(channelId);
  if (!channel) throw new Error("Channel not found");
  if (channel.type !== "joint") throw new Error("Only joint channels can be disconnected");

  const now = new Date();
  await db.transaction(async (tx) => {
    const [projection] = await tx
      .select({ jointChannelId: jointChannelServers.jointChannelId })
      .from(jointChannelServers)
      .where(and(
        eq(jointChannelServers.localChannelId, channelId),
        eq(jointChannelServers.status, "active"),
      ));
    if (!projection) throw new Error("Joint channel not found");

    await tx.update(jointChannelServers)
      .set({
        status: "disconnected",
        disconnectedByUserId,
        disconnectedAt: now,
      })
      .where(and(
        eq(jointChannelServers.jointChannelId, projection.jointChannelId),
        eq(jointChannelServers.localChannelId, channelId),
      ));

    await tx.update(channels)
      .set({ deletedAt: now })
      .where(eq(channels.id, channelId));

    // Settle assignees the disconnect just made unreachable. This must run
    // AFTER the two updates above and inside the same transaction: it re-derives
    // reachability from the projections that are still active, so it depends on
    // this projection already being 'disconnected' and its local channel already
    // soft-deleted. Eager, not lazy-at-read — a stale assignee must never be
    // observable, and read-time settlement would need every reader to remember.
    await unassignUnreachableJointTasks(tx, projection.jointChannelId, disconnectedByUserId, now);
  });
}

async function deletePrivateChannelIfEmpty(channelId: string, db: DatabaseExecutor = getDb()) {
  const [channel] = await db
    .select({ type: channels.type, deletedAt: channels.deletedAt })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!channel || channel.type !== "private" || channel.deletedAt) return;

  const result = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM channel_humans WHERE channel_id = ${channelId}) AS "humanCount",
      (SELECT count(*)::int FROM channel_agents WHERE channel_id = ${channelId}) AS "agentCount"
  `);
  const [row] = result.rows as Array<{ humanCount?: number; agentCount?: number }>;
  const humanCount = row?.humanCount ?? 0;
  const agentCount = row?.agentCount ?? 0;
  if (humanCount + agentCount > 0) return;

  await db.update(channels)
    .set({ deletedAt: new Date() })
    .where(and(eq(channels.id, channelId), eq(channels.type, "private"), isNull(channels.deletedAt)));
}

export async function addAgent(
  channelId: string,
  agentId: string,
  options: { role?: "member" | "admin"; executor?: DatabaseExecutor } = {},
) {
  const db = options.executor ?? getDb();
  const channel = await getChannel(channelId, { executor: db });
  if (!channel) {
    throw new Error("Channel not found");
  }
  if (channel?.type === "thread") {
    throw new Error("Thread membership is managed via follow/unfollow, not channel_agents");
  }
  const [agent] = await db
    .select({ serverId: agents.serverId })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent || agent.serverId !== channel.serverId) {
    throw new Error("Agent is not a member of this channel's server");
  }
  if (isAllSystemChannel(channel)) {
    return false;
  }
  const inserted = await db
    .insert(channelAgents)
    .values({ channelId, agentId, role: options.role ?? "member" })
    .onConflictDoNothing()
    .returning({ agentId: channelAgents.agentId });
  return inserted.length > 0;
}

export async function removeAgent(channelId: string, agentId: string, executor?: DatabaseExecutor) {
  const db = executor ?? getDb();
  const channel = await getChannel(channelId, { executor: db });
  if (channel?.type === "thread") {
    throw new Error("Thread membership is managed via follow/unfollow, not channel_agents");
  }
  // Protect #all channel
  if (channel && isAllSystemChannel(channel)) {
    throw new Error("Cannot remove members from the #all channel");
  }
  await db.delete(channelAgents).where(
    and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, agentId))
  );
  await deletePrivateChannelIfEmpty(channelId, db);
}

async function getChannelAgentsRaw(channelId: string) {
  const db = getDb();
  return db
    .select({
      id: agents.id,
      serverId: agents.serverId,
      serverName: servers.name,
      serverSlug: servers.slug,
      name: agents.name,
      displayName: agents.displayName,
      status: agents.status,
      avatarUrl: agents.avatarUrl,
      channelRole: channelAgents.role,
      serverRole: serverAgentMembers.role,
    })
    .from(channelAgents)
    .innerJoin(agents, eq(channelAgents.agentId, agents.id))
    .innerJoin(servers, eq(servers.id, agents.serverId))
    // Channel membership is the audience authority here. Keep the server-role
    // projection additive: legacy/test rows can predate server_agent_members
    // and must not disappear from delivery merely because role metadata is
    // absent.
    .leftJoin(serverAgentMembers, and(
      eq(serverAgentMembers.serverId, agents.serverId),
      eq(serverAgentMembers.agentId, agents.id),
    ))
    .where(and(eq(channelAgents.channelId, channelId), isNull(agents.deletedAt)))
    .orderBy(asc(channelAgents.addedAt));
}

/**
 * The full agent audience of a server. This is the effective agent membership
 * of an enabled virtual `#all` channel: in the pre-virtualization model every
 * active agent had a real `channel_agents` row in `#all`, so the audience is
 * every active (non-deleted) agent on the server.
 */
async function getServerAudienceAgents(serverId: string) {
  const db = getDb();
  return db
    .select({
      id: agents.id,
      serverId: agents.serverId,
      serverName: servers.name,
      serverSlug: servers.slug,
      name: agents.name,
      displayName: agents.displayName,
      status: agents.status,
      avatarUrl: agents.avatarUrl,
    })
    .from(agents)
    .innerJoin(servers, eq(servers.id, agents.serverId))
    .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt)))
    .orderBy(asc(agents.createdAt));
}

/**
 * Agent membership of a channel. For an enabled virtual `#all` channel this is
 * the whole server agent audience (single source of truth shared with
 * getChannelMembers / getVirtualAllChannelMembers), so message delivery, agent
 * wake/system messages, push/unread, and the member-list API all match the
 * pre-virtualization behavior. All other channels read their explicit
 * `channel_agents` rows.
 */
export async function getChannelAgents(channelId: string) {
  const channel = await getChannel(channelId);
  if (channel && isEnabledAllChannel(channel)) {
    return getServerAudienceAgents(channel.serverId);
  }
  return getChannelAgentsRaw(channelId);
}

export async function getAgentChannels(agentId: string, viewerUserId: string) {
  const db = getDb();
  const viewerMembership = alias(channelHumans, "viewer_agent_channel_membership");
  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      description: channels.description,
      type: channels.type,
      createdAt: channels.createdAt,
      archivedAt: channels.archivedAt,
    })
    .from(channelAgents)
    .innerJoin(channels, eq(channelAgents.channelId, channels.id))
    .leftJoin(viewerMembership, and(
      eq(viewerMembership.channelId, channels.id),
      eq(viewerMembership.userId, viewerUserId),
    ))
    .where(
      and(
        eq(channelAgents.agentId, agentId),
        inArray(channels.type, LISTABLE_CHANNEL_TYPES),
        or(
          eq(channels.type, "channel"),
          isNotNull(viewerMembership.userId),
        ),
        isNull(channels.deletedAt)
      )
    )
    .orderBy(asc(channels.name));
  return attachActivityMuteState(rows, "agent", agentId);
}

export async function listChannelsForAgent(serverId: string, agentId: string) {
  const db = getDb();
  const memberships = await db
    .select({
      channelId: channelAgents.channelId,
      role: channelAgents.role,
      authorityRevision: channelAgents.authorityRevision,
    })
    .from(channelAgents)
    .where(eq(channelAgents.agentId, agentId));
  const joinedSet = new Set(memberships.map((m) => m.channelId));
  const membershipByChannel = new Map(memberships.map((membership) => [membership.channelId, membership]));
  const [agentServerMembership] = await db.select({ role: serverAgentMembers.role })
    .from(serverAgentMembers)
    .where(and(eq(serverAgentMembers.serverId, serverId), eq(serverAgentMembers.agentId, agentId)));
  const list = await db
    .select()
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      inArray(channels.type, LISTABLE_CHANNEL_TYPES),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
    ))
    .orderBy(asc(channels.createdAt));

  const visibleChannels = list
    .filter((ch) => !requiresExplicitMembership(ch.type) || joinedSet.has(ch.id))
    .map((ch) => {
      const membership = membershipByChannel.get(ch.id);
      const joined = isEnabledAllChannel(ch) || Boolean(membership);
      const supportsChannelRoles = (ch.type === "channel" || ch.type === "private") && !isAllSystemChannel(ch);
      return {
        ...ch,
        joined,
        channelRole: membership?.role ?? null,
        channelAuthorityRevision: membership?.authorityRevision ?? null,
        channelAdminBasis: getChannelAdminBasis({
          serverRole: agentServerMembership?.role ?? null,
          channelRole: membership?.role ?? null,
          isChannelMember: Boolean(membership),
          supportsChannelRoles,
        }),
        channelCapabilities: Object.fromEntries(CHANNEL_MANAGEMENT_CAPABILITIES.map((capability) => [
          capability,
          capability === "addChannelMembers"
            ? canAddChannelMembers({
                serverRole: agentServerMembership?.role ?? null,
                admissionClass: "current_member",
                isChannelMember: Boolean(membership),
                channelType: ch.type,
                channelName: ch.name,
                archived: ch.archivedAt !== null,
                deleted: ch.deletedAt !== null,
              })
            : hasEffectiveChannelCapability({
                serverRole: agentServerMembership?.role ?? null,
                channelRole: membership?.role ?? null,
                isChannelMember: Boolean(membership),
                supportsChannelRoles,
                capability,
              }),
        ])),
      };
    });
  // v1 built-in app conversations are intentionally not ordinary DMs: they
  // have one agent member and no dm_channel_identities row. Admit only the
  // exact registry-derived rows for this authenticated agent. This keeps
  // arbitrary DMs and test-catalog app names out of the channel directory and
  // writable target surface.
  const installedApps = await listInstalledRapApps(serverId);
  const builtInDmChannels = (await Promise.all(installedApps.map((app) =>
    getBuiltInConversationChannel(serverId, app.appId, agentId)
  )))
    .filter((channel): channel is NonNullable<typeof channel> => channel !== null)
    .map((channel) => ({ ...channel, joined: true }));
  const visibleWithMuteState = await attachActivityMuteState(visibleChannels, "agent", agentId);
  const builtInDmWithoutMuteSurface = builtInDmChannels.map((channel) => ({
    ...channel,
    activityMuted: false,
    muteFromSeq: null,
    prefsVersion: 0,
    activityMuteSupported: false,
  }));
  return [...visibleWithMuteState, ...builtInDmWithoutMuteSurface]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

// DM support — unified peer model for both agent-DMs and user-DMs

/** Peer info returned for DMs (agent or user) */
export interface DMPeer {
  peerType: "agent" | "user";
  peerId: string;
  peerName: string;
  peerDisplayName: string | null;
  peerDescription: string | null;
  peerGravatarHash: string | null;
  peerAvatarUrl: string | null;
}

/** DM channel with peer info */
export type DMChannel = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  createdAt: Date;
  lastMessageAt?: Date | null;
  activityMuted?: boolean;
  muteFromSeq?: number | null;
  prefsVersion?: number;
  activityMuteSupported?: boolean;
  maxReadSeq?: number;
  readStateVersion?: number;
} & DMPeer;

interface DMChannelListOptions {
  traceQuery?: DbQueryTracer;
  humanActivityMuteEnabled?: boolean;
}

/**
 * Select a DM channel with its peer info (agent-DM).
 */
async function selectDMWithAgentPeer(channelId: string): Promise<DMChannel | null> {
  const db = getDb();
  const [result] = await db
    .select({
      id: channels.id,
      name: channels.name,
      type: channels.type,
      description: channels.description,
      createdAt: channels.createdAt,
      peerId: agents.id,
      peerName: agents.name,
      peerDisplayName: agents.displayName,
      peerDescription: agents.description,
      peerGravatarHash: sql<string | null>`null`,
      peerAvatarUrl: agents.avatarUrl,
    })
    .from(channels)
    .innerJoin(channelAgents, eq(channels.id, channelAgents.channelId))
    .innerJoin(agents, eq(channelAgents.agentId, agents.id))
    .where(and(eq(channels.id, channelId), isNull(agents.deletedAt)));
  if (!result) return null;
  return { ...result, peerType: "agent" as const };
}

/**
 * Select a human-readable DM detail row for a participant. Unlike the normal DM
 * list this preserves soft-deleted agent peers so historical search/permalink
 * navigation can still open the conversation without resurrecting it in the
 * sidebar DM list.
 */
export async function getReadableDMChannelForUser(channelId: string, currentUserId: string): Promise<DMChannel | null> {
  const db = getDb();
  const [agentPeer] = await db
    .select({
      id: channels.id,
      name: channels.name,
      type: channels.type,
      description: channels.description,
      createdAt: channels.createdAt,
      peerId: channelAgents.agentId,
      peerName: sql<string>`COALESCE(${agents.name}, ${channels.name}, 'Agent')`,
      peerDisplayName: agents.displayName,
      peerDescription: agents.description,
      peerGravatarHash: sql<string | null>`null`,
      peerAvatarUrl: agents.avatarUrl,
    })
    .from(channels)
    .innerJoin(channelAgents, eq(channels.id, channelAgents.channelId))
    .leftJoin(agents, eq(channelAgents.agentId, agents.id))
    .innerJoin(channelHumans, and(
      eq(channels.id, channelHumans.channelId),
      eq(channelHumans.userId, currentUserId),
    ))
    .where(and(eq(channels.id, channelId), eq(channels.type, "dm")));
  if (agentPeer) return { ...agentPeer, peerType: "agent" as const };

  // Once mutable agent membership is gone, current membership shape is not
  // provenance: a deleted human-agent DM and a self-DM both look like one
  // human and zero agents. Only the durable identity may classify the row.
  const [identity] = await db
    .select({
      kind: dmChannelIdentities.kind,
      peerKey: dmChannelIdentities.peerKey,
    })
    .from(dmChannelIdentities)
    .innerJoin(channels, and(
      eq(channels.id, dmChannelIdentities.channelId),
      eq(channels.serverId, dmChannelIdentities.serverId),
    ))
    .innerJoin(channelHumans, and(
      eq(channels.id, channelHumans.channelId),
      eq(channelHumans.userId, currentUserId),
    ))
    .where(and(eq(channels.id, channelId), eq(channels.type, "dm")));
  if (!identity) return null;

  const participantIds = identity.peerKey.split(":");
  if (!participantIds.includes(currentUserId)) return null;
  if (identity.kind === "human_self") {
    return participantIds.length === 1 && participantIds[0] === currentUserId
      ? selectDMWithUserPeer(channelId, currentUserId, currentUserId)
      : null;
  }
  if (identity.kind === "human_human") {
    const peerUserId = participantIds.find((id) => id !== currentUserId);
    return participantIds.length === 2 && peerUserId
      ? selectDMWithUserPeer(channelId, currentUserId, peerUserId)
      : null;
  }
  if (identity.kind !== "human_agent" || participantIds.length !== 2) return null;

  const agentId = participantIds.find((id) => id !== currentUserId);
  if (!agentId) return null;
  const [deletedAgentPeer] = await db
    .select({
      id: channels.id,
      name: channels.name,
      type: channels.type,
      description: channels.description,
      createdAt: channels.createdAt,
      peerId: agents.id,
      peerName: agents.name,
      peerDisplayName: agents.displayName,
      peerDescription: agents.description,
      peerGravatarHash: sql<string | null>`null`,
      peerAvatarUrl: agents.avatarUrl,
    })
    .from(channels)
    .innerJoin(agents, and(eq(agents.id, agentId), eq(agents.serverId, channels.serverId)))
    .where(and(eq(channels.id, channelId), eq(channels.type, "dm")));
  return deletedAgentPeer ? { ...deletedAgentPeer, peerType: "agent" as const } : null;
}

/**
 * Select a DM channel with its peer info (user-DM, peer = the other user).
 */
async function selectDMWithUserPeer(
  channelId: string,
  currentUserId: string,
  identityPeerId?: string,
): Promise<DMChannel | null> {
  const db = getDb();

  // Direct-read callers pass the durable identity peer. Find/create callers
  // have just established exact membership and may resolve from that shape.
  let otherUserId = identityPeerId;
  if (!otherUserId) {
    const allHumans = await db
      .select({ userId: channelHumans.userId })
      .from(channelHumans)
      .where(eq(channelHumans.channelId, channelId));
    otherUserId = allHumans.find(h => h.userId !== currentUserId)?.userId ?? currentUserId;
  }
  if (!otherUserId) return null;

  const [peer] = await db
    .select({ id: users.id, name: users.name, displayName: users.displayName, description: users.description, email: users.email, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, otherUserId));
  if (!peer) return null;

  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch) return null;

  return {
    id: ch.id,
    name: ch.name,
    type: ch.type,
    description: ch.description,
    createdAt: ch.createdAt,
    peerType: "user",
    peerId: peer.id,
    peerName: peer.name,
    peerDisplayName: peer.displayName,
    peerDescription: peer.description,
    peerAvatarUrl: peer.avatarUrl,
    peerGravatarHash: createHash("sha256").update(peer.email.trim().toLowerCase()).digest("hex"),
  };
}

/**
 * Find or create a DM channel between a user and an agent.
 * Returns unified peer format.
 */
export async function findOrCreateDM(serverId: string, userId: string, agentId: string): Promise<DMChannel | null> {
  const identityKind: DmIdentityKind = "human_agent";
  const identityKey = dmIdentityKey([userId, agentId]);
  const dmChannelId = await withServerResourceLock(
    serverId,
    DM_LOCK_NAMESPACE,
    dmPairKey("human-agent", [userId, agentId]),
    async (tx) => {
      const [agent] = await tx
        .select({ id: agents.id, name: agents.name, displayName: agents.displayName })
        .from(agents)
        .where(and(
          eq(agents.id, agentId),
          eq(agents.serverId, serverId),
          isNull(agents.deletedAt),
        ));
      if (!agent) return null;

      const [identified] = await tx
        .select({ id: channels.id, deletedAt: channels.deletedAt })
        .from(dmChannelIdentities)
        .innerJoin(channels, eq(channels.id, dmChannelIdentities.channelId))
        .where(and(
          eq(dmChannelIdentities.serverId, serverId),
          eq(channels.type, "dm"),
          eq(dmChannelIdentities.kind, identityKind),
          eq(dmChannelIdentities.peerKey, identityKey),
        ))
        .orderBy(sql`${channels.deletedAt} ASC NULLS FIRST`, asc(channels.createdAt), asc(channels.id))
        .limit(1);

      if (identified) {
        if (identified.deletedAt) {
          await tx.update(channels).set({ deletedAt: null }).where(eq(channels.id, identified.id));
        }
        return identified.id;
      }

      // Legacy fallback: while both membership rows still exist, the exact
      // one-human/one-agent shape is sufficient to adopt and stamp. Once an
      // agent deletion removes channel_agents this path can no longer match,
      // which prevents the tombstone from being reclassified as a self-DM.
      const [existing] = await tx
        .select({ id: channels.id, deletedAt: channels.deletedAt })
        .from(channels)
        .innerJoin(channelAgents, eq(channels.id, channelAgents.channelId))
        .innerJoin(channelHumans, eq(channels.id, channelHumans.channelId))
        .where(and(
          eq(channels.serverId, serverId),
          eq(channels.type, "dm"),
          eq(channelAgents.agentId, agentId),
          eq(channelHumans.userId, userId),
          sql`(SELECT count(*) FROM channel_humans WHERE channel_id = ${channels.id}) = 1`,
          sql`(SELECT count(*) FROM channel_agents WHERE channel_id = ${channels.id}) = 1`,
        ));

      if (existing) {
        await tx.insert(dmChannelIdentities).values({
          channelId: existing.id,
          serverId,
          kind: identityKind,
          peerKey: identityKey,
        });
        await tx.update(channels).set({ deletedAt: null }).where(eq(channels.id, existing.id));
        return existing.id;
      }

      // DM channel name = unique name (identity); display name resolved at read time.
      const dmName = agent.name || "Agent";
      const [dmChannel] = await tx.insert(channels).values({
        serverId,
        name: dmName,
        type: "dm",
      }).returning();

      await tx.insert(dmChannelIdentities).values({
        channelId: dmChannel.id,
        serverId,
        kind: identityKind,
        peerKey: identityKey,
      });
      await tx.insert(channelAgents).values({ channelId: dmChannel.id, agentId });
      await tx.insert(channelHumans).values({ channelId: dmChannel.id, userId });
      return dmChannel.id;
    },
  );

  return dmChannelId ? selectDMWithAgentPeer(dmChannelId) : null;
}

/**
 * Find or create a DM channel between two users (human-to-human DM).
 * Returns unified peer format (peer = the other user).
 */
export async function findOrCreateUserDM(
  serverId: string,
  userId1: string,
  userId2: string,
  opts: { hidePassivePeerOnCreate?: boolean } = {},
): Promise<DMChannel | null> {
  const isSelf = userId1 === userId2;

  if (isSelf) {
    const identityKind: DmIdentityKind = "human_self";
    const identityKey = dmIdentityKey([userId1]);
    const dmChannelId = await withServerResourceLock(
      serverId,
      DM_LOCK_NAMESPACE,
      dmPairKey("user-user", [userId1]),
      async (tx) => {
        // Self-DM lookup is deliberately provenance-only. A legacy singleton
        // membership shape is ambiguous because deleting an agent leaves its
        // human-agent DM with exactly one human and no channel_agents row.
        const [existing] = await tx
          .select({ id: channels.id, deletedAt: channels.deletedAt })
          .from(dmChannelIdentities)
          .innerJoin(channels, eq(channels.id, dmChannelIdentities.channelId))
          .where(and(
            eq(dmChannelIdentities.serverId, serverId),
            eq(channels.type, "dm"),
            eq(dmChannelIdentities.kind, identityKind),
            eq(dmChannelIdentities.peerKey, identityKey),
          ))
          .orderBy(sql`${channels.deletedAt} ASC NULLS FIRST`, asc(channels.createdAt), asc(channels.id))
          .limit(1);

        if (existing) {
          if (existing.deletedAt) {
            await tx.update(channels).set({ deletedAt: null }).where(eq(channels.id, existing.id));
          }
          return existing.id;
        }

        const [selfUser] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId1));
        const [dmChannel] = await tx.insert(channels).values({
          serverId,
          name: selfUser?.name || "User",
          type: "dm",
        }).returning();

        await tx.insert(dmChannelIdentities).values({
          channelId: dmChannel.id,
          serverId,
          kind: identityKind,
          peerKey: identityKey,
        });
        await tx.insert(channelHumans).values({ channelId: dmChannel.id, userId: userId1 });
        return dmChannel.id;
      },
    );
    return selectDMWithUserPeer(dmChannelId, userId1);
  }

  const identityKind: DmIdentityKind = "human_human";
  const identityKey = dmIdentityKey([userId1, userId2]);
  const dmChannelId = await withServerResourceLock(
    serverId,
    DM_LOCK_NAMESPACE,
    dmPairKey("user-user", [userId1, userId2]),
    async (tx) => {
      const cm2 = alias(channelHumans, "cm2");

      const [identified] = await tx
        .select({ id: channels.id, deletedAt: channels.deletedAt })
        .from(dmChannelIdentities)
        .innerJoin(channels, eq(channels.id, dmChannelIdentities.channelId))
        .where(and(
          eq(dmChannelIdentities.serverId, serverId),
          eq(channels.type, "dm"),
          eq(dmChannelIdentities.kind, identityKind),
          eq(dmChannelIdentities.peerKey, identityKey),
        ))
        .orderBy(sql`${channels.deletedAt} ASC NULLS FIRST`, asc(channels.createdAt), asc(channels.id))
        .limit(1);

      if (identified) {
        if (identified.deletedAt) {
          await tx.update(channels).set({ deletedAt: null }).where(eq(channels.id, identified.id));
        }
        return identified.id;
      }

      // Legacy exact-shape fallback, stamped on first safe reuse.
      const existing = await tx
        .select({ id: channels.id, deletedAt: channels.deletedAt })
        .from(channels)
        .innerJoin(channelHumans, and(eq(channels.id, channelHumans.channelId), eq(channelHumans.userId, userId1)))
        .innerJoin(cm2, and(eq(channels.id, cm2.channelId), eq(cm2.userId, userId2)))
        .leftJoin(channelAgents, eq(channels.id, channelAgents.channelId))
        .where(and(
          eq(channels.serverId, serverId),
          eq(channels.type, "dm"),
          isNull(channelAgents.agentId), // No agent = user-DM
          sql`(SELECT count(*) FROM channel_humans WHERE channel_id = ${channels.id}) = 2`,
        ));

      if (existing.length > 0) {
        const dm = existing[0];
        await tx.insert(dmChannelIdentities).values({
          channelId: dm.id,
          serverId,
          kind: identityKind,
          peerKey: identityKey,
        });
        await tx.update(channels).set({ deletedAt: null }).where(eq(channels.id, dm.id));
        return dm.id;
      }

      // DM channel name = unique name (identity); display name resolved at read time.
      const [otherUser] = await tx
        .select({ name: users.name, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, userId2));
      const dmName = otherUser?.name || "User";
      const [dmChannel] = await tx.insert(channels).values({
        serverId,
        name: dmName,
        type: "dm",
      }).returning();

      await tx.insert(dmChannelIdentities).values({
        channelId: dmChannel.id,
        serverId,
        kind: identityKind,
        peerKey: identityKey,
      });
      await tx.insert(channelHumans).values([
        { channelId: dmChannel.id, userId: userId1 },
        { channelId: dmChannel.id, userId: userId2 },
      ]);

      if (opts.hidePassivePeerOnCreate) {
        await tx
          .update(serverMembers)
          .set({
            hiddenDmIds: sql`(
              SELECT COALESCE(json_agg(id), '[]'::json)
              FROM (
                SELECT id
                FROM json_array_elements_text(COALESCE(${serverMembers.hiddenDmIds}, '[]'::json)) existing(id)
                UNION
                SELECT ${dmChannel.id}
              ) merged
            )`,
          })
          .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId2)));
      }

      return dmChannel.id;
    },
  );

  return selectDMWithUserPeer(dmChannelId, userId1);
}

/**
 * Find or create a DM channel between two agents (agent-to-agent DM).
 * Both agents are stored in channelAgents; no human membership is written.
 */
export async function findOrCreateAgentDM(serverId: string, agentId1: string, agentId2: string): Promise<DMChannel | null> {
  if (agentId1 === agentId2) {
    throw new Error("Cannot create a DM with yourself");
  }

  const identityKind: DmIdentityKind = "agent_agent";
  const identityKey = dmIdentityKey([agentId1, agentId2]);
  const dmChannelId = await withServerResourceLock(
    serverId,
    DM_LOCK_NAMESPACE,
    dmPairKey("agent-agent", [agentId1, agentId2]),
    async (tx) => {
      const [agent2] = await tx
        .select({ id: agents.id, name: agents.name, displayName: agents.displayName, avatarUrl: agents.avatarUrl })
        .from(agents)
        .where(and(eq(agents.id, agentId2), eq(agents.serverId, serverId), isNull(agents.deletedAt)));
      if (!agent2) return null;

      const ca2 = alias(channelAgents, "ca2");

      const [identified] = await tx
        .select({ id: channels.id, deletedAt: channels.deletedAt })
        .from(dmChannelIdentities)
        .innerJoin(channels, eq(channels.id, dmChannelIdentities.channelId))
        .where(and(
          eq(dmChannelIdentities.serverId, serverId),
          eq(channels.type, "dm"),
          eq(dmChannelIdentities.kind, identityKind),
          eq(dmChannelIdentities.peerKey, identityKey),
        ))
        .orderBy(sql`${channels.deletedAt} ASC NULLS FIRST`, asc(channels.createdAt), asc(channels.id))
        .limit(1);

      if (identified) {
        if (identified.deletedAt) {
          await tx.update(channels).set({ deletedAt: null }).where(eq(channels.id, identified.id));
        }
        return identified.id;
      }

      const existing = await tx
        .select({ id: channels.id, deletedAt: channels.deletedAt })
        .from(channels)
        .innerJoin(channelAgents, and(eq(channels.id, channelAgents.channelId), eq(channelAgents.agentId, agentId1)))
        .innerJoin(ca2, and(eq(channels.id, ca2.channelId), eq(ca2.agentId, agentId2)))
        .leftJoin(channelHumans, eq(channels.id, channelHumans.channelId))
        .where(and(
          eq(channels.serverId, serverId),
          eq(channels.type, "dm"),
          isNull(channelHumans.userId),
          sql`(SELECT count(*) FROM channel_agents WHERE channel_id = ${channels.id}) = 2`,
        ));

      if (existing.length > 0) {
        const dm = existing[0];
        await tx.insert(dmChannelIdentities).values({
          channelId: dm.id,
          serverId,
          kind: identityKind,
          peerKey: identityKey,
        });
        await tx.update(channels).set({ deletedAt: null }).where(eq(channels.id, dm.id));
        return dm.id;
      }

      const dmName = agent2.name || "Agent";
      const [dmChannel] = await tx.insert(channels).values({
        serverId,
        name: dmName,
        type: "dm",
      }).returning();

      await tx.insert(dmChannelIdentities).values({
        channelId: dmChannel.id,
        serverId,
        kind: identityKind,
        peerKey: identityKey,
      });
      await tx.insert(channelAgents).values([
        { channelId: dmChannel.id, agentId: agentId1 },
        { channelId: dmChannel.id, agentId: agentId2 },
      ]);

      return dmChannel.id;
    },
  );

  return dmChannelId ? selectDMWithAgentPeer(dmChannelId) : null;
}

/**
 * List all DM channels for a user — both agent-DMs and user-DMs.
 * Returns unified peer format.
 */
export async function listDMChannels(
  serverId: string,
  userId: string,
  opts?: DMChannelListOptions,
): Promise<DMChannel[]> {
  const db = getDb();
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;
  const serverRole = await resolveHumanServerRole(serverId, userId);
  if (serverRole === "guest" && !await isGuestFeatureEnabled(serverId, userId)) return [];

  // Query 1: Agent-DMs (channel has entry in channelAgents)
  const agentDMs = await traceQuery(
    "dm_channels.agent_dms_by_user",
    () => db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type,
        description: channels.description,
        createdAt: channels.createdAt,
        peerId: agents.id,
        peerName: agents.name,
        peerDisplayName: agents.displayName,
        peerDescription: agents.description,
        peerGravatarHash: sql<string | null>`null`,
        peerAvatarUrl: agents.avatarUrl,
      })
      .from(channels)
      .innerJoin(channelAgents, eq(channels.id, channelAgents.channelId))
      .innerJoin(agents, eq(channelAgents.agentId, agents.id))
      .innerJoin(channelHumans, eq(channels.id, channelHumans.channelId))
      .where(and(
        eq(channels.serverId, serverId),
        eq(channels.type, "dm"),
        eq(channelHumans.userId, userId),
        isNull(channels.deletedAt),
        isNull(agents.deletedAt),
      )),
  );

  // Query 2: User-DMs (channel has NO entry in channelAgents, peer = other user)
  const otherHuman = alias(channelHumans, "other_human");
  const userDMRows = await traceQuery(
    "dm_channels.user_dms_by_user",
    () => db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type,
        description: channels.description,
        createdAt: channels.createdAt,
        peerId: users.id,
        peerName: users.name,
        peerDisplayName: users.displayName,
        peerDescription: users.description,
        peerEmail: users.email,
        peerAvatarUrl: users.avatarUrl,
      })
      .from(channels)
      .innerJoin(channelHumans, and(eq(channels.id, channelHumans.channelId), eq(channelHumans.userId, userId)))
      .innerJoin(otherHuman, and(eq(channels.id, otherHuman.channelId)))
      .innerJoin(users, eq(otherHuman.userId, users.id))
      .leftJoin(channelAgents, eq(channels.id, channelAgents.channelId))
      .where(and(
        eq(channels.serverId, serverId),
        eq(channels.type, "dm"),
        isNull(channels.deletedAt),
        isNull(channelAgents.agentId), // No agent = user-DM
        // other_human must not be current user
      )),
  );
  const userDMs = userDMRows
    .filter(r => r.peerId !== userId)
    .map(({ peerEmail, ...row }) => ({
      ...row,
      peerGravatarHash: createHash("sha256").update(peerEmail.trim().toLowerCase()).digest("hex"),
    }));

  // Query 3: Self-DMs. Mutable membership shape is ambiguous after agent
  // deletion, so explicit human_self provenance is the load-bearing filter.
  const selfDMRows = await traceQuery(
    "dm_channels.self_dms_by_user",
    () => db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type,
        description: channels.description,
        createdAt: channels.createdAt,
        peerId: users.id,
        peerName: users.name,
        peerDisplayName: users.displayName,
        peerDescription: users.description,
        peerEmail: users.email,
        peerAvatarUrl: users.avatarUrl,
      })
      .from(channels)
      .innerJoin(dmChannelIdentities, and(
        eq(channels.id, dmChannelIdentities.channelId),
        eq(dmChannelIdentities.serverId, serverId),
        eq(dmChannelIdentities.kind, "human_self"),
        eq(dmChannelIdentities.peerKey, userId),
      ))
      .innerJoin(channelHumans, and(eq(channels.id, channelHumans.channelId), eq(channelHumans.userId, userId)))
      .innerJoin(users, eq(users.id, channelHumans.userId))
      .leftJoin(channelAgents, eq(channels.id, channelAgents.channelId))
      .where(and(
        eq(channels.serverId, serverId),
        eq(channels.type, "dm"),
        isNull(channels.deletedAt),
        isNull(channelAgents.agentId),
        sql`(SELECT count(*) FROM channel_humans WHERE channel_id = ${channels.id}) = 1`,
      )),
  );
  const selfDMs = selfDMRows.map(({ peerEmail, ...row }) => ({
    ...row,
    peerGravatarHash: createHash("sha256").update(peerEmail.trim().toLowerCase()).digest("hex"),
  }));

  const allDMs: DMChannel[] = [
    ...agentDMs.map(dm => ({ ...dm, peerType: "agent" as const })),
    ...userDMs.map(dm => ({ ...dm, peerType: "user" as const })),
    ...selfDMs.map(dm => ({ ...dm, peerType: "user" as const })),
  ];

  // Sort by most recent message first, then by createdAt for DMs with no messages
  if (allDMs.length === 0) return allDMs;

  const humanActivityMuteEnabled = opts?.humanActivityMuteEnabled ?? await isHumanActivityMuteEnabled(serverId, userId);
  const allDmsWithMuteState = await attachActivityMuteState(allDMs, "user", userId, humanActivityMuteEnabled);
  const allDmsWithDisplayPrefs = await attachUserChannelDisplayPrefs(allDmsWithMuteState, userId);
  const allDmsWithLastMessageAt = await attachLastMessageAt(
    await attachReadState(allDmsWithDisplayPrefs, userId),
    traceQuery,
    "dm_channels.last_messages_by_channels",
    "dm_channels_count",
  );

  return allDmsWithLastMessageAt.sort((a, b) => {
    const aLast = a.lastMessageAt;
    const bLast = b.lastMessageAt;
    // DMs with messages come first, sorted by most recent
    if (aLast && bLast) return bLast.getTime() - aLast.getTime();
    if (aLast && !bLast) return -1;
    if (!aLast && bLast) return 1;
    // Both have no messages — sort by creation date ascending
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

/**
 * List DM channel ids the user still participates in, including soft-deleted
 * or peer-removed DMs. Used only for conversation-level sidebar state so stale
 * removed-peer rows can still be closed/pinned without resurrecting them in
 * the normal DM list.
 */
export async function listUserDMChannelIdsIncludingRemoved(
  serverId: string,
  userId: string,
  opts: { traceQuery?: DbQueryTracer } = {},
): Promise<string[]> {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const rows = await traceQuery(
    "dm_channels.removed_peer_dms_by_user",
    () => db
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(channelHumans, and(eq(channels.id, channelHumans.channelId), eq(channelHumans.userId, userId)))
      .where(and(
        eq(channels.serverId, serverId),
        eq(channels.type, "dm"),
      )),
  );
  return rows.map((row) => row.id);
}

export interface UserDMPinTarget {
  channelId: string;
  peerType: "human" | "agent";
  peerId: string;
}

/**
 * Resolve durable peer identities for DMs the user still participates in.
 * Unlike the ordinary DM directory, this intentionally includes removed human
 * members and deleted agents so conversation-level Pin/Unpin can keep working
 * without re-exposing those peers in Members/Agents directory responses.
 */
export async function listUserDMPinTargetsIncludingRemoved(
  serverId: string,
  userId: string,
  opts: { traceQuery?: DbQueryTracer } = {},
): Promise<UserDMPinTarget[]> {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const rows = await traceQuery(
    "dm_channels.pin_targets_including_removed",
    () => db
      .select({
        channelId: dmChannelIdentities.channelId,
        kind: dmChannelIdentities.kind,
        peerKey: dmChannelIdentities.peerKey,
      })
      .from(dmChannelIdentities)
      .innerJoin(channels, and(
        eq(channels.id, dmChannelIdentities.channelId),
        eq(channels.serverId, dmChannelIdentities.serverId),
      ))
      .innerJoin(channelHumans, and(
        eq(channelHumans.channelId, channels.id),
        eq(channelHumans.userId, userId),
      ))
      .where(and(
        eq(dmChannelIdentities.serverId, serverId),
        eq(channels.type, "dm"),
      )),
  );

  const targets: UserDMPinTarget[] = [];
  for (const row of rows) {
    const participantIds = row.peerKey.split(":");
    if (!participantIds.includes(userId)) continue;
    if (row.kind === "human_self") {
      if (participantIds.length === 1 && participantIds[0] === userId) {
        targets.push({ channelId: row.channelId, peerType: "human", peerId: userId });
      }
      continue;
    }
    if (participantIds.length !== 2) continue;
    const peerId = participantIds.find((id) => id !== userId);
    if (!peerId) continue;
    if (row.kind === "human_human") {
      targets.push({ channelId: row.channelId, peerType: "human", peerId });
    } else if (row.kind === "human_agent") {
      targets.push({ channelId: row.channelId, peerType: "agent", peerId });
    }
  }
  return targets;
}

export interface AgentConversationSummary {
  id: string;
  createdAt: Date;
  peerId: string;
  peerName: string;
  peerDisplayName: string | null;
  peerAvatarUrl: string | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
}

/**
 * List agent-to-agent DM channels for one agent.
 * Human DMs are explicitly excluded.
 */
export async function listAgentToAgentDMsForAgent(serverId: string, agentId: string): Promise<AgentConversationSummary[]> {
  const db = getDb();
  const otherAgentMembership = alias(channelAgents, "other_agent_membership");

  const rows = await db
    .select({
      id: channels.id,
      createdAt: channels.createdAt,
      peerId: agents.id,
      peerName: agents.name,
      peerDisplayName: agents.displayName,
      peerAvatarUrl: agents.avatarUrl,
    })
    .from(channels)
    .innerJoin(channelAgents, and(eq(channels.id, channelAgents.channelId), eq(channelAgents.agentId, agentId)))
    .innerJoin(otherAgentMembership, eq(channels.id, otherAgentMembership.channelId))
    .innerJoin(agents, eq(otherAgentMembership.agentId, agents.id))
    .leftJoin(channelHumans, eq(channels.id, channelHumans.channelId))
    .where(and(
      eq(channels.serverId, serverId),
      eq(channels.type, "dm"),
      isNull(channels.deletedAt),
      isNull(channelHumans.userId),
      isNull(agents.deletedAt),
      sql`${otherAgentMembership.agentId} <> ${agentId}`,
    ));

  if (rows.length === 0) return [];

  const lastMessages = await db
    .select({
      channelId: messages.channelId,
      content: messages.content,
      createdAt: messages.createdAt,
      messageType: messages.messageType,
    })
    .from(messages)
    .where(inArray(messages.channelId, rows.map((row) => row.id)))
    .orderBy(desc(messages.createdAt));

  const latestByChannel = new Map<string, { content: string; createdAt: Date }>();
  for (const message of lastMessages) {
    if (message.messageType === "system") continue;
    if (!latestByChannel.has(message.channelId)) {
      latestByChannel.set(message.channelId, { content: message.content, createdAt: message.createdAt });
    }
  }

  return rows
    .map((row) => {
      const latest = latestByChannel.get(row.id);
      return {
        id: row.id,
        createdAt: row.createdAt,
        peerId: row.peerId,
        peerName: row.peerName,
        peerDisplayName: row.peerDisplayName,
        peerAvatarUrl: row.peerAvatarUrl,
        lastMessageAt: latest?.createdAt ?? null,
        lastMessagePreview: latest?.content ?? null,
      };
    })
    .sort((a, b) => {
      const aTime = a.lastMessageAt?.getTime() ?? a.createdAt.getTime();
      const bTime = b.lastMessageAt?.getTime() ?? b.createdAt.getTime();
      return bTime - aTime;
    });
}



/**
 * Check if a human user can access (view) a channel within the active server.
 *
 * The `serverId` argument is mandatory and pins the check to the active server
 * in the request. This prevents cross-server IDOR: passing a channel/attachment
 * UUID from server B while authenticated against server A must always be
 * rejected, even when `canUserAccessChannel` is called from a route that uses
 * `requireFlexAuth` instead of `requireServer` (e.g. attachment downloads).
 *
 * Why: prior versions trusted middleware to constrain scope, but mounts like
 * `/api/attachments/:id` on the public router did not carry `req.serverId` for
 * user-auth paths. Callers must now assert the active server explicitly.
 * See #proj-security task #10 (2026-04-19).
 */
export async function canUserAccessChannel(
  channelId: string,
  userId: string,
  serverId: ServerId,
  opts?: { includeDeleted?: boolean },
): Promise<boolean> {
  const channel = await getChannel(channelId, opts);
  if (!channel) return false;

  // Cross-server guard: the channel must live in the caller's active server.
  if (channel.serverId !== serverId) return false;

  const serverRole = await resolveHumanServerRole(serverId, userId);
  if (serverRole === "guest") {
    if (channel.type === "thread") {
      const jointThread = await getJointThreadProjectionByLocalThread(channelId, serverId);
      if (jointThread) return false;
      if (!channel.parentMessageId) return false;
      const [parentMsg] = await getDb()
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, channel.parentMessageId));
      return parentMsg ? canUserAccessChannel(parentMsg.channelId, userId, serverId, opts) : false;
    }
    const isChannelMember = await isChannelHuman(channelId, userId);
    return canGuestReadChannel({
      gateEnabled: await isGuestFeatureEnabled(serverId, userId),
      serverRole,
      channelType: channel.type,
      channelName: channel.name,
      allChannelHidden: isAllSystemChannel(channel) && !isEnabledAllChannel(channel),
      guestVisible: channel.guestVisible,
      guestJoinable: channel.guestJoinable,
      isChannelMember,
      archived: channel.archivedAt !== null,
      deleted: channel.deletedAt !== null,
    });
  }

  if (isAllSystemChannel(channel) && !isEnabledAllChannel(channel)) return false;

  // Public channels are viewable by all server humans.
  if (channel.type === "channel") return true;

  if (channel.type === "joint" && !await resolveChannelAccess({ serverId, channelId, includeDeleted: opts?.includeDeleted })) {
    return false;
  }

  if (channel.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, serverId);
    if (jointThread) {
      return canUserAccessChannel(jointThread.localParentChannelId, userId, serverId, opts);
    }
  }

  if (channel.type === "thread" && channel.parentMessageId) {
    const db2 = getDb();
    const [parentMsg] = await db2
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return false;
    return canUserAccessChannel(parentMsg.channelId, userId, serverId, opts);
  }

  // Human-facing DM reads are participant-scoped. Agent-to-agent DMs have no
  // human participant rows, so they are intentionally not readable through the
  // ordinary human channel/message/attachment routes; privileged human surfaces
  // expose them only as activity summaries through the agent detail API.
  const db = getDb();
  if (channel.type === "dm") {
    const humanParticipants = await db
      .select({ userId: channelHumans.userId })
      .from(channelHumans)
      .where(eq(channelHumans.channelId, channelId));
    return humanParticipants.some((participant) => participant.userId === userId);
  }

  // Private channels are invite-only, so human users need explicit membership.
  const [row] = await db
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId)));
  if (row) return true;

  return false;
}

/**
 * The CLOSED set of fields a residue-only read-all receipt may contain.
 *
 * Every entry is a value the caller already owns: their own read-state row's
 * version, and whether that row changed. Nothing here is derived from the
 * channel's present state.
 *
 * @Tenny's ruling (#proj-activity:b3ffd225, `4cfb516d`) made this a closed SET
 * rather than a ban on one field name. Asserting "the receipt has no maxReadSeq"
 * names one leak; asserting "the receipt's fields are a subset of THIS list"
 * makes the next channel-derived field added to ReadStateMutationResult fail
 * automatically instead of requiring someone to remember to forbid it.
 *
 * Why it matters here and not in the deleted-channel precedent: a deleted
 * channel's frontier is FROZEN, a live channel's is a SIGNAL. One call tells a
 * former member roughly what they already knew; polling it is an activity
 * monitor for a channel they can no longer see. A precedent may only be cited
 * together with the property that made it safe.
 */
export const RESIDUE_ONLY_READ_ALL_RECEIPT_FIELDS = ["ok", "readStateVersion", "changed"] as const;

export type ResidueOnlyReadAllReceipt = {
  ok: true;
  readStateVersion: number;
  changed: boolean;
};

/**
 * Build the receipt for a caller who retired their own residue without having
 * access to the channel. Constructed by naming each allowed field, so a field
 * cannot arrive here by being spread in from somewhere else.
 */
export function buildResidueOnlyReadAllReceipt(
  state: ReadStateMutationResult,
): ResidueOnlyReadAllReceipt {
  return {
    ok: true,
    readStateVersion: state.readStateVersion,
    changed: state.changed,
  };
}

/**
 * Does the SERVER'S OWN records show this user ever had a relationship with this
 * channel?
 *
 * This exists to answer one question and no other: when access is denied, may we
 * say "you do not have access" (which admits the channel exists), or must we say
 * "not found" (which admits nothing)?
 *
 * @Tenny's ruling, #proj-activity:b3ffd225 (`f0a31e7f`): the criterion is NOT
 * "always 404". It is that the response must not depend on whether the channel
 * exists *for a requester with no prior relationship to it*. Someone who was a
 * member, or still carries residue for it, ALREADY KNOWS it exists -- telling
 * them the truth discloses nothing, and they are precisely the population that
 * needs to clear stale Activity entries (the usability half of task #48).
 *
 * Why this cannot be turned into a probe: every row consulted is keyed by the
 * CALLER'S OWN id and written by the server, never by the request. A stranger
 * cannot manufacture one, so a stranger can never move themselves out of the
 * 404 branch.
 *
 * Note what is deliberately NOT consulted: current membership (`channelHumans`).
 * A current member has access and never reaches this call; an ex-member's row is
 * gone. Membership answers "can you", residue answers "did you ever" -- and only
 * the second is the question here.
 *
 * Fail-closed: any error answers "no prior relationship", i.e. falls to the 404
 * that discloses nothing. Per ruling ①, uncertainty tips toward non-disclosure.
 */
export async function hasPriorChannelRelationship(
  userId: string,
  channelId: string,
): Promise<boolean> {
  try {
    const db = getDb();
    // Ruling ① requires the witness be *cheap*, or the site must fall back to 404
    // rather than pay for the answer -- so the cost of each lookup is part of the
    // contract, not an implementation detail. The first two tables are PRIMARY
    // KEY (user_id, channel_id): one index hit each. The other two are noted at
    // their own call sites, because they are keyed differently and an
    // undifferentiated "all cheap" claim here was already wrong once.
    const [cursor] = await db
      .select({ userId: userChannelReadCursors.userId })
      .from(userChannelReadCursors)
      .where(and(
        eq(userChannelReadCursors.userId, userId),
        eq(userChannelReadCursors.channelId, channelId),
      ))
      .limit(1);
    if (cursor) return true;

    const [inboxState] = await db
      .select({ userId: userChannelInboxStates.userId })
      .from(userChannelInboxStates)
      .where(and(
        eq(userChannelInboxStates.userId, userId),
        eq(userChannelInboxStates.channelId, channelId),
      ))
      .limit(1);
    if (inboxState) return true;

    // @Tenny's follow-up caught the gap that made the first two insufficient:
    // "ever held a read cursor" is NOT the same as "still has residue". A former
    // member who never read anything has no cursor row, yet is exactly the person
    // with an Activity entry they cannot clear -- judging them a stranger would
    // leave the usability half of #48 broken while the leak half looked fixed.
    // So every receiver-owned residue table is a witness, not just the read side.
    // target_kind is included deliberately. This table's PK is
    // (receiver_type, receiver_id, target_kind, target_channel_id), so omitting
    // the kind leaves target_channel_id off the usable prefix and degrades to a
    // scan of every suppression row this user owns -- on the STRANGER path, the
    // one an enumerating attacker hammers, and the one that widens the timing
    // difference already recorded as a known gap. Naming all five kinds keeps it
    // to a bounded set of index probes and needs no migration. (@Tenny)
    const [suppression] = await db
      .select({ receiverId: inboxSuppressionStates.receiverId })
      .from(inboxSuppressionStates)
      .where(and(
        eq(inboxSuppressionStates.receiverType, "user"),
        eq(inboxSuppressionStates.receiverId, userId),
        inArray(inboxSuppressionStates.targetKind, [
          "channel",
          "dm",
          "followed_thread",
          "public_channel_mention",
          "public_thread_mention",
        ]),
        eq(inboxSuppressionStates.targetChannelId, channelId),
      ))
      .limit(1);
    if (suppression) return true;

    // Threads are channels, and four of the six call sites take an id that may be
    // one. A follow row survives losing access to the parent.
    const [follow] = await db
      .select({ followerId: threadFollows.followerId })
      .from(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, channelId),
        eq(threadFollows.followerType, "user"),
        eq(threadFollows.followerId, userId),
      ))
      .limit(1);
    return Boolean(follow);
  } catch (err) {
    console.error("[hasPriorChannelRelationship] lookup failed:", err);
    return false;
  }
}

/**
 * Add a human user to a channel (inserts into channelHumans).
 */
export async function addHuman(
  channelId: string,
  userId: string,
  options: ChannelServiceOptions & { role?: "member" | "admin" } = {},
) {
  const db = options.executor ?? getDb();
  const [channel] = await db
    .select({ id: channels.id, serverId: channels.serverId, name: channels.name, type: channels.type })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!channel) {
    throw new Error("Channel not found");
  }
  if (channel?.type === "thread") {
    throw new Error("Thread membership is managed via follow/unfollow, not channel_humans");
  }
  const [member] = await db
    .select({ userId: serverMembers.userId, role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, channel.serverId), eq(serverMembers.userId, userId)));
  if (!member) {
    throw new Error("Human is not a member of this channel's server");
  }
  if (member.role === "guest" && options.role === "admin") {
    throw new Error("Guest cannot be a channel admin");
  }
  if (isAllSystemChannel(channel)) {
    if (member.role === "guest") {
      throw new Error("Guest cannot be added to the #all channel");
    }
    return false;
  }
  const inserted = await db
    .insert(channelHumans)
    .values({ channelId, userId, role: options.role ?? "member" })
    .onConflictDoNothing()
    .returning({ userId: channelHumans.userId });
  return inserted.length > 0;
}

export async function addGuestHumanIfAllowed(
  channelId: string,
  userId: string,
): Promise<"joined" | "already_joined" | "forbidden"> {
  return getDb().transaction(async (tx) => {
    const [lockedChannel] = await tx.select().from(channels)
      .where(eq(channels.id, channelId))
      .for("update");
    if (!lockedChannel) return "forbidden";

    const [member] = await tx.select({ role: serverMembers.role })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, lockedChannel.serverId), eq(serverMembers.userId, userId)))
      .limit(1);
    if (member?.role !== "guest") return "forbidden";

    const [existing] = await tx.select({ userId: channelHumans.userId })
      .from(channelHumans)
      .where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId)))
      .for("update")
      .limit(1);
    if (existing) return "already_joined";

    const allowed = canGuestJoinChannel({
      gateEnabled: await isGuestFeatureEnabled(lockedChannel.serverId, userId, tx),
      serverRole: member.role,
      channelType: lockedChannel.type,
      channelName: lockedChannel.name,
      allChannelHidden: isAllSystemChannel(lockedChannel) && !isEnabledAllChannel(lockedChannel),
      guestVisible: lockedChannel.guestVisible,
      guestJoinable: lockedChannel.guestJoinable,
      isChannelMember: false,
      archived: lockedChannel.archivedAt !== null,
      deleted: lockedChannel.deletedAt !== null,
    });
    if (!allowed) return "forbidden";

    return await addHuman(channelId, userId, { executor: tx })
      ? "joined"
      : "already_joined";
  });
}

/**
 * Mention "add" on a thread mutates membership on the parent channel. Resolve
 * that authority object explicitly so capability checks and the write lock use
 * the same channel rather than treating a thread follow as channel membership.
 */
export async function getChannelMembershipAuthorityChannelId(
  channelId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<string | null> {
  const channel = await getChannel(channelId, { executor });
  if (!channel) return null;
  if (channel.type !== "thread") return channel.id;
  if (!channel.parentMessageId) return null;
  const [parentMessage] = await executor
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, channel.parentMessageId))
    .limit(1);
  return parentMessage?.channelId ?? null;
}

export type ChannelMembershipActorType = "user" | "agent";

export class ChannelMembershipRoleMutationError extends Error {
  constructor(
    public readonly code:
      | "channel_not_found"
      | "channel_capability_required"
      | "channel_archived"
      | "channel_admin_self_demote_forbidden"
      | "channel_member_required"
      | "channel_membership_conflict"
      | "guest_channel_admin_forbidden"
      | "unsupported_channel_shape"
      | "protected_server_role",
    message: string,
  ) {
    super(message);
    this.name = "ChannelMembershipRoleMutationError";
  }
}

/**
 * Human-only v1 writer for the stored channel role. Callers expose this through
 * the Web API only; there is deliberately no Agent API/CLI/action-card route.
 */
export async function changeChannelMembershipRole(input: {
  serverId: string;
  channelId: string;
  requesterUserId: string;
  targetType: ChannelMembershipActorType;
  targetId: string;
  nextRole: ChannelRole;
}) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: channels.id, serverId: channels.serverId, name: channels.name, type: channels.type, archivedAt: channels.archivedAt })
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.serverId, input.serverId), isNull(channels.deletedAt)))
      .for("update");
    if (!channel) {
      throw new ChannelMembershipRoleMutationError("channel_not_found", "Channel not found");
    }
    if ((channel.type !== "channel" && channel.type !== "private") || isAllSystemChannel(channel)) {
      throw new ChannelMembershipRoleMutationError("unsupported_channel_shape", "Channel roles are supported only for regular public or private channels");
    }
    if (channel.archivedAt) {
      throw new ChannelMembershipRoleMutationError("channel_archived", "This channel is archived");
    }

    // Channel row is always locked first. Membership rows are then locked in a
    // stable actor tuple order so promote/demote/remove races cannot deadlock.
    const lockOrder = [
      { type: "user" as const, id: input.requesterUserId },
      { type: input.targetType, id: input.targetId },
    ].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
    for (const actor of lockOrder) {
      if (actor.type === "user") {
        await tx.select({ id: channelHumans.userId })
          .from(channelHumans)
          .where(and(eq(channelHumans.channelId, input.channelId), eq(channelHumans.userId, actor.id)))
          .for("update");
      } else {
        await tx.select({ id: channelAgents.agentId })
          .from(channelAgents)
          .where(and(eq(channelAgents.channelId, input.channelId), eq(channelAgents.agentId, actor.id)))
          .for("update");
      }
    }

    const [requesterServer] = await tx.select({ role: serverMembers.role }).from(serverMembers).where(and(
      eq(serverMembers.serverId, input.serverId),
      eq(serverMembers.userId, input.requesterUserId),
    ));
    const [requesterMembership] = await tx.select({ role: channelHumans.role }).from(channelHumans).where(and(
      eq(channelHumans.channelId, input.channelId),
      eq(channelHumans.userId, input.requesterUserId),
    ));
    const requesterCanAccess = channel.type === "channel" || Boolean(requesterMembership);
    const requesterAllowed = requesterCanAccess && hasEffectiveChannelCapability({
      serverRole: requesterServer?.role ?? null,
      channelRole: requesterMembership?.role ?? null,
      isChannelMember: Boolean(requesterMembership),
      supportsChannelRoles: true,
      capability: "changeChannelMemberRoles",
    });
    if (!requesterAllowed) {
      throw new ChannelMembershipRoleMutationError("channel_capability_required", "You do not have permission to change channel member roles");
    }

    if (input.targetType === "user" && input.targetId === input.requesterUserId) {
      const code = input.nextRole === "member"
        ? "channel_admin_self_demote_forbidden"
        : "channel_membership_conflict";
      throw new ChannelMembershipRoleMutationError(code, "A channel admin cannot change their own channel role");
    }

    const targetMembership = input.targetType === "user"
      ? await tx.select({ role: channelHumans.role, authorityRevision: channelHumans.authorityRevision })
        .from(channelHumans)
        .where(and(eq(channelHumans.channelId, input.channelId), eq(channelHumans.userId, input.targetId)))
        .then((rows) => rows[0])
      : await tx.select({ role: channelAgents.role, authorityRevision: channelAgents.authorityRevision })
        .from(channelAgents)
        .where(and(eq(channelAgents.channelId, input.channelId), eq(channelAgents.agentId, input.targetId)))
        .then((rows) => rows[0]);
    if (!targetMembership) {
      throw new ChannelMembershipRoleMutationError("channel_member_required", "Target must already be a channel member");
    }

    const targetServerRole = input.targetType === "user"
      ? await tx.select({ role: serverMembers.role }).from(serverMembers).where(and(
        eq(serverMembers.serverId, input.serverId),
        eq(serverMembers.userId, input.targetId),
      )).then((rows) => rows[0]?.role ?? null)
      : await tx.select({ role: serverAgentMembers.role }).from(serverAgentMembers).where(and(
        eq(serverAgentMembers.serverId, input.serverId),
        eq(serverAgentMembers.agentId, input.targetId),
      )).then((rows) => rows[0]?.role ?? null);
    if (targetServerRole === "owner" || targetServerRole === "admin") {
      throw new ChannelMembershipRoleMutationError("protected_server_role", "Server owners and admins cannot be changed from channel role management");
    }
    if (targetServerRole === "guest" && input.nextRole === "admin") {
      throw new ChannelMembershipRoleMutationError(
        "guest_channel_admin_forbidden",
        "Guests cannot be promoted to channel admin",
      );
    }

    if (targetMembership.role === input.nextRole) {
      return {
        changed: false,
        channelId: input.channelId,
        targetType: input.targetType,
        targetId: input.targetId,
        channelRole: targetMembership.role,
        authorityRevision: targetMembership.authorityRevision,
        eventId: null,
      };
    }

    const authorityRevision = targetMembership.authorityRevision + 1;
    if (input.targetType === "user") {
      await tx.update(channelHumans).set({ role: input.nextRole, authorityRevision }).where(and(
        eq(channelHumans.channelId, input.channelId),
        eq(channelHumans.userId, input.targetId),
      ));
    } else {
      await tx.update(channelAgents).set({ role: input.nextRole, authorityRevision }).where(and(
        eq(channelAgents.channelId, input.channelId),
        eq(channelAgents.agentId, input.targetId),
      ));
    }
    const [event] = await tx.insert(channelMembershipRoleEvents).values({
      channelId: input.channelId,
      serverId: input.serverId,
      requesterUserId: input.requesterUserId,
      targetType: input.targetType,
      targetId: input.targetId,
      previousRole: targetMembership.role,
      nextRole: input.nextRole,
      authorityRevision,
    }).returning({ id: channelMembershipRoleEvents.id });

    return {
      changed: true,
      channelId: input.channelId,
      targetType: input.targetType,
      targetId: input.targetId,
      channelRole: input.nextRole,
      authorityRevision,
      eventId: event!.id,
    };
  });
}

export async function markChannelMembershipRoleEventDelivered(eventId: string) {
  await getDb().update(channelMembershipRoleEvents).set({
    deliveryStatus: "sent",
    deliveryAttempts: sql`${channelMembershipRoleEvents.deliveryAttempts} + 1`,
    deliveredAt: currentDate(),
    lastDeliveryError: null,
  }).where(eq(channelMembershipRoleEvents.id, eventId));
}

/** Remove a human from a channel. #all never has explicit human membership. */
export async function removeHuman(channelId: string, userId: string, executor?: DatabaseExecutor) {
  const db = executor ?? getDb();
  const channel = await getChannel(channelId, { executor: db });
  if (channel?.type === "thread") {
    throw new Error("Thread membership is managed via follow/unfollow, not channel_humans");
  }
  if (channel && isAllSystemChannel(channel)) {
    throw new Error("Cannot leave or remove from the #all channel");
  }
  await db.delete(channelHumans).where(
    and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId))
  );
  await deletePrivateChannelIfEmpty(channelId, db);
  // Executor callers own the surrounding transaction and invalidate after its
  // commit. A reconnect before commit could otherwise recover the old rooms.
  if (!executor) await revokeSocketAccess({ userId });
}

/**
 * Get humans in a channel.
 */
async function getChannelHumansRaw(channelId: string) {
  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      serverId: channels.serverId,
      serverName: servers.name,
      serverSlug: servers.slug,
      name: users.name,
      displayName: users.displayName,
      description: users.description,
      avatarUrl: users.avatarUrl,
      email: users.email,
      role: serverMembers.role,
      serverRole: serverMembers.role,
      channelRole: channelHumans.role,
    })
    .from(channelHumans)
    .innerJoin(channels, eq(channelHumans.channelId, channels.id))
    .innerJoin(servers, eq(servers.id, channels.serverId))
    .innerJoin(users, eq(channelHumans.userId, users.id))
    .innerJoin(serverMembers, and(
      eq(serverMembers.serverId, channels.serverId),
      eq(serverMembers.userId, users.id),
    ))
    .where(eq(channelHumans.channelId, channelId))
    .orderBy(asc(channelHumans.joinedAt));

  return rows.map(({ email, ...rest }) => ({
    ...rest,
    gravatarHash: createHash("sha256").update(email.trim().toLowerCase()).digest("hex"),
  }));
}

/**
 * The non-Guest human audience of a server. This is the effective human
 * membership of an enabled virtual `#all` channel. Guest visibility is a
 * separate read-only policy and never grants roster or delivery membership.
 */
async function getServerAudienceHumans(serverId: string) {
  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      serverId: serverMembers.serverId,
      serverName: servers.name,
      serverSlug: servers.slug,
      name: users.name,
      displayName: users.displayName,
      description: users.description,
      avatarUrl: users.avatarUrl,
      email: users.email,
      role: serverMembers.role,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .innerJoin(users, eq(serverMembers.userId, users.id))
    .where(and(eq(serverMembers.serverId, serverId), ne(serverMembers.role, "guest")))
    .orderBy(asc(serverMembers.joinedAt));

  return rows.map(({ email, ...rest }) => ({
    ...rest,
    gravatarHash: createHash("sha256").update(email.trim().toLowerCase()).digest("hex"),
  }));
}

/**
 * Human membership of a channel. For an enabled virtual `#all` channel this is
 * the non-Guest server human audience (single source of truth shared with
 * getChannelMembers / getVirtualAllChannelMembers), so push/unread targeting and
 * the member-list API match the pre-virtualization behavior. All other channels
 * read their explicit `channel_humans` rows.
 */
export async function getChannelHumans(channelId: string) {
  const channel = await getChannel(channelId);
  if (channel && isEnabledAllChannel(channel)) {
    return getServerAudienceHumans(channel.serverId);
  }
  return getChannelHumansRaw(channelId);
}

async function getVirtualAllChannelMembers(serverId: string) {
  const [agentList, humanList] = await Promise.all([
    getServerAudienceAgents(serverId),
    getServerAudienceHumans(serverId),
  ]);
  return { agents: agentList, humans: humanList };
}

/**
 * Current external conversation participants for display in the channel
 * participant panel. They remain projections, never Raft users/agents or
 * membership authority. Provider actor IDs are deliberately not returned.
 */
export async function getChannelExternalMembers(
  channelId: string,
  now: Date = currentDate(),
): Promise<ChannelExternalMember[]> {
  const db = getDb();
  const rows = await db.select({
    id: externalActorProjections.id,
    provider: externalActorProjections.provider,
    displayName: externalActorProjections.displayName,
    handles: externalActorProjections.handles,
    actorKind: externalActorProjections.actorKind,
    avatarUrl: externalProjectionAvatarArtifacts.publicUrl,
  }).from(externalAddressabilityProjections)
    .innerJoin(
      externalActorProjections,
      eq(externalActorProjections.id, externalAddressabilityProjections.projectionId),
    )
    .innerJoin(
      externalChannelBindings,
      and(
        sql`${externalChannelBindings.id}::text = ${externalAddressabilityProjections.bindingId}`,
        eq(externalChannelBindings.bindingEpoch, externalAddressabilityProjections.bindingEpoch),
        eq(externalChannelBindings.providerConversationId, externalAddressabilityProjections.conversationId),
      ),
    )
    .leftJoin(
      externalProjectionAvatarArtifacts,
      and(
        eq(externalProjectionAvatarArtifacts.id, externalActorProjections.avatarArtifactId),
        eq(externalProjectionAvatarArtifacts.state, "active"),
      ),
    )
    .where(and(
      eq(externalChannelBindings.channelId, channelId),
      eq(externalChannelBindings.state, "active"),
      eq(externalAddressabilityProjections.state, "active"),
      gt(externalAddressabilityProjections.expiresAt, now),
      eq(externalActorProjections.state, "active"),
      eq(externalActorProjections.deactivated, false),
      eq(externalActorProjections.provider, "slack"),
      eq(externalAddressabilityProjections.provider, externalActorProjections.provider),
    ))
    .orderBy(asc(externalActorProjections.displayName), asc(externalActorProjections.id));

  const unique = new Map<string, ChannelExternalMember>();
  for (const row of rows) {
    if (row.provider !== "slack" || unique.has(row.id)) continue;
    unique.set(row.id, {
      id: row.id,
      provider: row.provider,
      displayName: row.displayName,
      handles: row.handles,
      actorKind: row.actorKind,
      avatarUrl: row.avatarUrl,
    });
  }
  return [...unique.values()];
}

/**
 * Members = join/post authority (see thread contract in schema.ts).
 * Regular channels: read channel_humans + channel_agents directly.
 * Thread channels:  delegate to the parent channel/DM's members.
 * For "who gets notified" use getThreadFollowers instead.
 * For enabled #all channels, derive members from the server audience.
 */
export async function getChannelMembers(channelId: string) {
  const channel = await getChannel(channelId);

  // Threads delegate join/membership to their parent channel (or DM).
  // Followers of a thread are exposed separately via getThreadFollowers.
  if (channel?.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    if (jointThread) {
      return getChannelMembers(jointThread.localParentChannelId);
    }
  }

  if (channel?.type === "thread" && channel.parentMessageId) {
    const db2 = getDb();
    const [parentMsg] = await db2
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return { agents: [], humans: [] };
    return getChannelMembers(parentMsg.channelId);
  }

  if (channel && isEnabledAllChannel(channel)) {
    return getVirtualAllChannelMembers(channel.serverId);
  }

  if (channel?.type === "joint") {
    const db = getDb();
    const [projection] = await db
      .select({ jointChannelId: jointChannelServers.jointChannelId })
      .from(jointChannelServers)
      .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
      .where(and(
        eq(jointChannelServers.localChannelId, channelId),
        eq(jointChannelServers.status, "active"),
        eq(jointChannels.status, "active"),
      ));
    if (projection) {
      const projections = await db
        .select({ localChannelId: jointChannelServers.localChannelId })
        .from(jointChannelServers)
        .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
        .where(and(
          eq(jointChannelServers.jointChannelId, projection.jointChannelId),
          eq(jointChannelServers.status, "active"),
          isNull(channels.deletedAt),
        ));
      // The same person can belong to more than one server in a joint channel.
      // Merge peer projections first so the projection being viewed always owns
      // the final role and server metadata for duplicate identities.
      const orderedProjections = [
        ...projections.filter((row) => row.localChannelId !== channelId),
        ...projections.filter((row) => row.localChannelId === channelId),
      ];
      const agentsById = new Map<string, Awaited<ReturnType<typeof getChannelAgentsRaw>>[number]>();
      const humansById = new Map<string, Awaited<ReturnType<typeof getChannelHumansRaw>>[number]>();
      for (const row of orderedProjections) {
        for (const agent of await getChannelAgentsRaw(row.localChannelId)) {
          agentsById.set(agent.id, agent);
        }
        for (const human of await getChannelHumansRaw(row.localChannelId)) {
          humansById.set(human.id, human);
        }
      }
      return { agents: [...agentsById.values()], humans: [...humansById.values()] };
    }
  }

  const agentList = await getChannelAgentsRaw(channelId);
  const humanList = await getChannelHumansRaw(channelId);

  return { agents: agentList, humans: humanList };
}

/**
 * Followers = attention/notification authority (see thread contract in
 * schema.ts). Reads thread_follows and is the source of truth for
 * notifications, unread, done, and follow/unfollow. Never use this to decide
 * whether someone may post — that is governed by getChannelMembers and
 * canUserPostToChannel / canAgentPostToChannel.
 */
export async function getThreadFollowers(threadChannelId: string) {
  const db = getDb();

  const agentList = await db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      status: agents.status,
      avatarUrl: agents.avatarUrl,
    })
    .from(threadFollows)
    .innerJoin(agents, eq(agents.id, threadFollows.followerId))
    .where(and(
      eq(threadFollows.threadChannelId, threadChannelId),
      eq(threadFollows.followerType, "agent"),
      isNull(threadFollows.unfollowedAt),
      isNull(agents.deletedAt),
    ))
    .orderBy(asc(threadFollows.createdAt));

  const humanRows = await db
    .select({
      id: users.id,
      name: users.name,
      displayName: users.displayName,
      description: users.description,
      avatarUrl: users.avatarUrl,
      email: users.email,
    })
    .from(threadFollows)
    .innerJoin(users, eq(users.id, threadFollows.followerId))
    .where(and(
      eq(threadFollows.threadChannelId, threadChannelId),
      eq(threadFollows.followerType, "user"),
      isNull(threadFollows.unfollowedAt),
    ))
    .orderBy(asc(threadFollows.createdAt));

  const humanList = humanRows.map(({ email, ...rest }) => ({
    ...rest,
    gravatarHash: createHash("sha256").update(email.trim().toLowerCase()).digest("hex"),
  }));

  return { agents: agentList, humans: humanList };
}

export type ManagedThreadAgentFollower = {
  id: string;
  name: string;
  displayName: string | null;
  status: string;
  avatarUrl: string | null;
  serverId: string;
  serverName: string;
  serverSlug: string;
  threadChannelId: string;
};

export async function getManagedThreadFollowerAudienceThreadChannelIds(threadChannelId: string): Promise<string[]> {
  const jointThread = await getJointThreadProjectionByLocalThread(threadChannelId);
  if (!jointThread) return [threadChannelId];
  const projections = await getActiveJointThreadProjectionsByCanonicalThread(jointThread.canonicalThreadChannelId);
  return [...new Set(projections.map((projection) => projection.localThreadChannelId))];
}

/**
 * Management rosters are rendered from one local thread projection, but a
 * Joint Thread can have active follower rows on peer-server local projections.
 * Aggregate those rows for display while leaving write permission to the
 * caller-facing route.
 */
export async function getManagedThreadAgentFollowers(threadChannelId: string): Promise<ManagedThreadAgentFollower[]> {
  const threadChannelIds = await getManagedThreadFollowerAudienceThreadChannelIds(threadChannelId);
  if (threadChannelIds.length === 0) return [];

  const rows = await getDb()
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      status: agents.status,
      avatarUrl: agents.avatarUrl,
      serverId: servers.id,
      serverName: servers.name,
      serverSlug: servers.slug,
      threadChannelId: threadFollows.threadChannelId,
    })
    .from(threadFollows)
    .innerJoin(agents, eq(agents.id, threadFollows.followerId))
    .innerJoin(channels, and(
      eq(channels.id, threadFollows.threadChannelId),
      eq(channels.type, "thread"),
      isNull(channels.deletedAt),
    ))
    .innerJoin(servers, eq(servers.id, channels.serverId))
    .where(and(
      inArray(threadFollows.threadChannelId, threadChannelIds),
      eq(threadFollows.followerType, "agent"),
      isNull(threadFollows.unfollowedAt),
      isNull(agents.deletedAt),
    ))
    .orderBy(asc(threadFollows.createdAt));

  const agentsById = new Map<string, ManagedThreadAgentFollower>();
  for (const row of rows) agentsById.set(row.id, row);
  return [...agentsById.values()];
}

export type ManagedAgentThreadFollowerMutation = {
  changed: boolean;
  removalToken: string | null;
  activityEvent: {
    id: string;
    title: string;
    text: string;
    dedupeKey: string;
  } | null;
};

const THREAD_FOLLOWER_REMOVED_ACTIVITY_PREFIX = "thread_follower_management:removed:";
const THREAD_FOLLOWER_RESTORED_ACTIVITY_PREFIX = "thread_follower_management:restored:";

function threadFollowerActivityEntry(input: {
  title: string;
  text: string;
  eventId: string;
}): TrajectoryEntry {
  return {
    kind: "slock_action",
    title: input.title,
    text: input.text,
    producerFactId: input.eventId,
  };
}

function formatThreadFollowerRemovalText(input: {
  actorLabel: string;
  threadLabel: string;
}): string {
  return [
    `actor: ${input.actorLabel}`,
    `thread: ${input.threadLabel}`,
    "Ordinary thread updates stopped. Personal mentions and task assignments can still notify you. You can follow the thread again.",
  ].join("\n");
}

function formatThreadFollowerRestoreText(input: {
  actorLabel: string;
  threadLabel: string;
}): string {
  return [
    `actor: ${input.actorLabel}`,
    `thread: ${input.threadLabel}`,
    "Thread updates resumed because your follower entry was restored.",
  ].join("\n");
}

/**
 * Remove an Agent from a thread's attention roster and append the user-visible
 * receipt to the canonical Agent Activity log in the same transaction. The
 * `unfollowedAt` value is both the exact state transition and the public Undo
 * token; the Activity dedupe key derives from it, so request retries reuse one
 * durable action instead of minting a parallel audit/notification model.
 */
export async function removeManagedAgentThreadFollower(input: {
  threadChannelId: string;
  agentId: string;
  actorLabel: string;
  threadLabel: string;
  activity: AgentActivity;
  activityDetail: string;
}): Promise<ManagedAgentThreadFollowerMutation> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const removalPrefix = `${THREAD_FOLLOWER_REMOVED_ACTIVITY_PREFIX}${input.threadChannelId}:`;
    const [latestActivityEvent] = await tx
      .select({ createdAt: agentActivityEvents.createdAt })
      .from(agentActivityEvents)
      .where(eq(agentActivityEvents.agentId, input.agentId))
      .orderBy(desc(agentActivityEvents.createdAt))
      .limit(1);
    const now = currentDate();
    const removalToken = new Date(Math.max(
      now.getTime(),
      (latestActivityEvent?.createdAt.getTime() ?? Number.NEGATIVE_INFINITY) + 1,
    ));
    const [removed] = await tx
      .update(threadFollows)
      .set({ unfollowedAt: removalToken })
      .where(and(
        eq(threadFollows.threadChannelId, input.threadChannelId),
        eq(threadFollows.followerType, "agent"),
        eq(threadFollows.followerId, input.agentId),
        isNull(threadFollows.unfollowedAt),
      ))
      .returning({ threadChannelId: threadFollows.threadChannelId });
    if (!removed) {
      const [currentFollow] = await tx
        .select({ unfollowedAt: threadFollows.unfollowedAt })
        .from(threadFollows)
        .where(and(
          eq(threadFollows.threadChannelId, input.threadChannelId),
          eq(threadFollows.followerType, "agent"),
          eq(threadFollows.followerId, input.agentId),
          isNotNull(threadFollows.unfollowedAt),
        ))
        .limit(1);
      if (!currentFollow?.unfollowedAt) {
        return {
          changed: false,
          removalToken: null,
          activityEvent: null,
        };
      }
      const currentToken = currentFollow.unfollowedAt.toISOString();
      const currentDedupeKey = `${removalPrefix}${currentToken}`;
      const [existingActivity] = await tx
        .select({
          id: agentActivityEvents.id,
          entries: agentActivityEvents.entries,
          dedupeKey: agentActivityEvents.dedupeKey,
        })
        .from(agentActivityEvents)
        .where(and(
          eq(agentActivityEvents.agentId, input.agentId),
          eq(agentActivityEvents.dedupeKey, currentDedupeKey),
        ))
        .limit(1);
      const existingEntry = existingActivity?.entries.find((entry) => entry.kind === "slock_action");
      return existingActivity?.dedupeKey && existingEntry?.kind === "slock_action"
        ? {
            changed: false,
            removalToken: currentToken,
            activityEvent: {
              id: existingActivity.id,
              title: existingEntry.title,
              text: existingEntry.text,
              dedupeKey: existingActivity.dedupeKey,
            },
          }
        : { changed: false, removalToken: null, activityEvent: null };
    }

    const eventId = randomUUID();
    const token = removalToken.toISOString();
    const dedupeKey = `${removalPrefix}${token}`;
    const title = "Removed from thread followers";
    const text = formatThreadFollowerRemovalText(input);
    await tx.insert(agentActivityEvents).values({
      id: eventId,
      agentId: input.agentId,
      activity: input.activity,
      detail: input.activityDetail,
      entries: [threadFollowerActivityEntry({ title, text, eventId })],
      dedupeKey,
      createdAt: removalToken,
    });
    return {
      changed: true,
      removalToken: token,
      activityEvent: { id: eventId, title, text, dedupeKey },
    };
  });
}

/** Restore only the exact removal represented by `removalToken`. */
export async function restoreManagedAgentThreadFollower(input: {
  threadChannelId: string;
  agentId: string;
  actorLabel: string;
  threadLabel: string;
  activity: AgentActivity;
  activityDetail: string;
  removalToken: string;
}): Promise<ManagedAgentThreadFollowerMutation> {
  const parsedToken = new Date(input.removalToken);
  if (!Number.isFinite(parsedToken.getTime())) {
    return {
      changed: false,
      removalToken: null,
      activityEvent: null,
    };
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    const canonicalToken = parsedToken.toISOString();
    const removalDedupeKey = `${THREAD_FOLLOWER_REMOVED_ACTIVITY_PREFIX}${input.threadChannelId}:${canonicalToken}`;
    const [removalActivity] = await tx
      .select({ id: agentActivityEvents.id })
      .from(agentActivityEvents)
      .where(and(
        eq(agentActivityEvents.agentId, input.agentId),
        eq(agentActivityEvents.dedupeKey, removalDedupeKey),
      ))
      .limit(1);
    if (!removalActivity) {
      return { changed: false, removalToken: null, activityEvent: null };
    }

    const [restored] = await tx
      .update(threadFollows)
      .set({ unfollowedAt: null })
      .where(and(
        eq(threadFollows.threadChannelId, input.threadChannelId),
        eq(threadFollows.followerType, "agent"),
        eq(threadFollows.followerId, input.agentId),
        eq(threadFollows.unfollowedAt, parsedToken),
      ))
      .returning({ threadChannelId: threadFollows.threadChannelId });
    if (!restored) {
      return {
        changed: false,
        removalToken: null,
        activityEvent: null,
      };
    }

    const eventId = randomUUID();
    const dedupeKey = `${THREAD_FOLLOWER_RESTORED_ACTIVITY_PREFIX}${input.threadChannelId}:${canonicalToken}`;
    const title = "Restored to thread followers";
    const text = formatThreadFollowerRestoreText(input);
    const [latestActivityEvent] = await tx
      .select({ createdAt: agentActivityEvents.createdAt })
      .from(agentActivityEvents)
      .where(eq(agentActivityEvents.agentId, input.agentId))
      .orderBy(desc(agentActivityEvents.createdAt))
      .limit(1);
    const restoredAt = new Date(Math.max(
      currentDate().getTime(),
      parsedToken.getTime() + 1,
      (latestActivityEvent?.createdAt.getTime() ?? Number.NEGATIVE_INFINITY) + 1,
    ));
    await tx.insert(agentActivityEvents).values({
      id: eventId,
      agentId: input.agentId,
      activity: input.activity,
      detail: input.activityDetail,
      entries: [threadFollowerActivityEntry({ title, text, eventId })],
      dedupeKey,
      createdAt: restoredAt,
    });
    return {
      changed: true,
      removalToken: canonicalToken,
      activityEvent: { id: eventId, title, text, dedupeKey },
    };
  });
}

/**
 * Check if a human user is in a channel (in channelHumans).
 */
export async function isChannelHuman(
  channelId: string,
  userId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const db = executor;
  const [row] = await db
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId)));
  return !!row;
}

/**
 * Check if an agent is in a channel (in channelAgents).
 */
export async function isChannelAgent(
  channelId: string,
  agentId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const db = executor;
  const [row] = await db
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, agentId)));
  return !!row;
}

async function isServerHumanMember(serverId: string, userId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  return !!row;
}

async function isServerAgent(serverId: string, agentId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), eq(agents.id, agentId), isNull(agents.deletedAt)));
  return !!row;
}

/**
 * Check if an agent can access (view) a channel.
 * Public channels: all server agents can view.
 * Private, joint channels, and DMs: only participating agents can view.
 */
export async function canAgentAccessChannel(channelId: string, agentId: string): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (!channel) return false;

  if (isAllSystemChannel(channel) && !isEnabledAllChannel(channel)) return false;

  if (channel.type === "channel") return true;

  if (channel.type === "joint" && !await resolveChannelAccess({ serverId: channel.serverId, channelId })) {
    return false;
  }

  if (channel.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    if (jointThread) {
      return canAgentAccessChannel(jointThread.localParentChannelId, agentId);
    }
  }

  if (channel.type === "thread" && channel.parentMessageId) {
    const db = getDb();
    const [parentMsg] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return false;
    return canAgentAccessChannel(parentMsg.channelId, agentId);
  }

  return isChannelAgent(channelId, agentId);
}

/**
 * Resolve one channel id into the exact agent-facing target grammar, while
 * performing the visibility check in the same operation. Callers must treat a
 * null result as both "not visible" and "not resolvable" and must not disclose
 * which case applied.
 *
 * DM storage names are not a reliable peer projection: human-agent DMs are
 * named after the agent, and an agent-agent DM is named after whichever peer
 * happened to be the creation target. Prefer durable DM provenance and only
 * use current membership as a legacy fallback.
 */
export async function resolveAgentFacingChannelRef(
  serverId: string,
  agentId: string,
  channelId: string,
): Promise<string | null> {
  const channel = await getChannel(channelId);
  if (!channel || channel.serverId !== serverId) return null;
  if (!await canAgentAccessChannel(channelId, agentId)) return null;
  // Task creation is top-level-only. Do not manufacture a #thread-name target
  // for an invalid historical row; that string is not part of the target DSL.
  if (channel.type === "thread") return null;
  if (channel.type !== "dm") return `#${channel.name}`;

  const db = getDb();
  const [identity] = await db
    .select({ kind: dmChannelIdentities.kind, peerKey: dmChannelIdentities.peerKey })
    .from(dmChannelIdentities)
    .where(and(
      eq(dmChannelIdentities.channelId, channelId),
      eq(dmChannelIdentities.serverId, serverId),
    ))
    .limit(1);

  if (identity) {
    const participants = identity.peerKey.split(":");
    if (!participants.includes(agentId)) return null;
    const peerId = participants.find((id) => id !== agentId);
    if (peerId && identity.kind === "human_agent") {
      const [peer] = await db.select({ name: users.name }).from(users).where(eq(users.id, peerId)).limit(1);
      return peer?.name ? `dm:@${peer.name}` : null;
    }
    if (peerId && identity.kind === "agent_agent") {
      const [peer] = await db.select({ name: agents.name }).from(agents).where(and(
        eq(agents.id, peerId),
        eq(agents.serverId, serverId),
      )).limit(1);
      return peer?.name ? `dm:@${peer.name}` : null;
    }
    return null;
  }

  // Legacy human-agent DMs may predate dm_channel_identities.
  const [humanPeer] = await db
    .select({ name: users.name })
    .from(channelHumans)
    .innerJoin(users, eq(channelHumans.userId, users.id))
    .where(eq(channelHumans.channelId, channelId))
    .limit(1);
  if (humanPeer?.name) return `dm:@${humanPeer.name}`;

  // Legacy agent-agent DMs likewise derive the peer from the other member.
  const [agentPeer] = await db
    .select({ name: agents.name })
    .from(channelAgents)
    .innerJoin(agents, eq(channelAgents.agentId, agents.id))
    .where(and(
      eq(channelAgents.channelId, channelId),
      sql`${channelAgents.agentId} <> ${agentId}`,
    ))
    .limit(1);
  if (agentPeer?.name) return `dm:@${agentPeer.name}`;

  // Built-in app conversations intentionally have one agent member and no DM
  // identity row. Their registry app id is the documented dm:@ target.
  return isAppId(channel.name) ? `dm:@${channel.name}` : null;
}

/**
 * Enumerate the current agent's visible, task-bearing channel namespace. This
 * starts from public channels plus the agent's own membership rows; it never
 * scans hidden task assignments and therefore cannot turn their count into a
 * timing or output oracle. Archived channels remain included because archive
 * does not revoke read access or retire outstanding work.
 */
export async function listAgentFacingTaskChannelRefs(
  serverId: string,
  agentId: string,
): Promise<Map<string, string>> {
  const db = getDb();
  const candidates = await db
    .select({ id: channels.id })
    .from(channels)
    .leftJoin(channelAgents, and(
      eq(channelAgents.channelId, channels.id),
      eq(channelAgents.agentId, agentId),
    ))
    .where(and(
      eq(channels.serverId, serverId),
      inArray(channels.type, ["channel", "private", "joint", "dm"]),
      isNull(channels.deletedAt),
      or(eq(channels.type, "channel"), isNotNull(channelAgents.agentId)),
    ));

  const refs = new Map<string, string>();
  await Promise.all(candidates.map(async ({ id }) => {
    const ref = await resolveAgentFacingChannelRef(serverId, agentId, id);
    if (ref) refs.set(id, ref);
  }));
  return refs;
}

export async function isAgentActivelyFollowingThread(threadChannelId: string, agentId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ followerId: threadFollows.followerId })
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, threadChannelId),
      eq(threadFollows.followerType, "agent"),
      eq(threadFollows.followerId, agentId),
      isNull(threadFollows.unfollowedAt),
    ))
    .limit(1);
  return Boolean(row);
}

async function canAgentAccessThreadParentForDelivery(threadChannelId: string, agentId: string): Promise<boolean> {
  const db = getDb();
  const [threadChannel] = await db
    .select({ id: channels.id, serverId: channels.serverId })
    .from(channels)
    .where(and(
      eq(channels.id, threadChannelId),
      eq(channels.type, "thread"),
      isNull(channels.deletedAt),
    ))
    .limit(1);
  if (!threadChannel) return false;

  const jointThread = await getJointThreadProjectionByLocalThread(threadChannelId, threadChannel.serverId);
  if (jointThread) {
    const jointParentChannels = alias(channels, "agent_thread_delivery_joint_parent_channels");
    const [row] = await db
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .innerJoin(agents, and(
        eq(agents.id, channelAgents.agentId),
        isNull(agents.deletedAt),
      ))
      .innerJoin(jointParentChannels, and(
        eq(jointParentChannels.id, jointThread.localParentChannelId),
        isNull(jointParentChannels.deletedAt),
      ))
      .where(and(
        eq(channelAgents.channelId, jointThread.localParentChannelId),
        eq(channelAgents.agentId, agentId),
      ))
      .limit(1);
    return Boolean(row);
  }

  const parentMessages = alias(messages, "agent_thread_delivery_parent_messages");
  const parentChannels = alias(channels, "agent_thread_delivery_parent_channels");
  const parentChannelAgents = alias(channelAgents, "agent_thread_delivery_parent_channel_agents");
  const [row] = await db
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(parentMessages, eq(parentMessages.id, channels.parentMessageId))
    .innerJoin(parentChannels, and(
      eq(parentChannels.id, parentMessages.channelId),
      isNull(parentChannels.deletedAt),
    ))
    .innerJoin(agents, and(
      eq(agents.id, agentId),
      isNull(agents.deletedAt),
    ))
    .leftJoin(parentChannelAgents, and(
      eq(parentChannelAgents.channelId, parentMessages.channelId),
      eq(parentChannelAgents.agentId, agents.id),
    ))
    .where(and(
      eq(channels.id, threadChannelId),
      eq(channels.type, "thread"),
      isNull(channels.deletedAt),
      sql`(
        (${parentChannels.type} = 'channel' AND ${agents.serverId} = ${parentChannels.serverId})
        OR ${parentChannelAgents.agentId} IS NOT NULL
      )`,
    ))
    .limit(1);
  return Boolean(row);
}

export async function canAgentReceiveChannelDelivery(
  channelId: string,
  agentId: string,
  opts: { personalMention?: boolean } = {},
): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (!channel) return false;

  if (channel.type !== "thread") {
    return canAgentAccessChannel(channelId, agentId);
  }

  if (opts.personalMention) {
    return canAgentAccessThreadParentForDelivery(channelId, agentId);
  }

  return await isAgentActivelyFollowingThread(channelId, agentId)
    && await canAgentAccessThreadParentForDelivery(channelId, agentId);
}

/**
 * Post authority for a human (see thread contract in schema.ts).
 * Threads recurse to parent channel/DM membership; following a thread never
 * grants post permission.
 */
export async function canUserPostToChannel(channelId: string, userId: string): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (!channel) return false;

  const serverRole = await resolveHumanServerRole(channel.serverId, userId);
  if (serverRole === "guest") {
    if (channel.type === "thread") {
      const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
      if (jointThread) return false;
      if (!channel.parentMessageId) return false;
      const [parentMsg] = await getDb()
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, channel.parentMessageId));
      return parentMsg ? canUserPostToChannel(parentMsg.channelId, userId) : false;
    }
    return canGuestPostToChannel({
      gateEnabled: await isGuestFeatureEnabled(channel.serverId, userId),
      serverRole,
      channelType: channel.type,
      channelName: channel.name,
      allChannelHidden: isAllSystemChannel(channel) && !isEnabledAllChannel(channel),
      guestVisible: channel.guestVisible,
      guestJoinable: channel.guestJoinable,
      isChannelMember: await isChannelHuman(channelId, userId),
      archived: channel.archivedAt !== null,
      deleted: channel.deletedAt !== null,
    });
  }

  if (isAllSystemChannel(channel) && !isEnabledAllChannel(channel)) return false;
  if (isEnabledAllChannel(channel)) return isServerHumanMember(channel.serverId, userId);

  if (channel.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    if (jointThread) {
      return canUserPostToChannel(jointThread.localParentChannelId, userId);
    }
  }

  if (channel.type === "thread" && channel.parentMessageId) {
    const db = getDb();
    const [parentMsg] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return false;
    return canUserPostToChannel(parentMsg.channelId, userId);
  }

  return isChannelHuman(channelId, userId);
}

/**
 * Post authority for an agent (see thread contract in schema.ts).
 * Threads recurse to parent channel/DM membership; being in thread_follows
 * never grants post permission.
 */
export async function canAgentPostToChannel(channelId: string, agentId: string): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (!channel) return false;

  if (isAllSystemChannel(channel) && !isEnabledAllChannel(channel)) return false;
  if (isEnabledAllChannel(channel)) return isServerAgent(channel.serverId, agentId);

  if (channel.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    if (jointThread) {
      return canAgentPostToChannel(jointThread.localParentChannelId, agentId);
    }
  }

  if (channel.type === "thread" && channel.parentMessageId) {
    const db = getDb();
    const [parentMsg] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return false;
    return canAgentPostToChannel(parentMsg.channelId, agentId);
  }

  return isChannelAgent(channelId, agentId);
}

/**
 * Resolve a unified target identifier to a channel ID.
 * Accepts:
 *   - "#channel" for channels
 *   - "#channel:shortid" for threads in channels
 *   - "dm:@peer" or "DM:@peer" (legacy uppercase) for DMs
 *   - "dm:@peer:shortid" for threads in DMs
 * For DMs, the agentId is needed to find the DM channel between the agent and the peer.
 */
/**
 * Split a channel ref into its channel part and optional thread short id.
 *
 * This is the ONLY place the suffix rule lives. `resolveChannelByName` below
 * calls it, so a caller that needs to tell "this channel does not exist" apart
 * from "this message has no thread yet" gets exactly the split the resolver
 * acted on. An earlier version of this comment claimed that while the resolver
 * still carried its own inline copy: the two agreed character for character,
 * which is precisely how a second implementation stays hidden -- nothing warns
 * you when you edit one of them.
 *
 * The suffix must be a full 8-hex message short id (`MESSAGE_SHORT_ID_RE`, the
 * same predicate the message resolvers use). A looser `[0-9a-f]+` also matched
 * refs like `#general:1`, routing a plain channel whose name happens to contain
 * a colon into thread lookup.
 */
export function parseChannelRef(
  channelRef: string,
): { baseRef: string; threadShortId: string | null } {
  const withSuffix = (prefix: string, rest: string) => {
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > 0) {
      const shortId = rest.slice(lastColon + 1);
      if (MESSAGE_SHORT_ID_RE.test(shortId)) {
        return { baseRef: `${prefix}${rest.slice(0, lastColon)}`, threadShortId: shortId };
      }
    }
    return { baseRef: `${prefix}${rest}`, threadShortId: null };
  };
  if (channelRef.startsWith("DM:@") || channelRef.startsWith("dm:@")) {
    return withSuffix(channelRef.slice(0, 4), channelRef.slice(4));
  }
  if (channelRef.startsWith("#")) {
    return withSuffix("#", channelRef.slice(1));
  }
  return { baseRef: channelRef, threadShortId: null };
}

export async function resolveChannelByName(
  serverId: string,
  agentId: string,
  channelRef: string
): Promise<{ channelId: string; type: ChannelRefType } | null> {
  const db = getDb();

  // Single source for the suffix rule -- see parseChannelRef.
  const { baseRef, threadShortId } = parseChannelRef(channelRef);

  // DM or DM thread: dm:@peer or dm:@peer:shortid (also legacy DM:@)
  if (channelRef.startsWith("DM:@") || channelRef.startsWith("dm:@")) {
    if (threadShortId) {
      return resolveThreadByShortId(serverId, agentId, threadShortId);
    }
    return resolveDMByPeerName(serverId, agentId, baseRef.slice(4));
  }

  // Channel or channel thread: #name or #name:shortid
  if (channelRef.startsWith("#")) {
    if (threadShortId) {
      return resolveThreadByShortId(serverId, agentId, threadShortId);
    }
    const rest = baseRef.slice(1);
    // Plain channel lookup
    const [channel] = await db
      .select({
        id: channels.id,
        type: channels.type,
        name: channels.name,
      })
      .from(channels)
      .where(
        and(
          eq(channels.serverId, serverId),
          inArray(channels.type, LISTABLE_CHANNEL_TYPES),
          eq(channels.name, rest),
          isNull(channels.deletedAt)
        )
      );
    if (!channel) return null;
    if (isAllSystemChannel(channel) && !isEnabledAllChannel(channel)) {
      return null;
    }
    if (requiresExplicitMembership(channel.type) && !await isChannelAgent(channel.id, agentId)) {
      return null;
    }
    if (channel.type === "joint" && !await resolveChannelAccess({ serverId, channelId: channel.id })) {
      return null;
    }
    return { channelId: channel.id, type: channel.type as ListableChannelType };
  }

  return null;
}

/** Resolve a thread channel by its short ID (first 8 chars of parent message UUID). */
async function resolveThreadByShortId(
  serverId: string,
  agentId: string,
  shortId: string
): Promise<{ channelId: string; type: "thread" } | null> {
  const db = getDb();
  const threadName = `thread-${shortId}`;
  const [channel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.serverId, serverId),
        eq(channels.type, "thread"),
        eq(channels.name, threadName),
        isNull(channels.deletedAt)
      )
    );
  if (!channel) return null;
  if (!await canAgentAccessChannel(channel.id, agentId)) return null;
  return { channelId: channel.id, type: "thread" };
}

/**
 * Resolve a DM channel by peer name (for agents).
 * Searches for an existing DM between the agent and a user/agent with this name.
 */
async function resolveDMByPeerName(
  serverId: string,
  agentId: string,
  peerName: string
): Promise<{ channelId: string; type: "dm" } | null> {
  const db = getDb();

  // Built-in app DMs are resolved for the authenticated owner only. The
  // owner is never accepted from the ref string: Agent A therefore cannot
  // resolve Agent B's derived conversation even though both refs render as
  // `dm:@<appId>`.
  if (isAppId(peerName)) {
    const appDm = await getBuiltInConversationChannel(serverId, peerName, agentId);
    if (appDm) return { channelId: appDm.id, type: "dm" };
  }

  // Try user peer first: find user with matching name in this server
  const userResults = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(serverMembers, eq(serverMembers.userId, users.id))
    .where(and(eq(serverMembers.serverId, serverId), eq(users.name, peerName)));

  for (const user of userResults) {
    // Find DM channel between this agent and this user
    const [dm] = await db
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(channelAgents, eq(channels.id, channelAgents.channelId))
      .innerJoin(channelHumans, eq(channels.id, channelHumans.channelId))
      .where(
        and(
          eq(channels.serverId, serverId),
          eq(channels.type, "dm"),
          eq(channelAgents.agentId, agentId),
          eq(channelHumans.userId, user.id),
          isNull(channels.deletedAt)
        )
      );
    if (dm) return { channelId: dm.id, type: "dm" };
  }

  const agentResults = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), eq(agents.name, peerName), isNull(agents.deletedAt)));

  const otherAgentMembership = alias(channelAgents, "other_agent_membership");
  for (const peerAgent of agentResults) {
    if (peerAgent.id === agentId) continue;
    const [dm] = await db
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(channelAgents, and(eq(channels.id, channelAgents.channelId), eq(channelAgents.agentId, agentId)))
      .innerJoin(otherAgentMembership, and(eq(channels.id, otherAgentMembership.channelId), eq(otherAgentMembership.agentId, peerAgent.id)))
      .leftJoin(channelHumans, eq(channels.id, channelHumans.channelId))
      .where(and(
        eq(channels.serverId, serverId),
        eq(channels.type, "dm"),
        isNull(channels.deletedAt),
        isNull(channelHumans.userId),
      ));
    if (dm) return { channelId: dm.id, type: "dm" };
  }

  return null;
}

/**
 * Resolve a user by @name within a server. Returns userId or null.
 */
export async function resolveUserByName(serverId: string, name: string): Promise<string | null> {
  const db = getDb();
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(serverMembers, eq(serverMembers.userId, users.id))
    .where(and(eq(serverMembers.serverId, serverId), eq(users.name, name)));
  return user?.id || null;
}

export async function resolveAgentByName(serverId: string, name: string): Promise<string | null> {
  const db = getDb();
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), eq(agents.name, name), isNull(agents.deletedAt)));
  return agent?.id || null;
}

export async function getMessage(messageId: string) {
  const db = getDb();
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  return msg ?? null;
}

export type ChannelFileEntry = {
  id: string;
  messageId: string;
  channelId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  thumbnailKey: string | null;
  createdAt: string;
  uploaderType: "user" | "agent" | "external_projection";
  uploaderId: string;
  uploaderName: string | null;
  uploaderDisplayName: string | null;
  source: {
    type: "channel" | "thread";
    channelId: string;
    parentMessageId: string | null;
    parentMessageShortId: string | null;
  };
};

export type ChannelFilesCursor = {
  createdAt: string;
  id: string;
};

export async function listChannelFiles(
  channelId: string,
  opts: { historyCutoff?: Date | null; limit?: number; cursor?: ChannelFilesCursor | null } = {},
): Promise<ChannelFileEntry[]> {
  const db = getDb();
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 500));
  const historyCutoff = opts.historyCutoff ?? null;
  const historyFilter = historyCutoff ? sql`AND m.created_at >= ${historyCutoff}` : sql``;
  const cursor = opts.cursor ?? null;
  const cursorFilter = cursor
    ? sql`AND (a.created_at < ${cursor.createdAt}::timestamptz OR (a.created_at = ${cursor.createdAt}::timestamptz AND a.id < ${cursor.id}))`
    : sql``;
  const rows = await db.execute(sql`
    WITH candidate_files AS (
      (
        SELECT
          a.id,
          a.message_id,
          a.channel_id,
          a.filename,
          a.mime_type,
          a.size_bytes,
          a.width,
          a.height,
          a.thumbnail_key,
          a.created_at,
          a.uploader_type,
          a.uploader_id,
          m.channel_id AS source_channel_id,
          CASE WHEN source_channel.type = 'thread' THEN 'thread' ELSE 'channel' END AS source_type,
          source_channel.parent_message_id
        FROM attachments a
        INNER JOIN messages m
          ON m.id = a.message_id
         AND m.channel_id = a.channel_id
        INNER JOIN channels source_channel
          ON source_channel.id = a.channel_id
         AND source_channel.deleted_at IS NULL
        WHERE a.message_id IS NOT NULL
          AND a.channel_id = ${channelId}
          ${historyFilter}
          ${cursorFilter}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limit}
      )
      UNION ALL
      (
        SELECT
          a.id,
          a.message_id,
          a.channel_id,
          a.filename,
          a.mime_type,
          a.size_bytes,
          a.width,
          a.height,
          a.thumbnail_key,
          a.created_at,
          a.uploader_type,
          a.uploader_id,
          m.channel_id AS source_channel_id,
          'thread'::text AS source_type,
          source_channel.parent_message_id
        FROM messages parent_message
        INNER JOIN channels source_channel
          ON source_channel.parent_message_id = parent_message.id
         AND source_channel.type = 'thread'
         AND source_channel.deleted_at IS NULL
        INNER JOIN attachments a
          ON a.channel_id = source_channel.id
         AND a.message_id IS NOT NULL
        INNER JOIN messages m
          ON m.id = a.message_id
         AND m.channel_id = source_channel.id
        WHERE parent_message.channel_id = ${channelId}
          ${historyFilter}
          ${cursorFilter}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limit}
      )
    )
    SELECT
      cf.id::text AS "id",
      cf.message_id::text AS "messageId",
      cf.channel_id::text AS "channelId",
      cf.filename AS "filename",
      cf.mime_type AS "mimeType",
      cf.size_bytes::int AS "sizeBytes",
      cf.width::int AS "width",
      cf.height::int AS "height",
      cf.thumbnail_key AS "thumbnailKey",
      cf.created_at::text AS "createdAt",
      cf.uploader_type AS "uploaderType",
      cf.uploader_id::text AS "uploaderId",
      CASE
        WHEN cf.uploader_type = 'user' THEN u.name
        WHEN cf.uploader_type = 'agent' THEN ag.name
        WHEN cf.uploader_type = 'external_projection' THEN eap.display_name
        ELSE NULL
      END AS "uploaderName",
      CASE
        WHEN cf.uploader_type = 'user' THEN u.display_name
        WHEN cf.uploader_type = 'agent' THEN ag.display_name
        WHEN cf.uploader_type = 'external_projection' THEN eap.display_name
        ELSE NULL
      END AS "uploaderDisplayName",
      cf.source_channel_id::text AS "sourceChannelId",
      cf.source_type AS "sourceType",
      cf.parent_message_id::text AS "parentMessageId"
    FROM candidate_files cf
    LEFT JOIN users u
      ON cf.uploader_type = 'user'
     AND u.id::text = cf.uploader_id
    LEFT JOIN agents ag
      ON cf.uploader_type = 'agent'
     AND ag.id::text = cf.uploader_id
    LEFT JOIN external_actor_projections eap
      ON cf.uploader_type = 'external_projection'
     AND eap.id::text = cf.uploader_id
    ORDER BY cf.created_at DESC, cf.id DESC
    LIMIT ${limit}
  `);

  return rows.rows.map((row) => {
    const r = row as Record<string, unknown>;
    const parentMessageId = typeof r.parentMessageId === "string" ? r.parentMessageId : null;
    return {
      id: String(r.id),
      messageId: String(r.messageId),
      channelId: String(r.channelId),
      filename: String(r.filename),
      mimeType: String(r.mimeType),
      sizeBytes: Number(r.sizeBytes),
      width: r.width == null ? null : Number(r.width),
      height: r.height == null ? null : Number(r.height),
      thumbnailKey: typeof r.thumbnailKey === "string" ? r.thumbnailKey : null,
      createdAt: String(r.createdAt),
      uploaderType: r.uploaderType === "agent"
        ? "agent"
        : r.uploaderType === "external_projection"
          ? "external_projection"
          : "user",
      uploaderId: String(r.uploaderId),
      uploaderName: typeof r.uploaderName === "string" ? r.uploaderName : null,
      uploaderDisplayName: typeof r.uploaderDisplayName === "string" ? r.uploaderDisplayName : null,
      source: {
        type: r.sourceType === "thread" ? "thread" : "channel",
        channelId: String(r.sourceChannelId),
        parentMessageId,
        parentMessageShortId: parentMessageId ? parentMessageId.slice(0, 8) : null,
      },
    };
  });
}

// ── Thread support ───────────────────────────────────────

type CanonicalThreadRow = {
  threadChannelId: string;
  storageThreadChannelId: string;
  parentMessageId: string;
  replyCount: number;
  lastReplyAt: string | null;
};

async function listCanonicalThreadsForParentMessages(
  parentMessageIds: string[],
): Promise<CanonicalThreadRow[]> {
  const dedupedParentMessageIds = [...new Set(parentMessageIds.filter(Boolean))];
  if (dedupedParentMessageIds.length === 0) return [];

  const db = getDb();
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (c.parent_message_id)
      c.id::text AS "threadChannelId",
      c.id::text AS "storageThreadChannelId",
      c.parent_message_id::text AS "parentMessageId",
      COALESCE(stats.reply_count, 0)::int AS "replyCount",
      latest.last_reply_at::text AS "lastReplyAt"
    FROM channels c
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS reply_count
      FROM messages m
      WHERE m.channel_id = c.id
    ) stats ON TRUE
    LEFT JOIN LATERAL (
      SELECT m.created_at AS last_reply_at
      FROM messages m
      WHERE m.channel_id = c.id
      ORDER BY m.created_at DESC
      LIMIT 1
    ) latest ON TRUE
    WHERE c.type = 'thread'
      AND c.deleted_at IS NULL
      AND c.parent_message_id IN (${sql.join(dedupedParentMessageIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY
      c.parent_message_id,
      latest.last_reply_at DESC NULLS LAST,
      COALESCE(stats.reply_count, 0) DESC,
      c.created_at ASC,
      c.id ASC
  `);

  return rows.rows as CanonicalThreadRow[];
}

async function listCanonicalThreadsForChannelParentMessages(
  channelId: string,
  parentMessageIds: string[],
): Promise<CanonicalThreadRow[]> {
  const dedupedParentMessageIds = [...new Set(parentMessageIds.filter(Boolean))];
  if (dedupedParentMessageIds.length === 0) return [];

  const db = getDb();
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (c.parent_message_id)
      c.id::text AS "threadChannelId",
      c.id::text AS "storageThreadChannelId",
      c.parent_message_id::text AS "parentMessageId",
      COALESCE(stats.reply_count, 0)::int AS "replyCount",
      latest.last_reply_at::text AS "lastReplyAt"
    FROM channels c
    INNER JOIN messages pm ON pm.id = c.parent_message_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS reply_count
      FROM messages m
      WHERE m.channel_id = c.id
    ) stats ON TRUE
    LEFT JOIN LATERAL (
      SELECT m.created_at AS last_reply_at
      FROM messages m
      WHERE m.channel_id = c.id
      ORDER BY m.created_at DESC
      LIMIT 1
    ) latest ON TRUE
    WHERE c.type = 'thread'
      AND c.deleted_at IS NULL
      AND pm.channel_id = ${channelId}
      AND c.parent_message_id IN (${sql.join(dedupedParentMessageIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY
      c.parent_message_id,
      latest.last_reply_at DESC NULLS LAST,
      COALESCE(stats.reply_count, 0) DESC,
      c.created_at ASC,
      c.id ASC
  `);

  return rows.rows as CanonicalThreadRow[];
}

async function listCanonicalThreadsForChannel(channelId: string): Promise<CanonicalThreadRow[]> {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (c.parent_message_id)
      c.id::text AS "threadChannelId",
      c.id::text AS "storageThreadChannelId",
      c.parent_message_id::text AS "parentMessageId",
      COALESCE(stats.reply_count, 0)::int AS "replyCount",
      latest.last_reply_at::text AS "lastReplyAt"
    FROM channels c
    INNER JOIN messages pm ON pm.id = c.parent_message_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS reply_count
      FROM messages m
      WHERE m.channel_id = c.id
    ) stats ON TRUE
    LEFT JOIN LATERAL (
      SELECT m.created_at AS last_reply_at
      FROM messages m
      WHERE m.channel_id = c.id
      ORDER BY m.created_at DESC
      LIMIT 1
    ) latest ON TRUE
    WHERE c.type = 'thread'
      AND c.deleted_at IS NULL
      AND pm.channel_id = ${channelId}
    ORDER BY
      c.parent_message_id,
      latest.last_reply_at DESC NULLS LAST,
      COALESCE(stats.reply_count, 0) DESC,
      c.created_at ASC,
      c.id ASC
  `);

  return rows.rows as CanonicalThreadRow[];
}

export async function listThreadChannelIdsForParentChannel(channelId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT DISTINCT c.id::text AS "threadChannelId"
    FROM channels c
    INNER JOIN messages pm ON pm.id = c.parent_message_id
    WHERE c.type = 'thread'
      AND c.deleted_at IS NULL
      AND pm.channel_id = ${channelId}
  `);
  return (rows.rows as Array<{ threadChannelId: string }>).map((row) => row.threadChannelId);
}

async function listRecentCanonicalThreadParentMessageIds(channelId: string, limit: number): Promise<string[]> {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];

  const db = getDb();
  const rows = await db.execute(sql`
    SELECT c.parent_message_id::text AS "parentMessageId"
    FROM channels c
    INNER JOIN messages pm ON pm.id = c.parent_message_id
    WHERE c.type = 'thread'
      AND c.deleted_at IS NULL
      AND pm.channel_id = ${channelId}
    GROUP BY c.parent_message_id
    ORDER BY max(pm.seq) DESC, c.parent_message_id DESC
    LIMIT ${boundedLimit}
  `);

  return (rows.rows as Array<{ parentMessageId: string }>).map((row) => row.parentMessageId);
}

export async function listRecentThreadParentMessageIdsForChannelView(channelId: string, limit: number): Promise<string[]> {
  const channel = await getChannel(channelId);
  if (channel?.type !== "joint") {
    return listRecentCanonicalThreadParentMessageIds(channelId, limit);
  }

  const resolved = await resolveChannelAccess({ serverId: channel.serverId, channelId });
  if (!resolved || resolved.kind !== "joint") return [];
  return listRecentCanonicalThreadParentMessageIds(resolved.canonicalChannelId, limit);
}

async function getCanonicalThreadForParentMessage(parentMessageId: string): Promise<CanonicalThreadRow | null> {
  const [row] = await listCanonicalThreadsForParentMessages([parentMessageId]);
  return row ?? null;
}

async function listThreadRowsForChannelView(
  channelId: string,
  parentMessageIds?: string[],
): Promise<CanonicalThreadRow[]> {
  const parentScope = parentMessageIds ? [...new Set(parentMessageIds.filter(Boolean))] : undefined;
  if (parentScope && parentScope.length === 0) return [];

  const channel = await getChannel(channelId);
  if (channel?.type !== "joint") {
    return parentScope
      ? listCanonicalThreadsForChannelParentMessages(channelId, parentScope)
      : listCanonicalThreadsForChannel(channelId);
  }

  const resolved = await resolveChannelAccess({ serverId: channel.serverId, channelId });
  if (!resolved || resolved.kind !== "joint") return [];

  const canonicalThreads = parentScope
    ? await listCanonicalThreadsForChannelParentMessages(resolved.canonicalChannelId, parentScope)
    : await listCanonicalThreadsForChannel(resolved.canonicalChannelId);
  if (canonicalThreads.length === 0) return [];

  const projections = await Promise.all(
    canonicalThreads.map(async (thread) => ({
      thread,
      localProjection: (await listActiveJointThreadProjectionRows({
        canonicalThreadChannelId: thread.threadChannelId,
        serverId: channel.serverId,
      }))[0] ?? null,
    })),
  );

  return projections
    .filter((entry): entry is typeof entry & { localProjection: JointThreadProjection } => Boolean(entry.localProjection))
    .map(({ thread, localProjection }) => ({
      ...thread,
      threadChannelId: localProjection.localThreadChannelId,
      storageThreadChannelId: thread.threadChannelId,
    }));
}

// Stamps the thread CHANNEL id onto the PARENT message's `messages.thread_id`
// column. This is the single writer of that column: a thread parent gains its
// `thread_id` reference once its thread channel is resolved. Reply messages
// *inside* a thread keep `thread_id = null` and live in the thread channel
// itself (see `schema.ts` `messages.threadId` comment for the contract).
async function syncParentMessageThreadId(parentMessageId: string, threadChannelId: string) {
  const db = getDb();
  await db.update(messages)
    .set({ threadId: threadChannelId })
    .where(eq(messages.id, parentMessageId));
}

/**
 * Find or create a thread channel for a parent message.
 * Thread = channel with type="thread" and parentMessageId set.
 *
 * This function never writes thread_follows rows. Follow rows are written only by:
 *   - the reply-broadcast path in messageService (sender → 'replied', parent author → 'authored')
 *   - mention handling in messageService (mentioned → 'mentioned')
 *   - explicit manual follow via the /channels/threads/follow route
 *
 * Rationale: opening a thread panel must not auto-follow — pollution of the
 * Threads list by view-only opens was the bug this contract fixes.
 */
export async function getOrCreateThread(
  parentMessageId: string,
  _creatorId: string,
  _creatorType: "user" | "agent",
): Promise<{ id: string; serverId: string; parentMessageId: string; created: boolean }> {
  const db = getDb();

  const existing = await getCanonicalThreadForParentMessage(parentMessageId);
  if (existing) {
    await syncParentMessageThreadId(parentMessageId, existing.threadChannelId);
    const [parentThread] = await db
      .select({ serverId: channels.serverId })
      .from(channels)
      .where(eq(channels.id, existing.threadChannelId))
      .limit(1);
    if (!parentThread) throw new Error("Canonical thread channel not found");
    return {
      id: existing.threadChannelId,
      serverId: parentThread.serverId,
      parentMessageId,
      created: false,
    };
  }

  // Get parent message to find its channel and author
  const [parentMsg] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, parentMessageId));
  if (!parentMsg) throw new Error("Parent message not found");

  // Get parent channel to find serverId
  const [parentChannel] = await db
    .select({ serverId: channels.serverId })
    .from(channels)
    .where(eq(channels.id, parentMsg.channelId));
  if (!parentChannel) throw new Error("Parent channel not found");

  // Create thread channel
  const threadName = `thread-${parentMessageId.slice(0, 8)}`;
  const [threadChannel] = await db.insert(channels).values({
    serverId: parentChannel.serverId,
    name: threadName,
    type: "thread",
    parentMessageId,
  }).onConflictDoNothing().returning();

  if (threadChannel) {
    await syncParentMessageThreadId(parentMessageId, threadChannel.id);
    return { id: threadChannel.id, serverId: parentChannel.serverId, parentMessageId, created: true };
  }

  const canonical = await getCanonicalThreadForParentMessage(parentMessageId);
  if (!canonical) throw new Error("Thread creation conflicted but no canonical thread was found");
  await syncParentMessageThreadId(parentMessageId, canonical.threadChannelId);
  return { id: canonical.threadChannelId, serverId: parentChannel.serverId, parentMessageId, created: false };
}

export async function getOrCreateThreadForChannel(
  parentChannelId: string,
  parentMessageId: string,
  creatorId: string,
  creatorType: "user" | "agent",
): Promise<{ id: string; serverId: string; parentMessageId: string; created: boolean; canonicalThreadChannelId: string }> {
  const parentChannel = await getChannel(parentChannelId);
  if (!parentChannel) throw new Error("Parent channel not found");

  if (parentChannel.type !== "joint") {
    const db = getDb();
    const [parentMsg] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, parentMessageId));
    if (!parentMsg || parentMsg.channelId !== parentChannelId) {
      throw new Error("Parent message not found");
    }
    const thread = await getOrCreateThread(parentMessageId, creatorId, creatorType);
    return { ...thread, canonicalThreadChannelId: thread.id };
  }

  const parentProjection = await resolveChannelAccess({ serverId: parentChannel.serverId, channelId: parentChannelId });
  if (!parentProjection || parentProjection.kind !== "joint") {
    throw new Error("Parent channel not found");
  }

  const db = getDb();
  const [parentMsg] = await db
    .select({ id: messages.id, channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, parentMessageId));
  if (!parentMsg || parentMsg.channelId !== parentProjection.canonicalChannelId) {
    throw new Error("Parent message not found");
  }

  const canonicalThread = await getOrCreateThread(parentMessageId, creatorId, creatorType);

  const [existingJointThread] = await db
    .select({ id: jointChannels.id })
    .from(jointChannels)
    .where(and(
      eq(jointChannels.canonicalChannelId, canonicalThread.id),
      eq(jointChannels.status, "active"),
    ))
    .limit(1);

  const jointThreadId = existingJointThread?.id ?? (await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: parentChannel.serverId,
    createdByUserId: creatorType === "user" ? creatorId : null,
    status: "active",
  }).returning({ id: jointChannels.id }))[0].id;

  const parentProjections = await getActiveJointChannelProjectionsByLocalChannel(parentChannelId);
  let localThreadId: string | null = null;
  let createdLocalProjection = false;

  for (const projection of parentProjections) {
    const projectionThread = await ensureJointThreadProjectionForLocalParent(db, {
      jointThreadId,
      localParentProjection: projection,
      parentMessageId,
      joinedByUserId: creatorType === "user" && projection.serverId === parentChannel.serverId ? creatorId : null,
    });
    createdLocalProjection = createdLocalProjection || projectionThread.created;

    if (projection.localChannelId === parentChannelId) {
      localThreadId = projectionThread.localThreadChannelId;
    }
  }

  if (!localThreadId) throw new Error("Thread projection not found");
  return {
    id: localThreadId,
    serverId: parentChannel.serverId,
    parentMessageId,
    created: canonicalThread.created || createdLocalProjection,
    canonicalThreadChannelId: canonicalThread.id,
  };
}

type ThreadSummaryLatestReply = {
  messageId: string;
  seq: number;
  preview: string;
  senderId: string;
  senderType: "user" | "agent" | "system" | "external_projection";
  /** Stable unique handle retained for identity/backward compatibility. */
  senderName: string;
  /** UI label: canonical display name, falling back to the stable handle. */
  senderDisplayName: string;
  senderAvatarUrl: string | null;
  createdAt: string;
};

type ThreadSummaryResult = {
  threadChannelId: string;
  replyCount: number;
  lastReplyAt: string | null;
  participantIds: string[];
  unreadCount: number;
  firstUnreadMessageId: string | null;
  latestReplies: ThreadSummaryLatestReply[];
};

/**
 * Get thread summary info for messages in a channel.
 * Returns map of parentMessageId → viewer-aware thread summary metadata.
 */
export async function getThreadSummaries(channelId: string): Promise<
  Record<string, ThreadSummaryResult>
>;
export async function getThreadSummaries(
  channelId: string,
  opts?: ThreadSummaryOptions,
): Promise<
  Record<string, ThreadSummaryResult>
>;
export async function getThreadSummaries(
  channelId: string,
  opts?: ThreadSummaryOptions,
): Promise<
  Record<string, ThreadSummaryResult>
> {
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;

  const threads = await traceQuery(
    "channel_threads.list_by_channel",
    () => listThreadRowsForChannelView(channelId, opts?.parentMessageIds),
    (rows) => ({
      parent_message_scope_count: opts?.parentMessageIds?.length ?? null,
      parent_message_scope_source: opts?.parentMessageScopeSource ?? null,
      row_count: rows.length,
    }),
  );

  if (threads.length === 0) return {};

  const db = getDb();
  const result: Record<string, ThreadSummaryResult> = {};
  const threadChannelIds = threads.map(thread => thread.threadChannelId);
  const threadStorageRows = threads.map(thread => sql`(${thread.threadChannelId}::uuid, ${thread.storageThreadChannelId}::uuid)`);

  // Batch-fetch unique participants (senders in each thread)
  const participantRows = await traceQuery(
    "channel_threads.participants_by_threads",
    () => db.execute(sql`
      SELECT
        input_threads.thread_id::text AS "threadChannelId",
        m.sender_id AS "senderId"
      FROM (VALUES ${sql.join(threadStorageRows, sql`, `)}) AS input_threads(thread_id, storage_thread_id)
      INNER JOIN messages m
        ON m.channel_id = input_threads.storage_thread_id
      GROUP BY input_threads.thread_id, m.sender_id
    `),
    (rows) => ({
      input_count: threadChannelIds.length,
      participant_rows_count: rows.rows.length,
    }),
  );
  const participantsByThreadId = new Map<string, string[]>();
  for (const row of participantRows.rows as Array<{ threadChannelId: string; senderId: string }>) {
    const list = participantsByThreadId.get(row.threadChannelId) ?? [];
    list.push(row.senderId);
    participantsByThreadId.set(row.threadChannelId, list);
  }

  const unreadByThreadId = new Map<string, { unreadCount: number; firstUnreadMessageId: string | null }>();
  if (opts?.userId) {
    const unreadRows = await traceQuery(
      "channel_threads.unread_by_threads",
      () => db.execute(sql`
        SELECT
          input_threads.thread_id::text AS "threadChannelId",
          first_unread.id::text AS "firstUnreadMessageId",
          COALESCE(unread.unread_count, 0)::int AS "unreadCount"
        FROM (VALUES ${sql.join(threadStorageRows, sql`, `)}) AS input_threads(thread_id, storage_thread_id)
        LEFT JOIN thread_follows tf
          ON tf.thread_channel_id = input_threads.thread_id
          AND tf.follower_type = 'user'
          AND tf.follower_id = ${opts.userId}
          AND tf.done_at IS NULL
          AND tf.unfollowed_at IS NULL
        LEFT JOIN user_channel_read_cursors rc
          ON rc.channel_id = input_threads.thread_id
          AND rc.user_id = ${opts.userId}
        LEFT JOIN LATERAL (
          SELECT m.id
          FROM messages m
          WHERE tf.thread_channel_id IS NOT NULL
            AND m.channel_id = input_threads.storage_thread_id
            AND m.seq > COALESCE(rc.last_read_seq, 0)
          ORDER BY m.seq ASC
          LIMIT 1
        ) first_unread ON true
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS unread_count
          FROM messages m
          WHERE tf.thread_channel_id IS NOT NULL
            AND m.channel_id = input_threads.storage_thread_id
            AND m.seq > COALESCE(rc.last_read_seq, 0)
        ) unread ON true
      `),
      (rows) => ({
        input_count: threadChannelIds.length,
        unread_rows_count: rows.rows.length,
        unread_threads_count: (rows.rows as Array<{ unreadCount: number }>).filter((row) => row.unreadCount > 0).length,
      }),
    );
    for (const row of unreadRows.rows as Array<{ threadChannelId: string; unreadCount: number; firstUnreadMessageId: string | null }>) {
      unreadByThreadId.set(row.threadChannelId, {
        unreadCount: row.unreadCount,
        firstUnreadMessageId: row.firstUnreadMessageId ?? null,
      });
    }
  }

  // Latest conversation replies per thread — the "server sends the newest 3
  // upfront" leg of the inline reply previews design (task #47/#592). System
  // events remain part of replyCount and the full thread history, but the
  // compact preview is a human/agent conversation summary, not an audit log.
  const latestReplyRows = await traceQuery(
    "channel_threads.latest_replies_by_threads",
    () => db.execute(sql`
      SELECT
        input_threads.thread_id::text AS "threadChannelId",
        latest.id::text AS "messageId",
        latest.seq::int AS "seq",
        latest.content AS "content",
        latest.sender_id AS "senderId",
        latest.sender_type AS "senderType",
        latest.message_type AS "messageType",
        latest.created_at AS "createdAt"
      FROM (VALUES ${sql.join(threadStorageRows, sql`, `)}) AS input_threads(thread_id, storage_thread_id)
      JOIN LATERAL (
        SELECT m.id, m.seq, m.content, m.sender_id, m.sender_type, m.message_type, m.created_at
        FROM messages m
        WHERE m.channel_id = input_threads.storage_thread_id
          AND m.message_type <> 'system'
        ORDER BY m.seq DESC
        LIMIT 3
      ) latest ON true
    `),
    (rows) => ({
      input_count: threadChannelIds.length,
      latest_reply_rows_count: rows.rows.length,
    }),
  );
  type LatestReplyRow = {
    threadChannelId: string;
    messageId: string;
    seq: number;
    content: string;
    senderId: string;
    senderType: "user" | "agent" | "external_projection";
    messageType: string;
    createdAt: string | Date;
  };
  const latestRows = latestReplyRows.rows as LatestReplyRow[];
  const replySenderUserIds = [...new Set(latestRows.filter((r) => r.senderType === "user" && r.messageType !== "system").map((r) => r.senderId))];
  const replySenderAgentIds = [...new Set(latestRows.filter((r) => r.senderType === "agent").map((r) => r.senderId))];
  const replySenderNames = new Map<string, string>();
  const replySenderDisplayNames = new Map<string, string>();
  const replySenderAvatars = new Map<string, string | null>();
  const externalReplyNames = new Map<string, string>();
  const externalReplyAvatars = new Map<string, string | null>();
  if (replySenderUserIds.length > 0) {
    const rows = await db
      .select({ id: users.id, name: users.name, displayName: users.displayName, avatarUrl: users.avatarUrl })
      .from(users)
      .where(inArray(users.id, replySenderUserIds));
    for (const row of rows) {
      const senderName = row.name || "User";
      replySenderNames.set(row.id, senderName);
      replySenderDisplayNames.set(row.id, row.displayName || senderName);
      replySenderAvatars.set(row.id, row.avatarUrl ?? null);
    }
  }
  if (replySenderAgentIds.length > 0) {
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
      })
      .from(agents)
      .where(inArray(agents.id, replySenderAgentIds));
    for (const row of rows) {
      const senderName = row.name || "Agent";
      replySenderNames.set(row.id, senderName);
      replySenderDisplayNames.set(row.id, row.displayName || senderName);
      replySenderAvatars.set(row.id, row.avatarUrl ?? null);
    }
  }
  const externalReplyMessageIds = latestRows
    .filter((row) => row.senderType === "external_projection")
    .map((row) => row.messageId);
  if (externalReplyMessageIds.length > 0) {
    const rows = await db
      .select({
        messageId: externalMessageAuthorFacts.messageId,
        displayName: externalMessageAuthorFacts.displayName,
        frozenAvatarUrl: externalMessageAuthorFacts.avatarUrl,
        frozenAvatarDigest: externalMessageAuthorFacts.avatarDigest,
        avatarPublicUrl: externalProjectionAvatarArtifacts.publicUrl,
        avatarSourceDigest: externalProjectionAvatarArtifacts.sourceDigest,
        avatarState: externalProjectionAvatarArtifacts.state,
      })
      .from(externalMessageAuthorFacts)
      .leftJoin(
        externalProjectionAvatarArtifacts,
        eq(externalProjectionAvatarArtifacts.id, externalMessageAuthorFacts.avatarArtifactId),
      )
      .where(inArray(externalMessageAuthorFacts.messageId, externalReplyMessageIds));
    for (const row of rows) {
      externalReplyNames.set(row.messageId, row.displayName);
      externalReplyAvatars.set(
        row.messageId,
        row.avatarState === "active"
          && row.avatarPublicUrl === row.frozenAvatarUrl
          && row.avatarSourceDigest === row.frozenAvatarDigest
          ? row.avatarPublicUrl
          : null,
      );
    }
    if (externalReplyNames.size !== new Set(externalReplyMessageIds).size) {
      throw new Error("External projection thread reply is missing immutable author fact");
    }
  }
  const latestRepliesByThreadId = new Map<string, ThreadSummaryLatestReply[]>();
  for (const row of latestRows) {
    const isSystem = row.messageType === "system";
    const list = latestRepliesByThreadId.get(row.threadChannelId) ?? [];
    list.push({
      messageId: row.messageId,
      seq: row.seq,
      preview: row.content,
      senderId: row.senderId,
      senderType: isSystem ? "system" : row.senderType,
      senderName: isSystem
        ? "System"
        : row.senderType === "external_projection"
          ? (externalReplyNames.get(row.messageId) ?? "External user")
          : (replySenderNames.get(row.senderId) ?? (row.senderType === "agent" ? "Agent" : "User")),
      senderDisplayName: isSystem
        ? "System"
        : row.senderType === "external_projection"
          ? (externalReplyNames.get(row.messageId) ?? "External user")
          : (replySenderDisplayNames.get(row.senderId) ?? (row.senderType === "agent" ? "Agent" : "User")),
      senderAvatarUrl: isSystem
        ? null
        : row.senderType === "external_projection"
          ? (externalReplyAvatars.get(row.messageId) ?? null)
          : (replySenderAvatars.get(row.senderId) ?? null),
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    });
    latestRepliesByThreadId.set(row.threadChannelId, list);
  }
  for (const list of latestRepliesByThreadId.values()) list.sort((a, b) => a.seq - b.seq);

  for (const thread of threads) {
    if (!thread.parentMessageId) continue;
    const unread = unreadByThreadId.get(thread.threadChannelId);
    result[thread.parentMessageId] = {
      threadChannelId: thread.threadChannelId,
      replyCount: thread.replyCount,
      lastReplyAt: thread.lastReplyAt ?? null,
      participantIds: participantsByThreadId.get(thread.threadChannelId) ?? [],
      unreadCount: unread?.unreadCount ?? 0,
      firstUnreadMessageId: unread?.firstUnreadMessageId ?? null,
      latestReplies: latestRepliesByThreadId.get(thread.threadChannelId) ?? [],
    };
  }

  return result;
}

export async function getThreadSummariesForParentMessages(parentMessageIds: string[]): Promise<
  Record<string, { threadChannelId: string; replyCount: number }>
> {
  const threads = await listCanonicalThreadsForParentMessages(parentMessageIds);
  if (threads.length === 0) return {};

  const result: Record<string, { threadChannelId: string; replyCount: number }> = {};
  for (const thread of threads) {
    if (!thread.parentMessageId) continue;
    result[thread.parentMessageId] = {
      threadChannelId: thread.threadChannelId,
      replyCount: thread.replyCount,
    };
  }

  return result;
}

/**
 * Get thread info for a single parent message.
 */
export async function getThreadInfo(parentMessageId: string): Promise<{
  threadChannelId: string;
  replyCount: number;
  lastReplyAt: string | null;
  participantIds: string[];
} | null> {
  const db = getDb();
  const thread = await getCanonicalThreadForParentMessage(parentMessageId);
  if (!thread) return null;

  const participants = await db
    .select({ senderId: messages.senderId })
    .from(messages)
    .where(eq(messages.channelId, thread.threadChannelId))
    .groupBy(messages.senderId);

  return {
    threadChannelId: thread.threadChannelId,
    replyCount: thread.replyCount,
    lastReplyAt: thread.lastReplyAt ?? null,
    participantIds: participants.map(p => p.senderId),
  };
}

export async function getThreadInfoForChannel(channelId: string, parentMessageId: string): Promise<{
  threadChannelId: string;
  replyCount: number;
  lastReplyAt: string | null;
  participantIds: string[];
} | null> {
  const [thread] = await listThreadRowsForChannelView(channelId, [parentMessageId]);
  if (!thread || thread.parentMessageId !== parentMessageId) return null;

  const db = getDb();
  const participants = await db
    .select({ senderId: messages.senderId })
    .from(messages)
    .where(eq(messages.channelId, thread.storageThreadChannelId))
    .groupBy(messages.senderId);

  return {
    threadChannelId: thread.threadChannelId,
    replyCount: thread.replyCount,
    lastReplyAt: thread.lastReplyAt ?? null,
    participantIds: participants.map(p => p.senderId),
  };
}

// ── Followed threads ─────────────────────────────────────

type FollowedThreadMetadataRow = {
  threadChannelId: string;
  storageThreadChannelId: string;
  activityUpperBoundSeq?: number | string | null;
};

type FollowedThreadStatsRow = {
  threadChannelId: string;
  replyCount: number;
  lastReplyAt: string | null;
  lastReplyMessageId: string | null;
  /** Exact latest activity seq as a canonical decimal string (task #361 B1). */
  lastReplySeqExact: string | null;
  lastReplyContent: string | null;
  lastReplySenderType: string | null;
  lastReplySenderId: string | null;
  firstUnreadMessageId: string | null;
  unreadCount: number;
};

type FollowedThreadStatsSource = "rw_mv" | "pg_legacy";
type FollowedThreadStatsFallbackReason = "none" | "feature_disabled" | "history_cutoff" | "activity_upper_bound" | "rw_error" | "rw_row_mismatch";

const RISINGWAVE_FOLLOWED_THREAD_STATS_CONTRACT_VERSION = 1;
const RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW = "rw_followed_thread_stats_v1";
// This query is normally sub-100ms; 2s catches RW serving stalls without making
// the trace stream noisy during ordinary latency variance.
const RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS = 2_000;
const RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS_ENV = "RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS";
const RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP = 100;
const RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP_ENV = "RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP";
const RISINGWAVE_FOLLOWED_THREAD_STATS_QUERY_NAME = "channels.followed_threads_stats_by_threads";

type RisingWaveFollowedThreadStatsReplayQuery = {
  sql: string;
  params: string[];
  threadChannelIds: string[];
};

function followedThreadStatsTraceAttrs(
  statsSource: FollowedThreadStatsSource,
  fallbackReason: FollowedThreadStatsFallbackReason,
): TraceAttributes {
  return {
    stats_source: statsSource,
    fallback_reason: fallbackReason,
    contract_version: RISINGWAVE_FOLLOWED_THREAD_STATS_CONTRACT_VERSION,
  };
}

function recordFollowedThreadStatsBackendFailed(error: unknown) {
  addTraceEvent("followed_threads.stats_backend.failed", {
    ...followedThreadStatsTraceAttrs("rw_mv", "rw_error"),
    error_class: error instanceof Error ? error.name : typeof error,
  });
}

function recordFollowedThreadStatsRowMismatch(expectedRows: number, actualRows: number) {
  addTraceEvent("followed_threads.stats_backend.row_mismatch", {
    ...followedThreadStatsTraceAttrs("rw_mv", "rw_row_mismatch"),
    followed_threads_count: expectedRows,
    stats_rows_count: actualRows,
  });
}

function recordFollowedThreadStatsBackendSucceeded(rowCount: number) {
  addTraceEvent("followed_threads.stats_backend.succeeded", {
    ...followedThreadStatsTraceAttrs("rw_mv", "none"),
    backend: "risingwave",
    rw_followed_thread_stats_view: RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW,
    followed_threads_count: rowCount,
    stats_rows_count: rowCount,
  });
}

function getFollowedThreadStatsSlowReplayTraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS_ENV]?.trim();
  if (!raw) return RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS;
  return parsed;
}

function getFollowedThreadStatsReplayThreadCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP_ENV]?.trim();
  if (!raw) return RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP;
  return parsed;
}

function buildRisingWaveFollowedThreadStatsReplayQuery(
  serverId: string,
  userId: string,
  threadChannelIds: string[],
): RisingWaveFollowedThreadStatsReplayQuery {
  const values = threadChannelIds.map((_, index) => `($${index + 3}::varchar)`).join(", ");
  return {
    sql: `
      WITH input_threads(thread_channel_id) AS (
        VALUES ${values}
      )
      SELECT
        s.thread_channel_id::text AS "threadChannelId",
        COALESCE(s.reply_count, 0)::int AS "replyCount",
        CASE
          WHEN s.last_reply_at IS NULL THEN NULL::text
          ELSE to_char(s.last_reply_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'
        END AS "lastReplyAt",
        s.latest_message_id::text AS "lastReplyMessageId",
        -- Same tuple as lastReplyMessageId: rw_followed_thread_stats_v1 joins
        -- latest.seq = stats.latest_seq, so id and seq cannot describe
        -- different messages. Never splice these from separate sources.
        s.latest_seq::text AS "lastReplySeqExact",
        s.latest_preview AS "lastReplyContent",
        s.latest_sender_type AS "lastReplySenderType",
        s.latest_sender_id AS "lastReplySenderId",
        s.first_unread_message_id::text AS "firstUnreadMessageId",
        COALESCE(s.unread_count, 0)::int AS "unreadCount"
      FROM input_threads i
      JOIN ${RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW} s
        ON s.server_id = $1
       AND s.user_id = $2
       AND s.thread_channel_id = i.thread_channel_id
    `,
    params: [serverId, userId, ...threadChannelIds],
    threadChannelIds,
  };
}

function recordSlowRisingWaveFollowedThreadStatsReplayQuery(
  durationMs: number,
  replayQuery: RisingWaveFollowedThreadStatsReplayQuery,
  statsRowsCount: number,
): void {
  const thresholdMs = getFollowedThreadStatsSlowReplayTraceMs();
  if (durationMs < thresholdMs) return;

  const threadCap = getFollowedThreadStatsReplayThreadCap();
  const replayPayloadTruncated = replayQuery.threadChannelIds.length > threadCap;
  const stableQueryHash = createHash("sha256")
    .update(`${RISINGWAVE_FOLLOWED_THREAD_STATS_QUERY_NAME}\0${RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW}`)
    .digest("hex");
  const attrs: TraceAttributes = {
    ...followedThreadStatsTraceAttrs("rw_mv", "none"),
    backend: "risingwave",
    query_name: RISINGWAVE_FOLLOWED_THREAD_STATS_QUERY_NAME,
    query_hash: stableQueryHash,
    query_shape_hash: stableQueryHash,
    duration_ms: durationMs,
    slow_threshold_ms: thresholdMs,
    rw_followed_thread_stats_view: RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW,
    followed_threads_count: replayQuery.threadChannelIds.length,
    stats_rows_count: statsRowsCount,
    replay_sql_dialect: "risingwave_pgwire",
    replay_sql_parameterized: true,
    replay_param_count: replayQuery.params.length,
    replay_thread_cap: threadCap,
    replay_payload_truncated: replayPayloadTruncated,
    replay_contains_dsn: false,
    replay_contains_message_content: false,
    replay_connection_label: "risingwave",
  };
  if (!replayPayloadTruncated) {
    const replayParamsJson = JSON.stringify(replayQuery.params);
    attrs.replay_sql = replayQuery.sql;
    attrs.replay_params_json = replayParamsJson;
    attrs.replay_hash = createHash("sha256").update(`${replayQuery.sql}\0${replayParamsJson}`).digest("hex");
  }
  addTraceEvent("followed_threads.stats_backend.slow_replay_query", attrs);
}

async function getFollowedThreadStatsFromRisingWave(
  serverId: string,
  userId: string,
  threads: FollowedThreadMetadataRow[],
  historyCutoff: Date | undefined,
  traceQuery: DbQueryTracer,
): Promise<FollowedThreadStatsRow[] | null> {
  // CONTRACT: rw_followed_thread_stats_v1 is an endpoint-shaped serving read
  // model for GET /api/channels/threads/followed. It must return all stats
  // fields in one lookup keyed by (server_id, user_id, thread_channel_id). Do
  // not replace this with request-time joins across generic RW MVs; that shape
  // was benchmarked slower than Postgres.
  if (historyCutoff || !isRisingWaveFollowedThreadStatsEnabled()) return null;
  const client = getRisingWavePool();
  if (!client || threads.length === 0) return null;

  const threadIds = threads.map((thread) => thread.threadChannelId);
  const replayQuery = buildRisingWaveFollowedThreadStatsReplayQuery(serverId, userId, threadIds);
  const queryStart = performance.now();
  const result = await traceQuery(
    RISINGWAVE_FOLLOWED_THREAD_STATS_QUERY_NAME,
    () => client.query(replayQuery.sql, replayQuery.params),
    (queryResult) => ({
      ...followedThreadStatsTraceAttrs("rw_mv", "none"),
      backend: "risingwave",
      rw_followed_thread_stats_view: RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW,
      followed_threads_count: threads.length,
      stats_rows_count: queryResult.rows.length,
      history_cutoff_present: false,
    }),
  );
  recordSlowRisingWaveFollowedThreadStatsReplayQuery(performance.now() - queryStart, replayQuery, result.rows.length);
  return result.rows as FollowedThreadStatsRow[];
}

async function getFollowedThreadStatsFromPostgres(
  userId: string,
  threads: FollowedThreadMetadataRow[],
  historyCutoff: Date | undefined,
  traceQuery: DbQueryTracer,
  fallbackReason: FollowedThreadStatsFallbackReason,
  executor: DatabaseExecutor = getDb(),
): Promise<FollowedThreadStatsRow[]> {
  const cutoffCondition = historyCutoff ? sql` AND m.created_at > ${historyCutoff}` : sql``;

  const statsRows = await traceQuery(
    "channels.followed_threads_stats_by_threads",
    () => executor.execute(sql`
      WITH input_threads(thread_id, storage_thread_id, activity_upper_bound_seq) AS (
        VALUES ${sql.join(threads.map(t => sql`(
          ${t.threadChannelId}::uuid,
          ${t.storageThreadChannelId}::uuid,
          ${t.activityUpperBoundSeq ?? null}::bigint
        )`), sql`, `)}
      ),
      stats AS (
        SELECT
          input_threads.thread_id,
          input_threads.storage_thread_id,
          count(m.id)::int AS reply_count,
          count(m.id) FILTER (
            WHERE m.seq > COALESCE(rc.last_read_seq, 0)
              AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          )::int AS unread_count,
          max(m.seq) AS latest_seq,
          min(m.seq) FILTER (
            WHERE m.seq > COALESCE(rc.last_read_seq, 0)
              AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          ) AS first_unread_seq
        FROM input_threads
        LEFT JOIN user_channel_read_cursors rc
          ON rc.channel_id = input_threads.thread_id AND rc.user_id = ${userId}
        LEFT JOIN messages m
          ON m.channel_id = input_threads.storage_thread_id
         AND (
           input_threads.activity_upper_bound_seq IS NULL
           OR m.seq <= input_threads.activity_upper_bound_seq
         )
         ${cutoffCondition}
        GROUP BY input_threads.thread_id, input_threads.storage_thread_id
      )
      SELECT
        stats.thread_id::text AS "threadChannelId",
        COALESCE(stats.reply_count, 0)::int AS "replyCount",
        latest.created_at::text AS "lastReplyAt",
        latest.id::text AS "lastReplyMessageId",
        stats.latest_seq::text AS "lastReplySeqExact",
        latest.content AS "lastReplyContent",
        latest.sender_type AS "lastReplySenderType",
        latest.sender_id AS "lastReplySenderId",
        first_unread.id::text AS "firstUnreadMessageId",
        COALESCE(stats.unread_count, 0)::int AS "unreadCount"
      FROM stats
      LEFT JOIN messages latest
        ON latest.channel_id = stats.storage_thread_id
       AND latest.seq = stats.latest_seq
      LEFT JOIN messages first_unread
        ON first_unread.channel_id = stats.storage_thread_id
       AND first_unread.seq = stats.first_unread_seq
    `),
    (result) => ({
      ...followedThreadStatsTraceAttrs("pg_legacy", fallbackReason),
      followed_threads_count: threads.length,
      stats_rows_count: result.rows.length,
      history_cutoff_present: Boolean(historyCutoff),
    }),
  );
  return statsRows.rows as FollowedThreadStatsRow[];
}

async function getFollowedThreadStatsRows(
  serverId: string,
  userId: string,
  threads: FollowedThreadMetadataRow[],
  historyCutoff: Date | undefined,
  traceQuery: DbQueryTracer,
  executor?: DatabaseExecutor,
): Promise<FollowedThreadStatsRow[]> {
  if (executor) {
    return getFollowedThreadStatsFromPostgres(
      userId,
      threads,
      historyCutoff,
      traceQuery,
      threads.some((thread) => thread.activityUpperBoundSeq != null)
        ? "activity_upper_bound"
        : historyCutoff
          ? "history_cutoff"
          : "feature_disabled",
      executor,
    );
  }
  if (threads.some((thread) => thread.activityUpperBoundSeq != null)) {
    return getFollowedThreadStatsFromPostgres(userId, threads, historyCutoff, traceQuery, "activity_upper_bound");
  }
  if (historyCutoff) {
    return getFollowedThreadStatsFromPostgres(userId, threads, historyCutoff, traceQuery, "history_cutoff");
  }

  if (isRisingWaveFollowedThreadStatsEnabled()) {
    try {
      const risingWaveRows = await getFollowedThreadStatsFromRisingWave(serverId, userId, threads, historyCutoff, traceQuery);
      if (risingWaveRows) {
        if (risingWaveRows.length === threads.length) {
          recordFollowedThreadStatsBackendSucceeded(risingWaveRows.length);
          return risingWaveRows;
        }
        recordFollowedThreadStatsRowMismatch(threads.length, risingWaveRows.length);
        return getFollowedThreadStatsFromPostgres(userId, threads, historyCutoff, traceQuery, "rw_row_mismatch");
      }
    } catch (error) {
      recordFollowedThreadStatsBackendFailed(error);
      return getFollowedThreadStatsFromPostgres(userId, threads, historyCutoff, traceQuery, "rw_error");
    }
  }

  return getFollowedThreadStatsFromPostgres(userId, threads, historyCutoff, traceQuery, "feature_disabled");
}

/** Test-only surface for the same-source frontier rule. */
/**
 * Pair the content frontier with whichever message supplied
 * `latestActivityMessageId`, or fail closed.
 *
 * Keyed on `lastReplyMessageId` rather than `replyCount`: the id is what the
 * sibling field actually used, so keying on the same thing is what makes the two
 * provably same-source. `replyCount` can disagree with the joined row after a
 * delete and would silently re-pair a reply id with a parent seq.
 */
function latestActivitySeqSameSource(
  stats: { lastReplyMessageId: string | null; lastReplySeqExact: string | null } | undefined,
  parentMessageSeq: number | string | null | undefined,
): string | null {
  if (stats?.lastReplyMessageId != null) {
    // Fail closed on a NONCANONICAL value too, not only a missing one. A
    // selected message with a seq the contract cannot represent must not be
    // published as a frontier: UInt64String is what the Done intent validates
    // against, so a partial/odd value would either be rejected downstream or
    // compare wrongly in compareUInt64String (which keys on string length).
    return canonicalUint64OrNull(stats.lastReplySeqExact);
  }
  return canonicalUint64OrNull(parentMessageSeq);
}

/** Canonical decimal UInt64String, or null. Never a coerced/partial value. */
function canonicalUint64OrNull(value: number | string | null | undefined): string | null {
  if (value == null) return null;
  // Numbers arrive from some drivers; reject anything not an exact non-negative
  // integer rather than stringifying a float or a rounded >2^53 value.
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return String(value);
  }
  return /^(0|[1-9][0-9]*)$/.test(value) ? value : null;
}

export const __testFollowedThreadFrontier = { latestActivitySeqSameSource };

/** Test-only surface for the read-state authority query's own safety contract. */
export const __testReadStateAuthority = { fetchReadStateAuthorityRows };

// Inbox residue (follow, done, notified mention) is not access authority.
// Resolve the shared guest policy before SQL pagination. null means the
// ordinary-member policy; [] means a guest with no readable channels.
async function guestInboxChannelIds(serverId: string, userId: string, executor: DatabaseExecutor): Promise<string[] | null> {
  if (await resolveHumanServerRole(serverId, userId, executor) !== "guest") return null;
  const gateEnabled = await isGuestFeatureEnabled(serverId, userId, executor);
  if (!gateEnabled) return [];
  const rows = await executor.select({ channel: channels, memberId: channelHumans.userId, parentChannelId: messages.channelId })
    .from(channels).leftJoin(channelHumans, and(
      eq(channelHumans.channelId, channels.id), eq(channelHumans.userId, userId),
    )).leftJoin(messages, eq(messages.id, channels.parentMessageId)).where(and(eq(channels.serverId, serverId), isNull(channels.deletedAt)));
  const readable = rows.filter(({ channel, memberId }) => canGuestReadChannel({
    gateEnabled, serverRole: "guest", channelType: channel.type, channelName: channel.name,
    allChannelHidden: isAllSystemChannel(channel) && !isEnabledAllChannel(channel),
    guestVisible: channel.guestVisible, guestJoinable: channel.guestJoinable,
    isChannelMember: memberId !== null, archived: channel.archivedAt !== null, deleted: false,
  })).map(({ channel }) => channel.id);
  const parents = new Set(readable);
  return [...readable, ...rows.filter(({ channel, parentChannelId }) =>
    channel.type === "thread" && parentChannelId !== null && parents.has(parentChannelId),
  ).map(({ channel }) => channel.id)];
}

function guestInboxAccessSql(ids: string[] | null, channelId: SQL): SQL {
  return ids === null ? sql`true` : ids.length === 0 ? sql`false`
    : sql`${channelId} IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`;
}

/** Get all threads a user participates in, with unread counts and parent message info. */
export async function getFollowedThreads(
  serverId: string,
  userId: string,
  historyCutoff?: Date,
  opts?: FollowedThreadsOptions,
): Promise<Array<{
  threadChannelId: string;
  parentMessageId: string;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: string;
  parentMessagePreview: string;
  parentMessageSenderType: string;
  parentMessageSenderId: string;
  latestActivityPreview: string;
  latestActivitySenderType: string;
  latestActivitySenderId: string;
  latestActivitySenderName: string | null;
  latestActivityMessageId: string;
  latestActivitySeq: string | null;
  firstUnreadMessageId: string | null;
  lastActivityAt: string;
  replyCount: number;
  lastReplyAt: string | null;
  unreadCount: number;
  taskId: string | null;
  taskNumber: number | null;
  taskStatus: string | null;
  taskClaimedByType: "agent" | "user" | null;
  taskClaimedById: string | null;
  taskClaimedByName: string | null;
  maxReadSeq: number;
  readStateVersion: number;
  readState: InboxScopeReadFrontier;
  doneAt: string | null;
  isFollowing: boolean;
  unfollowedAt: string | null;
}>> {
  const db = opts?.executor ?? getDb();
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;
  const guestAccess = await guestInboxChannelIds(serverId, userId, db);
  const state = opts?.state ?? "active";
  const searchPattern = opts?.q ? `%${opts.q}%` : null;
  const doneCondition = state === "done"
    ? isNotNull(threadFollows.doneAt)
    : state === "active" || state === "unfollowed_active"
      ? isNull(threadFollows.doneAt)
      : undefined;
  const followCondition = state === "unfollowed" || state === "unfollowed_active"
    ? isNotNull(threadFollows.unfollowedAt)
    : state === "done"
      ? undefined
      : isNull(threadFollows.unfollowedAt);

  // Find thread channels the user follows (via threadFollows)
  const parentMessages = alias(messages, "parent_msg");
  const parentChannels = alias(channels, "parent_ch");
  const parentChannelHumans = alias(channelHumans, "parent_channel_humans");

  const regularThreadsQuery = db
      .select({
        threadChannelId: channels.id,
        storageThreadChannelId: channels.id,
        parentMessageId: channels.parentMessageId,
        parentChannelId: parentMessages.channelId,
        parentChannelName: parentChannels.name,
        parentChannelType: parentChannels.type,
        parentMessageContent: parentMessages.content,
        parentMessageCreatedAt: parentMessages.createdAt,
        parentMessageSenderType: parentMessages.senderType,
        parentMessageSenderId: parentMessages.senderId,
        parentMessageSeq: sql<string>`${parentMessages.seq}::text`,
        taskId: tasks.id,
        taskNumber: tasks.taskNumber,
        taskStatus: tasks.status,
        taskClaimedByType: tasks.claimedByType,
        taskClaimedById: tasks.claimedById,
        doneAt: threadFollows.doneAt,
        unfollowedAt: threadFollows.unfollowedAt,
        activityUpperBoundSeq: sql<number>`COALESCE(${inboxSuppressionStates.doneThroughSeq}, 0)`,
      })
      .from(threadFollows)
      .innerJoin(channels, and(
        eq(threadFollows.threadChannelId, channels.id),
        eq(channels.type, "thread"),
        isNull(channels.deletedAt),
      ))
      .innerJoin(parentMessages, eq(channels.parentMessageId, parentMessages.id))
      .innerJoin(parentChannels, eq(parentMessages.channelId, parentChannels.id))
      .leftJoin(parentChannelHumans, and(
        eq(parentChannelHumans.channelId, parentChannels.id),
        eq(parentChannelHumans.userId, userId),
      ))
      .leftJoin(tasks, eq(tasks.messageId, parentMessages.id))
      .leftJoin(inboxSuppressionStates, and(
        eq(inboxSuppressionStates.receiverType, "user"),
        eq(inboxSuppressionStates.receiverId, userId),
        // Ordinary replies clear the followed-thread done projection, but the
        // paired mention suppression retains the exact sequence written by
        // explicit unfollow and is therefore the durable history boundary.
        eq(inboxSuppressionStates.targetKind, "public_thread_mention"),
        eq(inboxSuppressionStates.targetChannelId, channels.id),
      ))
      .where(and(
        eq(threadFollows.followerType, "user"),
        eq(threadFollows.followerId, userId),
        doneCondition,
        followCondition,
        eq(parentChannels.serverId, serverId),
        guestInboxAccessSql(guestAccess, sql`${parentChannels.id}`),
        isNull(parentChannels.archivedAt),
        sql`(${parentChannels.type} = 'channel' OR ${parentChannelHumans.userId} IS NOT NULL)`,
        opts?.channelId ? eq(parentMessages.channelId, opts.channelId) : undefined,
        searchPattern
          ? sql`(
              ${parentChannels.name} ILIKE ${searchPattern}
              OR ${parentMessages.content} ILIKE ${searchPattern}
              OR EXISTS (
                SELECT 1
                FROM messages search_message
                LEFT JOIN users search_user
                  ON search_message.sender_type = 'user'
                 AND search_user.id::text = search_message.sender_id
                LEFT JOIN agents search_agent
                  ON search_message.sender_type = 'agent'
                 AND search_agent.id::text = search_message.sender_id
                WHERE search_message.channel_id = ${channels.id}
                  ${state === "unfollowed"
                    ? sql`AND search_message.seq <= COALESCE(${inboxSuppressionStates.doneThroughSeq}, 0)`
                    : sql``}
                  AND (
                    search_message.content ILIKE ${searchPattern}
                    OR COALESCE(search_user.display_name, search_user.name, search_agent.display_name, search_agent.name, '') ILIKE ${searchPattern}
                  )
              )
            )`
          : undefined,
      ));
  const regularThreads = await traceQuery(
    "channels.followed_threads_by_user",
    () => state === "done" || state === "unfollowed"
      ? regularThreadsQuery
          .orderBy(
            state === "done"
              ? opts?.sort === "asc" ? asc(threadFollows.doneAt) : desc(threadFollows.doneAt)
              : opts?.sort === "asc" ? asc(threadFollows.unfollowedAt) : desc(threadFollows.unfollowedAt),
            opts?.sort === "asc" ? asc(threadFollows.threadChannelId) : desc(threadFollows.threadChannelId),
          )
          .limit(opts?.maxRows ?? 101)
      : regularThreadsQuery,
  );
  const jointThreadRows = await traceQuery(
    "channels.followed_joint_threads_by_user",
    () => db.execute(sql`
      SELECT
        local_thread.id::text AS "threadChannelId",
        canonical_thread.id::text AS "storageThreadChannelId",
        canonical_thread.parent_message_id::text AS "parentMessageId",
        local_parent.id::text AS "parentChannelId",
        local_parent.name AS "parentChannelName",
        local_parent.type AS "parentChannelType",
        parent_msg.content AS "parentMessageContent",
        parent_msg.created_at AS "parentMessageCreatedAt",
        parent_msg.sender_type AS "parentMessageSenderType",
        parent_msg.sender_id AS "parentMessageSenderId",
        -- Same parent_msg row that supplies parentMessageId (joined on
        -- canonical_thread.parent_message_id), so the zero-reply fallback pairs
        -- id and seq from one tuple. Cast to text because messages.seq is a
        -- bigint: a JS number would round past 2^53 before this code saw it.
        -- Without this column the joint arm returned undefined and every joint
        -- zero-reply thread failed closed to a null frontier. (@赵梓淇.)
        parent_msg.seq::text AS "parentMessageSeq",
        legacy_task.id::text AS "taskId",
        legacy_task.task_number AS "taskNumber",
        legacy_task.status AS "taskStatus",
        legacy_task.claimed_by_type AS "taskClaimedByType",
        legacy_task.claimed_by_id AS "taskClaimedById",
        tf.done_at AS "doneAt",
        tf.unfollowed_at AS "unfollowedAt",
        COALESCE(suppression.done_through_seq, 0) AS "activityUpperBoundSeq"
      FROM ${threadFollows} tf
      INNER JOIN ${channels} local_thread
        ON local_thread.id = tf.thread_channel_id
       AND local_thread.type = 'thread'
       AND local_thread.server_id = ${serverId}
       AND local_thread.deleted_at IS NULL
      INNER JOIN ${jointChannelServers} thread_projection
        ON thread_projection.local_channel_id = local_thread.id
       AND thread_projection.server_id = ${serverId}
       AND thread_projection.status = 'active'
      INNER JOIN ${jointChannels} thread_joint
        ON thread_joint.id = thread_projection.joint_channel_id
       AND thread_joint.status = 'active'
      INNER JOIN ${channels} canonical_thread
        ON canonical_thread.id = thread_joint.canonical_channel_id
       AND canonical_thread.type = 'thread'
       AND canonical_thread.deleted_at IS NULL
      INNER JOIN ${messages} parent_msg
        ON parent_msg.id = canonical_thread.parent_message_id
      INNER JOIN ${jointChannels} parent_joint
        ON parent_joint.canonical_channel_id = parent_msg.channel_id
       AND parent_joint.status = 'active'
      INNER JOIN ${jointChannelServers} parent_projection
        ON parent_projection.joint_channel_id = parent_joint.id
       AND parent_projection.server_id = ${serverId}
       AND parent_projection.status = 'active'
      INNER JOIN ${channels} local_parent
        ON local_parent.id = parent_projection.local_channel_id
       AND local_parent.type = 'joint'
       AND local_parent.archived_at IS NULL
       AND local_parent.deleted_at IS NULL
      INNER JOIN ${channelHumans} parent_member
        ON parent_member.channel_id = local_parent.id
       AND parent_member.user_id = ${userId}
      LEFT JOIN ${tasks} legacy_task
        ON legacy_task.message_id = parent_msg.id
      LEFT JOIN ${inboxSuppressionStates} suppression
        ON suppression.receiver_type = 'user'
       AND suppression.receiver_id = ${userId}::uuid
       AND suppression.target_kind = 'public_thread_mention'
       AND suppression.target_channel_id = local_thread.id
      WHERE ${guestInboxAccessSql(guestAccess, sql`local_parent.id`)}
        AND tf.follower_type = 'user'
        AND tf.follower_id = ${userId}
        AND ${state === "done"
          ? sql`tf.done_at IS NOT NULL`
          : state === "active" || state === "unfollowed_active"
            ? sql`tf.done_at IS NULL`
            : sql`TRUE`}
        AND ${state === "unfollowed" || state === "unfollowed_active"
          ? sql`tf.unfollowed_at IS NOT NULL`
          : state === "done"
            ? sql`TRUE`
            : sql`tf.unfollowed_at IS NULL`}
        ${opts?.channelId ? sql`AND local_parent.id = ${opts.channelId}::uuid` : sql``}
        ${searchPattern ? sql`AND (
          local_parent.name ILIKE ${searchPattern}
          OR parent_msg.content ILIKE ${searchPattern}
          OR EXISTS (
            SELECT 1
            FROM messages search_message
            LEFT JOIN users search_user
              ON search_message.sender_type = 'user'
             AND search_user.id::text = search_message.sender_id
            LEFT JOIN agents search_agent
              ON search_message.sender_type = 'agent'
             AND search_agent.id::text = search_message.sender_id
            WHERE search_message.channel_id = canonical_thread.id
              ${state === "unfollowed"
                ? sql`AND search_message.seq <= COALESCE(suppression.done_through_seq, 0)`
                : sql``}
              AND (
                search_message.content ILIKE ${searchPattern}
                OR COALESCE(search_user.display_name, search_user.name, search_agent.display_name, search_agent.name, '') ILIKE ${searchPattern}
              )
          )
        )` : sql``}
      ${state === "done" || state === "unfollowed"
        ? sql`ORDER BY ${state === "done" ? sql`tf.done_at` : sql`tf.unfollowed_at`} ${opts?.sort === "asc" ? sql`ASC` : sql`DESC`}, tf.thread_channel_id ${opts?.sort === "asc" ? sql`ASC` : sql`DESC`} LIMIT ${opts?.maxRows ?? 101}`
        : sql``}
    `),
  );
  const threads = [
    ...regularThreads,
    ...(jointThreadRows.rows as any[]).map((row) => ({
      ...row,
      parentMessageCreatedAt: new Date(row.parentMessageCreatedAt),
      unfollowedAt: row.unfollowedAt ? new Date(row.unfollowedAt) : null,
      activityUpperBoundSeq: row.activityUpperBoundSeq == null ? null : Number(row.activityUpperBoundSeq),
    })),
  ];

  if (threads.length === 0) return [];

  const statsRows = await getFollowedThreadStatsRows(
    serverId,
    userId,
    threads.map((thread) => ({
      ...thread,
      activityUpperBoundSeq: state === "unfollowed" ? thread.activityUpperBoundSeq : null,
    })),
    historyCutoff,
    traceQuery,
    opts?.executor,
  );

  const statsMap = new Map<string, {
    replyCount: number;
    lastReplyAt: string | null;
    lastReplyMessageId: string | null;
    lastReplySeqExact: string | null;
    lastReplyContent: string | null;
    lastReplySenderType: string | null;
    lastReplySenderId: string | null;
    firstUnreadMessageId: string | null;
    unreadCount: number;
  }>();
  for (const row of statsRows) {
    statsMap.set(row.threadChannelId, {
      replyCount: row.replyCount,
      lastReplyAt: row.lastReplyAt,
      lastReplyMessageId: row.lastReplyMessageId ?? null,
      lastReplySeqExact: row.lastReplySeqExact ?? null,
      lastReplyContent: row.lastReplyContent ?? null,
      lastReplySenderType: row.lastReplySenderType ?? null,
      lastReplySenderId: row.lastReplySenderId ?? null,
      firstUnreadMessageId: row.firstUnreadMessageId ?? null,
      unreadCount: row.unreadCount,
    });
  }

  // Batch-resolve task claimant names
  const claimantNameMap = new Map<string, string>();
  const agentClaimantIds = threads.filter(t => t.taskClaimedByType === "agent" && t.taskClaimedById).map(t => t.taskClaimedById!);
  const userClaimantIds = threads.filter(t => t.taskClaimedByType === "user" && t.taskClaimedById).map(t => t.taskClaimedById!);
  if (agentClaimantIds.length > 0) {
    const agentRows = await traceQuery(
      "channels.followed_threads.agent_claimants",
      () => db.select({ id: agents.id, name: agents.name }).from(agents).where(sql`${agents.id} IN (${sql.join(agentClaimantIds.map(id => sql`${id}`), sql`, `)})`),
      (rows) => ({
        input_count: agentClaimantIds.length,
        claimants_count: rows.length,
      }),
    );
    for (const a of agentRows) claimantNameMap.set(a.id, a.name);
  }
  if (userClaimantIds.length > 0) {
    const userRows = await traceQuery(
      "channels.followed_threads.user_claimants",
      () => db.select({ id: users.id, name: users.name, displayName: users.displayName }).from(users).where(sql`${users.id} IN (${sql.join(userClaimantIds.map(id => sql`${id}`), sql`, `)})`),
      (rows) => ({
        input_count: userClaimantIds.length,
        claimants_count: rows.length,
      }),
    );
    for (const u of userRows) claimantNameMap.set(u.id, u.displayName || u.name);
  }

  const readStates = await attachReadState(
    threads.map((thread) => ({ id: thread.threadChannelId })),
    userId,
    db,
  );
  const readStateByThread = new Map(readStates.map((state) => [state.id, state]));

  const externalLatestMessageIds = threads.flatMap((thread) => {
    const stats = statsMap.get(thread.threadChannelId);
    const senderType = stats?.lastReplySenderType ?? thread.parentMessageSenderType;
    const messageId = stats?.lastReplyMessageId ?? thread.parentMessageId;
    return senderType === "external_projection" && messageId ? [messageId] : [];
  });
  const externalLatestNameByMessageId = new Map<string, string>();
  if (externalLatestMessageIds.length > 0) {
    const externalRows = await traceQuery(
      "channels.followed_threads.external_projection_names",
      () => db
        .select({ messageId: externalMessageAuthorFacts.messageId, displayName: externalMessageAuthorFacts.displayName })
        .from(externalMessageAuthorFacts)
        .where(inArray(externalMessageAuthorFacts.messageId, externalLatestMessageIds)),
      (rows) => ({ input_count: externalLatestMessageIds.length, result_count: rows.length }),
    );
    for (const row of externalRows) externalLatestNameByMessageId.set(row.messageId, row.displayName);
    if (externalLatestNameByMessageId.size !== new Set(externalLatestMessageIds).size) {
      throw new Error("External projection followed-thread row is missing immutable author fact");
    }
  }

  const result = threads.map(t => {
    const stats = statsMap.get(t.threadChannelId);
    const readState = readStateByThread.get(t.threadChannelId);
    const latestActivityContent = stats?.lastReplyContent ?? t.parentMessageContent;
    return {
      threadChannelId: t.threadChannelId,
      parentMessageId: t.parentMessageId!,
      parentChannelId: t.parentChannelId,
      parentChannelName: t.parentChannelName,
      parentChannelType: t.parentChannelType,
      parentMessagePreview: t.parentMessageContent.length > 100
        ? t.parentMessageContent.slice(0, 100) + "…"
        : t.parentMessageContent,
      parentMessageSenderType: t.parentMessageSenderType,
      parentMessageSenderId: t.parentMessageSenderId,
      latestActivityPreview: latestActivityContent.length > 140
        ? latestActivityContent.slice(0, 140) + "…"
        : latestActivityContent,
      latestActivitySenderType: stats?.lastReplySenderType ?? t.parentMessageSenderType,
      latestActivitySenderId: stats?.lastReplySenderId ?? t.parentMessageSenderId,
      latestActivitySenderName: externalLatestNameByMessageId.get(stats?.lastReplyMessageId ?? t.parentMessageId!) ?? null,
      latestActivityMessageId: stats?.lastReplyMessageId ?? t.parentMessageId!,
      // Same-source frontier, paired with latestActivityMessageId above. This is
      // the PRODUCTION call site: the helper existing and being unit-tested
      // proves nothing about /threads/followed unless the result uses it.
      latestActivitySeq: latestActivitySeqSameSource(stats, t.parentMessageSeq),
      firstUnreadMessageId: stats?.firstUnreadMessageId ?? null,
      lastActivityAt: stats?.lastReplyAt ?? t.parentMessageCreatedAt.toISOString(),
      replyCount: stats?.replyCount ?? 0,
      lastReplyAt: stats?.lastReplyAt ?? null,
      unreadCount: stats?.unreadCount ?? 0,
      taskId: t.taskId,
      taskNumber: t.taskNumber,
      taskStatus: t.taskStatus,
      taskClaimedByType: t.taskClaimedByType,
      taskClaimedById: t.taskClaimedById,
      taskClaimedByName: t.taskClaimedById ? (claimantNameMap.get(t.taskClaimedById) ?? null) : null,
      maxReadSeq: readState?.maxReadSeq ?? 0,
      readStateVersion: readState?.readStateVersion ?? 0,
      // #632 SSOT: the union must survive this manual map — the absent
      // fallback still goes through the shared constructor.
      readState: readState?.readState ?? makeInboxScopeReadFrontier(null),
      doneAt: t.doneAt ? new Date(t.doneAt).toISOString() : null,
      isFollowing: !t.unfollowedAt,
      unfollowedAt: t.unfollowedAt ? new Date(t.unfollowedAt).toISOString() : null,
    };
  });

  // Active follows are ordered by activity; Done history is ordered by the
  // explicit completion time so restoring an older item is deterministic.
  result.sort((a, b) => {
    if (state === "done" || state === "unfollowed") {
      const leftStateAt = state === "done" ? a.doneAt : a.unfollowedAt;
      const rightStateAt = state === "done" ? b.doneAt : b.unfollowedAt;
      const delta = new Date(leftStateAt ?? 0).getTime() - new Date(rightStateAt ?? 0).getTime();
      if (delta !== 0) return opts?.sort === "asc" ? delta : -delta;
      const identityDelta = a.threadChannelId.localeCompare(b.threadChannelId);
      return opts?.sort === "asc" ? identityDelta : -identityDelta;
    }
    return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
  });

  return result;
}

export type InboxFilter = "all" | "unread" | "mentions" | "unread_mentions";

export type InboxGroupCount = {
  channelId: string;
  channelName: string;
  channelType: "channel" | "private" | "joint" | "dm";
  count: number;
  lastActivityAt: string;
};

// CONTRACT: InboxItem is the API-visible row shape that both the canonical
// inline Postgres SQL below and rw_inbox_items_v2 must produce after
// page-bounded enrichment. SYNC REQUIRED: if any field name, type, nullability,
// or semantics changes here, update the inline SQL in getInboxItems,
// infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql, and run:
// pnpm --filter @botiverse/raft-server risingwave:verify-inbox-parity
export type InboxItem =
  | {
      kind: "channel" | "dm";
      channelId: string;
      channelName: string;
      channelType: "channel" | "private" | "joint" | "dm";
      lastMessageId: string;
      latestActivitySeq: string | null;
      /** Guard-domain frontier on active Inbox rows; history may omit it. */
      doneFrontierSeq?: string | null;
      firstUnreadMessageId: string | null;
      firstMentionMessageId: string | null;
      lastMessageAt: string;
      lastMessagePreview: string;
      lastMessageSenderType: string;
      lastMessageSenderId: string;
      lastMessageSenderName: string | null;
      unreadCount: number;
      hasMention: boolean;
      maxReadSeq?: number;
      readStateVersion?: number;
      /**
       * SSOT per-scope read state union (#632) — always set on the ACTIVE
       * /channels/inbox serving path (every backend). Done/unfollowed history
       * surfaces do not adjudicate read state and may omit it.
       */
      readState?: InboxScopeReadFrontier;
      doneAt?: string | null;
    }
  | {
      kind: "thread";
      threadChannelId: string;
      parentMessageId: string;
      parentChannelId: string;
      parentChannelName: string;
      parentChannelType: string;
      parentMessagePreview: string;
      parentMessageSenderType: string;
      parentMessageSenderId: string;
      latestActivityPreview: string;
      latestActivitySenderType: string;
      latestActivitySenderId: string;
      latestActivitySenderName: string | null;
      latestActivityMessageId: string;
      latestActivitySeq: string | null;
      /** Guard-domain frontier on active Inbox rows; history may omit it. */
      doneFrontierSeq?: string | null;
      firstUnreadMessageId: string | null;
      firstMentionMessageId: string | null;
      lastActivityAt: string;
      lastReplyAt: string | null;
      replyCount: number;
      unreadCount: number;
      hasMention: boolean;
      taskNumber: number | null;
      taskStatus: string | null;
      taskClaimedByName: string | null;
      maxReadSeq?: number;
      readStateVersion?: number;
      /**
       * SSOT per-scope read state union (#632) — always set on the ACTIVE
       * /channels/inbox serving path (every backend). Done/unfollowed history
       * surfaces do not adjudicate read state and may omit it.
       */
      readState?: InboxScopeReadFrontier;
      doneAt?: string | null;
      isFollowing?: boolean;
      unfollowedAt?: string | null;
    };

function readInboxGroupCounts(rows: readonly QueryResultRow[]): InboxGroupCount[] {
  const row = rows[0] as Record<string, unknown> | undefined;
  const ids = Array.isArray(row?.groupChannelIds) ? row.groupChannelIds : [];
  const names = Array.isArray(row?.groupChannelNames) ? row.groupChannelNames : [];
  const types = Array.isArray(row?.groupChannelTypes) ? row.groupChannelTypes : [];
  const counts = Array.isArray(row?.groupCounts) ? row.groupCounts : [];
  const lastActivityAts = Array.isArray(row?.groupLastActivityAts) ? row.groupLastActivityAts : [];
  const groups: InboxGroupCount[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const channelId = ids[index];
    const channelName = names[index];
    const channelType = types[index];
    const count = Number(counts[index]);
    const lastActivityValue = lastActivityAts[index];
    const lastActivityDate = lastActivityValue instanceof Date
      ? lastActivityValue
      : typeof lastActivityValue === "string"
        ? new Date(lastActivityValue)
        : null;
    if (
      typeof channelId !== "string" ||
      typeof channelName !== "string" ||
      (channelType !== "channel" && channelType !== "private" && channelType !== "joint" && channelType !== "dm") ||
      !Number.isFinite(count) ||
      count <= 0 ||
      !lastActivityDate ||
      !Number.isFinite(lastActivityDate.getTime())
    ) continue;
    groups.push({ channelId, channelName, channelType, count, lastActivityAt: lastActivityDate.toISOString() });
  }
  return groups;
}

type DoneChannelInboxRow = {
  kind: string;
  channelId: string;
  channelName: string | null;
  channelType: "channel" | "private" | "joint" | "dm";
  lastMessageId: string;
  lastMessageSeq: string;
  lastMessageAt: string | Date;
  lastMessagePreview: string | null;
  lastMessageSenderType: string;
  lastMessageSenderId: string;
  doneAt: string | Date;
};

async function attachReadStateToInboxItems(
  items: InboxItem[],
  userId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<InboxItem[]> {
  const scopeIds = items
    .map((item) => item.kind === "thread" ? item.threadChannelId : item.channelId)
    .filter((id, index, list) => list.indexOf(id) === index);
  if (scopeIds.length === 0) return items;
  const states = await executor
    .select({
      channelId: userChannelReadCursors.channelId,
      maxReadSeq: userChannelReadCursors.lastReadSeq,
      readStateVersion: userChannelReadCursors.readStateVersion,
    })
    .from(userChannelReadCursors)
    .where(and(
      eq(userChannelReadCursors.userId, userId),
      inArray(userChannelReadCursors.channelId, scopeIds),
    ));
  const stateByChannel = new Map(states.map((state) => [state.channelId, state]));
  return items.map((item) => {
    const scopeId = item.kind === "thread" ? item.threadChannelId : item.channelId;
    const state = stateByChannel.get(scopeId);
    return {
      ...item,
      maxReadSeq: state?.maxReadSeq ?? 0,
      readStateVersion: state?.readStateVersion ?? 0,
    } as InboxItem;
  });
}

/**
 * The one corruption sink every /channels/inbox backend wires as onCorrupt:
 * exactly one stable line per corrupt scope (shape frozen in the shared
 * contract). Callback failure isolation lives inside the shared total
 * constructor — this sink deliberately adds no try/catch of its own.
 */
function logInboxScopeCorruption(scopeId: string, corruption: InboxScopeCursorCorruption): void {
  console.error(formatInboxScopeCorruptionLine(scopeId, corruption));
}

/**
 * Enrich PG-path inbox page rows with the read-cursor triple AND the union
 * frontier pair from the SINGLE authority read (#632 SSOT — the same
 * fetchReadStateAuthorityRows the list/DM/thread and unread exits use, so the
 * same scope yields the identical union here as there):
 *   - readCursorPresent/readStateVersion/maxReadSeq: structural presence plus
 *     NULL-preserved cursor values.
 *   - readStateActivityMessageId/readStateActivitySeq: latest message of the
 *     scope's OWN storage channel (NULL for a zero-reply thread). Kept in
 *     DEDICATED fields: the row's latestActivityMessageId/latestActivitySeq
 *     stay the serving query's display pair, which deliberately keeps the
 *     zero-reply parent fallback the sync serializer requires — and which
 *     would be wrong for adjudication anyway (the parent seq lives in a
 *     different seq domain than the scope's cursor).
 * RW rows carry their own cursor_v2 fields and never come through here (the
 * RW offload is preserved).
 */
async function enrichInboxRowsWithReadCursorAuthority(
  rows: readonly InboxPolicySqlRow[],
  userId: string,
  traceQuery: DbQueryTracer,
  executor: DatabaseExecutor = getDb(),
): Promise<void> {
  const scopeIds = [...new Set(
    rows.map((row) => inboxScopeIdOfRow(row)).filter((id): id is string => id !== null),
  )];
  if (scopeIds.length === 0) return;
  const authorityRows = await fetchReadStateAuthorityRows(
    scopeIds,
    userId,
    traceQuery,
    "channels.inbox_read_state_authority",
    executor,
  );
  const authorityByScope = new Map(authorityRows.map((row) => [row.channelId, row]));
  for (const row of rows) {
    const scopeId = inboxScopeIdOfRow(row);
    const authority = scopeId === null ? undefined : authorityByScope.get(scopeId);
    row.readCursorPresent = authority?.readCursorPresent === true;
    row.readStateVersion = authority?.readStateVersion ?? null;
    row.maxReadSeq = authority?.maxReadSeq ?? null;
    row.readStateActivityMessageId = authority?.latestActivityMessageId ?? null;
    row.readStateActivitySeq = authority?.latestActivitySeq ?? null;
    row.doneFrontierSeq = authority?.doneFrontierSeq ?? null;
  }
}

function inboxScopeIdOfRow(row: InboxPolicySqlRow): string | null {
  const value = row.kind === "thread" ? row.threadChannelId : row.channelId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read durable Done history from Postgres. This intentionally stays separate
 * from the active Inbox serving path: Done history is a lower-volume view and
 * must not widen the RisingWave active-row contract.
 */
export async function getDoneInboxItems(
  serverId: string,
  userId: string,
  opts: {
    limit?: number;
    offset?: number;
    historyCutoff?: Date;
    channelId?: string;
    q?: string;
    sort?: "asc" | "desc";
    traceQuery?: DbQueryTracer;
  } = {},
): Promise<{ items: InboxItem[]; hasMore: boolean; totalCount: null }> {
  const db = getDb();
  const guestAccess = await guestInboxChannelIds(serverId, userId, db);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const fetchLimit = limit + offset + 1;
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const historyCutoff = opts.historyCutoff;
  const searchPattern = opts.q ? `%${opts.q}%` : null;
  const sortDirection = opts.sort === "asc" ? sql`ASC` : sql`DESC`;

  // Resolve the caller's local server namespace to canonical message storage
  // before reading messages. In particular, a joint channel's local projection
  // is the access authority while its canonical channel owns the message rows.
  const messageStorageChannelIds = await traceQuery(
    "channels.done_inbox_message_storage_scopes",
    () => resolveServerMessageStorageChannelIds(serverId, db),
    (rows) => ({ storage_scope_count: rows.length }),
  );

  const channelRows = messageStorageChannelIds.length === 0
    ? { rows: [] }
    : await traceQuery(
      "channels.done_inbox_channels_by_user",
      () => db.execute(sql`
      SELECT
        c.type::text AS "kind",
        c.id::text AS "channelId",
        c.name AS "channelName",
        c.type::text AS "channelType",
        latest.id::text AS "lastMessageId",
        latest.seq::text AS "lastMessageSeq",
        latest.created_at AS "lastMessageAt",
        latest.content AS "lastMessagePreview",
        latest.sender_type AS "lastMessageSenderType",
        latest.sender_id::text AS "lastMessageSenderId",
        state.done_at AS "doneAt"
      FROM ${userChannelInboxStates} state
      INNER JOIN ${channels} c
        ON c.id = state.channel_id
       AND c.type <> 'thread'
       AND c.deleted_at IS NULL
       AND c.archived_at IS NULL
      LEFT JOIN ${channelHumans} member
        ON member.channel_id = c.id
       AND member.user_id = ${userId}
      LEFT JOIN ${jointChannelServers} projection
        ON projection.local_channel_id = c.id
       AND projection.server_id = ${serverId}
       AND projection.status = 'active'
      LEFT JOIN ${jointChannels} joint
        ON joint.id = projection.joint_channel_id
       AND joint.status = 'active'
      INNER JOIN LATERAL (
        SELECT m.id, m.seq, m.created_at, m.content, m.sender_type, m.sender_id
        FROM ${messages} m
        WHERE m.channel_id = COALESCE(joint.canonical_channel_id, c.id)
          ${historyCutoff ? sql`AND m.created_at >= ${historyCutoff}` : sql``}
        ORDER BY m.seq DESC
        LIMIT 1
      ) latest ON true
      WHERE state.user_id = ${userId}
        AND ${guestInboxAccessSql(guestAccess, sql`c.id`)}
        AND state.done_at IS NOT NULL
        ${opts.channelId ? sql`AND c.id = ${opts.channelId}::uuid` : sql``}
        ${searchPattern ? sql`AND (
          c.name ILIKE ${searchPattern}
          OR latest.content ILIKE ${searchPattern}
          OR EXISTS (
            SELECT 1
            FROM users search_user
            WHERE latest.sender_type = 'user'
              AND search_user.id::text = latest.sender_id
              AND COALESCE(search_user.display_name, search_user.name) ILIKE ${searchPattern}
          )
          OR EXISTS (
            SELECT 1
            FROM agents search_agent
            WHERE latest.sender_type = 'agent'
              AND search_agent.id::text = latest.sender_id
              AND COALESCE(search_agent.display_name, search_agent.name) ILIKE ${searchPattern}
          )
        )` : sql``}
        AND COALESCE(joint.canonical_channel_id, c.id) IN (${sql.join(messageStorageChannelIds.map((id) => sql`${id}`), sql`, `)})
        AND (c.type = 'channel' OR member.user_id IS NOT NULL)
      ORDER BY state.done_at ${sortDirection}, c.id ${sortDirection}
      LIMIT ${fetchLimit}
    `),
    );

  const channelItems = (channelRows.rows as DoneChannelInboxRow[]).map((row) => ({
    kind: row.kind === "dm" ? "dm" as const : "channel" as const,
    channelId: String(row.channelId),
    channelName: String(row.channelName ?? ""),
    channelType: row.channelType as "channel" | "private" | "joint" | "dm",
    lastMessageId: String(row.lastMessageId),
    latestActivitySeq: row.lastMessageSeq,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: new Date(row.lastMessageAt as string | Date).toISOString(),
    lastMessagePreview: String(row.lastMessagePreview ?? ""),
    lastMessageSenderType: String(row.lastMessageSenderType),
    lastMessageSenderId: String(row.lastMessageSenderId),
    lastMessageSenderName: null,
    unreadCount: 0,
    hasMention: false,
    doneAt: new Date(row.doneAt as string | Date).toISOString(),
  })) satisfies InboxItem[];

  const followedThreads = await getFollowedThreads(serverId, userId, historyCutoff, {
    state: "done",
    maxRows: fetchLimit,
    channelId: opts.channelId,
    q: opts.q,
    sort: opts.sort,
    traceQuery,
  });
  const threadItems = followedThreads.map((thread): InboxItem => ({
    kind: "thread",
    threadChannelId: thread.threadChannelId,
    parentMessageId: thread.parentMessageId,
    parentChannelId: thread.parentChannelId,
    parentChannelName: thread.parentChannelName,
    parentChannelType: thread.parentChannelType,
    parentMessagePreview: thread.parentMessagePreview,
    parentMessageSenderType: thread.parentMessageSenderType,
    parentMessageSenderId: thread.parentMessageSenderId,
    latestActivityPreview: thread.latestActivityPreview,
    latestActivitySenderType: thread.latestActivitySenderType,
    latestActivitySenderId: thread.latestActivitySenderId,
    latestActivitySenderName: thread.latestActivitySenderName,
    latestActivityMessageId: thread.latestActivityMessageId,
    latestActivitySeq: thread.latestActivitySeq ?? null,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastActivityAt: thread.lastActivityAt,
    lastReplyAt: thread.lastReplyAt,
    replyCount: thread.replyCount,
    unreadCount: 0,
    hasMention: false,
    taskNumber: thread.taskNumber,
    taskStatus: thread.taskStatus,
    taskClaimedByName: thread.taskClaimedByName,
    maxReadSeq: thread.maxReadSeq,
    readStateVersion: thread.readStateVersion,
    readState: thread.readState,
    doneAt: thread.doneAt,
    isFollowing: thread.isFollowing,
    unfollowedAt: thread.unfollowedAt,
  }));

  const combined = [...channelItems, ...threadItems].sort((a, b) => {
    const delta = new Date(a.doneAt ?? 0).getTime() - new Date(b.doneAt ?? 0).getTime();
    if (delta !== 0) return opts.sort === "asc" ? delta : -delta;
    const aIdentity = `${a.kind}:${a.kind === "thread" ? a.threadChannelId : a.channelId}`;
    const bIdentity = `${b.kind}:${b.kind === "thread" ? b.threadChannelId : b.channelId}`;
    const identityDelta = aIdentity.localeCompare(bIdentity);
    return opts.sort === "asc" ? identityDelta : -identityDelta;
  });
  const page = combined.slice(offset, offset + limit);
  return {
    items: await attachReadStateToInboxItems(page, userId),
    hasMore: combined.length > offset + limit,
    totalCount: null,
  };
}

/**
 * Compatibility history for explicitly unfollowed threads. Activity All uses
 * the live not-Done projection below; this endpoint retains the frozen
 * unfollow-boundary projection across completion states for older clients.
 */
export async function getUnfollowedInboxItems(
  serverId: string,
  userId: string,
  opts: {
    limit?: number;
    offset?: number;
    historyCutoff?: Date;
    channelId?: string;
    q?: string;
    sort?: "asc" | "desc";
    traceQuery?: DbQueryTracer;
    executor?: DatabaseExecutor;
  } = {},
): Promise<{ items: InboxItem[]; hasMore: boolean; totalCount: null }> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const fetchLimit = limit + offset + 1;
  const followedThreads = await getFollowedThreads(serverId, userId, opts.historyCutoff, {
    state: "unfollowed",
    maxRows: fetchLimit,
    channelId: opts.channelId,
    q: opts.q,
    sort: opts.sort,
    traceQuery: opts.traceQuery,
    executor: opts.executor,
  });
  const combined = followedThreads.map(unfollowedThreadInboxItem);
  const page = combined.slice(offset, offset + limit);
  return {
    items: page,
    hasMore: combined.length > offset + limit,
    totalCount: null,
  };
}

type FollowedThreadInboxSource = Awaited<ReturnType<typeof getFollowedThreads>>[number];

function unfollowedThreadInboxItem(thread: FollowedThreadInboxSource): InboxItem {
  return {
    kind: "thread",
    threadChannelId: thread.threadChannelId,
    parentMessageId: thread.parentMessageId,
    parentChannelId: thread.parentChannelId,
    parentChannelName: thread.parentChannelName,
    parentChannelType: thread.parentChannelType,
    parentMessagePreview: thread.parentMessagePreview,
    parentMessageSenderType: thread.parentMessageSenderType,
    parentMessageSenderId: thread.parentMessageSenderId,
    latestActivityPreview: thread.latestActivityPreview,
    latestActivitySenderType: thread.latestActivitySenderType,
    latestActivitySenderId: thread.latestActivitySenderId,
    latestActivitySenderName: thread.latestActivitySenderName,
    latestActivityMessageId: thread.latestActivityMessageId,
    latestActivitySeq: thread.latestActivitySeq,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastActivityAt: thread.lastActivityAt,
    lastReplyAt: thread.lastReplyAt,
    replyCount: thread.replyCount,
    unreadCount: 0,
    hasMention: false,
    taskNumber: thread.taskNumber,
    taskStatus: thread.taskStatus,
    taskClaimedByName: thread.taskClaimedByName,
    maxReadSeq: thread.maxReadSeq,
    readStateVersion: thread.readStateVersion,
    readState: thread.readState,
    doneAt: null,
    isFollowing: false,
    unfollowedAt: thread.unfollowedAt,
  };
}

async function getActiveUnfollowedInboxItems(
  serverId: string,
  userId: string,
  opts: {
    historyCutoff?: Date;
    channelId?: string;
    q?: string;
    sort?: "asc" | "desc";
    traceQuery?: DbQueryTracer;
    executor?: DatabaseExecutor;
  },
): Promise<InboxItem[]> {
  const threads = await getFollowedThreads(serverId, userId, opts.historyCutoff, {
    state: "unfollowed_active",
    channelId: opts.channelId,
    q: opts.q,
    sort: opts.sort,
    traceQuery: opts.traceQuery,
    executor: opts.executor,
  });
  return threads.map((thread) => ({
    ...unfollowedThreadInboxItem(thread),
    // The active All row needs follow state for controls, not a terminal
    // history timestamp. Keeping this absent also prevents label projection.
    unfollowedAt: null,
  }));
}

type InboxQueryResult = { rows: QueryResultRow[]; contractVersion?: number };

const INBOX_PG_FALLBACK_QUERY_NAME = "channels.inbox_items_serving_rows_by_user";
const INBOX_PG_FALLBACK_QUERY_IDENTITY = "inbox_items_serving_rows_v13";
const INBOX_PG_FALLBACK_LEGACY_QUERY_HASH = "ff11a9e16bc68872";
const INBOX_PG_FALLBACK_STATEMENT_TIMEOUT_CAP_MS = 3_000;
const INBOX_PG_FALLBACK_TIMEOUT_SCOPE = "transaction_local" as const;

type InboxPgFallbackQueryOutcome = "query_completed" | "statement_timeout" | "query_error";
type InboxPgFallbackTimeoutPlan = {
  inheritedTimeoutMs: number;
  effectiveTimeoutMs: number;
};

function inboxPgFallbackEffectiveTimeoutMs(inheritedTimeoutMs: number): number {
  if (!Number.isSafeInteger(inheritedTimeoutMs) || inheritedTimeoutMs < 0) {
    throw new Error("Invalid inherited statement_timeout for inbox PG fallback");
  }
  return inheritedTimeoutMs === 0
    ? INBOX_PG_FALLBACK_STATEMENT_TIMEOUT_CAP_MS
    : Math.min(inheritedTimeoutMs, INBOX_PG_FALLBACK_STATEMENT_TIMEOUT_CAP_MS);
}

function inboxPgFallbackQueryScopeTraceAttrs(
  queryHash: string,
): Record<string, string | number | boolean> {
  return {
    "pg.fallback.query_name": INBOX_PG_FALLBACK_QUERY_NAME,
    "pg.fallback.query_identity": INBOX_PG_FALLBACK_QUERY_IDENTITY,
    "pg.fallback.query_hash": queryHash,
    "pg.fallback.legacy_query_hash": INBOX_PG_FALLBACK_LEGACY_QUERY_HASH,
    "pg.fallback.timeout_scope": INBOX_PG_FALLBACK_TIMEOUT_SCOPE,
    "pg.fallback.statement_timeout_cap_ms": INBOX_PG_FALLBACK_STATEMENT_TIMEOUT_CAP_MS,
  };
}

function inboxPgFallbackTimeoutPlanTraceAttrs(
  timeoutPlan: InboxPgFallbackTimeoutPlan | undefined,
): Record<string, number> {
  if (!timeoutPlan) return {};
  return {
    "pg.fallback.inherited_statement_timeout_ms": timeoutPlan.inheritedTimeoutMs,
    "pg.fallback.effective_statement_timeout_ms": timeoutPlan.effectiveTimeoutMs,
  };
}

function inboxPgFallbackQueryTraceAttrs(
  queryHash: string,
  outcome: InboxPgFallbackQueryOutcome,
  timeoutPlan?: InboxPgFallbackTimeoutPlan,
): TraceAttributes {
  return {
    ...inboxPgFallbackQueryScopeTraceAttrs(queryHash),
    ...inboxPgFallbackTimeoutPlanTraceAttrs(timeoutPlan),
    "pg.fallback.outcome": outcome,
  };
}

function inboxPgFallbackQueryErrorTraceAttrs(
  queryHash: string,
  error: unknown,
  timeoutPlan?: InboxPgFallbackTimeoutPlan,
): TraceAttributes {
  const reason = queryFailureReason(error);
  return {
    ...inboxPgFallbackQueryTraceAttrs(
      queryHash,
      reason === "statement_timeout" ? "statement_timeout" : "query_error",
      timeoutPlan,
    ),
    ...queryFailureTraceAttrs(error),
  };
}

function mergeInboxAllPageKeyRows(
  servingRows: readonly QueryResultRow[],
  mentionRows: readonly QueryResultRow[],
  sort: "asc" | "desc" | undefined,
  offset: number,
  limit: number,
): QueryResultRow[] {
  const rowsByIdentity = new Map<string, QueryResultRow>();
  for (const row of servingRows) {
    rowsByIdentity.set(
      `${String(row._kind)}:${String(row._sourceChannelId)}`,
      row,
    );
  }
  for (const row of mentionRows) {
    const identity = `${String(row._kind)}:${String(row._sourceChannelId)}`;
    if (!rowsByIdentity.has(identity)) rowsByIdentity.set(identity, row);
  }
  const direction = sort === "asc" ? 1 : -1;
  const compareText = (left: unknown, right: unknown) => {
    const leftText = String(left);
    const rightText = String(right);
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
  };
  const activityTime = (value: unknown) =>
    value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return [...rowsByIdentity.values()]
    .sort((left, right) => {
      const activityComparison =
        activityTime(left._lastActivityAt) -
        activityTime(right._lastActivityAt);
      return (
        direction *
        (activityComparison ||
          compareText(left._kind, right._kind) ||
          compareText(left._sourceChannelId, right._sourceChannelId))
      );
    })
    .slice(offset, offset + limit + 1)
    .map((row, pageOrdinal) => ({ ...row, _pageOrdinal: pageOrdinal }));
}

export const __testInboxPgFallbackTimeout = {
  queryName: INBOX_PG_FALLBACK_QUERY_NAME,
  queryIdentity: INBOX_PG_FALLBACK_QUERY_IDENTITY,
  statementTimeoutCapMs: INBOX_PG_FALLBACK_STATEMENT_TIMEOUT_CAP_MS,
  timeoutScope: INBOX_PG_FALLBACK_TIMEOUT_SCOPE,
  effectiveTimeoutMs: inboxPgFallbackEffectiveTimeoutMs,
  errorTraceAttrs: inboxPgFallbackQueryErrorTraceAttrs,
  mergeAllPageKeyRows: mergeInboxAllPageKeyRows,
};

const UUID_TEXT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RISINGWAVE_LEGACY_UNREAD_CONTRACT_VERSION = 1;
const RISINGWAVE_CHANNEL_UNREAD_CONTRACT_VERSION = 2;
const RISINGWAVE_CHANNEL_UNREAD_COUNTS_VIEW = "rw_channel_unread_counts_v2";

type InboxTraceBackend = "rw_mv" | "pg_legacy" | "pg_serving_rows";
type InboxTraceRoute = RisingWaveInboxTraceRoute;
type InboxFallbackReason =
  | "none"
  | "no_rw_env"
  | "history_cutoff"
  | "joint_storage"
  | "rw_error"
  | "read_frontier_mismatch"
  | "breaker_open"
  | "pglite_dev";
type InboxTraceNegativeEvidenceBucket =
  | "does_not_prove_fact_recorded_or_ui_rendered"
  | "does_not_prove_fact_absent_or_message_ineligible"
  | "does_not_prove_future_message_suppression";

type InboxBackendSelection = {
  backend: InboxTraceBackend;
  fallbackReason: InboxFallbackReason;
  contractVersion?: number;
};
type InboxPostgresSelectionReason =
  | "risingwave_result"
  | "rfc056_guard_off_uses_canonical_pg"
  | "rfc056_shadow_uses_canonical_pg"
  | "read_frontier_mismatch_uses_canonical_pg"
  | "history_cutoff_uses_serving_rows"
  | "human_activity_mute_uses_serving_rows"
  | "legacy_inline_policy_pending_serving_rows_migration";

type RisingWaveInboxFailSoftReason = "connection_acquire_error" | "query_error" | "breaker_open";

type RisingWaveInboxAttempt<T> = {
  result: T | null;
  fallbackReason?: InboxFallbackReason;
  failSoftReason?: RisingWaveInboxFailSoftReason;
  contractVersion?: number;
  error?: unknown;
};

type RisingWaveInboxFailSoftDeps = {
  getPool: typeof getRisingWavePool;
  query: typeof queryRisingWave;
  getRfc056ServingMode: typeof getRisingWaveInboxRfc056ServingMode;
  getInboxItemsServingVersion: typeof getRisingWaveInboxItemsServingVersionForRequest;
  getJointStorageServerIds: typeof getJointStorageServerIdsForUser;
  nowMs: () => number;
  random: () => number;
};

const defaultRisingWaveInboxFailSoftDeps: RisingWaveInboxFailSoftDeps = {
  getPool: getRisingWavePool,
  query: queryRisingWave,
  getRfc056ServingMode: getRisingWaveInboxRfc056ServingMode,
  getInboxItemsServingVersion: getRisingWaveInboxItemsServingVersionForRequest,
  getJointStorageServerIds: getJointStorageServerIdsForUser,
  nowMs: () => performance.now(),
  random: () => randomInt(0, 1_000_000) / 1_000_000,
};

let risingWaveInboxFailSoftDeps = defaultRisingWaveInboxFailSoftDeps;

function getRisingWaveInboxPool() {
  return risingWaveInboxFailSoftDeps.getPool();
}

function queryRisingWaveInbox<T extends QueryResultRow = QueryResultRow>(
  pool: Parameters<typeof queryRisingWave>[0],
  queryText: string,
  values?: unknown[],
) {
  return risingWaveInboxFailSoftDeps.query<T>(pool, queryText, values);
}

type RisingWaveInboxThreadReplyCountContractRow = {
  kind?: unknown;
  replyCount?: unknown;
};

function inboxTraceAttrs(
  backend: InboxTraceBackend,
  route: InboxTraceRoute,
  fallbackReason: InboxFallbackReason,
  contractVersion = RISINGWAVE_UNREAD_INBOX_CONTRACT_VERSION,
): TraceAttributes {
  return {
    "inbox.backend": backend,
    "inbox.route": route,
    "inbox.fallback_reason": fallbackReason,
    "inbox.contract_version": contractVersion,
    inbox_backend: backend,
    inbox_route: route,
    inbox_fallback_reason: fallbackReason,
    inbox_contract_version: contractVersion,
  };
}

function recordInboxBackendSelected(
  backend: InboxTraceBackend,
  route: InboxTraceRoute,
  fallbackReason: InboxFallbackReason,
  contractVersion?: number,
  extraAttrs: TraceAttributes = {},
) {
  addTraceEvent("inbox.backend.selected", {
    ...inboxTraceAttrs(backend, route, fallbackReason, contractVersion),
    ...extraAttrs,
  });
}

function inboxPostgresSelectionTraceAttrs(reason: InboxPostgresSelectionReason): TraceAttributes {
  return {
    "inbox.postgres_selection_reason": reason,
    inbox_postgres_selection_reason: reason,
    ...(reason === "legacy_inline_policy_pending_serving_rows_migration"
      ? {
        "inbox.legacy_retire_gate": "pending_serving_rows_parity",
        inbox_legacy_retire_gate: "pending_serving_rows_parity",
      }
      : {}),
  };
}

function recordInboxBackendFailed(
  backend: InboxTraceBackend,
  route: InboxTraceRoute,
  error: unknown,
  contractVersion?: number,
  terminalStatus?: 500,
) {
  if (backend === "rw_mv") {
    recordRisingWaveInboxBackendFailed({
      route,
      error,
      contractVersion,
      terminalStatus,
      breakerState: getRisingWaveInboxBreakerTraceState(),
      queryName: getRisingWaveInboxQueryName(route),
    });
    return;
  }
  addTraceEvent("inbox.backend.failed", {
    ...inboxTraceAttrs(backend, route, "rw_error", contractVersion),
    error_class: error instanceof Error ? error.name : typeof error,
  });
}

const RISINGWAVE_INBOX_BREAKER_MIN_MS = 5_000;
const RISINGWAVE_INBOX_BREAKER_MAX_MS = 15_000;

const risingWaveInboxBreaker = {
  openedAtMs: 0,
  openUntilMs: 0,
  openedCount: 0,
  halfOpenProbeInFlight: false,
  lastRoute: null as InboxTraceRoute | null,
  lastReason: null as RisingWaveInboxFailSoftReason | null,
};

function getRisingWavePoolTraceAttrs(): TraceAttributes {
  const state = getRisingWavePoolState(getRisingWaveInboxPool());
  const timeoutMs = getRisingWaveConnectionTimeoutMillis();
  return {
    "rw.pool.total_count": state.rw_pool_total,
    "rw.pool.idle_count": state.rw_pool_idle,
    "rw.pool.waiting_count": state.rw_pool_waiting,
    "rw.timeout_ms": timeoutMs,
    "rw.pool.connection_timeout_ms": timeoutMs,
    timeout_ms: timeoutMs,
    ...state,
  };
}

function getRisingWaveInboxQueryName(route: InboxTraceRoute): string {
  if (route === "channel_unread") return "channels.unread_counts_by_user";
  if (route === "sidebar_summary") return "servers.sidebar_unread_counts_by_user";
  return "channels.inbox_items_by_user";
}

function getRisingWaveInboxBreakerState(nowMs = risingWaveInboxFailSoftDeps.nowMs()): "closed" | "open" | "half_open" {
  if (risingWaveInboxBreaker.openUntilMs > nowMs) return "open";
  if (risingWaveInboxBreaker.openUntilMs > 0) return "half_open";
  return "closed";
}

function getRisingWaveInboxBreakerTraceState(nowMs = risingWaveInboxFailSoftDeps.nowMs()): RisingWaveBreakerState {
  return getRisingWaveInboxBreakerState(nowMs);
}

function getRisingWaveInboxBreakerTraceAttrs(nowMs = risingWaveInboxFailSoftDeps.nowMs()): TraceAttributes {
  return {
    "rw.breaker.state": getRisingWaveInboxBreakerState(nowMs),
    "rw.breaker.opened_count": risingWaveInboxBreaker.openedCount,
    "rw.breaker.half_open_probe_in_flight": risingWaveInboxBreaker.halfOpenProbeInFlight,
    "rw.breaker.open_remaining_ms": Math.max(Math.ceil(risingWaveInboxBreaker.openUntilMs - nowMs), 0),
    "rw.breaker.last_route": risingWaveInboxBreaker.lastRoute,
    "rw.breaker.last_reason": risingWaveInboxBreaker.lastReason,
  };
}

function openRisingWaveInboxBreaker(
  route: InboxTraceRoute,
  reason: Exclude<RisingWaveInboxFailSoftReason, "breaker_open">,
  contractVersion?: number,
  error?: unknown,
) {
  const nowMs = risingWaveInboxFailSoftDeps.nowMs();
  const openForMs = RISINGWAVE_INBOX_BREAKER_MIN_MS
    + Math.floor(risingWaveInboxFailSoftDeps.random() * (RISINGWAVE_INBOX_BREAKER_MAX_MS - RISINGWAVE_INBOX_BREAKER_MIN_MS + 1));
  risingWaveInboxBreaker.openedAtMs = nowMs;
  risingWaveInboxBreaker.openUntilMs = nowMs + openForMs;
  risingWaveInboxBreaker.openedCount += 1;
  risingWaveInboxBreaker.halfOpenProbeInFlight = false;
  risingWaveInboxBreaker.lastRoute = route;
  risingWaveInboxBreaker.lastReason = reason;
  addTraceEvent("inbox.rw.breaker.opened", {
    ...inboxTraceAttrs("rw_mv", route, "rw_error", contractVersion),
    ...(error ? risingWaveInboxFailureAttrs({
      route,
      error,
      contractVersion,
      queryName: getRisingWaveInboxQueryName(route),
      breakerState: getRisingWaveInboxBreakerTraceState(nowMs),
    }) : {}),
    "rw.failsoft_reason": reason,
    "rw.breaker.open_for_ms": openForMs,
    "rw.query_name": getRisingWaveInboxQueryName(route),
    "rw.fallback_outcome": "pg_selected",
    ...getRisingWavePoolTraceAttrs(),
    ...getRisingWaveInboxBreakerTraceAttrs(nowMs),
  });
}

function closeRisingWaveInboxBreaker(route: InboxTraceRoute, contractVersion?: number) {
  if (risingWaveInboxBreaker.openUntilMs === 0) return;
  const previousState = getRisingWaveInboxBreakerState();
  risingWaveInboxBreaker.openUntilMs = 0;
  risingWaveInboxBreaker.halfOpenProbeInFlight = false;
  addTraceEvent("inbox.rw.breaker.closed", {
    ...inboxTraceAttrs("rw_mv", route, "none", contractVersion),
    "rw.breaker.previous_state": previousState,
    ...getRisingWavePoolTraceAttrs(),
    ...getRisingWaveInboxBreakerTraceAttrs(),
  });
}

function shouldBypassRisingWaveInboxRead(route: InboxTraceRoute, contractVersion?: number): boolean {
  const nowMs = risingWaveInboxFailSoftDeps.nowMs();
  const breakerState = getRisingWaveInboxBreakerState(nowMs);
  if (breakerState === "closed") return false;
  if (breakerState === "half_open" && !risingWaveInboxBreaker.halfOpenProbeInFlight) {
    risingWaveInboxBreaker.halfOpenProbeInFlight = true;
    addTraceEvent("inbox.rw.breaker.half_open_probe_started", {
      ...inboxTraceAttrs("rw_mv", route, "none", contractVersion),
      "rw.query_name": getRisingWaveInboxQueryName(route),
      ...getRisingWavePoolTraceAttrs(),
      ...getRisingWaveInboxBreakerTraceAttrs(nowMs),
    });
    return false;
  }
  addTraceEvent("inbox.rw.failsoft.fallback", {
    ...inboxTraceAttrs("pg_legacy", route, "breaker_open", contractVersion),
    reason: "breaker_open",
    "rw.failsoft_reason": "breaker_open" satisfies RisingWaveInboxFailSoftReason,
    "rw.query_name": getRisingWaveInboxQueryName(route),
    "rw.fallback_outcome": "pg_selected",
    ...getRisingWavePoolTraceAttrs(),
    ...getRisingWaveInboxBreakerTraceAttrs(nowMs),
  });
  return true;
}

function getRisingWaveFallbackReasonForTrace(
  attempt: RisingWaveInboxAttempt<unknown>,
): "rw_error" | "breaker_open" | null {
  if (attempt.failSoftReason === "breaker_open") return "breaker_open";
  if (attempt.fallbackReason === "rw_error") return "rw_error";
  return null;
}

async function withRisingWaveInboxFallbackTrace<T>(
  route: InboxTraceRoute,
  queryName: string,
  attempt: RisingWaveInboxAttempt<unknown>,
  readPostgres: () => Promise<T>,
): Promise<T> {
  const fallbackReason = getRisingWaveFallbackReasonForTrace(attempt);
  if (!fallbackReason) return readPostgres();

  const startedAtMs = risingWaveInboxFailSoftDeps.nowMs();
  try {
    const result = await readPostgres();
    recordRisingWaveInboxFallbackCompleted({
      route,
      error: attempt.error,
      contractVersion: attempt.contractVersion,
      queryName,
      breakerState: getRisingWaveInboxBreakerTraceState(),
      fallbackReason,
      fallbackOutcome: "success",
      fallbackLatencyMs: Math.round(risingWaveInboxFailSoftDeps.nowMs() - startedAtMs),
    });
    return result;
  } catch (error) {
    recordRisingWaveInboxFallbackCompleted({
      route,
      error: attempt.error,
      contractVersion: attempt.contractVersion,
      queryName,
      breakerState: getRisingWaveInboxBreakerTraceState(),
      fallbackReason,
      fallbackOutcome: "error",
      fallbackLatencyMs: Math.round(risingWaveInboxFailSoftDeps.nowMs() - startedAtMs),
    });
    throw error;
  }
}

async function tryReadRisingWaveInboxWithFailSoft<T>(
  route: InboxTraceRoute,
  contractVersion: number | undefined,
  readRisingWave: () => Promise<T | null>,
): Promise<RisingWaveInboxAttempt<T>> {
  if (shouldBypassRisingWaveInboxRead(route, contractVersion)) {
    return {
      result: null,
      fallbackReason: "breaker_open",
      failSoftReason: "breaker_open",
      contractVersion,
    };
  }
  try {
    const result = await readRisingWave();
    closeRisingWaveInboxBreaker(route, contractVersion);
    return { result, contractVersion };
  } catch (error) {
    const connectionFailure = isRisingWaveInboxFailSoftError(error);
    // Inbox-item serving depends on additive versioned read-frontier relations.
    // During DDL-first rollout/rollback, schema absence and other RW query
    // failures must select the canonical PG response rather than return a 500
    // or mix old/new schema state. The legacy unread/sidebar routes retain
    // their stricter query-error behavior.
    const canFailSoft = connectionFailure
      || route === "all"
      || route === "unread"
      || route === "mentions"
      || route === "unread_mentions";
    const failSoftReason: Exclude<RisingWaveInboxFailSoftReason, "breaker_open"> = connectionFailure
      ? "connection_acquire_error"
      : "query_error";
    recordInboxBackendFailed("rw_mv", route, error, contractVersion, canFailSoft ? undefined : 500);
    if (!canFailSoft) {
      risingWaveInboxBreaker.halfOpenProbeInFlight = false;
      throw error;
    }
    openRisingWaveInboxBreaker(route, failSoftReason, contractVersion, error);
    recordRisingWaveInboxFailSoftFallback(route, failSoftReason, contractVersion, error);
    return {
      result: null,
      fallbackReason: "rw_error",
      failSoftReason,
      contractVersion,
      error,
    };
  }
}

export const __testRisingWaveInboxFailSoft = {
  reset() {
    risingWaveInboxFailSoftDeps = defaultRisingWaveInboxFailSoftDeps;
    risingWaveInboxBreaker.openedAtMs = 0;
    risingWaveInboxBreaker.openUntilMs = 0;
    risingWaveInboxBreaker.openedCount = 0;
    risingWaveInboxBreaker.halfOpenProbeInFlight = false;
    risingWaveInboxBreaker.lastRoute = null;
    risingWaveInboxBreaker.lastReason = null;
  },
  setDeps(deps: Partial<RisingWaveInboxFailSoftDeps>) {
    risingWaveInboxFailSoftDeps = { ...risingWaveInboxFailSoftDeps, ...deps };
  },
  getBreakerState(nowMs?: number) {
    return getRisingWaveInboxBreakerState(nowMs);
  },
  validateReadFrontier(
    rows: readonly InboxPolicySqlRow[],
    primary: InboxReadAuthority,
  ) {
    return validateRisingWaveInboxReadFrontier(rows, primary);
  },
  read<T>(
    route: InboxTraceRoute,
    contractVersion: number | undefined,
    readRisingWave: () => Promise<T | null>,
  ) {
    return tryReadRisingWaveInboxWithFailSoft(route, contractVersion, readRisingWave);
  },
  async readWithPostgresFallback<T>(
    route: InboxTraceRoute,
    contractVersion: number | undefined,
    readRisingWave: () => Promise<T | null>,
    readPostgres: (attempt: RisingWaveInboxAttempt<T>) => Promise<T>,
  ) {
    const attempt = await tryReadRisingWaveInboxWithFailSoft(route, contractVersion, readRisingWave);
    if (attempt.result !== null) return { backend: "rw_mv" as const, result: attempt.result, attempt };
    return {
      backend: "pg_legacy" as const,
      result: await withRisingWaveInboxFallbackTrace(
        route,
        getRisingWaveInboxQueryName(route),
        attempt,
        () => readPostgres(attempt),
      ),
      attempt,
    };
  },
  async callInboxItemsWrapper(
    serverId: string,
    userId: string,
    opts?: Parameters<typeof getInboxItems>[2],
  ) {
    return getInboxItems(serverId, userId, opts);
  },
  async callUnreadCountsWrapper(
    serverId: string,
    userId: string,
    historyCutoff: Date | undefined,
    opts?: UnreadCountOptions,
  ) {
    return getUnreadCounts(serverId, userId, historyCutoff, opts);
  },
  async callSidebarUnreadSummaryCountsWrapper(
    servers: SidebarUnreadSummaryInput[],
    userId: string,
    opts?: SidebarUnreadSummaryOptions,
  ) {
    return getSidebarUnreadSummaryCounts(servers, userId, opts);
  },
};

function recordRisingWaveInboxFailSoftFallback(
  route: InboxTraceRoute,
  reason: RisingWaveInboxFailSoftReason,
  contractVersion?: number,
  error?: unknown,
) {
  addTraceEvent("inbox.rw.failsoft.fallback", {
    ...inboxTraceAttrs("pg_legacy", route, reason === "breaker_open" ? "breaker_open" : "rw_error", contractVersion),
    reason: reason === "breaker_open" ? "breaker_open" : "rw_error",
    ...(error ? risingWaveInboxFailureAttrs({
      route,
      error,
      contractVersion,
      queryName: getRisingWaveInboxQueryName(route),
      breakerState: getRisingWaveInboxBreakerTraceState(),
    }) : {}),
    "rw.failsoft_reason": reason,
    "rw.query_name": getRisingWaveInboxQueryName(route),
    "rw.fallback_outcome": "pg_selected",
    ...getRisingWavePoolTraceAttrs(),
    ...getRisingWaveInboxBreakerTraceAttrs(),
  });
}

function recordRisingWaveInboxThreadReplyCountNullContractViolation(
  rows: readonly RisingWaveInboxThreadReplyCountContractRow[],
  opts: {
    filter: InboxFilter;
    servedVersion: RisingWaveInboxItemsServingVersion;
    requestedVersion: RisingWaveInboxItemsServingVersion;
    forcedV2ForHistoryCutoff: boolean;
    historyCutoff: boolean;
  },
) {
  const nullThreadReplyCountRows = rows.filter((row) =>
    row.kind === "thread" && row.replyCount == null
  ).length;
  if (nullThreadReplyCountRows === 0) return;

  addTraceEvent("inbox.rw.thread_reply_count_null_contract_violation", {
    ...inboxTraceAttrs("rw_mv", opts.filter, "none", opts.servedVersion),
    state: "contract_violation",
    contract: "thread_reply_count_non_null",
    violated_field: "reply_count",
    target_kind: "thread",
    rw_inbox_items_version: opts.servedVersion,
    rw_inbox_items_requested_version: opts.requestedVersion,
    rw_inbox_items_version_forced: opts.forcedV2ForHistoryCutoff,
    rw_inbox_items_version_force_reason: opts.forcedV2ForHistoryCutoff ? "history_cutoff" : "none",
    rw_inbox_items_serving_view: getRisingWaveInboxItemsServingView(opts.servedVersion),
    history_cutoff_present: opts.historyCutoff,
    rows_count: rows.length,
    null_thread_reply_count_rows: nullThreadReplyCountRows,
  });
}

function inboxTargetTraceJoinKey(receiverType: "user" | "agent", receiverId: string, sourceChannelId: string) {
  return `${receiverType}:${receiverId}:${sourceChannelId}`;
}

function recordInboxServingRowsRead(
  rows: readonly InboxPolicySqlRow[],
  opts: { receiverType: "user"; receiverId: string; filter: InboxFilter; limit: number; offset: number },
) {
  addTraceEvent("inbox.serving_row.read.page", {
    "inbox.trace_contract_version": 1,
    filter: opts.filter,
    limit: opts.limit,
    offset: opts.offset,
    rows_count: rows.length,
    negative_evidence_bucket: "does_not_prove_fact_recorded_or_ui_rendered" satisfies InboxTraceNegativeEvidenceBucket,
  });
  for (const row of rows) {
    const sourceChannelId = typeof row.sourceChannelId === "string"
      ? row.sourceChannelId
      : typeof row.channelId === "string"
        ? row.channelId
        : typeof row.threadChannelId === "string"
          ? row.threadChannelId
          : "";
    addTraceEvent("inbox.serving_row.read", {
      "inbox.trace_contract_version": 1,
      "inbox.trace_join_key": sourceChannelId
        ? inboxTargetTraceJoinKey(opts.receiverType, opts.receiverId, sourceChannelId)
        : `${opts.receiverType}:${opts.receiverId}:unknown`,
      receiver_type: opts.receiverType,
      receiver_id: opts.receiverId,
      source_channel_id: sourceChannelId,
      target_kind: row.kind ?? "unknown",
      latest_notified_seq: row.latestNotifiedSeq ?? null,
      first_unread_seq: row.firstUnreadSeq ?? null,
      unread_count: row.unreadCount ?? 0,
      has_any_mention: row.hasAnyMention === true || row.hasMention === true,
      state: "row_returned",
      negative_evidence_bucket: "does_not_prove_fact_recorded_or_ui_rendered" satisfies InboxTraceNegativeEvidenceBucket,
    });
  }
}

function recordInboxReadRebuildRequested(
  userId: string,
  rows: readonly { channelId: string }[],
) {
  addTraceEvent("inbox.serving_row.rebuild.requested", {
    "inbox.trace_contract_version": 1,
    receiver_type: "user",
    receiver_id: userId,
    targets_count: rows.length,
    state: rows.length > 0 ? "read_cursor_advanced" : "no_active_inbox_rows",
    negative_evidence_bucket: "does_not_prove_fact_absent_or_message_ineligible" satisfies InboxTraceNegativeEvidenceBucket,
  });
  for (const row of rows) {
    addTraceEvent("inbox.serving_row.rebuild.target", {
      "inbox.trace_contract_version": 1,
      "inbox.trace_join_key": inboxTargetTraceJoinKey("user", userId, row.channelId),
      receiver_type: "user",
      receiver_id: userId,
      source_channel_id: row.channelId,
      state: "read_cursor_advanced",
      negative_evidence_bucket: "does_not_prove_fact_absent_or_message_ineligible" satisfies InboxTraceNegativeEvidenceBucket,
    });
  }
}

function recordInboxMuteStateTrace(
  eventName: "inbox.mute_state.read" | "inbox.mute_state.write",
  opts: {
    receiverType: "user" | "agent";
    receiverId: string;
    sourceChannelId: string;
    state: "muted" | "unmuted";
    muteFromSeq: number | null;
    reason: "current_state" | "muted_from_next_seq" | "unmuted";
  },
) {
  addTraceEvent(eventName, {
    "inbox.trace_contract_version": 1,
    "inbox.trace_join_key": inboxTargetTraceJoinKey(opts.receiverType, opts.receiverId, opts.sourceChannelId),
    receiver_type: opts.receiverType,
    receiver_id: opts.receiverId,
    source_channel_id: opts.sourceChannelId,
    state: opts.state,
    reason: opts.reason,
    activity_muted: opts.state === "muted",
    mute_from_seq_present: opts.muteFromSeq != null,
    ...(opts.muteFromSeq != null ? { mute_from_seq: opts.muteFromSeq } : {}),
    negative_evidence_bucket: "does_not_prove_future_message_suppression" satisfies InboxTraceNegativeEvidenceBucket,
  });
}

function getLegacyInboxFallbackReason(historyCutoff?: Date): InboxFallbackReason {
  if (historyCutoff) return "history_cutoff";
  try {
    getPool();
    return "no_rw_env";
  } catch {
    return "pglite_dev";
  }
}

async function getRisingWaveInboxItemsServingVersionForRequest(
  serverId: string,
  userId: string,
): Promise<RisingWaveInboxItemsServingVersion> {
  const evaluation = await evaluateFeatureFlag({
    key: INBOX_VISIBILITY_V3_FEATURE_FLAG_KEY,
    serverId,
    userId,
  });
  return evaluation.enabled ? 3 : getRisingWaveInboxItemsServingVersion();
}

function selectRisingWaveInboxItemsServingVersionForRequest(
  requestedVersion: RisingWaveInboxItemsServingVersion,
  opts: { historyCutoff?: Date },
): RisingWaveInboxItemsServingVersion {
  // v3 does not own the historyCutoff predicate yet. Keep cutoff traffic on RW
  // v2 at request selection time so a v3 flag rollout cannot fall through to PG.
  if (opts.historyCutoff && requestedVersion === 3) return 2;
  return requestedVersion;
}

function userPersonalMentionExistsForMessageAliasSql(userId: string): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM message_mentions mm
    WHERE mm.message_id = m.id
      AND mm.target_type = 'user'
      AND mm.target_id = ${userId}::uuid
      AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
  )`;
}

function legacyChatActivityPromotionAllowedSql(userId: string, muteFromSeq: SQL): SQL {
  return activityPromotionAllowedByMuteSql({
    kindIsThread: sql`false`,
    messageSeq: sql.raw("m.seq"),
    muteFromSeq,
    personalMentionExists: userPersonalMentionExistsForMessageAliasSql(userId),
  });
}

async function getJointStorageServerIdsForUser(serverIds: string[], userId: string): Promise<Set<string>> {
  const uniqueServerIds = [...new Set(serverIds.filter(Boolean))];
  if (uniqueServerIds.length === 0) return new Set();

  const db = getDb();
  const result = await db.execute(sql`
    SELECT DISTINCT c.server_id::text AS "serverId"
    FROM joint_channel_servers jcs
    INNER JOIN joint_channels jc
      ON jc.id = jcs.joint_channel_id
     AND jc.status = 'active'
    INNER JOIN channels c
      ON c.id = jcs.local_channel_id
     AND c.server_id IN (${sql.join(uniqueServerIds.map((id) => sql`${id}`), sql`, `)})
     AND c.deleted_at IS NULL
     AND c.archived_at IS NULL
    LEFT JOIN channel_humans ch
      ON ch.channel_id = c.id
     AND ch.user_id = ${userId}
    LEFT JOIN thread_follows tf
      ON tf.thread_channel_id = c.id
     AND tf.follower_type = 'user'
     AND tf.follower_id = ${userId}
     AND tf.done_at IS NULL
     AND tf.unfollowed_at IS NULL
    WHERE jcs.status = 'active'
      AND jcs.server_id = c.server_id
      AND (
        (c.type = 'joint' AND ch.user_id IS NOT NULL)
        OR (c.type = 'thread' AND tf.thread_channel_id IS NOT NULL)
      )
  `);

  return new Set((result.rows as Array<{ serverId: string }>).map((row) => row.serverId));
}

function buildRisingWaveInboxItemsServingQuery(
  limit: number,
  offset: number,
  version = getRisingWaveInboxItemsServingVersion(),
  opts: {
    includeMentionOnlyInAllAndUnread?: boolean;
    sort?: "asc" | "desc";
  } = {},
) {
  const sortDirection = opts.sort === "asc" ? "ASC" : "DESC";
  // v1/v2 stays a code-level default. v3 is selected only by the reviewed
  // Feature Flag v0 gate after matching production RW object evidence. The v2
  // and v3 serving views point at the versioned v0.3 suppression graph; the
  // graph must exist before this serving switch is merged/released.
  const inboxItems = getRisingWaveInboxItemsServingView(version);
  const mentionOnlyExpr = version === 1 ? "false" : "i.mention_only";
  const visibilityContractPredicate =
    version === 3 ? "AND i.visibility_contract_version = 3" : "";
  const filterMentionOnlyPredicate = opts.includeMentionOnlyInAllAndUnread
    ? ""
    : `AND (
          $3::text = 'mentions'
          OR ${mentionOnlyExpr} = false
        )`;
  const activeMentionOnlyPredicate = opts.includeMentionOnlyInAllAndUnread
    ? ""
    : `AND ${mentionOnlyExpr} = false`;
  // CONTRACT: RW serving must stay behavior-compatible with the inline Postgres
  // SQL in getInboxItems below. SYNC REQUIRED: any field, filter, unread-count,
  // mention, ordering, pagination, or total-count semantic changed here or in
  // the PG SQL must be mirrored in the other side and in:
  // infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql
  // Then run: pnpm --filter @botiverse/raft-server risingwave:verify-inbox-parity
  // PG and RW stringify timestamptz with slightly different timezone/fractional
  // formatting. Keep the shared serving query byte-comparable at the API layer.
  const timestampText = (expr: string) =>
    `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`;

  return `
    WITH read_authority AS (
      SELECT
        true AS "readAuthorityPresent",
        authority.last_terminal_authority_seq AS "readAuthoritySeq"
      FROM rw_inbox_read_authorities_v1 authority
      WHERE authority.server_id = $1
        AND authority.principal_id = $2
      UNION ALL
      SELECT false, 0::bigint
      WHERE NOT EXISTS (
        SELECT 1
        FROM rw_inbox_read_authorities_v1 authority
        WHERE authority.server_id = $1
          AND authority.principal_id = $2
      )
    ),
    filtered AS (
      SELECT
        i.kind AS "kind",
        i.channel_id AS "channelId",
        i.channel_name AS "channelName",
        i.channel_type AS "channelType",
        i.last_message_id AS "lastMessageId",
        i.first_unread_message_id AS "firstUnreadMessageId",
        i.last_message_at AS "lastMessageAtRaw",
        i.last_message_preview AS "lastMessagePreview",
        i.last_message_sender_type AS "lastMessageSenderType",
        i.last_message_sender_id AS "lastMessageSenderId",
        NULL::text AS "lastMessageSenderName",
        i.unread_count::int AS "unreadCount",
        i.thread_channel_id AS "threadChannelId",
        i.parent_message_id AS "parentMessageId",
        i.parent_channel_id AS "parentChannelId",
        i.parent_channel_name AS "parentChannelName",
        i.parent_channel_type AS "parentChannelType",
        i.parent_message_preview AS "parentMessagePreview",
        i.parent_message_sender_type AS "parentMessageSenderType",
        i.parent_message_sender_id AS "parentMessageSenderId",
        i.latest_activity_preview AS "latestActivityPreview",
        i.latest_activity_sender_type AS "latestActivitySenderType",
        i.latest_activity_sender_id AS "latestActivitySenderId",
        i.latest_activity_message_id AS "latestActivityMessageId",
        latest_activity.seq::text AS "latestActivitySeq",
        i.last_activity_at AS "lastActivityAtRaw",
        i.last_reply_at AS "lastReplyAtRaw",
        i.reply_count::int AS "replyCount",
        i.task_number AS "taskNumber",
        i.task_status AS "taskStatus",
        i.task_claimed_by_type AS "taskClaimedByType",
        i.task_claimed_by_id AS "taskClaimedById",
        NULL::text AS "taskClaimedByName",
        i.has_mention AS "hasMention",
        ${mentionOnlyExpr} AS "mentionOnly",
        i.last_read_seq AS "materializedLastReadSeq",
        -- NULL-preserving on purpose: presence is the structural "readCursorPresent"
        -- JOIN fact below; value columns stay NULL for absent/corrupt rows and the
        -- shared constructor classifies (never COALESCE-pad to 0). maxReadSeq is
        -- text so the int8 domain reaches the mapper as a canonical decimal string.
        cursor_v2.last_read_seq::text AS "maxReadSeq",
        cursor_v2.read_state_version AS "readStateVersion",
        cursor_v2.user_id IS NOT NULL AS "readCursorPresent",
        i.activity_at AS "activityAt",
        i.has_any_mention AS "hasAnyMention"
      FROM ${inboxItems} i
      LEFT JOIN rw_user_channel_read_cursors_v2 cursor_v2
        ON cursor_v2.user_id = i.user_id
       AND cursor_v2.channel_id = COALESCE(i.channel_id, i.thread_channel_id)
      LEFT JOIN rw_messages latest_activity
        ON latest_activity.id = i.latest_activity_message_id
      WHERE i.server_id = $1
        AND i.user_id = $2
        ${visibilityContractPredicate}
        AND ($3::text <> 'all' OR i.kind = 'thread' OR i.channel_type IN ('channel', 'private', 'joint', 'dm'))
        AND (
          ($3::text = 'all')
          OR ($3::text = 'unread' AND i.unread_count > 0)
          OR ($3::text = 'mentions' AND i.has_any_mention)
          OR ($3::text = 'unread_mentions' AND i.unread_count > 0 AND i.has_mention)
        )
        AND ($4::timestamptz IS NULL OR i.activity_at > $4::timestamptz)
        AND (
          $6::text IS NULL
          OR COALESCE(i.channel_name, '') ILIKE '%' || $6::text || '%'
          OR COALESCE(i.last_message_preview, '') ILIKE '%' || $6::text || '%'
          OR COALESCE(i.parent_channel_name, '') ILIKE '%' || $6::text || '%'
          OR COALESCE(i.parent_message_preview, '') ILIKE '%' || $6::text || '%'
          OR COALESCE(i.latest_activity_preview, '') ILIKE '%' || $6::text || '%'
        )
        ${filterMentionOnlyPredicate}
    ),
    faceted AS (
      SELECT
        filtered.*,
        CASE WHEN "kind" = 'thread' THEN "parentChannelId" ELSE "channelId" END AS "groupChannelId",
        CASE WHEN "kind" = 'thread' THEN "parentChannelName" ELSE "channelName" END AS "groupChannelName",
        CASE WHEN "kind" = 'thread' THEN "parentChannelType" ELSE "channelType" END AS "groupChannelType"
      FROM filtered
    ),
    group_counts AS (
      SELECT
        "groupChannelId",
        "groupChannelName",
        "groupChannelType",
        count(*)::int AS "groupCount",
        MAX("activityAt") AS "groupLastActivityAt"
      FROM faceted
      WHERE "groupChannelId" IS NOT NULL
      GROUP BY "groupChannelId", "groupChannelName", "groupChannelType"
    ),
    group_totals AS (
      SELECT
        array_agg("groupChannelId"::text ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelIds",
        array_agg("groupChannelName" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelNames",
        array_agg("groupChannelType"::text ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelTypes",
        array_agg("groupCount"::int ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupCounts",
        array_agg("groupLastActivityAt"::text ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupLastActivityAts"
      FROM group_counts
    ),
    selected AS (
      SELECT *
      FROM faceted
      -- RisingWave's pgwire parameter binder supports text/varchar here but
      -- does not implement PostgreSQL's uuid cast. Route parsing has already
      -- validated channelId as a UUID, while every RW channel identity in this
      -- graph is varchar, so text equality preserves the channel facet exactly.
      WHERE $5::text IS NULL OR "groupChannelId" = $5::text
    ),
    active_totals AS (
      SELECT
        COALESCE(sum(CASE WHEN ${mentionOnlyExpr} THEN 0 ELSE i.unread_count END), 0)::int AS "activeUnreadCount"
      FROM ${inboxItems} i
      WHERE i.server_id = $1
        AND i.user_id = $2
        ${visibilityContractPredicate}
        AND (i.kind = 'thread' OR i.channel_type IN ('channel', 'private', 'joint', 'dm'))
        AND ($4::timestamptz IS NULL OR i.activity_at > $4::timestamptz)
        ${activeMentionOnlyPredicate}
    ),
    totals AS (
      SELECT
        count(*)::int AS "totalCount",
        COALESCE(sum("unreadCount"), 0)::int AS "totalUnreadCount"
      FROM selected
    ),
    page AS (
      SELECT *
      FROM selected
      ORDER BY "activityAt" ${sortDirection} NULLS LAST,
        "kind" ${sortDirection},
        COALESCE("threadChannelId", "channelId") ${sortDirection}
      LIMIT ${limit}
      OFFSET ${offset}
    ),
    page_enriched AS (
      SELECT
        p."kind",
        p."channelId",
        p."channelName",
        p."channelType",
        p."lastMessageId"::text AS "lastMessageId",
        p."latestActivitySeq"::text AS "latestActivitySeq",
        p."firstUnreadMessageId"::text AS "firstUnreadMessageId",
        ${timestampText('p."lastMessageAtRaw"')} AS "lastMessageAt",
        p."lastMessagePreview",
        p."lastMessageSenderType",
        p."lastMessageSenderId",
        p."lastMessageSenderName",
        p."unreadCount" AS "unreadCount",
        p."threadChannelId"::text AS "threadChannelId",
        p."parentMessageId"::text AS "parentMessageId",
        p."parentChannelId"::text AS "parentChannelId",
        p."parentChannelName",
        p."parentChannelType",
        p."parentMessagePreview",
        p."parentMessageSenderType",
        p."parentMessageSenderId",
        p."latestActivityPreview",
        p."latestActivitySenderType",
        p."latestActivitySenderId",
        p."latestActivityMessageId"::text AS "latestActivityMessageId",
        ${timestampText('p."lastActivityAtRaw"')} AS "lastActivityAt",
        CASE WHEN p."lastReplyAtRaw" IS NULL THEN NULL::text ELSE ${timestampText('p."lastReplyAtRaw"')} END AS "lastReplyAt",
        p."replyCount",
        p."taskNumber",
        p."taskStatus",
        p."taskClaimedByType",
        p."taskClaimedById",
        p."taskClaimedByName",
        (CASE WHEN p."mentionOnly" THEN p."hasAnyMention" ELSE p."hasMention" END) AS "hasMention",
        -- TODO(firstMentionMessageId): materialize first_mention_message_id in
        -- rw_inbox_items_v2 MV + parity; Postgres-path-first. Until then the RW
        -- backend does not project this column, so the shared result mapper in
        -- getInboxItems resolves row.firstMentionMessageId to null for RW rows.
        p."materializedLastReadSeq",
        p."maxReadSeq",
        p."readStateVersion",
        p."readCursorPresent",
        p."activityAt"
      FROM page p
    )
    SELECT
      page_enriched.*,
      totals."totalCount",
      totals."totalUnreadCount",
      active_totals."activeUnreadCount",
      group_totals."groupChannelIds",
      group_totals."groupChannelNames",
      group_totals."groupChannelTypes",
      group_totals."groupCounts",
      group_totals."groupLastActivityAts",
      read_authority."readAuthorityPresent",
      read_authority."readAuthoritySeq"
    FROM totals
    CROSS JOIN active_totals
    CROSS JOIN group_totals
    CROSS JOIN read_authority
    LEFT JOIN page_enriched ON true
    ORDER BY page_enriched."activityAt" ${sortDirection} NULLS LAST,
      page_enriched."kind" ${sortDirection},
      COALESCE(page_enriched."threadChannelId", page_enriched."channelId") ${sortDirection}
  `;
}

function getRisingWaveInboxItemsServingView(version: RisingWaveInboxItemsServingVersion): string {
  return version === 3
    ? RW_INBOX_ITEMS_V3_SERVING_VIEW
    : version === 2
      ? RW_INBOX_ITEMS_V2_SERVING_VIEW
      : RW_INBOX_ITEMS_V1_SERVING_VIEW;
}

async function getInboxItemsFromRisingWave(
  serverId: string,
  userId: string,
  opts: {
    filter: InboxFilter;
    limit: number;
    offset: number;
    channelId?: string;
    q?: string;
    historyCutoff?: Date;
    includeMentionOnlyInAllAndUnread?: boolean;
    sort?: "asc" | "desc";
    servingVersion?: RisingWaveInboxItemsServingVersion;
    requestedServingVersion?: RisingWaveInboxItemsServingVersion;
    traceQuery: DbQueryTracer;
  },
): Promise<InboxQueryResult | null> {
  const client = getRisingWaveInboxPool();
  // CONTRACT: This is the only env-gated RW Inbox backend. No-env and
  // v1 history_cutoff traffic intentionally use the Postgres serving-row SQL in
  // getInboxItems. SYNC REQUIRED: fallback/error behavior changes here must be
  // reflected in tracing expectations and parity verification.
  if (!client) return null;

  const pageLimit = Math.trunc(opts.limit + 1);
  const pageOffset = Math.trunc(opts.offset);
  const inboxItemsVersion = opts.servingVersion ?? getRisingWaveInboxItemsServingVersion();
  const requestedInboxItemsVersion = opts.requestedServingVersion ?? inboxItemsVersion;
  const forcedV2ForHistoryCutoff = Boolean(opts.historyCutoff
    && requestedInboxItemsVersion === 3
    && inboxItemsVersion === 2);
  if (opts.historyCutoff && inboxItemsVersion !== 2) return null;
  // Limit/offset are clamped by getInboxItems before this point and truncated
  // again here. Keep them as SQL literals because RisingWave does not accept
  // bound parameters in LIMIT/OFFSET in this shared serving query shape.
  const queryParams: unknown[] = [serverId, userId, opts.filter, opts.historyCutoff ?? null, opts.channelId ?? null, opts.q ?? null];
  const read = await opts.traceQuery(
    "channels.inbox_items_by_user",
    () => queryRisingWaveInbox(client, buildRisingWaveInboxItemsServingQuery(pageLimit, pageOffset, inboxItemsVersion, {
      includeMentionOnlyInAllAndUnread: opts.includeMentionOnlyInAllAndUnread,
      sort: opts.sort,
    }), queryParams),
    (queryRead) => ({
      ...inboxTraceAttrs("rw_mv", opts.filter, "none", inboxItemsVersion),
      backend: "risingwave",
      contract_version: inboxItemsVersion,
      "rw.acquire_wait_ms": Math.round(queryRead.acquireWaitMs),
      "rw.pool.total_count": queryRead.poolState.rw_pool_total,
      "rw.pool.idle_count": queryRead.poolState.rw_pool_idle,
      "rw.pool.waiting_count": queryRead.poolState.rw_pool_waiting,
      "rw.timeout_ms": getRisingWaveConnectionTimeoutMillis(),
      "rw.pool.connection_timeout_ms": getRisingWaveConnectionTimeoutMillis(),
      ...queryRead.poolState,
      rw_inbox_items_version: inboxItemsVersion,
      rw_inbox_items_requested_version: requestedInboxItemsVersion,
      rw_inbox_items_version_forced: forcedV2ForHistoryCutoff,
      rw_inbox_items_version_force_reason: forcedV2ForHistoryCutoff ? "history_cutoff" : "none",
      rw_inbox_visibility_v3_flag_enabled: requestedInboxItemsVersion === 3,
      filter: opts.filter,
      limit: opts.limit,
      offset: opts.offset,
      history_cutoff_present: Boolean(opts.historyCutoff),
      channel_id_present: Boolean(opts.channelId),
      query_present: Boolean(opts.q),
      row_count: queryRead.result.rows.length,
    }),
    (error) => risingWaveInboxFailureAttrs({
      route: opts.filter,
      error,
      contractVersion: inboxItemsVersion,
      queryName: "channels.inbox_items_by_user",
    }),
  );
  recordRisingWaveInboxThreadReplyCountNullContractViolation(read.result.rows, {
    filter: opts.filter,
    servedVersion: inboxItemsVersion,
    requestedVersion: requestedInboxItemsVersion,
    forcedV2ForHistoryCutoff,
    historyCutoff: Boolean(opts.historyCutoff),
  });
  return { rows: read.result.rows, contractVersion: inboxItemsVersion };
}

async function enrichInboxRowsWithProfileNames(
  rows: any[],
  traceQuery: DbQueryTracer,
  executor: DatabaseExecutor = getDb(),
) {
  // CONTRACT: RW intentionally does not materialize user/agent profile tables.
  // Both PG legacy rows and RW rows pass through this page-bounded enrichment
  // for lastMessageSenderName/taskClaimedByName. SYNC REQUIRED: if those fields
  // move into either backend query, update the other backend and parity script.
  if (rows.length === 0) return;
  const db = executor;

  const senderUserIds = new Set<string>();
  const senderAgentIds = new Set<string>();
  const externalSenderMessageIds = new Set<string>();
  const claimantUserIds = new Set<string>();
  const claimantAgentIds = new Set<string>();

  for (const row of rows) {
    if (!row.lastMessageSenderName && row.lastMessageSenderId) {
      if (row.lastMessageSenderType === "user" && UUID_TEXT_RE.test(row.lastMessageSenderId)) senderUserIds.add(row.lastMessageSenderId);
      if (row.lastMessageSenderType === "agent" && UUID_TEXT_RE.test(row.lastMessageSenderId)) senderAgentIds.add(row.lastMessageSenderId);
      if (row.lastMessageSenderType === "external_projection" && row.lastMessageId) externalSenderMessageIds.add(row.lastMessageId);
    }
    if (!row.latestActivitySenderName
      && row.latestActivitySenderType === "external_projection"
      && row.latestActivityMessageId) {
      externalSenderMessageIds.add(row.latestActivityMessageId);
    }
    if (!row.taskClaimedByName && row.taskClaimedById) {
      if (row.taskClaimedByType === "user" && UUID_TEXT_RE.test(row.taskClaimedById)) claimantUserIds.add(row.taskClaimedById);
      if (row.taskClaimedByType === "agent" && UUID_TEXT_RE.test(row.taskClaimedById)) claimantAgentIds.add(row.taskClaimedById);
    }
  }

  const userIds = [...new Set([...senderUserIds, ...claimantUserIds])];
  const agentIds = [...new Set([...senderAgentIds, ...claimantAgentIds])];
  const userNameMap = new Map<string, string>();
  const agentNameMap = new Map<string, string>();
  const externalNameByMessageId = new Map<string, string>();

  if (userIds.length > 0) {
    const userRows = await traceQuery(
      "channels.inbox_profile_names.users",
      () => db
        .select({ id: users.id, name: users.name, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, userIds)),
      (result) => ({ input_count: userIds.length, result_count: result.length }),
    );
    for (const user of userRows) userNameMap.set(user.id, user.displayName || user.name);
  }

  if (agentIds.length > 0) {
    const agentRows = await traceQuery(
      "channels.inbox_profile_names.agents",
      () => db
        .select({ id: agents.id, name: agents.name, displayName: agents.displayName })
        .from(agents)
        .where(inArray(agents.id, agentIds)),
      (result) => ({ input_count: agentIds.length, result_count: result.length }),
    );
    for (const agent of agentRows) agentNameMap.set(agent.id, agent.displayName || agent.name);
  }

  if (externalSenderMessageIds.size > 0) {
    const externalRows = await traceQuery(
      "channels.inbox_profile_names.external_projections",
      () => db
        .select({ messageId: externalMessageAuthorFacts.messageId, displayName: externalMessageAuthorFacts.displayName })
        .from(externalMessageAuthorFacts)
        .where(inArray(externalMessageAuthorFacts.messageId, [...externalSenderMessageIds])),
      (result) => ({ input_count: externalSenderMessageIds.size, result_count: result.length }),
    );
    for (const external of externalRows) externalNameByMessageId.set(external.messageId, external.displayName);
    if (externalNameByMessageId.size !== externalSenderMessageIds.size) {
      throw new Error("External projection inbox row is missing immutable author fact");
    }
  }

  for (const row of rows) {
    if (!row.lastMessageSenderName && row.lastMessageSenderId) {
      if (row.lastMessageSenderType === "user") row.lastMessageSenderName = userNameMap.get(row.lastMessageSenderId) ?? null;
      if (row.lastMessageSenderType === "agent") row.lastMessageSenderName = agentNameMap.get(row.lastMessageSenderId) ?? null;
      if (row.lastMessageSenderType === "external_projection") row.lastMessageSenderName = externalNameByMessageId.get(row.lastMessageId) ?? null;
    }
    if (!row.latestActivitySenderName && row.latestActivitySenderType === "external_projection") {
      row.latestActivitySenderName = externalNameByMessageId.get(row.latestActivityMessageId) ?? null;
    }
    if (!row.taskClaimedByName && row.taskClaimedById) {
      if (row.taskClaimedByType === "user") row.taskClaimedByName = userNameMap.get(row.taskClaimedById) ?? null;
      if (row.taskClaimedByType === "agent") row.taskClaimedByName = agentNameMap.get(row.taskClaimedById) ?? null;
    }
  }
}

async function getSidebarUnreadSummaryCountsFromRisingWave(
  servers: SidebarUnreadSummaryInput[],
  userId: string,
  traceQuery: DbQueryTracer,
): Promise<Record<string, number> | null> {
  const client = getRisingWaveInboxPool();
  // CONTRACT: rw_sidebar_unread_summary_v1 must match the inline Postgres SQL
  // in getSidebarUnreadSummaryCounts below. SYNC REQUIRED: membership,
  // channel-type, archived/deleted, history-cutoff, or count semantic changes
  // must be mirrored in infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql
  // and verified with risingwave:verify-inbox-parity.
  if (!client) return null;

  const counts: Record<string, number> = {};
  for (const server of servers) counts[server.serverId] = 0;

  const serverIds = servers.map((server) => server.serverId);
  const rows = await traceQuery(
    "servers.sidebar_unread_counts_by_user",
    () => queryRisingWaveInbox(client, `
      SELECT server_id::text AS "serverId", unread_count::int AS "count"
      FROM rw_sidebar_unread_summary_v1
      WHERE user_id = $1
        AND server_id = ANY($2::varchar[])
    `, [userId, serverIds]),
    (result) => ({
      ...inboxTraceAttrs("rw_mv", "sidebar_summary", "none", RISINGWAVE_LEGACY_UNREAD_CONTRACT_VERSION),
      backend: "risingwave",
      contract_version: RISINGWAVE_LEGACY_UNREAD_CONTRACT_VERSION,
      "rw.acquire_wait_ms": Math.round(result.acquireWaitMs),
      "rw.pool.total_count": result.poolState.rw_pool_total,
      "rw.pool.idle_count": result.poolState.rw_pool_idle,
      "rw.pool.waiting_count": result.poolState.rw_pool_waiting,
      "rw.timeout_ms": getRisingWaveConnectionTimeoutMillis(),
      "rw.pool.connection_timeout_ms": getRisingWaveConnectionTimeoutMillis(),
      ...result.poolState,
      servers_count: servers.length,
      servers_with_unread_count: result.result.rows.length,
      history_cutoff_present_count: 0,
    }),
    (error) => risingWaveInboxFailureAttrs({
      route: "sidebar_summary",
      error,
      contractVersion: RISINGWAVE_LEGACY_UNREAD_CONTRACT_VERSION,
      queryName: "servers.sidebar_unread_counts_by_user",
    }),
  );

  for (const row of rows.result.rows as { serverId: string; count: number }[]) {
    counts[row.serverId] = row.count;
  }
  return counts;
}

async function getUnreadCountsFromRisingWave(
  serverId: string,
  userId: string,
  historyCutoff: Date | undefined,
  traceQuery: DbQueryTracer,
): Promise<Record<string, number> | null> {
  // CONTRACT: RISINGWAVE_CHANNEL_UNREAD_COUNTS_VIEW materializes user-scoped
  // private/DM/joint/thread unread rows for GET /api/channels/unread. Public
  // non-thread channel unread is computed in the serving query because it is
  // visible to any current user, but still needs the requested userId for read
  // cursor and self-sent-message exclusion. SYNC REQUIRED: if the Postgres SQL
  // in getUnreadCounts changes membership, thread parent access,
  // archived/deleted, history-cutoff, or count semantics, update the RW query
  // and MV in infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql and rerun
  // risingwave:verify-inbox-parity.
  //
  // The RW MV covers full retained history. Per-plan history_cutoff requests use
  // Postgres until a cutoff-aware RW contract is designed.
  if (historyCutoff) return null;

  const client = getRisingWaveInboxPool();
  if (!client) return null;

  const rows = await traceQuery(
    "channels.unread_counts_by_user",
    () => queryRisingWaveInbox(client, `
      WITH public_unread AS (
        SELECT
          c.id AS channel_id,
          count(m.id)::int AS unread_count
        FROM rw_channels AS c
        LEFT JOIN rw_user_channel_read_cursors AS rc
          ON rc.channel_id = c.id
         AND rc.user_id = $2
        JOIN rw_messages AS m
          ON m.channel_id = c.id
         AND m.seq > COALESCE(rc.last_read_seq, 0)
         AND NOT (m.sender_type = 'user' AND m.sender_id = $2)
        WHERE c.server_id = $1
          AND c.deleted_at IS NULL
          AND c.archived_at IS NULL
          AND c.type NOT IN ('dm', 'private', 'joint', 'thread')
        GROUP BY c.id
      ),
      scoped_unread AS (
        SELECT v.channel_id, v.unread_count::int AS unread_count
        FROM ${RISINGWAVE_CHANNEL_UNREAD_COUNTS_VIEW} AS v
        JOIN rw_channels AS c
          ON c.id = v.channel_id
        WHERE v.server_id = $1
          AND v.user_id = $2
          AND c.type IN ('dm', 'private', 'joint', 'thread')
      )
      SELECT channel_id AS "channelId", unread_count::int AS "count"
      FROM public_unread
      UNION ALL
      SELECT channel_id AS "channelId", unread_count::int AS "count"
      FROM scoped_unread
      ORDER BY "channelId"
    `, [serverId, userId]),
    (result) => ({
      ...inboxTraceAttrs("rw_mv", "channel_unread", "none", RISINGWAVE_CHANNEL_UNREAD_CONTRACT_VERSION),
      backend: "risingwave",
      contract_version: RISINGWAVE_CHANNEL_UNREAD_CONTRACT_VERSION,
      "rw.acquire_wait_ms": Math.round(result.acquireWaitMs),
      "rw.pool.total_count": result.poolState.rw_pool_total,
      "rw.pool.idle_count": result.poolState.rw_pool_idle,
      "rw.pool.waiting_count": result.poolState.rw_pool_waiting,
      "rw.timeout_ms": getRisingWaveConnectionTimeoutMillis(),
      "rw.pool.connection_timeout_ms": getRisingWaveConnectionTimeoutMillis(),
      ...result.poolState,
      rw_channel_unread_counts_view: RISINGWAVE_CHANNEL_UNREAD_COUNTS_VIEW,
      unread_channels_count: result.result.rows.length,
      history_cutoff_present: false,
    }),
    (error) => risingWaveInboxFailureAttrs({
      route: "channel_unread",
      error,
      contractVersion: RISINGWAVE_CHANNEL_UNREAD_CONTRACT_VERSION,
      queryName: "channels.unread_counts_by_user",
    }),
  );

  const counts: Record<string, number> = {};
  for (const row of rows.result.rows as { channelId: string; count: number }[]) {
    counts[row.channelId] = row.count;
  }
  return counts;
}

async function tryGetInboxItemsFromRisingWave(
  serverId: string,
  userId: string,
  opts: {
    filter: InboxFilter;
    limit: number;
    offset: number;
    channelId?: string;
    q?: string;
    historyCutoff?: Date;
    includeMentionOnlyInAllAndUnread?: boolean;
    sort?: "asc" | "desc";
    traceQuery: DbQueryTracer;
  },
): Promise<RisingWaveInboxAttempt<InboxQueryResult>> {
  if (!getRisingWaveInboxPool()) return { result: null };

  const requestedInboxItemsVersion = await risingWaveInboxFailSoftDeps.getInboxItemsServingVersion(serverId, userId);
  const inboxItemsVersion = selectRisingWaveInboxItemsServingVersionForRequest(requestedInboxItemsVersion, opts);
  return tryReadRisingWaveInboxWithFailSoft(
    opts.filter,
    inboxItemsVersion,
    () => getInboxItemsFromRisingWave(serverId, userId, {
      ...opts,
      servingVersion: inboxItemsVersion,
      requestedServingVersion: requestedInboxItemsVersion,
    }),
  );
}

async function tryGetUnreadCountsFromRisingWave(
  serverId: string,
  userId: string,
  historyCutoff: Date | undefined,
  traceQuery: DbQueryTracer,
): Promise<RisingWaveInboxAttempt<Record<string, number>>> {
  if (!getRisingWaveInboxPool()) return { result: null };
  return tryReadRisingWaveInboxWithFailSoft(
    "channel_unread",
    RISINGWAVE_CHANNEL_UNREAD_CONTRACT_VERSION,
    () => getUnreadCountsFromRisingWave(serverId, userId, historyCutoff, traceQuery),
  );
}

async function getInboxItemsFromServingRows(
  serverId: string,
  userId: string,
  opts: {
    filter: InboxFilter;
    limit: number;
    offset: number;
    channelId?: string;
    q?: string;
    sort?: "asc" | "desc";
    historyCutoff?: Date;
    fallbackReason?: InboxFallbackReason;
    postgresSelectionReason?: InboxPostgresSelectionReason;
    traceQuery: DbQueryTracer;
    executor?: DatabaseExecutor;
  },
): Promise<InboxQueryResult> {
  const db = opts.executor ?? getDb();
  const guestAccess = await guestInboxChannelIds(serverId, userId, db);
  const sortDirection = opts.sort === "asc" ? sql`ASC` : sql`DESC`;
  const historyCutoffPredicate = opts.historyCutoff
    ? sql`AND last_activity_at > ${opts.historyCutoff}`
    : sql``;
  const searchPattern = opts.q ? `%${opts.q}%` : null;
  const searchPredicate = searchPattern
    ? sql`AND (
        COALESCE(channel_name, '') ILIKE ${searchPattern}
        OR EXISTS (
          SELECT 1
          FROM messages search_message
          LEFT JOIN users search_user
            ON search_message.sender_type = 'user'
           AND search_user.id::text = search_message.sender_id
          LEFT JOIN agents search_agent
            ON search_message.sender_type = 'agent'
           AND search_agent.id::text = search_message.sender_id
          WHERE search_message.channel_id = all_visible_rows.storage_channel_id
            AND (
              search_message.content ILIKE ${searchPattern}
              OR COALESCE(search_user.display_name, search_user.name, search_agent.display_name, search_agent.name, '') ILIKE ${searchPattern}
            )
        )
        OR (
          kind = 'thread'
          AND EXISTS (
            SELECT 1
            FROM channels search_thread
            LEFT JOIN joint_channel_servers search_thread_projection
              ON search_thread_projection.local_channel_id = search_thread.id
             AND search_thread_projection.server_id = ${serverId}
             AND search_thread_projection.status = 'active'
            LEFT JOIN joint_channels search_thread_joint
              ON search_thread_joint.id = search_thread_projection.joint_channel_id
             AND search_thread_joint.status = 'active'
            LEFT JOIN channels search_canonical_thread
              ON search_canonical_thread.id = search_thread_joint.canonical_channel_id
            INNER JOIN messages search_parent_message
              ON search_parent_message.id = COALESCE(search_canonical_thread.parent_message_id, search_thread.parent_message_id)
            INNER JOIN channels search_parent_channel
              ON search_parent_channel.id = search_parent_message.channel_id
            WHERE search_thread.id = all_visible_rows.source_channel_id
              AND (
                search_parent_channel.name ILIKE ${searchPattern}
                OR search_parent_message.content ILIKE ${searchPattern}
              )
          )
        )
      )`
    : sql``;
  const splitAllPageEnrichment = opts.filter === "all";
  const splitAllMetadata = splitAllPageEnrichment && opts.channelId == null;
  type ServingRowsOutput = "combined" | "page" | "metadata";
  const buildServingRowsQuery = (
    output: ServingRowsOutput = splitAllMetadata ? "page" : "combined",
  ) => {
    const isAllFilter = opts.filter === "all";
    const selectedSource = splitAllMetadata && output === "page"
      ? sql`filtered`
      : sql`faceted`;
    const selectedGroupPredicate = splitAllMetadata && output === "page"
      ? sql``
      : sql`WHERE ${opts.channelId ?? null}::uuid IS NULL OR "groupChannelId" = ${opts.channelId ?? null}::uuid`;
    const mentionAggregationCtes = isAllFilter
      ? sql`
    mention_presence AS MATERIALIZED (
      SELECT DISTINCT mention.source_channel_id
      FROM scoped_mentions mention
    ),
    live_mentions AS MATERIALIZED (
      SELECT
        NULL::uuid AS source_channel_id,
        NULL::uuid AS latest_message_id,
        NULL::bigint AS latest_message_seq,
        0::int AS unread_mention_count,
        NULL::uuid AS first_unread_message_id
      WHERE false
    ),`
      : sql`
    mention_presence AS MATERIALIZED (
      SELECT NULL::uuid AS source_channel_id
      WHERE false
    ),
    live_mentions AS MATERIALIZED (
      SELECT
        mention.source_channel_id,
        (array_agg(mention.message_id ORDER BY mention.message_seq DESC, mention.message_id DESC))[1] AS latest_message_id,
        max(mention.message_seq) AS latest_message_seq,
        (count(*) FILTER (
          WHERE mention.message_seq > mention.last_read_seq
        ))::int AS unread_mention_count,
        (array_agg(mention.message_id ORDER BY mention.message_seq ASC, mention.message_id ASC) FILTER (
          WHERE mention.message_seq > mention.last_read_seq
        ))[1] AS first_unread_message_id
      FROM scoped_mentions mention
      GROUP BY mention.source_channel_id, mention.last_read_seq
    ),`;
    const filterPredicate = opts.filter === "all"
      ? sql`true`
      : opts.filter === "unread"
        ? sql`mention_only = false AND unread_count > 0`
        : opts.filter === "mentions"
          ? sql`has_any_mention = true`
          : sql`mention_only = false AND unread_count > 0 AND unread_mention_count > 0`;
    const pageMentionAggregationCte = isAllFilter
      ? sql`
    page_live_mentions AS MATERIALIZED (
      SELECT
        mention.source_channel_id,
        (array_agg(mention.message_id ORDER BY mention.message_seq DESC, mention.message_id DESC))[1] AS latest_message_id,
        max(mention.message_seq) AS latest_message_seq,
        (count(*) FILTER (
          WHERE mention.message_seq > mention.last_read_seq
        ))::int AS unread_mention_count,
        (array_agg(mention.message_id ORDER BY mention.message_seq ASC, mention.message_id ASC) FILTER (
          WHERE mention.message_seq > mention.last_read_seq
        ))[1] AS first_unread_message_id
      FROM scoped_mentions mention
      INNER JOIN page selected_page
        ON selected_page.source_channel_id = mention.source_channel_id
      GROUP BY mention.source_channel_id, mention.last_read_seq
    ),`
      : sql`
    page_live_mentions AS MATERIALIZED (
      SELECT
        NULL::uuid AS source_channel_id,
        NULL::uuid AS latest_message_id,
        NULL::bigint AS latest_message_seq,
        0::int AS unread_mention_count,
        NULL::uuid AS first_unread_message_id
      WHERE false
    ),`;
    const pageEnrichmentFields = splitAllPageEnrichment
      ? sql`
        CASE
          WHEN p.kind = 'thread' THEN NULL::text
          ELSE (
            CASE
              WHEN p.mention_only THEN p.effective_latest_personal_mention_message_id
              ELSE p.latest_notified_message_id
            END
          )::text
        END AS "lastMessageId",
        NULL::text AS "lastMessageAt",
        NULL::text AS "lastMessagePreview",
        NULL::text AS "lastMessageSenderType",
        NULL::text AS "lastMessageSenderId",
        NULL::text AS "parentMessageId",
        NULL::text AS "parentChannelId",
        NULL::text AS "parentChannelName",
        NULL::text AS "parentChannelType",
        NULL::text AS "parentMessagePreview",
        NULL::text AS "parentMessageSenderType",
        NULL::text AS "parentMessageSenderId",
        NULL::text AS "latestActivityPreview",
        NULL::text AS "latestActivitySenderType",
        NULL::text AS "latestActivitySenderId",
        NULL::text AS "latestActivityMessageId",
        NULL::text AS "latestActivitySeq",
        NULL::text AS "lastActivityAt",
        NULL::text AS "lastReplyAt",
        NULL::int AS "replyCount",
        NULL::int AS "taskNumber",
        NULL::text AS "taskStatus",
        NULL::text AS "taskClaimedByType",
        NULL::text AS "taskClaimedById",
        p.storage_channel_id::text AS "_storageChannelId",
        (
          CASE
            WHEN p.mention_only THEN p.effective_latest_personal_mention_message_id
            ELSE p.latest_notified_message_id
          END
        )::text AS "_latestMessageLookupId",`
      : sql`
        CASE WHEN p.kind = 'thread' THEN NULL::text ELSE latest_message.id::text END AS "lastMessageId",
        CASE WHEN p.kind = 'thread' THEN NULL::text ELSE to_char((latest_message.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' END AS "lastMessageAt",
        CASE WHEN p.kind = 'thread' THEN NULL::text ELSE latest_message.content END AS "lastMessagePreview",
        CASE WHEN p.kind = 'thread' THEN NULL::text ELSE latest_message.sender_type END AS "lastMessageSenderType",
        CASE WHEN p.kind = 'thread' THEN NULL::text ELSE latest_message.sender_id END AS "lastMessageSenderId",
        pm.id::text AS "parentMessageId",
        COALESCE(local_parent.id, parent_ch.id)::text AS "parentChannelId",
        COALESCE(local_parent.name, parent_ch.name) AS "parentChannelName",
        COALESCE(local_parent.type::text, parent_ch.type::text) AS "parentChannelType",
        pm.content AS "parentMessagePreview",
        pm.sender_type AS "parentMessageSenderType",
        pm.sender_id AS "parentMessageSenderId",
        COALESCE(latest_message.content, pm.content) AS "latestActivityPreview",
        COALESCE(latest_message.sender_type, pm.sender_type) AS "latestActivitySenderType",
        COALESCE(latest_message.sender_id, pm.sender_id) AS "latestActivitySenderId",
        COALESCE(latest_message.id, pm.id)::text AS "latestActivityMessageId",
        COALESCE(latest_message.seq, pm.seq)::text AS "latestActivitySeq",
        to_char((COALESCE(latest_message.created_at, pm.created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastActivityAt",
        CASE WHEN p.kind = 'thread' AND latest_message.id IS NOT NULL THEN to_char((latest_message.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' ELSE NULL::text END AS "lastReplyAt",
        CASE WHEN p.kind = 'thread' THEN COALESCE(reply_count.reply_count, 0)::int ELSE NULL::int END AS "replyCount",
        task.task_number AS "taskNumber",
        task.status AS "taskStatus",
        task.claimed_by_type AS "taskClaimedByType",
        task.claimed_by_id AS "taskClaimedById",`;
    const pageEnrichmentJoins = splitAllPageEnrichment
      ? sql``
      : sql`
      LEFT JOIN messages latest_message
        ON latest_message.id = CASE
          WHEN p.mention_only THEN p.effective_latest_personal_mention_message_id
          ELSE p.latest_notified_message_id
        END
      LEFT JOIN channels thread_channel
        ON thread_channel.id = p.source_channel_id
       AND p.kind = 'thread'
      LEFT JOIN joint_channel_servers thread_projection
        ON thread_projection.local_channel_id = thread_channel.id
       AND thread_projection.server_id = ${serverId}
       AND thread_projection.status = 'active'
      LEFT JOIN joint_channels thread_joint
        ON thread_joint.id = thread_projection.joint_channel_id
       AND thread_joint.status = 'active'
      LEFT JOIN channels canonical_thread
        ON canonical_thread.id = thread_joint.canonical_channel_id
       AND canonical_thread.type = 'thread'
       AND canonical_thread.deleted_at IS NULL
      LEFT JOIN messages pm
        ON pm.id = COALESCE(canonical_thread.parent_message_id, thread_channel.parent_message_id)
      LEFT JOIN channels parent_ch
        ON parent_ch.id = pm.channel_id
      LEFT JOIN joint_channels parent_joint
        ON parent_joint.canonical_channel_id = pm.channel_id
       AND parent_joint.status = 'active'
      LEFT JOIN joint_channel_servers parent_projection
        ON parent_projection.joint_channel_id = parent_joint.id
       AND parent_projection.server_id = ${serverId}
       AND parent_projection.status = 'active'
      LEFT JOIN channels local_parent
        ON local_parent.id = parent_projection.local_channel_id
       AND local_parent.type = 'joint'
       AND local_parent.archived_at IS NULL
       AND local_parent.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS reply_count
        FROM messages m
        WHERE p.kind = 'thread'
          AND m.channel_id = p.storage_channel_id
      ) reply_count ON true
      LEFT JOIN tasks task
        ON task.message_id = pm.id`;
    const commonCtes = sql`
    receiver_scope_ids AS MATERIALIZED (
      SELECT source_row.source_channel_id
      FROM inbox_serving_rows source_row
      INNER JOIN channels source_channel
        ON source_channel.id = source_row.source_channel_id
       AND source_channel.server_id = ${serverId}::uuid
       AND source_channel.deleted_at IS NULL
       AND source_channel.archived_at IS NULL
      LEFT JOIN user_channel_inbox_states scope_inbox
        ON scope_inbox.channel_id = source_channel.id
       AND scope_inbox.user_id = ${userId}::uuid
      WHERE source_row.receiver_type = 'user'
        AND source_row.receiver_id = ${userId}::uuid
        AND source_row.server_id = ${serverId}::uuid
        AND scope_inbox.done_at IS NULL
    ),
    receiver_rows AS MATERIALIZED (
      SELECT
        r.receiver_type,
        r.receiver_id,
        r.server_id,
        r.kind,
        r.source_channel_id,
        r.latest_notified_message_id,
        r.latest_notified_seq,
        r.latest_notified_at,
        r.last_activity_at,
        r.first_unread_message_id,
        r.first_unread_seq,
        r.unread_count::int AS unread_count,
        r.latest_personal_mention_message_id,
        r.latest_personal_mention_seq,
        r.unread_mention_count,
        r.has_any_mention,
        c.name AS channel_name,
        c.type AS channel_type,
        COALESCE(joint_storage.canonical_channel_id, c.id) AS storage_channel_id,
        joint_projection.joint_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        inbox.done_at AS channel_done_at,
        chat_member.user_id AS chat_member_user_id,
        tf.thread_channel_id AS followed_thread_channel_id
      FROM receiver_scope_ids scope
      INNER JOIN inbox_serving_rows r
        ON r.source_channel_id = scope.source_channel_id
      INNER JOIN channels c
        ON c.id = r.source_channel_id
       AND c.deleted_at IS NULL
       AND c.archived_at IS NULL
      LEFT JOIN joint_channel_servers joint_projection
        ON joint_projection.local_channel_id = c.id
       AND joint_projection.server_id = c.server_id
       AND joint_projection.status = 'active'
      LEFT JOIN joint_channels joint_storage
        ON joint_storage.id = joint_projection.joint_channel_id
       AND joint_storage.status = 'active'
      LEFT JOIN user_channel_inbox_states inbox
        ON inbox.channel_id = c.id
       AND inbox.user_id = ${userId}
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id
       AND rc.user_id = ${userId}
      LEFT JOIN channel_humans chat_member
        ON chat_member.channel_id = c.id
       AND chat_member.user_id = ${userId}
      LEFT JOIN thread_follows tf
        ON tf.thread_channel_id = c.id
       AND tf.follower_type = 'user'
       AND tf.follower_id = ${userId}
       AND tf.done_at IS NULL
       AND tf.unfollowed_at IS NULL
      WHERE r.receiver_type = 'user'
        AND r.receiver_id = ${userId}::uuid
        AND r.server_id = ${serverId}
        AND c.server_id = ${serverId}
        AND inbox.done_at IS NULL
    ),
    receiver_scope_stats AS (
      SELECT count(*)::int AS receiver_scope_row_count
      FROM receiver_rows
    ),
    mention_scope AS MATERIALIZED (
      SELECT
        receiver.source_channel_id,
        receiver.source_channel_id AS mention_channel_id,
        receiver.last_read_seq
      FROM receiver_rows receiver
      UNION
      SELECT
        receiver.source_channel_id,
        sibling_projection.local_channel_id AS mention_channel_id,
        receiver.last_read_seq
      FROM receiver_rows receiver
      INNER JOIN joint_channel_servers sibling_projection
        ON sibling_projection.joint_channel_id = receiver.joint_channel_id
       AND sibling_projection.status = 'active'
    ),
    server_target_mentions AS MATERIALIZED (
      SELECT
        server_mention.channel_id,
        server_mention.message_id,
        server_mention.message_seq,
        server_mention.notified_at
      FROM message_mentions server_mention
      WHERE server_mention.target_type = 'user'
        AND server_mention.target_id = ${userId}::uuid
        AND server_mention.server_id = ${serverId}::uuid
        AND (server_mention.notifiable_at_send OR server_mention.notified_at IS NOT NULL)
    ),
    scoped_mentions AS MATERIALIZED (
      SELECT
        scope.source_channel_id,
        scope.last_read_seq,
        server_mention.message_id,
        server_mention.message_seq
      FROM mention_scope scope
      INNER JOIN server_target_mentions server_mention
        ON server_mention.channel_id = scope.mention_channel_id
      UNION ALL
      SELECT
        scope.source_channel_id,
        scope.last_read_seq,
        sibling_mention.message_id,
        sibling_mention.message_seq
      FROM mention_scope scope
      INNER JOIN message_mentions sibling_mention
        ON sibling_mention.channel_id = scope.mention_channel_id
       AND sibling_mention.target_type = 'user'
       AND sibling_mention.target_id = ${userId}::uuid
       AND sibling_mention.server_id <> ${serverId}::uuid
       AND (sibling_mention.notifiable_at_send OR sibling_mention.notified_at IS NOT NULL)
    ),
    ${mentionAggregationCtes}
    base_rows AS (
      SELECT
        r.receiver_type,
        r.receiver_id,
        r.server_id,
        r.kind,
        r.source_channel_id,
        r.latest_notified_message_id,
        r.latest_notified_seq,
        r.latest_notified_at,
        r.last_activity_at,
        r.first_unread_message_id,
        r.first_unread_seq,
        r.unread_count,
        CASE
          WHEN live_mentions.latest_message_seq IS NOT NULL
            AND (r.latest_personal_mention_seq IS NULL OR live_mentions.latest_message_seq >= r.latest_personal_mention_seq)
          THEN live_mentions.latest_message_id
          ELSE r.latest_personal_mention_message_id
        END AS latest_personal_mention_message_id,
        GREATEST(
          COALESCE(r.latest_personal_mention_seq, 0),
          COALESCE(live_mentions.latest_message_seq, 0)
        ) AS latest_personal_mention_seq,
        GREATEST(r.unread_mention_count, COALESCE(live_mentions.unread_mention_count, 0)) AS unread_mention_count,
        live_mentions.first_unread_message_id AS first_unread_personal_mention_message_id,
        (
          r.has_any_mention
          OR live_mentions.latest_message_id IS NOT NULL
          OR mention_presence.source_channel_id IS NOT NULL
        ) AS has_any_mention,
        r.channel_name,
        r.channel_type,
        r.storage_channel_id,
        r.joint_channel_id,
        r.last_read_seq,
        r.channel_done_at,
        r.chat_member_user_id,
        r.followed_thread_channel_id
      FROM receiver_rows r
      LEFT JOIN live_mentions
        ON live_mentions.source_channel_id = r.source_channel_id
      LEFT JOIN mention_presence
        ON mention_presence.source_channel_id = r.source_channel_id
    ),
    visible_rows AS (
      SELECT
        b.*,
        CASE
          WHEN b.kind IN ('channel', 'dm') AND b.chat_member_user_id IS NOT NULL THEN false
          WHEN b.kind = 'thread' AND b.followed_thread_channel_id IS NOT NULL THEN false
          ELSE true
        END AS mention_only
      FROM base_rows b
      WHERE (
          b.kind IN ('channel', 'dm')
          AND b.channel_type IN ('channel', 'private', 'joint', 'dm')
          AND b.chat_member_user_id IS NOT NULL
        )
        OR (
          b.kind = 'thread'
          AND b.followed_thread_channel_id IS NOT NULL
        )
        OR b.has_any_mention
    ),
    mention_channel_rows AS (
      SELECT
        'user' AS receiver_type,
        ${userId}::uuid AS receiver_id,
        ${serverId}::uuid AS server_id,
        CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind,
        c.id AS source_channel_id,
        m.id AS latest_notified_message_id,
        m.seq AS latest_notified_seq,
        m.created_at AS latest_notified_at,
        m.created_at AS last_activity_at,
        CASE
          WHEN chat_member.user_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN m.id
          ELSE NULL
        END AS first_unread_message_id,
        CASE
          WHEN chat_member.user_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN m.seq
          ELSE NULL
        END AS first_unread_seq,
        CASE
          WHEN chat_member.user_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN 1
          ELSE 0
        END::int AS unread_count,
        m.id AS latest_personal_mention_message_id,
        m.seq AS latest_personal_mention_seq,
        CASE WHEN m.seq > COALESCE(rc.last_read_seq, 0) THEN 1 ELSE 0 END::int AS unread_mention_count,
        -- Mention-only fallback rows: firstMentionMessageId is the notified mention
        -- ANCHOR (always), not the read-gated first-unread used by member rows. These
        -- rows exist only because of the @ (unreadCount=0), so they must always jump to
        -- the mention; aligned with pg_legacy and the canonical rule (ApplePI A).
        m.id AS first_unread_personal_mention_message_id,
        true AS has_any_mention,
        c.name AS channel_name,
        c.type AS channel_type,
        COALESCE(joint_storage.canonical_channel_id, c.id) AS storage_channel_id,
        joint_projection.joint_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        inbox.done_at AS channel_done_at,
        chat_member.user_id AS chat_member_user_id,
        NULL::uuid AS followed_thread_channel_id,
        CASE WHEN chat_member.user_id IS NOT NULL THEN false ELSE true END AS mention_only
      FROM (
        SELECT
          mm.channel_id,
          max(mm.message_seq) AS latest_mention_seq
        FROM server_target_mentions mm
        INNER JOIN channels mention_channel
          ON mention_channel.id = mm.channel_id
        LEFT JOIN channel_humans member_check
          ON member_check.channel_id = mm.channel_id
         AND member_check.user_id = ${userId}
        LEFT JOIN user_channel_inbox_states inbox_check
          ON inbox_check.channel_id = mm.channel_id
         AND inbox_check.user_id = ${userId}
        LEFT JOIN inbox_suppression_states mention_suppression
          ON mention_suppression.receiver_type = 'user'
         AND mention_suppression.receiver_id = ${userId}::uuid
         AND mention_suppression.target_kind = 'public_channel_mention'
         AND mention_suppression.target_channel_id = mm.channel_id
        WHERE mention_channel.server_id = ${serverId}
          AND mention_channel.type IN ('channel', 'private', 'joint', 'dm')
          AND mention_channel.deleted_at IS NULL
          AND mention_channel.archived_at IS NULL
          AND inbox_check.done_at IS NULL
          AND (
            member_check.user_id IS NOT NULL
            OR (mention_channel.type = 'channel' AND mm.notified_at IS NOT NULL)
          )
        GROUP BY mm.channel_id
      ) latest_mention
      INNER JOIN channels c
        ON c.id = latest_mention.channel_id
      INNER JOIN messages m
        ON m.channel_id = latest_mention.channel_id
       AND m.seq = latest_mention.latest_mention_seq
      LEFT JOIN joint_channel_servers joint_projection
        ON joint_projection.local_channel_id = c.id
       AND joint_projection.server_id = c.server_id
       AND joint_projection.status = 'active'
      LEFT JOIN joint_channels joint_storage
        ON joint_storage.id = joint_projection.joint_channel_id
       AND joint_storage.status = 'active'
      LEFT JOIN user_channel_inbox_states inbox
        ON inbox.channel_id = c.id
       AND inbox.user_id = ${userId}
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id
       AND rc.user_id = ${userId}
      LEFT JOIN channel_humans chat_member
        ON chat_member.channel_id = c.id
       AND chat_member.user_id = ${userId}
    ),
    mention_thread_rows AS (
      SELECT
        'user' AS receiver_type,
        ${userId}::uuid AS receiver_id,
        ${serverId}::uuid AS server_id,
        'thread' AS kind,
        t.id AS source_channel_id,
        m.id AS latest_notified_message_id,
        m.seq AS latest_notified_seq,
        m.created_at AS latest_notified_at,
        m.created_at AS last_activity_at,
        CASE
          WHEN existing_follow.thread_channel_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN m.id
          ELSE NULL
        END AS first_unread_message_id,
        CASE
          WHEN existing_follow.thread_channel_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN m.seq
          ELSE NULL
        END AS first_unread_seq,
        CASE
          WHEN existing_follow.thread_channel_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN 1
          ELSE 0
        END::int AS unread_count,
        m.id AS latest_personal_mention_message_id,
        m.seq AS latest_personal_mention_seq,
        CASE WHEN m.seq > COALESCE(rc.last_read_seq, 0) THEN 1 ELSE 0 END::int AS unread_mention_count,
        -- Mention-only fallback rows: firstMentionMessageId is the notified mention
        -- ANCHOR (always), not the read-gated first-unread used by member rows. These
        -- rows exist only because of the @ (unreadCount=0), so they must always jump to
        -- the mention; aligned with pg_legacy and the canonical rule (ApplePI A).
        m.id AS first_unread_personal_mention_message_id,
        true AS has_any_mention,
        t.name AS channel_name,
        t.type AS channel_type,
        COALESCE(canonical_thread.id, t.id) AS storage_channel_id,
        thread_projection.joint_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        NULL::timestamp AS channel_done_at,
        NULL::uuid AS chat_member_user_id,
        existing_follow.thread_channel_id AS followed_thread_channel_id,
        CASE WHEN existing_follow.thread_channel_id IS NOT NULL THEN false ELSE true END AS mention_only
      FROM (
        SELECT
          mm.channel_id,
          max(mm.message_seq) AS latest_mention_seq
        FROM server_target_mentions mm
        INNER JOIN channels thread_channel
          ON thread_channel.id = mm.channel_id
        INNER JOIN messages parent_message
          ON parent_message.id = thread_channel.parent_message_id
        INNER JOIN channels parent_channel
          ON parent_channel.id = parent_message.channel_id
        LEFT JOIN thread_follows existing_follow
          ON existing_follow.thread_channel_id = mm.channel_id
         AND existing_follow.follower_type = 'user'
         AND existing_follow.follower_id = ${userId}
         AND existing_follow.done_at IS NULL
         AND existing_follow.unfollowed_at IS NULL
        LEFT JOIN channel_humans parent_member
          ON parent_member.channel_id = parent_channel.id
         AND parent_member.user_id = ${userId}
        LEFT JOIN inbox_suppression_states mention_suppression
          ON mention_suppression.receiver_type = 'user'
         AND mention_suppression.receiver_id = ${userId}::uuid
         AND mention_suppression.target_kind = 'public_thread_mention'
         AND mention_suppression.target_channel_id = mm.channel_id
        WHERE thread_channel.server_id = ${serverId}
          AND thread_channel.type = 'thread'
          AND thread_channel.deleted_at IS NULL
          AND parent_channel.archived_at IS NULL
          AND parent_channel.deleted_at IS NULL
          AND (
            existing_follow.thread_channel_id IS NOT NULL
            OR (
              mm.notified_at IS NOT NULL
              AND (
                parent_channel.type = 'channel'
                OR parent_member.user_id IS NOT NULL
              )
            )
          )
        GROUP BY mm.channel_id
      ) latest_mention
      INNER JOIN channels t
        ON t.id = latest_mention.channel_id
      INNER JOIN messages m
        ON m.channel_id = latest_mention.channel_id
       AND m.seq = latest_mention.latest_mention_seq
      LEFT JOIN joint_channel_servers thread_projection
        ON thread_projection.local_channel_id = t.id
       AND thread_projection.server_id = ${serverId}
       AND thread_projection.status = 'active'
      LEFT JOIN joint_channels thread_joint
        ON thread_joint.id = thread_projection.joint_channel_id
       AND thread_joint.status = 'active'
      LEFT JOIN channels canonical_thread
        ON canonical_thread.id = thread_joint.canonical_channel_id
       AND canonical_thread.type = 'thread'
       AND canonical_thread.deleted_at IS NULL
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = t.id
       AND rc.user_id = ${userId}
      LEFT JOIN thread_follows existing_follow
        ON existing_follow.thread_channel_id = t.id
       AND existing_follow.follower_type = 'user'
       AND existing_follow.follower_id = ${userId}
       AND existing_follow.done_at IS NULL
       AND existing_follow.unfollowed_at IS NULL
    ),
    all_visible_rows AS (
      SELECT * FROM visible_rows
      UNION ALL
      SELECT mc.*
      FROM mention_channel_rows mc
      WHERE NOT EXISTS (
        SELECT 1
        FROM visible_rows vr
        WHERE vr.kind = mc.kind
          AND vr.source_channel_id = mc.source_channel_id
      )
      UNION ALL
      SELECT mt.*
      FROM mention_thread_rows mt
      WHERE NOT EXISTS (
        SELECT 1
        FROM visible_rows vr
        WHERE vr.kind = mt.kind
          AND vr.source_channel_id = mt.source_channel_id
      )
    ),
    active_totals AS (
      SELECT
        COALESCE(sum(CASE WHEN mention_only THEN 0 ELSE unread_count END), 0)::int AS "activeUnreadCount"
      FROM all_visible_rows
      WHERE last_activity_at IS NOT NULL
        ${guestAccess === null ? sql`` : sql`AND ${guestInboxAccessSql(guestAccess, sql`source_channel_id`)}`}
        ${historyCutoffPredicate}
    ),
    filtered AS (
      SELECT *
      FROM all_visible_rows
      WHERE last_activity_at IS NOT NULL
        ${guestAccess === null ? sql`` : sql`AND ${guestInboxAccessSql(guestAccess, sql`source_channel_id`)}`}
        ${historyCutoffPredicate}
        ${searchPredicate}
        AND ${filterPredicate}
    )`;
    if (splitAllMetadata && output === "page") {
      return sql`
        WITH ${commonCtes},
        page AS MATERIALIZED (
          SELECT *
          FROM filtered
          ORDER BY last_activity_at ${sortDirection}, kind ${sortDirection}, source_channel_id ${sortDirection}
          LIMIT ${opts.limit + 1}
          OFFSET ${opts.offset}
        )
        SELECT
          row_number() OVER (
            ORDER BY last_activity_at ${sortDirection}, kind ${sortDirection}, source_channel_id ${sortDirection}
          )::int - 1 AS "_pageOrdinal",
          kind AS "_kind",
          source_channel_id::text AS "_sourceChannelId",
          latest_notified_message_id::text AS "_latestNotifiedMessageId",
          latest_notified_seq::text AS "_latestNotifiedSeq",
          last_activity_at AS "_lastActivityAt",
          first_unread_message_id::text AS "_firstUnreadMessageId",
          unread_count::int AS "_unreadCount",
          latest_personal_mention_message_id::text AS "_latestPersonalMentionMessageId",
          latest_personal_mention_seq::text AS "_latestPersonalMentionSeq",
          unread_mention_count::int AS "_unreadMentionCount",
          first_unread_personal_mention_message_id::text AS "_firstUnreadPersonalMentionMessageId",
          has_any_mention AS "_hasAnyMention",
          channel_name AS "_channelName",
          channel_type::text AS "_channelType",
          storage_channel_id::text AS "_storageChannelId",
          joint_channel_id::text AS "_jointChannelId",
          last_read_seq::text AS "_lastReadSeq",
          mention_only AS "_mentionOnly"
        FROM page
        ORDER BY last_activity_at ${sortDirection}, kind ${sortDirection}, source_channel_id ${sortDirection}
      `;
    }
    return sql`
    WITH ${commonCtes},
    non_thread_facets AS (
      SELECT
        filtered.*,
        filtered.source_channel_id AS "groupChannelId",
        filtered.channel_name AS "groupChannelName",
        filtered.channel_type::text AS "groupChannelType"
      FROM filtered
      WHERE filtered.kind <> 'thread'
    ),
    thread_facets AS (
      SELECT
        filtered.*,
        COALESCE(local_parent.id, parent_ch.id) AS "groupChannelId",
        COALESCE(local_parent.name, parent_ch.name) AS "groupChannelName",
        COALESCE(local_parent.type::text, parent_ch.type::text) AS "groupChannelType"
      FROM filtered
      INNER JOIN channels thread_channel
        ON thread_channel.id = filtered.source_channel_id
      LEFT JOIN joint_channel_servers thread_projection
        ON thread_projection.local_channel_id = thread_channel.id
       AND thread_projection.server_id = ${serverId}
       AND thread_projection.status = 'active'
      LEFT JOIN joint_channels thread_joint
        ON thread_joint.id = thread_projection.joint_channel_id
       AND thread_joint.status = 'active'
      LEFT JOIN channels canonical_thread
        ON canonical_thread.id = thread_joint.canonical_channel_id
       AND canonical_thread.type = 'thread'
       AND canonical_thread.deleted_at IS NULL
      LEFT JOIN messages parent_message
        ON parent_message.id = COALESCE(canonical_thread.parent_message_id, thread_channel.parent_message_id)
      LEFT JOIN channels parent_ch
        ON parent_ch.id = parent_message.channel_id
      LEFT JOIN joint_channels parent_joint
        ON parent_joint.canonical_channel_id = parent_message.channel_id
       AND parent_joint.status = 'active'
      LEFT JOIN joint_channel_servers parent_projection
        ON parent_projection.joint_channel_id = parent_joint.id
       AND parent_projection.server_id = ${serverId}
       AND parent_projection.status = 'active'
      LEFT JOIN channels local_parent
        ON local_parent.id = parent_projection.local_channel_id
       AND local_parent.type = 'joint'
       AND local_parent.archived_at IS NULL
       AND local_parent.deleted_at IS NULL
      WHERE filtered.kind = 'thread'
    ),
    faceted AS (
      SELECT * FROM non_thread_facets
      UNION ALL
      SELECT * FROM thread_facets
    ),
    group_counts AS (
      SELECT
        "groupChannelId",
        "groupChannelName",
        "groupChannelType",
        count(*)::int AS "groupCount",
        MAX(last_activity_at) AS "groupLastActivityAt"
      FROM faceted
      WHERE "groupChannelId" IS NOT NULL
      GROUP BY "groupChannelId", "groupChannelName", "groupChannelType"
    ),
    group_totals AS (
      SELECT
        array_agg("groupChannelId"::text ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelIds",
        array_agg("groupChannelName" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelNames",
        array_agg("groupChannelType" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelTypes",
        array_agg("groupCount" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupCounts",
        array_agg("groupLastActivityAt"::text ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupLastActivityAts"
      FROM group_counts
    ),
    selected AS (
      SELECT *
      FROM ${selectedSource}
      ${selectedGroupPredicate}
    ),
    totals AS (
      SELECT
        count(*)::int AS "totalCount",
        COALESCE(sum(CASE WHEN mention_only THEN 0 ELSE unread_count END), 0)::int AS "totalUnreadCount"
      FROM selected
    ),
    page AS MATERIALIZED (
      SELECT *
      FROM selected
      ORDER BY last_activity_at ${sortDirection}, kind ${sortDirection}, source_channel_id ${sortDirection}
      LIMIT ${opts.limit + 1}
      OFFSET ${opts.offset}
    ),
    ${pageMentionAggregationCte}
    page_effective AS (
      SELECT
        page.*,
        CASE
          WHEN page_live_mentions.latest_message_seq IS NOT NULL
            AND (
              page.latest_personal_mention_seq IS NULL
              OR page_live_mentions.latest_message_seq >= page.latest_personal_mention_seq
            )
          THEN page_live_mentions.latest_message_id
          ELSE page.latest_personal_mention_message_id
        END AS effective_latest_personal_mention_message_id,
        GREATEST(
          page.unread_mention_count,
          COALESCE(page_live_mentions.unread_mention_count, 0)
        ) AS effective_unread_mention_count,
        COALESCE(
          page_live_mentions.first_unread_message_id,
          page.first_unread_personal_mention_message_id
        ) AS effective_first_unread_personal_mention_message_id,
        (
          page.has_any_mention
          OR page_live_mentions.latest_message_id IS NOT NULL
        ) AS effective_has_any_mention
      FROM page
      LEFT JOIN page_live_mentions
        ON page_live_mentions.source_channel_id = page.source_channel_id
    ),
    page_enriched AS (
      SELECT
        p.kind AS "kind",
        CASE WHEN p.kind = 'thread' THEN NULL::text ELSE p.source_channel_id::text END AS "channelId",
        CASE WHEN p.kind = 'thread' THEN NULL::text ELSE p.channel_name END AS "channelName",
        CASE WHEN p.kind = 'thread' THEN NULL::text ELSE p.channel_type::text END AS "channelType",
        ${pageEnrichmentFields}
        CASE WHEN p.mention_only THEN p.effective_latest_personal_mention_message_id::text ELSE p.first_unread_message_id::text END AS "firstUnreadMessageId",
        p.effective_first_unread_personal_mention_message_id::text AS "firstMentionMessageId",
        NULL::text AS "lastMessageSenderName",
        CASE WHEN p.mention_only THEN 0 ELSE p.unread_count END::int AS "unreadCount",
        CASE WHEN p.kind = 'thread' THEN p.source_channel_id::text ELSE NULL::text END AS "threadChannelId",
        NULL::text AS "taskClaimedByName",
        (CASE WHEN p.mention_only THEN p.effective_has_any_mention ELSE p.effective_unread_mention_count > 0 END) AS "hasMention",
        p.effective_has_any_mention AS "hasAnyMention",
        p.mention_only AS "mentionOnly",
        p.source_channel_id::text AS "mentionSourceChannelId",
        p.last_activity_at AS "activityAt"
      FROM page_effective p
      ${pageEnrichmentJoins}
    )
    ${output === "metadata"
      ? sql`
        SELECT
          receiver_scope_stats.receiver_scope_row_count AS "__receiverScopeRowCount",
          totals."totalCount",
          totals."totalUnreadCount",
          active_totals."activeUnreadCount",
          group_totals."groupChannelIds",
          group_totals."groupChannelNames",
          group_totals."groupChannelTypes",
          group_totals."groupCounts",
          group_totals."groupLastActivityAts"
        FROM totals
        CROSS JOIN active_totals
        CROSS JOIN group_totals
        CROSS JOIN receiver_scope_stats
      `
      : output === "page"
        ? sql`
          SELECT
            page_enriched.*,
            NULL::int AS "__receiverScopeRowCount",
            NULL::int AS "totalCount",
            NULL::int AS "totalUnreadCount",
            NULL::int AS "activeUnreadCount",
            NULL::text[] AS "groupChannelIds",
            NULL::text[] AS "groupChannelNames",
            NULL::text[] AS "groupChannelTypes",
            NULL::int[] AS "groupCounts",
            NULL::text[] AS "groupLastActivityAts"
          FROM (SELECT 1) page_sentinel
          LEFT JOIN page_enriched ON true
          ORDER BY "activityAt" ${sortDirection} NULLS LAST,
            "kind" ${sortDirection},
            COALESCE("threadChannelId", "channelId") ${sortDirection}
        `
        : sql`
          SELECT
            page_enriched.*,
            receiver_scope_stats.receiver_scope_row_count AS "__receiverScopeRowCount",
            totals."totalCount",
            totals."totalUnreadCount",
            active_totals."activeUnreadCount",
            group_totals."groupChannelIds",
            group_totals."groupChannelNames",
            group_totals."groupChannelTypes",
            group_totals."groupCounts",
            group_totals."groupLastActivityAts"
          FROM totals
          CROSS JOIN active_totals
          CROSS JOIN group_totals
          CROSS JOIN receiver_scope_stats
          LEFT JOIN page_enriched ON true
          ORDER BY "activityAt" ${sortDirection} NULLS LAST,
            "kind" ${sortDirection},
            COALESCE("threadChannelId", "channelId") ${sortDirection}
        `}
    `;
  };
  const allPagePrefixLimit = opts.offset + opts.limit + 1;
  const boundedKeyPrefixLimit = searchPattern
    ? sql``
    : sql`LIMIT ${allPagePrefixLimit}`;
  const messagePrefixHistoryCutoffPredicate = opts.historyCutoff
    ? sql`AND prefix_message.created_at > ${opts.historyCutoff}`
    : sql``;
  const allPageKeyProjection = sql`
    SELECT
      kind AS "_kind",
      source_channel_id::text AS "_sourceChannelId",
      latest_notified_message_id::text AS "_latestNotifiedMessageId",
      latest_notified_seq::text AS "_latestNotifiedSeq",
      last_activity_at AS "_lastActivityAt",
      first_unread_message_id::text AS "_firstUnreadMessageId",
      unread_count::int AS "_unreadCount",
      latest_personal_mention_message_id::text AS "_latestPersonalMentionMessageId",
      latest_personal_mention_seq::text AS "_latestPersonalMentionSeq",
      unread_mention_count::int AS "_unreadMentionCount",
      first_unread_personal_mention_message_id::text AS "_firstUnreadPersonalMentionMessageId",
      has_any_mention AS "_hasAnyMention",
      channel_name AS "_channelName",
      channel_type::text AS "_channelType",
      storage_channel_id::text AS "_storageChannelId",
      joint_channel_id::text AS "_jointChannelId",
      last_read_seq::text AS "_lastReadSeq",
      mention_only AS "_mentionOnly"
    FROM page
    ORDER BY last_activity_at ${sortDirection}, kind ${sortDirection}, source_channel_id ${sortDirection}
  `;
  const buildAllPageServingKeysQuery = () => sql`
    WITH serving_prefix AS MATERIALIZED (
      SELECT
        r.kind,
        r.source_channel_id,
        r.latest_notified_message_id,
        r.latest_notified_seq,
        r.last_activity_at,
        r.first_unread_message_id,
        r.unread_count::int AS unread_count,
        r.latest_personal_mention_message_id,
        r.latest_personal_mention_seq,
        r.unread_mention_count::int AS unread_mention_count,
        NULL::uuid AS first_unread_personal_mention_message_id,
        r.has_any_mention,
        c.name AS channel_name,
        c.type AS channel_type,
        CASE
          WHEN r.kind IN ('channel', 'dm') AND chat_member.user_id IS NOT NULL THEN false
          WHEN r.kind = 'thread' AND followed_thread.thread_channel_id IS NOT NULL THEN false
          ELSE true
        END AS mention_only
      FROM inbox_serving_rows r
      INNER JOIN channels c
       ON c.id = r.source_channel_id
       AND c.deleted_at IS NULL
       AND c.archived_at IS NULL
      LEFT JOIN user_channel_inbox_states inbox
        ON inbox.channel_id = c.id
       AND inbox.user_id = ${userId}
      LEFT JOIN channel_humans chat_member
        ON chat_member.channel_id = c.id
       AND chat_member.user_id = ${userId}
      LEFT JOIN thread_follows followed_thread
        ON followed_thread.thread_channel_id = c.id
       AND followed_thread.follower_type = 'user'
       AND followed_thread.follower_id = ${userId}
       AND followed_thread.done_at IS NULL
       AND followed_thread.unfollowed_at IS NULL
      WHERE r.receiver_type = 'user'
        AND r.receiver_id = ${userId}::uuid
        AND r.server_id = ${serverId}::uuid
        AND c.server_id = ${serverId}::uuid
        AND inbox.done_at IS NULL
        AND (
          (
            r.kind IN ('channel', 'dm')
            AND c.type IN ('channel', 'private', 'joint', 'dm')
            AND chat_member.user_id IS NOT NULL
          )
          OR (
            r.kind = 'thread'
            AND followed_thread.thread_channel_id IS NOT NULL
          )
          OR r.has_any_mention
        )
        AND r.last_activity_at IS NOT NULL
        ${guestAccess === null ? sql`` : sql`AND ${guestInboxAccessSql(guestAccess, sql`r.source_channel_id`)}`}
        ${historyCutoffPredicate}
      ORDER BY r.last_activity_at ${sortDirection}, r.kind ${sortDirection}, r.source_channel_id ${sortDirection}
      ${boundedKeyPrefixLimit}
    ),
    serving_page_rows AS MATERIALIZED (
      SELECT
        prefix.kind,
        prefix.source_channel_id,
        prefix.latest_notified_message_id,
        prefix.latest_notified_seq,
        prefix.last_activity_at,
        prefix.first_unread_message_id,
        prefix.unread_count,
        prefix.latest_personal_mention_message_id,
        prefix.latest_personal_mention_seq,
        prefix.unread_mention_count,
        prefix.first_unread_personal_mention_message_id,
        prefix.has_any_mention,
        prefix.channel_name,
        prefix.channel_type,
        COALESCE(joint_storage.canonical_channel_id, prefix.source_channel_id) AS storage_channel_id,
        joint_projection.joint_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        prefix.mention_only
      FROM serving_prefix prefix
      LEFT JOIN joint_channel_servers joint_projection
        ON joint_projection.local_channel_id = prefix.source_channel_id
       AND joint_projection.server_id = ${serverId}::uuid
       AND joint_projection.status = 'active'
      LEFT JOIN joint_channels joint_storage
        ON joint_storage.id = joint_projection.joint_channel_id
       AND joint_storage.status = 'active'
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = prefix.source_channel_id
       AND rc.user_id = ${userId}
    ),
    all_visible_rows AS (
      SELECT * FROM serving_page_rows
    ),
    filtered AS (
      SELECT *
      FROM all_visible_rows
      WHERE last_activity_at IS NOT NULL
        ${guestAccess === null ? sql`` : sql`AND ${guestInboxAccessSql(guestAccess, sql`source_channel_id`)}`}
        ${historyCutoffPredicate}
        ${searchPredicate}
    ),
    page AS MATERIALIZED (
      SELECT *
      FROM filtered
      ORDER BY last_activity_at ${sortDirection}, kind ${sortDirection}, source_channel_id ${sortDirection}
      LIMIT ${allPagePrefixLimit}
    )
    ${allPageKeyProjection}
  `;
  const buildAllPageMentionKeysQuery = () => sql`
    WITH server_target_mentions AS MATERIALIZED (
      SELECT
        server_mention.channel_id,
        server_mention.message_id,
        server_mention.message_seq,
        server_mention.notified_at
      FROM message_mentions server_mention
      WHERE server_mention.target_type = 'user'
        AND server_mention.target_id = ${userId}::uuid
        AND server_mention.server_id = ${serverId}::uuid
        AND (server_mention.notifiable_at_send OR server_mention.notified_at IS NOT NULL)
    ),
    receiver_mention_source_ids AS MATERIALIZED (
      SELECT DISTINCT r.source_channel_id
      FROM server_target_mentions mention
      INNER JOIN inbox_serving_rows r
        ON r.source_channel_id = mention.channel_id
       AND r.receiver_type = 'user'
       AND r.receiver_id = ${userId}::uuid
       AND r.server_id = ${serverId}::uuid
      UNION
      SELECT DISTINCT r.source_channel_id
      FROM message_mentions sibling_mention
      INNER JOIN joint_channel_servers sibling_projection
        ON sibling_projection.local_channel_id = sibling_mention.channel_id
       AND sibling_projection.status = 'active'
      INNER JOIN joint_channel_servers receiver_projection
        ON receiver_projection.joint_channel_id = sibling_projection.joint_channel_id
       AND receiver_projection.server_id = ${serverId}::uuid
       AND receiver_projection.status = 'active'
      INNER JOIN inbox_serving_rows r
        ON r.source_channel_id = receiver_projection.local_channel_id
       AND r.receiver_type = 'user'
       AND r.receiver_id = ${userId}::uuid
       AND r.server_id = ${serverId}::uuid
      WHERE sibling_mention.target_type = 'user'
        AND sibling_mention.target_id = ${userId}::uuid
        AND sibling_mention.server_id <> ${serverId}::uuid
        AND (sibling_mention.notifiable_at_send OR sibling_mention.notified_at IS NOT NULL)
    ),
    receiver_mention_prefix AS MATERIALIZED (
      SELECT
        r.kind,
        r.source_channel_id,
        r.latest_notified_message_id,
        r.latest_notified_seq,
        r.last_activity_at,
        r.first_unread_message_id,
        r.unread_count::int AS unread_count,
        r.latest_personal_mention_message_id,
        r.latest_personal_mention_seq,
        r.unread_mention_count::int AS unread_mention_count,
        NULL::uuid AS first_unread_personal_mention_message_id,
        true AS has_any_mention,
        c.name AS channel_name,
        c.type AS channel_type,
        CASE
          WHEN r.kind IN ('channel', 'dm') AND chat_member.user_id IS NOT NULL THEN false
          WHEN r.kind = 'thread' AND followed_thread.thread_channel_id IS NOT NULL THEN false
          ELSE true
        END AS mention_only
      FROM receiver_mention_source_ids presence
      INNER JOIN inbox_serving_rows r
        ON r.source_channel_id = presence.source_channel_id
       AND r.receiver_type = 'user'
       AND r.receiver_id = ${userId}::uuid
       AND r.server_id = ${serverId}::uuid
      INNER JOIN channels c
        ON c.id = r.source_channel_id
       AND c.server_id = ${serverId}::uuid
       AND c.deleted_at IS NULL
       AND c.archived_at IS NULL
      LEFT JOIN user_channel_inbox_states inbox
        ON inbox.channel_id = c.id
       AND inbox.user_id = ${userId}
      LEFT JOIN channel_humans chat_member
        ON chat_member.channel_id = c.id
       AND chat_member.user_id = ${userId}
      LEFT JOIN thread_follows followed_thread
        ON followed_thread.thread_channel_id = c.id
       AND followed_thread.follower_type = 'user'
       AND followed_thread.follower_id = ${userId}
       AND followed_thread.done_at IS NULL
       AND followed_thread.unfollowed_at IS NULL
      WHERE inbox.done_at IS NULL
        AND r.last_activity_at IS NOT NULL
        ${guestAccess === null ? sql`` : sql`AND ${guestInboxAccessSql(guestAccess, sql`r.source_channel_id`)}`}
        ${historyCutoffPredicate}
      ORDER BY r.last_activity_at ${sortDirection}, r.kind ${sortDirection}, r.source_channel_id ${sortDirection}
      ${boundedKeyPrefixLimit}
    ),
    receiver_mention_rows AS (
      SELECT
        prefix.kind,
        prefix.source_channel_id,
        prefix.latest_notified_message_id,
        prefix.latest_notified_seq,
        prefix.last_activity_at,
        prefix.first_unread_message_id,
        prefix.unread_count,
        prefix.latest_personal_mention_message_id,
        prefix.latest_personal_mention_seq,
        prefix.unread_mention_count,
        prefix.first_unread_personal_mention_message_id,
        prefix.has_any_mention,
        prefix.channel_name,
        prefix.channel_type,
        COALESCE(joint_storage.canonical_channel_id, prefix.source_channel_id) AS storage_channel_id,
        joint_projection.joint_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        prefix.mention_only
      FROM receiver_mention_prefix prefix
      LEFT JOIN joint_channel_servers joint_projection
        ON joint_projection.local_channel_id = prefix.source_channel_id
       AND joint_projection.server_id = ${serverId}::uuid
       AND joint_projection.status = 'active'
      LEFT JOIN joint_channels joint_storage
        ON joint_storage.id = joint_projection.joint_channel_id
       AND joint_storage.status = 'active'
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = prefix.source_channel_id
       AND rc.user_id = ${userId}
    ),
    mention_channel_rows AS (
      SELECT
        CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind,
        c.id AS source_channel_id,
        m.id AS latest_notified_message_id,
        m.seq AS latest_notified_seq,
        m.created_at AS last_activity_at,
        CASE
          WHEN chat_member.user_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN m.id
          ELSE NULL
        END AS first_unread_message_id,
        CASE
          WHEN chat_member.user_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN 1
          ELSE 0
        END::int AS unread_count,
        m.id AS latest_personal_mention_message_id,
        m.seq AS latest_personal_mention_seq,
        CASE WHEN m.seq > COALESCE(rc.last_read_seq, 0) THEN 1 ELSE 0 END::int AS unread_mention_count,
        m.id AS first_unread_personal_mention_message_id,
        true AS has_any_mention,
        c.name AS channel_name,
        c.type AS channel_type,
        COALESCE(joint_storage.canonical_channel_id, c.id) AS storage_channel_id,
        joint_projection.joint_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        CASE WHEN chat_member.user_id IS NOT NULL THEN false ELSE true END AS mention_only
      FROM (
        SELECT
          grouped_mention.channel_id,
          grouped_mention.latest_mention_seq
        FROM (
          SELECT
            mention.channel_id,
            max(mention.message_seq) AS latest_mention_seq
          FROM server_target_mentions mention
          INNER JOIN channels mention_channel
            ON mention_channel.id = mention.channel_id
          LEFT JOIN channel_humans member_check
            ON member_check.channel_id = mention.channel_id
           AND member_check.user_id = ${userId}
          LEFT JOIN user_channel_inbox_states inbox_check
            ON inbox_check.channel_id = mention.channel_id
           AND inbox_check.user_id = ${userId}
          LEFT JOIN inbox_suppression_states mention_suppression
            ON mention_suppression.receiver_type = 'user'
           AND mention_suppression.receiver_id = ${userId}::uuid
           AND mention_suppression.target_kind = 'public_channel_mention'
           AND mention_suppression.target_channel_id = mention.channel_id
          WHERE mention_channel.server_id = ${serverId}::uuid
            AND mention_channel.type IN ('channel', 'private', 'joint', 'dm')
            AND mention_channel.deleted_at IS NULL
            AND mention_channel.archived_at IS NULL
            AND inbox_check.done_at IS NULL
            AND mention.message_seq > COALESCE(mention_suppression.done_through_seq, 0)
            AND (
              member_check.user_id IS NOT NULL
              OR (mention_channel.type = 'channel' AND mention.notified_at IS NOT NULL)
            )
          GROUP BY mention.channel_id
        ) grouped_mention
        INNER JOIN messages prefix_message
          ON prefix_message.channel_id = grouped_mention.channel_id
         AND prefix_message.seq = grouped_mention.latest_mention_seq
        WHERE prefix_message.created_at IS NOT NULL
          ${messagePrefixHistoryCutoffPredicate}
        ORDER BY prefix_message.created_at ${sortDirection}, grouped_mention.channel_id ${sortDirection}
        ${boundedKeyPrefixLimit}
      ) latest_mention
      INNER JOIN channels c
        ON c.id = latest_mention.channel_id
      INNER JOIN messages m
        ON m.channel_id = latest_mention.channel_id
       AND m.seq = latest_mention.latest_mention_seq
      LEFT JOIN joint_channel_servers joint_projection
        ON joint_projection.local_channel_id = c.id
       AND joint_projection.server_id = c.server_id
       AND joint_projection.status = 'active'
      LEFT JOIN joint_channels joint_storage
        ON joint_storage.id = joint_projection.joint_channel_id
       AND joint_storage.status = 'active'
      LEFT JOIN user_channel_inbox_states inbox
        ON inbox.channel_id = c.id
       AND inbox.user_id = ${userId}
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id
       AND rc.user_id = ${userId}
      LEFT JOIN channel_humans chat_member
        ON chat_member.channel_id = c.id
       AND chat_member.user_id = ${userId}
    ),
    mention_thread_rows AS (
      SELECT
        'thread' AS kind,
        thread_channel.id AS source_channel_id,
        m.id AS latest_notified_message_id,
        m.seq AS latest_notified_seq,
        m.created_at AS last_activity_at,
        CASE
          WHEN existing_follow.thread_channel_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN m.id
          ELSE NULL
        END AS first_unread_message_id,
        CASE
          WHEN existing_follow.thread_channel_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN 1
          ELSE 0
        END::int AS unread_count,
        m.id AS latest_personal_mention_message_id,
        m.seq AS latest_personal_mention_seq,
        CASE WHEN m.seq > COALESCE(rc.last_read_seq, 0) THEN 1 ELSE 0 END::int AS unread_mention_count,
        m.id AS first_unread_personal_mention_message_id,
        true AS has_any_mention,
        thread_channel.name AS channel_name,
        thread_channel.type AS channel_type,
        COALESCE(canonical_thread.id, thread_channel.id) AS storage_channel_id,
        thread_projection.joint_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        CASE WHEN existing_follow.thread_channel_id IS NOT NULL THEN false ELSE true END AS mention_only
      FROM (
        SELECT
          grouped_mention.channel_id,
          grouped_mention.latest_mention_seq
        FROM (
          SELECT
            mention.channel_id,
            max(mention.message_seq) AS latest_mention_seq
          FROM server_target_mentions mention
          INNER JOIN channels candidate_thread
            ON candidate_thread.id = mention.channel_id
          INNER JOIN messages parent_message
            ON parent_message.id = candidate_thread.parent_message_id
          INNER JOIN channels parent_channel
            ON parent_channel.id = parent_message.channel_id
          LEFT JOIN thread_follows existing_follow
            ON existing_follow.thread_channel_id = mention.channel_id
           AND existing_follow.follower_type = 'user'
           AND existing_follow.follower_id = ${userId}
           AND existing_follow.done_at IS NULL
           AND existing_follow.unfollowed_at IS NULL
          LEFT JOIN channel_humans parent_member
            ON parent_member.channel_id = parent_channel.id
           AND parent_member.user_id = ${userId}
          LEFT JOIN user_channel_inbox_states inbox_check
            ON inbox_check.channel_id = mention.channel_id
           AND inbox_check.user_id = ${userId}
          LEFT JOIN inbox_suppression_states mention_suppression
            ON mention_suppression.receiver_type = 'user'
           AND mention_suppression.receiver_id = ${userId}::uuid
           AND mention_suppression.target_kind = 'public_thread_mention'
           AND mention_suppression.target_channel_id = mention.channel_id
          WHERE candidate_thread.server_id = ${serverId}::uuid
            AND candidate_thread.type = 'thread'
            AND candidate_thread.deleted_at IS NULL
            AND parent_channel.archived_at IS NULL
            AND parent_channel.deleted_at IS NULL
            AND inbox_check.done_at IS NULL
            AND mention.message_seq > COALESCE(mention_suppression.done_through_seq, 0)
            AND (
              existing_follow.thread_channel_id IS NOT NULL
              OR (
                mention.notified_at IS NOT NULL
                AND (
                  parent_channel.type = 'channel'
                  OR parent_member.user_id IS NOT NULL
                )
              )
            )
          GROUP BY mention.channel_id
        ) grouped_mention
        INNER JOIN messages prefix_message
          ON prefix_message.channel_id = grouped_mention.channel_id
         AND prefix_message.seq = grouped_mention.latest_mention_seq
        WHERE prefix_message.created_at IS NOT NULL
          ${messagePrefixHistoryCutoffPredicate}
        ORDER BY prefix_message.created_at ${sortDirection}, grouped_mention.channel_id ${sortDirection}
        ${boundedKeyPrefixLimit}
      ) latest_mention
      INNER JOIN channels thread_channel
        ON thread_channel.id = latest_mention.channel_id
      INNER JOIN messages m
        ON m.channel_id = latest_mention.channel_id
       AND m.seq = latest_mention.latest_mention_seq
      LEFT JOIN joint_channel_servers thread_projection
        ON thread_projection.local_channel_id = thread_channel.id
       AND thread_projection.server_id = ${serverId}::uuid
       AND thread_projection.status = 'active'
      LEFT JOIN joint_channels thread_joint
        ON thread_joint.id = thread_projection.joint_channel_id
       AND thread_joint.status = 'active'
      LEFT JOIN channels canonical_thread
        ON canonical_thread.id = thread_joint.canonical_channel_id
       AND canonical_thread.type = 'thread'
       AND canonical_thread.deleted_at IS NULL
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = thread_channel.id
       AND rc.user_id = ${userId}
      LEFT JOIN thread_follows existing_follow
        ON existing_follow.thread_channel_id = thread_channel.id
       AND existing_follow.follower_type = 'user'
       AND existing_follow.follower_id = ${userId}
       AND existing_follow.done_at IS NULL
       AND existing_follow.unfollowed_at IS NULL
    ),
    all_visible_rows AS (
      SELECT * FROM receiver_mention_rows
      UNION ALL
      SELECT channel_row.*
      FROM mention_channel_rows channel_row
      WHERE NOT EXISTS (
        SELECT 1
        FROM receiver_mention_rows receiver_row
        WHERE receiver_row.kind = channel_row.kind
          AND receiver_row.source_channel_id = channel_row.source_channel_id
      )
      UNION ALL
      SELECT thread_row.*
      FROM mention_thread_rows thread_row
      WHERE NOT EXISTS (
        SELECT 1
        FROM receiver_mention_rows receiver_row
        WHERE receiver_row.kind = thread_row.kind
          AND receiver_row.source_channel_id = thread_row.source_channel_id
      )
    ),
    filtered AS (
      SELECT *
      FROM all_visible_rows
      WHERE last_activity_at IS NOT NULL
        ${guestAccess === null ? sql`` : sql`AND ${guestInboxAccessSql(guestAccess, sql`source_channel_id`)}`}
        ${historyCutoffPredicate}
        ${searchPredicate}
    ),
    page AS MATERIALIZED (
      SELECT *
      FROM filtered
      ORDER BY last_activity_at ${sortDirection}, kind ${sortDirection}, source_channel_id ${sortDirection}
      LIMIT ${allPagePrefixLimit}
    )
    ${allPageKeyProjection}
  `;
  const mergeAllPageKeyRows = (
    servingRows: readonly QueryResultRow[],
    mentionRows: readonly QueryResultRow[],
  ): QueryResultRow[] =>
    mergeInboxAllPageKeyRows(
      servingRows,
      mentionRows,
      opts.sort,
      opts.offset,
      opts.limit,
    );
  const buildAllPageHydrationQuery = (pageKeyRows: readonly QueryResultRow[]) => {
    const nullableText = (value: unknown) => value == null ? null : String(value);
    const pageInput = pageKeyRows.map((row) => ({
      row_ordinal: Number(row._pageOrdinal),
      kind: String(row._kind),
      source_channel_id: String(row._sourceChannelId),
      latest_notified_message_id: nullableText(row._latestNotifiedMessageId),
      latest_notified_seq: nullableText(row._latestNotifiedSeq),
      last_activity_at: row._lastActivityAt instanceof Date
        ? row._lastActivityAt.toISOString()
        : String(row._lastActivityAt),
      first_unread_message_id: nullableText(row._firstUnreadMessageId),
      unread_count: Number(row._unreadCount),
      latest_personal_mention_message_id: nullableText(row._latestPersonalMentionMessageId),
      latest_personal_mention_seq: nullableText(row._latestPersonalMentionSeq),
      unread_mention_count: Number(row._unreadMentionCount),
      first_unread_personal_mention_message_id: nullableText(row._firstUnreadPersonalMentionMessageId),
      has_any_mention: row._hasAnyMention === true,
      channel_name: nullableText(row._channelName),
      channel_type: nullableText(row._channelType),
      storage_channel_id: String(row._storageChannelId),
      joint_channel_id: nullableText(row._jointChannelId),
      last_read_seq: nullableText(row._lastReadSeq),
      mention_only: row._mentionOnly === true,
    }));
    return sql`
      WITH page_input AS MATERIALIZED (
        SELECT input.*
        FROM jsonb_to_recordset(${JSON.stringify(pageInput)}::jsonb) AS input(
          row_ordinal int,
          kind text,
          source_channel_id uuid,
          latest_notified_message_id uuid,
          latest_notified_seq bigint,
          last_activity_at timestamptz,
          first_unread_message_id uuid,
          unread_count int,
          latest_personal_mention_message_id uuid,
          latest_personal_mention_seq bigint,
          unread_mention_count int,
          first_unread_personal_mention_message_id uuid,
          has_any_mention boolean,
          channel_name text,
          channel_type text,
          storage_channel_id uuid,
          joint_channel_id uuid,
          last_read_seq bigint,
          mention_only boolean
        )
      ),
      page_mention_scope AS MATERIALIZED (
        SELECT
          input.row_ordinal,
          input.source_channel_id,
          input.source_channel_id AS mention_channel_id,
          input.last_read_seq
        FROM page_input input
        UNION
        SELECT
          input.row_ordinal,
          input.source_channel_id,
          sibling_projection.local_channel_id AS mention_channel_id,
          input.last_read_seq
        FROM page_input input
        INNER JOIN joint_channel_servers sibling_projection
          ON sibling_projection.joint_channel_id = input.joint_channel_id
         AND sibling_projection.status = 'active'
      ),
      page_scoped_mentions AS MATERIALIZED (
        SELECT
          scope.row_ordinal,
          scope.source_channel_id,
          scope.last_read_seq,
          server_mention.message_id,
          server_mention.message_seq
        FROM page_mention_scope scope
        INNER JOIN message_mentions server_mention
          ON server_mention.channel_id = scope.mention_channel_id
         AND server_mention.target_type = 'user'
         AND server_mention.target_id = ${userId}::uuid
         AND server_mention.server_id = ${serverId}::uuid
         AND (server_mention.notifiable_at_send OR server_mention.notified_at IS NOT NULL)
        UNION ALL
        SELECT
          scope.row_ordinal,
          scope.source_channel_id,
          scope.last_read_seq,
          sibling_mention.message_id,
          sibling_mention.message_seq
        FROM page_mention_scope scope
        INNER JOIN message_mentions sibling_mention
          ON sibling_mention.channel_id = scope.mention_channel_id
         AND sibling_mention.target_type = 'user'
         AND sibling_mention.target_id = ${userId}::uuid
         AND sibling_mention.server_id <> ${serverId}::uuid
         AND (sibling_mention.notifiable_at_send OR sibling_mention.notified_at IS NOT NULL)
      ),
      page_live_mentions AS MATERIALIZED (
        SELECT
          mention.row_ordinal,
          mention.source_channel_id,
          (array_agg(mention.message_id ORDER BY mention.message_seq DESC, mention.message_id DESC))[1] AS latest_message_id,
          max(mention.message_seq) AS latest_message_seq,
          (count(*) FILTER (
            WHERE mention.message_seq > mention.last_read_seq
          ))::int AS unread_mention_count,
          (array_agg(mention.message_id ORDER BY mention.message_seq ASC, mention.message_id ASC) FILTER (
            WHERE mention.message_seq > mention.last_read_seq
          ))[1] AS first_unread_message_id
        FROM page_scoped_mentions mention
        GROUP BY mention.row_ordinal, mention.source_channel_id, mention.last_read_seq
      ),
      page_effective AS (
        SELECT
          input.*,
          CASE
            WHEN live.latest_message_seq IS NOT NULL
              AND (
                input.latest_personal_mention_seq IS NULL
                OR live.latest_message_seq >= input.latest_personal_mention_seq
              )
            THEN live.latest_message_id
            ELSE input.latest_personal_mention_message_id
          END AS effective_latest_personal_mention_message_id,
          GREATEST(
            input.unread_mention_count,
            COALESCE(live.unread_mention_count, 0)
          ) AS effective_unread_mention_count,
          COALESCE(
            live.first_unread_message_id,
            input.first_unread_personal_mention_message_id
          ) AS effective_first_unread_personal_mention_message_id,
          (
            input.has_any_mention
            OR live.latest_message_id IS NOT NULL
          ) AS effective_has_any_mention
        FROM page_input input
        LEFT JOIN page_live_mentions live
          ON live.row_ordinal = input.row_ordinal
      )
      SELECT
        p.row_ordinal AS "_pageOrdinal",
        p.kind AS "kind",
        CASE WHEN p.kind = 'thread' THEN NULL::text ELSE p.source_channel_id::text END AS "channelId",
        CASE WHEN p.kind = 'thread' THEN NULL::text ELSE p.channel_name END AS "channelName",
        CASE WHEN p.kind = 'thread' THEN NULL::text ELSE p.channel_type END AS "channelType",
        CASE
          WHEN p.kind = 'thread' THEN NULL::text
          ELSE (
            CASE
              WHEN p.mention_only THEN p.effective_latest_personal_mention_message_id
              ELSE p.latest_notified_message_id
            END
          )::text
        END AS "lastMessageId",
        NULL::text AS "lastMessageAt",
        NULL::text AS "lastMessagePreview",
        NULL::text AS "lastMessageSenderType",
        NULL::text AS "lastMessageSenderId",
        NULL::text AS "parentMessageId",
        NULL::text AS "parentChannelId",
        NULL::text AS "parentChannelName",
        NULL::text AS "parentChannelType",
        NULL::text AS "parentMessagePreview",
        NULL::text AS "parentMessageSenderType",
        NULL::text AS "parentMessageSenderId",
        NULL::text AS "latestActivityPreview",
        NULL::text AS "latestActivitySenderType",
        NULL::text AS "latestActivitySenderId",
        NULL::text AS "latestActivityMessageId",
        NULL::text AS "latestActivitySeq",
        NULL::text AS "lastActivityAt",
        NULL::text AS "lastReplyAt",
        NULL::int AS "replyCount",
        NULL::int AS "taskNumber",
        NULL::text AS "taskStatus",
        NULL::text AS "taskClaimedByType",
        NULL::text AS "taskClaimedById",
        p.storage_channel_id::text AS "_storageChannelId",
        (
          CASE
            WHEN p.mention_only THEN p.effective_latest_personal_mention_message_id
            ELSE p.latest_notified_message_id
          END
        )::text AS "_latestMessageLookupId",
        CASE WHEN p.mention_only THEN p.effective_latest_personal_mention_message_id::text ELSE p.first_unread_message_id::text END AS "firstUnreadMessageId",
        p.effective_first_unread_personal_mention_message_id::text AS "firstMentionMessageId",
        NULL::text AS "lastMessageSenderName",
        CASE WHEN p.mention_only THEN 0 ELSE p.unread_count END::int AS "unreadCount",
        CASE WHEN p.kind = 'thread' THEN p.source_channel_id::text ELSE NULL::text END AS "threadChannelId",
        NULL::text AS "taskClaimedByName",
        (CASE WHEN p.mention_only THEN p.effective_has_any_mention ELSE p.effective_unread_mention_count > 0 END) AS "hasMention",
        p.effective_has_any_mention AS "hasAnyMention",
        p.mention_only AS "mentionOnly",
        p.source_channel_id::text AS "mentionSourceChannelId",
        p.last_activity_at AS "activityAt"
      FROM page_effective p
      ORDER BY p.row_ordinal
    `;
  };
  const buildAllPageEnrichmentQuery = (pageRows: readonly QueryResultRow[]) => {
    const pageInput = pageRows.map((row, rowOrdinal) => ({
      row_ordinal: rowOrdinal,
      kind: String(row.kind),
      source_channel_id: String(row.mentionSourceChannelId),
      storage_channel_id: String(row._storageChannelId),
      latest_message_lookup_id: row._latestMessageLookupId == null
        ? null
        : String(row._latestMessageLookupId),
    }));
    return sql`
      WITH page_input AS MATERIALIZED (
        SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(pageInput)}::jsonb) AS input(
          row_ordinal int,
          kind text,
          source_channel_id uuid,
          storage_channel_id uuid,
          latest_message_lookup_id uuid
        )
      )
      SELECT
        input.row_ordinal AS "_pageOrdinal",
        CASE WHEN input.kind = 'thread' THEN NULL::text ELSE latest_message.id::text END AS "lastMessageId",
        CASE WHEN input.kind = 'thread' THEN NULL::text ELSE to_char((latest_message.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' END AS "lastMessageAt",
        CASE WHEN input.kind = 'thread' THEN NULL::text ELSE latest_message.content END AS "lastMessagePreview",
        CASE WHEN input.kind = 'thread' THEN NULL::text ELSE latest_message.sender_type END AS "lastMessageSenderType",
        CASE WHEN input.kind = 'thread' THEN NULL::text ELSE latest_message.sender_id END AS "lastMessageSenderId",
        pm.id::text AS "parentMessageId",
        COALESCE(local_parent.id, parent_ch.id)::text AS "parentChannelId",
        COALESCE(local_parent.name, parent_ch.name) AS "parentChannelName",
        COALESCE(local_parent.type::text, parent_ch.type::text) AS "parentChannelType",
        pm.content AS "parentMessagePreview",
        pm.sender_type AS "parentMessageSenderType",
        pm.sender_id AS "parentMessageSenderId",
        COALESCE(latest_message.content, pm.content) AS "latestActivityPreview",
        COALESCE(latest_message.sender_type, pm.sender_type) AS "latestActivitySenderType",
        COALESCE(latest_message.sender_id, pm.sender_id) AS "latestActivitySenderId",
        COALESCE(latest_message.id, pm.id)::text AS "latestActivityMessageId",
        COALESCE(latest_message.seq, pm.seq)::text AS "latestActivitySeq",
        to_char((COALESCE(latest_message.created_at, pm.created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastActivityAt",
        CASE WHEN input.kind = 'thread' AND latest_message.id IS NOT NULL THEN to_char((latest_message.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' ELSE NULL::text END AS "lastReplyAt",
        CASE WHEN input.kind = 'thread' THEN COALESCE(reply_count.reply_count, 0)::int ELSE NULL::int END AS "replyCount",
        task.task_number AS "taskNumber",
        task.status AS "taskStatus",
        task.claimed_by_type AS "taskClaimedByType",
        task.claimed_by_id AS "taskClaimedById"
      FROM page_input input
      LEFT JOIN messages latest_message
        ON latest_message.id = input.latest_message_lookup_id
      LEFT JOIN channels thread_channel
        ON thread_channel.id = input.source_channel_id
       AND input.kind = 'thread'
      LEFT JOIN joint_channel_servers thread_projection
        ON thread_projection.local_channel_id = thread_channel.id
       AND thread_projection.server_id = ${serverId}
       AND thread_projection.status = 'active'
      LEFT JOIN joint_channels thread_joint
        ON thread_joint.id = thread_projection.joint_channel_id
       AND thread_joint.status = 'active'
      LEFT JOIN channels canonical_thread
        ON canonical_thread.id = thread_joint.canonical_channel_id
       AND canonical_thread.type = 'thread'
       AND canonical_thread.deleted_at IS NULL
      LEFT JOIN messages pm
        ON pm.id = COALESCE(canonical_thread.parent_message_id, thread_channel.parent_message_id)
      LEFT JOIN channels parent_ch
        ON parent_ch.id = pm.channel_id
      LEFT JOIN joint_channels parent_joint
        ON parent_joint.canonical_channel_id = pm.channel_id
       AND parent_joint.status = 'active'
      LEFT JOIN joint_channel_servers parent_projection
        ON parent_projection.joint_channel_id = parent_joint.id
       AND parent_projection.server_id = ${serverId}
       AND parent_projection.status = 'active'
      LEFT JOIN channels local_parent
        ON local_parent.id = parent_projection.local_channel_id
       AND local_parent.type = 'joint'
       AND local_parent.archived_at IS NULL
       AND local_parent.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS reply_count
        FROM messages m
        WHERE input.kind = 'thread'
          AND m.channel_id = input.storage_channel_id
      ) reply_count ON true
      LEFT JOIN tasks task
        ON task.message_id = pm.id
      ORDER BY input.row_ordinal
    `;
  };
  const queryHash = getSqlTraceHash(
    splitAllMetadata ? buildAllPageServingKeysQuery() : buildServingRowsQuery(),
  );
  const scopeTraceAttrs = inboxPgFallbackQueryScopeTraceAttrs(queryHash);
  let timeoutPlan: InboxPgFallbackTimeoutPlan | undefined;
  let receiverScopeRowCount: number | undefined;
  const receiverScopeRowCountTraceAttrs = () =>
    receiverScopeRowCount === undefined
      ? { receiver_scope_row_count_state: "unavailable_query_failed" as const }
      : {
          receiver_scope_row_count: receiverScopeRowCount,
          receiver_scope_row_count_state: "measured" as const,
        };
  const executeScopedServingRowsQuery = async (executor: DatabaseExecutor) => {
    // Keep the serving-key prefix, mention-fallback prefix, metadata,
    // bounded page hydration, and page enrichment as independent timeout
    // observations. Each key producer returns the first offset+limit+1 rows; their
    // stable in-memory union therefore contains every row that can enter the final
    // page. Hydration carries at most one requested page through JSON. Each statement
    // is independently subject to the same transaction-local 3s cap. Ordinary paging
    // already tolerates a newly created row committed between statements appearing on
    // the next request.
    const servingPageResult = splitAllMetadata
      ? await executor.execute(buildAllPageServingKeysQuery())
      : null;
    const mentionPageResult = splitAllMetadata
      ? await executor.execute(buildAllPageMentionKeysQuery())
      : null;
    const mainResult = servingPageResult && mentionPageResult
      ? {
        ...servingPageResult,
        rows: mergeAllPageKeyRows(servingPageResult.rows, mentionPageResult.rows),
      }
      : await executor.execute(buildServingRowsQuery());
    const metadataResult = splitAllMetadata
      ? await executor.execute(buildServingRowsQuery("metadata"))
      : null;
    const metadataRow = metadataResult?.rows[0];
    if (splitAllMetadata && !metadataRow) {
      throw new Error("Inbox serving-row metadata query returned no sentinel row");
    }
    const receiverScopeCount = metadataRow?.__receiverScopeRowCount
      ?? mainResult.rows[0]?.__receiverScopeRowCount;
    if (receiverScopeCount != null) {
      receiverScopeRowCount = Number(receiverScopeCount);
    }
    const pageHydrationResult = splitAllMetadata && mainResult.rows.length > 0
      ? await executor.execute(buildAllPageHydrationQuery(mainResult.rows))
      : null;
    if (
      splitAllMetadata
      && pageHydrationResult
      && pageHydrationResult.rows.length !== mainResult.rows.length
    ) {
      throw new Error("Inbox serving-row page hydration returned an incomplete page");
    }
    const mainRows = metadataRow
      ? pageHydrationResult?.rows.length
        ? pageHydrationResult.rows.map((row) => ({ ...row, ...metadataRow }))
        : [{ kind: null, ...metadataRow }]
      : mainResult.rows;
    if (!splitAllPageEnrichment) return mainResult;

    const pageRows = mainRows.filter((row) => row.kind != null);
    const pageEnrichmentResult = pageRows.length > 0
      ? await executor.execute(buildAllPageEnrichmentQuery(pageRows))
      : { rows: [] as QueryResultRow[] };
    const pageEnrichmentByOrdinal = new Map<number, QueryResultRow>();
    for (const row of pageEnrichmentResult.rows) {
      pageEnrichmentByOrdinal.set(Number(row._pageOrdinal), row);
    }
    let pageOrdinal = 0;
    const rows = mainRows.map((row) => {
      const {
        _pageOrdinal: _discardCorePageOrdinal,
        _storageChannelId: _discardStorageChannelId,
        _latestMessageLookupId: _discardLatestMessageLookupId,
        ...coreRow
      } = row;
      if (row.kind == null) return coreRow;
      const enrichment = pageEnrichmentByOrdinal.get(pageOrdinal);
      pageOrdinal += 1;
      if (!enrichment) return coreRow;
      const { _pageOrdinal: _discardPageOrdinal, ...enrichmentFields } = enrichment;
      return { ...coreRow, ...enrichmentFields };
    });
    return { ...mainResult, rows };
  };
  const executeServingRowsQuery = opts.executor
    ? () => withDbTraceAttributes(scopeTraceAttrs, () => executeScopedServingRowsQuery(opts.executor!))
    : () => withDbTraceAttributes(scopeTraceAttrs, () => db.transaction(async (tx) => {
      const inheritedTimeoutResult = await tx.execute(sql`
        SELECT setting::bigint AS "inheritedTimeoutMs", unit
        FROM pg_settings
        WHERE name = 'statement_timeout'
      `);
      const inheritedTimeoutRow = inheritedTimeoutResult.rows[0];
      if (inheritedTimeoutRow?.unit !== "ms") {
        throw new Error(
          "Unexpected statement_timeout unit for inbox PG fallback",
        );
      }
      const inheritedTimeoutMs = Number(
        inheritedTimeoutRow.inheritedTimeoutMs,
      );
      const currentTimeoutPlan: InboxPgFallbackTimeoutPlan = {
        inheritedTimeoutMs,
        effectiveTimeoutMs:
          inboxPgFallbackEffectiveTimeoutMs(inheritedTimeoutMs),
      };
      timeoutPlan = currentTimeoutPlan;
      const executionTraceAttrs = {
        ...scopeTraceAttrs,
        ...inboxPgFallbackTimeoutPlanTraceAttrs(currentTimeoutPlan),
      };
      return withDbTraceAttributes(executionTraceAttrs, async () => {
        // `is_local=true` keeps this cap transaction-local. It can only tighten
        // the inherited role/session policy: unlimited becomes 3s, 15s becomes
        // 3s, and a future stricter 2s policy remains 2s. The setting resets
        // before the checked-out client returns to the shared pool.
        await tx.execute(sql`SELECT set_config(
          'statement_timeout',
          ${`${currentTimeoutPlan.effectiveTimeoutMs}ms`},
          true
        )`);
        return executeScopedServingRowsQuery(tx);
      });
    }));
  const result = await opts.traceQuery(
    INBOX_PG_FALLBACK_QUERY_NAME,
    executeServingRowsQuery,
    (queryResult) => ({
      ...inboxTraceAttrs(
        "pg_serving_rows",
        opts.filter,
        opts.fallbackReason ?? "none",
      ),
      ...inboxPostgresSelectionTraceAttrs(
        opts.postgresSelectionReason ?? "human_activity_mute_uses_serving_rows",
      ),
      ...inboxPgFallbackQueryTraceAttrs(
        queryHash,
        "query_completed",
        timeoutPlan,
      ),
      filter: opts.filter,
      limit: opts.limit,
      offset: opts.offset,
      history_cutoff_present: Boolean(opts.historyCutoff),
      channel_id_present: Boolean(opts.channelId),
      query_present: Boolean(opts.q),
      ...receiverScopeRowCountTraceAttrs(),
      row_count: queryResult.rows.length,
    }),
    (error) => ({
      ...inboxTraceAttrs(
        "pg_serving_rows",
        opts.filter,
        opts.fallbackReason ?? "none",
      ),
      ...inboxPostgresSelectionTraceAttrs(
        opts.postgresSelectionReason ?? "human_activity_mute_uses_serving_rows",
      ),
      ...inboxPgFallbackQueryErrorTraceAttrs(queryHash, error, timeoutPlan),
      filter: opts.filter,
      limit: opts.limit,
      offset: opts.offset,
      history_cutoff_present: Boolean(opts.historyCutoff),
      channel_id_present: Boolean(opts.channelId),
      query_present: Boolean(opts.q),
      ...receiverScopeRowCountTraceAttrs(),
    }),
  );
  return { rows: result.rows };
}

export interface ActivityUnreadTotalsBatchInput {
  serverId: string;
  historyCutoff?: Date;
}

export type ActivityUnreadTotals = {
  totalUnreadCount: number;
  activeUnreadCount: number;
};

/**
 * task #235: per-server Activity unread totals for ALL of a user's servers in
 * ONE set-based statement (plus the same batched receiver-scope cardinality
 * pre-read the per-server serving path already uses).
 *
 * The CTE chain below is the totals-only extraction of
 * `getInboxItemsFromServingRows` (`filter=all`, no search, no channel facet),
 * keyed by the input VALUES table `v(server_id, history_cutoff)` instead of a
 * single `${serverId}` — every `server_id = $X` site becomes a join against
 * `v`/row server keys, the history-cutoff predicate becomes row-wise against
 * `v.history_cutoff`, and the final aggregates GROUP BY server with a LEFT
 * JOIN from `v` so an empty member server yields present-0, never a dropped
 * row (contract v2.3.1 §5/9c). Membership is revalidated IN the statement
 * (`server_members` join on the anchor): a membership revoked between the
 * route's listing and this computation drops the group entirely → the
 * service reports it unknown/absent, never a count or a fake 0 (§5
 * unauthorized fail-closed). The two texts must evolve in lockstep: the
 * per-server path stays alive as the test oracle
 * (activityUnreadTotalsBatch.oracle.test.ts) and any predicate drift between
 * them is a red test, per DoD 9d.
 *
 * Backend note (v2.3.1 §2): this batch computes the PG serving-rows (Sink B)
 * aggregates. `isHumanActivityMuteEnabled` is unconditionally true, so the
 * per-server authority path takes the same serving-rows branch for every
 * route-reachable configuration of this computation (the legacy inline branch
 * needs `forceCanonicalPostgres`, which the unread-summary loader never
 * sets). RisingWave row parity is owned by the rfcs/024 contract.
 */
export async function getActivityUnreadTotalsBatch(
  inputs: ActivityUnreadTotalsBatchInput[],
  userId: string,
  opts: {
    traceQuery?: DbQueryTracer;
    executor?: DatabaseExecutor;
  } = {},
): Promise<Map<string, ActivityUnreadTotals>> {
  const db = opts.executor ?? getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const uniqueInputs = [...new Map(inputs.map((input) => [input.serverId, input])).values()];
  if (uniqueInputs.length === 0) return new Map();
  // Backend-consistency guard: when RFC056 serving mode is "on" and an RW
  // pool is configured, Home's inbox authority can serve RW-computed totals.
  // This batch computes the PG serving-rows aggregates, so asserting a number
  // here could disagree with what Home shows — the exact cross-surface
  // divergence task #235 exists to eliminate. Fail closed: the whole batch is
  // unknown (absent on the wire) until an RW batch with audited equivalence
  // exists. "shadow" keeps Postgres authoritative and stays computable.
  const rfc056ServingMode = risingWaveInboxFailSoftDeps.getRfc056ServingMode();
  if (rfc056ServingMode === "on" && getRisingWaveInboxPool()) {
    addTraceEvent("activity_unread_batch.rw_live_fail_closed", {
      rw_rfc056_serving_mode: rfc056ServingMode,
      server_count: uniqueInputs.length,
    });
    return new Map();
  }
  const serverIdArray = `{${uniqueInputs.map((input) => input.serverId).join(",")}}`;
  const inputValuesSql = sql.join(
    uniqueInputs.map((input) =>
      sql`(${input.serverId}::uuid, ${input.historyCutoff ?? null}::timestamptz)`),
    sql`, `,
  );
  // Same rationale as the per-server serving path: the primary-key prefix
  // badly underestimates heavy receivers, so read the exact (server, source)
  // pairs first and feed them to the main statement as a VALUES table with
  // known cardinality.
  const receiverScopeQuery = sql`
    SELECT
      r.server_id::text AS "serverId",
      r.source_channel_id::text AS "sourceChannelId"
    FROM inbox_serving_rows r
    INNER JOIN channels source_channel
      ON source_channel.id = r.source_channel_id
     AND source_channel.server_id = r.server_id
     AND source_channel.deleted_at IS NULL
     AND source_channel.archived_at IS NULL
    LEFT JOIN user_channel_inbox_states inbox
      ON inbox.channel_id = source_channel.id
     AND inbox.user_id = ${userId}::uuid
    WHERE r.receiver_type = 'user'
      AND r.receiver_id = ${userId}::uuid
      AND r.server_id = ANY(${serverIdArray}::uuid[])
      AND inbox.done_at IS NULL
  `;
  const buildBatchTotalsQuery = (scopePairs: Array<{ serverId: string; sourceChannelId: string }>) => {
    const scopeValuesSql = scopePairs.length > 0
      ? sql`(VALUES ${sql.join(
          scopePairs.map((pair) => sql`(${pair.serverId}::uuid, ${pair.sourceChannelId}::uuid)`),
          sql`, `,
        )})`
      : sql`(SELECT NULL::uuid, NULL::uuid WHERE false)`;
    return sql`
    WITH v(server_id, history_cutoff) AS (
      VALUES ${inputValuesSql}
    ),
    scope(server_id, source_channel_id) AS (
      ${scopeValuesSql}
    ),
    receiver_rows AS MATERIALIZED (
      SELECT
        r.receiver_type,
        r.receiver_id,
        r.server_id,
        r.kind,
        r.source_channel_id,
        r.latest_notified_message_id,
        r.latest_notified_seq,
        r.latest_notified_at,
        r.last_activity_at,
        r.first_unread_message_id,
        r.first_unread_seq,
        r.unread_count::int AS unread_count,
        r.latest_personal_mention_message_id,
        r.latest_personal_mention_seq,
        r.unread_mention_count,
        r.has_any_mention,
        c.name AS channel_name,
        c.type AS channel_type,
        COALESCE(joint_storage.canonical_channel_id, c.id) AS storage_channel_id,
        joint_projection.joint_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        inbox.done_at AS channel_done_at,
        chat_member.user_id AS chat_member_user_id,
        tf.thread_channel_id AS followed_thread_channel_id
      FROM inbox_serving_rows r
      INNER JOIN scope
        ON scope.server_id = r.server_id
       AND scope.source_channel_id = r.source_channel_id
      INNER JOIN channels c
        ON c.id = r.source_channel_id
       AND c.deleted_at IS NULL
       AND c.archived_at IS NULL
      LEFT JOIN joint_channel_servers joint_projection
        ON joint_projection.local_channel_id = c.id
       AND joint_projection.server_id = c.server_id
       AND joint_projection.status = 'active'
      LEFT JOIN joint_channels joint_storage
        ON joint_storage.id = joint_projection.joint_channel_id
       AND joint_storage.status = 'active'
      LEFT JOIN user_channel_inbox_states inbox
        ON inbox.channel_id = c.id
       AND inbox.user_id = ${userId}
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id
       AND rc.user_id = ${userId}
      LEFT JOIN channel_humans chat_member
        ON chat_member.channel_id = c.id
       AND chat_member.user_id = ${userId}
      LEFT JOIN thread_follows tf
        ON tf.thread_channel_id = c.id
       AND tf.follower_type = 'user'
       AND tf.follower_id = ${userId}
       AND tf.done_at IS NULL
       AND tf.unfollowed_at IS NULL
      WHERE r.receiver_type = 'user'
        AND r.receiver_id = ${userId}::uuid
        AND c.server_id = r.server_id
        AND inbox.done_at IS NULL
    ),
    mention_scope AS MATERIALIZED (
      SELECT
        receiver.server_id,
        receiver.source_channel_id,
        receiver.source_channel_id AS mention_channel_id,
        receiver.last_read_seq
      FROM receiver_rows receiver
      UNION
      SELECT
        receiver.server_id,
        receiver.source_channel_id,
        sibling_projection.local_channel_id AS mention_channel_id,
        receiver.last_read_seq
      FROM receiver_rows receiver
      INNER JOIN joint_channel_servers sibling_projection
        ON sibling_projection.joint_channel_id = receiver.joint_channel_id
       AND sibling_projection.status = 'active'
    ),
    live_mentions AS MATERIALIZED (
      SELECT
        scope_rows.server_id,
        scope_rows.source_channel_id,
        (array_agg(mention.message_id ORDER BY mention.message_seq DESC, mention.message_id DESC))[1] AS latest_message_id,
        max(mention.message_seq) AS latest_message_seq,
        (count(*) FILTER (
          WHERE mention.message_seq > scope_rows.last_read_seq
        ))::int AS unread_mention_count,
        (array_agg(mention.message_id ORDER BY mention.message_seq ASC, mention.message_id ASC) FILTER (
          WHERE mention.message_seq > scope_rows.last_read_seq
        ))[1] AS first_unread_message_id
      FROM mention_scope scope_rows
      INNER JOIN message_mentions mention
        ON mention.channel_id = scope_rows.mention_channel_id
       AND mention.target_type = 'user'
       AND mention.target_id = ${userId}::uuid
       AND (mention.notifiable_at_send OR mention.notified_at IS NOT NULL)
      GROUP BY scope_rows.server_id, scope_rows.source_channel_id, scope_rows.last_read_seq
    ),
    base_rows AS (
      SELECT
        r.receiver_type,
        r.receiver_id,
        r.server_id,
        r.kind,
        r.source_channel_id,
        r.latest_notified_message_id,
        r.latest_notified_seq,
        r.latest_notified_at,
        r.last_activity_at,
        r.first_unread_message_id,
        r.first_unread_seq,
        r.unread_count,
        CASE
          WHEN live_mentions.latest_message_seq IS NOT NULL
            AND (r.latest_personal_mention_seq IS NULL OR live_mentions.latest_message_seq >= r.latest_personal_mention_seq)
          THEN live_mentions.latest_message_id
          ELSE r.latest_personal_mention_message_id
        END AS latest_personal_mention_message_id,
        GREATEST(
          COALESCE(r.latest_personal_mention_seq, 0),
          COALESCE(live_mentions.latest_message_seq, 0)
        ) AS latest_personal_mention_seq,
        GREATEST(r.unread_mention_count, COALESCE(live_mentions.unread_mention_count, 0)) AS unread_mention_count,
        live_mentions.first_unread_message_id AS first_unread_personal_mention_message_id,
        (r.has_any_mention OR live_mentions.latest_message_id IS NOT NULL) AS has_any_mention,
        r.channel_name,
        r.channel_type,
        r.storage_channel_id,
        r.last_read_seq,
        r.channel_done_at,
        r.chat_member_user_id,
        r.followed_thread_channel_id
      FROM receiver_rows r
      LEFT JOIN live_mentions
        ON live_mentions.source_channel_id = r.source_channel_id
    ),
    visible_rows AS (
      SELECT
        b.*,
        CASE
          WHEN b.kind IN ('channel', 'dm') AND b.chat_member_user_id IS NOT NULL THEN false
          WHEN b.kind = 'thread' AND b.followed_thread_channel_id IS NOT NULL THEN false
          ELSE true
        END AS mention_only
      FROM base_rows b
      WHERE (
          b.kind IN ('channel', 'dm')
          AND b.channel_type IN ('channel', 'private', 'joint', 'dm')
          AND b.chat_member_user_id IS NOT NULL
        )
        OR (
          b.kind = 'thread'
          AND b.followed_thread_channel_id IS NOT NULL
        )
        OR b.has_any_mention
    ),
    mention_channel_rows AS (
      SELECT
        'user' AS receiver_type,
        ${userId}::uuid AS receiver_id,
        latest_mention.server_id AS server_id,
        CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind,
        c.id AS source_channel_id,
        m.id AS latest_notified_message_id,
        m.seq AS latest_notified_seq,
        m.created_at AS latest_notified_at,
        m.created_at AS last_activity_at,
        CASE
          WHEN chat_member.user_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN m.id
          ELSE NULL
        END AS first_unread_message_id,
        CASE
          WHEN chat_member.user_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN m.seq
          ELSE NULL
        END AS first_unread_seq,
        CASE
          WHEN chat_member.user_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN 1
          ELSE 0
        END::int AS unread_count,
        m.id AS latest_personal_mention_message_id,
        m.seq AS latest_personal_mention_seq,
        CASE WHEN m.seq > COALESCE(rc.last_read_seq, 0) THEN 1 ELSE 0 END::int AS unread_mention_count,
        m.id AS first_unread_personal_mention_message_id,
        true AS has_any_mention,
        c.name AS channel_name,
        c.type AS channel_type,
        COALESCE(joint_storage.canonical_channel_id, c.id) AS storage_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        inbox.done_at AS channel_done_at,
        chat_member.user_id AS chat_member_user_id,
        NULL::uuid AS followed_thread_channel_id,
        CASE WHEN chat_member.user_id IS NOT NULL THEN false ELSE true END AS mention_only
      FROM (
        SELECT
          mm.channel_id,
          mention_channel.server_id,
          max(mm.message_seq) AS latest_mention_seq
        FROM message_mentions mm
        INNER JOIN channels mention_channel
          ON mention_channel.id = mm.channel_id
        INNER JOIN v
          ON v.server_id = mention_channel.server_id
        LEFT JOIN channel_humans member_check
          ON member_check.channel_id = mm.channel_id
         AND member_check.user_id = ${userId}
        LEFT JOIN user_channel_inbox_states inbox_check
          ON inbox_check.channel_id = mm.channel_id
         AND inbox_check.user_id = ${userId}
        LEFT JOIN inbox_suppression_states mention_suppression
          ON mention_suppression.receiver_type = 'user'
         AND mention_suppression.receiver_id = ${userId}::uuid
         AND mention_suppression.target_kind = 'public_channel_mention'
         AND mention_suppression.target_channel_id = mm.channel_id
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND mm.server_id = v.server_id
          AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
          AND mm.message_seq > COALESCE(mention_suppression.done_through_seq, 0)
          AND mention_channel.type IN ('channel', 'private', 'joint', 'dm')
          AND mention_channel.deleted_at IS NULL
          AND mention_channel.archived_at IS NULL
          AND inbox_check.done_at IS NULL
          AND (
            member_check.user_id IS NOT NULL
            OR (mention_channel.type = 'channel' AND mm.notified_at IS NOT NULL)
          )
        GROUP BY mm.channel_id, mention_channel.server_id
      ) latest_mention
      INNER JOIN channels c
        ON c.id = latest_mention.channel_id
      INNER JOIN messages m
        ON m.channel_id = latest_mention.channel_id
       AND m.seq = latest_mention.latest_mention_seq
      LEFT JOIN joint_channel_servers joint_projection
        ON joint_projection.local_channel_id = c.id
       AND joint_projection.server_id = c.server_id
       AND joint_projection.status = 'active'
      LEFT JOIN joint_channels joint_storage
        ON joint_storage.id = joint_projection.joint_channel_id
       AND joint_storage.status = 'active'
      LEFT JOIN user_channel_inbox_states inbox
        ON inbox.channel_id = c.id
       AND inbox.user_id = ${userId}
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id
       AND rc.user_id = ${userId}
      LEFT JOIN channel_humans chat_member
        ON chat_member.channel_id = c.id
       AND chat_member.user_id = ${userId}
    ),
    mention_thread_rows AS (
      SELECT
        'user' AS receiver_type,
        ${userId}::uuid AS receiver_id,
        latest_mention.server_id AS server_id,
        'thread' AS kind,
        t.id AS source_channel_id,
        m.id AS latest_notified_message_id,
        m.seq AS latest_notified_seq,
        m.created_at AS latest_notified_at,
        m.created_at AS last_activity_at,
        CASE
          WHEN existing_follow.thread_channel_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN m.id
          ELSE NULL
        END AS first_unread_message_id,
        CASE
          WHEN existing_follow.thread_channel_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN m.seq
          ELSE NULL
        END AS first_unread_seq,
        CASE
          WHEN existing_follow.thread_channel_id IS NOT NULL
           AND m.seq > COALESCE(rc.last_read_seq, 0)
           AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          THEN 1
          ELSE 0
        END::int AS unread_count,
        m.id AS latest_personal_mention_message_id,
        m.seq AS latest_personal_mention_seq,
        CASE WHEN m.seq > COALESCE(rc.last_read_seq, 0) THEN 1 ELSE 0 END::int AS unread_mention_count,
        m.id AS first_unread_personal_mention_message_id,
        true AS has_any_mention,
        t.name AS channel_name,
        t.type AS channel_type,
        COALESCE(canonical_thread.id, t.id) AS storage_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        NULL::timestamp AS channel_done_at,
        NULL::uuid AS chat_member_user_id,
        existing_follow.thread_channel_id AS followed_thread_channel_id,
        CASE WHEN existing_follow.thread_channel_id IS NOT NULL THEN false ELSE true END AS mention_only
      FROM (
        SELECT
          mm.channel_id,
          thread_channel.server_id,
          max(mm.message_seq) AS latest_mention_seq
        FROM message_mentions mm
        INNER JOIN channels thread_channel
          ON thread_channel.id = mm.channel_id
        INNER JOIN v
          ON v.server_id = thread_channel.server_id
        INNER JOIN messages parent_message
          ON parent_message.id = thread_channel.parent_message_id
        INNER JOIN channels parent_channel
          ON parent_channel.id = parent_message.channel_id
        LEFT JOIN thread_follows existing_follow
          ON existing_follow.thread_channel_id = mm.channel_id
         AND existing_follow.follower_type = 'user'
         AND existing_follow.follower_id = ${userId}
         AND existing_follow.done_at IS NULL
         AND existing_follow.unfollowed_at IS NULL
        LEFT JOIN channel_humans parent_member
          ON parent_member.channel_id = parent_channel.id
         AND parent_member.user_id = ${userId}
        LEFT JOIN inbox_suppression_states mention_suppression
          ON mention_suppression.receiver_type = 'user'
         AND mention_suppression.receiver_id = ${userId}::uuid
         AND mention_suppression.target_kind = 'public_thread_mention'
         AND mention_suppression.target_channel_id = mm.channel_id
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND mm.server_id = v.server_id
          AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
          AND mm.message_seq > COALESCE(mention_suppression.done_through_seq, 0)
          AND thread_channel.type = 'thread'
          AND thread_channel.deleted_at IS NULL
          AND parent_channel.archived_at IS NULL
          AND parent_channel.deleted_at IS NULL
          AND (
            existing_follow.thread_channel_id IS NOT NULL
            OR (
              mm.notified_at IS NOT NULL
              AND (
                parent_channel.type = 'channel'
                OR parent_member.user_id IS NOT NULL
              )
            )
          )
        GROUP BY mm.channel_id, thread_channel.server_id
      ) latest_mention
      INNER JOIN channels t
        ON t.id = latest_mention.channel_id
      INNER JOIN messages m
        ON m.channel_id = latest_mention.channel_id
       AND m.seq = latest_mention.latest_mention_seq
      LEFT JOIN joint_channel_servers thread_projection
        ON thread_projection.local_channel_id = t.id
       AND thread_projection.server_id = latest_mention.server_id
       AND thread_projection.status = 'active'
      LEFT JOIN joint_channels thread_joint
        ON thread_joint.id = thread_projection.joint_channel_id
       AND thread_joint.status = 'active'
      LEFT JOIN channels canonical_thread
        ON canonical_thread.id = thread_joint.canonical_channel_id
       AND canonical_thread.type = 'thread'
       AND canonical_thread.deleted_at IS NULL
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = t.id
       AND rc.user_id = ${userId}
      LEFT JOIN thread_follows existing_follow
        ON existing_follow.thread_channel_id = t.id
       AND existing_follow.follower_type = 'user'
       AND existing_follow.follower_id = ${userId}
       AND existing_follow.done_at IS NULL
       AND existing_follow.unfollowed_at IS NULL
    ),
    all_visible_rows AS (
      SELECT * FROM visible_rows
      UNION ALL
      SELECT mc.*
      FROM mention_channel_rows mc
      WHERE NOT EXISTS (
        SELECT 1
        FROM visible_rows vr
        WHERE vr.server_id = mc.server_id
          AND vr.kind = mc.kind
          AND vr.source_channel_id = mc.source_channel_id
      )
      UNION ALL
      SELECT mt.*
      FROM mention_thread_rows mt
      WHERE NOT EXISTS (
        SELECT 1
        FROM visible_rows vr
        WHERE vr.server_id = mt.server_id
          AND vr.kind = mt.kind
          AND vr.source_channel_id = mt.source_channel_id
      )
    ),
    active_totals AS (
      SELECT
        avr.server_id,
        COALESCE(sum(CASE WHEN avr.mention_only THEN 0 ELSE avr.unread_count END), 0)::int AS active_unread_count
      FROM all_visible_rows avr
      INNER JOIN v
        ON v.server_id = avr.server_id
      WHERE avr.last_activity_at IS NOT NULL
        AND (v.history_cutoff IS NULL OR avr.last_activity_at > v.history_cutoff)
      GROUP BY avr.server_id
    ),
    filtered AS (
      SELECT avr.*
      FROM all_visible_rows avr
      INNER JOIN v
        ON v.server_id = avr.server_id
      WHERE avr.last_activity_at IS NOT NULL
        AND (v.history_cutoff IS NULL OR avr.last_activity_at > v.history_cutoff)
    ),
    faceted AS (
      SELECT
        filtered.*,
        CASE WHEN filtered.kind = 'thread' THEN COALESCE(local_parent.id, parent_ch.id) ELSE filtered.source_channel_id END AS "groupChannelId"
      FROM filtered
      LEFT JOIN channels thread_channel
        ON thread_channel.id = filtered.source_channel_id
       AND filtered.kind = 'thread'
      LEFT JOIN joint_channel_servers thread_projection
        ON thread_projection.local_channel_id = thread_channel.id
       AND thread_projection.server_id = filtered.server_id
       AND thread_projection.status = 'active'
      LEFT JOIN joint_channels thread_joint
        ON thread_joint.id = thread_projection.joint_channel_id
       AND thread_joint.status = 'active'
      LEFT JOIN channels canonical_thread
        ON canonical_thread.id = thread_joint.canonical_channel_id
       AND canonical_thread.type = 'thread'
       AND canonical_thread.deleted_at IS NULL
      LEFT JOIN messages parent_message
        ON parent_message.id = COALESCE(canonical_thread.parent_message_id, thread_channel.parent_message_id)
      LEFT JOIN channels parent_ch
        ON parent_ch.id = parent_message.channel_id
      LEFT JOIN joint_channels parent_joint
        ON parent_joint.canonical_channel_id = parent_message.channel_id
       AND parent_joint.status = 'active'
      LEFT JOIN joint_channel_servers parent_projection
        ON parent_projection.joint_channel_id = parent_joint.id
       AND parent_projection.server_id = filtered.server_id
       AND parent_projection.status = 'active'
      LEFT JOIN channels local_parent
        ON local_parent.id = parent_projection.local_channel_id
       AND local_parent.type = 'joint'
       AND local_parent.archived_at IS NULL
       AND local_parent.deleted_at IS NULL
    ),
    totals AS (
      SELECT
        faceted.server_id,
        COALESCE(sum(CASE WHEN faceted.mention_only THEN 0 ELSE faceted.unread_count END), 0)::int AS total_unread_count
      FROM faceted
      GROUP BY faceted.server_id
    )
    SELECT
      v.server_id::text AS "serverId",
      COALESCE(totals.total_unread_count, 0)::int AS "totalUnreadCount",
      COALESCE(active_totals.active_unread_count, 0)::int AS "activeUnreadCount"
    FROM v
    INNER JOIN server_members sm
      ON sm.server_id = v.server_id
     AND sm.user_id = ${userId}::uuid
    LEFT JOIN totals
      ON totals.server_id = v.server_id
    LEFT JOIN active_totals
      ON active_totals.server_id = v.server_id
    `;
  };
  const executeBatch = async (executor: DatabaseExecutor) => {
    const scopeResult = await executor.execute(receiverScopeQuery);
    const scopePairs = scopeResult.rows.map((row) => ({
      serverId: String(row.serverId),
      sourceChannelId: String(row.sourceChannelId),
    }));
    return executor.execute(buildBatchTotalsQuery(scopePairs));
  };
  const executeWithTimeoutCap = opts.executor
    ? () => executeBatch(opts.executor!)
    : () => db.transaction(async (tx) => {
      const inheritedTimeoutResult = await tx.execute(sql`
        SELECT setting::bigint AS "inheritedTimeoutMs", unit
        FROM pg_settings
        WHERE name = 'statement_timeout'
      `);
      const inheritedTimeoutRow = inheritedTimeoutResult.rows[0];
      if (inheritedTimeoutRow?.unit !== "ms") {
        throw new Error(
          "Unexpected statement_timeout unit for activity unread totals batch",
        );
      }
      const effectiveTimeoutMs = inboxPgFallbackEffectiveTimeoutMs(
        Number(inheritedTimeoutRow.inheritedTimeoutMs),
      );
      await tx.execute(sql`SELECT set_config(
        'statement_timeout',
        ${`${effectiveTimeoutMs}ms`},
        true
      )`);
      return executeBatch(tx);
    });
  const result = await traceQuery(
    "channels.activity_unread_totals_batch_by_user",
    executeWithTimeoutCap,
    (queryResult) => ({
      server_count: uniqueInputs.length,
      row_count: queryResult.rows.length,
    }),
  );
  const totalsByServer = new Map<string, ActivityUnreadTotals>();
  for (const row of result.rows) {
    totalsByServer.set(String(row.serverId), {
      totalUnreadCount: Number(row.totalUnreadCount),
      activeUnreadCount: Number(row.activeUnreadCount),
    });
  }
  return totalsByServer;
}

async function tryGetSidebarUnreadSummaryCountsFromRisingWave(
  servers: SidebarUnreadSummaryInput[],
  userId: string,
  traceQuery: DbQueryTracer,
): Promise<RisingWaveInboxAttempt<Record<string, number>>> {
  if (!getRisingWaveInboxPool()) return { result: null };
  return tryReadRisingWaveInboxWithFailSoft(
    "sidebar_summary",
    RISINGWAVE_LEGACY_UNREAD_CONTRACT_VERSION,
    () => getSidebarUnreadSummaryCountsFromRisingWave(servers, userId, traceQuery),
  );
}

type InboxReadAuthority = { present: boolean; seq: number };

function safeReadFrontierNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function getPrimaryInboxReadAuthority(
  serverId: string,
  userId: string,
  traceQuery: DbQueryTracer,
): Promise<InboxReadAuthority> {
  const rows = await traceQuery(
    "channels.inbox_read_authority_by_user",
    () => getDb()
      .select({ seq: readMutationAuthorities.lastTerminalAuthoritySeq })
      .from(readMutationAuthorities)
      .where(and(
        eq(readMutationAuthorities.serverId, serverId),
        eq(readMutationAuthorities.principalId, userId),
      ))
      .limit(1),
    (result) => ({ row_count: result.length }),
  );
  return rows[0] ? { present: true, seq: rows[0].seq } : { present: false, seq: 0 };
}

function validateRisingWaveInboxReadFrontier(
  rows: readonly InboxPolicySqlRow[],
  primary: InboxReadAuthority,
): { ok: true } | { ok: false; reason: string; rwAuthoritySeq: number | null; rwAuthorityPresent: boolean | null } {
  const sentinel = rows[0];
  const rwAuthoritySeq = safeReadFrontierNumber(sentinel?.readAuthoritySeq);
  const rwAuthorityPresent = typeof sentinel?.readAuthorityPresent === "boolean"
    ? sentinel.readAuthorityPresent
    : null;
  if (
    !sentinel
    || rwAuthoritySeq === null
    || rwAuthorityPresent === null
    || rwAuthorityPresent !== primary.present
    || rwAuthoritySeq !== primary.seq
  ) {
    return { ok: false, reason: "authority_mismatch", rwAuthoritySeq, rwAuthorityPresent };
  }

  for (const row of rows) {
    if (row.kind == null) continue;
    const maxReadSeq = safeReadFrontierNumber(row.maxReadSeq);
    const readStateVersion = safeReadFrontierNumber(row.readStateVersion);
    if (maxReadSeq === null || readStateVersion === null) {
      return { ok: false, reason: "row_read_state_missing", rwAuthoritySeq, rwAuthorityPresent };
    }
    if (row.mentionOnly !== true) {
      const materializedLastReadSeq = safeReadFrontierNumber(row.materializedLastReadSeq);
      if (materializedLastReadSeq === null || materializedLastReadSeq !== maxReadSeq) {
        return { ok: false, reason: "cursor_projection_mismatch", rwAuthoritySeq, rwAuthorityPresent };
      }
      if (
        (materializedLastReadSeq > 0 || readStateVersion > 0)
        && row.readCursorPresent !== true
      ) {
        return { ok: false, reason: "cursor_projection_missing", rwAuthoritySeq, rwAuthorityPresent };
      }
    }
  }
  return { ok: true };
}

function attachRisingWaveReadStateToInboxItems(
  items: InboxItem[],
  rows: readonly InboxPolicySqlRow[],
): InboxItem[] {
  return items.map((item, index) => ({
    ...item,
    maxReadSeq: safeReadFrontierNumber(rows[index]?.maxReadSeq) ?? 0,
    readStateVersion: safeReadFrontierNumber(rows[index]?.readStateVersion) ?? 0,
  } as InboxItem));
}

type InboxItemsResult = {
  items: InboxItem[];
  groups: InboxGroupCount[];
  hasMore: boolean;
  totalCount: number;
  totalUnreadCount: number;
  activeUnreadCount: number;
};

function inboxItemActivityAt(item: InboxItem): string {
  return item.kind === "thread" ? item.lastActivityAt : item.lastMessageAt;
}

function inboxItemIdentity(item: InboxItem): string {
  return `${item.kind}:${item.kind === "thread" ? item.threadChannelId : item.channelId}`;
}

function compareInboxItems(
  left: InboxItem,
  right: InboxItem,
  sort: "asc" | "desc" | undefined,
): number {
  const direction = sort === "asc" ? 1 : -1;
  const leftAt = new Date(inboxItemActivityAt(left)).getTime();
  const rightAt = new Date(inboxItemActivityAt(right)).getTime();
  if (leftAt !== rightAt) return (leftAt - rightAt) * direction;
  const kindDelta = left.kind.localeCompare(right.kind);
  if (kindDelta !== 0) return kindDelta * direction;
  return inboxItemIdentity(left).localeCompare(inboxItemIdentity(right)) * direction;
}

function mergeActivityGroups(
  active: readonly InboxGroupCount[],
  unfollowed: readonly InboxItem[],
): InboxGroupCount[] {
  const groups = new Map(active.map((group) => [group.channelId, { ...group }]));
  for (const item of unfollowed) {
    if (item.kind !== "thread") continue;
    const current = groups.get(item.parentChannelId);
    if (!current) {
      groups.set(item.parentChannelId, {
        channelId: item.parentChannelId,
        channelName: item.parentChannelName,
        channelType: item.parentChannelType as InboxGroupCount["channelType"],
        count: 1,
        lastActivityAt: item.lastActivityAt,
      });
      continue;
    }
    current.count += 1;
    if (new Date(item.lastActivityAt).getTime() > new Date(current.lastActivityAt).getTime()) {
      current.lastActivityAt = item.lastActivityAt;
    }
  }
  return [...groups.values()].sort((left, right) => {
    const leftDm = left.channelType === "dm" ? 0 : 1;
    const rightDm = right.channelType === "dm" ? 0 : 1;
    if (leftDm !== rightDm) return leftDm - rightDm;
    const activityDelta = new Date(right.lastActivityAt).getTime()
      - new Date(left.lastActivityAt).getTime();
    if (activityDelta !== 0) return activityDelta;
    const nameDelta = left.channelName.toLocaleLowerCase().localeCompare(
      right.channelName.toLocaleLowerCase(),
    );
    if (nameDelta !== 0) return nameDelta;
    return left.channelId.localeCompare(right.channelId);
  });
}

async function getUnifiedActivityAllInboxItems(
  serverId: string,
  userId: string,
  opts: NonNullable<Parameters<typeof getInboxItems>[2]>,
  limit: number,
  offset: number,
): Promise<InboxItemsResult> {
  const needed = offset + limit + 1;
  const active = await getInboxItems(serverId, userId, {
    ...opts,
    includeUnfollowedThreads: false,
    internalLimitCap: needed,
    filter: "all",
    limit: needed,
    offset: 0,
  });
  const allUnfollowed = await getActiveUnfollowedInboxItems(serverId, userId, {
    historyCutoff: opts.historyCutoff,
    q: opts.q,
    sort: opts.sort,
    traceQuery: opts.traceQuery,
    executor: opts.executor,
  });
  const pageUnfollowed = opts.channelId
    ? allUnfollowed.filter((item) => item.kind === "thread" && item.parentChannelId === opts.channelId)
    : allUnfollowed;
  const activeItems = active.items.map((item): InboxItem => item.kind === "thread"
    ? { ...item, isFollowing: true, unfollowedAt: null }
    : item);
  const activeKeys = new Set(activeItems.map(inboxItemIdentity));
  const unfollowedItems = pageUnfollowed.filter((item) => !activeKeys.has(inboxItemIdentity(item)));
  const combined = [...activeItems, ...unfollowedItems]
    .sort((left, right) => compareInboxItems(left, right, opts.sort));

  return {
    items: combined.slice(offset, offset + limit),
    groups: mergeActivityGroups(active.groups, allUnfollowed.filter(
      (item) => !activeKeys.has(inboxItemIdentity(item)),
    )),
    hasMore: active.hasMore || combined.length > offset + limit,
    totalCount: active.totalCount + unfollowedItems.length,
    totalUnreadCount: active.totalUnreadCount,
    activeUnreadCount: active.activeUnreadCount,
  };
}

function recordRfc056ServingGuardDecision(
  mode: RisingWaveInboxRfc056ServingMode,
  route: InboxFilter,
  queryAllowed: boolean,
) {
  const servingAuthority = mode === "on" && queryAllowed
    ? "risingwave_candidate_with_postgres_fallback"
    : "postgres_only";
  addTraceEvent("inbox.rw.rfc056_serving_guard.decision", {
    ...inboxTraceAttrs(
      servingAuthority === "postgres_only" ? "pg_legacy" : "rw_mv",
      route,
      "none",
    ),
    "rw.rfc056.serving_mode": mode,
    "rw.rfc056.query_allowed": queryAllowed,
    "rw.rfc056.serving_authority": servingAuthority,
    rw_rfc056_serving_mode: mode,
    rw_rfc056_query_allowed: queryAllowed,
    rw_rfc056_serving_authority: servingAuthority,
  });
}

async function buildRisingWaveInboxItemsResult(
  result: InboxQueryResult,
  limit: number,
  traceQuery: DbQueryTracer,
  db: DatabaseExecutor,
): Promise<InboxItemsResult> {
  const rawRows = result.rows as InboxPolicySqlRow[];
  const page = selectInboxPolicyPageRows(rawRows, limit);
  const pageRows = page.rows;
  await enrichInboxRowsWithProfileNames(pageRows, traceQuery, db);
  const mappedItems = mapInboxPolicyRowsToItems(pageRows, logInboxScopeCorruption, "servingPair") as InboxItem[];
  return {
    items: attachRisingWaveReadStateToInboxItems(mappedItems, pageRows),
    groups: readInboxGroupCounts(result.rows),
    hasMore: page.hasMore,
    totalCount: page.totalCount,
    totalUnreadCount: page.totalUnreadCount,
    activeUnreadCount: selectInboxPolicyActiveUnreadCount(rawRows, page.totalUnreadCount),
  };
}

function recordRfc056ShadowComparison(
  route: InboxFilter,
  candidate: InboxItemsResult | null,
  authoritative: InboxItemsResult,
) {
  const matched = candidate !== null
    ? JSON.stringify(candidate) === JSON.stringify(authoritative)
    : null;
  addTraceEvent("inbox.rw.rfc056_serving_guard.shadow_comparison", {
    ...inboxTraceAttrs("pg_legacy", route, "none"),
    "rw.rfc056.serving_mode": "shadow",
    "rw.rfc056.authoritative_backend": "pg_legacy",
    "rw.rfc056.comparison": matched === null
      ? "candidate_unavailable"
      : matched
        ? "match"
        : "mismatch",
    "rw.rfc056.candidate_items_count": candidate?.items.length ?? 0,
    "rw.rfc056.authoritative_items_count": authoritative.items.length,
    "rw.rfc056.candidate_total_count": candidate?.totalCount ?? 0,
    "rw.rfc056.authoritative_total_count": authoritative.totalCount,
    rw_rfc056_serving_mode: "shadow",
    rw_rfc056_authoritative_backend: "pg_legacy",
    rw_rfc056_comparison: matched === null
      ? "candidate_unavailable"
      : matched
        ? "match"
        : "mismatch",
  });
}

async function observeRfc056ShadowComparison(
  route: InboxFilter,
  candidate: InboxQueryResult | null,
  authoritative: InboxItemsResult,
  limit: number,
  traceQuery: DbQueryTracer,
  db: DatabaseExecutor,
) {
  if (!candidate) {
    recordRfc056ShadowComparison(route, null, authoritative);
    return;
  }
  try {
    const candidateResult = await buildRisingWaveInboxItemsResult(
      candidate,
      limit,
      traceQuery,
      db,
    );
    recordRfc056ShadowComparison(route, candidateResult, authoritative);
  } catch {
    // Shadow observations are diagnostic only. Candidate comparison failures
    // can never fail or replace the authoritative Postgres response.
    recordRfc056ShadowComparison(route, null, authoritative);
  }
}

export async function getInboxItems(
  serverId: string,
  userId: string,
  opts: {
    filter?: InboxFilter;
    limit?: number;
    offset?: number;
    channelId?: string;
    q?: string;
    sort?: "asc" | "desc";
    historyCutoff?: Date;
    humanActivityMuteEnabled?: boolean;
    traceQuery?: DbQueryTracer;
    executor?: DatabaseExecutor;
    forcePostgres?: boolean;
    /** Bypass both RW and the serving-row projection for authority transactions. */
    forceCanonicalPostgres?: boolean;
    /** Activity All only: include unfollowed/not-done threads in the same page. */
    includeUnfollowedThreads?: boolean;
    /** Internal compositor escape hatch; HTTP callers remain capped at 100. */
    internalLimitCap?: number;
  } = {},
): Promise<InboxItemsResult> {
  const db = opts.executor ?? getDb();
  const guestAccess = await guestInboxChannelIds(serverId, userId, db);
  const filter = opts.filter ?? "all";
  const limitCap = Math.max(opts.internalLimitCap ?? 100, 1);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), limitCap);
  const offset = Math.max(opts.offset ?? 0, 0);
  const channelId = opts.channelId;
  const q = opts.q?.trim() || undefined;
  const sortDirection = opts.sort === "asc" ? sql`ASC` : sql`DESC`;
  const historyCutoff = opts.historyCutoff;
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  if (filter === "all" && opts.includeUnfollowedThreads) {
    return getUnifiedActivityAllInboxItems(serverId, userId, { ...opts, q }, limit, offset);
  }
  const legacyFallbackReason = getLegacyInboxFallbackReason(historyCutoff);
  const humanActivityMuteEnabled =
    opts.humanActivityMuteEnabled ??
    (await isHumanActivityMuteEnabled(serverId, userId));
  const humanMuteFromSeqSelect = humanActivityMuteEnabled
    ? sql`mute.mute_from_seq`
    : sql`NULL::bigint`;
  const humanMuteStateJoinSql = humanActivityMuteEnabled
    ? sql`
      LEFT JOIN inbox_target_mute_states mute
        ON mute.receiver_type = 'user'
       AND mute.receiver_id = ${userId}::uuid
       AND mute.server_id = ${serverId}
       AND mute.source_channel_id = c.id
    `
    : sql``;

  // The current RW inbox projection intentionally does not materialize sender
  // display names. Search must include the visible sender label, so query
  // requests use the canonical Postgres paths until that field joins the
  // versioned RW contract; non-search traffic keeps the existing RW fast path.
  // Guest policy is not yet represented in materialized projections. Use
  // the canonical query until those projections carry this access axis.
  const rfc056ServingMode = guestAccess !== null ? "off" : risingWaveInboxFailSoftDeps.getRfc056ServingMode();
  const rfc056QueryAllowed = !q
    && !opts.forcePostgres
    && rfc056ServingMode !== "off";
  recordRfc056ServingGuardDecision(
    rfc056ServingMode,
    filter,
    rfc056QueryAllowed,
  );
  let risingWaveAttempt: RisingWaveInboxAttempt<InboxQueryResult> = !rfc056QueryAllowed
    ? { result: null }
    : await tryGetInboxItemsFromRisingWave(serverId, userId, {
        filter,
        limit,
        offset,
        channelId,
        sort: opts.sort,
        historyCutoff,
        includeMentionOnlyInAllAndUnread: humanActivityMuteEnabled,
        traceQuery,
      });
  let risingWaveResult = risingWaveAttempt.result;
  if (risingWaveResult) {
    const primaryAuthority = await getPrimaryInboxReadAuthority(
      serverId,
      userId,
      traceQuery,
    );
    const validation = validateRisingWaveInboxReadFrontier(
      risingWaveResult.rows as InboxPolicySqlRow[],
      primaryAuthority,
    );
    if (!validation.ok) {
      addTraceEvent("inbox.rw.read_frontier_mismatch", {
        ...inboxTraceAttrs(
          "rw_mv",
          filter,
          "read_frontier_mismatch",
          risingWaveResult.contractVersion,
        ),
        reason: validation.reason,
        pg_authority_present: primaryAuthority.present,
        pg_authority_seq: primaryAuthority.seq,
        rw_authority_present: validation.rwAuthorityPresent,
        rw_authority_seq: validation.rwAuthoritySeq,
        fallback_target: "pg_fallback",
        fallback_outcome: "pg_selected",
      });
      risingWaveResult = null;
      risingWaveAttempt = {
        ...risingWaveAttempt,
        result: null,
        fallbackReason: "read_frontier_mismatch",
      };
    }
  }
  const risingWaveShadowResult = rfc056ServingMode === "shadow"
    ? risingWaveResult
    : null;
  if (rfc056ServingMode === "shadow") {
    // Shadow may read and compare RFC056, but Postgres remains authoritative.
    risingWaveResult = null;
  }
  const pgCanonicalFallbackReason: InboxFallbackReason =
    risingWaveAttempt.fallbackReason ?? legacyFallbackReason;
  const servingRowsFallbackReason: InboxFallbackReason = historyCutoff
    ? pgCanonicalFallbackReason
    : (risingWaveAttempt.fallbackReason ?? "none");
  const pgCanonicalContractVersion = risingWaveAttempt.contractVersion;
  const postgresSelectionReason: InboxPostgresSelectionReason = risingWaveResult
    ? "risingwave_result"
    : rfc056ServingMode === "off"
      ? "rfc056_guard_off_uses_canonical_pg"
      : rfc056ServingMode === "shadow"
        ? "rfc056_shadow_uses_canonical_pg"
        : risingWaveAttempt.fallbackReason === "read_frontier_mismatch"
          ? "read_frontier_mismatch_uses_canonical_pg"
          : historyCutoff
            ? "history_cutoff_uses_serving_rows"
            : humanActivityMuteEnabled
              ? "human_activity_mute_uses_serving_rows"
              : "legacy_inline_policy_pending_serving_rows_migration";
  const postgresSelectionAttrs = inboxPostgresSelectionTraceAttrs(
    postgresSelectionReason,
  );
  const selection: InboxBackendSelection = risingWaveResult
    ? {
        backend: "rw_mv",
        fallbackReason: "none",
        contractVersion: risingWaveResult.contractVersion,
      }
    : {
        backend: "pg_legacy",
        fallbackReason: pgCanonicalFallbackReason,
        contractVersion: pgCanonicalContractVersion,
      };

  if (
    (humanActivityMuteEnabled || historyCutoff)
    && !risingWaveResult
    && !opts.forceCanonicalPostgres
  ) {
    const servingResult = await withRisingWaveInboxFallbackTrace(
      filter,
      "channels.inbox_items_serving_rows_by_user",
      risingWaveAttempt,
      () => getInboxItemsFromServingRows(serverId, userId, {
        filter,
        limit,
        offset,
        channelId,
        q,
        sort: opts.sort,
        historyCutoff,
        fallbackReason: servingRowsFallbackReason,
        postgresSelectionReason,
        traceQuery,
        executor: opts.executor,
      }),
    );
    const page = selectInboxPolicyPageRows(
      servingResult.rows as InboxPolicySqlRow[],
      limit,
    );
    const pageRows = page.rows as any[];
    await enrichInboxRowsWithProfileNames(pageRows, traceQuery, db);
    recordInboxBackendSelected(
      "pg_serving_rows",
      filter,
      servingRowsFallbackReason,
      pgCanonicalContractVersion,
      postgresSelectionAttrs,
    );
    recordInboxServingRowsRead(pageRows, {
      receiverType: "user",
      receiverId: userId,
      filter,
      limit,
      offset,
    });
    // PG serving-rows path: the read-cursor triple AND the union frontier
    // pair come from the SINGLE authority read (identical union to the
    // list/unread exits); the serving query's own activity pair stays as the
    // display pair only. The authority read runs on the SAME executor as the
    // serving query — a global-getDb() read would miss the caller's
    // transaction snapshot and deadlock single-connection drivers.
    await enrichInboxRowsWithReadCursorAuthority(pageRows, userId, traceQuery, db);
    const items = await attachReadStateToInboxItems(
      mapInboxPolicyRowsToItems(pageRows, logInboxScopeCorruption, "authority") as InboxItem[],
      userId,
      db,
    );
    const authoritativeResult: InboxItemsResult = {
      items,
      groups: readInboxGroupCounts(servingResult.rows),
      hasMore: page.hasMore,
      totalCount: page.totalCount,
      totalUnreadCount: page.totalUnreadCount,
      activeUnreadCount: selectInboxPolicyActiveUnreadCount(
        servingResult.rows as InboxPolicySqlRow[],
        page.totalUnreadCount,
      ),
    };
    if (rfc056ServingMode === "shadow") {
      await observeRfc056ShadowComparison(
        filter,
        risingWaveShadowResult,
        authoritativeResult,
        limit,
        traceQuery,
        db,
      );
    }
    return authoritativeResult;
  }

  const legacyActivityChannelFilterPredicate = channelId
    ? sql`AND CASE
        WHEN activity."kind" = 'thread' THEN activity."parentChannelId"
        ELSE activity."sourceChannelId"
      END = ${channelId}::uuid`
    : sql``;
  const legacyCombinedChannelFilterPredicate = channelId
    ? sql`AND CASE
        WHEN combined."kind" = 'thread' THEN combined."parentChannelId"
        ELSE combined."channelId"
      END = ${channelId}`
    : sql``;
  const legacySearchPattern = q ? `%${q}%` : null;
  const legacyActivitySearchPredicate = legacySearchPattern
    ? sql`AND (
        COALESCE(activity."channelName", '') ILIKE ${legacySearchPattern}
        OR COALESCE(activity."parentChannelName", '') ILIKE ${legacySearchPattern}
        OR COALESCE(activity."parentMessagePreview", '') ILIKE ${legacySearchPattern}
        OR EXISTS (
          SELECT 1
          FROM messages search_message
          LEFT JOIN users search_user
            ON search_message.sender_type = 'user'
           AND search_user.id::text = search_message.sender_id
          LEFT JOIN agents search_agent
            ON search_message.sender_type = 'agent'
           AND search_agent.id::text = search_message.sender_id
          WHERE search_message.channel_id = activity."storageChannelId"
            AND (
              search_message.content ILIKE ${legacySearchPattern}
              OR COALESCE(search_user.display_name, search_user.name, search_agent.display_name, search_agent.name, '') ILIKE ${legacySearchPattern}
            )
        )
      )`
    : sql``;
  const legacyCombinedSearchPredicate = legacySearchPattern
    ? sql`AND (
        COALESCE(combined."channelName", '') ILIKE ${legacySearchPattern}
        OR COALESCE(combined."parentChannelName", '') ILIKE ${legacySearchPattern}
        OR COALESCE(combined."lastMessagePreview", '') ILIKE ${legacySearchPattern}
        OR COALESCE(combined."parentMessagePreview", '') ILIKE ${legacySearchPattern}
        OR COALESCE(combined."latestActivityPreview", '') ILIKE ${legacySearchPattern}
        OR COALESCE(combined."lastMessageSenderName", '') ILIKE ${legacySearchPattern}
        OR COALESCE(combined."taskClaimedByName", '') ILIKE ${legacySearchPattern}
      )`
    : sql``;

  const readLegacyInboxItemsFromPostgres = () =>
    filter === "all"
      ? traceQuery(
          "channels.inbox_items_by_user",
          () =>
            db.execute(sql`
    -- Canonical no-env Inbox behavior lives in this inline Postgres SQL.
    -- If you change selected fields, filters, unread/mention semantics,
    -- ordering, pagination, or totals here, update rw_inbox_items_v2 in
    -- infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql and rerun
    -- pnpm --filter @botiverse/raft-server risingwave:verify-inbox-parity.
    WITH eligible_chats AS (
      SELECT
        c.id,
        c.name,
        c.type,
        COALESCE(joint_storage.canonical_channel_id, c.id) AS storage_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        ${humanMuteFromSeqSelect} AS mute_from_seq
      FROM channels c
      INNER JOIN channel_humans ch
        ON ch.channel_id = c.id
       AND ch.user_id = ${userId}
      LEFT JOIN joint_channel_servers joint_projection
        ON joint_projection.local_channel_id = c.id
       AND joint_projection.server_id = c.server_id
       AND joint_projection.status = 'active'
      LEFT JOIN joint_channels joint_storage
        ON joint_storage.id = joint_projection.joint_channel_id
       AND joint_storage.status = 'active'
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id
       AND rc.user_id = ${userId}
      LEFT JOIN user_channel_inbox_states inbox
        ON inbox.channel_id = c.id
       AND inbox.user_id = ${userId}
      ${humanMuteStateJoinSql}
      WHERE c.server_id = ${serverId}
        AND ${guestInboxAccessSql(guestAccess, sql`c.id`)}
        AND c.type IN ('channel', 'private', 'joint', 'dm')
        AND c.deleted_at IS NULL
        AND c.archived_at IS NULL
        AND inbox.done_at IS NULL
    ),
    followed_threads AS (
      SELECT
        t.id AS source_channel_id,
        COALESCE(canonical_thread.id, t.id) AS storage_channel_id,
        COALESCE(canonical_thread.parent_message_id, t.parent_message_id) AS parent_message_id,
        COALESCE(local_parent.id, pm.channel_id) AS parent_channel_id,
        COALESCE(local_parent.name, parent_ch.name) AS parent_channel_name,
        COALESCE(local_parent.type::text, parent_ch.type::text) AS parent_channel_type,
        pm.content AS parent_message_preview,
        pm.sender_type AS parent_message_sender_type,
        pm.sender_id AS parent_message_sender_id,
        pm.created_at AS parent_message_created_at,
        pm.seq AS parent_message_seq,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq
      FROM thread_follows tf
      INNER JOIN channels t
        ON t.id = tf.thread_channel_id
       AND t.type = 'thread'
       AND t.server_id = ${serverId}
       AND t.deleted_at IS NULL
      LEFT JOIN joint_channel_servers thread_projection
        ON thread_projection.local_channel_id = t.id
       AND thread_projection.server_id = ${serverId}
       AND thread_projection.status = 'active'
      LEFT JOIN joint_channels thread_joint
        ON thread_joint.id = thread_projection.joint_channel_id
       AND thread_joint.status = 'active'
      LEFT JOIN channels canonical_thread
        ON canonical_thread.id = thread_joint.canonical_channel_id
       AND canonical_thread.type = 'thread'
       AND canonical_thread.deleted_at IS NULL
      INNER JOIN messages pm
        ON pm.id = COALESCE(canonical_thread.parent_message_id, t.parent_message_id)
      INNER JOIN channels parent_ch
        ON parent_ch.id = pm.channel_id
       AND parent_ch.archived_at IS NULL
      LEFT JOIN joint_channels parent_joint
        ON parent_joint.canonical_channel_id = pm.channel_id
       AND parent_joint.status = 'active'
      LEFT JOIN joint_channel_servers parent_projection
        ON parent_projection.joint_channel_id = parent_joint.id
       AND parent_projection.server_id = ${serverId}
       AND parent_projection.status = 'active'
      LEFT JOIN channels local_parent
        ON local_parent.id = parent_projection.local_channel_id
       AND local_parent.type = 'joint'
       AND local_parent.archived_at IS NULL
       AND local_parent.deleted_at IS NULL
      LEFT JOIN channel_humans parent_member
        ON parent_member.channel_id = COALESCE(local_parent.id, parent_ch.id)
       AND parent_member.user_id = ${userId}
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = t.id
       AND rc.user_id = ${userId}
        WHERE ${guestInboxAccessSql(guestAccess, sql`COALESCE(local_parent.id, parent_ch.id)`)}
        AND tf.follower_type = 'user'
          AND tf.follower_id = ${userId}
          AND tf.done_at IS NULL
          AND tf.unfollowed_at IS NULL
          AND (COALESCE(local_parent.type::text, parent_ch.type::text) = 'channel' OR parent_member.user_id IS NOT NULL)
    ),
    activity AS MATERIALIZED (
      SELECT
        CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS "kind",
        c.id AS "sourceChannelId",
        c.storage_channel_id AS "storageChannelId",
        c.name AS "channelName",
        c.type::text AS "channelType",
        NULL::uuid AS "parentMessageId",
        NULL::uuid AS "parentChannelId",
        NULL::text AS "parentChannelName",
        NULL::text AS "parentChannelType",
        NULL::text AS "parentMessagePreview",
        NULL::text AS "parentMessageSenderType",
        NULL::text AS "parentMessageSenderId",
        NULL::timestamptz AS "parentMessageCreatedAt",
        NULL::bigint AS "parentMessageSeq",
        c.last_read_seq AS "lastReadSeq",
        c.mute_from_seq AS "muteFromSeq",
        lm.created_at AS "activityAt"
      FROM eligible_chats c
      INNER JOIN LATERAL (
        SELECT m.created_at
        FROM messages m
        WHERE m.channel_id = c.storage_channel_id
          AND ${legacyChatActivityPromotionAllowedSql(userId, sql`c.mute_from_seq`)}
        ORDER BY m.seq DESC
        LIMIT 1
      ) lm ON true
      UNION ALL
      SELECT
        'thread' AS "kind",
        t.source_channel_id AS "sourceChannelId",
        t.storage_channel_id AS "storageChannelId",
        NULL::text AS "channelName",
        NULL::text AS "channelType",
        t.parent_message_id AS "parentMessageId",
        t.parent_channel_id AS "parentChannelId",
        t.parent_channel_name AS "parentChannelName",
        t.parent_channel_type AS "parentChannelType",
        t.parent_message_preview AS "parentMessagePreview",
        t.parent_message_sender_type AS "parentMessageSenderType",
        t.parent_message_sender_id AS "parentMessageSenderId",
        t.parent_message_created_at AS "parentMessageCreatedAt",
        t.parent_message_seq AS "parentMessageSeq",
        t.last_read_seq AS "lastReadSeq",
        NULL::bigint AS "muteFromSeq",
        COALESCE(latest_reply.created_at, t.parent_message_created_at) AS "activityAt"
      FROM followed_threads t
      LEFT JOIN LATERAL (
        SELECT m.created_at
        FROM messages m
        WHERE m.channel_id = t.storage_channel_id
        ORDER BY m.seq DESC
        LIMIT 1
      ) latest_reply ON true
    ),
    filtered_activity AS (
      SELECT *
      FROM activity
      WHERE true
      ${legacyActivitySearchPredicate}
    ),
    group_counts AS (
      SELECT
        CASE WHEN "kind" = 'thread' THEN "parentChannelId" ELSE "sourceChannelId" END AS "groupChannelId",
        CASE WHEN "kind" = 'thread' THEN "parentChannelName" ELSE "channelName" END AS "groupChannelName",
        CASE WHEN "kind" = 'thread' THEN "parentChannelType" ELSE "channelType" END AS "groupChannelType",
        count(*)::int AS "groupCount",
        MAX("activityAt") AS "groupLastActivityAt"
      FROM filtered_activity
      GROUP BY
        CASE WHEN "kind" = 'thread' THEN "parentChannelId" ELSE "sourceChannelId" END,
        CASE WHEN "kind" = 'thread' THEN "parentChannelName" ELSE "channelName" END,
        CASE WHEN "kind" = 'thread' THEN "parentChannelType" ELSE "channelType" END
    ),
    group_totals AS (
      SELECT
        array_agg("groupChannelId"::text ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelIds",
        array_agg("groupChannelName" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelNames",
        array_agg("groupChannelType" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelTypes",
        array_agg("groupCount" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupCounts",
        array_agg("groupLastActivityAt"::text ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupLastActivityAts"
      FROM group_counts
    ),
    selected_activity AS (
      SELECT *
      FROM filtered_activity activity
      WHERE true
      ${legacyActivityChannelFilterPredicate}
    ),
    totals AS (
      SELECT count(*)::int AS "totalCount"
      FROM selected_activity
    ),
    unread_totals AS (
      SELECT count(m.id)::int AS "totalUnreadCount"
      FROM selected_activity a
      INNER JOIN messages m
        ON m.channel_id = a."storageChannelId"
       AND m.seq > a."lastReadSeq"
       AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
    ),
    page AS (
      SELECT *
      FROM selected_activity
      ORDER BY "activityAt" ${sortDirection}, "kind" ${sortDirection}, "sourceChannelId" ${sortDirection}
      LIMIT ${limit + 1}
      OFFSET ${offset}
    ),
    page_enriched AS (
      SELECT
        p."kind",
        CASE WHEN p."kind" = 'thread' THEN NULL::text ELSE p."sourceChannelId"::text END AS "channelId",
        p."channelName",
        p."channelType",
        latest_message.id::text AS "lastMessageId",
        first_unread.id::text AS "firstUnreadMessageId",
        to_char((latest_message.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastMessageAt",
        latest_message.content AS "lastMessagePreview",
        latest_message.sender_type AS "lastMessageSenderType",
        latest_message.sender_id AS "lastMessageSenderId",
        COALESCE(su.display_name, su.name, sa.display_name, sa.name) AS "lastMessageSenderName",
        COALESCE(unread.unread_count, 0)::int AS "unreadCount",
        CASE WHEN p."kind" = 'thread' THEN p."sourceChannelId"::text ELSE NULL::text END AS "threadChannelId",
        p."parentMessageId"::text AS "parentMessageId",
        p."parentChannelId"::text AS "parentChannelId",
        p."parentChannelName",
        p."parentChannelType",
        p."parentMessagePreview",
        p."parentMessageSenderType",
        p."parentMessageSenderId",
        COALESCE(latest_message.content, p."parentMessagePreview") AS "latestActivityPreview",
        COALESCE(latest_message.sender_type, p."parentMessageSenderType") AS "latestActivitySenderType",
        COALESCE(latest_message.sender_id, p."parentMessageSenderId") AS "latestActivitySenderId",
        COALESCE(latest_message.id, p."parentMessageId")::text AS "latestActivityMessageId",
        COALESCE(latest_message.seq, p."parentMessageSeq")::text AS "latestActivitySeq",
        to_char((COALESCE(latest_message.created_at, p."parentMessageCreatedAt")) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastActivityAt",
        CASE WHEN p."kind" = 'thread' THEN to_char((latest_message.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' ELSE NULL::text END AS "lastReplyAt",
        CASE WHEN p."kind" = 'thread' THEN COALESCE(reply_count.reply_count, 0)::int ELSE NULL::int END AS "replyCount",
        legacy_task.task_number AS "taskNumber",
        legacy_task.status AS "taskStatus",
        COALESCE(claimant_user.display_name, claimant_user.name, claimant_agent.display_name, claimant_agent.name) AS "taskClaimedByName",
        COALESCE(has_mention.found, false) AS "hasMention",
        has_mention.first_mention_message_id::text AS "firstMentionMessageId",
        p."activityAt"
      FROM page p
      LEFT JOIN LATERAL (
        SELECT m.id, m.content, m.sender_type, m.sender_id, m.created_at, m.seq
        FROM messages m
        WHERE m.channel_id = p."storageChannelId"
          AND ${legacyChatActivityPromotionAllowedSql(userId, sql`p."muteFromSeq"`)}
        ORDER BY m.seq DESC
        LIMIT 1
      ) latest_message ON true
      LEFT JOIN LATERAL (
        SELECT m.id
        FROM messages m
        WHERE m.channel_id = p."storageChannelId"
          AND m.seq > p."lastReadSeq"
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
        ORDER BY m.seq ASC
        LIMIT 1
      ) first_unread ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS unread_count
        FROM messages m
        WHERE m.channel_id = p."storageChannelId"
          AND m.seq > p."lastReadSeq"
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
      ) unread ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS reply_count
        FROM messages m
        WHERE p."kind" = 'thread'
          AND m.channel_id = p."storageChannelId"
      ) reply_count ON true
      LEFT JOIN LATERAL (
        SELECT true AS found, mm.message_id AS first_mention_message_id
        FROM message_mentions mm
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
          AND (
            mm.channel_id = p."sourceChannelId"
            OR EXISTS (
              SELECT 1
              FROM joint_channel_servers base_projection
              INNER JOIN joint_channel_servers sibling_projection
                ON sibling_projection.joint_channel_id = base_projection.joint_channel_id
               AND sibling_projection.status = 'active'
              WHERE base_projection.local_channel_id = p."sourceChannelId"
                AND base_projection.status = 'active'
                AND sibling_projection.local_channel_id = mm.channel_id
            )
          )
          AND mm.message_seq > p."lastReadSeq"
        ORDER BY mm.message_seq ASC
        LIMIT 1
      ) has_mention ON true
      LEFT JOIN tasks legacy_task
        ON legacy_task.message_id = p."parentMessageId"
      LEFT JOIN agents claimant_agent
        ON legacy_task.claimed_by_type = 'agent'
       AND claimant_agent.id::text = legacy_task.claimed_by_id
      LEFT JOIN users claimant_user
        ON legacy_task.claimed_by_type = 'user'
       AND claimant_user.id::text = legacy_task.claimed_by_id
      LEFT JOIN users su
        ON latest_message.sender_type = 'user'
       AND su.id::text = latest_message.sender_id
      LEFT JOIN agents sa
        ON latest_message.sender_type = 'agent'
       AND sa.id::text = latest_message.sender_id
    )
    SELECT
      page_enriched.*,
      totals."totalCount",
      unread_totals."totalUnreadCount",
      unread_totals."totalUnreadCount" AS "activeUnreadCount",
      group_totals."groupChannelIds",
      group_totals."groupChannelNames",
      group_totals."groupChannelTypes",
      group_totals."groupCounts",
      group_totals."groupLastActivityAts"
    FROM totals
    CROSS JOIN unread_totals
    CROSS JOIN group_totals
    LEFT JOIN page_enriched ON true
    ORDER BY page_enriched."activityAt" ${sortDirection} NULLS LAST,
      page_enriched."kind" ${sortDirection},
      COALESCE(page_enriched."threadChannelId", page_enriched."channelId") ${sortDirection}
  `),
          (queryResult) => ({
            ...inboxTraceAttrs(
              "pg_legacy",
              filter,
              pgCanonicalFallbackReason,
              pgCanonicalContractVersion,
            ),
            ...postgresSelectionAttrs,
            filter,
            limit,
            offset,
            history_cutoff_present: false,
            row_count: queryResult.rows.length,
            channel_id_present: Boolean(channelId),
            query_present: Boolean(q),
            human_activity_mute_enabled: humanActivityMuteEnabled,
            mute_state_join_present: humanActivityMuteEnabled,
          }),
        )
      : traceQuery(
          "channels.inbox_items_by_user",
          () =>
            db.execute(sql`
    -- Canonical no-env Inbox behavior lives in this inline Postgres SQL.
    -- If you change selected fields, filters, unread/mention semantics,
    -- ordering, pagination, or totals here, update rw_inbox_items_v2 in
    -- infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql and rerun
    -- pnpm --filter @botiverse/raft-server risingwave:verify-inbox-parity.
    WITH eligible_chats AS (
      SELECT
        c.id,
        c.name,
        c.type,
        COALESCE(joint_storage.canonical_channel_id, c.id) AS storage_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        ${humanMuteFromSeqSelect} AS mute_from_seq
      FROM channels c
      INNER JOIN channel_humans ch
        ON ch.channel_id = c.id
       AND ch.user_id = ${userId}
      LEFT JOIN joint_channel_servers joint_projection
        ON joint_projection.local_channel_id = c.id
       AND joint_projection.server_id = c.server_id
       AND joint_projection.status = 'active'
      LEFT JOIN joint_channels joint_storage
        ON joint_storage.id = joint_projection.joint_channel_id
       AND joint_storage.status = 'active'
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id
       AND rc.user_id = ${userId}
      LEFT JOIN user_channel_inbox_states inbox
        ON inbox.channel_id = c.id
       AND inbox.user_id = ${userId}
      ${humanMuteStateJoinSql}
      WHERE c.server_id = ${serverId}
        AND ${guestInboxAccessSql(guestAccess, sql`c.id`)}
        AND c.type IN ('channel', 'private', 'joint', 'dm')
        AND c.deleted_at IS NULL
        AND c.archived_at IS NULL
        AND inbox.done_at IS NULL
    ),
    notified_public_mentions AS (
      SELECT
        c.id,
        c.name,
        c.type,
        c.id AS storage_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        m.id AS latest_mention_message_id,
        m.seq AS latest_mention_seq,
        m.created_at AS latest_mention_created_at,
        m.content AS latest_mention_preview,
        m.sender_type AS latest_mention_sender_type,
        m.sender_id AS latest_mention_sender_id
      FROM (
        SELECT
          mm.channel_id,
          max(mm.message_seq) AS latest_mention_seq
        FROM message_mentions mm
        INNER JOIN channels mention_channel
          ON mention_channel.id = mm.channel_id
        LEFT JOIN channel_humans existing_member
          ON existing_member.channel_id = mm.channel_id
         AND existing_member.user_id = ${userId}
        LEFT JOIN user_channel_inbox_states inbox
          ON inbox.channel_id = mm.channel_id
         AND inbox.user_id = ${userId}
        LEFT JOIN inbox_suppression_states mention_suppression
          ON mention_suppression.receiver_type = 'user'
         AND mention_suppression.receiver_id = ${userId}::uuid
         AND mention_suppression.target_kind = 'public_channel_mention'
         AND mention_suppression.target_channel_id = mm.channel_id
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND mm.notified_at IS NOT NULL
          AND mm.message_seq > COALESCE(mention_suppression.done_through_seq, 0)
          AND mention_channel.server_id = ${serverId}
          AND ${guestInboxAccessSql(guestAccess, sql`mention_channel.id`)}
          AND mention_channel.type = 'channel'
          AND mention_channel.deleted_at IS NULL
          AND mention_channel.archived_at IS NULL
          AND existing_member.user_id IS NULL
          AND inbox.done_at IS NULL
        GROUP BY mm.channel_id
      ) latest_mention
      INNER JOIN channels c
        ON c.id = latest_mention.channel_id
      INNER JOIN messages m
        ON m.channel_id = latest_mention.channel_id
       AND m.seq = latest_mention.latest_mention_seq
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id
       AND rc.user_id = ${userId}
    ),
    notified_public_thread_mentions AS (
      SELECT
        t.id AS source_channel_id,
        t.id AS storage_channel_id,
        t.parent_message_id,
        parent_ch.id AS parent_channel_id,
        parent_ch.name AS parent_channel_name,
        parent_ch.type::text AS parent_channel_type,
        pm.content AS parent_message_preview,
        pm.sender_type AS parent_message_sender_type,
        pm.sender_id AS parent_message_sender_id,
        pm.created_at AS parent_message_created_at,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        m.id AS latest_mention_message_id,
        m.seq AS latest_mention_seq,
        m.created_at AS latest_mention_created_at,
        m.content AS latest_mention_preview,
        m.sender_type AS latest_mention_sender_type,
        m.sender_id AS latest_mention_sender_id
      FROM (
        SELECT
          mm.channel_id,
          max(mm.message_seq) AS latest_mention_seq
        FROM message_mentions mm
        INNER JOIN channels thread_channel
          ON thread_channel.id = mm.channel_id
        INNER JOIN messages parent_message
          ON parent_message.id = thread_channel.parent_message_id
        INNER JOIN channels parent_channel
          ON parent_channel.id = parent_message.channel_id
        LEFT JOIN thread_follows existing_follow
          ON existing_follow.thread_channel_id = mm.channel_id
         AND existing_follow.follower_type = 'user'
         AND existing_follow.follower_id = ${userId}
         AND existing_follow.done_at IS NULL
         AND existing_follow.unfollowed_at IS NULL
        LEFT JOIN inbox_suppression_states mention_suppression
          ON mention_suppression.receiver_type = 'user'
         AND mention_suppression.receiver_id = ${userId}::uuid
         AND mention_suppression.target_kind = 'public_thread_mention'
         AND mention_suppression.target_channel_id = mm.channel_id
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND mm.notified_at IS NOT NULL
          AND mm.message_seq > COALESCE(mention_suppression.done_through_seq, 0)
          AND thread_channel.server_id = ${serverId}
          AND thread_channel.type = 'thread'
          AND thread_channel.deleted_at IS NULL
          AND parent_channel.type = 'channel'
          AND ${guestInboxAccessSql(guestAccess, sql`parent_channel.id`)}
          AND parent_channel.archived_at IS NULL
          AND parent_channel.deleted_at IS NULL
          AND existing_follow.thread_channel_id IS NULL
        GROUP BY mm.channel_id
      ) latest_mention
      INNER JOIN channels t
        ON t.id = latest_mention.channel_id
      INNER JOIN messages pm
        ON pm.id = t.parent_message_id
      INNER JOIN channels parent_ch
        ON parent_ch.id = pm.channel_id
      INNER JOIN messages m
        ON m.channel_id = latest_mention.channel_id
       AND m.seq = latest_mention.latest_mention_seq
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = t.id
       AND rc.user_id = ${userId}
    ),
    followed_threads AS (
      SELECT
        t.id AS source_channel_id,
        COALESCE(canonical_thread.id, t.id) AS storage_channel_id,
        COALESCE(canonical_thread.parent_message_id, t.parent_message_id) AS parent_message_id,
        COALESCE(local_parent.id, pm.channel_id) AS parent_channel_id,
        COALESCE(local_parent.name, parent_ch.name) AS parent_channel_name,
        COALESCE(local_parent.type::text, parent_ch.type::text) AS parent_channel_type,
        pm.content AS parent_message_preview,
        pm.sender_type AS parent_message_sender_type,
        pm.sender_id AS parent_message_sender_id,
        pm.created_at AS parent_message_created_at,
        pm.seq AS parent_message_seq,
        legacy_task.task_number AS task_number,
        legacy_task.status AS task_status,
        legacy_task.claimed_by_type AS task_claimed_by_type,
        legacy_task.claimed_by_id AS task_claimed_by_id
      FROM thread_follows tf
      INNER JOIN channels t
        ON t.id = tf.thread_channel_id
       AND t.type = 'thread'
       AND t.server_id = ${serverId}
       AND t.deleted_at IS NULL
      LEFT JOIN joint_channel_servers thread_projection
        ON thread_projection.local_channel_id = t.id
       AND thread_projection.server_id = ${serverId}
       AND thread_projection.status = 'active'
      LEFT JOIN joint_channels thread_joint
        ON thread_joint.id = thread_projection.joint_channel_id
       AND thread_joint.status = 'active'
      LEFT JOIN channels canonical_thread
        ON canonical_thread.id = thread_joint.canonical_channel_id
       AND canonical_thread.type = 'thread'
       AND canonical_thread.deleted_at IS NULL
      INNER JOIN messages pm
        ON pm.id = COALESCE(canonical_thread.parent_message_id, t.parent_message_id)
      INNER JOIN channels parent_ch
        ON parent_ch.id = pm.channel_id
       AND parent_ch.archived_at IS NULL
      LEFT JOIN joint_channels parent_joint
        ON parent_joint.canonical_channel_id = pm.channel_id
       AND parent_joint.status = 'active'
      LEFT JOIN joint_channel_servers parent_projection
        ON parent_projection.joint_channel_id = parent_joint.id
       AND parent_projection.server_id = ${serverId}
       AND parent_projection.status = 'active'
      LEFT JOIN channels local_parent
        ON local_parent.id = parent_projection.local_channel_id
       AND local_parent.type = 'joint'
       AND local_parent.archived_at IS NULL
       AND local_parent.deleted_at IS NULL
      LEFT JOIN channel_humans parent_member
        ON parent_member.channel_id = COALESCE(local_parent.id, parent_ch.id)
       AND parent_member.user_id = ${userId}
      LEFT JOIN tasks legacy_task
        ON legacy_task.message_id = pm.id
      WHERE ${guestInboxAccessSql(guestAccess, sql`COALESCE(local_parent.id, parent_ch.id)`)}
        AND tf.follower_type = 'user'
        AND tf.follower_id = ${userId}
        AND tf.done_at IS NULL
        AND tf.unfollowed_at IS NULL
        AND (COALESCE(local_parent.type::text, parent_ch.type::text) = 'channel' OR parent_member.user_id IS NOT NULL)
    ),
    chat_items AS (
      SELECT
        CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS "kind",
        c.id::text AS "channelId",
        c.name AS "channelName",
        c.type::text AS "channelType",
        lm.id::text AS "lastMessageId",
        first_unread.id::text AS "firstUnreadMessageId",
        to_char((lm.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastMessageAt",
        lm.content AS "lastMessagePreview",
        lm.sender_type AS "lastMessageSenderType",
        lm.sender_id AS "lastMessageSenderId",
        COALESCE(su.display_name, su.name, sa.display_name, sa.name) AS "lastMessageSenderName",
        COALESCE(unread.unread_count, 0)::int AS "unreadCount",
        NULL::text AS "threadChannelId",
        NULL::text AS "parentMessageId",
        NULL::text AS "parentChannelId",
        NULL::text AS "parentChannelName",
        NULL::text AS "parentChannelType",
        NULL::text AS "parentMessagePreview",
        NULL::text AS "parentMessageSenderType",
        NULL::text AS "parentMessageSenderId",
        NULL::text AS "latestActivityPreview",
        NULL::text AS "latestActivitySenderType",
        NULL::text AS "latestActivitySenderId",
        NULL::text AS "latestActivityMessageId",
        lm.seq::text AS "latestActivitySeq",
        NULL::text AS "lastActivityAt",
        NULL::text AS "lastReplyAt",
        NULL::int AS "replyCount",
        NULL::int AS "taskNumber",
        NULL::text AS "taskStatus",
        NULL::text AS "taskClaimedByName",
        COALESCE(has_mention.found, false) AS "hasMention",
        has_mention.first_mention_message_id::text AS "firstMentionMessageId",
        COALESCE(has_mention.found, false) AS "hasAnyMention",
        false AS "mentionOnly",
        c.id::text AS "mentionSourceChannelId",
        lm.created_at AS "activityAt"
      FROM eligible_chats c
      INNER JOIN LATERAL (
        SELECT m.id, m.content, m.sender_type, m.sender_id, m.created_at, m.seq
        FROM messages m
        WHERE m.channel_id = c.storage_channel_id
          AND ${legacyChatActivityPromotionAllowedSql(userId, sql`c.mute_from_seq`)}
        ORDER BY m.seq DESC
        LIMIT 1
      ) lm ON true
      LEFT JOIN LATERAL (
        SELECT m.id
        FROM messages m
        WHERE m.channel_id = c.storage_channel_id
          AND m.seq > c.last_read_seq
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
        ORDER BY m.seq ASC
        LIMIT 1
      ) first_unread ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS unread_count
        FROM messages m
        WHERE m.channel_id = c.storage_channel_id
          AND m.seq > c.last_read_seq
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
      ) unread ON true
      LEFT JOIN LATERAL (
        SELECT true AS found, mm.message_id AS first_mention_message_id
        FROM message_mentions mm
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
          AND (
            mm.channel_id = c.id
            OR EXISTS (
              SELECT 1
              FROM joint_channel_servers base_projection
              INNER JOIN joint_channel_servers sibling_projection
                ON sibling_projection.joint_channel_id = base_projection.joint_channel_id
               AND sibling_projection.status = 'active'
              WHERE base_projection.local_channel_id = c.id
                AND base_projection.status = 'active'
                AND sibling_projection.local_channel_id = mm.channel_id
            )
          )
          AND mm.message_seq > c.last_read_seq
        ORDER BY mm.message_seq ASC
        LIMIT 1
      ) has_mention ON true
      LEFT JOIN users su
        ON lm.sender_type = 'user'
       AND su.id::text = lm.sender_id
      LEFT JOIN agents sa
        ON lm.sender_type = 'agent'
       AND sa.id::text = lm.sender_id
    ),
    mention_items AS (
      SELECT
        'channel' AS "kind",
        c.id::text AS "channelId",
        c.name AS "channelName",
        c.type::text AS "channelType",
        c.latest_mention_message_id::text AS "lastMessageId",
        c.latest_mention_message_id::text AS "firstUnreadMessageId",
        to_char((c.latest_mention_created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastMessageAt",
        c.latest_mention_preview AS "lastMessagePreview",
        c.latest_mention_sender_type AS "lastMessageSenderType",
        c.latest_mention_sender_id AS "lastMessageSenderId",
        COALESCE(su.display_name, su.name, sa.display_name, sa.name) AS "lastMessageSenderName",
        0::int AS "unreadCount",
        NULL::text AS "threadChannelId",
        NULL::text AS "parentMessageId",
        NULL::text AS "parentChannelId",
        NULL::text AS "parentChannelName",
        NULL::text AS "parentChannelType",
        NULL::text AS "parentMessagePreview",
        NULL::text AS "parentMessageSenderType",
        NULL::text AS "parentMessageSenderId",
        NULL::text AS "latestActivityPreview",
        NULL::text AS "latestActivitySenderType",
        NULL::text AS "latestActivitySenderId",
        NULL::text AS "latestActivityMessageId",
        c.latest_mention_seq::text AS "latestActivitySeq",
        NULL::text AS "lastActivityAt",
        NULL::text AS "lastReplyAt",
        NULL::int AS "replyCount",
        NULL::int AS "taskNumber",
        NULL::text AS "taskStatus",
        NULL::text AS "taskClaimedByName",
        true AS "hasMention",
        c.latest_mention_message_id::text AS "firstMentionMessageId",
        true AS "hasAnyMention",
        true AS "mentionOnly",
        c.id::text AS "mentionSourceChannelId",
        c.latest_mention_created_at AS "activityAt"
      FROM notified_public_mentions c
      LEFT JOIN users su
        ON c.latest_mention_sender_type = 'user'
       AND su.id::text = c.latest_mention_sender_id
      LEFT JOIN agents sa
        ON c.latest_mention_sender_type = 'agent'
       AND sa.id::text = c.latest_mention_sender_id
    ),
    mention_thread_items AS (
      SELECT
        'thread' AS "kind",
        NULL::text AS "channelId",
        NULL::text AS "channelName",
        NULL::text AS "channelType",
        NULL::text AS "lastMessageId",
        c.latest_mention_message_id::text AS "firstUnreadMessageId",
        NULL::text AS "lastMessageAt",
        NULL::text AS "lastMessagePreview",
        NULL::text AS "lastMessageSenderType",
        NULL::text AS "lastMessageSenderId",
        NULL::text AS "lastMessageSenderName",
        0::int AS "unreadCount",
        c.source_channel_id::text AS "threadChannelId",
        c.parent_message_id::text AS "parentMessageId",
        c.parent_channel_id::text AS "parentChannelId",
        c.parent_channel_name AS "parentChannelName",
        c.parent_channel_type AS "parentChannelType",
        c.parent_message_preview AS "parentMessagePreview",
        c.parent_message_sender_type AS "parentMessageSenderType",
        c.parent_message_sender_id AS "parentMessageSenderId",
        c.latest_mention_preview AS "latestActivityPreview",
        c.latest_mention_sender_type AS "latestActivitySenderType",
        c.latest_mention_sender_id AS "latestActivitySenderId",
        c.latest_mention_message_id::text AS "latestActivityMessageId",
        c.latest_mention_seq::text AS "latestActivitySeq",
        to_char((c.latest_mention_created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastActivityAt",
        to_char((c.latest_mention_created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastReplyAt",
        0::int AS "replyCount",
        NULL::int AS "taskNumber",
        NULL::text AS "taskStatus",
        NULL::text AS "taskClaimedByName",
        true AS "hasMention",
        c.latest_mention_message_id::text AS "firstMentionMessageId",
        true AS "hasAnyMention",
        true AS "mentionOnly",
        c.source_channel_id::text AS "mentionSourceChannelId",
        c.latest_mention_created_at AS "activityAt"
      FROM notified_public_thread_mentions c
    ),
    thread_items AS (
      SELECT
        'thread' AS "kind",
        NULL::text AS "channelId",
        NULL::text AS "channelName",
        NULL::text AS "channelType",
        NULL::text AS "lastMessageId",
        first_unread.id::text AS "firstUnreadMessageId",
        NULL::text AS "lastMessageAt",
        NULL::text AS "lastMessagePreview",
        NULL::text AS "lastMessageSenderType",
        NULL::text AS "lastMessageSenderId",
        NULL::text AS "lastMessageSenderName",
        COALESCE(unread.unread_count, 0)::int AS "unreadCount",
        t.source_channel_id::text AS "threadChannelId",
        t.parent_message_id::text AS "parentMessageId",
        t.parent_channel_id::text AS "parentChannelId",
        t.parent_channel_name AS "parentChannelName",
        t.parent_channel_type AS "parentChannelType",
        t.parent_message_preview AS "parentMessagePreview",
        t.parent_message_sender_type AS "parentMessageSenderType",
        t.parent_message_sender_id AS "parentMessageSenderId",
        COALESCE(latest.latest_preview, t.parent_message_preview) AS "latestActivityPreview",
        COALESCE(latest.latest_sender_type, t.parent_message_sender_type) AS "latestActivitySenderType",
        COALESCE(latest.latest_sender_id, t.parent_message_sender_id) AS "latestActivitySenderId",
        COALESCE(latest.latest_message_id, t.parent_message_id)::text AS "latestActivityMessageId",
        COALESCE(latest.latest_message_seq, t.parent_message_seq)::text AS "latestActivitySeq",
        to_char((COALESCE(latest.last_reply_at, t.parent_message_created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastActivityAt",
        CASE WHEN latest.last_reply_at IS NULL THEN NULL::text ELSE to_char((latest.last_reply_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' END AS "lastReplyAt",
        COALESCE(stats.reply_count, 0)::int AS "replyCount",
        t.task_number AS "taskNumber",
        t.task_status AS "taskStatus",
        COALESCE(claimant_user.display_name, claimant_user.name, claimant_agent.display_name, claimant_agent.name) AS "taskClaimedByName",
        COALESCE(has_mention.found, false) AS "hasMention",
        has_mention.first_mention_message_id::text AS "firstMentionMessageId",
        COALESCE(has_mention.found, false) AS "hasAnyMention",
        false AS "mentionOnly",
        t.source_channel_id::text AS "mentionSourceChannelId",
        COALESCE(latest.last_reply_at, t.parent_message_created_at) AS "activityAt"
      FROM followed_threads t
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = t.source_channel_id
       AND rc.user_id = ${userId}
      LEFT JOIN LATERAL (
        SELECT
          count(*)::int AS reply_count
        FROM messages m
        WHERE m.channel_id = t.storage_channel_id
      ) stats ON true
      LEFT JOIN LATERAL (
        SELECT
          m.id AS latest_message_id,
          m.seq AS latest_message_seq,
          m.content AS latest_preview,
          m.sender_type AS latest_sender_type,
          m.sender_id AS latest_sender_id,
          m.created_at AS last_reply_at
        FROM messages m
        WHERE m.channel_id = t.storage_channel_id
        ORDER BY m.seq DESC
        LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT m.id
        FROM messages m
        WHERE m.channel_id = t.storage_channel_id
          AND m.seq > COALESCE(rc.last_read_seq, 0)
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
        ORDER BY m.seq ASC
        LIMIT 1
      ) first_unread ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS unread_count
        FROM messages m
        WHERE m.channel_id = t.storage_channel_id
          AND m.seq > COALESCE(rc.last_read_seq, 0)
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
      ) unread ON true
      LEFT JOIN LATERAL (
        SELECT true AS found, mm.message_id AS first_mention_message_id
        FROM message_mentions mm
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
          AND (
            mm.channel_id = t.source_channel_id
            OR EXISTS (
              SELECT 1
              FROM joint_channel_servers base_projection
              INNER JOIN joint_channel_servers sibling_projection
                ON sibling_projection.joint_channel_id = base_projection.joint_channel_id
               AND sibling_projection.status = 'active'
              WHERE base_projection.local_channel_id = t.source_channel_id
                AND base_projection.status = 'active'
                AND sibling_projection.local_channel_id = mm.channel_id
            )
          )
          AND mm.message_seq > COALESCE(rc.last_read_seq, 0)
        ORDER BY mm.message_seq ASC
        LIMIT 1
      ) has_mention ON true
      LEFT JOIN agents claimant_agent
        ON t.task_claimed_by_type = 'agent'
       AND claimant_agent.id::text = t.task_claimed_by_id
      LEFT JOIN users claimant_user
        ON t.task_claimed_by_type = 'user'
       AND claimant_user.id::text = t.task_claimed_by_id
    ),
    combined AS (
      SELECT * FROM chat_items
      UNION ALL
      SELECT * FROM mention_items
      UNION ALL
      SELECT * FROM mention_thread_items
      UNION ALL
      SELECT * FROM thread_items
    ),
    active_totals AS (
      SELECT COALESCE(sum("unreadCount"), 0)::int AS "activeUnreadCount"
      FROM combined
    ),
    filtered AS (
      -- Filter semantics:
      --   all      → every active inbox item (done_at IS NULL is enforced upstream
      --              via eligible_chats / thread_follows joins above).
      --   unread   → only items with unread messages.
      --   mentions → only items where the user has been @-mentioned in this
      --              channel/thread, regardless of read state. Plan A from
      --              #proj-uiux:6beb878c msg=691ade99 ("aggregated by
      --              thread/channel, includes read mentions").
      --   unread_mentions → unread items whose unread range contains an
      --              @-mention. This is the composed Activity v2
      --              Unread + Mentions state.
      --
      -- The existing per-row "hasMention" column is unread-scoped (used by the
      -- frontend @ badge — only shows when there's an unread mention). The
      -- mentions filter intentionally does NOT reuse that column: it runs an
      -- independent EXISTS against message_mentions so reading a mentioned
      -- message does not drop the row from the Mentions tab.
      SELECT *
      FROM combined
      WHERE true
        ${legacyCombinedSearchPredicate}
        AND (
          ${filter} = 'all'
          OR (${filter} = 'unread' AND "unreadCount" > 0)
          OR (${filter} = 'unread_mentions' AND "unreadCount" > 0 AND "hasMention" = true)
          OR (${filter} = 'mentions' AND EXISTS (
          SELECT 1 FROM message_mentions mm
          WHERE mm.target_type = 'user'
            AND mm.target_id = ${userId}::uuid
            AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
            AND (
              mm.channel_id::text = combined."mentionSourceChannelId"
              OR EXISTS (
                SELECT 1
                FROM joint_channel_servers base_projection
                INNER JOIN joint_channel_servers sibling_projection
                  ON sibling_projection.joint_channel_id = base_projection.joint_channel_id
                 AND sibling_projection.status = 'active'
                WHERE base_projection.local_channel_id::text = combined."mentionSourceChannelId"
                  AND base_projection.status = 'active'
                  AND sibling_projection.local_channel_id = mm.channel_id
              )
            )
        ))
        )
    ),
    group_counts AS (
      SELECT
        CASE WHEN "kind" = 'thread' THEN "parentChannelId" ELSE "channelId" END AS "groupChannelId",
        CASE WHEN "kind" = 'thread' THEN "parentChannelName" ELSE "channelName" END AS "groupChannelName",
        CASE WHEN "kind" = 'thread' THEN "parentChannelType" ELSE "channelType" END AS "groupChannelType",
        count(*)::int AS "groupCount",
        MAX("activityAt") AS "groupLastActivityAt"
      FROM filtered
      GROUP BY
        CASE WHEN "kind" = 'thread' THEN "parentChannelId" ELSE "channelId" END,
        CASE WHEN "kind" = 'thread' THEN "parentChannelName" ELSE "channelName" END,
        CASE WHEN "kind" = 'thread' THEN "parentChannelType" ELSE "channelType" END
    ),
    group_totals AS (
      SELECT
        array_agg("groupChannelId" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelIds",
        array_agg("groupChannelName" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelNames",
        array_agg("groupChannelType" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelTypes",
        array_agg("groupCount" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupCounts",
        array_agg("groupLastActivityAt"::text ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupLastActivityAts"
      FROM group_counts
    ),
    selected AS (
      SELECT *
      FROM filtered combined
      WHERE true
      ${legacyCombinedChannelFilterPredicate}
    ),
    totals AS (
      SELECT
        count(*)::int AS "totalCount",
        COALESCE(sum("unreadCount"), 0)::int AS "totalUnreadCount"
      FROM selected
    ),
    page AS (
      SELECT *
      FROM selected
      ORDER BY "activityAt" ${sortDirection},
        "kind" ${sortDirection},
        COALESCE("threadChannelId", "channelId") ${sortDirection}
      LIMIT ${limit + 1}
      OFFSET ${offset}
    )
    SELECT
      page.*,
      totals."totalCount",
      totals."totalUnreadCount",
      active_totals."activeUnreadCount",
      group_totals."groupChannelIds",
      group_totals."groupChannelNames",
      group_totals."groupChannelTypes",
      group_totals."groupCounts",
      group_totals."groupLastActivityAts"
    FROM totals
    CROSS JOIN active_totals
    CROSS JOIN group_totals
    LEFT JOIN page ON true
    ORDER BY page."activityAt" ${sortDirection} NULLS LAST,
      page."kind" ${sortDirection},
      COALESCE(page."threadChannelId", page."channelId") ${sortDirection}
  `),
          (queryResult) => ({
            ...inboxTraceAttrs(
              "pg_legacy",
              filter,
              pgCanonicalFallbackReason,
              pgCanonicalContractVersion,
            ),
            ...postgresSelectionAttrs,
            filter,
            limit,
            offset,
            history_cutoff_present: false,
            row_count: queryResult.rows.length,
            channel_id_present: Boolean(channelId),
            query_present: Boolean(q),
            human_activity_mute_enabled: humanActivityMuteEnabled,
            mute_state_join_present: humanActivityMuteEnabled,
          }),
        );
  const result =
    risingWaveResult ??
    (await withRisingWaveInboxFallbackTrace(
      filter,
      "channels.inbox_items_by_user",
      risingWaveAttempt,
      readLegacyInboxItemsFromPostgres,
    ));

  const rawRows = result.rows as InboxPolicySqlRow[];
  const page = selectInboxPolicyPageRows(rawRows, limit);
  const pageRows = page.rows as any[];

  await enrichInboxRowsWithProfileNames(pageRows, traceQuery, db);
  recordInboxBackendSelected(
    selection.backend,
    filter,
    selection.fallbackReason,
    selection.contractVersion,
    selection.backend === "pg_legacy" ? postgresSelectionAttrs : {},
  );
  if (selection.backend !== "rw_mv") {
    // PG canonical path: the read-cursor triple AND the union frontier pair
    // come from the SINGLE authority read (identical union to the list/unread
    // exits); RW rows carry their own cursor_v2 fields and skip this to
    // preserve the offload. The authority read runs on the SAME executor as
    // the rest of the flow — required when the caller is inside a
    // transaction (activity-sync authority tx), both for snapshot
    // consistency and to avoid single-connection (pglite) deadlock.
    await enrichInboxRowsWithReadCursorAuthority(pageRows, userId, traceQuery, db);
  }
  const frontierSource = selection.backend === "rw_mv" ? "servingPair" : "authority";
  const mappedItems = mapInboxPolicyRowsToItems(pageRows, logInboxScopeCorruption, frontierSource) as InboxItem[];
  const items = selection.backend === "rw_mv"
    ? attachRisingWaveReadStateToInboxItems(mappedItems, pageRows)
    : await attachReadStateToInboxItems(mappedItems, userId, db);

  const authoritativeResult: InboxItemsResult = {
    items,
    groups: readInboxGroupCounts(result.rows),
    hasMore: page.hasMore,
    totalCount: page.totalCount,
    totalUnreadCount: page.totalUnreadCount,
    activeUnreadCount: selectInboxPolicyActiveUnreadCount(
      rawRows,
      page.totalUnreadCount,
    ),
  };
  if (rfc056ServingMode === "shadow") {
    await observeRfc056ShadowComparison(
      filter,
      risingWaveShadowResult,
      authoritativeResult,
      limit,
      traceQuery,
      db,
    );
  }
  return authoritativeResult;
}

export async function markChannelInboxDone(
  userId: string,
  channelId: string,
  throughActivitySeq: unknown,
): Promise<ReadMutationAck> {
  // Released clients that predate bounded Done omit the frontier entirely.
  // Snapshot their canonical latest once at admission, then feed that exact S
  // through the unchanged strict guard and durable worker recheck. Explicit
  // null/malformed values remain on the strict V1 error path.
  let admittedThroughActivitySeq = throughActivitySeq;
  if (throughActivitySeq === undefined) {
    legacyDoneFrontierFallbacksTotal.inc({ target_kind: "channel" });
    admittedThroughActivitySeq = (await resolveChannelSuppressionTarget(channelId))?.latestSeqExact;
  }
  // A synchronous zero-write guard preserves the V1 400/409 contract. The
  // sequencer repeats it under the canonical content lock before committing
  // the atomic cursor + Done-state + suppression composite.
  const { target, frontier } = await assertChannelDoneFrontier({
    channelId,
    throughActivitySeq: admittedThroughActivitySeq,
  });
  const ack = await executeCompatibilityReadMutation({
    serverId: target.serverId,
    principalId: userId,
    mutation: {
      kind: "done",
      targetKind: "channel",
      scopeId: channelId,
      throughSeq: frontier.toString(),
    },
  });
  if (ack.terminalReason === "done_frontier_beyond_latest") {
    throw new DoneFrontierBeyondLatestError(channelId, frontier.toString(), null);
  }
  return ack;
}

/** Restore a channel or DM from durable Done history to the active Inbox. */
export async function markChannelInboxActive(userId: string, channelId: string) {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.update(userChannelInboxStates)
      .set({ doneAt: null, updatedAt: currentDate() })
      .where(and(
        eq(userChannelInboxStates.userId, userId),
        eq(userChannelInboxStates.channelId, channelId),
      ));
    await clearChannelDoneSuppression({ userId, channelId, executor: tx });
  });
  const sourceChannelId = await getMessageStorageChannelId(channelId);
  await rebuildInboxServingRowsForReceiverTargets([{
    receiverType: "user",
    receiverId: userId,
    sourceChannelId,
  }]);
}

export type ReadStateMutationResult = {
  channelId: string;
  maxReadSeq: number;
  readStateVersion: number;
  changed: boolean;
};

export type InboxReadLatestResult = {
  markedCount: number;
  scopes: ReadStateMutationResult[];
};

function readStateResultFromAckScope(scope: ReadMutationAck["scopes"][number]): ReadStateMutationResult {
  return {
    channelId: scope.scopeId,
    maxReadSeq: scope.maxReadSeq,
    readStateVersion: scope.readStateVersion,
    changed: scope.changed,
  };
}

/** Mark every active Inbox row read, including rows not loaded by the current page. */
export async function markInboxReadLatest(serverId: string, userId: string): Promise<InboxReadLatestResult> {
  const ack = await executeCompatibilityReadMutation({
    serverId,
    principalId: userId,
    mutation: { kind: "global_read_all" },
  });
  const rows = ack.scopes.map(readStateResultFromAckScope).filter((scope) => scope.changed);
  recordInboxReadRebuildRequested(userId, rows);
  return { markedCount: rows.length, scopes: rows };
}

export type ThreadFollowReason = "replied" | "authored" | "mentioned" | "manual";

/**
 * Write thread attention state. Ordinary auto-follow callers intentionally do
 * not override an explicit human unfollow; callers must opt in when a direct
 * mention, manual follow, or self-reply should reactivate a suppressed thread.
 */
export async function recordThreadFollow(
  followerType: "user" | "agent",
  followerId: string,
  threadChannelId: string,
  parentMessageId: string,
  reason: ThreadFollowReason,
  opts: {
    reactivateUnfollowed?: boolean;
    preserveExistingReason?: boolean;
  } = {},
) {
  const db = getDb();
  const reactivateUnfollowed = opts.reactivateUnfollowed ?? false;
  const preserveExistingReason = opts.preserveExistingReason ?? false;
  const result = await db.execute(sql`
    INSERT INTO thread_follows (
      thread_channel_id,
      follower_type,
      follower_id,
      parent_message_id,
      reason,
      done_at,
      unfollowed_at
    )
    VALUES (
      ${threadChannelId}::uuid,
      ${followerType},
      ${followerId}::uuid,
      ${parentMessageId}::uuid,
      ${reason},
      NULL,
      NULL
    )
    ON CONFLICT (thread_channel_id, follower_type, follower_id) DO UPDATE
    SET
      parent_message_id = EXCLUDED.parent_message_id,
      reason = CASE
        WHEN ${preserveExistingReason} THEN thread_follows.reason
        ELSE EXCLUDED.reason
      END,
      created_at = now(),
      done_at = NULL,
      unfollowed_at = NULL
    WHERE ${reactivateUnfollowed}
       OR thread_follows.unfollowed_at IS NULL
    RETURNING thread_channel_id
  `);

  if (result.rows.length > 0) {
    await clearFollowedThreadSuppressionForReceiver({
      followerType,
      followerId,
      threadChannelId,
    });
  }
}

/** Follow a thread manually (user). */
export async function followThread(userId: string, threadChannelId: string, parentMessageId: string) {
  await recordThreadFollow("user", userId, threadChannelId, parentMessageId, "manual", { reactivateUnfollowed: true });
  // Mark thread as read so existing messages don't appear as unread
  await markReadLatest(userId, threadChannelId);
}

/** Unfollow a thread for any supported follower type. */
export async function unfollowThreadForFollower(
  followerType: "user" | "agent",
  followerId: string,
  threadChannelId: string,
) {
  const db = getDb();
  const [thread] = await db
    .select({ parentMessageId: channels.parentMessageId })
    .from(channels)
    .where(and(eq(channels.id, threadChannelId), eq(channels.type, "thread")))
    .limit(1);
  const parentMessageId = thread?.parentMessageId
    ?? (await getJointThreadProjectionByLocalThread(threadChannelId))?.canonicalParentMessageId;
  if (!parentMessageId) return;

  await db.transaction(async (tx) => {
    const now = new Date();
    await tx.insert(threadFollows).values({
      threadChannelId,
      followerType,
      followerId,
      parentMessageId,
      reason: "manual",
      doneAt: null,
      unfollowedAt: now,
    }).onConflictDoUpdate({
      target: [threadFollows.threadChannelId, threadFollows.followerType, threadFollows.followerId],
      set: { reason: "manual", unfollowedAt: now },
    });

    if (followerType === "user") {
      await writeThreadDoneSuppression({
        userId: followerId,
        threadChannelId,
        writeSite: INBOX_SUPPRESSION_WRITE_SITES.unfollowThreadForFollower,
        executor: tx,
      });
    }
  });

  if (followerType === "user") {
    await markReadLatest(followerId, threadChannelId);
  }
}

/** Unfollow a thread (user). */
export async function unfollowThread(userId: string, threadChannelId: string) {
  await unfollowThreadForFollower("user", userId, threadChannelId);
}

/** Mark a thread as done (hide from active list, auto-restores on new messages). */
export async function markThreadDone(
  userId: string,
  threadChannelId: string,
  throughActivitySeq: unknown,
): Promise<ReadMutationAck> {
  let admittedThroughActivitySeq = throughActivitySeq;
  if (throughActivitySeq === undefined) {
    legacyDoneFrontierFallbacksTotal.inc({ target_kind: "thread" });
    admittedThroughActivitySeq = (await resolveThreadSuppressionTarget(threadChannelId))?.latestSeqExact;
  }
  const { target, frontier } = await assertThreadDoneFrontier({
    threadChannelId,
    throughActivitySeq: admittedThroughActivitySeq,
  });
  const ack = await executeCompatibilityReadMutation({
    serverId: target.serverId,
    principalId: userId,
    mutation: {
      kind: "done",
      targetKind: "thread",
      scopeId: threadChannelId,
      throughSeq: frontier.toString(),
    },
  });
  if (ack.terminalReason === "done_frontier_beyond_latest") {
    throw new DoneFrontierBeyondLatestError(threadChannelId, frontier.toString(), null);
  }
  return ack;
}

export type DeletedThreadDoneReceipt = {
  terminalReason: "legacy_done_target_unavailable";
  legacyNoop: true;
  retiredThroughActivitySeq: number;
  readStateVersion: number;
  changed: boolean;
};

/**
 * Retire a caller's durable Activity residue after its thread source has been
 * soft-deleted. The source is intentionally not recreated and no synthetic
 * Done suppression is written: `channel_read_all` admits the request only
 * from receiver-owned serving-row/fact/cursor evidence, advances to that
 * evidence boundary, and rebuilds the projection so refresh cannot resurrect
 * the stale row.
 */
export async function retireDeletedThreadDoneResidue(
  userId: string,
  threadChannelId: string,
  throughActivitySeq: unknown,
): Promise<DeletedThreadDoneReceipt> {
  if (throughActivitySeq === undefined) {
    // Count at admission rather than success: denied old-client attempts are
    // part of the compatibility population and must block premature removal.
    legacyDoneFrontierFallbacksTotal.inc({ target_kind: "thread" });
  } else if (parsePositiveCanonicalDecimal(throughActivitySeq) === null) {
    throw new DoneFrontierRequiredError(threadChannelId, throughActivitySeq);
  }

  addTraceEvent("thread_done.legacy_target_unavailable.admitted", {
    scope_id: threadChannelId,
    frontier_source: throughActivitySeq === undefined ? "omitted" : "explicit",
  });
  const state = await markReadLatest(userId, threadChannelId);
  return {
    terminalReason: "legacy_done_target_unavailable",
    legacyNoop: true,
    retiredThroughActivitySeq: state.maxReadSeq,
    readStateVersion: state.readStateVersion,
    changed: state.changed,
  };
}

/** Un-done a thread (restore to active list). */
export async function undoneThread(userId: string, threadChannelId: string) {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [restored] = await tx.update(threadFollows)
      .set({ doneAt: null })
      .where(and(
        eq(threadFollows.threadChannelId, threadChannelId),
        eq(threadFollows.followerType, "user"),
        eq(threadFollows.followerId, userId),
      ))
      .returning({ unfollowedAt: threadFollows.unfollowedAt });
    // Restoring Done must not silently re-follow an explicitly unfollowed
    // thread. Its existing suppression remains the delivery authority until a
    // direct mention, self-participation, or explicit Follow clears it.
    if (restored && restored.unfollowedAt === null) {
      await clearThreadDoneSuppression({ userId, threadChannelId, executor: tx });
    }
  });
  const sourceChannelId = await getMessageStorageChannelId(threadChannelId);
  await rebuildInboxServingRowsForReceiverTargets([{
    receiverType: "user",
    receiverId: userId,
    sourceChannelId,
  }]);
}

/** Clear doneAt for all followers of a thread (called when new message arrives). */
export async function clearThreadDoneForAll(threadChannelId: string) {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.update(threadFollows)
      .set({ doneAt: null })
      .where(and(
        eq(threadFollows.threadChannelId, threadChannelId),
        isNotNull(threadFollows.doneAt),
        isNull(threadFollows.unfollowedAt),
      ));
    await clearFollowedThreadSuppressionForAll({ threadChannelId, executor: tx });
  });
}


// ── Unread tracking ──────────────────────────────────────

/** Mark a channel as read up to the given seq for one kinded principal.
 *  String callers retain the deployed human-self behavior. */
export async function markRead(
  principal: string | { kind: "human" | "agent"; id: string },
  channelId: string,
  seq: number,
): Promise<ReadStateMutationResult> {
  const channel = await getChannel(channelId, { includeDeleted: true });
  if (!channel) throw new Error("Channel not found");
  const resolved = typeof principal === "string"
    ? { kind: "human" as const, id: principal }
    : principal;
  const ack = await executeCompatibilityReadMutation({
    serverId: channel.serverId,
    principalKind: resolved.kind,
    principalId: resolved.id,
    mutation: { kind: "row_read", scopeId: channelId, throughSeq: seq },
  });
  const scope = ack.scopes.find((candidate) => candidate.scopeId === channelId);
  if (!scope) return { channelId, maxReadSeq: 0, readStateVersion: 0, changed: false };
  return readStateResultFromAckScope(scope);
}

async function getMessageStorageChannelId(channelId: string): Promise<string> {
  const channel = await getChannel(channelId);
  if (!channel) return channelId;
  if (channel.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    return jointThread?.canonicalThreadChannelId ?? channelId;
  }
  if (channel.type === "joint") {
    const resolved = await resolveChannelAccess({ serverId: channel.serverId, channelId });
    return resolved?.kind === "joint" ? resolved.canonicalChannelId : channelId;
  }
  return channelId;
}

async function getLatestMessageSeq(channelId: string): Promise<number> {
  const db = getDb();
  const storageChannelId = await getMessageStorageChannelId(channelId);
  const [latest] = await db
    .select({ seq: sql<number>`MAX(${messages.seq})::int` })
    .from(messages)
    .where(eq(messages.channelId, storageChannelId));

  return latest?.seq ?? 0;
}

export type InboxTargetActivityMuteState = {
  activityMuted: boolean;
  muteFromSeq: number | null;
  prefsVersion: number;
  changed: boolean;
};

export async function getInboxTargetActivityMuteState(
  receiverType: "user" | "agent",
  receiverId: string,
  sourceChannelId: string,
): Promise<InboxTargetActivityMuteState> {
  const db = getDb();
  const [state] = await db
    .select({
      activityMuted: inboxTargetMuteStates.activityMuted,
      muteFromSeq: inboxTargetMuteStates.muteFromSeq,
      prefsVersion: inboxTargetMuteStates.prefsVersion,
    })
    .from(inboxTargetMuteStates)
    .where(and(
      eq(inboxTargetMuteStates.receiverType, receiverType),
      eq(inboxTargetMuteStates.receiverId, receiverId),
      eq(inboxTargetMuteStates.sourceChannelId, sourceChannelId),
    ))
    .limit(1);

  const activityMuted = !!state?.activityMuted && state.muteFromSeq != null;
  const result = state
    ? { activityMuted, muteFromSeq: activityMuted ? state.muteFromSeq : null, prefsVersion: state.prefsVersion }
    : { activityMuted: false, muteFromSeq: null, prefsVersion: 0 };
  recordInboxMuteStateTrace("inbox.mute_state.read", {
    receiverType,
    receiverId,
    sourceChannelId,
    state: result.activityMuted ? "muted" : "unmuted",
    muteFromSeq: result.muteFromSeq,
    reason: "current_state",
  });
  return { ...result, changed: false };
}

export async function setInboxTargetActivityMuteState(opts: {
  receiverType: "user" | "agent";
  receiverId: string;
  serverId: string;
  sourceChannelId: string;
  activityMuted: boolean;
}): Promise<InboxTargetActivityMuteState> {
  const db = getDb();
  const now = new Date();
  const current = await getInboxTargetActivityMuteState(opts.receiverType, opts.receiverId, opts.sourceChannelId);
  if (current.activityMuted === opts.activityMuted) {
    return { ...current, changed: false };
  }

  if (!opts.activityMuted) {
    const [state] = await db
      .insert(inboxTargetMuteStates)
      .values({
        receiverType: opts.receiverType,
        receiverId: opts.receiverId,
        serverId: opts.serverId,
        sourceChannelId: opts.sourceChannelId,
        activityMuted: false,
        muteFromSeq: null,
        prefsVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          inboxTargetMuteStates.receiverType,
          inboxTargetMuteStates.receiverId,
          inboxTargetMuteStates.sourceChannelId,
        ],
        set: {
          serverId: opts.serverId,
          activityMuted: false,
          muteFromSeq: null,
          prefsVersion: sql`${inboxTargetMuteStates.prefsVersion} + 1`,
          updatedAt: now,
        },
      })
      .returning({
        prefsVersion: inboxTargetMuteStates.prefsVersion,
      });
    recordInboxMuteStateTrace("inbox.mute_state.write", {
      receiverType: opts.receiverType,
      receiverId: opts.receiverId,
      sourceChannelId: opts.sourceChannelId,
      state: "unmuted",
      muteFromSeq: null,
      reason: "unmuted",
    });
    return { activityMuted: false, muteFromSeq: null, prefsVersion: state.prefsVersion, changed: true };
  }

  const muteFromSeq = await getLatestMessageSeq(opts.sourceChannelId) + 1;
  const [state] = await db
    .insert(inboxTargetMuteStates)
    .values({
      receiverType: opts.receiverType,
      receiverId: opts.receiverId,
      serverId: opts.serverId,
      sourceChannelId: opts.sourceChannelId,
      activityMuted: true,
      muteFromSeq,
      prefsVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        inboxTargetMuteStates.receiverType,
        inboxTargetMuteStates.receiverId,
        inboxTargetMuteStates.sourceChannelId,
      ],
      set: {
        serverId: opts.serverId,
        activityMuted: true,
        muteFromSeq,
        prefsVersion: sql`${inboxTargetMuteStates.prefsVersion} + 1`,
        updatedAt: now,
      },
    })
    .returning({
      prefsVersion: inboxTargetMuteStates.prefsVersion,
    });

  recordInboxMuteStateTrace("inbox.mute_state.write", {
    receiverType: opts.receiverType,
    receiverId: opts.receiverId,
    sourceChannelId: opts.sourceChannelId,
    state: "muted",
    muteFromSeq,
    reason: "muted_from_next_seq",
  });
  return { activityMuted: true, muteFromSeq, prefsVersion: state.prefsVersion, changed: true };
}

export type UserChannelMessageDisplayPrefs = {
  collapseLongMessages: boolean;
  prefsVersion: number;
  changed: boolean;
};

export async function getUserChannelMessageDisplayPrefs(
  userId: string,
  channelId: string,
): Promise<UserChannelMessageDisplayPrefs> {
  const db = getDb();
  const [state] = await db
    .select({
      collapseLongMessages: userChannelDisplayPrefs.collapseLongMessages,
      prefsVersion: userChannelDisplayPrefs.prefsVersion,
    })
    .from(userChannelDisplayPrefs)
    .where(and(
      eq(userChannelDisplayPrefs.userId, userId),
      eq(userChannelDisplayPrefs.channelId, channelId),
    ))
    .limit(1);

  const result = state
    ? { collapseLongMessages: state.collapseLongMessages, prefsVersion: state.prefsVersion }
    : { collapseLongMessages: true, prefsVersion: 0 };
  return { ...result, changed: false };
}

export async function setUserChannelMessageDisplayPrefs(opts: {
  userId: string;
  serverId: string;
  channelId: string;
  collapseLongMessages: boolean;
}): Promise<UserChannelMessageDisplayPrefs> {
  const db = getDb();
  const now = new Date();
  const current = await getUserChannelMessageDisplayPrefs(opts.userId, opts.channelId);
  if (current.collapseLongMessages === opts.collapseLongMessages) {
    return { ...current, changed: false };
  }

  const [state] = await db
    .insert(userChannelDisplayPrefs)
    .values({
      userId: opts.userId,
      channelId: opts.channelId,
      serverId: opts.serverId,
      collapseLongMessages: opts.collapseLongMessages,
      prefsVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        userChannelDisplayPrefs.userId,
        userChannelDisplayPrefs.channelId,
      ],
      set: {
        serverId: opts.serverId,
        collapseLongMessages: opts.collapseLongMessages,
        prefsVersion: sql`${userChannelDisplayPrefs.prefsVersion} + 1`,
        updatedAt: now,
      },
    })
    .returning({
      prefsVersion: userChannelDisplayPrefs.prefsVersion,
    });
  return { collapseLongMessages: opts.collapseLongMessages, prefsVersion: state.prefsVersion, changed: true };
}

export async function getActivityMutedUserIdsForMessage(opts: {
  serverId: string;
  sourceChannelId: string;
  userIds: string[];
  messageSeq: number;
  piercedUserIds?: Set<string>;
}): Promise<Set<string>> {
  const db = getDb();
  if (opts.userIds.length === 0) return new Set();
  if (!await isHumanActivityMuteEnabled(opts.serverId)) return new Set();
  const rows = await db
    .select({
      receiverId: inboxTargetMuteStates.receiverId,
      activityMuted: inboxTargetMuteStates.activityMuted,
      muteFromSeq: inboxTargetMuteStates.muteFromSeq,
    })
    .from(inboxTargetMuteStates)
    .where(and(
      eq(inboxTargetMuteStates.receiverType, "user"),
      eq(inboxTargetMuteStates.serverId, opts.serverId),
      eq(inboxTargetMuteStates.sourceChannelId, opts.sourceChannelId),
      inArray(inboxTargetMuteStates.receiverId, opts.userIds),
    ));
  const piercedUserIds = opts.piercedUserIds ?? new Set<string>();
  return new Set(rows
    .filter((row) => row.activityMuted && row.muteFromSeq != null && isActivityPromotionSuppressedByMute({
      kind: "channel",
      messageSeq: opts.messageSeq,
      muteFromSeq: row.muteFromSeq,
      personalMention: piercedUserIds.has(row.receiverId),
    }))
    .map((row) => row.receiverId));
}

export async function getActivityMutedAgentIdsForMessage(opts: {
  serverId: string;
  sourceChannelId: string;
  agentIds: string[];
  messageSeq: number;
  piercedAgentIds?: Set<string>;
}): Promise<Set<string>> {
  if (opts.agentIds.length === 0) return new Set();
  const db = getDb();
  const rows = await db
    .select({
      receiverId: inboxTargetMuteStates.receiverId,
      activityMuted: inboxTargetMuteStates.activityMuted,
      muteFromSeq: inboxTargetMuteStates.muteFromSeq,
    })
    .from(inboxTargetMuteStates)
    .where(and(
      eq(inboxTargetMuteStates.receiverType, "agent"),
      eq(inboxTargetMuteStates.serverId, opts.serverId),
      eq(inboxTargetMuteStates.sourceChannelId, opts.sourceChannelId),
      inArray(inboxTargetMuteStates.receiverId, opts.agentIds),
    ));
  const piercedAgentIds = opts.piercedAgentIds ?? new Set<string>();
  return new Set(rows
    .filter((row) => row.activityMuted && row.muteFromSeq != null && isActivityPromotionSuppressedByMute({
      kind: "channel",
      messageSeq: opts.messageSeq,
      muteFromSeq: row.muteFromSeq,
      personalMention: piercedAgentIds.has(row.receiverId),
    }))
    .map((row) => row.receiverId));
}

async function getLatestUnreadMessageSeqForUser(userId: string, channelId: string): Promise<number> {
  const db = getDb();
  const storageChannelId = await getMessageStorageChannelId(channelId);
  const [latest] = await db
    .select({ seq: sql<number>`MAX(${messages.seq})::int` })
    .from(messages)
    .where(and(
      eq(messages.channelId, storageChannelId),
      sql`NOT (${messages.senderType} = 'user' AND ${messages.senderId} = ${userId})`,
    ));

  return latest?.seq ?? 0;
}

/** Mark a channel as fully read up to its latest message.
 *  String callers retain the deployed human-self behavior. Kinded callers are
 *  used only after the route/auth layer has resolved the intended receiver;
 *  the sequencer independently rechecks receiver membership by kind. */
export async function markReadLatest(
  principal: string | { kind: "human" | "agent"; id: string },
  channelId: string,
): Promise<ReadStateMutationResult> {
  const channel = await getChannel(channelId, { includeDeleted: true });
  if (!channel) throw new Error("Channel not found");
  const resolved = typeof principal === "string"
    ? { kind: "human" as const, id: principal }
    : principal;
  const ack = await executeCompatibilityReadMutation({
    serverId: channel.serverId,
    principalKind: resolved.kind,
    principalId: resolved.id,
    mutation: { kind: "channel_read_all", scopeId: channelId },
  });
  const scope = ack.scopes.find((candidate) => candidate.scopeId === channelId);
  if (!scope) return { channelId, maxReadSeq: 0, readStateVersion: 0, changed: false };
  return readStateResultFromAckScope(scope);
}

/** Mark a channel as unread by rewinding the read cursor to just before the latest unread-eligible message. */
export async function markUnread(userId: string, channelId: string): Promise<ReadStateMutationResult & { unreadCount: number }> {
  const channel = await getChannel(channelId, { includeDeleted: true });
  if (!channel) throw new Error("Channel not found");
  const boundary = await resolveReadMutationUnreadBoundary({
    serverId: channel.serverId,
    principalId: userId,
    scopeId: channelId,
  });
  if (boundary.latestUnreadEligibleSeq <= 0) {
    return { channelId, maxReadSeq: 0, readStateVersion: 0, changed: false, unreadCount: 0 };
  }
  const ack = await executeCompatibilityReadMutation({
    serverId: channel.serverId,
    principalId: userId,
    mutation: { kind: "row_unread", scopeId: channelId, throughSeq: boundary.throughSeq },
  });
  const scope = ack.scopes.find((candidate) => candidate.scopeId === channelId);
  if (!scope) return { channelId, maxReadSeq: 0, readStateVersion: 0, changed: false, unreadCount: 0 };
  return {
    ...readStateResultFromAckScope(scope),
    unreadCount: Math.max(boundary.latestUnreadEligibleSeq - scope.maxReadSeq, 0),
  };
}

/** Get unread message counts for all channels in a server for a user.
 *  Two-step approach: first identify channels with any unread via EXISTS (short-circuits),
 *  then count only in those channels. Avoids scanning messages in fully-read channels. */
export async function getUnreadCounts(
  serverId: string,
  userId: string,
  historyCutoff?: Date,
  opts?: UnreadCountOptions,
): Promise<Record<string, number>> {
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;
  const jointStorageServerIds = historyCutoff
    ? new Set<string>()
    : await risingWaveInboxFailSoftDeps.getJointStorageServerIds([serverId], userId);
  let risingWaveAttempt: RisingWaveInboxAttempt<Record<string, number>> = { result: null };
  if (!historyCutoff && jointStorageServerIds.size === 0) {
    risingWaveAttempt = await tryGetUnreadCountsFromRisingWave(serverId, userId, historyCutoff, traceQuery);
    if (risingWaveAttempt.result) {
      recordInboxBackendSelected("rw_mv", "channel_unread", "none", RISINGWAVE_CHANNEL_UNREAD_CONTRACT_VERSION);
      return risingWaveAttempt.result;
    }
  }

  const db = getDb();
  const cutoffCondition = historyCutoff ? sql` AND m.created_at > ${historyCutoff}` : sql``;
  const legacyFallbackReason = getLegacyInboxFallbackReason(historyCutoff);
  const pgFallbackReason = risingWaveAttempt.fallbackReason
    ?? (jointStorageServerIds.size > 0 ? "joint_storage" : legacyFallbackReason);

  const rows = await withRisingWaveInboxFallbackTrace(
    "channel_unread",
    "channels.unread_counts_by_user",
    risingWaveAttempt,
    () => traceQuery(
      "channels.unread_counts_by_user",
      () => db.execute(sql`
      -- Canonical no-env channel unread behavior lives in this inline Postgres SQL.
      -- If you change membership, thread parent access, archived/deleted,
      -- history-cutoff, or count semantics here, update RISINGWAVE_CHANNEL_UNREAD_COUNTS_VIEW
      -- in infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql and rerun
      -- pnpm --filter @botiverse/raft-server risingwave:verify-inbox-parity.
      WITH candidate_channels AS (
        SELECT
          c.id AS source_channel_id,
          COALESCE(joint_storage.canonical_channel_id, c.id) AS storage_channel_id,
          COALESCE(rc.last_read_seq, 0) AS last_read_seq
        FROM channels c
        LEFT JOIN channel_humans ch
          ON ch.channel_id = c.id AND ch.user_id = ${userId}
        LEFT JOIN joint_channel_servers joint_projection
          ON joint_projection.local_channel_id = c.id
         AND joint_projection.server_id = c.server_id
         AND joint_projection.status = 'active'
        LEFT JOIN joint_channels joint_storage
          ON joint_storage.id = joint_projection.joint_channel_id
         AND joint_storage.status = 'active'
        LEFT JOIN user_channel_read_cursors rc
          ON rc.channel_id = c.id AND rc.user_id = ${userId}
        WHERE c.server_id = ${serverId}
          AND c.deleted_at IS NULL
          AND c.archived_at IS NULL
          AND c.type != 'thread'
          -- DM/private/joint channels must be visible to the current user.
          AND (c.type NOT IN ('dm', 'private', 'joint') OR ch.user_id IS NOT NULL)
        UNION ALL
        SELECT
          c.id AS source_channel_id,
          c.id AS storage_channel_id,
          COALESCE(rc.last_read_seq, 0) AS last_read_seq
        FROM thread_follows tf
        INNER JOIN channels c
          ON c.id = tf.thread_channel_id
         AND c.type = 'thread'
         AND c.server_id = ${serverId}
         AND c.deleted_at IS NULL
        INNER JOIN messages pm
          ON pm.id = c.parent_message_id
        INNER JOIN channels pc
          ON pc.id = pm.channel_id
         AND pc.archived_at IS NULL
         AND pc.deleted_at IS NULL
        LEFT JOIN channel_humans pch
          ON pch.channel_id = pc.id AND pch.user_id = ${userId}
        LEFT JOIN user_channel_read_cursors rc
          ON rc.channel_id = c.id AND rc.user_id = ${userId}
        WHERE tf.follower_type = 'user'
          AND tf.follower_id = ${userId}
          AND tf.done_at IS NULL
          AND tf.unfollowed_at IS NULL
          AND (pc.type NOT IN ('dm', 'private', 'joint') OR pch.user_id IS NOT NULL)
        UNION ALL
        SELECT
          local_thread.id AS source_channel_id,
          canonical_thread.id AS storage_channel_id,
          COALESCE(rc.last_read_seq, 0) AS last_read_seq
        FROM thread_follows tf
        INNER JOIN channels local_thread
          ON local_thread.id = tf.thread_channel_id
         AND local_thread.type = 'thread'
         AND local_thread.server_id = ${serverId}
         AND local_thread.deleted_at IS NULL
        INNER JOIN joint_channel_servers thread_projection
          ON thread_projection.local_channel_id = local_thread.id
         AND thread_projection.server_id = ${serverId}
         AND thread_projection.status = 'active'
        INNER JOIN joint_channels thread_joint
          ON thread_joint.id = thread_projection.joint_channel_id
         AND thread_joint.status = 'active'
        INNER JOIN channels canonical_thread
          ON canonical_thread.id = thread_joint.canonical_channel_id
         AND canonical_thread.type = 'thread'
         AND canonical_thread.deleted_at IS NULL
        INNER JOIN messages parent_msg
          ON parent_msg.id = canonical_thread.parent_message_id
        INNER JOIN joint_channels parent_joint
          ON parent_joint.canonical_channel_id = parent_msg.channel_id
         AND parent_joint.status = 'active'
        INNER JOIN joint_channel_servers parent_projection
          ON parent_projection.joint_channel_id = parent_joint.id
         AND parent_projection.server_id = ${serverId}
         AND parent_projection.status = 'active'
        INNER JOIN channels local_parent
          ON local_parent.id = parent_projection.local_channel_id
         AND local_parent.type = 'joint'
         AND local_parent.archived_at IS NULL
         AND local_parent.deleted_at IS NULL
        INNER JOIN channel_humans parent_member
          ON parent_member.channel_id = local_parent.id
         AND parent_member.user_id = ${userId}
        LEFT JOIN user_channel_read_cursors rc
          ON rc.channel_id = local_thread.id AND rc.user_id = ${userId}
        WHERE tf.follower_type = 'user'
          AND tf.follower_id = ${userId}
          AND tf.done_at IS NULL
          AND tf.unfollowed_at IS NULL
      ),
      unread_channels AS (
        SELECT cc.source_channel_id, cc.storage_channel_id, cc.last_read_seq
        FROM candidate_channels cc
        WHERE EXISTS (
            SELECT 1 FROM messages m
            WHERE m.channel_id = cc.storage_channel_id
              AND m.seq > cc.last_read_seq
              AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
              ${cutoffCondition}
          )
      )
      SELECT uc.source_channel_id AS "channelId", count(*)::int AS "count"
      FROM unread_channels uc
      JOIN messages m ON m.channel_id = uc.storage_channel_id
        AND m.seq > uc.last_read_seq
        AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
        ${cutoffCondition}
      GROUP BY uc.source_channel_id
      `),
      (result) => ({
        ...inboxTraceAttrs("pg_legacy", "channel_unread", pgFallbackReason, RISINGWAVE_CHANNEL_UNREAD_CONTRACT_VERSION),
        unread_channels_count: result.rows.length,
        history_cutoff_present: Boolean(historyCutoff),
      }),
    ),
  );

  const counts: Record<string, number> = {};
  for (const row of rows.rows as { channelId: string; count: number }[]) {
    counts[row.channelId] = row.count;
  }
  recordInboxBackendSelected(
    "pg_legacy",
    "channel_unread",
    pgFallbackReason,
    RISINGWAVE_CHANNEL_UNREAD_CONTRACT_VERSION,
  );
  return counts;
}

export async function getUnreadSummary(
  serverId: string,
  userId: string,
  historyCutoff?: Date,
  opts?: UnreadCountOptions,
): Promise<Record<string, ChannelUnreadSummaryEntry>> {
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;
  const counts = await getUnreadCounts(serverId, userId, historyCutoff, { traceQuery });
  const db = getDb();
  const mentionRows = await traceQuery(
    "channels.unread_summary_mentions_by_user",
    () => db.execute(sql`
      SELECT
        serving_row.source_channel_id::text AS "channelId",
        serving_row.unread_mention_count::int AS "unreadMentionCount",
        serving_row.has_any_mention AS "hasAnyMention"
      FROM inbox_serving_rows serving_row
      INNER JOIN channels source_channel
        ON source_channel.id = serving_row.source_channel_id
       AND source_channel.server_id = serving_row.server_id
       AND source_channel.deleted_at IS NULL
       AND source_channel.archived_at IS NULL
      WHERE serving_row.receiver_type = 'user'
        AND serving_row.receiver_id = ${userId}::uuid
        AND serving_row.server_id = ${serverId}
    `),
    (result) => ({
      unread_summary_mention_rows_count: result.rows.length,
      history_cutoff_present: Boolean(historyCutoff),
    }),
  );

  const summary: Record<string, ChannelUnreadSummaryEntry> = {};
  const absentReadState = makeInboxScopeReadFrontier(null);
  for (const [channelId, unreadCount] of Object.entries(counts)) {
    summary[channelId] = {
      unreadCount,
      hasMention: false,
      hasAnyMention: false,
      readState: absentReadState,
    };
  }
  for (const row of mentionRows.rows as Array<{ channelId: string; unreadMentionCount: number; hasAnyMention: boolean }>) {
    if (row.unreadMentionCount <= 0 && row.hasAnyMention !== true) continue;
    const channelId = row.channelId;
    const existing = summary[channelId];
    summary[channelId] = {
      unreadCount: existing?.unreadCount ?? 0,
      hasMention: row.unreadMentionCount > 0,
      hasAnyMention: row.hasAnyMention === true,
      readState: existing?.readState ?? absentReadState,
    };
  }

  const scopeIds = Object.keys(summary);
  if (scopeIds.length > 0) {
    // #632 SSOT: read the AUTHORITY table directly (the cursor table is what
    // both the RW materialization and the PG count arms derive from), with
    // presence preserved as a STRUCTURAL JOIN fact — no COALESCE-to-0 before
    // the shared constructor decides absent/present/corrupt. The frontier
    // pair comes from ONE row (lateral over the storage channel), so id/seq
    // cannot be cross-source.
    const readStateRows = await fetchReadStateAuthorityRows(
      scopeIds,
      userId,
      traceQuery,
      "channels.unread_summary_read_state_by_user",
    );
    applyUnreadSummaryReadStates(
      summary,
      readStateRows,
      (channelId, corruption) => {
        console.error(formatInboxScopeCorruptionLine(channelId, corruption));
      },
    );
  }
  return summary;
}

export interface UnreadSummaryReadStateRow {
  channelId: string;
  /**
   * STRUCTURAL presence fact straight from the JOIN (`rc.user_id IS NOT
   * NULL`) — presence is never synthesized from whichever value columns
   * happen to be NULL (frozen exit gate).
   */
  readCursorPresent: boolean;
  readStateVersion: number | null;
  maxReadSeq: string | null;
  latestActivityMessageId: string | null;
  latestActivitySeq: string | null;
  /** Done guard domain; parent fallback is included for zero-reply threads. */
  doneFrontierSeq?: string | null;
}

/**
 * Exported for teeth: applies authority rows onto summary entries via the
 * single shared constructor. Presence is the structural JOIN fact; a present
 * row whose value columns are unexpectedly NULL flows into the constructor
 * as-is and classifies CORRUPT (never silently absent, never coalesced to
 * 0). Corruption reporting goes through onCorrupt per scope — one bad row
 * must not affect the rest.
 */
export function applyUnreadSummaryReadStates(
  summary: Record<string, ChannelUnreadSummaryEntry>,
  rows: UnreadSummaryReadStateRow[],
  onCorrupt: (channelId: string, corruption: Parameters<typeof formatInboxScopeCorruptionLine>[1]) => void,
): void {
  for (const row of rows) {
    const entry = summary[row.channelId];
    if (!entry) continue;
    const cursor = row.readCursorPresent
      ? {
        readStateVersion: row.readStateVersion as number,
        maxReadSeq: row.maxReadSeq as string,
        latestActivityMessageId: row.latestActivityMessageId,
        latestActivitySeq: row.latestActivitySeq,
      }
      : null;
    entry.readState = makeInboxScopeReadFrontier(cursor, (c) => onCorrupt(row.channelId, c));
  }
}

/**
 * Count unread messages that would surface as pink unread indicators in the sidebar.
 * This includes:
 * - regular channels the user has joined
 * - DM channels the user participates in
 *
 * It excludes:
 * - non-joined regular channels (which render with the dim/grey unread treatment)
 * - thread channels (not part of the sidebar's pink unread server summary)
 */
export async function getSidebarUnreadSummaryCounts(
  servers: SidebarUnreadSummaryInput[],
  userId: string,
  opts: SidebarUnreadSummaryOptions = {},
): Promise<Record<string, number>> {
  if (servers.length === 0) return {};
  const traceQuery = opts.traceQuery ?? untracedDbQuery;

  const hasHistoryCutoff = servers.some((server) => Boolean(server.historyCutoff));
  const jointStorageServerIds = hasHistoryCutoff
    ? new Set<string>()
    : await risingWaveInboxFailSoftDeps.getJointStorageServerIds(servers.map((server) => server.serverId), userId);
  let risingWaveAttempt: RisingWaveInboxAttempt<Record<string, number>> = { result: null };
  if (!hasHistoryCutoff && jointStorageServerIds.size === 0) {
    risingWaveAttempt = await tryGetSidebarUnreadSummaryCountsFromRisingWave(
      servers,
      userId,
      traceQuery,
    );
    if (risingWaveAttempt.result) {
      recordInboxBackendSelected("rw_mv", "sidebar_summary", "none", RISINGWAVE_LEGACY_UNREAD_CONTRACT_VERSION);
      return risingWaveAttempt.result;
    }
  }

  const db = getDb();
  const legacyFallbackReason = getLegacyInboxFallbackReason(servers.find((server) => server.historyCutoff)?.historyCutoff);
  const pgFallbackReason = risingWaveAttempt.fallbackReason
    ?? (jointStorageServerIds.size > 0 ? "joint_storage" : legacyFallbackReason);

  const serverRows = servers.map(({ serverId, historyCutoff }) =>
    sql`(${serverId}::uuid, ${historyCutoff ?? null}::timestamp)`,
  );

  const rows = await withRisingWaveInboxFallbackTrace(
    "sidebar_summary",
    "servers.sidebar_unread_counts_by_user",
    risingWaveAttempt,
    () => traceQuery(
      "servers.sidebar_unread_counts_by_user",
      () => db.execute(sql`
    -- Canonical no-env sidebar unread behavior lives in this inline Postgres SQL.
    -- If you change membership, channel-type, archived/deleted, history-cutoff,
    -- or count semantics here, update rw_sidebar_unread_summary_v1 in
    -- infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql and rerun
    -- pnpm --filter @botiverse/raft-server risingwave:verify-inbox-parity.
    WITH selected_servers(server_id, history_cutoff) AS (
      VALUES ${sql.join(serverRows, sql`, `)}
    ),
    sidebar_unread_channels AS (
      SELECT
        c.server_id,
        c.id,
        COALESCE(joint_storage.canonical_channel_id, c.id) AS storage_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        s.history_cutoff
      FROM selected_servers s
      INNER JOIN channels c ON c.server_id = s.server_id
      LEFT JOIN joint_channel_servers joint_projection
        ON joint_projection.local_channel_id = c.id
       AND joint_projection.server_id = c.server_id
       AND joint_projection.status = 'active'
      LEFT JOIN joint_channels joint_storage
        ON joint_storage.id = joint_projection.joint_channel_id
       AND joint_storage.status = 'active'
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id AND rc.user_id = ${userId}
      WHERE c.deleted_at IS NULL
        AND c.archived_at IS NULL
        AND c.type != 'thread'
        AND EXISTS (
          SELECT 1 FROM channel_humans ch
          WHERE ch.channel_id = c.id AND ch.user_id = ${userId}
        )
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m.channel_id = COALESCE(joint_storage.canonical_channel_id, c.id)
            AND m.seq > COALESCE(rc.last_read_seq, 0)
            AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
            AND (s.history_cutoff IS NULL OR m.created_at > s.history_cutoff)
        )
    )
    SELECT uc.server_id::text AS "serverId", count(*)::int AS "count"
    FROM sidebar_unread_channels uc
    JOIN messages m ON m.channel_id = uc.storage_channel_id
      AND m.seq > uc.last_read_seq
      AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
      AND (uc.history_cutoff IS NULL OR m.created_at > uc.history_cutoff)
    GROUP BY uc.server_id
      `),
      (result) => ({
        ...inboxTraceAttrs("pg_legacy", "sidebar_summary", pgFallbackReason, RISINGWAVE_LEGACY_UNREAD_CONTRACT_VERSION),
        servers_count: servers.length,
        servers_with_unread_count: result.rows.length,
        history_cutoff_present_count: servers.filter((server) => Boolean(server.historyCutoff)).length,
      }),
    ),
  );

  const counts: Record<string, number> = {};
  for (const server of servers) counts[server.serverId] = 0;
  for (const row of rows.rows as { serverId: string; count: number }[]) {
    counts[row.serverId] = row.count;
  }
  recordInboxBackendSelected(
    "pg_legacy",
    "sidebar_summary",
    pgFallbackReason,
    RISINGWAVE_LEGACY_UNREAD_CONTRACT_VERSION,
  );
  return counts;
}

export async function getSidebarUnreadSummaryCount(
  serverId: string,
  userId: string,
  historyCutoff?: Date,
  opts: SidebarUnreadSummaryOptions = {},
): Promise<number> {
  const counts = await getSidebarUnreadSummaryCounts([{ serverId, historyCutoff }], userId, opts);
  return counts[serverId] ?? 0;
}

// ── Agent legacy read / compatibility tracking ───────────

/**
 * Get the durable legacy read-ish seq for an agent/channel.
 *
 * This value is an agent usability checkpoint, not model-seen proof. New
 * daemon/runtime freshness gates must use explicit model-seen provenance
 * (`seenUpToSeq` today), while old daemon compatibility may still advance this
 * checkpoint from receive-ack to keep unread/summary bounded.
 */
export async function getAgentLegacyReadCursor(agentId: string, channelId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ lastReadSeq: agentChannelReadCursors.lastReadSeq })
    .from(agentChannelReadCursors)
    .where(and(
      eq(agentChannelReadCursors.agentId, agentId),
      eq(agentChannelReadCursors.channelId, channelId),
    ));
  return row?.lastReadSeq ?? 0;
}

/**
 * All durable legacy read-ish cursor rows for an agent (CL-CURSOR-SPLIT CS-4).
 *
 * Same caveats as `getAgentLegacyReadCursor`: this is an ack/usability
 * checkpoint horizon, never model-seen proof, and must not feed freshness
 * gates. CS-4 uses it as the per-channel rebuild watermark after the volatile
 * delivery buffer is lost (server restart/deploy): channels WITHOUT a cursor
 * row are deliberately not rebuilt (v1 boundary — no horizon to rebuild from).
 */
export async function getAgentLegacyReadCursors(
  agentId: string,
): Promise<Array<{ channelId: string; lastReadSeq: number }>> {
  const db = getDb();
  return db
    .select({
      channelId: agentChannelReadCursors.channelId,
      lastReadSeq: agentChannelReadCursors.lastReadSeq,
    })
    .from(agentChannelReadCursors)
    .where(eq(agentChannelReadCursors.agentId, agentId));
}

/**
 * Advance the durable legacy read-ish cursor for an agent/channel.
 *
 * Callers must not treat this as a model-seen boundary. It is either an
 * explicit history/read usability checkpoint or an old-daemon ack compatibility
 * horizon. Faithfulness-sensitive decisions must use explicit model-seen
 * provenance instead.
 */
export async function markAgentLegacyRead(agentId: string, channelId: string, seq: number) {
  const db = getDb();
  const result = await db.execute(sql`
    INSERT INTO agent_channel_read_cursors (agent_id, channel_id, last_read_seq, updated_at)
    VALUES (${agentId}, ${channelId}, ${seq}, now())
    ON CONFLICT (agent_id, channel_id) DO UPDATE SET
      last_read_seq = EXCLUDED.last_read_seq,
      updated_at = now()
    WHERE agent_channel_read_cursors.last_read_seq < EXCLUDED.last_read_seq
    RETURNING
      channel_id::text AS "channelId",
      last_read_seq::int AS "maxReadSeq"
  `);
  const [advanced] = result.rows as Array<{ channelId: string; maxReadSeq: number }>;
  await rebuildInboxServingRowsForReceiverTargets([{
    receiverType: "agent",
    receiverId: agentId,
    sourceChannelId: channelId,
  }]);
  if (advanced) return { ...advanced, changed: true };

  await db
    .update(agentChannelReadCursors)
    .set({ updatedAt: new Date() })
    .where(and(
      eq(agentChannelReadCursors.agentId, agentId),
      eq(agentChannelReadCursors.channelId, channelId),
    ));
  const [existing] = await db
    .select({ maxReadSeq: agentChannelReadCursors.lastReadSeq })
    .from(agentChannelReadCursors)
    .where(and(
      eq(agentChannelReadCursors.agentId, agentId),
      eq(agentChannelReadCursors.channelId, channelId),
    ))
    .limit(1);
  return { channelId, maxReadSeq: existing?.maxReadSeq ?? 0, changed: false };
}

/**
 * Old-daemon compatibility: advance the existing agent read cursor from acked
 * message seqs so legacy daemons connected to a newer server do not accumulate
 * unbounded unread/pending-summary state.
 *
 * This is deliberately separate from AgentOrchestrator delivery ack. Delivery
 * ack/drain remains volatile replay state; this DB write is an ack-checkpoint
 * compatibility horizon, not model-seen proof. Freshness gates must continue
 * to ignore this cursor and read explicit model-seen provenance only.
 */
export async function markAgentLegacyAckCheckpoint(agentId: string, seqs: number[]): Promise<void> {
  const normalizedSeqs = [...new Set(seqs
    .map((seq) => Math.floor(Number(seq)))
    .filter((seq) => Number.isInteger(seq) && seq > 0))];
  if (normalizedSeqs.length === 0) return;

  const db = getDb();
  const ackChannels = alias(channels, "legacy_ack_channels");
  const ackParentMessages = alias(messages, "legacy_ack_parent_messages");
  const rows = await db
    .select({
      channelId: messages.channelId,
      maxSeq: sql<number>`max(${messages.seq})::int`,
    })
    .from(messages)
    .innerJoin(ackChannels, eq(ackChannels.id, messages.channelId))
    .leftJoin(ackParentMessages, eq(ackParentMessages.id, ackChannels.parentMessageId))
    .innerJoin(channelAgents, and(
      eq(channelAgents.channelId, sql<string>`COALESCE(${ackParentMessages.channelId}, ${messages.channelId})`),
      eq(channelAgents.agentId, agentId),
    ))
    .where(inArray(messages.seq, normalizedSeqs))
    .groupBy(messages.channelId);

  await Promise.all(rows.map((row) => markAgentLegacyRead(agentId, row.channelId, row.maxSeq)));
}

/** Get unread message counts for all channels an agent belongs to. Returns channelLabel → count. */
export async function getAgentUnreadCounts(agentId: string, historyCutoff?: Date): Promise<Record<string, number>> {
  const db = getDb();

  const baseConditions = [
    isNull(channels.deletedAt),
    gt(messages.seq, sql`COALESCE(${agentChannelReadCursors.lastReadSeq}, 0)`),
  ];
  if (historyCutoff) {
    baseConditions.push(gt(messages.createdAt, historyCutoff));
  }

  const nonThreadRows = await db
    .select({
      channelId: messages.channelId,
      channelName: channels.name,
      channelType: channels.type,
      count: sql<number>`count(*)::int`,
    })
    .from(messages)
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .innerJoin(channelAgents, and(
      eq(channelAgents.channelId, messages.channelId),
      eq(channelAgents.agentId, agentId),
    ))
    .leftJoin(
      agentChannelReadCursors,
      and(
        eq(agentChannelReadCursors.channelId, messages.channelId),
        eq(agentChannelReadCursors.agentId, agentId),
      ),
    )
    .where(and(
      ...baseConditions,
      sql`${channels.type} <> 'thread'`,
    ))
    .groupBy(messages.channelId, channels.name, channels.type);

  const unreadParentMessages = alias(messages, "agent_unread_thread_parent_messages");
  const unreadParentChannels = alias(channels, "agent_unread_thread_parent_channels");
  const unreadParentChannelAgents = alias(channelAgents, "agent_unread_thread_parent_channel_agents");
  const threadRows = await db
    .select({
      channelId: messages.channelId,
      channelName: channels.name,
      channelType: channels.type,
      parentChannelId: unreadParentChannels.id,
      parentChannelName: unreadParentChannels.name,
      parentChannelType: unreadParentChannels.type,
      parentMessageId: unreadParentMessages.id,
      count: sql<number>`count(*)::int`,
    })
    .from(messages)
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .innerJoin(threadFollows, and(
      eq(threadFollows.threadChannelId, channels.id),
      eq(threadFollows.followerType, "agent"),
      eq(threadFollows.followerId, agentId),
      isNull(threadFollows.unfollowedAt),
    ))
    .innerJoin(agents, and(
      eq(agents.id, threadFollows.followerId),
      isNull(agents.deletedAt),
    ))
    .innerJoin(unreadParentMessages, eq(unreadParentMessages.id, channels.parentMessageId))
    .innerJoin(unreadParentChannels, and(
      eq(unreadParentChannels.id, unreadParentMessages.channelId),
      isNull(unreadParentChannels.deletedAt),
    ))
    .leftJoin(unreadParentChannelAgents, and(
      eq(unreadParentChannelAgents.channelId, unreadParentMessages.channelId),
      eq(unreadParentChannelAgents.agentId, agents.id),
    ))
    .leftJoin(
      agentChannelReadCursors,
      and(
        eq(agentChannelReadCursors.channelId, messages.channelId),
        eq(agentChannelReadCursors.agentId, agentId),
      ),
    )
    .where(and(
      ...baseConditions,
      eq(channels.type, "thread"),
      gte(messages.createdAt, threadFollows.createdAt),
      sql`(
        (${unreadParentChannels.type} = 'channel' AND ${agents.serverId} = ${unreadParentChannels.serverId})
        OR ${unreadParentChannelAgents.agentId} IS NOT NULL
      )`,
    ))
    .groupBy(
      messages.channelId,
      channels.name,
      channels.type,
      unreadParentChannels.id,
      unreadParentChannels.name,
      unreadParentChannels.type,
      unreadParentMessages.id,
    );

  const deliverableThreadRows = [];
  for (const row of threadRows) {
    if (await canAgentReceiveChannelDelivery(row.channelId, agentId)) {
      deliverableThreadRows.push(row);
    }
  }

  const rows = [
    ...nonThreadRows.map((row) => ({
      ...row,
      parentChannelId: null as string | null,
      parentChannelName: null as string | null,
      parentChannelType: null as string | null,
      parentMessageId: null as string | null,
    })),
    ...deliverableThreadRows,
  ];

  // Resolve human peer names for DM channels
  const dmChannelIds = rows.flatMap((row) => {
    if (row.channelType === "dm") return [row.channelId];
    if (row.channelType === "thread" && row.parentChannelType === "dm" && row.parentChannelId) return [row.parentChannelId];
    return [];
  });
  const dmPeerNames = new Map<string, string>();
  if (dmChannelIds.length > 0) {
    const peers = await db
      .select({
        channelId: channelHumans.channelId,
        peerName: users.name,
      })
      .from(channelHumans)
      .innerJoin(users, eq(channelHumans.userId, users.id))
      .where(inArray(channelHumans.channelId, dmChannelIds));
    for (const p of peers) {
      dmPeerNames.set(p.channelId, p.peerName);
    }
  }

  const counts: Record<string, number> = {};
  for (const row of rows) {
    let key: string;
    if (row.channelType === "dm") {
      const peerName = dmPeerNames.get(row.channelId) || row.channelName;
      key = `DM:@${peerName}`;
    } else if (row.channelType === "thread" && row.parentChannelName && row.parentMessageId) {
      const shortParentMessageId = row.parentMessageId.slice(0, 8);
      if (row.parentChannelType === "dm") {
        const peerName = row.parentChannelId ? dmPeerNames.get(row.parentChannelId) : undefined;
        key = `DM:@${peerName || row.parentChannelName}:${shortParentMessageId}`;
      } else {
        key = `#${row.parentChannelName}:${shortParentMessageId}`;
      }
    } else {
      key = `#${row.channelName}`;
    }
    counts[key] = row.count;
  }
  return counts;
}
