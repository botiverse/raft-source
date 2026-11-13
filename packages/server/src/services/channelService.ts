import { readSlackBotMentionAuthority } from "./slackBotMentionAuthority";
import { acquireFeatureFlagReadLock, evaluateFeatureFlag } from "./featureFlagService";
import { getComputedJointHumanPublicRowsForScopes, getComputedJointHumanPublicRows, getJointHumanDeliveryRows, resolveJointHumanEntrySql } from "./jointHumanMembershipAccess";
import { assertJointReconnectReady } from "./jointMembershipDeparture";
import { filterJointActiveEntries, filterJointHostSidesEmpty, filterJointPendingRemovalEntries, jointMembershipRemovalPendingSql } from "./jointHumanMembershipAccess";
import { channelActorHasCapability, resolveChannelActorContext, lockComputedJointActor, resolveChannelActorContextsMany, type ChannelActorContext } from "../lib/channelActorPermissions";
import { channelRemovalAudit, isJointMember, jointOfLocalChannel, recordChannelMembershipsEnded, removalActorContext, removalActorUserId, type ChannelRemovalActor } from "./channelMembershipAudit";
import { jointConversationFamilySql, resolveJointHumanMembershipScopes, filterJointHumanMemberEntries } from "./jointHumanMembershipAccess";
import { assertJointUsersLocked, JointActorUnavailableError, lockJointActorFirst, lockJointHumanAdmissionSource, lockJointUsersFirst, lockJointHumanMembershipChannel, prepareJointHumanMembershipMirror, withJointUsersGuessed } from "./jointHumanMembershipMirror";
import { newAuditOperationId, recordIntegrationAuditEvents, serverAuditContextMetadata } from "./integrationAuditService";
import { recordServerConnected, type ServerConnectedMode } from "./jointMemberConnectEffects";
import { recordOrdinaryJointAdmissions } from "./jointAdmissionKind";
import { lockJointLifecycle, lockJointLifecycleOfChannel } from "./jointLifecycleLock";
import { revokeSocketAccess } from "../socket/accessRevocation";
import { beginAgentReadAdvance, noteAgentReadAdvance, noteAgentThreadFollowResumed } from "./agentReadProgressService";
import { createHash, randomInt, randomUUID } from "crypto";
import { performance } from "node:perf_hooks";
import type { QueryResultRow } from "pg";
import { eq, and, isNull, isNotNull, sql, inArray, asc, desc, ne, or, type SQL, type SQLWrapper } from "drizzle-orm";
import { ensureAllChannelHumanRows } from "./allChannelMembership";
import { activeAppBotOrOrdinaryAgent, agentFindableBy, listedServerAgent, type AgentFinder } from "./agentMemberListPolicy";
import { alias, unionAll } from "drizzle-orm/pg-core";
import { getDb, getSqlTraceHash, withDbTraceAttributes, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import type { RemovedMemberEffects } from "./serverService";
import {
  getRisingWaveConnectionTimeoutMillis,
  getRisingWaveInboxItemsServingVersion,
  getRisingWavePool,
  getRisingWavePoolState,
  RisingWaveNotConfiguredError,
  queryRisingWave,
  RISINGWAVE_UNREAD_INBOX_CONTRACT_VERSION,
  UNIFIED_CHAIN_VIEWS,
  CONVERSATION_UNREAD_VIEW,
  withUnifiedChainTransition,
  type UnifiedChainQuery,
  type RisingWavePoolState,
  type RisingWaveInboxItemsServingVersion,
  asRisingWaveOverload,
  isRisingWaveOverloadedError,
  asRisingWaveReadError,
} from "../db/risingwave";
import { isPoolAcquireTimeoutError, observeStatement, recordStatementError } from "../db/statementMetrics";
import {
  getConversationUnreadSourceOverride,
  type ConversationUnreadRow,
  type ConversationUnreadSummaryQuery,
  type SidebarUnreadTotalsQuery,
} from "./conversationUnreadSource";
import { getActivityReadSourceOverride } from "./activityReadSource";
import {
  listSlackPairHeadsForHealth, SLACK_PAIR_HEAD_BATCH_SIZE, slackPairOutboundHold, type SlackPairOutboundHold,
} from "./slackBridgePairQueue";
import { agentLounges, agentMigrationReceiptChannels, agentPrivateSurfaces, channelLastPosts, channelLastPostsBackfill, channels, channelAgents, channelHumans, dmChannelIdentities, agents, users, serverMembers, messages, userChannelReadCursors, userChannelInboxStates, userChannelDisplayPrefs, inboxTargetMuteStates, inboxSuppressionStates, agentChannelReadCursors, servers, threadFollows, agentActivityEvents, tasks, taskEvents, jointChannels, jointChannelServers, jointChannelInvites, readMutationAuthorities, channelMembershipRoleEvents, serverAgentMembers, externalMessageAuthorFacts, externalProjectionAvatarArtifacts, externalActorProjections, externalAddressabilityProjections, externalAppInstalls, externalAppRegistrations, externalChannelBindings, channelExternalInvites } from "../db/schema";
import { gt, gte, lt, not } from "drizzle-orm";
import { AgentLoungeImmutableError, AgentLoungeOutsiderError, isAgentLoungeChannel, isLoungeOutsiderAgent, loungeSummariesForAgents, notAgentLoungeChannel } from "./agentLoungeService";
import { acquireServerAdmissionLocks, acquireServerLock, getHistoryCutoff, getServerPlan, JOINT_HOST_LOCK_NAMESPACE, isChannelReadOnlyByBillingFeature, lockServerResourceInTransaction, withServerLock, withServerResourceLock } from "./planService";
import { HISTORY_PREVIEW_CHARS, historyLimitedPreview } from "./historyPreview";
import { assertCanUnarchiveExternalChannel, assertJointParticipantCanConnect } from "./externalChannelLimitService";
import { reconcileExternalFreezesForChannel, reconcileExternalFreezesForJointConnect, reconcileServerExternalFreeze, reconcileServerExternalFreezes } from "./externalChannelFreezeService";
import { assertFreeHostCanConnectFirstServer, assertJointAdmission, type ReleasingGuest, freeServerIds, preflightFreeHostJointCapacity, reconcileJointOverLimit, reconcileJointOverLimitFor, refreshJointEntitlementsBeforeAdmission } from "./jointChannelLimitService";
import { getJointLimitStatesForJoints, resolveParentJointId } from "./jointChannelLimitState";
import { getExternalFreezeAtForChannels } from "./externalChannelFreezeState";
import { DEPRECATED_GRAVATAR_HASH, asServerId, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, MAX_JOINT_CHANNEL_SERVERS, PLAN_CONFIG, activityMuteSupportedFor, currentDate, currentTimeMs, formatInboxScopeCorruptionLine, getEffectiveLimits, makeInboxScopeReadFrontier, type AgentActivity, type InboxScopeCursorCorruption, type InboxScopeReadFrontier, type ServerId, type ServerPlan, type TraceAttributes, type TrajectoryEntry, CHANNEL_MANAGEMENT_CAPABILITIES, canAddChannelMembers, canGuestPostToChannel, canGuestReadChannel, channelSupportsRoles, getChannelAdminBasis, hasEffectiveChannelCapability, type ChannelRole, type ServerRole } from "@botiverse/raft-shared";
import { actorRoleHasServerCapability } from "../lib/actorPermissions";
import { channelTypeSupportsThreadSort, type ChannelThreadSort, RAFT_TASK_REF_SEPARATOR, formatDmPeerRef, formatRaftChannelTaskRef, isSubConversationType, parseDmPeerRef, type DmPeerKind, type MarkUnreadOutcome } from "@botiverse/raft-shared";
import { DmTargetResolutionError } from "./dmTargetResolutionError";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace";
import { MESSAGE_SHORT_ID_RE, uuidShortIdRange } from "../lib/messageId";
import { createConcurrencyLimiter } from "../lib/mapWithConcurrency";
import { sqlUuidOrNull } from "../db/sqlUuid";
import { addTraceEvent, errorClassOf } from "../tracing/semanticTrace";
import { queryFailureReason, queryFailureTraceAttrs } from "../tracing/queryTrace";
import {
  risingWaveInboxFailureAttrs,
  type RisingWaveInboxTraceRoute,
} from "../tracing/risingWaveInboxTrace";
import { sendJointChannelInviteEmail } from "./emailService";
import { normalizeEmail } from "./emailNormalization";
import {
  isSubConversationInboxKind,
  mapInboxPolicyRowsToItems,
  selectInboxPolicyActiveUnreadCount,
  selectInboxPolicyPageRows,
  type InboxPolicySqlRow,
} from "./inboxPolicyModel";
import { legacyDoneFrontierFallbacksTotal } from "../metrics";
import {
  executeCompatibilityReadMutation,
  isReadMutationFenceRefusal,
  raiseReadPositionForJoin,
  resolveReadMutationUnreadBoundary,
  type ReadMutationAck,
} from "./readMutationSequencer";
import { activityPromotionAllowedByMuteSql, isActivityPromotionSuppressedByMute } from "./inboxMutePolicy";
import { taskConversationUnreadMessageSql } from "./inboxUnreadEligibility";
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
} from "./inboxSuppressionWriters";
import { emitAppFacingNotificationEvent } from "./appNotificationDeliveryService";
import { isAppId } from "./rapRegistry";
import {
  AGENT_REMINDERS_DM_PEER,
  getAgentPrivateSurfaceChannelId,
  getAgentPrivateSurfaceKind,
  isAgentPrivateSurfaceChannel,
} from "./agentPrivateSurfaces";
import {
  getBuiltInConversationChannel,
  listInstalledApps as listInstalledRapApps,
} from "./rapRegistryStore";
import { withChannelWriterFence, assertChannelWritableInTransaction } from "./channelConversionFenceService";
import { announceJointInvitesChanged, announceJointInvitesForJoints, coalesceListChanges } from "./listChangedRealtime";
import { ActionCardConversionFrozenError, assertActionCardWritableInTransaction } from "./actionCardConversionService";

interface ChannelServiceOptions {
  executor?: DatabaseExecutor;
  actionCardMessageId?: string;
  actionCardConfirmationVersion?: number;
}

/**
 * The action-card gate for a member add, scoped to the channel's server: a card
 * of another server is refused as if it did not exist. A missing channel scopes
 * to no server, so it is refused the same way.
 */
async function assertChannelActionCardWritable(
  executor: DatabaseExecutor,
  channelId: string,
  options: ChannelServiceOptions,
): Promise<void> {
  if (!options.actionCardMessageId) return;
  const [channel] = await executor.select({ serverId: channels.serverId }).from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!channel) throw new ActionCardConversionFrozenError();
  await assertActionCardWritableInTransaction(executor, channel.serverId, options.actionCardMessageId, options.actionCardConfirmationVersion);
}

export type JointChannelInviteValidationCode =
  | "joint_target_server_invalid"
  | "joint_invitee_unavailable"
  | "joint_invite_required"
  | "joint_invite_limit_exceeded";

export class JointChannelInviteValidationError extends Error {
  readonly code: JointChannelInviteValidationCode;
  readonly targetServerSlug?: string;
  readonly invitee?: string;
  readonly inviteeIndex?: number;

  constructor(
    message: string,
    code: JointChannelInviteValidationCode,
    details: { targetServerSlug?: string; invitee?: string; inviteeIndex?: number } = {},
  ) {
    super(message);
    this.name = "JointChannelInviteValidationError";
    this.code = code;
    this.targetServerSlug = details.targetServerSlug;
    this.invitee = details.invitee;
    this.inviteeIndex = details.inviteeIndex;
  }
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
  /**
   * Contract v0.3 §18.8: set while the parent joint is over its free-server
   * cap. Before this time the joint is in its grace period; at or after it the
   * joint is read-only (`jointBillingLocked`). Null when within the cap.
   */
  jointOverLimitGraceEndsAt?: string | null;
  /**
   * The viewing server's external channel freeze, on its external channels
   * (ordinary ones too): from this time its side of the channel is
   * read-only; before it the server is over the free plan's limit and will
   * be. Null otherwise.
   */
  externalFreezeAt?: string | null;
};

export type ExternalBridgeMetadata = {
  bridge?: {
    provider: "slack";
    providerConversationId: string;
    state: "active" | "paused" | "quarantined";
    /** Why sync stopped; present only while the binding is not active
     *  (e.g. the legacy `raft_privacy_mismatch` pause reason). */
    stateReason?: string;
    /** Present only while Raft messages for Slack are held: `waiting` is a
     *  pair-level block with its actionable hint; `stalled` is a head message
     *  that needs an admin retry. `since` is when it started. */
    outbound?: SlackPairOutboundHold;
    /** The Slack installation's state, present only while it is not active
     *  (e.g. `reauth_required`): no pair of that installation syncs then. */
    installState?: Exclude<typeof externalAppInstalls.$inferSelect["state"], "active">;
  };
};

export type ChannelExternalMember = {
  id: string;
  provider: "slack";
  displayName: string;
  handles: string[];
  actorKind: "human" | "guest" | "remote" | "bot" | "unknown";
  /** A display-only external participant is not a selectable mention target. */
  mentionable?: boolean;
  avatarUrl: string | null;
  /** Slack workspace display name for the external-identity panel
   *  ("from <workspace>" line). Provider-side ids stay server-side — the
   *  production-composition test forbids them on this endpoint. */
  workspaceName: string | null;
};

export type JointServerMetadata = {
  serverId: string;
  serverName: string;
  serverSlug: string;
  role: "host" | "participant" | null;
  status: "active" | "pending";
  isCurrentServer?: boolean;
  /** Whether the joint's free-server cap counts this server as free. */
  plan: "free" | "paid";
  /**
   * Active servers only: the joint's channel name on that server. Names are
   * per server, so a ref another server's member wrote (`#their-name:#7`)
   * maps to the reader's channel through this (task v2 refs).
   */
  channelName?: string;
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

/**
 * A joint sub-conversation projection: a thread (parent = a message) or a
 * task conversation (parent = a task, task v2). The local face lives in one
 * server under its local parent channel; messages live only in the canonical
 * row. Exactly one of canonicalParentMessageId / canonicalParentTaskId is set.
 */
export type JointThreadProjection = {
  jointThreadId: string;
  localThreadChannelId: string;
  canonicalThreadChannelId: string;
  localServerId: string;
  localParentChannelId: string;
  canonicalParentChannelId: string;
  kind: "thread" | "task";
  canonicalParentMessageId: string | null;
  canonicalParentTaskId: string | null;
  role: "host" | "participant";
  threadChannel: typeof channels.$inferSelect;
};

const REGULAR_CHANNEL_TYPES: RegularChannelType[] = ["channel", "private"];
export const LISTABLE_CHANNEL_TYPES: ListableChannelType[] = ["channel", "private", "joint"];
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

/**
 * The archived joint channels a host owner/admin sees without being in them:
 * the host's own copy whose host side is empty, as when
 * it was archived because the host side emptied (jointHostSideArchive.ts). It
 * stays in the host's archived list so a host owner/admin can bring it back
 * (POST /channels/:id/unarchive rejoins them; channelActorHasCapability).
 * Never a Guest, a partner's copy, or a joint the host still has members in.
 */
async function hostRecoverableArchivedJointIds(
  serverId: string,
  serverRole: ServerRole | null,
  rows: readonly { id: string; type: string; archivedAt: Date | null }[],
  executor: DatabaseExecutor = getDb(),
): Promise<Set<string>> {
  const recoverable = new Set<string>();
  if (serverRole !== "owner" && serverRole !== "admin") return recoverable;
  const ids = rows.filter((row) => row.type === "joint" && row.archivedAt !== null).map((row) => row.id);
  if (ids.length === 0) return recoverable;
  const hostScopes = [...(await resolveJointHumanMembershipScopes({ localChannelIds: ids, serverId: asServerId(serverId) }, executor)).values()]
    .filter((scope) => scope.entryServerId === scope.hostServerId);
  const active = await filterJointActiveEntries(hostScopes, executor);
  const empty = await filterJointHostSidesEmpty(hostScopes.map((scope) => scope.jointId), executor);
  for (const scope of hostScopes) {
    if (active.has(scope.localChannelId) && empty.has(scope.jointId)) recoverable.add(scope.localChannelId);
  }
  return recoverable;
}

async function resolveHumanServerRole(
  serverId: string,
  userId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<ServerRole | null> {
  const [membership] = await executor
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);
  return membership?.role ?? null;
}

/**
 * The one channel a Guest belongs to on this server (server_members
 * .guest_channel_id), or null: not a Guest, or a legacy Guest with no binding,
 * which reads nothing (#wg-rbac:#15). No rollout flag is involved.
 */
export async function getGuestChannelId(
  serverId: string,
  userId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<string | null> {
  const [membership] = await executor
    .select({ guestChannelId: serverMembers.guestChannelId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId), eq(serverMembers.role, "guest")))
    .limit(1);
  return membership?.guestChannelId ?? null;
}

/** A Guest's bound channel as a viewer may see it (matrix §1 "Guest in #x"). */
export interface VisibleGuestChannel {
  id: string;
  name: string;
}

/**
 * The bound channel of each listed Guest, kept only where `viewerId` may read
 * that channel (filterUserAccessibleChannelIds), so a private channel's name
 * never reaches someone outside it. Non-guests and hidden channels are absent.
 */
export async function resolveVisibleGuestChannels(
  serverId: string,
  viewerId: string,
  userIds: readonly string[],
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, VisibleGuestChannel>> {
  const result = new Map<string, VisibleGuestChannel>();
  if (userIds.length === 0) return result;
  const rows = await executor
    .select({ userId: serverMembers.userId, channelId: channels.id, name: channels.name })
    .from(serverMembers)
    .innerJoin(channels, eq(channels.id, serverMembers.guestChannelId))
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.role, "guest"),
      inArray(serverMembers.userId, [...new Set(userIds)]),
    ));
  if (rows.length === 0) return result;
  const visible = await filterUserAccessibleChannelIds(
    [...new Set(rows.map((row) => row.channelId))], viewerId, asServerId(serverId), { executor },
  );
  for (const row of rows) {
    if (visible.has(row.channelId)) result.set(row.userId, { id: row.channelId, name: row.name });
  }
  return result;
}

/** `rows` with `guestChannel` set: the visible bound channel for a Guest, else null. */
export async function withVisibleGuestChannels<T extends { userId: string; role: string | null }>(
  serverId: string,
  viewerId: string,
  rows: readonly T[],
): Promise<Array<T & { guestChannel: VisibleGuestChannel | null }>> {
  const guestIds = rows.filter((row) => row.role === "guest").map((row) => row.userId);
  const channelsByGuest = await resolveVisibleGuestChannels(serverId, viewerId, guestIds);
  return rows.map((row) => ({ ...row, guestChannel: channelsByGuest.get(row.userId) ?? null }));
}

export async function createChannel(
  serverId: string,
  name: string,
  description?: string,
  type: ListableChannelType = "channel",
  options: ChannelServiceOptions & { type?: "user" | "agent"; id?: string; initialUserIds?: readonly string[]; initialAgentIds?: readonly string[] } = {},
) {
  const creator = options.type && options.id ? { ...options, type: options.type, id: options.id } : undefined;
  const apply = async (tx: DatabaseExecutor) => {
    if (options.actionCardMessageId) {
      await assertActionCardWritableInTransaction(tx, serverId, options.actionCardMessageId, options.actionCardConfirmationVersion);
    }
    const channel = await createChannelWithExecutor(tx, serverId, name, description, type);
    if (creator && type !== "joint") {
      if (creator.type === "user") {
        // read-position: new conversation, no history before this join (no row = position 0)
        await tx.insert(channelHumans).values({
          channelId: channel.id,
          userId: creator.id,
          role: "admin",
        });
      } else {
        // read-position: new conversation, no history before this join (no row = position 0)
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
        // read-position: new conversation, no history before this join (no row = position 0)
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
        // read-position: new conversation, no history before this join (no row = position 0)
        await tx.insert(channelAgents).values(initialAgentIds.map((agentId) => ({
          channelId: channel.id,
          agentId,
          role: "member" as const,
        })));
      }
    }
    return channel;
  };
  if (options.executor) return apply(options.executor);
  return withServerLock(serverId, 3, apply);
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
      .where(and(eq(channels.serverId, serverId), inArray(channels.type, REGULAR_CHANNEL_TYPES), isNull(channels.deletedAt), notAgentLoungeChannel(channels.id)));
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
  /**
   * The inviter confirmed connecting directly as admin of both servers
   * (RFC 075 §4.5). Only takes effect for the inviter's own invite on this
   * target; authority is re-checked server-side, never taken from this flag.
   */
  sameAdmin?: boolean;
}

export type JointInviteAcceptedVia = "invitee" | "same_admin";

type JointInvitee = {
  userId: string;
  email: string;
  name: string;
  displayName: string | null;
  role: "owner" | "admin";
};

/** The creation and its same-admin accepts (each its own transaction): one joint-invites:changed per invitee. */
export function createJointChannel(input: CreateJointChannelInput) {
  return coalesceListChanges(() => createJointChannelUncoalesced(input));
}

async function createJointChannelUncoalesced(input: CreateJointChannelInput) {
  const inviteRequests = normalizeJointInviteRequests(input);
  const db = getDb();
  const now = input.now ?? currentDate();
  // §18.11 item 5: refresh entitlements before taking any lock.
  const preResolvedTargets = [];
  for (const inviteRequest of inviteRequests) {
    preResolvedTargets.push((await getJointInviteTargetServer(db, inviteRequest.targetServerSlug, input.hostServerId)).id);
  }
  await refreshJointEntitlementsBeforeAdmission(null, [input.hostServerId, ...preResolvedTargets], now);
  // A joint nobody has joined yet does not use the free host's slot, so
  // creating is not capped; the invites it sends are. Answer now rather than
  // when an invitee accepts (that accept is the authoritative check).
  await preflightFreeHostJointCapacity(input.hostServerId, now, { audience: "host" });

  // The users rows this creation names (the creator, the initial members, the
  // invitees), first (lockJointUsersFirst), before the host's lock and every
  // server, member and J lock: an FK check taking a person's row only at the
  // insert closes a cycle with their account deletion (users row FOR UPDATE,
  // then the servers they own; the invitees own or administer the targets).
  // The invitees are guessed unlocked and resolved again under the locks; a
  // set that grew restarts the transaction, so no users row is taken late.
  let result!: Awaited<ReturnType<typeof createJointChannelInTransaction>>;
  for (let attempt = 0; ; attempt += 1) {
    const guessedInvitees = await guessJointInviteeIds(db, input.hostServerId, inviteRequests);
    try {
      result = await db.transaction((tx) => createJointChannelInTransaction(tx, input, inviteRequests, guessedInvitees, now));
      break;
    } catch (err) {
      if (!(err instanceof JointCreationInviteesChanged)) throw err;
      if (attempt >= 2) throw new Error("The invited people changed while the channel was created; try again");
    }
  }

  const sameAdmin = await acceptSameAdminJointInvites(result.invites, result.sameAdminInviteIds, input.createdByUserId, result.creatorGeneration);
  return { channel: result.channel, jointChannel: result.jointChannel, ...sameAdmin };
}

/** createJointChannel's invitees resolved under its locks include someone its users lock did not take: restart. */
class JointCreationInviteesChanged extends Error {}

/** The invitees createJointChannel will resolve, read without a lock (an unresolvable request guesses none: refused under the locks). */
async function guessJointInviteeIds(db: DatabaseExecutor, hostServerId: string, inviteRequests: JointInviteRequest[]): Promise<string[]> {
  const ids: string[] = [];
  for (const inviteRequest of inviteRequests) {
    try {
      const targetServer = await getJointInviteTargetServer(db, inviteRequest.targetServerSlug, hostServerId);
      const invitees = await resolveJointInvitees(db, targetServer.id, inviteRequest.invitedPeople, inviteRequest.targetServerSlug);
      ids.push(...invitees.map((invitee) => invitee.userId));
    } catch (err) {
      if (!(err instanceof JointChannelInviteValidationError)) throw err;
    }
  }
  return ids;
}

async function createJointChannelInTransaction(
  tx: DatabaseTransaction,
  input: CreateJointChannelInput,
  inviteRequests: JointInviteRequest[],
  guessedInvitees: readonly string[],
  now: Date,
) {
  const lockedUserIds = new Set([input.createdByUserId, ...(input.userIds ?? []), ...guessedInvitees]);
  // The creator retired or being deleted: refused (JointActorUnavailableError; the route answers as a creator who may not federate).
  await lockJointUsersFirst(tx, { actorUserId: input.createdByUserId, userIds: [...lockedUserIds] });
  await acquireServerLock(tx, input.hostServerId, 3);
  const resolvedInviteRequests = [];
  for (const inviteRequest of inviteRequests) {
    const targetServer = await getJointInviteTargetServer(tx, inviteRequest.targetServerSlug, input.hostServerId);
    const invitees = await resolveJointInvitees(tx, targetServer.id, inviteRequest.invitedPeople, inviteRequest.targetServerSlug);
    if (invitees.some((invitee) => !lockedUserIds.has(invitee.userId))) throw new JointCreationInviteesChanged();
    resolvedInviteRequests.push({ targetServer, invitees, sameAdmin: inviteRequest.sameAdmin === true });
  }
  // Contract v0.3 §18.6/§18.7: the new joint must fit the server and
  // free-server caps with every invited target counted.
  await assertJointAdmission(tx, null, {
    kind: "invite",
    targetServerIds: [input.hostServerId, ...resolvedInviteRequests.map((request) => request.targetServer.id)],
    hostServerId: input.hostServerId,
  }, now);

  await lockJointHumanAdmissionSource(tx, input.hostServerId, [input.createdByUserId, ...(input.userIds ?? [])]);
  const storageNamespaceId = await ensureJointStorageNamespace(tx, input.createdByUserId);
  const storageChannel = await createJointStorageChannelWithExecutor(tx, storageNamespaceId);
  const channel = await createChannelWithExecutor(tx, input.hostServerId, input.name, input.description, "joint");
  // read-position: new conversation, no history before this join (no row = position 0)
  await tx.insert(channelHumans)
    .values([
      { channelId: channel.id, userId: input.createdByUserId },
      ...(input.userIds ?? []).map((userId) => ({ channelId: channel.id, userId })),
    ])
    .onConflictDoNothing();
  if (input.agentIds?.length) {
    // read-position: new conversation, no history before this join (no row = position 0)
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

  // New J is not visible before this transaction commits. Its source FK
  // exists now; never insert admissions before creating the projection.
  const mirrorHumans = await prepareJointHumanMembershipMirror(tx, { channelIds: [channel.id] }, "join");
  // The creator admitted everyone this creation adds, themselves included.
  await mirrorHumans.apply(undefined, { actorUserId: input.createdByUserId });
  // The creator's membership as this creation wrote it: the servers this
  // same operation connects for them (same-admin) are sources of exactly it.
  const creatorGeneration = (await tx.execute<{ generation: number }>(sql`SELECT generation FROM joint_channel_members
    WHERE joint_channel_id=${joint.id}::uuid AND user_id=${input.createdByUserId}::uuid`)).rows.map((row) => Number(row.generation))[0];

  const invites = [];
  const sameAdminInviteIds = new Set<string>();
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
      if (inviteRequest.sameAdmin && invitee.userId === input.createdByUserId) {
        sameAdminInviteIds.add(invite.id);
      }
    }
  }

  return { channel, jointChannel: joint, invites, sameAdminInviteIds, creatorGeneration };
}

/** The target server's projection created by a same-admin accept. */
export type SameAdminAcceptedProjection = Awaited<ReturnType<typeof acceptJointChannelInvite>>;

/**
 * RFC 075 §4.5: when the inviter is also the invitee (an owner/admin of the
 * target, already enforced by resolveJointInvitees and re-checked under the
 * target lock by acceptJointChannelInvite), accept in the same request instead
 * of emailing the inviter a link to themselves. Runs after the invite
 * transaction commits so it takes the target server lock on its own, the same
 * way a link accept does. An accept that fails (e.g. the joint hit a limit in
 * between) falls back to the email flow, so the invite is never left silent.
 *
 * `creationGeneration`: these accepts are part of the joint's creation (the
 * creator's membership generation that creation wrote). Each
 * target that connects is a source of that membership, if it still is the
 * creator's current one. A later invite on a shared channel passes none.
 */
let sameAdminAcceptBarrier: ((inviteId: string) => Promise<void>) | null = null;
/** Tests only: runs before each same-admin accept of a joint's creation (after the creation committed). */
export function __setSameAdminAcceptBarrierForTests(barrier: ((inviteId: string) => Promise<void>) | null): void {
  sameAdminAcceptBarrier = barrier;
}

async function acceptSameAdminJointInvites<T extends { id: string; toServerId: string }>(
  invites: T[],
  sameAdminInviteIds: ReadonlySet<string>,
  inviterUserId: string,
  creationGeneration?: number,
) {
  const acceptedProjections: SameAdminAcceptedProjection[] = [];
  const emailInviteIds: string[] = [];
  for (const invite of invites) {
    if (!sameAdminInviteIds.has(invite.id)) {
      emailInviteIds.push(invite.id);
      continue;
    }
    try {
      await sameAdminAcceptBarrier?.(invite.id);
      const channel = await acceptJointChannelInviteWithEntitlements({
        inviteId: invite.id,
        targetServerId: invite.toServerId,
        acceptedByUserId: inviterUserId,
        acceptedVia: "same_admin",
      }, true, { creationGeneration, connectedAuditMode: "same_admin" });
      acceptedProjections.push(channel);
    } catch (err) {
      console.error("[JointChannel] same-admin accept failed; falling back to the invite email:", err);
      emailInviteIds.push(invite.id);
    }
  }
  await sendJointChannelInviteEmails(emailInviteIds);
  const refreshedInvites = acceptedProjections.length > 0
    ? await getDb().select().from(jointChannelInvites).where(inArray(jointChannelInvites.id, invites.map((invite) => invite.id)))
    : [];
  const byId = new Map(refreshedInvites.map((invite) => [invite.id, invite]));
  return {
    invites: invites.map((invite) => byId.get(invite.id) ?? invite),
    acceptedProjections,
  };
}

function normalizeJointInviteRequests(input: Pick<CreateJointChannelInput, "targetServerSlug" | "invitedPeople" | "jointInvites">): JointInviteRequest[] {
  const rawRequests = Array.isArray(input.jointInvites) && input.jointInvites.length > 0
    ? input.jointInvites
    : [{
        targetServerSlug: input.targetServerSlug ?? "",
        invitedPeople: input.invitedPeople ?? [],
      }];
  if (rawRequests.length > MAX_JOINT_CHANNEL_INVITE_TARGETS) {
    throw new JointChannelInviteValidationError(
      `Joint channels support a maximum of ${MAX_JOINT_CHANNEL_SERVERS} servers`,
      "joint_invite_limit_exceeded",
    );
  }
  const byTargetSlug = new Map<string, JointInviteRequest>();

  for (const rawRequest of rawRequests) {
    const targetServerSlug = rawRequest.targetServerSlug.trim();
    if (!targetServerSlug) {
      throw new JointChannelInviteValidationError("Invite server slug is required", "joint_invite_required");
    }
    const invitedPeople = normalizeJointInvitePeople(rawRequest.invitedPeople);
    if (invitedPeople.length === 0) {
      throw new JointChannelInviteValidationError("At least one invited person is required", "joint_invite_required", { targetServerSlug });
    }
    const key = targetServerSlug.toLowerCase();
    const existing = byTargetSlug.get(key);
    if (existing) {
      existing.invitedPeople = normalizeJointInvitePeople([...existing.invitedPeople, ...invitedPeople]);
      existing.sameAdmin = existing.sameAdmin === true || rawRequest.sameAdmin === true;
    } else {
      byTargetSlug.set(key, { targetServerSlug, invitedPeople, sameAdmin: rawRequest.sameAdmin === true });
    }
  }

  if (byTargetSlug.size === 0) {
    throw new JointChannelInviteValidationError("Invite server slug is required", "joint_invite_required");
  }
  return [...byTargetSlug.values()];
}

type InviteServerToJointChannelInput = {
  localChannelId: string;
  fromServerId: string;
  invitedByUserId: string;
  targetServerSlug: string;
  invitedPeople: string[];
  /** See JointInviteRequest.sameAdmin. */
  sameAdmin?: boolean;
};

/** The invites and their same-admin accepts (each its own transaction): one joint-invites:changed per invitee. */
export function inviteServerToJointChannel(input: InviteServerToJointChannelInput) {
  return coalesceListChanges(() => inviteServerToJointChannelUncoalesced(input));
}

async function inviteServerToJointChannelUncoalesced(input: InviteServerToJointChannelInput) {
  const targetSlug = input.targetServerSlug.trim();
  if (!targetSlug) {
    throw new JointChannelInviteValidationError("Invite server slug is required", "joint_invite_required");
  }
  const invitedPeople = normalizeJointInvitePeople(input.invitedPeople);
  if (invitedPeople.length === 0) {
    throw new JointChannelInviteValidationError("At least one invited person is required", "joint_invite_required", { targetServerSlug: targetSlug });
  }

  const now = currentDate();
  const db = getDb();
  const [preProjection] = await db
    .select({ jointChannelId: jointChannelServers.jointChannelId })
    .from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.localChannelId, input.localChannelId),
      eq(jointChannelServers.serverId, input.fromServerId),
      eq(jointChannelServers.status, "active"),
    ));
  if (preProjection) {
    const preTarget = await getJointInviteTargetServer(db, targetSlug, input.fromServerId);
    const preParentJointId = await resolveParentJointId(db, preProjection.jointChannelId) ?? preProjection.jointChannelId;
    await refreshJointEntitlementsBeforeAdmission(preParentJointId, [preTarget.id], now);
    // If no other server has joined yet, accepting this invite would use the
    // host's free slot; reject early when another joint already uses it.
    const [preJoint] = await db
      .select({ hostServerId: jointChannels.createdByServerId })
      .from(jointChannels)
      .where(eq(jointChannels.id, preParentJointId));
    if (preJoint) {
      // Only the host's own admin is told the host's plan (#wg-rbac:#61). Another
      // server inviting means one has joined, which the preflight skips: never refused today.
      await preflightFreeHostJointCapacity(preJoint.hostServerId, now, {
        audience: preJoint.hostServerId === input.fromServerId ? "host" : "outsider",
        excludeJointId: preParentJointId,
      });
    }
  }

  // The users rows the invites name first (lockJointUsersFirst): the inviter
  // (the actor) and the invitees (they own or administer the target), before
  // the host's ns-3 lock and the joint's: an FK check taking one only at the
  // insert closes a cycle with their account deletion (users row FOR UPDATE,
  // then the servers they own). The invitees are guessed unlocked and resolved
  // again under the locks; a set that grew restarts (withJointUsersGuessed).
  const inviteRequest = { targetServerSlug: targetSlug, invitedPeople };
  const result = await withJointUsersGuessed(async () => [input.invitedByUserId, ...await guessJointInviteeIds(db, input.fromServerId, [inviteRequest])], (lockedUserIds) => db.transaction(async (tx) => {
    // The inviter retired or being deleted: refused (JointActorUnavailableError; the route answers as one who may not federate).
    await lockJointUsersFirst(tx, { actorUserId: input.invitedByUserId, userIds: [...lockedUserIds] });
    await lockServerResourceInTransaction(tx, input.fromServerId, 3, input.localChannelId);
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

    await lockJointFederationAuthority(tx,input.localChannelId,input.fromServerId,input.invitedByUserId);
    const targetServer = await getJointInviteTargetServer(tx, targetSlug, input.fromServerId);
    // One lock on the parent joint row serializes invites from every
    // participant server, not just this server's projection (§18.7).
    await assertJointAdmission(tx, await resolveParentJointId(tx, projection.jointChannelId), {
      kind: "invite",
      targetServerIds: [targetServer.id],
    }, now);
    const invitees = await resolveJointInvitees(tx, targetServer.id, invitedPeople, targetSlug);
    assertJointUsersLocked(lockedUserIds, invitees.map((invitee) => invitee.userId));
    const invites = [];
    const sameAdminInviteIds = new Set<string>();
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
      if (input.sameAdmin === true && invitee.userId === input.invitedByUserId) {
        sameAdminInviteIds.add(invite.id);
      }
    }
    return { invites, sameAdminInviteIds };
  }));

  return acceptSameAdminJointInvites(result.invites, result.sameAdminInviteIds, input.invitedByUserId);
}

function normalizeJointInvitePeople(invitedPeople: string[] | undefined): string[] {
  if ((invitedPeople?.length ?? 0) > MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET) {
    throw new JointChannelInviteValidationError(
      `A joint channel invite can include a maximum of ${MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET} invited people per target server`,
      "joint_invite_limit_exceeded",
    );
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
    throw new JointChannelInviteValidationError(
      "Target server not found",
      "joint_target_server_invalid",
      { targetServerSlug },
    );
  }
  if (targetServer.id === fromServerId) {
    throw new JointChannelInviteValidationError(
      "Cannot invite the current server",
      "joint_target_server_invalid",
      { targetServerSlug },
    );
  }
  return targetServer;
}

async function resolveJointInvitees(
  executor: DatabaseExecutor,
  targetServerId: string,
  invitedPeople: string[],
  targetServerSlug: string,
): Promise<JointInvitee[]> {
  const invitees: JointInvitee[] = [];
  const seenUserIds = new Set<string>();
  for (const [inviteeIndex, invitedPerson] of invitedPeople.entries()) {
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
    // One answer whether nobody matches or the match is not an admin: two
    // would let an inviter on another server test whether an email or handle
    // belongs to this server's members. Both come after the same single query.
    if (!invitee || (invitee.role !== "owner" && invitee.role !== "admin")) {
      throw new JointChannelInviteValidationError(
        `Cannot invite ${invitedPerson}: invite an owner or admin of the target server`,
        "joint_invitee_unavailable",
        { targetServerSlug, invitee: invitedPerson, inviteeIndex },
      );
    }
    if (seenUserIds.has(invitee.userId)) continue;
    seenUserIds.add(invitee.userId);
    invitees.push({ ...invitee, role: invitee.role });
  }
  if (invitees.length === 0) {
    throw new JointChannelInviteValidationError(
      "At least one invited person is required",
      "joint_invite_required",
      { targetServerSlug },
    );
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

async function lockJointFederationAuthority(tx: DatabaseExecutor, localChannelId:string, serverId:string, userId:string) {
  await lockJointHumanMembershipChannel(tx,localChannelId);
  await lockComputedJointActor({serverId,channelId:localChannelId,actorType:"user",actorId:userId},tx);
  const scope=(await resolveJointHumanMembershipScopes({localChannelIds:[localChannelId]},tx)).get(localChannelId);
  if (scope) {
    const context=await resolveChannelActorContext(serverId,localChannelId,"user",userId,tx);
    if (!context || !channelActorHasCapability(context,"federateChannels")) throw new Error("Channel capability required");
  }
}

export async function createJointChannelInvite(input: {
  jointChannelId: string;
  fromServerId: string;
  targetServerId: string;
  invitedUserId: string;
  invitedByUserId: string;
  executor?: DatabaseExecutor;
}): Promise<typeof jointChannelInvites.$inferSelect> {
  if (!input.executor) return getDb().transaction(tx=>createJointChannelInvite({...input,executor:tx}));
  const db = input.executor;
  const [source]=await db.select({id:jointChannelServers.localChannelId}).from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId,input.jointChannelId),eq(jointChannelServers.serverId,input.fromServerId)));
  if (!source) throw new Error("Joint channel not found");
  await lockJointFederationAuthority(db,source.id,input.fromServerId,input.invitedByUserId);
  return insertJointChannelInvite(db, input);
}

/**
 * The joint invite an external channel invite connects a server with
 * (#wg-rbac:#16, P2a-3): from the host to `targetServerId`, for the target's
 * owner or admin who connects or approved (`authorizerUserId`). The external
 * invite is the authority for this one connection, so the inviter's current
 * federation capability is not checked; they are recorded as its sender.
 *
 * Inside the caller's transaction, after the target server's admission and
 * ns-3 locks (ADMISSION_LOCK_ORDER in planService). The accept that follows
 * locks, in order, the target's prior local channel, its
 * server and member rows, the joint's membership lock (J), JOINT_HOST and the
 * joint row. Those are taken here first, before the joint invite row is
 * upserted: every other writer of that row (createJointChannelInvite, resend,
 * the invite route's admission) holds J and the joint row before it, so
 * upserting first would close a cycle with them (Cody, real PG). The accept
 * re-takes the same locks re-entrantly.
 */
export async function createExternalConnectJointInvite(tx: DatabaseTransaction, input: {
  jointChannelId: string;
  fromServerId: string;
  targetServerId: string;
  authorizerUserId: string;
  joinerUserId: string;
  inviterUserId: string | null;
}): Promise<typeof jointChannelInvites.$inferSelect> {
  const [prior] = await tx.select({ localChannelId: jointChannelServers.localChannelId }).from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, input.jointChannelId), eq(jointChannelServers.serverId, input.targetServerId)));
  if (prior) await lockJointHumanMembershipChannel(tx, prior.localChannelId);
  await lockJointHumanAdmissionSource(tx, input.targetServerId, [input.authorizerUserId, input.joinerUserId]);
  await prepareJointHumanMembershipMirror(tx, { jointIds: [input.jointChannelId] }, "join");
  const parentJointId = await resolveParentJointId(tx, input.jointChannelId) ?? input.jointChannelId;
  const [joint] = await tx.select({ hostServerId: jointChannels.createdByServerId }).from(jointChannels).where(eq(jointChannels.id, parentJointId));
  if (!joint) throw new Error("Joint channel not found");
  await acquireServerLock(tx, joint.hostServerId, JOINT_HOST_LOCK_NAMESPACE);
  await tx.execute(sql`SELECT ${jointChannels.id} FROM ${jointChannels} WHERE ${jointChannels.id} = ${parentJointId} FOR UPDATE`);
  return insertJointChannelInvite(tx, {
    jointChannelId: input.jointChannelId,
    fromServerId: input.fromServerId,
    targetServerId: input.targetServerId,
    invitedUserId: input.authorizerUserId,
    invitedByUserId: input.inviterUserId,
  });
}

async function insertJointChannelInvite(db: DatabaseExecutor, input: {
  jointChannelId: string;
  fromServerId: string;
  targetServerId: string;
  invitedUserId: string;
  invitedByUserId: string | null;
}): Promise<typeof jointChannelInvites.$inferSelect> {
  const [existing] = await db
    .select()
    .from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.jointChannelId, input.jointChannelId),
      eq(jointChannelServers.serverId, input.targetServerId),
      eq(jointChannelServers.status, "active"),
    ));
  if (existing) {
    throw new JointChannelInviteValidationError(
      "Target server is already in this joint channel",
      "joint_target_server_invalid",
    );
  }

  const [invite] = await db.insert(jointChannelInvites).values({
    jointChannelId: input.jointChannelId,
    fromServerId: input.fromServerId,
    toServerId: input.targetServerId,
    invitedUserId: input.invitedUserId,
    invitedByUserId: input.invitedByUserId,
    expiresAt: new Date(currentTimeMs() + JOINT_CHANNEL_INVITE_TTL_MS),
  }).onConflictDoUpdate({
    target: [jointChannelInvites.jointChannelId, jointChannelInvites.toServerId, jointChannelInvites.invitedUserId],
    targetWhere: sql`status = 'pending'`,
    set: {
      invitedByUserId: input.invitedByUserId,
      expiresAt: new Date(currentTimeMs() + JOINT_CHANNEL_INVITE_TTL_MS),
      createdAt: currentDate(),
    },
  }).returning();
  if (!invite) throw new Error("Joint channel invite not created");
  // Every invite writer comes here, in its transaction: sent once that commits.
  announceJointInvitesChanged([invite]);
  return invite;
}

export async function resendPendingJointChannelInvites(input: {
  localChannelId:string; fromServerId:string; requestedByUserId:string;
  /** Spends the resend's emails (one per pending invitee) before any is sent; a throw rolls the resend back. */
  admitResend?:(people:number)=>Promise<void>;
}) {
  const inviteIds=await getDb().transaction(async tx=>{
    // The resender's users row first (the invites name them as their sender
    // from now on), before the channel and the joint's locks; retired or
    // being deleted (lockJointActorFirst): the neutral refusal.
    await lockJointActorFirst(tx,input.requestedByUserId).catch(unusableActorAsNotFound);
    await lockJointFederationAuthority(tx,input.localChannelId,input.fromServerId,input.requestedByUserId);
    const [projection]=await tx.select({jointId:jointChannelServers.jointChannelId}).from(jointChannelServers)
      .innerJoin(jointChannels,eq(jointChannels.id,jointChannelServers.jointChannelId))
      .where(and(eq(jointChannelServers.localChannelId,input.localChannelId),eq(jointChannelServers.serverId,input.fromServerId),
        eq(jointChannelServers.status,"active"),eq(jointChannels.status,"active")));
    if(!projection) throw new Error("Joint channel not found");
    const rows=await tx.update(jointChannelInvites).set({invitedByUserId:input.requestedByUserId,
      expiresAt:new Date(currentTimeMs()+JOINT_CHANNEL_INVITE_TTL_MS),createdAt:currentDate()})
      .where(and(eq(jointChannelInvites.jointChannelId,projection.jointId),eq(jointChannelInvites.fromServerId,input.fromServerId),
        eq(jointChannelInvites.status,"pending"))).returning({id:jointChannelInvites.id,toServerId:jointChannelInvites.toServerId,invitedUserId:jointChannelInvites.invitedUserId});
    if(!rows.length) throw new Error("No pending joint channel invite found");
    if(input.admitResend) await input.admitResend(rows.length);
    announceJointInvitesChanged(rows);
    return rows.map(row=>row.id);
  });
  await sendJointChannelInviteEmails(inviteIds);
  return {ok:true,resentCount:inviteIds.length};
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
  const now = currentTimeMs();
  return rows.filter((row) => row.expiresAt.getTime() > now);
}

type AcceptJointChannelInviteInput = {
  inviteId: string;
  targetServerId: string;
  /** The invited owner/admin of the target server: authorizes the connection. */
  acceptedByUserId: string;
  /**
   * Who is added to the joint channel on the target server; the accepter when
   * absent. When another person (an external invite's joiner, P2a-3), they
   * must be a current non-guest member of the target, checked under the same
   * member locks as the accepter's role.
   */
  joinerUserId?: string;
  /** Audit only; authority checks are identical for both paths. */
  acceptedVia?: JointInviteAcceptedVia;
};
export function acceptJointChannelInvite(input: AcceptJointChannelInviteInput) {
  return acceptJointChannelInviteWithEntitlements(input,true,{connectedAuditMode:"joint_invite"});
}

/**
 * The host's `servers` row FOR KEY SHARE before the joint's membership lock
 * (J): the accept's `channel.server_connected` audit event references it
 * (server_id), and that foreign key's KEY SHARE taken after J would close a
 * J <-> server cycle with deleteServer (server row FOR UPDATE, then J), as
 * externalInviteConnectService.connectJointChannel takes it.
 */
async function lockJointHostServerBeforeAudit(tx: DatabaseExecutor, hostServerId: string | null): Promise<void> {
  if (hostServerId) await tx.execute(sql`SELECT id FROM servers WHERE id=${hostServerId}::uuid FOR KEY SHARE`);
}

/** The host (created_by_server_id) of the top-level joint of any joint id; null for a missing joint. */
async function jointHostOfJoint(executor: DatabaseExecutor, jointChannelId: string): Promise<string | null> {
  const parentJointId = await resolveParentJointId(executor, jointChannelId) ?? jointChannelId;
  const [row] = await executor.select({ hostServerId: jointChannels.createdByServerId }).from(jointChannels).where(eq(jointChannels.id, parentJointId));
  return row?.hostServerId ?? null;
}

/** A joint channel archived (its archive is shared by every active projection): no server joins it. */
export class JointChannelArchivedError extends Error {
  readonly code = "channel_archived";
  constructor() {
    super("This channel is archived");
    this.name = "JointChannelArchivedError";
  }
}

/**
 * Under the joint's lifecycle lock (which archive/unarchive hold while they
 * write): the joint is not archived. Read after the lock, so an archive that
 * committed while this waited, or before it started, refuses the connection.
 */
async function assertJointOpenUnderLifecycle(tx: DatabaseExecutor, jointChannelId: string): Promise<void> {
  const [archived] = await tx.select({ id: channels.id }).from(jointChannelServers)
    .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
    .where(and(eq(jointChannelServers.jointChannelId, jointChannelId), eq(jointChannelServers.status, "active"), isNotNull(channels.archivedAt)))
    .limit(1);
  if (archived) throw new JointChannelArchivedError();
}

/** Why an accept refused the people it names (authorizer's role, joiner's membership). */
/** A same-admin accept of a joint's creation after the creator left, or left and rejoined another way: refused, nothing written. */
export class JointCreationMembershipChangedError extends Error {
  readonly code = "membership_changed";
  constructor() {
    super("The creator's membership changed since the channel was created");
    this.name = "JointCreationMembershipChangedError";
  }
}

export class JointInviteAccepterError extends Error {
  constructor(readonly code: "authorizer_not_admin" | "joiner_not_member", message: string) {
    super(message);
    this.name = "JointInviteAccepterError";
  }
}

/**
 * Accept inside the caller's open transaction (an external invite's
 * connection, P2a-3), with the authorizer and the joiner named apart: the
 * accept's own transaction becomes a savepoint on the caller's (db/index
 * scopeTransactions), so its writes commit or roll back with the caller's.
 * Every check and write is the ordinary accept's; the caller refreshes
 * entitlements before its transaction (refreshJointEntitlementsBeforeAdmission)
 * and owes the post-commit effects and the `channel.server_connected` audit
 * event (recordServerConnected, in its transaction).
 */
export function acceptJointChannelInviteInCallerTransaction(
  input: AcceptJointChannelInviteInput & { joinerUserId: string },
  /** A self_connect whose actor's host Guest seat the caller ends in this commit: the cap counts the two once (ReleasingGuest). */
  options: { releasingGuest?: ReleasingGuest } = {},
) {
  return acceptJointChannelInviteWithEntitlements(input, false, options);
}

async function acceptJointChannelInviteWithEntitlements(
  input: AcceptJointChannelInviteInput,
  refreshEntitlements: boolean,
  /** A batch accept has reconciled every server's external channel freeze already, before any joint row lock. */
  options: {
    externalFreezesReconciled?: boolean;
    creationGeneration?: number;
    releasingGuest?: ReleasingGuest;
    /**
     * A joint invite's own accept: this accept writes the `channel.server_connected`
     * audit event when it connects the server. Absent inside an external
     * connect's transaction, whose caller writes it.
     */
    connectedAuditMode?: Extract<ServerConnectedMode, "joint_invite" | "same_admin">;
  } = {},
) {
  const acceptedVia: JointInviteAcceptedVia = input.acceptedVia ?? "invitee";
  const joinerUserId = input.joinerUserId ?? input.acceptedByUserId;
  assertJointChannelInviteId(input.inviteId);
  const now = currentDate();
  const [preInvite] = await getDb()
    .select({ jointChannelId: jointChannelInvites.jointChannelId })
    .from(jointChannelInvites)
    .where(eq(jointChannelInvites.id, input.inviteId));
  if (preInvite && refreshEntitlements) {
    await refreshJointEntitlementsBeforeAdmission(
      await resolveParentJointId(getDb(), preInvite.jointChannelId),
      [input.targetServerId],
      now,
    );
  }
  // Unlocked, only to know whose admission lock to take; re-checked under it.
  const preHostServerId = preInvite ? await jointHostOfJoint(getDb(), preInvite.jointChannelId) : null;
  return getDb().transaction(async (tx) => {
    // ADMISSION_LOCK_ORDER (planService): the connecting server's and the
    // joint's host's admission locks first (the connecting server's
    // one-external-channel rule; both their external channel freezes), then
    // the connecting server's ns-3 lock. Re-entrant when a batch accept or an
    // external connect already holds them.
    await acquireServerAdmissionLocks(tx, preHostServerId ? [input.targetServerId, preHostServerId] : [input.targetServerId]);
    await acquireServerLock(tx, input.targetServerId, 3);
    // Unlocked, only to find which joint's lifecycle lock to take. Everything
    // this accept uses is read below, under that lock (Cody f294a013): a
    // metadata fan-out, an archive or a delete that committed while this
    // waited is what the new projection is built from or refused on.
    const [located] = await tx.select({ jointChannelId: jointChannelInvites.jointChannelId }).from(jointChannelInvites)
      .where(eq(jointChannelInvites.id, input.inviteId));
    if (!located) throw new Error("Joint channel invite not found");
    // After the ns-3 lock, before any channel row: archive/unarchive and the
    // metadata fan-out of the joint serialize with this new projection
    // (jointLifecycleLock.ts).
    await lockJointLifecycle(tx, located.jointChannelId);
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
        eq(jointChannelInvites.jointChannelId, located.jointChannelId),
        eq(jointChannelInvites.toServerId, input.targetServerId),
        eq(jointChannelInvites.invitedUserId, input.acceptedByUserId),
        eq(jointChannelInvites.status, "pending"),
        eq(jointChannels.status, "active"),
        isNull(displayChannel.deletedAt),
      ));
    if (!invite) {
      throw new Error("Joint channel invite not found");
    }
    // Time after the locks.
    if (invite.expiresAt.getTime() <= currentTimeMs()) {
      await tx.update(jointChannelInvites)
        .set({ status: "expired" })
        .where(eq(jointChannelInvites.id, input.inviteId));
      throw new Error("Joint channel invite expired");
    }
    // Sent only if this accept commits (afterAmbientCommit): the invitee's list loses it.
    announceJointInvitesChanged([invite]);
    await assertJointOpenUnderLifecycle(tx, invite.jointChannelId);
    const [priorProjection] = await tx
      .select({ localChannelId: jointChannelServers.localChannelId, status: jointChannelServers.status })
      .from(jointChannelServers)
      .where(and(
        eq(jointChannelServers.jointChannelId, invite.jointChannelId),
        eq(jointChannelServers.serverId, input.targetServerId),
      ));
    const existingProjection = priorProjection?.status === "active" ? priorProjection : undefined;
    if (priorProjection) await lockJointHumanMembershipChannel(tx, priorProjection.localChannelId);
    await lockJointHumanAdmissionSource(tx, input.targetServerId, [input.acceptedByUserId, joinerUserId]);
    const [acceptingMember] = await tx
      .select({ role: serverMembers.role })
      .from(serverMembers)
      .where(and(
        eq(serverMembers.serverId, input.targetServerId),
        eq(serverMembers.userId, input.acceptedByUserId),
      ));
    if (!acceptingMember || (acceptingMember.role !== "owner" && acceptingMember.role !== "admin")) {
      throw new JointInviteAccepterError("authorizer_not_admin", "Only target server admins can accept joint channel invites");
    }
    if (joinerUserId !== input.acceptedByUserId) {
      const [joiningMember] = await tx
        .select({ role: serverMembers.role })
        .from(serverMembers)
        .where(and(
          eq(serverMembers.serverId, input.targetServerId),
          eq(serverMembers.userId, joinerUserId),
        ));
      if (!joiningMember || joiningMember.role === "guest") {
        throw new JointInviteAccepterError("joiner_not_member", "The person joining is no longer a member of the target server");
      }
    }

    if (options.connectedAuditMode) await lockJointHostServerBeforeAudit(tx, preHostServerId);
    // Before the capacity check's joint-row lock as well as before CH writes.
    await prepareJointHumanMembershipMirror(tx, { jointIds: [invite.jointChannelId] }, "join");
    const existingMember = await tx.execute(sql`SELECT 1 FROM joint_channel_members
      WHERE joint_channel_id=${invite.jointChannelId}::uuid AND user_id=${joinerUserId}::uuid`);
    const alreadyJoined = existingMember.rows.length>0;
    // Part of the joint's creation: only while the creator still holds the
    // membership that creation wrote (under the J lock, before any write).
    // Left since, or left and rejoined another way: refused, nothing written
    // (the same-admin caller falls back to the invite email).
    if (options.creationGeneration !== undefined) {
      const [current] = (await tx.execute<{ generation: number }>(sql`SELECT generation FROM joint_channel_members
        WHERE joint_channel_id=${invite.jointChannelId}::uuid AND user_id=${joinerUserId}::uuid FOR UPDATE`)).rows;
      if (!current || Number(current.generation) !== options.creationGeneration) throw new JointCreationMembershipChangedError();
    }
    // Part of the joint's creation (same-admin at create): this server is a
    // source of the membership that creation wrote, only while it is still
    // the joiner's current one (under the J and member locks above).
    const recordCreationSource = async () => {
      if (options.creationGeneration === undefined) return;
      await recordOrdinaryJointAdmissions(tx, sql`SELECT m.joint_channel_id,m.user_id,${input.targetServerId}::uuid AS server_id,m.generation,
          now() AS admitted_at,${input.acceptedByUserId}::uuid AS admitted_by
        FROM joint_channel_members m
        WHERE m.joint_channel_id=${invite.jointChannelId}::uuid AND m.user_id=${joinerUserId}::uuid AND m.generation=${options.creationGeneration}`);
    };
    await assertJointReconnectReady(tx, invite.jointChannelId, input.targetServerId);
    if (existingProjection) {
      const joined = alreadyJoined ? [] : await tx.insert(channelHumans)
        .values({ channelId: existingProjection.localChannelId, userId: joinerUserId })
        .onConflictDoNothing()
        .returning({ userId: channelHumans.userId });
      if (joined.length > 0) {
        await startReadPositionAtJoin(tx, "human", joinerUserId, existingProjection.localChannelId);
      }
      await tx.update(jointChannelInvites)
        .set({
          status: "accepted",
          acceptedByUserId: input.acceptedByUserId,
          acceptedAt: currentDate(),
          acceptedVia,
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
      const mirrorExisting = await prepareJointHumanMembershipMirror(tx, { channelIds: [existingProjection.localChannelId] }, "join");
      await mirrorExisting.apply([joinerUserId], { actorUserId: input.acceptedByUserId });
      await recordCreationSource();
      return existingChannel;
    }

    const parentJointId = await resolveParentJointId(tx, invite.jointChannelId);
    // The host whose admission lock was taken (it never changes; a joint
    // found missing before the transaction has none to compare).
    if (await jointHostOfJoint(tx, invite.jointChannelId) !== preHostServerId) throw new Error("Joint channel invite not found");
    // ADMISSION_LOCK_ORDER rule 4: the free plan's external channel freeze
    // rows before JOINT_HOST and the joint row lock below, counting the joint
    // as connected (the projection is written after those checks).
    if (!options.externalFreezesReconciled) {
      await reconcileExternalFreezesForJointConnect(tx, {
        parentJointId: parentJointId ?? invite.jointChannelId,
        connectingServerIds: [input.targetServerId],
        now,
      });
    }
    // The first other server to connect makes this joint use the host's free
    // slot: the one authoritative free-host check (JOINT_HOST lock, then the
    // joint row lock, under this server's ns-3 lock).
    await assertFreeHostCanConnectFirstServer(tx, parentJointId ?? invite.jointChannelId, input.targetServerId, now);
    // Accepting counts active participants plus this server, so an old free
    // invite cannot push a joint that is already over past the cap (§18.8).
    // A host with external channels on lifts that cap; a free server newly
    // connecting is then held to one external channel instead.
    await assertJointAdmission(tx, parentJointId, { kind: "accept", serverId: input.targetServerId }, now,
      options.releasingGuest ? { releasingGuest: options.releasingGuest } : {});
    await assertJointParticipantCanConnect(tx, {
      parentJointId: parentJointId ?? invite.jointChannelId,
      targetServerId: input.targetServerId,
      priorLocalChannelId: priorProjection?.localChannelId,
      now,
    });

    if (priorProjection?.status === "disconnected") await tx.update(channels).set({deletedAt:now})
      .where(eq(channels.id,priorProjection.localChannelId));
    const projection = await createChannelWithExecutor(
      tx,
      input.targetServerId,
      invite.channelName,
      invite.channelDescription ?? undefined,
      "joint",
    );
    if (!alreadyJoined) await tx.insert(channelHumans)
      .values({ channelId: projection.id, userId: joinerUserId })
      .onConflictDoNothing();
    // A server that disconnected earlier still has its row (the primary key is
    // joint + server); rejoining reuses it with the new local copy.
    await tx.insert(jointChannelServers).values({
      jointChannelId: invite.jointChannelId,
      serverId: input.targetServerId,
      localChannelId: projection.id,
      role: "participant",
      joinedByUserId: input.acceptedByUserId,
    }).onConflictDoUpdate({
      target: [jointChannelServers.jointChannelId, jointChannelServers.serverId],
      set: {
        localChannelId: projection.id,
        role: "participant",
        status: "active",
        joinedByUserId: input.acceptedByUserId,
        joinedAt: now,
        disconnectedByUserId: null,
        disconnectedAt: null,
      },
      setWhere: eq(jointChannelServers.status, "disconnected"),
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
    // The projection is not committed yet, so name the canonical storage explicitly.
    const [canonicalLatest] = await tx
      .select({ seq: sql<number>`COALESCE(MAX(${messages.seq}), 0)::int` })
      .from(messages)
      .where(eq(messages.channelId, invite.canonicalChannelId));
    await startReadPositionAtJoin(tx, "human", joinerUserId, projection.id, canonicalLatest?.seq ?? 0);
    // Task v2: the joining server also gets a local face of every task
    // conversation under the channel (same rule as threads).
    const { backfillJointTaskConversationProjectionsForLocalParent } = await import("./taskConversationService");
    await backfillJointTaskConversationProjectionsForLocalParent(tx, {
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
        acceptedAt: currentDate(),
        acceptedVia,
      })
      .where(eq(jointChannelInvites.id, input.inviteId));
    // The target projection may have been created above, so resolve the new
    // source after it exists, inside the same already-J-locked transaction.
    const mirrorAccepted = await prepareJointHumanMembershipMirror(tx, { channelIds: [projection.id] }, "join");
    await mirrorAccepted.apply([joinerUserId], { actorUserId: input.acceptedByUserId });
    await recordCreationSource();
    if (parentJointId) await reconcileJointOverLimit(tx, parentJointId, now);
    // This accept connected the server (an accept that found it connected
    // returned above): one event on the host, naming the host's own copy. A
    // host with no active copy (it disconnected itself, external channels
    // off) has no row to write.
    if (options.connectedAuditMode && preHostServerId && preHostServerId !== input.targetServerId) {
      const [hostCopy] = await tx.select({ localChannelId: jointChannelServers.localChannelId }).from(jointChannelServers)
        .where(and(
          eq(jointChannelServers.jointChannelId, invite.jointChannelId),
          eq(jointChannelServers.serverId, preHostServerId),
          eq(jointChannelServers.role, "host"),
          eq(jointChannelServers.status, "active"),
        ));
      if (hostCopy) await recordServerConnected(tx, {
        mode: options.connectedAuditMode,
        jointChannelId: invite.jointChannelId,
        hostServerId: preHostServerId,
        hostChannelId: hostCopy.localChannelId,
        connectedServerId: input.targetServerId,
        actorUserId: input.acceptedByUserId,
      });
    }
    return projection;
  });
}

/** One acceptance operation, with a single pre-operation membership snapshot.
 * Sequential independent accepts do not accumulate sources for existing J
 * members. Every selected invite is personal and revalidated by the ordinary
 * accept writer; failure rolls back all connection/membership writes. */
export async function acceptJointChannelInvites(input:{inviteIds:readonly string[];acceptedByUserId:string}) {
  const ids=[...new Set(input.inviteIds)];
  if(ids.length===0 || ids.length>=MAX_JOINT_CHANNEL_SERVERS || ids.some(id=>!isJointChannelInviteId(id))) throw new Error("Invalid joint invite selection");
  const db=getDb();
  const invites=await db.select().from(jointChannelInvites).where(and(inArray(jointChannelInvites.id,ids),eq(jointChannelInvites.invitedUserId,input.acceptedByUserId),eq(jointChannelInvites.status,"pending")));
  const jointId=invites[0]?.jointChannelId;
  if(invites.length!==ids.length || !jointId || invites.some(invite=>invite.jointChannelId!==jointId)) throw new Error("Joint channel invite not found");
  const serverIds=[...new Set(invites.map(invite=>invite.toServerId))].sort();
  if(serverIds.length!==ids.length) throw new Error("Invalid joint invite selection");
  await refreshJointEntitlementsBeforeAdmission(await resolveParentJointId(db,jointId) ?? jointId,serverIds,currentDate());
  // Unlocked, only to know whose admission lock to take; each accept re-checks it under the lock.
  const hostServerId=await jointHostOfJoint(db,jointId);
  return db.transaction(async tx=>{
    // ADMISSION_LOCK_ORDER (planService): every connecting server's and the host's admission lock, then the connecting servers' ns-3 locks, each in server-id order.
    await acquireServerAdmissionLocks(tx,hostServerId?[...serverIds,hostServerId]:serverIds);
    for(const serverId of serverIds) await acquireServerLock(tx,serverId,3);
    await lockJointLifecycle(tx,jointId);
    await assertJointOpenUnderLifecycle(tx,jointId);
    const prior=await tx.select({id:jointChannelServers.localChannelId}).from(jointChannelServers)
      .where(and(eq(jointChannelServers.jointChannelId,jointId),inArray(jointChannelServers.serverId,serverIds)));
    for(const id of prior.map(row=>row.id).sort()) await lockJointHumanMembershipChannel(tx,id);
    for(const serverId of serverIds) await lockJointHumanAdmissionSource(tx,serverId,[input.acceptedByUserId]);
    await lockJointHostServerBeforeAudit(tx,hostServerId);
    await prepareJointHumanMembershipMirror(tx,{jointIds:[jointId]},"join");
    const before=await tx.execute(sql`SELECT 1 FROM joint_channel_members WHERE joint_channel_id=${jointId}::uuid AND user_id=${input.acceptedByUserId}::uuid`);
    // ADMISSION_LOCK_ORDER rule 4: every server's external channel freeze
    // row once, before the first accept takes the joint row lock.
    await reconcileExternalFreezesForJointConnect(tx,{parentJointId:await resolveParentJointId(tx,jointId) ?? jointId,connectingServerIds:serverIds,now:currentDate()});
    const accepted=[];
    for(const invite of [...invites].sort((a,b)=>a.toServerId.localeCompare(b.toServerId))) {
      accepted.push(await acceptJointChannelInviteWithEntitlements({inviteId:invite.id,targetServerId:invite.toServerId,acceptedByUserId:input.acceptedByUserId},false,{externalFreezesReconciled:true,connectedAuditMode:"joint_invite"}));
    }
    if(before.rows.length===0) await recordOrdinaryJointAdmissions(tx,sql`SELECT m.joint_channel_id,m.user_id,s.server_id,m.generation,
        now() AS admitted_at,${input.acceptedByUserId}::uuid AS admitted_by
      FROM joint_channel_members m CROSS JOIN (VALUES ${sql.join(serverIds.map(id=>sql`(${id}::uuid)`),sql`, `)}) s(server_id)
      WHERE m.joint_channel_id=${jointId}::uuid AND m.user_id=${input.acceptedByUserId}::uuid`);
    return accepted;
  });
}

export type ArchivedFilter = "exclude" | "include" | "only";

interface ChannelListOptions {
  archived?: ArchivedFilter;
  traceQuery?: DbQueryTracer;
  humanActivityMuteEnabled?: boolean;
  /**
   * Only these channels (GET /api/sync/changes rebuilding changed rows): the
   * same rows the full list holds for them, filtered before any per-row work,
   * and never the `#all` lazy insert (an id list is not "this server's list").
   */
  channelIds?: readonly string[];
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
 * caller's transaction holds the connection deadlocks the flow. Transaction-
 * scoped callers must thread their executor through this read.
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
        COALESCE(rc.marked_unread, false) AS "markedUnread",
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

/** One conversation the person marked unread (user_channel_read_cursors.marked_unread), with its cursor. */
export type MarkedUnreadScope = { channelId: string; readStateVersion: number; maxReadSeq: string };

/**
 * The conversations of one server this person has marked unread (Mark as
 * Unread with nothing countable past the cursor) and still sees: a channel or
 * DM they are a member of, a thread or task conversation they follow and have
 * not marked done. The one Postgres read behind "unread, no count" on the
 * sidebar summary and in Activity (rows and the Unread filter): RisingWave
 * does not carry the flag. Served by idx_user_channel_read_cursors_marked_unread
 * (user_id) WHERE marked_unread, so it reads only the person's marked rows.
 */
async function loadMarkedUnreadScopes(
  serverId: string,
  userId: string,
  traceQuery: DbQueryTracer,
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, MarkedUnreadScope>> {
  const result = await traceQuery(
    "channels.marked_unread_scopes",
    () => executor.execute(sql`
      SELECT rc.channel_id::text AS "channelId",
             rc.read_state_version::int AS "readStateVersion",
             rc.last_read_seq::text AS "maxReadSeq"
      FROM user_channel_read_cursors rc
      JOIN channels c ON c.id = rc.channel_id
      WHERE rc.user_id = ${userId}::uuid
        AND rc.marked_unread
        AND c.server_id = ${serverId}::uuid
        AND c.deleted_at IS NULL
        AND c.archived_at IS NULL
        AND CASE WHEN c.type IN ('thread', 'task')
          THEN EXISTS (
            SELECT 1 FROM thread_follows tf
            WHERE tf.thread_channel_id = c.id
              AND tf.follower_type = 'user'
              AND tf.follower_id = ${userId}::uuid
              AND tf.unfollowed_at IS NULL
              AND tf.done_at IS NULL
          )
          ELSE EXISTS (
            SELECT 1 FROM channel_humans ch
            WHERE ch.channel_id = c.id AND ch.user_id = ${userId}::uuid
          )
        END
    `),
    (r) => ({ marked_unread_scope_count: r.rows.length }),
  );
  return new Map((result.rows as MarkedUnreadScope[]).map((row) => [row.channelId, row]));
}

function readFrontierFromAuthorityRow(row: UnreadSummaryReadStateRow): InboxScopeReadFrontier {
  const cursor = row.readCursorPresent
    ? {
      readStateVersion: row.readStateVersion as number,
      maxReadSeq: row.maxReadSeq as string,
      latestActivityMessageId: row.latestActivityMessageId,
      latestActivitySeq: row.latestActivitySeq,
      markedUnread: row.markedUnread === true,
    }
    : null;
  return makeInboxScopeReadFrontier(cursor, (c) => {
    console.error(formatInboxScopeCorruptionLine(row.channelId, c));
  });
}

/**
 * The list/DM/followed-thread read-state snapshot of one authority row (absent
 * row = no channel row). Shared by attachReadState and the followed-threads
 * RisingWave path, which builds the authority row from the cursor table plus
 * the RW latest message, so both produce the same snapshot for the same facts.
 */
function readStateSnapshotFromAuthorityRow(state: UnreadSummaryReadStateRow | undefined): ReadStateSnapshot {
  return {
    // Legacy fields keep their historical coalesce-to-0 shape for existing
    // consumers; the NEW readState union is the authoritative carrier
    // (#632) — absence/corruption stay visible there.
    maxReadSeq: state?.readCursorPresent ? Number(state.maxReadSeq) : 0,
    readStateVersion: state?.readCursorPresent ? (state.readStateVersion as number) : 0,
    readState: state ? readFrontierFromAuthorityRow(state) : makeInboxScopeReadFrontier(null),
  };
}

async function attachReadState<T extends { id: string }>(
  rows: T[],
  userId: string,
  executor: DatabaseExecutor = getDb(),
  traceQuery: DbQueryTracer = untracedDbQuery,
): Promise<Array<T & ReadStateSnapshot>> {
  if (rows.length === 0) return [];
  const authorityRows = await fetchReadStateAuthorityRows(
    rows.map((row) => row.id),
    userId,
    traceQuery,
    "channels.read_state_by_channels",
    executor,
  );
  const stateByChannel = new Map(authorityRows.map((row) => [row.channelId, row]));
  return rows.map((row) => ({
    ...row,
    ...readStateSnapshotFromAuthorityRow(stateByChannel.get(row.id)),
  }));
}

/**
 * The activity mute a person (or agent) sees for one stored mute row. The list
 * (attachActivityMuteState) and every single-conversation read
 * (getInboxTargetActivityMuteState) go through this one rule so they agree.
 * An owner's DM with their assistant stays out of Activity by a row nobody
 * chose (push_muted false, keepAssistantDmOutOfActivity): it reads as not
 * muted, so it never looks like the owner muted it (and an agent DM offers no
 * mute switch).
 */
function readActivityMuteState(
  state: { activityMuted: boolean; muteFromSeq: number | null; pushMuted: boolean; prefsVersion: number } | undefined,
): { activityMuted: boolean; muteFromSeq: number | null; prefsVersion: number } {
  if (!state) return { activityMuted: false, muteFromSeq: null, prefsVersion: 0 };
  const assistantDm = state.pushMuted === false && state.activityMuted;
  const activityMuted = !assistantDm && state.activityMuted && state.muteFromSeq != null;
  return { activityMuted, muteFromSeq: activityMuted ? state.muteFromSeq : null, prefsVersion: state.prefsVersion };
}

// `type` is required, not optional: this row set decides whether the API
// announces a mute capability, and an absent type must fail the compile rather
// than silently default to "supported" (that default is what let DMs claim a
// control no surface renders — task #473). A DM is supported only when its id
// is in `appBotDmIds` (the person's DMs with an App bot); agents pass none.
async function attachActivityMuteState<T extends { id: string; type: string }>(
  rows: T[],
  receiverType: "user" | "agent",
  receiverId: string,
  enabled = true,
  appBotDmIds: ReadonlySet<string> = new Set(),
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
      pushMuted: inboxTargetMuteStates.pushMuted,
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
    const { activityMuted, muteFromSeq, prefsVersion } = readActivityMuteState(stateByChannel.get(row.id));
    return {
      ...row,
      activityMuted,
      muteFromSeq,
      prefsVersion,
      activityMuteSupported: activityMuteSupportedFor({ type: row.type, dmPeerIsAppBot: appBotDmIds.has(row.id) }),
    };
  });
}

/** attachActivityMuteState's `activityMuteSupported` for one conversation a person reads. */
export async function userActivityMuteSupported(channel: { id: string; type: string }): Promise<boolean> {
  if (channel.type !== "dm") return activityMuteSupportedFor({ type: channel.type });
  const [appBot] = await getDb()
    .select({ id: agents.id })
    .from(channelAgents)
    .innerJoin(agents, eq(channelAgents.agentId, agents.id))
    .where(and(
      eq(channelAgents.channelId, channel.id),
      isNotNull(agents.managedByAppInstallId),
      isNull(agents.deletedAt),
    ))
    .limit(1);
  return activityMuteSupportedFor({ type: "dm", dmPeerIsAppBot: appBot !== undefined });
}

// Per-user message display prefs hydration (task #187 collapse-long-messages).
// A missing row means the default: long messages render in full
// (collapseLongMessages = false) at prefsVersion 0.
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
      collapseLongMessages: state?.collapseLongMessages ?? false,
      displayPrefsVersion: state?.prefsVersion ?? 0,
    };
  });
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
  /**
   * Non-joined public channel only: its latest message is past the user's read
   * cursor. Such a channel has no exact count (unreadCount is 0); the sidebar
   * shows a quiet indicator instead.
   */
  hasNew?: boolean;  /**
   * Followed-thread rows with unread replies only: the LOCAL channel the thread
   * hangs under in this server (for a joint thread, this server's joint
   * channel). Absent when it cannot be resolved yet (e.g. CDC lag on a
   * just-created projection).
   */
  parentChannelId?: string;
};

/**
 * Per parent channel: how many followed threads under it have unread replies,
 * and whether any of them has an unread mention. Kept apart from the channel's
 * own unreadCount (thread replies are never part of it).
 */
export type ThreadUnreadByParent = Record<string, { count: number; hasMention: boolean }>;

/** Folds the followed-thread rows of a sidebar summary onto their parent channels. */
export function summarizeThreadUnreadByParent(
  summary: Record<string, ChannelUnreadSummaryEntry>,
): ThreadUnreadByParent {
  const byParent: ThreadUnreadByParent = {};
  for (const entry of Object.values(summary)) {
    if (!entry.parentChannelId || entry.unreadCount <= 0) continue;
    const slot = byParent[entry.parentChannelId] ??= { count: 0, hasMention: false };
    slot.count += 1;
    if (entry.hasMention) slot.hasMention = true;
  }
  return byParent;
}

interface SidebarUnreadSummaryOptions {
  traceQuery?: DbQueryTracer;
}


/** Every unified-chain serving view is receiver-keyed: reads must filter on `receiver_type`. */
const RECEIVER_KEYED_SERVING_VIEWS: ReadonlySet<string> = new Set([UNIFIED_CHAIN_VIEWS.serving]);

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

type DMChannelLastMessageSummary = {
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  lastMessageSenderName: string | null;
};

async function attachLastMessageSummary<T extends { id: string }>(
  rows: T[],
  traceQuery: DbQueryTracer,
  queryName: string,
  countAttrName: string,
  /** The reading server's plan history cutoff: a last message behind it shows 40 characters (services/historyWindow.ts). */
  historyCutoff?: Date,
): Promise<Array<T & DMChannelLastMessageSummary>> {
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
        latest.created_at AS "lastMessageAt",
        CASE
          WHEN length(latest.normalized_content) = 0 THEN NULL
          ${historyCutoff ? sql`WHEN latest.created_at <= ${historyCutoff} AND length(latest.normalized_content) > ${HISTORY_PREVIEW_CHARS}
            THEN left(latest.normalized_content, ${HISTORY_PREVIEW_CHARS - 1}) || '…'
          WHEN latest.created_at <= ${historyCutoff} THEN latest.normalized_content` : sql``}
          WHEN length(latest.normalized_content) > 140 THEN left(latest.normalized_content, 139) || '…'
          ELSE latest.normalized_content
        END AS "lastMessagePreview",
        COALESCE(
          NULLIF(sender_user.display_name, ''),
          sender_user.name,
          NULLIF(sender_agent.display_name, ''),
          sender_agent.name,
          external_author.display_name
        ) AS "lastMessageSenderName"
      FROM input_channels
      JOIN LATERAL (
        SELECT
          m.id,
          m.sender_type,
          m.sender_id,
          -- The sender as a uuid, so the joins below are primary-key probes.
          -- Comparing id::text instead hides the users/agents primary keys and
          -- scans both tables on every call. Non-uuid sender ids (system
          -- messages are sender_type 'user' with sender_id 'system') become
          -- NULL here instead of failing the cast; a type check alone would
          -- not guard the cast, since SQL does not fix the order of AND terms.
          ${sqlUuidOrNull(sql.raw("m.sender_id"))} AS sender_uuid,
          m.created_at,
          btrim(regexp_replace(m.content, '\\s+', ' ', 'g')) AS normalized_content
        FROM messages m
        WHERE m.channel_id = input_channels.channel_id
        ORDER BY m.created_at DESC, m.seq DESC
        LIMIT 1
      ) latest ON TRUE
      LEFT JOIN users sender_user
        ON latest.sender_type = 'user'
       AND sender_user.id = latest.sender_uuid
      LEFT JOIN agents sender_agent
        ON latest.sender_type = 'agent'
       AND sender_agent.id = latest.sender_uuid
      LEFT JOIN external_message_author_facts external_author
        ON latest.sender_type = 'external_projection'
       AND external_author.message_id = latest.id
    `).then((result) =>
      (result.rows as Array<{
        channelId: string;
        lastMessageAt: Date | string | null;
        lastMessagePreview: string | null;
        lastMessageSenderName: string | null;
      }>).map((row) => ({
        channelId: row.channelId,
        lastMessageAt: row.lastMessageAt instanceof Date
          ? row.lastMessageAt
          : row.lastMessageAt
            ? new Date(row.lastMessageAt)
            : null,
        lastMessagePreview: row.lastMessagePreview,
        lastMessageSenderName: row.lastMessageSenderName,
      }))
    ),
    (latestRows) => ({
      [countAttrName]: channelIds.length,
      channels_with_messages_count: latestRows.length,
    }),
  );
  const lastMessageMap = new Map(lastMessages.map((row) => [row.channelId, row]));
  return rows.map((row) => ({
    ...row,
    lastMessageAt: lastMessageMap.get(row.id)?.lastMessageAt ?? null,
    lastMessagePreview: lastMessageMap.get(row.id)?.lastMessagePreview ?? null,
    lastMessageSenderName: lastMessageMap.get(row.id)?.lastMessageSenderName ?? null,
  }));
}

/**
 * Joint channel metadata, and on every row `externalFreezeAt`: the free plan's
 * external channel freeze of the row's server (the viewing side), when this
 * is one of its external channels (externalChannelFreezeState).
 */
export async function attachJointChannelMetadata<T extends { id: string; type: string; serverId: string }>(
  rows: T[],
): Promise<Array<T & JointChannelMetadata>> {
  const [withJoint, freezeAtByChannelId] = await Promise.all([
    attachJointOnlyMetadata(rows),
    getExternalFreezeAtForChannels(getDb(), rows),
  ]);
  return withJoint.map((row) => ({ ...row, externalFreezeAt: freezeAtByChannelId.get(row.id) ?? null }));
}

async function attachJointOnlyMetadata<T extends { id: string; type: string; serverId: string }>(
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
      channelName: channels.name,
    })
    .from(jointChannelServers)
    .innerJoin(servers, eq(servers.id, jointChannelServers.serverId))
    .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
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
  const graceEndsAtByLocalId = new Map<string, string | null>();
  const limitNow = currentDate();
  const limitStates = await getJointLimitStatesForJoints(db, jointIds, limitNow);
  for (const projection of projections) {
    const state = limitStates.get(projection.jointChannelId) ?? null;
    billingLockedByLocalId.set(projection.localChannelId, state?.readOnly ?? false);
    graceEndsAtByLocalId.set(projection.localChannelId, state?.graceEndsAt?.toISOString() ?? null);
  }
  const freeServers = await freeServerIds(db, [...new Set([
    ...activeServers.map((server) => server.serverId),
    ...pendingInvites.map((invite) => invite.toServerId),
  ])], limitNow);
  const planOf = (serverId: string) => (freeServers.has(serverId) ? "free" as const : "paid" as const);

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
        plan: planOf(invite.toServerId),
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
        plan: planOf(server.serverId),
        channelName: server.channelName,
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
      jointOverLimitGraceEndsAt: projection ? graceEndsAtByLocalId.get(projection.localChannelId) ?? null : null,
    };
  });
}

interface FollowedThreadsOptions {
  traceQuery?: DbQueryTracer;
  executor?: DatabaseExecutor;
  state?: "active" | "done" | "unfollowed" | "unfollowed_active";
  maxRows?: number;
  channelId?: string;
  /** Only threads whose parent channel is one of these ids ([] = none). Activity "Pinned" scope. */
  parentChannelIds?: readonly string[];
  q?: string;
  sort?: "asc" | "desc";
  /** Active follows only: just the threads with unread replies (all channels). */
  unreadOnly?: boolean;
  /**
   * Active follows only: one page, newest activity first (latestActivitySeq
   * desc, then thread id desc). Without it the whole list is returned as before.
   */
  page?: { limit: number; cursor?: FollowedThreadsCursor | null };
  /**
   * Internal: run the legacy all-Postgres list even when the active-follows
   * RisingWave path (rw_followed_threads_v5) applies. For the path diff script
   * (scripts/followed-threads-path-diff.ts) and tests; no route sets it.
   */
  forceLegacyPath?: boolean;
  /**
   * Task v2: also list the task conversations (`channels.type = 'task'`) the
   * user follows, as `kind: "task"` rows. The web followed-threads route and
   * Activity's Done / Unfollowed lists set it whatever the reader's flag
   * (task v2 per-task mode: a v2 task keeps its conversation after a
   * rollback / on the flag-off side of a joint channel).
   */
  includeTaskConversations?: boolean;
}

interface ThreadSummaryOptions {
  traceQuery?: DbQueryTracer;
  userId?: string;
  parentMessageIds?: string[];
  /**
   * The reading server's plan history cutoff (services/historyWindow.ts): the
   * newest replies a summary previews stay inside it. Counts are unchanged.
   */
  historyCutoff?: Date;
  /**
   * Default true. False skips the participants read entirely and returns an
   * empty `participantIds` for every thread. That read aggregates every sender
   * over each thread's whole history, so its cost grows with the thread and is
   * not bounded by the page; a caller that does not show participants (the
   * anonymous public page) must not pay for it or read those ids at all.
   */
  includeParticipants?: boolean;
  /**
   * Resolve reply agents only among this server's agents, as the caller's
   * parent rows do (the anonymous public page joins agents on its own server
   * id). A reply whose agent belongs to another server gets the parent row's
   * fallback: "Unknown agent", no avatar. Unset (member reads): agents resolve
   * by id, as member message rows do (enrichWithSenderNames), which is what
   * keeps a joint channel's participant-server agents named.
   */
  agentServerId?: string;
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
      bindingId: externalChannelBindings.id,
      bindingEpoch: externalChannelBindings.bindingEpoch,
      channelId: externalChannelBindings.channelId,
      provider: externalAppRegistrations.provider,
      providerConversationId: externalChannelBindings.providerConversationId,
      state: externalChannelBindings.state,
      stateReason: externalChannelBindings.stateReason,
      installState: externalAppInstalls.state,
    }).from(externalChannelBindings)
      .innerJoin(
        externalAppRegistrations,
        eq(externalAppRegistrations.id, externalChannelBindings.registrationId),
      )
      .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
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
  const active = rows.filter((row) => row.state === "active" && row.installState === "active");
  const heads: Awaited<ReturnType<typeof listSlackPairHeadsForHealth>> = [];
  for (let offset = 0; offset < active.length; offset += SLACK_PAIR_HEAD_BATCH_SIZE) {
    const batch = active.slice(offset, offset + SLACK_PAIR_HEAD_BATCH_SIZE);
    heads.push(...await traceQuery(
      "channels.external_bridge_pair_heads",
      () => listSlackPairHeadsForHealth(getDb(), batch.map((row) => ({ bindingId: row.bindingId, bindingEpoch: row.bindingEpoch }))),
      (result) => ({ bridged_channels_count: batch.length, held_pairs_count: result.length }),
    ));
  }
  const now = currentDate();
  const outboundByBindingId = new Map(heads.flatMap((head) => {
    const hold = slackPairOutboundHold(head, now);
    return hold ? [[head.currentBindingId, hold] as const] : [];
  }));
  const bridgeByChannelId = new Map(rows.map((row) => {
    const outbound = outboundByBindingId.get(row.bindingId);
    return [row.channelId, {
      provider: row.provider,
      providerConversationId: row.providerConversationId,
      state: row.state,
      ...(row.state !== "active" && row.stateReason ? { stateReason: row.stateReason } : {}),
      ...(outbound ? { outbound } : {}),
      ...(row.installState !== "active" ? { installState: row.installState } : {}),
    }];
  }));
  return list.map((channel) => {
    const bridge = bridgeByChannelId.get(channel.id);
    return bridge ? { ...channel, bridge } : channel;
  });
}

/** Attach steps for one user's channel or DM list in flight at once. */
const LIST_ATTACH_CONCURRENCY = 3;

/**
 * The per-user state on a channel list (mute, display prefs, read state, last
 * message time, joint metadata). Each step reads its own table for the same
 * rows, so they run side by side (at most LIST_ATTACH_CONCURRENCY at once) and
 * are merged per row in the order the nested calls used to apply them.
 */
async function attachUserChannelListState<T extends { id: string; type: string; serverId: string; archivedAt: Date | null }>(
  rows: T[],
  userId: string,
  humanActivityMuteEnabled: boolean,
  traceQuery: DbQueryTracer,
  opts: { skipArchivedActivity?: boolean } = {},
) {
  // Whole-list reads (no channelIds) skip the per-channel latest-message reads
  // for archived channels: no client uses lastMessageAt or readState on an
  // archived row of the list (#proj-data:#12), and a big server is mostly
  // archived channels (prod: 617 of 683), each a cold index read. An archived
  // row then carries no readState (the web leaves its read-state ledger as it
  // is), lastMessageAt null and the legacy 0s. A lookup by id keeps them.
  const activityRows = opts.skipArchivedActivity ? rows.filter((row) => row.archivedAt === null) : rows;
  const limit = createConcurrencyLimiter(LIST_ATTACH_CONCURRENCY);
  const [withMute, withDisplayPrefs, withReadState, withLastMessage, withJoint] = await Promise.all([
    limit(() => attachActivityMuteState(rows, "user", userId, humanActivityMuteEnabled)),
    limit(() => attachUserChannelDisplayPrefs(rows, userId)),
    limit(() => attachReadState(activityRows, userId)),
    limit(() => attachLastMessageAt(activityRows, traceQuery, "channels.last_messages_by_channels", "channels_count")),
    limit(() => attachJointChannelMetadata(rows)),
  ]);
  const readStateById = new Map(withReadState.map((row) => [row.id, row]));
  const lastMessageById = new Map(withLastMessage.map((row) => [row.id, row]));
  return rows.map((row, index) => {
    const readState = readStateById.get(row.id);
    return {
      ...withMute[index]!,
      ...withDisplayPrefs[index]!,
      ...(readState
        ? { maxReadSeq: readState.maxReadSeq, readStateVersion: readState.readStateVersion, readState: readState.readState }
        : { maxReadSeq: 0, readStateVersion: 0, readState: undefined as InboxScopeReadFrontier | undefined }),
      lastMessageAt: lastMessageById.get(row.id)?.lastMessageAt ?? null,
      ...withJoint[index]!,
    };
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
  const channelIds = opts?.channelIds;
  if (channelIds) {
    if (channelIds.length === 0) return [];
    conditions.push(inArray(channels.id, [...new Set(channelIds)]));
  } else {
    // Agent lounges are not in the channel directory (browse, sidebar,
    // forward-to; the other full-list callers are Guest-only and Guests
    // never read a lounge): the web lists them from the DM list. A
    // lookup by id (GET /api/channels/:id, sync) still returns them.
    conditions.push(notAgentLoungeChannel(channels.id));
  }
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
      const [serverRole, memberships] = await Promise.all([
        resolveHumanServerRole(serverId, userId),
        traceQuery(
          "channels.memberships_by_user",
          () => db
            .select({ channelId: channelHumans.channelId })
            .from(channelHumans)
            .where(eq(channelHumans.userId, userId)),
          (rows) => ({
            channels_count: list.length,
            memberships_count: rows.length,
          }),
        ),
      ]);
      const guestChannelId = serverRole === "guest" ? await getGuestChannelId(serverId, userId) : null;
      const joinedSet = new Set(memberships.map((m) => m.channelId));
      const jointIds = list.filter(channel => channel.type === "joint").map(channel => channel.id);
      const jointAccess = await filterUserAccessibleChannelIds(jointIds, userId, asServerId(serverId));
      for (const id of jointIds) { if (jointAccess.has(id)) joinedSet.add(id); else joinedSet.delete(id); }
      const recoverableJoints = await hostRecoverableArchivedJointIds(serverId, serverRole, list.filter((ch) => !joinedSet.has(ch.id)));
      const visibleChannels = list
        .filter((ch) => serverRole === "guest"
          ? canGuestReadChannel({
              serverRole,
              channelId: ch.id,
              guestChannelId,
              channelType: ch.type,
              isChannelMember: joinedSet.has(ch.id),
              // Joint rows: joinedSet holds filterUserAccessibleChannelIds (the guest joint rule).
              jointEntry: ch.type === "joint" && joinedSet.has(ch.id),
              archived: ch.archivedAt !== null,
              deleted: ch.deletedAt !== null,
            })
          : !requiresExplicitMembership(ch.type) || joinedSet.has(ch.id) || recoverableJoints.has(ch.id))
        .map((ch) => ({
          ...ch,
          joined: serverRole === "guest" && isAllSystemChannel(ch) ? false : joinedSet.has(ch.id),
        }));
      return attachUserChannelListState(visibleChannels, userId, opts?.humanActivityMuteEnabled ?? true, traceQuery, {
        skipArchivedActivity: !channelIds,
      });
    }
    const visibleChannels = list.filter((ch) => ch.type === "channel");
    return attachJointChannelMetadata(
      await attachLastMessageAt(visibleChannels, traceQuery, "channels.last_messages_by_channels", "channels_count"),
    );
  }

  let allChannel = list.find(isAllSystemChannel);
  if (!allChannel && !channelIds) {
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
    const [serverRole, memberships] = await Promise.all([
      resolveHumanServerRole(serverId, userId),
      traceQuery(
        "channels.memberships_by_user",
        () => db
          .select({ channelId: channelHumans.channelId })
          .from(channelHumans)
          .where(eq(channelHumans.userId, userId)),
        (rows) => ({
          channels_count: visibleList.length,
          memberships_count: rows.length,
        }),
      ),
    ]);
    const guestChannelId = serverRole === "guest" ? await getGuestChannelId(serverId, userId) : null;
    const joinedSet = new Set(memberships.map((m) => m.channelId));
    const jointIds = visibleList.filter(channel => channel.type === "joint").map(channel => channel.id);
    const jointAccess = await filterUserAccessibleChannelIds(jointIds, userId, asServerId(serverId));
    for (const id of jointIds) { if (jointAccess.has(id)) joinedSet.add(id); else joinedSet.delete(id); }
    const recoverableJoints = await hostRecoverableArchivedJointIds(serverId, serverRole, visibleList.filter((ch) => !joinedSet.has(ch.id)));

    const visibleChannels = visibleList
      .filter((ch) => serverRole === "guest"
        ? canGuestReadChannel({
            serverRole,
            channelId: ch.id,
            guestChannelId,
            channelType: ch.type,
            isChannelMember: joinedSet.has(ch.id),
            // Joint rows: joinedSet holds filterUserAccessibleChannelIds (the guest joint rule).
            jointEntry: ch.type === "joint" && joinedSet.has(ch.id),
            archived: ch.archivedAt !== null,
            deleted: ch.deletedAt !== null,
          })
        : !requiresExplicitMembership(ch.type) || joinedSet.has(ch.id) || recoverableJoints.has(ch.id))
      .map((ch) => ({
        ...ch,
        joined: serverRole === "guest"
          ? !isAllSystemChannel(ch) && joinedSet.has(ch.id)
          : isEnabledAllChannel(ch) || joinedSet.has(ch.id),
      }));
    return attachUserChannelListState(visibleChannels, userId, opts?.humanActivityMuteEnabled ?? true, traceQuery, {
      skipArchivedActivity: !channelIds,
    });
  }

  const visibleChannels = visibleList.filter((ch) => ch.type === "channel");
  return attachJointChannelMetadata(
    await attachLastMessageAt(visibleChannels, traceQuery, "channels.last_messages_by_channels", "channels_count"),
  );
}

/**
 * The subset of `channelIds` (top-level channels of this server) one human
 * may view, by the same rule as `listChannels`: public channels for every
 * member, private and joint channels only with a channel membership, Guest
 * channels through the Guest policy, and never a hidden #all. Archived
 * channels stay visible; deleted ones and anything outside the server do not.
 */
export async function filterChannelIdsVisibleToHuman(
  serverId: string,
  userId: string,
  channelIds: readonly string[],
  executor: DatabaseExecutor = getDb(),
): Promise<Set<string>> {
  const visible = new Set<string>();
  if (channelIds.length === 0) return visible;
  const serverRole = await resolveHumanServerRole(serverId, userId, executor);
  if (!serverRole) return visible;
  const ids = [...new Set(channelIds)];
  const [rows, memberships] = await Promise.all([
    executor.select({
      id: channels.id,
      name: channels.name,
      type: channels.type,
      guestVisible: channels.guestVisible,
      archivedAt: channels.archivedAt,
      deletedAt: channels.deletedAt,
    }).from(channels).where(and(
      eq(channels.serverId, serverId),
      inArray(channels.id, ids),
      inArray(channels.type, LISTABLE_CHANNEL_TYPES),
      isNull(channels.deletedAt),
    )),
    executor.select({ channelId: channelHumans.channelId })
      .from(channelHumans)
      .where(and(eq(channelHumans.userId, userId), inArray(channelHumans.channelId, ids))),
  ]);
  const guestChannelId = serverRole === "guest" ? await getGuestChannelId(serverId, userId, executor) : null;
  const joinedSet = new Set(memberships.map((membership) => membership.channelId));
  const jointIds = rows.filter(channel => channel.type === "joint").map(channel => channel.id);
  const jointAccess = await filterUserAccessibleChannelIds(jointIds, userId, asServerId(serverId), { executor });
  for (const id of jointIds) { if (jointAccess.has(id)) joinedSet.add(id); else joinedSet.delete(id); }
  for (const ch of rows) {
    const allChannelHidden = isAllSystemChannel(ch) && !isEnabledAllChannel(ch);
    const readable = serverRole === "guest"
      ? canGuestReadChannel({
          serverRole,
          channelId: ch.id,
          guestChannelId,
          channelType: ch.type,
          isChannelMember: joinedSet.has(ch.id),
          // Joint rows: joinedSet holds filterUserAccessibleChannelIds (the guest joint rule).
          jointEntry: ch.type === "joint" && joinedSet.has(ch.id),
          archived: ch.archivedAt !== null,
          deleted: ch.deletedAt !== null,
        })
      : !allChannelHidden && (!requiresExplicitMembership(ch.type) || joinedSet.has(ch.id));
    if (readable) visible.add(ch.id);
  }
  return visible;
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

/** updateChannel's refusal to change a joint channel's visibility (routes match it to answer 403). */
export const JOINT_VISIBILITY_FIXED_MESSAGE = "External channels stay private, so you can't change this channel's visibility";

/** addHuman's refusal to put a Guest in #all (routes match it to answer 403). */
export const GUEST_ALL_CHANNEL_MESSAGE = "Guests can't be added to #all";

/**
 * A channel with an external relation stays private (cindyz, #wg-rbac:0829b5df):
 * it is made public only once the relation is gone.
 */
export class ExternalMembersKeepPrivateError extends Error {
  readonly code = "external_members_keep_private";
  constructor() {
    super("This channel has external members or pending external invites, so it stays private.");
    this.name = "ExternalMembersKeepPrivateError";
  }
}

/**
 * Of `channelIds`, those with an external relation (#wg-rbac:#16): a Guest
 * bound to the channel, or an open external invite to it (pending,
 * awaiting approval or connecting, not expired). One statement for the whole
 * list (both sides are indexed by channel). Not gated by external_channels_v1:
 * a channel that is already external stays so with the flag off.
 */
export async function channelIdsWithExternalRelation(
  channelIds: readonly string[],
  db: DatabaseExecutor = getDb(),
): Promise<Set<string>> {
  const ids = [...new Set(channelIds)];
  if (ids.length === 0) return new Set();
  const rows = await unionAll(
    db.select({ channelId: sql<string>`${serverMembers.guestChannelId}`.as("channel_id") }).from(serverMembers)
      .where(and(eq(serverMembers.role, "guest"), inArray(serverMembers.guestChannelId, ids))),
    db.select({ channelId: sql<string>`${channelExternalInvites.channelId}`.as("channel_id") }).from(channelExternalInvites)
      .where(and(
        inArray(channelExternalInvites.channelId, ids),
        // Every open status (OPEN_EXTERNAL_INVITE_STATUSES), self_connecting included.
        inArray(channelExternalInvites.status, ["pending", "awaiting_approval", "connecting", "self_connecting"]),
        gt(channelExternalInvites.expiresAt, sql`now()`),
      )),
  );
  return new Set(rows.map((row) => row.channelId));
}

async function hasExternalRelation(db: DatabaseExecutor, channelId: string): Promise<boolean> {
  return (await channelIdsWithExternalRelation([channelId], db)).has(channelId);
}

/**
 * Who reads `hasExternalRelation`: their role in the rows' Server and, for a
 * Guest, the channel they are bound to (server_members.guest_channel_id).
 */
export type ExternalRelationViewer =
  | { role: "guest"; guestChannelId: string | null }
  | { role: Exclude<ServerRole, "guest"> | null };

/**
 * `hasExternalRelation` on channel payloads, for `viewer` in the rows'
 * Server. A non-guest member of the Server the relation belongs to gets it
 * on every eligible row; a joint channel's participant projection never does
 * (its relations, if any, are the host's). A Guest gets it only on its own
 * bound channel, always true (its binding is that channel's external
 * relation, so it tells them nothing new), and on no other row. The field is
 * omitted, not false, where it isn't given, and on DMs, threads and tasks.
 * Rows must carry `jointRole` (attachJointChannelMetadata) for joint
 * channels; one without it is skipped.
 */
export async function attachExternalRelations<T extends { id: string; type: string; jointRole?: "host" | "participant" | null }>(
  rows: readonly T[],
  viewer: ExternalRelationViewer,
  db: DatabaseExecutor = getDb(),
): Promise<Array<T & { hasExternalRelation?: boolean }>> {
  if (viewer.role === "guest") {
    const { guestChannelId } = viewer;
    return rows.map((row) => (row.id === guestChannelId && (row.type === "channel" || row.type === "private" || row.type === "joint")
      ? { ...row, hasExternalRelation: true }
      : row));
  }
  if (viewer.role === null) return [...rows];
  const eligible = rows.filter((row) => row.type === "channel" || row.type === "private" || (row.type === "joint" && row.jointRole === "host"));
  const external = await channelIdsWithExternalRelation(eligible.map((row) => row.id), db);
  const eligibleIds = new Set(eligible.map((row) => row.id));
  return rows.map((row) => (eligibleIds.has(row.id) ? { ...row, hasExternalRelation: external.has(row.id) } : row));
}

export async function updateChannel(
  channelId: string,
  updates: {
    name?: string;
    description?: string;
    type?: RegularChannelType;
    guestVisible?: boolean;
    threadSort?: ChannelThreadSort;
    /**
     * Channel announcements: the object id to store (null removes it), on
     * every projection of a joint. Checked by the caller
     * (channelAnnouncements.ts channelAnnouncementChange).
     */
    announcementArtifactId?: string | null;
  },
  executor?: DatabaseExecutor,
): Promise<typeof channels.$inferSelect> {
  if (!executor) {
    const updated = await withChannelWriterFence(channelId, tx => updateChannel(channelId, updates, tx));
    // Post-commit: callers that own the transaction (routes) revoke themselves
    // after their commit; the fenced path revokes here, after the fence.
    await revokeChannelAccessAfterUpdate(updates, updated);
    return updated;
  }
  await assertChannelWritableInTransaction(executor, channelId);
  const db = executor ?? getDb();
  const channel = await getChannel(channelId, { executor: db });
  if (!channel) throw new Error("Channel not found");
  if (!REGULAR_CHANNEL_TYPES.includes(channel.type as RegularChannelType) && channel.type !== "joint") {
    throw new Error("Cannot edit DM channels");
  }
  if (channel.type === "joint" && updates.type !== undefined) {
    throw new Error(JOINT_VISIBILITY_FIXED_MESSAGE);
  }
  // An agent's lounge keeps its name and stays public (#proj-chat:#15); its
  // description is the only thing an admin may edit.
  if ((updates.name !== undefined && updates.name !== channel.name)
    || (updates.type !== undefined && updates.type !== channel.type)
    || updates.guestVisible === true) {
    if (await isAgentLoungeChannel(channelId, db)) throw new AgentLoungeImmutableError();
  }
  if (updates.guestVisible !== undefined
    && channel.type !== "channel" && channel.type !== "private") {
    throw new Error("Guest access is supported only for ordinary channels");
  }
  if (updates.threadSort !== undefined && !channelTypeSupportsThreadSort(channel.type)) {
    throw new Error("Thread sort is supported only for ordinary channels");
  }
  if (isAllSystemChannel(channel) && updates.name && updates.name !== "all") {
    throw new Error("Cannot rename the #all channel");
  }
  if (!isAllSystemChannel(channel) && updates.name === SYSTEM_ALL_CHANNEL_KEY) {
    throw new Error('Channel name "all" is reserved');
  }
  const allSystemVisibilityUpdate = isAllSystemChannel(channel)
    && updates.type !== undefined
    && updates.type !== channel.type;
  // The one write that turns an ordinary channel public. Under the channel row
  // lock (the PATCH route holds it already), as sending and accepting external
  // invites lock it first: neither can add a relation beside this check.
  if (updates.type === "channel" && !isAllSystemChannel(channel)) {
    const [locked] = await db.select({ type: channels.type }).from(channels).where(eq(channels.id, channelId)).for("update");
    if (locked?.type === "private" && await hasExternalRelation(db, channelId)) throw new ExternalMembersKeepPrivateError();
  }

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
        .select({ id: channels.id, archivedAt: channels.archivedAt, type: channels.type })
        .from(channels)
        .where(and(
          eq(channels.serverId, projectionChannel.serverId),
          inArray(channels.type, LISTABLE_CHANNEL_TYPES),
          eq(channels.name, updates.name),
          ne(channels.id, projectionChannel.id),
          isNull(channels.deletedAt)
        ));
      if (existing) {
        // Named only on the renaming server: another joint server's archived
        // channel is not this caller's to restore or open.
        if (existing.archivedAt && projectionChannel.serverId === channel.serverId) {
          throw new ArchivedNameCollisionError(updates.name, existing.id, existing.type);
        }
        throw new Error(`Channel name "${updates.name}" is already taken`);
      }
    }
  }

  const setValues: Record<string, unknown> = {};
  if (updates.name !== undefined) setValues.name = updates.name;
  if (updates.description !== undefined) setValues.description = updates.description || null;
  if (updates.threadSort !== undefined && updates.threadSort !== channel.threadSort) setValues.threadSort = updates.threadSort;
  if (updates.announcementArtifactId !== undefined) setValues.announcementArtifactId = updates.announcementArtifactId;
  if (allSystemVisibilityUpdate) {
    setValues.type = updates.type;
  } else if (updates.type !== undefined && updates.type !== channel.type) {
    setValues.type = updates.type;
  }
  const nextType = updates.type ?? channel.type;
  const nextGuestVisible = nextType === "private" && !isAllSystemChannel(channel)
    ? false
    : updates.guestVisible ?? channel.guestVisible;
  if (updates.guestVisible !== undefined || (nextType === "private" && !isAllSystemChannel(channel))) {
    setValues.guestVisible = nextGuestVisible;
  }

  if (Object.keys(setValues).length === 0) {
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
    // Restoring #all gives the members their rows back (hiding deleted them above).
    if (allSystemVisibilityUpdate && updates.type === "channel") {
      await ensureAllChannelHumanRows(tx, channel.serverId);
    }

    const [updated] = await tx.select().from(channels).where(eq(channels.id, channelId));

    if (channel.type === "channel" && updated.type === "private") {
      await pruneThreadFollowsOutsideParentMembership(channelId, tx);
    }

    return updated;
  };
  return applyUpdate(executor);
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

  const [mapping] = await executor.insert(jointChannelServers).values({
    jointChannelId: input.jointThreadId,
    serverId: input.localParentProjection.serverId,
    localChannelId: threadProjection.id,
    role: input.localParentProjection.role,
    status: "active",
    joinedByUserId: input.joinedByUserId,
  }).onConflictDoUpdate({
    // A server that disconnected and rejoined: reuse its old row.
    target: [jointChannelServers.jointChannelId, jointChannelServers.serverId],
    set: {
      localChannelId: threadProjection.id,
      role: input.localParentProjection.role,
      status: "active",
      joinedByUserId: input.joinedByUserId,
      joinedAt: currentDate(),
      disconnectedByUserId: null,
      disconnectedAt: null,
    },
    setWhere: eq(jointChannelServers.status, "disconnected"),
  }).returning({ localChannelId: jointChannelServers.localChannelId });
  if (mapping) return { localThreadChannelId: mapping.localChannelId, created: true };

  // A concurrent request mapped this server's projection first (an active row,
  // which the upsert leaves alone). Our row would be an unmapped thread nobody
  // can see, and the caller would write into it: drop it, use the mapped one.
  await executor.delete(channels).where(eq(channels.id, threadProjection.id));
  const [winner] = await executor
    .select({ localChannelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.jointChannelId, input.jointThreadId),
      eq(jointChannelServers.serverId, input.localParentProjection.serverId),
      eq(jointChannelServers.status, "active"),
    ))
    .limit(1);
  if (!winner) throw new Error("Joint thread projection not found");
  return { localThreadChannelId: winner.localChannelId, created: false };
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
  input: {
    localThreadChannelId?: string;
    localThreadChannelIds?: string[];
    canonicalThreadChannelId?: string;
    canonicalThreadChannelIds?: string[];
    serverId?: string;
  },
  executor: DatabaseExecutor = getDb(),
): Promise<JointThreadProjection[]> {
  const db = executor;
  const localThread = alias(channels, "joint_thread_local_thread");
  const canonicalThread = alias(channels, "joint_thread_canonical_thread");
  const parentMessage = alias(messages, "joint_thread_parent_message");
  const parentTask = alias(tasks, "joint_thread_parent_task");
  const parentJoint = alias(jointChannels, "joint_thread_parent_joint");
  const parentProjection = alias(jointChannelServers, "joint_thread_parent_projection");

  const filters = [
    eq(jointChannels.status, "active"),
    eq(jointChannelServers.status, "active"),
    eq(parentJoint.status, "active"),
    eq(parentProjection.status, "active"),
    // Threads and task conversations (task v2) project the same way; a local
    // face always has its canonical row's type.
    inArray(canonicalThread.type, ["thread", "task"]),
    sql`${localThread.type} = ${canonicalThread.type}`,
    // The parent is the durable local↔canonical identity anchor: for a thread
    // the parent message (stamped with the canonical thread id), for a task
    // conversation the task (pointing at its canonical conversation, and the
    // local face carrying the same task id). A swapped projection row must not
    // silently redirect reads or writes to another canonical conversation that
    // happens to share the parent channel; fail closed until it is repaired.
    sql`(
      (${canonicalThread.type} = 'thread' AND ${parentMessage.threadId} = ${canonicalThread.id}::text)
      OR (
        ${canonicalThread.type} = 'task'
        AND ${parentTask.conversationChannelId} = ${canonicalThread.id}
        AND ${localThread.taskId} = ${canonicalThread.taskId}
      )
    )`,
    isNull(localThread.deletedAt),
    isNull(canonicalThread.deletedAt),
  ];
  if (input.localThreadChannelId) filters.push(eq(jointChannelServers.localChannelId, input.localThreadChannelId));
  if (input.localThreadChannelIds) filters.push(inArray(jointChannelServers.localChannelId, input.localThreadChannelIds));
  if (input.canonicalThreadChannelId) filters.push(eq(jointChannels.canonicalChannelId, input.canonicalThreadChannelId));
  if (input.canonicalThreadChannelIds) filters.push(inArray(jointChannels.canonicalChannelId, input.canonicalThreadChannelIds));
  if (input.serverId) filters.push(eq(jointChannelServers.serverId, input.serverId));

  const canonicalParentChannelId = sql<string>`COALESCE(${parentMessage.channelId}, ${parentTask.channelId})`;
  const rows = await db
    .select({
      jointThreadId: jointChannels.id,
      localThreadChannelId: jointChannelServers.localChannelId,
      canonicalThreadChannelId: jointChannels.canonicalChannelId,
      localServerId: jointChannelServers.serverId,
      localParentChannelId: parentProjection.localChannelId,
      canonicalParentChannelId,
      canonicalType: canonicalThread.type,
      canonicalParentMessageId: canonicalThread.parentMessageId,
      canonicalParentTaskId: canonicalThread.taskId,
      role: jointChannelServers.role,
      threadChannel: localThread,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(localThread, eq(localThread.id, jointChannelServers.localChannelId))
    .innerJoin(canonicalThread, eq(canonicalThread.id, jointChannels.canonicalChannelId))
    .leftJoin(parentMessage, and(
      eq(parentMessage.id, canonicalThread.parentMessageId),
      eq(canonicalThread.type, "thread"),
    ))
    .leftJoin(parentTask, and(
      eq(parentTask.id, canonicalThread.taskId),
      eq(canonicalThread.type, "task"),
    ))
    .innerJoin(parentJoint, eq(parentJoint.canonicalChannelId, canonicalParentChannelId))
    .innerJoin(parentProjection, and(
      eq(parentProjection.jointChannelId, parentJoint.id),
      eq(parentProjection.serverId, jointChannelServers.serverId),
    ))
    .where(and(...filters))
    .orderBy(asc(jointChannelServers.joinedAt));

  return rows
    .filter((row) => (row.canonicalType === "thread" ? Boolean(row.canonicalParentMessageId) : Boolean(row.canonicalParentTaskId)))
    .map(({ canonicalType, ...row }) => ({
      ...row,
      kind: canonicalType === "task" ? "task" as const : "thread" as const,
      role: row.role as "host" | "participant",
    }));
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

// One round trip for a whole page of canonical Threads, scoped to the local
// Server. Same rows (and joined_at order) as calling
// getActiveJointThreadProjectionsByCanonicalThread per id and keeping the
// candidates whose localServerId is serverId.
export async function getActiveJointThreadProjectionsByCanonicalThreadsForServer(
  canonicalThreadChannelIds: string[],
  serverId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<JointThreadProjection[]> {
  if (canonicalThreadChannelIds.length === 0) return [];
  return listActiveJointThreadProjectionRows({ canonicalThreadChannelIds, serverId }, executor);
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
  const permission = await resolveJointHumanEntrySql({ serverId }, db);
  const result = await db.execute(sql`SELECT 1 FROM joint_channel_servers local
    JOIN joint_channel_servers peer ON peer.joint_channel_id=local.joint_channel_id AND peer.status='active'
    JOIN channel_agents ca ON ca.channel_id=peer.local_channel_id AND ca.agent_id=${agentId}::uuid
    JOIN agents a ON a.id=ca.agent_id AND a.server_id=peer.server_id AND a.deleted_at IS NULL
    WHERE local.server_id=${serverId}::uuid AND ${permission(sql`local.local_channel_id`,sql`${userId}::uuid`)}
      AND NOT (${jointMembershipRemovalPendingSql(sql`local.joint_channel_id`,"agent",sql`a.id`)}) LIMIT 1`);
  return result.rows.length > 0;
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
    .innerJoin(jointChannels, and(
      eq(jointChannels.id, sourceProjection.jointChannelId),
      eq(jointChannels.status, "active"),
    ))
    .innerJoin(siblingProjection, and(
      eq(siblingProjection.jointChannelId, sourceProjection.jointChannelId),
      eq(siblingProjection.status, "active"),
      ne(siblingProjection.serverId, sourceServerId),
    ))
    .where(eq(channelAgents.agentId, agentId));

  return [...new Set(rows.map((row) => row.localChannelId))];
}

/** null means invisible; a visible J identity may have no current source. */
export async function getComputedJointVisibleHuman(serverId: string, requesterId: string, targetIds?: readonly string[]) {
  const db = getDb();
  const projections = await db.select({ id: jointChannelServers.localChannelId }).from(jointChannelServers)
    .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
    .where(and(eq(jointChannelServers.serverId, serverId), eq(channels.type, "joint")));
  const scopes = await resolveJointHumanMembershipScopes({ localChannelIds: projections.map(row => row.id) }, db);
  const allowed = await filterJointHumanMemberEntries([...scopes.values()], requesterId, db);
  const humans = new Map<string, Awaited<ReturnType<typeof getComputedJointHumanPublicRows>>[number]>();
  const rows=await getComputedJointHumanPublicRowsForScopes([...scopes.values()].filter(scope=>allowed.has(scope.localChannelId)),targetIds,db);
  for(const {human} of rows) if(!humans.has(human.id)) humans.set(human.id,human);
  return humans;
}

export async function getJointVisibleHumanServerId(serverId: string, requesterId: string, targetUserId: string): Promise<string | null> {
  const computed = await getComputedJointVisibleHuman(serverId, requesterId, [targetUserId]);
  return computed.get(targetUserId)?.serverId || null;
}

export async function canUserSeeHumanThroughLocalChannel(serverId: string, requesterId: string, targetUserId: string): Promise<boolean> {
  if (requesterId === targetUserId) return true;
  if ((await getComputedJointVisibleHuman(serverId, requesterId, [targetUserId])).has(targetUserId)) return true;

  const db = getDb();
  const requesterRole = await resolveHumanServerRole(serverId, requesterId);
  const targetHumans = alias(channelHumans, "hidden_profile_target_humans");
  if (requesterRole === "guest") {
    // A Guest sees the people of its one readable channel, nobody else.
    return (await guestReadableChannelHumanIds(serverId, requesterId, [targetUserId])).has(targetUserId);
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

/**
 * canUserSeeHumanThroughLocalChannel for many people at once: the ones of
 * `targetUserIds` it answers true for, in a fixed number of queries whatever
 * their number. The same rule: the requester itself; for a Guest, the members
 * of its one readable channel; for anyone else, anyone sharing a
 * conversation of this server with them, not deleted and not #all.
 */
export async function canUserSeeHumansThroughLocalChannel(serverId: string, requesterId: string, targetUserIds: readonly string[]): Promise<Set<string>> {
  const visible = new Set<string>(targetUserIds.includes(requesterId) ? [requesterId] : []);
  const others = [...new Set(targetUserIds)].filter((id) => id !== requesterId);
  if (others.length === 0) return visible;
  const show = (ids: Iterable<string>) => { for (const id of ids) visible.add(id); };

  if (await resolveHumanServerRole(serverId, requesterId) !== "guest") {
    show(await getHumanIdsVisibleThroughLocalChannels(serverId, requesterId, others));
    return visible;
  }
  show(await guestReadableChannelHumanIds(serverId, requesterId, others));
  return visible;
}

/**
 * Of `targetUserIds`, the people a Guest may see: members of its one channel,
 * when that channel is readable to it (canGuestReadChannel). Empty for a
 * legacy Guest with no binding.
 */
async function guestReadableChannelHumanIds(serverId: string, guestId: string, targetUserIds: readonly string[]): Promise<Set<string>> {
  const db = getDb();
  const guestChannelId = await getGuestChannelId(serverId, guestId, db);
  if (!guestChannelId || targetUserIds.length === 0) return new Set();
  const [channel] = await db.select({ id: channels.id, type: channels.type, archivedAt: channels.archivedAt, deletedAt: channels.deletedAt })
    .from(channels)
    .where(and(eq(channels.id, guestChannelId), eq(channels.serverId, serverId)))
    .limit(1);
  if (!channel) return new Set();
  if (channel.type === "joint") {
    // P3: the people of the whole joint channel (every server), when the
    // Guest enters it through its host projection. Simplified cards only:
    // the profile route reduces them (toChannelScopedHumanProfile).
    if (channel.archivedAt !== null || channel.deletedAt !== null) return new Set();
    if (!(await filterGuestJointEntries(serverId, guestId, guestChannelId, [channel], db)).has(channel.id)) return new Set();
    return jointConversationHumanIds(guestChannelId, targetUserIds, db);
  }
  const members = await db.select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, guestChannelId), inArray(channelHumans.userId, [guestId, ...targetUserIds])));
  const memberIds = new Set(members.map((row) => row.userId));
  if (!canGuestReadChannel({
    serverRole: "guest",
    channelId: channel.id,
    guestChannelId,
    channelType: channel.type,
    isChannelMember: memberIds.has(guestId),
    archived: channel.archivedAt !== null,
    deleted: channel.deletedAt !== null,
  })) return new Set();
  return new Set(targetUserIds.filter((id) => memberIds.has(id)));
}

/**
 * Of `targetUserIds`, the humans currently in the joint channel whose local
 * projection is `localChannelId`, through any active entry of any server
 * (resolveJointHumanEntrySql: J membership, guest rule).
 */
async function jointConversationHumanIds(localChannelId: string, targetUserIds: readonly string[], db: DatabaseExecutor): Promise<Set<string>> {
  if (targetUserIds.length === 0) return new Set();
  const [projection] = await db.select({ jointId: jointChannelServers.jointChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, localChannelId)).limit(1);
  if (!projection) return new Set();
  const allowed = await resolveJointHumanEntrySql({ jointIds: [projection.jointId] }, db);
  const rows = await db.execute<{ userId: string }>(sql`
    SELECT t.user_id::text AS "userId" FROM unnest(${sql.param([...new Set(targetUserIds)])}::uuid[]) AS t(user_id)
    WHERE EXISTS (SELECT 1 FROM joint_channel_servers jp
      WHERE jp.joint_channel_id=${projection.jointId}::uuid AND jp.status='active'
        AND ${allowed(sql`jp.local_channel_id`, sql`t.user_id`)})`);
  return new Set(rows.rows.map((row) => row.userId));
}

/**
 * `candidateIds` narrows the answer to those humans in SQL (and drops #all
 * there too), so a batched lookup reads at most "requester's channels x
 * candidates" rows instead of every co-member (Ray, #11193). Without it the
 * whole set is returned, as before.
 */
export async function getHumanIdsVisibleThroughLocalChannels(serverId: string, requesterId: string, candidateIds?: readonly string[]): Promise<Set<string>> {
  if (candidateIds && candidateIds.length === 0) return new Set();
  const db = getDb();
  const visibleHumans = alias(channelHumans, "hidden_directory_visible_humans");
  const rows = await db
    .select({
      userId: visibleHumans.userId,
      name: channels.name,
      type: channels.type,
    })
    .from(channelHumans)
    .innerJoin(visibleHumans, candidateIds
      ? and(eq(visibleHumans.channelId, channelHumans.channelId), inArray(visibleHumans.userId, [...candidateIds]))
      : eq(visibleHumans.channelId, channelHumans.channelId))
    .innerJoin(channels, and(
      eq(channels.id, channelHumans.channelId),
      eq(channels.serverId, serverId),
      isNull(channels.deletedAt),
      candidateIds
        ? not(and(eq(channels.name, SYSTEM_ALL_CHANNEL_KEY), inArray(channels.type, ["channel", "private"]))!)
        : undefined,
    ))
    .where(eq(channelHumans.userId, requesterId));

  const visible = new Set(rows.filter(channel => !isAllSystemChannel(channel)).map(channel => channel.userId));
  for (const id of (await getComputedJointVisibleHuman(serverId, requesterId, candidateIds)).keys()) visible.add(id);
  return visible;
}

export async function getHumanIdsVisibleThroughJointChannels(serverId: string, requesterId: string): Promise<Set<string>> {
  return new Set((await getComputedJointVisibleHuman(serverId, requesterId)).keys());
}

export async function canUserSeeHumanThroughJointChannel(serverId: string, requesterId: string, targetUserId: string): Promise<boolean> {
  return (await getComputedJointVisibleHuman(serverId, requesterId, [targetUserId])).has(targetUserId);
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
  const start = currentTimeMs();
  // The parent's live threads (parent message in the channel) and Task v2
  // conversations (parent on the row), resolved once through their indexes.
  // Matching each follow against them in the DELETE (EXISTS ... OR EXISTS)
  // read every follow of the type: all of thread_follows (~2.3M rows), 6-9 s
  // on production (#triage:#142).
  const scope = await executor.execute<{ id: string }>(sql`
    SELECT parent_threads.id
    FROM ${channels} parent_threads
    INNER JOIN ${messages} parent_messages
      ON parent_messages.id = parent_threads.parent_message_id
    WHERE parent_threads.type = 'thread'
      AND parent_threads.deleted_at IS NULL
      AND parent_messages.channel_id = ${parentChannelId}
    UNION ALL
    SELECT task_conversations.id
    FROM ${channels} task_conversations
    WHERE task_conversations.type = 'task'
      AND task_conversations.deleted_at IS NULL
      AND task_conversations.parent_channel_id = ${parentChannelId}
  `);
  const scopeIds = scope.rows.map((row) => row.id);
  const inScope = sql`${threadFollows.threadChannelId} = ANY(${`{${scopeIds.join(",")}}`}::uuid[])`;
  const userResult = scopeIds.length === 0 ? { rows: [] } : await executor.execute(sql`
    DELETE FROM ${threadFollows}
    WHERE ${threadFollows.followerType} = 'user'
      AND ${inScope}
      AND NOT EXISTS (
        SELECT 1
        FROM ${channelHumans}
        WHERE ${channelHumans.channelId} = ${parentChannelId}
          AND ${channelHumans.userId} = ${threadFollows.followerId}
      )
    RETURNING 1
  `);

  const agentResult = scopeIds.length === 0 ? { rows: [] } : await executor.execute(sql`
    DELETE FROM ${threadFollows}
    WHERE ${threadFollows.followerType} = 'agent'
      AND ${inScope}
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
    scope_count: scopeIds.length,
    duration_ms: currentTimeMs() - start,
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
  executor?: DatabaseExecutor;
}): Promise<ChannelAccessResolution | null> {
  const resolved = await resolveChannelAccessMany({
    serverId: input.serverId,
    channelIds: [input.channelId],
    includeDeleted: input.includeDeleted,
    executor: input.executor,
  });
  return resolved.get(input.channelId) ?? null;
}

/**
 * resolveChannelAccess for many channel ids of one server in at most two
 * queries (the channels, then the active projections of the joint ones). The
 * single entry point of the local/joint access rule: a channel resolves when it
 * exists (not deleted unless includeDeleted), belongs to `serverId`, and, for a
 * joint channel, has an active projection in that server under an active joint.
 * Ids that do not resolve are absent from the map.
 */
export async function resolveChannelAccessMany(input: {
  serverId: string;
  channelIds: readonly string[];
  includeDeleted?: boolean;
  executor?: DatabaseExecutor;
}): Promise<Map<string, ChannelAccessResolution>> {
  const resolved = new Map<string, ChannelAccessResolution>();
  const channelIds = [...new Set(input.channelIds)];
  if (channelIds.length === 0) return resolved;
  const db = input.executor ?? getDb();
  const conditions = [inArray(channels.id, channelIds)];
  if (!input.includeDeleted) conditions.push(isNull(channels.deletedAt));
  const channelRows = (await db.select().from(channels).where(and(...conditions)))
    .filter((channel) => channel.serverId === input.serverId);

  const jointIds = channelRows.filter((channel) => channel.type === "joint").map((channel) => channel.id);
  const projections = jointIds.length === 0 ? [] : await db
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
      inArray(jointChannelServers.localChannelId, jointIds),
      eq(jointChannelServers.serverId, input.serverId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ));
  const projectionByLocal = new Map<string, (typeof projections)[number]>();
  for (const projection of projections) {
    if (!projectionByLocal.has(projection.localChannelId)) projectionByLocal.set(projection.localChannelId, projection);
  }

  for (const channel of channelRows) {
    if (channel.type !== "joint") {
      resolved.set(channel.id, {
        kind: "local",
        localChannelId: channel.id,
        canonicalChannelId: channel.id,
        serverId: channel.serverId,
        channel,
      });
      continue;
    }
    const projection = projectionByLocal.get(channel.id);
    if (!projection) continue;
    resolved.set(channel.id, {
      kind: "joint",
      localChannelId: projection.localChannelId,
      canonicalChannelId: projection.canonicalChannelId,
      jointChannelId: projection.jointChannelId,
      localServerId: projection.localServerId,
      role: projection.role,
      channel,
    });
  }
  return resolved;
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
  /** Null for an archive no person asked for (a joint whose host side emptied). */
  archivedByUserId: string | null,
  executor?: DatabaseExecutor,
  opts?: ArchiveOptions,
): Promise<typeof channels.$inferSelect> {
  if (!executor) {
    const endedGuests: EndedChannelGuest[] = [];
    // The archiver's and the bound Guests' users rows first (lockJointUsersFirst; only locked: no route's refusal here).
    const archived = await withJointUsersGuessed(async () => [archivedByUserId, ...await archiveBoundGuestIds(channelId)], (lockedUserIds) => withChannelWriterFence(channelId, async (tx) => {
      endedGuests.length = 0;
      await lockJointUsersFirst(tx, { userIds: [...lockedUserIds] });
      await lockJointLifecycleOfChannel(tx, channelId);
      return archiveChannel(channelId, archivedByUserId, tx, { endedGuests, lockedUserIds });
    }));
    await finishEndedChannelGuests(archived.serverId, endedGuests);
    await revokeBoundGuestSockets(channelId);
    return archived;
  }
  await assertChannelWritableInTransaction(executor, channelId);
  const db = executor ?? getDb();
  const channel = await getChannel(channelId, { executor: db });
  if (!channel) throw new Error("Channel not found");
  if (!REGULAR_CHANNEL_TYPES.includes(channel.type as RegularChannelType) && channel.type !== "joint") throw new Error("Only regular channels can be archived");
  if (isAllSystemChannel(channel)) throw new Error("The #all channel cannot be archived");
  if (channel.archivedAt) return channel;

  if (channel.type === "joint") {
    const projections = await getActiveJointChannelProjectionsByLocalChannel(channelId, db);
    const projectionIds = projections.length > 0
      ? projections.map((projection) => projection.localChannelId)
      : [channelId];
    const archivedRows = await db.update(channels)
      .set({ archivedAt: currentDate(), archivedByUserId, archivedByAgentId: null })
      .where(inArray(channels.id, projectionIds))
      .returning();
    await closeArchivedJointToExternalPeople(db, channel, archivedRows, archivedByUserId, opts);
    await reconcileExternalFreezesAfterArchiveChange(db, channel, projections, true);
    // This entry's row: callers announce on the channel they archived.
    return archivedRows.find((row) => row.id === channelId) ?? archivedRows[0] ?? channel;
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
    // Guests and open invites first: the freeze reconcile then counts the
    // channel without them (clear-only, no admission locks on this path).
    await closeArchivedChannelToExternalPeople(tx, updated, archivedByUserId, opts);
    await reconcileExternalFreezesAfterArchiveChange(tx, updated, [], true);
    return updated;
  };
  return executor ? applyArchive(executor) : getDb().transaction(applyArchive);
}

/**
 * Archiving or unarchiving a channel removes it from, or returns it to, the
 * external channels of its server (and, for a joint, of every server active
 * in it): the free plan's freeze follows in the same transaction. After the
 * channel writes; no joint row is locked here.
 */
async function reconcileExternalFreezesAfterArchiveChange(
  executor: DatabaseExecutor,
  channel: { serverId: string },
  projections: ReadonlyArray<{ serverId: string }>,
  archived: boolean,
): Promise<void> {
  const serverIds = [...new Set([channel.serverId, ...projections.map((projection) => projection.serverId)])];
  await reconcileServerExternalFreezes(executor, serverIds, currentDate(), { clearOnly: archived });
}

/**
 * An archive's: `endedGuests` collects the Guests it removed (finished after
 * commit); `lockedUserIds`, the users rows its transaction took first
 * (lockJointUsersFirst: the archiver and the bound Guests guessed by
 * archiveBoundGuestIds), against which the Guests read under the channel
 * lock are checked (a new one restarts it: JointUsersLockSetChangedError).
 */
export interface ArchiveOptions {
  endedGuests?: EndedChannelGuest[];
  lockedUserIds?: ReadonlySet<string>;
}

/**
 * The Guests an archive of `channelId` would remove (bound to it or, for a
 * joint, to any active projection), read without a lock: the set its users
 * lock takes first (withJointUsersGuessed), re-read under the channel lock.
 */
export async function archiveBoundGuestIds(channelId: string, executor: DatabaseExecutor = getDb()): Promise<string[]> {
  const channelIds = [channelId, ...(await getActiveJointChannelProjectionsByLocalChannel(channelId, executor)).map((projection) => projection.localChannelId)];
  return (await executor.select({ userId: serverMembers.userId }).from(serverMembers)
    .where(and(eq(serverMembers.role, "guest"), inArray(serverMembers.guestChannelId, [...new Set(channelIds)]))))
    .map((row) => row.userId);
}

/** A Guest whose server membership ended with its channel; finished after commit (finishEndedChannelGuests). */
export interface EndedChannelGuest {
  userId: string;
  effects: RemovedMemberEffects;
  /** The server it left, when not the archived channel's own (a joint's other projections). */
  serverId?: string;
}

/**
 * P3: archiving a joint channel closes it to external people as an ordinary
 * channel's archive does (closeArchivedChannelToExternalPeople), on every
 * projection it archived: open invites are revoked and each Guest bound to a
 * projection leaves that projection's server. A membership write, so it does
 * not read the host's external_channels_v1 (jointEntryIdentitySql's rule).
 * The bound Guests' member rows are already locked, before J
 * (lockBoundJointGuestMemberships).
 */
async function closeArchivedJointToExternalPeople(
  tx: DatabaseExecutor,
  channel: { id: string; serverId: string },
  archivedRows: ReadonlyArray<typeof channels.$inferSelect>,
  actorUserId: string | null,
  opts: ArchiveOptions | undefined,
): Promise<void> {
  void channel;
  if (archivedRows.length === 0) return;
  for (const row of [...archivedRows].sort((a, b) => a.id.localeCompare(b.id))) {
    const ended: EndedChannelGuest[] = [];
    await closeArchivedChannelToExternalPeople(tx, row, actorUserId, { endedGuests: ended, lockedUserIds: opts?.lockedUserIds });
    for (const guest of ended) opts?.endedGuests?.push({ ...guest, serverId: row.serverId });
  }
}

/**
 * Archiving ends a channel's ties to people outside the server, in the
 * archive's transaction (owner decision 2026-11-03): its open invites and
 * approval requests are revoked, and each Guest bound to it leaves the server,
 * as on channel deletion. Unarchiving brings neither back: they need new
 * invites. The channel row is locked by the caller; then the invite rows, the
 * server and the Guests' membership rows (lock order of deleteChannel), each
 * Guest re-checked under its lock, so one promoted meanwhile stays a member.
 * The departure is recorded as `removed` by the archiving person (none for an
 * agent), as for any removal. The archiver's and the Guests' users rows were
 * taken first (`lockedUserIds`): a Guest bound since that guess restarts the
 * archive (JointUsersLockSetChangedError), before any of its rows is taken.
 */
async function closeArchivedChannelToExternalPeople(
  tx: DatabaseExecutor,
  channel: typeof channels.$inferSelect,
  actorUserId: string | null,
  opts: ArchiveOptions | undefined,
): Promise<void> {
  const endedGuests = opts?.endedGuests;
  // Under the channel row's lock (nothing binds a Guest to it without that lock).
  const guestIds = await boundGuestIds(tx, channel.serverId, channel.id);
  if (opts?.lockedUserIds) assertJointUsersLocked(opts.lockedUserIds, guestIds);
  const { revokeOpenInvitesForArchivedChannel } = await import("./externalInviteService");
  await revokeOpenInvitesForArchivedChannel(tx, channel.id, actorUserId);
  if (guestIds.length === 0) return;
  const { lockServerMembershipsAfterChannel, removeMemberInTransaction } = await import("./serverService");
  await lockServerMembershipsAfterChannel(tx as DatabaseTransaction, channel.serverId, guestIds);
  for (const userId of guestIds) {
    const effects = await removeMemberInTransaction(tx as DatabaseTransaction, channel.serverId, userId, {
      onlyIfGuestBoundTo: channel.id,
      reason: "removed",
      actorUserId,
    });
    if (effects) endedGuests?.push({ userId, effects });
  }
}

/** After the archive's commit: the ended Guests' sockets, notifications and credentials, as for any removal. */
export async function finishEndedChannelGuests(serverId: string, endedGuests: readonly EndedChannelGuest[]): Promise<void> {
  if (endedGuests.length === 0) return;
  const { finishRemovedMember } = await import("./serverService");
  for (const guest of endedGuests) await finishRemovedMember(guest.serverId ?? serverId, guest.userId, guest.effects);
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
  opts?: ArchiveOptions,
): Promise<{ channel: typeof channels.$inferSelect; changed: boolean }> {
  if (!executor) {
    const admissionServerIds = archived ? [] : await unarchiveAdmissionServerIds(channelId);
    const endedGuests: EndedChannelGuest[] = [];
    // An archive's bound Guests' users rows first (lockJointUsersFirst), before the admission locks.
    const result = await withJointUsersGuessed(async () => archived ? archiveBoundGuestIds(channelId) : [], (lockedUserIds) => withChannelWriterFence(channelId, async (tx) => {
      endedGuests.length = 0;
      await lockJointUsersFirst(tx, { userIds: [...lockedUserIds] });
      await acquireServerAdmissionLocks(tx, admissionServerIds);
      await lockJointLifecycleOfChannel(tx, channelId);
      return setLocalChannelArchivedByAgent(channelId, archivedByAgentId, archived, tx, { endedGuests, lockedUserIds });
    }));
    await finishEndedChannelGuests(result.channel.serverId, endedGuests);
    if (archived && result.channel.archivedAt) await revokeBoundGuestSockets(channelId);
    return result;
  }
  await assertChannelWritableInTransaction(executor, channelId);
  const db = executor ?? getDb();
  const current = await getChannel(channelId, { executor: db });
  if (!current) throw new Error("Channel not found");
  if (!REGULAR_CHANNEL_TYPES.includes(current.type as RegularChannelType) && current.type !== "joint") {
    throw new Error("Only regular channels can be archived");
  }
  if (isAllSystemChannel(current)) throw new Error("The #all channel cannot be archived");

  if (!archived && current.archivedAt) await assertUnarchiveKeepsExternalLimit(db, current);
  if (current.type === "joint") {
    // Same shape as the human joint archive: the archive is shared, so every
    // active projection flips together.
    const projections = await getActiveJointChannelProjectionsByLocalChannel(channelId, db);
    const projectionIds = projections.length > 0
      ? projections.map((projection) => projection.localChannelId)
      : [channelId];
    const changedRows = await db.update(channels)
      .set(archived
        ? { archivedAt: currentDate(), archivedByUserId: null, archivedByAgentId }
        : { archivedAt: null, archivedByUserId: null, archivedByAgentId: null })
      .where(and(
        inArray(channels.id, projectionIds),
        archived ? isNull(channels.archivedAt) : isNotNull(channels.archivedAt),
      ))
      .returning();
    if (archived) await closeArchivedJointToExternalPeople(db, current, changedRows, null, opts);
    if (changedRows.length > 0) await reconcileExternalFreezesAfterArchiveChange(db, current, projections, archived);
    const updatedLocal = changedRows.find((row) => row.id === channelId);
    if (updatedLocal) return { channel: updatedLocal, changed: true };
    const [unchanged] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!unchanged) throw new Error("Channel not found");
    return { channel: unchanged, changed: changedRows.length > 0 };
  }

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
      if (archived) {
        await emitPublicChannelArchiveEvents(tx, updated, "agent");
        // Guests and open invites before the freeze reconcile (clear-only on archive).
        await closeArchivedChannelToExternalPeople(tx, updated, null, opts);
      }
      await reconcileExternalFreezesAfterArchiveChange(tx, updated, [], archived);
      return { channel: updated, changed: true };
    }
    const [unchanged] = await tx.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!unchanged) throw new Error("Channel not found");
    return { channel: unchanged, changed: false };
  };
  return executor ? applyArchive(executor) : getDb().transaction(applyArchive);
}

/**
 * The servers whose admission locks an unarchive takes first
 * (ADMISSION_LOCK_ORDER rule 1; the conversion fence may come before): the
 * channel's server and every server active in its joint. An unlocked read,
 * for the caller to lock before anything else; the unarchive re-reads the
 * joint under its lifecycle lock.
 */
export async function unarchiveAdmissionServerIds(channelId: string, executor: DatabaseExecutor = getDb()): Promise<string[]> {
  const [channel] = await executor.select({ serverId: channels.serverId }).from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!channel) return [];
  const projections = await getActiveJointChannelProjectionsByLocalChannel(channelId, executor);
  return [...new Set([channel.serverId, ...projections.map((projection) => projection.serverId)])].sort();
}

/**
 * An unarchive makes the channel external again: the free plan's one
 * external channel rule applies as on an admission (free_external_limit).
 */
async function assertUnarchiveKeepsExternalLimit(executor: DatabaseExecutor, channel: { id: string; serverId: string; type: string }): Promise<void> {
  const projections = channel.type === "joint" ? await getActiveJointChannelProjectionsByLocalChannel(channel.id, executor) : [];
  await assertCanUnarchiveExternalChannel(executor, { channel, projections, now: currentDate() });
}

/**
 * Unarchive a channel. Idempotent on already-active channels. Refuses
 * (ExternalChannelLimitError, free_external_limit) when it would put a free
 * server in more than one external channel.
 */
export async function unarchiveChannel(channelId: string, executor?: DatabaseExecutor): Promise<typeof channels.$inferSelect> {
  if (!executor) {
    const admissionServerIds = await unarchiveAdmissionServerIds(channelId);
    return withChannelWriterFence(channelId, async (tx) => {
      await acquireServerAdmissionLocks(tx, admissionServerIds);
      await lockJointLifecycleOfChannel(tx, channelId);
      return unarchiveChannel(channelId, tx);
    });
  }
  await assertChannelWritableInTransaction(executor, channelId);
  const db = executor ?? getDb();
  const channel = await getChannel(channelId, { executor: db });
  if (!channel) throw new Error("Channel not found");
  if (!REGULAR_CHANNEL_TYPES.includes(channel.type as RegularChannelType) && channel.type !== "joint") throw new Error("Only regular channels can be unarchived");
  if (!channel.archivedAt) return channel;
  await assertUnarchiveKeepsExternalLimit(db, channel);

  if (channel.type === "joint") {
    const projections = await getActiveJointChannelProjectionsByLocalChannel(channelId, db);
    const projectionIds = projections.length > 0
      ? projections.map((projection) => projection.localChannelId)
      : [channelId];
    const unarchivedRows = await db.update(channels)
      .set({ archivedAt: null, archivedByUserId: null, archivedByAgentId: null })
      .where(inArray(channels.id, projectionIds))
      .returning();
    await reconcileExternalFreezesAfterArchiveChange(db, channel, projections, false);
    // This entry's row (as archiveChannel): callers announce on the channel they unarchived.
    return unarchivedRows.find((row) => row.id === channelId) ?? unarchivedRows[0] ?? channel;
  }

  const [updated] = await db.update(channels)
    .set({ archivedAt: null, archivedByUserId: null, archivedByAgentId: null })
    .where(eq(channels.id, channelId))
    .returning();
  await reconcileExternalFreezesAfterArchiveChange(db, channel, [], false);
  return updated;
}

/**
 * Archive state and effective root are read by the same walk. Threads/tasks
 * inherit their parent's archived state. Ordinary sends reuse the root type
 * without adding a separate DM eligibility query.
 */
type ChannelArchiveState = { archived: boolean; rootType: typeof channels.$inferSelect.type | null };

/**
 * `lockRoot`: the root's archived state is decided by a FOR SHARE read of its
 * row in the ambient transaction (the row archiveChannel and unarchiveChannel
 * update), so an archive committed first is seen and a later one waits for the
 * caller's commit. Only the root is locked: a thread's or task's own row is
 * never archived (RFC 082 §4.6, the card edit's attempt admission).
 */
export type ChannelArchiveReadOptions = { lockRoot?: boolean };

async function getChannelArchiveState(channelId: string, options: ChannelArchiveReadOptions = {}): Promise<ChannelArchiveState> {
  const channel = await getChannel(channelId);
  if (!channel) return { archived: false, rootType: null };
  if (channel.archivedAt) return { archived: true, rootType: channel.type };
  // Task conversation (task v2): archived with its parent channel.
  if (channel.type === "task") {
    return channel.parentChannelId ? getChannelArchiveState(channel.parentChannelId, options) : { archived: false, rootType: channel.type };
  }
  if (isSubConversationType(channel.type)) {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    if (jointThread) {
      return getChannelArchiveState(jointThread.localParentChannelId, options);
    }
  }

  if (channel.type === "thread" && channel.parentMessageId) {
    const db = getDb();
    const [parentMsg] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return { archived: false, rootType: channel.type };
    return getChannelArchiveState(parentMsg.channelId, options);
  }
  if (options.lockRoot) {
    const [root] = await getDb().select({ archivedAt: channels.archivedAt }).from(channels)
      .where(eq(channels.id, channelId)).for("share");
    return { archived: Boolean(root?.archivedAt), rootType: channel.type };
  }
  return { archived: false, rootType: channel.type };
}

export async function isChannelArchived(channelId: string, options: ChannelArchiveReadOptions = {}): Promise<boolean> {
  return (await getChannelArchiveState(channelId, options)).archived;
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
export async function assertChannelNotArchived(channelId: string): Promise<Pick<ChannelArchiveState, "rootType"> | void> {
  const state = await getChannelArchiveState(channelId);
  if (state.archived) throw new ChannelArchivedError(channelId);
  // The send path reuses the root already read by this archive walk; it must
  // not run a second parent lookup just to decide whether this is a DM.
  return { rootType: state.rootType };
}

/**
 * Soft-delete a channel. `options.deletedByUserId`: the person deleting it,
 * recorded on a joint copy it retires (joint_channel_servers
 * disconnected_by_user_id, joint_membership_departures actor_user_id).
 */
export async function deleteChannel(channelId: string, options: { deletedByUserId?: string } = {}) {
  const db = getDb();
  const channel = await getChannel(channelId, { includeDeleted: true });

  if (!channel) return;

  // Prevent deletion of the built-in #all channel
  if (isAllSystemChannel(channel)) {
    throw new Error("The #all channel cannot be deleted");
  }

  const now = currentDate();
  let endedGuests: Array<{ userId: string; effects: RemovedMemberEffects }> = [];

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
  for (let attempt = 0; ; attempt += 1) {
    // The Guests it removes, guessed unlocked: their users rows are taken first below.
    const guessedGuests = await boundGuestIds(db, channel.serverId, channelId);
    endedGuests = [];
    try {
      await withChannelWriterFence(channelId, (tx) => deleteChannelInTransaction(tx, channel, options, guessedGuests, now, endedGuests));
      break;
    } catch (err) {
      if (!(err instanceof ChannelGuestsChanged)) throw err;
      if (attempt >= 2) throw new Error("The channel's Guests changed while it was deleted; try again");
    }
  }

  if (endedGuests.length > 0) {
    const { finishRemovedMember } = await import("./serverService");
    for (const guest of endedGuests) await finishRemovedMember(channel.serverId, guest.userId, guest.effects);
  }
}

/** deleteChannel found, under the channel lock, a bound Guest its users lock did not take: restart. */
class ChannelGuestsChanged extends Error {}

async function deleteChannelInTransaction(
  tx: DatabaseTransaction,
  channel: { id: string; serverId: string },
  options: { deletedByUserId?: string },
  guessedGuests: readonly string[],
  now: Date,
  endedGuests: Array<{ userId: string; effects: RemovedMemberEffects }>,
): Promise<void> {
  const channelId = channel.id;
  // The users rows first (lockJointUsersFirst): the deleter's (a joint
  // copy's retirement names them) and the bound Guests' (their removal's
  // departure and membership-end rows name them), before the channel row:
  // taken only by those rows' FK checks, after the channel, server and
  // member rows, a Guest's or the deleter's row closes a cycle with their
  // account deletion (users row FOR UPDATE, then the servers they own).
  // The deleter retired or being deleted: refused (JointActorUnavailableError).
  await lockJointUsersFirst(tx, { actorUserId: options.deletedByUserId, userIds: guessedGuests });
  // Global lock order channel -> server -> member -> joint -> channel
  // membership. The channel row, then the server and its bound Guests'
  // membership rows (read under the channel lock: nothing binds a Guest to a
  // channel without it), before the joint mirror (#wg-rbac:#15).
  await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId)).for("update");
  const preliminaryGuests = await boundGuestIds(tx, channel.serverId, channelId);
  if (preliminaryGuests.some((guestId) => !guessedGuests.includes(guestId))) throw new ChannelGuestsChanged();
  if (preliminaryGuests.length > 0) {
    const { lockServerMembershipsAfterChannel } = await import("./serverService");
    await lockServerMembershipsAfterChannel(tx, channel.serverId, preliminaryGuests);
  }
  await lockJointHumanMembershipChannel(tx, channelId);
  const mirrorHumans = await prepareJointHumanMembershipMirror(tx, { channelIds: [channelId] }, "retire");
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
      // A status change: Tasks-page activity (taskService.TASK_ACTIVITY_NOW).
      lastActivityAt: sql`now()`,
    })
    .where(and(
      eq(tasks.channelId, channelId),
      // Backlog too: it isn't active, but it isn't over either, and a dead
      // channel keeps nothing that may come back.
      inArray(tasks.status, ["backlog", "todo", "in_progress", "in_review"]),
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
  await mirrorHumans.apply(undefined, options.deletedByUserId ? { actorUserId: options.deletedByUserId } : {});

  // A Guest exists only for this channel: deleting it ends its Guests' server
  // membership through the normal removal, in the same commit (#wg-rbac:#15).
  // Their membership rows are locked above; each is re-checked under that
  // lock, so a Guest promoted meanwhile keeps its membership.
  if (preliminaryGuests.length > 0) {
    const { removeMemberInTransaction } = await import("./serverService");
    for (const guestId of preliminaryGuests) {
      const guest = { userId: guestId };
      // Re-checked under the membership lock: a Guest promoted meanwhile keeps its membership.
      const effects = await removeMemberInTransaction(tx, channel.serverId, guest.userId, { onlyIfGuestBoundTo: channelId, reason: "removed" });
      if (!effects) continue;
      // The server removal skips soft-deleted channels, and this one already is:
      // drop the Guest's row here (read cursors stay, as for any removal).
      await tx.delete(channelHumans).where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, guest.userId)));
      endedGuests.push({ userId: guest.userId, effects });
    }
  }
  // A deleted channel is no longer external: the free plan's freeze follows
  // in the same commit (its Guests' removal above already reconciled).
  await reconcileServerExternalFreeze(tx, channel.serverId, now, { clearOnly: true });
}

/** Payload reason marking an unassign the disconnect caused, not a person choosing. */
export const TASK_UNASSIGN_REASON_JOINT_DISCONNECTED = "joint_channel_disconnected";

/**
 * With external_channels_v1 on for the host server, the host's copy of a joint
 * channel can't be disconnected: its owner/admins may only remove the other servers
 * (disconnectParticipantServerByHost, behind the same flag).
 */
export class JointHostDisconnectError extends Error {
  readonly code = "host_cannot_disconnect";
  constructor() {
    super("The host server can't disconnect from its own channel. Archive the channel instead.");
  }
}

/**
 * A projection with bound Guests is not disconnected (P3, Cody/Tenny on PR
 * #13205), whatever external_channels_v1 says: the disconnect would delete
 * the channel the Guests are bound to and strand them. Remove them first.
 */
export class JointGuestsPresentError extends Error {
  readonly code = "guests_present";
  constructor() {
    super("This channel has guests. Remove them before disconnecting this server.");
  }
}

/**
 * The writes of one projection's disconnect, after the caller authorized it
 * and while it holds the projection's channel row (lockJointHumanMembershipChannel)
 * and the actor's joint locks (lockComputedJointActor). Shared by a server
 * disconnecting itself (disconnectJointChannel) and the host disconnecting a
 * participant (disconnectParticipantServerByHost).
 */
async function disconnectJointProjectionInTransaction(
  tx: DatabaseExecutor,
  { channelId, serverId, projection, disconnectedByUserId, now }: {
    channelId: string;
    serverId: string;
    projection: { jointChannelId: string; canonicalChannelId: string };
    disconnectedByUserId: string;
    now: Date;
  },
): Promise<void> {
  // Under the projection's row lock (lockJointHumanMembershipChannel, taken by
  // the caller), which a Guest's invite acceptance takes before binding: none slips in.
  if (await boundGuestIds(tx, serverId, channelId).then((ids) => ids.length > 0)) throw new JointGuestsPresentError();
  const mirrorHumans = await prepareJointHumanMembershipMirror(tx, { channelIds: [channelId] }, "disconnect");
  await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
  await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
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
  // This copy's pending invites leave their invitees' lists (the mirror's
  // apply below says so too).
  await announceJointInvitesForJoints(tx, [projection.jointChannelId]);

  await tx.update(channels)
    .set({ deletedAt: now })
    .where(eq(channels.id, channelId));

  // This server's copies of the joint's threads go with it, so none stays
  // active under a parent that is gone; rejoining reuses their rows.
  const threadCopies = await tx
    .select({ jointThreadId: jointChannelServers.jointChannelId, localChannelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(channels, eq(channels.id, jointChannels.canonicalChannelId))
    .innerJoin(messages, eq(messages.id, channels.parentMessageId))
    .where(and(
      eq(messages.channelId, projection.canonicalChannelId),
      eq(channels.type, "thread"),
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.status, "active"),
    ));
  if (threadCopies.length > 0) {
    await tx.update(jointChannelServers)
      .set({ status: "disconnected", disconnectedByUserId, disconnectedAt: now })
      .where(and(
        inArray(jointChannelServers.jointChannelId, threadCopies.map((copy) => copy.jointThreadId)),
        eq(jointChannelServers.serverId, serverId),
        eq(jointChannelServers.status, "active"),
      ));
    await tx.update(channels)
      .set({ deletedAt: now })
      .where(and(inArray(channels.id, threadCopies.map((copy) => copy.localChannelId)), isNull(channels.deletedAt)));
  }

  // The departure this starts settles the assignees the disconnect made
  // unreachable (jointMembershipDeparture.ts, reason joint_channel_disconnected).
  // AFTER the two updates above and inside the same transaction: it reads this
  // projection as already 'disconnected' and its local channel soft-deleted.
  await mirrorHumans.apply(undefined, { actorUserId: disconnectedByUserId });

  // The joint is no longer an external channel of this server, nor of the
  // other side if it is left alone. Before the joint row write below
  // (ADMISSION_LOCK_ORDER rule 4).
  await reconcileExternalFreezesForChannel(tx, { serverId, jointChannelId: projection.jointChannelId, now, clearOnly: true });
  // A free participant leaving can bring the joint back within the cap.
  await reconcileJointOverLimitFor(tx, projection.jointChannelId, now);
}

/** An actor retired or being deleted (JointActorUnavailableError) answers as an unknown channel. */
function unusableActorAsNotFound(err: unknown): never {
  if (err instanceof JointActorUnavailableError) throw new Error("Channel not found");
  throw err;
}

/**
 * Disconnect this server's copy of a joint channel (another server's, never
 * the host's: JointHostDisconnectError). Returns the joint and its canonical
 * storage channel so the caller can tell the servers still connected. A
 * participant's disconnect writes one `channel.server_disconnected` audit
 * event (`byHost: false`) on its own server and one on the host, in the same
 * commit.
 */
export async function disconnectJointChannel(
  channelId: string,
  disconnectedByUserId: string,
): Promise<{ jointChannelId: string; canonicalChannelId: string }> {
  const db = getDb();
  const channel = await getChannel(channelId);
  if (!channel) throw new Error("Channel not found");
  if (channel.type !== "joint") throw new Error("Only joint channels can be disconnected");

  const now = currentDate();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    const [projection] = await tx
      .select({ jointChannelId: jointChannelServers.jointChannelId, canonicalChannelId: jointChannels.canonicalChannelId, role: jointChannelServers.role })
      .from(jointChannelServers)
      .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
      .where(and(
        eq(jointChannelServers.localChannelId, channelId),
        eq(jointChannelServers.status, "active"),
      ));
    if (!projection) throw new Error("Joint channel not found");
    // The host's active copy, for its `channel.server_disconnected` audit
    // event: read again after the disconnect's writes, under its locks. A
    // host disconnecting itself (external channels off) writes no event.
    const readHostCopy = async () => projection.role !== "participant" ? undefined : (await tx
      .select({ serverId: jointChannelServers.serverId, localChannelId: jointChannelServers.localChannelId })
      .from(jointChannelServers)
      .where(and(
        eq(jointChannelServers.jointChannelId, projection.jointChannelId),
        eq(jointChannelServers.role, "host"),
        eq(jointChannelServers.status, "active"),
        ne(jointChannelServers.serverId, channel.serverId),
      )))[0];
    const hostBefore = await readHostCopy();

    // Lock order, as disconnectParticipantServerByHost's (#13716): the actor's
    // `users` row and this server's `servers` row FOR KEY SHARE (the
    // projection row and the departure record name both; the audit events
    // reference this server's and the host's, so the host's is taken with it,
    // in id order as disconnectParticipantServerByHost does), BEFORE the channel
    // row. Deleting this server takes its row FOR UPDATE, then J, then
    // inserts a departure whose FK KEY-SHAREs this
    // channel row; with the server row first taken after the channel row
    // (lockComputedJointActor's FOR SHARE) each waited on the other
    // (jointSelfDisconnectLockOrder.realPg.test.ts).
    // Retired or being deleted (lockJointActorFirst): the neutral refusal.
    await lockJointActorFirst(tx, disconnectedByUserId).catch(unusableActorAsNotFound);
    await tx.execute(sql`SELECT id FROM servers WHERE id IN (${sql.join([channel.serverId, ...(hostBefore ? [hostBefore.serverId] : [])].map((id) => sql`${id}::uuid`), sql`, `)}) ORDER BY id FOR KEY SHARE`);
    await lockJointHumanMembershipChannel(tx, channelId);
    await lockComputedJointActor({ serverId: channel.serverId, channelId, actorType: "user", actorId: disconnectedByUserId }, tx);
    // Under the locks: a server deleted meanwhile has no copy to disconnect.
    const [server] = await tx.select({ deletedAt: servers.deletedAt }).from(servers).where(eq(servers.id, channel.serverId));
    if (!server || server.deletedAt) throw new Error("Channel not found");
    const context = await resolveChannelActorContext(channel.serverId, channelId, "user", disconnectedByUserId, tx);
    if (context?.jointAuthority && (!context.canAccessChannel || !context.jointAuthority.inherited)) throw new Error("Channel capability required");
    // A projection's role is fixed when it is created; nothing has been written yet.
    if (projection.role === "host" && (await evaluateFeatureFlag({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId: channel.serverId, userId: disconnectedByUserId }, tx)).enabled) {
      throw new JointHostDisconnectError();
    }
    await disconnectJointProjectionInTransaction(tx, { channelId, serverId: channel.serverId, projection, disconnectedByUserId, now });
    // As the host's disconnect of a participant writes them (byHost: true):
    // one event on each of the two servers, each naming its own copy, in
    // this commit. One per channel: the thread copies that went with it
    // write none. The actor's role is this server's, so only its own row has it.
    if (projection.role === "participant") {
      const hostCopy = hostBefore ? await readHostCopy() : undefined;
      const host = hostCopy && hostCopy.serverId === hostBefore?.serverId ? hostCopy : undefined;
      const operationId = newAuditOperationId();
      await recordIntegrationAuditEvents([
        ...(host ? [{ serverId: host.serverId, channelId: host.localChannelId, actorRole: undefined }] : []),
        { serverId: channel.serverId, channelId, actorRole: context?.serverRole },
      ].map(({ serverId, channelId: ownChannelId, actorRole }) => ({
        serverId,
        eventType: "channel.server_disconnected" as const,
        outcome: "success" as const,
        source: "web" as const,
        actor: { type: "human" as const, id: disconnectedByUserId },
        target: { type: "server", id: channel.serverId },
        metadata: {
          jointChannelId: projection.jointChannelId,
          ...(host ? { hostServerId: host.serverId } : {}),
          disconnectedServerId: channel.serverId,
          channelId: ownChannelId,
          byHost: false,
          ...serverAuditContextMetadata({ actorRole, operationId }),
        },
      })), tx);
    }
    return { jointChannelId: projection.jointChannelId, canonicalChannelId: projection.canonicalChannelId };
  }).then(async result => {
    // The durable claim was committed with the denial list. A lost inline run
    // is recovered on another replica; runtime effects never precede commit.

    return result;
  });
}

/** POST /channels/:id/joint-servers/:serverId/disconnect on a copy that is not the host's active copy of a joint. */
export class JointNotHostError extends Error {
  readonly code = "not_joint_host";
  constructor() {
    super("Only the host server can disconnect another server. To leave, disconnect your own server instead.");
  }
}

/** The server named is not an active participant of the host's joint (unknown, already gone, or the host itself). */
export class JointServerNotConnectedError extends Error {
  readonly code = "server_not_connected";
  constructor() {
    super("That server is not connected to this channel.");
  }
}

let hostDisconnectBeforeLocksHookForTests: ((hostChannelId: string) => Promise<void>) | null = null;
/** Tests only: awaited by disconnectParticipantServerByHost after its unlocked reads, before its transaction and locks (a window for the actor's access to change). */
export function __setHostDisconnectBeforeLocksHookForTests(hook: ((hostChannelId: string) => Promise<void>) | null): void {
  hostDisconnectBeforeLocksHookForTests = hook;
}

/**
 * The host's owner/admin disconnects a participant server from a joint channel
 * (external_channels_v1, evaluated for the host): the participant's
 * projection goes exactly as its own disconnect would take it
 * (disconnectJointProjectionInTransaction), with the host's admin recorded as
 * who disconnected it, and one `channel.server_disconnected` audit event on
 * each of the two servers in the same commit. A flag that is off answers as an
 * unknown channel ("Channel not found"), so the feature stays hidden.
 *
 * Lock order, all before the first J lock (identity/resource rows -> flag
 * share locks -> J, jointHumanMembershipAccess.ts acquireJointSourceExitFlagReadLock):
 * 1. The actor's `users` row FOR KEY SHARE (lockJointActorFirst): the
 *    participant's projection row and its departure record name the actor
 *    (disconnected_by_user_id, actor_user_id FKs). Account deletion takes that
 *    row FOR UPDATE first and then the person's owned servers, so it is taken
 *    before anything else; an actor retired or being deleted is refused.
 * 2. Both `servers` rows FOR KEY SHARE, in id order (as
 *    externalInviteConnectService.ts does): the audit rows reference both
 *    (server_id FK), B's departure record references B. Deleting a server
 *    takes its row FOR UPDATE, then J, then inserts a
 *    departure whose FK KEY-SHAREs the projection's channel row. Taking B's
 *    row through an INSERT after J closes a J <-> B cycle (as the departure
 *    worker, cleanJointMembershipDepartureBatch); taking it after the channel
 *    rows closes a channel <-> B cycle with that departure INSERT (both
 *    reproduced in jointHostDisconnectLockOrder.realPg.test.ts). KEY SHARE
 *    conflicts only with FOR UPDATE, which a server's deletion, role change
 *    or plan writer takes before any channel row.
 * 3. The host's channel row (FOR NO KEY UPDATE: only read, as the archive and
 *    a joint member removal take it), then the participant's (FOR UPDATE, as
 *    its own disconnect takes it). The entry's row before any other
 *    projection's, as withLockedChannelActorCapability then
 *    lockJointProjectionWrite do.
 * 4. The host's `servers` row FOR SHARE and the actor's host `server_members`
 *    row FOR SHARE (channel -> server -> member,
 *    lockServerMembershipsAfterChannel): a demotion or removal (FOR UPDATE on
 *    the member row) can't interleave.
 * 5. lockComputedJointActor (the same server/member rows again, the
 *    source-exit flag, J) and the mirror's own J.
 * 6. external_channels_v1's share lock, last and evaluated under it, as the
 *    connect paths take it (revalidateUnderLocks): one order for that lock
 *    and J everywhere. (The retired joint_member_connect_v1's lock sat before
 *    J; #wg-rbac:#55.)
 * Then everything is re-read: both projections, the participant server not
 * deleted, the flag, the actor's role and that they can open the host's copy.
 */
export async function disconnectParticipantServerByHost(
  hostChannelId: string,
  targetServerId: string,
  actorUserId: string,
): Promise<{
  jointChannelId: string;
  canonicalChannelId: string;
  hostServerId: string;
  targetChannelId: string;
}> {
  const db = getDb();
  const hostChannel = await getChannel(hostChannelId);
  if (!hostChannel) throw new Error("Channel not found");
  if (hostChannel.type !== "joint") throw new JointNotHostError();
  const hostServerId = hostChannel.serverId;
  await hostDisconnectBeforeLocksHookForTests?.(hostChannelId);

  const now = currentDate();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    // Both projections of one active joint, read again under the locks below.
    const readProjections = async () => {
      const [host] = await tx
        .select({ jointChannelId: jointChannelServers.jointChannelId, canonicalChannelId: jointChannels.canonicalChannelId, role: jointChannelServers.role })
        .from(jointChannelServers)
        .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
        .where(and(
          eq(jointChannelServers.localChannelId, hostChannelId),
          eq(jointChannelServers.serverId, hostServerId),
          eq(jointChannelServers.status, "active"),
          eq(jointChannels.status, "active"),
        ));
      if (!host || host.role !== "host") throw new JointNotHostError();
      const [target] = await tx
        .select({ localChannelId: jointChannelServers.localChannelId })
        .from(jointChannelServers)
        .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
        .innerJoin(servers, eq(servers.id, jointChannelServers.serverId))
        .where(and(
          eq(jointChannelServers.jointChannelId, host.jointChannelId),
          eq(jointChannelServers.serverId, targetServerId),
          eq(jointChannelServers.role, "participant"),
          eq(jointChannelServers.status, "active"),
          isNull(channels.deletedAt),
          isNull(servers.deletedAt),
        ));
      if (!target) throw new JointServerNotConnectedError();
      return { host, targetChannelId: target.localChannelId };
    };

    const before = await readProjections();
    // The order is the function comment's; every row lock precedes the first J lock.
    // Retired or being deleted (lockJointActorFirst): as the flag off, the neutral refusal.
    await lockJointActorFirst(tx, actorUserId).catch(unusableActorAsNotFound);
    await tx.execute(sql`SELECT id FROM servers WHERE id IN (${hostServerId}::uuid, ${targetServerId}::uuid) ORDER BY id FOR KEY SHARE`);
    await lockJointHumanMembershipChannel(tx, hostChannelId, "no key update");
    await lockJointHumanMembershipChannel(tx, before.targetChannelId);
    await tx.execute(sql`SELECT id FROM servers WHERE id=${hostServerId}::uuid FOR SHARE`);
    await tx.execute(sql`SELECT user_id FROM server_members WHERE server_id=${hostServerId}::uuid AND user_id=${actorUserId}::uuid FOR SHARE`);
    await lockComputedJointActor({ serverId: hostServerId, channelId: hostChannelId, actorType: "user", actorId: actorUserId }, tx);
    // Last, after J, as every other holder takes it (revalidateUnderLocks,
    // ADMISSION_LOCK_ORDER rule 5): a rule or kill-switch write then queues
    // behind this transaction and never between its flag lock and its J.
    await acquireFeatureFlagReadLock(tx, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY);

    // Under the locks: the joint, both projections, the flag and the actor's authority as they now are.
    const { host, targetChannelId } = await readProjections();
    if (targetChannelId !== before.targetChannelId) throw new JointServerNotConnectedError();
    if (!(await evaluateFeatureFlag({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId: hostServerId, userId: actorUserId }, tx)).enabled) {
      throw new Error("Channel not found");
    }
    const context = await resolveChannelActorContext(hostServerId, hostChannelId, "user", actorUserId, tx);
    // Still an owner/admin of the host, still able to open its copy.
    if (!context || !actorRoleHasServerCapability(context.serverRole, "federateChannels") || !context.canAccessChannel) {
      throw new Error("Channel capability required");
    }
    // As disconnectJointChannel: the authority must be the inherited one.
    if (context.jointAuthority && !context.jointAuthority.inherited) throw new Error("Channel capability required");

    await disconnectJointProjectionInTransaction(tx, {
      channelId: targetChannelId,
      serverId: targetServerId,
      projection: host,
      disconnectedByUserId: actorUserId,
      now,
    });

    const operationId = newAuditOperationId();
    await recordIntegrationAuditEvents([
      { serverId: hostServerId, channelId: hostChannelId },
      { serverId: targetServerId, channelId: targetChannelId },
    ].map(({ serverId, channelId }) => ({
      serverId,
      eventType: "channel.server_disconnected" as const,
      outcome: "success" as const,
      source: "web" as const,
      actor: { type: "human" as const, id: actorUserId },
      target: { type: "server", id: targetServerId },
      metadata: {
        jointChannelId: host.jointChannelId,
        hostServerId,
        disconnectedServerId: targetServerId,
        channelId,
        byHost: true,
        ...serverAuditContextMetadata({ actorRole: context.serverRole, operationId }),
      },
    })), tx);
    return { jointChannelId: host.jointChannelId, canonicalChannelId: host.canonicalChannelId, hostServerId, targetChannelId };
  });
}

export type ServerJointConnection = {
  channelId: string;
  name: string;
  role: "host" | "participant";
  /** Humans from this server still on the local copy; 0 means nobody here can open it. */
  memberCount: number;
  isMember: boolean;
  archived: boolean;
  servers: Array<{ serverId: string; name: string; role: "host" | "participant" }>;
};

/**
 * Every active joint copy owned by this server, for its owners and admins,
 * including copies none of them is a member of (#raft-architecture task #22).
 * Metadata only: no messages, members or agent activity.
 */
export async function listServerJointConnections(serverId: string, viewerUserId: string): Promise<ServerJointConnection[]> {
  const db = getDb();
  const rows = await db
    .select({
      jointChannelId: jointChannelServers.jointChannelId,
      channelId: channels.id,
      name: channels.name,
      archivedAt: channels.archivedAt,
      role: jointChannelServers.role,
      memberCount: sql<number>`(SELECT count(*)::int FROM ${channelHumans} WHERE ${channelHumans.channelId} = ${channels.id})`,
      isMember: sql<boolean>`EXISTS (SELECT 1 FROM ${channelHumans} WHERE ${channelHumans.channelId} = ${channels.id} AND ${channelHumans.userId} = ${viewerUserId})`,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
    .where(and(
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
      isNull(channels.deletedAt),
      ne(channels.type, "thread"),
    ))
    .orderBy(asc(channels.name));
  if (rows.length === 0) return [];

  const peers = await db
    .select({
      jointChannelId: jointChannelServers.jointChannelId,
      serverId: servers.id,
      name: servers.name,
      role: jointChannelServers.role,
    })
    .from(jointChannelServers)
    .innerJoin(servers, eq(servers.id, jointChannelServers.serverId))
    .where(and(
      inArray(jointChannelServers.jointChannelId, [...new Set(rows.map((row) => row.jointChannelId))]),
      eq(jointChannelServers.status, "active"),
      isNull(servers.deletedAt),
    ))
    .orderBy(asc(jointChannelServers.joinedAt));
  const peersByJoint = new Map<string, ServerJointConnection["servers"]>();
  for (const peer of peers) {
    const list = peersByJoint.get(peer.jointChannelId) ?? [];
    list.push({ serverId: peer.serverId, name: peer.name, role: peer.role as "host" | "participant" });
    peersByJoint.set(peer.jointChannelId, list);
  }

  return rows.map((row) => ({
    channelId: row.channelId,
    name: row.name,
    role: row.role as "host" | "participant",
    memberCount: Number(row.memberCount),
    isMember: Boolean(row.isMember),
    archived: row.archivedAt != null,
    servers: peersByJoint.get(row.jointChannelId) ?? [],
  }));
}

/**
 * What removing a private channel's last member does: `delete` it (the web,
 * after its "Leave and Delete Channel?" confirm, and an agent that passed
 * `deleteIfLast`), or `refuse` with LastPrivateMemberError, which rolls the
 * removal back with the transaction (an agent that didn't).
 */
export type LastPrivateMember = "delete" | "refuse";

/** Thrown, with nothing changed (it rolls the removal back), when removing the last member would delete a private channel and the caller chose `refuse`; routes map it to 409 `last_member_deletes_channel`. */
export class LastPrivateMemberError extends Error {
  constructor() {
    super("Removing the last member deletes this private channel and all its messages");
    this.name = "LastPrivateMemberError";
  }
}

/** Whether removing this member deleted the channel (it was private and now has no human or agent left). */
export interface ChannelMemberRemoval {
  channelDeleted: boolean;
  /**
   * Set when the person removed was a Guest of this channel: the Guest's
   * server membership ended in the same commit (#wg-rbac:#15). The caller that
   * owns the transaction runs finishRemovedMember after commit.
   */
  endedGuestMembership?: { serverId: string; effects: RemovedMemberEffects };
}

async function deletePrivateChannelIfEmpty(channelId: string, db: DatabaseExecutor = getDb(), lastMember: LastPrivateMember = "delete"): Promise<boolean> {
  const [channel] = await db
    .select({ type: channels.type, deletedAt: channels.deletedAt })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!channel || channel.type !== "private" || channel.deletedAt) return false;

  const result = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM channel_humans WHERE channel_id = ${channelId}) AS "humanCount",
      (SELECT count(*)::int FROM channel_agents WHERE channel_id = ${channelId}) AS "agentCount"
  `);
  const [row] = result.rows as Array<{ humanCount?: number; agentCount?: number }>;
  const humanCount = row?.humanCount ?? 0;
  const agentCount = row?.agentCount ?? 0;
  if (humanCount + agentCount > 0) return false;
  if (lastMember === "refuse") throw new LastPrivateMemberError();

  await db.update(channels)
    .set({ deletedAt: currentDate() })
    .where(and(eq(channels.id, channelId), eq(channels.type, "private"), isNull(channels.deletedAt)));
  return true;
}

/**
 * Where a conversation's messages are stored, resolved on the caller's executor: a join
 * runs inside the membership transaction, which must see its own uncommitted rows and
 * must not wait on a second connection.
 */
export async function getMessageStorageChannelIdWithExecutor(executor: DatabaseExecutor, channelId: string): Promise<string> {
  const [channel] = await executor
    .select({ type: channels.type, serverId: channels.serverId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!channel) return channelId;
  // Sub-conversations (thread, task conversation): a joint local face stores in canonical.
  if (isSubConversationType(channel.type)) {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId, executor);
    return jointThread?.canonicalThreadChannelId ?? channelId;
  }
  if (channel.type !== "joint") return channelId;
  const [projection] = await executor
    .select({ canonicalChannelId: jointChannels.canonicalChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      eq(jointChannelServers.localChannelId, channelId),
      eq(jointChannelServers.serverId, channel.serverId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ))
    .limit(1);
  return projection?.canonicalChannelId ?? channelId;
}

/**
 * getMessageStorageChannelIdWithExecutor for many local channels of one
 * server at once, by the same rules: a joint channel's active projection
 * stores in its canonical channel, a joint thread's local face in its
 * canonical thread (the projection getJointThreadProjectionByLocalThread
 * reads, which also gives the thread's local parent channel, as
 * canUserAccessChannel uses it). Channels stored in themselves are absent.
 * At most two queries, run together (joint channels, joint threads).
 */
export async function resolveLocalMessageStorage(
  serverId: string,
  channelRows: ReadonlyArray<{ id: string; type: string }>,
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, { storageChannelId: string; localParentChannelId?: string }>> {
  const jointIds = channelRows.filter((row) => row.type === "joint").map((row) => row.id);
  const threadIds = channelRows.filter((row) => row.type === "thread").map((row) => row.id);
  const [jointRows, threadProjections] = await Promise.all([
    jointIds.length === 0 ? [] : executor
      .select({ localChannelId: jointChannelServers.localChannelId, canonicalChannelId: jointChannels.canonicalChannelId })
      .from(jointChannelServers)
      .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
      .where(and(
        inArray(jointChannelServers.localChannelId, jointIds),
        eq(jointChannelServers.serverId, serverId),
        eq(jointChannelServers.status, "active"),
        eq(jointChannels.status, "active"),
      )),
    threadIds.length === 0 ? [] : listActiveJointThreadProjectionRows({ localThreadChannelIds: threadIds, serverId }, executor),
  ]);
  const resolved = new Map<string, { storageChannelId: string; localParentChannelId?: string }>();
  for (const row of jointRows) {
    if (!resolved.has(row.localChannelId)) resolved.set(row.localChannelId, { storageChannelId: row.canonicalChannelId });
  }
  // Earliest-joined first, as getJointThreadProjectionByLocalThread takes the first.
  for (const projection of threadProjections) {
    if (!resolved.has(projection.localThreadChannelId)) {
      resolved.set(projection.localThreadChannelId, { storageChannelId: projection.canonicalThreadChannelId, localParentChannelId: projection.localParentChannelId });
    }
  }
  return resolved;
}

/**
 * A member's read position starts where they joined: everything already in the
 * conversation is read, for humans and agents alike, so "unread" is only ever
 * `seq > cursor`. Runs in the membership write's transaction. `throughSeq` defaults
 * to the conversation's latest message; a join caused by a message that must itself
 * stay unread (a mention or reply that auto-follows) passes the seq before it.
 */
export async function startReadPositionAtJoin(
  executor: DatabaseExecutor,
  principalKind: "human" | "agent",
  principalId: string,
  channelId: string,
  throughSeq?: number,
): Promise<void> {
  if (principalKind === "human") {
    const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [channelId] }, executor)).get(channelId);
    if (scope && (await filterJointHumanMemberEntries([scope], principalId, executor)).has(channelId)) {
      return; // Existing conversation member entering another face has not read it.
    }
  }
  let seq = throughSeq;
  if (seq === undefined) {
    const storageChannelId = await getMessageStorageChannelIdWithExecutor(executor, channelId);
    const [latest] = await executor
      .select({ seq: sql<number>`COALESCE(MAX(${messages.seq}), 0)::int` })
      .from(messages)
      .where(eq(messages.channelId, storageChannelId));
    seq = latest?.seq ?? 0;
  }
  await raiseReadPositionForJoin(executor, principalKind, principalId, channelId, seq);
}

/** Thrown when someone tries to leave, or be removed from, #all; routes map it to 403. */
export const ALL_CHANNEL_LEAVE_MESSAGE = "Cannot leave or remove from the #all channel";
/** Thrown when an agent is removed from (or leaves) #all; routes map it to 403. */
export const ALL_CHANNEL_REMOVE_MEMBERS_MESSAGE = "Cannot remove members from the #all channel";

export async function addAgent(channelId: string, agentId: string, options: ChannelServiceOptions & { role?: "member" | "admin" } = {}): Promise<boolean> {
  if (!options.executor) {
    return withChannelWriterFence(channelId, async (tx) => {
      await assertChannelActionCardWritable(tx, channelId, options);
      return addAgent(channelId, agentId, { ...options, executor: tx });
    });
  }
  const db = options.executor ?? getDb();
  await assertChannelWritableInTransaction(db, channelId);
  await assertChannelActionCardWritable(db, channelId, options);
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)));
  if (!channel) {
    throw new Error("Channel not found");
  }
  if (isSubConversationType(channel?.type)) {
    throw new Error("Thread membership is managed via follow/unfollow, not channel_agents");
  }
  const [agent] = await db
    .select({ serverId: agents.serverId, assistantOwnerUserId: agents.assistantOwnerUserId })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent || agent.serverId !== channel.serverId) {
    throw new Error("Agent is not a member of this channel's server");
  }
  // RFC 074 §2: an assistant is never added to a channel. (A DM is decided by
  // the deferred channel_agents guard trigger: only the DM with its owner.)
  if (agent.assistantOwnerUserId && channel.type !== "dm") {
    throw new Error(ASSISTANT_CHANNEL_FORBIDDEN_MESSAGE);
  }
  if (isAllSystemChannel(channel)) {
    return false;
  }
  if (channel.type === "joint") {
    await lockJointHumanMembershipChannel(db,channelId);
    await prepareJointHumanMembershipMirror(db,{channelIds:[channelId]},"join");
    const scope = (await resolveJointHumanMembershipScopes({localChannelIds:[channelId]},db)).get(channelId);
    if (!scope || !(await filterJointActiveEntries([scope],db)).has(channelId)
      || (await filterJointPendingRemovalEntries([scope],"agent",agentId,db)).has(channelId)) throw new Error("Channel capability required");
    // Pin J only; adding an agent must never manufacture human membership.
  }
  // Agent Lounge: only its own agent is ever a member (the database refuses
  // the row too; this gives the caller a reason instead of a constraint error).
  if (await isLoungeOutsiderAgent(channelId, agentId, db)) throw new AgentLoungeOutsiderError();
  const inserted = await db
    .insert(channelAgents)
    .values({ channelId, agentId, role: options.role ?? "member" })
    .onConflictDoNothing()
    .returning({ agentId: channelAgents.agentId });
  if (inserted.length > 0) await startReadPositionAtJoin(db, "agent", agentId, channelId);
  return inserted.length > 0;
}

/** Agent membership is stored on its own server's local joint face. Host
 * management must resolve that face rather than delete a host-only row. */
export async function getJointAgentRemovalChannel(channelId: string, agentId: string, tx: DatabaseExecutor = getDb()) {
  const channel = await getChannel(channelId, { executor: tx });
  if (!channel || channel.type !== "joint") return channel;
  const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [channelId] }, tx)).get(channelId);
  if (!scope) return channel;
  const rows = await tx.execute<{ channelId: string }>(sql`SELECT p.local_channel_id AS "channelId"
    FROM joint_channel_servers p JOIN channel_agents ca ON ca.channel_id=p.local_channel_id
    JOIN agents a ON a.id=ca.agent_id AND a.server_id=p.server_id
    WHERE p.joint_channel_id=${scope.jointId}::uuid AND p.status='active' AND ca.agent_id=${agentId}::uuid LIMIT 1`);
  return rows.rows[0] ? getChannel(rows.rows[0].channelId, { executor: tx }) : null;
}

export async function removeAgent(channelId: string, agentId: string, executor?: DatabaseExecutor, actor?: ChannelActorContext, lastMember: LastPrivateMember = "delete"): Promise<ChannelMemberRemoval> {
  if (!executor) return withChannelWriterFence(channelId, tx => removeAgent(channelId, agentId, tx, actor, lastMember));
  await assertChannelWritableInTransaction(executor, channelId);
  const db = executor;
  const channel = await getChannel(channelId, { executor: db });
  if (isSubConversationType(channel?.type)) throw new Error("Thread membership is managed via follow/unfollow, not channel_agents");
  if (channel && isAllSystemChannel(channel)) throw new Error(ALL_CHANNEL_REMOVE_MEMBERS_MESSAGE);
  if (channel?.type === "joint") {
    await lockJointHumanMembershipChannel(db, channelId);
    if (actor) {
      if (actor.channelId !== channelId || actor.serverId !== channel.serverId) throw new Error("Channel capability required");
      await lockComputedJointActor({ serverId: actor.serverId, channelId, actorType: actor.actorType, actorId: actor.actorId }, db);
      actor = await resolveChannelActorContext(actor.serverId, channelId, actor.actorType, actor.actorId, db) ?? undefined;
      if (!actor) throw new Error("Channel capability required");
    }
    await prepareJointHumanMembershipMirror(db, { channelIds: [channelId] }, "remove");
    {
      const target = await getJointAgentRemovalChannel(channelId, agentId, db);
      if (actor && (!channelActorHasCapability(actor, "removeChannelMembers", "agent")
        || (!actor.jointAuthority?.isHostEntry && target && target.serverId !== actor.serverId))) throw new Error("Channel capability required");
      if (!target) return { channelDeleted: false };
      const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [channelId] }, db)).get(channelId)!;
      await db.execute(sql`DELETE FROM channel_agents WHERE agent_id=${agentId}::uuid
        AND channel_id IN (${jointConversationFamilySql(scope.jointId)})`);
      return { channelDeleted: false };
    }
  }
  await db.delete(channelAgents).where(and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, agentId)));
  return { channelDeleted: await deletePrivateChannelIfEmpty(channelId, db, lastMember) };
}

async function getChannelAgentsRaw(channelId: string, onlyIds?: readonly string[]) {
  return (await getChannelAgentsRawForChannels([channelId], { onlyIds })).map(({ channelId: _channelId, ...agent }) => agent);
}

/**
 * Members a roster read is narrowed to (GET /api/sync/changes rebuilding
 * changed member rows): only these ids of each kind; a kind left out reads
 * none. Absent = the whole roster.
 */
export type ChannelMemberFilter = { userIds: readonly string[]; agentIds: readonly string[] };

/** getChannelAgentsRaw for several channels in one query; rows carry their channelId. */
async function getChannelAgentsRawForChannels(channelIds: readonly string[], options: { name?: string; id?: string; onlyIds?: readonly string[] } = {}) {
  if (channelIds.length === 0 || options.onlyIds?.length === 0) return [];
  const db = getDb();
  return db
    .select({
      channelId: channelAgents.channelId,
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
    .where(and(
      inArray(channelAgents.channelId, [...channelIds]),
      isNull(agents.deletedAt),
      activeAppBotOrOrdinaryAgent(),
      options.name === undefined ? undefined : eq(agents.name, options.name),
      options.id === undefined ? undefined : eq(agents.id, options.id),
      options.onlyIds === undefined ? undefined : inArray(agents.id, [...options.onlyIds]),
    ))
    .orderBy(asc(channelAgents.addedAt));
}

/**
 * The full agent audience of a server. This is the effective agent membership
 * of an enabled virtual `#all` channel: in the pre-virtualization model every
 * active agent had a real `channel_agents` row in `#all`, so the audience is
 * every active (non-deleted) agent on the server, less removed App Bots and
 * personal assistants (listedServerAgent).
 */
async function getServerAudienceAgents(serverId: string, options: { name?: string; onlyIds?: readonly string[] } = {}) {
  if (options.onlyIds?.length === 0) return [];
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
    .where(and(
      eq(agents.serverId, serverId),
      isNull(agents.deletedAt),
      listedServerAgent(),
      options.name === undefined ? undefined : eq(agents.name, options.name),
      options.onlyIds === undefined ? undefined : inArray(agents.id, [...options.onlyIds]),
    ))
    .orderBy(asc(agents.createdAt));
}

/**
 * The channels whose member list shows this agent while
 * activeAppBotOrOrdinaryAgent passes: the listable ones it has a membership
 * row in, and its server's enabled `#all`. A removed App Bot keeps its rows,
 * so removing or re-adding it changes these lists without a membership write;
 * callers use this to tell open clients which lists to re-read.
 */
export async function getListableChannelsListingAgent(serverId: string, agentId: string): Promise<Array<{ id: string; type: string }>> {
  return getDb()
    .select({ id: channels.id, type: channels.type })
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      isNull(channels.deletedAt),
      inArray(channels.type, LISTABLE_CHANNEL_TYPES),
      or(
        sql`exists (select 1 from ${channelAgents} where ${channelAgents.channelId} = ${channels.id} and ${channelAgents.agentId} = ${agentId})`,
        and(eq(channels.name, SYSTEM_ALL_CHANNEL_KEY), eq(channels.type, "channel")),
      ),
    ));
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
  if(channel?.type==="joint") {
    const db=getDb();
    const scope=(await resolveJointHumanMembershipScopes({localChannelIds:[channelId]},db)).get(channelId);
    if(!scope || !(await filterJointActiveEntries([scope],db)).has(channelId)) return [];
    const rows=await getChannelAgentsRaw(channelId);
    const denied=await db.execute<{id:string}>(sql`SELECT jmr.agent_id id FROM joint_membership_removals jmr
      JOIN joint_membership_departures jmd ON jmd.id=jmr.departure_id
      WHERE jmd.completed_at IS NULL AND jmd.joint_channel_id=${scope.jointId}::uuid AND jmr.remove_membership AND jmr.agent_id IS NOT NULL`);
    const deniedIds=new Set(denied.rows.map(row=>row.id));
    return rows.filter(row=>!deniedIds.has(row.id));
  }
  return getChannelAgentsRaw(channelId);
}

export async function getAgentChannels(agentId: string, viewerUserId: string) {
  const db = getDb();
  const memberChannels = await db.select({id: channelAgents.channelId}).from(channelAgents)
    .where(eq(channelAgents.agentId, agentId));
  const jointPermission = await resolveJointHumanEntrySql({localChannelIds: memberChannels.map(row => row.id)}, db);
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
          and(ne(channels.type, "joint"), isNotNull(viewerMembership.userId)),
          and(eq(channels.type, "joint"), jointPermission(channels.id, sql`${viewerUserId}::uuid`),
            sql`EXISTS (SELECT 1 FROM agents a WHERE a.id=${agentId}::uuid
              AND a.server_id=${channels.serverId} AND a.deleted_at IS NULL)`,
            sql`NOT EXISTS (SELECT 1 FROM joint_channel_servers p WHERE p.local_channel_id=${channels.id}
              AND ${jointMembershipRemovalPendingSql(sql`p.joint_channel_id`, "agent", sql`${agentId}::uuid`)})`),
        ),
        isNull(channels.deletedAt)
      )
    )
    .orderBy(asc(channels.name));
  return attachActivityMuteState(rows, "agent", agentId);
}

let lastPostsBackfilledAt = 0;
let lastPostsBackfilledCheckedAt = 0;

/** Whether scripts/backfill-channel-last-posts.ts has completed (cached; a false is rechecked once a minute). */
async function channelLastPostsBackfilled(): Promise<boolean> {
  if (lastPostsBackfilledAt) return true;
  if (Date.now() - lastPostsBackfilledCheckedAt < 60_000) return false;
  lastPostsBackfilledCheckedAt = Date.now();
  const [row] = await getDb().select({ at: channelLastPostsBackfill.completedAt }).from(channelLastPostsBackfill).limit(1);
  if (row) lastPostsBackfilledAt = row.at.getTime();
  return !!row;
}

/** Test seam: forget the cached backfill state. */
export function __resetChannelLastPostsBackfillCacheForTests(): void {
  lastPostsBackfilledAt = 0;
  lastPostsBackfilledCheckedAt = 0;
}

/**
 * Which channels an agent's directory covers: live ones (the default, what
 * `server.info` lists), or only archived ones (read-only; `server info
 * --channels --archived`). Either way the same visibility applies: public
 * channels, plus private / joint ones the agent can access.
 */
export type AgentChannelDirectoryScope = "live" | "archived";

/**
 * The channels of one directory scope the agent can see, and what decided it:
 * public channels (not another agent's lounge), plus private / joint / DM ones
 * it is in (a joint one only while it can access it). Shared by the listing
 * and the archived count so the two never disagree on visibility.
 */
async function visibleAgentDirectoryRows(serverId: string, agentId: string, scope: AgentChannelDirectoryScope) {
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
      scope === "archived" ? isNotNull(channels.archivedAt) : isNull(channels.archivedAt),
    ))
    .orderBy(asc(channels.createdAt));

  const jointContexts = await resolveChannelActorContextsMany(serverId,list.filter(row=>row.type==="joint").map(row=>row.id),"agent",agentId,db);
  for (const channel of list) {
    if (channel.type === "joint" && !jointContexts.get(channel.id)?.canAccessChannel) joinedSet.delete(channel.id);
  }
  // Agent Lounge: another agent's lounge is readable but never listed (not
  // guided there, #proj-chat:30a58e4d); its own agent is a member and sees it.
  const loungeIds = new Set((await db.select({ channelId: agentLounges.channelId })
    .from(agentLounges)
    .where(eq(agentLounges.serverId, serverId))).map((row) => row.channelId));
  const listed = list.filter((ch) => (!requiresExplicitMembership(ch.type) && !loungeIds.has(ch.id)) || joinedSet.has(ch.id));
  return { db, listed, joinedSet, membershipByChannel, agentServerMembership, jointContexts };
}

/**
 * How many archived channels the agent can see (`server.info`
 * archivedChannelCount): the same rule as `visibleAgentDirectoryRows` with
 * scope archived, as one count. Public channels (not another agent's
 * lounge) and private ones it is in are counted in SQL; a joint one it is in
 * also needs its access resolved, so those few rows go through the same
 * resolver the listing uses.
 */
export async function countArchivedChannelsForAgent(serverId: string, agentId: string): Promise<number> {
  const db = getDb();
  const isMember = sql`exists (select 1 from ${channelAgents} where ${channelAgents.channelId} = ${channels.id} and ${channelAgents.agentId} = ${agentId})`;
  const isLounge = sql`exists (select 1 from ${agentLounges} where ${agentLounges.channelId} = ${channels.id})`;
  const archivedHere = and(
    eq(channels.serverId, serverId),
    isNull(channels.deletedAt),
    isNotNull(channels.archivedAt),
  );
  const [plain] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(channels)
    .where(and(
      archivedHere,
      or(
        and(eq(channels.type, "channel"), sql`not ${isLounge}`),
        and(inArray(channels.type, ["channel", "private"]), isMember),
      ),
    ));
  const jointIds = (await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(archivedHere, eq(channels.type, "joint"), isMember))).map((row) => row.id);
  if (jointIds.length === 0) return plain?.count ?? 0;
  const jointContexts = await resolveChannelActorContextsMany(serverId, jointIds, "agent", agentId, db);
  return (plain?.count ?? 0) + jointIds.filter((id) => jointContexts.get(id)?.canAccessChannel).length;
}

export async function listChannelsForAgent(serverId: string, agentId: string, options: { scope?: AgentChannelDirectoryScope } = {}) {
  const scope = options.scope ?? "live";
  const { db, listed, membershipByChannel, agentServerMembership, jointContexts } = await visibleAgentDirectoryRows(serverId, agentId, scope);
  // When a person or an agent last posted there (thread replies included); null: no posts yet.
  // Left out until the one-time backfill has run: before that, no row is not "no posts".
  const lastPostKnown = await channelLastPostsBackfilled();
  // A joint projection's posts are stored in its canonical channel (the same
  // mapping as resolveLocalMessageStorage: an active projection, type joint),
  // so they are on the canonical row. Its own row holds only posts from before
  // it was converted from a regular channel (moved, so no trigger wrote them
  // to the canonical row): the later of the two.
  const canonicalLastPosts = alias(channelLastPosts, "canonical_last_posts");
  const lastPosts = listed.length === 0 || !lastPostKnown ? [] : await db
    .select({
      channelId: channels.id,
      lastPostAt: sql<Date>`greatest(${channelLastPosts.lastPostAt}, ${canonicalLastPosts.lastPostAt})`.mapWith(channelLastPosts.lastPostAt),
    })
    .from(channels)
    .leftJoin(jointChannelServers, and(
      eq(jointChannelServers.localChannelId, channels.id),
      eq(channels.type, "joint"),
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.status, "active"),
    ))
    .leftJoin(jointChannels, and(eq(jointChannels.id, jointChannelServers.jointChannelId), eq(jointChannels.status, "active")))
    .leftJoin(channelLastPosts, eq(channelLastPosts.channelId, channels.id))
    .leftJoin(canonicalLastPosts, eq(canonicalLastPosts.channelId, jointChannels.canonicalChannelId))
    .where(and(
      inArray(channels.id, listed.map((ch) => ch.id)),
      or(isNotNull(channelLastPosts.channelId), isNotNull(canonicalLastPosts.channelId)),
    ));
  const lastPostByChannel = new Map(lastPosts.map((row) => [row.channelId, row.lastPostAt.toISOString()]));
  // `taskId` (task v2) is NULL on every listable channel, and
  // `taskNumberHighWater` is the task number allocator's bookkeeping; keep both
  // out of the agent-facing directory so its shape is unchanged. So is the
  // stored announcement id: the serverInfo route adds the resolved
  // `announcement` (channelAnnouncements.ts) while channel_announcement_v0 is on.
  const visibleChannels = listed
    .map(({ taskId: _taskId, taskNumberHighWater: _taskNumberHighWater, announcementArtifactId: _announcementArtifactId, ...ch }) => {
      const jointContext = jointContexts.get(ch.id);
      const membership = membershipByChannel.get(ch.id);
      const joined = isEnabledAllChannel(ch) || Boolean(membership);
      const supportsChannelRoles = channelSupportsRoles(ch.type, ch.name) && !isAllSystemChannel(ch);
      return {
        ...ch,
        joined,
        // Only on archived rows: live rows stay as they were (no "not archived" on every line).
        ...(ch.archivedAt !== null ? { archived: true as const } : {}),
        ...(lastPostKnown ? { lastPostAt: lastPostByChannel.get(ch.id) ?? null } : {}),
        channelRole: membership?.role ?? null,
        channelAuthorityRevision: membership?.authorityRevision ?? null,
        channelAdminBasis: jointContext?.jointAuthority ? jointContext.channelAdminBasis : getChannelAdminBasis({
          serverRole: agentServerMembership?.role ?? null,
          channelRole: membership?.role ?? null,
          isChannelMember: Boolean(membership),
          supportsChannelRoles,
        }),
        channelCapabilities: Object.fromEntries(CHANNEL_MANAGEMENT_CAPABILITIES.map((capability) => [
          capability,
          // An archived channel is read-only: of the management actions only
          // unarchiving (the archive capability) still applies; the rest are refused (409 channel_archived).
          ch.archivedAt !== null && capability !== "archiveChannels" ? false : jointContext?.jointAuthority ? channelActorHasCapability(jointContext,capability) : capability === "addChannelMembers"
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
                channelType: ch.type,
              }),
        ])),
      };
    });
  // v1 built-in app conversations are intentionally not ordinary DMs: they
  // have one agent member and no dm_channel_identities row. Admit only the
  // exact registry-derived rows for this authenticated agent. This keeps
  // arbitrary DMs and test-catalog app names out of the channel directory and
  // writable target surface.
  const installedApps = scope === "archived" ? [] : await listInstalledRapApps(serverId);
  const builtInDmChannels = (await Promise.all(installedApps.map((app) =>
    getBuiltInConversationChannel(serverId, app.appId, agentId)
  )))
    .filter((channel): channel is NonNullable<typeof channel> => channel !== null)
    .map(({ taskId: _taskId, taskNumberHighWater: _taskNumberHighWater, announcementArtifactId: _announcementArtifactId, ...channel }) => ({ ...channel, joined: true }));
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
  lastMessagePreview?: string | null;
  lastMessageSenderName?: string | null;
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
  /** Only these DMs (GET /api/sync/changes): the same rows the full list holds for them. */
  channelIds?: readonly string[];
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
 * getReadableDMChannelForUser's `peerName` for many DM channels at once, in
 * at most four queries however many channels: the same rules (an agent
 * member first, else the durable identity: self, the other human, or a
 * deleted agent of the channel's server). Absent where it would answer null.
 */
export async function getReadableDMPeerNamesForUser(channelIds: readonly string[], currentUserId: string): Promise<Map<string, string>> {
  return new Map([...(await getReadableDMPeersForUser(channelIds, currentUserId))].map(([id, peer]) => [id, peer.name]));
}

/** getReadableDMPeerNamesForUser with each peer's display name too (null when it has none), as the sidebar labels the DM. */
export async function getReadableDMPeersForUser(channelIds: readonly string[], currentUserId: string): Promise<Map<string, { type: "user" | "agent"; id: string; name: string; displayName: string | null }>> {
  const names = new Map<string, { type: "user" | "agent"; id: string; name: string; displayName: string | null }>();
  if (channelIds.length === 0) return names;
  const db = getDb();
  const agentPeers = await db
    .select({ id: channels.id, agentId: channelAgents.agentId, peerName: sql<string>`COALESCE(${agents.name}, ${channels.name}, 'Agent')`, peerDisplayName: agents.displayName })
    .from(channels)
    .innerJoin(channelAgents, eq(channels.id, channelAgents.channelId))
    .leftJoin(agents, eq(channelAgents.agentId, agents.id))
    .innerJoin(channelHumans, and(eq(channels.id, channelHumans.channelId), eq(channelHumans.userId, currentUserId)))
    .where(and(inArray(channels.id, [...channelIds]), eq(channels.type, "dm")));
  for (const row of agentPeers) if (!names.has(row.id)) names.set(row.id, { type: "agent", id: row.agentId, name: row.peerName, displayName: row.peerDisplayName ?? null });

  const rest = channelIds.filter((id) => !names.has(id));
  if (rest.length === 0) return names;
  const identities = await db
    .select({ id: channels.id, serverId: channels.serverId, kind: dmChannelIdentities.kind, peerKey: dmChannelIdentities.peerKey })
    .from(dmChannelIdentities)
    .innerJoin(channels, and(eq(channels.id, dmChannelIdentities.channelId), eq(channels.serverId, dmChannelIdentities.serverId)))
    .innerJoin(channelHumans, and(eq(channels.id, channelHumans.channelId), eq(channelHumans.userId, currentUserId)))
    .where(and(inArray(channels.id, rest), eq(channels.type, "dm")));
  const userPeer = new Map<string, string>();
  const agentPeer = new Map<string, { agentId: string; serverId: string }>();
  for (const identity of identities) {
    const participantIds = identity.peerKey.split(":");
    if (!participantIds.includes(currentUserId)) continue;
    const other = participantIds.find((id) => id !== currentUserId);
    if (identity.kind === "human_self") {
      if (participantIds.length === 1) userPeer.set(identity.id, currentUserId);
    } else if (identity.kind === "human_human") {
      if (participantIds.length === 2 && other) userPeer.set(identity.id, other);
    } else if (identity.kind === "human_agent") {
      if (participantIds.length === 2 && other) agentPeer.set(identity.id, { agentId: other, serverId: identity.serverId });
    }
  }
  const userIds = [...new Set(userPeer.values())];
  const agentIds = [...new Set([...agentPeer.values()].map((peer) => peer.agentId))];
  const [userRows, agentRows] = await Promise.all([
    userIds.length > 0 ? db.select({ id: users.id, name: users.name, displayName: users.displayName }).from(users).where(inArray(users.id, userIds)) : [],
    agentIds.length > 0 ? db.select({ id: agents.id, serverId: agents.serverId, name: agents.name, displayName: agents.displayName }).from(agents).where(inArray(agents.id, agentIds)) : [],
  ]);
  const userOf = new Map(userRows.map((row) => [row.id, row]));
  const agentOf = new Map(agentRows.map((row) => [row.id, row]));
  for (const [channelId, userId] of userPeer) {
    const row = userOf.get(userId);
    if (row?.name != null) names.set(channelId, { type: "user", id: row.id, name: row.name, displayName: row.displayName ?? null });
  }
  for (const [channelId, peer] of agentPeer) {
    const row = agentOf.get(peer.agentId);
    if (row && row.serverId === peer.serverId) names.set(channelId, { type: "agent", id: row.id, name: row.name, displayName: row.displayName ?? null });
  }
  return names;
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
    .select({ id: users.id, name: users.name, displayName: users.displayName, description: users.description, avatarUrl: users.avatarUrl })
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
    peerGravatarHash: DEPRECATED_GRAVATAR_HASH,
  };
}

/**
 * Find or create a DM channel between a user and an agent.
 * Returns unified peer format.
 */
/** The live DM between two people, without creating one. */
export async function findHumanHumanDmChannelId(serverId: string, userId: string, otherUserId: string): Promise<string | null> {
  if (userId === otherUserId) return null;
  const [row] = await getDb()
    .select({ id: channels.id })
    .from(dmChannelIdentities)
    .innerJoin(channels, eq(channels.id, dmChannelIdentities.channelId))
    .where(and(
      eq(dmChannelIdentities.serverId, serverId),
      eq(channels.type, "dm"),
      isNull(channels.deletedAt),
      eq(dmChannelIdentities.kind, "human_human"),
      eq(dmChannelIdentities.peerKey, dmIdentityKey([userId, otherUserId])),
    ))
    .orderBy(asc(channels.createdAt), asc(channels.id))
    .limit(1);
  return row?.id ?? null;
}

/** The live DM between this person and this agent, without creating one. */
export async function findHumanAgentDmChannelId(serverId: string, userId: string, agentId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ id: channels.id })
    .from(dmChannelIdentities)
    .innerJoin(channels, eq(channels.id, dmChannelIdentities.channelId))
    .where(and(
      eq(dmChannelIdentities.serverId, serverId),
      eq(channels.type, "dm"),
      isNull(channels.deletedAt),
      eq(dmChannelIdentities.kind, "human_agent"),
      eq(dmChannelIdentities.peerKey, dmIdentityKey([userId, agentId])),
    ))
    .orderBy(asc(channels.createdAt), asc(channels.id))
    .limit(1);
  return row?.id ?? null;
}

// Identity reuse repairs legacy departures that removed channel_humans.
// Select from current server membership so absent peers are never re-enrolled.
// Conflict-do-nothing preserves an existing participant's role/join timestamp;
// read cursors and inbox/display state are deliberately independent.
async function restoreDmHumanParticipants(
  tx: DatabaseExecutor,
  serverId: string,
  channelId: string,
  userIds: readonly string[],
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO ${channelHumans} (channel_id, user_id)
    SELECT ${channelId}::uuid, ${serverMembers.userId}
    FROM ${serverMembers}
    WHERE ${serverMembers.serverId} = ${serverId}
      AND ${inArray(serverMembers.userId, [...new Set(userIds)])}
    ON CONFLICT (channel_id, user_id) DO NOTHING
  `);
}

export async function findOrCreateDM(serverId: string, userId: string, agentId: string): Promise<DMChannel | null> {
  const identityKind: DmIdentityKind = "human_agent";
  const identityKey = dmIdentityKey([userId, agentId]);
  const dmChannelId = await withServerResourceLock(
    serverId,
    DM_LOCK_NAMESPACE,
    dmPairKey("human-agent", [userId, agentId]),
    async (tx) => {
      const [agent] = await tx
        .select({ id: agents.id, name: agents.name, displayName: agents.displayName, assistantOwnerUserId: agents.assistantOwnerUserId })
        .from(agents)
        .where(and(
          eq(agents.id, agentId),
          eq(agents.serverId, serverId),
          isNull(agents.deletedAt),
        ));
      if (!agent) return null;
      // RFC 074 §2: an assistant's only DM is the one with its owner.
      if (agent.assistantOwnerUserId && agent.assistantOwnerUserId !== userId) return null;

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
        await restoreDmHumanParticipants(tx, serverId, identified.id, [userId]);
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
      // read-position: new conversation, no history before this join (no row = position 0)
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
          await restoreDmHumanParticipants(tx, serverId, existing.id, [userId1]);
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
        // read-position: new conversation, no history before this join (no row = position 0)
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
        await restoreDmHumanParticipants(tx, serverId, identified.id, [userId1, userId2]);
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
      // read-position: new conversation, no history before this join (no row = position 0)
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
  // RFC 074 §2: an assistant has no DMs with other agents.
  const assistants = await getDb()
    .select({ id: agents.id })
    .from(agents)
    .where(and(inArray(agents.id, [agentId1, agentId2]), isNotNull(agents.assistantOwnerUserId)))
    .limit(1);
  if (assistants.length > 0) return null;

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
      // read-position: new conversation, no history before this join (no row = position 0)
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
  // Read beside the list's own queries, not after them (bootstrap path). An
  // early return never awaits it: a failure then is not an unhandled rejection.
  const historyCutoffPending = getServerPlan(serverId).then((plan) => getHistoryCutoff(plan));
  historyCutoffPending.catch(() => {});
  const db = getDb();
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;
  if (opts?.channelIds && opts.channelIds.length === 0) return [];
  const onlyIds = opts?.channelIds ? inArray(channels.id, [...new Set(opts.channelIds)]) : undefined;

  // The user's DMs with each peer, in one statement: agent DMs (the channel
  // has an agent), user DMs (no agent; the peer is the other human) and
  // self DMs (explicit human_self provenance — mutable membership is
  // ambiguous after agent deletion). It runs alongside the role check; a
  // guest without the guest feature discards it.
  const otherHuman = alias(channelHumans, "other_human");
  const agentDMs = db
    .select({
      peerKind: sql<"agent" | "user" | "self">`'agent'`.as("peer_kind"),
      id: channels.id,
      name: channels.name,
      type: channels.type,
      description: channels.description,
      createdAt: channels.createdAt,
      peerId: agents.id,
      peerName: agents.name,
      peerDisplayName: agents.displayName,
      peerDescription: agents.description,
      peerAvatarUrl: agents.avatarUrl,
      // The agent is live (deletedAt below), so this is isAppBotAgent.
      peerIsAppBot: sql<boolean>`${agents.managedByAppInstallId} is not null`.as("peer_is_app_bot"),
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
      onlyIds,
    ));
  const userDMs = db
    .select({
      peerKind: sql<"agent" | "user" | "self">`'user'`.as("peer_kind"),
      id: channels.id,
      name: channels.name,
      type: channels.type,
      description: channels.description,
      createdAt: channels.createdAt,
      peerId: users.id,
      peerName: users.name,
      peerDisplayName: users.displayName,
      peerDescription: users.description,
      peerAvatarUrl: users.avatarUrl,
      peerIsAppBot: sql<boolean>`false`.as("peer_is_app_bot"),
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
      ne(otherHuman.userId, userId), // the peer, not the current user
      onlyIds,
    ));
  const selfDMs = db
    .select({
      peerKind: sql<"agent" | "user" | "self">`'self'`.as("peer_kind"),
      id: channels.id,
      name: channels.name,
      type: channels.type,
      description: channels.description,
      createdAt: channels.createdAt,
      peerId: users.id,
      peerName: users.name,
      peerDisplayName: users.displayName,
      peerDescription: users.description,
      peerAvatarUrl: users.avatarUrl,
      peerIsAppBot: sql<boolean>`false`.as("peer_is_app_bot"),
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
      onlyIds,
    ));
  const [serverRole, peerDMRows] = await Promise.all([
    resolveHumanServerRole(serverId, userId),
    traceQuery(
      "dm_channels.peer_dms_by_user",
      () => unionAll(agentDMs, userDMs, selfDMs),
      (rows) => ({
        agent_dms_count: rows.filter((row) => row.peerKind === "agent").length,
        user_dms_count: rows.filter((row) => row.peerKind === "user").length,
        self_dms_count: rows.filter((row) => row.peerKind === "self").length,
      }),
    ),
  ]);
  // A Guest has no DMs (#wg-rbac:#15).
  if (serverRole === null || serverRole === "guest") return [];

  // Agent DMs first, then user DMs, then self DMs (the order the sort below
  // breaks ties in).
  const kindOrder = { agent: 0, user: 1, self: 2 } as const;
  const allDMs: DMChannel[] = peerDMRows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => kindOrder[a.row.peerKind] - kindOrder[b.row.peerKind] || a.index - b.index)
    .map(({ row: { peerKind, peerIsAppBot: _peerIsAppBot, ...row } }) => ({
      ...row,
      peerGravatarHash: peerKind === "agent" ? null : DEPRECATED_GRAVATAR_HASH,
      peerType: peerKind === "agent" ? "agent" as const : "user" as const,
    }));
  const appBotDmIds = new Set(peerDMRows.filter((row) => row.peerIsAppBot).map((row) => row.id));

  // Sort by most recent message first, then by createdAt for DMs with no messages
  if (allDMs.length === 0) return allDMs;

  const humanActivityMuteEnabled = opts?.humanActivityMuteEnabled ?? true;
  // Each attach step reads its own table for the same rows; they run side by
  // side (at most LIST_ATTACH_CONCURRENCY at once) and are merged per row.
  const limit = createConcurrencyLimiter(LIST_ATTACH_CONCURRENCY);
  // Agent Lounge: the agent's lounge rides on its DM row (only once one
  // exists); the web keeps it under the DM. Unread comes from the unread
  // summary by its channelId, as for any channel.
  const [withMute, withDisplayPrefs, withReadState, withLastMessage, lounges] = await Promise.all([
    limit(() => attachActivityMuteState(allDMs, "user", userId, humanActivityMuteEnabled, appBotDmIds)),
    limit(() => attachUserChannelDisplayPrefs(allDMs, userId)),
    limit(() => attachReadState(allDMs, userId)),
    limit(async () => attachLastMessageSummary(
      allDMs,
      traceQuery,
      "dm_channels.last_messages_by_channels",
      "dm_channels_count",
      await historyCutoffPending,
    )),
    limit(() => loungeSummariesForAgents(allDMs.filter((dm) => dm.peerType === "agent").map((dm) => dm.peerId), userId)),
  ]);
  const allDmsWithLastMessageSummary = allDMs.map((dm, index) => {
    const lounge = dm.peerType === "agent" ? lounges.get(dm.peerId) : undefined;
    return {
      ...withMute[index]!,
      ...withDisplayPrefs[index]!,
      ...withReadState[index]!,
      ...withLastMessage[index]!,
      ...(lounge ? { lounge } : {}),
    };
  });

  return allDmsWithLastMessageSummary.sort((a, b) => {
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
  const historyCutoffPending = getServerPlan(serverId).then((plan) => getHistoryCutoff(plan));
  historyCutoffPending.catch(() => {});
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

  const historyCutoff = await historyCutoffPending;
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
        // Behind the plan's history window: 40 characters (services/historyWindow.ts).
        lastMessagePreview: latest && historyCutoff && latest.createdAt <= historyCutoff
          ? historyLimitedPreview(latest.content)
          : latest?.content ?? null,
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
/**
 * P3 (guests in joint channels): of `candidates`, the joint channel a Guest of
 * `serverId` enters. Only its bound channel can qualify, and only when that is
 * the HOST's own projection, the host has external_channels_v1 on, no removal
 * of the guest is pending, and the guest is a current joint member: its
 * joint_channel_members row through the host entry
 * (filterJointHumanMemberEntries). Flag off: nothing, exactly as before P3.
 */
export async function filterGuestJointEntries(
  serverId: string,
  userId: string,
  guestChannelId: string | null,
  candidates: ReadonlyArray<{ id: string; type: string }>,
  db: DatabaseExecutor = getDb(),
): Promise<Set<string>> {
  if (!guestChannelId || !candidates.some((channel) => channel.id === guestChannelId && channel.type === "joint")) return new Set();
  const scope = (await resolveJointHumanMembershipScopes({ serverId: asServerId(serverId), localChannelIds: [guestChannelId] }, db)).get(guestChannelId);
  if (!scope || !scope.guestEntryEnabled || scope.entryServerId !== scope.hostServerId) return new Set();
  if ((await filterJointPendingRemovalEntries([scope], "user", userId, db)).has(guestChannelId)) return new Set();
  return filterJointHumanMemberEntries([scope], userId, db);
}

export async function canUserAccessChannel(
  channelId: string,
  userId: string,
  serverId: ServerId,
  opts?: { includeDeleted?: boolean; executor?: DatabaseExecutor },
): Promise<boolean> {
  const db = opts?.executor ?? getDb();
  const channel = await getChannel(channelId, { ...opts, executor: db });
  if (!channel) return false;

  // Cross-server guard: the channel must live in the caller's active server.
  if (channel.serverId !== serverId) return false;

  const serverRole = await resolveHumanServerRole(serverId, userId, db);
  if (serverRole === null) return false;
  if (serverRole === "guest") {
    // Task conversation (task v2): visibility is the parent channel's.
    if (channel.type === "task") {
      return channel.parentChannelId ? canUserAccessChannel(channel.parentChannelId, userId, serverId, opts) : false;
    }
    if (isSubConversationType(channel.type)) {
      // A joint thread follows its local parent projection (P3: the Guest's
      // bound host projection, through the joint guest rule).
      const jointThread = await getJointThreadProjectionByLocalThread(channelId, serverId, db);
      if (jointThread) return canUserAccessChannel(jointThread.localParentChannelId, userId, serverId, opts);
      if (!channel.parentMessageId) return false;
      const [parentMsg] = await db
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, channel.parentMessageId));
      return parentMsg ? canUserAccessChannel(parentMsg.channelId, userId, serverId, opts) : false;
    }
    const guestChannelId = await getGuestChannelId(serverId, userId, db);
    const jointEntry = channel.type === "joint"
      ? (await filterGuestJointEntries(serverId, userId, guestChannelId, [channel], db)).has(channel.id)
      : false;
    const isChannelMember = channel.type === "joint" ? jointEntry : await isChannelHuman(channelId, userId, db);
    return canGuestReadChannel({
      serverRole,
      channelId: channel.id,
      guestChannelId,
      channelType: channel.type,
      isChannelMember,
      jointEntry,
      archived: channel.archivedAt !== null,
      deleted: channel.deletedAt !== null,
    });
  }

  if (isAllSystemChannel(channel) && !isEnabledAllChannel(channel)) return false;

  // Public channels are viewable by all server humans.
  if (channel.type === "channel") return true;

  if (channel.type === "joint") {
    const scope = (await resolveJointHumanMembershipScopes({ serverId, localChannelIds: [channelId] }, db)).get(channelId);
    if (scope && (await filterJointPendingRemovalEntries([scope], "user", userId, db)).has(channelId)) return false;
    return scope !== undefined && (await filterJointHumanMemberEntries([scope], userId, db)).has(channelId);
  }

  // Task conversation (task v2): the parent channel decides — for a joint
  // local face that is this server's local channel; a canonical joint
  // conversation's parent is storage and never grants access.
  if (channel.type === "task") {
    return channel.parentChannelId ? canUserAccessChannel(channel.parentChannelId, userId, serverId, opts) : false;
  }

  if (isSubConversationType(channel.type)) {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, serverId, db);
    if (jointThread) {
      return canUserAccessChannel(jointThread.localParentChannelId, userId, serverId, opts);
    }
  }

  if (channel.type === "thread" && channel.parentMessageId) {
    const [parentMsg] = await db
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
 * Batched `canUserAccessChannel` over many candidate channels of ONE server:
 * returns the subset of `channelIds` the human may view, with a constant
 * number of queries independent of `channelIds.length`.
 *
 * Mirrors `canUserAccessChannel` rule for rule: `channel`, `private`, `joint`
 * and `dm` directly; a `thread` through its parent (a joint thread's local
 * parent projection, otherwise its parent message's channel), resolved for all
 * threads at once and checked with one nested call. Only an unknown type falls
 * back to the single-channel check.
 */
export async function filterUserAccessibleChannelIds(
  channelIds: readonly string[],
  userId: string,
  serverId: ServerId,
  opts?: { executor?: DatabaseExecutor },
): Promise<Set<string>> {
  const db = opts?.executor ?? getDb();
  const accessible = new Set<string>();
  if (channelIds.length === 0) return accessible;

  // Same row filter as getChannel (not deleted) plus the cross-server guard.
  const candidates = (await db
    .select()
    .from(channels)
    .where(and(inArray(channels.id, [...channelIds]), isNull(channels.deletedAt))))
    .filter((channel) => channel.serverId === serverId);
  if (candidates.length === 0) return accessible;

  const serverRole = await resolveHumanServerRole(serverId, userId, db);
  if (serverRole === null) return accessible;
  const batchable = candidates.filter((channel) => channel.type === "channel" || channel.type === "private" || channel.type === "joint" || channel.type === "dm");
  const threads = candidates.filter((channel) => channel.type === "thread");
  const fallback = candidates.filter((channel) => !batchable.includes(channel) && !threads.includes(channel));

  // Human DM reads are participant-scoped: the same membership row as private.
  const needsMembership = batchable.filter((channel) => serverRole === "guest" || channel.type === "private" || channel.type === "dm");
  const memberChannelIds = new Set<string>();
  if (needsMembership.length > 0) {
    const rows = await db
      .select({ channelId: channelHumans.channelId })
      .from(channelHumans)
      .where(and(
        eq(channelHumans.userId, userId),
        inArray(channelHumans.channelId, needsMembership.map((channel) => channel.id)),
      ));
    for (const row of rows) memberChannelIds.add(row.channelId);
  }

  if (serverRole === "guest") {
    const guestChannelId = batchable.length > 0 ? await getGuestChannelId(serverId, userId, db) : null;
    const guestJointEntries = await filterGuestJointEntries(serverId, userId, guestChannelId, batchable, db);
    for (const channel of batchable) {
      const jointEntry = channel.type === "joint" && guestJointEntries.has(channel.id);
      if (canGuestReadChannel({
        serverRole,
        channelId: channel.id,
        guestChannelId,
        channelType: channel.type,
        isChannelMember: channel.type === "joint" ? jointEntry : memberChannelIds.has(channel.id),
        jointEntry,
        archived: channel.archivedAt !== null,
        deleted: channel.deletedAt !== null,
      })) accessible.add(channel.id);
    }
  } else {
    const visible = batchable.filter((channel) => !(isAllSystemChannel(channel) && !isEnabledAllChannel(channel)));
    const allJointIds = visible.filter((channel) => channel.type === "joint").map((channel) => channel.id);
    const jointScopes = await resolveJointHumanMembershipScopes({ serverId, localChannelIds: allJointIds }, db);
    // Joint: J membership through this server's active entry.
    const jointMembers = await filterJointHumanMemberEntries([...jointScopes.values()], userId, db);
    const deniedJointEntries = await filterJointPendingRemovalEntries([...jointScopes.values()], "user", userId, db);
    for (const channel of visible) {
      if (channel.type === "channel") accessible.add(channel.id);
      else if (channel.type === "joint") { if (jointMembers.has(channel.id) && !deniedJointEntries.has(channel.id)) accessible.add(channel.id); }
      else if (memberChannelIds.has(channel.id)) accessible.add(channel.id);
    }
  }

  if (threads.length > 0) {
    for (const id of await filterUserAccessibleThreadIds(threads, userId, serverId, serverRole, db)) accessible.add(id);
  }

  // Not a type the batch knows; the single check stays the one source of truth.
  for (const channel of fallback) {
    if (await canUserAccessChannel(channel.id, userId, serverId, { executor: db })) accessible.add(channel.id);
  }
  return accessible;
}

/**
 * canUserAccessChannel's thread rule for a list of threads: a guest never sees
 * a joint thread and otherwise sees a thread through its parent message's
 * channel; anyone else sees a joint thread through its local parent
 * projection, a thread through its parent message's channel, and a thread with
 * neither through its own membership row.
 */
async function filterUserAccessibleThreadIds(
  threads: ReadonlyArray<typeof channels.$inferSelect>,
  userId: string,
  serverId: ServerId,
  serverRole: Awaited<ReturnType<typeof resolveHumanServerRole>>,
  db: DatabaseExecutor,
): Promise<Set<string>> {
  const accessible = new Set<string>();
  const jointParentByThread = new Map<string, string>();
  for (const projection of await listActiveJointThreadProjectionRows({ localThreadChannelIds: threads.map((thread) => thread.id), serverId }, db)) {
    if (!jointParentByThread.has(projection.localThreadChannelId)) jointParentByThread.set(projection.localThreadChannelId, projection.localParentChannelId);
  }
  const parentMessageIds = threads
    .filter((thread) => !jointParentByThread.has(thread.id) && thread.parentMessageId)
    .map((thread) => thread.parentMessageId!);
  const parentChannelByMessage = new Map<string, string>();
  if (parentMessageIds.length > 0) {
    const rows = await db
      .select({ id: messages.id, channelId: messages.channelId })
      .from(messages)
      .where(inArray(messages.id, [...new Set(parentMessageIds)]));
    for (const row of rows) parentChannelByMessage.set(row.id, row.channelId);
  }

  const parentByThread = new Map<string, string>();
  const ownMembership: string[] = [];
  for (const thread of threads) {
    const jointParent = jointParentByThread.get(thread.id);
    if (jointParent) {
      // A Guest reaches a joint thread through its bound host projection (P3);
      // the parent check applies the guest rule.
      parentByThread.set(thread.id, jointParent);
      continue;
    }
    if (thread.parentMessageId) {
      const parent = parentChannelByMessage.get(thread.parentMessageId);
      if (parent) parentByThread.set(thread.id, parent);
      continue;
    }
    if (serverRole !== "guest") ownMembership.push(thread.id);
  }

  const parentIds = [...new Set(parentByThread.values())];
  const accessibleParents = parentIds.length > 0
    ? await filterUserAccessibleChannelIds(parentIds, userId, serverId, { executor: db })
    : new Set<string>();
  for (const [threadId, parentId] of parentByThread) if (accessibleParents.has(parentId)) accessible.add(threadId);

  if (ownMembership.length > 0) {
    const rows = await db
      .select({ channelId: channelHumans.channelId })
      .from(channelHumans)
      .where(and(eq(channelHumans.userId, userId), inArray(channelHumans.channelId, ownMembership)));
    for (const row of rows) accessible.add(row.channelId);
  }
  return accessible;
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
 * Joining writes the first witness. Since #8292 a member's read position starts at
 * the join, so EVERY join (channel, joint invite, thread follow) leaves a read-cursor
 * row, and anyone removed afterwards gets the 403. The same holds for Guests: a
 * revoked Guest could read the channel, so a 404 would hide nothing from them and
 * would only stop them clearing its stale Activity entry. The one population still
 * answered 404 is ex-members from before #8292 who never read, followed, marked
 * done or were suppressed -- they left no residue and there is no membership
 * history table to consult. That is the fail-closed direction.
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
 * Agent Lounge: a human's first post joins them (canUserPostToChannel already
 * let them post). True when it joined them; false for any other channel or an
 * existing member.
 */
export async function ensureLoungeHumanMember(channelId: string, userId: string): Promise<boolean> {
  if (!await isAgentLoungeChannel(channelId)) return false;
  if (await isChannelHuman(channelId, userId)) return false;
  return addHuman(channelId, userId);
}

/**
 * Add a human user to a channel (inserts into channelHumans). `actorUserId`:
 * the person who added them (themselves for a self-join), recorded as who
 * admitted them when this makes them a joint member; none when no person did.
 */
export async function addHuman(channelId: string, userId: string, options: ChannelServiceOptions & {
  role?: "member" | "admin";
  actorUserId?: string;
  boundGuest?: boolean;
  /**
   * A joint's channel row lock. A caller holding the archive's FOR NO KEY
   * UPDATE (an unarchive that rejoins its host admin) keeps it: upgrading would
   * wait on readers' FOR KEY SHARE (P3; withLockedChannelActorCapabilities).
   */
  jointChannelLock?: "update" | "no key update";
} = {}): Promise<boolean> {
  if (!options.executor) {
    return withChannelWriterFence(channelId, async (tx) => {
      // Its own transaction: the person added and the one adding them first
      // (lockJointUsersFirst; only locked), as withLockedChannelActorCapability
      // takes them for a caller's transaction.
      await lockJointUsersFirst(tx, { userIds: [userId, options.actorUserId] });
      await assertChannelActionCardWritable(tx, channelId, options);
      return addHuman(channelId, userId, { ...options, executor: tx });
    });
  }
  const db = options.executor ?? getDb();
  await assertChannelWritableInTransaction(db, channelId);
  await assertChannelActionCardWritable(db, channelId, options);
  const [channel] = await db
    .select({ id: channels.id, serverId: channels.serverId, name: channels.name, type: channels.type })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!channel) {
    throw new Error("Channel not found");
  }
  if (isSubConversationType(channel?.type)) {
    throw new Error("Thread membership is managed via follow/unfollow, not channel_humans");
  }
  if (channel.type === "joint") {
    await lockJointHumanMembershipChannel(db, channelId, options.jointChannelLock);
    await lockJointHumanAdmissionSource(db, channel.serverId, [userId]);
  }
  const [member] = await db
    .select({ userId: serverMembers.userId, role: serverMembers.role, guestChannelId: serverMembers.guestChannelId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, channel.serverId), eq(serverMembers.userId, userId)));
  if (!member) {
    throw new Error("Human is not a member of this channel's server");
  }
  if (member.role === "guest" && options.role === "admin") {
    throw new Error("Guests can't be channel admins");
  }
  // Agent Lounge: Guests never take part, and nobody manages it as channel admin.
  if (channel.type === "channel" && (member.role === "guest" || options.role === "admin")
    && await isAgentLoungeChannel(channelId, db)) {
    throw new Error(member.role === "guest" ? "Guests cannot join an agent's lounge" : "An agent's lounge has no channel admins");
  }
  if (isAllSystemChannel(channel)) {
    if (member.role === "guest") {
      throw new Error(GUEST_ALL_CHANNEL_MESSAGE);
    }
    return false;
  }
  const mirrorHumans = await prepareJointHumanMembershipMirror(db, { channelIds: [channelId] }, "join");
  const joint = mirrorHumans.coversChannel(channelId);
  if (joint) {
    // P3: a Guest joins a joint channel only as itself, bound to this
    // projection (its external invite acceptance); the mirror's join then
    // admits it only through the host projection with the host flag on.
    // No member-add path adds a Guest.
    if (member.role === "guest" && !(options.boundGuest && member.guestChannelId === channelId)) throw new Error("Channel capability required");
    const existing = await db.execute<{ member: boolean }>(sql`SELECT EXISTS (
      SELECT 1 FROM joint_channel_members m JOIN joint_channel_servers p ON p.joint_channel_id=m.joint_channel_id
      WHERE p.local_channel_id=${channelId}::uuid AND m.user_id=${userId}::uuid
    ) AS member`);
    if (existing.rows[0]?.member) return false;
  }
  const inserted = joint
    ? await db.insert(channelHumans).values({channelId,userId,role:"member"})
      .onConflictDoUpdate({target:[channelHumans.channelId,channelHumans.userId],set:{role:"member",authorityRevision:sql`${channelHumans.authorityRevision}+1`}})
      .returning({userId:channelHumans.userId})
    : await db.insert(channelHumans).values({channelId,userId,role:options.role??"member"})
      .onConflictDoNothing().returning({userId:channelHumans.userId});
  if (inserted.length > 0 || joint) await startReadPositionAtJoin(db, "human", userId, channelId);
  await mirrorHumans.apply([userId], options.actorUserId ? { actorUserId: options.actorUserId } : {});
  return joint || inserted.length > 0;
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
  // Task conversation (task v2): its parent channel is on the row.
  if (channel.type === "task") return channel.parentChannelId ?? null;
  if (channel.type !== "thread") return channel.id;
  return (await resolveThreadParent(channel, executor))?.parentChannelId ?? null;
}

/**
 * The parent message of a thread and the local channel it hangs off. A joint
 * thread's local projection carries no parent_message_id (the parent lives on
 * the canonical thread): resolve it through the thread's own server's
 * projection, whose parent message is canonical and whose parent channel is
 * that server's projection of the parent joint channel. Null when neither
 * exists, so callers fail closed.
 */
export async function resolveThreadParent(
  thread: { id: string; serverId: string; parentMessageId: string | null },
  executor: DatabaseExecutor = getDb(),
): Promise<{ parentMessageId: string; parentChannelId: string } | null> {
  if (!thread.parentMessageId) {
    const projection = await getJointThreadProjectionByLocalThread(thread.id, thread.serverId, executor);
    // Thread-only: a task conversation has no parent message.
    return projection?.canonicalParentMessageId
      ? { parentMessageId: projection.canonicalParentMessageId, parentChannelId: projection.localParentChannelId }
      : null;
  }
  const [parentMessage] = await executor
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, thread.parentMessageId))
    .limit(1);
  return parentMessage ? { parentMessageId: thread.parentMessageId, parentChannelId: parentMessage.channelId } : null;
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
    // A joint channel's roles live on this server's projection (the channel id
    // here), so only this server's members can be targeted: another server's
    // people have no membership row on this projection.
    if (!channelSupportsRoles(channel.type, channel.name) || isAllSystemChannel(channel)) {
      throw new ChannelMembershipRoleMutationError("unsupported_channel_shape", "Channel roles are supported only for public, private or joint channels");
    }
    if (channel.archivedAt) {
      throw new ChannelMembershipRoleMutationError("channel_archived", "This channel is archived");
    }
    // Agent Lounge: nobody manages it as channel admin (as addHuman/addAgent
    // refuse); promotion would hand a member channel-level archive/unarchive.
    if (input.nextRole === "admin" && channel.type === "channel" && await isAgentLoungeChannel(channel.id, tx)) {
      throw new ChannelMembershipRoleMutationError("unsupported_channel_shape", "An agent's lounge has no channel admins");
    }

    await lockComputedJointActor({ serverId: input.serverId, channelId: input.channelId,
      actorType: "user", actorId: input.requesterUserId,
      humanSubjectIds: input.targetType === "user" ? [input.targetId] : [],
    }, tx);
    const jointContext = channel.type === "joint"
      ? await resolveChannelActorContext(input.serverId, input.channelId, "user", input.requesterUserId, tx)
      : null;
    const jointRoles = jointContext?.jointAuthority !== undefined;
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
    const requesterAllowed = jointRoles ? channelActorHasCapability(jointContext!, "changeChannelMemberRoles") : requesterCanAccess && hasEffectiveChannelCapability({
      serverRole: requesterServer?.role ?? null,
      channelRole: requesterMembership?.role ?? null,
      isChannelMember: Boolean(requesterMembership),
      supportsChannelRoles: true,
      capability: "changeChannelMemberRoles",
      channelType: channel.type,
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

    // A qualified host J member need not have a CH row on this projection.
    // Creating a host-side role record does not admit a new J member or move
    // their read cursor. Another entry's admin status is deliberately irrelevant.
    if (jointRoles && input.targetType === "user") {
      const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [input.channelId] }, tx)).get(input.channelId)!;
      if (!(await filterJointHumanMemberEntries([scope], input.targetId, tx)).has(input.channelId)) {
        throw new ChannelMembershipRoleMutationError("channel_member_required", "Target must already be a channel member");
      }
      if (input.nextRole === "admin") {
        const hostMember = await tx.execute(sql`SELECT 1 FROM server_members
          WHERE server_id=${scope.hostServerId}::uuid AND user_id=${input.targetId}::uuid AND role<>'guest'`);
        if (!hostMember.rows.length) throw new ChannelMembershipRoleMutationError("channel_member_required", "Target must be a current host member");
      }
      // read-position: existing member projection; J membership is unchanged, preserve all read cursors.
      await tx.insert(channelHumans).values({ channelId: input.channelId, userId: input.targetId, role: "member" }).onConflictDoNothing();
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

/**
 * Remove a human from a channel. #all never has explicit human membership.
 * `removedBy` is required (ChannelRemovalActor): the person themselves, the
 * person or agent acting on channel authority, or the system. A call without
 * one is a programming error and removes nothing.
 */
export async function removeHuman(channelId: string, userId: string, removedBy: ChannelRemovalActor, executor?: DatabaseExecutor, lastMember: LastPrivateMember = "delete"): Promise<ChannelMemberRemoval> {
  // Checked at run time too: an untyped caller must not fall back to a self-leave.
  if (!removedBy || typeof removedBy !== "object") throw new Error("removeHuman requires an explicit actor");
  if (!executor) {
    const removal = await withChannelWriterFence(channelId, async (tx) => {
      // Its own transaction (a self-leave, the system): the person removed and
      // the one removing them first (lockJointUsersFirst; only locked: a person
      // mid-deletion may still leave), as withLockedChannelActorCapability
      // takes them for a caller's transaction.
      await lockJointUsersFirst(tx, { userIds: [userId, removalActorUserId(userId, removedBy)] });
      return removeHuman(channelId, userId, removedBy, tx, lastMember);
    });
    // Executor callers own the surrounding transaction and invalidate after its
    // commit. A reconnect before commit could otherwise recover the old rooms.
    await finishChannelMemberRemoval(removal, userId);
    return removal;
  }
  await assertChannelWritableInTransaction(executor, channelId);
  const db = executor ?? getDb();
  let actor = removalActorContext(removedBy);
  const channel = await getChannel(channelId, { executor: db });
  if (isSubConversationType(channel?.type)) {
    throw new Error("Thread membership is managed via follow/unfollow, not channel_humans");
  }
  if (channel && isAllSystemChannel(channel)) {
    throw new Error(ALL_CHANNEL_LEAVE_MESSAGE);
  }
  if (channel?.type === "joint") {
    // FOR NO KEY UPDATE: a joint removal never deletes the joint channel, and
    // a member's (or Guest's) read mutation holds its member row before the
    // channel's FOR KEY SHARE (the admission fence); FOR UPDATE here would
    // close a cycle with that read once this removal takes the member row
    // (P3, Cody on PR #13205). Writers stay serialized.
    await lockJointHumanMembershipChannel(db, channelId, "no key update");
    if (actor) {
      if (actor.channelId !== channelId || actor.serverId !== channel.serverId) throw new Error("Channel capability required");
      await lockComputedJointActor({ serverId: actor.serverId, channelId, actorType: actor.actorType, actorId: actor.actorId, humanSubjectIds: [userId] },db);
      actor = await resolveChannelActorContext(actor.serverId,channelId,actor.actorType,actor.actorId,db) ?? undefined;
      if (!actor) throw new Error("Channel capability required");
    }
  }
  // A Guest exists only for its one channel: leaving it, or being removed
  // from it, ends the Guest's server membership in the same commit. The full
  // server removal deletes the channel row itself, in its own lock order
  // (servers -> member row -> channel_humans), so no Guest is left with only a
  // server_members row (#wg-rbac:#15).
  // The unlocked read only routes; the binding is re-checked under the
  // membership lock, and a Guest promoted meanwhile takes the Member path.
  if (channel && await isGuestBoundToChannel(db, channel.serverId, channelId, userId)) {
    // Global lock order channel -> server -> member -> joint -> channel
    // membership: the channel row first (also for a self-leave), so emptying a
    // private channel cannot wait behind a deletion holding it.
    // A joint channel is never deleted here: FOR NO KEY UPDATE, as above.
    // An emptied private channel may be (deletePrivateChannelIfEmpty).
    await db.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId)).for(channel.type === "joint" ? "no key update" : "update");
    const { removeMemberInTransaction } = await import("./serverService");
    const actorUserId = removalActorUserId(userId, removedBy);
    const removalAudit = channelRemovalAudit(userId, actor ?? removedBy);
    const effects = await removeMemberInTransaction(db as DatabaseTransaction, channel.serverId, userId, {
      onlyIfGuestBoundTo: channelId,
      reason: actorUserId === userId ? "left" : "removed",
      actorUserId: actorUserId ?? null,
      // Every channel the Guest loses with its membership is audited there, by this actor.
      channelAudit: { reason: "guest_unbind", actor: removalAudit.actor, actorRole: removalAudit.actorRole },
    });
    if (effects) {
      return {
        channelDeleted: await deletePrivateChannelIfEmpty(channelId, db, lastMember),
        endedGuestMembership: { serverId: channel.serverId, effects },
      };
    }
  }
  const mirrorHumans = await prepareJointHumanMembershipMirror(db, { channelIds: [channelId] }, "remove");
  if (mirrorHumans.coversChannel(channelId) && actor) {
    if (!channelActorHasCapability(actor, "removeChannelMembers")) throw new Error("Channel capability required");
  }
  // A joint channel is audited once per joint, whichever copy the removal came through.
  const joint = channel?.type === "joint" ? await jointOfLocalChannel(db, channelId) : null;
  const wasJointMember = joint ? await isJointMember(db, joint.jointChannelId, userId) : false;
  const deleted = await db.delete(channelHumans).where(
    and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId))
  ).returning({ userId: channelHumans.userId });
  // The person leaving or removing them; an agent or the system records none.
  const mirrorActorUserId = removalActorUserId(userId, removedBy);
  await mirrorHumans.apply([userId], mirrorActorUserId ? { actorUserId: mirrorActorUserId } : {});
  const ended = deleted.length > 0 || (joint !== null && wasJointMember && !await isJointMember(db, joint.jointChannelId, userId));
  if (channel && ended) {
    // Same transaction as the removal: a failed audit write fails the removal.
    await recordChannelMembershipsEnded(db, {
      ...channelRemovalAudit(userId, actor ?? removedBy),
      targetUserId: userId,
      memberships: [{ serverId: channel.serverId, channelId, channelType: channel.type, joint }],
    });
  }
  return { channelDeleted: await deletePrivateChannelIfEmpty(channelId, db, lastMember) };
}

/**
 * An archived channel cuts its Guests off (cindyz 10-30): every request is
 * refused by the read rule, and this drops their live connections so they stop
 * receiving the channel at once. After the archive's commit.
 */
export async function revokeBoundGuestSockets(channelId: string): Promise<void> {
  // A joint channel archives on every server at once: each server's projection
  // may have Guests bound to it.
  const channelIds = new Set([channelId]);
  for (const projection of await getActiveJointChannelProjectionsByLocalChannel(channelId)) channelIds.add(projection.localChannelId);
  const guests = await getDb().select({ userId: serverMembers.userId }).from(serverMembers)
    .where(and(eq(serverMembers.role, "guest"), inArray(serverMembers.guestChannelId, [...channelIds])));
  for (const guest of guests) await revokeSocketAccess({ userId: guest.userId });
}

async function boundGuestIds(db: DatabaseExecutor, serverId: string, channelId: string): Promise<string[]> {
  return (await db.select({ userId: serverMembers.userId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.role, "guest"), eq(serverMembers.guestChannelId, channelId))))
    .map((row) => row.userId);
}

async function isGuestBoundToChannel(db: DatabaseExecutor, serverId: string, channelId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ userId: serverMembers.userId }).from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, userId),
      eq(serverMembers.role, "guest"),
      eq(serverMembers.guestChannelId, channelId),
    ))
    .limit(1);
  return Boolean(row);
}

/**
 * After a removeHuman commit: the socket revocation every removal owes, and,
 * when a Guest's server membership ended with it, the rest of that removal.
 * Callers that pass removeHuman their own transaction call this after commit.
 */
export async function finishChannelMemberRemoval(removal: ChannelMemberRemoval, userId: string): Promise<void> {
  if (removal.endedGuestMembership) {
    const { finishRemovedMember } = await import("./serverService");
    await finishRemovedMember(removal.endedGuestMembership.serverId, userId, removal.endedGuestMembership.effects);
    return;
  }
  await revokeSocketAccess({ userId });
}

/**
 * Get humans in a channel.
 */
async function getChannelHumansRaw(channelId: string, onlyIds?: readonly string[]) {
  return (await getChannelHumansRawForChannels([channelId], { onlyIds })).map(({ channelId: _channelId, ...human }) => human);
}

/** getChannelHumansRaw for several channels in one query; rows carry their channelId. */
async function getChannelHumansRawForChannels(channelIds: readonly string[], options: { name?: string; id?: string; onlyIds?: readonly string[] } = {}) {
  if (channelIds.length === 0 || options.onlyIds?.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({
      channelId: channelHumans.channelId,
      id: users.id,
      serverId: channels.serverId,
      serverName: servers.name,
      serverSlug: servers.slug,
      name: users.name,
      displayName: users.displayName,
      description: users.description,
      avatarUrl: users.avatarUrl,
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
    .where(and(
      inArray(channelHumans.channelId, [...channelIds]),
      options.name === undefined ? undefined : eq(users.name, options.name),
      options.id === undefined ? undefined : eq(users.id, options.id),
      options.onlyIds === undefined ? undefined : inArray(users.id, [...options.onlyIds]),
    ))
    .orderBy(asc(channelHumans.joinedAt));

  return rows.map((row) => ({ ...row, gravatarHash: DEPRECATED_GRAVATAR_HASH }));
}

/**
 * The one definition of who is in a server's `#all` audience.
 *
 * Guest visibility is a separate read-only policy: a Guest may be allowed to
 * *read* a channel, but that never grants roster or delivery membership in
 * `#all`. Every query that resolves the `#all` audience must use this condition
 * rather than restating it — the Guest delivery defect this replaces existed
 * because a second copy of the predicate in `messageService` silently lost the
 * role filter, and the copies were held together only by a comment.
 */
export function serverAudienceMemberCondition(serverId: string) {
  return and(eq(serverMembers.serverId, serverId), ne(serverMembers.role, "guest"));
}

/**
 * The non-Guest human audience of a server. This is the effective human
 * membership of an enabled virtual `#all` channel. Guest visibility is a
 * separate read-only policy and never grants roster or delivery membership.
 */
async function getServerAudienceHumans(serverId: string, options: { name?: string; onlyIds?: readonly string[] } = {}) {
  if (options.onlyIds?.length === 0) return [];
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
      role: serverMembers.role,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .innerJoin(users, eq(serverMembers.userId, users.id))
    .where(and(
      serverAudienceMemberCondition(serverId),
      options.name === undefined ? undefined : eq(users.name, options.name),
      options.onlyIds === undefined ? undefined : inArray(users.id, [...options.onlyIds]),
    ))
    .orderBy(asc(serverMembers.joinedAt));

  return rows.map((row) => ({ ...row, gravatarHash: DEPRECATED_GRAVATAR_HASH }));
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
  if (channel?.type === "joint") {
    return (await getJointHumanDeliveryRows([channelId])).map(({ channelId: _channelId, ...human }) => human);
  }
  return getChannelHumansRaw(channelId);
}

async function getVirtualAllChannelMembers(serverId: string, only?: ChannelMemberFilter) {
  const [agentList, humanList] = await Promise.all([
    getServerAudienceAgents(serverId, { onlyIds: only?.agentIds }),
    getServerAudienceHumans(serverId, { onlyIds: only?.userIds }),
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
  return db.transaction(async tx => {
    const rows = await tx.select({
      id: externalActorProjections.id,
      provider: externalActorProjections.provider,
      displayName: externalActorProjections.displayName,
      handles: externalActorProjections.handles,
      actorKind: externalActorProjections.actorKind,
      externalActorId: externalActorProjections.externalActorId,
      appRegistrationId: externalActorProjections.appRegistrationId,
      installId: externalActorProjections.installId,
      workspaceId: externalActorProjections.workspaceId,
      connectionEpoch: externalAddressabilityProjections.connectionEpoch,
      bindingId: externalAddressabilityProjections.bindingId,
      bindingEpoch: externalAddressabilityProjections.bindingEpoch,
      conversationId: externalAddressabilityProjections.conversationId,
      memberRevision: externalAddressabilityProjections.memberRevision,
      contextRevision: externalAddressabilityProjections.contextRevision,
      avatarUrl: externalProjectionAvatarArtifacts.publicUrl,
      // workspaceName only — the members endpoint intentionally does not
      // expose provider-side ids (installId/appRegistrationId/workspaceId/
      // externalActorId). The external-identity panel reads provider,
      // actorKind, displayName, avatarUrl, workspaceName.
      workspaceName: externalAppInstalls.workspaceName,
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
      .leftJoin(
        externalAppInstalls,
        sql`${externalAppInstalls.id}::text = ${externalActorProjections.installId}`,
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

    const remoteIds = [...new Set(rows.filter(row => row.actorKind === "remote").map(row => row.externalActorId))];
    const botRows = remoteIds.length ? await tx.select({ id: externalActorProjections.id,
      installId: externalActorProjections.installId, workspaceId: externalActorProjections.workspaceId,
      appRegistrationId: externalActorProjections.appRegistrationId, userId: externalActorProjections.slackBotUserId })
      .from(externalActorProjections).where(and(eq(externalActorProjections.provider, "slack"),
        eq(externalActorProjections.actorKind, "bot"), inArray(externalActorProjections.slackBotUserId, remoteIds),
        inArray(externalActorProjections.installId, [...new Set(rows.map(row => row.installId))]))) : [];
    const unique = new Map<string, ChannelExternalMember>();
    for (const row of rows) {
      if (row.provider !== "slack" || unique.has(row.id)) continue;
      const possible = row.actorKind === "remote" ? botRows.filter(bot => bot.userId === row.externalActorId
        && bot.installId === row.installId && bot.workspaceId === row.workspaceId && bot.appRegistrationId === row.appRegistrationId) : [];
      const mapping = possible.length === 1 ? await readSlackBotMentionAuthority({ executor: tx, botProjectionId: possible[0]!.id, now,
        context: { provider: row.provider, appRegistrationId: row.appRegistrationId, installId: row.installId,
          workspaceId: row.workspaceId, connectionEpoch: row.connectionEpoch, bindingId: row.bindingId, bindingEpoch: row.bindingEpoch,
          conversationId: row.conversationId, memberRevision: row.memberRevision, contextRevision: row.contextRevision } }) : null;
      let botAvatar: string | null = null;
      if (mapping?.bot.avatarArtifactId) {
        const [avatar] = await tx.select().from(externalProjectionAvatarArtifacts).where(and(
          eq(externalProjectionAvatarArtifacts.id, mapping.bot.avatarArtifactId), eq(externalProjectionAvatarArtifacts.ownerType, "external_projection"),
          eq(externalProjectionAvatarArtifacts.ownerId, mapping.bot.id), eq(externalProjectionAvatarArtifacts.state, "active"))).limit(1);
        botAvatar = avatar?.publicUrl ?? null;
      }
      const id = mapping?.bot.id ?? row.id;
      unique.set(id, { id, provider: row.provider, displayName: mapping?.bot.displayName ?? row.displayName,
        handles: row.handles, actorKind: mapping ? "bot" : row.actorKind, mentionable: Boolean(mapping) || row.actorKind === "human",
        avatarUrl: mapping ? botAvatar : row.avatarUrl, workspaceName: row.workspaceName });
    }
    return [...unique.values()];
  });
}

export interface ChannelMembers {
  /** `inViewerServer` as on humans: joint rosters only (the agent's own server is the viewed one). */
  agents: Array<Awaited<ReturnType<typeof getServerAudienceAgents>>[number] & { inViewerServer?: boolean }>;
  /** `servers` is set on joint rosters only (see ChannelMemberServer): the
   * person's current sources minus the viewed server. `inViewerServer`
   * (joint rosters only) says whether the
   * person belongs to the viewed server, any role, for member-list grouping. */
  humans: Array<Awaited<ReturnType<typeof getServerAudienceHumans>>[number] & { servers?: ChannelMemberServer[]; isManager?: boolean; inViewerServer?: boolean }>;
}

/**
 * Members = join/post authority (see thread contract in schema.ts).
 * Regular channels: read channel_humans + channel_agents directly.
 * Thread channels:  delegate to the parent channel/DM's members.
 * For "who gets notified" read thread_follows instead.
 * For enabled #all channels, derive members from the server audience.
 * `only` reads just those members (see ChannelMemberFilter), each the row the
 * whole roster holds for them.
 */
export async function getChannelMembers(channelId: string, only?: ChannelMemberFilter): Promise<ChannelMembers> {
  const channel = await getChannel(channelId);

  // Threads delegate join/membership to their parent channel (or DM).
  // Followers of a thread live in thread_follows (attention, not membership).
  // Task conversations (task v2) likewise: the parent channel's members.
  if (channel?.type === "task") {
    return channel.parentChannelId ? getChannelMembers(channel.parentChannelId, only) : { agents: [], humans: [] };
  }
  if (channel?.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    if (jointThread) {
      return getChannelMembers(jointThread.localParentChannelId, only);
    }
  }

  if (channel?.type === "thread" && channel.parentMessageId) {
    const db2 = getDb();
    const [parentMsg] = await db2
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return { agents: [], humans: [] };
    return getChannelMembers(parentMsg.channelId, only);
  }

  if (channel && isEnabledAllChannel(channel)) {
    return getVirtualAllChannelMembers(channel.serverId, only);
  }

  if (channel?.type === "joint") {
    const db = getDb();
    const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [channelId] }, db)).get(channelId);
    if (scope) {
      if (!(await filterJointActiveEntries([scope], db)).has(channelId)) return { agents: [], humans: [] };
      const projections = await getActiveJointChannelProjectionsByLocalChannel(channelId, db);
      const rawAgents = await getChannelAgentsRawForChannels(projections.map(row => row.localChannelId), { onlyIds: only?.agentIds });
      const denied = await db.execute<{ id: string }>(sql`SELECT jmr.agent_id id FROM joint_membership_removals jmr
        JOIN joint_membership_departures jmd ON jmd.id=jmr.departure_id
        WHERE jmd.completed_at IS NULL AND jmd.joint_channel_id=${scope.jointId}::uuid AND jmr.remove_membership AND jmr.agent_id IS NOT NULL`);
      const deniedIds = new Set(denied.rows.map(row => row.id));
      return { humans: await getComputedJointHumanPublicRows(scope, only?.userIds, db),
        agents: [...new Map(rawAgents.filter(row => !deniedIds.has(row.id))
          .map(({ channelId: _channelId, ...row }) => [row.id, { ...row, inViewerServer: row.serverId === channel.serverId }])).values()] };
    }
  }

  const agentList = await getChannelAgentsRaw(channelId, only?.agentIds);
  const humanList = await getChannelHumansRaw(channelId, only?.userIds);

  return { agents: agentList, humans: humanList };
}

/** A member on a page of a roster (getChannelMemberPager); `role` is a person's in the channel's server, an agent's null. */
export interface ChannelMemberPageRow {
  id: string;
  serverId: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: string | null;
}

/**
 * A page of a roster: members whose handle or display name matches the ILIKE
 * `pattern`, after `after` by (handle, id), at most `limit`.
 */
export interface ChannelMemberPageQuery {
  pattern: string;
  after: { name: string; id: string } | null;
  limit: number;
}

/** A roster read a page at a time: its people (not retired) and its agents, each by handle then id. */
export interface ChannelMemberPager {
  people(page: ChannelMemberPageQuery): Promise<ChannelMemberPageRow[]>;
  agents(page: ChannelMemberPageQuery): Promise<ChannelMemberPageRow[]>;
}

/**
 * getChannelMembers' roster of a channel, private channel or DM (its
 * channel_humans and channel_agents rows; an enabled `#all`, the server
 * audience) a page at a time in the database rather than whole, for a picker
 * that offers the first few of a large one (platform/mentions). The same
 * conditions as getChannelMembers' reads: people who are members of the
 * channel's server (`#all`: serverAudienceMemberCondition), live agents that
 * pass activeAppBotOrOrdinaryAgent (`#all`: listedServerAgent); and people who
 * are not retired. Null for
 * a roster getChannelMembers assembles from others (a joint channel's from
 * every server's projection; a thread's or task's from its parent) and for no
 * live channel: read those whole.
 */
export async function getChannelMemberPager(channelId: string): Promise<ChannelMemberPager | null> {
  const channel = await getChannel(channelId);
  if (!channel || !(channel.type === "channel" || channel.type === "private" || channel.type === "dm")) return null;
  const serverAudience = isEnabledAllChannel(channel);
  const db = getDb();
  const afterKey = (name: SQLWrapper, id: SQLWrapper, after: ChannelMemberPageQuery["after"]) =>
    after ? sql`(${name}, ${id}) > (${after.name}, ${after.id}::uuid)` : undefined;
  return {
    async people({ pattern, after, limit }) {
      const columns = { id: users.id, serverId: serverMembers.serverId, name: users.name, displayName: users.displayName, avatarUrl: users.avatarUrl, role: serverMembers.role };
      const matching = and(
        isNull(users.retiredAt),
        sql`(${users.name} ILIKE ${pattern} OR ${users.displayName} ILIKE ${pattern})`,
        afterKey(users.name, users.id, after),
      );
      return serverAudience
        ? db.select(columns).from(serverMembers)
          .innerJoin(users, eq(users.id, serverMembers.userId))
          .where(and(serverAudienceMemberCondition(channel.serverId), matching))
          .orderBy(asc(users.name), asc(users.id)).limit(limit)
        : db.select(columns).from(channelHumans)
          .innerJoin(users, eq(users.id, channelHumans.userId))
          .innerJoin(serverMembers, and(eq(serverMembers.serverId, channel.serverId), eq(serverMembers.userId, channelHumans.userId)))
          .where(and(eq(channelHumans.channelId, channel.id), matching))
          .orderBy(asc(users.name), asc(users.id)).limit(limit);
    },
    async agents({ pattern, after, limit }) {
      const columns = { id: agents.id, serverId: agents.serverId, name: agents.name, displayName: agents.displayName, avatarUrl: agents.avatarUrl };
      const matching = and(
        isNull(agents.deletedAt),
        serverAudience ? listedServerAgent() : activeAppBotOrOrdinaryAgent(),
        sql`(${agents.name} ILIKE ${pattern} OR ${agents.displayName} ILIKE ${pattern})`,
        afterKey(agents.name, agents.id, after),
      );
      const rows = serverAudience
        ? await db.select(columns).from(agents)
          .where(and(eq(agents.serverId, channel.serverId), matching))
          .orderBy(asc(agents.name), asc(agents.id)).limit(limit)
        : await db.select(columns).from(channelAgents)
          .innerJoin(agents, eq(agents.id, channelAgents.agentId))
          .where(and(eq(channelAgents.channelId, channel.id), matching))
          .orderBy(asc(agents.name), asc(agents.id)).limit(limit);
      return rows.map((row) => ({ ...row, role: null }));
    },
  };
}

/**
 * A server a channel member participates through (RFC 075 phase 1). Only joint
 * channel rosters carry `servers` on their human rows; elsewhere a member's
 * one server is the row's `serverId`/`serverName`/`serverSlug`.
 */
export interface ChannelMemberServer {
  id: string;
  name: string;
  slug: string;
}

/** Source labels visible from this entry omit the entry itself. Other server
 * identities never fill a missing source; an empty list has no badges. */
export function agentVisibleMemberServers(
  member: { servers?: readonly ChannelMemberServer[] },
  viewerServerId: string,
): Array<{ name: string; slug: string; yours?: true }> | undefined {
  const servers = member.servers;
  if (!servers || servers.length === 0) return undefined;
  const visible = servers.filter(server => server.id !== viewerServerId);
  if (!visible.length) return undefined;
  return visible.map(server => ({ name: server.name, slug: server.slug }));
}

/** The viewed server first (when present), then the rest by name, then id. */
export function orderChannelMemberServers(
  servers: readonly ChannelMemberServer[],
  viewedServerId: string,
): ChannelMemberServer[] {
  return [...servers].sort((a, b) => {
    if (a.id === viewedServerId) return b.id === viewedServerId ? 0 : -1;
    if (b.id === viewedServerId) return 1;
    return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

/**
 * Ids of the agents and humans whose membership row is on this exact channel.
 * For a joint projection that is this server's side only, unlike
 * getChannelMembers, which merges every server's projection.
 */
export async function getLocalChannelMemberIds(channelId: string) {
  const db = getDb();
  const scope=(await resolveJointHumanMembershipScopes({localChannelIds:[channelId]},db)).get(channelId);
  if(scope) {
    const [humans,agents]=await Promise.all([getJointHumanDeliveryRows([channelId],db),getChannelAgents(channelId)]);
    return {userIds:new Set(humans.map(row=>row.id)),agentIds:new Set(agents.map(row=>row.id))};
  }
  const [agentRows, humanRows] = await Promise.all([
    db.select({ id: channelAgents.agentId }).from(channelAgents).where(eq(channelAgents.channelId, channelId)),
    db.select({ id: channelHumans.userId }).from(channelHumans).where(eq(channelHumans.channelId, channelId)),
  ]);
  return {
    agentIds: new Set(agentRows.map((row) => row.id)),
    userIds: new Set(humanRows.map((row) => row.id)),
  };
}

/** Only manager selection, never a membership or visibility predicate. */
export async function getJointHumanManagerCandidateIds(channelId:string,userIds:readonly string[]) {
  const db=getDb(),scope=(await resolveJointHumanMembershipScopes({localChannelIds:[channelId]},db)).get(channelId);
  if(!scope) return null;
  if(!userIds.length || scope.entryServerId!==scope.hostServerId) return new Set<string>();
  const rows=await db.execute<{id:string}>(sql`SELECT sm.user_id id FROM server_members sm
    WHERE sm.server_id=${scope.hostServerId}::uuid AND sm.role='member'
      AND sm.user_id IN (${sql.join(userIds.map(id=>sql`${id}::uuid`),sql`, `)})`);
  return new Set(rows.rows.map(row=>row.id));
}

export interface ChannelRosterNameMatches {
  agents: Array<{ id: string; name: string; channelRole?: ChannelMembershipRole }>;
  humans: Array<{ id: string; name: string; serverSlug: string | null; role: string | null; channelRole?: ChannelMembershipRole }>;
}

type ChannelMembershipRole = (typeof channelAgents.$inferSelect)["role"];

/**
 * A `GET /users/:name/channels` membership row: the channel's own facts and
 * the subject's membership of it, nothing of the caller's. A
 * `listChannelsForAgent` row also carries the caller's membership (`joined`,
 * `channelRole`, `channelAuthorityRevision`), the caller's authority
 * (`channelAdminBasis`, `channelCapabilities`), and the caller's attention
 * state (`activityMuted`, `muteFromSeq`, `prefsVersion`,
 * `activityMuteSupported`); none of them is copied. `joined` is the
 * subject's: a membership row is a channel whose roster lists them.
 * `channelRole` is the subject's stored role, present only where channel roles
 * exist (a public or private channel other than `#all`).
 */
export function userChannelMembershipRow<Id extends string>(
  channel: Omit<typeof channels.$inferSelect, "id" | "taskId" | "taskNumberHighWater" | "announcementArtifactId"> & { id: Id; lastPostAt?: string | null },
  channelRole: ChannelMembershipRole | undefined,
) {
  return {
    id: channel.id,
    serverId: channel.serverId,
    name: channel.name,
    description: channel.description,
    type: channel.type,
    // No `visitorVisible`: `listChannelsForAgent` rows carry the column as
    // `guestVisible` only, and this row's shape stays theirs (user-info parity).
    guestVisible: channel.guestVisible,
    parentMessageId: channel.parentMessageId,
    parentChannelId: channel.parentChannelId,
    createdAt: channel.createdAt,
    archivedAt: channel.archivedAt,
    archivedByUserId: channel.archivedByUserId,
    archivedByAgentId: channel.archivedByAgentId,
    deletedAt: channel.deletedAt,
    // A channel setting, not the caller's: `listChannelsForAgent` rows carry it
    // as a column, so this row does too (user-info parity).
    threadSort: channel.threadSort,
    joined: true,
    // `listChannelsForAgent` carries `lastPostAt` once its one-time backfill
    // has run (null = no posts yet; absent before that). Forward it verbatim so
    // this route's row shape stays identical to the agent channel list's
    // (user-info parity).
    ...("lastPostAt" in channel ? { lastPostAt: channel.lastPostAt ?? null } : {}),
    ...(channelRole ? { channelRole } : {}),
  };
}

/**
 * Roster rows of `subject` for each channel of a `listChannelsForAgent` window,
 * as the agent's roster route (`GET /channel-members?channel=#<name>`) would
 * list them: `resolveChannelByName(serverId, agentId, "#<name>")`, then
 * `getChannelMembers`. `null` where that reference does not resolve (the
 * roster route's 404).
 *
 * A non-joint roster is matched by name (`subject.name`, of `subject.kind`; the
 * other list is empty), the predicate the caller would apply to the full
 * roster, so only matching rows are read. A joint roster spans every server's
 * projection, where a same-named agent of another server is someone else, so
 * it is matched by identity instead: the rows of the agent or user
 * `subject.id` (see getJointChannelRosterRowsForSubject). User names are
 * unique, so for humans the two agree.
 *
 * Public and private channels are batched: one `channel_agents` or
 * `channel_humans` query for the whole window, one caller-membership query for
 * the private ones, and one audience query when an enabled `#all` is in the
 * window. Their resolution is the row itself: names are unique per server among
 * live listable channels, archived included. Everything else (joint channels,
 * whose roster spans server projections; a name that does not read back as a
 * plain `#name` reference) is resolved through the roster route's own
 * per-channel path; the joint rosters it resolves are then read together.
 *
 * Built-in app conversations (type `dm`, named by app id, the caller's own)
 * are not rosters anyone is a member of in this sense: they are inspected and
 * list no one (their `#<appId>` reference would resolve a regular channel of
 * that name, if one exists, or nothing).
 *
 * A matched row carries the subject's `channelRole` only where channel roles
 * exist: a public or private channel other than `#all`, read from that
 * channel's own membership row (not a joint projection, not the `#all`
 * audience).
 */
export async function getChannelRosterNameMatchesForAgentWindow(
  serverId: string,
  agentId: string,
  window: ReadonlyArray<Pick<typeof channels.$inferSelect, "id" | "name" | "type">>,
  subject: { kind: "agent" | "human"; name: string; id: string },
): Promise<Array<ChannelRosterNameMatches | null>> {
  // `withChannelRole`: the rows are the channel's own `channel_agents` /
  // `channel_humans` rows and the channel supports channel roles.
  const matches = (rows: readonly ChannelRosterRow[], withChannelRole = false): ChannelRosterNameMatches => {
    const named = rows.filter((row) => row.name === subject.name);
    const roleOf = (row: ChannelRosterRow) => (withChannelRole && row.channelRole ? { channelRole: row.channelRole } : {});
    return subject.kind === "agent"
      ? { agents: named.map((row) => ({ id: row.id, name: row.name, ...roleOf(row) })), humans: [] }
      : { agents: [], humans: named.map((row) => ({ id: row.id, name: row.name, serverSlug: row.serverSlug, role: row.role ?? null, ...roleOf(row) })) };
  };
  // The roster route's query schema trims the reference before resolving it.
  const refFor = (name: string) => `#${name}`.trim();
  const batched = window.filter((channel) => (
    (channel.type === "channel" || channel.type === "private")
    && refFor(channel.name) === `#${channel.name}`
    && parseChannelRef(`#${channel.name}`).threadShortId === null
  ));
  const batchedIds = new Set(batched.map((channel) => channel.id));
  // A hidden #all (private "all") never resolves; an enabled one is the server audience.
  const hiddenAll = batched.filter((channel) => isAllSystemChannel(channel) && !isEnabledAllChannel(channel));
  const enabledAll = batched.filter((channel) => isEnabledAllChannel(channel));
  const explicit = batched.filter((channel) => !isAllSystemChannel(channel));
  const privateIds = explicit.filter((channel) => requiresExplicitMembership(channel.type)).map((channel) => channel.id);
  const explicitIds = explicit.map((channel) => channel.id);

  const db = getDb();
  const [callerPrivateRows, explicitRows, audienceRows] = await Promise.all([
    privateIds.length === 0
      ? []
      : db.select({ channelId: channelAgents.channelId })
        .from(channelAgents)
        .where(and(inArray(channelAgents.channelId, privateIds), eq(channelAgents.agentId, agentId))),
    subject.kind === "agent"
      ? getChannelAgentsRawForChannels(explicitIds, { name: subject.name })
      : getChannelHumansRawForChannels(explicitIds, { name: subject.name }),
    enabledAll.length === 0
      ? []
      : subject.kind === "agent"
        ? getServerAudienceAgents(serverId, { name: subject.name })
        : getServerAudienceHumans(serverId, { name: subject.name }),
  ]);
  const callerPrivate = new Set(callerPrivateRows.map((row) => row.channelId));
  const rowsByChannel = new Map<string, ChannelRosterRow[]>();
  for (const { channelId, ...row } of explicitRows) {
    rowsByChannel.set(channelId, [...(rowsByChannel.get(channelId) ?? []), row]);
  }

  const result: Array<ChannelRosterNameMatches | null> = [];
  // Window index -> resolved joint channel, read together after the loop.
  const jointSlots = new Map<number, string>();
  for (const channel of window) {
    if (batchedIds.has(channel.id)) {
      if (hiddenAll.includes(channel)) result.push(null);
      else if (enabledAll.includes(channel)) result.push(matches(audienceRows));
      else if (requiresExplicitMembership(channel.type) && !callerPrivate.has(channel.id)) result.push(null);
      else result.push(matches(rowsByChannel.get(channel.id) ?? [], true));
      continue;
    }
    if (channel.type === "dm") {
      result.push(matches([]));
      continue;
    }
    const resolved = await resolveChannelByName(serverId, agentId, refFor(channel.name));
    if (!resolved) {
      result.push(null);
      continue;
    }
    if (resolved.type === "joint") {
      jointSlots.set(result.length, resolved.channelId);
      result.push(null);
      continue;
    }
    const members = await getChannelMembers(resolved.channelId);
    const ownRoleRows = resolved.channelId === channel.id
      && (channel.type === "channel" || channel.type === "private")
      && !isAllSystemChannel(channel);
    result.push(matches(subject.kind === "agent" ? members.agents.map((agent) => ({ ...agent, serverSlug: agent.serverSlug ?? null })) : members.humans, ownRoleRows));
  }
  if (jointSlots.size > 0) {
    const subjectRows = await getJointChannelRosterRowsForSubject([...new Set(jointSlots.values())], subject);
    for (const [index, channelId] of jointSlots) {
      const row = subjectRows.get(channelId);
      result[index] = matches(row ? [row] : []);
    }
  }
  return result;
}

type ChannelRosterRow = { id: string; name: string; serverSlug: string | null; role?: string | null; channelRole?: ChannelMembershipRole | null };

/**
 * `subject`'s row, if any, in the roster `getChannelMembers` returns for each
 * of these joint channel projections, read by identity (agent or user id) in
 * two queries for any number of channels.
 *
 * A person's row is their J membership (getComputedJointHumanPublicRowsForScopes);
 * an agent's is its channel_agents row on any active, live projection of the
 * joint. A channel with no joint projection reads its own rows, as
 * getChannelMembers does.
 */
async function getJointChannelRosterRowsForSubject(
  channelIds: readonly string[],
  subject: { kind: "agent" | "human"; id: string },
): Promise<Map<string, ChannelRosterRow>> {
  const db = getDb();
  const scopes = await resolveJointHumanMembershipScopes({localChannelIds:channelIds},db);
  const result = new Map<string,ChannelRosterRow>();
  const jointScopes=[...scopes.values()];
  if(subject.kind==="human") {
    for(const {localChannelId,human} of await getComputedJointHumanPublicRowsForScopes(jointScopes,[subject.id],db)) result.set(localChannelId,human);
  } else if(jointScopes.length) {
    const rows=await db.execute<{localChannelId:string;id:string;name:string;serverSlug:string}>(sql`
      SELECT v.local_channel_id AS "localChannelId",a.id,a.name,s.slug AS "serverSlug"
      FROM joint_channel_servers v JOIN joint_channels j ON j.id=v.joint_channel_id AND j.status='active'
      JOIN channels vc ON vc.id=v.local_channel_id AND vc.deleted_at IS NULL
      JOIN joint_channel_servers peer ON peer.joint_channel_id=v.joint_channel_id AND peer.status='active'
      JOIN channels pc ON pc.id=peer.local_channel_id AND pc.deleted_at IS NULL
      JOIN channel_agents ca ON ca.channel_id=peer.local_channel_id AND ca.agent_id=${subject.id}::uuid
      JOIN agents a ON a.id=ca.agent_id AND a.server_id=peer.server_id AND a.deleted_at IS NULL
      JOIN servers s ON s.id=a.server_id AND s.deleted_at IS NULL
      WHERE v.local_channel_id IN (${sql.join(jointScopes.map(scope=>sql`${scope.localChannelId}::uuid`),sql`, `)})
        AND v.status='active' AND NOT (${jointMembershipRemovalPendingSql(sql`v.joint_channel_id`,"agent",sql`a.id`)})`);
    for(const {localChannelId,...row} of rows.rows) result.set(localChannelId,row);
  }
  const unscoped = channelIds.filter((id) => !scopes.has(id));
  if (!unscoped.length) return result;
  const rows: Array<ChannelRosterRow & { channelId: string }> = subject.kind === "agent"
    ? await getChannelAgentsRawForChannels(unscoped, { id: subject.id })
    : await getChannelHumansRawForChannels(unscoped, { id: subject.id });
  for (const { channelId: rowChannelId, ...row } of rows) result.set(rowChannelId, row);
  return result;
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
 * The local thread projection that holds an Agent's follower row: the thread
 * itself, or in a Joint Thread the projection on the Agent's own server (a
 * follow is recorded against the follower's server's projection). Null when
 * that server has no active projection of the thread.
 */
export async function getManagedFollowerThreadChannelIdForServer(
  threadChannelId: string,
  agentServerId: string,
): Promise<string | null> {
  const threadChannelIds = await getManagedThreadFollowerAudienceThreadChannelIds(threadChannelId);
  if (threadChannelIds.length === 0) return null;
  const [projection] = await getDb()
    .select({ id: channels.id })
    .from(channels)
    .where(and(inArray(channels.id, threadChannelIds), eq(channels.serverId, agentServerId)))
    .limit(1);
  return projection?.id ?? null;
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
      // Task v2: a task conversation's followers are managed as a thread's.
      inArray(channels.type, ["thread", "task"]),
      isNull(channels.deletedAt),
    ))
    .innerJoin(servers, eq(servers.id, channels.serverId))
    .where(and(
      inArray(threadFollows.threadChannelId, threadChannelIds),
      eq(threadFollows.followerType, "agent"),
      isNull(threadFollows.unfollowedAt),
      isNull(agents.deletedAt),
      activeAppBotOrOrdinaryAgent(),
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

/** What the follower receipt names: a thread, or (task v2) a task conversation. */
export type ManagedFollowerConversationKind = "thread" | "task";

function formatThreadFollowerRemovalText(input: {
  actorLabel: string;
  threadLabel: string;
  conversationKind?: ManagedFollowerConversationKind;
}): string {
  const noun = input.conversationKind === "task" ? "task" : "thread";
  return [
    `actor: ${input.actorLabel}`,
    `${noun}: ${input.threadLabel}`,
    `Ordinary ${noun} updates stopped. Personal mentions and task assignments can still notify you. You can follow the ${noun} again.`,
  ].join("\n");
}

function formatThreadFollowerRestoreText(input: {
  actorLabel: string;
  threadLabel: string;
  conversationKind?: ManagedFollowerConversationKind;
}): string {
  const noun = input.conversationKind === "task" ? "task" : "thread";
  return [
    `actor: ${input.actorLabel}`,
    `${noun}: ${input.threadLabel}`,
    `${noun === "task" ? "Task" : "Thread"} updates resumed because your follower entry was restored.`,
  ].join("\n");
}

/**
 * Task v2: a task conversation's Agent followers are managed as a thread's.
 * The task's creator stands where a thread's parent-message author does (a
 * channel manager may always manage). Every live task-conversation row — a
 * joint projection included — carries its task (channels_task_id_matches_type;
 * only a deleted task's soft-deleted conversation has none), and
 * the receipt names the task by its ref as seen from that row's parent
 * channel (`#channel:#7`; a DM task: `Task #7`). Null fails closed.
 */
export async function resolveTaskConversationFollowerManagement(
  conversation: { taskId: string | null; parentChannelId: string | null },
  executor: DatabaseExecutor = getDb(),
): Promise<{ taskId: string; createdByType: "user" | "agent"; createdById: string; label: string } | null> {
  if (!conversation.taskId) return null;
  const [task] = await executor
    .select({ id: tasks.id, taskNumber: tasks.taskNumber, createdByType: tasks.createdByType, createdById: tasks.createdById })
    .from(tasks)
    .where(eq(tasks.id, conversation.taskId))
    .limit(1);
  if (!task) return null;
  const [parent] = conversation.parentChannelId
    ? await executor
      .select({ name: channels.name, type: channels.type })
      .from(channels)
      .where(eq(channels.id, conversation.parentChannelId))
      .limit(1)
    : [];
  const label = parent && parent.type !== "dm"
    ? formatRaftChannelTaskRef(parent.name, task.taskNumber)
    : `Task #${task.taskNumber}`;
  return { taskId: task.id, createdByType: task.createdByType, createdById: task.createdById, label };
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
  conversationKind?: ManagedFollowerConversationKind;
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
    const title = input.conversationKind === "task" ? "Removed from task followers" : "Removed from thread followers";
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
  conversationKind?: ManagedFollowerConversationKind;
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
    const title = input.conversationKind === "task" ? "Restored to task followers" : "Restored to thread followers";
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
  const [row] = await executor
    .select({ type: channels.type, userId: channelHumans.userId })
    .from(channels)
    .leftJoin(channelHumans, and(eq(channelHumans.channelId, channels.id), eq(channelHumans.userId, userId)))
    .where(eq(channels.id, channelId));
  if (row?.type === "joint") {
    const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [channelId] }, executor)).get(channelId);
    if (scope && (!(await filterJointActiveEntries([scope], executor)).has(channelId)
      || (await filterJointPendingRemovalEntries([scope], "user", userId, executor)).has(channelId))) return false;
    if (scope) {
      return (await filterJointHumanMemberEntries([scope], userId, executor)).has(channelId);
    }
  }
  return row?.userId != null;
}

/**
 * `lockMembership`: the rows a posting verdict rests on are read FOR SHARE in
 * the ambient transaction, by the same statement that decides. A removal
 * committed first is then seen, and a later one waits for the caller's
 * commit. Locking in a separate statement first is not enough: a row added
 * after that lock is visible to the decision but not locked (RFC 082 §4.6,
 * the card edit's attempt admission; peng, #12710).
 */
export type AgentPostingAuthorityOptions = { lockMembership?: boolean };

/**
 * Check if an agent is in a channel (in channelAgents).
 */
export async function isChannelAgent(
  channelId: string,
  agentId: string,
  executor: DatabaseExecutor = getDb(),
  options: AgentPostingAuthorityOptions = {},
): Promise<boolean> {
  const db = executor;
  const read = db
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, agentId)));
  const [row] = options.lockMembership ? await read.for("share") : await read;
  if (!row) return false;
  const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [channelId] }, db)).get(channelId);
  return !scope || (await filterJointActiveEntries([scope], db)).has(channelId)
    && !(await filterJointPendingRemovalEntries([scope], "agent", agentId, db)).has(channelId);
}

async function isServerHumanMember(serverId: string, userId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  return !!row;
}

async function isServerAgent(serverId: string, agentId: string, options: AgentPostingAuthorityOptions = {}): Promise<boolean> {
  const db = getDb();
  const read = db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), eq(agents.id, agentId), isNull(agents.deletedAt)));
  const [row] = options.lockMembership ? await read.for("share") : await read;
  return !!row;
}

/**
 * Check if an agent can access (view) a channel.
 * Only a live (not deleted) agent of the channel's own server can view.
 * Public channels: all server agents can view.
 * Private, joint channels, and DMs: only participating agents can view.
 */
export async function canAgentAccessChannel(channelId: string, agentId: string): Promise<boolean> {
  return (await filterAgentsWithChannelAccess(channelId, [agentId])).has(agentId);
}

/**
 * canAgentAccessChannel for several agents on one channel, in a fixed number
 * of queries: message delivery checks every recipient, and one check per agent
 * under Promise.all borrowed a pool connection each.
 *
 * Pinned to the channel's server: an agent of another server, or a deleted
 * one, never has access, even to a public channel. (Callers used to pin it
 * themselves; filterAgentAccessibleChannelIds is the batched form over many
 * channels with the same rules.)
 */
export async function filterAgentsWithChannelAccess(channelId: string, agentIds: readonly string[]): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const db = getDb();
  const channel = await getChannel(channelId);
  if (!channel) return new Set();
  const ids = (await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      inArray(agents.id, [...new Set(agentIds)]),
      eq(agents.serverId, channel.serverId),
      isNull(agents.deletedAt),
    )))
    .map((row) => row.id);
  if (ids.length === 0) return new Set();

  if (isAllSystemChannel(channel) && !isEnabledAllChannel(channel)) return new Set();

  if (channel.type === "channel") return new Set(ids);

  if (channel.type === "joint") {
    const resolvedJoint = await resolveChannelAccess({ serverId: channel.serverId, channelId });
    if (!resolvedJoint || resolvedJoint.kind !== "joint") return new Set();
    const memberships = await db
      .selectDistinct({ agentId: channelAgents.agentId })
      .from(jointChannelServers)
      .innerJoin(channelAgents, eq(channelAgents.channelId, jointChannelServers.localChannelId))
      .where(and(
        eq(jointChannelServers.jointChannelId, resolvedJoint.jointChannelId),
        eq(jointChannelServers.serverId, channel.serverId),
        eq(jointChannelServers.status, "active"),
        inArray(channelAgents.agentId, ids),
        sql`NOT (${jointMembershipRemovalPendingSql(sql`${jointChannelServers.jointChannelId}`, "agent", sql`${channelAgents.agentId}`)})`,
      ));
    return new Set(memberships.map((row) => row.agentId));
  }

  if (channel.type === "task") {
    return channel.parentChannelId ? filterAgentsWithChannelAccess(channel.parentChannelId, ids) : new Set();
  }

  if (isSubConversationType(channel.type)) {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    if (jointThread) {
      return filterAgentsWithChannelAccess(jointThread.localParentChannelId, ids);
    }
  }

  if (channel.type === "thread" && channel.parentMessageId) {
    const [parentMsg] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return new Set();
    return filterAgentsWithChannelAccess(parentMsg.channelId, ids);
  }

  const members = await db
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, channelId), inArray(channelAgents.agentId, ids)));
  return new Set(members.map((row) => row.agentId));
}

/**
 * canUserAccessChannel for several humans on one channel of `serverId`. For
 * non-guests on a top-level conversation (channel, private, dm, joint) it
 * runs a fixed number of queries; guests (whose reads also depend on their own
 * guest gate) and any other channel type go through canUserAccessChannel
 * itself, one human at a time, so the single check stays the source of truth
 * for them. Like canUserAccessChannel it does not check that a non-guest is a
 * member of the server; callers that need standing check it first.
 */
export async function filterUsersWithChannelAccess(channelId: string, userIds: readonly string[], serverId: ServerId): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Set();
  const db = getDb();
  const channel = await getChannel(channelId);
  if (!channel || channel.serverId !== serverId) return new Set();
  const roles = new Map((await db
    .select({ userId: serverMembers.userId, role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.userId, ids))))
    .map((row) => [row.userId, row.role]));
  const batchable = channel.type === "channel" || channel.type === "private" || channel.type === "dm" || channel.type === "joint";
  const single = ids.filter((id) => !batchable || roles.get(id) === "guest");
  const others = ids.filter((id) => !single.includes(id));
  const accessible = new Set<string>();
  for (const id of single) {
    if (await canUserAccessChannel(channelId, id, serverId)) accessible.add(id);
  }
  if (others.length === 0 || (isAllSystemChannel(channel) && !isEnabledAllChannel(channel))) return accessible;

  if (channel.type === "channel") {
    for (const id of others) accessible.add(id);
  } else if (channel.type === "joint") {
    const resolvedJoint = await resolveChannelAccess({ serverId, channelId });
    if (resolvedJoint?.kind === "joint") {
      const rows = await db
        .selectDistinct({ userId: channelHumans.userId })
        .from(jointChannelServers)
        .innerJoin(channelHumans, eq(channelHumans.channelId, jointChannelServers.localChannelId))
        .where(and(
          eq(jointChannelServers.jointChannelId, resolvedJoint.jointChannelId),
          eq(jointChannelServers.serverId, serverId),
          eq(jointChannelServers.status, "active"),
          inArray(channelHumans.userId, others),
        ));
      for (const row of rows) accessible.add(row.userId);
    }
  } else {
    // private and dm: an explicit membership row (a DM's human participants).
    const rows = await db
      .select({ userId: channelHumans.userId })
      .from(channelHumans)
      .where(and(eq(channelHumans.channelId, channelId), inArray(channelHumans.userId, others)));
    for (const row of rows) accessible.add(row.userId);
  }
  return accessible;
}

/**
 * Batched `canAgentAccessChannel` over many candidate channels of ONE server:
 * returns the subset of `channelIds` the agent may view, with a constant
 * number of queries independent of `channelIds.length`.
 *
 * Same rules as filterAgentsWithChannelAccess, plus the server pin: the agent
 * must belong to `serverId` and not be deleted, and every channel must live
 * in `serverId` (a thread's parent too). The #all system rule; public
 * channels; private/dm by the agent's membership row; joint by the agent's
 * membership of an active projection of that joint in this server; a thread
 * through its parent (a joint thread's local parent projection, otherwise its
 * parent message's channel), and a thread with neither through its own row.
 */
export async function filterAgentAccessibleChannelIds(
  channelIds: readonly string[],
  agentId: string,
  serverId: ServerId,
  opts?: { executor?: DatabaseExecutor },
): Promise<Set<string>> {
  const db = opts?.executor ?? getDb();
  if (channelIds.length === 0) return new Set();
  if (!await isLiveAgentOfServer(agentId, serverId, db)) return new Set();
  return filterServerAgentAccessibleChannelIds(channelIds, agentId, serverId, db);
}

/** The agent server pin: a live (not deleted) agent of `serverId`. One query. */
export async function isLiveAgentOfServer(agentId: string, serverId: ServerId, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  const [agent] = await executor
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.serverId, serverId), isNull(agents.deletedAt)))
    .limit(1);
  return Boolean(agent);
}

/** filterAgentAccessibleChannelIds once the agent is known to be a live agent of `serverId`. */
async function filterServerAgentAccessibleChannelIds(
  channelIds: readonly string[],
  agentId: string,
  serverId: ServerId,
  db: DatabaseExecutor,
): Promise<Set<string>> {
  const accessible = new Set<string>();
  // Same row filter as getChannel (not deleted) plus the cross-server guard.
  const candidates = (await db
    .select()
    .from(channels)
    .where(and(inArray(channels.id, [...new Set(channelIds)]), isNull(channels.deletedAt))))
    .filter((channel) => channel.serverId === serverId)
    .filter((channel) => !(isAllSystemChannel(channel) && !isEnabledAllChannel(channel)));
  if (candidates.length === 0) return accessible;

  const jointIds = candidates.filter((channel) => channel.type === "joint").map((channel) => channel.id);
  const threads = candidates.filter((channel) => channel.type === "thread");
  // Joint: an active projection of the channel on this server under an active
  // joint (the resolveChannelAccess condition) AND the agent is a member of
  // some active local projection of that joint on this server.
  if (jointIds.length > 0) {
    const memberProjection = alias(jointChannelServers, "agent_member_projection");
    const rows = await db
      .selectDistinct({ localChannelId: jointChannelServers.localChannelId })
      .from(jointChannelServers)
      .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
      .innerJoin(memberProjection, and(
        eq(memberProjection.jointChannelId, jointChannelServers.jointChannelId),
        eq(memberProjection.serverId, serverId),
        eq(memberProjection.status, "active"),
      ))
      .innerJoin(channelAgents, and(
        eq(channelAgents.channelId, memberProjection.localChannelId),
        eq(channelAgents.agentId, agentId),
      ))
      .where(and(
        inArray(jointChannelServers.localChannelId, jointIds),
        eq(jointChannelServers.serverId, serverId),
        eq(jointChannelServers.status, "active"),
        eq(jointChannels.status, "active"),
        sql`NOT (${jointMembershipRemovalPendingSql(jointChannelServers.jointChannelId, "agent", sql`${agentId}::uuid`)})`,
      ));
    for (const row of rows) accessible.add(row.localChannelId);
  }

  // Threads: a joint thread through its local parent projection, otherwise
  // through its parent message's channel; neither => its own membership row.
  const parentByThread = new Map<string, string>();
  const unresolvedThreads = new Set<string>();
  // Task conversations (task v2): through the channel the task is in
  // (channels.parent_channel_id, the local parent on every face), as the
  // single check filterAgentsWithChannelAccess does; a sub-conversation has
  // no membership rows of its own, so without a parent it is not visible.
  for (const channel of candidates) {
    if (channel.type !== "task") continue;
    if (channel.parentChannelId) parentByThread.set(channel.id, channel.parentChannelId);
    else unresolvedThreads.add(channel.id);
  }
  if (threads.length > 0) {
    for (const projection of await listActiveJointThreadProjectionRows({ localThreadChannelIds: threads.map((thread) => thread.id), serverId }, db)) {
      if (!parentByThread.has(projection.localThreadChannelId)) parentByThread.set(projection.localThreadChannelId, projection.localParentChannelId);
    }
    const parentMessageIds = threads
      .filter((thread) => !parentByThread.has(thread.id) && thread.parentMessageId)
      .map((thread) => thread.parentMessageId!);
    const parentChannelByMessage = new Map<string, string>();
    if (parentMessageIds.length > 0) {
      const rows = await db
        .select({ id: messages.id, channelId: messages.channelId })
        .from(messages)
        .where(inArray(messages.id, [...new Set(parentMessageIds)]));
      for (const row of rows) parentChannelByMessage.set(row.id, row.channelId);
    }
    for (const thread of threads) {
      if (parentByThread.has(thread.id)) continue;
      if (thread.parentMessageId) {
        const parent = parentChannelByMessage.get(thread.parentMessageId);
        if (parent) parentByThread.set(thread.id, parent);
        else unresolvedThreads.add(thread.id);
      }
    }
  }

  const membershipIds = candidates
    .filter((channel) => channel.type !== "channel" && channel.type !== "joint")
    .filter((channel) => !parentByThread.has(channel.id) && !unresolvedThreads.has(channel.id))
    .map((channel) => channel.id);
  if (membershipIds.length > 0) {
    const rows = await db
      .select({ channelId: channelAgents.channelId })
      .from(channelAgents)
      .where(and(eq(channelAgents.agentId, agentId), inArray(channelAgents.channelId, membershipIds)));
    for (const row of rows) accessible.add(row.channelId);
  }
  for (const channel of candidates) if (channel.type === "channel") accessible.add(channel.id);

  const parentIds = [...new Set(parentByThread.values())];
  if (parentIds.length > 0) {
    const accessibleParents = await filterServerAgentAccessibleChannelIds(parentIds, agentId, serverId, db);
    for (const [threadId, parentId] of parentByThread) if (accessibleParents.has(parentId)) accessible.add(threadId);
  }
  return accessible;
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
/**
 * Names in this server held by BOTH a human member and a (non-deleted) agent.
 * For those names a bare `dm:@name` is ambiguous, so agent-facing DM targets
 * carry the peer's kind (`dm:@name~agent`, see dmPeerRef.ts); every other name
 * keeps the bare form it always had.
 */
export async function findCrossKindTwinPeerNames(serverId: string, names: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(names)].filter((name) => name.length > 0);
  const twins = new Set<string>();
  if (unique.length === 0) return twins;
  const db = getDb();
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = await db
      .selectDistinct({ name: users.name })
      .from(users)
      .innerJoin(serverMembers, and(eq(serverMembers.userId, users.id), eq(serverMembers.serverId, serverId)))
      .innerJoin(agents, and(eq(agents.name, users.name), eq(agents.serverId, serverId), isNull(agents.deletedAt)))
      .where(inArray(users.name, chunk));
    for (const row of rows) if (row.name) twins.add(row.name);
  }
  return twins;
}

async function agentFacingDmRef(serverId: string, peerName: string, peerKind: DmPeerKind): Promise<string> {
  const twins = await findCrossKindTwinPeerNames(serverId, [peerName]);
  return `dm:@${formatDmPeerRef(peerName, twins.has(peerName) ? peerKind : null)}`;
}

/**
 * The other side of a DM as `userId` sees it (RFC 077: an assistant reading
 * its owner's DMs names them from the owner's side): `alice`, `scout`, or with
 * a `~human` / `~agent` suffix when a human and an agent share the name. The
 * user themself for their own notes DM. Null when `userId` is not part of it.
 */
export async function resolveUserFacingDmPeerRef(serverId: string, userId: string, channelId: string): Promise<string | null> {
  return (await resolveUserFacingDmPeer(serverId, userId, channelId))?.ref ?? null;
}

/** The other side of a DM from `userId`'s side: who it is and how to name it (`ref`, without `dm:@`). */
export async function resolveUserFacingDmPeer(
  serverId: string,
  userId: string,
  channelId: string,
): Promise<{ id: string; type: DmPeerKind; ref: string } | null> {
  const db = getDb();
  const [identity] = await db
    .select({ kind: dmChannelIdentities.kind, peerKey: dmChannelIdentities.peerKey })
    .from(dmChannelIdentities)
    .where(and(eq(dmChannelIdentities.channelId, channelId), eq(dmChannelIdentities.serverId, serverId)))
    .limit(1);
  const peerFor = async (id: string, name: string | null | undefined, type: DmPeerKind) =>
    name ? { id, type, ref: (await agentFacingDmRef(serverId, name, type)).slice("dm:@".length) } : null;
  const userName = async (id: string) => (await db.select({ name: users.name }).from(users).where(eq(users.id, id)).limit(1))[0]?.name;
  const agentName = async (id: string) => (await db.select({ name: agents.name }).from(agents).where(and(eq(agents.id, id), eq(agents.serverId, serverId))).limit(1))[0]?.name;
  if (identity) {
    const participants = identity.peerKey.split(":");
    if (!participants.includes(userId)) return null;
    if (identity.kind === "human_self") return peerFor(userId, await userName(userId), "human");
    const peerId = participants.find((id) => id !== userId);
    if (!peerId) return null;
    if (identity.kind === "human_human") return peerFor(peerId, await userName(peerId), "human");
    if (identity.kind === "human_agent") return peerFor(peerId, await agentName(peerId), "agent");
    return null;
  }
  // Legacy DMs without an identity row: the other member.
  const [humanPeer] = await db
    .select({ id: users.id, name: users.name })
    .from(channelHumans)
    .innerJoin(users, eq(channelHumans.userId, users.id))
    .where(and(eq(channelHumans.channelId, channelId), sql`${channelHumans.userId} <> ${userId}`))
    .limit(1);
  if (humanPeer?.name) return peerFor(humanPeer.id, humanPeer.name, "human");
  const [agentPeer] = await db
    .select({ id: agents.id, name: agents.name })
    .from(channelAgents)
    .innerJoin(agents, eq(channelAgents.agentId, agents.id))
    .where(eq(channelAgents.channelId, channelId))
    .limit(1);
  return agentPeer ? peerFor(agentPeer.id, agentPeer.name, "agent") : null;
}

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
  if (isSubConversationType(channel.type)) return null;
  if (channel.type !== "dm") return `#${channel.name}`;
  // The agent's own private reminder conversation (no peer, no identity row).
  if (await getAgentPrivateSurfaceKind(agentId, channelId) === "reminders") return `dm:@${AGENT_REMINDERS_DM_PEER}`;
  // A migration receipt DM (no peer either): named by the channel, for its own agent.
  if (channel.name.startsWith(MIGRATION_RECEIPT_CHANNEL_PREFIX)
    && await findAgentMigrationReceiptChannelId(getDb(), serverId, agentId, channel.name) === channelId) {
    return `dm:@${channel.name}`;
  }

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
      return peer?.name ? agentFacingDmRef(serverId, peer.name, "human") : null;
    }
    if (peerId && identity.kind === "agent_agent") {
      const [peer] = await db.select({ name: agents.name }).from(agents).where(and(
        eq(agents.id, peerId),
        eq(agents.serverId, serverId),
      )).limit(1);
      return peer?.name ? agentFacingDmRef(serverId, peer.name, "agent") : null;
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
  if (humanPeer?.name) return agentFacingDmRef(serverId, humanPeer.name, "human");

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
  if (agentPeer?.name) return agentFacingDmRef(serverId, agentPeer.name, "agent");

  // Built-in app conversations intentionally have one agent member and no DM
  // identity row. Their registry app id is the documented dm:@ target.
  return isAppId(channel.name) ? `dm:@${channel.name}` : null;
}

/**
 * The other participant of a DM, for `agentId`, from the DM's identity row:
 * their kind, id, handle and profile description. Null for the agent's own
 * reminders DM, app DMs, DMs the agent is not part of, deleted agents, and
 * legacy DMs without an identity row (no card for those, never a hold).
 */
export async function getDmPeerForAgent(
  serverId: string,
  agentId: string,
  dmChannelId: string,
): Promise<{ kind: "human" | "agent"; id: string; name: string; description: string | null } | null> {
  const db = getDb();
  const [identity] = await db
    .select({ kind: dmChannelIdentities.kind, peerKey: dmChannelIdentities.peerKey })
    .from(dmChannelIdentities)
    .where(and(
      eq(dmChannelIdentities.channelId, dmChannelId),
      eq(dmChannelIdentities.serverId, serverId),
    ))
    .limit(1);
  if (!identity) return null;
  const participants = identity.peerKey.split(":");
  if (!participants.includes(agentId)) return null;
  const peerId = participants.find((id) => id !== agentId);
  if (!peerId) return null;
  if (identity.kind === "human_agent") {
    const [peer] = await db.select({ name: users.name, description: users.description }).from(users).where(eq(users.id, peerId)).limit(1);
    return peer?.name ? { kind: "human", id: peerId, name: peer.name, description: peer.description || null } : null;
  }
  if (identity.kind === "agent_agent") {
    const [peer] = await db.select({ name: agents.name, description: agents.description }).from(agents).where(and(
      eq(agents.id, peerId),
      eq(agents.serverId, serverId),
      isNull(agents.deletedAt),
    )).limit(1);
    return peer?.name ? { kind: "agent", id: peerId, name: peer.name, description: peer.description || null } : null;
  }
  return null;
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
    .select({ id: channels.id, name: channels.name, type: channels.type })
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
  return resolveAgentFacingTaskChannelRefs(serverId, agentId, candidates);
}

/**
 * Of these local channels, the ones where the agent can change a task now: not
 * archived, and it is a member (or it is the enabled #all), which is what the
 * task write routes ask of `canAgentPostToChannel` + `isChannelArchived`, in
 * one query. For the idle task reminder, which must not chase a task whose
 * every exit would be refused. A joint's removal in progress is not looked at:
 * the channel still counts until the removal lands.
 */
export async function listAgentTaskWritableChannelIds(agentId: string, channelIds: readonly string[]): Promise<Set<string>> {
  if (channelIds.length === 0) return new Set();
  const rows = await getDb()
    .select({ id: channels.id, name: channels.name, type: channels.type, memberAgentId: channelAgents.agentId })
    .from(channels)
    .leftJoin(channelAgents, and(
      eq(channelAgents.channelId, channels.id),
      eq(channelAgents.agentId, agentId),
    ))
    .where(and(
      inArray(channels.id, [...channelIds]),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
    ));
  return new Set(rows
    .filter((row) => row.memberAgentId !== null || isEnabledAllChannel(row))
    .map((row) => row.id));
}

/**
 * resolveAgentFacingChannelRef for the task-list candidates (this server, not
 * deleted, top-level types; private/joint/dm only with the agent's own
 * channel_agents row) in a fixed number of queries instead of several per
 * channel: one agent in hundreds of channels borrowed 172 pool connections for
 * one task list (prod 2026-10-06). Same rules: canAgentAccessChannel (the #all
 * system rule; public channels; joint through resolveChannelAccessMany and the
 * agent's membership of an active projection of that joint in this server;
 * private/dm by the membership row the candidates already carry), `#name` for
 * non-DMs, and DMs through resolveAgentFacingDmRefs.
 */
async function resolveAgentFacingTaskChannelRefs(
  serverId: string,
  agentId: string,
  candidates: ReadonlyArray<ChannelSystemFields & { id: string }>,
): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  const visible = candidates.filter((channel) => !(isAllSystemChannel(channel) && !isEnabledAllChannel(channel)));

  const jointIds = visible.filter((channel) => channel.type === "joint").map((channel) => channel.id);
  const jointAccess = jointIds.length === 0 ? new Map<string, ChannelAccessResolution>() : await resolveChannelAccessMany({ serverId, channelIds: jointIds });
  const accessibleJointIds = new Set<string>();
  const jointChannelIdByLocal = new Map<string, string>();
  for (const [localId, access] of jointAccess) {
    if (access.kind === "joint") jointChannelIdByLocal.set(localId, access.jointChannelId);
  }
  if (jointChannelIdByLocal.size > 0) {
    const memberJoints = await getDb()
      .selectDistinct({ jointChannelId: jointChannelServers.jointChannelId })
      .from(jointChannelServers)
      .innerJoin(channelAgents, eq(channelAgents.channelId, jointChannelServers.localChannelId))
      .where(and(
        inArray(jointChannelServers.jointChannelId, [...new Set(jointChannelIdByLocal.values())]),
        eq(jointChannelServers.serverId, serverId),
        eq(jointChannelServers.status, "active"),
        eq(channelAgents.agentId, agentId),
      ));
    const memberJointIds = new Set(memberJoints.map((row) => row.jointChannelId));
    for (const [localId, jointChannelId] of jointChannelIdByLocal) {
      if (memberJointIds.has(jointChannelId)) accessibleJointIds.add(localId);
    }
  }

  const dmIds: string[] = [];
  for (const channel of visible) {
    if (channel.type === "dm") { dmIds.push(channel.id); continue; }
    if (channel.type === "joint" && !accessibleJointIds.has(channel.id)) continue;
    refs.set(channel.id, `#${channel.name}`);
  }
  if (dmIds.length > 0) {
    for (const [channelId, ref] of await resolveAgentFacingDmRefs(serverId, agentId, dmIds)) refs.set(channelId, ref);
  }
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

  // Task conversation (task v2): delivered like a thread — to active
  // followers (or a personal mention) who can access the parent channel.
  if (channel.type === "task") {
    const parentAccess = channel.parentChannelId ? await canAgentAccessChannel(channel.parentChannelId, agentId) : false;
    if (!parentAccess) return false;
    return opts.personalMention ? true : isAgentActivelyFollowingThread(channelId, agentId);
  }

  if (channel.type !== "thread") {
    return canAgentAccessChannel(channelId, agentId);
  }
  // canAgentAccessChannel pins the server; the thread checks below need it too.
  if (!await isServerAgent(channel.serverId, agentId)) return false;

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
  if (serverRole === null) return false;
  if (serverRole === "guest") {
    if (channel.type === "task") {
      return channel.parentChannelId ? canUserPostToChannel(channel.parentChannelId, userId) : false;
    }
    if (isSubConversationType(channel.type)) {
      const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
      if (jointThread) return canUserPostToChannel(jointThread.localParentChannelId, userId);
      if (!channel.parentMessageId) return false;
      const [parentMsg] = await getDb()
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, channel.parentMessageId));
      return parentMsg ? canUserPostToChannel(parentMsg.channelId, userId) : false;
    }
    const guestChannelId = await getGuestChannelId(channel.serverId, userId);
    const jointEntry = channel.type === "joint"
      ? (await filterGuestJointEntries(channel.serverId, userId, guestChannelId, [channel])).has(channel.id)
      : false;
    return canGuestPostToChannel({
      serverRole,
      channelId: channel.id,
      guestChannelId,
      channelType: channel.type,
      isChannelMember: channel.type === "joint" ? jointEntry : await isChannelHuman(channelId, userId),
      jointEntry,
      archived: channel.archivedAt !== null,
      deleted: channel.deletedAt !== null,
    });
  }

  if (isAllSystemChannel(channel) && !isEnabledAllChannel(channel)) return false;
  if (isEnabledAllChannel(channel)) return isServerHumanMember(channel.serverId, userId);

  // Task conversation (task v2): post authority = parent channel membership,
  // exactly like a thread; following never grants it.
  if (channel.type === "task") {
    return channel.parentChannelId ? canUserPostToChannel(channel.parentChannelId, userId) : false;
  }

  if (isSubConversationType(channel.type)) {
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

  // Agent Lounge: any non-guest human of the Server may post (Guests returned
  // above); the first post joins them (ensureLoungeHumanMember).
  if (channel.type === "channel" && await isAgentLoungeChannel(channelId)) {
    return isServerHumanMember(channel.serverId, userId);
  }

  return isChannelHuman(channelId, userId);
}

/**
 * Post authority for an agent (see thread contract in schema.ts).
 * Threads recurse to parent channel/DM membership; being in thread_follows
 * never grants post permission.
 */
/** Thrown (as an Error message) wherever an assistant would join a channel. */
export const ASSISTANT_CHANNEL_FORBIDDEN_MESSAGE = "A personal assistant can only be in its DM with its owner";
export const ASSISTANT_CHANNEL_FORBIDDEN_CODE = "assistant_channel_forbidden";

/**
 * RFC 074 §2: an assistant (agents.assistant_owner_user_id set) posts only in
 * its DM with its owner, or a thread under that DM. Null when the agent is not
 * an assistant (the ordinary rules apply).
 */
export async function assistantMayPostTo(channelId: string, agentId: string, options: AgentPostingAuthorityOptions = {}): Promise<boolean | null> {
  const db = getDb();
  const [agent] = await db
    .select({ ownerUserId: agents.assistantOwnerUserId })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent?.ownerUserId) return null;
  const channel = await getChannel(channelId);
  if (!channel) return false;
  let dmChannelId = channelId;
  if (isSubConversationType(channel.type)) {
    if (!channel.parentChannelId) return false;
    dmChannelId = channel.parentChannelId;
    const parent = await getChannel(dmChannelId);
    if (parent?.type !== "dm") return false;
  } else if (channel.type !== "dm") {
    return false;
  }
  const ownerRead = db
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, dmChannelId), eq(channelHumans.userId, agent.ownerUserId)))
    .limit(1);
  const [ownerRow] = options.lockMembership ? await ownerRead.for("share") : await ownerRead;
  if (!ownerRow) return false;
  return isChannelAgent(dmChannelId, agentId, db, options);
}

export async function canAgentPostToChannel(channelId: string, agentId: string, options: AgentPostingAuthorityOptions = {}): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (!channel) return false;
  // Only a live agent of the channel's own server posts there (a thread's
  // parent is re-checked by the recursion below).
  if (!await isServerAgent(channel.serverId, agentId, options)) return false;
  // Before the #all shortcut below: that one lets any server agent post there.
  const assistantVerdict = await assistantMayPostTo(channelId, agentId, options);
  if (assistantVerdict !== null) return assistantVerdict;

  if (isAllSystemChannel(channel) && !isEnabledAllChannel(channel)) return false;
  if (isEnabledAllChannel(channel)) return isServerAgent(channel.serverId, agentId, options);
  // Private agent surfaces (dm:@reminders) are written by the server only.
  if (channel.type === "dm" && await isAgentPrivateSurfaceChannel(channelId)) return false;

  if (channel.type === "task") {
    return channel.parentChannelId ? canAgentPostToChannel(channel.parentChannelId, agentId, options) : false;
  }

  if (isSubConversationType(channel.type)) {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    if (jointThread) {
      return canAgentPostToChannel(jointThread.localParentChannelId, agentId, options);
    }
  }

  if (channel.type === "thread" && channel.parentMessageId) {
    const db = getDb();
    const [parentMsg] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return false;
    return canAgentPostToChannel(parentMsg.channelId, agentId, options);
  }

  return isChannelAgent(channelId, agentId, getDb(), options);
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
      // The thread is located by its short id; still refuse a malformed peer
      // kind rather than silently ignoring it.
      const rawPeer = baseRef.slice(4);
      const parsedPeer = parseDmPeerRef(rawPeer);
      if (!parsedPeer.ok && parsedPeer.reason === "unknown_peer_kind") {
        throw DmTargetResolutionError.invalidPeerKind(rawPeer, parsedPeer.suffix);
      }
      const thread = await resolveThreadByShortId(serverId, agentId, threadShortId);
      // An explicit kind is a claim about which DM the thread lives in: a
      // thread under the agent Twin's DM is not `dm:@Twin~human:<id>`.
      if (thread && parsedPeer.ok && parsedPeer.peerKind) {
        const namedDm = await resolveDMByPeerName(serverId, agentId, rawPeer);
        if (!namedDm || await getThreadParentChannelId(thread.channelId) !== namedDm.channelId) return null;
      }
      return thread;
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

/**
 * Resolve a thread channel by an 8-hex suffix.
 *
 * The suffix is tried in order:
 *   1. as a parent-message short id (`thread-<shortId>` channel name) — the
 *      form `replyTarget` prints and the only form older docs described;
 *   2. as a thread-channel id short form — the `threadId=` header field is the
 *      first 8 chars of the thread channel's UUID, and agents habitually paste
 *      it into the same `#channel:<id>` slot. Before this fallback that always
 *      answered "Message or thread not found" for a thread that plainly exists.
 *
 * Both lookups are server-scoped (a `#channel:<id>` suffix never claimed to be
 * scoped to the named channel — thread resolution has always been server-wide)
 * and the same `canAgentAccessChannel` gate runs after each, so the fallback
 * grants nothing the message-id path did not. An id matching a message in one
 * place and a thread UUID in another resolves to the message first; a prefix
 * matching more than one thread resolves to nothing (same neutral answer as a
 * miss — UUID-prefix collisions are vanishingly rare and none of the callers
 * can distinguish the two cases anyway).
 */
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
  if (channel) {
    if (!await canAgentAccessChannel(channel.id, agentId)) return null;
    return { channelId: channel.id, type: "thread" };
  }

  // Fallback: the suffix may be the thread channel's own id short form
  // (`threadId=` in the message header), not its parent's message short id.
  const bounds = uuidShortIdRange(shortId);
  const candidates = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.serverId, serverId),
        eq(channels.type, "thread"),
        gte(channels.id, bounds.lower),
        ...(bounds.upper ? [lt(channels.id, bounds.upper)] : []),
        isNull(channels.deletedAt)
      )
    )
    .limit(2);
  if (candidates.length !== 1) return null;
  if (!await canAgentAccessChannel(candidates[0].id, agentId)) return null;
  return { channelId: candidates[0].id, type: "thread" };
}

async function getThreadParentChannelId(threadChannelId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ channelId: messages.channelId })
    .from(channels)
    .innerJoin(messages, eq(messages.id, channels.parentMessageId))
    .where(eq(channels.id, threadChannelId))
    .limit(1);
  return row?.channelId ?? null;
}

/**
 * Resolve a DM channel by peer name (for agents).
 * Searches for an existing DM between the agent and a user/agent with this name.
 */
/** Name prefix of the agent-only DM a migration receipt is posted to (agentMigrationService). */
export const MIGRATION_RECEIPT_CHANNEL_PREFIX = "migration-receipt-";

async function findAgentMigrationReceiptChannelId(
  db: ReturnType<typeof getDb>,
  serverId: string,
  agentId: string,
  channelName: string,
): Promise<string | null> {
  const [row] = await db.select({ channelId: agentMigrationReceiptChannels.channelId })
    .from(agentMigrationReceiptChannels)
    .innerJoin(channels, eq(channels.id, agentMigrationReceiptChannels.channelId))
    .where(and(
      eq(agentMigrationReceiptChannels.serverId, serverId),
      eq(agentMigrationReceiptChannels.agentId, agentId),
      eq(channels.name, channelName),
      isNull(channels.deletedAt),
    ))
    .limit(1);
  return row?.channelId ?? null;
}

/** Whether a channel is a migration receipt surface: one-way, the agent reads it but never replies there. */
export async function isAgentMigrationReceiptChannel(channelId: string): Promise<boolean> {
  const [row] = await getDb().select({ channelId: agentMigrationReceiptChannels.channelId })
    .from(agentMigrationReceiptChannels)
    .where(eq(agentMigrationReceiptChannels.channelId, channelId))
    .limit(1);
  return Boolean(row);
}

async function resolveDMByPeerName(
  serverId: string,
  agentId: string,
  rawPeer: string
): Promise<{ channelId: string; type: "dm" } | null> {
  const db = getDb();

  // `dm:@reminders` is the authenticated agent's own private reminder
  // conversation. The handle is reserved, so it takes precedence over (and
  // can never collide with) a human or agent peer named `reminders`.
  if (rawPeer.toLowerCase() === AGENT_REMINDERS_DM_PEER) {
    const channelId = await getAgentPrivateSurfaceChannelId(agentId, "reminders");
    return channelId ? { channelId, type: "dm" } : null;
  }

  // A migration receipt lives in a hidden DM whose only member is the agent,
  // so it has no peer and renders as `dm:@migration-receipt-<support ref>`
  // (the channel's name). It resolves for the agent it belongs to and for no
  // one else. For that agent the receipt wins over a peer with the same name;
  // for everyone else the lookup falls through to the peer rules below.
  if (rawPeer.startsWith(MIGRATION_RECEIPT_CHANNEL_PREFIX)) {
    const receiptChannelId = await findAgentMigrationReceiptChannelId(db, serverId, agentId, rawPeer);
    if (receiptChannelId) return { channelId: receiptChannelId, type: "dm" };
  }

  // Built-in app DMs are resolved for the authenticated owner only. The
  // owner is never accepted from the ref string: Agent A therefore cannot
  // resolve Agent B's derived conversation even though both refs render as
  // `dm:@<appId>`.
  if (isAppId(rawPeer)) {
    const appDm = await getBuiltInConversationChannel(serverId, rawPeer, agentId);
    if (appDm) return { channelId: appDm.id, type: "dm" };
  }

  // `dm:@name~agent` / `dm:@name~human` names the kind of peer explicitly.
  // An unknown suffix is refused, never read as a bare name.
  const parsed = parseDmPeerRef(rawPeer);
  if (!parsed.ok) {
    if (parsed.reason === "unknown_peer_kind") throw DmTargetResolutionError.invalidPeerKind(rawPeer, parsed.suffix);
    return null;
  }
  const { peerName, peerKind } = parsed;

  const humanDm = peerKind === "agent" ? null : await findHumanPeerDm(db, serverId, agentId, peerName);
  if (peerKind === "human") return humanDm;
  const agentDm = await findAgentPeerDm(db, serverId, agentId, peerName);
  if (peerKind === "agent") return agentDm;

  // A bare name held by BOTH a human member and a non-deleted agent in this
  // server is ambiguous REGARDLESS of whether the two DMs both exist yet. The
  // meaning of `dm:@name` must be stable over time: resolving it to the human's
  // DM today and turning into an error once the agent's DM appears would let
  // the same target silently change which conversation it names (a
  // send-to-the-wrong-person hazard). `findCrossKindTwinPeerNames` is the one
  // stability rule shared with the agent-facing label path.
  const twins = await findCrossKindTwinPeerNames(serverId, [peerName]);
  if (twins.has(peerName)) throw DmTargetResolutionError.ambiguous(peerName);
  return humanDm ?? agentDm;
}

async function findHumanPeerDm(
  db: ReturnType<typeof getDb>,
  serverId: string,
  agentId: string,
  peerName: string,
): Promise<{ channelId: string; type: "dm" } | null> {
  const userResults = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(serverMembers, eq(serverMembers.userId, users.id))
    .where(and(eq(serverMembers.serverId, serverId), eq(users.name, peerName)));

  for (const user of userResults) {
    const dm = await findHumanAgentDm(serverId, agentId, user.id);
    if (dm) return dm;
  }
  return null;
}

/**
 * The existing DM between `agentId` and the human `userId` in this server, if
 * any. The lookup `dm:@name` / `dm:@name~human` runs for each person with that
 * name; the App-Bot-only `dm:sub:<sub>` runs it for the person the App's
 * subject resolved to (agentWritableTarget).
 */
export async function findHumanAgentDm(
  serverId: string,
  agentId: string,
  userId: string,
): Promise<{ channelId: string; type: "dm" } | null> {
  const [dm] = await getDb()
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(channelAgents, eq(channels.id, channelAgents.channelId))
    .innerJoin(channelHumans, eq(channels.id, channelHumans.channelId))
    .where(
      and(
        eq(channels.serverId, serverId),
        eq(channels.type, "dm"),
        eq(channelAgents.agentId, agentId),
        eq(channelHumans.userId, userId),
        isNull(channels.deletedAt)
      )
    );
  return dm ? { channelId: dm.id, type: "dm" } : null;
}

async function findAgentPeerDm(
  db: ReturnType<typeof getDb>,
  serverId: string,
  agentId: string,
  peerName: string,
): Promise<{ channelId: string; type: "dm" } | null> {
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

/**
 * An agent of this server by its handle, as `finder` may find it: another
 * person's personal assistant resolves as not found (agentFindableBy), so a
 * handle never confirms that someone has one. `finder` is the human asking
 * (their own assistant resolves) or the agent asking (itself resolves); `{}`
 * finds no assistant at all.
 */
export async function resolveAgentByName(serverId: string, name: string, finder: AgentFinder): Promise<string | null> {
  const db = getDb();
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), eq(agents.name, name), isNull(agents.deletedAt), agentFindableBy(finder)));
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
    /** "task": a task v2 conversation under this channel (listed with `includeTaskConversations`). */
    type: "channel" | "thread" | "task";
    channelId: string;
    parentMessageId: string | null;
    parentMessageShortId: string | null;
    /** Task conversations only: the task the file was posted in. */
    taskId?: string;
    taskNumber?: number;
  };
};

export type ChannelFilesCursor = {
  createdAt: string;
  id: string;
};

type ListChannelFilesOptions = {
  historyCutoff?: Date | null;
  limit?: number;
  cursor?: ChannelFilesCursor | null;
  /**
   * Task v2: also list attachments posted in the task conversations of this
   * channel (canonical conversations, parent_channel_id = channelId). The
   * route sets it whatever the reader's flag (task v2 per-task mode).
   */
  includeTaskConversations?: boolean;
};

export async function listChannelFiles(
  channelId: string,
  opts: ListChannelFilesOptions = {},
): Promise<ChannelFileEntry[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 500));
  const rows = await queryChannelFileRows(channelId, opts, opts.cursor ?? null, limit);
  return rows.map(toChannelFileEntry);
}

/**
 * Whether the history window leaves any of the channel's files out of
 * listChannelFiles: one file posted before `historyCutoff`, in the same places
 * the list looks (the channel, its threads, and with `includeTaskConversations`
 * its task conversations).
 */
export async function hasChannelFilesBehindHistory(
  channelId: string,
  historyCutoff: Date,
  opts: Pick<ListChannelFilesOptions, "includeTaskConversations"> = {},
): Promise<boolean> {
  const rows = await queryChannelFileRows(channelId, { ...opts, behindHistoryCutoff: historyCutoff }, null, 1);
  return rows.length > 0;
}

async function queryChannelFileRows(
  channelId: string,
  opts: ListChannelFilesOptions & { behindHistoryCutoff?: Date },
  cursor: ChannelFilesCursor | null,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const db = getDb();
  const historyCutoff = opts.historyCutoff ?? null;
  // The files the window shows, or (behindHistoryCutoff) only those it hides.
  const historyFilter = opts.behindHistoryCutoff
    ? sql`AND m.created_at < ${opts.behindHistoryCutoff}`
    : historyCutoff ? sql`AND m.created_at >= ${historyCutoff}` : sql``;
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
          a.object_id,
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
          a.object_id,
          a.created_at,
          a.uploader_type,
          a.uploader_id,
          m.channel_id AS source_channel_id,
          'thread'::text AS source_type,
          source_channel.parent_message_id
        -- Threads under this channel by parent_channel_id
        -- (idx_channels_thread_parent_channel): the cost follows the thread
        -- count. Finding them through the channel's messages read every
        -- message of the channel, threads or not.
        FROM channels source_channel
        INNER JOIN attachments a
          ON a.channel_id = source_channel.id
         AND a.message_id IS NOT NULL
        INNER JOIN messages m
          ON m.id = a.message_id
         AND m.channel_id = source_channel.id
        WHERE source_channel.parent_channel_id = ${channelId}
          AND source_channel.type = 'thread'
          AND source_channel.deleted_at IS NULL
          ${historyFilter}
          ${cursorFilter}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limit}
      )
      ${opts.includeTaskConversations ? sql`
      UNION ALL
      (
        SELECT
          a.id,
          a.message_id,
          a.channel_id,
          a.filename,
          a.object_id,
          a.created_at,
          a.uploader_type,
          a.uploader_id,
          m.channel_id AS source_channel_id,
          'task'::text AS source_type,
          NULL::uuid AS parent_message_id
        -- Task v2 conversations under this channel by parent_channel_id
        -- (idx_channels_task_parent_channel), like the thread arm above.
        FROM channels source_channel
        INNER JOIN attachments a
          ON a.channel_id = source_channel.id
         AND a.message_id IS NOT NULL
        INNER JOIN messages m
          ON m.id = a.message_id
         AND m.channel_id = source_channel.id
        WHERE source_channel.parent_channel_id = ${channelId}
          AND source_channel.type = 'task'
          AND source_channel.deleted_at IS NULL
          ${historyFilter}
          ${cursorFilter}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limit}
      )` : sql``}
    )
    SELECT
      cf.id::text AS "id",
      cf.message_id::text AS "messageId",
      cf.channel_id::text AS "channelId",
      cf.filename AS "filename",
      o.id::text AS "objectId",
      o.mime_type AS "mimeType",
      o.size_bytes::int AS "sizeBytes",
      o.width::int AS "width",
      o.height::int AS "height",
      o.thumbnail_key AS "thumbnailKey",
      -- UTC ISO with all six fractional digits, whatever the session time
      -- zone: clients get one format, and the page cursor (compared exactly
      -- against created_at) keeps microseconds that toISOString() would drop.
      to_char(cf.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
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
      cf.parent_message_id::text AS "parentMessageId",
      source_task.id::text AS "sourceTaskId",
      source_task.task_number AS "sourceTaskNumber"
    FROM candidate_files cf
    -- Physical metadata comes from the object only, joined by primary key
    -- after each arm's LIMIT (object_id is NOT NULL and a foreign key, so the
    -- join always finds it).
    LEFT JOIN attachment_objects o
      ON o.id = cf.object_id
    LEFT JOIN channels source_conversation
      ON cf.source_type = 'task'
     AND source_conversation.id = cf.source_channel_id
    LEFT JOIN tasks source_task
      ON source_task.id = source_conversation.task_id
    -- The uploader as a uuid (NULL when the stored id is not one), so the
    -- joins below are primary-key probes. Comparing id::text instead hides
    -- the primary keys: on a channel with 500 files that compared every file
    -- with every agent and user (9.8 s on prod).
    CROSS JOIN LATERAL (
      SELECT ${sqlUuidOrNull(sql.raw("cf.uploader_id"))} AS id
    ) uploader
    LEFT JOIN users u
      ON cf.uploader_type = 'user'
     AND u.id = uploader.id
    LEFT JOIN agents ag
      ON cf.uploader_type = 'agent'
     AND ag.id = uploader.id
    LEFT JOIN external_actor_projections eap
      ON cf.uploader_type = 'external_projection'
     AND eap.id = uploader.id
    ORDER BY cf.created_at DESC, cf.id DESC
    LIMIT ${limit}
  `);
  return rows.rows as Array<Record<string, unknown>>;
}

function toChannelFileEntry(r: Record<string, unknown>): ChannelFileEntry {
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
      type: r.sourceType === "thread" ? "thread" : r.sourceType === "task" ? "task" : "channel",
      channelId: String(r.sourceChannelId),
      parentMessageId,
      parentMessageShortId: parentMessageId ? parentMessageId.slice(0, 8) : null,
      ...(r.sourceType === "task" && typeof r.sourceTaskId === "string"
        ? { taskId: r.sourceTaskId, taskNumber: Number(r.sourceTaskNumber) }
        : {}),
    },
  };
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
      AND c.parent_channel_id = ${channelId}
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
      AND c.parent_channel_id = ${channelId}
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

/**
 * Every thread channel under a parent channel, as the agent inbox keys them.
 * A joint channel's threads are local projections with no parent message
 * (task #24): they are found through the parent's projection, the canonical
 * parent's threads, and each thread's projection on the same server -- the
 * mapping loadLocalThreadParentChannelIds reads in the other direction. No
 * status filter: callers purge, and a stale projection's inbox rows must go
 * too.
 */
export async function listThreadChannelIdsForParentChannel(channelId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT c.id::text AS "threadChannelId"
    FROM channels c
    INNER JOIN messages pm ON pm.id = c.parent_message_id
    WHERE c.type = 'thread'
      AND c.deleted_at IS NULL
      AND c.parent_channel_id = ${channelId}
      AND pm.channel_id = ${channelId}
    UNION
    SELECT thread_projection.local_channel_id::text AS "threadChannelId"
    FROM joint_channel_servers parent_projection
    INNER JOIN joint_channels parent_joint ON parent_joint.id = parent_projection.joint_channel_id
    INNER JOIN channels canonical_thread
      ON canonical_thread.parent_channel_id = parent_joint.canonical_channel_id
     AND canonical_thread.type = 'thread'
     AND canonical_thread.deleted_at IS NULL
    INNER JOIN joint_channels thread_joint ON thread_joint.canonical_channel_id = canonical_thread.id
    INNER JOIN joint_channel_servers thread_projection
      ON thread_projection.joint_channel_id = thread_joint.id
     AND thread_projection.server_id = parent_projection.server_id
    INNER JOIN channels local_thread
      ON local_thread.id = thread_projection.local_channel_id
     AND local_thread.type = 'thread'
     AND local_thread.deleted_at IS NULL
    WHERE parent_projection.local_channel_id = ${channelId}
    UNION
    -- Task v2 conversations of this channel: the canonical conversation of an
    -- ordinary channel, or this server's projection under a local joint
    -- channel (both name the channel as parent_channel_id).
    SELECT task_conversation.id::text AS "threadChannelId"
    FROM channels task_conversation
    WHERE task_conversation.type = 'task'
      AND task_conversation.deleted_at IS NULL
      AND task_conversation.parent_channel_id = ${channelId}
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
      AND c.parent_channel_id = ${channelId}
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

  // Every thread's local projection in one read (first row per canonical
  // thread, in the same order the single lookup returns them).
  const firstProjection = new Map<string, JointThreadProjection>();
  for (const projection of await getActiveJointThreadProjectionsByCanonicalThreadsForServer(
    canonicalThreads.map((thread) => thread.threadChannelId),
    channel.serverId,
  )) {
    if (!firstProjection.has(projection.canonicalThreadChannelId)) firstProjection.set(projection.canonicalThreadChannelId, projection);
  }
  const projections = canonicalThreads.map((thread) => ({ thread, localProjection: firstProjection.get(thread.threadChannelId) ?? null }));

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
//
// getOrCreateThread calls this on every resolution, and the value is almost
// always already set. Skip the no-op: an UPDATE writes a new row version even
// when nothing changes, and when that version is not HOT it re-inserts the row
// into every messages index, including the full-text GIN pending list.
async function syncParentMessageThreadId(
  parentMessageId: string,
  threadChannelId: string,
  executor: DatabaseExecutor = getDb(),
) {
  await executor.update(messages)
    .set({ threadId: threadChannelId })
    .where(and(
      eq(messages.id, parentMessageId),
      sql`${messages.threadId} IS DISTINCT FROM ${threadChannelId}`,
    ));
}

/**
 * Every creator of a root's canonical thread queues on the root message row
 * before inserting the thread. Slack inbound locks the root FOR UPDATE and
 * then inserts the thread ON CONFLICT; if this path inserted first, its
 * uncommitted idx_channels_active_thread_parent entry made inbound wait on it
 * while its parent_message_id FK share (and the thread_id stamp) waited on
 * inbound's root lock: a 40P01 cycle. FOR NO KEY UPDATE is enough to queue
 * behind that FOR UPDATE and matches the thread_id stamp this transaction
 * writes anyway; it does not block readers' FOR KEY SHARE.
 */
async function lockThreadRootMessageForCreate(executor: DatabaseExecutor, parentMessageId: string) {
  await executor.select({ id: messages.id })
    .from(messages)
    .where(eq(messages.id, parentMessageId))
    .for("no key update");
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
    const [parentThread] = await db
      .select({
        serverId: channels.serverId,
        parentThreadId: sql<string | null>`(SELECT ${messages.threadId} FROM ${messages} WHERE ${messages.id} = ${parentMessageId})`,
      })
      .from(channels)
      .where(eq(channels.id, existing.threadChannelId))
      .limit(1);
    if (!parentThread) throw new Error("Canonical thread channel not found");
    // Usually already stamped. Still re-stamp when it is missing or when the
    // canonical thread among duplicates has changed.
    if (parentThread.parentThreadId !== existing.threadChannelId) {
      await syncParentMessageThreadId(parentMessageId, existing.threadChannelId);
    }
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

  // Create the thread channel and stamp the parent's thread_id in one
  // transaction. As two autocommit statements, a failed or timed-out stamp
  // left a committed thread whose parent carried no thread_id; search relies
  // on "a thread's parent always carries its thread_id".
  const threadName = `thread-${parentMessageId.slice(0, 8)}`;
  const threadChannel = await db.transaction(async (tx) => {
    await lockThreadRootMessageForCreate(tx, parentMessageId);
    const [inserted] = await tx.insert(channels).values({
      serverId: parentChannel.serverId,
      name: threadName,
      type: "thread",
      parentMessageId,
    }).onConflictDoNothing().returning();
    if (inserted) await syncParentMessageThreadId(parentMessageId, inserted.id, tx);
    return inserted;
  });

  if (threadChannel) {
    return { id: threadChannel.id, serverId: parentChannel.serverId, parentMessageId, created: true };
  }

  const canonical = await getCanonicalThreadForParentMessage(parentMessageId);
  if (!canonical) throw new Error("Thread creation conflicted but no canonical thread was found");
  await syncParentMessageThreadId(parentMessageId, canonical.threadChannelId);
  return { id: canonical.threadChannelId, serverId: parentChannel.serverId, parentMessageId, created: false };
}

/**
 * The joint record of a canonical thread, created if missing. Two first opens
 * at once both read "none" and both insert; canonical_channel_id is unique, so
 * the loser's insert does nothing and it takes the winner's record. (Before the
 * index both inserted, and their local threads hung off different records.)
 */
async function insertOrTakeJointThread(input: {
  canonicalChannelId: string;
  createdByServerId: string;
  createdByUserId: string | null;
}): Promise<string> {
  const db = getDb();
  const [inserted] = await db.insert(jointChannels).values({ ...input, status: "active" })
    .onConflictDoNothing({ target: jointChannels.canonicalChannelId })
    .returning({ id: jointChannels.id });
  if (inserted) return inserted.id;

  const [winner] = await db
    .select({ id: jointChannels.id })
    .from(jointChannels)
    .where(eq(jointChannels.canonicalChannelId, input.canonicalChannelId))
    .limit(1);
  if (!winner) throw new Error("Joint thread not found");
  return winner.id;
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

  const jointThreadId = existingJointThread?.id ?? await insertOrTakeJointThread({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: parentChannel.serverId,
    createdByUserId: creatorType === "user" ? creatorId : null,
  });

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
  updatedAt: string;
};

type ThreadSummaryResult = {
  threadChannelId: string;
  replyCount: number;
  lastReplyAt: string | null;
  participantIds: string[];
  unreadCount: number;
  firstUnreadMessageId: string | null;
  /** The requesting user follows this thread (done or not). False without a user. */
  followed: boolean;
  latestReplies: ThreadSummaryLatestReply[];
};

/** Thread-summary reads in flight at once for one call of getThreadSummaries. */
const THREAD_SUMMARY_QUERY_CONCURRENCY = 3;

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

  // The reads below come in two waves of independent queries (participants,
  // unread state and latest replies; then the reply senders' names), at most
  // THREAD_SUMMARY_QUERY_CONCURRENCY at once.
  const limit = createConcurrencyLimiter(THREAD_SUMMARY_QUERY_CONCURRENCY);
  // Batch-fetch unique participants (senders in each thread)
  const participantRowsPending = opts?.includeParticipants === false ? null : limit(() => traceQuery(
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
  ));
  const unreadRowsPending = !opts?.userId ? null : limit(() => traceQuery(
    "channel_threads.unread_by_threads",
    () => db.execute(sql`
      SELECT
        input_threads.thread_id::text AS "threadChannelId",
        first_unread.id::text AS "firstUnreadMessageId",
        COALESCE(unread.unread_count, 0)::int AS "unreadCount",
        -- Following, done or not (Done only stops the unread count). By the
        -- thread_follows primary key.
        EXISTS (
          SELECT 1 FROM thread_follows any_follow
          WHERE any_follow.thread_channel_id = input_threads.thread_id
            AND any_follow.follower_type = 'user'
            AND any_follow.follower_id = ${opts.userId}
            AND any_follow.unfollowed_at IS NULL
        ) AS "followed"
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
  ));
  // Latest conversation replies per thread — the "server sends the newest 3
  // upfront" leg of the inline reply previews design (task #47/#592). System
  // events remain part of replyCount and the full thread history, but the
  // compact preview is a human/agent conversation summary, not an audit log.
  const latestReplyRowsPending = limit(() => traceQuery(
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
        latest.created_at AS "createdAt",
        latest.updated_at AS "updatedAt"
      FROM (VALUES ${sql.join(threadStorageRows, sql`, `)}) AS input_threads(thread_id, storage_thread_id)
      JOIN LATERAL (
        SELECT m.id, m.seq, m.content, m.sender_id, m.sender_type, m.message_type, m.created_at, m.updated_at
        FROM messages m
        WHERE m.channel_id = input_threads.storage_thread_id
          AND m.message_type <> 'system'
          ${opts?.historyCutoff ? sql`AND m.created_at > ${opts.historyCutoff}` : sql``}
        ORDER BY m.seq DESC
        LIMIT 3
      ) latest ON true
    `),
    (rows) => ({
      input_count: threadChannelIds.length,
      latest_reply_rows_count: rows.rows.length,
    }),
  ));
  const [participantRows, unreadRows, latestReplyRows] = await Promise.all([
    participantRowsPending,
    unreadRowsPending,
    latestReplyRowsPending,
  ]);
  const participantsByThreadId = new Map<string, string[]>();
  for (const row of (participantRows?.rows ?? []) as Array<{ threadChannelId: string; senderId: string }>) {
    const list = participantsByThreadId.get(row.threadChannelId) ?? [];
    list.push(row.senderId);
    participantsByThreadId.set(row.threadChannelId, list);
  }

  const unreadByThreadId = new Map<string, { unreadCount: number; firstUnreadMessageId: string | null; followed: boolean }>();
  if (unreadRows) {
    for (const row of unreadRows.rows as Array<{ threadChannelId: string; unreadCount: number; firstUnreadMessageId: string | null; followed: boolean }>) {
      unreadByThreadId.set(row.threadChannelId, {
        unreadCount: row.unreadCount,
        firstUnreadMessageId: row.firstUnreadMessageId ?? null,
        followed: row.followed === true,
      });
    }
  }

  type LatestReplyRow = {
    threadChannelId: string;
    messageId: string;
    seq: number;
    content: string;
    senderId: string;
    senderType: "user" | "agent" | "external_projection";
    messageType: string;
    createdAt: string | Date;
    updatedAt: string | Date;
  };
  const latestRows = latestReplyRows.rows as LatestReplyRow[];
  const replySenderUserIds = [...new Set(latestRows.filter((r) => r.senderType === "user" && r.messageType !== "system").map((r) => r.senderId))];
  const replySenderAgentIds = [...new Set(latestRows.filter((r) => r.senderType === "agent").map((r) => r.senderId))];
  const replySenderNames = new Map<string, string>();
  const replySenderDisplayNames = new Map<string, string>();
  const replySenderAvatars = new Map<string, string | null>();
  const externalReplyNames = new Map<string, string>();
  const externalReplyAvatars = new Map<string, string | null>();
  const externalReplyMessageIds = latestRows
    .filter((row) => row.senderType === "external_projection")
    .map((row) => row.messageId);
  const [replyUserRows, replyAgentRows, externalReplyRows] = await Promise.all([
    replySenderUserIds.length === 0 ? [] : limit(() => db
      .select({ id: users.id, name: users.name, displayName: users.displayName, avatarUrl: users.avatarUrl })
      .from(users)
      .where(inArray(users.id, replySenderUserIds))),
    replySenderAgentIds.length === 0 ? [] : limit(() => db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
      })
      .from(agents)
      .where(and(
        inArray(agents.id, replySenderAgentIds),
        opts?.agentServerId ? eq(agents.serverId, opts.agentServerId) : undefined,
      ))),
    externalReplyMessageIds.length === 0 ? [] : limit(() => db
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
      .where(inArray(externalMessageAuthorFacts.messageId, externalReplyMessageIds))),
  ]);
  for (const row of replyUserRows) {
    const senderName = row.name || "User";
    replySenderNames.set(row.id, senderName);
    replySenderDisplayNames.set(row.id, row.displayName || senderName);
    replySenderAvatars.set(row.id, row.avatarUrl ?? null);
  }
  for (const row of replyAgentRows) {
    const senderName = row.name || "Agent";
    replySenderNames.set(row.id, senderName);
    replySenderDisplayNames.set(row.id, row.displayName || senderName);
    replySenderAvatars.set(row.id, row.avatarUrl ?? null);
  }
  if (externalReplyMessageIds.length > 0) {
    for (const row of externalReplyRows) {
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
  const unresolvedAgentName = opts?.agentServerId ? "Unknown agent" : "Agent";
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
          : (replySenderNames.get(row.senderId) ?? (row.senderType === "agent" ? unresolvedAgentName : "User")),
      senderDisplayName: isSystem
        ? "System"
        : row.senderType === "external_projection"
          ? (externalReplyNames.get(row.messageId) ?? "External user")
          : (replySenderDisplayNames.get(row.senderId) ?? (row.senderType === "agent" ? unresolvedAgentName : "User")),
      senderAvatarUrl: isSystem
        ? null
        : row.senderType === "external_projection"
          ? (externalReplyAvatars.get(row.messageId) ?? null)
          : (replySenderAvatars.get(row.senderId) ?? null),
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
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
      followed: unread?.followed ?? false,
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

export type FollowedThreadMetadataRow = {
  threadChannelId: string;
  storageThreadChannelId: string;
  activityUpperBoundSeq?: number | string | null;
};

export type FollowedThreadStatsRow = {
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
/**
 * Why a followed-thread stats read ran on Postgres. None of these is a fallback
 * for an absent or failing RisingWave (that is an error): they are the reads the
 * RW view cannot answer (a per-thread activity upper bound) and consistency
 * reads inside an authority transaction ("history_cutoff" is now only the label
 * of an authority-transaction read that carries a cutoff; a cutoff alone no
 * longer reroutes a read to Postgres). "task_conversation": the followed task
 * conversations (task v2), which rw_followed_threads_v5 does not carry (it is
 * keyed on thread parent messages); a small, per-user Postgres read.
 */
type FollowedThreadStatsPostgresReason = "history_cutoff" | "activity_upper_bound" | "authority_transaction" | "task_conversation";
type FollowedThreadStatsFallbackReason = "none" | FollowedThreadStatsPostgresReason;

const RISINGWAVE_FOLLOWED_THREAD_STATS_CONTRACT_VERSION = 1;
// The stats read is served by rw_followed_threads_v5 (074; v4's stats columns): v3's exact stats
// columns (070: the unified chain's unread rule, a row for every follow state)
// plus the parent/task columns the active path reads. One view serves both, so
// v3 is no longer read and can be dropped once no running version reads it.
// latest_preview is a 141-char prefix, enough for the 140-char preview.
const RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW = "rw_followed_threads_v5";
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
    ...followedThreadStatsTraceAttrs("rw_mv", "none"),
    error_class: errorClassOf(error),
  });
}

/**
 * RW served fewer stats rows than the followed threads asked for: CDC lag (a
 * thread followed seconds ago that the view has not caught up with yet). Not an
 * error and not a Postgres reroute; the missing threads render without stats.
 */
function recordFollowedThreadStatsRowMismatch(expectedRows: number, actualRows: number) {
  addTraceEvent("followed_threads.stats_backend.row_mismatch", {
    ...followedThreadStatsTraceAttrs("rw_mv", "none"),
    followed_threads_count: expectedRows,
    stats_rows_count: actualRows,
    missing_stats_rows_count: Math.max(0, expectedRows - actualRows),
    likely_cause: "cdc_lag",
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
  view: string = RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW,
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
        -- Same tuple as lastReplyMessageId: the view joins
        -- latest.seq = stats.latest_seq, so id and seq cannot describe
        -- different messages. Never splice these from separate sources.
        s.latest_seq::text AS "lastReplySeqExact",
        s.latest_preview AS "lastReplyContent",
        s.latest_sender_type AS "lastReplySenderType",
        s.latest_sender_id AS "lastReplySenderId",
        s.first_unread_message_id::text AS "firstUnreadMessageId",
        COALESCE(s.unread_count, 0)::int AS "unreadCount"
      FROM input_threads i
      JOIN ${view} s
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
  traceQuery: DbQueryTracer,
  historyCutoffPresent: boolean,
): Promise<FollowedThreadStatsRow[]> {
  // CONTRACT: rw_followed_threads_v5 is an endpoint-shaped serving read
  // model for GET /api/channels/threads/followed and the Done / Activity
  // followed-thread lists, for every follow state. It must return all stats
  // fields in one lookup keyed by (server_id, user_id, thread_channel_id). Do
  // not replace this with request-time joins across generic RW MVs; that shape
  // was benchmarked slower than Postgres.
  if (threads.length === 0) return [];
  const client = getRisingWavePool();
  if (!client) throw new RisingWaveNotConfiguredError("followed-thread stats");

  const threadIds = threads.map((thread) => thread.threadChannelId);
  const view = RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW;
  const readStats = async () => {
    const replayQuery = buildRisingWaveFollowedThreadStatsReplayQuery(serverId, userId, threadIds, view);
    const queryStart = performance.now();
    const result = await traceQuery(
      RISINGWAVE_FOLLOWED_THREAD_STATS_QUERY_NAME,
      () => {
        // pool.query, not queryRisingWave, so the duration here includes the
        // wait for an RW connection; an acquire timeout counts with no duration.
        const statementStartMs = Date.now();
        return client.query(replayQuery.sql, replayQuery.params).then(
          (queryResult) => {
            observeStatement("risingwave", "select", statementStartMs);
            return queryResult;
          },
          (error: unknown) => {
            if (isPoolAcquireTimeoutError(error)) recordStatementError("risingwave", error);
            else observeStatement("risingwave", "select", statementStartMs, error);
            throw asRisingWaveOverload(error);
          },
        );
      },
      (queryResult) => ({
        ...followedThreadStatsTraceAttrs("rw_mv", "none"),
        backend: "risingwave",
        rw_followed_thread_stats_view: view,
        followed_threads_count: threads.length,
        stats_rows_count: queryResult.rows.length,
        // A cutoff no longer reroutes to Postgres; it only withholds old previews.
        history_cutoff_present: historyCutoffPresent,
      }),
    );
    recordSlowRisingWaveFollowedThreadStatsReplayQuery(performance.now() - queryStart, replayQuery, result.rows.length);
    return result.rows as FollowedThreadStatsRow[];
  };
  return readStats();
}


/**
 * Followed-thread stats from Postgres, for the reads the RW view cannot answer
 * (activity upper bound) and for authority transactions. Never
 * a substitute for an absent or failing RisingWave. Exported for the test
 * reference of the RW read (src/test/risingWaveReadReference.ts).
 */
export async function getFollowedThreadStatsFromPostgres(
  userId: string,
  threads: FollowedThreadMetadataRow[],
  historyCutoff: Date | undefined,
  traceQuery: DbQueryTracer,
  postgresReason: FollowedThreadStatsPostgresReason | "none",
  executor: DatabaseExecutor = getDb(),
): Promise<FollowedThreadStatsRow[]> {
  const cutoffCondition = historyCutoff ? sql` AND m.created_at > ${historyCutoff}` : sql``;
  // The unified chain's unread rule (rw_inbox_normal_v5, 075-inbox-cursor-decouple.sql),
  // identical to rw_followed_threads_v5 (v3's rule): after the cursor, not own-sent, not
  // a system message the user caused (NULL causal actor = no exclusion), not a
  // noise subtype. These reads serve the documented RW gaps, so they must not
  // reintroduce the pre-063 rule.
  const threadUnreadPredicate = sql`m.seq > COALESCE(rc.last_read_seq, 0)
              AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
              AND NOT COALESCE(m.message_type = 'system' AND m.causal_actor_type = 'user' AND m.causal_actor_id = ${userId}::text, FALSE)
              AND (m.system_subtype IS NULL OR m.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))`;
  // Task conversations (the only threads of a "task_conversation" read): replies
  // are chat messages, not lifecycle lines -- the task row's and Activity's count.
  // Their unread is on the same basis (taskConversationUnreadMessageSql), so
  // "N new" never counts a lifecycle line.
  const replyCountExpr = postgresReason === "task_conversation"
    ? sql`count(m.id) FILTER (WHERE m.message_type = 'chat')`
    : sql`count(m.id)`;
  const unreadPredicate = postgresReason === "task_conversation"
    ? sql`${threadUnreadPredicate} AND ${taskConversationUnreadMessageSql(sql`m`, sql`true`)}`
    : threadUnreadPredicate;

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
          ${replyCountExpr}::int AS reply_count,
          count(m.id) FILTER (WHERE ${unreadPredicate})::int AS unread_count,
          max(m.seq) AS latest_seq,
          min(m.seq) FILTER (WHERE ${unreadPredicate}) AS first_unread_seq
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
      ...followedThreadStatsTraceAttrs("pg_legacy", postgresReason),
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
    // Authority transaction: a consistency read on the caller's executor.
    return getFollowedThreadStatsFromPostgres(
      userId,
      threads,
      historyCutoff,
      traceQuery,
      threads.some((thread) => thread.activityUpperBoundSeq != null)
        ? "activity_upper_bound"
        : historyCutoff
          ? "history_cutoff"
          : "authority_transaction",
      executor,
    );
  }
  // The RW view carries no per-thread activity upper bound (unfollowed threads
  // are clipped at done_through_seq), so those reads stay on Postgres.
  //
  // A plan history cutoff does NOT reroute (product decision): the numbers
  // (unreadCount, replyCount, lastReplyAt) come from RW as-is for every plan.
  // The only cutoff rule is that a free plan never sees content older than its
  // cutoff; getFollowedThreads enforces it by blanking the latest reply's
  // preview when that reply is before the cutoff.
  if (threads.some((thread) => thread.activityUpperBoundSeq != null)) {
    return getFollowedThreadStatsFromPostgres(userId, threads, historyCutoff, traceQuery, "activity_upper_bound");
  }

  const override = getActivityReadSourceOverride();
  if (override) return override.followedThreadStats({ serverId, userId, threads, traceQuery });

  // RisingWave only, for every follow state: unconfigured or a failed read errors.
  let risingWaveRows: FollowedThreadStatsRow[];
  try {
    risingWaveRows = await getFollowedThreadStatsFromRisingWave(serverId, userId, threads, traceQuery, Boolean(historyCutoff));
  } catch (error) {
    recordFollowedThreadStatsBackendFailed(error);
    throw error;
  }
  if (risingWaveRows.length !== threads.length) {
    // CDC lag: a just-followed thread the view has not caught up with yet. Serve
    // what RW has; getFollowedThreads renders a thread without a stats row from
    // its parent message (zero replies, zero unread) until the view catches up.
    recordFollowedThreadStatsRowMismatch(threads.length, risingWaveRows.length);
    return risingWaveRows;
  }
  recordFollowedThreadStatsBackendSucceeded(risingWaveRows.length);
  return risingWaveRows;
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
/** For a Guest, every conversation it may read (its channel, that channel's threads and tasks); null for anyone else. */
export async function guestReadableConversationIds(serverId: string, userId: string, executor: DatabaseExecutor = getDb()): Promise<string[] | null> {
  return guestInboxChannelIds(serverId, userId, executor);
}

async function guestInboxChannelIds(serverId: string, userId: string, executor: DatabaseExecutor): Promise<string[] | null> {
  if (await resolveHumanServerRole(serverId, userId, executor) !== "guest") return null;
  // A Guest's inbox is its one channel and that channel's threads and tasks.
  const guestChannelId = await getGuestChannelId(serverId, userId, executor);
  if (!guestChannelId) return [];
  const [bound] = await executor.select({ channel: channels, memberId: channelHumans.userId })
    .from(channels).leftJoin(channelHumans, and(
      eq(channelHumans.channelId, channels.id), eq(channelHumans.userId, userId),
    )).where(and(eq(channels.id, guestChannelId), eq(channels.serverId, serverId)))
    .limit(1);
  const jointEntry = bound?.channel.type === "joint"
    && (await filterGuestJointEntries(serverId, userId, guestChannelId, [bound.channel], executor)).has(bound.channel.id);
  if (!bound || !canGuestReadChannel({
    serverRole: "guest", channelId: bound.channel.id, guestChannelId, channelType: bound.channel.type,
    isChannelMember: bound.channel.type === "joint" ? jointEntry : bound.memberId !== null, jointEntry,
    archived: bound.channel.archivedAt !== null, deleted: bound.channel.deletedAt !== null,
  })) return [];
  if (bound.channel.type === "joint") {
    // P3: a joint channel's threads and tasks are this server's local faces
    // of canonical conversations under the joint's canonical channel.
    const faces = await executor.execute<{ id: string }>(sql`
      SELECT tp.local_channel_id::text AS id
      FROM joint_channel_servers rp
      JOIN joint_channels rj ON rj.id=rp.joint_channel_id
      -- parent_channel_id is the validated parent cache (jointConversationFamilySql).
      JOIN channels ct ON ct.parent_channel_id=rj.canonical_channel_id AND ct.type IN ('thread','task') AND ct.deleted_at IS NULL
      JOIN joint_channels tj ON tj.canonical_channel_id=ct.id
      JOIN joint_channel_servers tp ON tp.joint_channel_id=tj.id AND tp.server_id=rp.server_id AND tp.status='active'
      JOIN channels lc ON lc.id=tp.local_channel_id AND lc.deleted_at IS NULL
      WHERE rp.local_channel_id=${guestChannelId}::uuid AND rp.server_id=${serverId}::uuid`);
    return [guestChannelId, ...faces.rows.map((row) => row.id)];
  }
  const children = await executor.select({ id: channels.id })
    .from(channels).leftJoin(messages, eq(messages.id, channels.parentMessageId))
    .where(and(eq(channels.serverId, serverId), isNull(channels.deletedAt), or(
      and(eq(channels.type, "thread"), eq(messages.channelId, guestChannelId)),
      // Task conversations (task v2) inherit their parent channel's readability.
      and(eq(channels.type, "task"), eq(channels.parentChannelId, guestChannelId)),
    )));
  return [guestChannelId, ...children.map((row) => row.id)];
}

function guestInboxAccessSql(ids: string[] | null, channelId: SQL): SQL {
  return ids === null ? sql`true` : ids.length === 0 ? sql`false`
    : sql`${channelId} IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`;
}

/**
 * Task v2: the followed task conversations of the canonical Postgres Activity
 * read, as a `UNION ALL` arm of its `followed_threads` CTE (same columns, in
 * order, plus `conversation_kind`). A task conversation's parent is its task's
 * channel, `channels.parent_channel_id` on every face (a joint channel's local
 * conversation already points at this server's local channel), so no parent
 * message and no joint parent mapping; messages live in the canonical
 * conversation (joint storage mapping like a joint thread). Visibility is the
 * thread rule against that parent: this server, live, public or a member.
 * parent_message_preview is the task title (search matches it; the API row
 * takes the title from the task itself). Mirrors rw_conversation_parent_v1 in
 * infra/risingwave/sql/078-task-conversations.sql.
 */
function followedTaskConversationsLegacyInboxArm(opts: {
  serverId: string;
  userId: string;
  guestAccess: string[] | null;
  withTaskColumns: boolean;
}): SQL {
  const { serverId, userId, guestAccess } = opts;
  return sql`SELECT
        conv.id AS source_channel_id,
        COALESCE(canonical_conv.id, conv.id) AS storage_channel_id,
        NULL::uuid AS parent_message_id,
        conv_parent.id AS parent_channel_id,
        conv_parent.name AS parent_channel_name,
        conv_parent.type::text AS parent_channel_type,
        conv_task.title AS parent_message_preview,
        NULL::text AS parent_message_sender_type,
        NULL::text AS parent_message_sender_id,
        NULL::timestamptz AS parent_message_created_at,
        NULL::bigint AS parent_message_seq,
        ${opts.withTaskColumns
          ? sql`conv_task.task_number AS task_number,
        conv_task.status AS task_status,
        conv_task.claimed_by_type AS task_claimed_by_type,
        conv_task.claimed_by_id AS task_claimed_by_id,`
          : sql`COALESCE(conv_rc.last_read_seq, 0) AS last_read_seq,`}
        'task'::text AS conversation_kind
      FROM thread_follows conv_follow
      INNER JOIN channels conv
        ON conv.id = conv_follow.thread_channel_id
       AND conv.type = 'task'
       AND conv.server_id = ${serverId}
       AND conv.deleted_at IS NULL
      INNER JOIN tasks conv_task
        ON conv_task.id = conv.task_id
      LEFT JOIN joint_channel_servers conv_projection
        ON conv_projection.local_channel_id = conv.id
       AND conv_projection.server_id = ${serverId}
       AND conv_projection.status = 'active'
      LEFT JOIN joint_channels conv_joint
        ON conv_joint.id = conv_projection.joint_channel_id
       AND conv_joint.status = 'active'
      LEFT JOIN channels canonical_conv
        ON canonical_conv.id = conv_joint.canonical_channel_id
       AND canonical_conv.type = 'task'
       AND canonical_conv.deleted_at IS NULL
      INNER JOIN channels conv_parent
        ON conv_parent.id = conv.parent_channel_id
       AND conv_parent.server_id = ${serverId}
       AND conv_parent.archived_at IS NULL
       AND conv_parent.deleted_at IS NULL
      LEFT JOIN channel_humans conv_parent_member
        ON conv_parent_member.channel_id = conv_parent.id
       AND conv_parent_member.user_id = ${userId}
      LEFT JOIN user_channel_read_cursors conv_rc
        ON conv_rc.channel_id = conv.id
       AND conv_rc.user_id = ${userId}
      WHERE ${guestInboxAccessSql(guestAccess, sql`conv_parent.id`)}
        AND conv_follow.follower_type = 'user'
        AND conv_follow.follower_id = ${userId}
        AND conv_follow.done_at IS NULL
        AND conv_follow.unfollowed_at IS NULL
        AND (conv_parent.type = 'channel' OR conv_parent_member.user_id IS NOT NULL)`;
}

/** One followed thread as GET /api/channels/threads/followed returns it. */
export type FollowedThread = {
  threadChannelId: string;
  parentMessageId: string;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: string;
  parentMessagePreview: string;
  parentMessageSenderType: string;
  parentMessageSenderId: string;
  /** When the parent message was posted: the thread's place in its channel (jump pill order). */
  parentMessageCreatedAt: string;
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
  /**
   * An unread reply in this thread mentions the user. Same source as the
   * sidebar summary's thread rows (and so threadUnread.hasMention), so the
   * jump pill and the badge agree. False when that read fails: it only orders
   * the pill.
   */
  hasMention: boolean;
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
};

/**
 * Task v2: a followed task conversation in the followed-threads list
 * (`includeTaskConversations`). Same fields as a thread row, keyed by the
 * reader's LOCAL task conversation (`threadChannelId`), with the task in place
 * of the parent message: `parentMessagePreview` is the task title, the
 * "parent" author/time are the task's creator and creation time, and there is
 * no parent message (`parentMessageId: null`; `latestActivityMessageId` is null
 * until the first reply).
 */
export type FollowedTaskConversation = Omit<FollowedThread, "parentMessageId" | "latestActivityMessageId" | "taskId" | "taskNumber" | "taskStatus"> & {
  kind: "task";
  parentMessageId: null;
  latestActivityMessageId: string | null;
  taskId: string;
  taskNumber: number;
  taskTitle: string;
  taskStatus: string;
  /** The chat message the task hangs under and its time (its place in the
   *  channel); null for a task under no message, or whose source is deleted. */
  sourceMessageId: string | null;
  sourceMessageCreatedAt: string | null;
};

/** One followed thread before stats and read state: its parent message, parent channel and task. */
type FollowedThreadSourceRow = {
  /** Task v2: set for a followed task conversation (its parent is the task, not a message). */
  conversationKind?: "task";
  taskTitle?: string | null;
  /** Task v2: the message the task hangs under (task conversations only). */
  sourceMessageId?: string | null;
  sourceMessageCreatedAt?: Date | null;
  threadChannelId: string;
  storageThreadChannelId: string;
  parentMessageId: string | null;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: string;
  parentMessageContent: string;
  parentMessageCreatedAt: Date;
  parentMessageSenderType: string;
  parentMessageSenderId: string;
  parentMessageSeq: string | null;
  taskId: string | null;
  taskNumber: number | null;
  taskStatus: string | null;
  taskClaimedByType: "agent" | "user" | null;
  taskClaimedById: string | null;
  doneAt: Date | string | null;
  unfollowedAt: Date | string | null;
  activityUpperBoundSeq: number | null;
};

/**
 * One rw_followed_threads_v5 row (infra/risingwave/sql/074-followed-threads-v5.sql)
 * as the server reads it: v3's stats columns (FollowedThreadStatsRow) plus the
 * parent message and its task. lastReplyContent and parentMessageContent are
 * 141-character prefixes (enough for the 140/100-character previews). The
 * timestamps are `YYYY-MM-DD HH24:MI:SS.US+00` text, the format the v3 stats read
 * returns for lastReplyAt.
 */
export type FollowedThreadRwRow = FollowedThreadStatsRow & {
  storageThreadChannelId: string;
  parentMessageId: string | null;
  parentChannelId: string | null;
  /** Server of the parent message's channel (rw_channels), NULL when RW lacks it. */
  parentServerId: string | null;
  parentMessageContent: string | null;
  parentMessageSenderType: string | null;
  parentMessageSenderId: string | null;
  parentMessageSeq: string | null;
  parentMessageCreatedAt: string | null;
  taskId: string | null;
  taskNumber: number | null;
  taskStatus: string | null;
  taskClaimedByType: "agent" | "user" | null;
  taskClaimedById: string | null;
  /** v5: the followed thread is a local projection of a joint thread. */
  jointProjection: boolean;
  /** v5: this server's local joint channel of the canonical parent channel (joint projections). */
  jointParentChannelId: string | null;
};

type FollowedThreadsState = NonNullable<FollowedThreadsOptions["state"]>;

/** Why a getFollowedThreads call ran the legacy (all-Postgres list) path. */
type FollowedThreadsLegacyReason =
  | "guest"
  | "state"
  | "executor"
  | "search"
  | "channel_filter"
  | "max_rows"
  | "forced"
  | "rw_failed";

type FollowedThreadsQueryContext = {
  serverId: string;
  userId: string;
  db: DatabaseExecutor;
  traceQuery: DbQueryTracer;
  guestAccess: string[] | null;
  state: FollowedThreadsState;
  opts: FollowedThreadsOptions | undefined;
};

type LoadedFollowedThreads = {
  threads: FollowedThreadSourceRow[];
  statsRows: FollowedThreadStatsRow[];
  readStateByThread: Map<string, ReadStateSnapshot>;
};

const RISINGWAVE_FOLLOWED_THREADS_VIEW = "rw_followed_threads_v5";
const RW_MISSING_THREAD_IDS_TRACE_CAP = 5;
const RISINGWAVE_FOLLOWED_THREADS_QUERY_NAME = "channels.followed_threads_rw_rows";

/**
 * The single lookup of the RW followed-threads path: every rw_followed_threads_v5
 * row of (server, user), on the lookup index prefix. The view holds every follow
 * state; the caller keeps only the Postgres follow set.
 */
export const RISINGWAVE_FOLLOWED_THREADS_ROWS_SQL = `
      SELECT
        v.thread_channel_id::text AS "threadChannelId",
        v.storage_thread_channel_id::text AS "storageThreadChannelId",
        COALESCE(v.reply_count, 0)::int AS "replyCount",
        CASE
          WHEN v.last_reply_at IS NULL THEN NULL::text
          ELSE to_char(v.last_reply_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'
        END AS "lastReplyAt",
        -- Same tuple: the view joins latest.seq = stats.latest_seq.
        v.latest_message_id::text AS "lastReplyMessageId",
        v.latest_seq::text AS "lastReplySeqExact",
        v.latest_preview AS "lastReplyContent",
        v.latest_sender_type AS "lastReplySenderType",
        v.latest_sender_id AS "lastReplySenderId",
        v.first_unread_message_id::text AS "firstUnreadMessageId",
        COALESCE(v.unread_count, 0)::int AS "unreadCount",
        v.parent_message_id::text AS "parentMessageId",
        v.parent_channel_id::text AS "parentChannelId",
        v.parent_server_id::text AS "parentServerId",
        v.parent_preview AS "parentMessageContent",
        v.parent_sender_type AS "parentMessageSenderType",
        v.parent_sender_id AS "parentMessageSenderId",
        v.parent_seq::text AS "parentMessageSeq",
        CASE
          WHEN v.parent_created_at IS NULL THEN NULL::text
          ELSE to_char(v.parent_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'
        END AS "parentMessageCreatedAt",
        v.task_id::text AS "taskId",
        v.task_number::int AS "taskNumber",
        v.task_status AS "taskStatus",
        v.task_claimed_by_type AS "taskClaimedByType",
        v.task_claimed_by_id AS "taskClaimedById",
        COALESCE(v.joint_projection, FALSE) AS "jointProjection",
        v.joint_parent_channel_id::text AS "jointParentChannelId"
      FROM ${RISINGWAVE_FOLLOWED_THREADS_VIEW} v
      WHERE v.server_id = $1
        AND v.user_id = $2
    `;

function followedThreadParentChannelIdsSql(parentChannelIds: readonly string[], parentChannelId: SQL): SQL {
  if (parentChannelIds.length === 0) return sql`false`;
  return sql`(${parentChannelId})::text IN (${sql.join(parentChannelIds.map((id) => sql`${id.toLowerCase()}`), sql`, `)})`;
}

function followedThreadsLegacyReason(ctx: FollowedThreadsQueryContext): FollowedThreadsLegacyReason | null {
  if (ctx.opts?.forceLegacyPath) return "forced";
  if (ctx.guestAccess !== null) return "guest";
  if (ctx.state !== "active") return "state";
  if (ctx.opts?.executor) return "executor";
  if (ctx.opts?.q) return "search";
  if (ctx.opts?.channelId || ctx.opts?.parentChannelIds) return "channel_filter";
  if (ctx.opts?.maxRows != null) return "max_rows";
  return null;
}

/**
 * The Postgres regular-thread list (threads whose parent message is in this
 * server).
 */
async function queryFollowedRegularThreads(
  ctx: FollowedThreadsQueryContext,
): Promise<FollowedThreadSourceRow[]> {
  const { serverId, userId, db, traceQuery, guestAccess, state, opts } = ctx;
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
        isNull(parentChannels.deletedAt),
        sql`(${parentChannels.type} = 'channel' OR ${parentChannelHumans.userId} IS NOT NULL)`,
        opts?.channelId ? eq(parentMessages.channelId, opts.channelId) : undefined,
        opts?.parentChannelIds ? followedThreadParentChannelIdsSql(opts.parentChannelIds, sql`${parentMessages.channelId}`) : undefined,
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
  return traceQuery(
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
}

/** The Postgres joint-thread list (local projections of joint threads). */
async function queryFollowedJointThreads(ctx: FollowedThreadsQueryContext): Promise<FollowedThreadSourceRow[]> {
  const { serverId, userId, db, traceQuery, guestAccess, state, opts } = ctx;
  const searchPattern = opts?.q ? `%${opts.q}%` : null;
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
        ${opts?.parentChannelIds ? sql`AND ${followedThreadParentChannelIdsSql(opts.parentChannelIds, sql`local_parent.id`)}` : sql``}
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
  return (jointThreadRows.rows as any[]).map((row) => ({
    ...row,
    parentMessageCreatedAt: new Date(row.parentMessageCreatedAt),
    unfollowedAt: row.unfollowedAt ? new Date(row.unfollowedAt) : null,
    activityUpperBoundSeq: row.activityUpperBoundSeq == null ? null : Number(row.activityUpperBoundSeq),
  }));
}

/**
 * Task v2: the task conversations the user follows, in the follow state of
 * the read (ctx.state, as the thread queries: active, done, unfollowed,
 * unfollowed_active -- Done history and the Unfollowed lists list them like
 * threads), keyed by
 * the user's LOCAL conversation on this server (the canonical conversation on
 * an ordinary channel, this server's projection on a joint channel), with the
 * task standing in for the parent message. Visibility is the thread rule on
 * the conversation's parent channel (this server, not archived/deleted, public
 * or a member; guests: readable parents only). Messages live in the canonical
 * conversation (`tasks.conversation_channel_id`), so stats read it there and
 * the read cursor stays on the local conversation. All Postgres: the RW
 * followed-threads view is keyed on thread parent messages.
 */
async function loadFollowedTaskConversations(
  ctx: FollowedThreadsQueryContext,
  historyCutoff: Date | undefined,
): Promise<LoadedFollowedThreads> {
  const { serverId, userId, db, traceQuery, guestAccess, state, opts } = ctx;
  const searchPattern = opts?.q ? `%${opts.q}%` : null;
  // Same follow-state conditions, history order and row cap as
  // queryFollowedRegularThreads / queryFollowedJointThreads.
  const doneCondition = state === "done"
    ? sql`tf.done_at IS NOT NULL`
    : state === "active" || state === "unfollowed_active"
      ? sql`tf.done_at IS NULL`
      : sql`TRUE`;
  const followCondition = state === "unfollowed" || state === "unfollowed_active"
    ? sql`tf.unfollowed_at IS NOT NULL`
    : state === "done"
      ? sql`TRUE`
      : sql`tf.unfollowed_at IS NULL`;
  const historyOrder = state === "done" || state === "unfollowed"
    ? sql`ORDER BY ${state === "done" ? sql`tf.done_at` : sql`tf.unfollowed_at`} ${opts?.sort === "asc" ? sql`ASC` : sql`DESC`}, tf.thread_channel_id ${opts?.sort === "asc" ? sql`ASC` : sql`DESC`} LIMIT ${opts?.maxRows ?? 101}`
    : sql``;
  const result = await traceQuery(
    "channels.followed_task_conversations_by_user",
    () => db.execute(sql`
      SELECT
        conversation.id::text AS "threadChannelId",
        COALESCE(task.conversation_channel_id, conversation.id)::text AS "storageThreadChannelId",
        parent.id::text AS "parentChannelId",
        parent.name AS "parentChannelName",
        parent.type AS "parentChannelType",
        task.id::text AS "taskId",
        task.task_number AS "taskNumber",
        task.title AS "taskTitle",
        task.status AS "taskStatus",
        task.claimed_by_type AS "taskClaimedByType",
        task.claimed_by_id AS "taskClaimedById",
        task.created_by_type AS "createdByType",
        task.created_by_id AS "createdById",
        task.created_at AS "createdAt",
        source.id::text AS "sourceMessageId",
        source.created_at AS "sourceMessageCreatedAt",
        tf.done_at AS "doneAt",
        tf.unfollowed_at AS "unfollowedAt",
        COALESCE(suppression.done_through_seq, 0) AS "activityUpperBoundSeq"
      FROM ${threadFollows} tf
      INNER JOIN ${channels} conversation
        ON conversation.id = tf.thread_channel_id
       AND conversation.type = 'task'
       AND conversation.server_id = ${serverId}
       AND conversation.deleted_at IS NULL
      INNER JOIN ${tasks} task
        ON task.id = conversation.task_id
      -- Where the task sits in its channel: the message it hangs under.
      LEFT JOIN ${messages} source
        ON source.id = task.source_message_id
       AND source.deleted_at IS NULL
      INNER JOIN ${channels} parent
        ON parent.id = conversation.parent_channel_id
       AND parent.server_id = ${serverId}
       AND parent.archived_at IS NULL
       AND parent.deleted_at IS NULL
      LEFT JOIN ${channelHumans} parent_member
        ON parent_member.channel_id = parent.id
       AND parent_member.user_id = ${userId}
      -- The unfollow boundary (as for a thread): the paired mention suppression
      -- keeps the exact seq written by the explicit unfollow.
      LEFT JOIN ${inboxSuppressionStates} suppression
        ON suppression.receiver_type = 'user'
       AND suppression.receiver_id = ${userId}::uuid
       AND suppression.target_kind = 'public_thread_mention'
       AND suppression.target_channel_id = conversation.id
      WHERE tf.follower_type = 'user'
        AND tf.follower_id = ${userId}
        AND ${doneCondition}
        AND ${followCondition}
        AND (parent.type = 'channel' OR parent_member.user_id IS NOT NULL)
        AND ${guestInboxAccessSql(guestAccess, sql`parent.id`)}
        ${opts?.channelId ? sql`AND parent.id = ${opts.channelId}::uuid` : sql``}
        ${searchPattern ? sql`AND (parent.name ILIKE ${searchPattern} OR task.title ILIKE ${searchPattern})` : sql``}
      ${historyOrder}
    `),
    (queryResult) => ({ followed_task_conversations_count: queryResult.rows.length }),
  );
  const threads: FollowedThreadSourceRow[] = (result.rows as Array<Record<string, unknown>>).map((row) => ({
    conversationKind: "task",
    taskTitle: String(row.taskTitle ?? ""),
    sourceMessageId: (row.sourceMessageId as string | null) ?? null,
    sourceMessageCreatedAt: row.sourceMessageCreatedAt ? new Date(row.sourceMessageCreatedAt as string | Date) : null,
    threadChannelId: String(row.threadChannelId),
    storageThreadChannelId: String(row.storageThreadChannelId),
    parentMessageId: null,
    parentChannelId: String(row.parentChannelId),
    parentChannelName: String(row.parentChannelName ?? ""),
    parentChannelType: String(row.parentChannelType),
    parentMessageContent: String(row.taskTitle ?? ""),
    parentMessageCreatedAt: new Date(row.createdAt as string | Date),
    parentMessageSenderType: String(row.createdByType),
    parentMessageSenderId: String(row.createdById),
    parentMessageSeq: null,
    taskId: String(row.taskId),
    taskNumber: Number(row.taskNumber),
    taskStatus: String(row.taskStatus),
    taskClaimedByType: (row.taskClaimedByType as "agent" | "user" | null) ?? null,
    taskClaimedById: (row.taskClaimedById as string | null) ?? null,
    doneAt: (row.doneAt as Date | string | null) ?? null,
    unfollowedAt: (row.unfollowedAt as Date | string | null) ?? null,
    // The stats stop at the unfollow boundary only for the frozen Unfollowed
    // history, as for threads (loadFollowedThreadsLegacy).
    activityUpperBoundSeq: state === "unfollowed" && row.activityUpperBoundSeq != null ? Number(row.activityUpperBoundSeq) : null,
  }));
  if (threads.length === 0) return { threads: [], statsRows: [], readStateByThread: new Map() };
  const statsRows = await getFollowedThreadStatsFromPostgres(
    userId,
    threads,
    historyCutoff,
    traceQuery,
    "task_conversation",
    db,
  );
  const readStates = await attachReadState(
    threads.map((thread) => ({ id: thread.threadChannelId })),
    userId,
    db,
    traceQuery,
  );
  return {
    threads,
    statsRows,
    readStateByThread: new Map(readStates.map((readState) => [readState.id, readState])),
  };
}

/** Every follow state, any caller: the Postgres list, v3 stats, the read-state authority read. */
async function loadFollowedThreadsLegacy(
  ctx: FollowedThreadsQueryContext,
  historyCutoff: Date | undefined,
): Promise<LoadedFollowedThreads> {
  const { serverId, userId, db, traceQuery, state, opts } = ctx;
  const regularThreads = await queryFollowedRegularThreads(ctx);
  const jointThreads = await queryFollowedJointThreads(ctx);
  let threads = [...regularThreads, ...jointThreads];

  if (await resolveHumanServerRole(serverId, userId, db) === "guest") {
    // Every distinct parent in one batched check, however many threads a guest follows.
    const visibleParents = await filterUserAccessibleChannelIds(
      [...new Set(threads.map((thread) => thread.parentChannelId))],
      userId,
      serverId as ServerId,
      { executor: db },
    );
    threads = threads.filter((thread) => visibleParents.has(thread.parentChannelId));
  }

  if (threads.length === 0) return { threads: [], statsRows: [], readStateByThread: new Map() };

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
  const readStates = await attachReadState(
    threads.map((thread) => ({ id: thread.threadChannelId })),
    userId,
    db,
    traceQuery,
  );
  return {
    threads,
    statsRows,
    readStateByThread: new Map(readStates.map((readState) => [readState.id, readState])),
  };
}

async function readFollowedThreadRwRows(
  serverId: string,
  userId: string,
  traceQuery: DbQueryTracer,
): Promise<FollowedThreadRwRow[]> {
  const override = getActivityReadSourceOverride();
  if (override) return override.followedThreadRows({ serverId, userId, traceQuery });
  const pool = getRisingWaveInboxPool();
  if (!pool) throw new RisingWaveNotConfiguredError("followed threads");
  const read = await traceQuery(
    RISINGWAVE_FOLLOWED_THREADS_QUERY_NAME,
    () => queryRisingWaveInbox<FollowedThreadRwRow>(pool, RISINGWAVE_FOLLOWED_THREADS_ROWS_SQL, [serverId, userId]),
    (queryRead) => ({
      backend: "risingwave",
      db_system: "risingwave",
      rw_followed_threads_view: RISINGWAVE_FOLLOWED_THREADS_VIEW,
      rows_count: queryRead.result.rows.length,
      "rw.acquire_wait_ms": Math.round(queryRead.acquireWaitMs),
      "rw.pool.total_count": queryRead.poolState.rw_pool_total,
      "rw.pool.idle_count": queryRead.poolState.rw_pool_idle,
      "rw.pool.waiting_count": queryRead.poolState.rw_pool_waiting,
    }),
  );
  return read.result.rows;
}

/**
 * Active follows of a non-guest without search / channel filter / row cap /
 * executor, from rw_followed_threads_v5 plus three primary-key Postgres reads.
 *
 * Authority stays in Postgres: the follow set (a just-followed thread appears
 * immediately), the parent channel's visibility and name (by distinct parent
 * channel), and the read cursor. RisingWave supplies what used to cost a random
 * `messages` read per thread: the parent message, its task and the stats.
 *
 * Followed threads RW has no row for yet (CDC lag) take the legacy regular-thread
 * query restricted to them; joint projections keep the legacy joint query. Both
 * get v3 stats and the read-state authority read, as before.
 *
 * Returns null when the RW read fails (e.g. the view is not deployed yet); the
 * caller then runs the whole legacy path. That error is never surfaced.
 */
async function loadActiveFollowedThreadsFromRisingWave(
  ctx: FollowedThreadsQueryContext,
  historyCutoff: Date | undefined,
): Promise<LoadedFollowedThreads | null> {
  const { serverId, userId, db, traceQuery } = ctx;
  // Independent reads: RW in flight while Postgres resolves the follow set. The
  // settled wrapper keeps an RW rejection from going unhandled if Postgres throws.
  const rwRead = readFollowedThreadRwRows(serverId, userId, traceQuery).then(
    (rows) => ({ ok: true as const, rows }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const followSet = await traceQuery(
    "channels.followed_thread_ids_by_user",
    () => db.execute(sql`
      SELECT tf.thread_channel_id::text AS "threadChannelId"
      FROM thread_follows tf
      JOIN channels c
        ON c.id = tf.thread_channel_id
       AND c.type = 'thread'
       AND c.deleted_at IS NULL
       AND c.server_id = ${serverId}
      WHERE tf.follower_type = 'user'
        AND tf.follower_id = ${userId}
        AND tf.done_at IS NULL
        AND tf.unfollowed_at IS NULL
    `),
    (result) => ({ followed_threads_count: result.rows.length }),
  );
  const rw = await rwRead;
  if (!rw.ok) {
    addTraceEvent("followed_threads.rw_rows.failed", {
      backend: "risingwave",
      rw_followed_threads_view: RISINGWAVE_FOLLOWED_THREADS_VIEW,
      error_class: errorClassOf(rw.error),
    });
    // An overloaded RW pool answers 503 (#9044), never the legacy path: that
    // path is the expensive Postgres read, and running it exactly while RW is
    // overloaded would move the load onto the primary.
    if (isRisingWaveOverloadedError(rw.error)) throw rw.error;
    // Not configured is not a transient read failure: the legacy path needs
    // RisingWave for the stats too, and with no follows would answer an empty
    // list that hides the outage. The route answers 503 rw_unconfigured.
    if (rw.error instanceof RisingWaveNotConfiguredError) throw rw.error;
    return null;
  }
  const followedIds = (followSet.rows as Array<{ threadChannelId: string }>).map((row) => row.threadChannelId);

  // Partition the follow set by what RW knows about each thread.
  const rwByThread = new Map(rw.rows.map((row) => [row.threadChannelId, row]));
  // Joint projections are served like regular threads, with this server's local
  // joint channel as the parent channel (v5's joint_parent_channel_id).
  const rwRegular: FollowedThreadRwRow[] = [];
  const jointThreadIds = new Set<string>();
  const missingIds: string[] = [];
  let nonRegularCount = 0;
  for (const threadChannelId of followedIds) {
    const row = rwByThread.get(threadChannelId);
    if (!row) {
      // CDC lag: followed in Postgres, not in the view yet.
      missingIds.push(threadChannelId);
    } else if (row.jointProjection) {
      if (row.parentMessageId == null || row.parentMessageCreatedAt == null) {
        // The canonical parent message has not reached RW yet: CDC lag.
        missingIds.push(threadChannelId);
      } else if (row.jointParentChannelId == null) {
        // No active projection of the canonical parent channel in this server:
        // not visible here (the Postgres joint query's parent_projection join).
        nonRegularCount += 1;
      } else {
        jointThreadIds.add(threadChannelId);
        rwRegular.push({ ...row, parentChannelId: row.jointParentChannelId });
      }
    } else if (row.parentMessageId == null || (row.parentServerId != null && row.parentServerId !== serverId)) {
      // No parent message, or a parent in another server: never a thread of
      // this server's channels.
      nonRegularCount += 1;
    } else if (row.parentServerId == null || row.parentChannelId == null || row.parentMessageCreatedAt == null) {
      // The parent message (or its channel) has not reached RW yet: CDC lag.
      missingIds.push(threadChannelId);
    } else {
      rwRegular.push(row);
    }
  }

  // Visibility and names for the RW regular threads, authoritative in Postgres
  // and per distinct parent channel. Same rule as the legacy regular query's
  // WHERE: this server, not archived, not deleted, public or a member.
  const parentChannelIds = [...new Set(rwRegular.map((row) => row.parentChannelId!))];
  const parentChannelRows = parentChannelIds.length === 0 ? [] : (await traceQuery(
    "channels.followed_threads.parent_channels",
    () => db.execute(sql`
      SELECT
        c.id::text AS "id",
        c.name AS "name",
        c.type AS "type",
        c.server_id::text AS "serverId",
        c.archived_at AS "archivedAt",
        c.deleted_at AS "deletedAt",
        (ch.user_id IS NOT NULL) AS "member"
      FROM channels c
      LEFT JOIN channel_humans ch
        ON ch.channel_id = c.id
       AND ch.user_id = ${userId}
      WHERE c.id IN (${sql.join(parentChannelIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `),
    (result) => ({ parent_channels_count: parentChannelIds.length, rows_count: result.rows.length }),
  )).rows as Array<{
    id: string;
    name: string;
    type: string;
    serverId: string;
    archivedAt: unknown;
    deletedAt: unknown;
    member: boolean;
  }>;
  const visibleParentById = new Map(
    parentChannelRows
      .filter((channel) => channel.serverId === serverId
        && channel.archivedAt == null
        && channel.deletedAt == null
        && (channel.type === "channel" || channel.member))
      .map((channel) => [channel.id, channel]),
  );
  // A joint thread's parent must be the local joint channel, and (joint channels
  // are not public) the user a member of it: the joint query's local_parent /
  // parent_member rule.
  const rwVisible = rwRegular.filter((row) => {
    const parentChannel = visibleParentById.get(row.parentChannelId!);
    if (!parentChannel) return false;
    return !jointThreadIds.has(row.threadChannelId) || parentChannel.type === "joint";
  });
  const rwThreads: FollowedThreadSourceRow[] = rwVisible.map((row) => {
    const parentChannel = visibleParentById.get(row.parentChannelId!)!;
    return {
      threadChannelId: row.threadChannelId,
      storageThreadChannelId: row.storageThreadChannelId,
      parentMessageId: row.parentMessageId,
      parentChannelId: row.parentChannelId!,
      parentChannelName: parentChannel.name,
      parentChannelType: parentChannel.type,
      parentMessageContent: row.parentMessageContent ?? "",
      parentMessageCreatedAt: new Date(row.parentMessageCreatedAt!),
      parentMessageSenderType: row.parentMessageSenderType ?? "",
      parentMessageSenderId: row.parentMessageSenderId ?? "",
      parentMessageSeq: row.parentMessageSeq,
      taskId: row.taskId,
      taskNumber: row.taskNumber == null ? null : Number(row.taskNumber),
      taskStatus: row.taskStatus,
      taskClaimedByType: row.taskClaimedByType,
      taskClaimedById: row.taskClaimedById,
      doneAt: null,
      unfollowedAt: null,
      activityUpperBoundSeq: null,
    };
  });

  // Threads RW has not caught up with yet (CDC lag, seconds) are left out, not
  // filled from Postgres: they show up on the next read. rw_missing_threads
  // below keeps them visible in traces.
  addTraceEvent("followed_threads.source_selected", {
    followed_threads_source: "rw_v5",
    rw_followed_threads_view: RISINGWAVE_FOLLOWED_THREADS_VIEW,
    followed_threads_count: followedIds.length,
    rw_rows_count: rw.rows.length,
    rw_regular_threads: rwRegular.length,
    rw_hidden_threads: rwRegular.length - rwVisible.length,
    rw_non_regular_threads: nonRegularCount,
    rw_missing_threads: missingIds.length,
    // Which threads (ids only, at most 5), so a late arrival in the view can be
    // traced against the RW and Postgres timelines.
    ...(missingIds.length > 0
      ? { rw_missing_thread_ids: missingIds.slice(0, RW_MISSING_THREAD_IDS_TRACE_CAP).join(",") }
      : {}),
    joint_threads: rwVisible.filter((row) => jointThreadIds.has(row.threadChannelId)).length,
  });

  // Stats: the RW row itself (no second RW read).
  const rwStatsRows: FollowedThreadStatsRow[] = rwVisible.map((row) => ({
    threadChannelId: row.threadChannelId,
    replyCount: row.replyCount,
    lastReplyAt: row.lastReplyAt,
    lastReplyMessageId: row.lastReplyMessageId,
    lastReplySeqExact: row.lastReplySeqExact,
    lastReplyContent: row.lastReplyContent,
    lastReplySenderType: row.lastReplySenderType,
    lastReplySenderId: row.lastReplySenderId,
    firstUnreadMessageId: row.firstUnreadMessageId,
    unreadCount: row.unreadCount,
  }));
  // Read state: the cursor by primary key, plus the RW latest message as the
  // content frontier, through the same snapshot mapping as the authority read
  // (fetchReadStateAuthorityRows).
  const rwThreadIds = rwVisible.map((row) => row.threadChannelId);
  const cursorRows = rwThreadIds.length === 0 ? [] : (await traceQuery(
    "channels.followed_threads.read_cursors",
    () => db.execute(sql`
      SELECT
        channel_id::text AS "channelId",
        read_state_version::int AS "readStateVersion",
        last_read_seq::text AS "maxReadSeq",
        marked_unread AS "markedUnread"
      FROM user_channel_read_cursors
      WHERE user_id = ${userId}
        AND channel_id IN (${sql.join(rwThreadIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `),
    (result) => ({ input_count: rwThreadIds.length, read_cursor_rows_count: result.rows.length }),
  )).rows as Array<{ channelId: string; readStateVersion: number; maxReadSeq: string; markedUnread: boolean }>;
  const cursorByThread = new Map(cursorRows.map((row) => [row.channelId, row]));
  const readStateByThread = new Map<string, ReadStateSnapshot>();
  for (const row of rwVisible) {
    const cursor = cursorByThread.get(row.threadChannelId);
    readStateByThread.set(row.threadChannelId, readStateSnapshotFromAuthorityRow({
      channelId: row.threadChannelId,
      readCursorPresent: cursor !== undefined,
      readStateVersion: cursor?.readStateVersion ?? null,
      maxReadSeq: cursor?.maxReadSeq ?? null,
      markedUnread: cursor?.markedUnread === true,
      latestActivityMessageId: row.lastReplyMessageId,
      latestActivitySeq: row.lastReplySeqExact,
      doneFrontierSeq: row.lastReplySeqExact ?? row.parentMessageSeq,
    }));
  }

  return {
    threads: rwThreads,
    statsRows: rwStatsRows,
    readStateByThread,
  };
}

/** Get all threads a user participates in, with unread counts and parent message info. */
/** The followed threads of a user in a server (the whole list without `opts.page`). */
export async function getFollowedThreads(
  serverId: string,
  userId: string,
  historyCutoff?: Date,
  opts?: FollowedThreadsOptions & { includeTaskConversations?: false },
): Promise<FollowedThread[]> {
  return (await loadFollowedThreads(serverId, userId, historyCutoff, opts)).threads;
}

/**
 * Opaque cursor of the followed-thread pages: the last returned thread's
 * (latestActivitySeq, threadChannelId). Produced only by
 * encodeFollowedThreadsCursor; a client passes it back unchanged.
 */
export type FollowedThreadsCursor = string & { readonly __brand: "FollowedThreadsCursor" };

function encodeFollowedThreadsCursor(seq: bigint, threadChannelId: string): FollowedThreadsCursor {
  return Buffer.from(JSON.stringify({ s: seq.toString(), i: threadChannelId }), "utf8").toString("base64url") as FollowedThreadsCursor;
}

/** Null for anything that is not a cursor this server produced. */
export function parseFollowedThreadsCursor(raw: unknown): FollowedThreadsCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  return decodeFollowedThreadsCursor(raw as FollowedThreadsCursor) ? raw as FollowedThreadsCursor : null;
}

function decodeFollowedThreadsCursor(cursor: FollowedThreadsCursor): { seq: bigint; threadChannelId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { s?: unknown; i?: unknown };
    if (typeof parsed.s !== "string" || !/^\d{1,20}$/.test(parsed.s)) return null;
    if (typeof parsed.i !== "string" || !UUID_RE.test(parsed.i)) return null;
    return { seq: BigInt(parsed.s), threadChannelId: parsed.i };
  } catch {
    return null;
  }
}

/** Newest activity first; the thread id breaks ties so the order is total. */
function compareFollowedThreadOrder(
  a: { seq: bigint; threadChannelId: string },
  b: { seq: bigint; threadChannelId: string },
): number {
  if (a.seq !== b.seq) return a.seq > b.seq ? -1 : 1;
  return a.threadChannelId > b.threadChannelId ? -1 : a.threadChannelId < b.threadChannelId ? 1 : 0;
}

function selectFollowedThreadsPage(
  threads: FollowedThreadSourceRow[],
  statsMap: Map<string, { unreadCount: number; lastReplyMessageId: string | null; lastReplySeqExact: string | null }>,
  opts: FollowedThreadsOptions | undefined,
): { rows: FollowedThreadSourceRow[]; next: FollowedThreadsCursor | null; paged: boolean } {
  let rows = opts?.unreadOnly
    ? threads.filter((thread) => (statsMap.get(thread.threadChannelId)?.unreadCount ?? 0) > 0)
    : threads;
  const page = opts?.page;
  if (!page) return { rows, next: null, paged: false };
  const keyed = rows.map((thread) => ({
    thread,
    key: {
      seq: BigInt(latestActivitySeqSameSource(statsMap.get(thread.threadChannelId), thread.parentMessageSeq) ?? "0"),
      threadChannelId: thread.threadChannelId,
    },
  }));
  keyed.sort((a, b) => compareFollowedThreadOrder(a.key, b.key));
  const after = page.cursor ? decodeFollowedThreadsCursor(page.cursor) : null;
  // Strictly older than the cursor: a thread that got new activity moved to an
  // earlier page and is neither repeated nor skipped.
  const remaining = after ? keyed.filter((entry) => compareFollowedThreadOrder(entry.key, after) > 0) : keyed;
  const limit = Math.max(1, Math.floor(page.limit));
  const taken = remaining.slice(0, limit);
  const last = taken[taken.length - 1];
  rows = taken.map((entry) => entry.thread);
  return {
    rows,
    next: remaining.length > limit && last ? encodeFollowedThreadsCursor(last.key.seq, last.key.threadChannelId) : null,
    paged: true,
  };
}

export async function loadFollowedThreads(
  serverId: string,
  userId: string,
  historyCutoff: Date | undefined,
  opts: FollowedThreadsOptions & { includeTaskConversations: boolean },
): Promise<{ threads: Array<FollowedThread | FollowedTaskConversation>; next: FollowedThreadsCursor | null }>;
export async function loadFollowedThreads(
  serverId: string,
  userId: string,
  historyCutoff?: Date,
  opts?: FollowedThreadsOptions & { includeTaskConversations?: false },
): Promise<{ threads: FollowedThread[]; next: FollowedThreadsCursor | null }>;
export async function loadFollowedThreads(
  serverId: string,
  userId: string,
  historyCutoff?: Date,
  opts?: FollowedThreadsOptions,
): Promise<{ threads: Array<FollowedThread | FollowedTaskConversation>; next: FollowedThreadsCursor | null }> {
  const db = opts?.executor ?? getDb();
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;
  const guestAccess = await guestInboxChannelIds(serverId, userId, db);
  const state = opts?.state ?? "active";
  const ctx: FollowedThreadsQueryContext = { serverId, userId, db, traceQuery, guestAccess, state, opts };

  // Started with the thread read, awaited after it (settled, so a failure never
  // goes unhandled while the thread read is in flight).
  const mentionRead = state === "active"
    ? loadFollowedThreadMentionIds(serverId, userId, traceQuery)
    : Promise.resolve(new Set<string>());
  const legacyReason = followedThreadsLegacyReason(ctx);
  let loaded = legacyReason === null ? await loadActiveFollowedThreadsFromRisingWave(ctx, historyCutoff) : null;
  if (!loaded) {
    addTraceEvent("followed_threads.source_selected", {
      followed_threads_source: "legacy",
      legacy_reason: legacyReason ?? "rw_failed",
    });
    loaded = await loadFollowedThreadsLegacy(ctx, historyCutoff);
  }
  if (opts?.includeTaskConversations) {
    const taskConversations = await loadFollowedTaskConversations(ctx, historyCutoff);
    if (taskConversations.threads.length > 0) {
      loaded = {
        threads: [...loaded.threads, ...taskConversations.threads],
        statsRows: [...loaded.statsRows, ...taskConversations.statsRows],
        readStateByThread: new Map([...loaded.readStateByThread, ...taskConversations.readStateByThread]),
      };
    }
  }
  const { statsRows, readStateByThread } = loaded;
  let threads = loaded.threads;
  const mentionedThreadIds = await mentionRead;
  if (threads.length === 0) return { threads: [], next: null };

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

  // unreadOnly / page: chosen here, before the per-thread enrichment below,
  // so claimant names, external names and the response only cover the page.
  const selection = selectFollowedThreadsPage(threads, statsMap, state === "active" ? opts : undefined);
  threads = selection.rows;
  if (threads.length === 0) return { threads: [], next: selection.next };

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

  const historyCutoffMs = historyCutoff?.getTime();
  const result = threads.map(t => {
    const stats = statsMap.get(t.threadChannelId);
    const readState = readStateByThread.get(t.threadChannelId);
    // Free-plan history cutoff: the counts and lastReplyAt are served as-is (a
    // product decision); the content of a latest reply behind the cutoff is
    // withheld, and a thread start behind it is a 40-character glimpse, the
    // header Activity can't do without (cindyz, task #8).
    const latestReplyBeforeCutoff = historyCutoffMs !== undefined
      && stats?.lastReplyAt != null
      && new Date(stats.lastReplyAt).getTime() <= historyCutoffMs;
    const parentBehindCutoff = historyCutoffMs !== undefined
      && t.parentMessageCreatedAt.getTime() <= historyCutoffMs;
    const parentContent = parentBehindCutoff ? historyLimitedPreview(t.parentMessageContent) ?? "" : t.parentMessageContent;
    const latestActivityContent = latestReplyBeforeCutoff ? "" : stats?.lastReplyContent ?? parentContent;
    return {
      threadChannelId: t.threadChannelId,
      parentMessageId: t.parentMessageId!,
      parentChannelId: t.parentChannelId,
      parentChannelName: t.parentChannelName,
      parentChannelType: t.parentChannelType,
      parentMessagePreview: parentContent.length > 100
        ? parentContent.slice(0, 100) + "…"
        : parentContent,
      parentMessageSenderType: t.parentMessageSenderType,
      parentMessageSenderId: t.parentMessageSenderId,
      parentMessageCreatedAt: t.parentMessageCreatedAt.toISOString(),
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
      hasMention: (stats?.unreadCount ?? 0) > 0 && mentionedThreadIds.has(t.threadChannelId),
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
      // Task v2 (includeTaskConversations): a task conversation row. Its
      // parentMessageId / zero-reply latestActivityMessageId are null.
      ...(t.conversationKind === "task"
        ? {
          kind: "task" as const,
          taskTitle: t.taskTitle ?? "",
          sourceMessageId: t.sourceMessageId ?? null,
          sourceMessageCreatedAt: t.sourceMessageCreatedAt ? t.sourceMessageCreatedAt.toISOString() : null,
        }
        : {}),
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

  if (selection.paged) {
    // A page keeps the cursor order (latestActivitySeq desc, then id desc).
    result.sort((a, b) => compareFollowedThreadOrder(
      { seq: BigInt(a.latestActivitySeq ?? "0"), threadChannelId: a.threadChannelId },
      { seq: BigInt(b.latestActivitySeq ?? "0"), threadChannelId: b.threadChannelId },
    ));
  }
  return { threads: result, next: selection.next };
}

export type InboxFilter = "all" | "unread" | "mentions" | "unread_mentions";

/**
 * Activity row scope. "dms" keeps DMs and threads under DMs; "no_dms" is the
 * exact complement (RFC 074 assistant reads); omitted = everything.
 */
export type InboxScope = "dms" | "no_dms";

export function isDmScopedInboxItem(item: InboxItem): boolean {
  return isSubConversationInboxItem(item) ? item.parentChannelType === "dm" : item.channelType === "dm";
}

function dmScopeSqlPredicate(alias: SQL): SQL {
  return sql`AND (${alias}."channelType" = 'dm' OR (${alias}."kind" IN ('thread', 'task') AND ${alias}."parentChannelType" = 'dm'))`;
}

// Complement of dmScopeSqlPredicate. COALESCE: a NULL type column must count as
// "not a DM" instead of dropping the row through NOT NULL = NULL.
function nonDmScopeSqlPredicate(alias: SQL): SQL {
  return sql`AND NOT COALESCE(${alias}."channelType" = 'dm' OR (${alias}."kind" IN ('thread', 'task') AND ${alias}."parentChannelType" = 'dm'), false)`;
}

function inboxScopeSqlPredicate(scope: InboxScope | undefined, alias: SQL): SQL {
  if (scope === "dms") return dmScopeSqlPredicate(alias);
  if (scope === "no_dms") return nonDmScopeSqlPredicate(alias);
  return sql``;
}

/**
 * Activity "Pinned" scope: the row's group conversation (its own channel, or a
 * thread's or task conversation's parent channel) is one of the user's pinned conversations. The
 * route resolves the pinned channel ids (pinned channels plus the DM of each
 * pinned agent/human peer). SYNC REQUIRED with the RisingWave serving query
 * (pinnedChannelIdsParam) and isPinnedScopedInboxItem (unfollowed merge).
 */
export function isPinnedScopedInboxItem(item: InboxItem, pinnedChannelIds: ReadonlySet<string>): boolean {
  const groupChannelId = item.kind === "thread" || item.kind === "task" ? item.parentChannelId : item.channelId;
  return typeof groupChannelId === "string" && pinnedChannelIds.has(groupChannelId.toLowerCase());
}

function pinnedScopeSqlPredicate(pinnedChannelIds: readonly string[] | undefined, groupChannelId: SQL): SQL {
  if (pinnedChannelIds === undefined) return sql``;
  if (pinnedChannelIds.length === 0) return sql`AND false`;
  return sql`AND (${groupChannelId})::text IN (${sql.join(pinnedChannelIds.map((id) => sql`${id}`), sql`, `)})`;
}

/**
 * Activity rows by their own id (`ids` on the route): a channel/DM row's
 * channelId, a thread/task row's threadChannelId, so a client can refresh a few
 * rows after a sync change. Narrows the selected rows only, like the channel
 * facet (groups and activeUnreadCount stay list-wide). SYNC REQUIRED with the
 * RisingWave serving query (rowIdsParam) and the unfollowed merge.
 */
export function inboxItemRowId(item: InboxItem): string {
  return item.kind === "thread" || item.kind === "task" ? item.threadChannelId : item.channelId;
}

function rowIdsSqlPredicate(rowIds: readonly string[] | undefined, rowId: SQL): SQL {
  if (rowIds === undefined) return sql``;
  if (rowIds.length === 0) return sql`AND false`;
  return sql`AND (${rowId})::text IN (${sql.join(rowIds.map((id) => sql`${id}`), sql`, `)})`;
}

function normalizePinnedChannelIds(ids: readonly string[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined;
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
}

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
  | ThreadInboxItem
  | TaskConversationInboxItem;

export type ThreadInboxItem = {
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


/**
 * Task v2: a task conversation's Activity row (kind "task"). The thread arm's
 * fields (it is a sub-conversation: `threadChannelId` is its LOCAL
 * conversation channel, `parentChannel*` the task's channel), with no parent
 * message (`parentMessageId` null; `parentMessagePreview` is the task title,
 * the parent sender fields are empty) and the task's identity.
 */
export type TaskConversationInboxItem = Omit<ThreadInboxItem, "kind" | "parentMessageId"> & {
  kind: "task";
  parentMessageId: null;
  taskId: string | null;
  taskTitle: string | null;
};

/** A thread or a task conversation row: both are keyed by `threadChannelId`. */
export type SubConversationInboxItem = ThreadInboxItem | TaskConversationInboxItem;

export function isSubConversationInboxItem(item: InboxItem): item is SubConversationInboxItem {
  return isSubConversationInboxKind(item.kind);
}

/** The conversation an Activity row is about: a channel/DM, a thread or a task conversation. */
export function inboxItemScopeChannelId(item: InboxItem): string {
  return isSubConversationInboxItem(item) ? item.threadChannelId : item.channelId;
}

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
    .map((item) => (item.kind === "thread" || item.kind === "task") ? item.threadChannelId : item.channelId)
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
    const scopeId = (item.kind === "thread" || item.kind === "task") ? item.threadChannelId : item.channelId;
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
    row.markedUnread = authority?.markedUnread === true;
    row.readStateActivityMessageId = authority?.latestActivityMessageId ?? null;
    row.readStateActivitySeq = authority?.latestActivitySeq ?? null;
    row.doneFrontierSeq = authority?.doneFrontierSeq ?? null;
  }
}

function inboxScopeIdOfRow(row: InboxPolicySqlRow): string | null {
  const value = (row.kind === "thread" || row.kind === "task") ? row.threadChannelId : row.channelId;
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
       AND c.type NOT IN ('thread', 'task')
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

  const { threads: followedThreads } = await loadFollowedThreads(serverId, userId, historyCutoff, {
    state: "done",
    maxRows: fetchLimit,
    channelId: opts.channelId,
    q: opts.q,
    sort: opts.sort,
    traceQuery,
    // Task v2: a done task conversation is Done history like a done thread.
    includeTaskConversations: true,
  });
  const threadItems = followedThreads.map((thread): InboxItem => "kind" in thread ? {
    ...taskConversationHistoryInboxItem(thread),
    doneAt: thread.doneAt,
    isFollowing: thread.isFollowing,
    unfollowedAt: thread.unfollowedAt,
  } : ({
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
    const aIdentity = `${a.kind}:${(a.kind === "thread" || a.kind === "task") ? a.threadChannelId : a.channelId}`;
    const bIdentity = `${b.kind}:${(b.kind === "thread" || b.kind === "task") ? b.threadChannelId : b.channelId}`;
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
    /** Activity "Pinned" scope: only threads whose parent channel is one of these ids. */
    pinnedChannelIds?: readonly string[];
    q?: string;
    sort?: "asc" | "desc";
    traceQuery?: DbQueryTracer;
    executor?: DatabaseExecutor;
  } = {},
): Promise<{ items: InboxItem[]; hasMore: boolean; totalCount: null }> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const fetchLimit = limit + offset + 1;
  const { threads: followedThreads } = await loadFollowedThreads(serverId, userId, opts.historyCutoff, {
    state: "unfollowed",
    maxRows: fetchLimit,
    channelId: opts.channelId,
    parentChannelIds: opts.pinnedChannelIds,
    q: opts.q,
    sort: opts.sort,
    traceQuery: opts.traceQuery,
    executor: opts.executor,
    includeTaskConversations: true,
  });
  const combined = followedThreads.map(unfollowedThreadInboxItem);
  const page = combined.slice(offset, offset + limit);
  return {
    items: page,
    hasMore: combined.length > offset + limit,
    totalCount: null,
  };
}

type FollowedThreadInboxSource = FollowedThread | FollowedTaskConversation;

/**
 * A followed task conversation as a history Activity row (kind "task"): the
 * thread fields, no parent message, the task's identity. Not read, no unread
 * (history rows); the caller sets the follow/done state.
 */
function taskConversationHistoryInboxItem(thread: FollowedTaskConversation): TaskConversationInboxItem {
  return {
    kind: "task",
    threadChannelId: thread.threadChannelId,
    parentMessageId: null,
    parentChannelId: thread.parentChannelId,
    parentChannelName: thread.parentChannelName,
    parentChannelType: thread.parentChannelType,
    parentMessagePreview: thread.taskTitle,
    parentMessageSenderType: "",
    parentMessageSenderId: "",
    latestActivityPreview: thread.latestActivityPreview,
    latestActivitySenderType: thread.latestActivitySenderType,
    latestActivitySenderId: thread.latestActivitySenderId,
    latestActivitySenderName: thread.latestActivitySenderName,
    latestActivityMessageId: thread.latestActivityMessageId ?? "",
    latestActivitySeq: thread.latestActivitySeq ?? null,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastActivityAt: thread.lastActivityAt,
    lastReplyAt: thread.lastReplyAt,
    replyCount: thread.replyCount,
    unreadCount: 0,
    hasMention: false,
    taskId: thread.taskId,
    taskNumber: thread.taskNumber,
    taskTitle: thread.taskTitle,
    taskStatus: thread.taskStatus,
    taskClaimedByName: thread.taskClaimedByName,
    maxReadSeq: thread.maxReadSeq,
    readStateVersion: thread.readStateVersion,
    readState: thread.readState,
  };
}

function unfollowedThreadInboxItem(thread: FollowedThreadInboxSource): InboxItem {
  if ("kind" in thread) {
    return {
      ...taskConversationHistoryInboxItem(thread),
      doneAt: null,
      isFollowing: false,
      unfollowedAt: thread.unfollowedAt,
    };
  }
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
  const { threads } = await loadFollowedThreads(serverId, userId, opts.historyCutoff, {
    state: "unfollowed_active",
    channelId: opts.channelId,
    q: opts.q,
    sort: opts.sort,
    traceQuery: opts.traceQuery,
    executor: opts.executor,
    includeTaskConversations: true,
  });
  return threads.map((thread) => ({
    ...unfollowedThreadInboxItem(thread),
    // The active All row needs follow state for controls, not a terminal
    // history timestamp. Keeping this absent also prevents label projection.
    unfollowedAt: null,
  }));
}

type InboxQueryResult = { rows: QueryResultRow[]; contractVersion?: number };
/** The RW Activity read, with the conversations it found marked unread (loadMarkedUnreadScopes). */
type RisingWaveInboxQueryResult = InboxQueryResult & { markedScopeIds: ReadonlySet<string> };

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

/** pg_legacy: the canonical inline Postgres read (search, guest, authority transactions). */
type InboxTraceBackend = "rw_mv" | "pg_legacy";
type InboxTraceRoute = RisingWaveInboxTraceRoute;
// RisingWave is a hard dependency, so no inbox read is ever a fallback. The
// trace key stays for the consumed trace contract.
type InboxFallbackReason = "none";
type InboxTraceNegativeEvidenceBucket =
  | "does_not_prove_fact_recorded_or_ui_rendered"
  | "does_not_prove_fact_absent_or_message_ineligible"
  | "does_not_prove_future_message_suppression";

type InboxBackendSelection = {
  backend: InboxTraceBackend;
  fallbackReason: InboxFallbackReason;
  contractVersion?: number;
};
// Test seam: pool/query injection ONLY. It carries no routing or fallback
// semantics — those died with the fail-soft teardown (2026-09-21) and must
// not grow back here.
let risingWaveInboxTestOverrides: {
  getPool?: typeof getRisingWavePool;
  query?: typeof queryRisingWave;
} = {};

export const __testRisingWaveInbox = {
  set(overrides: typeof risingWaveInboxTestOverrides) {
    risingWaveInboxTestOverrides = { ...risingWaveInboxTestOverrides, ...overrides };
  },
  reset() {
    risingWaveInboxTestOverrides = {};
  },
};

function getRisingWaveInboxPool() {
  return (risingWaveInboxTestOverrides.getPool ?? getRisingWavePool)();
}

function queryRisingWaveInbox<T extends QueryResultRow = QueryResultRow>(
  pool: NonNullable<ReturnType<typeof getRisingWavePool>>,
  queryText: UnifiedChainQuery,
  values?: unknown[],
) {
  // TRANSITION: a missing current view is read from the newest older generation.
  return withUnifiedChainTransition(
    queryText,
    (text) => (risingWaveInboxTestOverrides.query ?? queryRisingWave)<T>(pool, text, values),
    (missingViews, readViews) => addTraceEvent("inbox.rw.unified_chain_view_fallback", {
      backend: "risingwave",
      missing_views: missingViews.join(","),
      fallback_views: readViews.join(","),
    }),
  );
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
    // db_system follows the backend. Without this, successful RW reads land as
    // db_system=postgresql (the shared route tracer's default — one tracer
    // instance serves both PG and RW queries in a request, so the per-call
    // attrs are the only place the backend is known). Failures already set
    // db_system=risingwave via risingWaveInboxFailureAttrs; during the
    // 2026-09-19 incident this asymmetry made "successes counted by
    // db_system=risingwave" structurally zero regardless of path health.
    "db.system": backend === "rw_mv" ? "risingwave" : "postgresql",
    db_system: backend === "rw_mv" ? "risingwave" : "postgresql",
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

// Activity "DMs" scope: DMs plus threads whose parent is a DM. Applied before
// groups, totals and the active unread count so every number on the page is
// computed within the scope. SYNC REQUIRED with dmScopeSqlPredicate (canonical
// Postgres) and isDmScopedInboxItem (unfollowed-thread merge).
const RISINGWAVE_DM_SCOPE_PREDICATE =
  "(i.channel_type = 'dm' OR (i.kind IN ('thread', 'task') AND i.parent_channel_type = 'dm'))";

function buildRisingWaveInboxItemsServingQuery(
  limit: number,
  offset: number,
  version = getRisingWaveInboxItemsServingVersion(),
  opts: {
    includeMentionOnlyInAllAndUnread?: boolean;
    sort?: "asc" | "desc";
    servingViewOverride?: string;
    /**
     * The serving view carries first_mention_message_id / mention_done_through_seq
     * (rw_inbox_serving_v9 only; the transition fallback's older generations do
     * not, and read NULL).
     */
    carriesFirstMention?: boolean;
    /** Bind index (varchar[]): only rows whose group channel is one of these (Pinned scope). */
    pinnedChannelIdsParam?: number;
    /** Bind index (varchar[]): only rows whose own id is one of these (`ids`); narrows the selection, not groups. */
    rowIdsParam?: number;
    /** Bind index (varchar[]): thread rows below these parents are left out of rows, groups and totals. */
    excludeThreadParentsParam?: number;
    /**
     * Bind index (varchar[]): conversations marked unread (no count). The Unread
     * filter lists them too; they add a row to its totals and 0 to its counts.
     */
    markedScopeIdsParam?: number;
  } = {},
) {
  const sortDirection = opts.sort === "asc" ? "ASC" : "DESC";
  // Defaults to the unified chain now that Stage 3 is complete. The override
  // exists for parity scripts that still want to name a view explicitly.
  const inboxItems = opts.servingViewOverride ?? UNIFIED_CHAIN_VIEWS.serving;
  // 063 Stage 3: v4 is receiver-keyed. Derive the key expression from the view
  // actually being queried rather than from the flag, so the predicate can
  // never disagree with the FROM clause.
  const receiverKeyed = RECEIVER_KEYED_SERVING_VIEWS.has(inboxItems);
  const inboxReceiverExpr = receiverKeyed ? "i.receiver_id" : "i.user_id";
  // Non-empty ONLY in the receiver-keyed shape: v3 has no receiver_type column,
  // so emitting this against v3 would be a hard SQL error rather than a wrong
  // answer -- which is the failure mode we want if these two ever drift apart.
  const receiverTypePredicate = receiverKeyed ? "AND i.receiver_type = 'user'" : "";
  const mentionOnlyExpr = "i.mention_only";
  // v5 and later serving views carry the latest activity seq as a column. Earlier views need it looked
  // up in rw_messages by id -- a random point read that, cold in the block cache,
  // cost seconds per page (the Activity tail of 2026-09-25).
  const carriesActivitySeq = inboxItems === UNIFIED_CHAIN_VIEWS.serving;
  const latestActivitySeqExpr = carriesActivitySeq ? "i.latest_activity_seq" : "latest_activity.seq";
  const latestActivityJoin = carriesActivitySeq
    ? ""
    : `LEFT JOIN rw_messages latest_activity
        ON latest_activity.id = i.latest_activity_message_id`;
  // A member row's anchor is the view's; a mention-only row's is resolved for
  // the page (resolveRisingWaveMentionOnlyAnchors) from mentionDoneThroughSeq.
  const firstMentionExpr = opts.carriesFirstMention ? "i.first_mention_message_id" : "NULL::varchar";
  const mentionDoneThroughSeqExpr = opts.carriesFirstMention ? "i.mention_done_through_seq" : "NULL::bigint";
  const filterMentionOnlyPredicate = opts.includeMentionOnlyInAllAndUnread
    ? ""
    : `AND (
          $3::text = 'mentions'
          OR ${mentionOnlyExpr} = false
        )`;
  const activeMentionOnlyPredicate = opts.includeMentionOnlyInAllAndUnread
    ? ""
    : `AND ${mentionOnlyExpr} = false`;
  // Parents the receiver can no longer see (getInboxItemsFromRisingWave checks
  // them in Postgres). A NULL parent compares unknown and is kept.
  const excludedThreadParentPredicate = opts.excludeThreadParentsParam
    ? `AND (i.kind NOT IN ('thread', 'task') OR NOT COALESCE(i.parent_channel_id = ANY($${opts.excludeThreadParentsParam}::varchar[]), false))`
    : "";
  // Activity "Pinned" scope. SYNC REQUIRED with pinnedScopeSqlPredicate
  // (canonical Postgres) and isPinnedScopedInboxItem (unfollowed merge).
  const pinnedScopePredicate = opts.pinnedChannelIdsParam
    ? `AND COALESCE((CASE WHEN i.kind IN ('thread', 'task') THEN i.parent_channel_id ELSE i.channel_id END) = ANY($${opts.pinnedChannelIdsParam}::varchar[]), false)`
    : "";
  // `ids`. SYNC REQUIRED with rowIdsSqlPredicate (canonical Postgres) and the unfollowed merge.
  const rowIdsPredicate = opts.rowIdsParam
    ? `AND COALESCE((CASE WHEN "kind" IN ('thread', 'task') THEN "threadChannelId" ELSE "channelId" END) = ANY($${opts.rowIdsParam}::varchar[]), false)`
    : "";
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
    WITH filtered AS (
      SELECT
        i.kind AS "kind",
        i.channel_id AS "channelId",
        i.channel_name AS "channelName",
        i.channel_type AS "channelType",
        i.last_message_id AS "lastMessageId",
        i.first_unread_message_id AS "firstUnreadMessageId",
        -- A mention-only row (a mention where nothing else is unread) has no
        -- latest message: its time is the mention's, which only activity_at carries.
        COALESCE(i.last_message_at, i.activity_at) AS "lastMessageAtRaw",
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
        ${latestActivitySeqExpr}::text AS "latestActivitySeq",
        COALESCE(i.last_activity_at, i.activity_at) AS "lastActivityAtRaw",
        i.last_reply_at AS "lastReplyAtRaw",
        i.reply_count::int AS "replyCount",
        i.task_number AS "taskNumber",
        i.task_status AS "taskStatus",
        i.task_claimed_by_type AS "taskClaimedByType",
        i.task_claimed_by_id AS "taskClaimedById",
        NULL::text AS "taskClaimedByName",
        i.has_mention AS "hasMention",
        ${firstMentionExpr} AS "firstMentionMessageId",
        ${mentionDoneThroughSeqExpr} AS "mentionDoneThroughSeq",
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
        ON cursor_v2.user_id = ${inboxReceiverExpr}
       AND cursor_v2.channel_id = COALESCE(i.channel_id, i.thread_channel_id)
      ${latestActivityJoin}
      WHERE i.server_id = $1
        AND ${inboxReceiverExpr} = $2
        ${receiverTypePredicate}
        AND ($3::text <> 'all' OR i.kind IN ('thread', 'task') OR i.channel_type IN ('channel', 'private', 'joint', 'dm'))
        AND (
          ($3::text = 'all')
          OR ($3::text = 'unread' AND (i.unread_count > 0${opts.markedScopeIdsParam
            ? ` OR COALESCE(COALESCE(i.channel_id, i.thread_channel_id) = ANY($${opts.markedScopeIdsParam}::varchar[]), false)`
            : ""}))
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
        AND (COALESCE($7::text, '') <> 'dms' OR ${RISINGWAVE_DM_SCOPE_PREDICATE})
        AND (COALESCE($7::text, '') <> 'no_dms' OR NOT COALESCE(${RISINGWAVE_DM_SCOPE_PREDICATE}, false))
        ${pinnedScopePredicate}
        ${excludedThreadParentPredicate}
    ),
    faceted AS (
      SELECT
        filtered.*,
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelId" ELSE "channelId" END AS "groupChannelId",
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelName" ELSE "channelName" END AS "groupChannelName",
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelType" ELSE "channelType" END AS "groupChannelType"
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
      WHERE ($5::text IS NULL OR "groupChannelId" = $5::text)
        ${rowIdsPredicate}
    ),
    active_totals AS (
      SELECT
        COALESCE(sum(CASE WHEN ${mentionOnlyExpr} THEN 0 ELSE i.unread_count END), 0)::int AS "activeUnreadCount"
      FROM ${inboxItems} i
      WHERE i.server_id = $1
        AND ${inboxReceiverExpr} = $2
        ${receiverTypePredicate}
        AND (i.kind IN ('thread', 'task') OR i.channel_type IN ('channel', 'private', 'joint', 'dm'))
        AND ($4::timestamptz IS NULL OR i.activity_at > $4::timestamptz)
        AND (COALESCE($7::text, '') <> 'dms' OR ${RISINGWAVE_DM_SCOPE_PREDICATE})
        AND (COALESCE($7::text, '') <> 'no_dms' OR NOT COALESCE(${RISINGWAVE_DM_SCOPE_PREDICATE}, false))
        ${pinnedScopePredicate}
        ${activeMentionOnlyPredicate}
        ${excludedThreadParentPredicate}
    ),
    -- Every thread parent this receiver's rows hang below, whatever the filter,
    -- so one Postgres check covers the rows, the groups and both totals.
    thread_parents AS (
      SELECT array_agg(DISTINCT i.parent_channel_id) AS "threadParentChannelIds"
      FROM ${inboxItems} i
      WHERE i.server_id = $1
        AND ${inboxReceiverExpr} = $2
        ${receiverTypePredicate}
        AND i.kind IN ('thread', 'task')
        AND i.parent_channel_id IS NOT NULL
        AND ($4::timestamptz IS NULL OR i.activity_at > $4::timestamptz)
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
        p."firstMentionMessageId"::text AS "firstMentionMessageId",
        p."mentionDoneThroughSeq"::text AS "mentionDoneThroughSeq",
        -- For resolveRisingWaveMentionOnlyAnchors only. Not "mentionOnly": the
        -- shared result mapper reads that name, and the RW path never fed it.
        p."mentionOnly" AS "servedMentionOnly",
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
      thread_parents."threadParentChannelIds"
    FROM totals
    CROSS JOIN active_totals
    CROSS JOIN group_totals
    CROSS JOIN thread_parents
    LEFT JOIN page_enriched ON true
    ORDER BY page_enriched."activityAt" ${sortDirection} NULLS LAST,
      page_enriched."kind" ${sortDirection},
      COALESCE(page_enriched."threadChannelId", page_enriched."channelId") ${sortDirection}
  `;
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
    scope?: InboxScope;
    /** Pinned scope: only rows whose group channel is one of these ids. */
    pinnedChannelIds?: readonly string[];
    /** `ids`: only rows whose own id is one of these. */
    rowIds?: readonly string[];
    historyCutoff?: Date;
    includeMentionOnlyInAllAndUnread?: boolean;
    sort?: "asc" | "desc";
    servingVersion?: RisingWaveInboxItemsServingVersion;
    requestedServingVersion?: RisingWaveInboxItemsServingVersion;
    traceQuery: DbQueryTracer;
    executor?: DatabaseExecutor;
  },
): Promise<RisingWaveInboxQueryResult> {
  const client = getRisingWaveInboxPool();
  // CONTRACT: RisingWave is required. Unconfigured or a failed read throws;
  // there is no Postgres fallback. SYNC REQUIRED: error behavior changes here
  // must be reflected in tracing expectations and parity verification.
  if (!client) throw new RisingWaveNotConfiguredError("Activity items");

  const pageLimit = Math.trunc(opts.limit + 1);
  // Bounded here too, for every caller: an offset past bigint fails the
  // statement at prepare (offset=1e20, 11-04 10:24Z).
  const pageOffset = Math.min(Math.trunc(opts.offset), Number.MAX_SAFE_INTEGER);
  const inboxItemsVersion = opts.servingVersion ?? getRisingWaveInboxItemsServingVersion();
  const requestedInboxItemsVersion = opts.requestedServingVersion ?? inboxItemsVersion;
  const versionForceReason = requestedInboxItemsVersion === 3 && inboxItemsVersion === 2
    ? "history_cutoff"
    : "none";
  if (opts.historyCutoff && inboxItemsVersion !== 2) {
    throw new Error(`RisingWave inbox serving version ${inboxItemsVersion} does not support a history cutoff`);
  }
  // 063 Stage 3 is complete: Activity serves only from the receiver-keyed
  // unified chain. The per-server Feature Flag that ramped it is gone, so the
  // rollback for this read is a deploy revert, not a flag flip -- the v3 objects
  // outlive this commit by design and are dropped in a later, separate batch.
  const servingView = UNIFIED_CHAIN_VIEWS.serving;
  // Limit/offset are clamped by getInboxItems before this point and truncated
  // again here. Keep them as SQL literals because RisingWave does not accept
  // bound parameters in LIMIT/OFFSET in this shared serving query shape.
  const queryParams: unknown[] = [serverId, userId, opts.filter, opts.historyCutoff ?? null, opts.channelId ?? null, opts.q ?? null, opts.scope ?? null];
  // The serving-view attributes below only become queryable once ScopeDB has
  // matching typed columns (its row builder promotes an allowlist and silently
  // drops everything else). The query name IS already a typed column, so during
  // the ramp we also distinguish the chain there: that makes liveness queryable
  // on the day of the hotfix rather than after a schema change. It deliberately
  // splits the metric series while the flag is ramping - that separation is the
  // point, and it disappears when the flag reaches 100% and the branch is
  // deleted.
  // Optional array binds take the next free index, in this order, only when
  // present ($8 pinned ids, then the row ids, then the excluded thread parents,
  // then the conversations marked unread for the Unread filter).
  const pinnedChannelIds = opts.pinnedChannelIds ? [...opts.pinnedChannelIds] : undefined;
  const rowIds = opts.rowIds ? [...opts.rowIds] : undefined;
  // Marked unread (no count): stamped on the page's rows, and listed by the Unread filter.
  const markedScopeIds = new Set((await loadMarkedUnreadScopes(serverId, userId, opts.traceQuery, opts.executor ?? getDb())).keys());
  const markedForFilter = opts.filter === "unread" && markedScopeIds.size > 0 ? [...markedScopeIds] : undefined;
  // Whether the last read answered from rw_inbox_serving_v9 (the generation
  // with the first-mention columns), not a transition fallback.
  let servedFirstMention = false;
  const readPage = (excludedThreadParentIds: readonly string[]) => {
    const params = [...queryParams];
    const bind = (value: unknown) => params.push(value);
    const pinnedChannelIdsParam = pinnedChannelIds ? bind(pinnedChannelIds) : undefined;
    const rowIdsParam = rowIds ? bind(rowIds) : undefined;
    const excludeThreadParentsParam = excludedThreadParentIds.length > 0 ? bind([...excludedThreadParentIds]) : undefined;
    const markedScopeIdsParam = markedForFilter ? bind(markedForFilter) : undefined;
    // The transition builds the text once per generation it tries; the last
    // build is the one that answered.
    const query = (resolved: (view: string) => string) => {
      servedFirstMention = resolved(servingView) === UNIFIED_CHAIN_VIEWS.serving;
      return buildRisingWaveInboxItemsServingQuery(pageLimit, pageOffset, inboxItemsVersion, {
        includeMentionOnlyInAllAndUnread: opts.includeMentionOnlyInAllAndUnread,
        sort: opts.sort,
        servingViewOverride: servingView,
        carriesFirstMention: servedFirstMention,
        pinnedChannelIdsParam,
        rowIdsParam,
        excludeThreadParentsParam,
        markedScopeIdsParam,
      });
    };
    return opts.traceQuery(
      "channels.inbox_items_by_user",
      () => queryRisingWaveInbox(client, query, params),
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
        rw_inbox_items_version_forced: versionForceReason !== "none",
        rw_inbox_items_version_force_reason: versionForceReason,
        rw_inbox_visibility_v3_flag_enabled: requestedInboxItemsVersion === 3,
        // 061 Stage 2: the serving view is no longer implied by the version -
        // Still reported explicitly rather than hardcoded at the call site: the
        // value a trace carries should be the view that was queried, so a future
        // swap shows up here instead of hiding behind a literal.
        rw_inbox_items_serving_view: servingView,
        rw_inbox_items_derivation_chain: false,
        // The flag is evaluated per server, so a server-gated rollout can only be
        // compared against its control group if the serving event carries the
        // dimension it was gated on. Nothing else on this event family does.
        // The key must be exactly `server_id`: the ScopeDB row builder promotes
        // only allowlisted attribute names into typed columns
        // (PROMOTED_IDENTITY_ATTRS in shared/tracing/eventRows.ts), and anything
        // else is dropped on that sink - a dotted key would be silently lost.
        server_id: serverId,
        filter: opts.filter,
        limit: opts.limit,
        offset: opts.offset,
        history_cutoff_present: Boolean(opts.historyCutoff),
        channel_id_present: Boolean(opts.channelId),
        query_present: Boolean(opts.q),
        scope: pinnedChannelIds ? "pinned" : opts.scope ?? "all",
        ...(pinnedChannelIds ? { pinned_channel_count: pinnedChannelIds.length } : {}),
        ...(rowIds ? { row_id_count: rowIds.length } : {}),
        row_count: queryRead.result.rows.length,
        excluded_thread_parent_count: excludedThreadParentIds.length,
      }),
      (error) => risingWaveInboxFailureAttrs({
        route: opts.filter,
        error,
        contractVersion: inboxItemsVersion,
        queryName: "channels.inbox_items_by_user",
      }),
    );
  };
  // Threads below a parent the receiver can no longer see (archived, deleted,
  // or a non-public parent they left) stay in the serving views until 077's
  // parent condition is built everywhere. Check the parents in Postgres, after
  // whichever view generation answered, and in the rare case one fails, read
  // again with those parents excluded in SQL so rows, groups, page size and
  // totals all agree. Redundant once 077 serves.
  let read = await readPage([]);
  const invisibleParents = await findInvisibleThreadParentChannelIds(
    userId,
    read.result.rows[0]?.threadParentChannelIds,
    opts.traceQuery,
    opts.executor ?? getDb(),
  );
  if (invisibleParents.length > 0) {
    addTraceEvent("inbox.rw.invisible_thread_parents_excluded", {
      ...inboxTraceAttrs("rw_mv", opts.filter, "none", inboxItemsVersion),
      server_id: serverId,
      excluded_thread_parent_count: invisibleParents.length,
    });
    read = await readPage(invisibleParents);
  }
  if (servedFirstMention) {
    await resolveRisingWaveMentionOnlyAnchors(client, userId, read.result.rows, opts.traceQuery);
  }
  recordRisingWaveInboxThreadReplyCountNullContractViolation(read.result.rows, {
    filter: opts.filter,
    servedVersion: inboxItemsVersion,
    servingView,
    requestedVersion: requestedInboxItemsVersion,
    forcedV2ForHistoryCutoff: versionForceReason === "history_cutoff",
    historyCutoff: Boolean(opts.historyCutoff),
  });
  return { rows: read.result.rows, contractVersion: inboxItemsVersion, markedScopeIds };
}

type RisingWaveMentionOnlyAnchorRow = {
  servedMentionOnly?: unknown;
  channelId?: unknown;
  threadChannelId?: unknown;
  mentionDoneThroughSeq?: unknown;
  firstMentionMessageId?: unknown;
  firstUnreadMessageId?: unknown;
};

/**
 * The first-mention anchor of the page's mention-only rows, in one RisingWave
 * read (none when the page has no such row). rw_inbox_serving_v9 carries a
 * member row's anchor (the lowest-seq notifying mention after the read cursor,
 * from rw_inbox_mention_v7) and leaves a mention-only row's NULL: as in the
 * Postgres has_mention lateral, a mention-only row's anchor ignores the read
 * cursor (it opens the @ even once read) and respects Done, i.e. the lowest-seq
 * mention of the user that notifies (notifiable at send, or notified later)
 * after the row's mention suppression position (mentionDoneThroughSeq). Like
 * Postgres, the row's firstUnreadMessageId is that anchor too.
 * The conversation is matched through its storage, as rw_inbox_mention_v7 maps
 * a mention to its targets: a joint projection's mentions are those in its
 * canonical storage or any active sibling projection. Served by
 * idx_rw_message_mentions_v2_inbox (target_type, target_id, channel_id, ...).
 * Fills the rows in place.
 */
async function resolveRisingWaveMentionOnlyAnchors(
  client: NonNullable<ReturnType<typeof getRisingWavePool>>,
  userId: string,
  rows: readonly RisingWaveMentionOnlyAnchorRow[],
  traceQuery: DbQueryTracer,
): Promise<void> {
  const targets = rows.flatMap((row) => {
    if (row.servedMentionOnly !== true) return [];
    const targetId = typeof row.channelId === "string" ? row.channelId
      : typeof row.threadChannelId === "string" ? row.threadChannelId
        : null;
    if (targetId === null) return [];
    const doneThroughSeq = typeof row.mentionDoneThroughSeq === "string" || typeof row.mentionDoneThroughSeq === "number"
      ? BigInt(row.mentionDoneThroughSeq)
      : 0n;
    return [{ row, targetId, doneThroughSeq }];
  });
  if (targets.length === 0) return;
  // One row per conversation of the page: each target's own Done position goes in
  // as a parallel array (RW 3.0.3 has no multi-argument unnest; WITH ORDINALITY
  // plus a subscript pairs them), and the anchor is aggregated in SQL, so the read
  // returns at most the page's mention-only rows however many mentions the user has.
  const byTarget = new Map(targets.map((target) => [target.targetId, target] as const));
  const targetIds = [...byTarget.keys()];
  const doneThroughSeqs = targetIds.map((targetId) => byTarget.get(targetId)!.doneThroughSeq.toString());
  const minDoneThroughSeq = targets.reduce((min, target) => target.doneThroughSeq < min ? target.doneThroughSeq : min, targets[0]!.doneThroughSeq);
  const read = await traceQuery(
    "channels.inbox_mention_only_anchors",
    () => queryRisingWaveInbox<{ target_id: string; message_id: string | null }>(client, `
      WITH proj AS (
        SELECT s.local_channel_id, j.canonical_channel_id
        FROM rw_joint_channel_servers AS s
        JOIN rw_joint_channels AS j ON j.id = s.joint_channel_id
        WHERE s.status = 'active' AND j.status = 'active'
      ), req AS (
        SELECT t.target_id, ($3::bigint[])[CAST(t.ord AS INT)] AS done_through_seq
        FROM unnest($2::varchar[]) WITH ORDINALITY AS t(target_id, ord)
      ), targets AS (
        SELECT r.target_id, r.done_through_seq, COALESCE(p.canonical_channel_id, r.target_id) AS storage_id
        FROM req AS r
        LEFT JOIN proj AS p ON p.local_channel_id = r.target_id
      ), storage_channels AS (
        SELECT storage_id AS channel_id FROM targets
        UNION
        SELECT p.local_channel_id FROM proj AS p JOIN targets AS t ON p.canonical_channel_id = t.storage_id
      ), mm AS (
        SELECT CAST(m.message_id AS VARCHAR) AS message_id, m.message_seq,
               COALESCE(pj.canonical_channel_id, m.channel_id) AS storage_id
        FROM rw_message_mentions_v2 AS m
        LEFT JOIN proj AS pj ON pj.local_channel_id = m.channel_id
        WHERE m.target_type = 'user'
          AND m.target_id = $1
          AND m.channel_id IN (SELECT channel_id FROM storage_channels)
          AND (m.notifiable_at_send OR m.notified_at IS NOT NULL)
          AND m.message_seq > $4::bigint
      )
      SELECT t.target_id, first_value(mm.message_id ORDER BY mm.message_seq) AS message_id
      FROM targets AS t
      JOIN mm ON mm.storage_id = t.storage_id AND mm.message_seq > t.done_through_seq
      GROUP BY t.target_id
    `, [userId, targetIds, doneThroughSeqs, minDoneThroughSeq.toString()]),
    (queryRead) => ({
      backend: "risingwave",
      db_system: "risingwave",
      target_count: targetIds.length,
      row_count: queryRead.result.rows.length,
      "rw.acquire_wait_ms": Math.round(queryRead.acquireWaitMs),
      "rw.pool.total_count": queryRead.poolState.rw_pool_total,
      "rw.pool.idle_count": queryRead.poolState.rw_pool_idle,
      "rw.pool.waiting_count": queryRead.poolState.rw_pool_waiting,
    }),
    // A failed read (connection timeout, overload) is the case to diagnose.
    () => ({ backend: "risingwave", db_system: "risingwave" }),
  );
  const anchors = new Map(read.result.rows.map((row) => [row.target_id, row.message_id] as const));
  for (const target of targets) {
    const messageId = anchors.get(target.targetId) ?? null;
    target.row.firstMentionMessageId = messageId;
    target.row.firstUnreadMessageId = messageId;
  }
}

/**
 * The thread parents among `parentChannelIds` that `userId` cannot see, by the
 * rule the Postgres Activity read and 077's rw_inbox_items_v12 apply: a thread
 * shows only below a live, unarchived parent that is public or has the user as
 * a member. Ids that are not UUIDs or not found count as not visible.
 * Human receivers only: membership is channel_humans. An agent read would need
 * channel_agents, or every private parent would count as not visible.
 */
async function findInvisibleThreadParentChannelIds(
  userId: string,
  parentChannelIds: unknown,
  traceQuery: DbQueryTracer,
  db: DatabaseExecutor,
): Promise<string[]> {
  if (!Array.isArray(parentChannelIds)) return [];
  const candidates = [...new Set(parentChannelIds.filter((id): id is string => typeof id === "string"))];
  if (candidates.length === 0) return [];
  const uuidCandidates = candidates.filter((id) => UUID_TEXT_RE.test(id));
  const visible = new Set<string>();
  if (uuidCandidates.length > 0) {
    const rows = await traceQuery(
      "channels.inbox_thread_parent_visibility",
      () => db
        .select({ id: channels.id })
        .from(channels)
        .leftJoin(channelHumans, and(eq(channelHumans.channelId, channels.id), eq(channelHumans.userId, userId)))
        .where(and(
          inArray(channels.id, uuidCandidates),
          isNull(channels.deletedAt),
          isNull(channels.archivedAt),
          or(eq(channels.type, "channel"), isNotNull(channelHumans.userId)),
        )),
      (result) => ({ input_count: uuidCandidates.length, result_count: result.length }),
    );
    for (const row of rows) visible.add(row.id.toLowerCase());
  }
  return candidates.filter((id) => !visible.has(id.toLowerCase()));
}

/**
 * Task v2: the task behind each task-conversation row (kind "task") of a page,
 * by its conversation channel (channels.task_id), in one primary-key read.
 * Neither backend carries the task's id or title (the RisingWave serving
 * columns are those of the generation it replaces, so the transition fallback
 * stays a rename); the number / status / claimant are filled when the backend
 * left them NULL (the Postgres read joins tasks by parent message only).
 * Runs before enrichInboxRowsWithProfileNames, which resolves the claimant's
 * name.
 */
/** The fields of an Activity page row this enrichment reads and fills; the
 *  rows carry more, which it leaves alone. */
type InboxRowTaskIdentity = {
  kind?: unknown;
  threadChannelId?: unknown;
  taskId?: string | null;
  taskTitle?: string | null;
  taskNumber?: number | null;
  taskStatus?: string | null;
  taskClaimedByType?: string | null;
  taskClaimedById?: string | null;
  taskClaimedByName?: string | null;
};

async function enrichInboxRowsWithTaskIdentity(
  rows: InboxRowTaskIdentity[],
  traceQuery: DbQueryTracer,
  executor: DatabaseExecutor = getDb(),
): Promise<void> {
  const conversationIds = [...new Set(rows
    .filter((row) => row.kind === "task" && typeof row.threadChannelId === "string" && UUID_TEXT_RE.test(row.threadChannelId))
    .map((row) => row.threadChannelId as string))];
  if (conversationIds.length === 0) return;
  const taskRows = await traceQuery(
    "channels.inbox_task_conversations",
    () => executor
      .select({
        conversationId: channels.id,
        taskId: tasks.id,
        taskNumber: tasks.taskNumber,
        title: tasks.title,
        status: tasks.status,
        claimedByType: tasks.claimedByType,
        claimedById: tasks.claimedById,
      })
      .from(channels)
      .innerJoin(tasks, eq(tasks.id, channels.taskId))
      .where(inArray(channels.id, conversationIds)),
    (result) => ({ input_count: conversationIds.length, result_count: result.length }),
  );
  const byConversation = new Map(taskRows.map((row) => [row.conversationId, row]));
  for (const row of rows) {
    if (row.kind !== "task") continue;
    const task = typeof row.threadChannelId === "string" ? byConversation.get(row.threadChannelId) : undefined;
    row.taskId = task?.taskId ?? null;
    row.taskTitle = task?.title ?? null;
    if (!task) continue;
    if (row.taskNumber == null) row.taskNumber = task.taskNumber;
    if (row.taskStatus == null) row.taskStatus = task.status;
    if (row.taskClaimedById == null && row.taskClaimedByName == null) {
      row.taskClaimedByType = task.claimedByType;
      row.taskClaimedById = task.claimedById;
    }
  }
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

export async function getActivityUnreadTotalsBatch(
  inputs: ActivityUnreadTotalsBatchInput[],
  userId: string,
  opts: {
    traceQuery?: DbQueryTracer;
  } = {},
): Promise<Map<string, ActivityUnreadTotals>> {
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const uniqueInputs = [...new Map(inputs.map((input) => [input.serverId, input])).values()];
  if (uniqueInputs.length === 0) return new Map();
  const override = getActivityReadSourceOverride();
  if (override) return override.activityUnreadTotals(uniqueInputs, userId, { traceQuery });
  // Totals come from the SAME materialized view family as the Activity list —
  // one source, watermark included, so the historical cross-surface divergence
  // (task #235) cannot exist. RisingWave is required: unconfigured or a failed
  // read throws (no Postgres fallback, no fail-closed absence).
  return getActivityUnreadTotalsBatchFromRisingWave(
    uniqueInputs.map((input) => input.serverId),
    userId,
    traceQuery,
  );
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

function inboxTargetTraceJoinKey(receiverType: "user" | "agent", receiverId: string, sourceChannelId: string) {
  return `${receiverType}:${receiverId}:${sourceChannelId}`;
}

export type ActivityUnreadTotals = {
  totalUnreadCount: number;
  activeUnreadCount: number;
};

export type ActivityUnreadTotalsBatchInput = {
  serverId: string;
  historyCutoff?: Date;
};

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

function recordRisingWaveInboxThreadReplyCountNullContractViolation(
  rows: readonly RisingWaveInboxThreadReplyCountContractRow[],
  opts: {
    filter: InboxFilter;
    servedVersion: RisingWaveInboxItemsServingVersion;
    requestedVersion: RisingWaveInboxItemsServingVersion;
    forcedV2ForHistoryCutoff: boolean;
    historyCutoff: boolean;
    servingView?: string;
  },
) {
  const nullThreadReplyCountRows = rows.filter((row) =>
    isSubConversationInboxKind(row.kind) && row.replyCount == null
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
    rw_inbox_items_serving_view: opts.servingView ?? UNIFIED_CHAIN_VIEWS.serving,
    history_cutoff_present: opts.historyCutoff,
    rows_count: rows.length,
    null_thread_reply_count_rows: nullThreadReplyCountRows,
  });
}

async function getActivityUnreadTotalsBatchFromRisingWave(
  serverIds: string[],
  userId: string,
  traceQuery: DbQueryTracer,
): Promise<Map<string, ActivityUnreadTotals>> {
  const client = getRisingWaveInboxPool();
  if (!client) throw new RisingWaveNotConfiguredError("Activity unread totals");
  // Point lookup on the totals MV stacked on the serving view: every serving
  // predicate (mention-only zeroing, target kinds, watermark, free-tier
  // cutoff) is inherited by construction, so the count is definitionally the
  // sum of what the list shows. Rebuild scripts must carry this dependent
  // when swapping the serving view.
  const totals = new Map<string, ActivityUnreadTotals>();
  for (const serverId of serverIds) {
    totals.set(serverId, { totalUnreadCount: 0, activeUnreadCount: 0 });
  }
  const totalsView = UNIFIED_CHAIN_VIEWS.totals;
  // The second arm lists the unread each thread parent contributes to the
  // total (what the totals view sums for threads), so threads below a parent
  // the receiver can no longer see can be taken back out, as the Activity list
  // leaves them out (getInboxItemsFromRisingWave). Same round trip.
  const read = await traceQuery(
    "channels.activity_unread_totals_batch_by_user.derivation",
    () => queryRisingWaveInbox<{ serverId: string; parentChannelId: string | null; unreadCount: number }>(
      client,
      `SELECT
         t.server_id AS "serverId",
         CAST(NULL AS VARCHAR) AS "parentChannelId",
         t.total_unread_count AS "unreadCount"
       FROM ${totalsView} t
       WHERE t.receiver_id = $1
         AND t.receiver_type = 'user'
         AND t.server_id = ANY($2)
       UNION ALL
       SELECT
         i.server_id AS "serverId",
         i.parent_channel_id AS "parentChannelId",
         CAST(SUM(i.unread_count) AS INT) AS "unreadCount"
       FROM ${UNIFIED_CHAIN_VIEWS.serving} i
       WHERE i.receiver_id = $1
         AND i.receiver_type = 'user'
         AND i.server_id = ANY($2)
         AND i.kind IN ('thread', 'task')
         AND NOT i.mention_only
         AND i.unread_count > 0
         AND i.parent_channel_id IS NOT NULL
       GROUP BY i.server_id, i.parent_channel_id`,
      [userId, serverIds],
    ),
    (queryRead) => {
      const totalRows = queryRead.result.rows.filter((row) => row.parentChannelId == null).length;
      return {
        ...inboxTraceAttrs("rw_mv", "activity_totals", "none"),
        server_count: serverIds.length,
        row_count: totalRows,
        thread_parent_row_count: queryRead.result.rows.length - totalRows,
        // Every (user, server) membership has a totals row, so a missing row is not
        // an ordinary zero: the membership has not reached RisingWave. Counted, not
        // hidden; the badge still reads 0 for it.
        missing_row_count: serverIds.length - totalRows,
        rw_inbox_items_serving_view: totalsView,
        rw_inbox_items_derivation_chain: true,
        rw_inbox_unified_chain: true,
      };
    },
  );
  const totalRows = read.result.rows.filter((row) => row.parentChannelId == null);
  const parentRows = read.result.rows.filter((row) => row.parentChannelId != null);
  const invisibleParents = new Set(await findInvisibleThreadParentChannelIds(
    userId,
    parentRows.map((row) => String(row.parentChannelId)),
    traceQuery,
    getDb(),
  ));
  const hiddenUnreadByServer = new Map<string, number>();
  for (const row of parentRows) {
    if (!invisibleParents.has(String(row.parentChannelId))) continue;
    const serverId = String(row.serverId);
    hiddenUnreadByServer.set(serverId, (hiddenUnreadByServer.get(serverId) ?? 0) + Number(row.unreadCount));
  }
  if (hiddenUnreadByServer.size > 0) {
    addTraceEvent("inbox.rw.invisible_thread_parents_excluded", {
      ...inboxTraceAttrs("rw_mv", "activity_totals", "none"),
      excluded_thread_parent_count: invisibleParents.size,
      server_count: hiddenUnreadByServer.size,
    });
  }
  for (const row of totalRows) {
    const serverId = String(row.serverId);
    const count = Math.max(0, Number(row.unreadCount) - (hiddenUnreadByServer.get(serverId) ?? 0));
    totals.set(serverId, { totalUnreadCount: count, activeUnreadCount: count });
  }
  return totals;
}


function safeReadFrontierNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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

export type InboxItemsResult = {
  items: InboxItem[];
  groups: InboxGroupCount[];
  hasMore: boolean;
  totalCount: number;
  totalUnreadCount: number;
  activeUnreadCount: number;
};

export function inboxItemActivityAt(item: InboxItem): string {
  return (item.kind === "thread" || item.kind === "task") ? item.lastActivityAt : item.lastMessageAt;
}

export function inboxItemIdentity(item: InboxItem): string {
  return `${item.kind}:${(item.kind === "thread" || item.kind === "task") ? item.threadChannelId : item.channelId}`;
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
    if (item.kind !== "thread" && item.kind !== "task") continue;
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
  opts: InboxItemsQuery,
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
  const dmScopedUnfollowed = opts.scope === "dms"
    ? allUnfollowed.filter(isDmScopedInboxItem)
    : opts.scope === "no_dms"
      ? allUnfollowed.filter((item) => !isDmScopedInboxItem(item))
      : allUnfollowed;
  const pinnedChannelIdSet = opts.pinnedChannelIds ? new Set(normalizePinnedChannelIds(opts.pinnedChannelIds)) : null;
  const scopedUnfollowed = pinnedChannelIdSet
    ? dmScopedUnfollowed.filter((item) => isPinnedScopedInboxItem(item, pinnedChannelIdSet))
    : dmScopedUnfollowed;
  const rowIdSet = opts.rowIds ? new Set(opts.rowIds) : null;
  const pageUnfollowed = scopedUnfollowed.filter((item) =>
    (!opts.channelId || (isSubConversationInboxItem(item) && item.parentChannelId === opts.channelId))
    && (!rowIdSet || rowIdSet.has(inboxItemRowId(item).toLowerCase())));
  const activeItems = active.items.map((item): InboxItem => item.kind === "thread" || item.kind === "task"
    ? { ...item, isFollowing: true, unfollowedAt: null }
    : item);
  const activeKeys = new Set(activeItems.map(inboxItemIdentity));
  const unfollowedItems = pageUnfollowed.filter((item) => !activeKeys.has(inboxItemIdentity(item)));
  const combined = [...activeItems, ...unfollowedItems]
    .sort((left, right) => compareInboxItems(left, right, opts.sort));

  return {
    items: combined.slice(offset, offset + limit),
    groups: mergeActivityGroups(active.groups, scopedUnfollowed.filter(
      (item) => !activeKeys.has(inboxItemIdentity(item)),
    )),
    hasMore: active.hasMore || combined.length > offset + limit,
    totalCount: active.totalCount + unfollowedItems.length,
    totalUnreadCount: active.totalUnreadCount,
    activeUnreadCount: active.activeUnreadCount,
  };
}

async function buildRisingWaveInboxItemsResult(
  result: RisingWaveInboxQueryResult,
  limit: number,
  traceQuery: DbQueryTracer,
  db: DatabaseExecutor,
): Promise<InboxItemsResult> {
  const rawRows = result.rows as InboxPolicySqlRow[];
  const page = selectInboxPolicyPageRows(rawRows, limit);
  const pageRows = page.rows;
  // The serving views do not carry the flag: stamp it from the read's own
  // marked-unread lookup (loadMarkedUnreadScopes).
  for (const row of pageRows) {
    const scopeId = inboxScopeIdOfRow(row);
    row.markedUnread = scopeId !== null && result.markedScopeIds.has(scopeId);
  }
  await enrichInboxRowsWithTaskIdentity(pageRows, traceQuery, db);
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

export type InboxItemsQuery = NonNullable<Parameters<typeof getInboxItems>[2]>;

/**
 * Activity rows for one reader. On a plan with a history window, every preview
 * of a message behind it (a thread's start, its latest activity, a channel's
 * last message) is a 40-character glimpse (cindyz, task #8), whichever source
 * served the page (RisingWave, the canonical read, a compositor). Done once
 * here, after the source, so the paths can't disagree.
 */
export async function getInboxItems(
  serverId: string,
  userId: string,
  opts: Parameters<typeof readInboxItems>[2] = {},
): Promise<InboxItemsResult> {
  const result = await readInboxItems(serverId, userId, opts);
  return opts.historyCutoff ? cutInboxPreviewsBehindWindow(result, opts.historyCutoff, opts.executor ?? getDb()) : result;
}

async function cutInboxPreviewsBehindWindow(
  result: InboxItemsResult,
  cutoff: Date,
  db: DatabaseExecutor,
): Promise<InboxItemsResult> {
  const isMessageId = (id: string | null | undefined): id is string => typeof id === "string" && UUID_TEXT_RE.test(id);
  const ids = new Set<string>();
  for (const item of result.items) {
    if ("latestActivityMessageId" in item) {
      if (item.kind === "thread" && isMessageId(item.parentMessageId)) ids.add(item.parentMessageId);
      if (isMessageId(item.latestActivityMessageId)) ids.add(item.latestActivityMessageId);
    } else if (isMessageId(item.lastMessageId)) {
      ids.add(item.lastMessageId);
    }
  }
  if (ids.size === 0) return result;
  const rows = await db.select({ id: messages.id, createdAt: messages.createdAt }).from(messages)
    .where(inArray(messages.id, [...ids]));
  const behind = new Set(rows.filter((row) => row.createdAt.getTime() <= cutoff.getTime()).map((row) => row.id));
  if (behind.size === 0) return result;
  const glimpse = (text: string) => historyLimitedPreview(text) ?? "";
  return {
    ...result,
    items: result.items.map((item): InboxItem => {
      if (!("latestActivityMessageId" in item)) {
        return behind.has(item.lastMessageId) ? { ...item, lastMessagePreview: glimpse(item.lastMessagePreview) } : item;
      }
      return {
        ...item,
        // A task's title (its parent preview) is its own, not a message.
        ...(item.kind === "thread" && behind.has(item.parentMessageId) && { parentMessagePreview: glimpse(item.parentMessagePreview) }),
        ...(behind.has(item.latestActivityMessageId) && { latestActivityPreview: glimpse(item.latestActivityPreview) }),
      };
    }),
  };
}

const UUID_TEXT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readInboxItems(
  serverId: string,
  userId: string,
  opts: {
    filter?: InboxFilter;
    limit?: number;
    offset?: number;
    channelId?: string;
    q?: string;
    /** Restrict every row, group and count to this scope. */
    scope?: InboxScope;
    /**
     * Activity "Pinned" scope: restrict every row, group and count to rows
     * whose group channel (the row's channel, or a thread's parent) is one of
     * these ids. Undefined = no restriction; [] = nothing.
     */
    pinnedChannelIds?: readonly string[];
    /**
     * `ids`: only rows whose own id (a channel/DM row's channelId, a thread/task
     * row's threadChannelId) is one of these. Narrows rows and totalCount /
     * totalUnreadCount like the channel facet; groups and activeUnreadCount
     * stay list-wide. Undefined = no restriction; [] = nothing.
     */
    rowIds?: readonly string[];
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
  const pinnedChannelIds = normalizePinnedChannelIds(opts.pinnedChannelIds);
  const rowIds = normalizePinnedChannelIds(opts.rowIds);
  if (filter === "all" && opts.includeUnfollowedThreads) {
    return getUnifiedActivityAllInboxItems(serverId, userId, { ...opts, q, pinnedChannelIds, rowIds }, limit, offset);
  }
  const humanActivityMuteEnabled = opts.humanActivityMuteEnabled ?? true;
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

  // The derivation view is THE serving source, and RisingWave is a hard
  // dependency: unconfigured or a failed read is an error, never a reroute (no
  // PG fail-soft; a future RW->PG sink may add storage-level redundancy, not a
  // read branch). The canonical inline Postgres read below serves only what the
  // projections do not carry yet -- search (sender display names are not
  // materialized) and guest access (guest policy is not represented) -- plus the
  // explicit force escapes for authority transactions.
  const useCanonicalPostgres = Boolean(q)
    || guestAccess !== null
    || opts.forcePostgres === true
    || opts.forceCanonicalPostgres === true;
  const canonicalSelectionReason = q
    ? "search_not_projected"
    : guestAccess !== null
      ? "guest_policy_not_projected"
      : "forced_canonical";
  if (!useCanonicalPostgres) {
    const override = getActivityReadSourceOverride();
    if (override) return override.inboxItems(serverId, userId, { ...opts, q });
    const risingWaveResult = await getInboxItemsFromRisingWave(serverId, userId, {
      filter,
      limit,
      offset,
      channelId,
      scope: opts.scope,
      pinnedChannelIds,
      rowIds,
      sort: opts.sort,
      historyCutoff,
      includeMentionOnlyInAllAndUnread: humanActivityMuteEnabled,
      traceQuery,
      executor: db,
    });
    recordInboxBackendSelected(
      "rw_mv",
      filter,
      "none",
      risingWaveResult.contractVersion,
    );
    return buildRisingWaveInboxItemsResult(risingWaveResult, limit, traceQuery, db);
  }

  const legacyActivityChannelFilterPredicate = channelId
    ? sql`AND CASE
        WHEN activity."kind" IN ('thread', 'task') THEN activity."parentChannelId"
        ELSE activity."sourceChannelId"
      END = ${channelId}::uuid`
    : sql``;
  const legacyCombinedChannelFilterPredicate = channelId
    ? sql`AND CASE
        WHEN combined."kind" IN ('thread', 'task') THEN combined."parentChannelId"
        ELSE combined."channelId"
      END = ${channelId}`
    : sql``;
  const legacyActivityScopePredicate = sql`${inboxScopeSqlPredicate(opts.scope, sql`activity`)}
      ${pinnedScopeSqlPredicate(pinnedChannelIds, sql`CASE WHEN activity."kind" IN ('thread', 'task') THEN activity."parentChannelId" ELSE activity."sourceChannelId" END`)}`;
  const legacyCombinedScopePredicate = sql`${inboxScopeSqlPredicate(opts.scope, sql`combined`)}
      ${pinnedScopeSqlPredicate(pinnedChannelIds, sql`CASE WHEN combined."kind" IN ('thread', 'task') THEN combined."parentChannelId" ELSE combined."channelId" END`)}`;
  const legacySearchPattern = q ? `%${q}%` : null;
  const legacyActivitySearchPredicate = legacySearchPattern
    ? sql`AND (
        COALESCE(activity."channelName", '') ILIKE ${legacySearchPattern}
        OR COALESCE(activity."parentChannelName", '') ILIKE ${legacySearchPattern}
        OR (${historyCutoff ? sql`(activity."kind" <> 'thread' OR activity."parentMessageCreatedAt" > ${historyCutoff})` : sql`true`}
          AND COALESCE(activity."parentMessagePreview", '') ILIKE ${legacySearchPattern})
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
            ${historyCutoff ? sql`AND search_message.created_at > ${historyCutoff}` : sql``}
            AND (
              search_message.content ILIKE ${legacySearchPattern}
              OR COALESCE(search_user.display_name, search_user.name, search_agent.display_name, search_agent.name, '') ILIKE ${legacySearchPattern}
            )
        )
      )`
    : sql``;
  // Behind the history cutoff a preview is not searchable: a row's last
  // message and latest activity are at "activityAt", a thread's start at
  // "parentMessageCreatedAt" (a task's title is its own).
  const legacyCombinedActivityInWindow = historyCutoff ? sql`combined."activityAt" > ${historyCutoff}` : sql`true`;
  const legacyCombinedParentInWindow = historyCutoff
    ? sql`(combined."kind" <> 'thread' OR combined."parentMessageCreatedAt" > ${historyCutoff})`
    : sql`true`;
  const legacyCombinedSearchPredicate = legacySearchPattern
    ? sql`AND (
        COALESCE(combined."channelName", '') ILIKE ${legacySearchPattern}
        OR COALESCE(combined."parentChannelName", '') ILIKE ${legacySearchPattern}
        OR (${legacyCombinedActivityInWindow} AND COALESCE(combined."lastMessagePreview", '') ILIKE ${legacySearchPattern})
        OR (${legacyCombinedParentInWindow} AND COALESCE(combined."parentMessagePreview", '') ILIKE ${legacySearchPattern})
        OR (${legacyCombinedActivityInWindow} AND COALESCE(combined."latestActivityPreview", '') ILIKE ${legacySearchPattern})
        OR COALESCE(combined."lastMessageSenderName", '') ILIKE ${legacySearchPattern}
        OR COALESCE(combined."taskClaimedByName", '') ILIKE ${legacySearchPattern}
      )`
    : sql``;

  // Free-tier history cutoff on the canonical path. In the projected world
  // this predicate lives INSIDE the serving view (plan-derived); the inline
  // SQL carries it per request so the canonical reads keep the same product
  // behavior. Empty fragments when no cutoff: zero plan-shape change.
  const legacyCutoffAndM = historyCutoff ? sql` AND m.created_at > ${historyCutoff}` : sql``;

  const legacyCutoffAndMm = historyCutoff ? sql` AND mm.created_at > ${historyCutoff}` : sql``;

  // Marked unread (no count): the Unread filter lists these too (SYNC with
  // the RisingWave read's markedScopeIdsParam); a row each, 0 to the counts.
  const markedForUnreadFilter = filter === "unread"
    ? [...(await loadMarkedUnreadScopes(serverId, userId, traceQuery, db)).keys()]
    : [];
  const legacyMarkedUnreadPredicate = markedForUnreadFilter.length > 0
    ? sql`OR (${filter} = 'unread' AND (CASE WHEN combined."kind" IN ('thread', 'task') THEN combined."threadChannelId" ELSE combined."channelId" END)::text IN (${sql.join(markedForUnreadFilter.map((id) => sql`${id}`), sql`, `)}))`
    : sql``;
  const readLegacyInboxItemsFromPostgres = () =>
    filter === "all"
      ? traceQuery(
          "channels.inbox_items_by_user",
          () =>
            db.execute(sql`
    -- Canonical Postgres Inbox read (search, guest access, authority transactions).
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
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        'thread'::text AS conversation_kind
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
       AND parent_ch.deleted_at IS NULL
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
      UNION ALL
      ${followedTaskConversationsLegacyInboxArm({ serverId, userId, guestAccess, withTaskColumns: false })}
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
        lm.created_at AS "activityAt",
        false AS "isOutsiderMention"
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
        t.conversation_kind AS "kind",
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
        COALESCE(latest_reply.created_at, t.parent_message_created_at) AS "activityAt",
        false AS "isOutsiderMention"
      FROM followed_threads t
      LEFT JOIN LATERAL (
        SELECT m.created_at
        FROM messages m
        WHERE m.channel_id = t.storage_channel_id
        ORDER BY m.seq DESC
        LIMIT 1
      ) latest_reply ON true
      -- A task conversation shows once it has a message (its creator follows it
      -- from creation), as in the RisingWave chain.
      WHERE t.conversation_kind = 'thread' OR latest_reply.created_at IS NOT NULL
      UNION ALL
      -- Notified outsider public-channel mentions: a user @-mentioned in a
      -- public channel they are NOT a member of gets a mention-only Activity
      -- row. notified_at is the notify pipeline's recorded policy verdict —
      -- Activity trusts it rather than re-deriving visibility. This behavior
      -- lived exclusively in write-time fan-out (serving_rows) until the
      -- 2026-09-21 teardown surfaced the gap (live regression, three prod
      -- cases verified against the old chain).
      SELECT
        'channel' AS "kind",
        oc.id AS "sourceChannelId",
        oc.id AS "storageChannelId",
        oc.name AS "channelName",
        oc.type::text AS "channelType",
        NULL::uuid AS "parentMessageId",
        NULL::uuid AS "parentChannelId",
        NULL::text AS "parentChannelName",
        NULL::text AS "parentChannelType",
        NULL::text AS "parentMessagePreview",
        NULL::text AS "parentMessageSenderType",
        NULL::text AS "parentMessageSenderId",
        NULL::timestamptz AS "parentMessageCreatedAt",
        NULL::bigint AS "parentMessageSeq",
        COALESCE(outsider_rc.last_read_seq, 0) AS "lastReadSeq",
        NULL::bigint AS "muteFromSeq",
        outsider_latest.created_at AS "activityAt",
        true AS "isOutsiderMention"
      FROM channels oc
      INNER JOIN LATERAL (
        SELECT m.created_at
        FROM message_mentions mm
        INNER JOIN messages m ON m.id = mm.message_id
        LEFT JOIN inbox_suppression_states mention_suppression
          ON mention_suppression.receiver_type = 'user'
         AND mention_suppression.receiver_id = ${userId}::uuid
         AND mention_suppression.target_kind = 'public_channel_mention'
         AND mention_suppression.target_channel_id = mm.channel_id
        WHERE mm.channel_id = oc.id
          AND mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND mm.notified_at IS NOT NULL
          AND mm.message_seq > COALESCE(mention_suppression.done_through_seq, 0)${legacyCutoffAndMm}
        ORDER BY mm.message_seq DESC
        LIMIT 1
      ) outsider_latest ON true
      LEFT JOIN channel_humans outsider_member
        ON outsider_member.channel_id = oc.id
       AND outsider_member.user_id = ${userId}
      LEFT JOIN user_channel_read_cursors outsider_rc
        ON outsider_rc.channel_id = oc.id
       AND outsider_rc.user_id = ${userId}
      WHERE oc.server_id = ${serverId}
        AND ${guestInboxAccessSql(guestAccess, sql`oc.id`)}
        AND oc.type = 'channel'
        AND oc.deleted_at IS NULL
        AND oc.archived_at IS NULL
        AND outsider_member.user_id IS NULL
      UNION ALL
      -- Notified outsider public-thread mentions: same admission verdict
      -- (notified_at) for threads the user does not follow, in public parent
      -- channels. Mirrors notified_public_thread_mentions in the filtered
      -- branch.
      SELECT
        'thread' AS "kind",
        ot.id AS "sourceChannelId",
        ot.id AS "storageChannelId",
        NULL::text AS "channelName",
        NULL::text AS "channelType",
        ot.parent_message_id AS "parentMessageId",
        outsider_parent_ch.id AS "parentChannelId",
        outsider_parent_ch.name AS "parentChannelName",
        outsider_parent_ch.type::text AS "parentChannelType",
        outsider_pm.content AS "parentMessagePreview",
        outsider_pm.sender_type AS "parentMessageSenderType",
        outsider_pm.sender_id AS "parentMessageSenderId",
        outsider_pm.created_at AS "parentMessageCreatedAt",
        outsider_pm.seq AS "parentMessageSeq",
        COALESCE(outsider_trc.last_read_seq, 0) AS "lastReadSeq",
        NULL::bigint AS "muteFromSeq",
        outsider_tm.created_at AS "activityAt",
        true AS "isOutsiderMention"
      FROM channels ot
      INNER JOIN messages outsider_pm ON outsider_pm.id = ot.parent_message_id
      INNER JOIN channels outsider_parent_ch ON outsider_parent_ch.id = outsider_pm.channel_id
      INNER JOIN LATERAL (
        SELECT m.created_at
        FROM message_mentions mm
        INNER JOIN messages m ON m.id = mm.message_id
        LEFT JOIN inbox_suppression_states mention_suppression
          ON mention_suppression.receiver_type = 'user'
         AND mention_suppression.receiver_id = ${userId}::uuid
         AND mention_suppression.target_kind = 'public_thread_mention'
         AND mention_suppression.target_channel_id = mm.channel_id
        WHERE mm.channel_id = ot.id
          AND mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND mm.notified_at IS NOT NULL
          AND mm.message_seq > COALESCE(mention_suppression.done_through_seq, 0)${legacyCutoffAndMm}
        ORDER BY mm.message_seq DESC
        LIMIT 1
      ) outsider_tm ON true
      LEFT JOIN thread_follows outsider_follow
        ON outsider_follow.thread_channel_id = ot.id
       AND outsider_follow.follower_type = 'user'
       AND outsider_follow.follower_id = ${userId}
       AND outsider_follow.done_at IS NULL
       AND outsider_follow.unfollowed_at IS NULL
      LEFT JOIN user_channel_read_cursors outsider_trc
        ON outsider_trc.channel_id = ot.id
       AND outsider_trc.user_id = ${userId}
      WHERE ot.server_id = ${serverId}
        AND ot.type = 'thread'
        AND ot.deleted_at IS NULL
        AND outsider_parent_ch.type = 'channel'
        AND ${guestInboxAccessSql(guestAccess, sql`outsider_parent_ch.id`)}
        AND outsider_parent_ch.archived_at IS NULL
        AND outsider_parent_ch.deleted_at IS NULL
        AND outsider_follow.thread_channel_id IS NULL
    ),
    filtered_activity AS (
      SELECT *
      FROM activity
      WHERE true
      ${legacyActivitySearchPredicate}
      ${legacyActivityScopePredicate}
    ),
    group_counts AS (
      SELECT
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelId" ELSE "sourceChannelId" END AS "groupChannelId",
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelName" ELSE "channelName" END AS "groupChannelName",
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelType" ELSE "channelType" END AS "groupChannelType",
        count(*)::int AS "groupCount",
        MAX("activityAt") AS "groupLastActivityAt"
      FROM filtered_activity
      GROUP BY
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelId" ELSE "sourceChannelId" END,
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelName" ELSE "channelName" END,
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelType" ELSE "channelType" END
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
      ${rowIdsSqlPredicate(rowIds, sql`activity."sourceChannelId"`)}
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
       AND m.seq > a."lastReadSeq"${legacyCutoffAndM}
       AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
       AND ${legacyChatActivityPromotionAllowedSql(userId, sql`a."muteFromSeq"`)}
       AND ${taskConversationUnreadMessageSql(sql`m`, sql`a."kind" = 'task'`)}
      WHERE NOT a."isOutsiderMention"
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
        CASE WHEN p."kind" IN ('thread', 'task') THEN NULL::text ELSE p."sourceChannelId"::text END AS "channelId",
        p."channelName",
        p."channelType",
        latest_message.id::text AS "lastMessageId",
        CASE WHEN p."isOutsiderMention" THEN has_mention.first_mention_message_id::text ELSE first_unread.id::text END AS "firstUnreadMessageId",
        to_char((latest_message.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastMessageAt",
        latest_message.content AS "lastMessagePreview",
        latest_message.sender_type AS "lastMessageSenderType",
        latest_message.sender_id AS "lastMessageSenderId",
        COALESCE(su.display_name, su.name, sa.display_name, sa.name) AS "lastMessageSenderName",
        CASE WHEN p."isOutsiderMention" THEN 0 ELSE COALESCE(unread.unread_count, 0) END::int AS "unreadCount",
        CASE WHEN p."kind" IN ('thread', 'task') THEN p."sourceChannelId"::text ELSE NULL::text END AS "threadChannelId",
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
        CASE WHEN p."kind" IN ('thread', 'task') THEN to_char((latest_message.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' ELSE NULL::text END AS "lastReplyAt",
        CASE WHEN p."kind" IN ('thread', 'task') THEN COALESCE(reply_count.reply_count, 0)::int ELSE NULL::int END AS "replyCount",
        legacy_task.task_number AS "taskNumber",
        legacy_task.status AS "taskStatus",
        COALESCE(claimant_user.display_name, claimant_user.name, claimant_agent.display_name, claimant_agent.name) AS "taskClaimedByName",
        CASE WHEN p."isOutsiderMention" THEN true ELSE COALESCE(has_mention.found, false) END AS "hasMention",
        has_mention.first_mention_message_id::text AS "firstMentionMessageId",
        CASE WHEN p."isOutsiderMention" THEN true ELSE COALESCE(has_mention.found, false) END AS "hasAnyMention",
        p."isOutsiderMention" AS "mentionOnly",
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
          AND m.seq > p."lastReadSeq"${legacyCutoffAndM}
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          AND ${legacyChatActivityPromotionAllowedSql(userId, sql`p."muteFromSeq"`)}
          AND ${taskConversationUnreadMessageSql(sql`m`, sql`p."kind" = 'task'`)}
        ORDER BY m.seq ASC
        LIMIT 1
      ) first_unread ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS unread_count
        FROM messages m
        WHERE m.channel_id = p."storageChannelId"
          AND m.seq > p."lastReadSeq"${legacyCutoffAndM}
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          AND ${legacyChatActivityPromotionAllowedSql(userId, sql`p."muteFromSeq"`)}
          AND ${taskConversationUnreadMessageSql(sql`m`, sql`p."kind" = 'task'`)}
      ) unread ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS reply_count
        FROM messages m
        WHERE p."kind" IN ('thread', 'task')
          AND m.channel_id = p."storageChannelId"
          -- A task conversation's replies are its chat messages (people and
          -- agents), not its lifecycle lines, as rw_task_conversation_replies_v1
          -- and the task row count them; a thread counts every message.
          AND (p."kind" = 'thread' OR m.message_type = 'chat')
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
          -- Outsider rows: the anchor ignores the READ cursor (a mention-only
          -- row must open the @ even when read) but respects DONE
          -- (suppression): after done, only a newer mention reopens and the
          -- anchor moves to it. Member rows keep cursor gating.
          AND (
            (NOT p."isOutsiderMention" AND mm.message_seq > p."lastReadSeq")
            OR (p."isOutsiderMention" AND mm.message_seq > COALESCE((
              SELECT s.done_through_seq
              FROM inbox_suppression_states s
              WHERE s.receiver_type = 'user'
                AND s.receiver_id = ${userId}::uuid
                AND s.target_kind = CASE p."kind" WHEN 'thread' THEN 'public_thread_mention' ELSE 'public_channel_mention' END
                AND s.target_channel_id = p."sourceChannelId"
            ), 0))
          )${legacyCutoffAndMm}
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
            ...inboxTraceAttrs("pg_legacy", filter, "none"),
            inbox_pg_selection_reason: canonicalSelectionReason,
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
    -- Canonical Postgres Inbox read (search, guest access, authority transactions).
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
          AND mm.message_seq > COALESCE(mention_suppression.done_through_seq, 0)${legacyCutoffAndMm}
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
          AND mm.message_seq > COALESCE(mention_suppression.done_through_seq, 0)${legacyCutoffAndMm}
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
        legacy_task.claimed_by_id AS task_claimed_by_id,
        'thread'::text AS conversation_kind
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
       AND parent_ch.deleted_at IS NULL
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
      UNION ALL
      ${followedTaskConversationsLegacyInboxArm({ serverId, userId, guestAccess, withTaskColumns: true })}
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
        NULL::timestamptz AS "parentMessageCreatedAt",
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
          AND m.seq > c.last_read_seq${legacyCutoffAndM}
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          AND ${legacyChatActivityPromotionAllowedSql(userId, sql`c.mute_from_seq`)}
        ORDER BY m.seq ASC
        LIMIT 1
      ) first_unread ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS unread_count
        FROM messages m
        WHERE m.channel_id = c.storage_channel_id
          AND m.seq > c.last_read_seq${legacyCutoffAndM}
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          AND ${legacyChatActivityPromotionAllowedSql(userId, sql`c.mute_from_seq`)}
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
          AND mm.message_seq > c.last_read_seq${legacyCutoffAndMm}
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
        NULL::timestamptz AS "parentMessageCreatedAt",
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
        c.parent_message_created_at AS "parentMessageCreatedAt",
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
        t.conversation_kind AS "kind",
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
        t.parent_message_created_at AS "parentMessageCreatedAt",
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
          -- A task conversation counts its chat messages only (see the all branch).
          AND (t.conversation_kind = 'thread' OR m.message_type = 'chat')
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
          AND m.seq > COALESCE(rc.last_read_seq, 0)${legacyCutoffAndM}
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          AND ${taskConversationUnreadMessageSql(sql`m`, sql`t.conversation_kind = 'task'`)}
        ORDER BY m.seq ASC
        LIMIT 1
      ) first_unread ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS unread_count
        FROM messages m
        WHERE m.channel_id = t.storage_channel_id
          AND m.seq > COALESCE(rc.last_read_seq, 0)${legacyCutoffAndM}
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          AND ${taskConversationUnreadMessageSql(sql`m`, sql`t.conversation_kind = 'task'`)}
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
          AND mm.message_seq > COALESCE(rc.last_read_seq, 0)${legacyCutoffAndMm}
        ORDER BY mm.message_seq ASC
        LIMIT 1
      ) has_mention ON true
      LEFT JOIN agents claimant_agent
        ON t.task_claimed_by_type = 'agent'
       AND claimant_agent.id::text = t.task_claimed_by_id
      LEFT JOIN users claimant_user
        ON t.task_claimed_by_type = 'user'
       AND claimant_user.id::text = t.task_claimed_by_id
      -- A task conversation shows once it has a message, as in the RisingWave chain.
      WHERE t.conversation_kind = 'thread' OR latest.last_reply_at IS NOT NULL
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
      WHERE true
      ${legacyCombinedScopePredicate}
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
        ${legacyCombinedScopePredicate}
        AND (
          ${filter} = 'all'
          OR (${filter} = 'unread' AND "unreadCount" > 0)
          ${legacyMarkedUnreadPredicate}
          OR (${filter} = 'unread_mentions' AND "unreadCount" > 0 AND "hasMention" = true)
          OR (${filter} = 'mentions' AND EXISTS (
          SELECT 1 FROM message_mentions mm
          WHERE mm.target_type = 'user'
            AND mm.target_id = ${userId}::uuid
            AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
            ${historyCutoff ? sql`AND mm.created_at > ${historyCutoff}` : sql``}
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
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelId" ELSE "channelId" END AS "groupChannelId",
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelName" ELSE "channelName" END AS "groupChannelName",
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelType" ELSE "channelType" END AS "groupChannelType",
        count(*)::int AS "groupCount",
        MAX("activityAt") AS "groupLastActivityAt"
      FROM filtered
      GROUP BY
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelId" ELSE "channelId" END,
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelName" ELSE "channelName" END,
        CASE WHEN "kind" IN ('thread', 'task') THEN "parentChannelType" ELSE "channelType" END
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
      ${rowIdsSqlPredicate(rowIds, sql`CASE WHEN combined."kind" IN ('thread', 'task') THEN combined."threadChannelId" ELSE combined."channelId" END`)}
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
            ...inboxTraceAttrs("pg_legacy", filter, "none"),
            inbox_pg_selection_reason: canonicalSelectionReason,
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
  const result = await readLegacyInboxItemsFromPostgres();

  const rawRows = result.rows as InboxPolicySqlRow[];
  const page = selectInboxPolicyPageRows(rawRows, limit);
  const pageRows = page.rows as any[];

  await enrichInboxRowsWithTaskIdentity(pageRows, traceQuery, db);
  await enrichInboxRowsWithProfileNames(pageRows, traceQuery, db);
  recordInboxBackendSelected("pg_legacy", filter, "none", undefined, {
    inbox_pg_selection_reason: canonicalSelectionReason,
  });
  // Row-read trace events (page + one per returned item). Event names keep
  // the historical inbox.serving_row.* family: they are a consumed trace
  // contract (join-key correlation), and renaming them is a trace-contract
  // change, not a teardown concern.
  recordInboxServingRowsRead(pageRows, {
    receiverType: "user",
    receiverId: userId,
    filter,
    limit,
    offset,
  });
  // PG canonical path: the read-cursor triple AND the union frontier pair
  // come from the SINGLE authority read (identical union to the list/unread
  // exits). The authority read runs on the SAME executor as the rest of the
  // flow — required when the caller is inside a transaction, both for
  // snapshot consistency and to avoid
  // single-connection (pglite) deadlock.
  await enrichInboxRowsWithReadCursorAuthority(pageRows, userId, traceQuery, db);
  const mappedItems = mapInboxPolicyRowsToItems(pageRows, logInboxScopeCorruption, "authority") as InboxItem[];
  const items = await attachReadStateToInboxItems(mappedItems, userId, db);

  return {
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
}

export type ReadStateMutationResult = {
  channelId: string;
  maxReadSeq: number;
  readStateVersion: number;
  changed: boolean;
  /** Unread left after the write, when the sequencer computed it (see ReadMutationAck scopes). */
  unreadCount?: number;
  /** Marked unread with nothing countable (see ReadMutationAck scopes); absent means false. */
  markedUnread?: boolean;
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
    ...(typeof scope.unreadCount === "number" ? { unreadCount: scope.unreadCount } : {}),
    ...(scope.markedUnread === true ? { markedUnread: true } : {}),
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

/** Read this sidebar conversation and its active followed threads, at one captured frontier. */
export async function markConversationReadLatest(serverId: string, userId: string, channelId: string): Promise<InboxReadLatestResult> {
  const ack = await executeCompatibilityReadMutation({
    serverId,
    principalId: userId,
    mutation: { kind: "conversation_read_all", scopeId: channelId },
  });
  const scopes = ack.scopes.map(readStateResultFromAckScope);
  recordInboxReadRebuildRequested(userId, scopes.filter((scope) => scope.changed));
  return { markedCount: scopes.filter((scope) => scope.changed).length, scopes };
}

export type ThreadFollowReason = "replied" | "authored" | "mentioned" | "manual" | "assigned" | "saved";

/**
 * Write thread attention state. Ordinary auto-follow callers intentionally do
 * not override an explicit human unfollow; callers must opt in when a direct
 * mention, manual follow, or self-reply should reactivate a suppressed thread.
 */
export async function recordThreadFollow(
  followerType: "user" | "agent",
  followerId: string,
  threadChannelId: string,
  /** Thread: its parent message. Task conversation (task v2): null + `opts.parentTaskId`. */
  parentMessageId: string | null,
  reason: ThreadFollowReason,
  opts: {
    /** Task conversation (task v2): the task it belongs to. */
    parentTaskId?: string | null;
    reactivateUnfollowed?: boolean;
    preserveExistingReason?: boolean;
    /**
     * Where the follower's read position starts when this call STARTS a follow (no row,
     * or a previously unfollowed one): "latest", or the seq before the message that
     * caused the follow so that message stays unread. An already-active follow keeps
     * its position. Omit only when the caller moves the position itself.
     */
    joinedThroughSeq?: number | "latest";
    /** Run the writes in the caller's transaction (notifications/settings.ts setLevel). */
    executor?: DatabaseExecutor;
  } = {},
) {
  const db = opts.executor ?? getDb();
  // Agent Lounge: following is subscribing, and other agents never subscribe
  // there. Skipped, not refused: an automatic follow (say, of a message's
  // author whose lounge binding was released) must not fail the post that
  // triggered it. The agent route refuses with a reason before calling this.
  if (followerType === "agent" && await isLoungeOutsiderAgent(threadChannelId, followerId, db)) {
    return;
  }
  const reactivateUnfollowed = opts.reactivateUnfollowed ?? false;
  const preserveExistingReason = opts.preserveExistingReason ?? false;
  const result = await db.execute(sql`
    WITH prev AS (
      SELECT unfollowed_at FROM thread_follows
      WHERE thread_channel_id = ${threadChannelId}::uuid
        AND follower_type = ${followerType}
        AND follower_id = ${followerId}::uuid
    )
    INSERT INTO thread_follows (
      thread_channel_id,
      follower_type,
      follower_id,
      parent_message_id,
      parent_task_id,
      reason,
      done_at,
      unfollowed_at
    )
    VALUES (
      ${threadChannelId}::uuid,
      ${followerType},
      ${followerId}::uuid,
      ${parentMessageId}::uuid,
      ${opts.parentTaskId ?? null}::uuid,
      ${reason},
      NULL,
      NULL
    )
    ON CONFLICT (thread_channel_id, follower_type, follower_id) DO UPDATE
    SET
      parent_message_id = EXCLUDED.parent_message_id,
      parent_task_id = EXCLUDED.parent_task_id,
      reason = CASE
        -- Thread contract D: a follow only a save started takes the new
        -- reason (reply, mention, ...), so unsaving no longer releases it.
        -- Before the rules below that keep an active follow's reason.
        WHEN thread_follows.reason = 'saved' THEN EXCLUDED.reason
        WHEN ${preserveExistingReason} THEN thread_follows.reason
        -- Task v2: replying in a task conversation keeps why an ACTIVE follow
        -- began (the creator stays 'authored', the assignee 'assigned'); a
        -- reply that (re)starts a follow records 'replied'.
        WHEN EXCLUDED.reason = 'replied'
          AND EXCLUDED.parent_task_id IS NOT NULL
          AND thread_follows.unfollowed_at IS NULL
          THEN thread_follows.reason
        ELSE EXCLUDED.reason
      END,
      -- Start of the current follow period: a re-follow after an unfollow
      -- begins a new one; re-confirming an active follow (reply, mention)
      -- does not move it.
      created_at = CASE
        WHEN thread_follows.unfollowed_at IS NOT NULL THEN now()
        ELSE thread_follows.created_at
      END,
      done_at = NULL,
      unfollowed_at = NULL,
      -- An automatic re-follow (replying, being mentioned) ends a stored
      -- 'mentions' (= unfollowed) level: back to NULL (default). An explicit
      -- 'none' stays silent; 'all' / 'default' stay (contract §1.1).
      notification_level = CASE
        WHEN thread_follows.notification_level = 'mentions' THEN NULL
        ELSE thread_follows.notification_level
      END
    WHERE ${reactivateUnfollowed}
       OR thread_follows.unfollowed_at IS NULL
    RETURNING thread_channel_id,
      NOT EXISTS (SELECT 1 FROM prev WHERE prev.unfollowed_at IS NULL) AS started,
      EXISTS (SELECT 1 FROM prev WHERE prev.unfollowed_at IS NOT NULL) AS reactivated
  `);

  if (result.rows.length > 0) {
    await clearFollowedThreadSuppressionForReceiver({
      followerType,
      followerId,
      threadChannelId,
      executor: db,
    });
  }
  const row = result.rows[0] as { started?: boolean; reactivated?: boolean } | undefined;
  if (row?.started === true && opts.joinedThroughSeq !== undefined) {
    await startReadPositionAtJoin(
      db,
      followerType === "user" ? "human" : "agent",
      followerId,
      threadChannelId,
      opts.joinedThroughSeq === "latest" ? undefined : opts.joinedThroughSeq,
    );
  }
  // Not inside a caller's transaction: a client reloading before the commit would still read "stopped following".
  if (followerType === "agent" && row?.reactivated === true && !opts.executor) noteAgentThreadFollowResumed(threadChannelId);
}

/** Follow a thread manually (user). */
export async function followThread(userId: string, threadChannelId: string, parentMessageId: string) {
  await recordThreadFollow("user", userId, threadChannelId, parentMessageId, "manual", { reactivateUnfollowed: true });
  // Mark thread as read so existing messages don't appear as unread. A read-state fence refusal (the follower left the
  // Server meanwhile) must not fail the follow; any other error still surfaces.
  await markReadLatest(userId, threadChannelId).catch((error: unknown) => {
    if (!isReadMutationFenceRefusal(error)) throw error;
  });
}

/**
 * Follow a task conversation (task v2) by hand, for a person or an agent.
 * `conversationChannelId` is the follower's LOCAL conversation. Like a manual
 * thread follow, a person's existing messages read as read.
 */
export async function followTaskConversation(
  followerType: "user" | "agent",
  followerId: string,
  conversationChannelId: string,
): Promise<boolean> {
  const [conversation] = await getDb()
    .select({ taskId: channels.taskId })
    .from(channels)
    .where(and(eq(channels.id, conversationChannelId), eq(channels.type, "task"), isNull(channels.deletedAt)))
    .limit(1);
  if (!conversation?.taskId) return false;
  await recordThreadFollow(followerType, followerId, conversationChannelId, null, "manual", {
    parentTaskId: conversation.taskId,
    reactivateUnfollowed: true,
    ...(followerType === "agent" && { joinedThroughSeq: "latest" as const }),
  });
  if (followerType === "user") {
    await markReadLatest(followerId, conversationChannelId).catch((error: unknown) => {
      if (!isReadMutationFenceRefusal(error)) throw error;
    });
  }
  return true;
}

/** What a follow row of this thread / task conversation names as its parent, or null when it is neither. */
async function resolveThreadFollowParent(executor: DatabaseExecutor, threadChannelId: string, opts: { liveOnly?: boolean } = {}) {
  const conditions = [eq(channels.id, threadChannelId), inArray(channels.type, ["thread", "task"])];
  if (opts.liveOnly) conditions.push(isNull(channels.deletedAt));
  const [thread] = await executor
    .select({ type: channels.type, parentMessageId: channels.parentMessageId, taskId: channels.taskId })
    .from(channels)
    .where(and(...conditions))
    .limit(1);
  if (!thread) return null;
  // Task conversation (task v2): the follow row names the task, not a message.
  if (thread.type === "task") return thread.taskId ? { parentMessageId: null, parentTaskId: thread.taskId } : null;
  const parentMessageId = thread.parentMessageId
    ?? (await getJointThreadProjectionByLocalThread(threadChannelId, undefined, executor))?.canonicalParentMessageId
    ?? null;
  return parentMessageId ? { parentMessageId, parentTaskId: null } : null;
}

/**
 * The thread a person's saved message belongs to, as their server shows it
 * (thread contract D): a reply's own thread / task conversation, or for a
 * top-level message the thread rooted at it, created as the Follow button
 * creates it. Joint messages resolve to this server's projection. Null when
 * the message has no thread here (deleted, or no projection on this server).
 */
export async function resolveSavedMessageThreadChannelId(serverId: string, userId: string, messageId: string): Promise<string | null> {
  const message = await getMessage(messageId);
  if (!message) return null;
  const channel = await getChannel(message.channelId);
  if (!channel) return null;
  if (isSubConversationType(channel.type)) {
    const [projection] = await getActiveJointThreadProjectionsByCanonicalThreadsForServer([channel.id], serverId);
    if (projection) return projection.localThreadChannelId;
    return channel.serverId === serverId ? channel.id : null;
  }
  let localParentChannelId = channel.id;
  if (channel.serverId !== serverId || channel.type === "joint") {
    const projection = (await getActiveJointChannelProjectionsByLocalChannel(channel.id))
      .find((candidate) => candidate.serverId === serverId);
    if (!projection) return null;
    localParentChannelId = projection.localChannelId;
  }
  return (await getOrCreateThreadForChannel(localParentChannelId, messageId, userId, "user")).id;
}

/**
 * Serializes a person's save-follow writes on one thread (savedService's save
 * and unsave transactions): there may be no follow row to lock yet. Taken
 * first in each transaction, so the two never wait on each other's rows.
 */
export async function lockSaveFollow(executor: DatabaseExecutor, userId: string, threadChannelId: string): Promise<void> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`saved-follow:${threadChannelId}:${userId}`}, 0))`);
}

/**
 * Saving a message follows its thread (thread contract D), in the caller's
 * transaction after lockSaveFollow, and only while a save of the person's is
 * linked to the thread (checked in the statement). No row yet starts a
 * follow with reason 'saved'; an unfollowed row is re-followed the same way
 * when `reactivateUnfollowed`; an active follow is left exactly as it is,
 * whatever its reason. True when this started a follow: the caller then
 * moves the read position after commit (markThreadReadAfterFollowChange), as
 * after a manual follow.
 */
export async function writeSaveFollow(
  executor: DatabaseExecutor,
  userId: string,
  threadChannelId: string,
  opts: { reactivateUnfollowed: boolean },
): Promise<boolean> {
  const parent = await resolveThreadFollowParent(executor, threadChannelId, { liveOnly: true });
  if (!parent) return false;
  const result = await executor.execute(sql`
    INSERT INTO thread_follows (
      thread_channel_id,
      follower_type,
      follower_id,
      parent_message_id,
      parent_task_id,
      reason,
      done_at,
      unfollowed_at
    )
    SELECT
      ${threadChannelId}::uuid,
      'user',
      ${userId}::uuid,
      ${parent.parentMessageId}::uuid,
      ${parent.parentTaskId}::uuid,
      ${"saved" satisfies ThreadFollowReason},
      NULL,
      NULL
    WHERE EXISTS (
      SELECT 1 FROM user_saved
      WHERE user_saved.user_id = ${userId}::uuid
        AND user_saved.thread_channel_id = ${threadChannelId}::uuid
    )
    ON CONFLICT (thread_channel_id, follower_type, follower_id) DO UPDATE
    SET
      reason = EXCLUDED.reason,
      created_at = now(),
      done_at = NULL,
      unfollowed_at = NULL,
      -- As an automatic re-follow: a stored 'mentions' (= unfollowed) level ends.
      notification_level = CASE
        WHEN thread_follows.notification_level = 'mentions' THEN NULL
        ELSE thread_follows.notification_level
      END
    WHERE thread_follows.unfollowed_at IS NOT NULL AND ${opts.reactivateUnfollowed}
    RETURNING thread_channel_id
  `);
  if (result.rows.length === 0) return false;
  await clearFollowedThreadSuppressionForReceiver({ followerType: "user", followerId: userId, threadChannelId, executor });
  return true;
}

/**
 * Unsaving, in the caller's transaction after lockSaveFollow: the person's
 * follow of the thread goes only while saving is still its one reason
 * (reason 'saved'; a reply, mention or manual follow since then replaced it,
 * recordThreadFollow) and no other save of theirs is linked to the thread
 * (checked in the statement). True when the follow was deleted.
 */
export async function releaseSaveFollow(executor: DatabaseExecutor, userId: string, threadChannelId: string): Promise<boolean> {
  const deleted = await executor
    .delete(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, threadChannelId),
      eq(threadFollows.followerType, "user"),
      eq(threadFollows.followerId, userId),
      eq(threadFollows.reason, "saved"),
      isNull(threadFollows.unfollowedAt),
      sql`NOT EXISTS (
        SELECT 1 FROM user_saved
        WHERE user_saved.user_id = ${userId}::uuid
          AND user_saved.thread_channel_id = ${threadChannelId}::uuid
      )`,
    ))
    .returning({ threadChannelId: threadFollows.threadChannelId });
  return deleted.length > 0;
}

/** An unfollow's row writes (the follow row, a person's Done suppression), in `executor`'s transaction. */
async function writeThreadUnfollowRows(
  executor: DatabaseExecutor,
  followerType: "user" | "agent",
  followerId: string,
  threadChannelId: string,
): Promise<boolean> {
  const parent = await resolveThreadFollowParent(executor, threadChannelId);
  if (!parent) return false;
  const now = currentDate();
  await executor.insert(threadFollows).values({
    threadChannelId,
    followerType,
    followerId,
    parentMessageId: parent.parentMessageId,
    parentTaskId: parent.parentTaskId,
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
      executor,
    });
  }
  return true;
}

/**
 * The read-position move after a person's manual follow / unfollow (existing
 * messages read as read). A read-state fence refusal (the follower left the
 * Server meanwhile) must not fail it; any other error still surfaces.
 */
export async function markThreadReadAfterFollowChange(userId: string, threadChannelId: string): Promise<void> {
  await markReadLatest(userId, threadChannelId).catch((error: unknown) => {
    if (!isReadMutationFenceRefusal(error)) throw error;
  });
}

/** Unfollow a thread or task conversation for any supported follower type. */
export async function unfollowThreadForFollower(
  followerType: "user" | "agent",
  followerId: string,
  threadChannelId: string,
) {
  const written = await getDb().transaction((tx) => writeThreadUnfollowRows(tx, followerType, followerId, threadChannelId));
  if (!written) return false;
  if (followerType === "user") await markThreadReadAfterFollowChange(followerId, threadChannelId);
  return true;
}

/** Unfollow a thread (user). */
export async function unfollowThread(userId: string, threadChannelId: string) {
  await unfollowThreadForFollower("user", userId, threadChannelId);
}

/**
 * A person's manual follow or unfollow of a thread / task conversation named
 * by its own channel id: only the row writes, in the caller's transaction, so
 * notifications/settings.ts setLevel writes the follow state and the thread
 * level together (contract §1.1). The caller moves the read position after
 * commit (markThreadReadAfterFollowChange). False when the channel is not a
 * live thread / task conversation.
 */
export async function writeUserThreadFollowState(
  executor: DatabaseExecutor,
  userId: string,
  threadChannelId: string,
  state: "follow" | "unfollow",
): Promise<boolean> {
  if (state === "unfollow") return writeThreadUnfollowRows(executor, "user", userId, threadChannelId);
  const parent = await resolveThreadFollowParent(executor, threadChannelId, { liveOnly: true });
  if (!parent) return false;
  await recordThreadFollow("user", userId, threadChannelId, parent.parentMessageId, "manual", {
    parentTaskId: parent.parentTaskId,
    reactivateUnfollowed: true,
    executor,
  });
  return true;
}

/**
 * What the Follow button stores, named by the thread's own channel id, for
 * tests and fixtures: the manual follow and the explicit thread level `all`
 * in one transaction, then the read-position move. The button itself goes
 * through notifications/settings.ts setLevel, which also bumps the prefs
 * version and emits.
 */
export async function followThreadChannelForUser(userId: string, threadChannelId: string): Promise<boolean> {
  const written = await getDb().transaction(async (tx) => {
    if (!await writeUserThreadFollowState(tx, userId, threadChannelId, "follow")) return false;
    await tx.update(threadFollows).set({ notificationLevel: "all" }).where(and(
      eq(threadFollows.threadChannelId, threadChannelId),
      eq(threadFollows.followerType, "user"),
      eq(threadFollows.followerId, userId),
    ));
    return true;
  });
  if (written) await markThreadReadAfterFollowChange(userId, threadChannelId);
  return written;
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
  // Agent read progress (agentReadProgressService): the ack does not carry the
  // position the read moved from, so it is read first, only while the flag is on.
  const readProgress = resolved.kind === "agent"
    ? await beginAgentReadAdvance({ serverId: channel.serverId, scopeId: channelId, agentId: resolved.id })
    : null;
  const ack = await executeCompatibilityReadMutation({
    serverId: channel.serverId,
    principalKind: resolved.kind,
    principalId: resolved.id,
    mutation: { kind: "row_read", scopeId: channelId, throughSeq: seq },
  });
  const scope = ack.scopes.find((candidate) => candidate.scopeId === channelId);
  if (!scope) return { channelId, maxReadSeq: 0, readStateVersion: 0, changed: false };
  const result = readStateResultFromAckScope(scope);
  readProgress?.finish(result);
  return result;
}

async function getMessageStorageChannelId(channelId: string): Promise<string> {
  const channel = await getChannel(channelId);
  if (!channel) return channelId;
  if (isSubConversationType(channel.type)) {
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
      pushMuted: inboxTargetMuteStates.pushMuted,
      prefsVersion: inboxTargetMuteStates.prefsVersion,
    })
    .from(inboxTargetMuteStates)
    .where(and(
      eq(inboxTargetMuteStates.receiverType, receiverType),
      eq(inboxTargetMuteStates.receiverId, receiverId),
      eq(inboxTargetMuteStates.sourceChannelId, sourceChannelId),
    ))
    .limit(1);

  const result = readActivityMuteState(state);
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
  const now = currentDate();
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

  // An assistant DM's automatic row (mute_from_seq 0) reads as unmuted, so a
  // mute here replaces it and starts at the next message: earlier assistant
  // messages would then reach Activity. Only reachable while the route refuses
  // muting assistant DMs (not App bots, ACTIVITY_MUTE_NOT_SUPPORTED); keep the
  // row's start if that changes.
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
      pushMuted: true,
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
        // A person's own mute also silences push, an assistant DM's too.
        pushMuted: true,
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
    : { collapseLongMessages: false, prefsVersion: 0 };
  return { ...result, changed: false };
}

export async function setUserChannelMessageDisplayPrefs(opts: {
  userId: string;
  serverId: string;
  channelId: string;
  collapseLongMessages: boolean;
}): Promise<UserChannelMessageDisplayPrefs> {
  const db = getDb();
  const now = currentDate();
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
  options: { actingUserId?: string } = {},
): Promise<ReadStateMutationResult> {
  const channel = await getChannel(channelId, { includeDeleted: true });
  if (!channel) throw new Error("Channel not found");
  const resolved = typeof principal === "string"
    ? { kind: "human" as const, id: principal }
    : principal;
  // Read-all on an agent's behalf moves its read progress too (see markRead).
  const readProgress = resolved.kind === "agent"
    ? await beginAgentReadAdvance({ serverId: channel.serverId, scopeId: channelId, agentId: resolved.id })
    : null;
  const ack = await executeCompatibilityReadMutation({
    serverId: channel.serverId,
    principalKind: resolved.kind,
    principalId: resolved.id,
    mutation: { kind: "channel_read_all", scopeId: channelId },
    // Task #93 line B: a human writing an agent receiver's read state is fenced as the delegating actor.
    actor: resolved.kind === "agent" && options.actingUserId ? { kind: "human", userId: options.actingUserId } : undefined,
  });
  const scope = ack.scopes.find((candidate) => candidate.scopeId === channelId);
  if (!scope) return { channelId, maxReadSeq: 0, readStateVersion: 0, changed: false };
  const result = readStateResultFromAckScope(scope);
  readProgress?.finish(result);
  return result;
}

/**
 * Mark a conversation unread: rewind the read cursor to just before the latest
 * unread-eligible message. With none (nothing others wrote past the cursor, e.g.
 * a thread of only the person's own replies), the sequencer marks the scope
 * unread instead (`markedUnread`, no count), so the mark always takes effect.
 */
export async function markUnread(
  userId: string,
  channelId: string,
): Promise<ReadStateMutationResult & { unreadCount: number; markedUnread: boolean; outcome: MarkUnreadOutcome }> {
  const channel = await getChannel(channelId, { includeDeleted: true });
  if (!channel) throw new Error("Channel not found");
  const boundary = await resolveReadMutationUnreadBoundary({
    serverId: channel.serverId,
    principalId: userId,
    scopeId: channelId,
  });
  const ack = await executeCompatibilityReadMutation({
    serverId: channel.serverId,
    principalId: userId,
    mutation: { kind: "row_unread", scopeId: channelId, throughSeq: boundary.throughSeq },
  });
  const scope = ack.scopes.find((candidate) => candidate.scopeId === channelId);
  if (!scope) {
    return { channelId, maxReadSeq: 0, readStateVersion: 0, changed: false, unreadCount: 0, markedUnread: false, outcome: "nothing" };
  }
  const markedUnread = scope.markedUnread === true;
  // Count and outcome are decided together in the sequencer's transaction.
  // Only an ack minted by an older server process during a rolling deploy lacks
  // the outcome; that one keeps the count from the boundary read before the
  // write, and its outcome is read the way clients read an answer without it.
  if (scope.unreadOutcome !== undefined && scope.unreadCount !== undefined) {
    return { ...readStateResultFromAckScope(scope), unreadCount: scope.unreadCount, markedUnread, outcome: scope.unreadOutcome };
  }
  const unreadCount = Math.max(boundary.latestUnreadEligibleSeq - scope.maxReadSeq, 0);
  return {
    ...readStateResultFromAckScope(scope),
    unreadCount,
    markedUnread,
    outcome: unreadCount > 0 ? "counted" : markedUnread ? "marked" : "nothing",
  };
}

/**
 * Sidebar unread comes from ONE RisingWave view, rw_conversation_unread_v4
 * (infra/risingwave/sql/078-task-conversations.sql), a projection of the
 * unified chain: rw_inbox_normal_v5 + muted subscriptions (full count,
 * rw_inbox_muted_full_v1) + rw_inbox_mention_v7. Every rule -- membership, muted, joint storage mapping,
 * followed-thread / task-conversation visibility, free-plan eligibility (rw_target_eligible_v1), the
 * unread predicate (own sends, self-caused system messages and noise subtypes
 * excluded) and mention admission -- lives in the chain, so these readers only
 * select. There is no Postgres fallback: with no RisingWave, or a failed read,
 * the request fails.
 *
 * Non-joined public channels carry no count. The summary asks, in the same round
 * trip, whether each one has anything past the user's cursor (`hasNew`): a
 * per-request lookup over the server's public channels, never a users x public
 * channels expansion.
 */
const CONVERSATION_UNREAD_CONTRACT_VERSION = 3;

function conversationUnreadRwTraceAttrs(read: { acquireWaitMs: number; poolState: RisingWavePoolState }): TraceAttributes {
  return {
    backend: "risingwave",
    "rw.acquire_wait_ms": Math.round(read.acquireWaitMs),
    "rw.pool.total_count": read.poolState.rw_pool_total,
    "rw.pool.idle_count": read.poolState.rw_pool_idle,
    "rw.pool.waiting_count": read.poolState.rw_pool_waiting,
    "rw.timeout_ms": getRisingWaveConnectionTimeoutMillis(),
    "rw.pool.connection_timeout_ms": getRisingWaveConnectionTimeoutMillis(),
    ...read.poolState,
  };
}

type ConversationUnreadRead<T> = { rows: T; rwAttrs: TraceAttributes };


function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

async function readConversationUnreadSummaryRows(
  query: ConversationUnreadSummaryQuery,
): Promise<ConversationUnreadRead<ConversationUnreadRow[]>> {
  const override = getConversationUnreadSourceOverride();
  if (override) return { rows: await override.summaryRows(query), rwAttrs: {} };
  const pool = getRisingWaveInboxPool();
  if (!pool) throw new RisingWaveNotConfiguredError("sidebar unread");
  // Public arm: the server's live public channels the user has NOT joined (a
  // joined one is a subscribed row of the view, muted included), still eligible
  // under the plan (the chain's rule), whose latest seq is past the user's
  // cursor. rw_channels is read by its server_id index; the other joins are
  // point lookups by target / (user, channel).
  const publicArm = query.includePublicNew
    ? `
      UNION ALL
      SELECT c.server_id AS server_id, c.id AS target_id, 'channel' AS kind, FALSE AS subscribed,
             CAST(0 AS BIGINT) AS unread_count, CAST(0 AS BIGINT) AS mention_unread,
             CAST(0 AS BIGINT) AS total_mentions, TRUE AS has_new,
             tl.latest_seq AS latest_seq, CAST(NULL AS VARCHAR) AS latest_message_id,
             (uc.user_id IS NOT NULL) AS cursor_present,
             CAST(uc.last_read_seq AS BIGINT) AS last_read_seq,
             uc.read_state_version AS read_state_version
      FROM rw_channels AS c
      JOIN rw_target_latest_v4 AS tl ON tl.target_id = c.id
      JOIN rw_target_eligible_v1 AS g ON g.target_id = c.id
      LEFT JOIN rw_channel_humans AS ch ON ch.channel_id = c.id AND ch.user_id = $1
      LEFT JOIN rw_user_channel_read_cursors_v2 AS uc ON uc.channel_id = c.id AND uc.user_id = $1
      WHERE c.server_id = $2
        AND c.type = 'channel'
        AND c.deleted_at IS NULL
        AND c.archived_at IS NULL
        AND ch.user_id IS NULL
        AND tl.latest_seq > COALESCE(CAST(uc.last_read_seq AS BIGINT), 0)`
    : "";
  // Only the RW query's own failure becomes RisingWaveReadError (502); the
  // not-configured and overload errors keep their types, and a bug in the row
  // mapping below stays a 500.
  const read = await queryRisingWaveInbox(pool, `
      SELECT server_id, target_id, kind, subscribed,
             unread_count, mention_unread, total_mentions, FALSE AS has_new,
             latest_seq, latest_message_id, cursor_present, last_read_seq, read_state_version
      FROM ${CONVERSATION_UNREAD_VIEW}
      WHERE receiver_type = 'user'
        AND receiver_id = $1
        AND server_id = $2
        AND (unread_count > 0 OR total_mentions > 0)${publicArm}`, [query.userId, query.serverId])
    .catch((error: unknown) => { throw asRisingWaveReadError(error); });
  const rows = read.result.rows.map((row): ConversationUnreadRow => ({
    serverId: String(row.server_id),
    targetId: String(row.target_id),
    kind: row.kind as ConversationUnreadRow["kind"],
    subscribed: row.subscribed === true,
    unreadCount: Number(row.unread_count ?? 0),
    mentionUnread: Number(row.mention_unread ?? 0),
    totalMentions: Number(row.total_mentions ?? 0),
    hasNew: row.has_new === true,
    latestSeq: nullableText(row.latest_seq),
    latestMessageId: nullableText(row.latest_message_id),
    cursorPresent: row.cursor_present === true,
    lastReadSeq: nullableText(row.last_read_seq),
    readStateVersion: row.read_state_version === null || row.read_state_version === undefined
      ? null
      : Number(row.read_state_version),
  }));
  return { rows, rwAttrs: conversationUnreadRwTraceAttrs(read) };
}

async function readSidebarUnreadTotals(
  query: SidebarUnreadTotalsQuery,
): Promise<ConversationUnreadRead<Array<{ serverId: string; unreadCount: number }>>> {
  const override = getConversationUnreadSourceOverride();
  if (override) return { rows: await override.sidebarTotals(query), rwAttrs: {} };
  const pool = getRisingWaveInboxPool();
  if (!pool) throw new RisingWaveNotConfiguredError("sidebar unread totals");
  const read = await queryRisingWaveInbox(pool, `
      SELECT server_id, CAST(SUM(unread_count) AS BIGINT) AS unread_count
      FROM ${CONVERSATION_UNREAD_VIEW}
      WHERE receiver_type = 'user'
        AND receiver_id = $1
        AND server_id = ANY($2::varchar[])
        AND subscribed
        AND kind NOT IN ('thread', 'task')
        AND unread_count > 0
      GROUP BY server_id`, [query.userId, query.serverIds]);
  const rows = read.result.rows.map((row) => ({
    serverId: String(row.server_id),
    unreadCount: Number(row.unread_count ?? 0),
  }));
  return { rows, rwAttrs: conversationUnreadRwTraceAttrs(read) };
}

async function loadConversationUnreadSummaryRows(
  serverId: string,
  userId: string,
  includePublicNew: boolean,
  traceQuery: DbQueryTracer,
): Promise<ConversationUnreadRow[]> {
  const queryName = includePublicNew ? "channels.unread_summary_by_user" : "channels.unread_counts_by_user";
  const read = await traceQuery(
    queryName,
    () => readConversationUnreadSummaryRows({ serverId, userId, includePublicNew }),
    (result) => ({
      ...inboxTraceAttrs("rw_mv", "channel_unread", "none", CONVERSATION_UNREAD_CONTRACT_VERSION),
      ...result.rwAttrs,
      rw_conversation_unread_view: CONVERSATION_UNREAD_VIEW,
      unread_channels_count: result.rows.filter((row) => row.unreadCount > 0).length,
      has_new_channels_count: result.rows.filter((row) => row.hasNew).length,
      rows_count: result.rows.length,
    }),
    (error) => risingWaveInboxFailureAttrs({
      route: "channel_unread",
      error,
      contractVersion: CONVERSATION_UNREAD_CONTRACT_VERSION,
      queryName,
    }),
  );
  recordInboxBackendSelected("rw_mv", "channel_unread", "none", CONVERSATION_UNREAD_CONTRACT_VERSION);
  return read.rows;
}

/**
 * Exact unread counts for the user's subscribed conversations of a server
 * (joined channels incl. muted/private/joint, DMs, followed threads), keyed by
 * LOCAL channel id; only counts > 0. Non-joined public channels are not counted.
 */
export async function getUnreadCounts(
  serverId: string,
  userId: string,
  opts?: UnreadCountOptions,
): Promise<Record<string, number>> {
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;
  const rows = await loadConversationUnreadSummaryRows(serverId, userId, false, traceQuery);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.subscribed && row.unreadCount > 0) counts[row.targetId] = row.unreadCount;
  }
  return counts;
}

function readStateRowFromConversationUnreadRow(row: ConversationUnreadRow): UnreadSummaryReadStateRow {
  return {
    channelId: row.targetId,
    readCursorPresent: row.cursorPresent,
    readStateVersion: row.readStateVersion,
    maxReadSeq: row.lastReadSeq,
    latestActivityMessageId: row.latestMessageId,
    latestActivitySeq: row.latestSeq,
  };
}

/**
 * The sidebar summary of one server: subscribed conversations with their exact
 * count and mention flags, mention-only rows (count 0 + flags), and non-joined
 * public channels with `hasNew` (count 0). Read state rides on the same row.
 */
export async function getUnreadSummary(
  serverId: string,
  userId: string,
  opts?: UnreadCountOptions,
): Promise<Record<string, ChannelUnreadSummaryEntry>> {
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;
  const rows = await loadConversationUnreadSummaryRows(serverId, userId, true, traceQuery);
  const marked = await loadMarkedUnreadScopes(serverId, userId, traceQuery);

  const summary: Record<string, ChannelUnreadSummaryEntry> = {};
  const readStateRows = new Map<string, UnreadSummaryReadStateRow>();
  const absentReadState = makeInboxScopeReadFrontier(null);
  for (const row of rows) {
    const existing = summary[row.targetId];
    if (row.hasNew) {
      // A public channel the user has not joined; a mention-only row for the
      // same channel keeps its flags (and its fuller read-state row).
      summary[row.targetId] = existing
        ? { ...existing, hasNew: true }
        : { unreadCount: 0, hasMention: false, hasAnyMention: false, hasNew: true, readState: absentReadState };
      if (!readStateRows.has(row.targetId)) readStateRows.set(row.targetId, readStateRowFromConversationUnreadRow(row));
      continue;
    }
    summary[row.targetId] = {
      unreadCount: row.subscribed ? row.unreadCount : 0,
      hasMention: row.mentionUnread > 0,
      hasAnyMention: row.totalMentions > 0,
      ...(existing?.hasNew ? { hasNew: true } : {}),
      readState: absentReadState,
    };
    readStateRows.set(row.targetId, readStateRowFromConversationUnreadRow(row));
  }
  // Marked unread: unread with no count. An entry with nothing unread is added
  // for it, and its read state is the cursor's (Postgres, where the flag is
  // written, so version and flag agree), with RisingWave's latest message as
  // the content frontier when it has the row.
  for (const scope of marked.values()) {
    summary[scope.channelId] ??= {
      unreadCount: 0,
      hasMention: false,
      hasAnyMention: false,
      readState: absentReadState,
    };
    const served = readStateRows.get(scope.channelId);
    readStateRows.set(scope.channelId, {
      channelId: scope.channelId,
      readCursorPresent: true,
      readStateVersion: scope.readStateVersion,
      maxReadSeq: scope.maxReadSeq,
      markedUnread: true,
      latestActivityMessageId: served?.latestActivityMessageId ?? null,
      latestActivitySeq: served?.latestActivitySeq ?? null,
    });
  }
  applyUnreadSummaryReadStates(
    summary,
    [...readStateRows.values()],
    (channelId, corruption) => {
      console.error(formatInboxScopeCorruptionLine(channelId, corruption));
    },
  );
  // The view only carries followed, not-done threads under a live parent the
  // user can see. Only those with unread replies reach the badge, so only
  // they are resolved: the lookup scales with unread threads, not follows.
  // A task conversation keeps its own entry (Activity counts it) but gets no
  // parentChannelId: its unread is not the channel's (stdrc 2026-10-31,
  // #triage:c3f04178: "能进 activity 就行了"), since the channel can neither
  // lead to it nor mark it read. Same rule as the web's followed-thread fold.
  const threadIds = rows
    .filter((row) => row.kind === "thread" && row.subscribed && row.unreadCount > 0)
    .map((row) => row.targetId);
  if (threadIds.length > 0) {
    const parentByThread = await loadLocalThreadParentChannelIds(serverId, threadIds, traceQuery);
    for (const threadId of threadIds) {
      const parentChannelId = parentByThread.get(threadId);
      const entry = summary[threadId];
      if (parentChannelId && entry) entry.parentChannelId = parentChannelId;
    }
  }
  return summary;
}

/**
 * Threads of this server whose unread replies mention the user, from the same
 * read as the sidebar summary. Never throws: on failure no thread is marked
 * (hasMention only orders the jump pill) and the failure is traced.
 */
async function loadFollowedThreadMentionIds(
  serverId: string,
  userId: string,
  traceQuery: DbQueryTracer,
): Promise<Set<string>> {
  try {
    const rows = await loadConversationUnreadSummaryRows(serverId, userId, false, traceQuery);
    return new Set(rows.filter((row) => (row.kind === "thread" || row.kind === "task") && row.mentionUnread > 0).map((row) => row.targetId));
  } catch (error) {
    addTraceEvent("followed_threads.mentions.failed", { error_class: errorClassOf(error) });
    return new Set();
  }
}

/**
 * The local parent channel of each thread, in one primary-key read. A thread
 * of this server's own channel has it in channels.parent_channel_id. A joint
 * thread's local projection has no parent message (it lives on the canonical
 * thread), so its parent is this server's projection of the canonical parent
 * channel -- the same mapping as rw_followed_threads_v5's joint_parent_channel_id.
 */
async function loadLocalThreadParentChannelIds(
  serverId: string,
  threadIds: string[],
  traceQuery: DbQueryTracer,
): Promise<Map<string, string>> {
  const result = await traceQuery(
    "channels.unread_summary.thread_parents",
    () => getDb().execute(sql`
      SELECT
        t.id::text AS "threadId",
        COALESCE(
          CASE WHEN own_parent.server_id = ${serverId} THEN t.parent_channel_id END,
          parent_projection.local_channel_id
        )::text AS "parentChannelId"
      FROM channels t
      LEFT JOIN channels own_parent ON own_parent.id = t.parent_channel_id
      LEFT JOIN joint_channel_servers thread_projection
        ON thread_projection.local_channel_id = t.id
       AND thread_projection.status = 'active'
      LEFT JOIN joint_channels thread_joint
        ON thread_joint.id = thread_projection.joint_channel_id
       AND thread_joint.status = 'active'
      LEFT JOIN channels canonical_thread
        ON canonical_thread.id = thread_joint.canonical_channel_id
       AND canonical_thread.type = 'thread'
      LEFT JOIN joint_channels parent_joint
        ON parent_joint.canonical_channel_id = canonical_thread.parent_channel_id
       AND parent_joint.status = 'active'
      LEFT JOIN joint_channel_servers parent_projection
        ON parent_projection.joint_channel_id = parent_joint.id
       AND parent_projection.server_id = ${serverId}
       AND parent_projection.status = 'active'
      WHERE t.id IN (${sql.join(threadIds.map((id) => sql`${id}::uuid`), sql`, `)})
        -- Task conversations (task v2) carry their local parent channel in
        -- parent_channel_id on every face (own_parent arm).
        AND t.type IN ('thread', 'task')
    `),
    (result) => ({
      input_count: threadIds.length,
      resolved_count: (result.rows as Array<{ parentChannelId: string | null }>).filter((row) => row.parentChannelId).length,
    }),
  );
  const parentByThread = new Map<string, string>();
  for (const row of result.rows as Array<{ threadId: string; parentChannelId: string | null }>) {
    if (row.parentChannelId) parentByThread.set(row.threadId, row.parentChannelId);
  }
  return parentByThread;
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
  /** The cursor row's marked_unread (false when absent or not carried by the reader). */
  markedUnread?: boolean;
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
        markedUnread: row.markedUnread === true,
      }
      : null;
    entry.readState = makeInboxScopeReadFrontier(cursor, (c) => onCorrupt(row.channelId, c));
  }
}

/**
 * Per-server count behind the pink "other servers have unread" badge: the SUM of
 * exact unread over the user's subscribed channels and DMs (muted included, as
 * before), from the same view as the sidebar summary. Excludes followed threads,
 * mention-only rows and non-joined public channels.
 */
export async function getSidebarUnreadSummaryCounts(
  serverIds: string[],
  userId: string,
  opts: SidebarUnreadSummaryOptions = {},
): Promise<Record<string, number>> {
  const uniqueServerIds = [...new Set(serverIds)];
  if (uniqueServerIds.length === 0) return {};
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const queryName = "servers.sidebar_unread_counts_by_user";
  const read = await traceQuery(
    queryName,
    () => readSidebarUnreadTotals({ serverIds: uniqueServerIds, userId }),
    (result) => ({
      ...inboxTraceAttrs("rw_mv", "sidebar_summary", "none", CONVERSATION_UNREAD_CONTRACT_VERSION),
      ...result.rwAttrs,
      rw_conversation_unread_view: CONVERSATION_UNREAD_VIEW,
      servers_count: uniqueServerIds.length,
      servers_with_unread_count: result.rows.filter((row) => row.unreadCount > 0).length,
    }),
    (error) => risingWaveInboxFailureAttrs({
      route: "sidebar_summary",
      error,
      contractVersion: CONVERSATION_UNREAD_CONTRACT_VERSION,
      queryName,
    }),
  );
  const counts: Record<string, number> = {};
  for (const serverId of uniqueServerIds) counts[serverId] = 0;
  for (const row of read.rows) {
    if (row.serverId in counts) counts[row.serverId] = row.unreadCount;
  }
  recordInboxBackendSelected("rw_mv", "sidebar_summary", "none", CONVERSATION_UNREAD_CONTRACT_VERSION);
  return counts;
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
/**
 * An agent's own send: advance its read cursor to the sent message only when
 * that reads through nothing it has not been handed. If the conversation holds
 * unread from others between the cursor and the new message (the inbox's own
 * unread rule: not the agent's sends, not system rows it caused, not noise
 * subtypes), the cursor stays where it is, and those messages are still
 * delivered. The agent's own message never counts as unread for it (the inbox
 * chain and the pull exclude it), so leaving the cursor below it is safe.
 * Check and write are one statement.
 *
 * `channelId` keys the cursor (the agent-facing, local conversation id);
 * `storageChannelId` is where the rows live. They differ for a joint channel
 * or joint thread, whose rows are stored under the canonical id: checking the
 * local id there would find nothing and read through every unread row.
 *
 * The same statement also returns the position it moved from and the agent's
 * server, for agent read progress (agentReadProgressService): no extra query.
 */
export async function markAgentOwnSendRead(agentId: string, channelId: string, seq: number, storageChannelId: string = channelId) {
  const db = getDb();
  const result = await db.execute(sql`
    WITH cursor_now AS (
      SELECT COALESCE(
        (SELECT COALESCE(last_read_seq8, CAST(last_read_seq AS BIGINT))
         FROM agent_channel_read_cursors
         WHERE agent_id = ${agentId} AND channel_id = ${channelId}),
        0
      ) AS seq
    ), advanced AS (
      INSERT INTO agent_channel_read_cursors (agent_id, channel_id, last_read_seq, updated_at)
      SELECT ${agentId}, ${channelId}, ${seq}, now()
      WHERE NOT EXISTS (
        SELECT 1 FROM messages m, cursor_now
        WHERE m.channel_id = ${storageChannelId}
          AND m.seq > cursor_now.seq
          AND m.seq < ${seq}
          AND NOT (m.sender_type = 'agent' AND m.sender_id = ${agentId}::text)
          AND NOT COALESCE(m.message_type = 'system' AND m.causal_actor_type = 'agent' AND m.causal_actor_id = ${agentId}::text, FALSE)
          AND (m.system_subtype IS NULL OR m.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
      )
      ON CONFLICT (agent_id, channel_id) DO UPDATE SET
        last_read_seq = EXCLUDED.last_read_seq,
        updated_at = now()
      WHERE agent_channel_read_cursors.last_read_seq < EXCLUDED.last_read_seq
      RETURNING channel_id, last_read_seq
    )
    SELECT
      advanced.channel_id::text AS "channelId",
      advanced.last_read_seq::int AS "maxReadSeq",
      (SELECT seq FROM cursor_now)::text AS "priorSeq",
      (SELECT server_id::text FROM agents WHERE id = ${agentId}::uuid) AS "serverId"
    FROM advanced
  `);
  const [advanced] = result.rows as Array<{ channelId: string; maxReadSeq: number; priorSeq: string | null; serverId: string | null }>;
  if (advanced) {
    noteAgentLegacyCursorAdvance(agentId, advanced);
    return { channelId: advanced.channelId, maxReadSeq: advanced.maxReadSeq, changed: true };
  }
  return { channelId, maxReadSeq: await getAgentLegacyReadCursor(agentId, channelId), changed: false };
}

/** Agent read progress for a legacy cursor write that moved (markAgentOwnSendRead, markAgentLegacyRead). */
function noteAgentLegacyCursorAdvance(
  agentId: string,
  advanced: { channelId: string; maxReadSeq: number; priorSeq: string | null; serverId: string | null },
): void {
  if (!advanced.serverId) return;
  noteAgentReadAdvance({
    serverId: advanced.serverId,
    scopeId: advanced.channelId,
    agentId,
    from: Number(advanced.priorSeq ?? 0),
    to: Number(advanced.maxReadSeq),
  });
}

/** The same statement also returns the position it moved from and the agent's server (agent read progress). */
export async function markAgentLegacyRead(agentId: string, channelId: string, seq: number) {
  const db = getDb();
  const result = await db.execute(sql`
    WITH cursor_now AS (
      SELECT COALESCE(
        (SELECT last_read_seq FROM agent_channel_read_cursors
         WHERE agent_id = ${agentId} AND channel_id = ${channelId}),
        0
      ) AS seq
    ), advanced AS (
      INSERT INTO agent_channel_read_cursors (agent_id, channel_id, last_read_seq, updated_at)
      VALUES (${agentId}, ${channelId}, ${seq}, now())
      ON CONFLICT (agent_id, channel_id) DO UPDATE SET
        last_read_seq = EXCLUDED.last_read_seq,
        updated_at = now()
      WHERE agent_channel_read_cursors.last_read_seq < EXCLUDED.last_read_seq
      RETURNING channel_id, last_read_seq
    )
    SELECT
      advanced.channel_id::text AS "channelId",
      advanced.last_read_seq::int AS "maxReadSeq",
      (SELECT seq FROM cursor_now)::text AS "priorSeq",
      (SELECT server_id::text FROM agents WHERE id = ${agentId}::uuid) AS "serverId"
    FROM advanced
  `);
  const [advanced] = result.rows as Array<{ channelId: string; maxReadSeq: number; priorSeq: string | null; serverId: string | null }>;
  if (advanced) {
    noteAgentLegacyCursorAdvance(agentId, advanced);
    return { channelId: advanced.channelId, maxReadSeq: advanced.maxReadSeq, changed: true };
  }

  await db
    .update(agentChannelReadCursors)
    .set({ updatedAt: currentDate() })
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
export type AgentReadPositionAdvance = {
  /** The agent-facing conversation (the read cursor's channel). */
  conversationId: string;
  /** Where its rows are stored (a joint channel's canonical channel). */
  storageId: string;
  /** The read position before and after the ack. */
  from: number;
  to: number;
  /** The acked seqs in (from, to]. */
  acked: number[];
};

/** Returns the conversations whose read position the ack moved forward. */
export async function markAgentLegacyAckCheckpoint(agentId: string, seqs: number[]): Promise<AgentReadPositionAdvance[]> {
  const normalizedSeqs = [...new Set(seqs
    .map((seq) => Math.floor(Number(seq)))
    .filter((seq) => Number.isInteger(seq) && seq > 0))];
  if (normalizedSeqs.length === 0) return [];

  // The cursor belongs to the conversation the agent was delivered: a message stored
  // under a joint channel's canonical channel (or thread) is acked on the agent's
  // server's local projection of it, the id live delivery and recovery hand the
  // agent. Only conversations the agent belongs to are written: a member of the
  // channel (for a thread, of its parent channel), or a follower of the thread.
  const result = await getDb().execute(sql`
    WITH acked AS (
      SELECT ${messages.channelId} AS storage_id, max(${messages.seq})::int AS max_seq,
        array_agg(${messages.seq}::bigint) AS seqs
      FROM ${messages}
      WHERE ${inArray(messages.seq, normalizedSeqs)}
      GROUP BY ${messages.channelId}
    ), targets AS (
      SELECT COALESCE(${jointChannelServers.localChannelId}, acked.storage_id) AS target_id, acked.storage_id, acked.max_seq, acked.seqs
      FROM acked
      INNER JOIN ${agents} ON ${agents.id} = ${agentId}
      LEFT JOIN ${jointChannels}
        ON ${jointChannels.canonicalChannelId} = acked.storage_id AND ${jointChannels.status} = 'active'
      LEFT JOIN ${jointChannelServers}
        ON ${jointChannelServers.jointChannelId} = ${jointChannels.id}
        AND ${jointChannelServers.serverId} = ${agents.serverId}
        AND ${jointChannelServers.status} = 'active'
    )
    SELECT targets.target_id AS "channelId", targets.storage_id::text AS "storageId", targets.max_seq AS "maxSeq",
      targets.seqs::text[] AS "seqs", ${channels.serverId}::text AS "serverId",
      (SELECT COALESCE(c.last_read_seq8, CAST(c.last_read_seq AS BIGINT))::text FROM agent_channel_read_cursors c
        WHERE c.agent_id = ${agentId} AND c.channel_id = targets.target_id) AS "priorSeq"
    FROM targets
    INNER JOIN ${channels} ON ${channels.id} = targets.target_id
    LEFT JOIN ${messages} AS parent ON parent.id = ${channels.parentMessageId}
    WHERE EXISTS (
        SELECT 1 FROM ${channelAgents}
        WHERE ${channelAgents.channelId} = COALESCE(parent.channel_id, targets.target_id)
          AND ${channelAgents.agentId} = ${agentId}
      )
      OR EXISTS (
        SELECT 1 FROM ${threadFollows}
        WHERE ${threadFollows.threadChannelId} = targets.target_id
          AND ${threadFollows.followerType} = 'agent'
          AND ${threadFollows.followerId} = ${agentId}
          AND ${threadFollows.unfollowedAt} IS NULL
      )
  `);
  const rows = (result.rows as Array<{ channelId: string; storageId: string; maxSeq: number | string; seqs: string[] | null; serverId: string | null; priorSeq: string | null }>)
    .map((row) => ({
      channelId: String(row.channelId),
      storageId: String(row.storageId),
      maxSeq: Number(row.maxSeq),
      seqs: (row.seqs ?? []).map(Number),
      serverId: row.serverId === null ? null : String(row.serverId),
      priorSeq: row.priorSeq === null ? 0 : Number(row.priorSeq),
    }));

  // markAgentLegacyRead for every conversation in one statement: a cursor only
  // moves forward, and one that does not still has updated_at touched.
  const maxSeqByChannel = new Map<string, number>();
  for (const row of rows) maxSeqByChannel.set(row.channelId, Math.max(maxSeqByChannel.get(row.channelId) ?? 0, row.maxSeq));
  if (maxSeqByChannel.size === 0) return [];
  const values = sql.join(
    [...maxSeqByChannel].map(([channelId, maxSeq]) => sql`(${agentId}::uuid, ${channelId}::uuid, ${maxSeq}::int, now())`),
    sql`, `,
  );
  await getDb().execute(sql`
    INSERT INTO agent_channel_read_cursors (agent_id, channel_id, last_read_seq, updated_at)
    VALUES ${values}
    ON CONFLICT (agent_id, channel_id) DO UPDATE SET
      last_read_seq = GREATEST(agent_channel_read_cursors.last_read_seq, EXCLUDED.last_read_seq),
      updated_at = now()
  `);
  // The read before the upsert: a concurrent advance in between only narrows what counts as passed.
  const advances: AgentReadPositionAdvance[] = [];
  for (const row of rows) {
    if (row.maxSeq <= row.priorSeq) continue;
    advances.push({
      conversationId: row.channelId,
      storageId: row.storageId,
      from: row.priorSeq,
      to: row.maxSeq,
      acked: row.seqs.filter((seq) => seq > row.priorSeq && seq <= row.maxSeq),
    });
    // Agent read progress (agentReadProgressService): `/events` acks (an
    // external agent's, or a `raft message check` that reaches the server; a
    // hosted agent's is answered by its daemon and never gets here, RFC 081 §3),
    // receive-ack and external-agent acks all move the position here.
    if (row.serverId) {
      noteAgentReadAdvance({ serverId: row.serverId, scopeId: row.channelId, agentId, from: row.priorSeq, to: row.maxSeq });
    }
  }
  return advances;
}

export type AgentFollowedThreadListItem = {
  target: string;
  threadChannelId: string;
  parentChannelRef: string;
  parentMessageId: string;
  parentMessageShortId: string;
  followedAt: string;
  reason: string;
  doneAt: string | null;
};

export async function listAgentFollowedThreads(
  serverId: string,
  agentId: string,
): Promise<AgentFollowedThreadListItem[]> {
  const db = getDb();

  const rows = await db
    .select({
      threadChannelId: channels.id,
      parentMessageId: threadFollows.parentMessageId,
      followedAt: threadFollows.createdAt,
      reason: threadFollows.reason,
      doneAt: threadFollows.doneAt,
    })
    .from(threadFollows)
    .innerJoin(channels, and(
      eq(channels.id, threadFollows.threadChannelId),
      eq(channels.type, "thread"),
      eq(channels.serverId, serverId),
      isNull(channels.deletedAt),
    ))
    .where(and(
      eq(threadFollows.followerType, "agent"),
      eq(threadFollows.followerId, agentId),
      isNull(threadFollows.unfollowedAt),
    ))
    .orderBy(desc(threadFollows.createdAt), desc(threadFollows.threadChannelId));

  // The LOCAL parent channel: a joint thread's projection has no parent
  // message on this server (its follow row names the canonical parent, stored
  // on the joint storage server), so the parent comes from the projection
  // mapping, not from the parent message's channel (task #24).
  const parentByThread = rows.length === 0
    ? new Map<string, string>()
    : await loadLocalThreadParentChannelIds(serverId, rows.map((row) => row.threadChannelId), untracedDbQuery);

  const items: AgentFollowedThreadListItem[] = [];
  for (const row of rows) {
    const parentChannelId = parentByThread.get(row.threadChannelId);
    if (!parentChannelId || !row.parentMessageId) continue;
    if (!await canAgentAccessChannel(row.threadChannelId, agentId)) continue;
    const parentChannelRef = await resolveAgentFacingChannelRef(serverId, agentId, parentChannelId);
    if (!parentChannelRef) continue;
    const parentMessageShortId = row.parentMessageId.slice(0, 8);
    items.push({
      target: `${parentChannelRef}:${parentMessageShortId}`,
      threadChannelId: row.threadChannelId,
      parentChannelRef,
      parentMessageId: row.parentMessageId,
      parentMessageShortId,
      followedAt: row.followedAt.toISOString(),
      reason: row.reason,
      doneAt: row.doneAt ? row.doneAt.toISOString() : null,
    });
  }
  return items;
}

/**
 * One (agent, target) row of the agent inbox view (UNIFIED_CHAIN_VIEWS.agentInbox,
 * rw_agent_inbox_v7 in infra/risingwave/sql/078-task-conversations.sql). The view owns
 * every offer rule: it holds ONLY the conversations the agent is offered (joined
 * through a membership or an active follow; admitted-stream unread, or a mention
 * unread beyond the admitted stream -- a mention after a mute pierces it),
 * and thread rows only when the agent can receive the thread (parent access, thread
 * and parent not deleted). The app reads these rows; it does not re-filter them.
 * `target_id` is the agent-facing channel (a joint channel's LOCAL projection);
 * `storage_channel_id` is where its messages live.
 */
export interface AgentInboxChainRow {
  targetId: string;
  storageChannelId: string;
  /** "task": a task conversation (task v2), a sub-conversation like a thread (078). */
  kind: "channel" | "dm" | "thread" | "task";
  serverId: string;
  channelName: string;
  channelType: typeof channels.$inferSelect["type"];
  /** A thread's parent message; for a joint thread's local projection, the canonical parent. */
  parentMessageId: string | null;
  /** The LOCAL parent channel (rw_thread_parent_v3). */
  parentChannelId: string | null;
  parentChannelName: string | null;
  parentChannelType: string | null;
  lastReadSeq: number;
  unreadCount: number;
  firstUnreadSeq: number | null;
  latestSeq: number | null;
  mentionUnread: number;
  maxMentionSeq: number | null;
  /** False when the row exists only through the mention arm (e.g. a muted channel). */
  subscribed: boolean;
  /** The unread the agent is offered: subscribed ? unread_count : mention_unread. */
  offeredUnread: number;
  /** GREATEST(latest_seq, max_mention_seq): the newest activity, the inbox page key. */
  activitySeq: number;
  /** channel_agents.added_at, or the active thread follow's created_at. */
  joinedAt: Date;
  /**
   * Task conversations only: the task's number and title (not view columns:
   * readAgentInboxChainRows adds them from Postgres). The row's agent-facing
   * target is the task ref `#parent:#N` (formatAgentInboxTarget).
   */
  taskNumber?: number | null;
  taskTitle?: string | null;
}

export type AgentInboxChainSelection =
  | { source: "chain"; rows: AgentInboxChainRow[] }
  | { source: "unavailable"; reason: "rw_unconfigured" | "rw_error" };

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Read, once per resume, the agent's rows from the unified chain -- the only
 * source of agent recovery. Both consumers (unread summary and catch-up
 * candidates) take the SAME rows. When the chain is unconfigured or its read
 * fails the selection is `unavailable` and the caller skips recovery; there is
 * no second source to fall back to.
 */
export async function selectAgentInboxChainRows(agentId: string): Promise<AgentInboxChainSelection> {
  const pool = getRisingWaveInboxPool();
  if (!pool) return { source: "unavailable", reason: "rw_unconfigured" };
  try {
    return { source: "chain", rows: await readAgentInboxChainRows(pool, agentId) };
  } catch (error) {
    console.error(`[ChannelService] agent inbox chain read failed for agent ${agentId}; skipping resume recovery:`, error);
    return { source: "unavailable", reason: "rw_error" };
  }
}

/**
 * Narrows a chain read. With `limit`, the rows come newest activity first
 * (`ORDER BY activity_seq DESC LIMIT`), one range scan of the view's
 * (agent_id, activity_seq DESC) index.
 */
export type AgentInboxChainReadOptions = {
  kind?: AgentInboxChainRow["kind"];
  beforeSeq?: number;
  mentionsOnly?: boolean;
  limit?: number;
};

/** Read one agent's rows from the agent inbox view. Throws on query failure. */
export async function readAgentInboxChainRows(
  pool: NonNullable<ReturnType<typeof getRisingWavePool>>,
  agentId: string,
  opts: AgentInboxChainReadOptions = {},
): Promise<AgentInboxChainRow[]> {
  const values: unknown[] = [agentId];
  const where = ["agent_id = $1"];
  if (opts.kind !== undefined) {
    values.push(opts.kind);
    where.push(`kind = $${values.length}`);
  }
  if (opts.beforeSeq !== undefined) {
    values.push(opts.beforeSeq);
    where.push(`activity_seq < $${values.length}`);
  }
  if (opts.mentionsOnly) where.push("mention_unread > 0");
  let page = "";
  if (opts.limit !== undefined) {
    // RisingWave only accepts a constant after LIMIT (a bind parameter fails to
    // prepare: "expects an integer ... after LIMIT, but found non-const
    // expression"), so the validated integer is inlined.
    const limit = Math.trunc(opts.limit);
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`invalid agent inbox page limit: ${opts.limit}`);
    page = `
    ORDER BY activity_seq DESC
    LIMIT ${limit}`;
  }
  const read = await queryRisingWaveInbox(pool, `SELECT
      target_id, storage_channel_id, kind, server_id, channel_name, channel_type, parent_message_id,
      parent_channel_id, parent_channel_name, parent_channel_type, last_read_seq, unread_count,
      first_unread_seq, latest_seq, mention_unread, max_mention_seq, subscribed, offered_unread,
      activity_seq, joined_at
    FROM ${UNIFIED_CHAIN_VIEWS.agentInbox}
    WHERE ${where.join(" AND ")}${page}`, values);
  const rows = read.result.rows.map((row): AgentInboxChainRow => ({
    targetId: String(row.target_id),
    storageChannelId: String(row.storage_channel_id),
    kind: row.kind as AgentInboxChainRow["kind"],
    serverId: String(row.server_id),
    channelName: String(row.channel_name),
    channelType: row.channel_type as AgentInboxChainRow["channelType"],
    parentMessageId: row.parent_message_id == null ? null : String(row.parent_message_id),
    parentChannelId: row.parent_channel_id == null ? null : String(row.parent_channel_id),
    parentChannelName: row.parent_channel_name == null ? null : String(row.parent_channel_name),
    parentChannelType: row.parent_channel_type == null ? null : String(row.parent_channel_type),
    lastReadSeq: Number(row.last_read_seq),
    unreadCount: Number(row.unread_count),
    firstUnreadSeq: toNullableNumber(row.first_unread_seq),
    latestSeq: toNullableNumber(row.latest_seq),
    mentionUnread: Number(row.mention_unread),
    maxMentionSeq: toNullableNumber(row.max_mention_seq),
    subscribed: row.subscribed === true,
    offeredUnread: Number(row.offered_unread),
    activitySeq: Number(row.activity_seq),
    joinedAt: new Date(row.joined_at as string | Date),
  }));
  await attachAgentInboxTaskIdentity(rows);
  return rows;
}

/**
 * Task v2: the number and title of the task behind each task-conversation row
 * (kind "task"), by its conversation channel, in one primary-key read. Rows of
 * other kinds are untouched; with no task rows nothing is read.
 */
async function attachAgentInboxTaskIdentity(rows: AgentInboxChainRow[]): Promise<void> {
  const conversationIds = [...new Set(rows.filter((row) => row.kind === "task").map((row) => row.targetId))]
    .filter((id) => UUID_TEXT_RE.test(id));
  if (conversationIds.length === 0) return;
  const taskRows = await getDb()
    .select({ conversationId: channels.id, taskNumber: tasks.taskNumber, title: tasks.title })
    .from(channels)
    .innerJoin(tasks, eq(tasks.id, channels.taskId))
    .where(inArray(channels.id, conversationIds));
  const byConversation = new Map(taskRows.map((row) => [row.conversationId, row]));
  for (const row of rows) {
    if (row.kind !== "task") continue;
    const task = byConversation.get(row.targetId);
    row.taskNumber = task?.taskNumber ?? null;
    row.taskTitle = task?.title ?? null;
  }
}

export type AgentInboxTotals = { conversations: number; dms: number; mentions: number };

/** The agent's inbox totals, counted in the view. Throws on query failure. */
export async function readAgentInboxChainTotals(
  pool: NonNullable<ReturnType<typeof getRisingWavePool>>,
  agentId: string,
): Promise<AgentInboxTotals> {
  const read = await queryRisingWaveInbox(pool, `SELECT
      count(*) AS conversations,
      count(*) FILTER (WHERE kind = 'dm') AS dms,
      count(*) FILTER (WHERE mention_unread > 0) AS mentions
    FROM ${UNIFIED_CHAIN_VIEWS.agentInbox}
    WHERE agent_id = $1`, [agentId]);
  const row = read.result.rows[0] ?? {};
  return {
    conversations: Number(row.conversations ?? 0),
    dms: Number(row.dms ?? 0),
    mentions: Number(row.mentions ?? 0),
  };
}

/**
 * The seq columns of one (agent, target) row of the agent inbox view, or, for a
 * target the agent has no row for (`inAgentInbox` false), the target's own
 * progress in the chain (`targetLatestSeq`, rw_target_latest_v4).
 */
export type AgentInboxChainSeqRow = Pick<AgentInboxChainRow, "targetId" | "latestSeq" | "maxMentionSeq" | "lastReadSeq"> & {
  inAgentInbox: boolean;
  targetLatestSeq: number | null;
};

/**
 * The seq columns of the agent's rows for `targetIds` (agent-facing channel
 * ids): what `/events?wait_for=` re-checks while the chain catches up to a
 * notice. The agent inbox view only has rows for conversations with something
 * to offer, so a target with no row (the agent already read it, the message was
 * deleted, the agent can no longer see it -- or the chain has not caught up
 * yet) gets a second, per-target read of the conversation's own latest seq,
 * only for those targets: at or past the notice's seq means the message is in
 * the chain and there is simply nothing to deliver. Every target comes back.
 * Null when RisingWave is not configured; throws on query failure (an overload
 * as RisingWaveOverloadedError).
 */
export async function readAgentInboxChainTargetSeqs(
  agentId: string,
  targetIds: readonly string[],
): Promise<AgentInboxChainSeqRow[] | null> {
  const pool = getRisingWaveInboxPool();
  if (!pool) return null;
  if (targetIds.length === 0) return [];
  const read = await queryRisingWaveInbox(pool, `SELECT target_id, latest_seq, max_mention_seq, last_read_seq
    FROM ${UNIFIED_CHAIN_VIEWS.agentInbox}
    WHERE agent_id = $1 AND target_id = ANY($2)`, [agentId, [...targetIds]]);
  const rows = read.result.rows.map((row): AgentInboxChainSeqRow => ({
    targetId: String(row.target_id),
    latestSeq: toNullableNumber(row.latest_seq),
    maxMentionSeq: toNullableNumber(row.max_mention_seq),
    lastReadSeq: Number(row.last_read_seq ?? 0),
    inAgentInbox: true,
    targetLatestSeq: null,
  }));
  const found = new Set(rows.map((row) => row.targetId));
  const missing = [...new Set(targetIds)].filter((targetId) => !found.has(targetId));
  if (missing.length === 0) return rows;
  const targetRead = await queryRisingWaveInbox(pool, `SELECT target_id, latest_seq
    FROM rw_target_latest_v4
    WHERE target_id = ANY($1)`, [missing]);
  const targetLatest = new Map(targetRead.result.rows.map((row) => [String(row.target_id), toNullableNumber(row.latest_seq)] as const));
  return [...rows, ...missing.map((targetId): AgentInboxChainSeqRow => ({
    targetId,
    latestSeq: null,
    maxMentionSeq: null,
    lastReadSeq: 0,
    inAgentInbox: false,
    targetLatestSeq: targetLatest.get(targetId) ?? null,
  }))];
}

const AGENT_UNREAD_SUMMARY_MAX_TARGETS = 20;

/**
 * The resume prompt lists unread targets one line each; an agent following
 * thousands of threads (prod max 13,906) would get a prompt of thousands of lines.
 * Keep DMs (and DM threads) first, then the targets with the most unread, and
 * fold the rest into one line that says how many were left out. The daemon
 * renders every entry as "- <label>: <n> unread", so the folded line reads
 * naturally without a daemon change.
 */
export function capAgentUnreadSummary(
  counts: Record<string, number>,
  max = AGENT_UNREAD_SUMMARY_MAX_TARGETS,
): Record<string, number> {
  const entries = Object.entries(counts);
  if (entries.length <= max) return counts;
  entries.sort(([a, na], [b, nb]) => {
    const dmA = a.startsWith("dm:") ? 0 : 1;
    const dmB = b.startsWith("dm:") ? 0 : 1;
    return dmA - dmB || nb - na || a.localeCompare(b);
  });
  const kept = entries.slice(0, max);
  const rest = entries.slice(max);
  const folded = rest.reduce((sum, [, n]) => sum + n, 0);
  return {
    ...Object.fromEntries(kept),
    [`(${rest.length} more conversations — run \`raft inbox check\` to list them)`]: folded,
  };
}

/**
 * The agent-facing `dm:@peer` ref of every DM the rows name (DM rows, and the
 * parent DM of DM threads). A DM with no addressable peer (e.g. the single-member
 * migration receipt DM) has no entry.
 */
export async function resolveAgentInboxDmRefs(
  agentId: string,
  rows: readonly AgentInboxChainRow[],
): Promise<Map<string, string>> {
  const byServer = new Map<string, Set<string>>();
  for (const row of rows) {
    const channelId = row.kind === "dm"
      ? row.targetId
      : (row.kind === "thread" || row.kind === "task") && row.parentChannelType === "dm" ? row.parentChannelId : null;
    if (!channelId) continue;
    const ids = byServer.get(row.serverId) ?? new Set<string>();
    ids.add(channelId);
    byServer.set(row.serverId, ids);
  }
  const refs = new Map<string, string>();
  for (const [serverId, ids] of byServer) {
    for (const [channelId, ref] of await resolveAgentFacingDmRefs(serverId, agentId, [...ids])) refs.set(channelId, ref);
  }
  return refs;
}

/**
 * The batched form of resolveAgentFacingChannelRef for DM channels: `dm:@peer`
 * for each DM the agent belongs to, by the same rules (DM identity row first;
 * legacy DMs by their other human, then other agent member; built-in app
 * conversations by their app id). One query per 500 channels instead of several
 * per channel — an agent can have hundreds of unread DM threads.
 */
export async function resolveAgentFacingDmRefs(
  serverId: string,
  agentId: string,
  dmChannelIds: readonly string[],
): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  const ids = [...new Set(dmChannelIds)];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const result = await getDb().execute(sql`
      SELECT c.id::text AS channel_id, c.name AS channel_name,
        i.kind AS identity_kind, i.peer_key AS peer_key,
        (SELECT u.name FROM ${users} AS u
          WHERE i.kind = 'human_agent' AND u.id = peer.id) AS identity_human,
        (SELECT a.name FROM ${agents} AS a
          WHERE i.kind = 'agent_agent' AND a.server_id = c.server_id AND a.id = peer.id) AS identity_agent,
        (SELECT u.name FROM ${channelHumans} AS h INNER JOIN ${users} AS u ON u.id = h.user_id
          WHERE h.channel_id = c.id LIMIT 1) AS legacy_human,
        (SELECT a.name FROM ${channelAgents} AS ca INNER JOIN ${agents} AS a ON a.id = ca.agent_id
          WHERE ca.channel_id = c.id AND ca.agent_id <> ${agentId} LIMIT 1) AS legacy_agent,
        (SELECT s.kind FROM ${agentPrivateSurfaces} AS s
          WHERE s.channel_id = c.id AND s.agent_id = ${agentId} LIMIT 1) AS private_surface_kind,
        (SELECT 'yes' FROM ${agentMigrationReceiptChannels} AS r
          WHERE r.channel_id = c.id AND r.agent_id = ${agentId} LIMIT 1) AS migration_receipt
      FROM ${channels} AS c
      INNER JOIN ${channelAgents} AS me ON me.channel_id = c.id AND me.agent_id = ${agentId}
      LEFT JOIN ${dmChannelIdentities} AS i ON i.channel_id = c.id AND i.server_id = c.server_id
      -- The identity's other participant as a uuid (NULL when it is not one),
      -- so the name lookups above are primary-key probes; comparing id::text
      -- would scan users/agents once per DM.
      LEFT JOIN LATERAL (
        SELECT ${sqlUuidOrNull(sql.raw("p"))} AS id
        FROM unnest(string_to_array(i.peer_key, ':')) AS p
        WHERE p <> ${agentId}
        LIMIT 1
      ) AS peer ON true
      WHERE c.id IN (${sql.join(chunk.map((id) => sql`${id}::uuid`), sql`, `)})
        AND c.type = 'dm' AND c.server_id = ${serverId}
    `);
    const peers: Array<{ channelId: string; name: string; kind: DmPeerKind | null }> = [];
    for (const row of result.rows as Array<Record<string, string | null>>) {
      let peer: { name: string; kind: DmPeerKind | null } | null = null;
      if (row.private_surface_kind === "reminders") {
        peer = { name: AGENT_REMINDERS_DM_PEER, kind: null };
      } else if (row.migration_receipt === "yes") {
        // Mirrors resolveAgentFacingChannelRef: the receipt DM is named by its channel.
        peer = { name: String(row.channel_name), kind: null };
      } else if (row.identity_kind) {
        // Mirrors resolveAgentFacingChannelRef: an identity row is authoritative;
        // the agent must be one of its participants.
        const participants = String(row.peer_key ?? "").split(":");
        if (participants.includes(agentId)) {
          if (row.identity_kind === "human_agent" && row.identity_human) peer = { name: row.identity_human, kind: "human" };
          if (row.identity_kind === "agent_agent" && row.identity_agent) peer = { name: row.identity_agent, kind: "agent" };
        }
      } else if (row.legacy_human) {
        peer = { name: row.legacy_human, kind: "human" };
      } else if (row.legacy_agent) {
        peer = { name: row.legacy_agent, kind: "agent" };
      } else if (isAppId(String(row.channel_name))) {
        peer = { name: String(row.channel_name), kind: null };
      }
      if (peer) peers.push({ channelId: String(row.channel_id), ...peer });
    }
    const twins = await findCrossKindTwinPeerNames(serverId, peers.filter((p) => p.kind).map((p) => p.name));
    for (const peer of peers) {
      refs.set(peer.channelId, `dm:@${formatDmPeerRef(peer.name, twins.has(peer.name) ? peer.kind : null)}`);
    }
  }
  return refs;
}

/**
 * The bare peer face of one DM, as the agent-facing payload prints it: `name`
 * or `name~kind` (the `dm:@...` target with the prefix stripped). Reuses the
 * batched resolveAgentFacingDmRefs — identity-row-first resolution plus the
 * twin suffix — so the rendered label always matches the target DSL exactly.
 */
export async function resolveAgentFacingDmPeerFace(
  serverId: string,
  agentId: string,
  channelId: string,
): Promise<string | null> {
  const refs = await resolveAgentFacingDmRefs(serverId, agentId, [channelId]);
  const ref = refs.get(channelId);
  if (!ref) return null;
  return ref.slice("dm:@".length);
}

/**
 * THE target of an agent inbox row, in the delivery target DSL (what
 * `raft message send/read --target` takes and live delivery prints):
 * `#chan`, `#chan:<parent short id>`, `dm:@peer`, `dm:@peer:<parent short id>`;
 * a task conversation (task v2) is its task ref `#chan:#7` / `dm:@peer:#7`
 * (what `raft task read/reply` take).
 * The resume summary and `raft inbox check` both label rows with it.
 */
export function formatAgentInboxTarget(row: AgentInboxChainRow, dmRefs: ReadonlyMap<string, string>): string {
  if (row.kind === "dm") return dmRefs.get(row.targetId) ?? `dm:@${row.channelName}`;
  if (row.kind === "task" && row.parentChannelName && row.taskNumber != null) {
    if (row.parentChannelType === "dm") {
      const parentRef = (row.parentChannelId ? dmRefs.get(row.parentChannelId) : undefined) ?? `dm:@${row.parentChannelName}`;
      // The DM ref may carry a `~agent`/`~human` suffix, so append rather than reformat.
      return `${parentRef}${RAFT_TASK_REF_SEPARATOR}${row.taskNumber}`;
    }
    return formatRaftChannelTaskRef(row.parentChannelName, row.taskNumber);
  }
  if (row.kind === "thread" && row.parentMessageId && row.parentChannelName) {
    const shortId = row.parentMessageId.slice(0, 8);
    if (row.parentChannelType === "dm") {
      const parentRef = (row.parentChannelId ? dmRefs.get(row.parentChannelId) : undefined) ?? `dm:@${row.parentChannelName}`;
      return `${parentRef}:${shortId}`;
    }
    return `#${row.parentChannelName}:${shortId}`;
  }
  return `#${row.channelName}`;
}

/**
 * Unread counts for the conversations an agent will be offered on resume, from
 * the unified chain's rows (read once for this resume by
 * selectAgentInboxChainRows). Returns target -> offered unread. The chain gates
 * the free-plan history window per target (rw_target_eligible_v1), not per message.
 * A DM with no addressable peer is skipped, as in listAgentInbox: no target opens it.
 */
export async function getAgentUnreadCounts(
  agentId: string,
  chain: AgentInboxChainRow[],
  resolvedDmRefs?: ReadonlyMap<string, string>,
): Promise<Record<string, number>> {
  const dmRefs = resolvedDmRefs ?? await resolveAgentInboxDmRefs(agentId, chain);
  const counts: Record<string, number> = {};
  for (const row of chain) {
    if (row.offeredUnread <= 0) continue;
    if (row.kind === "dm" && !dmRefs.has(row.targetId)) continue;
    const target = formatAgentInboxTarget(row, dmRefs);
    counts[target] = (counts[target] ?? 0) + row.offeredUnread;
  }
  return counts;
}

/**
 * What a start's unread summary covers, by the same target the summary names:
 * the conversations behind each target and the latest seq the chain showed for
 * them. A completed first turn may settle these (unowedReadBacklog.ts), never
 * further than this snapshot.
 */
export async function getAgentUnreadSummaryTargets(
  agentId: string,
  chain: AgentInboxChainRow[],
  resolvedDmRefs?: ReadonlyMap<string, string>,
): Promise<Map<string, Array<{ channelId: string; latestSeq: number }>>> {
  const dmRefs = resolvedDmRefs ?? await resolveAgentInboxDmRefs(agentId, chain);
  const targets = new Map<string, Array<{ channelId: string; latestSeq: number }>>();
  for (const row of chain) {
    if (row.offeredUnread <= 0 || row.latestSeq === null) continue;
    if (row.kind === "dm" && !dmRefs.has(row.targetId)) continue;
    const target = formatAgentInboxTarget(row, dmRefs);
    const list = targets.get(target) ?? [];
    list.push({ channelId: row.targetId, latestSeq: row.latestSeq });
    targets.set(target, list);
  }
  return targets;
}

/**
 * `raft inbox check` cannot answer: the durable unread source (the unified
 * chain in RisingWave) is unconfigured or its read failed. The route turns this
 * into 503 INBOX_UNAVAILABLE -- never a silently partial list.
 */
export class AgentInboxUnavailableError extends Error {
  readonly code = "INBOX_UNAVAILABLE" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentInboxUnavailableError";
  }
}

export type AgentInboxView = "unread" | "mentions";

export type AgentInboxConversation = {
  target: string;
  /**
   * The contract's kinds (channel | dm | thread): a task conversation reads as
   * "thread" here for older CLIs; `conversationKind: "task"` and the task fields
   * say which (task v2).
   */
  kind: Exclude<AgentInboxChainRow["kind"], "task">;
  conversationKind?: "task";
  taskNumber?: number | null;
  /** The task's title (task conversations; `raft inbox check` prints it). */
  title?: string | null;
  unread: number;
  mentions: number;
  lastReadSeq: number;
  activitySeq: number;
  latestSenderName: string | null;
  latestAt: string | null;
};

export type AgentInboxList = {
  view: AgentInboxView;
  items: AgentInboxConversation[];
  hasMore: boolean;
  nextBeforeSeq: number | null;
  totals: AgentInboxTotals;
};

/**
 * The chain is derived from Postgres and trails it; the read position an ack
 * or a read just wrote is authoritative. A row read through its newest message
 * is dropped, a partly read one starts at the durable position. Without this, a
 * drain that calls again right after acking would be handed the rows it just
 * acked, and `raft inbox check` right after a `message read --after` would list
 * the conversation as still unread (a phantom that lasts until the chain
 * catches up).
 */
export async function withDurableAgentReadPositions(
  agentId: string,
  chain: AgentInboxChainRow[],
): Promise<AgentInboxChainRow[]> {
  if (chain.length === 0) return chain;
  const cursorRows = await getDb()
    .select({
      channelId: agentChannelReadCursors.channelId,
      lastReadSeq: sql<string>`COALESCE(${agentChannelReadCursors.lastReadSeq8}, ${agentChannelReadCursors.lastReadSeq})`,
    })
    .from(agentChannelReadCursors)
    .where(and(
      eq(agentChannelReadCursors.agentId, agentId),
      inArray(agentChannelReadCursors.channelId, chain.map((row) => row.targetId)),
    ));
  const cursors = new Map(cursorRows.map((row) => [row.channelId, Number(row.lastReadSeq)]));
  const adjusted: AgentInboxChainRow[] = [];
  for (const row of chain) {
    const cursor = cursors.get(row.targetId);
    if (cursor === undefined || cursor <= row.lastReadSeq) {
      adjusted.push(row);
      continue;
    }
    if (cursor >= Math.max(row.latestSeq ?? 0, row.maxMentionSeq ?? 0)) continue;
    adjusted.push({
      ...row,
      lastReadSeq: cursor,
      firstUnreadSeq: row.firstUnreadSeq !== null && row.firstUnreadSeq > cursor ? row.firstUnreadSeq : null,
    });
  }
  return adjusted;
}

/**
 * The agent's Activity panel: the conversations the view offers, newest activity
 * first, keyset-paged by activity seq in the view. A message belongs to exactly
 * one conversation and seq is global, so activity seqs are unique across rows and
 * `activity_seq < beforeSeq` pages exactly. Only the page (and the agent's DM
 * rows, to drop DMs no target can open) is read, never the whole inbox.
 */
export async function listAgentInbox(
  agentId: string,
  serverId: string,
  opts: { view: AgentInboxView; beforeSeq?: number; limit: number },
): Promise<AgentInboxList> {
  return (await listAgentInboxWithShownTargets(agentId, serverId, opts)).list;
}

/**
 * The inbox page, plus what it showed with a count: each listed target with
 * unread, the conversations behind it and their latest seq. An external agent's
 * end-of-turn report may settle those (externalTurnEndSnapshot.ts).
 */
export async function listAgentInboxWithShownTargets(
  agentId: string,
  serverId: string,
  opts: { view: AgentInboxView; beforeSeq?: number; limit: number },
): Promise<{
  list: AgentInboxList;
  shownTargets: Map<string, Array<{ channelId: string; latestSeq: number }>>;
  /** The chain rows behind `list.items`, in the same order (RFC 081 rows read their first unread and preview from them). */
  pageRows: AgentInboxChainRow[];
}> {
  const pool = getRisingWaveInboxPool();
  if (!pool) throw new AgentInboxUnavailableError("Agent inbox source is not configured");
  let totals: AgentInboxTotals;
  let dmRows: AgentInboxChainRow[];
  try {
    [totals, dmRows] = await Promise.all([
      readAgentInboxChainTotals(pool, agentId),
      readAgentInboxChainRows(pool, agentId, { kind: "dm" }),
    ]);
  } catch (error) {
    throw new AgentInboxUnavailableError("Agent inbox source read failed", { cause: error });
  }

  // A DM with no addressable peer (e.g. the single-member migration receipt DM)
  // cannot be opened with any target, so it would sit in the list forever: it is
  // neither listed nor counted.
  const dmRefs = await resolveAgentInboxDmRefs(agentId, dmRows);
  const unaddressable = dmRows.filter((row) => !dmRefs.has(row.targetId));
  const hidden = new Set(unaddressable.map((row) => row.targetId));
  totals = {
    conversations: totals.conversations - unaddressable.length,
    dms: totals.dms - unaddressable.length,
    mentions: totals.mentions - unaddressable.filter((row) => row.mentionUnread > 0).length,
  };

  let rows: AgentInboxChainRow[];
  try {
    rows = await readAgentInboxChainRows(pool, agentId, {
      beforeSeq: opts.beforeSeq,
      mentionsOnly: opts.view === "mentions",
      // One past the page says whether there is more; the hidden DMs may take slots.
      limit: opts.limit + 1 + hidden.size,
    });
  } catch (error) {
    throw new AgentInboxUnavailableError("Agent inbox source read failed", { cause: error });
  }
  // The durable read position wins over the trailing chain: a conversation the
  // agent just read through is not listed (and not counted) as unread.
  const visibleRows = rows.filter((row) => !hidden.has(row.targetId));
  const durableRows = await withDurableAgentReadPositions(agentId, visibleRows);
  const kept = new Set(durableRows.map((row) => row.targetId));
  const readThrough = visibleRows.filter((row) => !kept.has(row.targetId));
  if (readThrough.length > 0) {
    totals = {
      conversations: Math.max(0, totals.conversations - readThrough.length),
      dms: Math.max(0, totals.dms - readThrough.filter((row) => row.kind === "dm").length),
      mentions: Math.max(0, totals.mentions - readThrough.filter((row) => row.mentionUnread > 0).length),
    };
  }
  const candidates = durableRows;
  const page = candidates.slice(0, opts.limit);
  // More exists whenever the read itself overflowed the page: rows dropped as
  // read-through must not hide the conversations after them.
  const hasMore = candidates.length > page.length || visibleRows.length > opts.limit;

  for (const [channelId, ref] of await resolveAgentInboxDmRefs(agentId, page.filter((row) => row.kind === "thread" || row.kind === "task"))) {
    dmRefs.set(channelId, ref);
  }
  const latestBySeq = await getAgentInboxLatestMessages(page.map((row) => row.activitySeq).filter((seq) => seq > 0));
  const items: AgentInboxConversation[] = page.map((row) => {
    const latest = latestBySeq.get(row.activitySeq);
    return {
      target: formatAgentInboxTarget(row, dmRefs),
      kind: row.kind === "task" ? "thread" : row.kind,
      ...(row.kind === "task"
        ? { conversationKind: "task" as const, taskNumber: row.taskNumber ?? null, title: row.taskTitle ?? null }
        : {}),
      unread: row.offeredUnread,
      mentions: row.mentionUnread,
      lastReadSeq: row.lastReadSeq,
      activitySeq: row.activitySeq,
      latestSenderName: latest?.senderName ?? null,
      latestAt: latest?.createdAt ?? null,
    };
  });
  const shownTargets = new Map<string, Array<{ channelId: string; latestSeq: number }>>();
  page.forEach((row, index) => {
    if (row.offeredUnread <= 0 || row.latestSeq === null) return;
    const target = items[index]!.target;
    shownTargets.set(target, [...(shownTargets.get(target) ?? []), { channelId: row.targetId, latestSeq: row.latestSeq }]);
  });
  // An empty page (every row read through) still pages on from the rows it examined.
  const last = page.at(-1) ?? visibleRows.slice(0, opts.limit).at(-1);
  return {
    list: {
      view: opts.view,
      items,
      hasMore,
      nextBeforeSeq: hasMore && last ? last.activitySeq : null,
      totals,
    },
    shownTargets,
    pageRows: page,
  };
}

/**
 * RFC 081 `inbox dismiss`: the agent's offered conversations whose activity
 * is before `beforeSeq` (at most `limit`, newest first), or the one row of
 * `targetIds`; corrected by the durable read position like the list, so a
 * conversation read through is not offered again. Throws
 * AgentInboxUnavailableError when the chain is not configured or fails.
 */
export async function readAgentInboxChainRowsForDismiss(
  agentId: string,
  opts: { beforeSeq: number; limit: number } | { targetIds: readonly string[] },
): Promise<AgentInboxChainRow[]> {
  const pool = getRisingWaveInboxPool();
  if (!pool) throw new AgentInboxUnavailableError("Agent inbox source is not configured");
  let rows: AgentInboxChainRow[];
  try {
    if ("targetIds" in opts) {
      const wanted = new Set(opts.targetIds);
      rows = wanted.size === 0 ? [] : (await readAgentInboxChainRows(pool, agentId)).filter((row) => wanted.has(row.targetId));
    } else {
      rows = await readAgentInboxChainRows(pool, agentId, { beforeSeq: opts.beforeSeq, limit: opts.limit });
    }
  } catch (error) {
    throw new AgentInboxUnavailableError("Agent inbox source read failed", { cause: error });
  }
  return withDurableAgentReadPositions(agentId, rows);
}

/** Sender name and time of the given messages (seq is global), for one inbox page. */
async function getAgentInboxLatestMessages(
  seqs: number[],
): Promise<Map<number, { senderName: string | null; createdAt: string }>> {
  const out = new Map<number, { senderName: string | null; createdAt: string }>();
  if (seqs.length === 0) return out;
  const rows = await getDb()
    .select({
      seq: messages.seq,
      createdAt: messages.createdAt,
      messageType: messages.messageType,
      senderType: messages.senderType,
      userName: users.name,
      agentName: agents.name,
    })
    .from(messages)
    .leftJoin(users, and(eq(messages.senderType, "user"), sql`${users.id}::text = ${messages.senderId}`))
    .leftJoin(agents, and(eq(messages.senderType, "agent"), sql`${agents.id}::text = ${messages.senderId}`))
    .where(inArray(messages.seq, seqs));
  for (const row of rows) {
    const senderName = row.messageType === "system"
      ? null
      : row.senderType === "user"
        ? row.userName
        : row.senderType === "agent"
          ? row.agentName
          : null;
    out.set(Number(row.seq), {
      senderName: senderName ?? null,
      createdAt: (row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt)).toISOString(),
    });
  }
  return out;
}
