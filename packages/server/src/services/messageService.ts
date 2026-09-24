import { serializeErrorForLog } from "../tracing/safeErrorLog.js";
import { randomUUID } from "node:crypto";
import { eq, desc, gt, gte, lt, and, inArray, isNull, isNotNull, not, sql, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, registerDatabaseCloseHookForTests, withDbTraceAttributes, type DatabaseExecutor } from "../db/index.js";
import { messages, messageReactions, agents, users, channels, threadFollows, servers, serverMembers, serverMembershipDepartures, userChannelInboxStates, channelHumans, channelAgents, messageMentions, mentionDeliveryOccurrences, jointChannels, jointChannelServers, agentChannelReadCursors, attachmentCommentRefs, attachments, inboxNotificationFacts, tasks, externalReactionStates, externalActorProjections } from "../db/schema.js";
import type { Server as SocketServer } from "socket.io";
import type {
  AgentMessageDeliveryResult,
  AgentOrchestrator,
  DeliverMessageOptions,
} from "./agentOrchestrator.js";
import {
  SERVER_GUEST_FEATURE_FLAG_KEY,
  isAgentApiExternalMessageForbiddenAuthorityField,
  MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
  currentDate,
  currentTimeMs,
  extractRaftMentionHandles,
  extractRaftRefTargets,
  parseRaftRefTarget,
  replaceOutsideMarkdownCode,
  structuredRaftMentionStillAppears,
  failpoints,
  messageRef,
  messageRepliesDiscussion,
  renderThirdPartyInertText,
  syncScopeWindow,
  type AgentMessage,
  type AgentThreadContextMessage,
  type AgentThreadJoinContext,
  type ServerId,
  type RaftTargetString,
  type TraceAttributes,
} from "@botiverse/raft-shared";
import * as channelService from "./channelService.js";
import * as mentionDeliveryOccurrenceService from "./mentionDeliveryOccurrenceService.js";
import { CompatibilityReadMutationPendingError } from "./readMutationSequencer.js";
import { emitScopeReadUpdated } from "./readReceiptService.js";
import { ensureTaskForMessage, enrichSingleLegacyTask, type TaskRow } from "./taskService.js";
import {
  loadCanonicalTaskFactsByMessageId,
  projectTaskFactsOntoRows,
  toAgentTaskCurrentProjection,
  withProjectedTaskFacts,
} from "./messageTaskProjection.js";
import {
  getAttachmentsForMessages,
  getThumbnailUrl,
  normalizeAttachmentFilename,
  resolveAttachmentMimeType,
} from "../routes/attachments.js";
import { updateMaxSeqRedis, getMaxSeqRedis } from "../replicaRouter.js";
import { redisSyncDuration } from "../metrics.js";
import { buildSearchText } from "./searchService.js";
import * as agentPermalinkRenderService from "./agentPermalinkRenderService.js";
import * as agentService from "./agentService.js";
import * as serverService from "./serverService.js";
import {
  actorHasServerCapabilityInServer,
  actorRoleHasServerCapability,
  getActorServerRoleInServer,
} from "../lib/actorPermissions.js";
import { actorHasChannelCapability } from "../lib/channelActorPermissions.js";
import { sendPushNotifications, type PushPayload } from "./pushService.js";
import { createOrReplayAgentSend, type AgentSendInsertedTransactionInput } from "./agentSendReplayService.js";
import { traceQuerySpan } from "../tracing/queryTrace.js";
import {
  AttachmentLinkError,
  linkAttachmentsToMessageWithExecutor as linkAttachmentRowsToMessageWithExecutor,
} from "./attachmentLinkingService.js";
import { emitTaskCreated } from "./taskRealtimeEvents.js";
import { projectRichMessageSocketPayload } from "./messageRealtimeEvents.js";
import {
  recordInboxNotificationFacts,
  type InboxNotificationFactInput,
} from "./inboxNotificationService.js";
import { renderAnchorLabel } from "./attachmentCommentAnchorLabel.js";
import { SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION } from "./systemMessageBornReadRegistry.js";
import {
  ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
  COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY,
  evaluateFeatureFlag,
} from "./featureFlagService.js";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace.js";
import { isMessageShortId, messageIdShortPrefixConditions, UUID_RE, uuidShortIdRange } from "../lib/messageId.js";
import { getConfiguredAppUrl } from "../config/appUrl.js";
import { addTraceEvent } from "../tracing/semanticTrace.js";
import { sanitizeRouteErrorMessage } from "../tracing/routeFailure.js";
import { isNotificationPushSocketEnabled } from "./receiverStatePushService.js";
import { emitPlatformScopedUserEvent, socketUserServerRoom } from "../socket/platformScope.js";
import {
  formatPushBody,
  formatPushServerLabel,
  formatPushSurfaceTitle,
  summarizePushBody,
} from "./pushDisplay.js";
import {
  persistNativeNotificationIntents,
  resolveNotificationIntents,
} from "./nativeNotificationService.js";
import { loadExternalMessageAuthors } from "./externalProjectionService.js";
import {
  classifyOrdinaryMessageExternalProjection,
  type OrdinaryMessageExternalProjectionDecision,
} from "./ordinaryMessageExternalProjection.js";
import {
  lockOrdinaryMessageExternalDeliveryAdmission,
  maybeEnqueueOrdinaryMessageExternalDelivery,
  runSlackBridgeOutboundAdmissionStage,
  runSlackBridgeOutboundPipelineStage,
  type SlackBridgeOutboundPipelineTopology,
} from "./externalDeliveryOutboxService.js";
import { getComputerLinkedMachineIds } from "./computerCredentialService.js";
import { getInstalledApp } from "./rapRegistryStore.js";
import { isAppId, type AppId } from "./rapRegistry.js";
const THREAD_JOIN_CONTEXT_WINDOW = 6;
const AGENT_FORWARDED_ITEM_CONTENT_CHAR_LIMIT = 2_000;
const AGENT_FORWARDED_BUNDLE_CHAR_LIMIT = 12_000;

type MessageDbOperation = "insert" | "select" | "transaction";
type MessageDbTimeoutSubkind = "query_canceled" | "lock_not_available" | "none";
type PostPersistThreadReadPersistenceState = "committed" | "transaction_pending";

function buildThreadRepliesSyncWindow(input: {
  serverId: string;
  parentMessageId: string;
  parentScopeKind: string;
  parentScopeId: string;
}) {
  return {
    producer: MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
    discussion: messageRepliesDiscussion(
      messageRef(input.serverId, input.parentMessageId),
      {
        serverId: input.serverId,
        scopeKind: input.parentScopeKind,
        scopeId: input.parentScopeId,
      },
    ),
    window: syncScopeWindow(),
  };
}

function isMessageDatabaseFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current === "object") {
      const errorLike = current as { code?: unknown; name?: unknown; query?: unknown; cause?: unknown };
      if (typeof errorLike.code === "string" && (
        /^[0-9A-Z]{5}$/.test(errorLike.code)
        || ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"].includes(errorLike.code)
      )) return true;
      if (typeof errorLike.query === "string") return true;
      if (["DatabaseError", "DrizzleQueryError", "PostgresError"].includes(String(errorLike.name ?? ""))) return true;
      current = errorLike.cause;
      continue;
    }
    break;
  }
  return false;
}

function getMessageDbErrorTraceAttrs(error: unknown): TraceAttributes {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    chain.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }

  const coded = chain.find((entry) => {
    const code = typeof entry === "object" ? (entry as { code?: unknown }).code : undefined;
    return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
  });
  const sqlstate = coded && typeof coded === "object"
    ? (coded as { code: string }).code
    : undefined;
  const messageSource = coded ?? chain.at(-1) ?? error;
  const rawMessage = messageSource instanceof Error
    ? messageSource.message
    : typeof messageSource === "object" && typeof (messageSource as { message?: unknown }).message === "string"
      ? String((messageSource as { message: string }).message)
      : "Database operation failed";
  const withoutParams = rawMessage.replace(/\bparams:\s*[\s\S]*$/i, "params: [redacted]");
  const withoutIdentifiers = withoutParams
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[uuid]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]");
  const canonicalMessage = /failed query:/i.test(withoutIdentifiers)
    ? "Database query failed"
    : withoutIdentifiers;
  const timeoutSubkind: MessageDbTimeoutSubkind = sqlstate === "57014"
    ? "query_canceled"
    : sqlstate === "55P03"
      ? "lock_not_available"
      : "none";

  return {
    error_class: error instanceof Error ? error.name : typeof error,
    ...(chain.length > 1 && chain[1] instanceof Error ? { error_cause_class: chain[1].name } : {}),
    ...(sqlstate ? { sqlstate } : {}),
    timeout_subkind: timeoutSubkind,
    error_message: sanitizeRouteErrorMessage(canonicalMessage),
  };
}

async function traceMessageDbPhase<T>(
  input: { phase: string; queryName: string; dbOperation: MessageDbOperation },
  work: () => Promise<T>,
): Promise<T> {
  const attrs = {
    event_kind: "db_query",
    phase: input.phase,
    query_name: input.queryName,
    db_operation: input.dbOperation,
    peer_service: "postgresql",
  } as const;
  const start = currentTimeMs();
  try {
    const result = await withDbTraceAttributes(attrs, work);
    addTraceEvent("message_pipeline.db_phase.finished", {
      ...attrs,
      outcome: "success",
      reason: "query_completed",
      duration_ms: currentTimeMs() - start,
    });
    return result;
  } catch (error) {
    addTraceEvent("message_pipeline.db_phase.failed", {
      ...attrs,
      outcome: "error",
      reason: "query_failed",
      duration_ms: currentTimeMs() - start,
      ...getMessageDbErrorTraceAttrs(error),
    });
    throw error;
  }
}

function getMentionHandles(content: string): string[] {
  return extractRaftMentionHandles(content).map((handle) => `@${handle}`);
}

function getMentionNameSet(content: string): Set<string> {
  return new Set(extractRaftMentionHandles(content));
}

export async function getHumanThreadFollowerIds(
  threadChannelId: string,
  executor: DatabaseExecutor = getDb(),
  knownJointThreadProjection?: channelService.JointThreadProjection | null,
): Promise<string[]> {
  const db = executor;
  const jointThreadProjection = knownJointThreadProjection === undefined
    ? await channelService.getJointThreadProjectionByLocalThread(threadChannelId)
    : knownJointThreadProjection;
  if (jointThreadProjection) {
    const rows = await db
      .select({ id: threadFollows.followerId })
      .from(threadFollows)
      .innerJoin(channels, and(
        eq(channels.id, threadFollows.threadChannelId),
        eq(channels.type, "thread"),
        isNull(channels.deletedAt),
      ))
      .innerJoin(channelHumans, and(
        eq(channelHumans.channelId, jointThreadProjection.localParentChannelId),
        eq(channelHumans.userId, threadFollows.followerId),
      ))
      .where(and(
        eq(threadFollows.threadChannelId, threadChannelId),
        eq(threadFollows.followerType, "user"),
        isNull(threadFollows.unfollowedAt),
      ));
    return rows.map((r) => r.id);
  }
  const parentChannels = alias(channels, "parent_channels");
  const rows = await db
    .select({ id: threadFollows.followerId })
    .from(threadFollows)
    .innerJoin(channels, and(
      eq(channels.id, threadFollows.threadChannelId),
      eq(channels.type, "thread"),
      isNull(channels.deletedAt),
    ))
    .innerJoin(messages, eq(messages.id, channels.parentMessageId))
    .innerJoin(parentChannels, eq(parentChannels.id, messages.channelId))
    .leftJoin(channelHumans, and(
      eq(channelHumans.channelId, messages.channelId),
      eq(channelHumans.userId, threadFollows.followerId),
    ))
    .leftJoin(serverMembers, and(
      eq(serverMembers.serverId, parentChannels.serverId),
      eq(serverMembers.userId, threadFollows.followerId),
    ))
    .where(and(
      eq(threadFollows.threadChannelId, threadChannelId),
      eq(threadFollows.followerType, "user"),
      isNull(threadFollows.unfollowedAt),
      sql`(
        (${parentChannels.type} = 'channel' AND ${serverMembers.userId} IS NOT NULL)
        OR ${channelHumans.userId} IS NOT NULL
      )`,
    ));
  return rows.map((r) => r.id);
}

async function getThreadAgentFollowers(
  threadChannelId: string,
  executor: DatabaseExecutor = getDb(),
  knownJointThreadProjection?: channelService.JointThreadProjection | null,
) {
  const db = executor;
  const jointThreadProjection = knownJointThreadProjection === undefined
    ? await channelService.getJointThreadProjectionByLocalThread(threadChannelId)
    : knownJointThreadProjection;
  if (jointThreadProjection) {
    return db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        status: agents.status,
        avatarUrl: agents.avatarUrl,
      })
      .from(threadFollows)
      .innerJoin(agents, eq(agents.id, threadFollows.followerId))
      .innerJoin(channels, and(
        eq(channels.id, threadFollows.threadChannelId),
        eq(channels.type, "thread"),
        isNull(channels.deletedAt),
      ))
      .innerJoin(channelAgents, and(
        eq(channelAgents.channelId, jointThreadProjection.localParentChannelId),
        eq(channelAgents.agentId, threadFollows.followerId),
      ))
      .where(and(
        eq(threadFollows.threadChannelId, threadChannelId),
        eq(threadFollows.followerType, "agent"),
        isNull(threadFollows.unfollowedAt),
        isNull(agents.deletedAt),
      ));
  }

  const parentChannels = alias(channels, "parent_channels");
  return db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      status: agents.status,
      avatarUrl: agents.avatarUrl,
    })
    .from(threadFollows)
    .innerJoin(agents, eq(agents.id, threadFollows.followerId))
    .innerJoin(channels, and(
      eq(channels.id, threadFollows.threadChannelId),
      eq(channels.type, "thread"),
      isNull(channels.deletedAt),
    ))
    .innerJoin(messages, eq(messages.id, channels.parentMessageId))
    .innerJoin(parentChannels, eq(parentChannels.id, messages.channelId))
    .leftJoin(channelAgents, and(
      eq(channelAgents.channelId, messages.channelId),
      eq(channelAgents.agentId, agents.id),
    ))
    .where(and(
      eq(threadFollows.threadChannelId, threadChannelId),
      eq(threadFollows.followerType, "agent"),
      isNull(threadFollows.unfollowedAt),
      isNull(agents.deletedAt),
      sql`(
        (${parentChannels.type} = 'channel' AND ${agents.serverId} = ${parentChannels.serverId})
        OR ${channelAgents.agentId} IS NOT NULL
      )`,
    ));
}

async function getThreadFollowerCandidates(
  threadChannelId: string,
  executor: DatabaseExecutor = getDb(),
  knownJointThreadProjection?: channelService.JointThreadProjection | null,
) {
  const [humanFollowerIds, agentFollowers] = await Promise.all([
    getHumanThreadFollowerIds(threadChannelId, executor, knownJointThreadProjection),
    getThreadAgentFollowers(threadChannelId, executor, knownJointThreadProjection),
  ]);
  return { humanFollowerIds, agentFollowers };
}

async function listExplicitThreadUnfollows(
  threadChannelId: string,
  executor: DatabaseExecutor = getDb(),
) {
  return executor
    .select({
      followerType: threadFollows.followerType,
      followerId: threadFollows.followerId,
    })
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, threadChannelId),
      isNotNull(threadFollows.unfollowedAt),
    ));
}

type MessageServiceDeps = {
  createMessage: typeof createMessage;
  getChannel: typeof channelService.getChannel;
  getChannelHumans: typeof channelService.getChannelHumans;
  getChannelAgents: typeof channelService.getChannelAgents;
  getChannelMembers: typeof channelService.getChannelMembers;
  getChannelMembershipAuthorityChannelId: typeof channelService.getChannelMembershipAuthorityChannelId;
  actorHasChannelCapability: typeof actorHasChannelCapability;
  getThreadInfo: typeof channelService.getThreadInfo;
  clearThreadDoneForAll: typeof channelService.clearThreadDoneForAll;
  markRead: (userId: string, channelId: string, seq: number) => Promise<unknown>;
  markAgentLegacyRead: (agentId: string, channelId: string, seq: number) => Promise<unknown>;
  assertChannelNotArchived: typeof channelService.assertChannelNotArchived;
  getActiveJointChannelProjectionsByLocalChannel: typeof channelService.getActiveJointChannelProjectionsByLocalChannel;
  getActiveJointThreadProjectionsByCanonicalThread: typeof channelService.getActiveJointThreadProjectionsByCanonicalThread;
  getJointThreadProjectionForMember: typeof channelService.getJointThreadProjectionForMember;
  renderAgentReadablePermalinks: typeof agentPermalinkRenderService.renderAgentReadablePermalinks;
  listAgents: typeof agentService.listAgents;
  getServerIdentity: (serverId: string) => Promise<{ slug: string } | null>;
  getServerMembers: typeof serverService.getServerMembers;
  shouldHideHumanDirectoryFromRequester: typeof serverService.shouldHideHumanDirectoryFromRequester;
  shouldHideHumanDirectoryFromAgentRequester: typeof serverService.shouldHideHumanDirectoryFromAgentRequester;
  getHumanIdsVisibleThroughLocalChannels: typeof channelService.getHumanIdsVisibleThroughLocalChannels;
  getHumanIdsVisibleThroughJointChannels: typeof channelService.getHumanIdsVisibleThroughJointChannels;
  getActorServerRoleInServer: typeof getActorServerRoleInServer;
  buildPushTargets: typeof buildPushTargets;
  buildNotificationPushSocketTargets: typeof buildNotificationPushSocketTargets;
  getSenderIdentity: typeof getSenderIdentity;
  sendPushNotifications: typeof sendPushNotifications;
  persistNativeNotificationIntents: typeof persistNativeNotificationIntents;
  insertMentionRows: typeof insertMentionRows;
  getMentionFactsForMessages: typeof getMentionFactsForMessages;
  recordInboxNotificationFacts: typeof recordInboxNotificationFacts;
  getActivityMutedAgentIdsForMessage: typeof channelService.getActivityMutedAgentIdsForMessage;
  canViewerReadForwardedSource: typeof viewerCanReadForwardedSource;
  getThreadFollowerCandidates: typeof getThreadFollowerCandidates;
  listExplicitThreadUnfollows: typeof listExplicitThreadUnfollows;
  persistMentionDeliveryOccurrences: typeof mentionDeliveryOccurrenceService.ensureMentionDeliveryOccurrences;
};

const senderReadReceiptsInFlight = new Set<Promise<void>>();
const senderReadReceiptFailuresForTests: unknown[] = [];

function trackSenderReadReceipt(task: Promise<void>, options: { collectFailureForTests?: boolean } = {}): void {
  senderReadReceiptsInFlight.add(task);
  void task.then(
    () => {
      senderReadReceiptsInFlight.delete(task);
    },
    (error) => {
      if (options.collectFailureForTests) {
        senderReadReceiptFailuresForTests.push(error);
      }
      senderReadReceiptsInFlight.delete(task);
    },
  );
}

export function getSenderReadReceiptInFlightCountForTests(): number {
  return senderReadReceiptsInFlight.size;
}

export async function drainSenderReadReceiptsForTests(): Promise<void> {
  while (true) {
    const snapshot = [...senderReadReceiptsInFlight];
    if (snapshot.length > 0) {
      await Promise.allSettled(snapshot);
    }

    // Registration is synchronous, while settlement removal runs in a
    // microtask. Give both the finally callback and one possible immediately
    // chained registration a chance to become visible before declaring the
    // test lifecycle quiescent.
    await Promise.resolve();
    if (senderReadReceiptFailuresForTests.length > 0) {
      throw new AggregateError(
        senderReadReceiptFailuresForTests.splice(0),
        "sender read receipt lifecycle rejected while draining",
      );
    }
    if (senderReadReceiptsInFlight.size !== 0) continue;
    await Promise.resolve();
    if (senderReadReceiptFailuresForTests.length > 0) {
      throw new AggregateError(
        senderReadReceiptFailuresForTests.splice(0),
        "sender read receipt lifecycle rejected while draining",
      );
    }
    if (senderReadReceiptsInFlight.size === 0) return;
  }
}

export function registerSenderReadReceiptForTests(readMutation: Promise<unknown>): void {
  const settledTask = readMutation.then(() => undefined);
  trackSenderReadReceipt(settledTask, { collectFailureForTests: true });
}

registerDatabaseCloseHookForTests(drainSenderReadReceiptsForTests);

function scheduleSenderReadReceipt(input: {
  io: SocketServer;
  serverId: string;
  channelId: string;
  senderType: "user" | "agent";
  senderId: string;
  readMutation: Promise<unknown>;
}): void {
  const settledTask = input.readMutation.then((value) => {
    if (!value || typeof value !== "object") return;
    const state = value as { maxReadSeq?: unknown; changed?: unknown };
    if (typeof state.maxReadSeq !== "number" || typeof state.changed !== "boolean") return;
    return emitScopeReadUpdated({
      io: input.io,
      serverId: input.serverId,
      scopeId: input.channelId,
      peerKind: input.senderType === "user" ? "human" : "agent",
      peerId: input.senderId,
      maxReadSeq: state.maxReadSeq,
      changed: state.changed,
    });
  }).catch((error) => {
    if (!(error instanceof CompatibilityReadMutationPendingError)) throw error;
    console.warn("[MessageService] sender read receipt remains pending", {
      serverId: error.serverId,
      principalId: error.principalId,
      mutationId: error.mutationId,
      authoritySeq: error.authoritySeq,
    });
  });
  settledTask.catch(() => {});
  trackSenderReadReceipt(settledTask);
}

const defaultMessageServiceDeps: MessageServiceDeps = {
  createMessage,
  getChannel: channelService.getChannel,
  getChannelHumans: channelService.getChannelHumans,
  getChannelAgents: channelService.getChannelAgents,
  getChannelMembers: channelService.getChannelMembers,
  getChannelMembershipAuthorityChannelId: channelService.getChannelMembershipAuthorityChannelId,
  actorHasChannelCapability,
  getThreadInfo: channelService.getThreadInfo,
  clearThreadDoneForAll: channelService.clearThreadDoneForAll,
  markRead: channelService.markRead,
  markAgentLegacyRead: channelService.markAgentLegacyRead,
  assertChannelNotArchived: channelService.assertChannelNotArchived,
  getActiveJointChannelProjectionsByLocalChannel: channelService.getActiveJointChannelProjectionsByLocalChannel,
  getActiveJointThreadProjectionsByCanonicalThread: channelService.getActiveJointThreadProjectionsByCanonicalThread,
  getJointThreadProjectionForMember: channelService.getJointThreadProjectionForMember,
  renderAgentReadablePermalinks: agentPermalinkRenderService.renderAgentReadablePermalinks,
  listAgents: agentService.listAgents,
  getServerIdentity: async (serverId) => {
    const server = await serverService.getServer(serverId);
    return server ? { slug: server.slug } : null;
  },
  getServerMembers: serverService.getServerMembers,
  shouldHideHumanDirectoryFromRequester: serverService.shouldHideHumanDirectoryFromRequester,
  shouldHideHumanDirectoryFromAgentRequester: serverService.shouldHideHumanDirectoryFromAgentRequester,
  getHumanIdsVisibleThroughLocalChannels: channelService.getHumanIdsVisibleThroughLocalChannels,
  getHumanIdsVisibleThroughJointChannels: channelService.getHumanIdsVisibleThroughJointChannels,
  getActorServerRoleInServer,
  buildPushTargets,
  buildNotificationPushSocketTargets,
  getSenderIdentity,
  sendPushNotifications,
  persistNativeNotificationIntents,
  insertMentionRows,
  getMentionFactsForMessages,
  recordInboxNotificationFacts,
  getActivityMutedAgentIdsForMessage: channelService.getActivityMutedAgentIdsForMessage,
  canViewerReadForwardedSource: viewerCanReadForwardedSource,
  getThreadFollowerCandidates,
  listExplicitThreadUnfollows,
  persistMentionDeliveryOccurrences: mentionDeliveryOccurrenceService.ensureMentionDeliveryOccurrences,
};

let messageServiceDepsOverride: Partial<MessageServiceDeps> | null = null;

function resolveMessageServiceDeps(): MessageServiceDeps {
  const usesMockPersistence = Boolean(messageServiceDepsOverride?.createMessage);
  const testFallbacks: Partial<MessageServiceDeps> = messageServiceDepsOverride
    ? {
      getActiveJointChannelProjectionsByLocalChannel: async () => [],
      getActiveJointThreadProjectionsByCanonicalThread: async () => [],
      getJointThreadProjectionForMember: async () => null,
      ...(usesMockPersistence ? {
        getServerIdentity: async () => null,
        shouldHideHumanDirectoryFromRequester: async () => false,
        shouldHideHumanDirectoryFromAgentRequester: async () => false,
        getHumanIdsVisibleThroughLocalChannels: async () => new Set<string>(),
        getHumanIdsVisibleThroughJointChannels: async () => new Set<string>(),
        recordInboxNotificationFacts: async () => 0,
        getActivityMutedAgentIdsForMessage: async () => new Set<string>(),
        persistNativeNotificationIntents: async () => 0,
        // Unit fixtures that replace persistence must not fall through into
        // the live channel-role database while projecting sender-only mention
        // actions. Focused authorization tests override these seams directly.
        getChannelMembershipAuthorityChannelId: async (channelId: string) => channelId,
        actorHasChannelCapability: async () => false,
      } : {}),
    }
    : {};
  return {
    ...defaultMessageServiceDeps,
    ...testFallbacks,
    ...(messageServiceDepsOverride ?? {}),
  };
}

export function __setMessageServiceDepsForTests(overrides: Partial<MessageServiceDeps>) {
  messageServiceDepsOverride = overrides;
}

export function __resetMessageServiceDepsForTests() {
  messageServiceDepsOverride = null;
}

export async function awaitPostPersistReadMutation(readMutation: Promise<unknown>): Promise<void> {
  try {
    await readMutation;
  } catch (error) {
    if (!(error instanceof CompatibilityReadMutationPendingError)) throw error;
    // The message/follow transaction is already committed. Keep that primary
    // result successful while the durable sequencer worker/frontier recovers
    // the accepted read intent. Do not log message content or request payloads.
    console.warn("[MessageService] post-persist read mutation remains pending", {
      serverId: error.serverId,
      principalId: error.principalId,
      mutationId: error.mutationId,
      authoritySeq: error.authoritySeq,
    });
  }
}

async function getPostPersistThreadFollowerCandidates(
  deps: MessageServiceDeps,
  threadChannelId: string,
  purpose: "inbox_notification_facts" | "agent_delivery",
  executor?: DatabaseExecutor,
  knownJointThreadProjection?: channelService.JointThreadProjection | null,
  persistenceState: PostPersistThreadReadPersistenceState = "committed",
) {
  return runPostPersistThreadRead({
    purpose,
    queryName: "thread_follows.eligible_followers",
    persistenceState,
    fallback: { humanFollowerIds: [], agentFollowers: [] },
    work: () => deps.getThreadFollowerCandidates(
      threadChannelId,
      executor,
      knownJointThreadProjection,
    ),
  });
}

type AgentDeliveryCandidate = { id: string };

function uniqueAgentDeliveryCandidates(candidates: readonly AgentDeliveryCandidate[]): AgentDeliveryCandidate[] {
  const byId = new Map<string, AgentDeliveryCandidate>();
  for (const candidate of candidates) byId.set(candidate.id, candidate);
  return [...byId.values()];
}

function buildThreadAgentDeliveryCandidatesFromFacts(
  facts: readonly InboxNotificationFactInput[],
  sourceThreadChannelId: string,
): AgentDeliveryCandidate[] {
  return uniqueAgentDeliveryCandidates(facts
    .filter((fact) => (
      fact.receiverType === "agent"
      && fact.kind === "thread"
      && fact.sourceChannelId === sourceThreadChannelId
      && (
        fact.suppressionReason !== "unfollowed_thread_ordinary"
        || fact.personalMention === true
      )
    ))
    .map((fact) => ({ id: fact.receiverId })));
}

async function getPersistedThreadAgentDeliveryAudience(
  messageId: string,
  sourceThreadChannelId: string,
  persistenceState: PostPersistThreadReadPersistenceState = "committed",
): Promise<AgentDeliveryCandidate[] | null> {
  return runPostPersistThreadRead({
    purpose: "agent_delivery",
    queryName: "inbox_notification_facts.thread_agent_delivery_audience",
    persistenceState,
    fallback: null,
    work: async () => {
      const rows = await getDb()
        .select({ id: inboxNotificationFacts.receiverId })
        .from(inboxNotificationFacts)
        .where(and(
          eq(inboxNotificationFacts.messageId, messageId),
          eq(inboxNotificationFacts.receiverType, "agent"),
          eq(inboxNotificationFacts.kind, "thread"),
          eq(inboxNotificationFacts.sourceChannelId, sourceThreadChannelId),
        ));
      return uniqueAgentDeliveryCandidates(rows);
    },
  });
}

async function resolveThreadAgentDeliveryCandidates(opts: {
  deps: MessageServiceDeps;
  threadChannelId: string;
  messageId: string;
  precomputedCandidates?: readonly AgentDeliveryCandidate[];
}): Promise<{ candidates: AgentDeliveryCandidate[]; source: "inbox_facts_precomputed" | "inbox_facts_persisted" | "thread_follows_fallback" }> {
  if (opts.precomputedCandidates) {
    return {
      candidates: uniqueAgentDeliveryCandidates(opts.precomputedCandidates),
      source: "inbox_facts_precomputed",
    };
  }

  const persistedAudience = await getPersistedThreadAgentDeliveryAudience(
    opts.messageId,
    opts.threadChannelId,
  );
  if (persistedAudience && persistedAudience.length > 0) {
    return {
      candidates: persistedAudience,
      source: "inbox_facts_persisted",
    };
  }

  const { agentFollowers } = await getPostPersistThreadFollowerCandidates(
    opts.deps,
    opts.threadChannelId,
    "agent_delivery",
  );
  return {
    candidates: agentFollowers,
    source: "thread_follows_fallback",
  };
}

async function runPostPersistThreadRead<T>(opts: {
  purpose: "inbox_notification_facts" | "agent_delivery";
  queryName: string;
  persistenceState: PostPersistThreadReadPersistenceState;
  fallback: T;
  work: () => Promise<T>;
}): Promise<T> {
  const phase = `message_pipeline.post_persist.${opts.purpose}`;
  try {
    return await traceMessageDbPhase({
      phase,
      queryName: opts.queryName,
      dbOperation: "select",
    }, opts.work);
  } catch (error) {
    if (!isMessageDatabaseFailure(error)) throw error;
    const durableMessagePresent = opts.persistenceState === "committed";
    addTraceEvent("message_pipeline.post_persist_side_effect.degraded", {
      phase,
      query_name: opts.queryName,
      db_operation: "select",
      peer_service: "postgresql",
      persistence_state: opts.persistenceState,
      durable_message_present: durableMessagePresent,
      failure_policy: durableMessagePresent ? "continue_after_persist" : "continue_within_transaction",
      ...getMessageDbErrorTraceAttrs(error),
    });
    return opts.fallback;
  }
}

async function getAgentDeliveryOptionsForSender(
  deps: MessageServiceDeps,
  serverId: string,
  senderType: InternalActorType,
  senderId: string,
): Promise<DeliverMessageOptions> {
  if (senderType !== "user") return {};
  const role = await deps.getActorServerRoleInServer(serverId, "user", senderId).catch(() => null);
  return role === "owner" || role === "admin" ? { adminAuthority: true } : {};
}

type PersistedDeliveryChannel = Pick<typeof channels.$inferSelect, "id" | "serverId" | "type">;
type PersistedDeliveryMessage = Pick<typeof messages.$inferSelect, "id" | "seq" | "taskAssigneeType" | "taskAssigneeId"> & {
  taskAssigneeName?: string | null;
};

type DirectMentionFollowSnapshot = {
  doneAt: Date | null;
  unfollowedAt: Date | null;
} | undefined;

export function planDirectMentionThreadFollow(snapshot: DirectMentionFollowSnapshot): {
  shouldActivate: boolean;
  reactivatedExplicitUnfollow: boolean;
} {
  if (!snapshot) return { shouldActivate: true, reactivatedExplicitUnfollow: false };
  if (snapshot.unfollowedAt) return { shouldActivate: true, reactivatedExplicitUnfollow: true };
  return {
    shouldActivate: Boolean(snapshot.doneAt),
    reactivatedExplicitUnfollow: false,
  };
}

async function getMutedAgentDeliveryIdsForPersistedMessage(
  deps: MessageServiceDeps,
  channel: PersistedDeliveryChannel,
  message: PersistedDeliveryMessage,
  agentIds: string[],
  piercedAgentIds: Set<string> = new Set(),
): Promise<Set<string>> {
  if (channel.type === "thread" || agentIds.length === 0) return new Set();
  const promotedRows = await getDb()
    .select({ receiverId: inboxNotificationFacts.receiverId })
    .from(inboxNotificationFacts)
    .where(and(
      eq(inboxNotificationFacts.messageId, message.id),
      eq(inboxNotificationFacts.receiverType, "agent"),
      inArray(inboxNotificationFacts.receiverId, agentIds),
    ));
  const promotedAgentIds = new Set(promotedRows.map((row) => row.receiverId));
  const candidates = agentIds.filter((agentId) => !piercedAgentIds.has(agentId) && !promotedAgentIds.has(agentId));
  if (candidates.length === 0) return new Set();
  return deps.getActivityMutedAgentIdsForMessage({
    serverId: channel.serverId,
    sourceChannelId: channel.id,
    agentIds: candidates,
    messageSeq: message.seq,
  });
}

function isSystemMessageIdentity(messageType: "chat" | "system", senderId: string): boolean {
  return messageType === "system" || senderId === "system";
}

type InternalActorType = "user" | "agent";
type StoredMessageSenderType = InternalActorType | "external_projection";
type AgentVisibleSenderType = AgentMessage["sender_type"];
type AgentVisibleTaskAssigneeType = AgentMessage["task_assignee_type"];
type AgentVisibleChannelType = AgentMessage["channel_type"];
type FrontendConversationChannelType = typeof channels.$inferSelect["type"];
type FrontendParentChannelType = Exclude<FrontendConversationChannelType, "thread">;
export type FrontendConversationContext = {
  channelType: FrontendConversationChannelType;
  parentMessageId?: string;
  parentChannelId?: string;
  parentChannelType?: FrontendParentChannelType;
};

function buildFrontendConversationContext(opts: {
  channelType: FrontendConversationChannelType;
  parentMessageId?: string | null;
  parentChannel?: Pick<typeof channels.$inferSelect, "id" | "type"> | null;
}): FrontendConversationContext {
  const context: FrontendConversationContext = { channelType: opts.channelType };
  if (opts.channelType !== "thread") return context;
  if (!opts.parentMessageId || !opts.parentChannel || opts.parentChannel.type === "thread") return context;
  context.parentMessageId = opts.parentMessageId;
  context.parentChannelId = opts.parentChannel.id;
  context.parentChannelType = opts.parentChannel.type;
  return context;
}

function withFrontendConversationContext<T extends Record<string, unknown>>(
  payload: T,
  context: FrontendConversationContext,
): T & { conversationContext: FrontendConversationContext } {
  return { ...payload, conversationContext: context };
}

function projectFrontendMessagePayload<T extends Record<string, unknown>>(
  payload: T,
): Omit<T, "agentSendKey" | "searchText" | "searchVector" | "senderHandle"> {
  return projectRichMessageSocketPayload(payload);
}

function projectThreadLatestReplyPayload<T extends Record<string, unknown>>(
  payload: T,
): Omit<T, "agentSendKey" | "searchText" | "searchVector" | "senderHandle"> & {
  senderDisplayName: string;
  senderAvatarUrl: string | null;
} {
  const projected = projectFrontendMessagePayload(payload);
  const externalAuthor = projected.externalAuthor && typeof projected.externalAuthor === "object"
    ? projected.externalAuthor as { avatarUrl?: unknown }
    : null;
  return {
    ...projected,
    senderDisplayName: typeof projected.senderName === "string" ? projected.senderName : "",
    senderAvatarUrl: typeof externalAuthor?.avatarUrl === "string" ? externalAuthor.avatarUrl : null,
  };
}

type PushTargetTraceAttrs = {
  human_audience_count: number;
  human_mention_only_audience_count: number;
  human_delivery_count: number;
  muted_human_count: number;
  activity_muted_human_count?: number;
};

function traceChannelAudienceAttrs(channel: Pick<typeof channels.$inferSelect, "type" | "name"> | null | undefined) {
  return {
    target_type: channel?.type ?? "missing",
    is_all_channel: channel ? channelService.isEnabledAllChannel(channel) : false,
  };
}

const pushTargetTraceAttrs = new WeakMap<Map<string, PushPayload>, PushTargetTraceAttrs>();

function setPushTargetTraceAttrs(targets: Map<string, PushPayload>, attrs: PushTargetTraceAttrs): void {
  pushTargetTraceAttrs.set(targets, attrs);
}

function getPushTargetTraceAttrs(targets: Map<string, PushPayload>): PushTargetTraceAttrs {
  return pushTargetTraceAttrs.get(targets) ?? {
    human_audience_count: targets.size,
    human_mention_only_audience_count: 0,
    human_delivery_count: targets.size,
    muted_human_count: 0,
  };
}

type PushNotificationTarget = {
  userId: string;
  payload: PushPayload;
};

export type NotificationPushProjectionGroup = {
  targets: Map<string, PushPayload>;
  identity: NotificationPushSocketIdentity;
};

export type NotificationPushProjectionTarget = PushNotificationTarget & {
  identity: NotificationPushSocketIdentity;
};

export type NotificationPushSurfaceKind = "channel" | "dm" | "thread";

export type NotificationPushSocketIdentity = {
  serverId: string;
  kind: NotificationPushSurfaceKind;
  channelId: string | null;
  threadId: string | null;
  parentChannelId: string | null;
  parentMessageId: string | null;
  messageId: string;
};

export type NotificationPushSocketPayload = Pick<
  PushPayload,
  | "title"
  | "body"
  | "tag"
  | "url"
  | "serverName"
  | "channelName"
  | "parentChannelKind"
  | "senderId"
  | "senderType"
  | "senderName"
  | "messagePreview"
  | "mentioned"
> & NotificationPushSocketIdentity;

export type NotificationPushSocketTarget = {
  userId: string;
  payload: NotificationPushSocketPayload;
};

export function buildNotificationPushSocketTargets(
  targets: PushNotificationTarget[],
  identity: NotificationPushSocketIdentity,
): NotificationPushSocketTarget[] {
  return targets.map(({ userId, payload }) => {
    const {
      title,
      body,
      tag,
      url,
      serverName,
      channelName,
      parentChannelKind,
      senderId,
      senderType,
      senderName,
      messagePreview,
      mentioned,
    } = payload;
    return {
      userId,
      payload: {
        title,
        body,
        tag,
        url,
        ...(serverName !== undefined && { serverName }),
        ...(channelName !== undefined && { channelName }),
        ...(parentChannelKind !== undefined && { parentChannelKind }),
        ...(senderId !== undefined && { senderId }),
        ...(senderType !== undefined && { senderType }),
        ...(senderName !== undefined && { senderName }),
        ...(messagePreview !== undefined && { messagePreview }),
        ...(mentioned !== undefined && { mentioned }),
        ...identity,
      },
    };
  });
}

export function buildNotificationPushProjectionTargets(
  groups: NotificationPushProjectionGroup[],
): NotificationPushProjectionTarget[] {
  return groups.flatMap(({ targets, identity }) => (
    [...targets.entries()].map(([userId, payload]) => ({ userId, payload, identity }))
  ));
}

export function selectCanonicalNotificationProjectionTargets(
  targets: NotificationPushProjectionTarget[],
  source: { serverId: string; messageId: string },
): NotificationPushProjectionTarget[] {
  const byUser = new Map<string, NotificationPushProjectionTarget[]>();
  for (const target of targets) {
    if (target.identity.messageId !== source.messageId) continue;
    const bucket = byUser.get(target.userId);
    if (bucket) bucket.push(target);
    else byUser.set(target.userId, [target]);
  }

  return [...byUser.values()].flatMap((candidates) => {
    if (candidates.length === 1) return candidates;
    const sourceMatches = candidates.filter((target) => target.identity.serverId === source.serverId);
    return sourceMatches.length === 1 ? sourceMatches : [];
  });
}

// Compatibility export for existing callers/tests. Canonical selection is a
// notification-intent decision, not a web-only transport decision.
export const selectCanonicalWebPushProjectionTargets = selectCanonicalNotificationProjectionTargets;

function buildAbsolutePushTargets(pushTargets: Map<string, PushPayload>, appUrl: string): PushNotificationTarget[] {
  return [...pushTargets.entries()].map(([userId, payload]) => ({
    userId,
    payload: { ...payload, url: `${appUrl}${payload.url}` },
  }));
}

function buildAbsoluteNotificationPushProjectionTargets(
  targets: NotificationPushProjectionTarget[],
  appUrl: string,
): NotificationPushProjectionTarget[] {
  return targets.map((target) => ({
    ...target,
    payload: { ...target.payload, url: `${appUrl}${target.payload.url}` },
  }));
}

function buildNotificationPushSocketIdentity(
  channel: Pick<typeof channels.$inferSelect, "id" | "serverId" | "type" | "parentMessageId">,
  messageId: string,
  parentChannelId: string | null = null,
): NotificationPushSocketIdentity {
  if (channel.type === "thread") {
    return {
      serverId: channel.serverId,
      kind: "thread",
      channelId: channel.id,
      threadId: channel.id,
      parentChannelId,
      parentMessageId: channel.parentMessageId,
      messageId,
    };
  }
  return {
    serverId: channel.serverId,
    kind: channel.type === "dm" ? "dm" : "channel",
    channelId: channel.id,
    threadId: null,
    parentChannelId: null,
    parentMessageId: null,
    messageId,
  };
}

function emitNotificationPushSocketTargets(
  io: SocketServer,
  targets: NotificationPushSocketTarget[],
): void {
  for (const { userId, payload } of targets) {
    emitPlatformScopedUserEvent(io, userId, "notification:push", payload);
  }
}

function emitNotificationPushProjectionTargets(
  io: SocketServer,
  targets: NotificationPushProjectionTarget[],
): void {
  if (!isNotificationPushSocketEnabled() || targets.length === 0) return;
  for (const target of targets) {
    const [socketTarget] = buildNotificationPushSocketTargets([target], target.identity);
    if (!socketTarget) continue;
    emitPlatformScopedUserEvent(io, socketTarget.userId, "notification:push", socketTarget.payload);
  }
}

// Handle Contract dual-namespace (product/identity/handle-contract.md @ 56f9fba, V2
// in #engineering:18165df1 + #engineering:623cd7d7): flat handles (humans + external
// agents) are globally unique, composed handles ({local}.{server_slug}) only get
// uniqueness from composition — so shorthand `@alice` can still collide across
// joint scopes and future federation. Picker selection emits {type,id,name} to pin
// the intended UUID at send time and survive rename. Free-text @mentions fall
// through to handle lookup in writeMentionFacts; the structured payload only
// covers picker-confirmed intent. Under v2, a raw handle that matches multiple
// actors stays inert and is reported to the sender as unresolved, while the
// ordinary message still succeeds. V1 retains its historical all-match behavior.
export type StructuredMentionInput = {
  type: "user" | "agent";
  id: string;
  name: string;
};

export class MentionValidationError extends Error {
  constructor(
    message: string,
    public readonly code?: "mention_binding_conflict",
  ) {
    super(message);
    this.name = "MentionValidationError";
  }
}

export async function validateStructuredResourceReferences(
  content: string,
  serverId: string,
  deps: {
    isResourceReferencesEnabled: (serverId: string) => Promise<boolean>;
    getComputerLinkedMachineIds: (serverId: string) => Promise<Set<string>>;
    getInstalledApp: (serverId: string, appId: AppId) => Promise<unknown | null>;
  } = {
    isResourceReferencesEnabled: async (targetServerId) => (
      await evaluateFeatureFlag({
        key: COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY,
        serverId: targetServerId,
      })
    ).enabled,
    getComputerLinkedMachineIds,
    getInstalledApp,
  },
): Promise<void> {
  let malformedReferenceKind: "Computer" | "App" | null = null;
  replaceOutsideMarkdownCode(content, (chunk) => {
    for (const match of chunk.matchAll(/(^|[^\\])<((?:computer|app):[^<>\n]+)>/g)) {
      if (!parseRaftRefTarget(match[2] ?? "")) {
        malformedReferenceKind = match[2]?.startsWith("computer:") ? "Computer" : "App";
        break;
      }
    }
    return chunk;
  });
  if (malformedReferenceKind) {
    throw new MentionValidationError(`${malformedReferenceKind} reference is malformed`);
  }

  const references = extractRaftRefTargets(content)
    .map((entry) => entry.target)
    .filter((target) => target.kind === "computer" || target.kind === "app");
  if (references.length === 0) return;
  if (!(await deps.isResourceReferencesEnabled(serverId))) {
    throw new MentionValidationError("Computer and App references are not enabled in this server");
  }

  const computerIds = [...new Set(
    references.flatMap((target) => target.kind === "computer" ? [target.machineId] : []),
  )];
  if (computerIds.length > 0) {
    const visibleComputerMachineIds = await deps.getComputerLinkedMachineIds(serverId);
    for (const machineId of computerIds) {
      if (!visibleComputerMachineIds.has(machineId)) {
        throw new MentionValidationError("Computer reference is not available in this server");
      }
    }
  }

  const appIds = [...new Set(
    references.flatMap((target) => target.kind === "app" ? [target.appId] : []),
  )];
  for (const appId of appIds) {
    if (!isAppId(appId) || !(await deps.getInstalledApp(serverId, appId))) {
      throw new MentionValidationError("App reference is not installed in this server");
    }
  }
}

export class UserRandomIdConflictError extends Error {
  status = 409 as const;
  code = "random_id_conflict" as const;

  constructor() {
    super("randomId has already been used for a different message");
    this.name = "UserRandomIdConflictError";
  }
}

function isMessageRouteDomainError(error: unknown): boolean {
  return error instanceof channelService.ChannelArchivedError
    || error instanceof MentionValidationError
    || error instanceof UserRandomIdConflictError
    || error instanceof AttachmentLinkError;
}

export type SystemMessageInboxFactProducer =
  | "agent.join_channel"
  | "agent.migration_completed_receipt"
  | "agent.migration_canceled_receipt"
  | "agent.migration_failed_receipt"
  | "action_card.carrier"
  | "channel.agent_membership"
  | "channel.human_membership"
  | "channel.self_unfollow_thread"
  | "channel.rename"
  | "channel.archive"
  | "channel.unarchive"
  | "onboarding.owner_instruction"
  | "onboarding.owner_opener_v2_ledger"
  | "onboarding.member_instruction"
  | "onboarding.all_channel_unlock"
  | "onboarding.cross_channel_hint"
  | "task.body"
  | "task.created_summary"
  | "task.assignment_receipt"
  | "task.converted_summary"
  | "task.lifecycle_thread"
  | "task.deleted_summary"
  | "external_projection.inbound"
  | `test.${string}`;

export type SystemMessageInboxFactPolicy = {
  mode: "record" | "skip";
  producer: SystemMessageInboxFactProducer;
  reason: string;
};

export type ResolvedMentionFact = {
  type: "user" | "agent";
  id: string;
  name: string;
};

/**
 * The real human/agent whose action produced a system message. System-message
 * fact rows always carry `senderType:"system"`, so the ordinary
 * receiver===sender born-read shortcut can never fire for the actor. Passing the
 * real actor lets us born-read the actor's own row for self-caused system
 * messages. `{type,id}` (not a bare id) so `user:U` and `agent:U` never collide.
 */
export type CausalActor = {
  type: "user" | "agent";
  id: string;
};

function messageReceiverUnreadEligible(
  receiverType: "user" | "agent",
  receiverId: string,
  senderType: "user" | "agent" | "system" | "external_projection",
  senderId: string,
  causalActor?: CausalActor,
) {
  // Per-item born-read: the actor who caused this (system) message is not
  // unread-eligible for their own row. This is a fact-level flag only; it does
  // NOT touch any read cursor/watermark.
  if (causalActor && causalActor.type === receiverType && causalActor.id === receiverId) {
    return false;
  }
  return !(receiverType === senderType && receiverId === senderId);
}

async function recordInboxFactsForPersistedMessage(opts: {
  channel: typeof channels.$inferSelect;
  message: typeof messages.$inferSelect;
  senderType: "user" | "agent" | "system" | "external_projection";
  senderId: string;
  causalActor?: CausalActor;
  targetVisibleMentions: ResolvedMentionFact[];
  jointProjections: channelService.JointChannelProjection[];
  jointThreadProjection: channelService.JointThreadProjection | null;
  deps: MessageServiceDeps;
  executor?: DatabaseExecutor;
  persistenceState?: PostPersistThreadReadPersistenceState;
  dedupeLogicalReceiverAcrossJointProjections?: boolean;
}) {
  // Keep the optional executor lazy: mocked persistence need not own a DB.
  const executor = opts.executor;
  const mentionKeys = new Set(opts.targetVisibleMentions.map((mention) => `${mention.type}:${mention.id}`));
  const facts: InboxNotificationFactInput[] = [];
  const factsByKey = new Map<string, InboxNotificationFactInput>();
  const addReceiver = (
    receiverType: "user" | "agent",
    receiverId: string,
    serverId: string,
    kind: "channel" | "dm" | "thread",
    sourceChannelId: string,
    receiverOpts: { suppressionReason?: InboxNotificationFactInput["suppressionReason"] } = {},
  ) => {
    const key = opts.dedupeLogicalReceiverAcrossJointProjections
      && (opts.jointProjections.length > 0 || opts.jointThreadProjection)
      ? `${receiverType}:${receiverId}`
      : `${receiverType}:${receiverId}:${sourceChannelId}`;
    const personalMention = mentionKeys.has(`${receiverType}:${receiverId}`);
    const existing = factsByKey.get(key);
    if (existing) {
      existing.personalMention = existing.personalMention || personalMention;
      existing.suppressionReason ??= receiverOpts.suppressionReason;
      return;
    }
    const fact: InboxNotificationFactInput = {
      receiverType,
      receiverId,
      serverId,
      kind,
      sourceChannelId,
      messageId: opts.message.id,
      messageSeq: opts.message.seq,
      activityAt: opts.message.createdAt,
      personalMention,
      unreadEligible: messageReceiverUnreadEligible(receiverType, receiverId, opts.senderType, opts.senderId, opts.causalActor),
      suppressionReason: receiverOpts.suppressionReason,
    };
    factsByKey.set(key, fact);
    facts.push(fact);
  };
  const addThreadSameSendCandidates = async (
    serverId: string,
    sourceThreadChannelId: string,
    parentChannelId: string,
    optsForCandidates: { useJointProjectionResolver?: boolean } = {},
  ) => {
    // Facts must be complete for this send before later thread-follow side effects
    // run, so include deterministic same-send eligibility here.
    const [parentHumans, parentAgents] = await Promise.all([
      opts.deps.getChannelHumans(parentChannelId),
      opts.deps.getChannelAgents(parentChannelId),
    ]);
    const parentHumanIds = new Set(parentHumans.map((human) => human.id));
    const parentAgentIds = new Set(parentAgents.map((agent) => agent.id));
    const addSameSendReceiver = async (
      actorType: "user" | "agent",
      actorId: string,
      receiverOpts: { suppressionReason?: InboxNotificationFactInput["suppressionReason"] } = {},
    ) => {
      if (optsForCandidates.useJointProjectionResolver) {
        const projection = await opts.deps.getJointThreadProjectionForMember(
          opts.message.channelId,
          actorType,
          actorId,
          executor,
        );
        if (projection?.localThreadChannelId !== sourceThreadChannelId) return;
      }
      addReceiver(actorType, actorId, serverId, "thread", sourceThreadChannelId, receiverOpts);
    };

    if (opts.senderType === "user" || opts.senderType === "agent") {
      await addSameSendReceiver(opts.senderType, opts.senderId);
    }

    const explicitUnfollows = await opts.deps.listExplicitThreadUnfollows(sourceThreadChannelId, executor);
    const explicitUnfollowKeys = new Set(
      explicitUnfollows.map((row) => `${row.followerType}:${row.followerId}`),
    );
    const hasExplicitThreadUnfollow = (actorType: "user" | "agent", actorId: string) =>
      explicitUnfollowKeys.has(`${actorType}:${actorId}`);
    if (opts.channel.parentMessageId) {
      const [parentMsg] = await (executor ?? getDb())
        .select({ senderType: messages.senderType, senderId: messages.senderId })
        .from(messages)
        .where(eq(messages.id, opts.channel.parentMessageId))
        .limit(1);
      if (
        parentMsg
        && (opts.senderType === "system" || !(parentMsg.senderType === opts.senderType && parentMsg.senderId === opts.senderId))
        && (parentMsg.senderType === "user" || parentMsg.senderType === "agent")
        && !hasExplicitThreadUnfollow(parentMsg.senderType, parentMsg.senderId)
      ) {
        await addSameSendReceiver(parentMsg.senderType, parentMsg.senderId);
      }
    }

    for (const mention of opts.targetVisibleMentions) {
      if (mention.type === "user" && parentHumanIds.has(mention.id)) {
        await addSameSendReceiver("user", mention.id);
      }
      if (mention.type === "agent" && parentAgentIds.has(mention.id)) {
        await addSameSendReceiver("agent", mention.id);
      }
    }

    for (const row of explicitUnfollows) {
      await addSameSendReceiver(row.followerType, row.followerId, {
        suppressionReason: "unfollowed_thread_ordinary",
      });
    }
  };
  const addPostPersistThreadSameSendCandidates = async (
    serverId: string,
    sourceThreadChannelId: string,
    parentChannelId: string,
    optsForCandidates: { useJointProjectionResolver?: boolean } = {},
  ) => runPostPersistThreadRead({
    purpose: "inbox_notification_facts",
    queryName: "thread_follows.same_send_candidates",
    persistenceState: opts.persistenceState ?? "committed",
    fallback: undefined,
    work: () => addThreadSameSendCandidates(
      serverId,
      sourceThreadChannelId,
      parentChannelId,
      optsForCandidates,
    ),
  });

  if (opts.channel.type === "thread") {
    if (opts.jointThreadProjection) {
      // A joint-thread reply may be finalized inside the source-message
      // transaction. Re-entering getDb() here deadlocks pglite's single
      // connection and escapes the transaction snapshot on Postgres, so keep
      // projection and follower reads on the caller's executor.
      const projections = await opts.deps.getActiveJointThreadProjectionsByCanonicalThread(
        opts.message.channelId,
        executor,
      );
      for (const projection of projections) {
        const { humanFollowerIds, agentFollowers } = await getPostPersistThreadFollowerCandidates(
          opts.deps,
          projection.localThreadChannelId,
          "inbox_notification_facts",
          executor,
          projection,
          opts.persistenceState ?? "committed",
        );
        for (const userId of humanFollowerIds) addReceiver("user", userId, projection.localServerId, "thread", projection.localThreadChannelId);
        for (const agent of agentFollowers) addReceiver("agent", agent.id, projection.localServerId, "thread", projection.localThreadChannelId);
        await addPostPersistThreadSameSendCandidates(
          projection.localServerId,
          projection.localThreadChannelId,
          projection.localParentChannelId,
          { useJointProjectionResolver: true },
        );
      }
    } else {
      let parentChannelId: string | null = null;
      if (opts.channel.parentMessageId) {
        // This helper runs inside the human random-send transaction. Re-entering
        // the global database here deadlocks pglite's single connection and also
        // escapes the transaction snapshot on Postgres. Keep every lookup on
        // the executor selected by the caller.
        const [parentMsg] = await (executor ?? getDb())
          .select({ channelId: messages.channelId })
          .from(messages)
          .where(eq(messages.id, opts.channel.parentMessageId))
          .limit(1);
        parentChannelId = parentMsg?.channelId ?? null;
      }
      const { humanFollowerIds, agentFollowers } = await getPostPersistThreadFollowerCandidates(
        opts.deps,
        opts.channel.id,
        "inbox_notification_facts",
        executor,
        opts.jointThreadProjection,
        opts.persistenceState ?? "committed",
      );
      for (const userId of humanFollowerIds) addReceiver("user", userId, opts.channel.serverId, "thread", opts.channel.id);
      for (const agent of agentFollowers) addReceiver("agent", agent.id, opts.channel.serverId, "thread", opts.channel.id);
      if (parentChannelId) {
        await addPostPersistThreadSameSendCandidates(opts.channel.serverId, opts.channel.id, parentChannelId);
      }
    }
  } else if (opts.jointProjections.length > 0) {
    for (const projection of opts.jointProjections) {
      const [humans, agents] = await Promise.all([
        opts.deps.getChannelHumans(projection.localChannelId),
        opts.deps.getChannelAgents(projection.localChannelId),
      ]);
      for (const human of humans) addReceiver("user", human.id, projection.serverId, "channel", projection.localChannelId);
      for (const agent of agents) addReceiver("agent", agent.id, projection.serverId, "channel", projection.localChannelId);
    }
  } else {
    const [humans, agents] = await Promise.all([
      opts.deps.getChannelHumans(opts.channel.id),
      opts.deps.getChannelAgents(opts.channel.id),
    ]);
    const kind = opts.channel.type === "dm" ? "dm" : "channel";
    for (const human of humans) addReceiver("user", human.id, opts.channel.serverId, kind, opts.channel.id);
    for (const agent of agents) addReceiver("agent", agent.id, opts.channel.serverId, kind, opts.channel.id);
  }

  const recorded = await opts.deps.recordInboxNotificationFacts(facts, executor);
  const threadAgentDeliveryCandidates = opts.channel.type === "thread"
    ? buildThreadAgentDeliveryCandidatesFromFacts(facts, opts.channel.id)
    : undefined;
  if (opts.senderType !== "external_projection") {
    await stampSendPathPersonalMentionDelivery({
      facts,
      message: opts.message,
      senderType: opts.senderType,
      senderId: opts.senderId,
      executor,
    });
  }
  // Observability for born-read (self-caused) suppression: count receiver rows
  // written with unreadEligible=false. For system messages a receiver is only
  // ever unread-ineligible via the causalActor self-caused gate, so this IS the
  // born-read count — the post-release signal (stdrc 7/11) that the gate really
  // fires in prod: born-read producers show bornReadReceiverCount>=1 while
  // self-caused-unread noise trends to zero.
  const bornReadReceiverCount = facts.filter((fact) => fact.unreadEligible === false).length;
  return { recorded, bornReadReceiverCount, threadAgentDeliveryCandidates };
}

async function stampSendPathPersonalMentionDelivery(opts: {
  facts: readonly InboxNotificationFactInput[];
  message: typeof messages.$inferSelect;
  senderType: "user" | "agent" | "system";
  senderId: string;
  executor?: DatabaseExecutor;
}) {
  const deliveredMentionTargets = opts.facts.filter((fact) =>
    fact.personalMention === true
      && fact.unreadEligible !== false
  );
  if (deliveredMentionTargets.length === 0) return;

  const targetPredicates = deliveredMentionTargets.map((fact) =>
    and(
      eq(messageMentions.targetType, fact.receiverType),
      eq(messageMentions.targetId, fact.receiverId),
    )
  );
  const deliveredAt = opts.message.createdAt;
  const stamp = opts.senderType === "system"
    ? { notifiedAt: deliveredAt }
    : { notifiedAt: deliveredAt, notifiedByType: opts.senderType, notifiedById: opts.senderId };
  await (opts.executor ?? getDb())
    .update(messageMentions)
    .set(stamp)
    .where(and(
      // `messageId` is globally unique. A canonical joint message deliberately
      // records its mention on the assignee's reachable local projection, so
      // the mention channel id need not equal the durable message channel id.
      eq(messageMentions.messageId, opts.message.id),
      eq(messageMentions.notifiableAtSend, true),
      isNull(messageMentions.notifiedAt),
      or(...targetPredicates),
    ));
}

export async function recordInboxFactsForPersistedMessages(
  persistedMessages: readonly (typeof messages.$inferSelect)[],
  opts: {
    inboxFactPolicy: SystemMessageInboxFactPolicy;
    executor?: DatabaseExecutor;
    channel?: typeof channels.$inferSelect;
    /**
     * Allows an executor-bound ordinary thread whose parent scope has already
     * been locked and validated by the caller. Joint-backed threads remain on
     * the projection-aware path and must not opt in here.
     */
    allowExecutorThread?: boolean;
    /**
     * Explicit transaction-bound Joint thread face. The caller must already
     * have locked and validated the complete active projection set.
     */
    jointThreadProjection?: channelService.JointThreadProjection | null;
    jointProjections?: readonly channelService.JointChannelProjection[];
    recordJointLocalFace?: boolean;
    causalActorByMessageId?: ReadonlyMap<string, CausalActor>;
    targetVisibleMentionsByMessageId?: ReadonlyMap<string, readonly ResolvedMentionFact[]>;
    /** Collapse a joint member present on multiple projections to one global receipt. */
    dedupeLogicalReceiverAcrossJointProjections?: boolean;
  },
): Promise<number> {
  if (persistedMessages.length === 0) return 0;
  const baseDeps = resolveMessageServiceDeps();
  const executor = opts.executor;
  const deps: MessageServiceDeps = executor
    ? {
        ...baseDeps,
        getChannelHumans: (channelId) => getChannelHumansWithExecutor(executor, channelId, opts.channel),
        getChannelAgents: (channelId) => getChannelAgentsWithExecutor(executor, channelId, opts.channel),
        recordInboxNotificationFacts: (facts, factExecutor) => baseDeps.recordInboxNotificationFacts(
          facts,
          factExecutor ?? executor,
        ),
        getActiveJointThreadProjectionsByCanonicalThread: (channelId) =>
          channelService.getActiveJointThreadProjectionsByCanonicalThread(channelId, executor),
        getJointThreadProjectionForMember: (channelId, followerType, followerId) =>
          channelService.getJointThreadProjectionForMember(channelId, followerType, followerId, executor),
      }
    : baseDeps;
  const mentionsByMessage = opts.targetVisibleMentionsByMessageId
    ?? (executor
      ? await getMentionFactsForMessagesWithExecutor(executor, persistedMessages.map((message) => message.id))
      : await deps.getMentionFactsForMessages(persistedMessages.map((message) => message.id)));
  let totalFacts = 0;
  const jointProjectionLookups = new Map<string, Promise<channelService.JointChannelProjection[]>>();
  const getJointProjectionsForChannel = (channelId: string) => {
    let lookup = jointProjectionLookups.get(channelId);
    if (!lookup) {
      lookup = deps.getActiveJointChannelProjectionsByLocalChannel(channelId);
      jointProjectionLookups.set(channelId, lookup);
    }
    return lookup;
  };

  for (const message of persistedMessages) {
    const channel = opts.channel?.id === message.channelId
      ? opts.channel
      : executor
        ? (await executor.select().from(channels).where(eq(channels.id, message.channelId)).limit(1))[0]
        : await deps.getChannel(message.channelId);
    if (!channel) continue;
    if (
      executor
      && channel.type === "thread"
      && !opts.allowExecutorThread
      && !opts.jointThreadProjection
    ) {
      throw new Error(`Executor-backed persisted facts do not support ${channel.type} channels`);
    }
    if (executor && channel.type === "joint" && !opts.jointProjections) {
      throw new Error("Executor-backed persisted facts for joint channels require frozen projections");
    }
    if (opts.inboxFactPolicy.mode === "skip") {
      addTraceEvent("message_pipeline.persisted_message_inbox_notification_facts.skipped", {
        target_type: channel.type,
        policy_mode: opts.inboxFactPolicy.mode,
        policy_producer: opts.inboxFactPolicy.producer,
        policy_reason: opts.inboxFactPolicy.reason,
      });
      continue;
    }
    if (channel.type === "joint" && !opts.recordJointLocalFace) {
      addTraceEvent("message_pipeline.persisted_message_inbox_notification_facts.skipped", {
        target_type: channel.type,
        policy_mode: opts.inboxFactPolicy.mode,
        policy_producer: opts.inboxFactPolicy.producer,
        policy_reason: opts.inboxFactPolicy.reason,
        skip_reason: "joint_local_face",
      });
      continue;
    }
    const inboxFactStart = currentTimeMs();
    const jointThreadProjection = opts.jointThreadProjection !== undefined
      ? opts.jointThreadProjection
      : channel.type === "thread" && !executor
        ? await channelService.getJointThreadProjectionByLocalThread(message.channelId)
          ?? null
        : null;
    const jointProjectionChannelId = jointThreadProjection?.canonicalThreadChannelId
      ?? (channel.type === "thread" || channel.type === "dm" ? null : message.channelId);
    const jointProjections = opts.jointProjections
      ? [...opts.jointProjections]
      : executor
        ? []
        : jointProjectionChannelId
          ? await getJointProjectionsForChannel(jointProjectionChannelId)
          : [];
    const persistedSenderType = message.messageType === "system"
      ? "system" as const
      : message.senderType;
    const { recorded: factCount, bornReadReceiverCount } = await recordInboxFactsForPersistedMessage({
      channel,
      message,
      senderType: persistedSenderType,
      senderId: message.senderId,
      causalActor: opts.causalActorByMessageId?.get(message.id),
      targetVisibleMentions: [...(mentionsByMessage.get(message.id) ?? [])],
      jointProjections,
      jointThreadProjection,
      deps,
      executor,
      dedupeLogicalReceiverAcrossJointProjections:
        opts.dedupeLogicalReceiverAcrossJointProjections,
    });
    totalFacts += factCount;
    addTraceEvent("message_pipeline.persisted_message_inbox_notification_facts.recorded", {
      duration_ms: currentTimeMs() - inboxFactStart,
      sender_type: persistedSenderType,
      target_type: channel.type,
      fact_count: factCount,
      born_read_receiver_count: bornReadReceiverCount,
      policy_mode: opts.inboxFactPolicy.mode,
      policy_producer: opts.inboxFactPolicy.producer,
      policy_reason: opts.inboxFactPolicy.reason,
      joint_projection_present: jointProjections.length > 0,
      joint_thread_projection_present: jointThreadProjection != null,
    });
  }

  return totalFacts;
}

type AddMemberWithMembershipSystemMessageInput = {
  channel: typeof channels.$inferSelect;
  memberId: string;
  memberName: string;
  memberType: "human" | "agent";
  causalActor: CausalActor;
  executor?: DatabaseExecutor;
};

/**
 * Atomically add a channel member and persist the shared membership notice
 * plus its inbox facts. A failed message/fact write rolls membership back, so
 * an ordinary retry can perform the complete operation instead of getting
 * trapped behind an already-member result with no durable notice.
 */
async function addMemberWithMembershipSystemMessage(
  input: AddMemberWithMembershipSystemMessageInput,
): Promise<{ added: boolean; message?: typeof messages.$inferSelect }> {
  const deps = resolveMessageServiceDeps();
  // Joint projection discovery uses the committed routing graph. Freeze that
  // audience and canonical storage identity before entering the write
  // transaction. Membership remains local to the addressed projection, while
  // the durable message and its projected facts belong to canonical storage.
  // Standalone callers perform these lookups before opening the write
  // transaction. A caller that already owns the channel lock supplies its
  // executor so joint lookup and persistence stay on the same connection.
  const jointProjections = input.channel.type === "joint"
    ? await deps.getActiveJointChannelProjectionsByLocalChannel(input.channel.id, input.executor)
    : undefined;
  let storageChannel = input.channel;
  if (jointProjections) {
    const canonicalChannelIds = new Set(jointProjections.map((projection) => projection.canonicalChannelId));
    if (jointProjections.length === 0 || canonicalChannelIds.size !== 1) {
      throw new Error("Active joint projection requires one canonical storage channel");
    }
    const [canonicalChannelId] = canonicalChannelIds;
    const canonicalChannel = await deps.getChannel(canonicalChannelId!, { executor: input.executor });
    if (!canonicalChannel || canonicalChannel.type !== "channel") {
      throw new Error("Active joint projection canonical storage channel is unavailable");
    }
    storageChannel = canonicalChannel;
  }
  const apply = async (tx: DatabaseExecutor) => {
    const added = input.memberType === "human"
      ? await channelService.addHuman(input.channel.id, input.memberId, { executor: tx })
      : await channelService.addAgent(input.channel.id, input.memberId, { executor: tx });
    if (!added) return { added: false };

    const content = `@${input.memberName} was added to this channel.`;
    const message = await deps.createMessage(
      storageChannel.id,
      "user",
      "system",
      content,
      "system",
      undefined,
      undefined,
      tx,
    );
    await recordInboxFactsForPersistedMessages([message], {
      inboxFactPolicy: {
        mode: "record",
        producer: input.memberType === "human"
          ? "channel.human_membership"
          : "channel.agent_membership",
        reason: `${input.memberType} membership changes are shared channel activity`,
      },
      executor: tx,
      channel: storageChannel,
      jointProjections,
      causalActorByMessageId: new Map([[message.id, input.causalActor]]),
    });
    await failpoints.hit("server.channel.membership.afterPersist", {
      channelId: input.channel.id,
      memberId: input.memberId,
      memberType: input.memberType,
      messageId: message.id,
    });
    return { added: true, message };
  };
  return input.executor ? apply(input.executor) : getDb().transaction(apply);
}

export async function addHumanWithMembershipSystemMessage(input: {
  channel: typeof channels.$inferSelect;
  userId: string;
  userName: string;
  causalActor: CausalActor;
  executor?: DatabaseExecutor;
}): Promise<{ added: boolean; message?: typeof messages.$inferSelect }> {
  return addMemberWithMembershipSystemMessage({
    channel: input.channel,
    memberId: input.userId,
    memberName: input.userName,
    memberType: "human",
    causalActor: input.causalActor,
    executor: input.executor,
  });
}

export async function addAgentWithMembershipSystemMessage(input: {
  channel: typeof channels.$inferSelect;
  agentId: string;
  agentName: string;
  causalActor: CausalActor;
  executor?: DatabaseExecutor;
}): Promise<{ added: boolean; message?: typeof messages.$inferSelect }> {
  return addMemberWithMembershipSystemMessage({
    channel: input.channel,
    memberId: input.agentId,
    memberName: input.agentName,
    memberType: "agent",
    causalActor: input.causalActor,
    executor: input.executor,
  });
}

type ResolvedMentionTarget = {
  targetType: "user" | "agent";
  targetId: string;
  rawHandle: string;
  targetAvatarUrl: string | null;
  // Send-time eligibility snapshot (mention-AX contract M-3/P-0): true when the
  // target was a scope-channel member at send commit and the mention may project
  // as a normal target-side notification. False rows are sender-side pending
  // actions only, invisible to the target until notify/add sets notified_at.
  notifiableAtSend: boolean;
};

function getMessageShortId(messageId: string): string {
  return messageId.slice(0, 8);
}

// Return the typed wire form (not opaque string) so a dropped sigil here is a
// compile error — the server constructs these targets, same as cli formatTarget.
function formatParentTarget(parentChannelType: string, parentName: string): RaftTargetString {
  return parentChannelType === "dm" ? `dm:@${parentName}` : `#${parentName}`;
}

function formatThreadTarget(parentChannelType: string, parentName: string, threadShortId: string): RaftTargetString {
  return parentChannelType === "dm"
    ? `dm:@${parentName}:${threadShortId}`
    : `#${parentName}:${threadShortId}`;
}

export function toAgentVisibleSenderType(senderType: StoredMessageSenderType, messageType: "chat" | "system" = "chat"): AgentVisibleSenderType {
  if (messageType === "system") return "system";
  if (senderType === "external_projection") return "third_party_app";
  return senderType === "user" ? "human" : "agent";
}

export function toAgentVisibleExternalMessage(message: {
  senderType: StoredMessageSenderType;
  externalAuthor?: EnrichedMessageRow["externalAuthor"];
}) {
  if (message.senderType !== "external_projection") return {};
  const author = message.externalAuthor;
  if (!author) throw new Error("External projection message is missing immutable provenance");
  return {
    external_message: {
      schema: "external-message-provenance.v1" as const,
      provider: author.provider,
      workspace_id: author.workspaceId,
      conversation_id: author.externalConversationId,
      message_id: author.externalMessageId,
      actor_id: author.externalActorId,
      actor_kind: author.actorKind,
      projection_id: author.projectionId,
    },
  };
}

export function renderAgentVisibleMessageContent(
  message: { senderType: StoredMessageSenderType; content: string },
  ordinaryRenderedContent: string,
): string {
  return message.senderType === "external_projection"
    ? renderThirdPartyInertText({ field: "tool_result", value: message.content })
    : ordinaryRenderedContent;
}

/**
 * Canonical downgrade for an enriched message returned by an Agent HTTP
 * mutation. Human websocket projections intentionally keep the enriched row;
 * the Agent response is a separate authority surface and must never inherit
 * Human-only external-author, raw search/storage, mention, task, claim, or
 * action-card fields.
 */
export function projectAgentVisibleHttpMessageResponse(
  message: EnrichedMessageRow,
  ordinaryRenderedContent: string = message.content,
): Record<string, unknown> {
  const external = message.senderType === "external_projection";
  const envelope: Record<string, unknown> = {
    ...message,
    senderType: toAgentVisibleSenderType(message.senderType, message.messageType),
    content: renderAgentVisibleMessageContent(message, ordinaryRenderedContent),
    ...(external ? toAgentVisibleExternalMessage(message) : {}),
    ...(external ? { mentioned: false } : {}),
  };
  if (external) {
    for (const field of Object.keys(envelope)) {
      if (isAgentApiExternalMessageForbiddenAuthorityField(field)) delete envelope[field];
    }
  }
  return envelope;
}

// Map DB channel rows into the channel_type field delivered to runtimes.
// This preserves the existing agent envelope contract; do not change privacy
// exposure here as a side effect of chat-history or membership-notice changes.
function toAgentVisibleChannelType(channelType: typeof channels.$inferSelect["type"]): AgentVisibleChannelType {
  return channelType === "thread"
    ? "thread"
    : channelType === "dm"
      ? "dm"
      : channelType === "private"
        ? "private"
        : "channel";
}

function toAgentVisibleTaskAssigneeType(taskAssigneeType: InternalActorType | null | undefined): AgentVisibleTaskAssigneeType {
  if (!taskAssigneeType) return null;
  return taskAssigneeType === "user" ? "human" : "agent";
}

function getAgentVisibleTaskAssigneeName(message: {
  taskAssigneeId?: string | null;
  taskAssigneeName?: string | null;
  claimedByName?: string | null;
}): string | null {
  return message.taskAssigneeName ?? message.claimedByName ?? null;
}

async function getSenderIdentity(senderType: "user" | "agent", senderId: string, fallbackName: string): Promise<{ uniqueName: string; description: string | null }> {
  const db = getDb();
  if (senderType === "user") {
    const [user] = await db
      .select({ name: users.name, description: users.description })
      .from(users)
      .where(eq(users.id, senderId));
    return {
      uniqueName: user?.name || fallbackName,
      description: user?.description || null,
    };
  }

  const [agent] = await db
    .select({ name: agents.name, description: agents.description })
    .from(agents)
    .where(eq(agents.id, senderId));
  return {
    uniqueName: agent?.name || fallbackName,
    description: agent?.description || null,
  };
}

export async function createMessage(
  channelId: string,
  senderType: "user" | "agent",
  senderId: string,
  content: string,
  messageType: "chat" | "system" = "chat",
  taskFields?: { taskStatus: "todo"; taskNumber: number },
  extraFields?: { threadId?: string | null; agentSendKey?: string | null; randomId?: string | null; actionMetadata?: unknown | null },
  executor: DatabaseExecutor = getDb(),
) {
  const db = executor;
  const [message] = await db
    .insert(messages)
    .values({
      channelId,
      senderType,
      senderId,
      content,
      messageType,
      searchText: buildSearchText(content),
      ...taskFields,
      ...extraFields,
    })
    .returning();
  await db.update(userChannelInboxStates)
    .set({ doneAt: null, updatedAt: new Date() })
    .where(and(
      eq(userChannelInboxStates.channelId, channelId),
      isNotNull(userChannelInboxStates.doneAt),
    ));
  return message;
}

/**
 * Reserve the complete wire identity for a system message before it is
 * persisted.
 *
 * App-owned delivery uses this narrow seam so the persist-before-delivery
 * invariant has a literal reverse mutation: a test can move delivery of this
 * prepared row above its insert and prove that replay exposes the operation
 * twice. Reserving a sequence is not publication; the row becomes a durable
 * chat fact only in `persistPreparedSystemMessage`.
 */
export async function prepareSystemMessageForOrderedDelivery(
  channelId: string,
  content: string,
  eventId: string,
): Promise<typeof messages.$inferSelect> {
  const sequenceResult = await getDb().execute(sql`
    SELECT nextval(pg_get_serial_sequence('messages', 'seq')) AS seq
  `);
  const [sequenceRow] = sequenceResult.rows as Array<{ seq: number | bigint | string }>;
  const reservedSeq = sequenceRow == null ? Number.NaN : Number(sequenceRow.seq);
  if (!Number.isSafeInteger(reservedSeq) || reservedSeq <= 0) {
    throw new Error("Could not reserve system message sequence");
  }
  const now = currentDate();
  return {
    id: randomUUID(),
    seq: reservedSeq,
    channelId,
    senderType: "user",
    senderId: "system",
    agentSendKey: null,
    randomId: eventId,
    messageType: "system",
    content,
    actionMetadata: null,
    searchText: buildSearchText(content),
    searchVector: null,
    threadId: null,
    taskStatus: null,
    taskNumber: null,
    taskAssigneeType: null,
    taskAssigneeId: null,
    taskClaimedAt: null,
    taskCompletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Persist a prepared system row once per OS-minted event id.
 *
 * The existing partial `(sender_id, random_id)` unique index is the best-effort
 * replay boundary. A conflict returns the canonical row only when every
 * delivery-bearing field still matches; reusing an event id for different
 * content or a different target fails closed.
 */
export async function persistPreparedSystemMessage(
  prepared: typeof messages.$inferSelect,
): Promise<{ message: typeof messages.$inferSelect; replayed: boolean }> {
  if (
    prepared.senderType !== "user"
    || prepared.senderId !== "system"
    || prepared.messageType !== "system"
    || !prepared.randomId
  ) {
    throw new Error("Prepared system message identity is invalid");
  }
  const eventId = prepared.randomId;

  return getDb().transaction(async (tx) => {
    const [inserted] = await tx
      .insert(messages)
      .values({
        id: prepared.id,
        seq: prepared.seq,
        channelId: prepared.channelId,
        senderType: prepared.senderType,
        senderId: prepared.senderId,
        randomId: eventId,
        messageType: prepared.messageType,
        content: prepared.content,
        searchText: prepared.searchText,
        createdAt: prepared.createdAt,
        updatedAt: prepared.updatedAt,
      })
      .onConflictDoNothing()
      .returning();

    const message = inserted ?? (await tx
      .select()
      .from(messages)
      .where(and(
        eq(messages.senderType, "user"),
        eq(messages.senderId, "system"),
        eq(messages.randomId, eventId),
      ))
      .limit(1))[0];
    if (!message) {
      throw new Error("System message replay lookup failed after idempotency conflict");
    }
    if (
      message.channelId !== prepared.channelId
      || message.messageType !== "system"
      || message.content !== prepared.content
    ) {
      throw new Error("System message event id was reused for a different message");
    }

    if (inserted) {
      await tx.update(userChannelInboxStates)
        .set({ doneAt: null, updatedAt: currentDate() })
        .where(and(
          eq(userChannelInboxStates.channelId, prepared.channelId),
          isNotNull(userChannelInboxStates.doneAt),
        ));
    }
    return { message, replayed: !inserted };
  });
}

type NewChatMessageTransactionFacts = {
  targetVisibleMentions: ResolvedMentionFact[];
  resolvedMentions: ResolvedMentionFact[];
  pendingMentionActions: PendingMentionAction[];
  outboundDeliveryId: string | null;
  threadAgentDeliveryCandidates: AgentDeliveryCandidate[] | undefined;
};

/**
 * Persists every message-derived fact that must share the winning source
 * message transaction. The Slack delivery outbox will be appended here; this
 * executor boundary deliberately exists before the additive outbox migration
 * so no producer has to grow a post-commit hook later.
 */
async function finalizeNewChatMessageInTransaction(opts: {
  executor: DatabaseExecutor;
  message: typeof messages.$inferSelect;
  channel: typeof channels.$inferSelect | null | undefined;
  requestedChannelId: string;
  senderType: "user" | "agent";
  senderId: string;
  authorName: string;
  mentionHandles?: string[] | null;
  mentionResolution: { targets: ResolvedMentionTarget[]; resolvedFacts: ResolvedMentionFact[] } | null;
  mentionScope: { scopeChannelId: string; scopeType: string } | null;
  mentions?: StructuredMentionInput[];
  mentionContract: "v1" | "v2";
  jointProjection: channelService.JointChannelProjection | null | undefined;
  jointProjections: channelService.JointChannelProjection[];
  jointThreadProjection: channelService.JointThreadProjection | null;
  ordinaryExternalProjectionDecision: OrdinaryMessageExternalProjectionDecision;
  deps: MessageServiceDeps;
}): Promise<NewChatMessageTransactionFacts> {
  const {
    executor,
    message,
    channel,
    requestedChannelId,
    senderType,
    senderId,
    mentionHandles,
  } = opts;
  let resolvedMentions: ResolvedMentionFact[] = [];
  let pendingMentionActions: PendingMentionAction[] = [];

  if (channel && mentionHandles && mentionHandles.length > 0) {
    if (opts.mentionResolution) {
      const insertedRows = await insertResolvedMentionTargets(
        message.id,
        message.seq,
        channel.serverId,
        requestedChannelId,
        opts.mentionResolution.targets,
        {
          ...opts.deps,
          insertMentionRows: (rows) => insertMentionRowsWithExecutor(executor, rows),
        },
      );
      resolvedMentions = opts.mentionResolution.resolvedFacts;
      pendingMentionActions = opts.mentionScope?.scopeType === "dm"
        ? []
        : await buildPendingMentionActions(
          insertedRows,
          opts.mentionResolution.targets,
          message.id,
          channel.serverId,
          requestedChannelId,
          senderType,
          senderId,
          opts.deps,
          executor,
        );
    } else {
      const mentionScope = opts.mentionScope ?? await resolveMentionScopeForChannel(
        channel,
        requestedChannelId,
        opts.jointProjection ?? null,
        opts.jointThreadProjection,
        opts.deps,
        executor,
      );
      const written = await writeMentionFacts(
        message.id,
        message.seq,
        channel.serverId,
        requestedChannelId,
        senderType,
        senderId,
        mentionScope.scopeChannelId,
        mentionScope.scopeType,
        mentionHandles,
        opts.mentions,
        opts.mentionContract,
        {
          ...opts.deps,
          insertMentionRows: (rows) => insertMentionRowsWithExecutor(executor, rows),
        },
      );
      resolvedMentions = written.resolvedFacts;
      pendingMentionActions = written.pendingMentionActions;
    }
  }

  const targetVisibleMentions = mentionHandles && mentionHandles.length > 0
    ? (await getMentionFactsForMessagesWithExecutor(executor, [message.id])).get(message.id) ?? []
    : [];

  let threadAgentDeliveryCandidates: AgentDeliveryCandidate[] | undefined;
  if (channel) {
    const transactionDeps: MessageServiceDeps = {
      ...opts.deps,
      getChannelHumans: (localChannelId) =>
        getChannelHumansWithExecutor(executor, localChannelId, channel),
      getChannelAgents: (localChannelId) =>
        getChannelAgentsWithExecutor(executor, localChannelId, channel),
      recordInboxNotificationFacts: (facts, factExecutor) =>
        opts.deps.recordInboxNotificationFacts(facts, factExecutor ?? executor),
    };
    const inboxFactStart = Date.now();
    const recordedFacts = await runSlackBridgeOutboundAdmissionStage(
      "inbox_facts",
      () => recordInboxFactsForPersistedMessage({
        channel,
        message,
        senderType,
        senderId,
        targetVisibleMentions,
        jointProjections: opts.jointProjections,
        jointThreadProjection: opts.jointThreadProjection,
        deps: transactionDeps,
        executor,
        persistenceState: "transaction_pending",
      }),
      { preserveError: isMessageRouteDomainError },
    );
    threadAgentDeliveryCandidates = recordedFacts.threadAgentDeliveryCandidates;
    addTraceEvent("message_pipeline.inbox_notification_facts.recorded", {
      duration_ms: Date.now() - inboxFactStart,
      sender_type: senderType,
      target_type: channel.type,
      fact_count: recordedFacts.recorded,
      joint_projection_present: opts.jointProjection != null,
      joint_thread_projection_present: opts.jointThreadProjection != null,
      persistence_state: "transaction_pending",
    });
  }

  const outboundDelivery = await maybeEnqueueOrdinaryMessageExternalDelivery({
    executor,
    message,
    requestedChannelId,
    senderType,
    senderId,
    authorName: opts.authorName,
    sourceText: message.content,
    decision: opts.ordinaryExternalProjectionDecision,
  });

  await failpoints.hit(
    "server.message.newChatTransaction.afterFacts",
    {
      messageId: message.id,
      channelId: message.channelId,
      senderType,
      senderId,
      ordinaryExternalProjectionEligible: opts.ordinaryExternalProjectionDecision.eligible,
      ordinaryExternalProjectionReason: opts.ordinaryExternalProjectionDecision.eligible
        ? "eligible"
        : opts.ordinaryExternalProjectionDecision.reason,
      outboundDeliveryId: outboundDelivery?.delivery.id ?? null,
    },
    async () => undefined,
  );

  return {
    targetVisibleMentions,
    resolvedMentions,
    pendingMentionActions,
    outboundDeliveryId: outboundDelivery?.delivery.id ?? null,
    threadAgentDeliveryCandidates,
  };
}

async function createOrReplayUserRandomSend(opts: {
  channelId: string;
  authorityChannelId: string;
  requestedChannelId: string;
  senderId: string;
  authorName: string;
  content: string;
  randomId: string;
  attachmentIds?: string[];
  actionMetadata?: unknown | null;
  channel: typeof channels.$inferSelect | null | undefined;
  mentionHandles?: string[] | null;
  mentionResolution: { targets: ResolvedMentionTarget[]; resolvedFacts: ResolvedMentionFact[] } | null;
  mentionResolutionError: unknown | null;
  mentionScope: { scopeChannelId: string; scopeType: string } | null;
  mentions?: StructuredMentionInput[];
  mentionContract: "v1" | "v2";
  jointProjection: channelService.JointChannelProjection | null | undefined;
  jointProjections: channelService.JointChannelProjection[];
  jointThreadProjection: channelService.JointThreadProjection | null;
  ordinaryExternalProjectionDecision: OrdinaryMessageExternalProjectionDecision;
  deps: MessageServiceDeps;
}) {
  const db = getDb();
  return db.transaction(async (tx) => {
    await runSlackBridgeOutboundAdmissionStage(
      "conversation_lock",
      () => lockOrdinaryMessageExternalDeliveryAdmission({
        executor: tx,
        authorityChannelId: opts.authorityChannelId,
        requestedChannelId: opts.requestedChannelId,
        canonicalConversationId: opts.channelId,
        decision: opts.ordinaryExternalProjectionDecision,
      }),
      { preserveError: isMessageRouteDomainError },
    );
    const insertAttempt = () => tx
      .insert(messages)
      .values({
        channelId: opts.channelId,
        senderType: "user",
        senderId: opts.senderId,
        randomId: opts.randomId,
        content: opts.content,
        messageType: "chat",
        searchText: buildSearchText(opts.content),
        actionMetadata: opts.actionMetadata ?? null,
      })
      .onConflictDoNothing()
      .returning();
    const insertRows = await runSlackBridgeOutboundAdmissionStage(
      "source_insert",
      async () => failpoints.enabled
        ? await failpoints.hit<Array<typeof messages.$inferSelect>>(
          "server.message.userRandomSend.insert",
          {
            channelId: opts.channelId,
            senderId: opts.senderId,
            randomId: opts.randomId,
            content: opts.content,
          },
          insertAttempt,
        )
        : insertAttempt(),
      { preserveError: isMessageRouteDomainError },
    );
    const [insertedMessage] = insertRows ?? [];

    if (!insertedMessage) {
      const replayedMessage = await runSlackBridgeOutboundAdmissionStage(
        "source_replay_lookup",
        async () => {
          const [row] = await tx
            .select()
            .from(messages)
            .where(and(
              eq(messages.senderType, "user"),
              eq(messages.senderId, opts.senderId),
              eq(messages.randomId, opts.randomId),
            ))
            .limit(1);
          return row;
        },
        { preserveError: isMessageRouteDomainError },
      );
      if (!replayedMessage) {
        throw new Error("User randomId send replay lookup failed after idempotency conflict");
      }
      const expectedForwardDigest = isRecord(opts.actionMetadata)
        && opts.actionMetadata.kind === "forwarded-bundle"
        && typeof opts.actionMetadata._forwardRequestDigest === "string"
        ? opts.actionMetadata._forwardRequestDigest
        : null;
      const replayedForwardDigest = isRecord(replayedMessage.actionMetadata)
        && replayedMessage.actionMetadata.kind === "forwarded-bundle"
        && typeof replayedMessage.actionMetadata._forwardRequestDigest === "string"
        ? replayedMessage.actionMetadata._forwardRequestDigest
        : null;
      if (
        replayedMessage.channelId !== opts.channelId
        || expectedForwardDigest !== replayedForwardDigest
      ) {
        throw new UserRandomIdConflictError();
      }
      const [attachmentRows, mentionsByMessage] = await runSlackBridgeOutboundPipelineStage(
        "replay_facts_read",
        () => Promise.all([
          linkAttachmentRowsToMessageWithExecutor(
            tx,
            opts.attachmentIds ?? [],
            replayedMessage.id,
            opts.senderId,
            "replay",
          ),
          getMentionFactsForMessagesWithExecutor(tx, [replayedMessage.id]),
        ]),
        { preserveError: isMessageRouteDomainError },
      );
      return {
        message: replayedMessage,
        replayed: true,
        attachments: attachmentRows.map(toLinkedMessageAttachment),
        targetVisibleMentions: mentionsByMessage.get(replayedMessage.id) ?? [],
        resolvedMentions: [] as ResolvedMentionFact[],
        pendingMentionActions: [] as PendingMentionAction[],
        outboundDeliveryId: null,
        threadAgentDeliveryCandidates: undefined,
      };
    }

    // The idempotency conflict lookup above is authoritative for a replay.
    // Only a winning insert needs mention facts derived from current mutable
    // membership/handles, so surface a pre-resolved validation error here and
    // let this transaction roll the new message back. Replays must continue to
    // return the facts frozen by their original winning send.
    if (opts.mentionResolutionError) throw opts.mentionResolutionError;

    await failpoints.hit(
      "server.message.userRandomSend.afterInsert",
      {
        messageId: insertedMessage.id,
        channelId: opts.channelId,
        senderId: opts.senderId,
        randomId: opts.randomId,
      },
      async () => undefined,
    );

    await runSlackBridgeOutboundAdmissionStage(
      "inbox_state_reset",
      () => tx.update(userChannelInboxStates)
        .set({ doneAt: null, updatedAt: new Date() })
        .where(and(
          eq(userChannelInboxStates.channelId, opts.channelId),
          isNotNull(userChannelInboxStates.doneAt),
        )),
      { preserveError: isMessageRouteDomainError },
    );

    const linkedAttachments = (await runSlackBridgeOutboundAdmissionStage(
      "attachment_link",
      () => linkAttachmentRowsToMessageWithExecutor(
        tx,
        opts.attachmentIds ?? [],
        insertedMessage.id,
        opts.senderId,
      ),
      { preserveError: isMessageRouteDomainError },
    )).map(toLinkedMessageAttachment);
    const facts = await finalizeNewChatMessageInTransaction({
      executor: tx,
      message: insertedMessage,
      channel: opts.channel,
      requestedChannelId: opts.requestedChannelId,
      senderType: "user",
      senderId: opts.senderId,
      authorName: opts.authorName,
      mentionHandles: opts.mentionHandles,
      mentionResolution: opts.mentionResolution,
      mentionScope: opts.mentionScope,
      mentions: opts.mentions,
      mentionContract: opts.mentionContract,
      jointProjection: opts.jointProjection,
      jointProjections: opts.jointProjections,
      jointThreadProjection: opts.jointThreadProjection,
      ordinaryExternalProjectionDecision: opts.ordinaryExternalProjectionDecision,
      deps: opts.deps,
    });

    return {
      message: insertedMessage,
      replayed: false,
      attachments: linkedAttachments,
      ...facts,
    };
  });
}

async function emitFrontendSocketBestEffort(input: {
  topology: SlackBridgeOutboundPipelineTopology;
  work: () => unknown;
  onSocketEmitFailure: (fact: {
    phase: "frontend_socket_emit";
    topology: SlackBridgeOutboundPipelineTopology;
  }) => void;
}): Promise<void> {
  try {
    await runSlackBridgeOutboundPipelineStage(
      "frontend_socket_emit",
      input.work,
      { topology: input.topology },
    );
  } catch {
    // The canonical message is already durable before this helper is called.
    // Realtime delivery is therefore an acceleration path: a Socket.IO
    // failure must not turn an accepted first send or idempotent replay into
    // an HTTP failure. Consumers recover from the persisted message stream.
    // Keep the diagnostic fixed and value-free; in particular, never project
    // adapter errors or room/member data into traces or HTTP responses.
    try {
      input.onSocketEmitFailure({
        phase: "frontend_socket_emit",
        topology: input.topology,
      });
    } catch {
      // Observability must not restore the response failure this boundary
      // exists to prevent.
    }
  }
}

async function emitPersistedMessageToFrontend(
  io: SocketServer,
  opts: {
    channelId: string;
    senderType: StoredMessageSenderType;
    senderId: string;
    message: typeof messages.$inferSelect;
    enriched: typeof messages.$inferSelect & {
      senderName: string;
      senderMembershipStatus?: "active" | "left" | "removed" | null;
      attachments: {
        id: string;
        filename: string;
        mimeType: string;
        sizeBytes: number;
        width: number | null;
        height: number | null;
        thumbnailUrl: string | null;
      }[];
    };
    asTask?: boolean;
    createdTask?: TaskRow | null;
    topology: SlackBridgeOutboundPipelineTopology;
    onSocketEmitFailure: (fact: {
      phase: "frontend_socket_emit";
      topology: SlackBridgeOutboundPipelineTopology;
    }) => void;
  },
) {
  const deps = resolveMessageServiceDeps();
  const { channelId, senderType, senderId, message, enriched, asTask, createdTask, topology, onSocketEmitFailure } = opts;
  const broadcastEnriched = sanitizeForwardedBundleMetadataForBroadcast(enriched);
  const projectPayload = async <T>(work: () => T): Promise<T> => {
    if (!failpoints.enabled) return work();
    return await failpoints.hit(
      "server.message.frontend.payloadProjection",
      { channelId, messageId: message.id, topology },
      async () => work(),
    ) as T;
  };
  const emitSocketBestEffort = (work: () => unknown) => emitFrontendSocketBestEffort({
    topology,
    work,
    onSocketEmitFailure,
  });

  // For DMs and threads, ensure participants' sockets are in the channel room before broadcasting.
  // New DMs/threads have no room members yet — without this, messages would be lost.
  // Uses socketsJoin() instead of fetchSockets() because the latter requires cross-replica
  // round-trips via Redis pub/sub and can timeout in multi-replica deployments.
  const channel = await runSlackBridgeOutboundPipelineStage(
    "frontend_channel_read",
    () => deps.getChannel(channelId),
    { topology },
  );
  if (channel && channel.type !== "thread") {
    const projections = await runSlackBridgeOutboundPipelineStage(
      "frontend_projection_read",
      () => deps.getActiveJointChannelProjectionsByLocalChannel(channelId),
      { topology },
    );
    if (projections.length > 0) {
      for (const projection of projections) {
        await runSlackBridgeOutboundPipelineStage(
          "frontend_max_seq",
          () => updateMaxSeq(projection.serverId, message.seq),
          { topology },
        );
        const payload = await runSlackBridgeOutboundPipelineStage(
          "frontend_payload_projection",
          () => projectPayload(() => projectFrontendMessagePayload(withFrontendConversationContext({
            ...broadcastEnriched,
            channelId: projection.localChannelId,
          }, buildFrontendConversationContext({ channelType: "joint" })))),
          { topology },
        );
        // message-realtime-producer: message-service.persisted.joint-channel-projection
        await emitSocketBestEffort(
          () => io.to(`channel:${projection.localChannelId}`).emit("message:new", payload),
        );
      }
      return channel;
    }
  }

  if (channel?.type === "thread" && channel.parentMessageId) {
    const jointThreadProjections = await deps.getActiveJointThreadProjectionsByCanonicalThread(channelId);
    if (jointThreadProjections.length > 0) {
      const parentMessageId = channel.parentMessageId;
      const db = getDb();
      const [parentMsg] = await db
        .select({ channelId: messages.channelId, senderType: messages.senderType, senderId: messages.senderId })
        .from(messages)
        .where(eq(messages.id, channel.parentMessageId));

      const senderProjection = senderType === "user" || senderType === "agent"
        ? jointThreadProjections.find((projection) => projection.localThreadChannelId === enriched.channelId)
          ?? await deps.getJointThreadProjectionForMember(channelId, senderType, senderId)
        : null;
      if (senderProjection && (senderType === "user" || senderType === "agent")) {
        await channelService.recordThreadFollow(
          senderType,
          senderId,
          senderProjection.localThreadChannelId,
          channel.parentMessageId,
          "replied",
          { reactivateUnfollowed: true },
        );
        if (senderType === "user") {
          await awaitPostPersistReadMutation(
            channelService.markReadLatest(senderId, senderProjection.localThreadChannelId),
          );
        }
      }

      if (
        parentMsg
        && (parentMsg.senderType === "user" || parentMsg.senderType === "agent")
        && parentMsg.senderId !== senderId
      ) {
        const authorProjection = await deps.getJointThreadProjectionForMember(
          channelId,
          parentMsg.senderType,
          parentMsg.senderId,
        );
        if (authorProjection) {
          await channelService.recordThreadFollow(
            parentMsg.senderType,
            parentMsg.senderId,
            authorProjection.localThreadChannelId,
            channel.parentMessageId,
            "authored",
          );
        }
      }

      const threadInfo = await deps.getThreadInfo(channel.parentMessageId);
      for (const projection of jointThreadProjections) {
        await runSlackBridgeOutboundPipelineStage(
          "frontend_max_seq",
          () => updateMaxSeq(projection.localServerId, message.seq),
          { topology },
        );
        await deps.clearThreadDoneForAll(projection.localThreadChannelId);
        const followerIds = await getHumanThreadFollowerIds(projection.localThreadChannelId);
        const conversationContext = buildFrontendConversationContext({
          channelType: "thread",
          parentMessageId,
          parentChannel: { id: projection.localParentChannelId, type: "joint" },
        });
        const messagePayload = await runSlackBridgeOutboundPipelineStage(
          "frontend_payload_projection",
          () => projectPayload(() => projectFrontendMessagePayload(withFrontendConversationContext({
            ...broadcastEnriched,
            channelId: projection.localThreadChannelId,
          }, conversationContext))),
          { topology },
        );
        for (const userId of followerIds) {
          io.in(socketUserServerRoom(userId, projection.localServerId)).socketsJoin(`channel:${projection.localThreadChannelId}`);
          // message-realtime-producer: message-service.persisted.joint-thread-follower
          await emitSocketBestEffort(
            () => io.to(`user:${userId}`).emit("message:new", messagePayload),
          );
        }
        const latestReply = await runSlackBridgeOutboundPipelineStage(
          "frontend_payload_projection",
          () => projectPayload(() => projectThreadLatestReplyPayload(withFrontendConversationContext({
            ...broadcastEnriched,
            channelId: projection.localThreadChannelId,
          }, conversationContext))),
          { topology },
        );
        await emitSocketBestEffort(
          () => io.to(`channel:${projection.localParentChannelId}`).emit("thread:updated", {
            parentMessageId,
            ...threadInfo,
            threadChannelId: projection.localThreadChannelId,
            syncCoreReplyWindow: buildThreadRepliesSyncWindow({
              serverId: projection.localServerId,
              parentMessageId,
              parentScopeKind: "joint",
              parentScopeId: projection.localParentChannelId,
            }),
            latestReply,
          }),
        );
      }
      return channel;
    }
  }

  let parentMsgForThread: {
    channelId: string;
    senderType: StoredMessageSenderType;
    senderId: string;
  } | null = null;
  if (channel?.type === "thread" && channel.parentMessageId) {
    // Reply-path auto-follows must happen before the room join + message:new
    // broadcast below. Otherwise the parent author is not yet in the thread
    // room for the first reply and can miss the live notification until a
    // later refresh/reply creates the follow projection.
    const db = getDb();
    const [parentMsg] = await db
      .select({ channelId: messages.channelId, senderType: messages.senderType, senderId: messages.senderId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    parentMsgForThread = parentMsg ?? null;

    if (senderType === "user" || senderType === "agent") {
      await channelService.recordThreadFollow(
        senderType,
        senderId,
        channelId,
        channel.parentMessageId,
        "replied",
        { reactivateUnfollowed: true },
      );
      if (senderType === "user") {
        await awaitPostPersistReadMutation(channelService.markReadLatest(senderId, channelId));
      }
    }

    if (
      parentMsgForThread
      && (parentMsgForThread.senderType === "user" || parentMsgForThread.senderType === "agent")
      && parentMsgForThread.senderId !== senderId
    ) {
      await channelService.recordThreadFollow(
        parentMsgForThread.senderType,
        parentMsgForThread.senderId,
        channelId,
        channel.parentMessageId,
        "authored",
      );
    }

    await deps.clearThreadDoneForAll(channelId);
  }

  let threadFollowerIdsForFrontend: string[] | null = null;
  let dmHumanIdsForFrontend: string[] | null = null;
  if (channel?.type === "dm") {
    const channelRoom = `channel:${channelId}`;
    const humans = await deps.getChannelHumans(channelId);
    dmHumanIdsForFrontend = humans.map((h) => h.id);
    for (const h of humans) {
      io.in(socketUserServerRoom(h.id, channel.serverId)).socketsJoin(channelRoom);
    }
  } else if (channel?.type === "thread") {
    const channelRoom = `channel:${channelId}`;
    const followerIds = await getHumanThreadFollowerIds(channelId);
    threadFollowerIdsForFrontend = followerIds;
    for (const userId of followerIds) {
      io.in(socketUserServerRoom(userId, channel.serverId)).socketsJoin(channelRoom);
    }
  }

  if (channel) {
    await runSlackBridgeOutboundPipelineStage(
      "frontend_max_seq",
      () => updateMaxSeq(channel.serverId, message.seq),
      { topology },
    );
  }

  if (channel?.type === "thread") {
    const parentChannel = parentMsgForThread
      ? await deps.getChannel(parentMsgForThread.channelId)
      : null;
    const conversationContext = buildFrontendConversationContext({
      channelType: "thread",
      parentMessageId: channel.parentMessageId,
      parentChannel,
    });
    const payload = await runSlackBridgeOutboundPipelineStage(
      "frontend_payload_projection",
      () => projectPayload(() => projectFrontendMessagePayload(withFrontendConversationContext(broadcastEnriched, conversationContext))),
      { topology },
    );
    if (parentChannel?.type === "channel") {
      // message-realtime-producer: message-service.persisted.thread-public
      await emitSocketBestEffort(
        () => io.to(`channel:${channelId}`).emit("message:new", payload),
      );
    } else {
      for (const userId of threadFollowerIdsForFrontend ?? []) {
        // message-realtime-producer: message-service.persisted.thread-private-follower
        await emitSocketBestEffort(
          () => io.to(`user:${userId}`).emit("message:new", payload),
        );
      }
    }
  } else {
    const payload = await runSlackBridgeOutboundPipelineStage(
      "frontend_payload_projection",
      () => projectPayload(() => projectFrontendMessagePayload(withFrontendConversationContext(
        broadcastEnriched,
        buildFrontendConversationContext({ channelType: channel?.type ?? "channel" }),
      ))),
      { topology },
    );
    // message-realtime-producer: message-service.persisted.channel
    await emitSocketBestEffort(
      () => io.to(`channel:${channelId}`).emit("message:new", payload),
    );
  }

  // v1.4: the host message carries no task columns, so the task-board event is
  // driven by the canonical task row. The host message itself was already
  // broadcast above as an ordinary `message:new` — task facts and chat facts
  // travel on separate channels and are never the same payload.
  if (asTask && createdTask) {
    const taskEnriched = await enrichSingleLegacyTask(createdTask);
    await emitSocketBestEffort(() => emitTaskCreated(io, {
      channelId,
      channelType: channel.type,
      serverId: channel.serverId,
    }, {
      channelId,
      tasks: [taskEnriched],
    }));
  }

  if (channel?.type === "dm") {
    const payload = { channelId };
    await emitSocketBestEffort(() => io.to(`channel:${channelId}`).emit("dm:new", payload));
    for (const userId of dmHumanIdsForFrontend ?? []) {
      await emitSocketBestEffort(() => io.to(`user:${userId}`).emit("dm:new", payload));
    }
  }

  if (channel?.type === "thread" && channel.parentMessageId) {
    if (parentMsgForThread) {
      const threadInfo = await deps.getThreadInfo(channel.parentMessageId);
      const parentChannel = await deps.getChannel(parentMsgForThread.channelId);
      const payload = {
        parentMessageId: channel.parentMessageId,
        threadChannelId: channelId,
        ...threadInfo,
        syncCoreReplyWindow: buildThreadRepliesSyncWindow({
          serverId: channel.serverId,
          parentMessageId: channel.parentMessageId,
          parentScopeKind: parentChannel?.type ?? "channel",
          parentScopeId: parentMsgForThread.channelId,
        }),
        latestReply: projectThreadLatestReplyPayload(withFrontendConversationContext(
          broadcastEnriched,
          buildFrontendConversationContext({
            channelType: "thread",
            parentMessageId: channel.parentMessageId,
            parentChannel,
          }),
        )),
      };
      if (parentChannel?.type === "private" || parentChannel?.type === "dm") {
        const parentHumans = await deps.getChannelHumans(parentMsgForThread.channelId);
        for (const human of parentHumans) {
          await emitSocketBestEffort(() => io.to(`user:${human.id}`).emit("thread:updated", payload));
        }
      } else {
        await emitSocketBestEffort(
          () => io.to(`channel:${parentMsgForThread.channelId}`).emit("thread:updated", payload),
        );
      }
    }
  }

  return channel;
}

/**
 * Collapse whitespace and clip a title/content snippet so it fits inside a
 * single-line system message body. Without this, multi-paragraph task titles
 * (common when a long message is converted to a task) blow up every
 * subsequent claim/status notification into a wall of text.
 */
const SYSTEM_MESSAGE_SUMMARY_MAX = 80;

export function summarizeForSystemMessage(text: string, maxLen: number = SYSTEM_MESSAGE_SUMMARY_MAX): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= maxLen) return single;
  return single.slice(0, maxLen - 1).trimEnd() + "…";
}

/**
 * Create and broadcast a **system message** to a channel/thread/DM.
 *
 * ## What a system message is
 *
 * A persisted chat-stream event with `senderType="system"` and
 * `messageType="system"`. It looks like a regular message in `messages` but is
 * authored by Slock itself, not by a human or agent. The role of a system
 * message is to **notify both humans and agents in the surface that something
 * noteworthy happened in the overall system** — a change everyone there
 * should be aware of (a new task arrived, the channel was archived, a member
 * was added). It carries a `seq` number, contributes to unread counts, shows
 * up in chat history, is rendered in the web chat list as a `message:new`
 * socket event, and is push-delivered to in-channel agents via
 * `agentOrchestrator.deliverMessage`. The event has to matter to **both**
 * audiences; if it only matters to one (or to a single person), it should not
 * be a system message.
 *
 * ## Delivery is the same as a normal message
 *
 * Once written, a system message rides the **same delivery path** as any
 * `chat` message: the same `io.to(channelRoom).emit("message:new", …)` socket
 * event fans out to web clients, and the same
 * `agentOrchestrator.deliverMessage(agentId, AgentMessage)` pushes it to each
 * agent's stdin / inbox. Agents don't see a separate "system delivery" channel —
 * they receive an `AgentMessage` whose `sender_type === "system"` and act on
 * it the same way they'd act on a chat message addressed to them. The only
 * thing this function does differently from `broadcastAndDeliver` is the
 * sender identity it stamps on the persisted row; the wake/notification
 * mechanics are identical.
 *
 * `content` is the only persisted/frontend-visible text. `additionalAgentContent`
 * is appended only to immediate agent delivery for machine-facing context that
 * humans should not see (e.g. CLI hint lines).
 *
 * ## Persistent channel system messages
 *
 * `broadcastSystemMessage()` writes a `messages` row and appears in the
 * channel/thread/DM history. It is distinct from `deliverSystemNoticeToAgent()`,
 * which uses the same `system` sender identity for an agent-only wake but does
 * not create chat history.
 *
 * ## What system messages are for
 *
 * Announcing **shared-state changes** that every member of the surface should
 * (a) see in the chat timeline and (b) potentially act on right now. The
 * canonical purposes are:
 *
 *   - Surface structural changes — channel archived/unarchived, members
 *     joined/removed, channel renamed. Everyone in the channel needs to know
 *     because it changes whether they can interact with the channel at all.
 *
 *   - **New** shared resources entering the surface — e.g. "📋 N new tasks
 *     created". The new resource is broadcast work; surface members can
 *     decide whether to claim/respond.
 *
 *   - Targeted onboarding instructions — pass `targetAgentIds` to wake only
 *     the specific agent(s) involved (the chat record is still visible to
 *     the surface, but only the targeted agents are pushed).
 *
 * ## What system messages are NOT for
 *
 * Anything that is **not** "every surface member needs to know AND maybe
 * act now" should NOT be a system message. In particular:
 *
 *   - **Personal events on shared surfaces.** Prefer an intrinsic owner
 *     delivery in the app-owned private conversation; an anchor is a
 *     reference, never a shared landing surface.
 *
 *   - **Lifecycle churn.** Repeated state transitions on the same object
 *     (task `todo → in_progress → in_review → done`, agent
 *     `online ↔ working ↔ idle`). Each transition is mostly meaningful to
 *     the actor, mostly noise to everyone else. Render the current state on
 *     the object's UI (task card, agent dot) and keep the historical trail
 *     in a per-object event log (e.g. `reminder_events`,
 *     `agent_activity_log`, future `task_events`).
 *
 *   - **Small-audience events.** Some changes only matter to a defined
 *     subset, not the whole surface. stdrc's example
 *     (`#proj-task` msg=b9b41129): task transitions only matter to the
 *     task's assignee + creator + reviewer. Don't ship those to the whole
 *     channel — wake just the involved parties (targeted delivery to the
 *     subset, or surface the change on the object's own UI/inbox).
 *
 *   - **Audit-only history.** "X did Y at time T" with no actionable handoff
 *     belongs in an event log surfaced via a dedicated detail panel, not in
 *     the chat timeline.
 *
 * ## Decision rule
 *
 * Use stdrc's framing: a system message exists to "notify them that something
 * noteworthy changed in the overall system." Run two checks:
 *
 *   1. Is this **noteworthy enough** that a typical surface member would
 *      think "good thing I know that"? (Channel archived = yes. Task moved
 *      from in_progress to in_review = no.)
 *   2. Is it meaningful to **both humans and agents** in this surface?
 *      (New task arriving = yes. The actor's own private alarm firing = no,
 *      that's an audience of one.)
 *
 *   If both yes → system message.
 *   If "only the actor / a specific person cares" → owner-targeted
 *      `deliverMessage` (no chat record), an owner-only DM row, or a per-object
 *      event log.
 *   If "everyone might want to look back at this someday but no one needs to
 *      act now" → per-object event log only.
 *
 * Convergence thread: `#proj-task` 2026-05-03 + 2026-05-06 (stdrc / xxchan /
 * Cody / Noel / Eric / XX). stdrc's directives (msg=62bd08b7 + msg=ef870d97 +
 * msg=c580faed): system messages are "noteworthy system-level changes to
 * notify both humans and agents about" — task status transitions and reminder
 * fire/schedule explicitly do NOT clear that bar; channel/membership/onboarding
 * stay; "task created" stays as a broadcast of new shared work.
 */
export async function broadcastSystemMessage(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  channelId: string,
  content: string,
  opts: {
    inboxFactPolicy: SystemMessageInboxFactPolicy;
    /**
     * Real actor who caused this system message. When their own inbox row is
     * built it is born-read (unreadEligible=false) — a self-caused system
     * message must not show as unread to its own actor. Per-item only; does
     * not touch read cursors. Omit for producers that must stay unread for
     * everyone (e.g. onboarding, where the joiner is the intended reader).
     */
    causalActor?: CausalActor;
    /**
     * Server-resolved personal-attention targets represented by explicit
     * @handles in `content`. Unlike ordinary system broadcasts, these targets
     * get durable mention facts and may pierce their own channel mute. Other
     * muted members remain suppressed. Callers must resolve visibility and
     * authorization before invoking this helper.
     */
    personalAttentionTargets?: ResolvedMentionFact[];
    targetAgentIds?: string[];
    additionalAgentContent?: string;
    /** Durable message + mention + inbox facts already committed by caller. */
    persistedMessage?: typeof messages.$inferSelect;
    /** Delivery options for an intrinsic persisted system message. */
    agentDeliveryOptions?: DeliverMessageOptions;
    /** Await typed queue receipts and fail if any targeted agent drops delivery. */
    awaitAgentDelivery?: boolean;
    /** Intrinsic targeted delivery bypasses ordinary channel/thread mute suppression. */
    bypassAgentMute?: boolean;
    /**
     * A logical task recipient may belong to both servers of one joint. Its
     * personal receipt is global, so task summary producers collapse the two
     * projection candidates to one fact while realtime still reaches both.
     */
    dedupeLogicalReceiverAcrossJointProjections?: boolean;
  },
) {
  // Structural coupling: a producer the registry declares "born-read" MUST pass
  // a causalActor when it actually records facts, otherwise the actor's own row
  // is silently left unread (declared ≠ actual). Fail loudly at the call site
  // instead of shipping a silent regression. Scoped to `mode:"record"`: a
  // skip-mode call records no facts, so there is no actor row to suppress and a
  // causalActor would be meaningless. Test-only producers (`test.*`) are not in
  // the registry and are intentionally exempt.
  const bornReadClassification =
    SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION[
      opts.inboxFactPolicy.producer as keyof typeof SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION
    ];
  if (
    bornReadClassification === "born-read"
    && opts.inboxFactPolicy.mode === "record"
    && !opts.causalActor
  ) {
    throw new Error(
      `born-read producer '${opts.inboxFactPolicy.producer}' must pass causalActor `
        + `(the real actor whose action caused this system message). Without it the `
        + `actor's own inbox row is incorrectly left unread.`,
    );
  }

  const deps = resolveMessageServiceDeps();
  if (
    opts.persistedMessage
    && (
      opts.persistedMessage.channelId !== channelId
      || opts.persistedMessage.messageType !== "system"
      || opts.persistedMessage.senderId !== "system"
      || opts.persistedMessage.content !== content
    )
  ) {
    throw new Error("Persisted system message does not match broadcast request");
  }
  const messageWasPersisted = opts.persistedMessage !== undefined;
  const message = opts.persistedMessage
    ?? await deps.createMessage(channelId, "user", "system", content, "system");
  const personalAttentionTargets = opts.personalAttentionTargets ?? [];
  const enriched = {
    ...message,
    senderName: "System",
    ...(personalAttentionTargets.length > 0 && { mentions: personalAttentionTargets }),
  };

  const channel = await deps.getChannel(channelId);
  if (!messageWasPersisted && channel && personalAttentionTargets.length > 0) {
    await deps.insertMentionRows(personalAttentionTargets.map((target) => ({
      messageId: message.id,
      messageSeq: message.seq,
      serverId: channel.serverId,
      channelId,
      targetType: target.type,
      targetId: target.id,
      handleAtSendTime: target.name,
      source: "send_path" as const,
      confidence: "exact" as const,
      notifiableAtSend: true,
    })));
  }
  const channelRoom = `channel:${channelId}`;
  let threadFollowerIdsForFrontend: string[] | null = null;
  let dmHumanIdsForFrontend: string[] | null = null;
  const traceAttrs = traceChannelAudienceAttrs(channel);

  addTraceEvent("message_pipeline.system_message.persisted", {
    ...traceAttrs,
    channel_present: Boolean(channel),
  });

  if (!messageWasPersisted && channel && opts.inboxFactPolicy.mode === "record") {
    const inboxFactStart = Date.now();
    const jointProjections = channel.type === "thread"
      ? []
      : await deps.getActiveJointChannelProjectionsByLocalChannel(channelId);
    const jointThreadProjections = channel.type === "thread"
      ? await deps.getActiveJointThreadProjectionsByCanonicalThread(channelId)
      : [];
    const { recorded: factCount, bornReadReceiverCount } = await recordInboxFactsForPersistedMessage({
      channel,
      message,
      senderType: "system",
      senderId: "system",
      causalActor: opts.causalActor,
      targetVisibleMentions: personalAttentionTargets,
      jointProjections,
      jointThreadProjection: jointThreadProjections[0] ?? null,
      deps,
      dedupeLogicalReceiverAcrossJointProjections:
        opts.dedupeLogicalReceiverAcrossJointProjections,
    });
    addTraceEvent("message_pipeline.system_inbox_notification_facts.recorded", {
      ...traceAttrs,
      duration_ms: Date.now() - inboxFactStart,
      fact_count: factCount,
      // born-read observability (stdrc 7/11): per-producer count of self-caused
      // receiver rows suppressed to born-read. Post-release confirmation that the
      // gate fires in prod — born-read producers show >=1, self-unread noise -> 0.
      born_read_receiver_count: bornReadReceiverCount,
      producer: opts.inboxFactPolicy.producer,
      joint_projection_present: jointProjections.length > 0,
      joint_thread_projection_present: jointThreadProjections.length > 0,
    });
  } else {
    addTraceEvent("message_pipeline.system_inbox_notification_facts.skipped", {
      ...traceAttrs,
      policy_mode: opts.inboxFactPolicy.mode,
      policy_producer: opts.inboxFactPolicy.producer,
      policy_reason: opts.inboxFactPolicy.reason,
      channel_present: Boolean(channel),
      ...(messageWasPersisted && { skip_reason: "durable_facts_committed_by_caller" }),
    });
  }

  // New DMs/threads may have no sockets in room yet. Join participants first so
  // system messages (e.g. onboarding) are visible without requiring manual DM open.
  if (channel?.type === "dm") {
    const humans = await deps.getChannelHumans(channelId);
    dmHumanIdsForFrontend = humans.map((h) => h.id);
    for (const h of humans) {
      io.in(socketUserServerRoom(h.id, channel.serverId)).socketsJoin(channelRoom);
    }
  } else if (channel?.type === "thread") {
    const followerIds = await getHumanThreadFollowerIds(channelId);
    threadFollowerIdsForFrontend = followerIds;
    for (const userId of followerIds) {
      io.in(socketUserServerRoom(userId, channel.serverId)).socketsJoin(channelRoom);
    }
  }

  // Broadcast to frontend
  if (channel?.type === "thread") {
    const [parentMsg] = channel.parentMessageId
      ? await getDb()
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, channel.parentMessageId))
      : [];
    const parentChannel = parentMsg
      ? await deps.getChannel(parentMsg.channelId)
      : null;
    const payload = projectFrontendMessagePayload(withFrontendConversationContext(enriched, buildFrontendConversationContext({
      channelType: "thread",
      parentMessageId: channel.parentMessageId,
      parentChannel,
    })));
    if (parentChannel?.type === "channel") {
      // message-realtime-producer: message-service.system.thread-public
      io.to(channelRoom).emit("message:new", payload);
    } else {
      for (const userId of threadFollowerIdsForFrontend ?? []) {
        // message-realtime-producer: message-service.system.thread-private-follower
        io.to(`user:${userId}`).emit("message:new", payload);
      }
    }
  } else {
    // message-realtime-producer: message-service.system.channel
    io.to(channelRoom).emit(
      "message:new",
      projectFrontendMessagePayload(withFrontendConversationContext(enriched, buildFrontendConversationContext({ channelType: channel?.type ?? "channel" }))),
    );
  }

  if (channel?.type === "dm") {
    const payload = { channelId };
    io.to(channelRoom).emit("dm:new", payload);
    for (const userId of dmHumanIdsForFrontend ?? []) {
      io.to(`user:${userId}`).emit("dm:new", payload);
    }
  }
  addTraceEvent("message_pipeline.system_frontend_emitted", {
    ...traceAttrs,
    human_audience_count: channel
      ? channel.type === "thread"
        ? (threadFollowerIdsForFrontend ?? []).length
        : (await deps.getChannelHumans(channelId)).length
      : 0,
  });

  // Deliver to agents in channel
  if (!channel) return enriched;

  // Track max seq for heartbeat (P2)
  updateMaxSeq(channel.serverId, message.seq);

  const agentsInChannel = channel.type === "thread"
    ? await getThreadAgentFollowers(channelId)
    : await deps.getChannelAgents(channelId);
  const targetAgentIdSet = opts.targetAgentIds ? new Set(opts.targetAgentIds) : null;
  const unfilteredTargetedAgents = targetAgentIdSet
    ? agentsInChannel.filter((agent) => targetAgentIdSet.has(agent.id))
    : agentsInChannel;
  const piercedAgentIds = new Set(
    personalAttentionTargets
      .filter((target) => target.type === "agent")
      .map((target) => target.id),
  );
  const mutedAgentDeliveryIds = opts.bypassAgentMute
    ? new Set<string>()
    : await getMutedAgentDeliveryIdsForPersistedMessage(
      deps,
      channel,
      message,
      unfilteredTargetedAgents.map((agent) => agent.id),
      piercedAgentIds,
    );
  const targetedAgents = unfilteredTargetedAgents.filter((agent) => !mutedAgentDeliveryIds.has(agent.id));
  addTraceEvent("message_pipeline.system_agent_delivery.scheduled", {
    ...traceAttrs,
    agent_audience_count: agentsInChannel.length,
    agent_muted_count: mutedAgentDeliveryIds.size,
    agent_delivery_count: targetedAgents.length,
    target_filter_present: Boolean(targetAgentIdSet),
  });
  // Fire-and-forget: deliver in parallel, don't block the response
  const agentDeliveryContent = opts.additionalAgentContent
    ? `${content}\n${opts.additionalAgentContent}`
    : content;
  const renderedContent = await agentPermalinkRenderService.renderAgentReadablePermalinks(
    agentDeliveryContent,
    channel.serverId,
  );
  const parentFields = channel.type === "thread"
    ? await resolveThreadParentFields(channel.id)
    : {};
  const deliverToAgent = (agent: typeof targetedAgents[number]) =>
    agentOrchestrator.deliverMessage(agent.id, {
      channel_id: channelId,
      channel_name: channel.name,
      channel_type: toAgentVisibleChannelType(channel.type),
      ...parentFields,
      sender_id: "system",
      sender_name: "system",
      sender_type: "system",
      content: renderedContent,
      timestamp: message.createdAt.toISOString(),
      seq: message.seq,
      message_id: message.id,
      ...(piercedAgentIds.has(agent.id) && { mentioned: true }),
    }, opts.agentDeliveryOptions);
  if (opts.awaitAgentDelivery) {
    if (targetedAgents.length === 0) {
      throw new Error("SYSTEM_MESSAGE_AGENT_DELIVERY_TARGET_MISSING");
    }
    const results = await Promise.all(targetedAgents.map(deliverToAgent));
    const dropped = results.find((result) => result.status !== "queued");
    if (dropped) {
      throw new Error(`SYSTEM_MESSAGE_AGENT_DELIVERY_DROPPED:${dropped.reason}`);
    }
  } else {
    const sysDeliveries = targetedAgents.map((agent) => deliverToAgent(agent).catch((err) => {
      console.error(`[MessageService] Failed to deliver system message to agent ${agent.id}:`, serializeErrorForLog(err));
    }));
    Promise.all(sysDeliveries).catch(() => {});
  }

  return enriched;
}
/**
 * Joint-aware variant of `broadcastSystemMessage`.
 *
 * `broadcastSystemMessage` persists and fans out to exactly the channel id it
 * is given. For a joint channel (or a joint thread projection) that is wrong:
 * the durable row must live in CANONICAL storage (one row of authority, so
 * canonical-backed history survives reload), while realtime, inbox facts, and
 * agent delivery must be projected to every active local surface (otherwise
 * peer servers never see the summary).
 *
 * This helper mirrors the canonicalization `broadcastAndDeliver` already does
 * for chat messages:
 *   1. delegate persistence + inbox facts to `broadcastSystemMessage` on the
 *      CANONICAL channel/thread id — one durable row of authority, and its
 *      inbox-fact path already expands joint projections into per-local-surface
 *      facts (its own realtime emit/delivery target the member-less canonical
 *      channel, so they reach nobody and are harmless),
 *   2. reuse the ordinary persisted-message projector for realtime and the
 *      ordinary persisted-message agent delivery for each local surface.
 *
 * Non-joint channels/threads delegate to `broadcastSystemMessage` unchanged.
 * Directed attention is carried through the same projection fanout: every
 * local surface sees the shared receipt, while the resolved target alone gets
 * `mentioned:true` and mute piercing on its own reachable projection.
 */
export async function broadcastSystemMessageToLocalSurfaces(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  channelId: string,
  content: string,
  opts: {
    inboxFactPolicy: SystemMessageInboxFactPolicy;
    causalActor?: CausalActor;
    /** Exact directed-attention targets already authorized by the caller. */
    personalAttentionTargets?: ResolvedMentionFact[];
    /** Durable message + inbox facts already committed atomically by caller. */
    persistedMessage?: typeof messages.$inferSelect;
  },
) {
  const deps = resolveMessageServiceDeps();
  const channel = await deps.getChannel(channelId);
  const jointThreadProjection = channel?.type === "thread"
    ? await channelService.getJointThreadProjectionByLocalThread(channelId)
    : null;
  const jointChannelProjections = channel && channel.type !== "thread"
    ? await deps.getActiveJointChannelProjectionsByLocalChannel(channelId)
    : [];
  const storageChannelId = jointThreadProjection?.canonicalThreadChannelId
    ?? jointChannelProjections[0]?.canonicalChannelId
    ?? null;

  if (!channel || !storageChannelId) {
    return broadcastSystemMessage(io, agentOrchestrator, channelId, content, opts);
  }

  // Persist + record inbox facts against the canonical id. The returned
  // message IS the single canonical durable row.
  const enriched = await broadcastSystemMessage(io, agentOrchestrator, storageChannelId, content, {
    ...opts,
    dedupeLogicalReceiverAcrossJointProjections: true,
  });
  const message = enriched;

  if (jointThreadProjection) {
    const projections = await deps.getActiveJointThreadProjectionsByCanonicalThread(storageChannelId);
    await Promise.all(projections.map(async (projection) => {
      updateMaxSeq(projection.localServerId, message.seq);
      const followerIds = await getHumanThreadFollowerIds(projection.localThreadChannelId);
      const payload = projectFrontendMessagePayload(withFrontendConversationContext({
        ...enriched,
        channelId: projection.localThreadChannelId,
      }, buildFrontendConversationContext({
        channelType: "thread",
        parentMessageId: projection.canonicalParentMessageId,
        parentChannel: { id: projection.localParentChannelId, type: "joint" },
      })));
      for (const userId of followerIds) {
        io.in(socketUserServerRoom(userId, projection.localServerId)).socketsJoin(
          `channel:${projection.localThreadChannelId}`,
        );
        // message-realtime-producer: message-service.system.joint-thread-follower
        io.to(`user:${userId}`).emit("message:new", payload);
      }
      await deliverMessagesToAgents(
        agentOrchestrator,
        [{ ...message, channelId: projection.localThreadChannelId }],
        "System",
        { personalAttentionTargets: opts.personalAttentionTargets },
      );
    }));
    return enriched;
  }

  await emitPersistedMessageToFrontend(io, {
    channelId: storageChannelId,
    senderType: "user",
    senderId: "system",
    message,
    enriched: {
      ...enriched,
      senderMembershipStatus: null,
      attachments: [],
    },
    topology: "joint_channel",
    onSocketEmitFailure: ({ phase, topology }) => {
      addTraceEvent("message_pipeline.frontend_socket_emit.degraded", {
        phase,
        topology,
        persistence_state: "durable",
        failure_policy: "continue_from_persisted_state",
        sender_type: "system",
        target_type: "joint",
      });
    },
  });
  await Promise.all(jointChannelProjections.map((projection) =>
    deliverMessagesToAgents(
      agentOrchestrator,
      [{ ...message, channelId: projection.localChannelId }],
      "System",
      { personalAttentionTargets: opts.personalAttentionTargets },
    )
  ));

  return enriched;
}

/**
 * Deliver a non-persistent agent notice with `system` sender identity.
 *
 * This helper intentionally does NOT write a `messages` row and therefore does
 * not create channel/thread/DM history. Use it for owner-targeted wakes whose
 * durable audit lives elsewhere. Use
 * `broadcastSystemMessage()` when the change should be visible in chat history
 * as a shared channel fact.
 */
export async function deliverSystemNoticeToAgent(
  agentOrchestrator: AgentOrchestrator,
  agentId: string,
  notice: {
    serverId: string;
    channel_id: string;
    channel_name: string;
    channel_type: AgentVisibleChannelType;
    content: string;
    timestamp?: string;
  },
  options: DeliverMessageOptions = { transient: true, intrinsic: true },
) {
  // Default options mark this delivery as intrinsic. Current callers are
  // author-owned events about the agent's own state, NOT channel content from
  // another principal.
  // They must bypass the `inbox:receive` scope gate so a user who has revoked
  // chat reception can still observe their own scheduled alarms and the
  // outcomes of action cards they prepared. If a future caller posts a
  // notice that should be gated, it can pass `{ intrinsic: false }`
  // explicitly — but think hard before doing that, because the alternative
  // is usually `broadcastSystemMessage` (which produces a real `messages`
  // row + chat history), not a transient notice.
  const effectiveOptions: DeliverMessageOptions = {
    transient: options.transient ?? true,
    intrinsic: options.intrinsic ?? true,
  };
  const renderedContent = await agentPermalinkRenderService.renderAgentReadablePermalinks(
    notice.content,
    notice.serverId,
  );
  const parentFields = notice.channel_type === "thread"
    ? await resolveThreadParentFields(notice.channel_id)
    : {};
  await agentOrchestrator.deliverMessage(agentId, {
    channel_id: notice.channel_id,
    channel_name: notice.channel_name,
    channel_type: notice.channel_type,
    ...parentFields,
    sender_id: "system",
    sender_name: "system",
    sender_type: "system",
    content: renderedContent,
    timestamp: notice.timestamp ?? new Date().toISOString(),
  }, effectiveOptions);
}

/**
 * Deliver an already-persisted message to agents in its channel.
 * Used for task messages that are inserted outside of broadcastAndDeliver.
 */
export async function deliverMessageToAgents(
  agentOrchestrator: AgentOrchestrator,
  message: typeof messages.$inferSelect,
  senderName: string,
) {
  await deliverMessagesToAgents(agentOrchestrator, [message], senderName);
}

/**
 * Deliver one persisted-message batch to channel agents.
 *
 * Recipients fan out in parallel, but each recipient's messages are delivered
 * in order. This preserves every durable message/inbox row while preventing a
 * bulk create from racing multiple inactive-agent wake attempts for the same
 * recipient.
 */
export async function deliverMessagesToAgents(
  agentOrchestrator: AgentOrchestrator,
  rawMessageBatch: readonly (typeof messages.$inferSelect)[],
  senderName: string,
  opts: { personalAttentionTargets?: readonly ResolvedMentionFact[] } = {},
) {
  if (rawMessageBatch.length === 0) return;

  // v1.4: a task's host message carries no task columns of its own, so project
  // the canonical facts on before anything reads them. This runs before the
  // assignee mute-pierce below on purpose — an assigned agent must still pierce
  // its own mute for a task addressed to it.
  const taskProjectedBatch = await withProjectedTaskFacts([...rawMessageBatch]);
  const externalAuthors = await loadExternalMessageAuthors(taskProjectedBatch.map((message) => message.id));
  const messageBatch = taskProjectedBatch.map((message) => ({
    ...message,
    externalAuthor: externalAuthors.get(message.id) ?? null,
  }));
  if (messageBatch.some((message) => message.senderType === "external_projection" && !message.externalAuthor)) {
    throw new Error("External projection message is missing immutable author fact");
  }

  const deps = resolveMessageServiceDeps();
  const firstMessage = messageBatch[0]!;
  if (messageBatch.some((message) => (
    message.channelId !== firstMessage.channelId
    || message.senderType !== firstMessage.senderType
    || message.senderId !== firstMessage.senderId
  ))) {
    throw new Error("Agent message batches must share a channel and sender");
  }

  const channel = await deps.getChannel(firstMessage.channelId);
  if (!channel) return;
  const parentFields = channel.type === "thread"
    ? await resolveThreadParentFields(channel.id)
    : {};

  const agentsInChannel = await deps.getChannelAgents(firstMessage.channelId);
  const candidateAgents = agentsInChannel.filter((agent) => !(
    firstMessage.senderType === "agent" && agent.id === firstMessage.senderId
  ));
  const candidateAgentIds = candidateAgents.map((agent) => agent.id);
  const renderedContents = await Promise.all(messageBatch.map((message) => (
    deps.renderAgentReadablePermalinks(message.content, channel.serverId)
  )));
  const isPersistedSystemMessage = firstMessage.messageType === "system"
    && firstMessage.senderType === "user"
    && firstMessage.senderId === "system";
  const isExternalProjectionMessage = firstMessage.senderType === "external_projection";
  const effectiveSenderName = firstMessage.externalAuthor?.displayName ?? senderName;
  let senderIdentity: { uniqueName: string; description: string | null };
  if (firstMessage.senderType === "external_projection") {
    senderIdentity = { uniqueName: effectiveSenderName, description: null };
  } else if (isPersistedSystemMessage) {
    senderIdentity = { uniqueName: "system", description: null };
  } else {
    senderIdentity = await deps.getSenderIdentity(
      firstMessage.senderType,
      firstMessage.senderId,
      effectiveSenderName,
    );
  }
  const deliveryOptions = isPersistedSystemMessage || firstMessage.senderType === "external_projection"
    ? {}
    : await getAgentDeliveryOptionsForSender(
      deps,
      channel.serverId,
      firstMessage.senderType,
      firstMessage.senderId,
    );
  const payloadsByAgent = new Map<string, AgentMessage[]>();

  for (const [index, message] of messageBatch.entries()) {
    const piercedAgentIds = new Set(
      (opts.personalAttentionTargets ?? [])
        .filter((target) => target.type === "agent")
        .map((target) => target.id),
    );
    if (message.senderType !== "external_projection" && message.taskAssigneeType === "agent" && message.taskAssigneeId) {
      piercedAgentIds.add(message.taskAssigneeId);
    }
    const mutedAgentDeliveryIds = await getMutedAgentDeliveryIdsForPersistedMessage(
      deps,
      channel,
      message,
      candidateAgentIds,
      piercedAgentIds,
    );
    for (const agent of candidateAgents) {
      if (mutedAgentDeliveryIds.has(agent.id)) continue;
      const payloads = payloadsByAgent.get(agent.id) ?? [];
      payloads.push({
        channel_id: message.channelId,
        channel_name: channel.name,
        channel_type: channel.type === "thread" ? "thread" : channel.type === "dm" ? "dm" : channel.type === "private" ? "private" : "channel",
        ...parentFields,
        sender_id: message.senderId,
        sender_name: message.externalAuthor?.displayName ?? senderIdentity.uniqueName,
        sender_description: senderIdentity.description,
        sender_type: toAgentVisibleSenderType(message.senderType, message.messageType),
        ...toAgentVisibleExternalMessage(message),
        ...(message.senderType === "external_projection" && { mentioned: false }),
        ...(message.senderType !== "external_projection" && piercedAgentIds.has(agent.id) && { mentioned: true }),
        content: renderAgentVisibleMessageContent(message, renderedContents[index]!),
        timestamp: message.createdAt.toISOString(),
        seq: message.seq,
        message_id: message.id,
        ...(message.senderType !== "external_projection" && message.taskStatus != null && {
          task_status: message.taskStatus as "todo" | "in_progress" | "in_review" | "done" | "closed",
          task_number: message.taskNumber,
          task_assignee_type: toAgentVisibleTaskAssigneeType(message.taskAssigneeType as InternalActorType | null),
          task_assignee_id: message.taskAssigneeId,
          task_assignee_name: getAgentVisibleTaskAssigneeName(message),
        }),
        ...(message.taskCurrentProjection && {
          task_current_projection: toAgentTaskCurrentProjection(message.taskCurrentProjection),
        }),
      });
      payloadsByAgent.set(agent.id, payloads);
    }
  }

  await Promise.all([...payloadsByAgent].map(async ([agentId, payloads]) => {
    for (const payload of payloads) {
      // THE BOOKKEEPING WRITE IS OUTSIDE THE DELIVERY TRY. This PR originally put it inside,
      // ahead of deliverMessage, so an occurrence-write throw jumped straight to the catch and
      // the message was NEVER DELIVERED — silently, because that catch swallows, and misreported,
      // because its text says "Failed to deliver task message" when the fault was bookkeeping.
      // Found by @Kabi; verified against base 0e9fb400, where this try contained only
      // deliverMessage and the log text was therefore accurate.
      // This is the THIRD mirror of the policy the file states twice in its own catches — "a
      // record-keeping write must never suppress the thing it records, so we still deliver" — and
      // it was the worst of the three: @Hipp's site propagated to the caller, this one vanished.
      let mentionDeliveryOccurrenceId: string | undefined;
      if (payload.message_id) {
        try {
          mentionDeliveryOccurrenceId = await ensureAgentMentionDeliveryOccurrence(
            payload.message_id,
            agentId,
            payload,
          );
        } catch (err) {
          // Same typed trace as the other two sites, so an accepted degradation stays observable.
          // Its absence here was the tell: the mechanism this file uses to keep accepted
          // degradations visible was missing at the one place the degradation was NOT accepted.
          addTraceEvent("message_pipeline.mention_occurrence.persist_degraded", {
            message_id: payload.message_id,
            intended_occurrence_count: 1,
            delivered_without_occurrence: true,
            recoverable: false,
          });
          console.error(
            `[MessageService] mention delivery occurrence unavailable for task message ${payload.message_id} agent ${agentId}; delivering without it (this mention is not recoverable):`,
            err,
          );
        }
      }
      try {
        await agentOrchestrator.deliverMessage(agentId, payload, {
          ...deliveryOptions,
          ...(mentionDeliveryOccurrenceId && { mentionDeliveryOccurrenceId }),
        });
      } catch (err) {
        // Now once again reachable ONLY by a delivery failure, so the text is true again.
        console.error(`[MessageService] Failed to deliver task message to agent ${agentId}:`, serializeErrorForLog(err));
      }
    }
  }));
}

async function resolveThreadParentFields(
  threadChannelId: string,
): Promise<Pick<AgentMessage, "parent_channel_name" | "parent_channel_id" | "parent_channel_type">> {
  const threadChannel = await channelService.getChannel(threadChannelId);
  if (threadChannel?.type !== "thread" || !threadChannel.parentMessageId) return {};
  const db = getDb();
  const [parentMessage] = await db
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, threadChannel.parentMessageId))
    .limit(1);
  const parentChannel = parentMessage ? await channelService.getChannel(parentMessage.channelId) : null;
  if (!parentChannel) return {};
  const parentChannelType = toAgentVisibleChannelType(parentChannel.type);
  return {
    parent_channel_name: parentChannel.name,
    parent_channel_id: parentChannel.id,
    parent_channel_type: parentChannelType === "thread" ? "channel" : parentChannelType,
  };
}

/**
 * Push an already-persisted message to one resolved agent target.
 * Mention actions use the typed result to decide whether their durable target
 * visibility may be recorded; it must not fan out to every current channel
 * member. `queued` is a replayable server-side handoff, not model-seen or a
 * daemon acknowledgement.
 */
export async function deliverMessageToAgent(
  agentOrchestrator: AgentOrchestrator,
  messageId: string,
  agentId: string,
  options: {
    requireQueueReceipt?: boolean;
    nonMemberMention?: boolean;
    reconcileNonMemberMention?: boolean;
  } = {},
): Promise<AgentMessageDeliveryResult | {
  status: "dropped";
  reason: "message_unavailable" | "channel_unavailable";
}> {
  const deps = resolveMessageServiceDeps();
  const db = getDb();
  const [rawMessage] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!rawMessage) return { status: "dropped", reason: "message_unavailable" };
  // v1.4: task facts live in `tasks`; project them so this delivery carries the
  // same `task_*` payload a pre-v1.4 message-task did.
  const [taskProjectedMessage] = await withProjectedTaskFacts([rawMessage], db);
  const externalAuthors = await loadExternalMessageAuthors([taskProjectedMessage.id], db);
  const message = {
    ...taskProjectedMessage,
    externalAuthor: externalAuthors.get(taskProjectedMessage.id) ?? null,
  };
  if (message.senderType === "external_projection" && !message.externalAuthor) {
    return { status: "dropped", reason: "message_unavailable" };
  }

  const channel = await deps.getChannel(message.channelId);
  if (!channel) return { status: "dropped", reason: "channel_unavailable" };

  const renderedContent = await deps.renderAgentReadablePermalinks(message.content, channel.serverId);
  const senderIdentity = message.senderType === "external_projection"
    ? { uniqueName: message.externalAuthor!.displayName, description: null }
    : await deps.getSenderIdentity(message.senderType, message.senderId, "Unknown");
  const { uniqueName: senderName, description: senderDescription } = senderIdentity;
  const deliveryOptions = message.senderType === "external_projection"
    ? {}
    : await getAgentDeliveryOptionsForSender(
        deps,
        channel.serverId,
        message.senderType,
        message.senderId,
      );

  let parentFields: Pick<AgentMessage, "parent_channel_name" | "parent_channel_id" | "parent_channel_type"> = {};
  if (channel.type === "thread" && channel.parentMessageId) {
    const [parentMessage] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId))
      .limit(1);
    const parentChannel = parentMessage ? await deps.getChannel(parentMessage.channelId) : null;
    if (parentChannel) {
      const parentChannelType = toAgentVisibleChannelType(parentChannel.type);
      parentFields = {
        parent_channel_name: parentChannel.name,
        parent_channel_id: parentChannel.id,
        parent_channel_type: parentChannelType === "thread" ? "channel" : parentChannelType,
      };
    }
  }

  const deliveryPayload: AgentMessage = {
      channel_id: message.channelId,
      channel_name: channel.name,
      channel_type: toAgentVisibleChannelType(channel.type),
      sender_id: message.senderId,
      sender_name: senderName,
      sender_description: senderDescription,
      sender_type: toAgentVisibleSenderType(message.senderType, message.messageType),
      ...toAgentVisibleExternalMessage(message),
      content: renderAgentVisibleMessageContent(message, renderedContent),
      timestamp: message.createdAt.toISOString(),
      seq: message.seq,
      message_id: message.id,
      mentioned: message.senderType === "external_projection" ? false : true,
      ...(message.senderType !== "external_projection" && options.nonMemberMention === true && { non_member_mention: true }),
      ...parentFields,
      ...(message.senderType !== "external_projection" && message.taskStatus != null && {
        task_status: message.taskStatus as "todo" | "in_progress" | "in_review" | "done" | "closed",
        task_number: message.taskNumber,
        task_assignee_type: toAgentVisibleTaskAssigneeType(message.taskAssigneeType as InternalActorType | null),
        task_assignee_id: message.taskAssigneeId,
        task_assignee_name: getAgentVisibleTaskAssigneeName(message),
      }),
      ...(message.taskCurrentProjection && {
        task_current_projection: toAgentTaskCurrentProjection(message.taskCurrentProjection),
      }),
    };
  // SAME DECLARED DEGRADATION AS THE BATCHED SEND PATH, and it was missing here.
  // The batched form above states the policy in its own catch: "a record-keeping write must never
  // suppress the thing it records, so we still deliver." This path had no catch at all, so a DB
  // fault in the occurrence write propagated out of deliverMessageToAgent and the delivery never
  // happened — the exact inversion of that policy, on a path with four live callers
  // (internalAgentApi x2, routes/messages.ts x2). Found by @Hipp during narrow review of #6700;
  // it predates the port (the retired #6583 head has the same unguarded call), so this is the
  // mirror site the policy was never installed at, not a merge regression.
  // Degradation cost is identical to the batched case: without a deliveryPayload the occurrence
  // can never be redriven, so the mention is delivered but UNRECOVERABLE — emitted as a typed
  // trace so an accepted degradation stays observable rather than implicit.
  let mentionDeliveryOccurrenceId: string | undefined;
  try {
    mentionDeliveryOccurrenceId = await ensureAgentMentionDeliveryOccurrence(
      message.id,
      agentId,
      deliveryPayload,
    );
  } catch (err) {
    addTraceEvent("message_pipeline.mention_occurrence.persist_degraded", {
      message_id: message.id,
      intended_occurrence_count: 1,
      delivered_without_occurrence: true,
      recoverable: false,
    });
    console.error(
      `[MessageService] mention delivery occurrence unavailable for message ${message.id} agent ${agentId}; delivering without it (this mention is not recoverable):`,
      err,
    );
  }
  return agentOrchestrator.deliverMessage(
    agentId,
    deliveryPayload,
    {
      ...deliveryOptions,
      requireQueueReceipt: options.requireQueueReceipt ?? false,
      ...(options.reconcileNonMemberMention === true && { reconcileNonMemberMention: true }),
      ...(mentionDeliveryOccurrenceId && { mentionDeliveryOccurrenceId }),
    },
  );
}

/**
 * CS-4 (CL-CURSOR-SPLIT): rebuild an EXTERNAL agent's pending deliveries from
 * the durable per-channel ack watermark after the volatile delivery buffer is
 * lost (server restart/deploy). Without this, messages fanned out before a
 * restart become permanently invisible to `message check` — they were claimed
 * by no one, and the only delivery state was in-memory.
 *
 * Contract pins (Kai, #wg-external-agent):
 * - Per-channel watermark only. NEVER a global/merged cursor: consuming
 *   channel A at seq 500 says nothing about unseen channel B at 480.
 * - Channels without a cursor row are NOT rebuilt (v1 boundary — there is no
 *   horizon to rebuild from; fabricating one would either replay full history
 *   or skip unseen rows).
 * - The watermark is an ack/usability checkpoint, never model-seen proof.
 *   Nothing here may feed freshness gates; send still requires explicit
 *   `seenUpToSeq` (CS-2).
 * - Shape parity: rebuilt entries are constructed as buffer-native snake_case
 *   `AgentMessage` (same builder family as `deliverMessageToAgents`), so
 *   `/events` and wake-hint peeks serve them indistinguishably from live
 *   fan-out. `/history`'s camelCase enriched rows never leak into the buffer.
 *
 * Scope: external-runtime agents only. Managed runtimes deliver through the
 * machine wake path (`deliverMessage` plans daemon wakes), where re-driving
 * durable rows would double-wake old daemons; their restart recovery is the
 * daemon's own concern. For external agents `deliverMessage` only appends to
 * the local inbox and emits the content-free SSE wake signal — exactly the
 * two effects a rebuild should have.
 *
 * Known v1 boundaries (documented, deliberate):
 * - joint channels are skipped (canonical-storage vs local-projection mapping
 *   needs its own slice);
 * - DM-parent thread names fall back to the stored channel name instead of
 *   the per-agent peer name;
 * - transient notices have no durable row and are not recoverable by design;
 * - rows the agent acknowledged via `/history` reads or its own sends are
 *   below the watermark and intentionally not replayed.
 */
const CURSOR_REBUILD_MAX_ROWS_PER_CHANNEL = 100;
const cursorRebuildInFlight = new Map<string, Promise<number>>();

const RESUME_CATCHUP_MAX_CHANNELS = 8;
const RESUME_CATCHUP_MAX_ROWS_PER_CHANNEL = 5;
const RESUME_CATCHUP_MAX_ROWS_TOTAL = 20;

/**
 * "This message is a task assigned to me" — the resume-catchup piercing rule,
 * expressed across both task representations.
 *
 * v1.4 moved task assignment off `messages.task_*` onto the canonical `tasks`
 * row. This predicate is a *filter*, not a payload, so the read-side projection
 * cannot cover it: without the EXISTS arm, a task assigned to an agent would
 * silently stop pushing past that agent's channel mute on resume.
 */
function taskAssignedToAgentSql(agentId: string) {
  return sql`(
    (${messages.taskAssigneeType} = 'agent' AND ${messages.taskAssigneeId} = ${agentId})
    OR EXISTS (
      SELECT 1
      FROM ${tasks}
      WHERE ${tasks.messageId} = ${messages.id}
        AND ${tasks.claimedByType} = 'agent'
        AND ${tasks.claimedById} = ${agentId}
    )
  )`;
}

function resumeCatchupPiercingSeqSql(agentId: string) {
  return sql<number | null>`max(CASE WHEN (
    ${channels.type} = 'dm'
    OR ${taskAssignedToAgentSql(agentId)}
    OR COALESCE(${inboxNotificationFacts.personalMention}, false)
  ) THEN ${messages.seq} ELSE NULL END)::int`;
}

function resumeCatchupChannelOrderSql(agentId: string) {
  const piercingSeq = resumeCatchupPiercingSeqSql(agentId);
  return [
    sql`CASE WHEN ${piercingSeq} IS NULL THEN 1 ELSE 0 END asc`,
    sql`${piercingSeq} desc`,
    sql`max(${messages.seq}) desc`,
  ];
}

function resumeCatchupRowOrderSql(agentId: string, channelType: typeof channels.$inferSelect["type"]) {
  return [
    sql`CASE WHEN (
      ${channelType} = 'dm'
      OR ${taskAssignedToAgentSql(agentId)}
      OR EXISTS (
        SELECT 1
        FROM ${inboxNotificationFacts}
        WHERE ${inboxNotificationFacts.receiverType} = 'agent'
          AND ${inboxNotificationFacts.receiverId} = ${agentId}
          AND ${inboxNotificationFacts.messageId} = ${messages.id}
          AND ${inboxNotificationFacts.personalMention} = true
      )
    ) THEN 0 ELSE 1 END asc`,
    desc(messages.seq),
  ];
}

type ResumeCatchupCandidate = {
  channelId: string;
  channelName: string;
  channelType: typeof channels.$inferSelect["type"];
  serverId: string;
  parentMessageId: string | null;
  addedAt: Date;
  lastReadSeq: number;
  firstUnreadSeq: number;
  latestUnreadSeq: number;
  latestPiercingSeq: number | null;
};

function compareResumeCatchupCandidates(a: ResumeCatchupCandidate, b: ResumeCatchupCandidate) {
  const aPierce = a.latestPiercingSeq ?? 0;
  const bPierce = b.latestPiercingSeq ?? 0;
  if (aPierce !== bPierce) return bPierce - aPierce;
  if (a.latestUnreadSeq !== b.latestUnreadSeq) return b.latestUnreadSeq - a.latestUnreadSeq;
  return b.firstUnreadSeq - a.firstUnreadSeq;
}

export interface AgentResumeCatchupResult {
  messages: AgentMessage[];
  candidateChannelCount: number;
  maxSeq: number | null;
}

/**
 * Managed-runtime resume catch-up: build a bounded, daemon-native AgentMessage
 * batch from durable unread rows above the agent's legacy ack watermark.
 *
 * This deliberately does not advance any cursor. The daemon decides whether the
 * rows were rendered into model input and updates only its local delivery
 * dedupe state; agentChannelReadCursors remains an ack/readability watermark,
 * not model-seen truth.
 */
export async function getAgentResumeCatchupMessages(
  agentId: string,
  historyCutoff?: Date,
): Promise<AgentResumeCatchupResult> {
  const deps = resolveMessageServiceDeps();
  const db = getDb();
  const baseConditions = [
    isNull(channels.deletedAt),
    gt(messages.seq, sql`COALESCE(${agentChannelReadCursors.lastReadSeq}, 0)`),
    sql`NOT (${messages.senderType} = 'agent' AND ${messages.senderId} = ${agentId})`,
  ];
  if (historyCutoff) {
    baseConditions.push(gt(messages.createdAt, historyCutoff));
  }

  const nonThreadCandidates = await db
    .select({
      channelId: channels.id,
      channelName: channels.name,
      channelType: channels.type,
      serverId: channels.serverId,
      parentMessageId: channels.parentMessageId,
      addedAt: channelAgents.addedAt,
      lastReadSeq: sql<number>`COALESCE(${agentChannelReadCursors.lastReadSeq}, 0)::int`,
      firstUnreadSeq: sql<number>`min(${messages.seq})::int`,
      latestUnreadSeq: sql<number>`max(${messages.seq})::int`,
      latestPiercingSeq: resumeCatchupPiercingSeqSql(agentId),
    })
    .from(channels)
    .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
    .innerJoin(messages, eq(messages.channelId, channels.id))
    .leftJoin(inboxNotificationFacts, and(
      eq(inboxNotificationFacts.receiverType, "agent"),
      eq(inboxNotificationFacts.receiverId, agentId),
      eq(inboxNotificationFacts.sourceChannelId, channels.id),
      eq(inboxNotificationFacts.messageId, messages.id),
    ))
    .leftJoin(
      agentChannelReadCursors,
      and(
        eq(agentChannelReadCursors.channelId, channels.id),
        eq(agentChannelReadCursors.agentId, agentId),
      ),
    )
    .where(and(
      ...baseConditions,
      sql`${channels.type} <> 'thread'`,
      eq(channelAgents.agentId, agentId),
      gte(messages.createdAt, channelAgents.addedAt),
    ))
    .groupBy(
      channels.id,
      channels.name,
      channels.type,
      channels.serverId,
      channels.parentMessageId,
      channelAgents.addedAt,
      agentChannelReadCursors.lastReadSeq,
    )
    .orderBy(...resumeCatchupChannelOrderSql(agentId))
    .limit(RESUME_CATCHUP_MAX_CHANNELS);

  const resumeParentMessages = alias(messages, "agent_resume_thread_parent_messages");
  const resumeParentChannels = alias(channels, "agent_resume_thread_parent_channels");
  const resumeParentChannelAgents = alias(channelAgents, "agent_resume_thread_parent_channel_agents");
  const threadCandidates = await db
    .select({
      channelId: channels.id,
      channelName: channels.name,
      channelType: channels.type,
      serverId: channels.serverId,
      parentMessageId: channels.parentMessageId,
      addedAt: threadFollows.createdAt,
      lastReadSeq: sql<number>`COALESCE(${agentChannelReadCursors.lastReadSeq}, 0)::int`,
      firstUnreadSeq: sql<number>`min(${messages.seq})::int`,
      latestUnreadSeq: sql<number>`max(${messages.seq})::int`,
      latestPiercingSeq: resumeCatchupPiercingSeqSql(agentId),
    })
    .from(channels)
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
    .innerJoin(resumeParentMessages, eq(resumeParentMessages.id, channels.parentMessageId))
    .innerJoin(resumeParentChannels, and(
      eq(resumeParentChannels.id, resumeParentMessages.channelId),
      isNull(resumeParentChannels.deletedAt),
    ))
    .leftJoin(resumeParentChannelAgents, and(
      eq(resumeParentChannelAgents.channelId, resumeParentMessages.channelId),
      eq(resumeParentChannelAgents.agentId, agents.id),
    ))
    .innerJoin(messages, eq(messages.channelId, channels.id))
    .leftJoin(inboxNotificationFacts, and(
      eq(inboxNotificationFacts.receiverType, "agent"),
      eq(inboxNotificationFacts.receiverId, agentId),
      eq(inboxNotificationFacts.sourceChannelId, channels.id),
      eq(inboxNotificationFacts.messageId, messages.id),
    ))
    .leftJoin(
      agentChannelReadCursors,
      and(
        eq(agentChannelReadCursors.channelId, channels.id),
        eq(agentChannelReadCursors.agentId, agentId),
      ),
    )
    .where(and(
      ...baseConditions,
      eq(channels.type, "thread"),
      gte(messages.createdAt, threadFollows.createdAt),
      sql`(
        (${resumeParentChannels.type} = 'channel' AND ${agents.serverId} = ${resumeParentChannels.serverId})
        OR ${resumeParentChannelAgents.agentId} IS NOT NULL
      )`,
    ))
    .groupBy(
      channels.id,
      channels.name,
      channels.type,
      channels.serverId,
      channels.parentMessageId,
      threadFollows.createdAt,
      agentChannelReadCursors.lastReadSeq,
    )
    .orderBy(...resumeCatchupChannelOrderSql(agentId))
    .limit(RESUME_CATCHUP_MAX_CHANNELS * 4);

  const deliverableThreadCandidates: ResumeCatchupCandidate[] = [];
  for (const candidate of threadCandidates) {
    if (await channelService.canAgentReceiveChannelDelivery(candidate.channelId, agentId)) {
      deliverableThreadCandidates.push(candidate);
    }
  }

  const candidates = [...nonThreadCandidates, ...deliverableThreadCandidates]
    .sort(compareResumeCatchupCandidates)
    .slice(0, RESUME_CATCHUP_MAX_CHANNELS);

  const output: AgentMessage[] = [];
  let maxSeq: number | null = null;
  for (const candidate of candidates) {
    if (output.length >= RESUME_CATCHUP_MAX_ROWS_TOTAL) break;

    let parentFields: Pick<AgentMessage, "parent_channel_name" | "parent_channel_id" | "parent_channel_type"> = {};
    if (candidate.channelType === "thread" && candidate.parentMessageId) {
      const [parentMessage] = await db
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, candidate.parentMessageId))
        .limit(1);
      const parentChannel = parentMessage ? await deps.getChannel(parentMessage.channelId) : null;
      if (parentChannel && parentChannel.type !== "thread") {
        const parentChannelType = toAgentVisibleChannelType(parentChannel.type);
        parentFields = {
          parent_channel_name: parentChannel.name,
          parent_channel_id: parentChannel.id,
          parent_channel_type: parentChannelType === "thread" ? "channel" : parentChannelType,
        };
      }
    }

    const rowConditions = [
      eq(messages.channelId, candidate.channelId),
      gte(messages.createdAt, candidate.addedAt),
      gt(messages.seq, candidate.lastReadSeq),
      sql`NOT (${messages.senderType} = 'agent' AND ${messages.senderId} = ${agentId})`,
    ];
    if (historyCutoff) {
      rowConditions.push(gt(messages.createdAt, historyCutoff));
    }
    const eligibleRows = await db
      .select()
      .from(messages)
      .where(and(...rowConditions))
      .orderBy(...resumeCatchupRowOrderSql(agentId, candidate.channelType))
      .limit(Math.min(RESUME_CATCHUP_MAX_ROWS_PER_CHANNEL, RESUME_CATCHUP_MAX_ROWS_TOTAL - output.length));
    const rows = await enrichWithSenderNames(eligibleRows);

    for (const row of rows) {
      if (output.length >= RESUME_CATCHUP_MAX_ROWS_TOTAL) break;
      if (typeof row.seq !== "number" || row.seq <= candidate.lastReadSeq) continue;
      if (row.createdAt < candidate.addedAt) continue;
      if (row.senderType === "agent" && row.senderId === agentId) continue;
      const piercedAgentIds = new Set<string>();
      if (row.senderType !== "external_projection" && row.taskAssigneeType === "agent" && row.taskAssigneeId === agentId) {
        piercedAgentIds.add(agentId);
      }
      const mutedAgentDeliveryIds = await getMutedAgentDeliveryIdsForPersistedMessage(
        deps,
        {
          id: candidate.channelId,
          serverId: candidate.serverId,
          type: candidate.channelType,
        },
        row,
        [agentId],
        piercedAgentIds,
      );
      if (mutedAgentDeliveryIds.has(agentId)) continue;

      const identity = isSystemMessageIdentity(row.messageType, row.senderId)
        ? { uniqueName: "system", description: null as string | null }
        : row.senderType === "external_projection"
        ? { uniqueName: row.externalAuthor?.displayName ?? "External user", description: null }
        : await deps.getSenderIdentity(
            row.senderType as InternalActorType,
            row.senderId,
            row.senderName,
          );
      const renderedContent = await deps.renderAgentReadablePermalinks(row.content, candidate.serverId);
      output.push({
        channel_id: candidate.channelId,
        channel_name: candidate.channelType === "dm" && row.senderType === "user" && !isSystemMessageIdentity(row.messageType, row.senderId)
          ? identity.uniqueName
          : candidate.channelName,
        channel_type: toAgentVisibleChannelType(candidate.channelType),
        sender_id: row.senderId,
        sender_name: identity.uniqueName,
        sender_description: identity.description,
        sender_type: toAgentVisibleSenderType(row.senderType, row.messageType),
        ...toAgentVisibleExternalMessage(row),
        ...(row.senderType === "external_projection" && { mentioned: false }),
        content: renderAgentVisibleMessageContent(row, renderedContent),
        timestamp: row.createdAt.toISOString(),
        seq: row.seq,
        message_id: row.id,
        ...parentFields,
        ...(row.attachments.length > 0 && {
          attachments: row.attachments.map((a) => ({
            id: a.id,
            filename: normalizeAttachmentFilename(a.filename),
            mimeType: resolveAttachmentMimeType(a.filename, a.mimeType),
            sizeBytes: a.sizeBytes ?? undefined,
          })),
        }),
        ...(row.senderType !== "external_projection" && row.taskStatus != null && {
          task_status: row.taskStatus as "todo" | "in_progress" | "in_review" | "done" | "closed",
          task_number: row.taskNumber,
          task_assignee_type: toAgentVisibleTaskAssigneeType(row.taskAssigneeType as InternalActorType | null),
          task_assignee_id: row.taskAssigneeId,
          task_assignee_name: getAgentVisibleTaskAssigneeName(row),
        }),
      });
      maxSeq = maxSeq == null ? row.seq : Math.max(maxSeq, row.seq);
    }
  }

  return {
    messages: output,
    candidateChannelCount: candidates.length,
    maxSeq,
  };
}

export type ExternalAgentCursorRebuildRoute =
  | "events"
  | "wake_hints"
  | "wake_hints_stream_open"
  | "wake_hints_stream_flush";

export async function rebuildExternalAgentPendingFromAckCursors(
  agentOrchestrator: AgentOrchestrator,
  agentId: string,
  route: ExternalAgentCursorRebuildRoute = "events",
): Promise<number> {
  // Serialize per agent: concurrent /events + /wake-hints calls would both
  // pass the pending-seq dedupe check and double-deliver.
  const inFlight = cursorRebuildInFlight.get(agentId);
  if (inFlight) return inFlight;
  const run = rebuildExternalAgentPendingInner(agentOrchestrator, agentId, route)
    .finally(() => cursorRebuildInFlight.delete(agentId));
  cursorRebuildInFlight.set(agentId, run);
  return run;
}

async function rebuildExternalAgentPendingInner(
  agentOrchestrator: AgentOrchestrator,
  agentId: string,
  route: ExternalAgentCursorRebuildRoute,
): Promise<number> {
  const deps = resolveMessageServiceDeps();
  const db = getDb();
  const startedAt = Date.now();

  // Candidate channels: cursor rows with durable messages above the watermark.
  // One query; in the steady state (everything acked) this returns no rows.
  const cursorChannels = alias(channels, "cursor_rebuild_channels");
  const cursorCandidates = await db
    .select({
      channelId: agentChannelReadCursors.channelId,
      lastReadSeq: agentChannelReadCursors.lastReadSeq,
    })
    .from(agentChannelReadCursors)
    .innerJoin(cursorChannels, and(
      eq(cursorChannels.id, agentChannelReadCursors.channelId),
      isNull(cursorChannels.deletedAt),
    ))
    .where(and(
      eq(agentChannelReadCursors.agentId, agentId),
      sql`EXISTS (
        SELECT 1 FROM ${messages}
        WHERE ${messages.channelId} = ${agentChannelReadCursors.channelId}
          AND ${messages.seq} > ${agentChannelReadCursors.lastReadSeq}
      )`,
    ));

  // Cold-start fallback: channels the agent is a member of but has never
  // read/acked (no cursor row). Without this, external agents that have
  // never run `message check` or `message read` on a channel cannot be
  // woken via the durable rebuild path — the volatile inbox is the only
  // delivery vector, and it is lost on server restart or cross-replica.
  // The baseline seq is the last message sent at or before the agent's
  // channel join time — pre-join history is treated as already consumed.
  const coldStartChannels = alias(channels, "cold_start_channels");
  const coldStartCandidates = await db
    .select({
      channelId: channelAgents.channelId,
      lastReadSeq: sql<number>`COALESCE(
        (SELECT MAX(${messages.seq}) FROM ${messages}
         WHERE ${messages.channelId} = ${channelAgents.channelId}
           AND ${messages.createdAt} <= ${channelAgents.addedAt}),
        0
      )`.as("last_read_seq"),
    })
    .from(channelAgents)
    .innerJoin(coldStartChannels, and(
      eq(coldStartChannels.id, channelAgents.channelId),
      isNull(coldStartChannels.deletedAt),
    ))
    .where(and(
      eq(channelAgents.agentId, agentId),
      sql`NOT EXISTS (
        SELECT 1 FROM ${agentChannelReadCursors}
        WHERE ${agentChannelReadCursors.agentId} = ${agentId}
          AND ${agentChannelReadCursors.channelId} = ${channelAgents.channelId}
      )`,
      sql`EXISTS (
        SELECT 1 FROM ${messages}
        WHERE ${messages.channelId} = ${channelAgents.channelId}
          AND ${messages.createdAt} > ${channelAgents.addedAt}
      )`,
    ));

  const candidates = [...cursorCandidates, ...coldStartCandidates];
  if (candidates.length === 0) {
    emitExternalAgentCursorRebuildTrace({
      route,
      durationMs: Date.now() - startedAt,
      cursorCandidateCount: 0,
      coldStartCandidateCount: 0,
      pendingBeforeCount: 0,
      inspectedMessageCount: 0,
      rebuiltMessageCount: 0,
      dedupedPendingCount: 0,
      skippedJointCount: 0,
      skippedNoMembershipCount: 0,
      skippedOwnSendCount: 0,
      skippedMutedCount: 0,
      deliveryFailureCount: 0,
    });
    return 0;
  }

  const pendingSeqs = new Set(
    agentOrchestrator.peekPendingMessages(agentId)
      .map((m) => m.seq)
      .filter((seq): seq is number => Number.isInteger(seq)),
  );
  let inspectedMessages = 0;
  let dedupedPending = 0;
  let skippedJoint = 0;
  let skippedNoMembership = 0;
  let skippedOwnSend = 0;
  let skippedMuted = 0;
  let deliveryFailures = 0;
  const deliveryOptionsBySender = new Map<string, DeliverMessageOptions>();
  const identityBySender = new Map<string, { uniqueName: string; description: string | null }>();
  let delivered = 0;

  for (const candidate of candidates) {
    const channel = await deps.getChannel(candidate.channelId);
    if (!channel || channel.type === "joint") {
      skippedJoint += 1;
      continue;
    }

    // Membership recheck at rebuild time: the cursor row may predate a
    // leave/unfollow. Thread delivery goes to followers, not parent members.
    const isThread = channel.type === "thread";
    const memberAgents = isThread
      ? await getThreadAgentFollowers(candidate.channelId)
      : await deps.getChannelAgents(candidate.channelId);
    if (!memberAgents.some((member) => member.id === agentId)) {
      skippedNoMembership += 1;
      continue;
    }

    // Thread parent fields, resolved once per channel.
    let parentChannelId: string | undefined;
    let parentChannelName: string | undefined;
    let parentChannelType: "channel" | "private" | "joint" | "dm" | undefined;
    if (isThread && channel.parentMessageId) {
      const [parentMessage] = await db
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, channel.parentMessageId))
        .limit(1);
      const parentChannel = parentMessage ? await deps.getChannel(parentMessage.channelId) : null;
      if (parentChannel && parentChannel.type !== "thread") {
        parentChannelId = parentChannel.id;
        parentChannelName = parentChannel.name;
        parentChannelType = parentChannel.type as "channel" | "private" | "joint" | "dm";
      }
    }

    // Enriched (senderName/attachments/task fields), chronological from the
    // watermark. Content is NOT permalink-rendered here: `/events` renders at
    // serve time, so rebuilt rows reach the wire rendered exactly once.
    const rows = await listMessages(
      candidate.channelId,
      CURSOR_REBUILD_MAX_ROWS_PER_CHANNEL,
      undefined,
      candidate.lastReadSeq,
    );

    for (const row of rows) {
      if (typeof row.seq !== "number" || row.seq <= candidate.lastReadSeq) continue;
      inspectedMessages += 1;
      // Live-buffer dedupe: delivered-but-unacked rows are both in the volatile
      // buffer and above the watermark; rebuild must not double them.
      if (pendingSeqs.has(row.seq)) {
        dedupedPending += 1;
        continue;
      }
      // An agent never receives its own sends (live fan-out excludes sender).
      if (row.senderType === "agent" && row.senderId === agentId) {
        skippedOwnSend += 1;
        continue;
      }
      const piercedAgentIds = new Set<string>();
      if (row.senderType !== "external_projection" && row.taskAssigneeType === "agent" && row.taskAssigneeId === agentId) {
        piercedAgentIds.add(agentId);
      }
      const mutedAgentDeliveryIds = await getMutedAgentDeliveryIdsForPersistedMessage(
        deps,
        channel,
        row,
        [agentId],
        piercedAgentIds,
      );
      if (mutedAgentDeliveryIds.has(agentId)) {
        skippedMuted += 1;
        continue;
      }

      const senderKey = `${row.senderType}:${row.senderId}`;
      let deliveryOptions = deliveryOptionsBySender.get(senderKey);
      if (!deliveryOptions) {
        deliveryOptions = isSystemMessageIdentity(row.messageType, row.senderId)
          ? {}
          : row.senderType === "external_projection"
          ? {}
          : await getAgentDeliveryOptionsForSender(
              deps,
              channel.serverId,
              row.senderType as InternalActorType,
              row.senderId,
            );
        deliveryOptionsBySender.set(senderKey, deliveryOptions);
      }
      // Live fan-out parity: buffer entries carry the sender's UNIQUE name
      // (the @mention handle), not the enriched display name.
      let identity = identityBySender.get(senderKey);
      if (!identity) {
        identity = isSystemMessageIdentity(row.messageType, row.senderId)
          ? { uniqueName: "system", description: null }
          : row.senderType === "external_projection"
          ? { uniqueName: row.externalAuthor?.displayName ?? "External user", description: null }
          : await deps.getSenderIdentity(
              row.senderType as InternalActorType,
              row.senderId,
              row.senderName,
            );
        identityBySender.set(senderKey, identity);
      }

      try {
        await agentOrchestrator.deliverMessage(agentId, {
          channel_id: candidate.channelId,
          // DM parity with live fan-out: the channel is named after the human
          // peer from the agent's perspective, not the stored channel name.
          channel_name: channel.type === "dm" && row.senderType === "user" && !isSystemMessageIdentity(row.messageType, row.senderId)
            ? identity.uniqueName
            : channel.name,
          channel_type: toAgentVisibleChannelType(channel.type),
          sender_id: row.senderId,
          sender_name: identity.uniqueName,
          sender_description: identity.description,
          sender_type: toAgentVisibleSenderType(row.senderType, row.messageType),
          ...toAgentVisibleExternalMessage(row),
          ...(row.senderType === "external_projection" && { mentioned: false }),
          content: renderAgentVisibleMessageContent(row, row.content),
          timestamp: row.createdAt.toISOString(),
          seq: row.seq,
          message_id: row.id,
          ...(parentChannelId && parentChannelType && {
            parent_channel_name: parentChannelName,
            parent_channel_id: parentChannelId,
            parent_channel_type: parentChannelType,
          }),
          ...(row.attachments.length > 0 && {
            attachments: row.attachments.map((a) => ({
              id: a.id,
              filename: a.filename,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes ?? undefined,
            })),
          }),
          ...(row.senderType !== "external_projection" && row.taskStatus != null && {
            task_status: row.taskStatus as "todo" | "in_progress" | "in_review" | "done" | "closed",
            task_number: row.taskNumber,
            task_assignee_type: toAgentVisibleTaskAssigneeType(row.taskAssigneeType as InternalActorType | null),
            task_assignee_id: row.taskAssigneeId,
            task_assignee_name: getAgentVisibleTaskAssigneeName(row),
          }),
        }, deliveryOptions);
        delivered += 1;
      } catch (err) {
        deliveryFailures += 1;
        console.error(`[MessageService] CS-4 rebuild delivery failed for agent ${agentId} seq ${row.seq}:`, serializeErrorForLog(err));
      }
    }
  }
  emitExternalAgentCursorRebuildTrace({
    route,
    durationMs: Date.now() - startedAt,
    cursorCandidateCount: cursorCandidates.length,
    coldStartCandidateCount: coldStartCandidates.length,
    pendingBeforeCount: pendingSeqs.size,
    inspectedMessageCount: inspectedMessages,
    rebuiltMessageCount: delivered,
    dedupedPendingCount: dedupedPending,
    skippedJointCount: skippedJoint,
    skippedNoMembershipCount: skippedNoMembership,
    skippedOwnSendCount: skippedOwnSend,
    skippedMutedCount: skippedMuted,
    deliveryFailureCount: deliveryFailures,
  });
  return delivered;
}

type ExternalAgentCursorRebuildTraceStats = {
  route: ExternalAgentCursorRebuildRoute;
  durationMs: number;
  cursorCandidateCount: number;
  coldStartCandidateCount: number;
  pendingBeforeCount: number;
  inspectedMessageCount: number;
  rebuiltMessageCount: number;
  dedupedPendingCount: number;
  skippedJointCount: number;
  skippedNoMembershipCount: number;
  skippedOwnSendCount: number;
  skippedMutedCount: number;
  deliveryFailureCount: number;
};

function emitExternalAgentCursorRebuildTrace(stats: ExternalAgentCursorRebuildTraceStats): void {
  const totalCandidates = stats.cursorCandidateCount + stats.coldStartCandidateCount;
  // Emit when candidates exist — even if nothing was rebuilt. The absence
  // of rebuilt messages when candidates exist IS negative evidence: it means
  // "rebuild ran, found candidate channels, but no deliverable messages above
  // the watermark." This is load-bearing for diagnosing wake-then-empty-check
  // gaps in external agent delivery.
  if (totalCandidates === 0) return;

  const rebuildOutcome = stats.rebuiltMessageCount > 0
    ? "messages_rebuilt"
    : stats.deliveryFailureCount > 0
      ? "delivery_failed"
      : stats.inspectedMessageCount > 0
        ? "all_filtered"
        : (stats.skippedJointCount + stats.skippedNoMembershipCount) > 0
          ? "candidates_skipped"
          : "no_messages_above_watermark";

  addTraceEvent("external_agent.cursor_rebuild.finished", {
    route: stats.route,
    duration_ms: stats.durationMs,
    rebuild_outcome: rebuildOutcome,
    candidate_channel_count: totalCandidates,
    cursor_candidate_channel_count: stats.cursorCandidateCount,
    cold_start_candidate_channel_count: stats.coldStartCandidateCount,
    pending_before_count: stats.pendingBeforeCount,
    inspected_message_count: stats.inspectedMessageCount,
    rebuilt_message_count: stats.rebuiltMessageCount,
    deduped_pending_count: stats.dedupedPendingCount,
    skipped_joint_count: stats.skippedJointCount,
    skipped_no_membership_count: stats.skippedNoMembershipCount,
    skipped_own_send_count: stats.skippedOwnSendCount,
    skipped_muted_count: stats.skippedMutedCount,
    delivery_failure_count: stats.deliveryFailureCount,
  });
}

/**
 * Batch-resolve sender names for a list of messages.
 * Keeps sender and attachment enrichment constant-query rather than per-message.
 */
type MessageRowForEnrichment = {
  id: string;
  channelId: string;
  senderId: string;
  senderType: StoredMessageSenderType;
  messageType: "chat" | "system";
  taskAssigneeType?: "user" | "agent" | null;
  taskAssigneeId?: string | null;
};

type MessageQueryTraceOptions = {
  traceQuery?: DbQueryTracer;
  attachmentCommentViewerUserId?: string | null;
  forwardedBundleViewerUserId?: string | null;
  forwardedBundleViewerAgentId?: string | null;
  forwardedBundleViewerServerId?: string | null;
  excludeSender?: {
    senderType: "user" | "agent";
    senderId: string;
  };
};

type MessageReactionSummary = {
  emoji: string;
  count: number;
  reactorIds: string[];
  reactorNames: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripForwardRequestDigest(actionMetadata: unknown): unknown {
  if (!isRecord(actionMetadata) || actionMetadata.kind !== "forwarded-bundle") return actionMetadata;
  const {
    _forwardRequestDigest: _requestDigest,
    forwardRequestFingerprint: _forwardRequestFingerprint,
    ...projected
  } = actionMetadata;
  return projected;
}

export function projectForwardDestinationMessage<T extends Record<string, unknown>>(message: T): T {
  if (!isRecord(message.actionMetadata) || message.actionMetadata.kind !== "forwarded-bundle") return message;
  const {
    taskStatus: _taskStatus,
    taskNumber: _taskNumber,
    taskAssigneeType: _taskAssigneeType,
    taskAssigneeId: _taskAssigneeId,
    taskClaimedAt: _taskClaimedAt,
    taskCompletedAt: _taskCompletedAt,
    ...projected
  } = message;
  return {
    ...projected,
    actionMetadata: stripForwardRequestDigest(message.actionMetadata),
  } as unknown as T;
}

function restrictedSourceTargetSnapshot(type: unknown) {
  return {
    id: null,
    type: typeof type === "string" && type ? type : "channel",
    label: "",
    labelVisibility: "restricted",
  };
}

function scrubbedSourceTargetSnapshot(sourceTargetSnapshot: Record<string, unknown> | null) {
  return restrictedSourceTargetSnapshot(sourceTargetSnapshot?.type);
}

async function viewerCanReadForwardedSource(
  sourceTargetId: string,
  sourceServerId: string,
  viewer: { type: "user"; id: string; serverId: string } | { type: "agent"; id: string; serverId: string },
): Promise<boolean> {
  const db = getDb();
  if (viewer.serverId !== sourceServerId) return false;
  if (viewer.type === "agent") {
    const agent = await agentService.getAgent(viewer.id);
    if (!agent || agent.serverId !== viewer.serverId) return false;
    return channelService.canAgentAccessChannel(sourceTargetId, viewer.id);
  }

  const [membership] = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, sourceServerId), eq(serverMembers.userId, viewer.id)))
    .limit(1);
  if (!membership) return false;
  return channelService.canUserAccessChannel(sourceTargetId, viewer.id, sourceServerId as ServerId);
}

async function scrubForwardedBundleMetadataForViewer(
  actionMetadata: unknown,
  viewer?: { type: "user"; id: string; serverId: string } | { type: "agent"; id: string; serverId: string } | null,
  canReadSource: typeof viewerCanReadForwardedSource = viewerCanReadForwardedSource,
): Promise<unknown> {
  if (!isRecord(actionMetadata) || actionMetadata.kind !== "forwarded-bundle") {
    return actionMetadata;
  }
  const { forwardRequestFingerprint: _forwardRequestFingerprint, ...publicMetadata } = actionMetadata;
  if (!viewer || !Array.isArray(actionMetadata.forwardedItems)) return publicMetadata;

  const forwardedItems = await Promise.all(actionMetadata.forwardedItems.map(async (rawItem) => {
    if (!isRecord(rawItem)) return rawItem;
    const sourceTargetId = typeof rawItem.sourceTargetId === "string" ? rawItem.sourceTargetId : null;
    const sourceServerId = typeof rawItem.sourceServerId === "string" ? rawItem.sourceServerId : null;
    const sourceTargetSnapshot = isRecord(rawItem.sourceTargetSnapshot) ? rawItem.sourceTargetSnapshot : null;
    if (!sourceTargetId || !sourceServerId) {
      return {
        ...rawItem,
        sourceMessageId: null,
        sourceServerId: null,
        sourceTargetId: null,
        sourceThreadId: null,
        parentChannelId: null,
        sourceTargetSnapshot: scrubbedSourceTargetSnapshot(sourceTargetSnapshot),
        provenanceState: "original_unavailable",
      };
    }

    if (await canReadSource(sourceTargetId, sourceServerId, viewer)) return rawItem;

    return {
      ...rawItem,
      sourceMessageId: null,
      sourceServerId: null,
      sourceTargetId: null,
      sourceThreadId: null,
      parentChannelId: null,
      sourceTargetSnapshot: scrubbedSourceTargetSnapshot(sourceTargetSnapshot),
      provenanceState: "original_unavailable",
    };
  }));

  return { ...publicMetadata, forwardedItems };
}

function stripForwardedSourcePointersForBroadcast(actionMetadata: unknown): unknown {
  if (!isRecord(actionMetadata) || actionMetadata.kind !== "forwarded-bundle") {
    return actionMetadata;
  }
  const { forwardRequestFingerprint: _forwardRequestFingerprint, ...publicMetadata } = actionMetadata;
  if (!Array.isArray(actionMetadata.forwardedItems)) return publicMetadata;

  return {
    ...publicMetadata,
    forwardedItems: actionMetadata.forwardedItems.map((rawItem) => {
      if (!isRecord(rawItem)) return rawItem;
      const sourceTargetSnapshot = isRecord(rawItem.sourceTargetSnapshot) ? rawItem.sourceTargetSnapshot : null;
      return {
        ...rawItem,
        sourceMessageId: null,
        sourceServerId: null,
        sourceTargetId: null,
        sourceThreadId: null,
        parentChannelId: null,
        sourceTargetSnapshot: scrubbedSourceTargetSnapshot(sourceTargetSnapshot),
        provenanceState: "original_unavailable",
      };
    }),
  };
}

function forwardedSourceLabelForAgent(snapshot: unknown): string | null {
  if (!isRecord(snapshot)) return null;
  const labelVisibility = typeof snapshot.labelVisibility === "string" ? snapshot.labelVisibility : null;
  const label = typeof snapshot.label === "string" && snapshot.label.trim() ? snapshot.label.trim() : null;
  if (labelVisibility === "public" && label) return label;
  return null;
}

function forwardedAuthorLabelForAgent(snapshot: unknown): string {
  if (!isRecord(snapshot)) return "Unknown";
  const uniqueName = typeof snapshot.uniqueName === "string" && snapshot.uniqueName.trim() ? snapshot.uniqueName.trim() : null;
  if (uniqueName) return `@${uniqueName}`;
  const name = typeof snapshot.name === "string" && snapshot.name.trim() ? snapshot.name.trim() : null;
  return name ?? "Unknown";
}

function truncateAgentForwardedText(value: string, limit: number, marker: string): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[${marker}: ${value.length - limit} chars omitted]`;
}

function formatForwardedBundleForAgent(actionMetadata: unknown): string | null {
  if (!isRecord(actionMetadata) || actionMetadata.kind !== "forwarded-bundle") return null;
  if (!Array.isArray(actionMetadata.forwardedItems) || actionMetadata.forwardedItems.length === 0) return null;

  const sections: string[] = [];
  for (const [index, rawItem] of actionMetadata.forwardedItems.entries()) {
    if (!isRecord(rawItem)) continue;
    const contentSnapshot = typeof rawItem.contentSnapshot === "string"
      ? truncateAgentForwardedText(rawItem.contentSnapshot, AGENT_FORWARDED_ITEM_CONTENT_CHAR_LIMIT, "forwarded content truncated")
      : "";
    const attachmentSnapshots = Array.isArray(rawItem.attachmentSnapshots)
      ? rawItem.attachmentSnapshots.filter(isRecord)
      : [];
    const lines = [
      `Forwarded message ${index + 1}:`,
      `From: ${forwardedAuthorLabelForAgent(rawItem.sourceAuthorSnapshot)}`,
    ];
    const sourceLabel = forwardedSourceLabelForAgent(rawItem.sourceTargetSnapshot);
    if (sourceLabel) lines.push(`Source: ${sourceLabel}`);
    if (typeof rawItem.sourceCreatedAt === "string" && rawItem.sourceCreatedAt.trim()) {
      lines.push(`Sent: ${rawItem.sourceCreatedAt.trim()}`);
    }
    lines.push("");
    lines.push(contentSnapshot || "[empty message]");
    if (attachmentSnapshots.length > 0) {
      const attachmentLabels = attachmentSnapshots.map((attachment) => {
        const filename = typeof attachment.filename === "string" && attachment.filename.trim()
          ? normalizeAttachmentFilename(attachment.filename)
          : "attachment";
        const mimeType = typeof attachment.mimeType === "string" && attachment.mimeType.trim()
          ? attachment.mimeType.trim()
          : null;
        return mimeType ? `${filename} (${mimeType})` : filename;
      });
      lines.push("");
      lines.push(`Attachments: ${attachmentLabels.join(", ")}`);
    }
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) return null;
  return truncateAgentForwardedText(
    `Forwarded content snapshot:\n\n${sections.join("\n\n---\n\n")}`,
    AGENT_FORWARDED_BUNDLE_CHAR_LIMIT,
    "forwarded snapshot truncated",
  );
}

function buildAgentFacingBaseContent(content: string, agentContentPrefix: string | undefined): string {
  return agentContentPrefix ? `${agentContentPrefix}\n${content}` : content;
}

function appendAgentForwardedSnapshot(content: string, forwardedSnapshot: string | null): string {
  return forwardedSnapshot ? `${content}\n\n${forwardedSnapshot}` : content;
}

/**
 * Append the bounded, agent-readable forwarded-bundle snapshot to canonical
 * message content. Callers must pass viewer-scoped action metadata returned by
 * the message query helpers (with forwardedBundleViewer* set); this formatter
 * deliberately renders snapshots only and never exposes source pointers.
 */
export function appendAgentFacingForwardedSnapshot(
  content: string,
  viewerScopedActionMetadata: unknown,
): string {
  return appendAgentForwardedSnapshot(
    content,
    formatForwardedBundleForAgent(viewerScopedActionMetadata),
  );
}

export function sanitizeForwardedBundleMetadataForBroadcast<T extends { actionMetadata?: unknown | null }>(message: T): T {
  const projected = projectForwardDestinationMessage(message as T & Record<string, unknown>);
  const actionMetadata = stripForwardedSourcePointersForBroadcast(projected.actionMetadata);
  if (actionMetadata === projected.actionMetadata) return projected;
  return {
    ...projected,
    actionMetadata,
  };
}

function resolveForwardedBundleViewer(opts: MessageQueryTraceOptions):
  | { type: "user"; id: string; serverId: string }
  | { type: "agent"; id: string; serverId: string }
  | null {
  if (opts.forwardedBundleViewerUserId) {
    return {
      type: "user",
      id: opts.forwardedBundleViewerUserId,
      serverId: opts.forwardedBundleViewerServerId ?? "",
    };
  }
  if (opts.forwardedBundleViewerAgentId && opts.forwardedBundleViewerServerId) {
    return {
      type: "agent",
      id: opts.forwardedBundleViewerAgentId,
      serverId: opts.forwardedBundleViewerServerId,
    };
  }
  return null;
}

async function getMentionFactsForMessages(
  messageIds: string[],
  traceQuery: DbQueryTracer = untracedDbQuery,
): Promise<Map<string, ResolvedMentionFact[]>> {
  if (messageIds.length === 0) return new Map();

  const rows = await traceQuery(
    "messages.mentions_by_messages",
    () => getDb()
      .select({
        messageId: messageMentions.messageId,
        targetType: messageMentions.targetType,
        targetId: messageMentions.targetId,
        handleAtSendTime: messageMentions.handleAtSendTime,
      })
      .from(messageMentions)
      .where(and(
        inArray(messageMentions.messageId, messageIds),
        or(eq(messageMentions.notifiableAtSend, true), isNotNull(messageMentions.notifiedAt)),
      ))
      .orderBy(messageMentions.createdAt),
    () => ({ input_count: messageIds.length }),
  );
  const byMessage = new Map<string, ResolvedMentionFact[]>();
  for (const row of rows) {
    const facts = byMessage.get(row.messageId) ?? [];
    facts.push({
      type: row.targetType,
      id: row.targetId,
      name: row.handleAtSendTime,
    });
    byMessage.set(row.messageId, facts);
  }
  return byMessage;
}

async function getMentionFactsForMessagesWithExecutor(
  executor: DatabaseExecutor,
  messageIds: string[],
): Promise<Map<string, ResolvedMentionFact[]>> {
  if (messageIds.length === 0) return new Map();

  const rows = await executor
    .select({
      messageId: messageMentions.messageId,
      targetType: messageMentions.targetType,
      targetId: messageMentions.targetId,
      handleAtSendTime: messageMentions.handleAtSendTime,
    })
    .from(messageMentions)
    .where(and(
      inArray(messageMentions.messageId, messageIds),
      or(eq(messageMentions.notifiableAtSend, true), isNotNull(messageMentions.notifiedAt)),
    ))
    .orderBy(messageMentions.createdAt);

  const byMessage = new Map<string, ResolvedMentionFact[]>();
  for (const row of rows) {
    const facts = byMessage.get(row.messageId) ?? [];
    facts.push({
      type: row.targetType,
      id: row.targetId,
      name: row.handleAtSendTime,
    });
    byMessage.set(row.messageId, facts);
  }
  return byMessage;
}

async function getReactionsForMessages(
  messageIds: string[],
  traceQuery: DbQueryTracer = untracedDbQuery,
): Promise<Map<string, MessageReactionSummary[]>> {
  if (messageIds.length === 0) return new Map();

  const db = getDb();
  const rows = await traceQuery(
    "messages.reactions_by_messages",
    () => db
      .select({
        messageId: messageReactions.messageId,
        emoji: messageReactions.emoji,
        reactorType: messageReactions.reactorType,
        reactorId: messageReactions.reactorId,
        userName: users.name,
        userDisplayName: users.displayName,
        agentName: agents.name,
        agentDisplayName: agents.displayName,
        createdAt: messageReactions.createdAt,
      })
      .from(messageReactions)
      .leftJoin(users, and(eq(messageReactions.reactorType, "user"), eq(messageReactions.reactorId, users.id)))
      .leftJoin(agents, and(eq(messageReactions.reactorType, "agent"), eq(messageReactions.reactorId, agents.id)))
      .where(inArray(messageReactions.messageId, messageIds))
      .orderBy(messageReactions.createdAt),
    () => ({ input_count: messageIds.length }),
  );
  const externalRows = await traceQuery(
    "messages.external_reactions_by_messages",
    () => db.select({
      messageId: externalReactionStates.raftMessageId,
      emoji: externalReactionStates.canonicalEmoji,
      reactorId: externalReactionStates.projectionId,
      reactorName: externalActorProjections.displayName,
    }).from(externalReactionStates)
      .innerJoin(externalActorProjections, and(
        eq(externalActorProjections.id, externalReactionStates.projectionId),
        eq(externalActorProjections.state, "active"),
        eq(externalActorProjections.deactivated, false),
      ))
      .where(and(
        inArray(externalReactionStates.raftMessageId, messageIds),
        eq(externalReactionStates.present, true),
      ))
      .orderBy(externalReactionStates.createdAt),
    () => ({ input_count: messageIds.length }),
  );

  const byMessage = new Map<string, Map<string, MessageReactionSummary>>();
  for (const row of rows) {
    let messageMap = byMessage.get(row.messageId);
    if (!messageMap) {
      messageMap = new Map();
      byMessage.set(row.messageId, messageMap);
    }

    let summary = messageMap.get(row.emoji);
    if (!summary) {
      summary = {
        emoji: row.emoji,
        count: 0,
        reactorIds: [],
        reactorNames: [],
      };
      messageMap.set(row.emoji, summary);
    }
    summary.count += 1;
    summary.reactorIds.push(row.reactorId);
    summary.reactorNames.push(
      row.reactorType === "agent"
        ? row.agentDisplayName || row.agentName || "Unknown agent"
        : row.userDisplayName || row.userName || "Unknown user",
    );
  }
  for (const row of externalRows) {
    let messageMap = byMessage.get(row.messageId);
    if (!messageMap) {
      messageMap = new Map();
      byMessage.set(row.messageId, messageMap);
    }
    let summary = messageMap.get(row.emoji);
    if (!summary) {
      summary = { emoji: row.emoji, count: 0, reactorIds: [], reactorNames: [] };
      messageMap.set(row.emoji, summary);
    }
    summary.count += 1;
    summary.reactorIds.push(row.reactorId);
    summary.reactorNames.push(row.reactorName);
  }

  return new Map([...byMessage.entries()].map(([messageId, emojiMap]) => [messageId, [...emojiMap.values()]]));
}

async function enrichWithSenderNames<T extends MessageRowForEnrichment>(
  inputRows: T[],
  opts: MessageQueryTraceOptions = {},
) {
  if (inputRows.length === 0) return [];

  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const messageIds = inputRows.map((m) => m.id);

  // v1.4: task facts live in `tasks`, but the message-shaped task fields are a
  // published interface (CLI `[task #N status=...]` suffix, socket payloads,
  // assignee mute-piercing). Project them back on here — the single chokepoint
  // every message-history read path already funnels through — so no read
  // surface has to learn about the storage move.
  const rows = projectTaskFactsOntoRows(
    inputRows,
    await loadCanonicalTaskFactsByMessageId(messageIds, db),
  );

  const reactionMap = await getReactionsForMessages(messageIds, traceQuery);
  const mentionMap = await getMentionFactsForMessages(messageIds, traceQuery);
  const externalAuthorMap = await loadExternalMessageAuthors(messageIds, db);
  const missingExternalAuthor = rows.find(
    (row) => row.senderType === "external_projection" && !externalAuthorMap.has(row.id),
  );
  if (missingExternalAuthor) {
    throw new Error("External projection message is missing immutable author fact");
  }

  // Collect unique actor IDs by type (exclude system messages — senderId "system" is not a valid UUID).
  // Task assignees share the same actor tables and must be resolved before
  // formatting agent-facing history, otherwise the CLI would leak opaque IDs.
  const userIdSet = new Set<string>();
  const agentIdSet = new Set<string>();
  for (const row of rows) {
    if (row.senderType === "user" && row.messageType !== "system") userIdSet.add(row.senderId);
    if (row.senderType === "agent") agentIdSet.add(row.senderId);
    if (row.taskAssigneeId) {
      if (row.taskAssigneeType === "user") userIdSet.add(row.taskAssigneeId);
      else if (row.taskAssigneeType === "agent") agentIdSet.add(row.taskAssigneeId);
    }
  }
  const userIds = [...userIdSet];
  const agentIds = [...agentIdSet];

  // Batch fetch all sender names (2 queries instead of N)
  const nameMap = new Map<string, string>();
  const handleMap = new Map<string, string>();
  const descriptionMap = new Map<string, string | null>();
  nameMap.set("system", "System");
  descriptionMap.set("system", null);
  const channelServerMap = new Map<string, string>();
  const channelTypeMap = new Map<string, string>();
  const activeMemberKeys = new Set<string>();
  const departureReasonByMemberKey = new Map<string, "left" | "removed">();
  const activeJointMemberKeys = new Set<string>();
  const jointMembershipChannelIds = new Set<string>();

  const userMessageRows = rows.filter((m) => m.senderType === "user" && m.messageType !== "system");

  if (userIds.length > 0) {
    const userRows = await traceQuery(
      "messages.senders.user_profiles",
      () => db
        .select({ id: users.id, name: users.name, displayName: users.displayName, description: users.description })
        .from(users)
        .where(inArray(users.id, userIds)),
      () => ({ input_count: userIds.length }),
    );
    for (const u of userRows) {
      nameMap.set(u.id, u.displayName || u.name || "User");
      handleMap.set(u.id, u.name || "User");
      descriptionMap.set(u.id, u.description || null);
    }
  }

  if (userMessageRows.length > 0) {
    const channelIds = [...new Set(userMessageRows.map((m) => m.channelId))];
    const channelRows = await traceQuery(
      "messages.senders.channels_by_messages",
      () => db
        .select({ id: channels.id, serverId: channels.serverId, type: channels.type })
        .from(channels)
        .where(inArray(channels.id, channelIds)),
      () => ({ input_count: channelIds.length }),
    );
    for (const channel of channelRows) {
      channelServerMap.set(channel.id, channel.serverId);
      channelTypeMap.set(channel.id, channel.type);
    }

    const serverIds = [...new Set(channelRows.map((channel) => channel.serverId))];
    if (serverIds.length > 0 && userIds.length > 0) {
      const membershipRows = await traceQuery(
        "messages.senders.server_members",
        () => db
          .select({ serverId: serverMembers.serverId, userId: serverMembers.userId })
          .from(serverMembers)
          .where(and(
            inArray(serverMembers.serverId, serverIds),
            inArray(serverMembers.userId, userIds),
          )),
        () => ({ input_count: userIds.length, server_count: serverIds.length }),
      );
      for (const membership of membershipRows) {
        activeMemberKeys.add(`${membership.serverId}:${membership.userId}`);
      }

      const departureRows = await traceQuery(
        "messages.senders.server_membership_departures",
        () => db
          .select({
            serverId: serverMembershipDepartures.serverId,
            userId: serverMembershipDepartures.userId,
            reason: serverMembershipDepartures.reason,
          })
          .from(serverMembershipDepartures)
          .where(and(
            inArray(serverMembershipDepartures.serverId, serverIds),
            inArray(serverMembershipDepartures.userId, userIds),
          )),
        () => ({ input_count: userIds.length, server_count: serverIds.length }),
      );
      for (const departure of departureRows) {
        departureReasonByMemberKey.set(
          `${departure.serverId}:${departure.userId}`,
          departure.reason,
        );
      }
    }

    const jointChannelIds = channelRows.filter((channel) => channel.type !== "thread").map((channel) => channel.id);
    if (jointChannelIds.length > 0 && userIds.length > 0) {
      const jointMemberRows = await traceQuery(
        "messages.senders.joint_channel_members",
        () => db
          .select({
            canonicalChannelId: jointChannels.canonicalChannelId,
            localChannelId: jointChannelServers.localChannelId,
            userId: channelHumans.userId,
          })
          .from(jointChannels)
          .innerJoin(jointChannelServers, and(
            eq(jointChannelServers.jointChannelId, jointChannels.id),
            eq(jointChannelServers.status, "active"),
          ))
          .innerJoin(channelHumans, and(
            eq(channelHumans.channelId, jointChannelServers.localChannelId),
            inArray(channelHumans.userId, userIds),
          ))
          .where(and(
            inArray(jointChannels.canonicalChannelId, jointChannelIds),
            eq(jointChannels.status, "active"),
          )),
        () => ({ input_count: userIds.length, joint_channel_count: jointChannelIds.length }),
      );
      for (const membership of jointMemberRows) {
        jointMembershipChannelIds.add(membership.canonicalChannelId);
        jointMembershipChannelIds.add(membership.localChannelId);
        activeJointMemberKeys.add(`${membership.canonicalChannelId}:${membership.userId}`);
        activeJointMemberKeys.add(`${membership.localChannelId}:${membership.userId}`);
      }
    }

    const threadChannelIds = channelRows.filter((channel) => channel.type === "thread").map((channel) => channel.id);
    if (threadChannelIds.length > 0 && userIds.length > 0) {
      const canonicalThreadChannels = alias(channels, "canonical_thread_channels");
      const parentMessages = alias(messages, "joint_thread_parent_messages");
      const parentJointChannels = alias(jointChannels, "parent_joint_channels");
      const parentJointChannelServers = alias(jointChannelServers, "parent_joint_channel_servers");
      const jointThreadMemberRows = await traceQuery(
        "messages.senders.joint_thread_parent_members",
        () => db
          .select({
            canonicalThreadChannelId: jointChannels.canonicalChannelId,
            localParentChannelId: parentJointChannelServers.localChannelId,
            userId: channelHumans.userId,
          })
          .from(jointChannels)
          .innerJoin(canonicalThreadChannels, and(
            eq(canonicalThreadChannels.id, jointChannels.canonicalChannelId),
            eq(canonicalThreadChannels.type, "thread"),
            isNull(canonicalThreadChannels.deletedAt),
          ))
          .innerJoin(parentMessages, eq(parentMessages.id, canonicalThreadChannels.parentMessageId))
          .innerJoin(parentJointChannels, and(
            eq(parentJointChannels.canonicalChannelId, parentMessages.channelId),
            eq(parentJointChannels.status, "active"),
          ))
          .innerJoin(parentJointChannelServers, and(
            eq(parentJointChannelServers.jointChannelId, parentJointChannels.id),
            eq(parentJointChannelServers.status, "active"),
          ))
          .innerJoin(channelHumans, and(
            eq(channelHumans.channelId, parentJointChannelServers.localChannelId),
            inArray(channelHumans.userId, userIds),
          ))
          .where(and(
            inArray(jointChannels.canonicalChannelId, threadChannelIds),
            eq(jointChannels.status, "active"),
          )),
        () => ({ input_count: userIds.length, thread_channel_count: threadChannelIds.length }),
      );
      for (const membership of jointThreadMemberRows) {
        jointMembershipChannelIds.add(membership.canonicalThreadChannelId);
        activeJointMemberKeys.add(`${membership.canonicalThreadChannelId}:${membership.userId}`);
        activeJointMemberKeys.add(`${membership.localParentChannelId}:${membership.userId}`);
      }
    }
  }

  if (agentIds.length > 0) {
    const agentRows = await traceQuery(
      "messages.senders.agent_profiles",
      () => db
        .select({ id: agents.id, name: agents.name, displayName: agents.displayName, description: agents.description })
        .from(agents)
        .where(inArray(agents.id, agentIds)),
      () => ({ input_count: agentIds.length }),
    );
    for (const a of agentRows) {
      nameMap.set(a.id, a.displayName || a.name);
      handleMap.set(a.id, a.name);
      descriptionMap.set(a.id, a.description || null);
    }
  }

  // Batch-fetch attachments for all messages
  const attachmentMap = await traceQuery(
    "messages.attachments_by_messages",
    () => getAttachmentsForMessages(messageIds),
    (result) => ({
      input_count: rows.length,
      attachments_count: [...result.values()].reduce((sum, list) => sum + list.length, 0),
    }),
  );

  // Attachment-comment enrichment (attachment-comments MVP spec §5): per-
  // Attachment comment counts power the chip badges, and a per-message ref
  // marks scoped comments so thread views can render the `re: filename` chip.
  // Two grouped queries for the whole batch — no per-message fan-out.
  //
  // Feature flag gate: servers outside the gate must not OBSERVE scoped-comment
  // metadata either — CLI/API message readers would otherwise see counts/refs
  // while the dedicated comment routes 403. Each batch channel resolves to its
  // server once and, for human API callers, evaluates with the viewer user id
  // so user deny rules hide the same metadata the dedicated routes block.
  // Messages on non-enabled (or unresolvable — fail closed) servers are
  // excluded from both queries, so their attachments keep commentCount 0 and
  // their messages commentRef null.
  const allChannelIds = [...new Set(rows.map((m) => m.channelId))];
  const gateRows = await traceQuery(
    "messages.attachment_comment_gate",
    () => db
      .select({ channelId: channels.id, serverId: servers.id })
      .from(channels)
      .innerJoin(servers, eq(servers.id, channels.serverId))
      .where(inArray(channels.id, allChannelIds)),
    () => ({ input_count: allChannelIds.length }),
  );
  const commentEnabledServerIds = new Set<string>();
  for (const serverId of [...new Set(gateRows.map((row) => row.serverId))]) {
    const evaluation = await evaluateFeatureFlag({
      key: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
      serverId,
      userId: opts.attachmentCommentViewerUserId ?? undefined,
    });
    if (evaluation.enabled) commentEnabledServerIds.add(serverId);
  }
  const commentEnabledChannelIds = new Set(
    gateRows
      .filter((row) => commentEnabledServerIds.has(row.serverId))
      .map((row) => row.channelId),
  );
  const commentEnabledMessageIds = new Set(
    rows.filter((m) => commentEnabledChannelIds.has(m.channelId)).map((m) => m.id),
  );

  const allAttachmentIds = [...attachmentMap.entries()]
    .filter(([messageId]) => commentEnabledMessageIds.has(messageId))
    .flatMap(([, list]) => list.map((a) => a.id));
  const commentCountMap = new Map<string, number>();
  if (allAttachmentIds.length > 0) {
    const countRows = await traceQuery(
      "messages.attachment_comment_counts",
      () => db
        .select({
          attachmentId: attachmentCommentRefs.attachmentId,
          count: sql<number>`count(*)::int`,
        })
        .from(attachmentCommentRefs)
        .where(inArray(attachmentCommentRefs.attachmentId, allAttachmentIds))
        .groupBy(attachmentCommentRefs.attachmentId),
      (result) => ({ input_count: allAttachmentIds.length, counted: result.length }),
    );
    for (const row of countRows) commentCountMap.set(row.attachmentId, row.count);
  }
  // Host coordinates for the re: chip's jump-to-message (cindyz 6/11; shape
  // per Dozy #wg-comment:e1d63fee): hostSource.channelId is ALWAYS the route
  // channel — for thread-hosted attachments that is the PARENT channel (the
  // raw attachments.channel_id would be the thread channel, which
  // nav.toThreadMessage cannot route by). routeKind spares the client a
  // channel-store lookup for the dm-vs-channel route split. Same joined
  // query — no page-load query-shape change.
  type CommentRefHostSource = {
    type: "channel" | "thread";
    routeKind: "channel" | "dm";
    channelId: string;
    parentMessageId?: string;
    threadChannelId?: string;
    // Set when the host is a TOP-LEVEL message that is itself a thread root
    // (has an active thread). The re: chip should open that thread rather than
    // locate the closed-state message (cindyz #32). Distinct from threadChannelId
    // (which is the thread a thread-HOSTED attachment lives in).
    rootThreadChannelId?: string;
  };
  const commentRefMap = new Map<
    string,
    {
      attachmentId: string;
      filename: string;
      hostMessageId: string | null;
      hostSource: CommentRefHostSource | null;
      /** Compact anchor location label (task #37) — agents and clients can
       *  show WHERE the comment points without the raw anchor payload. */
      anchorLabel: string | null;
      /** Full quoted text from the anchor — untruncated for client quote blocks. */
      anchorQuote: string | null;
    }
  >();
  const commentRefMessageIds = messageIds.filter((messageId) => commentEnabledMessageIds.has(messageId));
  if (commentRefMessageIds.length > 0) {
    const hostChannels = alias(channels, "comment_ref_host_channels");
    const hostParentMessages = alias(messages, "comment_ref_host_parent_messages");
    const hostParentChannels = alias(channels, "comment_ref_host_parent_channels");
    // The active thread that hangs off the host message itself, if any — i.e.
    // the host top-level message IS a thread root (cindyz #32). At most one row
    // per host: idx_channels_active_thread_parent is unique on parent_message_id
    // where type='thread' and not deleted, so this leftJoin cannot fan out.
    const hostChildThreadChannels = alias(channels, "comment_ref_host_child_thread_channels");
    const refRows = await traceQuery(
      "messages.attachment_comment_refs",
      () => db
        .select({
          commentMessageId: attachmentCommentRefs.commentMessageId,
          attachmentId: attachmentCommentRefs.attachmentId,
          anchorType: attachmentCommentRefs.anchorType,
          anchorData: attachmentCommentRefs.anchorData,
          filename: attachments.filename,
          hostMessageId: attachments.messageId,
          hostChannelId: attachments.channelId,
          hostChannelType: hostChannels.type,
          hostParentMessageId: hostChannels.parentMessageId,
          hostParentChannelId: hostParentMessages.channelId,
          hostParentChannelType: hostParentChannels.type,
          hostChildThreadChannelId: hostChildThreadChannels.id,
        })
        .from(attachmentCommentRefs)
        .innerJoin(attachments, eq(attachments.id, attachmentCommentRefs.attachmentId))
        .innerJoin(hostChannels, eq(hostChannels.id, attachments.channelId))
        .leftJoin(hostParentMessages, eq(hostParentMessages.id, hostChannels.parentMessageId))
        .leftJoin(hostParentChannels, eq(hostParentChannels.id, hostParentMessages.channelId))
        .leftJoin(hostChildThreadChannels, and(
          eq(hostChildThreadChannels.parentMessageId, attachments.messageId),
          eq(hostChildThreadChannels.type, "thread"),
          isNull(hostChildThreadChannels.deletedAt),
        ))
        .where(inArray(attachmentCommentRefs.commentMessageId, commentRefMessageIds)),
      (result) => ({ input_count: commentRefMessageIds.length, refs: result.length }),
    );
    for (const row of refRows) {
      const isThreadHosted = row.hostChannelType === "thread";
      let hostSource: CommentRefHostSource | null;
      if (isThreadHosted) {
        // Route through the parent channel; missing parent rows (shouldn't
        // happen for live threads) degrade to no jump rather than a wrong one.
        hostSource = row.hostParentChannelId && row.hostParentMessageId
          ? {
              type: "thread",
              routeKind: row.hostParentChannelType === "dm" ? "dm" : "channel",
              channelId: row.hostParentChannelId,
              parentMessageId: row.hostParentMessageId,
              threadChannelId: row.hostChannelId,
            }
          : null;
      } else {
        hostSource = {
          type: "channel",
          routeKind: row.hostChannelType === "dm" ? "dm" : "channel",
          channelId: row.hostChannelId,
          // Host top-level message is itself a thread root → re: chip opens the
          // thread expanded instead of locating the closed-state message (#32).
          ...(row.hostChildThreadChannelId ? { rootThreadChannelId: row.hostChildThreadChannelId } : {}),
        };
      }
      const anchorData = row.anchorData as Record<string, unknown> | null;
      const rawQuote = anchorData && typeof anchorData.quote === "string" ? anchorData.quote.trim() : null;
      commentRefMap.set(row.commentMessageId, {
        attachmentId: row.attachmentId,
        filename: normalizeAttachmentFilename(row.filename),
        hostMessageId: row.hostMessageId,
        hostSource,
        anchorLabel: renderAnchorLabel(row.anchorType, row.anchorData),
        anchorQuote: rawQuote || null,
      });
    }
  }

  return Promise.all(rows.map(async msg => {
    const externalAuthor = externalAuthorMap.get(msg.id) ?? null;
    return projectForwardDestinationMessage({
    ...msg,
    actionMetadata: await scrubForwardedBundleMetadataForViewer(
      "actionMetadata" in msg ? msg.actionMetadata : undefined,
      resolveForwardedBundleViewer(opts),
    ),
    commentRef: commentRefMap.get(msg.id) ?? null,
    senderName: externalAuthor?.displayName ?? nameMap.get(msg.senderId) ?? "Unknown",
    senderHandle: externalAuthor?.displayName
      ?? handleMap.get(msg.senderId)
      ?? nameMap.get(msg.senderId)
      ?? "Unknown",
    senderDescription: externalAuthor ? null : descriptionMap.get(msg.senderId) || null,
    externalAuthor,
    taskAssigneeName: msg.taskAssigneeId ? handleMap.get(msg.taskAssigneeId) || null : null,
    senderMembershipStatus:
      msg.senderType === "user" && msg.messageType !== "system"
        ? (
            channelTypeMap.get(msg.channelId) === "joint"
              || jointMembershipChannelIds.has(msg.channelId)
              ? (activeJointMemberKeys.has(`${msg.channelId}:${msg.senderId}`) ? "active" : "removed")
              : (() => {
                  const memberKey = `${channelServerMap.get(msg.channelId) ?? ""}:${msg.senderId}`;
                  return activeMemberKeys.has(memberKey)
                    ? "active"
                    : (departureReasonByMemberKey.get(memberKey) ?? "removed");
                })()
          )
        : null,
    reactions: reactionMap.get(msg.id) ?? [],
    mentions: mentionMap.get(msg.id) ?? [],
    attachments: (attachmentMap.get(msg.id) ?? []).map(a => ({
      id: a.id,
      filename: normalizeAttachmentFilename(a.filename),
      mimeType: resolveAttachmentMimeType(a.filename, a.mimeType),
      sizeBytes: a.sizeBytes,
      width: a.width,
      height: a.height,
      thumbnailUrl: getThumbnailUrl(a.thumbnailKey),
      commentCount: commentCountMap.get(a.id) ?? 0,
    })),
    });
  }));
}

/**
 * Publishes a provider-origin message only after its dedicated inbound
 * transaction commits. History remains authoritative; this is the live UI
 * acceleration path equivalent to the ordinary send pipeline.
 */
export async function emitExternalProjectionMessageToFrontend(
  io: SocketServer,
  messageId: string,
): Promise<void> {
  const db = getDb();
  const [message] = await db.select().from(messages).where(and(
    eq(messages.id, messageId),
    eq(messages.senderType, "external_projection"),
  )).limit(1);
  if (!message || message.senderType !== "external_projection") {
    throw new Error("Committed external projection message is unavailable");
  }
  const [enriched] = await enrichWithSenderNames([message]);
  if (!enriched?.externalAuthor) {
    throw new Error("Committed external projection author is unavailable");
  }

  const deps = resolveMessageServiceDeps();
  const channel = await deps.getChannel(message.channelId);
  let topology: SlackBridgeOutboundPipelineTopology = "missing";
  if (channel?.type === "thread") {
    const projections = await deps.getActiveJointThreadProjectionsByCanonicalThread(message.channelId);
    topology = projections.length > 0 ? "joint_thread" : "ordinary_thread";
  } else if (channel) {
    const projections = await deps.getActiveJointChannelProjectionsByLocalChannel(message.channelId);
    topology = projections.length > 0 || channel.type === "joint"
      ? "joint_channel"
      : channel.type === "dm"
        ? "dm"
        : "ordinary_channel";
  }

  await emitPersistedMessageToFrontend(io, {
    channelId: message.channelId,
    senderType: message.senderType,
    senderId: message.senderId,
    message,
    enriched: { ...enriched, senderMembershipStatus: null },
    topology,
    onSocketEmitFailure: ({ phase, topology: failedTopology }) => {
      addTraceEvent("external_inbound.frontend_socket_emit.degraded", {
        phase,
        topology: failedTopology,
        persistence_state: "durable",
        failure_policy: "continue_from_persisted_state",
        sender_type: "external_projection",
      });
    },
  });
}

/**
 * Publishes a durable provider-origin reaction change as a merge-only update.
 * Unlike the initial message emitter this must not replay unread/activity side
 * effects, and it must project the canonical row into every active Joint/local
 * conversation before broadcasting.
 */
export async function emitExternalReactionMessageUpdateToFrontend(
  io: SocketServer,
  messageId: string,
): Promise<void> {
  const db = getDb();
  const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!message) throw new Error("Updated Slack-linked message is unavailable");
  const context = await getMessageContext(message.id, 0, 0);
  const enriched = context?.messages[0];
  if (!enriched) throw new Error("Updated Slack-linked message context is unavailable");

  const storageChannel = await channelService.getChannel(message.channelId);
  if (!storageChannel) throw new Error("Updated external projection channel is unavailable");
  const targets = new Map<string, {
    localChannelId: string;
    serverId: string;
    conversationContext: FrontendConversationContext;
  }>();
  if (storageChannel.type === "thread") {
    const projections = await channelService.getActiveJointThreadProjectionsByCanonicalThread(message.channelId);
    for (const projection of projections) {
      const localParent = await channelService.getChannel(projection.localParentChannelId);
      targets.set(projection.localThreadChannelId, {
        localChannelId: projection.localThreadChannelId,
        serverId: projection.localServerId,
        conversationContext: buildFrontendConversationContext({
          channelType: "thread",
          parentMessageId: projection.canonicalParentMessageId,
          parentChannel: localParent,
        }),
      });
    }
  } else {
    const projections = await channelService.getActiveJointChannelProjectionsByLocalChannel(message.channelId);
    for (const projection of projections) {
      targets.set(projection.localChannelId, {
        localChannelId: projection.localChannelId,
        serverId: projection.serverId,
        conversationContext: buildFrontendConversationContext({ channelType: "joint" }),
      });
    }
  }
  if (targets.size === 0) {
    let conversationContext = buildFrontendConversationContext({ channelType: storageChannel.type });
    if (storageChannel.type === "thread" && storageChannel.parentMessageId) {
      const [parentMessage] = await db.select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, storageChannel.parentMessageId))
        .limit(1);
      const parentChannel = parentMessage
        ? await channelService.getChannel(parentMessage.channelId)
        : null;
      conversationContext = buildFrontendConversationContext({
        channelType: "thread",
        parentMessageId: storageChannel.parentMessageId,
        parentChannel,
      });
    }
    targets.set(message.channelId, {
      localChannelId: message.channelId,
      serverId: storageChannel.serverId,
      conversationContext,
    });
  }

  for (const target of targets.values()) {
    const localChannel = target.localChannelId === message.channelId
      ? storageChannel
      : await channelService.getChannel(target.localChannelId);
    const projected = target.localChannelId === message.channelId
      ? enriched
      : localChannel?.type === "joint"
        ? (await projectJointMessagesToLocalChannel(
            [enriched],
            target.localChannelId,
            target.serverId,
          ))[0] ?? enriched
        : (await projectMessagesToChannel([enriched], target.localChannelId))[0] ?? enriched;
    const broadcastProjected = sanitizeForwardedBundleMetadataForBroadcast(projected);
    // message-realtime-producer: message-service.external-reaction.updated
    io.to(`channel:${target.localChannelId}`).emit(
      "message:updated",
      projectRichMessageSocketPayload(withFrontendConversationContext(
        stripViewerScopedAttachmentCommentMetadata(broadcastProjected),
        target.conversationContext,
      )),
    );
  }
}

export type EnrichedMessageRow = Awaited<ReturnType<typeof listMessages>>[number];
type ThreadJoinContextBase = Pick<
  AgentThreadJoinContext,
  "reason" | "parent_message" | "recent_messages" | "history_truncated"
>;

export function stripViewerScopedAttachmentCommentMetadata<T extends Record<string, unknown>>(message: T): T {
  const stripped: Record<string, unknown> = {
    ...message,
    commentRef: null,
  };
  if (Array.isArray(message.attachments)) {
    stripped.attachments = message.attachments.map((attachment) =>
      attachment && typeof attachment === "object"
        ? { ...attachment, commentCount: 0 }
        : attachment
    );
  }
  return stripped as T;
}

function toThreadContextMessage(message: EnrichedMessageRow): AgentThreadContextMessage {
  // Scoped attachment comments carry their scope line into agent thread
  // context (task #37): same projection as the live delivery, so an agent
  // joining late reads what an agent present at creation read. Outside the
  // feature flag gate, commentRef is suppressed at enrichment (F11) — nothing to
  // render, nothing leaks.
  const ref = message.commentRef;
  const scopeLine = ref
    ? (ref.anchorLabel ? `[re: ${ref.filename} · ${ref.anchorLabel}]` : `[re: ${ref.filename}]`)
    : null;
  const quoteLine = ref?.anchorQuote ? `> ${ref.anchorQuote}` : null;
  const scopedContent = scopeLine
    ? [scopeLine, quoteLine, message.content].filter(Boolean).join("\n")
    : message.content;
  return {
    message_id: message.id,
    sender_name: message.senderHandle ?? message.senderName,
    sender_description: message.senderDescription || null,
    sender_type: toAgentVisibleSenderType(message.senderType, message.messageType),
    ...toAgentVisibleExternalMessage(message),
    content: renderAgentVisibleMessageContent(message, scopedContent),
    timestamp: message.createdAt.toISOString(),
    seq: message.seq,
  };
}

async function buildThreadJoinContextBase(
  threadChannelId: string,
  parentMessageId: string,
  beforeSeq: number,
): Promise<ThreadJoinContextBase | undefined> {
  // First-time thread entrants miss the semantic anchor completely if we only
  // deliver the triggering @mention, so we always include the parent/root message.
  const parentContext = await getMessageContext(parentMessageId, 0, 0);
  const parentMessage = parentContext?.messages[0];
  if (!parentMessage) return undefined;

  // Keep the window intentionally small: the goal is to prevent blind replies,
  // not to silently inject the full thread backlog into every delivery.
  const recentWindow = await listMessages(
    threadChannelId,
    THREAD_JOIN_CONTEXT_WINDOW + 1,
    beforeSeq,
  );
  const historyTruncated = recentWindow.length > THREAD_JOIN_CONTEXT_WINDOW;
  const recentMessages = historyTruncated
    ? recentWindow.slice(recentWindow.length - THREAD_JOIN_CONTEXT_WINDOW)
    : recentWindow;

  return {
    reason: "mentioned",
    parent_message: toThreadContextMessage(parentMessage),
    recent_messages: recentMessages.map(toThreadContextMessage),
    history_truncated: historyTruncated,
  };
}

export async function getMessage(messageId: string) {
  const db = getDb();
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
  return msg || null;
}

/**
 * Does a message with this short id live in THIS channel?
 *
 * Deliberately scoped to one channel rather than the server. `#channel:shortid`
 * is only ever a thread of that channel, so a short id belonging somewhere else
 * is simply not this target's anchor -- and answering that question globally
 * would build a cross-channel enumeration surface the caller never had, plus a
 * permission side-channel in whatever we said about the other channel.
 * @Tenny's ruling on task #145.
 *
 * Callers must already have resolved `channelId` as visible to the actor; this
 * function performs no access check of its own.
 */
export async function messageShortIdExistsInChannel(
  channelId: string,
  shortId: string,
): Promise<boolean> {
  if (!isMessageShortId(shortId)) return false;
  const db = getDb();
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.channelId, channelId), ...messageIdShortPrefixConditions(shortId)))
    .limit(1);
  return Boolean(row);
}

export async function resolveMessageIdInServer(
  serverId: string,
  idOrShortId: string,
): Promise<
  | { ok: true; messageId: string }
  | { ok: false; status: 400 | 404; error: string }
> {
  const value = idOrShortId.trim();
  const db = getDb();

  if (isMessageShortId(value)) {
    const conditions = [
      sql`(${channels.serverId} = ${serverId} OR ${jointChannelServers.serverId} = ${serverId})`,
      ...messageIdShortPrefixConditions(value),
    ];

    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .leftJoin(jointChannels, and(
        eq(jointChannels.canonicalChannelId, messages.channelId),
        eq(jointChannels.status, "active"),
      ))
      .leftJoin(jointChannelServers, and(
        eq(jointChannelServers.jointChannelId, jointChannels.id),
        eq(jointChannelServers.serverId, serverId),
        eq(jointChannelServers.status, "active"),
      ))
      .where(and(...conditions))
      .limit(2);
    if (rows.length === 1) return { ok: true, messageId: rows[0].id };
    if (rows.length === 0) return { ok: false, status: 404, error: "Message not found" };
    return { ok: false, status: 400, error: "Message short id is ambiguous" };
  }

  if (!UUID_RE.test(value)) {
    return { ok: false, status: 400, error: "Message id must be a full UUID or 8-character short id" };
  }

  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .leftJoin(jointChannels, and(
      eq(jointChannels.canonicalChannelId, messages.channelId),
      eq(jointChannels.status, "active"),
    ))
    .leftJoin(jointChannelServers, and(
      eq(jointChannelServers.jointChannelId, jointChannels.id),
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.status, "active"),
    ))
    .where(and(
      sql`(${channels.serverId} = ${serverId} OR ${jointChannelServers.serverId} = ${serverId})`,
      eq(messages.id, value),
    ))
    .limit(1);

  if (!row) return { ok: false, status: 404, error: "Message not found" };
  return { ok: true, messageId: row.id };
}

export async function resolveMessageIdVisibleToAgent(
  serverId: string,
  agentId: string,
  idOrShortId: string,
): Promise<
  | { ok: true; messageId: string }
  | { ok: false; status: 400 | 404; error: string }
> {
  return resolveMessageIdVisibleInServer(serverId, idOrShortId, (channelId) =>
    canActorAccessMessageChannel(channelId, serverId, (localChannelId) =>
      channelService.canAgentAccessChannel(localChannelId, agentId),
    ),
  );
}

export async function resolveMessageIdVisibleToUser(
  serverId: string,
  userId: string,
  idOrShortId: string,
): Promise<
  | { ok: true; messageId: string }
  | { ok: false; status: 400 | 404; error: string }
> {
  return resolveMessageIdVisibleInServer(serverId, idOrShortId, (channelId) =>
    canActorAccessMessageChannel(channelId, serverId, (localChannelId) =>
      channelService.canUserAccessChannel(localChannelId, userId, serverId as ServerId),
    ),
  );
}

async function resolveMessageIdVisibleInServer(
  serverId: string,
  idOrShortId: string,
  canAccessChannel: (channelId: string) => Promise<boolean>,
): Promise<
  | { ok: true; messageId: string }
  | { ok: false; status: 400 | 404; error: string }
> {
  const value = idOrShortId.trim();
  const db = getDb();

  const baseConditions = [
    sql`(${channels.serverId} = ${serverId} OR ${jointChannelServers.serverId} = ${serverId})`,
  ];
  if (isMessageShortId(value)) {
    baseConditions.push(...messageIdShortPrefixConditions(value));
  } else {
    if (!UUID_RE.test(value)) {
      return { ok: false, status: 400, error: "Message id must be a full UUID or 8-character short id" };
    }
    baseConditions.push(eq(messages.id, value));
  }

  const candidates = await db
    .select({ id: messages.id, channelId: messages.channelId })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .leftJoin(jointChannels, and(
      eq(jointChannels.canonicalChannelId, messages.channelId),
      eq(jointChannels.status, "active"),
    ))
    .leftJoin(jointChannelServers, and(
      eq(jointChannelServers.jointChannelId, jointChannels.id),
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.status, "active"),
    ))
    .where(and(...baseConditions));

  const visible: Array<{ id: string }> = [];
  for (const candidate of candidates) {
    if (await canAccessChannel(candidate.channelId)) {
      visible.push(candidate);
      if (visible.length > 1) break;
    }
  }

  if (visible.length === 1) return { ok: true, messageId: visible[0].id };
  if (visible.length === 0) return { ok: false, status: 404, error: "Message not found" };
  return { ok: false, status: 400, error: "Message short id is ambiguous" };
}

async function canActorAccessMessageChannel(
  canonicalChannelId: string,
  serverId: string,
  canAccessLocalChannel: (localChannelId: string) => Promise<boolean>,
): Promise<boolean> {
  const channel = await channelService.getChannel(canonicalChannelId);
  if (!channel) return false;

  let localChannelId = canonicalChannelId;
  if (channel.serverId !== serverId) {
    if (channel.type === "thread") {
      const localThreadProjection = (await channelService.getActiveJointThreadProjectionsByCanonicalThread(canonicalChannelId))
        .find((projection) => projection.localServerId === serverId);
      localChannelId = localThreadProjection?.localThreadChannelId ?? "";
    } else {
      const localChannelProjection = (await channelService.getActiveJointChannelProjectionsByLocalChannel(canonicalChannelId))
        .find((projection) => projection.serverId === serverId);
      localChannelId = localChannelProjection?.localChannelId ?? "";
    }
  }

  return localChannelId ? canAccessLocalChannel(localChannelId) : false;
}

export async function getMessageContext(
  messageId: string,
  before = 15,
  after = 15,
  historyCutoff?: Date,
  opts: MessageQueryTraceOptions = {},
) {
  const db = getDb();
  const targetConditions = [eq(messages.id, messageId)];
  if (historyCutoff) {
    targetConditions.push(gt(messages.createdAt, historyCutoff));
  }
  const [target] = await db.select().from(messages).where(and(...targetConditions)).limit(1);
  if (!target) return null;

  const previousConditions = [eq(messages.channelId, target.channelId), lt(messages.seq, target.seq)];
  if (historyCutoff) {
    const cutoffSeq = await getHistoryCutoffSeq(target.channelId, historyCutoff);
    if (cutoffSeq !== null) {
      previousConditions.push(gte(messages.seq, cutoffSeq));
    }
    previousConditions.push(gt(messages.createdAt, historyCutoff));
  }
  const previousRows = await db
    .select()
    .from(messages)
    .where(and(...previousConditions))
    .orderBy(desc(messages.seq))
    .limit(before + 1);

  const nextConditions = [eq(messages.channelId, target.channelId), gt(messages.seq, target.seq)];
  if (historyCutoff) {
    nextConditions.push(gt(messages.createdAt, historyCutoff));
  }
  const nextRows = await db
    .select()
    .from(messages)
    .where(and(...nextConditions))
    .orderBy(messages.seq)
    .limit(after + 1);

  const hasOlder = previousRows.length > before;
  const hasNewer = nextRows.length > after;
  const selectedPrevious = previousRows.slice(0, before).reverse();
  const selectedNext = nextRows.slice(0, after);
  const contextRows = [...selectedPrevious, target, ...selectedNext];

  return {
    channelId: target.channelId,
    targetMessageId: target.id,
    hasOlder,
    hasNewer,
    messages: await enrichWithSenderNames(contextRows, opts),
  };
}

async function getHistoryCutoffSeq(channelId: string, historyCutoff: Date): Promise<number | null> {
  const db = getDb();
  const [row] = await db
    .select({ cutoffSeq: sql<number | null>`MIN(${messages.seq})::bigint` })
    .from(messages)
    .where(and(eq(messages.channelId, channelId), gt(messages.createdAt, historyCutoff)));
  const cutoffSeq = row?.cutoffSeq;
  if (cutoffSeq == null) return null;
  return typeof cutoffSeq === "number" ? cutoffSeq : Number(cutoffSeq);
}

export async function getMessageContextInChannel(
  channelId: string,
  messageId: string,
  before = 15,
  after = 15,
  historyCutoff?: Date,
  opts: MessageQueryTraceOptions = {},
) {
  const db = getDb();
  const conditions = [eq(messages.channelId, channelId), eq(messages.id, messageId)];
  if (historyCutoff) {
    conditions.push(gt(messages.createdAt, historyCutoff));
  }
  const [target] = await db.select({ id: messages.id }).from(messages).where(and(...conditions)).limit(1);
  if (!target) return null;
  return getMessageContext(target.id, before, after, historyCutoff, opts);
}

export async function getThreadReplyContextForParentChannel(
  parentChannelId: string,
  replyMessageId: string,
  before = 15,
  after = 15,
  historyCutoff?: Date,
  opts: MessageQueryTraceOptions = {},
) {
  const db = getDb();
  const threadChannels = alias(channels, "thread_channels");
  const parentMessages = alias(messages, "parent_messages");
  const conditions = [
    eq(messages.id, replyMessageId),
    eq(threadChannels.type, "thread"),
    eq(parentMessages.channelId, parentChannelId),
  ];
  if (historyCutoff) {
    conditions.push(gt(messages.createdAt, historyCutoff));
  }
  const [target] = await db
    .select({
      replyMessageId: messages.id,
      threadChannelId: threadChannels.id,
      parentMessageId: parentMessages.id,
    })
    .from(messages)
    .innerJoin(threadChannels, eq(threadChannels.id, messages.channelId))
    .innerJoin(parentMessages, eq(parentMessages.id, threadChannels.parentMessageId))
    .where(and(...conditions))
    .limit(1);
  if (!target) return null;

  const context = await getMessageContext(target.replyMessageId, before, after, historyCutoff, opts);
  if (!context) return null;
  return {
    ...context,
    canonicalTarget: {
      kind: "thread" as const,
      channelId: parentChannelId,
      messageId: target.replyMessageId,
      threadParentMessageId: target.parentMessageId,
      threadChannelId: target.threadChannelId,
    },
  };
}

export async function getThreadReplyContextByShortIdForParentChannel(
  parentChannelId: string,
  shortId: string,
  before = 15,
  after = 15,
  historyCutoff?: Date,
  opts: MessageQueryTraceOptions = {},
) {
  const db = getDb();
  const threadChannels = alias(channels, "thread_channels");
  const parentMessages = alias(messages, "parent_messages");
  const conditions = [
    ...messageIdShortPrefixConditions(shortId),
    eq(threadChannels.type, "thread"),
    eq(parentMessages.channelId, parentChannelId),
  ];
  if (historyCutoff) {
    conditions.push(gt(messages.createdAt, historyCutoff));
  }
  const targets = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(threadChannels, eq(threadChannels.id, messages.channelId))
    .innerJoin(parentMessages, eq(parentMessages.id, threadChannels.parentMessageId))
    .where(and(...conditions))
    .limit(2);
  if (targets.length !== 1) return null;
  return getThreadReplyContextForParentChannel(parentChannelId, targets[0].id, before, after, historyCutoff, opts);
}

export async function getThreadParentContextByThreadChannelIdForParentChannel(
  parentChannelId: string,
  threadChannelIdOrShortId: string,
  before = 15,
  after = 15,
  historyCutoff?: Date,
  opts: MessageQueryTraceOptions = {},
) {
  const value = threadChannelIdOrShortId.trim();
  if (!UUID_RE.test(value) && !isMessageShortId(value)) return null;

  const db = getDb();
  const threadChannels = alias(channels, "thread_channels");
  const parentMessages = alias(messages, "parent_messages");
  const threadIdConditions = UUID_RE.test(value)
    ? [eq(threadChannels.id, value)]
    : (() => {
        const bounds = uuidShortIdRange(value);
        return [
          gte(threadChannels.id, bounds.lower),
          ...(bounds.upper ? [lt(threadChannels.id, bounds.upper)] : []),
        ];
      })();

  const targets = await db
    .select({
      parentMessageId: parentMessages.id,
    })
    .from(threadChannels)
    .innerJoin(parentMessages, eq(parentMessages.id, threadChannels.parentMessageId))
    .where(and(
      ...threadIdConditions,
      eq(threadChannels.type, "thread"),
      eq(parentMessages.channelId, parentChannelId),
      isNull(threadChannels.deletedAt),
    ))
    .limit(2);
  if (targets.length !== 1) return null;
  return getMessageContextInChannel(parentChannelId, targets[0].parentMessageId, before, after, historyCutoff, opts);
}

export async function getMessageContextBySeq(
  channelId: string,
  seq: number,
  before = 15,
  after = 15,
  historyCutoff?: Date,
  opts: MessageQueryTraceOptions = {},
) {
  const db = getDb();
  const conditions = [eq(messages.channelId, channelId), eq(messages.seq, seq)];
  if (historyCutoff) {
    conditions.push(gt(messages.createdAt, historyCutoff));
  }
  const [target] = await db.select({ id: messages.id }).from(messages).where(and(...conditions)).limit(1);
  if (!target) return null;
  return getMessageContext(target.id, before, after, historyCutoff, opts);
}

export async function getMessageContextByShortId(
  channelId: string,
  shortId: string,
  before = 15,
  after = 15,
  historyCutoff?: Date,
  opts: MessageQueryTraceOptions = {},
) {
  if (!isMessageShortId(shortId)) return null;

  const db = getDb();
  const conditions = [
    eq(messages.channelId, channelId),
    ...messageIdShortPrefixConditions(shortId),
  ];
  if (historyCutoff) {
    conditions.push(gt(messages.createdAt, historyCutoff));
  }

  const targets = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(...conditions))
    .limit(2);

  if (targets.length !== 1) return null;
  return getMessageContext(targets[0].id, before, after, historyCutoff, opts);
}

export type MessageSeqAnchorResolution =
  | { ok: true; seq: number }
  | { ok: false; reason: "not_found" | "ambiguous" };

export type MessageSeqAnchorPurpose = "pagination" | "around";

export async function resolveMessageSeqAnchor(
  channelId: string,
  anchor: string,
  purpose: MessageSeqAnchorPurpose,
  historyCutoff?: Date,
): Promise<MessageSeqAnchorResolution> {
  // Pagination emits numeric seq cursors, so decimal-only values must remain
  // seqs even when they reach the 8-character short-id width. `around` is a
  // locator instead: preserve the short-id-first behavior used by message
  // links, including UUIDs whose first eight characters happen to be digits.
  if (purpose === "pagination" && /^\d+$/.test(anchor)) {
    return { ok: true, seq: Number(anchor) };
  }

  const db = getDb();
  const conditions = [eq(messages.channelId, channelId)];
  if (isMessageShortId(anchor)) {
    conditions.push(...messageIdShortPrefixConditions(anchor));
  } else if (/^\d+$/.test(anchor)) {
    return { ok: true, seq: Number(anchor) };
  } else {
    if (!UUID_RE.test(anchor)) return { ok: false, reason: "not_found" };
    conditions.push(sql`${messages.id}::text = ${anchor.toLowerCase()}`);
  }
  if (historyCutoff) {
    conditions.push(gt(messages.createdAt, historyCutoff));
  }

  const targets = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(and(...conditions))
    .limit(2);

  if (targets.length === 0) return { ok: false, reason: "not_found" };
  if (targets.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, seq: targets[0].seq };
}

export async function listMessages(
  channelId: string,
  limit = 50,
  beforeSeq?: number,
  afterSeq?: number,
  historyCutoff?: Date,
  opts: MessageQueryTraceOptions = {},
) {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const conditions = [eq(messages.channelId, channelId)];
  if (beforeSeq !== undefined) {
    conditions.push(lt(messages.seq, beforeSeq));
  }
  if (afterSeq !== undefined) {
    conditions.push(gt(messages.seq, afterSeq));
  }
  if (historyCutoff) {
    conditions.push(gt(messages.createdAt, historyCutoff));
  }
  if (opts.excludeSender) {
    conditions.push(not(and(
      eq(messages.senderType, opts.excludeSender.senderType),
      eq(messages.senderId, opts.excludeSender.senderId),
    )!));
  }
  const direction = afterSeq !== undefined ? "after" : beforeSeq !== undefined ? "before" : "latest";
  const rows = await traceQuery(
    "messages.channel.loaded_page",
    () => db
      .select()
      .from(messages)
      .where(and(...conditions))
      // When using `after`, fetch oldest-first so we get messages right after the cursor;
      // otherwise fetch newest-first (default behavior for "latest N messages").
      .orderBy(afterSeq !== undefined ? messages.seq : desc(messages.seq))
      .limit(limit),
    () => ({
      limit,
      direction,
      history_cutoff_present: Boolean(historyCutoff),
    }),
  );

  if (afterSeq !== undefined) return enrichWithSenderNames(rows, opts); // already chronological
  const enriched = await enrichWithSenderNames(rows, opts);
  return enriched.reverse();
}

export type MessageWindowCoverage = {
  coveredAfterSeq: number;
  coveredFromSeq: number;
  coveredThroughSeq: number;
  remoteHighWaterSeq: number;
  hasGap: boolean;
  hasNewer: boolean;
  completeThroughLatest: boolean;
};

/**
 * Read one message page and its channel-domain high-water from the same repeatable-read snapshot.
 * The high-water covers the full channel message/read-state domain. [coveredAfterSeq] is the exact
 * predecessor in that same domain, so global sequence gaps from other channels do not look like local
 * message gaps. A history cutoff can narrow the page without pretending that older channel rows do not
 * exist. Non-latest directions are deliberately marked incomplete; only a latest-tail response can
 * establish read-state projection coverage.
 */
export async function listMessagesWithCoverage(
  channelId: string,
  limit = 50,
  beforeSeq?: number,
  afterSeq?: number,
  historyCutoff?: Date,
  opts: MessageQueryTraceOptions = {},
): Promise<{ messages: Awaited<ReturnType<typeof listMessages>>; coverage: MessageWindowCoverage }> {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const direction = afterSeq !== undefined ? "after" : beforeSeq !== undefined ? "before" : "latest";
  const result = await db.transaction(async (tx) => {
    const conditions = [eq(messages.channelId, channelId)];
    if (beforeSeq !== undefined) conditions.push(lt(messages.seq, beforeSeq));
    if (afterSeq !== undefined) conditions.push(gt(messages.seq, afterSeq));
    if (historyCutoff) conditions.push(gt(messages.createdAt, historyCutoff));
    if (opts.excludeSender) {
      conditions.push(not(and(
        eq(messages.senderType, opts.excludeSender.senderType),
        eq(messages.senderId, opts.excludeSender.senderId),
      )!));
    }

    const rows = await traceQuery(
        "messages.channel.loaded_page",
        () => tx
          .select()
          .from(messages)
          .where(and(...conditions))
          .orderBy(afterSeq !== undefined ? messages.seq : desc(messages.seq))
          .limit(limit),
        () => ({
          limit,
          direction,
          history_cutoff_present: Boolean(historyCutoff),
        }),
      );
    const chronologicalRows = afterSeq !== undefined ? rows : [...rows].reverse();
    const firstReturnedSeq = chronologicalRows[0]?.seq;
    const bounds = await traceQuery(
      "messages.channel.coverage_bound",
      () => tx
        .select({
          remoteHighWaterSeq: sql<number>`coalesce(max(${messages.seq}), 0)`.mapWith(Number),
          coveredAfterSeq: firstReturnedSeq == null
            ? sql<number>`coalesce(max(${messages.seq}), 0)`.mapWith(Number)
            : sql<number>`coalesce(max(${messages.seq}) filter (where ${messages.seq} < ${firstReturnedSeq}), 0)`.mapWith(Number),
        })
        .from(messages)
        .where(eq(messages.channelId, channelId)),
      () => ({ direction }),
    );
    return {
      remoteHighWaterSeq: bounds[0]?.remoteHighWaterSeq ?? 0,
      coveredAfterSeq: bounds[0]?.coveredAfterSeq ?? 0,
      rows,
    };
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });

  const chronologicalRows = afterSeq !== undefined ? result.rows : [...result.rows].reverse();
  const enriched = await enrichWithSenderNames(chronologicalRows, opts);
  const coveredFromSeq = enriched[0]?.seq ?? result.remoteHighWaterSeq + 1;
  const coveredThroughSeq = enriched.at(-1)?.seq ?? result.remoteHighWaterSeq;
  const completeThroughLatest = direction === "latest" && coveredThroughSeq === result.remoteHighWaterSeq;
  return {
    messages: enriched,
    coverage: {
      coveredAfterSeq: result.coveredAfterSeq,
      coveredFromSeq,
      coveredThroughSeq,
      remoteHighWaterSeq: result.remoteHighWaterSeq,
      hasGap: direction !== "latest",
      hasNewer: direction !== "latest",
      completeThroughLatest,
    },
  };
}

export async function listMessagesByIds(
  messageIds: readonly string[],
  opts: MessageQueryTraceOptions = {},
) {
  if (messageIds.length === 0) return [];
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const rows = await traceQuery(
    "messages.by_ids.loaded",
    () => db
      .select()
      .from(messages)
      .where(inArray(messages.id, [...messageIds])),
    () => ({ count: messageIds.length }),
  );
  const order = new Map(messageIds.map((id, index) => [id, index]));
  const enriched = await enrichWithSenderNames(rows, opts);
  return enriched.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export function projectMessagesToChannel<T extends { channelId: string }>(msgs: T[], channelId: string): T[] {
  return msgs.map((message) => ({ ...message, channelId }));
}

export async function projectJointMessagesToLocalChannel<T extends { channelId: string; threadId?: string | null }>(
  msgs: T[],
  channelId: string,
  serverId: string,
): Promise<T[]> {
  const canonicalThreadIds = [...new Set(msgs.map((message) => message.threadId).filter((threadId): threadId is string => Boolean(threadId)))];
  if (canonicalThreadIds.length === 0) return projectMessagesToChannel(msgs, channelId);

  const threadIdByCanonicalId = new Map<string, string>();
  await Promise.all(canonicalThreadIds.map(async (canonicalThreadId) => {
    const projection = (await channelService.getActiveJointThreadProjectionsByCanonicalThread(canonicalThreadId))
      .find((candidate) => candidate.localServerId === serverId);
    if (projection) {
      threadIdByCanonicalId.set(canonicalThreadId, projection.localThreadChannelId);
    }
  }));

  return msgs.map((message) => ({
    ...message,
    channelId,
    threadId: message.threadId ? threadIdByCanonicalId.get(message.threadId) ?? message.threadId : message.threadId,
  }));
}

/**
 * Check if there are messages older than the cutoff date for a channel.
 * Used to determine if the plan limit is actually truncating results.
 */
export async function hasOlderMessages(
  channelId: string,
  cutoff: Date,
  beforeSeq?: number,
  opts: MessageQueryTraceOptions = {},
): Promise<boolean> {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const conditions = [
    eq(messages.channelId, channelId),
    lt(messages.createdAt, cutoff),
  ];
  if (beforeSeq) {
    conditions.push(lt(messages.seq, beforeSeq));
  }
  const [row] = await traceQuery(
    "messages.channel.has_older",
    () => db
      .select({ id: messages.id })
      .from(messages)
      .where(and(...conditions))
      .limit(1),
    (result) => ({ row_count: result.length, before_seq_present: Boolean(beforeSeq) }),
  );
  return !!row;
}

/**
 * Sync messages: get messages with seq > sinceSeq for a channel (or all channels in server).
 * Used for gap sync after reconnection.
 */
export async function syncMessages(
  sinceSeq: number,
  channelId: string | undefined,
  limit = 200,
  serverId?: string,
  historyCutoff?: Date,
  userId?: string,
  viewerServerId = serverId,
) {
  const db = getDb();
  const enrichOptions: MessageQueryTraceOptions = {
    attachmentCommentViewerUserId: userId ?? null,
    forwardedBundleViewerUserId: userId ?? null,
    forwardedBundleViewerServerId: viewerServerId ?? null,
  };

  const conditions = [gt(messages.seq, sinceSeq)];
  if (channelId) {
    conditions.push(eq(messages.channelId, channelId));
  }
  if (historyCutoff) {
    conditions.push(gt(messages.createdAt, historyCutoff));
  }

  // If serverId provided, scope to channels in that server via join.
  // When syncing all channels for a user, preserve channel visibility:
  // public channels are readable server-wide; private/DM channels require
  // membership; threads require follow plus readable parent.
  if (serverId) {
    const role = userId ? await getActorServerRoleInServer(serverId, "user", userId) : null;
    if (userId && !role) return [];
    const isGuest = role === "guest";
    if (isGuest && !(await evaluateFeatureFlag({
      key: SERVER_GUEST_FEATURE_FLAG_KEY, serverId, userId,
    })).enabled) return [];
    const visibilityCondition = userId && !channelId
      ? sql`
        AND (
          (${channels.type} = 'channel' AND (
            ${!isGuest} OR ${channels.guestVisible}
            OR (${channels.name} <> 'all' AND EXISTS (
              SELECT 1 FROM ${channelHumans} ch
              WHERE ch.channel_id = ${channels.id} AND ch.user_id = ${userId}
            ))
          ))
          OR (
            ${channels.type} IN ('private', 'dm')
            AND EXISTS (
              SELECT 1 FROM ${channelHumans} ch
              WHERE ch.channel_id = ${channels.id}
                AND ch.user_id = ${userId}
            )
          )
          OR (
            ${channels.type} = 'thread'
            AND EXISTS (
              SELECT 1 FROM ${threadFollows} tf
              WHERE tf.thread_channel_id = ${channels.id}
                AND tf.follower_type = 'user'
                AND tf.follower_id = ${userId}
                AND tf.unfollowed_at IS NULL
            )
            AND EXISTS (
              SELECT 1
              FROM ${messages} pm
              INNER JOIN ${channels} pc ON pc.id = pm.channel_id
              LEFT JOIN ${channelHumans} pch
                ON pch.channel_id = pc.id
               AND pch.user_id = ${userId}
              WHERE pm.id = ${channels.parentMessageId}
                AND pc.server_id = ${serverId}
                AND pc.deleted_at IS NULL
                AND NOT (pc.name = 'all' AND pc.type <> 'channel')
                AND (pc.type <> 'joint' OR (${!isGuest} AND EXISTS (
                  SELECT 1 FROM ${jointChannelServers} jp
                  WHERE jp.local_channel_id = pc.id AND jp.server_id = ${serverId}
                    AND jp.status = 'active'
                )))
                AND (
                  (pc.type = 'channel' AND (${!isGuest} OR pc.guest_visible
                    OR (pc.name <> 'all' AND pch.user_id IS NOT NULL)))
                  OR (pc.type <> 'channel' AND pch.user_id IS NOT NULL)
                )
            )
          )
        )
      `
      : sql``;

    const rows = await db.execute(sql`
      SELECT
        ${messages.id},
        ${messages.seq},
        ${messages.channelId} AS "channelId",
        ${messages.senderType} AS "senderType",
        ${messages.senderId} AS "senderId",
        ${messages.messageType} AS "messageType",
        ${messages.content},
        ${messages.searchText} AS "searchText",
        ${messages.threadId} AS "threadId",
        ${messages.taskStatus} AS "taskStatus",
        ${messages.taskNumber} AS "taskNumber",
        ${messages.taskAssigneeType} AS "taskAssigneeType",
        ${messages.taskAssigneeId} AS "taskAssigneeId",
        ${messages.taskClaimedAt} AS "taskClaimedAt",
        ${messages.taskCompletedAt} AS "taskCompletedAt",
        ${messages.actionMetadata} AS "actionMetadata",
        ${messages.createdAt} AS "createdAt",
        ${messages.updatedAt} AS "updatedAt"
      FROM ${messages}
      INNER JOIN ${channels}
        ON ${messages.channelId} = ${channels.id}
      WHERE ${sql.join(conditions, sql` AND `)}
        AND ${channels.serverId} = ${serverId}
        AND ${channels.deletedAt} IS NULL
        AND NOT (${channels.name} = 'all' AND ${channels.type} <> 'channel')
        ${visibilityCondition}
      ORDER BY ${messages.seq}
      LIMIT ${limit}
    `);

    return enrichWithSenderNames(rows.rows as any[], enrichOptions);
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(messages.seq)
    .limit(limit);

  return enrichWithSenderNames(rows, enrichOptions);
}

// In-memory tracking of max seq per server for heartbeat (P2).
// Updated on every message write — zero DB overhead for heartbeat reads.
const serverMaxSeq = new Map<string, number>();
const serverMaxSeqSyncTimers = new Map<string, ReturnType<typeof setInterval>>();
const serverMaxSeqSyncRefs = new Map<string, number>();
const MAX_SEQ_REDIS_SYNC_INTERVAL_MS = 5_000;

export function getMaxSeq(serverId: string): number {
  return serverMaxSeq.get(serverId) || 0;
}

/**
 * Sync maxSeq from Redis into local cache and return the latest value.
 * Called on every heartbeat tick so replicas that don't write messages
 * still see seq advances from other replicas.
 */
export async function syncMaxSeqFromRedis(serverId: string): Promise<number> {
  const end = redisSyncDuration.startTimer();
  try {
    const redisSeq = await getMaxSeqRedis(serverId);
    if (redisSeq > 0) {
      const current = serverMaxSeq.get(serverId) || 0;
      if (redisSeq > current) serverMaxSeq.set(serverId, redisSeq);
    }
  } catch { /* Redis unavailable — use local value */ }
  end();
  return serverMaxSeq.get(serverId) || 0;
}

export function startMaxSeqRedisSync(serverId: string) {
  const refs = serverMaxSeqSyncRefs.get(serverId) || 0;
  serverMaxSeqSyncRefs.set(serverId, refs + 1);
  if (refs > 0) return;

  // Warm the cache immediately so quiet replicas don't wait a full interval
  // before sending a useful heartbeat seq.
  syncMaxSeqFromRedis(serverId).catch(() => {});

  const timer = setInterval(() => {
    syncMaxSeqFromRedis(serverId).catch(() => {});
  }, MAX_SEQ_REDIS_SYNC_INTERVAL_MS);

  serverMaxSeqSyncTimers.set(serverId, timer);
}

export function stopMaxSeqRedisSync(serverId: string) {
  const refs = serverMaxSeqSyncRefs.get(serverId);
  if (!refs) return;
  if (refs > 1) {
    serverMaxSeqSyncRefs.set(serverId, refs - 1);
    return;
  }

  serverMaxSeqSyncRefs.delete(serverId);
  const timer = serverMaxSeqSyncTimers.get(serverId);
  if (timer) {
    clearInterval(timer);
    serverMaxSeqSyncTimers.delete(serverId);
  }
}

export function updateMaxSeq(serverId: string, seq: number) {
  const current = serverMaxSeq.get(serverId) || 0;
  if (seq > current) {
    serverMaxSeq.set(serverId, seq);
    // Mirror to Redis for cross-replica heartbeat consistency (fire-and-forget)
    updateMaxSeqRedis(serverId, seq).catch(() => {});
  }
}

function buildChannelUrl(serverSlug: string, channelType: "channel" | "dm", channelId: string, messageId: string) {
  const base = channelType === "dm"
    ? `/s/${serverSlug}/dm/${channelId}`
    : `/s/${serverSlug}/channel/${channelId}`;
  return `${base}?msg=${messageId}`;
}

function buildThreadUrl(
  serverSlug: string,
  parentChannelId: string,
  parentChannelType: "channel" | "joint" | "dm",
  parentMessageId: string,
  focusedMessageId?: string,
) {
  const base = parentChannelType === "dm"
    ? `/s/${serverSlug}/dm/${parentChannelId}`
    : `/s/${serverSlug}/channel/${parentChannelId}`;
  const params = new URLSearchParams({
    thread: `${parentChannelId}:${parentMessageId}`,
  });
  if (focusedMessageId) {
    params.set("msg", focusedMessageId);
  }
  return `${base}?${params.toString()}`;
}

type PushTargetChannel = {
  id: string;
  type: "channel" | "private" | "joint" | "dm" | "thread";
  name: string;
  parentMessageId: string | null;
};

type PushTargetParentChannel = {
  id: string;
  type: "channel" | "joint" | "dm";
  name: string;
};

type PushTargetHuman = {
  id: string;
  name: string;
};

type PushTargetResolutionInput = {
  serverSlug: string;
  serverName?: string | null;
  channel: PushTargetChannel;
  messageId: string;
  senderId: string;
  senderType: "user" | "agent";
  senderName: string;
  body: string;
  dmHumans?: PushTargetHuman[];
  parentChannel?: PushTargetParentChannel;
  followedUserIds?: string[];
  mentionNames?: Set<string>;
  mentionedUserIds?: Set<string>;
  humanScopeMembers?: PushTargetHuman[];
  humanMentionOnlyMembers?: PushTargetHuman[];
  mutedUserIds?: Set<string>;
};

export function buildPushTargetsFromContext(input: PushTargetResolutionInput): Map<string, PushPayload> {
  const {
    serverSlug,
    serverName,
    channel,
    messageId,
    senderId,
    senderType,
    senderName,
    body,
    dmHumans = [],
    parentChannel,
    followedUserIds = [],
    mentionNames = new Set(),
    mentionedUserIds = new Set(),
    humanScopeMembers = [],
    humanMentionOnlyMembers = [],
    mutedUserIds = new Set(),
  } = input;

  const serverLabel = formatPushServerLabel(serverName, serverSlug);
  const payloads = new Map<string, PushPayload>();
  const setPayload = (userId: string, payload: PushPayload) => {
    if (mutedUserIds.has(userId)) return;
    payloads.set(userId, {
      ...payload,
      senderId,
      senderType,
    });
  };

  if (channel.type === "dm") {
    for (const human of dmHumans) {
      if (human.id === senderId && senderType === "user") continue;
      setPayload(human.id, {
        title: formatPushSurfaceTitle("DM", serverLabel),
        body: formatPushBody(senderName, body),
        tag: `message:${messageId}`,
        url: buildChannelUrl(serverSlug, "dm", channel.id, messageId),
        serverName: serverLabel,
        channelName: null,
        parentChannelKind: null,
        senderName,
        messagePreview: body,
        mentioned: false,
      });
    }
    return payloads;
  }

  if (channel.type === "channel" || channel.type === "private" || channel.type === "joint") {
    for (const human of humanScopeMembers) {
      if (human.id === senderId && senderType === "user") continue;
      const mentioned = mentionedUserIds.has(human.id) || mentionNames.has(human.name);
      setPayload(human.id, {
        title: formatPushSurfaceTitle(`#${channel.name}`, serverLabel),
        body: formatPushBody(senderName, body, mentioned),
        tag: `message:${messageId}`,
        url: buildChannelUrl(serverSlug, "channel", channel.id, messageId),
        serverName: serverLabel,
        channelName: channel.name,
        parentChannelKind: null,
        senderName,
        messagePreview: body,
        mentioned,
      });
    }
    if (channel.type === "channel") {
      for (const human of humanMentionOnlyMembers) {
        if (human.id === senderId && senderType === "user") continue;
        if (!mentionedUserIds.has(human.id) || payloads.has(human.id)) continue;
        setPayload(human.id, {
          title: formatPushSurfaceTitle(`#${channel.name}`, serverLabel),
          body: formatPushBody(senderName, body, true),
          tag: `message:${messageId}`,
          url: buildChannelUrl(serverSlug, "channel", channel.id, messageId),
          serverName: serverLabel,
          channelName: channel.name,
          parentChannelKind: null,
          senderName,
          messagePreview: body,
          mentioned: true,
        });
      }
    }
    return payloads;
  }

  if (channel.type === "thread" && channel.parentMessageId && parentChannel) {
    const threadScope = parentChannel.type === "dm" ? "DM" : `#${parentChannel.name}`;
    for (const userId of followedUserIds) {
      if (userId === senderId && senderType === "user") continue;
      setPayload(userId, {
        title: formatPushSurfaceTitle(`Thread in ${threadScope}`, serverLabel),
        body: formatPushBody(senderName, body),
        tag: `message:${messageId}`,
        url: buildThreadUrl(serverSlug, parentChannel.id, parentChannel.type, channel.parentMessageId, messageId),
        serverName: serverLabel,
        channelName: parentChannel.type === "dm" ? null : parentChannel.name,
        parentChannelKind: parentChannel.type,
        senderName,
        messagePreview: body,
        mentioned: false,
      });
    }
    return payloads;
  }

  return payloads;
}

export type ServerPushPipelineSurface = "direct_or_local" | "joint_channel" | "joint_thread";

export async function resolveServerPushSuppressionForPipeline(input: {
  surface: ServerPushPipelineSurface;
  serverId: string;
  targetUserIds: string[];
  targetVisibleMentionedUserIds: ReadonlySet<string>;
  resolveSuppressedUserIds?: typeof serverService.getServerPushSuppressedUserIds;
}): Promise<Set<string>> {
  const resolveSuppressedUserIds = input.resolveSuppressedUserIds
    ?? serverService.getServerPushSuppressedUserIds;
  return resolveSuppressedUserIds(
    input.serverId,
    input.targetUserIds,
    input.targetVisibleMentionedUserIds,
  );
}

async function buildPushTargets(opts: {
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>;
  messageId: string;
  messageSeq: number;
  senderId: string;
  senderType: "user" | "agent";
  senderName: string;
  content: string;
  mentionedUserIds?: Set<string>;
  attachmentCount: number;
}): Promise<Map<string, PushPayload>> {
  const { channel, messageId, messageSeq, senderId, senderType, senderName, content, mentionedUserIds = new Set(), attachmentCount } = opts;
  const db = getDb();
  const body = summarizePushBody(content, attachmentCount);
  const [serverRow] = await db
    .select({ slug: servers.slug, name: servers.name })
    .from(servers)
    .where(eq(servers.id, channel.serverId))
    .limit(1);

  if (!serverRow?.slug) return new Map();

  const mentionNames = getMentionNameSet(content);

  let dmHumans: PushTargetHuman[] = [];
  if (channel.type === "dm") {
    dmHumans = await channelService.getChannelHumans(channel.id);
  }

  let parentChannel: PushTargetParentChannel | undefined;
  let followedUserIds: string[] = [];
  if (channel.type === "thread" && channel.parentMessageId) {
    const [parentMessage] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId))
      .limit(1);

    if (parentMessage) {
      const parentChannelRow = await channelService.getChannel(parentMessage.channelId);
      if (parentChannelRow && (parentChannelRow.type === "channel" || parentChannelRow.type === "private" || parentChannelRow.type === "joint" || parentChannelRow.type === "dm")) {
        parentChannel = {
          id: parentChannelRow.id,
          type: parentChannelRow.type === "private" ? "channel" : parentChannelRow.type,
          name: parentChannelRow.name,
        };
        const parentChannels = alias(channels, "push_parent_channels");
        const followedUsers = await db
          .select({ userId: threadFollows.followerId })
          .from(threadFollows)
          .innerJoin(parentChannels, eq(parentChannels.id, parentMessage.channelId))
          .leftJoin(channelHumans, and(
            eq(channelHumans.channelId, parentMessage.channelId),
            eq(channelHumans.userId, threadFollows.followerId),
          ))
          .leftJoin(serverMembers, and(
            eq(serverMembers.serverId, parentChannels.serverId),
            eq(serverMembers.userId, threadFollows.followerId),
          ))
          .where(and(
            eq(threadFollows.threadChannelId, channel.id),
            eq(threadFollows.followerType, "user"),
            isNull(threadFollows.doneAt),
            isNull(threadFollows.unfollowedAt),
            sql`(
              (${parentChannels.type} = 'channel' AND ${serverMembers.userId} IS NOT NULL)
              OR ${channelHumans.userId} IS NOT NULL
            )`,
          ));
        followedUserIds = followedUsers.map((follow) => follow.userId);
      }
    }
  }

  let humanScopeMembers: PushTargetHuman[] = [];
  let humanMentionOnlyMembers: PushTargetHuman[] = [];
  if (channel.type === "channel" || channel.type === "private" || channel.type === "joint") {
    humanScopeMembers = await channelService.getChannelHumans(channel.id);
    if (channel.type === "channel") {
      const joinedHumanIds = new Set(humanScopeMembers.map((human) => human.id));
      const visibleHumans = await serverService.getServerMembers(channel.serverId, null);
      humanMentionOnlyMembers = visibleHumans
        .map((human) => ({ id: human.userId, name: human.name }))
        .filter((human) => !joinedHumanIds.has(human.id));
    }
  }

  const targets = buildPushTargetsFromContext({
    serverSlug: serverRow.slug,
    serverName: serverRow.name,
    channel: {
      id: channel.id,
      type: channel.type as "channel" | "private" | "joint" | "dm" | "thread",
      name: channel.name,
      parentMessageId: channel.parentMessageId,
    },
    messageId,
    senderId,
    senderType,
    senderName,
    body,
    dmHumans,
    parentChannel,
    followedUserIds,
    mentionNames,
    mentionedUserIds,
    humanScopeMembers,
    humanMentionOnlyMembers,
  });
  const serverMutedUserIds = await resolveServerPushSuppressionForPipeline({
    surface: "direct_or_local",
    serverId: channel.serverId,
    targetUserIds: [...targets.keys()],
    targetVisibleMentionedUserIds: mentionedUserIds,
  });
  const activityMutedUserIds = channel.type === "thread"
    ? new Set<string>()
    : await channelService.getActivityMutedUserIdsForMessage({
        serverId: channel.serverId,
        sourceChannelId: channel.id,
        userIds: [...targets.keys()],
        messageSeq,
        piercedUserIds: mentionedUserIds,
      });
  const mutedUserIds = new Set([...serverMutedUserIds, ...activityMutedUserIds]);
  for (const userId of mutedUserIds) {
    targets.delete(userId);
  }
  const humanAudienceCount = channel.type === "dm"
    ? dmHumans.length
    : channel.type === "thread"
      ? followedUserIds.length
      : humanScopeMembers.length;
  setPushTargetTraceAttrs(targets, {
    human_audience_count: humanAudienceCount,
    human_mention_only_audience_count: humanMentionOnlyMembers.length,
    human_delivery_count: targets.size,
    muted_human_count: mutedUserIds.size,
    activity_muted_human_count: activityMutedUserIds.size,
  });
  return targets;
}

async function handleJointThreadPostBroadcastSideEffects(input: {
  io: SocketServer;
  agentOrchestrator: AgentOrchestrator;
  deps: MessageServiceDeps;
  canonicalThreadChannelId: string;
  canonicalParentMessageId: string;
  sourceServerId: string;
  senderType: "user" | "agent";
  senderId: string;
  senderName: string;
  senderUniqueName: string;
  senderDescription: string | null;
  content: string;
  message: typeof messages.$inferSelect;
  attachments: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }[];
  resolvedMentions: ResolvedMentionFact[];
  targetVisibleMentions: ResolvedMentionFact[];
}) {
  const {
    io,
    agentOrchestrator,
    deps,
    canonicalThreadChannelId,
    canonicalParentMessageId,
    sourceServerId,
    senderType,
    senderId,
    senderName,
    senderUniqueName,
    senderDescription,
    content,
    message,
    attachments,
    resolvedMentions,
    targetVisibleMentions,
  } = input;
  const threadProjections = await channelService.getActiveJointThreadProjectionsByCanonicalThread(canonicalThreadChannelId);
  if (threadProjections.length === 0) return;

  const db = getDb();
  const mentionedAgentIds = new Set(resolvedMentions.filter((mention) => mention.type === "agent").map((mention) => mention.id));
  const mentionedUserIds = new Set(resolvedMentions.filter((mention) => mention.type === "user").map((mention) => mention.id));
  const targetVisibleMentionedAgentIds = new Set(targetVisibleMentions.filter((mention) => mention.type === "agent").map((mention) => mention.id));
  const targetVisibleMentionedUserIds = new Set(targetVisibleMentions.filter((mention) => mention.type === "user").map((mention) => mention.id));
  const mentionNames = getMentionNameSet(content);
  const body = summarizePushBody(content, attachments.length);
  let threadJoinContextBase: ThreadJoinContextBase | undefined;
  const deliveryPromises: Promise<unknown>[] = [];
  const notificationPushProjectionGroups: NotificationPushProjectionGroup[] = [];

  for (const projection of threadProjections) {
    const parentChannel = await deps.getChannel(projection.localParentChannelId);
    if (!parentChannel) continue;
    const candidateAgents = await deps.getChannelAgents(projection.localParentChannelId);
    const candidateAgentById = new Map(candidateAgents.map((agent) => [agent.id, agent]));
    const candidateHumans = await deps.getChannelHumans(projection.localParentChannelId);
    const candidateHumanById = new Map(candidateHumans.map((human) => [human.id, human]));

    const activeAgentFollows = await db
      .select({ followerId: threadFollows.followerId })
      .from(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, projection.localThreadChannelId),
        eq(threadFollows.followerType, "agent"),
        isNull(threadFollows.unfollowedAt),
      ));
    const followedAgentIds = new Set(activeAgentFollows.map((follow) => follow.followerId));
    const deliveryAgents = new Map(
      [...followedAgentIds]
        .map((agentId) => candidateAgentById.get(agentId))
        .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
        .map((agent) => [agent.id, agent]),
    );
    const reactivatedThreadAgentIds = new Set<string>();
    if (mentionedAgentIds.size > 0) {
      for (const mentionedAgentId of mentionedAgentIds) {
        const mentionedAgent = candidateAgentById.get(mentionedAgentId);
        if (!mentionedAgent || deliveryAgents.has(mentionedAgent.id)) continue;
        const [existingFollow] = await db
          .select({ doneAt: threadFollows.doneAt, unfollowedAt: threadFollows.unfollowedAt })
          .from(threadFollows)
          .where(and(
            eq(threadFollows.threadChannelId, projection.localThreadChannelId),
            eq(threadFollows.followerType, "agent"),
            eq(threadFollows.followerId, mentionedAgent.id),
          ))
          .limit(1);
        const followPlan = planDirectMentionThreadFollow(existingFollow);
        await channelService.recordThreadFollow(
          "agent",
          mentionedAgent.id,
          projection.localThreadChannelId,
          canonicalParentMessageId,
          "mentioned",
          { reactivateUnfollowed: true, preserveExistingReason: true },
        );
        const [activeFollow] = await db
          .select({ followerId: threadFollows.followerId })
          .from(threadFollows)
          .where(and(
            eq(threadFollows.threadChannelId, projection.localThreadChannelId),
            eq(threadFollows.followerType, "agent"),
            eq(threadFollows.followerId, mentionedAgent.id),
            isNull(threadFollows.unfollowedAt),
          ))
          .limit(1);
        if (activeFollow) {
          deliveryAgents.set(mentionedAgent.id, mentionedAgent);
          if (followPlan.reactivatedExplicitUnfollow) {
            reactivatedThreadAgentIds.add(mentionedAgent.id);
          }
        } else {
          deliveryAgents.set(mentionedAgent.id, mentionedAgent);
        }
      }
    }

    if (mentionedUserIds.size > 0) {
      for (const mentionedUserId of mentionedUserIds) {
        const mentionedUser = candidateHumanById.get(mentionedUserId);
        if (!mentionedUser) continue;
        const [existingFollow] = await db
          .select({ doneAt: threadFollows.doneAt, unfollowedAt: threadFollows.unfollowedAt })
          .from(threadFollows)
          .where(and(
            eq(threadFollows.threadChannelId, projection.localThreadChannelId),
            eq(threadFollows.followerType, "user"),
            eq(threadFollows.followerId, mentionedUser.id),
          ))
          .limit(1);
        if (planDirectMentionThreadFollow(existingFollow).shouldActivate) {
          await channelService.recordThreadFollow(
            "user",
            mentionedUser.id,
            projection.localThreadChannelId,
            canonicalParentMessageId,
            "mentioned",
            { reactivateUnfollowed: true, preserveExistingReason: true },
          );
        }
      }
    }

    const contextEligibleAgentIds = new Set(
      [...targetVisibleMentionedAgentIds].filter((agentId) => deliveryAgents.has(agentId)),
    );
    if (contextEligibleAgentIds.size > 0 && !threadJoinContextBase) {
      threadJoinContextBase = await buildThreadJoinContextBase(
        canonicalThreadChannelId,
        canonicalParentMessageId,
        message.seq,
      );
    }

    const renderedContent = await deps.renderAgentReadablePermalinks(content, projection.localServerId);
    const deliveryOptions = await getAgentDeliveryOptionsForSender(deps, projection.localServerId, senderType, senderId);
    const parentChannelType = parentChannel.type as "joint";
    const threadShortId = getMessageShortId(canonicalParentMessageId);
    for (const agent of deliveryAgents.values()) {
      if (senderType === "agent" && agent.id === senderId) continue;

      let threadJoinContext: AgentThreadJoinContext | undefined;
      if (threadJoinContextBase && contextEligibleAgentIds.has(agent.id)) {
        const parentTarget = formatParentTarget(parentChannelType, parentChannel.name);
        const threadTarget = formatThreadTarget(parentChannelType, parentChannel.name, threadShortId);
        threadJoinContext = {
          ...threadJoinContextBase,
          parent_target: parentTarget,
          thread_target: threadTarget,
          suggested_read_history_target: threadTarget,
        };
      }

      deliveryPromises.push(
        agentOrchestrator.deliverMessage(agent.id, {
          channel_id: projection.localThreadChannelId,
          channel_name: projection.threadChannel.name,
          channel_type: "thread",
          sender_id: senderId,
          sender_name: senderUniqueName,
          sender_description: senderDescription,
          sender_type: toAgentVisibleSenderType(senderType, message.messageType),
          content: renderedContent,
          timestamp: message.createdAt.toISOString(),
          seq: message.seq,
          message_id: message.id,
          ...(targetVisibleMentionedAgentIds.has(agent.id) && { mentioned: true }),
          parent_channel_name: parentChannel.name,
          parent_channel_id: projection.localParentChannelId,
          parent_channel_type: parentChannelType,
          ...(attachments.length > 0 && {
            attachments: attachments.map((attachment) => ({
              id: attachment.id,
              filename: normalizeAttachmentFilename(attachment.filename),
              mimeType: resolveAttachmentMimeType(attachment.filename, attachment.mimeType),
              sizeBytes: attachment.sizeBytes,
            })),
          }),
          ...(message.senderType !== "external_projection" && message.taskStatus != null && {
            task_status: message.taskStatus as "todo" | "in_progress" | "in_review" | "done" | "closed",
            task_number: message.taskNumber,
            task_assignee_type: toAgentVisibleTaskAssigneeType(message.taskAssigneeType as InternalActorType | null),
            task_assignee_id: message.taskAssigneeId,
            task_assignee_name: getAgentVisibleTaskAssigneeName(message),
          }),
          ...(threadJoinContext && { thread_join_context: threadJoinContext }),
          ...(reactivatedThreadAgentIds.has(agent.id) && {
            thread_follow_reactivation: { thread_target: formatThreadTarget(parentChannelType, parentChannel.name, threadShortId) },
          }),
        }, deliveryOptions).catch((err) => {
          console.error(`[MessageService] Failed to deliver joint thread message to agent ${agent.id}:`, serializeErrorForLog(err));
        })
      );
    }

    const [serverRow] = await db
      .select({ slug: servers.slug, name: servers.name })
      .from(servers)
      .where(eq(servers.id, projection.localServerId))
      .limit(1);
    if (!serverRow?.slug) continue;

    const followedUsers = await db
      .select({ userId: threadFollows.followerId })
      .from(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, projection.localThreadChannelId),
        eq(threadFollows.followerType, "user"),
        isNull(threadFollows.doneAt),
        isNull(threadFollows.unfollowedAt),
      ));
    const followedUserIds = followedUsers
      .map((follow) => follow.userId)
      .filter((userId) => candidateHumanById.has(userId));
    const projectionPushTargets = buildPushTargetsFromContext({
      serverSlug: serverRow.slug,
      serverName: serverRow.name,
      channel: {
        id: projection.localThreadChannelId,
        type: "thread",
        name: projection.threadChannel.name,
        parentMessageId: canonicalParentMessageId,
      },
      messageId: message.id,
      senderId,
      senderType,
      senderName,
      body,
      parentChannel: {
        id: projection.localParentChannelId,
        type: "joint",
        name: parentChannel.name,
      },
      followedUserIds,
      mentionNames,
      mentionedUserIds: targetVisibleMentionedUserIds,
    });
    const serverMutedUserIds = await resolveServerPushSuppressionForPipeline({
      surface: "joint_thread",
      serverId: projection.localServerId,
      targetUserIds: [...projectionPushTargets.keys()],
      targetVisibleMentionedUserIds,
    });
    for (const userId of serverMutedUserIds) projectionPushTargets.delete(userId);
    const notificationPushSocketIdentity: NotificationPushSocketIdentity = {
      serverId: projection.localServerId,
      kind: "thread",
      channelId: projection.localThreadChannelId,
      threadId: projection.localThreadChannelId,
      parentChannelId: projection.localParentChannelId,
      parentMessageId: canonicalParentMessageId,
      messageId: message.id,
    };
    if (projectionPushTargets.size > 0) {
      notificationPushProjectionGroups.push({
        targets: projectionPushTargets,
        identity: notificationPushSocketIdentity,
      });
    }
  }

  Promise.all(deliveryPromises).catch(() => {});
  const projectionTargets = buildNotificationPushProjectionTargets(notificationPushProjectionGroups);
  if (projectionTargets.length > 0) {
    const canonicalTargets = selectCanonicalNotificationProjectionTargets(projectionTargets, {
      serverId: sourceServerId,
      messageId: message.id,
    });
    await deps.persistNativeNotificationIntents(resolveNotificationIntents(canonicalTargets, message.createdAt)).catch(() => {
      console.error("[MessageService] Failed to persist native notification intents");
    });
    const appUrl = getConfiguredAppUrl();
    if (!appUrl) {
      console.warn("[MessageService] Skipping joint thread web push dispatch because APP_URL is not configured");
      return;
    }
    const targets = buildAbsoluteNotificationPushProjectionTargets(projectionTargets, appUrl);
    const webPushTargets = selectCanonicalNotificationProjectionTargets(targets, {
      serverId: sourceServerId,
      messageId: message.id,
    });
    deps.sendPushNotifications(webPushTargets).catch((err) => {
      console.error("[MessageService] Failed to dispatch joint thread web push notifications:", serializeErrorForLog(err));
    });
    emitNotificationPushProjectionTargets(io, targets);
  }
}

type InsertedMentionRow = {
  id: string;
  targetType: "user" | "agent";
  targetId: string;
  notifiableAtSend: boolean;
};

/**
 * Batched form: resolve the notifiable mention rows for many agents in ONE query and persist all
 * their occurrences in ONE insert. Used on the send path so the product path pays two round-trips
 * instead of two per mentioned agent, and so the occurrences are durable before any delivery is
 * initiated. Returns agentId -> occurrenceId for the agents that had a notifiable mention.
 */
async function ensureAgentMentionDeliveryOccurrencesForAgents(
  messageId: string,
  entries: readonly { agentId: string; deliveryPayload: AgentMessage }[],
): Promise<Map<string, string>> {
  if (entries.length === 0) return new Map();
  const mentions = await getDb().select({
    occurrenceId: messageMentions.id,
    serverId: messageMentions.serverId,
    targetId: messageMentions.targetId,
  }).from(messageMentions).where(and(
    eq(messageMentions.messageId, messageId),
    eq(messageMentions.targetType, "agent"),
    inArray(messageMentions.targetId, entries.map((entry) => entry.agentId)),
    or(eq(messageMentions.notifiableAtSend, true), isNotNull(messageMentions.notifiedAt)),
  ));
  const byAgentId = new Map(mentions.map((mention) => [mention.targetId, mention]));
  const rows = entries.flatMap((entry) => {
    const mention = byAgentId.get(entry.agentId);
    if (!mention) return [];
    return [{
      occurrenceId: mention.occurrenceId,
      messageId,
      serverId: mention.serverId,
      agentId: entry.agentId,
      deliveryPayload: entry.deliveryPayload,
    }];
  });
  await resolveMessageServiceDeps().persistMentionDeliveryOccurrences(rows);
  return new Map(rows.map((row) => [row.agentId, row.occurrenceId]));
}

async function ensureAgentMentionDeliveryOccurrence(
  messageId: string,
  agentId: string,
  deliveryPayload: AgentMessage,
): Promise<string | undefined> {
  const [mention] = await getDb().select({
    occurrenceId: messageMentions.id,
    serverId: messageMentions.serverId,
  }).from(messageMentions).where(and(
    eq(messageMentions.messageId, messageId),
    eq(messageMentions.targetType, "agent"),
    eq(messageMentions.targetId, agentId),
    or(eq(messageMentions.notifiableAtSend, true), isNotNull(messageMentions.notifiedAt)),
  )).limit(1);
  if (!mention) return undefined;
  // Through the SAME injectable dep as the batched form (which calls
  // resolveMessageServiceDeps().persistMentionDeliveryOccurrences). This path used the module
  // import directly, so no test could make it fail — and that is plausibly why it never grew the
  // declared-degradation catch its sibling has: the batched path was reachable by the harness, so
  // someone wrote the fault test and the catch followed; this one was not, so neither happened.
  // A testability asymmetry became a behaviour asymmetry.
  await resolveMessageServiceDeps().persistMentionDeliveryOccurrences([{
    occurrenceId: mention.occurrenceId,
    messageId,
    serverId: mention.serverId,
    agentId,
    deliveryPayload,
  }]);
  return mention.occurrenceId;
}

// Pending resolutions auto-expire (lazily, at read time) after this window;
// doing nothing is a valid terminal outcome (mention-AX M-5/M-12).
const PENDING_MENTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PendingMentionAction = {
  resolutionId: string;
  messageId: string;
  targetType: "user" | "agent";
  targetHandle: string;
  targetAvatarUrl: string | null;
  reason: "not_member";
  availableActions: readonly ("notify" | "add")[];
  expiresAt: string;
};

async function pendingMentionAvailableActions(
  serverId: string,
  channelId: string,
  senderType: "user" | "agent",
  senderId: string,
  deps: MessageServiceDeps,
  executor?: DatabaseExecutor,
): Promise<readonly ("notify" | "add")[]> {
  if (senderType !== "user") {
    return ["notify"] as const;
  }

  try {
    const authorityChannelId = await deps.getChannelMembershipAuthorityChannelId(
      channelId,
      executor,
    );
    const canAdd = authorityChannelId
      ? await deps.actorHasChannelCapability(
          serverId,
          authorityChannelId,
          "user",
          senderId,
          "addChannelMembers",
          executor,
        )
      : false;
    return canAdd
      ? (["notify", "add"] as const)
      : (["notify"] as const);
  } catch {
    // This is sender-only presentation layered on an already-persisted
    // message. If authority projection is unavailable, fail closed by hiding
    // Add without turning a successful send into an error.
    return ["notify"] as const;
  }
}

const senderPendingMentionActionsKey: unique symbol = Symbol("senderPendingMentionActions");
const senderUnresolvedMentionHandlesKey: unique symbol = Symbol("senderUnresolvedMentionHandles");

export function getSenderPendingMentionActions(message: unknown): PendingMentionAction[] {
  if (!message || typeof message !== "object") return [];
  const value = (message as { [senderPendingMentionActionsKey]?: PendingMentionAction[] })[senderPendingMentionActionsKey];
  return Array.isArray(value) ? value : [];
}

export function getSenderUnresolvedMentionHandles(message: unknown): string[] {
  if (!message || typeof message !== "object") return [];
  const value = (message as { [senderUnresolvedMentionHandlesKey]?: string[] })[senderUnresolvedMentionHandlesKey];
  return Array.isArray(value) ? value : [];
}

function attachSenderPendingMentionActions<T extends object>(message: T, pendingMentionActions: PendingMentionAction[]): T {
  if (pendingMentionActions.length === 0) return message;
  Object.defineProperty(message, senderPendingMentionActionsKey, {
    value: pendingMentionActions,
    enumerable: false,
  });
  return message;
}

function attachSenderUnresolvedMentionHandles<T extends object>(message: T, unresolvedMentionHandles: string[]): T {
  if (unresolvedMentionHandles.length === 0) return message;
  Object.defineProperty(message, senderUnresolvedMentionHandlesKey, {
    value: unresolvedMentionHandles,
    enumerable: false,
  });
  return message;
}

function findUnresolvedMentionHandles(
  mentionHandles: string[],
  resolvedMentions: ResolvedMentionFact[],
  structuredMentions: StructuredMentionInput[] | undefined = undefined,
): string[] {
  const resolvedHandles = new Set(resolvedMentions.map((mention) => mention.name));
  const structuredHandles = new Set((structuredMentions ?? []).map((mention) => mention.name.trim()));
  return Array.from(new Set(
    mentionHandles.filter((handle) => {
      const name = handle.slice(1);
      return !resolvedHandles.has(name) && !structuredHandles.has(name);
    }),
  ));
}

type LinkedMessageAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
};

function toLinkedMessageAttachment(
  attachment: typeof attachments.$inferSelect,
): LinkedMessageAttachment {
  return {
    id: attachment.id,
    filename: normalizeAttachmentFilename(attachment.filename),
    mimeType: resolveAttachmentMimeType(attachment.filename, attachment.mimeType),
    sizeBytes: attachment.sizeBytes,
    width: attachment.width,
    height: attachment.height,
    thumbnailUrl: getThumbnailUrl(attachment.thumbnailKey),
  };
}

async function getChannelHumansWithExecutor(
  executor: DatabaseExecutor,
  channelId: string,
  knownChannel?: Pick<typeof channels.$inferSelect, "id" | "serverId" | "name" | "type">,
): ReturnType<typeof channelService.getChannelHumans> {
  const channel = knownChannel?.id === channelId
    ? knownChannel
    : (await executor
      .select({ id: channels.id, serverId: channels.serverId, name: channels.name, type: channels.type })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1))[0];
  if (channel && channelService.isEnabledAllChannel(channel)) {
    const rows = await executor
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
      .where(eq(serverMembers.serverId, channel.serverId));
    return rows as Awaited<ReturnType<typeof channelService.getChannelHumans>>;
  }
  const rows = await executor
    .select({
      id: users.id,
      serverId: channels.serverId,
      serverName: servers.name,
      serverSlug: servers.slug,
      name: users.name,
      displayName: users.displayName,
      description: users.description,
      avatarUrl: users.avatarUrl,
      role: serverMembers.role,
    })
    .from(channelHumans)
    .innerJoin(channels, eq(channelHumans.channelId, channels.id))
    .innerJoin(servers, eq(servers.id, channels.serverId))
    .innerJoin(users, eq(channelHumans.userId, users.id))
    .innerJoin(serverMembers, and(
      eq(serverMembers.serverId, channels.serverId),
      eq(serverMembers.userId, users.id),
    ))
    .where(eq(channelHumans.channelId, channelId));
  return rows as Awaited<ReturnType<typeof channelService.getChannelHumans>>;
}

async function getChannelAgentsWithExecutor(
  executor: DatabaseExecutor,
  channelId: string,
  knownChannel?: Pick<typeof channels.$inferSelect, "id" | "serverId" | "name" | "type">,
): ReturnType<typeof channelService.getChannelAgents> {
  const channel = knownChannel?.id === channelId
    ? knownChannel
    : (await executor
      .select({ id: channels.id, serverId: channels.serverId, name: channels.name, type: channels.type })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1))[0];
  if (channel && channelService.isEnabledAllChannel(channel)) {
    const rows = await executor
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
      .where(and(eq(agents.serverId, channel.serverId), isNull(agents.deletedAt)));
    return rows as Awaited<ReturnType<typeof channelService.getChannelAgents>>;
  }
  const rows = await executor
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
    .from(channelAgents)
    .innerJoin(agents, eq(channelAgents.agentId, agents.id))
    .innerJoin(servers, eq(servers.id, agents.serverId))
    .where(and(eq(channelAgents.channelId, channelId), isNull(agents.deletedAt)));
  return rows as Awaited<ReturnType<typeof channelService.getChannelAgents>>;
}

/**
 * Default implementation: batch insert mention intent/fact rows into
 * message_mentions. Returns the inserted rows (empty on replay conflicts) so
 * the send path can surface pending mention actions keyed by row id.
 * Extracted as a dep so unit tests can stub it without initializing PGlite.
 */
async function insertMentionRowsWithOccurrenceRecords(
  executor: DatabaseExecutor,
  rows: (typeof messageMentions.$inferInsert)[],
): Promise<InsertedMentionRow[]> {
  if (rows.length === 0) return [];
  const inserted = await executor.insert(messageMentions).values(rows).onConflictDoNothing({
    target: [messageMentions.messageId, messageMentions.targetType, messageMentions.targetId],
  }).returning({
    id: messageMentions.id,
    targetType: messageMentions.targetType,
    targetId: messageMentions.targetId,
    notifiableAtSend: messageMentions.notifiableAtSend,
  });
  const occurrences = inserted
    .filter((row) => row.targetType === "agent" && row.notifiableAtSend)
    .flatMap((row) => {
      const source = rows.find((candidate) =>
        candidate.targetType === row.targetType && candidate.targetId === row.targetId
      );
      return source
        ? [{
            occurrenceId: row.id,
            messageId: source.messageId,
            serverId: source.serverId,
            agentId: row.targetId,
          }]
        : [];
    });
  if (occurrences.length > 0) {
    await executor.insert(mentionDeliveryOccurrences).values(occurrences).onConflictDoNothing({
      target: mentionDeliveryOccurrences.occurrenceId,
    });
  }
  return inserted;
}

async function insertMentionRows(rows: (typeof messageMentions.$inferInsert)[]): Promise<InsertedMentionRow[]> {
  return insertMentionRowsWithOccurrenceRecords(getDb(), rows);
}

async function insertMentionRowsWithExecutor(
  executor: DatabaseExecutor,
  rows: (typeof messageMentions.$inferInsert)[],
): Promise<InsertedMentionRow[]> {
  return insertMentionRowsWithOccurrenceRecords(executor, rows);
}

async function resolveMentionTargets(
  serverId: string,
  senderType: "user" | "agent",
  senderId: string,
  scopeChannelId: string,
  scopeType: string,
  mentionHandles: string[],
  structuredMentions: StructuredMentionInput[] | undefined,
  mentionContract: "v1" | "v2",
  deps: MessageServiceDeps,
): Promise<{ targets: ResolvedMentionTarget[]; resolvedFacts: ResolvedMentionFact[] }> {
  // Deduplicate handles by exact spelling. Handles are actor identifiers; when
  // case-only duplicates exist, lower-casing silently targets the wrong actor.
  const rawByHandle = new Map<string, string>();
  for (const match of mentionHandles) {
    const raw = match.slice(1); // strip leading @, preserve original case
    if (!rawByHandle.has(raw)) rawByHandle.set(raw, raw);
  }

  // Resolve candidate set based on effective scope (parent channel for threads)
  const isDm = scopeType === "dm";
  const isPrivateLike = scopeType === "private" || scopeType === "joint";
  let candidateHumans: { userId: string; name: string; avatarUrl?: string | null; role?: string | null }[];
  let candidateAgents: { id: string; name: string; avatarUrl?: string | null }[];
  // Send-time eligibility snapshot (mention-AX M-3): which resolved targets are
  // scope-channel members and may receive the normal mention notification.
  // Private-like scopes only resolve members, so every target is notifiable.
  let notifiableUserIds: Set<string> | null = null;
  let notifiableAgentIds: Set<string> | null = null;

  if (isPrivateLike) {
    // Private/joint scope: only scope channel members can be mentioned.
    // Joint member lookup aggregates all active local projections, which keeps
    // mention facts bounded to the shared channel instead of host server-wide.
    const members = await deps.getChannelMembers(scopeChannelId);
    candidateHumans = members.humans.map((h) => ({ userId: h.id, name: h.name, avatarUrl: h.avatarUrl }));
    candidateAgents = members.agents.map((a) => ({ id: a.id, name: a.name, avatarUrl: a.avatarUrl }));
  } else if (isDm) {
    // DM authoring behaves like a unique two-member private channel, but @handles
    // may reference same-server people/agents as inert facts. Only actual DM
    // participants are notifiable; outsiders receive no inbox/activity.
    const [serverHumans, serverAgents, scopeMembers] = await Promise.all([
      deps.getServerMembers(serverId, null),
      deps.listAgents(serverId),
      deps.getChannelMembers(scopeChannelId),
    ]);
    candidateHumans = serverHumans;
    candidateAgents = serverAgents;
    notifiableUserIds = new Set(scopeMembers.humans.map((h) => h.id));
    notifiableAgentIds = new Set(scopeMembers.agents.map((a) => a.id));
  } else {
    // Public channel: server-wide scope for the lexical fact; membership of the
    // scope channel decides notifiable_at_send for each resolved target.
    const [serverHumans, serverAgents, scopeMembers] = await Promise.all([
      deps.getServerMembers(serverId, null),
      deps.listAgents(serverId),
      deps.getChannelMembers(scopeChannelId),
    ]);
    candidateHumans = serverHumans;
    candidateAgents = serverAgents;
    notifiableUserIds = new Set(scopeMembers.humans.map((h) => h.id));
    notifiableAgentIds = new Set(scopeMembers.agents.map((a) => a.id));
  }

  // A hidden human directory is an authorization boundary, not just a list UI
  // preference. Mention resolution (including sender-only pending actions)
  // must not become an existence or avatar oracle. Private/joint candidates
  // are already bounded to current scope members. Human senders retain the
  // same self, local-channel, Joint-peer, and community owner/admin visibility
  // as the profile surface; #all is explicitly excluded from local visibility.
  if (
    senderType === "user"
    && !isPrivateLike
    && await deps.shouldHideHumanDirectoryFromRequester(serverId, senderId)
  ) {
    const [server, locallyVisibleHumanIds, jointVisibleHumanIds] = await Promise.all([
      deps.getServerIdentity(serverId),
      deps.getHumanIdsVisibleThroughLocalChannels(serverId, senderId),
      deps.getHumanIdsVisibleThroughJointChannels(serverId, senderId),
    ]);
    candidateHumans = candidateHumans.filter((human) => (
      locallyVisibleHumanIds.has(human.userId)
      || jointVisibleHumanIds.has(human.userId)
      || serverService.shouldExposeHumanInHiddenDirectory({
        userId: human.userId,
        serverSlug: server?.slug ?? null,
        role: human.role ?? null,
      }, senderId)
    ));
  } else if (
    senderType === "agent"
    && !isPrivateLike
    && await deps.shouldHideHumanDirectoryFromAgentRequester(serverId, senderId)
  ) {
    // Member agents have no human "self" and their established server/channel
    // directory contract exposes only the community owner/admin exception.
    const server = await deps.getServerIdentity(serverId);
    candidateHumans = candidateHumans.filter((human) => (
      serverService.shouldExposeHumanInHiddenDirectory({
        userId: human.userId,
        serverSlug: server?.slug ?? null,
        role: human.role ?? null,
      }, null)
    ));
  }

  const targets: ResolvedMentionTarget[] = [];
  const resolvedFacts: ResolvedMentionFact[] = [];
  const seen = new Set<string>(); // dedup by "targetType:targetId"
  const structuredHandleKeys = new Set<string>();
  const structuredTargetByHandle = new Map<string, string>();

  const addRow = (targetType: "user" | "agent", targetId: string, rawHandle: string, targetAvatarUrl: string | null) => {
    const key = `${targetType}:${targetId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const notifiableAtSend = targetType === "user"
      ? (notifiableUserIds ? notifiableUserIds.has(targetId) : true)
      : (notifiableAgentIds ? notifiableAgentIds.has(targetId) : true);
    targets.push({
      targetType,
      targetId,
      rawHandle,
      targetAvatarUrl,
      notifiableAtSend,
    });
    resolvedFacts.push({
      type: targetType,
      id: targetId,
      name: rawHandle,
    });
  };

  for (const mention of structuredMentions ?? []) {
    const requestedHandle = mention.name.trim();
    const rawHandle = rawByHandle.get(requestedHandle);
    if (!rawHandle) continue;

    // A structured entry means the composer had an identity-bearing mention
    // entity for this visible token. Claim the handle before validation so a
    // stale/malformed identity can never fall through to name-based matching
    // and notify a different same-handle actor. Invalid entries simply become
    // plain text; they never reject the containing message.
    structuredHandleKeys.add(requestedHandle);
    if (!UUID_RE.test(mention.id) || !requestedHandle) continue;

    const bindStructuredTarget = () => {
      const targetKey = `${mention.type}:${mention.id}`;
      const existingTargetKey = structuredTargetByHandle.get(requestedHandle);
      if (existingTargetKey && existingTargetKey !== targetKey) {
        throw new MentionValidationError(
          `Mention @${requestedHandle} is bound to more than one actor. Select exactly one actor id and type.`,
          "mention_binding_conflict",
        );
      }
      structuredTargetByHandle.set(requestedHandle, targetKey);
    };

    if (mention.type === "agent") {
      const candidate = candidateAgents.find((a) => a.id === mention.id);
      if (!candidate || candidate.name !== requestedHandle) continue;
      if (mentionContract === "v2") bindStructuredTarget();
      addRow("agent", candidate.id, rawHandle, candidate.avatarUrl ?? null);
      continue;
    }

    const candidate = candidateHumans.find((h) => h.userId === mention.id);
    if (!candidate || candidate.name !== requestedHandle) continue;
    if (mentionContract === "v2") bindStructuredTarget();
    addRow("user", candidate.userId, rawHandle, candidate.avatarUrl ?? null);
  }

  for (const [handle, rawHandle] of rawByHandle) {
    if (structuredHandleKeys.has(handle)) continue;
    const exactMatches = [
      ...candidateHumans
        .filter((candidate) => candidate.name === handle)
        .map((candidate) => ({
          type: "user" as const,
          id: candidate.userId,
          name: candidate.name,
          avatarUrl: candidate.avatarUrl ?? null,
        })),
      ...candidateAgents
        .filter((candidate) => candidate.name === handle)
        .map((candidate) => ({
          type: "agent" as const,
          id: candidate.id,
          name: candidate.name,
          avatarUrl: candidate.avatarUrl ?? null,
        })),
    ];
    if (mentionContract === "v2" && exactMatches.length > 1) {
      // V2 callers can still author raw text without selecting an actor. Keep
      // that ordinary message successful, but create no mention edge for a
      // token whose actor identity is unknowable. The sender-only unresolved
      // warning is attached after persistence below.
      continue;
    }
    for (const match of exactMatches) {
      addRow(match.type, match.id, rawHandle, match.avatarUrl);
    }
  }

  return { targets, resolvedFacts };
}

async function insertResolvedMentionTargets(
  messageId: string,
  messageSeq: number,
  serverId: string,
  channelId: string,
  targets: ResolvedMentionTarget[],
  deps: MessageServiceDeps,
): Promise<InsertedMentionRow[]> {
  if (targets.length === 0) return [];

  const rows: (typeof messageMentions.$inferInsert)[] = targets.map((target) => ({
    messageId,
    messageSeq,
    serverId,
    channelId,
    targetType: target.targetType,
    targetId: target.targetId,
    handleAtSendTime: target.rawHandle,
    source: "send_path",
    confidence: "exact",
    notifiableAtSend: target.notifiableAtSend,
  }));

  // Batch insert with conflict ignore (idempotent for replays). On replay the
  // conflict path returns no rows, so pending actions are only surfaced on the
  // original send; the sender-side pending query remains the durable surface.
  return deps.insertMentionRows(rows);
}

/**
 * Resolve @handles in message content and write durable mention intent/fact
 * rows. Each resolved handle becomes a row in message_mentions with the
 * target's immutable ID and the raw handle text at send time (rename-immune).
 *
 * Visibility scoping:
 *   - public channel → server-wide, intersected with a human sender's hidden-directory visibility
 *   - private channel / joint channel / thread → channel members only
 *   - DM → same-server candidates, intersected with hidden-directory visibility; only DM participants are notifiable
 *   - agents retain their separately defined directory contract
 *
 * Must be awaited before broadcast/delivery so mention facts are durable
 * before any consumer sees the message.
 */
async function writeMentionFacts(
  messageId: string,
  messageSeq: number,
  serverId: string,
  channelId: string,
  senderType: "user" | "agent",
  senderId: string,
  scopeChannelId: string,
  scopeType: string,
  mentionHandles: string[],
  structuredMentions: StructuredMentionInput[] | undefined,
  mentionContract: "v1" | "v2",
  deps: MessageServiceDeps,
): Promise<{ resolvedFacts: ResolvedMentionFact[]; pendingMentionActions: PendingMentionAction[] }> {
  const resolution = await resolveMentionTargets(
    serverId,
    senderType,
    senderId,
    scopeChannelId,
    scopeType,
    mentionHandles,
    structuredMentions,
    mentionContract,
    deps,
  );
  const insertedRows = await insertResolvedMentionTargets(
    messageId,
    messageSeq,
    serverId,
    channelId,
    resolution.targets,
    deps,
  );

  return {
    resolvedFacts: resolution.resolvedFacts,
    pendingMentionActions: scopeType === "dm"
      ? []
      : await buildPendingMentionActions(insertedRows, resolution.targets, messageId, serverId, channelId, senderType, senderId, deps),
  };
}

/**
 * Sender-side pending actions (mention-AX M-4): one entry per outsider
 * mention written on this send. Replays insert no rows and surface none —
 * the durable pending query remains the cross-turn discovery surface.
 */
async function buildPendingMentionActions(
  insertedRows: InsertedMentionRow[],
  targets: ResolvedMentionTarget[],
  messageId: string,
  serverId: string,
  channelId: string,
  senderType: "user" | "agent",
  senderId: string,
  deps: MessageServiceDeps,
  executor?: DatabaseExecutor,
): Promise<PendingMentionAction[]> {
  const pendingRows = insertedRows.filter((row) => !row.notifiableAtSend);
  if (pendingRows.length === 0) return [];

  const availableActions = await pendingMentionAvailableActions(serverId, channelId, senderType, senderId, deps, executor);
  const handleByTarget = new Map(
    targets.map((target) => [`${target.targetType}:${target.targetId}`, target.rawHandle]),
  );
  const avatarUrlByTarget = new Map(
    targets.map((target) => [`${target.targetType}:${target.targetId}`, target.targetAvatarUrl]),
  );
  return pendingRows
    .map((row) => ({
      resolutionId: row.id,
      messageId,
      targetType: row.targetType,
      targetHandle: handleByTarget.get(`${row.targetType}:${row.targetId}`) ?? "",
      targetAvatarUrl: avatarUrlByTarget.get(`${row.targetType}:${row.targetId}`) ?? null,
      reason: "not_member" as const,
      availableActions,
      expiresAt: new Date(Date.now() + PENDING_MENTION_TTL_MS).toISOString(),
    }));
}

async function resolveMentionScopeForChannel(
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  requestedChannelId: string,
  jointProjection: Awaited<ReturnType<typeof channelService.getActiveJointChannelProjectionsByLocalChannel>>[number] | null,
  jointThreadProjection: Awaited<ReturnType<typeof channelService.getJointThreadProjectionByLocalThread>> | null,
  deps: MessageServiceDeps,
  executor?: DatabaseExecutor,
): Promise<{ scopeChannelId: string; scopeType: string }> {
  let scopeChannelId = requestedChannelId;
  let scopeType = channel.type;
  if (jointProjection) {
    scopeChannelId = jointProjection.localChannelId;
    scopeType = "joint";
  } else if (channel.type === "thread" && jointThreadProjection) {
    scopeChannelId = jointThreadProjection.localParentChannelId;
    const parentChannel = await deps.getChannel(jointThreadProjection.localParentChannelId);
    scopeType = parentChannel?.type ?? "joint";
  } else if (channel.type === "thread" && channel.parentMessageId) {
    // Look up the parent channel to determine effective scope.
    const [parentMsg] = await (executor ?? getDb())
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (parentMsg) {
      const parentChannel = await deps.getChannel(parentMsg.channelId);
      if (parentChannel) {
        scopeChannelId = parentMsg.channelId;
        scopeType = parentChannel.type;
      }
    }
  }
  return { scopeChannelId, scopeType };
}

/**
 * Unified message pipeline: write to DB → broadcast via Socket.io → deliver to agents.
 * Both human (POST /messages) and agent (POST /internal/agent/:id/send) paths call this.
 */
export async function broadcastAndDeliver(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  opts: {
    channelId: string;
    senderType: "user" | "agent";
    senderId: string;
    senderName: string; // displayName for UI (Socket.io broadcast)
    content: string;
    mentions?: StructuredMentionInput[];
    /** Explicitly versioned authoring semantics. Omitted means the byte- and
     * behavior-compatible v1 contract. */
    mentionContract?: "v1" | "v2";
    attachmentIds?: string[];
    agentSendKey?: string;
    randomId?: string;
    actionMetadata?: unknown | null;
    asTask?: boolean;
    /**
     * A message already committed by a dedicated transactional persistence
     * boundary (currently Forward destination projections). The normal
     * broadcast/inbox/agent pipeline still runs, but no second message insert
     * is attempted.
     */
    prePersisted?: {
      message: typeof messages.$inferSelect;
      replayed: boolean;
    };
    /**
     * Agent-projection-only scope line prepended to the content agents
     * receive (task #37: scoped attachment comments deliver before their ref
     * row exists, so the caller passes the scope directly). Never touches
     * the stored message, the socket broadcast, or push bodies.
     */
    agentContentPrefix?: string;
  }
) {
  const deps = resolveMessageServiceDeps();
  // Tests that replace persistence keep their deliberately tiny legacy seam.
  // Runtime production always uses the executor-bound transaction below.
  const useAtomicMessageTransaction = messageServiceDepsOverride === null;
  const { channelId, senderType, senderId, senderName, content, mentions, attachmentIds, agentSendKey, randomId, actionMetadata, asTask } = opts;
  const mentionContract = opts.mentionContract ?? "v1";
  const ordinaryExternalProjectionDecision = classifyOrdinaryMessageExternalProjection({
    senderType,
    messageType: "chat",
    asTask,
    actionMetadata,
  });
  const agentFacingBaseContent = buildAgentFacingBaseContent(content, opts.agentContentPrefix);
  const channelResolveStart = Date.now();
  const requestedChannel = await runSlackBridgeOutboundPipelineStage(
    "channel_resolution",
    () => deps.getChannel(channelId),
  );
  const jointThreadProjection = requestedChannel?.type === "thread"
    ? await channelService.getJointThreadProjectionByLocalThread(channelId)
    : null;
  const jointProjections = requestedChannel?.type === "joint" || jointThreadProjection
    ? await channelService.getActiveJointChannelProjectionsByLocalChannel(jointThreadProjection?.canonicalThreadChannelId ?? channelId)
    : [];
  const jointProjection = jointProjections.find((projection) => projection.localChannelId === channelId);
  const storageChannelId = jointProjection?.canonicalChannelId ?? channelId;
  const externalDeliveryAuthorityChannelId = jointThreadProjection?.localParentChannelId ?? channelId;
  const channel = await runSlackBridgeOutboundPipelineStage(
    "channel_resolution",
    () => deps.getChannel(storageChannelId),
  );
  const frontendTopology: SlackBridgeOutboundPipelineTopology = jointThreadProjection
    ? "joint_thread"
    : channel?.type === "thread"
      ? "ordinary_thread"
      : jointProjection || requestedChannel?.type === "joint" || channel?.type === "joint"
        ? "joint_channel"
        : channel?.type === "dm"
          ? "dm"
          : channel
            ? "ordinary_channel"
            : "missing";

  // Archive gate: reject all chat writes on archived channels (and archived
  // parent channels when writing into a thread). System messages emitted by
  // the archive/unarchive flow use broadcastSystemMessage and therefore
  // bypass this check — that path is how the audit notice itself is posted.
  await runSlackBridgeOutboundPipelineStage(
    "archive_gate",
    () => deps.assertChannelNotArchived(channelId),
    { preserveError: isMessageRouteDomainError },
  );
  if (requestedChannel) {
    await validateStructuredResourceReferences(content, requestedChannel.serverId);
  }
  addTraceEvent("message_pipeline.channel.resolved", {
    duration_ms: Date.now() - channelResolveStart,
    sender_type: senderType,
    target_type: channel?.type ?? "missing",
    joint_projection_present: jointProjection != null,
    joint_thread_projection_present: jointThreadProjection != null,
  });

  const strictMentionHandles = getMentionHandles(content);
  const structuredMentionsForContent = mentions?.filter((mention) => (
    structuredRaftMentionStillAppears(content, mention.name.trim())
  ));
  const mentionHandles = Array.from(new Set([
    ...strictMentionHandles,
    ...(structuredMentionsForContent ?? []).map((mention) => `@${mention.name.trim()}`),
  ]));
  const agentSendAlreadyPersisted = senderType === "agent" && agentSendKey && mentionHandles.length > 0
    ? Boolean((await getDb()
      .select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.senderType, "agent"),
        eq(messages.senderId, senderId),
        eq(messages.agentSendKey, agentSendKey),
      ))
      .limit(1))[0])
    : false;
  let mentionResolution: { targets: ResolvedMentionTarget[]; resolvedFacts: ResolvedMentionFact[] } | null = null;
  let mentionScope: { scopeChannelId: string; scopeType: string } | null = null;
  let idempotentMentionResolutionError: unknown | null = null;
  if (channel && !agentSendAlreadyPersisted) {
    try {
      if (mentionHandles.length > 0) {
        mentionScope = await resolveMentionScopeForChannel(channel, channelId, jointProjection ?? null, jointThreadProjection, deps);
        mentionResolution = await resolveMentionTargets(
          channel.serverId,
          senderType,
          senderId,
          mentionScope.scopeChannelId,
          mentionScope.scopeType,
          mentionHandles,
          structuredMentionsForContent,
          mentionContract,
          deps,
        );
      }
    } catch (error) {
      // Idempotent replays must not reinterpret mutable mention membership.
      // Resolve before the write transaction to avoid nested DB reads, but
      // surface a resolution failure only if this send wins the insert and
      // therefore needs new mention facts.
      if (agentSendKey || randomId) {
        idempotentMentionResolutionError = error;
      } else {
        throw error;
      }
    }
  }

  // 1. v1.4: `asTask` no longer pre-allocates task columns on the message.
  // The host message is persisted as a plain chat message and the task fact is
  // created against it afterwards (see `ensureTaskForMessage` below), so a
  // send-as-task can never produce both a message-task and a canonical task.

  type MessageAttachment = {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
    thumbnailUrl: string | null;
  };
  let replayed = false;
  let message: typeof messages.$inferSelect;
  let msgAttachments: MessageAttachment[];
  let resolvedMentions: ResolvedMentionFact[] = [];
  let pendingMentionActions: PendingMentionAction[] = [];
  let targetVisibleMentions: ResolvedMentionFact[] = [];
  let mentionAndInboxFinalizedInPersistence = false;
  let threadAgentDeliveryCandidatesFromFacts: AgentDeliveryCandidate[] | undefined;

  const finalizeIdempotentAgentSendInTransaction = async (
    executor: DatabaseExecutor,
    persistedMessage: typeof messages.$inferSelect,
    replay: boolean,
  ) => {
    if (replay) {
      const mentionsByMessage = await getMentionFactsForMessagesWithExecutor(executor, [persistedMessage.id]);
      return {
        resolvedMentions: [] as ResolvedMentionFact[],
        pendingMentionActions: [] as PendingMentionAction[],
        targetVisibleMentions: mentionsByMessage.get(persistedMessage.id) ?? [],
      };
    }

    let transactionResolvedMentions: ResolvedMentionFact[] = [];
    let transactionPendingMentionActions: PendingMentionAction[] = [];

    if (channel && mentionHandles.length > 0) {
      if (!mentionScope || !mentionResolution) {
        throw new Error("Agent send mention resolution was not prepared before transactional persistence");
      }
      const transactionDeps: MessageServiceDeps = {
        ...deps,
        insertMentionRows: (rows) => insertMentionRowsWithExecutor(executor, rows),
      };
      const insertedRows = await insertResolvedMentionTargets(
        persistedMessage.id,
        persistedMessage.seq,
        channel.serverId,
        channelId,
        mentionResolution.targets,
        transactionDeps,
      );
      transactionResolvedMentions = mentionResolution.resolvedFacts;
      transactionPendingMentionActions = mentionScope.scopeType === "dm"
        ? []
        : await buildPendingMentionActions(
          insertedRows,
          mentionResolution.targets,
          persistedMessage.id,
          channel.serverId,
          channelId,
          "agent",
          senderId,
          deps,
        );
    }

    const transactionTargetVisibleMentions = mentionHandles.length > 0
      ? (await getMentionFactsForMessagesWithExecutor(executor, [persistedMessage.id])).get(persistedMessage.id) ?? []
      : [];
    if (channel) {
      const transactionDeps: MessageServiceDeps = {
        ...deps,
        getChannelHumans: (localChannelId) => getChannelHumansWithExecutor(executor, localChannelId, channel),
        getChannelAgents: (localChannelId) => getChannelAgentsWithExecutor(executor, localChannelId, channel),
        recordInboxNotificationFacts: (facts, nestedExecutor) => deps.recordInboxNotificationFacts(facts, nestedExecutor ?? executor),
      };
      await recordInboxFactsForPersistedMessage({
        channel,
        message: persistedMessage,
        senderType: "agent",
        senderId,
        targetVisibleMentions: transactionTargetVisibleMentions,
        jointProjections,
        jointThreadProjection,
        deps: transactionDeps,
        executor,
        persistenceState: "transaction_pending",
      });
    }

    return {
      resolvedMentions: transactionResolvedMentions,
      pendingMentionActions: transactionPendingMentionActions,
      targetVisibleMentions: transactionTargetVisibleMentions,
    };
  };

  const persistStart = Date.now();
  const persistence = await traceQuerySpan({
    queryName: "messages.insert",
    phase: "message_persist",
    dbSystem: "postgresql",
    attrs: {
      sender_type: senderType,
      target_type: channel?.type ?? "missing",
      idempotency_key_present: Boolean(agentSendKey || randomId),
    },
    successAttrs: (result: { replayed: boolean; attachments: MessageAttachment[] }) => ({
      replayed: result.replayed,
      attachment_count: result.attachments.length,
    }),
  }, async () => {
    if (opts.prePersisted) {
      return {
        replayed: opts.prePersisted.replayed,
        message: opts.prePersisted.message,
        attachments: [] as MessageAttachment[],
        resolvedMentions,
        pendingMentionActions,
        targetVisibleMentions,
        mentionAndInboxFinalizedInPersistence,
      };
    }
    if (senderType === "agent" && agentSendKey) {
      const replayResult = await traceMessageDbPhase({
        phase: "message_pipeline.persist",
        queryName: "messages.agent_send_transaction",
        dbOperation: "transaction",
      }, () => createOrReplayAgentSend({
        channelId: storageChannelId,
        senderId,
        content,
        agentSendKey,
        attachmentIds,
        beforeInsert: useAtomicMessageTransaction
          ? (executor) => lockOrdinaryMessageExternalDeliveryAdmission({
            executor,
            authorityChannelId: externalDeliveryAuthorityChannelId,
            requestedChannelId: channelId,
            canonicalConversationId: storageChannelId,
            decision: ordinaryExternalProjectionDecision,
          })
          : undefined,
        onInserted: useAtomicMessageTransaction
          ? async ({ executor, message: insertedMessage }: AgentSendInsertedTransactionInput) => {
            if (idempotentMentionResolutionError) throw idempotentMentionResolutionError;
            return finalizeNewChatMessageInTransaction({
              executor,
              message: insertedMessage,
              channel,
              requestedChannelId: channelId,
              senderType,
              senderId,
              authorName: senderName,
              mentionHandles,
              mentionResolution,
              mentionScope,
              mentions,
              jointProjection,
              jointProjections,
              jointThreadProjection,
              ordinaryExternalProjectionDecision,
              mentionContract,
              deps,
            });
          }
          : undefined,
      }));
      const transactionFacts = replayResult.insertedTransactionResult;
      return {
        replayed: replayResult.replayed,
        message: replayResult.message,
        attachments: replayResult.attachments,
        resolvedMentions: transactionFacts?.resolvedMentions ?? resolvedMentions,
        pendingMentionActions: transactionFacts?.pendingMentionActions ?? pendingMentionActions,
        targetVisibleMentions: transactionFacts?.targetVisibleMentions ?? targetVisibleMentions,
        mentionAndInboxFinalizedInPersistence: transactionFacts !== null,
        threadAgentDeliveryCandidates: transactionFacts?.threadAgentDeliveryCandidates,
      };
    }
    if (senderType === "user" && randomId) {
      const replayResult = await traceMessageDbPhase({
        phase: "message_pipeline.persist",
        queryName: "messages.user_random_send_transaction",
        dbOperation: "transaction",
      }, () => createOrReplayUserRandomSend({
        channelId: storageChannelId,
        authorityChannelId: externalDeliveryAuthorityChannelId,
        requestedChannelId: channelId,
        senderId,
        authorName: senderName,
        content,
        randomId,
        attachmentIds,
        actionMetadata: actionMetadata ?? null,
        channel,
        mentionHandles,
        mentionResolution,
        mentionResolutionError: idempotentMentionResolutionError,
        mentionScope,
        mentions,
        mentionContract,
        jointProjection,
        jointProjections,
        jointThreadProjection,
        ordinaryExternalProjectionDecision,
        deps,
      }));
      return {
        replayed: replayResult.replayed,
        message: replayResult.message,
        attachments: replayResult.attachments,
        resolvedMentions: replayResult.resolvedMentions,
        pendingMentionActions: replayResult.pendingMentionActions,
        targetVisibleMentions: replayResult.targetVisibleMentions,
        mentionAndInboxFinalizedInPersistence: true,
        threadAgentDeliveryCandidates: replayResult.threadAgentDeliveryCandidates,
      };
    }
    const persistDirectSend = async (executor?: DatabaseExecutor) => {
      const createdMessage = await deps.createMessage(
        storageChannelId,
        senderType,
        senderId,
        content,
        "chat",
        // v1.4: never a task-message — the task fact is created separately.
        undefined,
        { actionMetadata: actionMetadata ?? null },
        executor,
      );
      const linked = executor && attachmentIds && attachmentIds.length > 0
        ? await linkAttachmentRowsToMessageWithExecutor(
          executor,
          attachmentIds,
          createdMessage.id,
          senderId,
        )
        : [];
      const facts = executor && useAtomicMessageTransaction
        ? await finalizeNewChatMessageInTransaction({
          executor,
          message: createdMessage,
          channel,
          requestedChannelId: channelId,
          senderType,
          senderId,
          authorName: senderName,
          mentionHandles,
          mentionResolution,
          mentionScope,
          mentions,
          jointProjection,
          jointProjections,
          jointThreadProjection,
          ordinaryExternalProjectionDecision,
          mentionContract,
          deps,
        })
        : {
          resolvedMentions,
          pendingMentionActions,
          targetVisibleMentions,
          outboundDeliveryId: null,
          threadAgentDeliveryCandidates: undefined,
        };
      return {
        replayed: false,
        message: createdMessage,
        attachments: linked.map(toLinkedMessageAttachment),
        ...facts,
        mentionAndInboxFinalizedInPersistence: executor != null && useAtomicMessageTransaction,
      };
    };

    if (useAtomicMessageTransaction) {
      return traceMessageDbPhase({
        phase: "message_pipeline.persist",
        queryName: "messages.direct_send_transaction",
        dbOperation: "transaction",
      }, () => getDb().transaction(async (tx) => {
        await lockOrdinaryMessageExternalDeliveryAdmission({
          executor: tx,
          authorityChannelId: externalDeliveryAuthorityChannelId,
          requestedChannelId: channelId,
          canonicalConversationId: storageChannelId,
          decision: ordinaryExternalProjectionDecision,
        });
        return persistDirectSend(tx);
      }));
    }
    return traceMessageDbPhase({
      phase: "message_pipeline.persist",
      queryName: "messages.direct_send_insert",
      dbOperation: "insert",
    }, () => persistDirectSend());
  });
  replayed = persistence.replayed;
  message = persistence.message;
  msgAttachments = persistence.attachments;
  resolvedMentions = persistence.resolvedMentions;
  pendingMentionActions = persistence.pendingMentionActions;
  targetVisibleMentions = persistence.targetVisibleMentions;
  mentionAndInboxFinalizedInPersistence = persistence.mentionAndInboxFinalizedInPersistence;
  threadAgentDeliveryCandidatesFromFacts = persistence.threadAgentDeliveryCandidates;
  addTraceEvent("message_pipeline.message.persisted", {
    duration_ms: Date.now() - persistStart,
    sender_type: senderType,
    target_type: channel?.type ?? "missing",
    replayed,
    attachment_count: msgAttachments.length,
    as_task: asTask === true,
  });

  // 1b. Create the canonical task fact for `asTask` sends. Runs after persist so
  // it associates to a real message id, and is idempotent so an idempotency-key
  // replay converges on the same task row rather than minting a second one.
  let createdTask: TaskRow | null = null;
  if (asTask) {
    const taskCreateStart = Date.now();
    createdTask = await ensureTaskForMessage(message.id, senderType, senderId);
    addTraceEvent("message_pipeline.task_number.allocated", {
      duration_ms: Date.now() - taskCreateStart,
      sender_type: senderType,
    });
    // The remaining pipeline (socket payloads, agent delivery) reads task facts
    // off the message row. Project the just-created canonical facts back onto
    // this in-memory row so every downstream consumer keeps the pre-v1.4 shape
    // without re-querying, and without persisting them to messages.task_*.
    if (createdTask) {
      message = {
        ...message,
        taskStatus: createdTask.status,
        taskNumber: createdTask.taskNumber,
        taskAssigneeType: createdTask.claimedByType,
        taskAssigneeId: createdTask.claimedById,
        taskClaimedAt: createdTask.claimedAt,
        taskCompletedAt: createdTask.completedAt,
      };
    }
  }

  const mentionWriteStart = Date.now();

  // 2. Write message_mentions — send-time resolved mention intent/fact.
  // Awaited before broadcast/delivery so mention facts are durable.
  // Replay reuses an already-created message row. Its mention facts were
  // written on the original send, so do not re-write them here.
  // Thread scope: resolve against parent channel's effective scope, but write
  // the thread's own channelId so Inbox thread row can find it.
  if (!mentionAndInboxFinalizedInPersistence && channel && !replayed && mentionHandles && mentionHandles.length > 0) {
    if (mentionResolution) {
      const insertedRows = await insertResolvedMentionTargets(
        message.id,
        message.seq,
        channel.serverId,
        channelId,
        mentionResolution.targets,
        deps,
      );
      resolvedMentions = mentionResolution.resolvedFacts;
      pendingMentionActions = mentionScope?.scopeType === "dm"
        ? []
        : await buildPendingMentionActions(insertedRows, mentionResolution.targets, message.id, channel.serverId, channelId, senderType, senderId, deps);
    } else {
      mentionScope = mentionScope ?? await resolveMentionScopeForChannel(channel, channelId, jointProjection ?? null, jointThreadProjection, deps);
      const written = await writeMentionFacts(
        message.id,
        message.seq,
        channel.serverId,
        channelId,
        senderType,
        senderId,
        mentionScope.scopeChannelId,
        mentionScope.scopeType,
        mentionHandles,
        mentions,
        mentionContract,
        deps,
      );
      resolvedMentions = written.resolvedFacts;
      pendingMentionActions = written.pendingMentionActions;
    }
  }
  if (mentionHandles && mentionHandles.length > 0) {
    addTraceEvent("message_pipeline.mentions.recorded", {
      duration_ms: Date.now() - mentionWriteStart,
      sender_type: senderType,
      target_type: channel?.type ?? "missing",
      mention_count: mentionHandles.length,
      resolved_count: resolvedMentions.length,
      replayed,
    });
  }
  if (!mentionAndInboxFinalizedInPersistence && mentionHandles && mentionHandles.length > 0) {
    targetVisibleMentions = (await deps.getMentionFactsForMessages([message.id])).get(message.id) ?? [];
  }

  let inboxFactsRecorded = false;
  const recordInboxFactsForSend = async () => {
    if (!channel || replayed || inboxFactsRecorded || mentionAndInboxFinalizedInPersistence) return;
    const inboxFactStart = Date.now();
    const { recorded: factCount, threadAgentDeliveryCandidates } = await recordInboxFactsForPersistedMessage({
      channel,
      message,
      senderType,
      senderId,
      targetVisibleMentions,
      jointProjections,
      jointThreadProjection,
      deps,
    });
    threadAgentDeliveryCandidatesFromFacts = threadAgentDeliveryCandidates;
    inboxFactsRecorded = true;
    addTraceEvent("message_pipeline.inbox_notification_facts.recorded", {
      duration_ms: Date.now() - inboxFactStart,
      sender_type: senderType,
      target_type: channel.type,
      fact_count: factCount,
      joint_projection_present: jointProjection != null,
      joint_thread_projection_present: jointThreadProjection != null,
    });
  };
  await recordInboxFactsForSend();

  const enriched = {
    ...message,
    channelId: jointProjection?.localChannelId ?? message.channelId,
    senderName,
    senderMembershipStatus: senderType === "user" && message.messageType !== "system" ? "active" as const : null,
    attachments: msgAttachments,
    mentions: targetVisibleMentions,
  };
  const targetVisibleMentionedAgentIds = new Set(targetVisibleMentions.filter((mention) => mention.type === "agent").map((mention) => mention.id));
  // Sender-side only (mention-AX M-4/N-6): outsider mentions that produced no
  // target-side notification on this send. Keep this off enumerable message
  // payloads so socket/list/recipient hydration cannot surface it by accident.
  attachSenderPendingMentionActions(enriched, pendingMentionActions);
  // An exact authored token can resolve to no actor at all (unknown handle or
  // not visible in the effective private/thread scope). That case creates no
  // durable mention row, so expose it only on the original sender response.
  // Replays intentionally surface neither this ephemeral warning nor pending
  // actions; durable pending discovery remains `raft mention pending`.
  if (mentionContract === "v2" && !replayed && mentionHandles && mentionHandles.length > 0) {
    attachSenderUnresolvedMentionHandles(
      enriched,
      findUnresolvedMentionHandles(mentionHandles, resolvedMentions, structuredMentionsForContent),
    );
  }

  if (channel?.type === "thread" && jointThreadProjection && channel.parentMessageId && !replayed) {
    const jointThreadSideEffectsStart = Date.now();
    const { uniqueName: senderUniqueName, description: senderDescription } = await deps.getSenderIdentity(senderType, senderId, senderName);
    await handleJointThreadPostBroadcastSideEffects({
      io,
      agentOrchestrator,
      deps,
      canonicalThreadChannelId: storageChannelId,
      canonicalParentMessageId: channel.parentMessageId,
      sourceServerId: jointThreadProjection.localServerId,
      senderType,
      senderId,
      senderName,
      senderUniqueName,
      senderDescription,
      content,
      message,
      attachments: msgAttachments,
      resolvedMentions,
      targetVisibleMentions,
    });
    addTraceEvent("message_pipeline.joint_thread_side_effects.finished", {
      duration_ms: Date.now() - jointThreadSideEffectsStart,
      sender_type: senderType,
      attachment_count: msgAttachments.length,
      mention_count: resolvedMentions.length,
    });
  }

  // 3. Broadcast to frontend via Socket.io
  const frontendEmitStart = Date.now();
  await runSlackBridgeOutboundPipelineStage(
    "frontend_emit",
    () => emitPersistedMessageToFrontend(io, {
      channelId: storageChannelId,
      senderType,
      senderId,
      message,
      enriched,
      asTask,
      createdTask,
      topology: frontendTopology,
      onSocketEmitFailure: ({ phase, topology }) => {
        addTraceEvent("message_pipeline.frontend_socket_emit.degraded", {
          phase,
          topology,
          persistence_state: "durable",
          failure_policy: "continue_from_persisted_state",
          sender_type: senderType,
          target_type: channel?.type ?? "missing",
          replayed,
        });
      },
    }),
    { preserveError: isMessageRouteDomainError, topology: frontendTopology },
  );
  addTraceEvent("message_pipeline.frontend_emitted", {
    duration_ms: Date.now() - frontendEmitStart,
    sender_type: senderType,
    target_type: channel?.type ?? "missing",
    replayed,
  });

  if (replayed) {
    return enriched;
  }

  // 4. Advance sender's legacy read-ish cursor so their own message isn't counted as unread
  const senderReadMutation = senderType === "user"
    ? deps.markRead(senderId, channelId, message.seq)
    : deps.markAgentLegacyRead(senderId, channelId, message.seq);
  const sourceServerId = requestedChannel?.serverId ?? channel?.serverId;
  if (sourceServerId) {
    scheduleSenderReadReceipt({
      io,
      serverId: sourceServerId,
      channelId,
      senderType,
      senderId,
      readMutation: senderReadMutation,
    });
  } else {
    senderReadMutation.catch(() => {});
  }
  addTraceEvent("message_pipeline.sender_read_scheduled", {
    sender_type: senderType,
    target_type: channel?.type ?? "missing",
  });

  // 6. Deliver to agents in this channel (excluding sender if it's an agent).
  // For threads, the agent set is the set of thread followers (type=agent).
  const isDM = channel?.type === "dm";
  const isThread = channel?.type === "thread";
  if (isThread && jointThreadProjection && channel?.parentMessageId) {
    addTraceEvent("message_pipeline.delivery.skipped", {
      reason: "joint_thread_projection",
      sender_type: senderType,
      target_type: "thread",
    });
    return enriched;
  }
  if (jointProjection && jointProjections.length > 0) {
    const jointDeliveryScheduleStart = Date.now();
    const { uniqueName: senderUniqueName, description: senderDescription } = await deps.getSenderIdentity(senderType, senderId, senderName);
    const senderAuthorityServerId = jointProjection?.serverId ?? channel.serverId;
    const agentDeliveryOptions = await getAgentDeliveryOptionsForSender(deps, senderAuthorityServerId, senderType, senderId);
    const db = getDb();
    const mentionNames = getMentionNameSet(content);
    const mentionedUserIds = new Set(targetVisibleMentions.filter((mention) => mention.type === "user").map((mention) => mention.id));
    const body = summarizePushBody(content, msgAttachments.length);
    const deliveries = jointProjections.map(async (projection): Promise<NotificationPushProjectionGroup | null> => {
      const projectionAgents = await deps.getChannelAgents(projection.localChannelId);
      const renderedBaseContent = await deps.renderAgentReadablePermalinks(agentFacingBaseContent, projection.serverId);
      const piercedAgentIds = new Set(targetVisibleMentionedAgentIds);
      if (message.senderType !== "external_projection" && message.taskAssigneeType === "agent" && message.taskAssigneeId) {
        piercedAgentIds.add(message.taskAssigneeId);
      }
      const mutedAgentIds = await deps.getActivityMutedAgentIdsForMessage({
        serverId: projection.serverId,
        sourceChannelId: projection.localChannelId,
        agentIds: projectionAgents.map((agent) => agent.id),
        messageSeq: message.seq,
        piercedAgentIds,
      });
      await Promise.all(projectionAgents.map(async (agent) => {
        if ((senderType === "agent" && agent.id === senderId) || mutedAgentIds.has(agent.id)) return;
        const recipientForwardedSnapshot = formatForwardedBundleForAgent(
          await scrubForwardedBundleMetadataForViewer(actionMetadata, {
            type: "agent",
            id: agent.id,
            serverId: projection.serverId,
          }, deps.canViewerReadForwardedSource),
        );
        const renderedContent = appendAgentForwardedSnapshot(renderedBaseContent, recipientForwardedSnapshot);
        await agentOrchestrator.deliverMessage(agent.id, {
          channel_id: projection.localChannelId,
          channel_name: projection.channel.name,
          channel_type: "channel",
          sender_id: senderId,
          sender_name: senderUniqueName,
          sender_type: toAgentVisibleSenderType(senderType),
          sender_description: senderDescription,
          content: renderedContent,
          timestamp: message.createdAt.toISOString(),
          seq: message.seq,
          message_id: message.id,
          ...(targetVisibleMentionedAgentIds.has(agent.id) && { mentioned: true }),
        }, agentDeliveryOptions).catch((err) => {
          console.error(`[MessageService] Failed to deliver joint message to agent ${agent.id}:`, serializeErrorForLog(err));
        });
      }));
      const [serverRow] = await db
        .select({ slug: servers.slug, name: servers.name })
        .from(servers)
        .where(eq(servers.id, projection.serverId))
        .limit(1);
      if (!serverRow?.slug) return null;
      const humanScopeMembers = await deps.getChannelHumans(projection.localChannelId);
      const projectionPushTargets = buildPushTargetsFromContext({
        serverSlug: serverRow.slug,
        serverName: serverRow.name,
        channel: {
          id: projection.localChannelId,
          type: "joint",
          name: projection.channel.name,
          parentMessageId: null,
        },
        messageId: message.id,
        senderId,
        senderType,
        senderName,
        body,
        mentionNames,
        mentionedUserIds,
        humanScopeMembers,
      });
      const serverMutedUserIds = await resolveServerPushSuppressionForPipeline({
        surface: "joint_channel",
        serverId: projection.serverId,
        targetUserIds: [...projectionPushTargets.keys()],
        targetVisibleMentionedUserIds: mentionedUserIds,
      });
      const activityMutedUserIds = await channelService.getActivityMutedUserIdsForMessage({
        serverId: projection.serverId,
        sourceChannelId: projection.localChannelId,
        userIds: [...projectionPushTargets.keys()],
        messageSeq: message.seq,
        piercedUserIds: mentionedUserIds,
      });
      const mutedUserIds = new Set([...serverMutedUserIds, ...activityMutedUserIds]);
      for (const userId of mutedUserIds) projectionPushTargets.delete(userId);
      const notificationPushSocketIdentity: NotificationPushSocketIdentity = {
        serverId: projection.serverId,
        kind: "channel",
        channelId: projection.localChannelId,
        threadId: null,
        parentChannelId: null,
        parentMessageId: null,
        messageId: message.id,
      };
      return {
        targets: projectionPushTargets,
        identity: notificationPushSocketIdentity,
      };
    });
    Promise.all(deliveries).then(async (groups) => {
      const projectionTargets = buildNotificationPushProjectionTargets(
        groups.filter((group): group is NotificationPushProjectionGroup => group != null),
      );
      addTraceEvent("message_pipeline.joint_delivery.scheduled", {
        duration_ms: Date.now() - jointDeliveryScheduleStart,
        projection_count: jointProjections.length,
        push_target_count: projectionTargets.length,
        sender_type: senderType,
      });
      if (projectionTargets.length === 0) return;
      const canonicalTargets = selectCanonicalNotificationProjectionTargets(projectionTargets, {
        serverId: senderAuthorityServerId,
        messageId: message.id,
      });
      await deps.persistNativeNotificationIntents(resolveNotificationIntents(canonicalTargets, message.createdAt)).catch(() => {
        console.error("[MessageService] Failed to persist native notification intents");
      });
      const appUrl = getConfiguredAppUrl();
      if (!appUrl) {
        console.warn("[MessageService] Skipping joint channel web push dispatch because APP_URL is not configured");
        return;
      }
      const targets = buildAbsoluteNotificationPushProjectionTargets(projectionTargets, appUrl);
      const webPushTargets = selectCanonicalNotificationProjectionTargets(targets, {
        serverId: senderAuthorityServerId,
        messageId: message.id,
      });
      deps.sendPushNotifications(webPushTargets).catch((err) => {
        console.error("[MessageService] Failed to dispatch joint channel web push notifications:", serializeErrorForLog(err));
      });
      emitNotificationPushProjectionTargets(io, targets);
    }).catch(() => {});
    return enriched;
  }
  const deliveryPrepStart = Date.now();
  const threadAgentDeliveryResolution = isThread
    ? await resolveThreadAgentDeliveryCandidates({
        deps,
        threadChannelId: channelId,
        messageId: message.id,
        precomputedCandidates: threadAgentDeliveryCandidatesFromFacts,
      })
    : null;
  const channelAgentList: { id: string }[] = threadAgentDeliveryResolution
    ? threadAgentDeliveryResolution.candidates
    : await deps.getChannelAgents(channelId);

  // Resolve the unique sender name (for @mentions) and description for agent-visible metadata.
  const { uniqueName: senderUniqueName, description: senderDescription } = await deps.getSenderIdentity(senderType, senderId, senderName);

  // For DMs, resolve the human peer's unique name for each agent
  let dmHumanUniqueNames: Map<string, string> | undefined;
  if (isDM) {
    const humans = await deps.getChannelHumans(channelId);
    dmHumanUniqueNames = new Map(humans.map((h) => [h.id, h.name]));
  }

  // For threads, resolve parent channel info and auto-join @mentioned agents
  let parentChannelName: string | undefined;
  let parentChannelId: string | undefined;
  let parentChannelType: string | undefined;
  let parentDmHumanNames: Map<string, string> | undefined;
  let threadShortId: string | undefined;
  const newlyJoinedThreadAgentIds = new Set<string>();
  const reactivatedThreadAgentIds = new Set<string>();
  let threadJoinContextBase: ThreadJoinContextBase | undefined;
  if (isThread && channel?.parentMessageId) {
    const db = getDb();
    const [parentMsg] = await db.select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, channel.parentMessageId));
    if (parentMsg) {
      parentChannelId = jointThreadProjection?.localParentChannelId ?? parentMsg.channelId;
      threadShortId = getMessageShortId(channel.parentMessageId);
      const parentChannel = await channelService.getChannel(parentChannelId);
      if (parentChannel) {
        parentChannelName = parentChannel.name;
        parentChannelType = parentChannel.type;
        // For DM parent channels, resolve human peer names so each agent gets the right target
        if (parentChannel.type === "dm") {
          const humans = await channelService.getChannelHumans(parentChannelId);
          parentDmHumanNames = new Map(humans.map((h) => [h.id, h.name]));
        }
      }

      // Mention auto-follow (see thread contract in schema.ts):
      //   all thread kinds → parent-channel members only. A mention never pulls
      //   a parent-channel outsider into the thread (mention-AX contract
      //   N-1/N-7, supersedes the former public-thread server-wide scope of
      //   task #52); outsiders go through the sender-side resolution flow
      //   (notify/add) instead.
      // Inserted with reason='mentioned'. Still subject to the join != post
      // invariant: a mentioned follower gains notifications, not send rights.
      const mentionedAgentIds = new Set(resolvedMentions.filter((mention) => mention.type === "agent").map((mention) => mention.id));
      const mentionedUserIds = new Set(resolvedMentions.filter((mention) => mention.type === "user").map((mention) => mention.id));
      if (mentionedAgentIds.size > 0 || mentionedUserIds.size > 0) {
        const candidateAgents = await deps.getChannelAgents(parentChannelId);
        const threadAgentIds = new Set(channelAgentList.map((a) => a.id));
        for (const mentionedAgentId of mentionedAgentIds) {
          const mentionedAgent = candidateAgents.find((a) => a.id === mentionedAgentId);
          if (mentionedAgent) {
            const alreadyInDeliveryAudience = threadAgentIds.has(mentionedAgent.id);
            const [existingFollow] = await db
              .select({ doneAt: threadFollows.doneAt, unfollowedAt: threadFollows.unfollowedAt })
              .from(threadFollows)
              .where(and(
                eq(threadFollows.threadChannelId, channelId),
                eq(threadFollows.followerType, "agent"),
                eq(threadFollows.followerId, mentionedAgent.id),
              ))
              .limit(1);
            const followPlan = planDirectMentionThreadFollow(existingFollow);
            if (!followPlan.shouldActivate) {
              if (!alreadyInDeliveryAudience) {
                channelAgentList.push(mentionedAgent);
                threadAgentIds.add(mentionedAgent.id);
              }
              continue;
            }
            await channelService.recordThreadFollow(
              "agent",
              mentionedAgent.id,
              channelId,
              channel.parentMessageId!,
              "mentioned",
              { reactivateUnfollowed: true, preserveExistingReason: true },
            );
            const followRows = await db
              .select({ followerId: threadFollows.followerId })
              .from(threadFollows)
              .where(and(
                eq(threadFollows.threadChannelId, channelId),
                eq(threadFollows.followerType, "agent"),
                eq(threadFollows.followerId, mentionedAgent.id),
                isNull(threadFollows.unfollowedAt),
              ))
              .limit(1);
            if (followRows.length > 0) {
              if (!alreadyInDeliveryAudience) {
                channelAgentList.push(mentionedAgent);
                threadAgentIds.add(mentionedAgent.id);
              }
              if (followPlan.reactivatedExplicitUnfollow) {
                reactivatedThreadAgentIds.add(mentionedAgent.id);
              } else {
                newlyJoinedThreadAgentIds.add(mentionedAgent.id);
              }
            } else {
              if (!alreadyInDeliveryAudience) {
                channelAgentList.push(mentionedAgent);
                threadAgentIds.add(mentionedAgent.id);
              }
            }
          }
        }

        const candidateHumans = (await deps.getChannelHumans(parentChannelId)).map((h) => ({ ...h, userId: h.id }));
        for (const mentionedUserId of mentionedUserIds) {
          const mentionedUser = candidateHumans.find((h) => h.userId === mentionedUserId);
          if (mentionedUser) {
            const [existingFollow] = await db
              .select({ doneAt: threadFollows.doneAt, unfollowedAt: threadFollows.unfollowedAt })
              .from(threadFollows)
              .where(and(
                eq(threadFollows.threadChannelId, channelId),
                eq(threadFollows.followerType, "user"),
                eq(threadFollows.followerId, mentionedUser.userId),
              ))
              .limit(1);
            if (planDirectMentionThreadFollow(existingFollow).shouldActivate) {
              await channelService.recordThreadFollow(
                "user",
                mentionedUser.userId,
                channelId,
                channel.parentMessageId!,
                "mentioned",
                { reactivateUnfollowed: true, preserveExistingReason: true },
              );
            }
          }
        }
      }

      if (channelAgentList.some((agent) => targetVisibleMentionedAgentIds.has(agent.id))) {
        threadJoinContextBase = await buildThreadJoinContextBase(
          channelId,
          channel.parentMessageId,
          message.seq,
        );
      }
    }
  }

  // Fire-and-forget: deliver to agents in parallel, don't block the response.
  // Messages are already persisted in DB, so no durability risk.
  const renderedBaseContent = await deps.renderAgentReadablePermalinks(agentFacingBaseContent, channel.serverId);
  const deliveryOptions = await getAgentDeliveryOptionsForSender(deps, channel.serverId, senderType, senderId);
  const deliveryPromises: Promise<unknown>[] = [];
  const preparedDeliveries: { agentId: string; deliveryPayload: AgentMessage }[] = [];
  const mentionNames = getMentionNameSet(content);
  // Mention-driven delivery to non-joined agents is gated on target-visible
  // mention facts (mention-AX M-3/N-4): an outsider mention is not visible at
  // send time, so it produces no delivery here. After a sender notify/add
  // action marks the fact notified, target delivery happens on the action
  // path, not by re-running send-time delivery.
  const joinedAgentIds = new Set(channelAgentList.map((agent) => agent.id));
  const mentionOnlyAgents =
    channel?.type === "channel" && targetVisibleMentionedAgentIds.size > 0
      ? (await deps.listAgents(channel.serverId)).filter(
          (agent) => !joinedAgentIds.has(agent.id) && targetVisibleMentionedAgentIds.has(agent.id),
        )
      : [];
  const deliveryAgents = [...channelAgentList, ...mentionOnlyAgents];
  const agentMutePiercedIds = new Set(targetVisibleMentionedAgentIds);
  if (message.senderType !== "external_projection" && message.taskAssigneeType === "agent" && message.taskAssigneeId) {
    agentMutePiercedIds.add(message.taskAssigneeId);
  }
  const mutedAgentDeliveryIds = !isThread
    ? await deps.getActivityMutedAgentIdsForMessage({
        serverId: channel.serverId,
        sourceChannelId: channelId,
        agentIds: deliveryAgents.map((agent) => agent.id),
        messageSeq: message.seq,
        piercedAgentIds: agentMutePiercedIds,
      })
    : new Set<string>();
  for (const agent of deliveryAgents) {
    if (senderType === "agent" && agent.id === senderId) continue;
    if (mutedAgentDeliveryIds.has(agent.id)) continue;
    const recipientForwardedSnapshot = formatForwardedBundleForAgent(
      await scrubForwardedBundleMetadataForViewer(actionMetadata, {
        type: "agent",
        id: agent.id,
        serverId: channel.serverId,
      }, deps.canViewerReadForwardedSource),
    );
    const renderedContent = appendAgentForwardedSnapshot(renderedBaseContent, recipientForwardedSnapshot);

    // For DM channels, use the human peer's unique name (not the channel's stored name)
    let channelNameForAgent = channel?.name || "unknown";
    if (isDM && dmHumanUniqueNames) {
      // The DM peer from the agent's perspective is the sender (if human)
      channelNameForAgent = senderUniqueName;
    }

    // For threads in DMs, resolve the parent DM peer name per agent
    let parentNameForAgent = parentChannelName;
    if (isThread && parentChannelType === "dm" && parentDmHumanNames) {
      // Find any human in the DM as the peer name (from the agent's perspective)
      for (const [, name] of parentDmHumanNames) {
        parentNameForAgent = name;
        break;
      }
    }

    let threadJoinContext: AgentThreadJoinContext | undefined;
    if (
      isThread &&
      threadJoinContextBase &&
      threadShortId &&
      parentChannelType &&
      parentNameForAgent &&
      targetVisibleMentionedAgentIds.has(agent.id)
    ) {
      const parentTarget = formatParentTarget(parentChannelType, parentNameForAgent);
      const threadTarget = formatThreadTarget(parentChannelType, parentNameForAgent, threadShortId);
      threadJoinContext = {
        ...threadJoinContextBase,
        parent_target: parentTarget,
        thread_target: threadTarget,
        suggested_read_history_target: threadTarget,
      };
    }

    const deliveryPayload: AgentMessage = {
        channel_id: channelId,
        channel_name: channelNameForAgent,
        channel_type: isThread ? "thread" : isDM ? "dm" : channel?.type === "joint" ? "joint" : channel?.type === "private" ? "private" : "channel",
        sender_id: senderId,
        sender_name: senderUniqueName,
        sender_description: senderDescription,
        sender_type: toAgentVisibleSenderType(senderType, message.messageType),
        content: renderedContent,
        timestamp: message.createdAt.toISOString(),
        seq: message.seq,
        message_id: message.id,
        ...(targetVisibleMentionedAgentIds.has(agent.id) && { mentioned: true }),
        ...(isThread && { parent_channel_name: parentNameForAgent, parent_channel_id: parentChannelId, parent_channel_type: parentChannelType as "channel" | "private" | "joint" | "dm" }),
        ...(msgAttachments.length > 0 && {
          attachments: msgAttachments.map(a => ({
            id: a.id,
            filename: normalizeAttachmentFilename(a.filename),
            mimeType: resolveAttachmentMimeType(a.filename, a.mimeType),
            sizeBytes: a.sizeBytes,
          })),
        }),
        ...(message.senderType !== "external_projection" && message.taskStatus != null && {
          task_status: message.taskStatus as "todo" | "in_progress" | "in_review" | "done" | "closed",
          task_number: message.taskNumber,
          task_assignee_type: toAgentVisibleTaskAssigneeType(message.taskAssigneeType as InternalActorType | null),
          task_assignee_id: message.taskAssigneeId,
          task_assignee_name: getAgentVisibleTaskAssigneeName(message),
        }),
        ...(threadJoinContext && { thread_join_context: threadJoinContext }),
        ...(isThread && threadShortId && parentChannelType && parentNameForAgent && reactivatedThreadAgentIds.has(agent.id) && {
          thread_follow_reactivation: {
            thread_target: formatThreadTarget(parentChannelType, parentNameForAgent, threadShortId),
          },
        }),
      };
    preparedDeliveries.push({ agentId: agent.id, deliveryPayload });
  }

  // One batched resolve+persist for every target-visible mentioned agent, BEFORE any delivery is
  // initiated. Under the state-machine recovery predicate an existing un-acked occurrence is
  // re-delivered, so "recorded but never delivered" is recoverable while "delivered but never
  // recorded" is not — hence durability has to precede delivery, not follow it.
  const mentionOccurrenceCandidates = preparedDeliveries.filter(
    (prepared) => targetVisibleMentionedAgentIds.has(prepared.agentId),
  );
  let mentionDeliveryOccurrenceIds = new Map<string, string>();
  try {
    mentionDeliveryOccurrenceIds = await ensureAgentMentionDeliveryOccurrencesForAgents(
      message.id,
      mentionOccurrenceCandidates,
    );
  } catch (err) {
    // DECLARED DEGRADATION. A record-keeping write must never suppress the thing it records, so we
    // still deliver. The cost we accept in exchange is that these mentions become UNRECOVERABLE.
    // Note the exact mechanism: the occurrence ROW still exists (insertMentionRowsWithOccurrenceRecords
    // wrote it atomically with the mention facts) — what is missing is its deliveryPayload, and both
    // listRecoverableMentionDeliveries and ...ForAgent filter on isNotNull(deliveryPayload), so a
    // payload-less occurrence can never be redriven. That cost
    // is emitted as a typed trace rather than only a log line, so an intentionally accepted
    // degradation is observable and assertable instead of implicit in the implementation.
    addTraceEvent("message_pipeline.mention_occurrence.persist_degraded", {
      message_id: message.id,
      intended_occurrence_count: mentionOccurrenceCandidates.length,
      delivered_without_occurrence: true,
      recoverable: false,
    });
    console.error(
      `[MessageService] mention delivery occurrences unavailable for message ${message.id}; delivering without them (these mentions are not recoverable):`,
      err,
    );
  }

  // Invoked synchronously here, as before this spine existed, so delivery is initiated before
  // broadcastAndDeliver returns.
  for (const { agentId, deliveryPayload } of preparedDeliveries) {
    const mentionDeliveryOccurrenceId = mentionDeliveryOccurrenceIds.get(agentId);
    deliveryPromises.push(
      agentOrchestrator.deliverMessage(agentId, deliveryPayload, {
        ...deliveryOptions,
        ...(mentionDeliveryOccurrenceId && { mentionDeliveryOccurrenceId }),
      }).catch((err) => {
        console.error(`[MessageService] Failed to deliver to agent ${agentId}:`, serializeErrorForLog(err));
      }),
    );
  }
  // These delivery promises now carry real DB work, so the aggregate joins this file's existing
  // drainable lifecycle instead of staying an unregistered fire-and-forget. Registration is
  // synchronous, so it is visible before we return; the product path stays non-blocking because
  // nothing here is awaited.
  trackSenderReadReceipt(Promise.all(deliveryPromises).then(() => undefined));
  addTraceEvent("message_pipeline.agent_delivery.scheduled", {
    ...traceChannelAudienceAttrs(channel),
    duration_ms: Date.now() - deliveryPrepStart,
    sender_type: senderType,
    channel_agent_count: channelAgentList.length,
    agent_audience_count: channelAgentList.length,
    mention_only_agent_count: mentionOnlyAgents.length,
    muted_agent_suppressed_count: mutedAgentDeliveryIds.size,
    delivery_count: deliveryPromises.length,
    agent_delivery_count: deliveryPromises.length,
    newly_joined_thread_agent_count: newlyJoinedThreadAgentIds.size,
    reactivated_thread_agent_count: reactivatedThreadAgentIds.size,
    ...(threadAgentDeliveryResolution && { thread_agent_audience_source: threadAgentDeliveryResolution.source }),
  });

  const pushBuildStart = Date.now();
  const pushTargets = await deps.buildPushTargets({
    channel,
    messageId: message.id,
    messageSeq: message.seq,
    senderId,
    senderType,
    senderName,
    content,
    mentionedUserIds: new Set(targetVisibleMentions.filter((mention) => mention.type === "user").map((mention) => mention.id)),
    attachmentCount: msgAttachments.length,
  });
  const pushTraceAttrs = getPushTargetTraceAttrs(pushTargets);
  addTraceEvent("message_pipeline.push_targets.built", {
    ...traceChannelAudienceAttrs(channel),
    duration_ms: Date.now() - pushBuildStart,
    sender_type: senderType,
    target_count: pushTargets.size,
    ...pushTraceAttrs,
  });
  if (pushTargets.size > 0) {
    const identity = buildNotificationPushSocketIdentity(channel, message.id, parentChannelId ?? null);
    const intentTargets = buildNotificationPushProjectionTargets([{ targets: pushTargets, identity }]);
    await deps.persistNativeNotificationIntents(resolveNotificationIntents(intentTargets, message.createdAt)).catch(() => {
      console.error("[MessageService] Failed to persist native notification intents");
    });
    const appUrl = getConfiguredAppUrl();
    if (!appUrl) {
      console.warn("[MessageService] Skipping web push dispatch because APP_URL is not configured");
    } else {
      const targets = buildAbsolutePushTargets(pushTargets, appUrl);
      const socketTargets = isNotificationPushSocketEnabled()
        ? deps.buildNotificationPushSocketTargets(targets, identity)
        : [];
      deps.sendPushNotifications(targets).catch((err) => {
        console.error("[MessageService] Failed to dispatch web push notifications:", serializeErrorForLog(err));
      });
      await emitFrontendSocketBestEffort({
        topology: frontendTopology,
        work: () => emitNotificationPushSocketTargets(io, socketTargets),
        onSocketEmitFailure: ({ phase, topology }) => {
          addTraceEvent("message_pipeline.frontend_socket_emit.degraded", {
            phase,
            topology,
            persistence_state: "durable",
            failure_policy: "continue_from_persisted_state",
            sender_type: senderType,
            target_type: channel?.type ?? "missing",
            replayed,
            surface: "notification_push",
          });
        },
      });
      addTraceEvent("message_pipeline.push.scheduled", {
        sender_type: senderType,
        target_type: channel?.type ?? "missing",
        target_count: targets.length,
        app_url_configured: true,
      });
    }
  }

  return enriched;
}
