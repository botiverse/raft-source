import { AssistantSendAsOwnerError, lockAssistantDelegatedMessageAuthority } from "./assistantDelegatedMessageAuthority";
import { AGENT_LOUNGE_EXCLUDED_REASON, resolveAgentLounge } from "./agentLoungeService";
import { lockJointPostingAuthority, lockComputedJointActor, resolveChannelActorContext, channelActorHasCapability } from "../lib/channelActorPermissions";
import { getJointHumanDeliveryRows, resolveJointHumanEntrySql, jointMembershipRemovalPendingSql } from "./jointHumanMembershipAccess";
import { assertDmHumanPeersAreMembers, DmPeerNotMemberError } from "./dmSendPolicy";
import {
  conversionReadChannelPredicate,
  resolveConversionReadChannelIds,
  resolvedConversionReadChannelPredicate,
} from "./channelConversionReadScope";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { randomUUID } from "node:crypto";
import { legacyAgentProvenance } from "./externalAgentProvenance";
import { eq, asc, desc, gt, gte, lt, lte, and, inArray, isNull, isNotNull, not, sql, or, getTableColumns, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, isDatabaseInitialized, registerDatabaseCloseHookForTests, withDbTraceAttributes, type DatabaseExecutor } from "../db/index";
import { chunkForBindParameters } from "../db/bindParameterBudget";
import { mapBounded } from "../lib/boundedConcurrency";
import { createConcurrencyLimiter } from "../lib/mapWithConcurrency";
import { transientTransactionSqlState, withTransientTransactionRetry } from "../db/transientTransactionRetry";
import { withLockOrderRecording } from "../db/lockOrderRecorder";
import { isInTransaction } from "../db/ambientTransaction";
import { actionCards, messages, messageReactions, agents, users, channels, threadFollows, servers, serverMembers, serverMembershipDepartures, userChannelInboxStates, channelHumans, channelAgents, messageMentions, mentionDeliveryOccurrences, jointChannels, jointChannelServers, attachmentCommentRefs, attachments, inboxNotificationFacts, inboxTargetMuteStates, tasks, externalReactionStates, externalActorProjections, externalAddressabilityProjections, externalAppInstalls, externalBindingAudienceSnapshots, externalChannelBindings, externalMentionFacts, externalMessageAuthorFacts, externalProjectionAvatarArtifacts } from "../db/schema";
import type { Server as SocketServer } from "socket.io";
import type {
  AgentMessageDeliveryResult,
  AgentOrchestrator,
  DeliverMessageOptions,
} from "./agentOrchestrator";
import { DEPRECATED_GRAVATAR_HASH, 
  DELEGATED_RECEIPT_KIND,
  asServerId,
  isAgentApiExternalMessageForbiddenAuthorityField,
  isMessageCardMetadata,
  isSlackBridgedExternalProvider,
  MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
  currentDate,
  currentTimeMs,
  extractRaftMentionHandles,
  isSubConversationType,
  formatAgentTaskRefTail,
  formatRaftChannelTaskRef,
  formatRaftDmTaskRef,
  resolveRaftMentionHandle,
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
  encodeChannelActivityCursor,
  notificationPlainText,
  type ChannelActivityCursor,
  type ForwardedBundleTargetSnapshot,
} from "@botiverse/raft-shared";
import { sqlUuidOrNull } from "../db/sqlUuid";
import { isShownUserAvatarUrl } from "./avatarService";
import * as channelService from "./channelService";
import * as mentionDeliveryOccurrenceService from "./mentionDeliveryOccurrenceService";
import { CompatibilityReadMutationPendingError, isReadMutationFenceRefusal } from "./readMutationSequencer";
import { emitScopeReadUpdated } from "./readReceiptService";
import { ensureTaskForMessage, enrichSingleLegacyTask, touchTaskConversationActivity, type TaskRow } from "./taskService";
import {
  loadCanonicalTaskFactsByMessageId,
  projectTaskFactsOntoRows,
  toAgentTaskCurrentProjection,
  withProjectedTaskFacts,
} from "./messageTaskProjection";
import {
  getAttachmentsForMessages,
  getThumbnailUrl,
  normalizeAttachmentFilename,
  resolveAttachmentMimeType,
} from "../routes/attachments";
import { updateMaxSeqRedis, getMaxSeqRedis } from "../replicaRouter";
import { redisSyncDuration } from "../metrics";
import { buildSearchText } from "./searchTokenizer";
import * as agentPermalinkRenderService from "./agentPermalinkRenderService";
import * as agentService from "./agentService";
import { activeAppBotOrOrdinaryAgent, listedServerAgent } from "./agentMemberListPolicy";
import { getServerPlan, getHistoryCutoff } from "./planService";
import { HISTORY_PREVIEW_CHARS } from "./historyPreview";
import * as serverService from "./serverService";
import {
  actorHasServerCapabilityInServer,
  actorRoleHasServerCapability,
  getActorServerRoleInServer,
} from "../lib/actorPermissions";
import { actorHasChannelCapability } from "../lib/channelActorPermissions";
import {
  assertChannelWritableInTransaction,
  withChannelWriterFence,
} from "./channelConversionFenceService";
import { assertActionCardWritableInTransaction } from "./actionCardConversionService";
import { messageWithoutAgentHiddenActionCardSpec, withStoredActionCardSpec } from "./actionCardPresentation";
import { servedActionCardMetadata } from "./actionCardExpiry";
import { AgentSendIdempotencyConflictError, createOrReplayAgentSend, __hasAgentSendReplayDbOverrideForTests, type AgentSendInsertedTransactionInput } from "./agentSendReplayService";
import { agentMessageCardField, insertMessageCardRevision } from "./messageCardService";
export { AgentSendIdempotencyConflictError } from "./agentSendReplayService";
import { traceQuerySpan } from "../tracing/queryTrace";
import {
  AttachmentLinkError,
  linkAttachmentsToMessageWithExecutor as linkAttachmentRowsToMessageWithExecutor,
} from "./attachmentLinkingService";
import { emitTaskCreated } from "./taskRealtimeEvents";
import { projectRichMessageSocketPayload } from "./messageRealtimeEvents";
import {
  recordInboxNotificationFacts,
  type InboxNotificationFactInput,
} from "./inboxNotificationService";
import type { InboxFactNotificationContext } from "./notifications/enqueue";
import {
  type AgentCommentScopeProjection,
  projectAgentCommentScope,
  readFullAnchorQuote,
  renderAgentCommentScopedContent,
  renderAnchorLabel,
} from "./attachmentCommentAnchorLabel";
import { type RequiresCausalActorProducer } from "./systemMessageBornReadRegistry";
import { isMessageUnreadEligibleForReceiver, messageUnreadEligibleForReceiverSql } from "./inboxUnreadEligibility";
import {
  TERMINAL_FAILURE_CATCHUP_MAX_CANDIDATES,
  selectObligationCatchupCandidates,
  type CatchupBatchBuildInput,
  type CatchupObligation,
} from "../terminalFailureBreaker";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace";
import { isMessageShortId, messageIdShortPrefixConditions, UUID_RE, uuidShortIdRange } from "../lib/messageId";
import { addTraceEvent, errorClassOf } from "../tracing/semanticTrace";
import { traceIdentityHash } from "../tracing/traceIdentity";
import { sanitizeRouteErrorMessage } from "../tracing/routeFailure";
import { readSyncHorizon, snapshotXidSpan, syncHorizonFromDatabase, syncLateCap, type SyncHorizon } from "./syncHorizon";
import { emitAgentInboxLateRowsTrace, readAgentInboxPullSnapshot, scanAgentInboxLateRows, type AgentInboxLateHanded, type AgentInboxPullSnapshot } from "./agentInboxLateRows";
import { socketUserServerRoom } from "../socket/platformScope";
import { insertExternalMentionFact, loadExternalMessageAuthors, resolveExternalMentionFromDurableAuthority } from "./externalProjectionService";
import {
  classifyOrdinaryMessageExternalProjection,
  type OrdinaryMessageExternalProjectionDecision,
} from "./ordinaryMessageExternalProjection";
import {
  lockOrdinaryMessageExternalDeliveryAdmission,
  maybeEnqueueOrdinaryMessageExternalDelivery,
  runSlackBridgeOutboundAdmissionStage,
  runSlackBridgeOutboundPipelineStage,
  type SlackBridgeOutboundPipelineTopology,
} from "./externalDeliveryOutboxService";
import { resolveSlackOutboundMessageSurface } from "./slackBridgeDatabaseOutboundRuntime";
import type { ResolvedAttachment } from "./attachmentRecord";
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
    error_class: errorClassOf(error),
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
    const allowed = await resolveJointHumanEntrySql({ localChannelIds: [jointThreadProjection.localParentChannelId] }, db);
    const rows = await db
      .select({ id: threadFollows.followerId })
      .from(threadFollows)
      .innerJoin(channels, and(
        eq(channels.id, threadFollows.threadChannelId),
        inArray(channels.type, ["thread", "task"]),
        isNull(channels.deletedAt),
      ))
      .innerJoin(serverMembers, and(
        eq(serverMembers.serverId, jointThreadProjection.localServerId),
        eq(serverMembers.userId, threadFollows.followerId),
      ))
      .where(and(
        eq(threadFollows.threadChannelId, threadChannelId),
        eq(threadFollows.followerType, "user"),
        isNull(threadFollows.unfollowedAt),
        allowed(sql`${jointThreadProjection.localParentChannelId}::uuid`, threadFollows.followerId),
      ));
    return rows.map((r) => r.id);
  }
  const parentRows=await db.execute<{id:string}>(sql`SELECT coalesce(c.parent_channel_id,m.channel_id) id
    FROM channels c LEFT JOIN messages m ON m.id=c.parent_message_id WHERE c.id=${threadChannelId}::uuid`);
  const fallbackPermission=await resolveJointHumanEntrySql({localChannelIds:parentRows.rows.flatMap(row=>row.id?[row.id]:[])},db);
  const parentChannels = alias(channels, "parent_channels");
  const rows = await db
    .select({ id: threadFollows.followerId })
    .from(threadFollows)
    .innerJoin(channels, and(
      eq(channels.id, threadFollows.threadChannelId),
      inArray(channels.type, ["thread", "task"]),
      isNull(channels.deletedAt),
    ))
    // Thread: the parent message's channel. Task conversation (task v2): its
    // parent_channel_id (no parent message).
    .leftJoin(messages, eq(messages.id, channels.parentMessageId))
    .innerJoin(parentChannels, eq(parentChannels.id, sql`COALESCE(${messages.channelId}, ${channels.parentChannelId})`))
    .leftJoin(channelHumans, and(
      eq(channelHumans.channelId, parentChannels.id),
      eq(channelHumans.userId, threadFollows.followerId),
    ))
    .innerJoin(serverMembers, and(
      eq(serverMembers.serverId, parentChannels.serverId),
      eq(serverMembers.userId, threadFollows.followerId),
    ))
    .where(and(
      eq(threadFollows.threadChannelId, threadChannelId),
      eq(threadFollows.followerType, "user"),
      isNull(threadFollows.unfollowedAt),
      // A Guest follows only in its one bound, live channel, as its member
      // (canGuestReadChannel, #wg-rbac:#15).
      // A joint parent applies the joint entry rule, which itself admits only
      // a Guest bound to the host projection (P3) and gates on the host flag.
      sql`(
        (${parentChannels.type}='joint' AND ${fallbackPermission(parentChannels.id,threadFollows.followerId)}
          AND (${serverMembers.role} <> 'guest' OR (${parentChannels.id} = ${serverMembers.guestChannelId} AND ${parentChannels.archivedAt} IS NULL)))
        OR (${serverMembers.role} <> 'guest' AND (
          (${parentChannels.type} = 'channel' AND ${serverMembers.userId} IS NOT NULL)
          OR (${parentChannels.type}<>'joint' AND ${channelHumans.userId} IS NOT NULL)
        ))
        OR (${serverMembers.role} = 'guest'
          AND ${parentChannels.id} = ${serverMembers.guestChannelId}
          AND ${parentChannels.type} IN ('channel', 'private')
          AND ${parentChannels.archivedAt} IS NULL
          AND ${channelHumans.userId} IS NOT NULL)
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
        inArray(channels.type, ["thread", "task"]),
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
      inArray(channels.type, ["thread", "task"]),
      isNull(channels.deletedAt),
    ))
    .leftJoin(messages, eq(messages.id, channels.parentMessageId))
    .innerJoin(parentChannels, eq(parentChannels.id, sql`COALESCE(${messages.channelId}, ${channels.parentChannelId})`))
    .leftJoin(channelAgents, and(
      eq(channelAgents.channelId, parentChannels.id),
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

const JOINT_DELIVERY_PROJECTION_CONCURRENCY = 4;

type MessageServiceDeps = {
  createMessage: typeof createMessage;
  getChannel: typeof channelService.getChannel;
  getChannelHumans: typeof channelService.getChannelHumans;
  getChannelAgents: typeof channelService.getChannelAgents;
  /**
   * Batched member lookup across every joint projection of one message, so
   * the in-transaction round trips stay constant as the number of servers
   * grows (contract v0.3 §18.10.1). Optional: doubles fall back to the
   * per-projection getChannelHumans/getChannelAgents loop.
   */
  getJointProjectionMembers?: (localChannelIds: readonly string[]) => Promise<JointProjectionMembers>;
  getChannelMembers: typeof channelService.getChannelMembers;
  getChannelMembershipAuthorityChannelId: typeof channelService.getChannelMembershipAuthorityChannelId;
  /** Agent Lounge: the lounge a conversation belongs to, if any (agentLoungeService). */
  resolveAgentLounge: typeof resolveAgentLounge;
  actorHasChannelCapability: typeof actorHasChannelCapability;
  getThreadInfo: typeof channelService.getThreadInfo;
  clearThreadDoneForAll: typeof channelService.clearThreadDoneForAll;
  markRead: (userId: string, channelId: string, seq: number) => Promise<unknown>;
  markAgentLegacyRead: (agentId: string, channelId: string, seq: number) => Promise<unknown>;
  /** An agent's own send (see channelService.markAgentOwnSendRead). Stubs without it fall back to markAgentLegacyRead. */
  markAgentOwnSendRead?: (agentId: string, channelId: string, seq: number, storageChannelId?: string) => Promise<unknown>;
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
  getSenderIdentity: typeof getSenderIdentity;
  insertMentionRows: typeof insertMentionRows;
  getMentionFactsForMessages: typeof getMentionFactsForMessages;
  recordInboxNotificationFacts: typeof recordInboxNotificationFacts;
  getActivityMutedAgentIdsForMessage: typeof channelService.getActivityMutedAgentIdsForMessage;
  canViewerReadForwardedSource: typeof viewerCanReadForwardedSource;
  getThreadFollowerCandidates: typeof getThreadFollowerCandidates;
  listExplicitThreadUnfollows: typeof listExplicitThreadUnfollows;
  persistMentionDeliveryOccurrences: typeof mentionDeliveryOccurrenceService.ensureMentionDeliveryOccurrences;
  /** Agent handles by id, for the sender's "Delivered to N agents" receipt line. */
  getAgentNamesByIds: (agentIds: readonly string[]) => Promise<Map<string, string>>;
};

async function getAgentNamesByIds(agentIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return new Map();
  const rows = await getDb().select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ids));
  return new Map(rows.map((row) => [row.id, row.name]));
}

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
    if (isReadMutationFenceRefusal(error)) return;
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
  resolveAgentLounge,
  actorHasChannelCapability,
  getThreadInfo: channelService.getThreadInfo,
  clearThreadDoneForAll: channelService.clearThreadDoneForAll,
  markRead: channelService.markRead,
  markAgentLegacyRead: channelService.markAgentLegacyRead,
  markAgentOwnSendRead: channelService.markAgentOwnSendRead,
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
  getSenderIdentity,
  insertMentionRows,
  getMentionFactsForMessages,
  recordInboxNotificationFacts,
  getActivityMutedAgentIdsForMessage: channelService.getActivityMutedAgentIdsForMessage,
  canViewerReadForwardedSource: viewerCanReadForwardedSource,
  getThreadFollowerCandidates,
  listExplicitThreadUnfollows,
  persistMentionDeliveryOccurrences: mentionDeliveryOccurrenceService.ensureMentionDeliveryOccurrences,
  getAgentNamesByIds,
};

let messageServiceDepsOverride: Partial<MessageServiceDeps> | null = null;

function resolveMessageServiceDeps(): MessageServiceDeps {
  const usesMockPersistence = Boolean(messageServiceDepsOverride?.createMessage);
  const persistenceUnavailable = !isDatabaseInitialized();
  const testFallbacks: Partial<MessageServiceDeps> = messageServiceDepsOverride
    ? {
      getActiveJointChannelProjectionsByLocalChannel: async () => [],
      getActiveJointThreadProjectionsByCanonicalThread: async () => [],
      getJointThreadProjectionForMember: async () => null,
      ...(usesMockPersistence || persistenceUnavailable ? {
        getServerIdentity: async () => null,
        shouldHideHumanDirectoryFromRequester: async () => false,
        shouldHideHumanDirectoryFromAgentRequester: async () => false,
        getHumanIdsVisibleThroughLocalChannels: async () => new Set<string>(),
        getHumanIdsVisibleThroughJointChannels: async () => new Set<string>(),
        recordInboxNotificationFacts: async () => 0,
        getActivityMutedAgentIdsForMessage: async () => new Set<string>(),
        // Unit fixtures that replace persistence must not fall through into
        // the live channel-role database while projecting sender-only mention
        // actions. Focused authorization tests override these seams directly.
        getChannelMembershipAuthorityChannelId: async (channelId: string) => channelId,
        resolveAgentLounge: async () => null,
        actorHasChannelCapability: async () => false,
        getAgentNamesByIds: async () => new Map<string, string>(),
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
    // Task #93 line B: the sender lost membership after the message committed; the read-state side effect is refused
    // and the primary action stays successful. Any other error still surfaces.
    if (isReadMutationFenceRefusal(error)) return;
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

export type SenderDeliveryWarning = {
  targetType: "agent";
  targetId: string;
  /**
   * `agent_stuck_on_tool` (task #25): the message is queued, but the agent has
   * been stuck on one tool call with no output, so it will not see it until
   * that call returns or the agent is restarted.
   */
  reason: "agent_stopped" | "agent_stuck_on_tool";
};

type SenderDeliveryOutcome = {
  agentId: string;
  result: AgentMessageDeliveryResult | null;
};

const senderDeliveryWarningTimeoutMs = 1000;

type SenderDeliveryOutcomeCollection = {
  outcomes: SenderDeliveryOutcome[];
  timedOut: boolean;
};

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
      && (fact.kind === "thread" || fact.kind === "task")
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
          inArray(inboxNotificationFacts.kind, ["thread", "task"]),
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

  // A focused test override for follower resolution intentionally exercises
  // the post-persist fallback and its degradation trace; production always
  // prefers the durable inbox-facts audience below.
  const persistedAudience = messageServiceDepsOverride?.getThreadFollowerCandidates
    ? null
    : await getPersistedThreadAgentDeliveryAudience(opts.messageId, opts.threadChannelId);
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

/**
 * Runs a failable read so its failure cannot poison an open transaction: inside
 * an ambient transaction (where a failed statement aborts the whole transaction
 * in Postgres, and continuing only fails later with 25P02) it runs in a
 * SAVEPOINT, which a failure rolls back; outside one it just runs. Use it where
 * a caller catches the read's error and continues.
 */
async function readInSavepoint<T>(work: () => Promise<T>): Promise<T> {
  if (!isInTransaction()) return await work();
  return await getDb().transaction(() => work()) as T;
}

async function runPostPersistThreadRead<T>(opts: {
  purpose: "inbox_notification_facts" | "agent_delivery";
  queryName: string;
  persistenceState: PostPersistThreadReadPersistenceState;
  fallback: T;
  work: () => Promise<T>;
}): Promise<T> {
  const phase = `message_pipeline.post_persist.${opts.purpose}`;
  // Inside the (ambient) send transaction, any database error aborts it in
  // Postgres, so a plain catch-and-continue only moves the failure to the next
  // statement as 25P02 (10-15 02:57Z: a 40P01 here became a 500 that the send's
  // withTransientTransactionRetry could not retry). So the read runs in a
  // SAVEPOINT: a failure rolls back just the read and the send continues with
  // the fallback. A transient conflict (40P01/40001) is rethrown instead, so
  // the send's retry re-runs the whole transaction and gets the full audience.
  const withinTransaction = opts.persistenceState === "transaction_pending" && isInTransaction();
  const read = () => traceMessageDbPhase({
    phase,
    queryName: opts.queryName,
    dbOperation: "select",
  }, opts.work);
  try {
    return withinTransaction ? await getDb().transaction(read) : await read();
  } catch (error) {
    if (!isMessageDatabaseFailure(error)) throw error;
    const durableMessagePresent = opts.persistenceState === "committed";
    const transient = transientTransactionSqlState(error);
    const failurePolicy = durableMessagePresent
      ? "continue_after_persist"
      : transient
        ? "rethrow_for_transaction_retry"
        : withinTransaction ? "rollback_savepoint_and_continue" : "rethrow_within_transaction";
    addTraceEvent("message_pipeline.post_persist_side_effect.degraded", {
      phase,
      query_name: opts.queryName,
      db_operation: "select",
      peer_service: "postgresql",
      persistence_state: opts.persistenceState,
      durable_message_present: durableMessagePresent,
      failure_policy: failurePolicy,
      ...getMessageDbErrorTraceAttrs(error),
    });
    if (failurePolicy === "rethrow_for_transaction_retry" || failurePolicy === "rethrow_within_transaction") throw error;
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
  // Sub-conversations (thread, task conversation) are follow-scoped: the
  // follow / unfollow state is their mute; channel mute never applies.
  if (isSubConversationType(channel.type) || agentIds.length === 0) return new Set();
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

/**
 * Whether a thread's parent message has an author who follows the thread when
 * a reply lands ("authored"). Task conversations have no parent message: the
 * task's creator follows from creation (taskConversationService).
 */
function isFollowableThreadAuthor(parent: { messageType: "chat" | "system"; senderId: string }): boolean {
  return !isSystemMessageIdentity(parent.messageType, parent.senderId);
}

type InternalActorType = "user" | "agent";
type StoredMessageSenderType = InternalActorType | "external_projection";
type AgentVisibleSenderType = AgentMessage["sender_type"];
type AgentVisibleTaskAssigneeType = AgentMessage["task_assignee_type"];
type AgentVisibleChannelType = AgentMessage["channel_type"];
type FrontendConversationChannelType = typeof channels.$inferSelect["type"];
type FrontendParentChannelType = Exclude<FrontendConversationChannelType, "thread" | "task">;
export type FrontendConversationContext = {
  channelType: FrontendConversationChannelType;
  parentMessageId?: string;
  parentChannelId?: string;
  parentChannelType?: FrontendParentChannelType;
  /** Task conversation (channelType `task`, task v2): the task it belongs to. */
  taskId?: string;
};

function buildFrontendConversationContext(opts: {
  channelType: FrontendConversationChannelType;
  parentMessageId?: string | null;
  parentChannel?: Pick<typeof channels.$inferSelect, "id" | "type"> | null;
  taskId?: string | null;
}): FrontendConversationContext {
  const context: FrontendConversationContext = { channelType: opts.channelType };
  if (opts.channelType === "task") {
    if (opts.taskId) context.taskId = opts.taskId;
    if (opts.parentChannel && !isSubConversationType(opts.parentChannel.type)) {
      context.parentChannelId = opts.parentChannel.id;
      context.parentChannelType = opts.parentChannel.type as FrontendParentChannelType;
    }
    return context;
  }
  if (opts.channelType !== "thread") return context;
  if (!opts.parentMessageId || !opts.parentChannel || isSubConversationType(opts.parentChannel.type)) return context;
  context.parentMessageId = opts.parentMessageId;
  context.parentChannelId = opts.parentChannel.id;
  context.parentChannelType = opts.parentChannel.type as FrontendParentChannelType;
  return context;
}

/**
 * The conversation context a sub-conversation's message carries on the wire
 * (as `message:new` does), for an HTTP answer that returns that message, e.g.
 * a forward into a thread or task discussion ("View in chat" opens it).
 */
export async function frontendConversationContextFor(
  channel: Pick<typeof channels.$inferSelect, "type" | "parentMessageId" | "taskId">,
  parentChannelId: string | null,
): Promise<FrontendConversationContext | null> {
  if (!isSubConversationType(channel.type)) return null;
  const parentChannel = parentChannelId ? await channelService.getChannel(parentChannelId) : null;
  return buildFrontendConversationContext({
    channelType: channel.type as FrontendConversationChannelType,
    parentMessageId: channel.parentMessageId,
    parentChannel,
    taskId: channel.taskId,
  });
}

function withFrontendConversationContext<T extends Record<string, unknown>>(
  payload: T,
  context: FrontendConversationContext,
): T & { conversationContext: FrontendConversationContext } {
  return { ...payload, conversationContext: context };
}

function projectFrontendMessagePayload<T extends Record<string, unknown>>(
  payload: T,
): Omit<T, "agentSendKey" | "searchText" | "searchVector" | "senderHandle" | "serverId" | "senderTimezone"> {
  return projectRichMessageSocketPayload(payload);
}

function projectThreadLatestReplyPayload<T extends Record<string, unknown>>(
  payload: T,
): Omit<T, "agentSendKey" | "searchText" | "searchVector" | "senderHandle" | "serverId" | "senderTimezone"> & {
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

function traceChannelAudienceAttrs(channel: Pick<typeof channels.$inferSelect, "type" | "name"> | null | undefined) {
  return {
    target_type: channel?.type ?? "missing",
    is_all_channel: channel ? channelService.isEnabledAllChannel(channel) : false,
  };
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
  /**
   * `user`/`agent` claim a Raft principal (`id` is the user/agent UUID).
   * `external` claims a linked external projection (`id` is the
   * `external_actor_projections.id` UUID) — never lands in `message_mentions`,
   * only mints an `external_mention_facts` row for the outbound renderer.
   */
  type: "user" | "agent" | "external";
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

export class UserRandomIdConflictError extends Error {
  status = 409 as const;
  code = "random_id_conflict" as const;

  constructor() {
    super("randomId has already been used for a different message");
    this.name = "UserRandomIdConflictError";
  }
}

function isMessageRouteDomainError(error: unknown): boolean {
  return error instanceof DmPeerNotMemberError
    || error instanceof channelService.ChannelArchivedError
    || error instanceof MentionValidationError
    || error instanceof UserRandomIdConflictError
    || error instanceof AgentSendIdempotencyConflictError
    || error instanceof AttachmentLinkError;
}

export type SystemMessageInboxFactProducer =
  | "agent.join_channel"
  | "agent.server_role_changed"
  | "agent.runtime_action_required"
  | "agent.migration_completed_receipt"
  | "agent.migration_canceled_receipt"
  | "agent.migration_failed_receipt"
  | "agent.migration_aborted_receipt"
  | "app.agent_reminder"
  | "action_card.carrier"
  | "action_card.result_reply"
  | "assistant.delegated_receipt"
  | "assistant.stopped_by_admin"
  | "assistant.wechat_connected"
  | "assistant.wechat_reconnect_required"
  | "channel.agent_membership"
  | "channel.human_membership"
  | "channel.self_unfollow_thread"
  | "channel.rename"
  | "channel.announcement"
  | "channel.archive"
  | "channel.unarchive"
  | "channel.joint_disconnect"
  | "channel.joint_connect"
  | "onboarding.owner_instruction"
  | "onboarding.owner_opener_v2_ledger"
  | "onboarding.member_instruction"
  | "onboarding.all_channel_unlock"
  | "onboarding.cross_channel_hint"
  | "onboarding.hosted_recap_wake"
  | "task.body"
  | "task.created_summary"
  | "task.assignment_receipt"
  | "task.converted_summary"
  | "task.lifecycle_thread"
  | "task.deleted_summary"
  | "external_projection.inbound"
  | "slack_bridge.binding_paused"
  | "server.admin_notice"
  | `test.${string}`;

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

/**
 * Compile-time gate on a system-message fact's producer -> causalActor coupling,
 * derived from SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION (single source of truth):
 *
 * - `born-read` producer      -> `causalActor: CausalActor` (REQUIRED).
 * - `notify-exclude` / `skip` -> `causalActor?: never` (passing it is a type
 *    error, not merely optional) — these must stay unread for the actor.
 * - `real-sender` producer    -> no `causalActor` (the persisted message's own
 *    real sender already drives born-read), so `?: never` here too.
 * - `test.*` producer         -> exempt (tests may pass anything).
 *
 * The three states are enforced at compile time by the discriminated union; there
 * is deliberately NO runtime double-guard in broadcastSystemMessage.
 */
export type SystemMessageInboxFactPolicy = {
  mode: "record" | "skip";
  reason: string;
} & (
  | { producer: RequiresCausalActorProducer; causalActor: CausalActor }
  | { producer: Exclude<SystemMessageInboxFactProducer, RequiresCausalActorProducer | `test.${string}`>; causalActor?: never }
  | { producer: `test.${string}`; causalActor?: CausalActor }
);

/**
 * A persisted message paired with the causal actor that produced it, for the
 * born-read producers. The pair shape is what makes "every message has its
 * actor" structural: a message without a causalActor simply cannot be written
 * on this path.
 */
export type PersistedMessageWithCausalActor = {
  message: typeof messages.$inferSelect;
  causalActor: CausalActor;
};

export type ResolvedMentionFact = {
  /** `external` = provider-side projection (e.g. Slack member). Rendered as
   *  text-only on Raft; never produces a `message_mentions` row or inbox fact.
   *  Consumers that filter on `=== "user"` / `=== "agent"` skip it for free. */
  type: "user" | "agent" | "external";
  id: string;
  name: string;
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
  // NOT touch any read cursor/watermark. Same rule as delivery and the chain
  // (inboxUnreadEligibility); causal actors are only ever set on system messages.
  return isMessageUnreadEligibleForReceiver({
    senderType,
    senderId,
    messageType: causalActor ? "system" : null,
    causalActorType: causalActor?.type,
    causalActorId: causalActor?.id,
  }, { type: receiverType, id: receiverId });
}

/**
 * What the notification outbox needs to know about the message whose facts are
 * recorded (InboxFactNotificationContext). `mentionOnlyUserIds`: on a plain
 * public channel (no joint projection, not a sub-conversation), the @mentioned
 * server members who are not channel members and are not the sender. Only
 * id-resolved mentions count, never a name-only fallback.
 */
async function buildInboxFactNotificationContext(input: {
  channel: typeof channels.$inferSelect;
  message: typeof messages.$inferSelect;
  senderType: "user" | "agent" | "system" | "external_projection";
  senderId: string;
  causalActor?: CausalActor;
  producer?: string | null;
  targetVisibleMentions: readonly ResolvedMentionFact[];
  /** Set only for a plain public channel; null otherwise. */
  localChannelHumanIds: ReadonlySet<string> | null;
  executor?: DatabaseExecutor;
}): Promise<InboxFactNotificationContext> {
  const causalActor = input.causalActor && (input.causalActor.type === "user" || input.causalActor.type === "agent")
    ? { type: input.causalActor.type, id: input.causalActor.id }
    : null;
  let mentionOnlyUserIds: string[] | undefined;
  if (input.localChannelHumanIds) {
    const channelHumanIds = input.localChannelHumanIds;
    const candidates = [...new Set(
      input.targetVisibleMentions
        .filter((mention) => mention.type === "user")
        .map((mention) => mention.id)
        .filter((userId) => !channelHumanIds.has(userId))
        .filter((userId) => !(input.senderType === "user" && input.senderId === userId)),
    )];
    if (candidates.length > 0) {
      const members = await (input.executor ?? getDb())
        .select({ userId: serverMembers.userId })
        .from(serverMembers)
        .where(and(eq(serverMembers.serverId, input.channel.serverId), inArray(serverMembers.userId, candidates)));
      const memberIds = new Set(members.map((row) => row.userId));
      mentionOnlyUserIds = candidates.filter((userId) => memberIds.has(userId));
    } else {
      mentionOnlyUserIds = [];
    }
  }
  return {
    message: {
      id: input.message.id,
      seq: input.message.seq,
      createdAt: input.message.createdAt,
      messageType: input.message.messageType,
      systemSubtype: input.message.systemSubtype ?? null,
    },
    producer: input.producer ?? null,
    causalActor,
    channel: {
      id: input.channel.id,
      serverId: input.channel.serverId,
      type: input.channel.type as InboxFactNotificationContext["channel"]["type"],
      parentMessageId: input.channel.parentMessageId,
      parentChannelId: input.channel.parentChannelId ?? null,
      taskId: input.channel.taskId ?? null,
    },
    targetVisibleMentions: input.targetVisibleMentions.map((mention) => ({ type: mention.type, id: mention.id })),
    ...(mentionOnlyUserIds !== undefined && { mentionOnlyUserIds }),
  };
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
  suppressAgentDelivery?: boolean;
  /** System-message producer, forwarded to the notification outbox. */
  producer?: string | null;
}) {
  // Keep the optional executor lazy: mocked persistence need not own a DB.
  const executor = opts.executor;
  const mentionKeys = new Set(opts.targetVisibleMentions.map((mention) => `${mention.type}:${mention.id}`));
  const facts: InboxNotificationFactInput[] = [];
  const factsByKey = new Map<string, InboxNotificationFactInput>();
  // Sub-conversation facts: `task` for a task conversation (task v2), `thread`
  // otherwise; every other semantic is identical.
  const subConversationKind: "thread" | "task" = opts.channel.type === "task" ? "task" : "thread";
  const addReceiver = (
    receiverType: "user" | "agent",
    receiverId: string,
    serverId: string,
    kind: "channel" | "dm" | "thread" | "task",
    sourceChannelId: string,
    receiverOpts: { suppressionReason?: InboxNotificationFactInput["suppressionReason"] } = {},
  ) => {
    if (receiverType === "agent" && opts.suppressAgentDelivery) return;
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
      // A parent author / explicit unfollower can outlive their server
      // membership. Neither that provenance nor a retained DM participant row
      // grants delivery while they are away. Current parent humans were
      // already joined to server_members by the audience query.
      if (actorType === "user" && !parentHumanIds.has(actorId)) {
        const [membership] = await (executor ?? getDb()).select({ userId: serverMembers.userId })
          .from(serverMembers)
          .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, actorId)))
          .limit(1);
        if (!membership) return;
      }
      if (optsForCandidates.useJointProjectionResolver) {
        const projection = await opts.deps.getJointThreadProjectionForMember(
          opts.message.channelId,
          actorType,
          actorId,
          executor,
        );
        if (projection?.localThreadChannelId !== sourceThreadChannelId) return;
      }
      addReceiver(actorType, actorId, serverId, subConversationKind, sourceThreadChannelId, receiverOpts);
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
        .select({
          senderType: messages.senderType,
          senderId: messages.senderId,
          messageType: messages.messageType,
        })
        .from(messages)
        .where(eq(messages.id, opts.channel.parentMessageId))
        .limit(1);
      if (
        parentMsg
        && isFollowableThreadAuthor(parentMsg)
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

  // Humans of a plain public channel, for the mention-only notification audience.
  let localChannelHumanIds: Set<string> | null = null;
  if (isSubConversationType(opts.channel.type)) {
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
        for (const userId of humanFollowerIds) addReceiver("user", userId, projection.localServerId, subConversationKind, projection.localThreadChannelId);
        for (const agent of agentFollowers) addReceiver("agent", agent.id, projection.localServerId, subConversationKind, projection.localThreadChannelId);
        await addPostPersistThreadSameSendCandidates(
          projection.localServerId,
          projection.localThreadChannelId,
          projection.localParentChannelId,
          { useJointProjectionResolver: true },
        );
      }
    } else {
      // Task conversation (task v2): its parent channel is stored on the row.
      let parentChannelId: string | null = opts.channel.type === "task" ? opts.channel.parentChannelId ?? null : null;
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
      for (const userId of humanFollowerIds) addReceiver("user", userId, opts.channel.serverId, subConversationKind, opts.channel.id);
      for (const agent of agentFollowers) addReceiver("agent", agent.id, opts.channel.serverId, subConversationKind, opts.channel.id);
      if (parentChannelId) {
        await addPostPersistThreadSameSendCandidates(opts.channel.serverId, opts.channel.id, parentChannelId);
      }
    }
  } else if (opts.jointProjections.length > 0) {
    const batched = opts.deps.getJointProjectionMembers
      ? await opts.deps.getJointProjectionMembers(opts.jointProjections.map((projection) => projection.localChannelId))
      : null;
    for (const projection of opts.jointProjections) {
      const [humans, agents] = batched
        ? [batched.humansByChannel.get(projection.localChannelId) ?? [], batched.agentsByChannel.get(projection.localChannelId) ?? []]
        : await Promise.all([
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
    if (opts.channel.type === "channel") localChannelHumanIds = new Set(humans.map((human) => human.id));
    for (const human of humans) addReceiver("user", human.id, opts.channel.serverId, kind, opts.channel.id);
    for (const agent of agents) addReceiver("agent", agent.id, opts.channel.serverId, kind, opts.channel.id);
  }

  await promoteMentionedSubConversationFollowers({
    channel: opts.channel,
    message: opts.message,
    senderType: opts.senderType,
    senderId: opts.senderId,
    facts,
    executor,
  });

  // Illumination span (2026-09-21): the per-receiver facts write is the last
  // O(receivers) cost in the send transaction and previously hid inside the
  // messages.insert blob. receiver_count on the span makes its cost curve
  // directly readable (span duration vs receiver_count scatter = the ms price
  // of Stage 3's retirement target).
  const factsFanoutStartMs = Date.now();
  const notificationContext = await buildInboxFactNotificationContext({
    channel: opts.channel,
    message: opts.message,
    senderType: opts.senderType,
    senderId: opts.senderId,
    causalActor: opts.causalActor,
    producer: opts.producer,
    targetVisibleMentions: opts.targetVisibleMentions,
    localChannelHumanIds,
    executor,
  });
  const recorded = await opts.deps.recordInboxNotificationFacts(facts, executor, notificationContext);
  addTraceEvent("send.facts_fanout.finished", {
    event_kind: "send_phase",
    outcome: "success",
    reason: "facts_recorded",
    receiver_count: facts.length,
    recorded_count: recorded,
    duration_ms: Date.now() - factsFanoutStartMs,
    channel_kind: opts.channel.type,
  });
  const threadAgentDeliveryCandidates = isSubConversationType(opts.channel.type)
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

/**
 * A thread / task reply that @mentions (by id) one of its user receivers who
 * is not a send-time mention target (a follower outside the public parent
 * channel: the mention row is notifiable_at_send = false and the sender gets a
 * mention action) is still addressed to them, and they can see the thread.
 * Their existing fact becomes a personal mention (no new receivers), and their
 * mention row is stamped as notified at send, the state the mention action's
 * `notify` would write, so Activity's mention flags count it and that action
 * dedupes (`add` stays available). Suppressed facts (an explicit unfollower)
 * keep the mention action decision. enqueue's mentionedFollowerIds remains a
 * fallback for facts recorded elsewhere.
 */
async function promoteMentionedSubConversationFollowers(opts: {
  channel: typeof channels.$inferSelect;
  message: typeof messages.$inferSelect;
  senderType: "user" | "agent" | "system" | "external_projection";
  senderId: string;
  facts: InboxNotificationFactInput[];
  executor?: DatabaseExecutor;
}) {
  if (!isSubConversationType(opts.channel.type)) return;
  if (opts.message.messageType === "system") return;
  if (opts.senderType !== "user" && opts.senderType !== "agent") return;
  const candidates = opts.facts.filter((fact) =>
    fact.receiverType === "user"
      && fact.personalMention !== true
      && fact.suppressionReason === undefined
      && !(opts.senderType === "user" && fact.receiverId === opts.senderId)
  );
  if (candidates.length === 0) return;
  const db = opts.executor ?? getDb();
  const candidateIds = [...new Set(candidates.map((fact) => fact.receiverId))];
  const mentioned = new Set<string>();
  for (const chunk of chunkForBindParameters(candidateIds, 1)) {
    const rows = await db
      .select({ targetId: messageMentions.targetId })
      .from(messageMentions)
      .where(and(
        eq(messageMentions.messageId, opts.message.id),
        eq(messageMentions.targetType, "user"),
        inArray(messageMentions.targetId, chunk),
      ));
    for (const row of rows) mentioned.add(row.targetId);
  }
  if (mentioned.size === 0) return;
  for (const fact of candidates) {
    if (mentioned.has(fact.receiverId)) fact.personalMention = true;
  }
  for (const chunk of chunkForBindParameters([...mentioned], 1)) {
    await db
      .update(messageMentions)
      .set({
        notifiedAt: opts.message.createdAt,
        notifiedByType: opts.senderType,
        notifiedById: opts.senderId,
        notifiedAction: "notify_only",
      })
      .where(and(
        eq(messageMentions.messageId, opts.message.id),
        eq(messageMentions.targetType, "user"),
        inArray(messageMentions.targetId, chunk),
        eq(messageMentions.notifiableAtSend, false),
        isNull(messageMentions.notifiedAt),
      ));
  }
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
  persistedMessages: readonly (typeof messages.$inferSelect)[] | readonly PersistedMessageWithCausalActor[],
  opts: {
    inboxFactPolicy: Pick<SystemMessageInboxFactPolicy, "mode" | "producer" | "reason">;
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
    targetVisibleMentionsByMessageId?: ReadonlyMap<string, readonly ResolvedMentionFact[]>;
    /** Unresolved external authors remain visible to humans without waking agents. */
    suppressAgentDelivery?: boolean;
    /** Collapse a joint member present on multiple projections to one global receipt. */
    dedupeLogicalReceiverAcrossJointProjections?: boolean;
  },
): Promise<number> {
  // Normalize both input shapes to { message, causalActor? }.
  const normalized: ReadonlyArray<{ message: typeof messages.$inferSelect; causalActor?: CausalActor }> =
    persistedMessages.map((item) =>
      "message" in item ? item : { message: item, causalActor: undefined },
    );
  if (normalized.length === 0) return 0;
  const baseDeps = resolveMessageServiceDeps();
  const executor = opts.executor;
  const deps: MessageServiceDeps = executor
    ? {
        ...baseDeps,
        getChannelHumans: (channelId) => getChannelHumansWithExecutor(executor, channelId, opts.channel),
        getChannelAgents: (channelId) => getChannelAgentsWithExecutor(executor, channelId, opts.channel),
        getJointProjectionMembers: (localChannelIds) => getJointProjectionMembersWithExecutor(executor, localChannelIds),
        recordInboxNotificationFacts: (facts, factExecutor, notification) => baseDeps.recordInboxNotificationFacts(
          facts,
          factExecutor ?? executor,
          notification,
        ),
        getActiveJointThreadProjectionsByCanonicalThread: (channelId) =>
          channelService.getActiveJointThreadProjectionsByCanonicalThread(channelId, executor),
        getJointThreadProjectionForMember: (channelId, followerType, followerId) =>
          channelService.getJointThreadProjectionForMember(channelId, followerType, followerId, executor),
      }
    : baseDeps;
  const mentionsByMessage = opts.targetVisibleMentionsByMessageId
    ?? (executor
      ? await getMentionFactsForMessagesWithExecutor(executor, normalized.map((m) => m.message.id))
      : await deps.getMentionFactsForMessages(normalized.map((m) => m.message.id)));
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

  for (const { message, causalActor } of normalized) {
    const channel = opts.channel?.id === message.channelId
      ? opts.channel
      : executor
        ? (await executor.select().from(channels).where(eq(channels.id, message.channelId)).limit(1))[0]
        : await deps.getChannel(message.channelId);
    if (!channel) continue;
    if (
      executor
      && isSubConversationType(channel.type)
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
      : isSubConversationType(channel.type) && !executor
        ? await channelService.getJointThreadProjectionByLocalThread(message.channelId)
          ?? null
        : null;
    const jointProjectionChannelId = jointThreadProjection?.canonicalThreadChannelId
      ?? (isSubConversationType(channel.type) || channel.type === "dm" ? null : message.channelId);
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
      causalActor: causalActor,
      targetVisibleMentions: [...(mentionsByMessage.get(message.id) ?? [])],
      jointProjections,
      jointThreadProjection,
      deps,
      executor,
      dedupeLogicalReceiverAcrossJointProjections:
        opts.dedupeLogicalReceiverAcrossJointProjections,
      suppressAgentDelivery: opts.suppressAgentDelivery,
      producer: opts.inboxFactPolicy.producer,
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
  actionCardMessageId?: string;
  actionCardConfirmationVersion?: number;
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
    await assertChannelWritableInTransaction(tx, input.channel.id);
    if (input.actionCardMessageId) {
      await assertActionCardWritableInTransaction(tx, input.channel.serverId, input.actionCardMessageId, input.actionCardConfirmationVersion);
    }
    if (input.channel.type === "joint") {
      await tx.execute(sql`SELECT id FROM channels WHERE id=${input.channel.id}::uuid FOR UPDATE`);
      await lockComputedJointActor({ serverId:input.channel.serverId,channelId:input.channel.id,
        actorType:input.causalActor.type,actorId:input.causalActor.id,
        humanSubjectIds:input.memberType==="human"?[input.memberId]:[],
      },tx);
      const context=await resolveChannelActorContext(input.channel.serverId,input.channel.id,input.causalActor.type,input.causalActor.id,tx);
      if (!context || !channelActorHasCapability(context,"addChannelMembers")) throw new Error("Channel capability required");
    }
    const added = input.memberType === "human"
      ? await channelService.addHuman(input.channel.id, input.memberId, {
        executor: tx,
        // An agent adding someone is no person admitting them (admitted_by stays empty).
        ...(input.causalActor.type === "user" ? { actorUserId: input.causalActor.id } : {}),
      })
      : await channelService.addAgent(input.channel.id, input.memberId, { executor: tx });
    if (!added) return { added: false };

    const content = `@${input.memberName} was added to this channel.`;
    const producer = input.memberType === "human"
      ? "channel.human_membership"
      : "channel.agent_membership";
    const message = await deps.createMessage(
      storageChannel.id,
      "user",
      "system",
      content,
      "system",
      undefined,
      {
        causalActorType: input.causalActor.type,
        causalActorId: input.causalActor.id,
        systemSubtype: producer,
      },
      tx,
    );
    await recordInboxFactsForPersistedMessages([{ message, causalActor: input.causalActor }], {
      inboxFactPolicy: {
        mode: "record",
        producer,
        reason: `${input.memberType} membership changes are shared channel activity`,
      },
      executor: tx,
      channel: storageChannel,
      jointProjections,
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
  actionCardMessageId?: string;
  actionCardConfirmationVersion?: number;
}): Promise<{ added: boolean; message?: typeof messages.$inferSelect }> {
  return addMemberWithMembershipSystemMessage({
    channel: input.channel,
    memberId: input.userId,
    memberName: input.userName,
    memberType: "human",
    causalActor: input.causalActor,
    executor: input.executor,
    actionCardMessageId: input.actionCardMessageId,
    actionCardConfirmationVersion: input.actionCardConfirmationVersion,
  });
}

export async function addAgentWithMembershipSystemMessage(input: {
  channel: typeof channels.$inferSelect;
  agentId: string;
  agentName: string;
  causalActor: CausalActor;
  executor?: DatabaseExecutor;
  actionCardMessageId?: string;
  actionCardConfirmationVersion?: number;
}): Promise<{ added: boolean; message?: typeof messages.$inferSelect }> {
  return addMemberWithMembershipSystemMessage({
    channel: input.channel,
    memberId: input.agentId,
    memberName: input.agentName,
    memberType: "agent",
    causalActor: input.causalActor,
    executor: input.executor,
    actionCardMessageId: input.actionCardMessageId,
    actionCardConfirmationVersion: input.actionCardConfirmationVersion,
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

/**
 * The agent target of a sub-conversation: a thread's `#parent:<short id>`, or
 * (task v2) a task conversation's task ref `#parent:#7` / `dm:@peer:#7`.
 */
function formatSubConversationTarget(
  parentChannelType: string,
  parentName: string,
  threadShortId: string,
  taskConversationNumber: number | null | undefined,
): RaftTargetString {
  if (taskConversationNumber) {
    return parentChannelType === "dm"
      ? formatRaftDmTaskRef(parentName, taskConversationNumber)
      : formatRaftChannelTaskRef(parentName, taskConversationNumber);
  }
  return formatThreadTarget(parentChannelType, parentName, threadShortId);
}

// Task numbers never change, so a task conversation's number is cached.
const taskConversationNumberCache = new Map<string, number>();
const TASK_CONVERSATION_NUMBER_CACHE_MAX = 5_000;

/**
 * Task v2: the number of the task whose conversation `channel` is (any face:
 * canonical or a joint server's local one; each carries `task_id`), for the
 * agent envelope's `task_conversation_number`. Null for every other channel.
 */
export async function taskConversationNumberForChannel(
  channel: { type: string; taskId?: string | null } | null | undefined,
): Promise<number | null> {
  if (channel?.type !== "task" || !channel.taskId) return null;
  return taskNumberForTaskId(channel.taskId);
}

async function taskNumberForTaskId(taskId: string): Promise<number | null> {
  const cached = taskConversationNumberCache.get(taskId);
  if (cached !== undefined) return cached;
  const [row] = await getDb().select({ taskNumber: tasks.taskNumber }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!row) return null;
  if (taskConversationNumberCache.size >= TASK_CONVERSATION_NUMBER_CACHE_MAX) taskConversationNumberCache.clear();
  taskConversationNumberCache.set(taskId, row.taskNumber);
  return row.taskNumber;
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
  const externalMessage = legacyAgentProvenance({
      schema: "external-message-provenance.v1" as const,
      provider: author.provider,
      workspace_id: author.workspaceId,
      conversation_id: author.externalConversationId,
      message_id: author.externalMessageId,
      actor_id: author.externalActorId,
      actor_kind: author.actorKind,
      projection_id: author.projectionId,
    }, author.identityKind);
  return externalMessage ? { external_message: externalMessage } : { sender_id: "", senderId: "" };
}

/**
 * Product decision (Slack bridge owner): a message bridged from a paired Slack
 * channel reaches agents exactly like an ordinary Raft message — ordinary
 * content rendering and `mentioned` from the server-minted notifiable
 * message_mentions row. Binding the workspace is the humans' acceptance of
 * that. An unresolved Slack author remains inert until its identity is known.
 * Every other third-party payload (non-Slack external projections, an
 * external app's third_party_event content) stays inert; Raft's own system
 * apps' event content reads as an ordinary message's (agentFacingContent.ts,
 * docs/development/third-party-rendering.md). Provenance (`external_message`) and
 * the stripped authority fields are unchanged for Slack too.
 *
 * Slack-ness is read from the immutable author fact frozen with the canonical
 * external message (`external_message_author_facts.provider`); a row without
 * that fact is never treated as Slack-bridged (fails closed to inert).
 */
export function isSlackBridgedExternalMessage(message: {
  senderType: StoredMessageSenderType;
  externalAuthor?: { provider: string; actorKind?: string } | null;
}): boolean {
  return message.senderType === "external_projection"
    && isSlackBridgedExternalProvider(message.externalAuthor?.provider)
    && message.externalAuthor?.actorKind !== "unknown";
}

/**
 * Whether `agentId` holds a resolved personal mention fact on the message.
 * Enriched rows load `mentions` from notifiable (or later notified)
 * message_mentions rows — the same rule resume catch-up applies.
 */
export function isAgentPersonallyMentioned(
  mentions: readonly ResolvedMentionFact[] | null | undefined,
  agentId: string | null | undefined,
): boolean {
  if (!agentId) return false;
  return (mentions ?? []).some((mention) => mention.type === "agent" && mention.id === agentId);
}

export function renderAgentVisibleMessageContent(
  message: {
    senderType: StoredMessageSenderType;
    content: string;
    externalAuthor?: { provider: string } | null;
  },
  ordinaryRenderedContent: string,
): string {
  return message.senderType === "external_projection" && !isSlackBridgedExternalMessage(message)
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
  ordinaryRenderedContent: string,
  viewerAgentId: string | null,
): Record<string, unknown> {
  const external = message.senderType === "external_projection";
  // Slack-bridged messages carry the viewer's personal mention fact like an
  // ordinary message would; any other external payload stays non-mentioned.
  const mentioned = isSlackBridgedExternalMessage(message)
    && isAgentPersonallyMentioned(message.mentions, viewerAgentId);
  const envelope: Record<string, unknown> = {
    ...messageWithoutAgentHiddenActionCardSpec(message),
    senderType: toAgentVisibleSenderType(message.senderType, message.messageType),
    content: renderAgentVisibleMessageContent(message, ordinaryRenderedContent),
    ...(external ? toAgentVisibleExternalMessage(message) : {}),
    ...(external ? { mentioned } : {}),
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
// A task conversation (task v2) is a sub-conversation: it reaches runtimes as
// `thread` under its parent channel (older daemons keep working) and carries
// `task_conversation_number`, so renderers address it by its task ref
// (`#parent:#7`) and point at `raft task reply`.
function toAgentVisibleChannelType(channelType: typeof channels.$inferSelect["type"]): AgentVisibleChannelType {
  return isSubConversationType(channelType)
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

/**
 * The zone the sender's latest message in `channelIds` carried (a human's
 * zone travels with each message), or null.
 */
export async function getLatestSenderTimezone(
  channelIds: string[],
  senderType: "user" | "agent",
  senderId: string,
): Promise<string | null> {
  if (channelIds.length === 0) return null;
  const [latest] = await getDb()
    .select({ senderTimezone: messages.senderTimezone })
    .from(messages)
    .where(and(
      inArray(messages.channelId, channelIds),
      eq(messages.senderType, senderType),
      eq(messages.senderId, senderId),
    ))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return latest?.senderTimezone ?? null;
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
  extraFields?: { threadId?: string | null; agentSendKey?: string | null; randomId?: string | null; actionMetadata?: unknown | null; causalActorType?: "user" | "agent" | null; causalActorId?: string | null; systemSubtype?: string | null; senderTimezone?: string | null; delegatedByAgentId?: string | null },
  executor?: DatabaseExecutor,
) {
  const persist = async (db: DatabaseExecutor) => {
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
      .set({ doneAt: null, updatedAt: currentDate() })
      .where(and(
        eq(userChannelInboxStates.channelId, channelId),
        isNotNull(userChannelInboxStates.doneAt),
      ));
    return message;
  };

  // Callers that already own a transaction must re-read the durable fence in
  // that same transaction. The standalone path acquires the exact per-source
  // lock before checking and inserting, so a conversion cannot win between
  // the check and the message row.
  if (executor) {
    await assertChannelWritableInTransaction(executor, channelId);
    return persist(executor);
  }
  return withChannelWriterFence(channelId, persist);
}

/**
 * The longest a prepared system message's reserved seq may wait for its insert.
 * Must stay below agentInboxLateRows' AGENT_INBOX_SKIP_RECORD_GRACE_MS.
 */
export const PREPARED_SYSTEM_MESSAGE_MAX_AGE_MS = 30_000;

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
  provenance?: { causalActor?: CausalActor; systemSubtype?: string },
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
    senderTimezone: null,
    delegatedByAgentId: null,
    deletedAt: null,
    messageType: "system",
    content,
    actionMetadata: null,
    searchText: buildSearchText(content),
    searchVector: null,
    // Set by the insert trigger from the channel.
    serverId: null,
    threadId: null,
    taskStatus: null,
    taskNumber: null,
    taskAssigneeType: null,
    taskAssigneeId: null,
    taskClaimedAt: null,
    taskCompletedAt: null,
    causalActorType: provenance?.causalActor?.type ?? null,
    causalActorId: provenance?.causalActor?.id ?? null,
    systemSubtype: provenance?.systemSubtype ?? null,
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
  // A reserved seq must be followed promptly by its row: an external agent's
  // skip records (agentInboxLateRows.ts) are deleted once no transaction of
  // their snapshot is in flight plus AGENT_INBOX_SKIP_RECORD_GRACE_MS, and a
  // row inserted later under a seq reserved before that would be missed.
  const reservedAgeMs = currentTimeMs() - prepared.createdAt.getTime();
  const tooOld = reservedAgeMs > PREPARED_SYSTEM_MESSAGE_MAX_AGE_MS;

  return getDb().transaction(async (tx) => {
    if (tooOld) {
      // A replay of a row already persisted is fine; a first insert this late is not.
      const [existing] = await tx.select({ id: messages.id }).from(messages)
        .where(and(eq(messages.senderType, "user"), eq(messages.senderId, "system"), eq(messages.randomId, eventId)))
        .limit(1);
      if (!existing) throw new Error(`Prepared system message reservation expired (${Math.round(reservedAgeMs)} ms old)`);
    }
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
        causalActorType: prepared.causalActorType,
        causalActorId: prepared.causalActorId,
        systemSubtype: prepared.systemSubtype,
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

  let targetVisibleMentions = mentionHandles && mentionHandles.length > 0
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
      getJointProjectionMembers: (localChannelIds) => getJointProjectionMembersWithExecutor(executor, localChannelIds),
      recordInboxNotificationFacts: (facts, factExecutor, notification) =>
        opts.deps.recordInboxNotificationFacts(facts, factExecutor ?? executor, notification),
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

  // External (Slack-side) structured mentions: a picker-confirmed
  // `@<slack-handle>` becomes an `external_mention_facts` row so the outbound
  // renderer can swap the visible text for `<@U…>`. Never written into
  // `message_mentions` — that table is "wake a Raft human/agent" and external
  // projections are not Raft actors. Resolution is scoped to this channel's
  // active binding's addressability (joint: the requested binding's own
  // projection set, so a member of server A can't address a Slack user only
  // visible on server B's binding).
  const externalMentions = (opts.mentions ?? []).filter((m) => m.type === "external");
  if (externalMentions.length > 0 && channel) {
    // Bindings live on the authority channel — a thread resolves through its
    // parent, a Joint projection through the local binding row.
    const surface = await readInSavepoint(() => resolveSlackOutboundMessageSurface({
      executor,
      requestedChannelId,
      messageChannelId: message.channelId,
    })).catch((error: unknown) => {
      console.warn(
        "messageService external mention surface resolution failed",
        { messageId: message.id, error: error instanceof Error ? error.name : "unknown" },
      );
      return null;
    });
    const bindings = surface ? await executor.select({
      id: externalChannelBindings.id,
      connectionEpoch: externalChannelBindings.connectionEpoch,
      bindingEpoch: externalChannelBindings.bindingEpoch,
      providerConversationId: externalChannelBindings.providerConversationId,
      registrationId: externalChannelBindings.registrationId,
      installId: externalChannelBindings.installId,
    }).from(externalChannelBindings).where(and(
      eq(externalChannelBindings.channelId, surface.bindingChannelId),
      eq(externalChannelBindings.state, "active"),
    )) : [];
    for (const binding of bindings) {
      const [install] = await executor.select({
        providerAuthorityId: externalAppInstalls.providerAuthorityId,
      }).from(externalAppInstalls).where(
        eq(externalAppInstalls.id, binding.installId),
      ).limit(1);
      if (!install) continue;
      const snapshots = await executor.select({
        audienceRevision: externalBindingAudienceSnapshots.audienceRevision,
      }).from(externalBindingAudienceSnapshots).where(and(
        eq(externalBindingAudienceSnapshots.bindingId, binding.id),
        eq(externalBindingAudienceSnapshots.bindingEpoch, binding.bindingEpoch),
        eq(externalBindingAudienceSnapshots.status, "matched"),
        gt(externalBindingAudienceSnapshots.expiresAt, new Date()),
      )).orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1);
      const revision = snapshots[0]?.audienceRevision;
      if (revision === undefined || !Number.isSafeInteger(revision) || revision <= 0) continue;
      for (const mention of externalMentions) {
        const resolution = await resolveExternalMentionFromDurableAuthority({
          executor,
          rawHandle: mention.name.trim(),
          explicitProjectionId: mention.id,
          raftPrincipalCollision: false,
          now: new Date(),
          context: {
            provider: "slack",
            appRegistrationId: binding.registrationId,
            installId: binding.installId,
            workspaceId: install.providerAuthorityId,
            connectionEpoch: binding.connectionEpoch,
            bindingId: binding.id,
            bindingEpoch: binding.bindingEpoch,
            conversationId: binding.providerConversationId,
            memberRevision: revision,
            contextRevision: revision,
          },
        });
        if (resolution.kind === "resolved") {
          await insertExternalMentionFact({
            executor,
            messageId: message.id,
            fact: resolution.fact,
          });
          // Surface the external mention in the message payload so the Raft
          // side renders it as styled text (not a plain `@handle`). Not a
          // `message_mentions` row — inbox/notify consumers filter by
          // `type === "user"` / `"agent"` and never see this entry.
          targetVisibleMentions.push({
            type: "external",
            id: resolution.fact.projectionId,
            name: resolution.fact.handleAtSendTime,
          });
        }
      }
    }
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
  isDmSend: boolean;
  authorityChannelId: string;
  requestedChannelId: string;
  senderId: string;
  authorName: string;
  content: string;
  randomId: string;
  senderTimezone: string | null;
  delegatedByAgentId?: string | null;
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
}, executor?: DatabaseExecutor) {
  const run = async (tx: DatabaseExecutor) => {
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
        senderTimezone: opts.senderTimezone,
        delegatedByAgentId: opts.delegatedByAgentId ?? null,
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
    if (insertedMessage && opts.isDmSend) await assertDmHumanPeersAreMembers(tx, opts.channelId, "user", opts.senderId);

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
  };
  if (executor) return run(executor);
  return getDb().transaction(run);
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

/**
 * The `message:new` body (and HTTP send response) for a freshly persisted
 * row. It must carry every key the canonical manifest declares present on
 * `message:new` (CANONICAL_MESSAGE_FIELD_DESCRIPTORS presence.messageNew) —
 * mobile accepts a realtime frame as a full canonical fact only when every
 * such key is present. Values match what REST enrichment
 * (enrichWithSenderNames) returns for the same brand-new row:
 * - senderDescription: the sender's user/agent description, `null` when unset
 *   (callers resolve it via getSenderIdentity, the same `description || null`).
 * - reactions: a just-created message has none → `[]`.
 * - externalAuthor: only external_projection senders have one; ordinary
 *   user/agent/system sends → `null`.
 * - commentRef: viewer-scoped; shared broadcasts carry `null`
 *   (shared-null-preserve), the actor response attaches the real ref.
 * - deletedAt (manifest v7, RFC 077): a just-created message is not retracted
 *   → `null`; set explicitly so the key is present whatever the row carries.
 */
export function buildPersistedMessageFrontendPayload<
  M extends typeof messages.$inferSelect,
  A extends { id: string; filename: string; mimeType: string; sizeBytes: number; width: number | null; height: number | null; thumbnailUrl: string | null },
>(
  message: M,
  fields: {
    channelId: string;
    senderName: string;
    senderDescription: string | null;
    senderMembershipStatus: "active" | null;
    attachments: A[];
    mentions: ResolvedMentionFact[];
    /** RFC 077: the assistant that sent this for its owner (the label message lists carry). */
    delegatedBy?: DelegatedByLabel | null;
  },
) {
  return {
    ...omitSenderTimezone(message),
    delegatedBy: fields.delegatedBy ?? null,
    // Manifest v7 declares deletedAt present on message:new; set it explicitly so the key never
    // depends on the row shape. A brand-new row is never retracted, so this is null in practice.
    deletedAt: message.deletedAt ?? null,
    channelId: fields.channelId,
    senderName: fields.senderName,
    senderDescription: fields.senderDescription,
    senderMembershipStatus: fields.senderMembershipStatus,
    attachments: fields.attachments,
    mentions: fields.mentions,
    reactions: [] as MessageReactionSummary[],
    commentRef: null as EnrichedMessageRow["commentRef"],
    externalAuthor: null as EnrichedMessageRow["externalAuthor"],
  };
}

/**
 * A person's own reply reopens a DM hidden for them (closed, or hidden because
 * the other person started it): a reply in the DM or in one of its threads
 * (task #59). Only DM ids are in hidden_dm_ids, so the thread's parent matches
 * only when it is a DM, and only a member row that holds the id is touched.
 * Best effort after commit: a sidebar preference, not part of the message.
 */
async function reopenHiddenDmAfterOwnReply(userId: string, candidateDmIds: readonly string[]): Promise<void> {
  for (const dmId of candidateDmIds) {
    await getDb().update(serverMembers)
      .set({
        hiddenDmIds: sql`(
          SELECT COALESCE(json_agg(id), '[]'::json)
          FROM json_array_elements_text(${serverMembers.hiddenDmIds}) existing(id)
          WHERE id <> ${dmId}
        )`,
      })
      .where(and(
        eq(serverMembers.userId, userId),
        sql`${serverMembers.hiddenDmIds}::jsonb ? ${dmId}`,
      ));
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
      senderDescription: string | null;
      senderMembershipStatus?: "active" | "left" | "removed" | null;
      reactions: MessageReactionSummary[];
      commentRef: EnrichedMessageRow["commentRef"];
      externalAuthor: EnrichedMessageRow["externalAuthor"];
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
  if (
    channel
    && senderType === "user"
    && message.messageType === "chat"
    && !message.delegatedByAgentId
    && (channel.type === "dm" || (channel.type === "thread" && channel.parentChannelId))
  ) {
    await reopenHiddenDmAfterOwnReply(senderId, channel.type === "dm" ? [channel.id] : [channel.parentChannelId!])
      .catch((err) => console.error("[messages] reopening a hidden DM after a reply failed", { channelId, errorClass: errorClassOf(err) }));
  }
  if (channel && !isSubConversationType(channel.type)) {
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

  if (isSubConversationType(channel?.type) && channel && (channel.parentMessageId || channel.taskId)) {
    const jointThreadProjections = await deps.getActiveJointThreadProjectionsByCanonicalThread(channelId);
    if (jointThreadProjections.length > 0) {
      // Thread: parent message. Task conversation (task v2): the task.
      const parentMessageId = channel.parentMessageId;
      const parentTaskId = channel.type === "task" ? channel.taskId : null;
      const db = getDb();
      const [parentMsg] = parentMessageId
        ? await db
          .select({
            channelId: messages.channelId,
            senderType: messages.senderType,
            senderId: messages.senderId,
            messageType: messages.messageType,
          })
          .from(messages)
          .where(eq(messages.id, parentMessageId))
        : [];

      const senderProjection = senderType === "user" || senderType === "agent"
        ? jointThreadProjections.find((projection) => projection.localThreadChannelId === enriched.channelId)
          ?? await deps.getJointThreadProjectionForMember(channelId, senderType, senderId)
        : null;
      if (senderProjection && (senderType === "user" || senderType === "agent")) {
        await channelService.recordThreadFollow(
          senderType,
          senderId,
          senderProjection.localThreadChannelId,
          parentMessageId,
          "replied",
          { parentTaskId, reactivateUnfollowed: true, joinedThroughSeq: message.seq },
        );
        if (senderType === "user") {
          await awaitPostPersistReadMutation(
            channelService.markReadLatest(senderId, senderProjection.localThreadChannelId),
          );
        }
      }

      if (
        parentMsg
        && isFollowableThreadAuthor(parentMsg)
        && (parentMsg.senderType === "user" || parentMsg.senderType === "agent")
        && parentMsg.senderId !== senderId
      ) {
        const authorProjection = await deps.getJointThreadProjectionForMember(
          channelId,
          parentMsg.senderType,
          parentMsg.senderId,
        );
        if (authorProjection && parentMessageId) {
          await channelService.recordThreadFollow(
            parentMsg.senderType,
            parentMsg.senderId,
            authorProjection.localThreadChannelId,
            parentMessageId,
            "authored",
            { joinedThroughSeq: message.seq - 1 },
          );
        }
      }

      // Thread summaries live under the parent message (thread-only).
      const threadInfo = parentMessageId ? await deps.getThreadInfo(parentMessageId) : null;
      for (const projection of jointThreadProjections) {
        await runSlackBridgeOutboundPipelineStage(
          "frontend_max_seq",
          () => updateMaxSeq(projection.localServerId, message.seq),
          { topology },
        );
        await deps.clearThreadDoneForAll(projection.localThreadChannelId);
        const followerIds = await getHumanThreadFollowerIds(projection.localThreadChannelId);
        const conversationContext = buildFrontendConversationContext({
          channelType: channel.type,
          parentMessageId,
          parentChannel: { id: projection.localParentChannelId, type: "joint" },
          taskId: parentTaskId,
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
        if (!parentMessageId || !threadInfo) continue;
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
    messageType: "chat" | "system";
  } | null = null;
  const taskConversation = channel?.type === "task" && channel.taskId ? channel : null;
  if ((channel?.type === "thread" && channel.parentMessageId) || taskConversation) {
    // Reply-path auto-follows must happen before the room join + message:new
    // broadcast below. Otherwise the parent author is not yet in the thread
    // room for the first reply and can miss the live notification until a
    // later refresh/reply creates the follow projection.
    // Task conversation (task v2): no parent message (its creator follows from
    // creation); the reply still follows the replier.
    const db = getDb();
    const [parentMsg] = channel?.parentMessageId
      ? await db
        .select({
          channelId: messages.channelId,
          senderType: messages.senderType,
          senderId: messages.senderId,
          messageType: messages.messageType,
        })
        .from(messages)
        .where(eq(messages.id, channel.parentMessageId))
      : [];
    parentMsgForThread = parentMsg ?? null;

    if (senderType === "user" || senderType === "agent") {
      await channelService.recordThreadFollow(
        senderType,
        senderId,
        channelId,
        channel?.parentMessageId ?? null,
        "replied",
        { parentTaskId: taskConversation?.taskId ?? null, reactivateUnfollowed: true, joinedThroughSeq: message.seq },
      );
      if (senderType === "user") {
        await awaitPostPersistReadMutation(channelService.markReadLatest(senderId, channelId));
      }
    }

    if (
      parentMsgForThread
      && isFollowableThreadAuthor(parentMsgForThread)
      && (parentMsgForThread.senderType === "user" || parentMsgForThread.senderType === "agent")
      && parentMsgForThread.senderId !== senderId
    ) {
      await channelService.recordThreadFollow(
        parentMsgForThread.senderType,
        parentMsgForThread.senderId,
        channelId,
        channel!.parentMessageId,
        "authored",
        { joinedThroughSeq: message.seq - 1 },
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
  } else if (isSubConversationType(channel?.type)) {
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

  if (channel && isSubConversationType(channel.type)) {
    const parentChannelId = parentMsgForThread?.channelId
      ?? (channel.type === "task" ? channel.parentChannelId : null);
    const parentChannel = parentChannelId
      ? await deps.getChannel(parentChannelId)
      : null;
    const conversationContext = buildFrontendConversationContext({
      channelType: channel.type,
      parentMessageId: channel.parentMessageId,
      parentChannel,
      taskId: channel.taskId,
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

// Older CLIs always send this filler as the unfollow reason; it only repeats the
// line. Remove once no supported CLI predates the CLI that stopped sending it
// (thread/task unfollow without --reason now sends no reason).
const LEGACY_DEFAULT_UNFOLLOW_REASON = "no longer following";

/** An unfollow reason as given, or undefined for none (blank or the legacy filler). */
export function normalizeUnfollowReason(reason: unknown): string | undefined {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text || text.toLowerCase() === LEGACY_DEFAULT_UNFOLLOW_REASON) return undefined;
  return text;
}

/** The line an agent's unfollow posts: "@agent stopped following this thread", plus ": <reason>" when given. */
export function buildUnfollowNotice(agentName: string, target: "thread" | "task", reason?: string): string {
  const line = `@${agentName} stopped following this ${target}`;
  return reason ? `${line}: ${summarizeForSystemMessage(reason)}` : line;
}

const TASK_STATUS_EMOJI: Record<string, string> = { todo: "📝", in_progress: "🔄", in_review: "👀", done: "✅", closed: "🚫" };
const TASK_STATUS_LABEL: Record<string, string> = { backlog: "Backlog", todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done", closed: "Closed" };

/**
 * Shared task-status notice text for both the human and agent lifecycle paths.
 * Single source so a label/emoji tweak reaches every caller (they must not
 * drift — same lesson as the missing agent send this extracted helper fixes).
 *
 * A move to Backlog is worded by raft-design `design/patterns/tasks.md`
 * ("Martin moved #25 to Backlog: waits for the server-side record"): no glyph,
 * no title, and its reason when it has one. The reason is one line already
 * (`checkTaskStatusReason`).
 */
export function buildTaskStatusChangeNotice(
  actorName: string,
  taskNumber: number,
  title: string,
  status: string,
  backlogReason?: string,
): string {
  if (status === "backlog") {
    return `${actorName} moved #${taskNumber} to ${TASK_STATUS_LABEL.backlog}${backlogReason ? `: ${backlogReason}` : ""}`;
  }
  return `${TASK_STATUS_EMOJI[status] || "📝"} ${actorName} moved #${taskNumber} "${summarizeForSystemMessage(title)}" to ${TASK_STATUS_LABEL[status] || status}`;
}

/**
 * A thread system notice reaches the thread's agent followers. A directed one
 * (personal-attention target, e.g. a task assignment in the task conversation)
 * must also reach its target agent when that agent does NOT follow the thread
 * — and must not make it follow. The target is admitted only when this
 * notice's own inbox facts admitted it (a member of the parent scope with a
 * personal mention), so a caller cannot widen the audience past what the
 * fact path already authorized.
 */
async function withThreadPersonalAttentionAgents(
  followers: readonly AgentDeliveryCandidate[],
  threadChannelId: string,
  messageId: string,
  personalAttentionTargets: readonly ResolvedMentionFact[],
  factCandidates: readonly AgentDeliveryCandidate[] | undefined,
): Promise<AgentDeliveryCandidate[]> {
  const targetAgentIds = personalAttentionTargets
    .filter((target) => target.type === "agent")
    .map((target) => target.id)
    .filter((id) => !followers.some((agent) => agent.id === id));
  if (targetAgentIds.length === 0) return [...followers];
  const admitted = factCandidates
    ?? await getPersistedThreadAgentDeliveryAudience(messageId, threadChannelId)
    ?? [];
  const admittedIds = new Set(admitted.map((agent) => agent.id));
  return uniqueAgentDeliveryCandidates([
    ...followers,
    ...targetAgentIds.filter((id) => admittedIds.has(id)).map((id) => ({ id })),
  ]);
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
    /** Structured metadata stored on the new system row (ignored with `persistedMessage`). */
    actionMetadata?: unknown | null;
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
    ?? await deps.createMessage(channelId, "user", "system", content, "system", undefined, {
      causalActorType: opts.inboxFactPolicy.causalActor?.type ?? null,
      causalActorId: opts.inboxFactPolicy.causalActor?.id ?? null,
      systemSubtype: opts.inboxFactPolicy.producer,
      ...(opts.actionMetadata != null ? { actionMetadata: opts.actionMetadata } : {}),
    });
  const personalAttentionTargets = opts.personalAttentionTargets ?? [];
  // Same manifest-complete `message:new` key set as an ordinary send
  // (buildPersistedMessageFrontendPayload), with REST's values for a system
  // row: no sender description/membership, no attachments or reactions yet.
  const enriched = {
    ...message,
    // Manifest v7: deletedAt is present on message:new (a system row is never retracted).
    deletedAt: message.deletedAt ?? null,
    senderName: "System",
    senderDescription: null as string | null,
    senderMembershipStatus: null,
    attachments: [] as Array<{ id: string; filename: string; mimeType: string; sizeBytes: number; width: number | null; height: number | null; thumbnailUrl: string | null }>,
    mentions: personalAttentionTargets,
    reactions: [] as MessageReactionSummary[],
    commentRef: null as EnrichedMessageRow["commentRef"],
    externalAuthor: null as EnrichedMessageRow["externalAuthor"],
  };

  const channel = await deps.getChannel(channelId);
  if (!messageWasPersisted && channel && personalAttentionTargets.length > 0) {
    // `ResolvedMentionFact` widened to include `"external"` for picker-
    // confirmed provider mentions; those never become `message_mentions` rows
    // (inbox semantics are Raft-actor-only), so filter them out here.
    await deps.insertMentionRows(personalAttentionTargets.filter((t): t is ResolvedMentionFact & { type: "user" | "agent" } => t.type !== "external").map((target) => ({
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

  // Thread agent receivers admitted by this notice's own inbox facts (see the
  // agent delivery below); only computed here when facts are recorded here.
  let threadFactAgentCandidates: AgentDeliveryCandidate[] | undefined;
  if (!messageWasPersisted && channel && opts.inboxFactPolicy.mode === "record") {
    const inboxFactStart = currentTimeMs();
    const jointProjections = isSubConversationType(channel.type)
      ? []
      : await deps.getActiveJointChannelProjectionsByLocalChannel(channelId);
    const jointThreadProjections = isSubConversationType(channel.type)
      ? await deps.getActiveJointThreadProjectionsByCanonicalThread(channelId)
      : [];
    const {
      recorded: factCount,
      bornReadReceiverCount,
      threadAgentDeliveryCandidates,
    } = await recordInboxFactsForPersistedMessage({
      channel,
      message,
      senderType: "system",
      senderId: "system",
      causalActor: opts.inboxFactPolicy.causalActor,
      targetVisibleMentions: personalAttentionTargets,
      jointProjections,
      jointThreadProjection: jointThreadProjections[0] ?? null,
      deps,
      dedupeLogicalReceiverAcrossJointProjections:
        opts.dedupeLogicalReceiverAcrossJointProjections,
      producer: opts.inboxFactPolicy.producer,
    });
    threadFactAgentCandidates = threadAgentDeliveryCandidates;
    addTraceEvent("message_pipeline.system_inbox_notification_facts.recorded", {
      ...traceAttrs,
      duration_ms: currentTimeMs() - inboxFactStart,
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
  } else if (isSubConversationType(channel?.type)) {
    const followerIds = await getHumanThreadFollowerIds(channelId);
    threadFollowerIdsForFrontend = followerIds;
    for (const userId of followerIds) {
      io.in(socketUserServerRoom(userId, channel.serverId)).socketsJoin(channelRoom);
    }
  }

  // Broadcast to frontend
  if (channel && isSubConversationType(channel.type)) {
    const [parentMsg] = channel.parentMessageId
      ? await getDb()
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, channel.parentMessageId))
      : [];
    // Task conversation (task v2): parent channel stored on the row.
    const parentChannelId = parentMsg?.channelId ?? (channel.type === "task" ? channel.parentChannelId : null);
    const parentChannel = parentChannelId
      ? await deps.getChannel(parentChannelId)
      : null;
    const payload = projectFrontendMessagePayload(withFrontendConversationContext(enriched, buildFrontendConversationContext({
      channelType: channel.type,
      parentMessageId: channel.parentMessageId,
      parentChannel,
      taskId: channel.taskId,
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
      ? isSubConversationType(channel.type)
        ? (threadFollowerIdsForFrontend ?? []).length
        : (await deps.getChannelHumans(channelId)).length
      : 0,
  });

  // Deliver to agents in channel
  if (!channel) return enriched;

  // Track max seq for heartbeat (P2)
  updateMaxSeq(channel.serverId, message.seq);

  const agentsInChannel: AgentDeliveryCandidate[] = isSubConversationType(channel.type)
    ? await withThreadPersonalAttentionAgents(
      await getThreadAgentFollowers(channelId),
      channelId,
      message.id,
      personalAttentionTargets,
      threadFactAgentCandidates,
    )
    : await deps.getChannelAgents(channelId);
  const targetAgentIdSet = opts.targetAgentIds ? new Set(opts.targetAgentIds) : null;
  // Only agents for which the message is unread: the agent that caused it (it
  // joined, or added itself) or a noise subtype is born-read in its inbox, so
  // delivering it would wake the agent / show it in an inbox notice that its
  // pull never returns.
  const unfilteredTargetedAgents = (targetAgentIdSet
    ? agentsInChannel.filter((agent) => targetAgentIdSet.has(agent.id))
    : agentsInChannel
  ).filter((agent) => isMessageUnreadEligibleForReceiver(message, { type: "agent", id: agent.id }, {
    personallyMentioned: personalAttentionTargets.some((target) => target.type === "agent" && target.id === agent.id),
  }));
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
  const parentFields = isSubConversationType(channel.type)
    ? await resolveThreadParentFields(channel.id)
    : {};
  if (opts.awaitAgentDelivery && targetedAgents.length === 0) {
    throw new Error("SYSTEM_MESSAGE_AGENT_DELIVERY_TARGET_MISSING");
  }
  // Each recipient's payload (a DM resolves the agent-facing names, reads only
  // for a DM), then one channel batch: agent rows and access read once.
  const deliveries: Array<{ agentId: string; message: AgentMessage; options?: DeliverMessageOptions }> = [];
  for (const agent of targetedAgents) {
    deliveries.push({
      agentId: agent.id,
      message: {
        channel_id: channelId,
        channel_type: toAgentVisibleChannelType(channel.type),
        ...parentFields,
        ...await resolveRecipientDeliveryNames(channel.serverId, agent.id, channel, parentFields),
        sender_id: "system",
        sender_name: "system",
        sender_type: "system",
        content: renderedContent,
        timestamp: message.createdAt.toISOString(),
        seq: message.seq,
        message_id: message.id,
        ...(piercedAgentIds.has(agent.id) && { mentioned: true }),
      },
      options: opts.agentDeliveryOptions,
    });
  }
  const sysResults = agentOrchestrator.deliverMessagesOnChannel(channelId, deliveries);
  if (opts.awaitAgentDelivery) {
    const results = await Promise.all(sysResults);
    const dropped = results.find((result) => result.status !== "queued");
    if (dropped) {
      throw new Error(`SYSTEM_MESSAGE_AGENT_DELIVERY_DROPPED:${dropped.reason}`);
    }
  } else {
    void settleDeliveries(sysResults, deliveries.map((delivery) => delivery.agentId), "system message");
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
    /** Structured metadata stored on the new system row (ignored with `persistedMessage`). */
    actionMetadata?: unknown | null;
  },
) {
  const deps = resolveMessageServiceDeps();
  const channel = await deps.getChannel(channelId);
  const jointThreadProjection = isSubConversationType(channel?.type)
    ? await channelService.getJointThreadProjectionByLocalThread(channelId)
    : null;
  const jointChannelProjections = channel && !isSubConversationType(channel.type)
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
        channelType: projection.kind,
        parentMessageId: projection.canonicalParentMessageId,
        parentChannel: { id: projection.localParentChannelId, type: "joint" },
        taskId: projection.canonicalParentTaskId,
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
    channel_name: "task_conversation_number" in parentFields && parentFields.task_conversation_number
      ? formatAgentTaskRefTail(parentFields.task_conversation_number)
      : notice.channel_name,
    channel_type: notice.channel_type,
    ...parentFields,
    sender_id: "system",
    sender_name: "system",
    sender_type: "system",
    content: renderedContent,
    timestamp: notice.timestamp ?? currentDate().toISOString(),
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
  // Search-index columns are never read here; accepting rows without them lets
  // history reads (which skip them) feed delivery too.
  rawMessageBatch: readonly Omit<typeof messages.$inferSelect, "searchText" | "searchVector">[],
  senderName: string,
  opts: {
    personalAttentionTargets?: readonly ResolvedMentionFact[];
    /**
     * Caller-resolved audience override (agent ids). Used by the external
     * inbound commit hook, where the durable receivers are the persisted
     * inbox-notification facts — covering threads and Joint local faces that
     * have no channel_agents rows on the stored channel.
     */
    recipientAgentIds?: readonly string[];
  } = {},
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
  const parentFields = isSubConversationType(channel.type)
    ? await resolveThreadParentFields(channel.id)
    : {};

  // Threads (and task conversations) carry no channel_agents rows; their agent audience resolves the
  // same way the send path resolves it — durable inbox-facts receivers with
  // the follower set as fallback (same contract, same helper).
  const agentsInChannel: AgentDeliveryCandidate[] = opts.recipientAgentIds
    ? uniqueAgentDeliveryCandidates(opts.recipientAgentIds.map((id) => ({ id })))
    : isSubConversationType(channel.type)
      ? (await resolveThreadAgentDeliveryCandidates({
          deps,
          threadChannelId: channel.id,
          messageId: firstMessage.id,
        })).candidates
      : await deps.getChannelAgents(firstMessage.channelId);
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

  const recipientNames = new Map(await Promise.all(candidateAgents.map(async (agent) => [
    agent.id, await resolveRecipientDeliveryNames(channel.serverId, agent.id, channel, parentFields),
  ] as const)));

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
      // Deliver only what the agent's inbox counts as unread (inboxUnreadEligibility).
      if (!isMessageUnreadEligibleForReceiver(message, { type: "agent", id: agent.id }, {
        personallyMentioned: piercedAgentIds.has(agent.id),
      })) continue;
      const payloads = payloadsByAgent.get(agent.id) ?? [];
      payloads.push({
        channel_id: message.channelId,
        channel_name: channel.name,
        channel_type: toAgentVisibleChannelType(channel.type),
        ...parentFields,
        ...recipientNames.get(agent.id),
        sender_id: message.senderId,
        sender_name: message.externalAuthor?.displayName ?? senderIdentity.uniqueName,
        sender_description: senderIdentity.description,
        sender_timezone: message.senderTimezone ?? null,
        ...(await agentDelegatedByField(message as { delegatedByAgentId?: string | null })),
        // RFC 082: a card message reads `card=r<revision>` in the header; its content is the fallback.
        ...agentMessageCardField((message as { actionMetadata?: unknown }).actionMetadata),
        sender_type: toAgentVisibleSenderType(message.senderType, message.messageType),
        ...toAgentVisibleExternalMessage(message),
        // A resolved mention fact on an external_projection message carries the
        // same weight as a user/agent mention: it means the provider-side
        // sender addressed this agent through an identity link, not arbitrary
        // Slack text. Fail-open to mentioned=true only when we minted that fact.
        ...(message.senderType === "external_projection" && { mentioned: piercedAgentIds.has(agent.id) }),
        ...(message.senderType !== "external_projection" && piercedAgentIds.has(agent.id) && { mentioned: true }),
        content: renderAgentVisibleMessageContent(message, renderedContents[index]!),
        timestamp: message.createdAt.toISOString(),
        seq: message.seq,
        message_id: message.id,
        ...(message.senderType !== "external_projection" && message.taskStatus != null && {
          task_status: message.taskStatus as "backlog" | "todo" | "in_progress" | "in_review" | "done" | "closed",
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

  // Every message's mention occurrences in one write per message, BEFORE any delivery (durability
  // has to precede delivery, as in broadcastAndDeliver). A record-keeping write must never suppress
  // the thing it records, so a failed write degrades (typed trace) and we still deliver.
  const occurrenceIdsByMessage = new Map<string, Map<string, string>>();
  for (const message of messageBatch) {
    const entries = [...payloadsByAgent].flatMap(([agentId, payloads]) =>
      payloads.filter((payload) => payload.message_id === message.id).map((deliveryPayload) => ({ agentId, deliveryPayload })));
    if (entries.length === 0) continue;
    try {
      occurrenceIdsByMessage.set(message.id, await ensureAgentMentionDeliveryOccurrencesForAgents(message.id, entries));
    } catch (err) {
      addTraceEvent("message_pipeline.mention_occurrence.persist_degraded", {
        message_id: message.id,
        intended_occurrence_count: entries.length,
        delivered_without_occurrence: true,
        recoverable: false,
      });
      console.error(
        `[MessageService] mention delivery occurrences unavailable for message ${message.id}; delivering without them (these mentions are not recoverable):`,
        err,
      );
    }
  }

  // Every recipient's agent row and channel access once for the batch (all messages share the
  // channel); recipients then run in parallel, each recipient's messages in order.
  const gates = payloadsByAgent.size > 1
    ? await agentOrchestrator.loadDeliveryGates(channel.id, [...payloadsByAgent.keys()])
    : null;
  await Promise.all([...payloadsByAgent].map(async ([agentId, payloads]) => {
    for (const payload of payloads) {
      const mentionDeliveryOccurrenceId = payload.message_id
        ? occurrenceIdsByMessage.get(payload.message_id)?.get(agentId)
        : undefined;
      try {
        await agentOrchestrator.deliverMessage(agentId, payload, {
          ...deliveryOptions,
          ...(mentionDeliveryOccurrenceId && { mentionDeliveryOccurrenceId }),
        }, gates);
      } catch (err) {
        console.error(`[MessageService] Failed to deliver task message to agent ${agentId}:`, serializeErrorForLog(err));
      }
    }
  }));
}

/** Waits for started deliveries, logging each failure; never rejects. */
function settleDeliveries(
  results: ReadonlyArray<Promise<AgentMessageDeliveryResult>>,
  agentIds: readonly string[],
  what: string,
): Promise<void> {
  // fanout-ok: attaches a handler to deliveries already started by deliverMessagesOnChannel; no I/O of its own.
  return Promise.all(results.map((result, index) => result.catch((err) => {
    console.error(`[MessageService] Failed to deliver ${what} to agent ${agentIds[index]}:`, serializeErrorForLog(err));
  }))).then(() => undefined);
}

/** Storage names are not addresses. Resolve DM peers for this recipient,
 * including the parent of a thread; never infer them from a system sender. */
async function resolveRecipientDeliveryNames(
  serverId: string,
  agentId: string,
  channel: { id: string; name: string; type: string },
  parent: AgentThreadParentFields = {},
): Promise<Pick<AgentMessage, "channel_name" | "parent_channel_name" | "task_conversation_number">> {
  // Task v2: a task conversation is named by its ref's tail (`#7`), so every
  // renderer — including daemons and CLIs from before task v2, which print a
  // thread as `#${parent}:${channel_name}` — shows the task ref `#parent:#7`.
  channel = parent.task_conversation_number
    ? { ...channel, name: formatAgentTaskRefTail(parent.task_conversation_number) }
    : channel;
  const dmId = channel.type === "dm" ? channel.id
    : parent.parent_channel_type === "dm" ? parent.parent_channel_id : undefined;
  if (!dmId) return { channel_name: channel.name, ...parent };
  const ref = await channelService.resolveAgentFacingChannelRef(serverId, agentId, dmId);
  // A DM with no resolvable peer is not automatically an error. Agent-facing
  // private surfaces such as the migration receipt DM have exactly one agent
  // member, no dm_channel_identities row, and no human peer, so all three
  // resolution fallbacks decline and there is genuinely no peer name to use.
  // Falling back to the channel's own name keeps the message readable and keeps
  // the delivery working; throwing here would break the whole catch-up page for
  // such a channel rather than degrade its label.
  if (!ref?.startsWith("dm:@")) return { channel_name: channel.name, ...parent };
  const peer = ref.slice(4);
  return channel.type === "dm"
    ? { channel_name: peer }
    : { channel_name: channel.name, ...parent, parent_channel_name: peer };
}

/**
 * The conversation fields an agent envelope needs to name its conversation
 * (`channel_type` / `channel_name`, plus the parent for a thread), for a page
 * read from one non-DM channel or thread. Storage names only: callers must
 * not pass a DM or a thread under one (DM names are per-recipient peers).
 */
export async function agentConversationLabelsForChannel(
  channel: { id: string; name: string; type: typeof channels.$inferSelect["type"] },
): Promise<Pick<AgentMessage, "channel_id" | "channel_name" | "channel_type" | "parent_channel_id" | "parent_channel_name" | "parent_channel_type" | "task_conversation_number">> {
  const parentFields: AgentThreadParentFields = isSubConversationType(channel.type) ? await resolveThreadParentFields(channel.id) : {};
  return {
    channel_id: channel.id,
    // Task v2: the ref's tail (`#7`), so the target renders as the task ref.
    channel_name: parentFields.task_conversation_number ? formatAgentTaskRefTail(parentFields.task_conversation_number) : channel.name,
    channel_type: toAgentVisibleChannelType(channel.type),
    ...parentFields,
  };
}

/**
 * A sub-conversation's parent labels, plus (task v2) the task number of a task
 * conversation, which makes its agent target the task ref.
 */
type AgentThreadParentFields = Pick<AgentMessage, "parent_channel_name" | "parent_channel_id" | "parent_channel_type" | "task_conversation_number">;

async function resolveThreadParentFields(
  threadChannelId: string,
): Promise<AgentThreadParentFields> {
  const threadChannel = await channelService.getChannel(threadChannelId);
  if (!isSubConversationType(threadChannel?.type) || !threadChannel) return {};
  const db = getDb();
  let parentChannelId: string | null = null;
  if (threadChannel.type === "task") {
    // Task conversation (task v2): every face stores its local parent channel.
    parentChannelId = threadChannel.parentChannelId;
  } else if (threadChannel.parentMessageId) {
    const [parentMessage] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, threadChannel.parentMessageId))
      .limit(1);
    parentChannelId = parentMessage?.channelId ?? null;
  } else {
    // Joint thread local faces carry no parent_message_id — the durable
    // local↔canonical anchor is the projection row, so the parent context is
    // that face's local parent channel (agent payload contract).
    const jointThread = await channelService.getJointThreadProjectionByLocalThread(
      threadChannelId,
      threadChannel.serverId,
      db,
    );
    parentChannelId = jointThread?.localParentChannelId ?? null;
  }
  if (!parentChannelId) return {};
  const parentChannel = await channelService.getChannel(parentChannelId);
  if (!parentChannel) return {};
  // channel_type flattens joint → channel (existing agent envelope contract),
  // but parent_channel_type carries the real type so a Joint thread reply
  // reaches the agent with parent_channel_type: "joint" (send path parity).
  const parentChannelType = parentChannel.type === "joint"
    ? "joint"
    : toAgentVisibleChannelType(parentChannel.type);
  const taskConversationNumber = await taskConversationNumberForChannel(threadChannel);
  return {
    parent_channel_name: parentChannel.name,
    parent_channel_id: parentChannel.id,
    parent_channel_type: parentChannelType === "thread" ? "channel" : parentChannelType,
    ...(taskConversationNumber && { task_conversation_number: taskConversationNumber }),
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
    deliveryChannelId?: string;
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
  const [durableAgentMention] = message.senderType === "external_projection"
    ? await db.select({ id: messageMentions.id }).from(messageMentions).where(and(
        eq(messageMentions.messageId, message.id),
        eq(messageMentions.targetType, "agent"),
        eq(messageMentions.targetId, agentId),
        eq(messageMentions.notifiableAtSend, true),
      )).limit(1)
    : [];

  const messageChannel = await deps.getChannel(message.channelId);
  if (!messageChannel) return { status: "dropped", reason: "channel_unavailable" };
  const channel = options.deliveryChannelId
    ? await deps.getChannel(options.deliveryChannelId)
    : messageChannel;
  if (
    !channel
    || channel.serverId !== messageChannel.serverId
    || (options.deliveryChannelId && (
      channel.type !== "thread"
      || channel.parentMessageId !== message.id
    ))
  ) return { status: "dropped", reason: "channel_unavailable" };

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

  let parentFields: AgentThreadParentFields = {};
  if (channel.type === "task") {
    parentFields = await resolveThreadParentFields(channel.id);
  } else if (channel.type === "thread" && channel.parentMessageId) {
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
      channel_id: channel.id,
      channel_type: toAgentVisibleChannelType(channel.type),
      sender_id: message.senderId,
      sender_name: senderName,
      sender_description: senderDescription,
      sender_timezone: message.senderTimezone ?? null,
      ...(await agentDelegatedByField(message as { delegatedByAgentId?: string | null })),
      // RFC 082: a card message reads `card=r<revision>` in the header; its content is the fallback.
      ...agentMessageCardField((message as { actionMetadata?: unknown }).actionMetadata),
      sender_type: toAgentVisibleSenderType(message.senderType, message.messageType),
      ...toAgentVisibleExternalMessage(message),
      content: renderAgentVisibleMessageContent(message, renderedContent),
      timestamp: message.createdAt.toISOString(),
      seq: message.seq,
      message_id: message.id,
      mentioned: message.senderType === "external_projection" ? Boolean(durableAgentMention) : true,
      ...(message.senderType !== "external_projection" && options.nonMemberMention === true && { non_member_mention: true }),
      ...parentFields,
      ...await resolveRecipientDeliveryNames(channel.serverId, agentId, channel, parentFields),
      ...(message.senderType !== "external_projection" && message.taskStatus != null && {
        task_status: message.taskStatus as "backlog" | "todo" | "in_progress" | "in_review" | "done" | "closed",
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
 * Post-commit agent delivery for a committed external inbound message (the
 * Slack-bridge onInboundMessageCommitted hook). External commits persist on
 * the canonical channel/thread, so the audience is the durable inbox-fact
 * receiver set grouped by face (sourceChannelId = the local face id), with a
 * per-face channel projection so each face's agents receive their own local
 * channel identity. Minted mention targets outside the fact audience get the
 * same non-member wake the send path produces — exactly once per agent.
 */
/**
 * Run the post-commit side effects of a committed external inbound message
 * (frontend emit + agent delivery) so that one leg's failure cannot suppress
 * the other: the worker treats a thrown callback as a degraded-commit log
 * point and never replays it, so an early throw would permanently skip every
 * effect behind it. Both effects always run; failures are re-raised (as an
 * AggregateError when both fail) so the worker still records the degraded
 * commit.
 */
export async function runExternalInboundCommitSideEffects(
  emitFrontend: () => Promise<void>,
  deliverToAgents: () => Promise<void>,
): Promise<void> {
  const [emitResult, deliveryResult] = await Promise.allSettled([
    emitFrontend(),
    deliverToAgents(),
  ]);
  const errors = [emitResult, deliveryResult]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "External inbound post-commit side effects failed");
}

export async function deliverExternalInboundCommittedMessageToAgents(
  agentOrchestrator: AgentOrchestrator,
  messageId: string,
): Promise<void> {
  const db = getDb();
  const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!message) return;
  const [channel] = await db.select().from(channels).where(eq(channels.id, message.channelId)).limit(1);
  if (!channel) return;

  const mentionRows = await db
    .select({
      targetType: messageMentions.targetType,
      targetId: messageMentions.targetId,
      handleAtSendTime: messageMentions.handleAtSendTime,
    })
    .from(messageMentions)
    .where(and(
      eq(messageMentions.messageId, messageId),
      eq(messageMentions.notifiableAtSend, true),
    ));
  const personalAttentionTargets: ResolvedMentionFact[] = mentionRows.map((row) => ({
    type: row.targetType,
    id: row.targetId,
    name: row.handleAtSendTime,
  }));

  const agentFactRows = await db
    .select({
      receiverId: inboxNotificationFacts.receiverId,
      sourceChannelId: inboxNotificationFacts.sourceChannelId,
    })
    .from(inboxNotificationFacts)
    .where(and(
      eq(inboxNotificationFacts.messageId, messageId),
      eq(inboxNotificationFacts.receiverType, "agent"),
    ));
  const faceAgentIds = new Map<string, string[]>();
  for (const row of agentFactRows) {
    const ids = faceAgentIds.get(row.sourceChannelId) ?? [];
    ids.push(row.receiverId);
    faceAgentIds.set(row.sourceChannelId, ids);
  }
  const deliveredAgentIds = new Set<string>();
  // An "ordinary bound channel" is exactly one inbox face that IS the
  // canonical channel (channel.type === "channel" alone is not enough — a
  // joint canonical channel also has type "channel" but its faces live on
  // other channels). Only that shape supports canonical-thread delivery:
  // a Slack root Agent mention routes into the thread so the Agent's reply
  // uses the linked Slack thread_ts. Joint commits keep face-channel
  // delivery everywhere and never take the thread path.
  const isOrdinaryBoundChannel = channel.type === "channel"
    && faceAgentIds.size === 1
    && faceAgentIds.has(channel.id);
  const threadMentionedAgentIds = isOrdinaryBoundChannel
    ? new Set(personalAttentionTargets.filter((t) => t.type === "agent").map((t) => t.id))
    : new Set<string>();
  for (const [faceChannelId, agentIds] of faceAgentIds) {
    const isOrdinaryBoundFace = isOrdinaryBoundChannel && faceChannelId === channel.id;
    const threadAgents = isOrdinaryBoundFace
      ? agentIds.filter((id) => threadMentionedAgentIds.has(id))
      : [];
    const channelAgents = agentIds.filter((id) => !threadAgents.includes(id));
    if (channelAgents.length > 0) {
      await deliverMessagesToAgents(
        agentOrchestrator,
        [{ ...message, channelId: faceChannelId }],
        "external user",
        { personalAttentionTargets, recipientAgentIds: channelAgents },
      );
      for (const id of channelAgents) deliveredAgentIds.add(id);
    }
    for (const agentId of threadAgents) {
      const deliveryChannelId = (await channelService.getOrCreateThread(message.id, agentId, "agent")).id;
      const deliveryChannel = await channelService.getChannel(deliveryChannelId);
      if (!deliveryChannel) continue;
      if (!await channelService.canAgentAccessChannel(deliveryChannel.id, agentId)) continue;
      await deliverMessageToAgent(agentOrchestrator, messageId, agentId, {
        requireQueueReceipt: true,
        deliveryChannelId,
      });
      deliveredAgentIds.add(agentId);
    }
  }
  for (const target of personalAttentionTargets) {
    if (target.type !== "agent" || deliveredAgentIds.has(target.id)) continue;
    // Same ordinary-bound-channel gate as above: a joint canonical channel
    // has type "channel" too, but routing an outside-mention agent into a
    // canonical thread would break face delivery, so joint messages keep
    // the plain (non-thread) delivery path.
    const deliveryChannelId = isOrdinaryBoundChannel
      ? (await channelService.getOrCreateThread(message.id, target.id, "agent")).id
      : undefined;
    const deliveryChannel = deliveryChannelId
      ? await channelService.getChannel(deliveryChannelId)
      : channel;
    if (!deliveryChannel) continue;
    if (!await channelService.canAgentAccessChannel(deliveryChannel.id, target.id)) continue;
    await deliverMessageToAgent(agentOrchestrator, messageId, target.id, {
      requireQueueReceipt: true,
      nonMemberMention: true,
      reconcileNonMemberMention: true,
      deliveryChannelId,
    });
  }
}

export const RESUME_CATCHUP_MAX_CHANNELS = 8;
const RESUME_CATCHUP_MAX_CANDIDATES = RESUME_CATCHUP_MAX_CHANNELS * 4;
const RESUME_CATCHUP_MAX_ROWS_PER_CHANNEL = 5;
const RESUME_CATCHUP_MAX_ROWS_TOTAL = 20;

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
  /**
   * RFC 071 §6: the exclusive lower bound the rows are read from,
   * max(read cursor, obligation cursor). Absent (no obligation): the read cursor.
   */
  lowerBoundSeq?: number;
  /**
   * Late rows (agentInboxLateRows.ts): read exactly these seqs, which sit at or
   * below the read position, instead of the rows above the lower bound.
   */
  onlySeqs?: number[];
};

function compareResumeCatchupCandidates(a: ResumeCatchupCandidate, b: ResumeCatchupCandidate) {
  const aPierce = a.latestPiercingSeq ?? 0;
  const bPierce = b.latestPiercingSeq ?? 0;
  if (aPierce !== bPierce) return bPierce - aPierce;
  if (a.latestUnreadSeq !== b.latestUnreadSeq) return b.latestUnreadSeq - a.latestUnreadSeq;
  return b.firstUnreadSeq - a.firstUnreadSeq;
}

/** Where a catch-up message came from: what delivery needs beyond the AgentMessage. */
export interface AgentResumeCatchupSource {
  serverId: string;
  senderType: StoredMessageSenderType;
  senderId: string;
  system: boolean;
}

export interface AgentResumeCatchupResult {
  messages: AgentMessage[];
  /** Parallel to `messages`. Managed resume sends only `messages`; the external inbox pull derives delivery options from these. */
  sources: AgentResumeCatchupSource[];
  /** Every conversation whose rows were read, and whether unread rows remain beyond the ones returned. */
  conversations: Array<{ channelId: string; truncated: boolean }>;
  candidateChannelCount: number;
  maxSeq: number | null;
  /**
   * RFC 071 §6: only when the caller passed a catch-up obligation. What the
   * server needs to record the batch (`buildCatchupBatch`), except the
   * rendered rows, which the caller knows (it may append a folded wake).
   */
  obligationBatch?: Omit<CatchupBatchBuildInput, "batchId" | "launchId" | "builtAtMs" | "rendered"> & {
    /** The read cursor of EVERY owed conversation (RFC 6 "read cursor" settlement). */
    owedReadCursors: Record<string, number>;
  };
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
  historyCutoff: Date | undefined,
  opts: {
    chain: channelService.AgentInboxChainRow[];
    /**
     * RFC 071 §6: the terminal-failure breaker's open catch-up obligation.
     * Only the breaker's claimed start passes it (never while
     * RUNTIME_OUTCOME_ACK_ENABLED is false); absent, nothing below changes.
     */
    obligation?: CatchupObligation | null;
  },
): Promise<AgentResumeCatchupResult> {
  if (await agentService.isRaftBenchServiceAgent(agentId)) {
    return { messages: [], sources: [], conversations: [], candidateChannelCount: 0, maxSeq: null };
  }
  const deps = resolveMessageServiceDeps();
  const db = getDb();

  // Walk in priority order. The chain holds only offered rows, deliverable
  // threads included, so every row is a candidate. The page is wider than the
  // channel cap because a candidate can yield no rows once the per-row filters
  // apply (its unread predates the agent's join, or is its own), and such a
  // channel must not take the slot of one that has something to deliver.
  const ordered = resumeCatchupCandidatesFromChain(opts.chain).sort(compareResumeCatchupCandidates);
  const obligation = opts.obligation ?? null;
  if (!obligation) {
    return (await buildResumeCatchupBatch(deps, db, agentId, historyCutoff, ordered.slice(0, RESUME_CATCHUP_MAX_CANDIDATES))).result;
  }

  // RFC 071 §6 "no starvation": the lower bound max(read cursor, obligation
  // cursor) is applied BEFORE the cut, owed conversations go first (oldest
  // owed first), and the rest keep today's order.
  const byConversation = new Map(ordered.map((candidate) => [candidate.channelId, candidate]));
  const selection = selectObligationCatchupCandidates(
    obligation,
    ordered.map((candidate) => ({
      conversationId: candidate.channelId,
      lastReadSeq: candidate.lastReadSeq,
      firstUnreadSeq: candidate.firstUnreadSeq,
      latestUnreadSeq: candidate.latestUnreadSeq,
    })),
    Math.min(RESUME_CATCHUP_MAX_CANDIDATES, TERMINAL_FAILURE_CATCHUP_MAX_CANDIDATES),
  );
  const candidates = selection.candidates.map((selected) => ({
    ...byConversation.get(selected.conversationId)!,
    lowerBoundSeq: selected.lowerBoundSeq,
  }));
  const { result, batchConversations } = await buildResumeCatchupBatch(deps, db, agentId, historyCutoff, candidates);

  // Every owed conversation's read cursor: one the cursor has passed is
  // settled when the batch is recorded (RFC 6 "read cursor"). From the chain
  // when it lists the conversation, else the durable cursor row.
  const owedReadCursors: Record<string, number> = {};
  const missing = Object.keys(obligation.owedCeilings).filter((id) => {
    const fromChain = byConversation.get(id)?.lastReadSeq;
    if (fromChain !== undefined) owedReadCursors[id] = fromChain;
    return fromChain === undefined;
  });
  if (missing.length > 0) {
    const durable = new Map((await channelService.getAgentLegacyReadCursors(agentId)).map((row) => [row.channelId, row.lastReadSeq]));
    for (const conversationId of missing) {
      owedReadCursors[conversationId] = durable.get(conversationId) ?? 0;
    }
  }
  const unreadLatestSeqs: Record<string, number> = {};
  for (const candidate of ordered) unreadLatestSeqs[candidate.channelId] = candidate.latestUnreadSeq;
  return {
    ...result,
    obligationBatch: {
      conversations: batchConversations,
      owedReadCursors,
      candidateCapHit: selection.candidateCapHit,
      unreadLatestSeqs,
    },
  };
}

/**
 * Candidate channels from the unified chain. The chain already applies the
 * offer rules (joined, offered unread, thread deliverability), the
 * self / causal-actor / noise-subtype exclusions and resolves joint storage, so
 * this only maps rows. Rows are still fetched from Postgres by
 * buildResumeCatchupBatch with the per-row self and mute filters, from the
 * candidate's storage channel (resolveResumeCatchupTarget).
 */
function resumeCatchupCandidatesFromChain(chain: channelService.AgentInboxChainRow[]): ResumeCatchupCandidate[] {
  const candidates: ResumeCatchupCandidate[] = [];
  for (const row of chain) {
    const latestPiercingSeq = row.kind === "dm"
      ? row.latestSeq
      : row.mentionUnread > 0 ? row.maxMentionSeq : null;
    const candidate: ResumeCatchupCandidate = {
      channelId: row.targetId,
      channelName: row.channelName,
      channelType: row.channelType,
      serverId: row.serverId,
      parentMessageId: row.parentMessageId,
      addedAt: row.joinedAt,
      lastReadSeq: row.lastReadSeq,
      firstUnreadSeq: row.firstUnreadSeq ?? row.lastReadSeq + 1,
      latestUnreadSeq: row.latestSeq ?? row.maxMentionSeq ?? row.lastReadSeq + 1,
      latestPiercingSeq,
    };
    candidates.push(candidate);
  }
  return candidates;
}

type ResumeCatchupParentFields = AgentThreadParentFields;

/**
 * Where a candidate's messages are stored, and the parent labels the agent sees.
 * The candidate is always the agent-facing conversation: the read cursor, the
 * membership or follow, and mute are all keyed by it, for humans and agents alike.
 * A joint (cross-server) channel or thread stores its messages once, under the
 * canonical channel, and each server sees them through its local projection; so
 * rows are read from storage and labelled with the local projection, exactly as
 * live delivery labels them (broadcastAndDeliver / handleJointThreadPostBroadcastSideEffects).
 * A joint thread's local projection has no parent_message_id, so its parent is
 * the projection's local parent channel, not a lookup of the parent message.
 */
async function resolveResumeCatchupTarget(
  deps: MessageServiceDeps,
  db: ReturnType<typeof getDb>,
  candidate: Pick<ResumeCatchupCandidate, "channelId" | "channelType" | "serverId" | "parentMessageId">,
): Promise<{ storageChannelId: string; parentFields: ResumeCatchupParentFields }> {
  if (candidate.channelType === "joint") {
    return { storageChannelId: await channelService.getMessageStorageChannelIdWithExecutor(db, candidate.channelId), parentFields: {} };
  }
  if (!isSubConversationType(candidate.channelType)) return { storageChannelId: candidate.channelId, parentFields: {} };

  let parentChannel: Awaited<ReturnType<MessageServiceDeps["getChannel"]>> | null = null;
  let storageChannelId = candidate.channelId;
  const jointThread = await channelService.getJointThreadProjectionByLocalThread(candidate.channelId, candidate.serverId, db);
  if (jointThread) {
    storageChannelId = jointThread.canonicalThreadChannelId;
    parentChannel = await deps.getChannel(jointThread.localParentChannelId);
  } else if (candidate.channelType === "task") {
    // Task conversation (task v2): the row carries its parent channel.
    const conversation = await deps.getChannel(candidate.channelId);
    parentChannel = conversation?.parentChannelId ? await deps.getChannel(conversation.parentChannelId) : null;
  } else if (candidate.parentMessageId) {
    const [parentMessage] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, candidate.parentMessageId))
      .limit(1);
    parentChannel = parentMessage ? await deps.getChannel(parentMessage.channelId) : null;
  }
  if (!parentChannel || isSubConversationType(parentChannel.type)) return { storageChannelId, parentFields: {} };
  const parentChannelType = toAgentVisibleChannelType(parentChannel.type);
  // Task v2: a task conversation (either face) is addressed by its task ref.
  const taskConversationNumber = candidate.channelType === "task"
    ? await taskConversationNumberForChannel(await deps.getChannel(candidate.channelId))
    : null;
  return {
    storageChannelId,
    parentFields: {
      parent_channel_name: parentChannel.name,
      parent_channel_id: parentChannel.id,
      parent_channel_type: parentChannelType === "thread" ? "channel" : parentChannelType,
      ...(taskConversationNumber && { task_conversation_number: taskConversationNumber }),
    },
  };
}

export type AgentConversationIdentity = Pick<
  AgentMessage,
  "channel_id" | "channel_type" | "channel_name" | "parent_channel_name" | "parent_channel_id" | "parent_channel_type" | "task_conversation_number"
>;

/**
 * The conversation identity (`channel_type`, `channel_name`, and for threads
 * the `parent_channel_*` fields) that this agent sees for one agent-facing
 * conversation, labelled exactly as resume catch-up labels its rows: DM peers
 * resolved for this agent, joint channels and joint threads by the local
 * projection the agent's server sees. Resolve once per conversation and spread
 * it onto envelopes built from bare message rows (for example the held send
 * context), which otherwise carry no reply target and are dropped by clients.
 */
export async function resolveAgentConversationIdentity(
  serverId: string,
  agentId: string,
  channelId: string,
): Promise<AgentConversationIdentity | null> {
  const deps = resolveMessageServiceDeps();
  const channel = await deps.getChannel(channelId);
  if (!channel) return null;
  const { parentFields } = await resolveResumeCatchupTarget(deps, getDb(), {
    channelId: channel.id,
    channelType: channel.type,
    serverId,
    parentMessageId: channel.parentMessageId ?? null,
  });
  const names = await resolveRecipientDeliveryNames(serverId, agentId, channel, parentFields);
  return {
    channel_id: channel.id,
    channel_type: toAgentVisibleChannelType(channel.type),
    ...parentFields,
    ...names,
  };
}

/**
 * For an activity-muted conversation, the SQL form of the per-row mute filter in
 * buildResumeCatchupBatch (getMutedAgentDeliveryIdsForPersistedMessage): a row is
 * deliverable when it predates the mute (seq < mute_from_seq), was promoted for the
 * agent (an inbox notification fact), personally @mentions the agent (a notifiable
 * mention), or assigns the agent a task. Applying it in the fetch makes the
 * per-conversation LIMIT count only deliverable rows; otherwise a muted
 * conversation with more than LIMIT muted rows ahead of a piercing mention would
 * never reach the mention, and since dropped rows are never acked, never advance.
 * Returns null when the conversation is not muted for the agent. Threads are never
 * muted: a followed thread is independent of its parent channel's mute. The mute
 * state is keyed by the agent-facing conversation (a joint channel's local
 * projection), exactly as the per-row filter keys it.
 */
async function resumeCatchupMuteRowCondition(
  db: ReturnType<typeof getDb>,
  agentId: string,
  candidate: Pick<ResumeCatchupCandidate, "channelId" | "channelType" | "serverId">,
): Promise<SQL | null> {
  if (isSubConversationType(candidate.channelType)) return null;
  const [mute] = await db
    .select({ muteFromSeq: inboxTargetMuteStates.muteFromSeq })
    .from(inboxTargetMuteStates)
    .where(and(
      eq(inboxTargetMuteStates.receiverType, "agent"),
      eq(inboxTargetMuteStates.receiverId, agentId),
      eq(inboxTargetMuteStates.serverId, candidate.serverId),
      eq(inboxTargetMuteStates.sourceChannelId, candidate.channelId),
      eq(inboxTargetMuteStates.activityMuted, true),
      isNotNull(inboxTargetMuteStates.muteFromSeq),
    ))
    .limit(1);
  if (!mute || mute.muteFromSeq == null) return null;
  return sql`(
    ${messages.seq} < ${mute.muteFromSeq}
    OR (${messages.senderType} <> 'external_projection'
        AND ${messages.taskAssigneeType} = 'agent' AND ${messages.taskAssigneeId} = ${agentId})
    OR EXISTS (
      SELECT 1 FROM ${messageMentions}
      WHERE ${messageMentions.messageId} = ${messages.id}
        AND ${messageMentions.targetType} = 'agent' AND ${messageMentions.targetId} = ${agentId}
        AND (${messageMentions.notifiableAtSend} OR ${messageMentions.notifiedAt} IS NOT NULL)
    )
    OR EXISTS (
      SELECT 1 FROM ${inboxNotificationFacts}
      WHERE ${inboxNotificationFacts.messageId} = ${messages.id}
        AND ${inboxNotificationFacts.receiverType} = 'agent' AND ${inboxNotificationFacts.receiverId} = ${agentId}
    )
  )`;
}

async function buildResumeCatchupBatch(
  deps: MessageServiceDeps,
  db: ReturnType<typeof getDb>,
  agentId: string,
  historyCutoff: Date | undefined,
  candidates: ResumeCatchupCandidate[],
  limits: { maxRowsTotal: number; maxChannels: number } = { maxRowsTotal: RESUME_CATCHUP_MAX_ROWS_TOTAL, maxChannels: RESUME_CATCHUP_MAX_CHANNELS },
): Promise<{ result: AgentResumeCatchupResult; batchConversations: CatchupBatchBuildInput["conversations"] }> {
  const output: AgentMessage[] = [];
  const sources: AgentResumeCatchupSource[] = [];
  const conversations: AgentResumeCatchupResult["conversations"] = [];
  // RFC 071 §6: per conversation read, what the batch record's coverage needs.
  const batchConversations: CatchupBatchBuildInput["conversations"] = [];
  let maxSeq: number | null = null;
  let contributingChannels = 0;
  for (const candidate of candidates) {
    if (output.length >= limits.maxRowsTotal) break;
    if (contributingChannels >= limits.maxChannels) break;
    const outputBefore = output.length;
    const onlySeqs = candidate.onlySeqs;
    // Late rows sit at or below the read position: no lower bound for them.
    const lowerBoundSeq = onlySeqs ? 0 : candidate.lowerBoundSeq ?? candidate.lastReadSeq;

    const { storageChannelId, parentFields } = await resolveResumeCatchupTarget(deps, db, candidate);

    const recipientNames = await resolveRecipientDeliveryNames(candidate.serverId, agentId,
      { id: candidate.channelId, name: candidate.channelName, type: candidate.channelType }, parentFields);

    const rowConditions = [
      eq(messages.channelId, storageChannelId),
      onlySeqs ? inArray(messages.seq, onlySeqs) : gt(messages.seq, lowerBoundSeq),
      // The chain's unread rule, so a pull returns exactly what the chain counts.
      messageUnreadEligibleForReceiverSql({ type: "agent", id: agentId }),
    ];
    if (historyCutoff) {
      rowConditions.push(gt(messages.createdAt, historyCutoff));
    }
    const deliverableUnderMute = await resumeCatchupMuteRowCondition(db, agentId, candidate);
    if (deliverableUnderMute) rowConditions.push(deliverableUnderMute);
    // Contiguous, oldest first from the read position: an ack advances the
    // read position to the highest seq acked in the conversation, so returning
    // anything but the oldest unread rows would mark the older ones read unseen.
    const rowLimit = Math.min(onlySeqs ? onlySeqs.length : RESUME_CATCHUP_MAX_ROWS_PER_CHANNEL, limits.maxRowsTotal - output.length);
    const eligibleRows = await db
      .select()
      .from(messages)
      .where(and(...rowConditions))
      .orderBy(asc(messages.seq))
      .limit(rowLimit + 1);
    const conversation = { channelId: candidate.channelId, truncated: eligibleRows.length > rowLimit };
    conversations.push(conversation);
    // Every deliverable seq above the lower bound, ascending: rows the per-row
    // filters drop are not deliverable by rule and are left out; rows never
    // evaluated (the total cap) are kept, so they end the covered prefix.
    const fetchedSeqs: number[] = [];
    const rows = await enrichWithSenderNames(eligibleRows.slice(0, rowLimit), { includeSenderTimezone: true });
    // The same `mentioned` flag live delivery sets: the agent was @-mentioned in
    // the message (a notifiable mention row), so a recovered message reads the
    // same as the live one would have.
    const mentionedMessageIds = rows.length === 0 ? new Set<string>() : new Set((await db
      .select({ messageId: messageMentions.messageId })
      .from(messageMentions)
      .where(and(
        inArray(messageMentions.messageId, rows.map((row) => row.id)),
        eq(messageMentions.targetType, "agent"),
        eq(messageMentions.targetId, agentId),
        or(eq(messageMentions.notifiableAtSend, true), isNotNull(messageMentions.notifiedAt)),
      ))).map((mention) => mention.messageId));

    for (const [index, row] of rows.entries()) {
      if (output.length >= limits.maxRowsTotal) {
        conversation.truncated = true;
        for (const unevaluated of rows.slice(index)) {
          if (typeof unevaluated.seq === "number" && unevaluated.seq > lowerBoundSeq) fetchedSeqs.push(unevaluated.seq);
        }
        break;
      }
      if (typeof row.seq !== "number" || row.seq <= lowerBoundSeq) continue;
      if (!isMessageUnreadEligibleForReceiver(row, { type: "agent", id: agentId }, {
        personallyMentioned: mentionedMessageIds.has(row.id),
      })) continue;
      const piercedAgentIds = new Set<string>();
      if (row.senderType !== "external_projection" && row.taskAssigneeType === "agent" && row.taskAssigneeId === agentId) {
        piercedAgentIds.add(agentId);
      }
      // A personal @mention pierces a mute, as it does for live delivery (its
      // personal attention targets) and for the inbox view the candidate came from.
      if (mentionedMessageIds.has(row.id)) piercedAgentIds.add(agentId);
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
        channel_type: toAgentVisibleChannelType(candidate.channelType),
        sender_id: row.senderId,
        sender_name: identity.uniqueName,
        sender_description: identity.description,
        sender_timezone: row.senderTimezone ?? null,
        ...(await agentDelegatedByField(row as { delegatedByAgentId?: string | null })),
        // RFC 082: a card message reads `card=r<revision>` in the header; its content is the fallback.
        ...agentMessageCardField((row as { actionMetadata?: unknown }).actionMetadata),
        sender_type: toAgentVisibleSenderType(row.senderType, row.messageType),
        ...toAgentVisibleExternalMessage(row),
        ...(row.senderType === "external_projection"
          ? { mentioned: isSlackBridgedExternalMessage(row) && mentionedMessageIds.has(row.id) }
          : (mentionedMessageIds.has(row.id) || piercedAgentIds.has(agentId)) && { mentioned: true }),
        content: renderAgentVisibleMessageContent(row, renderedContent),
        timestamp: row.createdAt.toISOString(),
        seq: row.seq,
        message_id: row.id,
        ...parentFields,
        ...recipientNames,
        ...(row.attachments.length > 0 && {
          attachments: row.attachments.map((a) => ({
            id: a.id,
            filename: normalizeAttachmentFilename(a.filename),
            mimeType: resolveAttachmentMimeType(a.filename, a.mimeType),
            sizeBytes: a.sizeBytes ?? undefined,
          })),
        }),
        ...(row.senderType !== "external_projection" && row.taskStatus != null && {
          task_status: row.taskStatus as "backlog" | "todo" | "in_progress" | "in_review" | "done" | "closed",
          task_number: row.taskNumber,
          task_assignee_type: toAgentVisibleTaskAssigneeType(row.taskAssigneeType as InternalActorType | null),
          task_assignee_id: row.taskAssigneeId,
          task_assignee_name: getAgentVisibleTaskAssigneeName(row),
        }),
      });
      sources.push({
        serverId: candidate.serverId,
        senderType: row.senderType as StoredMessageSenderType,
        senderId: row.senderId,
        system: isSystemMessageIdentity(row.messageType, row.senderId),
      });
      fetchedSeqs.push(row.seq);
      maxSeq = maxSeq == null ? row.seq : Math.max(maxSeq, row.seq);
    }
    batchConversations.push({
      conversationId: candidate.channelId,
      fromSeqExclusive: lowerBoundSeq,
      latestSeq: candidate.latestUnreadSeq,
      truncated: conversation.truncated,
      fetchedSeqs,
    });
    if (output.length > outputBefore) contributingChannels += 1;
  }

  return {
    result: {
      messages: output,
      sources,
      conversations,
      candidateChannelCount: contributingChannels,
      maxSeq,
    },
    batchConversations,
  };
}

export type ExternalAgentInboxPullRoute =
  | "events"
  | "wake_hints"
  | "wake_hints_stream_open"
  | "wake_hints_stream_flush"
  | "push";

/**
 * Who shares a pull's rate limit: `/events` (an explicit drain, never
 * throttled), the wake-hints poll, and the wake-hints streams. The inbox push
 * does not use a slot (see pullExternalAgentInboxUnshared).
 */
export type ExternalAgentInboxPullSlot = "events" | "wake_hints" | "stream";

export type ExternalAgentInboxPull =
  | {
    status: "pulled";
    /** Persisted messages to hand the agent, seq ascending (oldest first within each conversation). */
    messages: AgentMessage[];
    /** Rows read but not deliverable (passive scope revoked, target no longer accessible). */
    droppedSeqs: number[];
    /** Conversations that still have unread after these messages are acked. */
    remainingConversations: number;
    /**
     * The pull left unread behind: a conversation was cut at the per-conversation
     * row cap, or the total-row / conversation / candidate cap stopped the walk.
     * A caller paging with `has_more` must page again.
     */
    truncated: boolean;
    /**
     * This pull's snapshot and late rows (agentInboxLateRows.ts); null when
     * the snapshot could not be read. Acknowledging the batch records the
     * ranges its ack passed under `snapshot`, and `handed` (late rows the batch
     * carries, handed over or dropped) in their skip records.
     */
    late: {
      snapshot: AgentInboxPullSnapshot;
      handed: AgentInboxLateHanded[];
    } | null;
  }
  | { status: "unavailable" };

/** Minimum time between two chain reads for the same agent and slot (except forced ones). */
export const EXTERNAL_AGENT_INBOX_PULL_MIN_INTERVAL_MS = 2_000;
let externalInboxPullMinIntervalMsForTests: number | null = null;

/** Test seam: override the pull rate limit (null restores the default). */
export function __setExternalAgentInboxPullMinIntervalMsForTests(ms: number | null): void {
  externalInboxPullMinIntervalMsForTests = ms;
}

/**
 * RisingWave derives the agent inbox chain from Postgres and trails it by about
 * a second. A wake signal fires right after the send, so the pull it forces
 * usually runs before the new message is in the chain and finds nothing. Wake
 * streams therefore pull again at these delays after a signal, instead of
 * leaving the message to the next heartbeat (25s by default).
 */
export const EXTERNAL_WAKE_FOLLOW_UP_PULL_DELAYS_MS: readonly number[] = [1_500, 5_000];
let externalWakeFollowUpPullDelaysMsForTests: readonly number[] | null = null;

/** Test seam: override the follow-up pull delays (null restores the default). */
export function __setExternalWakeFollowUpPullDelaysMsForTests(delays: readonly number[] | null): void {
  externalWakeFollowUpPullDelaysMsForTests = delays;
}

export function externalWakeFollowUpPullDelaysMs(): readonly number[] {
  return externalWakeFollowUpPullDelaysMsForTests ?? EXTERNAL_WAKE_FOLLOW_UP_PULL_DELAYS_MS;
}

let externalInboxAfterRowsReadHookForTests: ((agentId: string) => Promise<void>) | null = null;

/** Test seam: runs right after a pull read its rows above the read position (null removes it). */
export function __setExternalAgentInboxAfterRowsReadHookForTests(hook: ((agentId: string) => Promise<void>) | null): void {
  externalInboxAfterRowsReadHookForTests = hook;
}

type AgentInboxChainSelector = (agentId: string) => Promise<channelService.AgentInboxChainSelection>;
let externalInboxChainSelectorForTests: AgentInboxChainSelector | null = null;

/** Test seam: CI has no RisingWave, so tests supply the chain read. */
export function __setExternalAgentInboxChainSelectorForTests(selector: AgentInboxChainSelector | null): void {
  externalInboxChainSelectorForTests = selector;
}

type ExternalInboxPullSlotState = {
  lastStartedAtMs: number | null;
  last: ExternalAgentInboxPull | null;
  running: Promise<ExternalAgentInboxPull> | null;
  rerun: Promise<ExternalAgentInboxPull> | null;
};

// Rate-limit bookkeeping only, keyed by the orchestrator (one per process).
// No message state lives here: every result is re-derived from the chain.
const externalInboxPullSlots = new WeakMap<AgentOrchestrator, Map<string, ExternalInboxPullSlotState>>();

/**
 * An EXTERNAL agent's persisted messages come from one place: its durable
 * inbox (the agent inbox chain). For an external agent delivery, ack and read
 * are the same act, so what is unread is exactly what it has not yet received;
 * the server keeps no per-process copy of persisted messages (only items with
 * no durable row, such as third-party app events, are buffered). Each call
 * pulls the same bounded batch managed resume uses (getAgentResumeCatchupMessages):
 * conversations by priority, rows contiguous and oldest first from the read
 * position, so acking a batch never skips an unread row.
 *
 * Calls sharing a slot are serialized per agent; outside `/events` a slot reads
 * the chain at most once per EXTERNAL_AGENT_INBOX_PULL_MIN_INTERVAL_MS and
 * otherwise answers with its previous result. `force` (a wake signal: something
 * was just delivered) skips the interval and, if a read is in flight, queues
 * one more after it.
 */
export function pullExternalAgentInbox(
  agentOrchestrator: AgentOrchestrator,
  agentId: string,
  opts: { route: ExternalAgentInboxPullRoute; slot: ExternalAgentInboxPullSlot; force?: boolean },
): Promise<ExternalAgentInboxPull> {
  let slots = externalInboxPullSlots.get(agentOrchestrator);
  if (!slots) {
    slots = new Map();
    externalInboxPullSlots.set(agentOrchestrator, slots);
  }
  const key = `${agentId}:${opts.slot}`;
  let slot = slots.get(key);
  if (!slot) {
    slot = { lastStartedAtMs: null, last: null, running: null, rerun: null };
    slots.set(key, slot);
  }
  const state = slot;
  const minIntervalMs = opts.slot === "events"
    ? 0
    : externalInboxPullMinIntervalMsForTests ?? EXTERNAL_AGENT_INBOX_PULL_MIN_INTERVAL_MS;
  const start = (): Promise<ExternalAgentInboxPull> => {
    state.lastStartedAtMs = currentTimeMs();
    const run = pullExternalAgentInboxOnce(agentOrchestrator, agentId, opts.route)
      .then((result) => {
        state.last = result;
        return result;
      })
      .finally(() => {
        if (state.running === run) state.running = null;
      });
    state.running = run;
    return run;
  };
  if (state.running) {
    if (!opts.force) return state.running;
    state.rerun ??= state.running.catch(() => undefined).then(() => {
      state.rerun = null;
      return start();
    });
    return state.rerun;
  }
  if (
    !opts.force
    && state.last
    && state.lastStartedAtMs !== null
    && currentTimeMs() - state.lastStartedAtMs < minIntervalMs
  ) {
    return Promise.resolve(state.last);
  }
  return start();
}

/**
 * One chain read for the inbox push, outside the slot bookkeeping: the push's
 * per-agent lease already serializes it, and a slot would hand a later call
 * the same in-flight promise, so a stalled read would stall every retry on
 * this replica too.
 */
export function pullExternalAgentInboxUnshared(
  agentOrchestrator: AgentOrchestrator,
  agentId: string,
): Promise<ExternalAgentInboxPull> {
  return pullExternalAgentInboxOnce(agentOrchestrator, agentId, "push");
}

async function pullExternalAgentInboxOnce(
  agentOrchestrator: AgentOrchestrator,
  agentId: string,
  route: ExternalAgentInboxPullRoute,
): Promise<ExternalAgentInboxPull> {
  const startedAt = currentTimeMs();
  const stats: ExternalAgentInboxPullStats = {
    messageCount: 0, droppedCount: 0, truncatedConversationCount: 0, remainingConversationCount: 0,
    lastReadSeq: null, chainLatestSeq: null, conversationIds: null,
  };
  try {
    const agent = await agentService.getAgent(agentId);
    if (!agent) return { status: "unavailable" };
    // Before any row is read: a row this pull cannot see (its transaction still
    // in flight) is invisible in this snapshot, so once the ack moves the read
    // position past it, a later pull finds it (agentInboxLateRows.ts).
    const snapshot = await readAgentInboxPullSnapshot().catch((err) => {
      console.error("external agent inbox pull: snapshot read failed:", serializeErrorForLog(err));
      return null;
    });
    const selectChain = externalInboxChainSelectorForTests ?? channelService.selectAgentInboxChainRows;
    const inbox = await selectChain(agentId);
    if (inbox.source === "unavailable") {
      // No fallback: persisted messages wait for the chain; buffered items are unaffected.
      emitExternalAgentInboxPullTrace(route, "inbox_unavailable", startedAt, stats);
      return { status: "unavailable" };
    }
    // What the chain showed, before durable read positions: a chain_latest_seq
    // below a delivered message's seq means the chain had not caught up yet.
    for (const row of inbox.rows) {
      stats.lastReadSeq = Math.max(stats.lastReadSeq ?? 0, row.lastReadSeq);
      if (row.latestSeq !== null) stats.chainLatestSeq = Math.max(stats.chainLatestSeq ?? 0, row.latestSeq);
    }
    const chain = await channelService.withDurableAgentReadPositions(agentId, inbox.rows);
    const historyCutoff = getHistoryCutoff(await getServerPlan(agent.serverId));
    const catchup = await getAgentResumeCatchupMessages(agentId, historyCutoff, { chain });
    await externalInboxAfterRowsReadHookForTests?.(agentId);
    const late = snapshot ? await pullAgentInboxLateRows(agentId, historyCutoff) : null;
    const lateSeqs = new Set<number>();
    if (late) {
      // A row the read position passed between the two reads is not late twice.
      const pulledSeqs = new Set(catchup.messages.map((message) => message.seq));
      late.catchup.messages.forEach((message, index) => {
        if (typeof message.seq !== "number" || pulledSeqs.has(message.seq)) return;
        lateSeqs.add(message.seq);
        catchup.messages.push(message);
        catchup.sources.push(late.catchup.sources[index]!);
      });
    }

    // The gates live delivery applies (passive scope unless the sender has
    // admin authority, target access), evaluated at pull time.
    const deps = resolveMessageServiceDeps();
    const deliveryOptionsBySender = new Map<string, DeliverMessageOptions>();
    const items: Array<{ message: AgentMessage; options: DeliverMessageOptions }> = [];
    for (const [index, message] of catchup.messages.entries()) {
      const source = catchup.sources[index]!;
      const senderKey = `${source.senderType}:${source.senderId}`;
      let options = deliveryOptionsBySender.get(senderKey);
      if (!options) {
        options = source.system || source.senderType === "external_projection"
          ? {}
          : await getAgentDeliveryOptionsForSender(deps, source.serverId, source.senderType, source.senderId);
        deliveryOptionsBySender.set(senderKey, options);
      }
      items.push({ message, options });
    }
    const deliverable = await agentOrchestrator.filterExternalInboxDeliveries(agentId, items);
    const messages: AgentMessage[] = [];
    const droppedSeqs: number[] = [];
    items.forEach(({ message }, index) => {
      if (deliverable[index]) messages.push(message);
      else if (typeof message.seq === "number") droppedSeqs.push(message.seq);
    });
    messages.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    const covered = new Set(catchup.conversations.filter((c) => !c.truncated).map((c) => c.channelId));
    const unread = chain.map((row) => row.targetId);
    stats.messageCount = messages.length;
    stats.droppedCount = droppedSeqs.length;
    stats.truncatedConversationCount = catchup.conversations.filter((c) => c.truncated).length;
    stats.remainingConversationCount = unread.filter((id) => !covered.has(id)).length;
    // Every conversation this pull read: the chain's, plus any whose late rows were handed over.
    stats.conversationIds = [...new Set([
      ...catchup.conversations.map((c) => c.channelId),
      ...(late?.scan.rows ?? []).filter((row) => lateSeqs.has(row.seq)).map((row) => row.conversationId),
    ])];
    emitExternalAgentInboxPullTrace(route, messages.length > 0 || stats.remainingConversationCount > 0 ? "pulled" : "nothing_unread", startedAt, stats);
    if (late) {
      const droppedLate = droppedSeqs.filter((seq) => lateSeqs.has(seq)).length;
      emitAgentInboxLateRowsTrace(route, late.scan, lateSeqs.size - droppedLate, droppedLate);
    }
    return {
      status: "pulled",
      messages,
      droppedSeqs,
      remainingConversations: stats.remainingConversationCount,
      truncated: stats.truncatedConversationCount > 0 || stats.remainingConversationCount > 0 || late?.scan.paged === true,
      late: snapshot
        ? { snapshot, handed: (late?.scan.rows ?? []).filter((row) => lateSeqs.has(row.seq)).map(({ recordId, conversationId, seq }) => ({ recordId, conversationId, seq })) }
        : null,
    };
  } catch (err) {
    emitExternalAgentInboxPullTrace(route, "failed", startedAt, stats);
    throw err;
  }
}

/**
 * This pull's late rows (agentInboxLateRows.ts), rendered like the rows above
 * the read position. A failed scan yields none and commits nothing: the rows
 * stay late and the next pull scans again.
 */
async function pullAgentInboxLateRows(
  agentId: string,
  historyCutoff: Date | undefined,
): Promise<{ scan: Awaited<ReturnType<typeof scanAgentInboxLateRows>>; catchup: Pick<AgentResumeCatchupResult, "messages" | "sources"> } | null> {
  try {
    const scan = await scanAgentInboxLateRows(agentId);
    if (scan.rows.length === 0) return { scan, catchup: { messages: [], sources: [] } };
    const seqsByConversation = new Map<string, number[]>();
    for (const row of scan.rows) {
      const list = seqsByConversation.get(row.conversationId) ?? [];
      list.push(row.seq);
      seqsByConversation.set(row.conversationId, list);
    }
    const db = getDb();
    const conversationRows = await db
      .select({ id: channels.id, name: channels.name, type: channels.type, serverId: channels.serverId, parentMessageId: channels.parentMessageId, createdAt: channels.createdAt })
      .from(channels)
      .where(inArray(channels.id, [...seqsByConversation.keys()]));
    const candidates: ResumeCatchupCandidate[] = conversationRows.map((row) => {
      const onlySeqs = seqsByConversation.get(row.id)!;
      return {
        channelId: row.id,
        channelName: row.name,
        channelType: row.type,
        serverId: row.serverId,
        parentMessageId: row.parentMessageId ?? null,
        addedAt: row.createdAt,
        // Unused with onlySeqs (no lower bound); the rows sit at or below the read position.
        lastReadSeq: Math.max(...onlySeqs),
        firstUnreadSeq: Math.min(...onlySeqs),
        latestUnreadSeq: Math.max(...onlySeqs),
        latestPiercingSeq: null,
        onlySeqs,
      };
    });
    const { result } = await buildResumeCatchupBatch(resolveMessageServiceDeps(), db, agentId, historyCutoff, candidates, {
      maxRowsTotal: scan.rows.length,
      maxChannels: candidates.length,
    });
    return { scan, catchup: { messages: result.messages, sources: result.sources } };
  } catch (err) {
    console.error("external agent inbox pull: late-row scan failed:", serializeErrorForLog(err));
    return null;
  }
}

interface ExternalAgentInboxPullStats {
  messageCount: number;
  droppedCount: number;
  truncatedConversationCount: number;
  remainingConversationCount: number;
  /** Max read seq across the chain's rows (null: no rows). */
  lastReadSeq: number | null;
  /** Max latest seq across the chain's rows (null: no rows). */
  chainLatestSeq: number | null;
  /**
   * Conversations this pull read (null until the read happened, so unavailable/failed
   * pulls don't claim zero); traced as a count, plus a keyed hash when there is exactly one.
   */
  conversationIds: string[] | null;
}

/**
 * One aggregate event per chain read, with no raw ids: when the pull read exactly
 * one conversation it carries that conversation's keyed hash (traceIdentity.ts),
 * so a pull can be matched to the conversation it served (#proj-o11y:#29).
 * Rate-limited calls emit nothing.
 */
function emitExternalAgentInboxPullTrace(
  route: ExternalAgentInboxPullRoute,
  outcome: "pulled" | "nothing_unread" | "inbox_unavailable" | "failed",
  startedAt: number,
  stats: ExternalAgentInboxPullStats,
): void {
  const conversationIdHash = stats.conversationIds?.length === 1
    ? traceIdentityHash("conversation_id_hash", stats.conversationIds[0])
    : null;
  addTraceEvent("external_agent.inbox_pull.finished", {
    route,
    outcome,
    duration_ms: currentTimeMs() - startedAt,
    message_count: stats.messageCount,
    dropped_count: stats.droppedCount,
    truncated_conversation_count: stats.truncatedConversationCount,
    remaining_conversation_count: stats.remainingConversationCount,
    last_read_seq: stats.lastReadSeq,
    chain_latest_seq: stats.chainLatestSeq,
    ...(stats.conversationIds ? { conversation_count: stats.conversationIds.length } : {}),
    ...(conversationIdHash ? { conversation_id_hash: conversationIdHash } : {}),
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
  /** The reader's server: forwarded-bundle visibility and joint-thread
   *  comment back-links both resolve against it. */
  viewerServerId?: string | null;
  /**
   * Keep `senderTimezone` on enriched rows. Set only by agent-facing reads:
   * a human sender's browser zone is exposed to agents, never to other
   * humans' clients, so every other read drops the key.
   */
  includeSenderTimezone?: boolean;
  excludeSender?: {
    senderType: "user" | "agent";
    senderId: string;
  };
  executor?: DatabaseExecutor;
  resolvedReadChannelIds?: string[];
};

type MessageReactionSummary = {
  emoji: string;
  count: number;
  reactorIds: string[];
  reactorNames: string[];
};

// Columns for message-history reads. `searchText`/`searchVector` only feed the
// full-text index (the tsvector is ~1.4KB/row); no read surface serves them, and
// the realtime path already strips them. Leaving them out of the SELECT keeps
// them off the wire from Postgres and out of every HTTP message response.
const { searchText: _searchText, searchVector: _searchVector, ...messageReadColumns } = getTableColumns(messages);

async function loadMessageRows(
  limit: number,
  beforeSeq: number | undefined,
  afterSeq: number | undefined,
  historyCutoff: Date | undefined,
  opts: MessageQueryTraceOptions & { executor: DatabaseExecutor; resolvedReadChannelIds: string[] },
) {
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const conditions = [resolvedConversionReadChannelPredicate(messages.channelId, opts.resolvedReadChannelIds)];
  if (beforeSeq !== undefined) conditions.push(lt(messages.seq, beforeSeq));
  if (afterSeq !== undefined) conditions.push(gt(messages.seq, afterSeq));
  if (historyCutoff) conditions.push(gt(messages.createdAt, historyCutoff));
  if (opts.excludeSender) {
    conditions.push(not(and(
      eq(messages.senderType, opts.excludeSender.senderType),
      eq(messages.senderId, opts.excludeSender.senderId),
    )!));
  }
  const direction = afterSeq !== undefined ? "after" : beforeSeq !== undefined ? "before" : "latest";
  return traceQuery(
    "messages.channel.loaded_page",
    () => opts.executor
      .select(messageReadColumns)
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
}

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

/**
 * Drops the agent-only `senderTimezone` from a row bound for a human client.
 * The static type keeps the key (readers use `?? null`), like
 * `projectForwardDestinationMessage` keeps the task keys it strips.
 */
export function omitSenderTimezone<T extends Record<string, unknown>>(message: T): T {
  if (!("senderTimezone" in message)) return message;
  const { senderTimezone: _senderTimezone, ...projected } = message;
  return projected as unknown as T;
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
  } satisfies ForwardedBundleTargetSnapshot;
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

/** Forwarded-source checks in flight at once while enriching one page (agent viewers). */
const FORWARDED_SOURCE_CHECK_CONCURRENCY = 4;
/** Enrichment reads (senders, reactions, attachments, ...) in flight at once for one page. */
const ENRICHMENT_QUERY_CONCURRENCY = 3;

type ForwardedBundleViewer = Parameters<typeof viewerCanReadForwardedSource>[2];

function forwardedSourceKey(sourceTargetId: string, sourceServerId: string, viewer: ForwardedBundleViewer): string {
  return `${viewer.type}:${viewer.id}:${viewer.serverId}:${sourceServerId}:${sourceTargetId}`;
}

/**
 * viewerCanReadForwardedSource for one page of messages. For a human viewer
 * every forwarded source on the page is answered up front in a fixed number of
 * queries (one membership read, one filterUserAccessibleChannelIds). An agent
 * viewer's rule (canAgentAccessChannel per source channel) has no list form, so
 * its sources are checked once each, at most a few at a time.
 */
async function pageForwardedSourceCheck(
  actionMetadatas: readonly unknown[],
  viewer: ForwardedBundleViewer | null,
): Promise<typeof viewerCanReadForwardedSource> {
  const answers = new Map<string, Promise<boolean>>();
  if (viewer?.type === "user") {
    const targets = new Set<string>();
    const otherServer: Array<{ sourceTargetId: string; sourceServerId: string }> = [];
    for (const metadata of actionMetadatas) {
      if (!isRecord(metadata) || metadata.kind !== "forwarded-bundle" || !Array.isArray(metadata.forwardedItems)) continue;
      for (const item of metadata.forwardedItems) {
        if (!isRecord(item) || typeof item.sourceTargetId !== "string" || typeof item.sourceServerId !== "string") continue;
        if (item.sourceServerId === viewer.serverId) targets.add(item.sourceTargetId);
        else otherServer.push({ sourceTargetId: item.sourceTargetId, sourceServerId: item.sourceServerId });
      }
    }
    // Same rule as viewerCanReadForwardedSource: only sources in the viewer's
    // server, only for a member of it, then channel access.
    for (const source of otherServer) answers.set(forwardedSourceKey(source.sourceTargetId, source.sourceServerId, viewer), Promise.resolve(false));
    if (targets.size > 0) {
      const [membership] = await getDb()
        .select({ userId: serverMembers.userId })
        .from(serverMembers)
        .where(and(eq(serverMembers.serverId, viewer.serverId), eq(serverMembers.userId, viewer.id)))
        .limit(1);
      const accessible = membership
        ? await channelService.filterUserAccessibleChannelIds([...targets], viewer.id, viewer.serverId as ServerId)
        : new Set<string>();
      for (const target of targets) answers.set(forwardedSourceKey(target, viewer.serverId, viewer), Promise.resolve(accessible.has(target)));
    }
  }
  const limit = createConcurrencyLimiter(FORWARDED_SOURCE_CHECK_CONCURRENCY);
  return (sourceTargetId, sourceServerId, checkedViewer) => {
    const key = forwardedSourceKey(sourceTargetId, sourceServerId, checkedViewer);
    let answer = answers.get(key);
    if (!answer) {
      answer = limit(() => viewerCanReadForwardedSource(sourceTargetId, sourceServerId, checkedViewer));
      answers.set(key, answer);
    }
    return answer;
  };
}

/**
 * A forwarded item as seen by someone who can't read its source: every
 * pointer to the source and every source-naming field (the task's id, number
 * and title included) is dropped; only the scrubbed label remains.
 */
function withoutForwardedSourcePointers(
  rawItem: Record<string, unknown>,
  sourceTargetSnapshot: Record<string, unknown> | null,
): Record<string, unknown> {
  // The keys go, not just their values: a null still says a pointer was here
  // (Tenny, #proj-chat:#22). Readers treat a missing pointer as no pointer.
  const {
    sourceMessageId: _messageId,
    sourceServerId: _serverId,
    sourceTargetId: _targetId,
    sourceThreadId: _threadId,
    parentChannelId: _parentChannelId,
    sourceTaskId: _taskId,
    sourceTaskNumber: _taskNumber,
    sourceTaskTitle: _taskTitle,
    ...item
  } = rawItem;
  return {
    ...item,
    sourceTargetSnapshot: scrubbedSourceTargetSnapshot(sourceTargetSnapshot),
    provenanceState: "original_unavailable",
  };
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
      return withoutForwardedSourcePointers(rawItem, sourceTargetSnapshot);
    }

    if (await canReadSource(sourceTargetId, sourceServerId, viewer)) return rawItem;

    return withoutForwardedSourcePointers(rawItem, sourceTargetSnapshot);
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
      return withoutForwardedSourcePointers(rawItem, sourceTargetSnapshot);
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
    markRetractedDelegatedReceipt(content, viewerScopedActionMetadata),
    formatForwardedBundleForAgent(viewerScopedActionMetadata),
  );
}

/**
 * RFC 077: a receipt for a message an assistant sent as its owner reads as
 * retracted once the owner retracted it (`delegatedReceipt.deletedAt`), so the
 * assistant reading its DM never takes a retracted message as still out.
 */
function markRetractedDelegatedReceipt(content: string, actionMetadata: unknown): string {
  const metadata = actionMetadata && typeof actionMetadata === "object"
    ? actionMetadata as { delegatedReceipt?: { deletedAt?: unknown }; delegatedReceipts?: unknown }
    : undefined;
  // A forward receipt: each retracted line says where it was.
  if (Array.isArray(metadata?.delegatedReceipts)) {
    const marks = metadata.delegatedReceipts.flatMap((entry: { deletedAt?: unknown; conversationRef?: unknown }) =>
      entry && typeof entry.deletedAt === "string"
        ? [`[${typeof entry.conversationRef === "string" ? entry.conversationRef : "one destination"}: retracted by the owner at ${entry.deletedAt}]`]
        : []);
    return marks.length > 0 ? `${content}\n${marks.join("\n")}` : content;
  }
  const receipt = metadata?.delegatedReceipt;
  const deletedAt = receipt && typeof receipt.deletedAt === "string" ? receipt.deletedAt : null;
  return deletedAt ? `${content} [retracted by the owner at ${deletedAt}]` : content;
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
      serverId: opts.viewerServerId ?? "",
    };
  }
  if (opts.forwardedBundleViewerAgentId && opts.viewerServerId) {
    return {
      type: "agent",
      id: opts.forwardedBundleViewerAgentId,
      serverId: opts.viewerServerId,
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

  // Provider-side projections (Slack members) don't write `message_mentions`
  // rows — they live in `external_mention_facts` keyed to the same message.
  const externalRows = await traceQuery(
    "messages.external_mention_facts_by_messages",
    () => getDb()
      .select({
        messageId: externalMentionFacts.messageId,
        projectionId: externalMentionFacts.projectionId,
        handleAtSendTime: externalMentionFacts.handleAtSendTime,
      })
      .from(externalMentionFacts)
      .where(inArray(externalMentionFacts.messageId, messageIds)),
    () => ({ input_count: messageIds.length }),
  );
  for (const row of externalRows) {
    const facts = byMessage.get(row.messageId) ?? [];
    facts.push({ type: "external", id: row.projectionId, name: row.handleAtSendTime });
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

  // Provider-side projections (Slack members) don't write `message_mentions`
  // rows — they live in `external_mention_facts` keyed to the same message.
  // Load them too so refresh/read paths render the mention with the same
  // styled treatment as the initial send.
  const externalRows = await executor
    .select({
      messageId: externalMentionFacts.messageId,
      projectionId: externalMentionFacts.projectionId,
      handleAtSendTime: externalMentionFacts.handleAtSendTime,
    })
    .from(externalMentionFacts)
    .where(inArray(externalMentionFacts.messageId, messageIds));
  for (const row of externalRows) {
    const facts = byMessage.get(row.messageId) ?? [];
    facts.push({
      type: "external",
      id: row.projectionId,
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

/**
 * RFC 077 (task #6): for Activity/inbox rows, the assistant that sent each
 * row's latest message for its owner (the label the message list shows), by
 * primary key; rows whose latest message was not delegated get null. Also
 * whether that message, and a thread row's parent, is a retracted delegated
 * message, so the web never has to match the placeholder text.
 *
 * And the avatar of the latest message's sender (`senderAvatarUrl`, by the
 * chat message's rule: a person's only when Raft stores it). The client finds
 * faces in this server's members and agents, and a joint channel's people and
 * agents from the other server are in neither. Same rows,
 * same single query, so a page costs no extra round trip.
 */
export async function withLatestMessageFacts<T extends { kind: string }>(items: readonly T[]): Promise<Array<T & { latestDelegatedBy: DelegatedByLabel | null; latestRetracted: boolean; parentRetracted: boolean; senderAvatarUrl: string | null }>> {
  const latestIdOf = (item: T) => {
    const row = item as { kind: string; lastMessageId?: string; latestActivityMessageId?: string };
    return row.kind === "thread" ? row.latestActivityMessageId : row.lastMessageId;
  };
  const parentIdOf = (item: T) => (item.kind === "thread" ? (item as { parentMessageId?: string }).parentMessageId : undefined);
  const ids = [...new Set(items.flatMap((item) => [latestIdOf(item), parentIdOf(item)]).filter((id): id is string => typeof id === "string" && id.length === 36))];
  const delegatedAgents = alias(agents, "latest_delegated_agents");
  const senderUsers = alias(users, "latest_sender_users");
  const senderAgents = alias(agents, "latest_sender_agents");
  const rows = ids.length === 0 ? [] : await getDb()
    .select({
      id: messages.id,
      retractedAt: messages.deletedAt,
      delegatedAgentId: delegatedAgents.id,
      delegatedName: delegatedAgents.name,
      delegatedDisplayName: delegatedAgents.displayName,
      delegatedAvatarUrl: delegatedAgents.avatarUrl,
      delegatedDeletedAt: delegatedAgents.deletedAt,
      // The user's or agent's own avatar (a user's is kept below only when
      // Raft stores it); an external author's only while its mirrored
      // artifact is current (savedService).
      senderAvatarUrl: sql<string | null>`CASE
        WHEN ${messages.senderType} = 'user' THEN ${senderUsers.avatarUrl}
        WHEN ${messages.senderType} = 'agent' THEN ${senderAgents.avatarUrl}
        WHEN ${messages.senderType} = 'external_projection'
          AND ${externalProjectionAvatarArtifacts.state} = 'active'
          AND ${externalProjectionAvatarArtifacts.publicUrl} = ${externalMessageAuthorFacts.avatarUrl}
          AND ${externalProjectionAvatarArtifacts.sourceDigest} = ${externalMessageAuthorFacts.avatarDigest}
        THEN ${externalProjectionAvatarArtifacts.publicUrl}
        ELSE NULL
      END`,
      senderType: messages.senderType,
    })
    .from(messages)
    .leftJoin(delegatedAgents, eq(delegatedAgents.id, messages.delegatedByAgentId))
    // The sender as a uuid, so these are primary-key probes: `id::text =`
    // would scan both tables on every inbox load. System messages
    // (sender_id 'system') become NULL and match nothing.
    .leftJoin(senderUsers, and(
      sql`${messages.senderType} = 'user'`,
      sql`${senderUsers.id} = ${sqlUuidOrNull(sql`${messages.senderId}`)}`,
    ))
    .leftJoin(senderAgents, and(
      sql`${messages.senderType} = 'agent'`,
      sql`${senderAgents.id} = ${sqlUuidOrNull(sql`${messages.senderId}`)}`,
    ))
    .leftJoin(externalMessageAuthorFacts, and(
      sql`${messages.senderType} = 'external_projection'`,
      eq(externalMessageAuthorFacts.messageId, messages.id),
    ))
    .leftJoin(externalProjectionAvatarArtifacts, eq(externalProjectionAvatarArtifacts.id, externalMessageAuthorFacts.avatarArtifactId))
    .where(inArray(messages.id, ids));
  const delegated = rows.filter((row) => row.delegatedAgentId !== null);
  const byMessage = new Map(delegated.map((row) => [row.id, {
    id: row.delegatedAgentId!, name: row.delegatedName!, displayName: row.delegatedDisplayName || row.delegatedName!, avatarUrl: row.delegatedAvatarUrl ?? null, deleted: row.delegatedDeletedAt !== null,
  } satisfies DelegatedByLabel]));
  // A retracted delegated message: the web shows its own placeholder instead of matching the text.
  const retracted = new Set(delegated.filter((row) => row.retractedAt !== null).map((row) => row.id));
  const avatarOf = new Map(rows.map((row) => [
    row.id,
    row.senderType === "user" && !isShownUserAvatarUrl(row.senderAvatarUrl) ? null : row.senderAvatarUrl ?? null,
  ]));
  return items.map((item) => ({
    ...item,
    latestDelegatedBy: byMessage.get(latestIdOf(item) ?? "") ?? null,
    latestRetracted: retracted.has(latestIdOf(item) ?? ""),
    parentRetracted: retracted.has(parentIdOf(item) ?? ""),
    senderAvatarUrl: avatarOf.get(latestIdOf(item) ?? "") ?? null,
  }));
}

/**
 * RFC 077 (task #6): a delegated-send receipt's `retractable`, from the sent
 * message's actual state at read time, never from the receipt: false once it is
 * retracted or deleted, or when the viewer can no longer see where it went.
 * (A receipt written before the retraction, e.g. after its assistant was
 * deleted, still says `deletedAt: null`.)
 */
async function delegatedReceiptRetractable(
  rows: readonly { id: string; actionMetadata?: unknown }[],
  viewerUserId: string | null,
  viewerServerId: string | null,
): Promise<Map<string, ReadonlyMap<string, boolean>>> {
  // receipt id -> the sent message ids it lists (one for a send; a line each for a forward).
  const sentIdsOf = new Map<string, string[]>();
  for (const row of rows) {
    const metadata = row.actionMetadata as { kind?: unknown; delegatedReceipt?: { messageId?: unknown }; delegatedReceipts?: unknown } | null | undefined;
    if (metadata?.kind !== DELEGATED_RECEIPT_KIND) continue;
    const ids = [
      ...(typeof metadata.delegatedReceipt?.messageId === "string" ? [metadata.delegatedReceipt.messageId] : []),
      ...(Array.isArray(metadata.delegatedReceipts)
        ? metadata.delegatedReceipts.flatMap((entry: { messageId?: unknown }) => typeof entry?.messageId === "string" ? [entry.messageId] : [])
        : []),
    ];
    if (ids.length > 0) sentIdsOf.set(row.id, [...new Set(ids)]);
  }
  const result = new Map<string, ReadonlyMap<string, boolean>>();
  if (sentIdsOf.size === 0) return result;
  const sent = await getDb().select({ id: messages.id, channelId: messages.channelId, deletedAt: messages.deletedAt, delegatedByAgentId: messages.delegatedByAgentId })
    .from(messages)
    .where(inArray(messages.id, [...new Set([...sentIdsOf.values()].flat())]));
  const live = sent.filter((row) => row.deletedAt === null && row.delegatedByAgentId !== null);
  const visible = viewerUserId && viewerServerId
    ? await channelService.filterUserAccessibleChannelIds([...new Set(live.map((row) => row.channelId))], viewerUserId, asServerId(viewerServerId))
    : null;
  const ok = new Set(live.filter((row) => visible === null || visible.has(row.channelId)).map((row) => row.id));
  for (const [receiptId, sentIds] of sentIdsOf) result.set(receiptId, new Map(sentIds.map((id) => [id, ok.has(id)])));
  return result;
}

function withDelegatedReceiptRetractable<T extends { id: string }>(row: T, retractable: ReadonlyMap<string, ReadonlyMap<string, boolean>>): T {
  const bySentId = retractable.get(row.id);
  if (bySentId === undefined) return row;
  const metadata = (row as { actionMetadata?: { delegatedReceipt?: Record<string, unknown>; delegatedReceipts?: unknown } }).actionMetadata!;
  const withValue = (entry: Record<string, unknown> | undefined) => entry && typeof entry.messageId === "string"
    ? { ...entry, retractable: bySentId.get(entry.messageId) ?? false }
    : entry;
  return {
    ...row,
    actionMetadata: {
      ...metadata,
      delegatedReceipt: withValue(metadata.delegatedReceipt),
      ...(Array.isArray(metadata.delegatedReceipts)
        ? { delegatedReceipts: metadata.delegatedReceipts.map((entry: Record<string, unknown>) => withValue(entry)) }
        : {}),
    },
  };
}

async function enrichWithSenderNames<T extends MessageRowForEnrichment>(
  inputRows: T[],
  opts: MessageQueryTraceOptions = {},
) {
  if (inputRows.length === 0) return [];

  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const messageIds = inputRows.map((m) => m.id);
  const cardIds = inputRows.filter((row) => {
    const metadata = "actionMetadata" in row ? row.actionMetadata : null;
    return row.senderType !== "external_projection" && metadata !== null && typeof metadata === "object" && "kind" in metadata && metadata.kind === "action-card";
  }).map((row) => row.id);
  // The reads below are independent within each wave, so a wave runs them
  // side by side instead of one round trip after another. At most
  // ENRICHMENT_QUERY_CONCURRENCY run at once: each holds its own pool
  // connection, and one page load must not take a large share of the pool.
  // Inside an ambient transaction they all share its one connection, so they
  // run one at a time there (pg would queue them anyway, and deprecates
  // queueing; the link-card execute re-check reads a message in its transaction).
  const limit = createConcurrencyLimiter(isInTransaction() ? 1 : ENRICHMENT_QUERY_CONCURRENCY);
  // Task facts only add task fields, so the sender and channel of each row
  // are known before they load.
  const userMessageRows = inputRows.filter((m) => m.senderType === "user" && m.messageType !== "system");
  const senderChannelIds = [...new Set(userMessageRows.map((m) => m.channelId))];
  const [
    cardOriginRows,
    taskFacts,
    reactionMap,
    mentionMap,
    externalAuthorMap,
    attachmentMap,
    channelRows,
  ] = await Promise.all([
    cardIds.length === 0 ? [] : limit(() => db
      .select({ messageId: actionCards.messageId, serverId: actionCards.serverId, createdAt: actionCards.createdAt, requesterUserId: actionCards.requesterUserId })
      .from(actionCards).where(inArray(actionCards.messageId, cardIds))),
    limit(() => loadCanonicalTaskFactsByMessageId(messageIds, db)),
    limit(() => getReactionsForMessages(messageIds, traceQuery)),
    limit(() => getMentionFactsForMessages(messageIds, traceQuery)),
    limit(() => loadExternalMessageAuthors(messageIds, db)),
    // Batch-fetch attachments for all messages
    limit(() => traceQuery(
      "messages.attachments_by_messages",
      () => getAttachmentsForMessages(messageIds),
      (result) => ({
        input_count: inputRows.length,
        attachments_count: [...result.values()].reduce((sum, list) => sum + list.length, 0),
      }),
    )),
    senderChannelIds.length === 0 ? [] : limit(() => traceQuery(
      "messages.senders.channels_by_messages",
      () => db
        .select({ id: channels.id, serverId: channels.serverId, type: channels.type })
        .from(channels)
        .where(inArray(channels.id, senderChannelIds)),
      () => ({ input_count: senderChannelIds.length }),
    )),
  ]);
  const cardOrigins = new Map(cardOriginRows.map((card) => [card.messageId, card.serverId] as const));
  // When each card was prepared, from the same read: its served deadline (servedActionCardMetadata).
  const cardFacts = new Map(cardOriginRows.map((card) => [card.messageId, { createdAt: card.createdAt, requesterUserId: card.requesterUserId }] as const));

  // v1.4: task facts live in `tasks`, but the message-shaped task fields are a
  // published interface (CLI `[task #N status=...]` suffix, socket payloads,
  // assignee mute-piercing). Project them back on here — the single chokepoint
  // every message-history read path already funnels through — so no read
  // surface has to learn about the storage move.
  const rows = projectTaskFactsOntoRows(inputRows, taskFacts);
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
    // RFC 077: the assistant that sent a message as its owner is labeled on every read.
    const delegatedByAgentId = (row as { delegatedByAgentId?: string | null }).delegatedByAgentId;
    if (delegatedByAgentId) agentIdSet.add(delegatedByAgentId);
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

  for (const channel of channelRows) {
    channelServerMap.set(channel.id, channel.serverId);
    channelTypeMap.set(channel.id, channel.type);
  }
  const serverIds = [...new Set(channelRows.map((channel) => channel.serverId))];
  const jointChannelIds = channelRows.filter((channel) => !isSubConversationType(channel.type)).map((channel) => channel.id);
  // Threads and task conversations (task v2): membership is the parent's.
  const threadChannelIds = channelRows.filter((channel) => isSubConversationType(channel.type)).map((channel) => channel.id);
  const hasSenderMembership = userMessageRows.length > 0 && userIds.length > 0;
  const jointSenderPermission=hasSenderMembership ? await resolveJointHumanEntrySql({storageChannelIds:[...jointChannelIds,...threadChannelIds]},db) : null;
  const canonicalThreadChannels = alias(channels, "canonical_thread_channels");
  const parentMessages = alias(messages, "joint_thread_parent_messages");
  const parentJointChannels = alias(jointChannels, "parent_joint_channels");
  const parentJointChannelServers = alias(jointChannelServers, "parent_joint_channel_servers");
  const [
    userRows,
    agentRows,
    membershipRows,
    departureRows,
    jointMemberRows,
    jointThreadMemberRows,
  ] = await Promise.all([
    userIds.length === 0 ? [] : limit(() => traceQuery(
      "messages.senders.user_profiles",
      () => db
        .select({ id: users.id, name: users.name, displayName: users.displayName, description: users.description })
        .from(users)
        .where(inArray(users.id, userIds)),
      () => ({ input_count: userIds.length }),
    )),
    agentIds.length === 0 ? [] : limit(() => traceQuery(
      "messages.senders.agent_profiles",
      () => db
        .select({ id: agents.id, name: agents.name, displayName: agents.displayName, description: agents.description, avatarUrl: agents.avatarUrl, deletedAt: agents.deletedAt })
        .from(agents)
        .where(inArray(agents.id, agentIds)),
      () => ({ input_count: agentIds.length }),
    )),
    !hasSenderMembership || serverIds.length === 0 ? [] : limit(() => traceQuery(
      "messages.senders.server_members",
      () => db
        .select({ serverId: serverMembers.serverId, userId: serverMembers.userId })
        .from(serverMembers)
        .where(and(
          inArray(serverMembers.serverId, serverIds),
          inArray(serverMembers.userId, userIds),
        )),
      () => ({ input_count: userIds.length, server_count: serverIds.length }),
    )),
    !hasSenderMembership || serverIds.length === 0 ? [] : limit(() => traceQuery(
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
    )),
    !hasSenderMembership || jointChannelIds.length === 0 ? [] : limit(() => traceQuery(
      "messages.senders.joint_channel_members",
      () => db
        .select({
          canonicalChannelId: jointChannels.canonicalChannelId,
          localChannelId: jointChannelServers.localChannelId,
          userId: users.id,
        })
        .from(jointChannels)
        .innerJoin(jointChannelServers, and(
          eq(jointChannelServers.jointChannelId, jointChannels.id),
          eq(jointChannelServers.status, "active"),
        ))
        .innerJoin(users,inArray(users.id,userIds))
        .where(and(
          jointSenderPermission!(jointChannelServers.localChannelId,users.id),
          inArray(jointChannels.canonicalChannelId, jointChannelIds),
          eq(jointChannels.status, "active"),
        )),
      () => ({ input_count: userIds.length, joint_channel_count: jointChannelIds.length }),
    )),
    !hasSenderMembership || threadChannelIds.length === 0 ? [] : limit(() => traceQuery(
      "messages.senders.joint_thread_parent_members",
      () => db
        .select({
          canonicalThreadChannelId: jointChannels.canonicalChannelId,
          localParentChannelId: parentJointChannelServers.localChannelId,
          userId: users.id,
        })
        .from(jointChannels)
        .innerJoin(canonicalThreadChannels, and(
          eq(canonicalThreadChannels.id, jointChannels.canonicalChannelId),
          inArray(canonicalThreadChannels.type, ["thread", "task"]),
          isNull(canonicalThreadChannels.deletedAt),
        ))
        .leftJoin(parentMessages, eq(parentMessages.id, canonicalThreadChannels.parentMessageId))
        .leftJoin(tasks, eq(tasks.id, canonicalThreadChannels.taskId))
        .innerJoin(parentJointChannels, and(
          eq(parentJointChannels.canonicalChannelId, sql`COALESCE(${parentMessages.channelId}, ${tasks.channelId})`),
          eq(parentJointChannels.status, "active"),
        ))
        .innerJoin(parentJointChannelServers, and(
          eq(parentJointChannelServers.jointChannelId, parentJointChannels.id),
          eq(parentJointChannelServers.status, "active"),
        ))
        .innerJoin(users,inArray(users.id,userIds))
        .where(and(
          jointSenderPermission!(parentJointChannelServers.localChannelId,users.id),
          inArray(jointChannels.canonicalChannelId, threadChannelIds),
          eq(jointChannels.status, "active"),
        )),
      () => ({ input_count: userIds.length, thread_channel_count: threadChannelIds.length }),
    )),
  ]);
  for (const u of userRows) {
    nameMap.set(u.id, u.displayName || u.name || "User");
    handleMap.set(u.id, u.name || "User");
    descriptionMap.set(u.id, u.description || null);
  }
  const delegatedByMap = new Map<string, DelegatedByLabel>();
  for (const a of agentRows) {
    nameMap.set(a.id, a.displayName || a.name);
    handleMap.set(a.id, a.name);
    descriptionMap.set(a.id, a.description || null);
    delegatedByMap.set(a.id, { id: a.id, name: a.name, displayName: a.displayName || a.name, avatarUrl: a.avatarUrl ?? null, deleted: a.deletedAt !== null });
  }
  for (const membership of membershipRows) {
    activeMemberKeys.add(`${membership.serverId}:${membership.userId}`);
  }
  for (const departure of departureRows) {
    departureReasonByMemberKey.set(
      `${departure.serverId}:${departure.userId}`,
      departure.reason,
    );
  }
  for (const membership of jointMemberRows) {
    jointMembershipChannelIds.add(membership.canonicalChannelId);
    jointMembershipChannelIds.add(membership.localChannelId);
    activeJointMemberKeys.add(`${membership.canonicalChannelId}:${membership.userId}`);
    activeJointMemberKeys.add(`${membership.localChannelId}:${membership.userId}`);
  }
  for (const membership of jointThreadMemberRows) {
    jointMembershipChannelIds.add(membership.canonicalThreadChannelId);
    activeJointMemberKeys.add(`${membership.canonicalThreadChannelId}:${membership.userId}`);
    activeJointMemberKeys.add(`${membership.localParentChannelId}:${membership.userId}`);
  }

  // Attachment-comment enrichment (attachment-comments MVP spec §5): per-
  // Attachment comment counts power the chip badges, and a per-message ref
  // marks scoped comments so thread views can render the `re: filename` chip.
  // Two grouped queries for the whole batch — no per-message fan-out.
  const allAttachmentIds = [...attachmentMap.values()].flatMap((list) => list.map((a) => a.id));
  const commentCountMap = new Map<string, number>();
  // The last wave: comment counts, comment refs and the forwarded-source
  // check are independent of each other and run together.
  const countRowsPending = allAttachmentIds.length === 0 ? null : limit(() => traceQuery(
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
  ));
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
  const hostChannels = alias(channels, "comment_ref_host_channels");
  const hostParentMessages = alias(messages, "comment_ref_host_parent_messages");
  const hostParentChannels = alias(channels, "comment_ref_host_parent_channels");
  // The active thread that hangs off the host message itself, if any — i.e.
  // the host top-level message IS a thread root (cindyz #32). At most one row
  // per host: idx_channels_active_thread_parent is unique on parent_message_id
  // where type='thread' and not deleted, so this leftJoin cannot fan out.
  const hostChildThreadChannels = alias(channels, "comment_ref_host_child_thread_channels");
  // Messages are stored once: for a joint thread the host message lives on the
  // canonical thread, whichever local projection the attachment row names.
  const hostMessages = alias(messages, "comment_ref_host_messages");
  const refRowsPending = messageIds.length === 0 ? null : limit(() => traceQuery(
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
        hostMessageChannelId: hostMessages.channelId,
        hostInJointThread: sql<boolean>`EXISTS (
          SELECT 1 FROM ${jointChannels}
          WHERE ${jointChannels.canonicalChannelId} = ${hostMessages.channelId}
            AND ${jointChannels.status} = 'active'
        )`,
      })
      .from(attachmentCommentRefs)
      .innerJoin(attachments, eq(attachments.id, attachmentCommentRefs.attachmentId))
      .innerJoin(hostChannels, eq(hostChannels.id, attachments.channelId))
      .leftJoin(hostMessages, eq(hostMessages.id, attachments.messageId))
      .leftJoin(hostParentMessages, eq(hostParentMessages.id, hostChannels.parentMessageId))
      .leftJoin(hostParentChannels, eq(hostParentChannels.id, hostParentMessages.channelId))
      .leftJoin(hostChildThreadChannels, and(
        eq(hostChildThreadChannels.parentMessageId, attachments.messageId),
        eq(hostChildThreadChannels.type, "thread"),
        isNull(hostChildThreadChannels.deletedAt),
      ))
      .where(inArray(attachmentCommentRefs.commentMessageId, messageIds)),
    (result) => ({ input_count: messageIds.length, refs: result.length }),
  ));
  const canReadForwardedSourcePending = pageForwardedSourceCheck(
    rows.map((msg) => ("actionMetadata" in msg ? msg.actionMetadata : undefined)),
    resolveForwardedBundleViewer(opts),
  );
  const [countRows, refRows, canReadForwardedSource] = await Promise.all([
    countRowsPending ?? [],
    refRowsPending ?? [],
    canReadForwardedSourcePending,
  ]);
  for (const row of countRows) commentCountMap.set(row.attachmentId, row.count);
  // A joint thread routes through the reader's own server: its projection of
  // the parent joint channel and of the thread, with the canonical parent
  // message. Storage ids (canonical channel/thread) are never a route, so a
  // reader without a projection on their server (or an unknown reader server)
  // gets no jump rather than a wrong one. One batched read for the page.
  const viewerServerId = opts.viewerServerId ?? null;
  const jointHostThreadIds = [...new Set(refRows
    .filter((row) => row.hostChannelType === "thread" && row.hostInJointThread && row.hostMessageChannelId)
    .map((row) => row.hostMessageChannelId!))];
  const viewerJointThreadByCanonicalId = new Map<string, channelService.JointThreadProjection>();
  if (viewerServerId && jointHostThreadIds.length > 0) {
    const projections = await channelService.getActiveJointThreadProjectionsByCanonicalThreadsForServer(
      jointHostThreadIds,
      viewerServerId,
      db,
    );
    for (const projection of projections) {
      if (!viewerJointThreadByCanonicalId.has(projection.canonicalThreadChannelId)) {
        viewerJointThreadByCanonicalId.set(projection.canonicalThreadChannelId, projection);
      }
    }
  }
  for (const row of refRows) {
    const isThreadHosted = row.hostChannelType === "thread";
    let hostSource: CommentRefHostSource | null;
    if (isThreadHosted && row.hostInJointThread) {
      const projection = row.hostMessageChannelId
        ? viewerJointThreadByCanonicalId.get(row.hostMessageChannelId)
        : undefined;
      hostSource = projection?.canonicalParentMessageId
        ? {
            type: "thread",
            routeKind: "channel",
            channelId: projection.localParentChannelId,
            parentMessageId: projection.canonicalParentMessageId,
            threadChannelId: projection.localThreadChannelId,
          }
        : null;
    } else if (isThreadHosted) {
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
    const filename = normalizeAttachmentFilename(row.filename);
    const agentScope = projectAgentCommentScope(filename, row.anchorType, row.anchorData);
    commentRefMap.set(row.commentMessageId, {
      attachmentId: row.attachmentId,
      filename,
      hostMessageId: row.hostMessageId,
      hostSource,
      // Human API reads retain the Web card's compact quote preview. Agent
      // enrichment has no user identity and projects location only because
      // the complete quotation immediately follows as a blockquote.
      anchorLabel: opts.attachmentCommentViewerUserId
        ? renderAnchorLabel(row.anchorType, row.anchorData)
        : agentScope.anchorLabel,
      anchorQuote: agentScope.anchorQuote,
    });
  }

  const receiptRetractable = await delegatedReceiptRetractable(rows, opts.forwardedBundleViewerUserId ?? null, opts.viewerServerId ?? null);
  return Promise.all(rows.map(async msg => {
    const externalAuthor = externalAuthorMap.get(msg.id) ?? null;
    const visibleRow = opts.includeSenderTimezone ? msg : omitSenderTimezone(msg);
    return withDelegatedReceiptRetractable(projectForwardDestinationMessage({
    ...visibleRow,
    ...(externalAuthor?.identityKind === "anonymous" ? { senderId: externalAuthor.externalActorId } : {}),
    actionMetadata: await scrubForwardedBundleMetadataForViewer(
      cardIds.includes(msg.id) && "actionMetadata" in msg && msg.actionMetadata !== null && typeof msg.actionMetadata === "object"
        // A card stored before cards carried `presentation.card` gets one here (pure, no read); agent views drop it.
        // A prepared card is served with its deadline, and as `expired` past its 30 days (never stored).
        ? servedActionCardMetadata(withStoredActionCardSpec({ ...msg.actionMetadata, sourceServerId: cardOrigins.get(msg.id) ?? null }), cardFacts.get(msg.id))
        : "actionMetadata" in msg ? msg.actionMetadata : undefined,
      resolveForwardedBundleViewer(opts),
      canReadForwardedSource,
    ),
    commentRef: commentRefMap.get(msg.id) ?? null,
    delegatedBy: (() => {
      const delegatedByAgentId = (msg as { delegatedByAgentId?: string | null }).delegatedByAgentId;
      return delegatedByAgentId ? delegatedByMap.get(delegatedByAgentId) ?? null : null;
    })(),
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
    }), receiptRetractable);
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
  if (isSubConversationType(channel?.type)) {
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
 * Publishes a durable provider-origin body edit or reaction as a merge-only update.
 * Unlike the initial message emitter this must not replay unread/activity side
 * effects, and it must project the canonical row into every active Joint/local
 * conversation before broadcasting. A card message's update (RFC 082 §4.2) is
 * published the same way, after its commit, with the thread preview.
 */
export async function emitExternalLinkedMessageUpdateToFrontend(
  io: SocketServer,
  messageId: string,
  options: { updateThreadPreview?: boolean } = {},
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
  if (isSubConversationType(storageChannel.type)) {
    const projections = await channelService.getActiveJointThreadProjectionsByCanonicalThread(message.channelId);
    for (const projection of projections) {
      const localParent = await channelService.getChannel(projection.localParentChannelId);
      targets.set(projection.localThreadChannelId, {
        localChannelId: projection.localThreadChannelId,
        serverId: projection.localServerId,
        conversationContext: buildFrontendConversationContext({
          channelType: projection.kind,
          parentMessageId: projection.canonicalParentMessageId,
          parentChannel: localParent,
          taskId: projection.canonicalParentTaskId,
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
    const payload = projectRichMessageSocketPayload(withFrontendConversationContext(
      stripViewerScopedAttachmentCommentMetadata(broadcastProjected),
      target.conversationContext,
    ));
    // message-realtime-producer: message-service.external-reaction.updated
    io.to(`channel:${target.localChannelId}`).emit("message:updated", payload);
    // A parent viewer need not follow/join the reply's thread room. The
    // preview-only event must not append a reply to the parent's message list
    // or masquerade as a new arrival with a higher sequence/count.
    if (options.updateThreadPreview && target.conversationContext.channelType === "thread"
      && target.conversationContext.parentMessageId && target.conversationContext.parentChannelId) {
      io.to(`channel:${target.conversationContext.parentChannelId}`).emit("thread:reply_updated", payload);
    }
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
  const scopedContent = renderAgentCommentScopedContent(message.content, message.commentRef);
  return {
    message_id: message.id,
    sender_name: message.senderHandle ?? message.senderName,
    sender_description: message.senderDescription || null,
    sender_timezone: message.senderTimezone ?? null,
        ...((message as { delegatedBy?: { name: string } | null }).delegatedBy ? { delegated_by: { name: (message as { delegatedBy: { name: string } }).delegatedBy.name } } : {}),
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
  /** The receiving server's plan history cutoff (services/historyWindow.ts): no context from behind it. */
  historyCutoff: Date | undefined,
): Promise<ThreadJoinContextBase | undefined> {
  // First-time thread entrants miss the semantic anchor completely if we only
  // deliver the triggering @mention, so we always include the parent/root message.
  // A parent behind the plan's history window is not the agent's to read:
  // no join context then, as when the parent is gone; reading the thread
  // says why.
  const parentContext = await getMessageContext(parentMessageId, 0, 0, historyCutoff, { includeSenderTimezone: true });
  const parentMessage = parentContext?.messages[0];
  if (!parentMessage) return undefined;

  // Keep the window intentionally small: the goal is to prevent blind replies,
  // not to silently inject the full thread backlog into every delivery.
  const recentWindow = await listMessages(
    threadChannelId,
    THREAD_JOIN_CONTEXT_WINDOW + 1,
    beforeSeq,
    undefined,
    historyCutoff,
    { includeSenderTimezone: true },
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
    .where(and(conversionReadChannelPredicate(messages.channelId, channelId), ...messageIdShortPrefixConditions(shortId)))
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

/**
 * One message by full or short id, among those the actor may see. `message`
 * is the row the lookup matched, so a caller does not read it again.
 */
export type ResolvedVisibleMessageId =
  | { ok: true; messageId: string; message: typeof messages.$inferSelect }
  | { ok: false; status: 400 | 404; error: string };

export async function resolveMessageIdVisibleToAgent(
  serverId: string,
  agentId: string,
  idOrShortId: string,
): Promise<ResolvedVisibleMessageId> {
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
): Promise<ResolvedVisibleMessageId> {
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
): Promise<ResolvedVisibleMessageId> {
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
    .select({ message: messages })
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

  const visible: Array<typeof messages.$inferSelect> = [];
  for (const { message } of candidates) {
    if (await canAccessChannel(message.channelId)) {
      visible.push(message);
      if (visible.length > 1) break;
    }
  }

  if (visible.length === 1) return { ok: true, messageId: visible[0].id, message: visible[0] };
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
    if (isSubConversationType(channel.type)) {
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
  const [target] = await db.select(messageReadColumns).from(messages).where(and(...targetConditions)).limit(1);
  if (!target) return null;

  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const { previousRows, nextRows } = await db.transaction(async (tx) => {
    const resolvedReadChannelIds = await resolveConversionReadChannelIds(tx, target.channelId);
    const channelPred = resolvedConversionReadChannelPredicate(messages.channelId, resolvedReadChannelIds);

    const previousConditions = [channelPred, lt(messages.seq, target.seq)];
    if (historyCutoff) {
      const cutoffSeq = await getHistoryCutoffSeq(target.channelId, historyCutoff, tx, resolvedReadChannelIds);
      if (cutoffSeq !== null) {
        previousConditions.push(gte(messages.seq, cutoffSeq));
      }
      previousConditions.push(gt(messages.createdAt, historyCutoff));
    }
    const previousRows = await traceQuery(
      "messages.context.previous",
      () => tx
        .select(messageReadColumns)
        .from(messages)
        .where(and(...previousConditions))
        .orderBy(desc(messages.seq))
        .limit(before + 1),
      () => ({ limit: before + 1, direction: "before" }),
    );

    const nextConditions = [channelPred, gt(messages.seq, target.seq)];
    if (historyCutoff) {
      nextConditions.push(gt(messages.createdAt, historyCutoff));
    }
    const nextRows = await traceQuery(
      "messages.context.next",
      () => tx
        .select(messageReadColumns)
        .from(messages)
        .where(and(...nextConditions))
        .orderBy(messages.seq)
        .limit(after + 1),
      () => ({ limit: after + 1, direction: "after" }),
    );
    return { previousRows, nextRows };
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });

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

async function getHistoryCutoffSeq(
  channelId: string,
  historyCutoff: Date,
  executor: DatabaseExecutor = getDb(),
  resolvedReadChannelIds?: string[],
): Promise<number | null> {
  const channelPred = resolvedReadChannelIds
    ? resolvedConversionReadChannelPredicate(messages.channelId, resolvedReadChannelIds)
    : conversionReadChannelPredicate(messages.channelId, channelId);
  const [row] = await executor
    .select({ cutoffSeq: sql<number | null>`MIN(${messages.seq})::bigint` })
    .from(messages)
    .where(and(channelPred, gt(messages.createdAt, historyCutoff)));
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
  const conditions = [conversionReadChannelPredicate(messages.channelId, channelId), eq(messages.id, messageId)];
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
    conversionReadChannelPredicate(parentMessages.channelId, parentChannelId),
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
    conversionReadChannelPredicate(parentMessages.channelId, parentChannelId),
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
  const canonicalThreads = alias(channels, "canonical_thread_channels");
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
      conversionReadChannelPredicate(parentMessages.channelId, parentChannelId),
      isNull(threadChannels.deletedAt),
    ))
    .limit(2);
  // A joint thread's local projection carries no parent_message_id; match it
  // through its canonical thread, whose parent message lives in the canonical
  // parent channel the route passes for a joint parent. The mapping is then
  // confirmed by the shared projection reader, which fails closed.
  const projectionCandidates = targets.length > 1 ? [] : await db
    .select({ threadChannelId: threadChannels.id })
    .from(threadChannels)
    .innerJoin(jointChannelServers, eq(jointChannelServers.localChannelId, threadChannels.id))
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(canonicalThreads, eq(canonicalThreads.id, jointChannels.canonicalChannelId))
    .innerJoin(parentMessages, eq(parentMessages.id, canonicalThreads.parentMessageId))
    .where(and(
      ...threadIdConditions,
      eq(threadChannels.type, "thread"),
      isNull(threadChannels.parentMessageId),
      conversionReadChannelPredicate(parentMessages.channelId, parentChannelId),
      isNull(threadChannels.deletedAt),
    ))
    .limit(2);
  for (const candidate of projectionCandidates) {
    const projection = await channelService.getJointThreadProjectionByLocalThread(candidate.threadChannelId);
    if (projection?.canonicalParentMessageId) targets.push({ parentMessageId: projection.canonicalParentMessageId });
  }
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
  const conditions = [conversionReadChannelPredicate(messages.channelId, channelId), eq(messages.seq, seq)];
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
    conversionReadChannelPredicate(messages.channelId, channelId),
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
  const conditions = [conversionReadChannelPredicate(messages.channelId, channelId)];
  if (isMessageShortId(anchor)) {
    conditions.push(...messageIdShortPrefixConditions(anchor));
  } else if (/^\d+$/.test(anchor)) {
    return { ok: true, seq: Number(anchor) };
  } else {
    if (!UUID_RE.test(anchor)) return { ok: false, reason: "not_found" };
    conditions.push(sql`${messages.id}::text = ${anchor.toLowerCase()}`);
  }
  const lookupConditions = [...conditions];
  if (historyCutoff) {
    conditions.push(gt(messages.createdAt, historyCutoff));
  }

  const targets = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(and(...conditions))
    .limit(2);

  if (targets.length === 0) {
    // Seqs are global and passed 10M, so every seq is 8 digits now, the
    // short-id width. A decimal `around` that names no message by short id
    // is a seq: the "Older:" / "Newer:" lines print seqs, and agents
    // anchor on them (Cindy, 10-30: 404 for `around: 19852431`). A message
    // behind the history window that has this short id stays not_found, so
    // the caller's check outside the window still reports it as history-limited.
    if (purpose === "around" && /^\d+$/.test(anchor)) {
      const hidden = historyCutoff
        ? await db.select({ seq: messages.seq }).from(messages).where(and(...lookupConditions)).limit(1)
        : [];
      if (hidden.length === 0) return { ok: true, seq: Number(anchor) };
    }
    return { ok: false, reason: "not_found" };
  }
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
  if (opts.resolvedReadChannelIds === undefined) {
    return listMessagesForHistoryRead(channelId, limit, beforeSeq, afterSeq, historyCutoff, opts);
  }

  const executor = opts.executor ?? getDb();
  const rows = await loadMessageRows(limit, beforeSeq, afterSeq, historyCutoff, {
    ...opts,
    executor,
    resolvedReadChannelIds: opts.resolvedReadChannelIds,
  });

  if (afterSeq !== undefined) return enrichWithSenderNames(rows, opts); // already chronological
  const enriched = await enrichWithSenderNames(rows, opts);
  return enriched.reverse();
}

/**
 * History reads need both conversion-era storage ids and an indexable
 * channel_id predicate. Resolve the ids and consume them in one repeatable-read
 * snapshot: this preserves cutover correctness without leaving Postgres to
 * apply an `IN (subquery)` join filter while walking the global seq index.
 */
export async function listMessagesForHistoryRead(
  channelId: string,
  limit = 50,
  beforeSeq?: number,
  afterSeq?: number,
  historyCutoff?: Date,
  opts: MessageQueryTraceOptions = {},
) {
  const rows = await getDb().transaction(async (tx) => {
    const resolvedReadChannelIds = await resolveConversionReadChannelIds(tx, channelId);
    return loadMessageRows(limit, beforeSeq, afterSeq, historyCutoff, {
      ...opts,
      executor: tx,
      resolvedReadChannelIds,
    });
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });

  if (afterSeq !== undefined) return enrichWithSenderNames(rows, opts);
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
    const resolvedReadChannelIds = await resolveConversionReadChannelIds(tx, channelId);
    const readChannelPredicate = () => resolvedConversionReadChannelPredicate(
      messages.channelId,
      resolvedReadChannelIds,
    );
    const conditions = [readChannelPredicate()];
    if (beforeSeq !== undefined) conditions.push(lt(messages.seq, beforeSeq));
    if (afterSeq !== undefined) conditions.push(gt(messages.seq, afterSeq));
    if (historyCutoff) conditions.push(gt(messages.createdAt, historyCutoff));
    if (opts.excludeSender) {
      conditions.push(not(and(
        eq(messages.senderType, opts.excludeSender.senderType),
        eq(messages.senderId, opts.excludeSender.senderId),
      )!));
    }

    // The page and its coverage bounds in one statement: the bounds need the
    // page's first seq, which the statement reads from the page itself.
    const page = tx.$with("message_page").as(tx
      .select(messageReadColumns)
      .from(messages)
      .where(and(...conditions))
      .orderBy(afterSeq !== undefined ? messages.seq : desc(messages.seq))
      .limit(limit));
    const pageFirstSeq = sql`(select min(${page.seq}) from ${page})`;
    // Each bound is its own max() subquery so Postgres answers it from the
    // (channel_id, seq) index with one backward probe. A single max() with a
    // FILTER clause cannot use that rewrite and reads the channel's whole
    // index (10k+ buffers on the largest channels).
    const bounds = tx.$with("message_page_bounds").as(tx
      .select({
        remoteHighWaterSeq: sql<number>`coalesce((select max(${messages.seq}) from ${messages} where ${readChannelPredicate()}), 0)`
          .mapWith(Number)
          .as("remote_high_water_seq"),
        // Below the page's first message; with no page, the high-water mark.
        coveredAfterSeq: sql<number>`coalesce((select max(${messages.seq}) from ${messages} where ${readChannelPredicate()} and ${messages.seq} < coalesce(${pageFirstSeq}, 9223372036854775807)), 0)`
          .mapWith(Number)
          .as("covered_after_seq"),
      })
      .from(sql`(values (1)) as message_page_bounds_row(one)`));
    const joined = await traceQuery(
      "messages.channel.loaded_page",
      () => tx
        .with(page, bounds)
        .select()
        .from(bounds)
        .leftJoin(page, sql`true`)
        .orderBy(afterSeq !== undefined ? page.seq : desc(page.seq)),
      () => ({
        limit,
        direction,
        history_cutoff_present: Boolean(historyCutoff),
      }),
    );
    const rows = joined.flatMap((row) => (row.message_page ? [row.message_page] : []));
    return {
      remoteHighWaterSeq: joined[0]?.message_page_bounds.remoteHighWaterSeq ?? 0,
      coveredAfterSeq: joined[0]?.message_page_bounds.coveredAfterSeq ?? 0,
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

/**
 * Forum-style channels (#proj-chat:#24): one page of a channel's top-level
 * messages ordered by latest activity, the later of the message's own time
 * and its thread's latest reply (any message in the thread channel, the same
 * fact the thread summary's `lastReplyAt` reports), ties by seq. Pages walk
 * from the newest activity back; `before` is the keyset cursor
 * `(activityAt, seq)` of the oldest row already shown, exclusive.
 *
 * No stored activity column: the exact top `limit` under the cursor is the
 * union of (1) the newest messages by their own time whose activity is under
 * the cursor (an index walk on (channel_id, created_at) that stops after
 * `limit` rows) and (2) the channel's threads with the newest last reply under
 * the cursor (one probe per live thread). Any row of the true top `limit` is
 * in (1) when its activity is its own time and in (2) when a reply set it.
 * `activityAt` is Postgres text at microsecond precision so the cursor never
 * rounds between ties.
 *
 * Rows come back oldest activity first (display order, newest at the bottom),
 * each with its `activityAt`. `hasMore` is true when older rows remain.
 *
 * Cost (review of #13074, finding 3): leg (2) is not bounded by `limit`; every
 * page reads every live thread of the channel. Accepted for the /raft pilot
 * only. Follow-up before rolling out beyond /raft: store the thread's
 * last_reply_at with an index on (parent_channel_id, last_reply_at) so leg (2)
 * becomes a bounded index walk.
 */
export async function listTopLevelMessagesByActivity(
  channelId: string,
  limit: number,
  before: ChannelActivityCursor | null,
  historyCutoff?: Date,
  opts: MessageQueryTraceOptions = {},
) {
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const ordered = await getDb().transaction(async (tx) => {
    const readChannelIds = await resolveConversionReadChannelIds(tx, channelId);
    if (readChannelIds.length === 0) return [];
    const ids = sql.join(readChannelIds.map((id) => sql`${id}::uuid`), sql`, `);
    const cutoff = historyCutoff ? sql`AND m.created_at > ${historyCutoff.toISOString()}::timestamptz` : sql``;
    const underCursor = (activity: SQL) => before
      ? sql`AND (${activity}, m.seq) < (${before.activityAt}::timestamptz, ${before.seq}::bigint)`
      : sql``;
    const ownUnderCursor = before
      ? sql`AND (m.created_at, m.seq) < (${before.activityAt}::timestamptz, ${before.seq}::bigint)`
      : sql``;
    const take = limit + 1;
    const result = await traceQuery(
      "messages.channel.activity_page",
      () => tx.execute(sql`
        WITH by_own_time AS (
          SELECT m.id, m.seq, GREATEST(m.created_at, COALESCE(lr.last_reply_at, m.created_at)) AS activity_at
          FROM messages m
          LEFT JOIN LATERAL (
            SELECT max(r.created_at) AS last_reply_at
            FROM channels t
            JOIN messages r ON r.channel_id = t.id
            WHERE t.parent_message_id = m.id AND t.type = 'thread' AND t.deleted_at IS NULL
          ) lr ON TRUE
          WHERE m.channel_id IN (${ids}) ${cutoff} ${ownUnderCursor}
            ${underCursor(sql`GREATEST(m.created_at, COALESCE(lr.last_reply_at, m.created_at))`)}
          ORDER BY m.created_at DESC, m.seq DESC
          LIMIT ${take}
        ),
        by_reply AS (
          SELECT m.id, m.seq, GREATEST(m.created_at, lr.last_reply_at) AS activity_at
          FROM channels t
          CROSS JOIN LATERAL (
            SELECT r.created_at AS last_reply_at
            FROM messages r
            WHERE r.channel_id = t.id
            ORDER BY r.created_at DESC
            LIMIT 1
          ) lr
          JOIN messages m ON m.id = t.parent_message_id
          WHERE t.parent_channel_id IN (${ids}) AND t.type = 'thread' AND t.deleted_at IS NULL
            AND m.channel_id IN (${ids}) ${cutoff}
            ${underCursor(sql`GREATEST(m.created_at, lr.last_reply_at)`)}
          ORDER BY activity_at DESC, m.seq DESC
          LIMIT ${take}
        )
        SELECT id::text AS id, seq::text AS seq,
          to_char(activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activity_at
        FROM (SELECT * FROM by_own_time UNION SELECT * FROM by_reply) candidates
        ORDER BY candidates.activity_at DESC, candidates.seq DESC
        LIMIT ${take}
      `),
      () => ({ limit, cursor_present: Boolean(before), history_cutoff_present: Boolean(historyCutoff) }),
    );
    return (result.rows as Array<{ id: string; seq: string; activity_at: string }>).map((row) => ({
      id: row.id,
      seq: Number(row.seq),
      activityAt: row.activity_at,
    }));
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });

  const hasMore = ordered.length > limit;
  const pageRows = (hasMore ? ordered.slice(0, limit) : ordered).reverse();
  const activityById = new Map(pageRows.map((row) => [row.id, row.activityAt]));
  const loaded = await listMessagesByIds(pageRows.map((row) => row.id), opts);
  const oldest = pageRows[0];
  return {
    messages: loaded.map((message) => ({ ...message, activityAt: activityById.get(message.id)! })),
    hasMore,
    nextCursor: hasMore && oldest ? encodeChannelActivityCursor({ activityAt: oldest.activityAt, seq: oldest.seq }) : null,
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
      .select(messageReadColumns)
      .from(messages)
      .where(inArray(messages.id, [...messageIds])),
    () => ({ count: messageIds.length }),
  );
  const order = new Map(messageIds.map((id, index) => [id, index]));
  const enriched = await enrichWithSenderNames(rows, opts);
  return enriched.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/**
 * Search rows intentionally skip the full message enrichment pipeline. Load
 * only the attachment-comment scope required by the Agent projection for the
 * already-authorized result ids, scoped to the caller's server.
 */
export async function loadAgentCommentScopesForMessages(
  messageIds: readonly string[],
  serverId: string,
): Promise<Map<string, AgentCommentScopeProjection>> {
  const result = new Map<string, AgentCommentScopeProjection>();
  if (messageIds.length === 0) return result;

  const commentMessages = alias(messages, "agent_comment_scope_messages");
  const commentChannels = alias(channels, "agent_comment_scope_channels");
  const rows = await getDb()
    .select({
      commentMessageId: attachmentCommentRefs.commentMessageId,
      filename: attachments.filename,
      anchorType: attachmentCommentRefs.anchorType,
      anchorData: attachmentCommentRefs.anchorData,
    })
    .from(attachmentCommentRefs)
    .innerJoin(attachments, eq(attachments.id, attachmentCommentRefs.attachmentId))
    .innerJoin(commentMessages, eq(commentMessages.id, attachmentCommentRefs.commentMessageId))
    .innerJoin(commentChannels, eq(commentChannels.id, commentMessages.channelId))
    .where(and(
      inArray(attachmentCommentRefs.commentMessageId, [...messageIds]),
      eq(commentChannels.serverId, serverId),
    ));

  for (const row of rows) {
    result.set(row.commentMessageId, projectAgentCommentScope(
      normalizeAttachmentFilename(row.filename),
      row.anchorType,
      row.anchorData,
    ));
  }
  return result;
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

  // One batched lookup for the whole page (was one query per thread id, run
  // concurrently: 10-20 round trips per message page).
  const threadIdByCanonicalId = new Map<string, string>();
  const projections = await channelService.getActiveJointThreadProjectionsByCanonicalThreadsForServer(canonicalThreadIds, serverId);
  for (const projection of projections) {
    // Rows come ordered by joined_at; keep the first per canonical Thread, as .find() did.
    if (!threadIdByCanonicalId.has(projection.canonicalThreadChannelId)) {
      threadIdByCanonicalId.set(projection.canonicalThreadChannelId, projection.localThreadChannelId);
    }
  }

  return msgs.map((message) => ({
    ...message,
    channelId,
    threadId: message.threadId ? threadIdByCanonicalId.get(message.threadId) ?? message.threadId : message.threadId,
  }));
}

/**
 * Whether the conversation has a message at or after `seq` that a read would
 * show: the history read's row query (same conversion scope, history window
 * and deleted placeholders), one row, no sender or attachment lookups. A
 * `--before` page probes only older rows; this tells it whether "newer" exists.
 */
export async function hasMessagesAtOrAfter(
  channelId: string,
  seq: number,
  historyCutoff?: Date,
  opts: MessageQueryTraceOptions = {},
): Promise<boolean> {
  const rows = await getDb().transaction(async (tx) => {
    const resolvedReadChannelIds = await resolveConversionReadChannelIds(tx, channelId);
    return loadMessageRows(1, undefined, seq - 1, historyCutoff, {
      ...opts,
      executor: tx,
      resolvedReadChannelIds,
    });
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
  return rows.length > 0;
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
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  // Hidden is the complement of the window (created_at > cutoff). A
  // retracted message (deleted_at) stays in the timeline as a placeholder, so
  // it is hidden history like any other.
  //
  // The conversion scope is resolved first and bound as values, and the row is
  // taken newest-first by creation time: one probe of
  // idx_messages_channel_created_at from the cutoff down, never a walk of the
  // global seq index under a subquery filter (channelConversionReadScope.ts).
  const row = await getDb().transaction(async (tx) => {
    const channelIds = await resolveConversionReadChannelIds(tx, channelId);
    const conditions = [
      resolvedConversionReadChannelPredicate(messages.channelId, channelIds),
      lte(messages.createdAt, cutoff),
    ];
    if (beforeSeq) {
      conditions.push(lt(messages.seq, beforeSeq));
    }
    const [found] = await traceQuery(
      "messages.channel.has_older",
      () => tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt), desc(messages.seq))
        .limit(1),
      (result) => ({ row_count: result.length, before_seq_present: Boolean(beforeSeq) }),
    );
    return found;
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
  return !!row;
}

/** The characters of a preview: what the outline's row and hover preview show, without another request. */
const HUMAN_OUTLINE_PREVIEW_CHARS = 400;
// Markdown read per message for its preview. A page parses up to 500 of them
// on the event loop, so this stays well under notificationPlainText's own cap.
const HUMAN_OUTLINE_SOURCE_CHARS = 1_000;

export interface HumanOutlineItem {
  id: string;
  seq: number;
  createdAt: Date;
  senderId: string;
  senderName: string;
  preview: string;
  attachmentCount: number;
}

/**
 * One page of the conversation outline, newest first: what people wrote
 * themselves. `sender_type = 'user'` is not enough on its own: a system row is
 * stored as `user` / sender `system` (message_type tells it apart), and a
 * message a personal assistant sent as its owner is stored as the owner's
 * (RFC 077: sender_type `user`, sender_id the owner) with
 * `delegated_by_agent_id` set, so that is what leaves it out, as the
 * assistant's own "what my owner said" reads do. A retraction (deleted_at)
 * stays in the timeline as a placeholder, not here. External projections have
 * their own sender_type.
 *
 * No index of its own yet: it walks idx_messages_channel_seq backwards, as
 * far as `limit` human rows take it.
 */
export async function listHumanOutlineMessages(
  channelId: string,
  limit: number,
  beforeSeq: number | undefined,
  historyCutoff: Date | undefined,
  opts: MessageQueryTraceOptions = {},
): Promise<{ items: HumanOutlineItem[]; hasMore: boolean }> {
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const { rows, parentRows } = await getDb().transaction(async (tx) => {
    const channelIds = await resolveConversionReadChannelIds(tx, channelId);
    const live = [
      eq(messages.messageType, "chat"),
      isNull(messages.deletedAt),
      ...(historyCutoff ? [gt(messages.createdAt, historyCutoff)] : []),
    ];
    const conditions = [
      resolvedConversionReadChannelPredicate(messages.channelId, channelIds),
      eq(messages.senderType, "user"),
      isNull(messages.delegatedByAgentId),
      ...live,
    ];
    if (beforeSeq !== undefined) conditions.push(lt(messages.seq, beforeSeq));
    const columns = {
      id: messages.id,
      seq: messages.seq,
      createdAt: messages.createdAt,
      senderId: messages.senderId,
      senderType: messages.senderType,
      content: sql<string>`left(${messages.content}, ${HUMAN_OUTLINE_SOURCE_CHARS})`,
    };
    const rows = await traceQuery(
      "messages.channel.human_outline",
      () => tx
        .select(columns)
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.seq))
        .limit(limit + 1),
      (result) => ({ row_count: result.length, before_seq_present: beforeSeq !== undefined }),
    );
    // The message a thread started from, whoever wrote it (Artea): what the
    // thread is about, in its parent conversation. The first item, on the page
    // that reaches it.
    const parentRows = rows.length > limit ? [] : await tx
      .select(columns)
      .from(messages)
      .innerJoin(channels, eq(channels.parentMessageId, messages.id))
      .where(and(eq(channels.id, channelId), eq(channels.type, "thread"), ...live));
    return { rows, parentRows };
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
  const page = [...rows.slice(0, limit), ...parentRows];
  if (page.length === 0) return { items: [], hasMore: false };
  const senderIds = [...new Set(page.filter((row) => row.senderType === "user").map((row) => row.senderId))];
  const agentSenderIds = [...new Set(page.filter((row) => row.senderType === "agent").map((row) => row.senderId))];
  const [attachmentsByMessage, senders, agentSenders] = await Promise.all([
    getAttachmentsForMessages(page.map((row) => row.id)),
    getDb().select({ id: users.id, name: users.name, displayName: users.displayName }).from(users).where(inArray(users.id, senderIds)),
    agentSenderIds.length === 0 ? [] : getDb().select({ id: agents.id, name: agents.name, displayName: agents.displayName }).from(agents).where(inArray(agents.id, agentSenderIds)),
  ]);
  const nameById = new Map([...senders, ...agentSenders].map((sender) => [sender.id, sender.displayName || sender.name || "User"]));
  return {
    items: page.map((row) => ({
      id: row.id,
      seq: row.seq,
      createdAt: row.createdAt,
      senderId: row.senderId,
      senderName: nameById.get(row.senderId) ?? "Unknown",
      preview: Array.from(notificationPlainText(row.content).replace(/\s+/g, " ").trim()).slice(0, HUMAN_OUTLINE_PREVIEW_CHARS).join(""),
      attachmentCount: attachmentsByMessage.get(row.id)?.length ?? 0,
    })),
    hasMore: rows.length > limit,
  };
}

/**
 * The seq of the newest message (by created_at) behind the plan's history
 * window in a channel, 0 when none. Agent history reads use it to say a
 * forward read started behind the window, to move an `--unread` position that
 * found nothing inside it, and to call an empty numeric `--around` at or below
 * it history-limited. Seq
 * does not always follow created_at (an external projection keeps its
 * source's time), so a count that must leave hidden messages out filters by
 * time instead (`createdAfter` in attestedSendService, for send freshness).
 */
export async function lastSeqBehindHistory(channelId: string, cutoff: Date): Promise<number> {
  // On every agent send and history read of a Free server: the newest row at
  // or before the cutoff, by creation time (one probe of
  // idx_messages_channel_created_at), with the conversion scope bound as
  // values, as in hasOlderMessages.
  const row = await getDb().transaction(async (tx) => {
    const channelIds = await resolveConversionReadChannelIds(tx, channelId);
    const [found] = await tx
      .select({ seq: messages.seq })
      .from(messages)
      .where(and(resolvedConversionReadChannelPredicate(messages.channelId, channelIds), lte(messages.createdAt, cutoff)))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(1);
    return found;
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
  return Number(row?.seq ?? 0);
}

/** The hidden-history count stops here; above it the web says "over 1,000". */
export const HIDDEN_HISTORY_COUNT_CAP = 1000;
/** How many of the newest hidden messages the history preview shows. */
const HIDDEN_HISTORY_PREVIEW_LIMIT = 2;
/**
 * A hidden message's preview is its first 40 characters: enough to see there
 * is something there, not to read it (cindyz, #proj-commercial task #8). Cut
 * here, so the browser never holds more.
 */
export const HIDDEN_HISTORY_PREVIEW_CHARS = HISTORY_PREVIEW_CHARS;

export type HiddenHistoryPreviewMessage = {
  id: string;
  senderType: "user" | "agent" | "external_projection";
  senderId: string;
  senderName: string | null;
  senderAvatarUrl: string | null;
  /** @deprecated Always "" for a person, null otherwise; kept for older clients (DEPRECATED_GRAVATAR_HASH). */
  senderGravatarHash: string | null;
  createdAt: Date;
  /** The text on one line, at most HIDDEN_HISTORY_PREVIEW_CHARS characters; null for a message with none (files only). */
  preview: string | null;
};

/**
 * What a plan's history cutoff hides in a channel or thread, for the history
 * paywall: how many messages (what Pro would show there: chat and system
 * messages, and a retracted message's placeholder) and a glimpse of the newest
 * chat messages (system lines and retracted placeholders are counted but not
 * previewed). In a thread the count is of replies, and its first message,
 * which sits in the parent channel, is reported on its own.
 */
export type HiddenHistoryPreview = {
  /** Counted up to HIDDEN_HISTORY_COUNT_CAP. */
  hiddenCount: number;
  /** There are more than the cap. */
  hiddenCountCapped: boolean;
  /** A thread whose first message is behind the cutoff too. */
  parentHidden: boolean;
  /**
   * Oldest first, as they would sit in the timeline: the newest two hidden
   * chat messages, or, in a thread whose first message is hidden, that
   * message and the newest hidden reply. Empty when only system lines or
   * retracted placeholders hide.
   */
  latest: HiddenHistoryPreviewMessage[];
};

type HiddenPreviewRow = Omit<HiddenHistoryPreviewMessage, "createdAt" | "senderGravatarHash"> & {
  createdAt: Date | string;
};

/**
 * A sender's face follows the message rows' privacy: a person's own avatar
 * only when Raft stores it (see withLatestMessageFacts).
 */
async function selectHiddenPreviewRows(
  tx: DatabaseExecutor,
  where: SQL,
  limit: number,
  traceQuery: NonNullable<MessageQueryTraceOptions["traceQuery"]>,
  traceName: string,
  shape: { chars?: number; pick?: "newest" | "oldest" } = {},
): Promise<HiddenHistoryPreviewMessage[]> {
  const chars = shape.chars ?? HIDDEN_HISTORY_PREVIEW_CHARS;
  const pickOrder = shape.pick === "oldest" ? sql`ASC` : sql`DESC`;
  const result = await traceQuery(
    traceName,
    () => tx.execute(sql`
      SELECT
        latest.id::text AS "id",
        latest.sender_type AS "senderType",
        latest.sender_id AS "senderId",
        latest.created_at AS "createdAt",
        CASE
          WHEN length(latest.normalized_content) = 0 THEN NULL
          WHEN length(latest.normalized_content) > ${chars}
            THEN left(latest.normalized_content, ${chars - 1}) || '…'
          ELSE latest.normalized_content
        END AS "preview",
        COALESCE(
          NULLIF(sender_user.display_name, ''),
          sender_user.name,
          NULLIF(sender_agent.display_name, ''),
          sender_agent.name,
          external_author.display_name
        ) AS "senderName",
        COALESCE(sender_user.avatar_url, sender_agent.avatar_url) AS "senderAvatarUrl"
      FROM (
        SELECT
          m.id,
          m.sender_type,
          m.sender_id,
          -- As in the DM list's last-message summary: a uuid, so the joins
          -- below are primary-key probes.
          ${sqlUuidOrNull(sql.raw("m.sender_id"))} AS sender_uuid,
          m.created_at,
          m.seq,
          btrim(regexp_replace(m.content, '\\s+', ' ', 'g')) AS normalized_content
        FROM messages m
        WHERE ${where}
        ORDER BY m.created_at ${pickOrder}, m.seq ${pickOrder}
        LIMIT ${limit}
      ) latest
      LEFT JOIN users sender_user
        ON latest.sender_type = 'user'
       AND sender_user.id = latest.sender_uuid
      LEFT JOIN agents sender_agent
        ON latest.sender_type = 'agent'
       AND sender_agent.id = latest.sender_uuid
      LEFT JOIN external_message_author_facts external_author
        ON latest.sender_type = 'external_projection'
       AND external_author.message_id = latest.id
      ORDER BY latest.created_at ASC, latest.seq ASC
    `),
    (rows) => ({ row_count: rows.rows.length }),
  );
  return (result.rows as HiddenPreviewRow[]).map((row) => ({
    ...row,
    senderAvatarUrl: row.senderType === "user" && !isShownUserAvatarUrl(row.senderAvatarUrl) ? null : row.senderAvatarUrl,
    senderGravatarHash: row.senderType === "user" ? DEPRECATED_GRAVATAR_HASH : null,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  }));
}

/**
 * Both reads walk (channel_id, created_at) backward from the cutoff, with the
 * channel's conversion-era ids resolved first in the same snapshot (as
 * listMessagesForHistoryRead): an `IN (subquery)` would let Postgres walk the
 * global created_at index instead. The count reads at most cap + 1 rows.
 * Hidden is the complement of the timeline's window (created_at > cutoff).
 */
export async function getHiddenHistoryPreview(
  channelId: string,
  cutoff: Date,
  opts: MessageQueryTraceOptions = {},
): Promise<HiddenHistoryPreview> {
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  return getDb().transaction(async (tx) => {
    const channelIds = await resolveConversionReadChannelIds(tx, channelId);
    if (channelIds.length === 0) return { hiddenCount: 0, hiddenCountCapped: false, parentHidden: false, latest: [] };
    const hidden = sql`
      m.channel_id IN (${sql.join(channelIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND m.created_at <= ${cutoff}
    `;
    const counted = await traceQuery(
      "messages.channel.hidden_history_count",
      () => tx.execute(sql`
        SELECT count(*)::int AS "count"
        FROM (SELECT 1 FROM messages m WHERE ${hidden} LIMIT ${HIDDEN_HISTORY_COUNT_CAP + 1}) capped
      `),
      () => ({ channel_ids_count: channelIds.length }),
    );
    const count = Number((counted.rows[0] as { count?: number } | undefined)?.count ?? 0);
    // A thread's first message lives in its parent channel, behind the same cutoff.
    const parentRow = await traceQuery(
      "messages.channel.hidden_history_thread_parent",
      () => tx.execute(sql`
        SELECT pm.id::text AS "id"
        FROM channels c
        JOIN messages pm ON pm.id = c.parent_message_id
        WHERE c.id = ${channelId}::uuid
          AND c.type = 'thread'
          AND pm.created_at <= ${cutoff}
        LIMIT 1
      `),
      (result) => ({ row_count: result.rows.length }),
    );
    const parentId = (parentRow.rows[0] as { id?: string } | undefined)?.id ?? null;
    // Previews are of chat messages with their text: not system lines, not a
    // retracted message's placeholder.
    const parent = parentId
      ? await selectHiddenPreviewRows(tx, sql`m.id = ${parentId}::uuid AND m.deleted_at IS NULL`, 1, traceQuery, "messages.channel.hidden_history_parent_preview")
      : [];
    const replies = await selectHiddenPreviewRows(
      tx,
      sql`${hidden} AND m.message_type = 'chat' AND m.deleted_at IS NULL`,
      parentId ? HIDDEN_HISTORY_PREVIEW_LIMIT - 1 : HIDDEN_HISTORY_PREVIEW_LIMIT,
      traceQuery,
      "messages.channel.hidden_history_latest",
    );
    return {
      hiddenCount: Math.min(count, HIDDEN_HISTORY_COUNT_CAP),
      hiddenCountCapped: count > HIDDEN_HISTORY_COUNT_CAP,
      parentHidden: parentId !== null,
      latest: [...parent, ...replies],
    };
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/** The message a link points at, when it is behind the cutoff: more of it shows than of its neighbors (cindyz, task #8). */
export const HIDDEN_TARGET_PREVIEW_CHARS = 80;

/**
 * A message that a link, search hit or Activity row points at, behind the
 * cutoff: the history paywall centers on it (frames 4, 5, 8, 9 of the design).
 * The target is shown with its first 80 characters; one hidden chat message
 * before it (in a thread, its first message when that is hidden) and the next
 * two after it, 40 characters each. Only for a target the viewer may read;
 * the caller checks access first.
 */
export type HiddenTargetPreview = {
  target: HiddenHistoryPreviewMessage & { seq: number };
  before: HiddenHistoryPreviewMessage[];
  after: HiddenHistoryPreviewMessage[];
  /** In a thread: how many of its replies hide, and whether its first message does. */
  thread: { hiddenReplyCount: number; hiddenReplyCountCapped: boolean; parentHidden: boolean } | null;
  /** The target's own thread, when it goes on inside the window: its size and newest reply there (a way back in). */
  replies: { count: number; latest: HiddenHistoryPreviewMessage } | null;
};

export async function getHiddenTargetPreview(
  channelId: string,
  targetMessageId: string,
  cutoff: Date,
  opts: MessageQueryTraceOptions = {},
): Promise<HiddenTargetPreview | null> {
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  return getDb().transaction(async (tx) => {
    const channelIds = await resolveConversionReadChannelIds(tx, channelId);
    if (channelIds.length === 0) return null;
    const inChannel = sql`m.channel_id IN (${sql.join(channelIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
    const targetRow = (await traceQuery(
      "messages.channel.hidden_target",
      () => tx.execute(sql`
        SELECT m.seq::bigint AS "seq"
        FROM messages m
        WHERE ${inChannel} AND m.id = ${targetMessageId}::uuid AND m.created_at <= ${cutoff}
        LIMIT 1
      `),
      (result) => ({ row_count: result.rows.length }),
    )).rows[0] as { seq: string | number } | undefined;
    if (!targetRow) return null;
    // Neighbors by seq, the timeline's own order (global, so it holds across a
    // conversion's ids): a timestamp round-tripped through JS loses Postgres'
    // microseconds and would count the target as its own neighbor.
    const seq = Number(targetRow.seq);
    const previewable = sql`m.message_type = 'chat' AND m.deleted_at IS NULL`;
    const [target] = await selectHiddenPreviewRows(
      tx, sql`m.id = ${targetMessageId}::uuid`, 1, traceQuery,
      "messages.channel.hidden_target_preview", { chars: HIDDEN_TARGET_PREVIEW_CHARS },
    );
    if (!target) return null;
    const threadRow = (await traceQuery(
      "messages.channel.hidden_target_thread",
      () => tx.execute(sql`
        SELECT c.type AS "type", pm.id::text AS "parentId", pm.created_at <= ${cutoff} AS "parentHidden"
        FROM channels c
        LEFT JOIN messages pm ON pm.id = c.parent_message_id
        WHERE c.id = ${channelId}::uuid
      `),
      (result) => ({ row_count: result.rows.length }),
    )).rows[0] as { type?: string; parentId?: string | null; parentHidden?: boolean | null } | undefined;
    const inThread = threadRow?.type === "thread";
    const parentHidden = inThread && Boolean(threadRow?.parentId) && threadRow?.parentHidden === true;
    const before = parentHidden
      ? await selectHiddenPreviewRows(tx, sql`m.id = ${threadRow!.parentId!}::uuid AND m.deleted_at IS NULL`, 1, traceQuery, "messages.channel.hidden_target_before")
      : await selectHiddenPreviewRows(
          tx,
          sql`${inChannel} AND m.created_at <= ${cutoff} AND m.seq < ${seq} AND ${previewable}`,
          1, traceQuery, "messages.channel.hidden_target_before",
        );
    const after = await selectHiddenPreviewRows(
      tx,
      sql`${inChannel} AND m.created_at <= ${cutoff} AND m.seq > ${seq} AND ${previewable}`,
      2, traceQuery, "messages.channel.hidden_target_after", { pick: "oldest" },
    );
    let thread: HiddenTargetPreview["thread"] = null;
    if (inThread) {
      const counted = await traceQuery(
        "messages.channel.hidden_target_thread_count",
        () => tx.execute(sql`
          SELECT count(*)::int AS "count"
          FROM (SELECT 1 FROM messages m WHERE ${inChannel} AND m.created_at <= ${cutoff} LIMIT ${HIDDEN_HISTORY_COUNT_CAP + 1}) capped
        `),
        () => ({ channel_ids_count: channelIds.length }),
      );
      const count = Number((counted.rows[0] as { count?: number } | undefined)?.count ?? 0);
      thread = { hiddenReplyCount: Math.min(count, HIDDEN_HISTORY_COUNT_CAP), hiddenReplyCountCapped: count > HIDDEN_HISTORY_COUNT_CAP, parentHidden };
    }
    // The target's own thread: a hidden first message whose discussion goes on.
    const ownThread = (await traceQuery(
      "messages.channel.hidden_target_own_thread",
      () => tx.execute(sql`
        SELECT c.id::text AS "id",
          (SELECT count(*)::int FROM messages r WHERE r.channel_id = c.id) AS "count"
        FROM channels c
        WHERE c.parent_message_id = ${targetMessageId}::uuid AND c.type = 'thread' AND c.deleted_at IS NULL
        LIMIT 1
      `),
      (result) => ({ row_count: result.rows.length }),
    )).rows[0] as { id?: string; count?: number } | undefined;
    let replies: HiddenTargetPreview["replies"] = null;
    if (ownThread?.id && Number(ownThread.count ?? 0) > 0) {
      const [latest] = await selectHiddenPreviewRows(
        tx,
        sql`m.channel_id = ${ownThread.id}::uuid AND m.created_at > ${cutoff} AND ${previewable}`,
        1, traceQuery, "messages.channel.hidden_target_own_thread_latest",
      );
      // Only a thread that goes on inside the window: a way back in.
      replies = latest ? { count: Number(ownThread.count), latest } : null;
    }
    return { target: { ...target, seq }, before, after, thread, replies };
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/** A thread whose first message, in its parent channel, is behind the cutoff. */
export async function isThreadParentHidden(
  channelId: string,
  cutoff: Date,
  opts: MessageQueryTraceOptions = {},
): Promise<boolean> {
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const result = await traceQuery(
    "messages.channel.thread_parent_hidden",
    () => getDb().execute(sql`
      SELECT 1
      FROM channels c
      JOIN messages pm ON pm.id = c.parent_message_id
      WHERE c.id = ${channelId}::uuid
        AND c.type = 'thread'
        AND pm.created_at <= ${cutoff}
      LIMIT 1
    `),
    (rows) => ({ row_count: rows.rows.length }),
  );
  return result.rows.length > 0;
}

/**
 * Raw `db.execute` rows skip Drizzle's `bigserial({ mode: "number" })` mapping,
 * so node-postgres returns `messages.seq` (int8) as a string. Coerce it back so
 * every syncMessages outlet (`GET /messages/sync`, socket `sync:resume`) emits
 * the same numeric seq as the channel/context/socket paths.
 */
const RAW_SYNC_TIMESTAMP_FIELDS = ["createdAt", "updatedAt", "deletedAt", "taskClaimedAt", "taskCompletedAt"] as const;

/** `2026-10-21 21:37:58.578+00` (node-postgres text for a raw timestamptz) as a Date. */
function parsePgTimestampText(value: string): Date | string {
  const iso = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? value : parsed;
}

/**
 * A raw `db.execute` row in the shape the query builder returns: production
 * node-postgres hands back int8 `seq` and timestamptz columns as text, so the
 * client got `seq` as a string and times as `2026-10-21 21:37:58.578+00`
 * (which Safari cannot parse) instead of ISO.
 */
function normalizeRawSyncMessageRow<T extends { seq?: unknown }>(row: T): T {
  const normalized: Record<string, unknown> = { ...row };
  if (typeof normalized.seq === "string") normalized.seq = Number(normalized.seq);
  for (const field of RAW_SYNC_TIMESTAMP_FIELDS) {
    const value = normalized[field];
    if (typeof value === "string") normalized[field] = parsePgTimestampText(value);
  }
  return normalized as T;
}

type SyncMessageReadRow = Omit<typeof messages.$inferSelect, "searchText" | "searchVector">;

/**
 * messages.insert_xid is deliberately not in the drizzle table (schema.ts:
 * no ORM read can fetch it); the sync statement names it here only.
 */
const messagesInsertXid = sql.raw(`"messages"."insert_xid"`);

/** Every column of a message-history read (messageReadColumns), for the raw sync statement. */
const syncMessageReadSelectList = sql.join(
  Object.entries(messageReadColumns).map(([key, column]) => sql`${column} AS ${sql.identifier(key)}`),
  sql`, `,
);

/**
 * One statement: the snapshot horizon, the page and (with a since-horizon) the
 * late rows, so the horizon describes exactly the snapshot the rows were read
 * from (see ./syncHorizon). `from` and `filters` are shared by both arms, so
 * late rows pass the same visibility and history-cutoff filters as the page.
 * `filters` starts with AND (or is empty).
 */
function syncMessagesStatement(input: {
  selectList: SQL;
  from: SQL;
  filters: SQL;
  sinceSeq: number;
  limit: number;
  sinceHorizon: SyncHorizon | null;
  lateCap: number;
}): SQL {
  const { selectList, from, filters, sinceSeq, limit, sinceHorizon } = input;
  // Only a client that sent a since-horizon gets the finished-transaction
  // filter: requests without one return exactly what they did before.
  const finishedOnly = sinceHorizon
    ? sql`AND (${messagesInsertXid} IS NULL OR ${messagesInsertXid} < (SELECT xmin FROM sync_horizon))`
    : sql``;
  const lateArm = sinceHorizon
    ? sql`,
    sync_late AS (
      SELECT ${selectList}, TRUE AS "syncLate"
      ${from}
      WHERE ${messages.seq} <= ${sinceSeq}
        AND ${messagesInsertXid} >= ${sinceHorizon}::xid8
        AND ${messagesInsertXid} < (SELECT xmin FROM sync_horizon)
        ${filters}
      ORDER BY ${messages.seq}
      LIMIT ${input.lateCap + 1}
    )`
    : sql``;
  const lateRows = sinceHorizon ? sql`UNION ALL SELECT * FROM sync_late` : sql``;
  return sql`
    WITH sync_horizon AS MATERIALIZED (
      SELECT pg_snapshot_xmin(s.snap) AS xmin, pg_snapshot_xmax(s.snap) AS xmax
      FROM (SELECT pg_current_snapshot() AS snap) s
    ),
    sync_page AS (
      SELECT ${selectList}, FALSE AS "syncLate"
      ${from}
      WHERE ${messages.seq} > ${sinceSeq}
        ${filters}
        ${finishedOnly}
      ORDER BY ${messages.seq}
      LIMIT ${limit}
    )${lateArm}
    SELECT h.xmin::text AS "syncHorizon", h.xmax::text AS "syncSnapshotXmax", r.*
    FROM sync_horizon h
    LEFT JOIN (SELECT * FROM sync_page ${lateRows}) r ON TRUE
  `;
}

type SyncStatementRow = Record<string, unknown> & {
  id?: unknown;
  seq?: unknown;
  syncHorizon?: unknown;
  syncSnapshotXmax?: unknown;
  syncLate?: unknown;
};

/**
 * Split the statement's rows into the horizon and the messages: late rows
 * above the cap are dropped (reset), the rest are merged with the page,
 * deduplicated by id and ordered by seq.
 */
function splitSyncStatementRows(rows: readonly SyncStatementRow[], lateCap: number) {
  const head = rows[0];
  const horizon = syncHorizonFromDatabase(head?.syncHorizon);
  const span = snapshotXidSpan(horizon, head?.syncSnapshotXmax);
  const page: Record<string, unknown>[] = [];
  const late: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (row.id === null || row.id === undefined) continue; // the horizon row of an empty read
    const { syncHorizon: _horizon, syncSnapshotXmax: _xmax, syncLate, ...message } = row;
    (syncLate === true || syncLate === "t" ? late : page).push(normalizeRawSyncMessageRow(message));
  }
  const horizonReset = late.length > lateCap;
  const seen = new Set<unknown>();
  const merged = [...(horizonReset ? [] : late), ...page]
    .filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  return {
    rows: merged,
    horizon,
    horizonReset,
    lateCount: horizonReset ? 0 : late.length,
    snapshotXidSpan: span,
  };
}

export type SyncMessagesHorizonOptions = {
  /**
   * The horizon this client's previous round returned on its first page
   * (validated). Only on a round's first page: turns on the finished-
   * transaction filter and the late arm. Omitted = the pre-horizon behaviour.
   */
  sinceHorizon?: SyncHorizon | null;
};

export type SyncMessagesWithHorizonResult<T> = {
  messages: T[];
  /** pg_snapshot_xmin of the read's snapshot, decimal: the next round's since-horizon. */
  horizon: SyncHorizon;
  /** More than the late cap qualified: no late rows were returned; the client refetches its visible scope. */
  horizonReset: boolean;
  /** Late rows returned (0 without a since-horizon, or on reset). */
  lateCount: number;
  /** xmax - xmin of the read's snapshot (tracing lag proxy). */
  snapshotXidSpan: number | null;
};

/**
 * Sync messages: get messages with seq > sinceSeq for a channel (or all channels in server).
 * Used for gap sync after reconnection. Returns the message array only; see
 * syncMessagesWithHorizon for the horizon contract.
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
  return (await syncMessagesWithHorizon(sinceSeq, channelId, limit, serverId, historyCutoff, userId, viewerServerId)).messages;
}

/**
 * Sync messages with the sync horizon (./syncHorizon): the page
 * `seq > sinceSeq ORDER BY seq LIMIT limit`, the read's horizon and, when the
 * client sent a since-horizon, the late rows (`seq <= sinceSeq` whose
 * transaction finished after the previous round's horizon).
 */
export async function syncMessagesWithHorizon(
  sinceSeq: number,
  channelId: string | undefined,
  limit = 200,
  serverId?: string,
  historyCutoff?: Date,
  userId?: string,
  viewerServerId = serverId,
  options: SyncMessagesHorizonOptions = {},
) {
  // PRIMARY ONLY: the horizon statement runs on getDb(), never the search/read
  // replica (DATABASE_URL_READ_REPLICA -> getSearchDb()). On a standby,
  // pg_current_snapshot()/pg_snapshot_xmin describe the replica's replay
  // state, not the writer's in-flight transactions, so the horizon would be
  // wrong for rows a primary transaction has not committed yet.
  const db = getDb();
  const enrichOptions: MessageQueryTraceOptions = {
    attachmentCommentViewerUserId: userId ?? null,
    forwardedBundleViewerUserId: userId ?? null,
    viewerServerId: viewerServerId ?? null,
  };
  const sinceHorizon = options.sinceHorizon ?? null;
  const lateCap = syncLateCap();
  const emptyRead = async () => {
    const snapshot = await readSyncHorizon();
    return {
      messages: [] as Awaited<ReturnType<typeof enrichWithSenderNames<SyncMessageReadRow>>>,
      horizon: snapshot.horizon,
      horizonReset: false,
      lateCount: 0,
      snapshotXidSpan: snapshot.snapshotXidSpan,
    };
  };

  // Every filter except the seq bound (each arm has its own).
  const conditions: SQL[] = [];
  if (channelId) {
    conditions.push(conversionReadChannelPredicate(messages.channelId, channelId));
  }
  if (historyCutoff) {
    conditions.push(gt(messages.createdAt, historyCutoff));
  }
  const baseFilters = conditions.length > 0 ? sql`AND ${sql.join(conditions, sql` AND `)}` : sql``;

  // If serverId provided, scope to channels in that server via join.
  // When syncing all channels for a user, preserve channel visibility:
  // public channels are readable server-wide; private/DM channels require
  // membership; threads require follow plus readable parent.
  if (serverId) {
    const role = userId ? await getActorServerRoleInServer(serverId, "user", userId) : null;
    if (userId && !role) return emptyRead();
    const isGuest = role === "guest";
    // A Guest syncs only its one channel and that channel's followed threads
    // and tasks (#wg-rbac:#15).
    const guestIds = isGuest && userId ? await channelService.guestReadableConversationIds(serverId, userId, db) : null;
    if (isGuest && (!guestIds || guestIds.length === 0)) return emptyRead();
    const jointEntry = userId && !channelId ? await resolveJointHumanEntrySql({ serverId }, db) : null;
    const visibilityCondition = userId && !channelId && guestIds
      ? sql`
        AND ${channels.id} IN (${sql.join(guestIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND (
          ${channels.type} NOT IN ('thread', 'task')
          OR EXISTS (
            SELECT 1 FROM ${threadFollows} tf
            WHERE tf.thread_channel_id = ${channels.id}
              AND tf.follower_type = 'user'
              AND tf.follower_id = ${userId}
              AND tf.unfollowed_at IS NULL
          )
        )
      `
      : userId && !channelId
      ? sql`
        AND (
          (
            ${channels.type} = 'channel'
            AND EXISTS (
              SELECT 1 FROM ${serverMembers} sm
              WHERE sm.server_id = ${channels.serverId}
                AND sm.user_id = ${userId}
                AND sm.role <> 'guest'
            )
          )
          OR (
            ${channels.type} IN ('private', 'dm')
            AND EXISTS (
              SELECT 1 FROM ${channelHumans} ch
              WHERE ch.channel_id = ${channels.id}
                AND ch.user_id = ${userId}
            )
          )
          OR (
            ${channels.type} IN ('thread', 'task')
            AND EXISTS (
              SELECT 1 FROM ${threadFollows} tf
              WHERE tf.thread_channel_id = ${channels.id}
                AND tf.follower_type = 'user'
                AND tf.follower_id = ${userId}
                AND tf.unfollowed_at IS NULL
            )
            AND EXISTS (
              -- Parent channel: a thread's parent message's channel, a task
              -- conversation's (task v2) parent_channel_id.
              SELECT 1
              FROM ${channels} pc
              LEFT JOIN ${channelHumans} pch
                ON pch.channel_id = pc.id
               AND pch.user_id = ${userId}
              WHERE pc.id = COALESCE(
                  (SELECT pm.channel_id FROM ${messages} pm WHERE pm.id = ${channels.parentMessageId}),
                  CASE WHEN ${channels.type} = 'task' THEN ${channels.parentChannelId} END
                )
                AND pc.server_id = ${serverId}
                AND pc.deleted_at IS NULL
                AND NOT (pc.name = 'all' AND pc.type <> 'channel')
                AND (
                  (
                    pc.type = 'channel'
                    AND EXISTS (
                      SELECT 1 FROM ${serverMembers} psm
                      WHERE psm.server_id = pc.server_id
                        AND psm.user_id = ${userId}
                        AND psm.role <> 'guest'
                    )
                  )
                  OR (pc.type <> 'joint' AND pch.user_id IS NOT NULL)
                  OR (pc.type = 'joint' AND ${jointEntry ? jointEntry(sql`pc.id`, sql`${userId}::uuid`) : sql`false`})
                )
            )
          )
        )
      `
      : sql``;

    const rows = await db.execute(syncMessagesStatement({
      selectList: sql`
        ${messages.id},
        ${messages.seq},
        ${messages.channelId} AS "channelId",
        ${messages.senderType} AS "senderType",
        ${messages.senderId} AS "senderId",
        ${messages.messageType} AS "messageType",
        ${messages.content},
        ${messages.threadId} AS "threadId",
        ${messages.taskStatus} AS "taskStatus",
        ${messages.taskNumber} AS "taskNumber",
        ${messages.taskAssigneeType} AS "taskAssigneeType",
        ${messages.taskAssigneeId} AS "taskAssigneeId",
        ${messages.taskClaimedAt} AS "taskClaimedAt",
        ${messages.taskCompletedAt} AS "taskCompletedAt",
        ${messages.actionMetadata} AS "actionMetadata",
        ${messages.createdAt} AS "createdAt",
        ${messages.updatedAt} AS "updatedAt",
        -- RFC 077: a gap-filled copy must say who sent it for its owner and whether it was retracted,
        -- or it overwrites the live copy's label (the client may hold no other copy).
        ${messages.delegatedByAgentId} AS "delegatedByAgentId",
        ${messages.deletedAt} AS "deletedAt"
      `,
      from: sql`
      FROM ${messages}
      INNER JOIN ${channels}
        ON ${messages.channelId} = ${channels.id}`,
      filters: sql`
        ${baseFilters}
        AND ${channels.serverId} = ${serverId}
        AND ${channels.deletedAt} IS NULL
        AND NOT (${channels.name} = 'all' AND ${channels.type} <> 'channel')
        ${visibilityCondition}`,
      sinceSeq,
      limit,
      sinceHorizon,
      lateCap,
    }));
    const { rows: syncRows, ...horizonFields } = splitSyncStatementRows(rows.rows as SyncStatementRow[], lateCap);

    return {
      ...horizonFields,
      messages: await enrichWithSenderNames(syncRows as any[], enrichOptions),
    };
  }

  const rows = await db.execute(syncMessagesStatement({
    selectList: syncMessageReadSelectList,
    from: sql`FROM ${messages}`,
    filters: baseFilters,
    sinceSeq,
    limit,
    sinceHorizon,
    lateCap,
  }));
  const { rows: syncRows, ...horizonFields } = splitSyncStatementRows(rows.rows as SyncStatementRow[], lateCap);

  return {
    ...horizonFields,
    messages: await enrichWithSenderNames(syncRows as unknown as SyncMessageReadRow[], enrichOptions),
  };
}

/**
 * Attach to each row the `conversationContext` its `message:new` carries when
 * it is broadcast in its storage channel (the non-projection branches of the
 * frontend broadcast): `{ channelType }` for top-level conversations; a thread
 * adds its parent message and the parent message's channel; a task
 * conversation adds its task and parent channel. A parent channel that is gone
 * (deleted) or is itself a sub-conversation adds nothing, as on the broadcast.
 * Rows of joint projections are out of scope: their caller projects them.
 *
 * Batched for a replay page across many conversations: at most three reads
 * (the storage channels, the thread parents, the parent channels).
 */
export async function withStorageConversationContexts<T extends { channelId: string }>(
  rows: readonly T[],
  executor: DatabaseExecutor = getDb(),
): Promise<Array<T & { conversationContext: FrontendConversationContext }>> {
  if (rows.length === 0) return [];
  const channelIds = [...new Set(rows.map((row) => row.channelId))];
  const storageChannels = await executor
    .select({
      id: channels.id,
      type: channels.type,
      parentMessageId: channels.parentMessageId,
      parentChannelId: channels.parentChannelId,
      taskId: channels.taskId,
    })
    .from(channels)
    .where(inArray(channels.id, channelIds));
  const storageById = new Map(storageChannels.map((channel) => [channel.id, channel]));

  const parentMessageIds = [...new Set(storageChannels
    .filter((channel) => isSubConversationType(channel.type) && channel.parentMessageId)
    .map((channel) => channel.parentMessageId!))];
  const parentMessages = parentMessageIds.length === 0 ? [] : await executor
    .select({ id: messages.id, channelId: messages.channelId })
    .from(messages)
    .where(inArray(messages.id, parentMessageIds));
  const parentMessageChannel = new Map(parentMessages.map((message) => [message.id, message.channelId]));

  const parentChannelIdOf = (channel: (typeof storageChannels)[number]): string | null =>
    (channel.parentMessageId ? parentMessageChannel.get(channel.parentMessageId) : undefined)
      ?? (channel.type === "task" ? channel.parentChannelId : null);
  const parentChannelIds = [...new Set(storageChannels
    .filter((channel) => isSubConversationType(channel.type))
    .map(parentChannelIdOf)
    .filter((id): id is string => Boolean(id)))];
  const parentChannels = parentChannelIds.length === 0 ? [] : await executor
    .select({ id: channels.id, type: channels.type })
    .from(channels)
    .where(and(inArray(channels.id, parentChannelIds), isNull(channels.deletedAt)));
  const parentChannelById = new Map(parentChannels.map((channel) => [channel.id, channel]));

  const contextByChannel = new Map<string, FrontendConversationContext>();
  for (const channelId of channelIds) {
    const channel = storageById.get(channelId);
    if (!channel) {
      contextByChannel.set(channelId, buildFrontendConversationContext({ channelType: "channel" }));
      continue;
    }
    if (!isSubConversationType(channel.type)) {
      contextByChannel.set(channelId, buildFrontendConversationContext({ channelType: channel.type }));
      continue;
    }
    const parentChannelId = parentChannelIdOf(channel);
    contextByChannel.set(channelId, buildFrontendConversationContext({
      channelType: channel.type,
      parentMessageId: channel.parentMessageId,
      parentChannel: parentChannelId ? parentChannelById.get(parentChannelId) ?? null : null,
      taskId: channel.taskId,
    }));
  }
  return rows.map((row) => withFrontendConversationContext(
    row as T & Record<string, unknown>,
    contextByChannel.get(row.channelId)!,
  ));
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

function traceSendTransactionRetry(senderType: "user" | "agent") {
  return (info: { attempt: number; sqlState: string; delayMs: number }) => {
    addTraceEvent("message_pipeline.persist.transaction_retry", {
      sender_type: senderType,
      attempt: info.attempt,
      sql_state: info.sqlState,
      delay_ms: info.delayMs,
    });
  };
}

export function updateMaxSeq(serverId: string, seq: number) {
  const current = serverMaxSeq.get(serverId) || 0;
  if (seq > current) {
    serverMaxSeq.set(serverId, seq);
    // Mirror to Redis for cross-replica heartbeat consistency (fire-and-forget)
    updateMaxSeqRedis(serverId, seq).catch(() => {});
  }
}

async function handleJointThreadPostBroadcastSideEffects(input: {
  agentOrchestrator: AgentOrchestrator;
  deps: MessageServiceDeps;
  canonicalThreadChannelId: string;
  /** Thread: the canonical parent message. Task conversation (task v2): null. */
  canonicalParentMessageId: string | null;
  /** Task conversation (task v2): the task. */
  parentTaskId?: string | null;
  senderType: "user" | "agent";
  senderId: string;
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
    agentOrchestrator,
    deps,
    canonicalThreadChannelId,
    canonicalParentMessageId,
    parentTaskId = null,
    senderType,
    senderId,
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
  // Per receiving server: each reads inside its own plan's history window.
  const threadJoinContextBaseByServer = new Map<string, ThreadJoinContextBase | undefined>();
  const deliveryPromises: Promise<unknown>[] = [];

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
          { parentTaskId, reactivateUnfollowed: true, preserveExistingReason: true, joinedThroughSeq: input.message.seq - 1 },
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
            { parentTaskId, reactivateUnfollowed: true, preserveExistingReason: true, joinedThroughSeq: input.message.seq - 1 },
          );
        }
      }
    }

    const contextEligibleAgentIds = new Set(
      [...targetVisibleMentionedAgentIds].filter((agentId) => deliveryAgents.has(agentId)),
    );
    // Join context reads the parent message (thread-only).
    if (canonicalParentMessageId && contextEligibleAgentIds.size > 0 && !threadJoinContextBaseByServer.has(projection.localServerId)) {
      threadJoinContextBaseByServer.set(projection.localServerId, await buildThreadJoinContextBase(
        canonicalThreadChannelId,
        canonicalParentMessageId,
        message.seq,
        getHistoryCutoff(await getServerPlan(projection.localServerId)),
      ));
    }
    const threadJoinContextBase = threadJoinContextBaseByServer.get(projection.localServerId);

    const renderedContent = await deps.renderAgentReadablePermalinks(content, projection.localServerId);
    const deliveryOptions = await getAgentDeliveryOptionsForSender(deps, projection.localServerId, senderType, senderId);
    const parentChannelType = parentChannel.type as "joint";
    // A task conversation (task v2) is addressed by its task ref (`#parent:#7`).
    const threadShortId = canonicalParentMessageId
      ? getMessageShortId(canonicalParentMessageId)
      : projection.threadChannel.name;
    const taskConversationNumber = parentTaskId ? await taskNumberForTaskId(parentTaskId) : null;
    // Each agent's payload, then one channel batch for this projection's thread.
    const threadDeliveries: Array<{ agentId: string; message: AgentMessage; options?: DeliverMessageOptions }> = [];
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

      threadDeliveries.push({
        agentId: agent.id,
        options: deliveryOptions,
        message: {
          channel_id: projection.localThreadChannelId,
          // Task v2: the ref's tail (`#7`), so old and new renderers show `#parent:#7`.
          channel_name: taskConversationNumber ? formatAgentTaskRefTail(taskConversationNumber) : projection.threadChannel.name,
          channel_type: "thread",
          sender_id: senderId,
          sender_name: senderUniqueName,
          sender_description: senderDescription,
          sender_timezone: message.senderTimezone ?? null,
          ...(await agentDelegatedByField(message as { delegatedByAgentId?: string | null })),
          // RFC 082: a card message reads `card=r<revision>` in the header; its content is the fallback.
          ...agentMessageCardField((message as { actionMetadata?: unknown }).actionMetadata),
          sender_type: toAgentVisibleSenderType(senderType, message.messageType),
          content: renderedContent,
          timestamp: message.createdAt.toISOString(),
          seq: message.seq,
          message_id: message.id,
          ...(targetVisibleMentionedAgentIds.has(agent.id) && { mentioned: true }),
          parent_channel_name: parentChannel.name,
          parent_channel_id: projection.localParentChannelId,
          parent_channel_type: parentChannelType,
          ...(taskConversationNumber && { task_conversation_number: taskConversationNumber }),
          ...(attachments.length > 0 && {
            attachments: attachments.map((attachment) => ({
              id: attachment.id,
              filename: normalizeAttachmentFilename(attachment.filename),
              mimeType: resolveAttachmentMimeType(attachment.filename, attachment.mimeType),
              sizeBytes: attachment.sizeBytes,
            })),
          }),
          ...(message.senderType !== "external_projection" && message.taskStatus != null && {
            task_status: message.taskStatus as "backlog" | "todo" | "in_progress" | "in_review" | "done" | "closed",
            task_number: message.taskNumber,
            task_assignee_type: toAgentVisibleTaskAssigneeType(message.taskAssigneeType as InternalActorType | null),
            task_assignee_id: message.taskAssigneeId,
            task_assignee_name: getAgentVisibleTaskAssigneeName(message),
          }),
          ...(threadJoinContext && { thread_join_context: threadJoinContext }),
          ...(reactivatedThreadAgentIds.has(agent.id) && {
            thread_follow_reactivation: { thread_target: formatSubConversationTarget(parentChannelType, parentChannel.name, threadShortId, taskConversationNumber) },
          }),
        },
      });
    }
    await attachMentionDeliveryOccurrences(message.id, threadDeliveries, targetVisibleMentionedAgentIds, "joint_thread");
    deliveryPromises.push(settleDeliveries(
      agentOrchestrator.deliverMessagesOnChannel(projection.localThreadChannelId, threadDeliveries),
      threadDeliveries.map((delivery) => delivery.agentId),
      "joint thread message",
    ));
  }

  Promise.all(deliveryPromises).catch(() => {});
}

type InsertedMentionRow = {
  id: string;
  targetType: "user" | "agent";
  targetId: string;
  notifiableAtSend: boolean;
};

/**
 * Joint deliveries are built per projection, outside the ordinary send loop. The
 * occurrence rows for their mentions were written with the message (as everywhere),
 * so they need their payload here too; otherwise they stay `recorded` with no payload,
 * which recovery never picks up and nothing ever terminates. Mutates each mentioned
 * delivery's options with its occurrence id. Never fails the delivery.
 */
async function attachMentionDeliveryOccurrences(
  messageId: string,
  deliveries: Array<{ agentId: string; message: AgentMessage; options?: DeliverMessageOptions }>,
  targetVisibleMentionedAgentIds: ReadonlySet<string>,
  path: "joint_thread" | "joint_channel",
): Promise<void> {
  const candidates = deliveries.filter((delivery) => targetVisibleMentionedAgentIds.has(delivery.agentId));
  if (candidates.length === 0) return;
  try {
    const occurrenceIds = await ensureAgentMentionDeliveryOccurrencesForAgents(
      messageId,
      candidates.map((delivery) => ({ agentId: delivery.agentId, deliveryPayload: delivery.message })),
    );
    for (const delivery of candidates) {
      const mentionDeliveryOccurrenceId = occurrenceIds.get(delivery.agentId);
      if (mentionDeliveryOccurrenceId) delivery.options = { ...delivery.options, mentionDeliveryOccurrenceId };
    }
  } catch (err) {
    addTraceEvent("message_pipeline.mention_occurrence.persist_degraded", {
      message_id: messageId,
      intended_occurrence_count: candidates.length,
      delivered_without_occurrence: true,
      recoverable: false,
      delivery_path: path,
    });
    console.error(`[MessageService] mention delivery occurrences unavailable for ${path} message ${messageId}:`, err);
  }
}

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
  /** lounge_agent_excluded: another agent mentioned in an agent's lounge; never deliverable (no actions). */
  reason: "not_member" | typeof AGENT_LOUNGE_EXCLUDED_REASON;
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
    // In a savepoint: this runs inside the send transaction, and the catch
    // below continues the send.
    const canAdd = await readInSavepoint(async () => {
      const authorityChannelId = await deps.getChannelMembershipAuthorityChannelId(
        channelId,
        executor,
      );
      return authorityChannelId
        ? await deps.actorHasChannelCapability(
            serverId,
            authorityChannelId,
            "user",
            senderId,
            "addChannelMembers",
            executor,
          )
        : false;
    });
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
const senderDeliveryWarningsKey: unique symbol = Symbol("senderDeliveryWarnings");
const senderDeliveredAgentNamesKey: unique symbol = Symbol("senderDeliveredAgentNames");

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

export function getSenderDeliveryWarnings(message: unknown): SenderDeliveryWarning[] {
  if (!message || typeof message !== "object") return [];
  const value = (message as { [senderDeliveryWarningsKey]?: SenderDeliveryWarning[] })[senderDeliveryWarningsKey];
  return Array.isArray(value) ? value : [];
}

/**
 * The handles of the agents an agent's send was delivered to, sorted; empty
 * when it reached none. Null when not counted: the sender is not an agent, or
 * delivery starts after the send returns (Joint), or the lookup failed.
 */
export function getSenderDeliveredAgentNames(message: unknown): string[] | null {
  if (!message || typeof message !== "object") return null;
  const value = (message as { [senderDeliveredAgentNamesKey]?: string[] })[senderDeliveredAgentNamesKey];
  return Array.isArray(value) ? value : null;
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

function attachSenderDeliveredAgentNames<T extends object>(message: T, names: string[]): T {
  Object.defineProperty(message, senderDeliveredAgentNamesKey, {
    value: names,
    enumerable: false,
  });
  return message;
}

function attachSenderDeliveryWarnings<T extends object>(message: T, warnings: SenderDeliveryWarning[]): T {
  if (warnings.length === 0) return message;
  Object.defineProperty(message, senderDeliveryWarningsKey, {
    value: warnings,
    enumerable: false,
  });
  return message;
}

async function buildSenderDeliveryWarnings(
  outcomes: readonly SenderDeliveryOutcome[],
  opts: { isDM: boolean; isAgentStuckOnTool?: (agentId: string) => Promise<boolean> },
): Promise<SenderDeliveryWarning[]> {
  if (!opts.isDM) return [];
  const warnings: SenderDeliveryWarning[] = [];
  for (const outcome of outcomes) {
    if (outcome.result?.status === "dropped" && outcome.result.reason === "wake_suppressed") {
      warnings.push({ targetType: "agent", targetId: outcome.agentId, reason: "agent_stopped" });
    } else if (outcome.result?.status === "queued" && opts.isAgentStuckOnTool && await opts.isAgentStuckOnTool(outcome.agentId)) {
      warnings.push({ targetType: "agent", targetId: outcome.agentId, reason: "agent_stuck_on_tool" });
    }
  }
  return warnings;
}

/** task #25: whether the agent's current activity says it is stuck on a tool call. */
function agentStuckOnToolLookup(agentOrchestrator: AgentOrchestrator): ((agentId: string) => Promise<boolean>) | undefined {
  if (typeof agentOrchestrator.getActivity !== "function") return undefined;
  return async (agentId) => {
    try {
      return Boolean((await agentOrchestrator.getActivity(agentId)).toolStuck);
    } catch {
      return false;
    }
  };
}

async function collectSenderDeliveryWarningOutcomes(
  deliveryOutcomePromises: readonly Promise<SenderDeliveryOutcome>[],
): Promise<SenderDeliveryOutcomeCollection> {
  if (deliveryOutcomePromises.length === 0) return { outcomes: [], timedOut: false };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<SenderDeliveryOutcomeCollection>([
      Promise.all(deliveryOutcomePromises).then((outcomes) => ({ outcomes, timedOut: false })),
      new Promise<SenderDeliveryOutcomeCollection>((resolve) => {
        timeout = setTimeout(() => resolve({ outcomes: [], timedOut: true }), senderDeliveryWarningTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function findUnresolvedMentionHandles(
  mentionHandles: string[],
  resolvedMentions: ResolvedMentionFact[],
  structuredMentions: StructuredMentionInput[] | undefined = undefined,
): string[] {
  const resolvedHandles = new Set(resolvedMentions.map((mention) => mention.name));
  const structuredHandles = new Set((structuredMentions ?? []).map((mention) => mention.name.trim()));
  return Array.from(new Set(
    mentionHandles.filter((handle) => !resolveRaftMentionHandle(
      handle.slice(1),
      (name) => resolvedHandles.has(name) || structuredHandles.has(name),
    )),
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
  attachment: ResolvedAttachment,
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
      // Shared with channelService.getServerAudienceHumans rather than restated.
      // This function is a module-private copy only because the transactional
      // send paths need a `DatabaseExecutor`; the audience predicate itself has
      // no reason to be duplicated, and duplicating it is exactly how the Guest
      // delivery defect arose.
      .where(channelService.serverAudienceMemberCondition(channel.serverId));
    return rows as Awaited<ReturnType<typeof channelService.getChannelHumans>>;
  }
  if (channel?.type === "joint") {
    return (await getJointHumanDeliveryRows([channelId], executor)).map(({ channelId: _channelId, ...human }) => human);
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

type JointProjectionMembers = {
  humansByChannel: Map<string, Awaited<ReturnType<typeof channelService.getChannelHumans>>>;
  agentsByChannel: Map<string, Awaited<ReturnType<typeof channelService.getChannelAgents>>>;
};

/**
 * Same rows as getChannelHumansWithExecutor/getChannelAgentsWithExecutor for
 * ordinary channels, for many joint projections in two queries. Joint
 * projections are never the virtual #all channel, so that branch is not needed.
 */
async function getJointProjectionMembersWithExecutor(
  executor: DatabaseExecutor,
  localChannelIds: readonly string[],
): Promise<JointProjectionMembers> {
  const humansByChannel: JointProjectionMembers["humansByChannel"] = new Map();
  const agentsByChannel: JointProjectionMembers["agentsByChannel"] = new Map();
  if (localChannelIds.length === 0) return { humansByChannel, agentsByChannel };
  const ids = [...new Set(localChannelIds)];
  const [humanRows, agentRows] = await Promise.all([
    getJointHumanDeliveryRows(ids, executor),
    executor
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
      })
      .from(channelAgents)
      .innerJoin(agents, eq(channelAgents.agentId, agents.id))
      .innerJoin(servers, eq(servers.id, agents.serverId))
      .where(and(inArray(channelAgents.channelId, ids), isNull(agents.deletedAt), activeAppBotOrOrdinaryAgent(),
        sql`NOT (${jointMembershipRemovalPendingSql(sql`(SELECT p.joint_channel_id FROM joint_channel_servers p WHERE p.local_channel_id=${channelAgents.channelId})`, "agent", agents.id)})`,
      )),
  ]);
  for (const { channelId, ...human } of humanRows) {
    const list = humansByChannel.get(channelId) ?? [];
    list.push(human as Awaited<ReturnType<typeof channelService.getChannelHumans>>[number]);
    humansByChannel.set(channelId, list);
  }
  for (const { channelId, ...agent } of agentRows) {
    const list = agentsByChannel.get(channelId) ?? [];
    list.push(agent as Awaited<ReturnType<typeof channelService.getChannelAgents>>[number]);
    agentsByChannel.set(channelId, list);
  }
  return { humansByChannel, agentsByChannel };
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
      // The audience condition is channelService.getServerAudienceAgents'
      // (see getChannelHumansWithExecutor for why this copy exists).
      .where(and(eq(agents.serverId, channel.serverId), isNull(agents.deletedAt), listedServerAgent()));
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
    .where(and(eq(channelAgents.channelId, channelId), isNull(agents.deletedAt), activeAppBotOrOrdinaryAgent()));
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
  const notifiableAgentRows = inserted.filter((row) => row.targetType === "agent" && row.notifiableAtSend);
  // An agent that mentions itself is never delivered its own message (every delivery
  // loop skips the sender), so an occurrence for it would stay `recorded` with no
  // payload forever: unrecoverable, never terminal. Do not record one.
  const selfMentionKeys = new Set<string>();
  if (notifiableAgentRows.length > 0) {
    const messageIds = [...new Set(rows.map((row) => row.messageId))];
    const senders = await executor
      .select({ id: messages.id, senderType: messages.senderType, senderId: messages.senderId })
      .from(messages)
      .where(inArray(messages.id, messageIds));
    for (const sender of senders) {
      if (sender.senderType === "agent" && sender.senderId) selfMentionKeys.add(`${sender.id}:${sender.senderId}`);
    }
  }
  const occurrences = notifiableAgentRows
    .flatMap((row) => {
      const source = rows.find((candidate) =>
        candidate.targetType === row.targetType && candidate.targetId === row.targetId
      );
      return source && !selfMentionKeys.has(`${source.messageId}:${row.targetId}`)
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
      deps.listAgents(serverId, false, { memberListsOnly: true }),
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
      deps.listAgents(serverId, false, { memberListsOnly: true }),
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

    // External (Slack-side) projections never enter `message_mentions` — the
    // table's readers treat every row as a Raft human/agent to wake. The
    // structured id still claims the handle so a stale projection id can't
    // silently fall through to a same-named Raft user/agent.
    if (mention.type === "external") continue;

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

  const knownHandles = new Set([
    ...candidateHumans.map((candidate) => candidate.name),
    ...candidateAgents.map((candidate) => candidate.name),
  ]);
  for (const token of rawByHandle.keys()) {
    if (structuredHandleKeys.has(token)) continue;
    // `@ops的` / `@ops와` mention `ops`; the CJK remainder stays body text.
    const resolvedHandle = resolveRaftMentionHandle(token, (name) => knownHandles.has(name));
    if (!resolvedHandle || structuredHandleKeys.has(resolvedHandle.handle)) continue;
    const handle = resolvedHandle.handle;
    // handleAtSendTime records the matched name, not the glued token.
    const rawHandle = handle;
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
  const unnotified = insertedRows.filter((row) => !row.notifiableAtSend);
  if (unnotified.length === 0) return [];
  // Agent Lounge (tygg, #proj-chat:30a58e4d): it works like a DM, so nobody
  // unreached there gets a pending action, by the send or later: not a
  // person who has not joined, not another agent (it can only read it).
  if (await deps.resolveAgentLounge(channelId, executor)) return [];
  const pendingRows = unnotified;

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
      expiresAt: new Date(currentTimeMs() + PENDING_MENTION_TTL_MS).toISOString(),
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
  } else if (isSubConversationType(channel.type) && jointThreadProjection) {
    scopeChannelId = jointThreadProjection.localParentChannelId;
    const parentChannel = await deps.getChannel(jointThreadProjection.localParentChannelId);
    scopeType = parentChannel?.type ?? "joint";
  } else if (channel.type === "task" && channel.parentChannelId) {
    // Task conversation (task v2): mentions resolve in the parent channel.
    const parentChannel = await deps.getChannel(channel.parentChannelId);
    if (parentChannel) {
      scopeChannelId = parentChannel.id;
      scopeType = parentChannel.type;
    }
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
/**
 * RFC 077: the agent-facing `delegated_by` of a message an assistant sent as its
 * owner: `{ name }` (the assistant's handle), rendered as `delegated_by=@name`
 * in the message header. Empty for every other message, with no query.
 */
export async function agentDelegatedByField(row: { delegatedByAgentId?: string | null }): Promise<{ delegated_by?: { name: string } }> {
  const agentId = row.delegatedByAgentId;
  if (!agentId) return {};
  const [agent] = await getDb().select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return agent ? { delegated_by: { name: agent.name } } : {};
}

/**
 * RFC 077: the personal assistant that sent a message as its owner, as every
 * reader sees it ("sent by {assistant} for {owner}"). `deleted` keeps the
 * label on messages whose assistant was deleted since.
 */
export type DelegatedByLabel = { id: string; name: string; displayName: string; avatarUrl: string | null; deleted: boolean };

/** The `delegatedBy` label of one assistant (deleted ones included: the label says so). */
export async function delegatedByLabelOf(agentId: string): Promise<DelegatedByLabel | null> {
  const [agent] = await getDb().select({ id: agents.id, name: agents.name, displayName: agents.displayName, avatarUrl: agents.avatarUrl, deletedAt: agents.deletedAt })
    .from(agents).where(eq(agents.id, agentId)).limit(1);
  return agent ? { id: agent.id, name: agent.name, displayName: agent.displayName || agent.name, avatarUrl: agent.avatarUrl ?? null, deleted: agent.deletedAt !== null } : null;
}

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
    /**
     * With `agentSendKey`: refuse a replay whose target, content or attachments
     * differ from the committed message (AgentSendIdempotencyConflictError,
     * 409 `idempotency_key_reused`). Set by the agent-facing send routes.
     */
    rejectMismatchedAgentSendReplay?: boolean;
    randomId?: string;
    /**
     * Stored on the message. RFC 082: a message card's metadata
     * (`kind: "message-card"`, agent senders only) also writes the card's
     * revision 1 in the send's transaction (message_card_revisions).
     */
    actionMetadata?: unknown | null;
    /**
     * RFC 082: false when `content` is the fallback Raft derived from a message
     * card: it mentions no one, so neither an @handle in it nor a structured
     * mention resolves, and an idempotent replay compares the card alone (the
     * sender wrote no content to compare). Default true (the sender wrote the
     * content).
     */
    contentMentions?: boolean;
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
    /**
     * IANA zone the human sender's browser reported (web sends only, already
     * validated by the route). Stored on the message and exposed to agents
     * only. Ignored (stored as null) for any non-human sender.
     */
    senderTimezone?: string | null;
    /** RFC 077: the personal assistant sending this as its owner (`senderType: "user"`). */
    delegatedByAgentId?: string | null;
    /**
     * An agent send only: runs inside the send's transaction right after a
     * NEW message is inserted (never for an idempotent replay, never on the
     * non-transactional fixture path). Must not throw (it would fail the send):
     * the WeChat mirror mark (wechatMirrorDecision.ts) runs in its own savepoint.
     */
    afterAgentInsertInTransaction?: (executor: DatabaseExecutor, message: typeof messages.$inferSelect) => Promise<unknown>;
  }
) {
  const deps = resolveMessageServiceDeps();
  // Explicit persistence replacement keeps the lightweight fixture seam; all
  // production calls (and calls without a replacement) use the atomic writer
  // transaction and fence. Side-effect-only dependency overrides remain
  // compatible with the focused pipeline fixtures and never alter production.
  const useAtomicMessageTransaction = !messageServiceDepsOverride?.createMessage;
  const { channelId, senderType, senderId, senderName, content, mentions, attachmentIds, agentSendKey, randomId, actionMetadata, asTask } = opts;
  const mentionContract = opts.mentionContract ?? "v1";
  // RFC 082: a message card is an agent's, and its revisions name that agent.
  const messageCardMetadata = isMessageCardMetadata(actionMetadata) ? actionMetadata : null;
  if (messageCardMetadata && senderType !== "agent") throw new Error("A message card is sent by an agent");
  const recordAgentInsertInTransaction = async (executor: DatabaseExecutor, insertedMessage: typeof messages.$inferSelect) => {
    if (messageCardMetadata) {
      await insertMessageCardRevision(executor, {
        messageId: insertedMessage.id,
        revision: messageCardMetadata.revision,
        card: messageCardMetadata.card,
        content: insertedMessage.content,
        senderAgentId: senderId,
      });
    }
    await opts.afterAgentInsertInTransaction?.(executor, insertedMessage);
  };
  const senderTimezone = senderType === "user" ? opts.senderTimezone ?? null : null;
  const delegatedByAgentId = senderType === "user" ? opts.delegatedByAgentId ?? null : null;
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
  const jointThreadProjection = isSubConversationType(requestedChannel?.type)
    ? await channelService.getJointThreadProjectionByLocalThread(channelId)
    : null;
  const jointProjections = requestedChannel?.type === "joint" || jointThreadProjection
    ? await channelService.getActiveJointChannelProjectionsByLocalChannel(jointThreadProjection?.canonicalThreadChannelId ?? channelId)
    : [];
  const jointProjection = jointProjections.find((projection) => projection.localChannelId === channelId);
  const storageChannelId = jointThreadProjection?.canonicalThreadChannelId ?? jointProjection?.canonicalChannelId ?? channelId;
  const externalDeliveryAuthorityChannelId = jointThreadProjection?.localParentChannelId ?? channelId;
  // The channel whose Joint membership admits this post, for the save-time
  // lockJointPostingAuthority: a Joint thread's local parent, otherwise the
  // requested conversation. A Joint thread's local face carries no parent
  // pointer, so a walk up from it would stop before the joint row.
  const jointPostingAuthorityChannelId = jointThreadProjection?.localParentChannelId ?? channelId;
  const channel = await runSlackBridgeOutboundPipelineStage(
    "channel_resolution",
    () => deps.getChannel(storageChannelId),
  );
  const frontendTopology: SlackBridgeOutboundPipelineTopology = jointThreadProjection
    ? "joint_thread"
    : isSubConversationType(channel?.type)
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
  const archiveScope = await runSlackBridgeOutboundPipelineStage(
    "archive_gate",
    () => deps.assertChannelNotArchived(channelId),
    { preserveError: isMessageRouteDomainError },
  );
  const isDmSend = channel?.type === "dm" || archiveScope?.rootType === "dm";
  addTraceEvent("message_pipeline.channel.resolved", {
    duration_ms: currentTimeMs() - channelResolveStart,
    sender_type: senderType,
    target_type: channel?.type ?? "missing",
    joint_projection_present: jointProjection != null,
    joint_thread_projection_present: jointThreadProjection != null,
  });

  // A content Raft derived from a card mentions no one (RFC 082 §4.1).
  const contentMentions = opts.contentMentions !== false;
  const strictMentionHandles = contentMentions ? getMentionHandles(content) : [];
  const structuredMentionsForContent = contentMentions ? mentions?.filter((mention) => (
    structuredRaftMentionStillAppears(content, mention.name.trim())
  )) : [];
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
  // created against it in the same writer transaction, so a
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
        getJointProjectionMembers: (localChannelIds) => getJointProjectionMembersWithExecutor(executor, localChannelIds),
        recordInboxNotificationFacts: (facts, nestedExecutor, notification) => deps.recordInboxNotificationFacts(facts, nestedExecutor ?? executor, notification),
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

  let createdTask: TaskRow | null = null;
  const persistStart = currentTimeMs();
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
    // A fresh delegated write needs the requested face's authority even if
    // the storage channel still resolves. Already committed forwards returned
    // above: a later lookup miss must not retroactively refuse their delivery.
    if (delegatedByAgentId && !requestedChannel) {
      throw new AssistantSendAsOwnerError(404, "channel_not_found", "Channel not found or not visible");
    }
    if (senderType === "agent" && agentSendKey
      && (useAtomicMessageTransaction || __hasAgentSendReplayDbOverrideForTests())) {
      const runAgentReplay = async (tx?: DatabaseExecutor) => {
        if (tx && archiveScope?.rootType === "joint") await lockJointPostingAuthority(jointPostingAuthorityChannelId, senderType, senderId, tx, { forSend: true });
        const result = await createOrReplayAgentSend({
          channelId: storageChannelId,
          senderId,
          content,
          agentSendKey,
          attachmentIds,
          actionMetadata: actionMetadata ?? null,
          rejectMismatchedReplay: opts.rejectMismatchedAgentSendReplay === true,
          senderWroteContent: opts.contentMentions !== false,
          beforeInsert: tx && useAtomicMessageTransaction
            ? (executor) => lockOrdinaryMessageExternalDeliveryAdmission({
              executor,
              authorityChannelId: externalDeliveryAuthorityChannelId,
              requestedChannelId: channelId,
              canonicalConversationId: storageChannelId,
              decision: ordinaryExternalProjectionDecision,
            })
            : undefined,
          onInserted: tx && useAtomicMessageTransaction
            ? async ({ executor, message: insertedMessage }: AgentSendInsertedTransactionInput) => {
              if (isDmSend) await assertDmHumanPeersAreMembers(executor, storageChannelId, "agent", senderId);
              if (idempotentMentionResolutionError) throw idempotentMentionResolutionError;
              const facts = await finalizeNewChatMessageInTransaction({
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
              await recordAgentInsertInTransaction(executor, insertedMessage);
              return facts;
            }
            : undefined,
        }, tx);
        if (asTask && tx) createdTask = await ensureTaskForMessage(result.message.id, senderType, senderId, tx, requestedChannel?.serverId);
        return result;
      };
      const replayResult = await traceMessageDbPhase({
        phase: "message_pipeline.persist",
        queryName: "messages.agent_send_transaction",
        dbOperation: "transaction",
      }, () => __hasAgentSendReplayDbOverrideForTests()
        ? runAgentReplay()
        // Every write of this send, including derived facts and the outbound
        // enqueue, lives in this one transaction, so a deadlock/serialization
        // abort leaves nothing behind and the idempotent send can re-run.
        : withTransientTransactionRetry(
          () => withLockOrderRecording({
            transaction: "messages.agent_send_transaction",
            serverId: channel?.serverId,
            rowRoles: {
              permission: externalDeliveryAuthorityChannelId,
              request: channelId,
              stored: storageChannelId,
              parent: channel?.parentChannelId,
            },
          }, () => withChannelWriterFence(channelId, runAgentReplay)),
          { onRetry: traceSendTransactionRetry("agent") },
        ));
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
    if (useAtomicMessageTransaction && senderType === "user" && randomId) {
      const replayResult = await traceMessageDbPhase({
        phase: "message_pipeline.persist",
        queryName: "messages.user_random_send_transaction",
        dbOperation: "transaction",
      }, () => withTransientTransactionRetry(() => withChannelWriterFence(channelId, async (tx) => {
        if (archiveScope?.rootType === "joint") await lockJointPostingAuthority(jointPostingAuthorityChannelId, senderType, senderId, tx, { forSend: true });
        if (delegatedByAgentId && requestedChannel) {
          await lockAssistantDelegatedMessageAuthority(tx, {
            serverId: requestedChannel.serverId, ownerUserId: senderId, agentId: delegatedByAgentId,
          });
        }
        const result = await createOrReplayUserRandomSend({
        channelId: storageChannelId,
        isDmSend,
        authorityChannelId: externalDeliveryAuthorityChannelId,
        requestedChannelId: channelId,
        senderId,
        authorName: senderName,
        content,
        randomId,
        senderTimezone,
        delegatedByAgentId,
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
      }, tx);
        if (asTask) createdTask = await ensureTaskForMessage(result.message.id, senderType, senderId, tx, requestedChannel?.serverId);
        return result;
      }), { onRetry: traceSendTransactionRetry("user") }));
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
      if (executor && delegatedByAgentId && requestedChannel) {
        await lockAssistantDelegatedMessageAuthority(executor, {
          serverId: requestedChannel.serverId, ownerUserId: senderId, agentId: delegatedByAgentId,
        });
      }
      if (isDmSend && executor) await assertDmHumanPeersAreMembers(executor, storageChannelId, senderType, senderId);
      const createdMessage = await deps.createMessage(
        storageChannelId,
        senderType,
        senderId,
        content,
        "chat",
        // v1.4: never a task-message — the task fact is created separately.
        undefined,
        {
          actionMetadata: actionMetadata ?? null,
          randomId: randomId ?? null,
          ...(senderTimezone ? { senderTimezone } : {}),
          ...(delegatedByAgentId ? { delegatedByAgentId } : {}),
        },
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
      if (executor && useAtomicMessageTransaction && senderType === "agent") {
        await recordAgentInsertInTransaction(executor, createdMessage);
      }
      if (asTask && executor) createdTask = await ensureTaskForMessage(createdMessage.id, senderType, senderId, executor, requestedChannel?.serverId);
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
      }, () => withChannelWriterFence(channelId, async (tx) => {
        // Joint authority (its row, then J) before admission's channel rows,
        // as on the agent and random-id paths: admission first took the
        // canonical row before J here, the reverse of those paths.
        if (archiveScope?.rootType === "joint") await lockJointPostingAuthority(jointPostingAuthorityChannelId, senderType, senderId, tx, { forSend: true });
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
    duration_ms: currentTimeMs() - persistStart,
    sender_type: senderType,
    target_type: channel?.type ?? "missing",
    replayed,
    attachment_count: msgAttachments.length,
    as_task: asTask === true,
  });

  // 1a. A chat message in a task's own conversation is activity on that task
  // (the Tasks page's activity sort). After the commit, never inside the
  // send's transaction, and not awaited: the send neither waits for the stamp
  // nor fails with it (see touchTaskConversationActivity, which also never
  // waits for the task row's lock). A failed stamp is logged and leaves the
  // sort a little stale.
  if (useAtomicMessageTransaction && !replayed && message.messageType === "chat" && channel?.type === "task" && channel.taskId) {
    const taskId = channel.taskId;
    void touchTaskConversationActivity(taskId).catch((err: unknown) => {
      console.warn("[MessageService] task conversation activity stamp failed", { taskId, error: serializeErrorForLog(err) });
    });
  }

  // 1b. Create the canonical task fact for `asTask` sends. Runs after persist so
  // it associates to a real message id, and is idempotent so an idempotency-key
  // replay converges on the same task row rather than minting a second one.
  if (asTask) {
    const taskCreateStart = currentTimeMs();
    createdTask ??= await ensureTaskForMessage(message.id, senderType, senderId);
    addTraceEvent("message_pipeline.task_number.allocated", {
      duration_ms: currentTimeMs() - taskCreateStart,
      sender_type: senderType,
    });
    // The remaining pipeline (socket payloads, agent delivery) reads task facts
    // off the message row. Project the just-created canonical facts back onto
    // this in-memory row so every downstream consumer keeps the pre-v1.4 shape
    // without re-querying, and without persisting them to messages.task_*.
    // A task v2 task is not its message: it has its own conversation, and the
    // message stays an ordinary message (its "📌 created" line says so below).
    if (createdTask && !createdTask.ownConversation) {
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

  const mentionWriteStart = currentTimeMs();

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
      duration_ms: currentTimeMs() - mentionWriteStart,
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
    const inboxFactStart = currentTimeMs();
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
      duration_ms: currentTimeMs() - inboxFactStart,
      sender_type: senderType,
      target_type: channel.type,
      fact_count: factCount,
      joint_projection_present: jointProjection != null,
      joint_thread_projection_present: jointThreadProjection != null,
    });
  };
  await recordInboxFactsForSend();

  // One sender lookup per send: feeds the frontend payload's
  // senderDescription (REST parity) and the agent-visible sender metadata below.
  const { uniqueName: senderUniqueName, description: senderDescription } = await deps.getSenderIdentity(senderType, senderId, senderName);

  // The sender response and frontend broadcast are human-facing: keep the
  // agent-only sender zone off them (agent payloads read it from `message`).
  const enriched = buildPersistedMessageFrontendPayload(message, {
    channelId: jointThreadProjection?.localThreadChannelId
      ?? jointProjection?.localChannelId
      ?? message.channelId,
    senderName,
    senderDescription,
    senderMembershipStatus: senderType === "user" && message.messageType !== "system" ? "active" : null,
    attachments: msgAttachments,
    mentions: targetVisibleMentions,
    // The live message:new carries the same "sent by {assistant}" label as a re-read list.
    delegatedBy: message.delegatedByAgentId ? await delegatedByLabelOf(message.delegatedByAgentId) : null,
  });
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

  if (
    channel && isSubConversationType(channel.type) && jointThreadProjection
    && (channel.parentMessageId || channel.taskId) && !replayed
  ) {
    const jointThreadSideEffectsStart = currentTimeMs();
    await handleJointThreadPostBroadcastSideEffects({
      agentOrchestrator,
      deps,
      canonicalThreadChannelId: storageChannelId,
      canonicalParentMessageId: channel.parentMessageId,
      parentTaskId: channel.type === "task" ? channel.taskId : null,
      senderType,
      senderId,
      senderUniqueName,
      senderDescription,
      content,
      message,
      attachments: msgAttachments,
      resolvedMentions,
      targetVisibleMentions,
    });
    addTraceEvent("message_pipeline.joint_thread_side_effects.finished", {
      duration_ms: currentTimeMs() - jointThreadSideEffectsStart,
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
    duration_ms: currentTimeMs() - frontendEmitStart,
    sender_type: senderType,
    target_type: channel?.type ?? "missing",
    replayed,
  });

  if (replayed) {
    return enriched;
  }

  // 4. Advance sender's legacy read-ish cursor so their own message isn't counted as unread.
  // An agent's cursor only moves when that reads through nothing it has not
  // been handed: unread from others below its message stays unread (and is
  // still delivered) instead of being marked read by the send.
  const senderReadMutation = senderType === "user"
    ? deps.markRead(senderId, channelId, message.seq)
    : deps.markAgentOwnSendRead
      ? deps.markAgentOwnSendRead(senderId, channelId, message.seq, storageChannelId)
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
  // Threads and task conversations (task v2) deliver by the same follow rules.
  const isThread = isSubConversationType(channel?.type);
  if (isThread && jointThreadProjection && (channel?.parentMessageId || channel?.taskId)) {
    addTraceEvent("message_pipeline.delivery.skipped", {
      reason: "joint_thread_projection",
      sender_type: senderType,
      target_type: "thread",
    });
    return enriched;
  }
  if (jointProjection && jointProjections.length > 0) {
    const jointDeliveryScheduleStart = currentTimeMs();
    const senderAuthorityServerId = jointProjection?.serverId ?? channel.serverId;
    const agentDeliveryOptions = await getAgentDeliveryOptionsForSender(deps, senderAuthorityServerId, senderType, senderId);
    // Bounded: each projection runs ~8 queries plus per-agent delivery. With up
    // to 30 servers per joint, starting them all at once could exhaust the
    // connection pool for the whole server (contract v0.3 §18.10.1).
    const deliveries = mapBounded(jointProjections, JOINT_DELIVERY_PROJECTION_CONCURRENCY, async (projection): Promise<void> => {
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
      // Each agent's payload (its forwarded-bundle view), then one channel batch per projection.
      const projectionDeliveries: Array<{ agentId: string; message: AgentMessage; options?: DeliverMessageOptions }> = [];
      for (const agent of projectionAgents) {
        if ((senderType === "agent" && agent.id === senderId) || mutedAgentIds.has(agent.id)) continue;
        const recipientForwardedSnapshot = formatForwardedBundleForAgent(
          await scrubForwardedBundleMetadataForViewer(actionMetadata, {
            type: "agent",
            id: agent.id,
            serverId: projection.serverId,
          }, deps.canViewerReadForwardedSource),
        );
        projectionDeliveries.push({
          agentId: agent.id,
          message: {
            channel_id: projection.localChannelId,
            channel_name: projection.channel.name,
            channel_type: "channel",
            sender_id: senderId,
            sender_name: senderUniqueName,
            sender_type: toAgentVisibleSenderType(senderType),
            sender_description: senderDescription,
            sender_timezone: message.senderTimezone ?? null,
            ...(await agentDelegatedByField(message as { delegatedByAgentId?: string | null })),
            // RFC 082: a card message reads `card=r<revision>` in the header; its content is the fallback.
            ...agentMessageCardField((message as { actionMetadata?: unknown }).actionMetadata),
            content: appendAgentForwardedSnapshot(renderedBaseContent, recipientForwardedSnapshot),
            timestamp: message.createdAt.toISOString(),
            seq: message.seq,
            message_id: message.id,
            ...(targetVisibleMentionedAgentIds.has(agent.id) && { mentioned: true }),
          },
          options: agentDeliveryOptions,
        });
      }
      await attachMentionDeliveryOccurrences(message.id, projectionDeliveries, targetVisibleMentionedAgentIds, "joint_channel");
      await settleDeliveries(
        agentOrchestrator.deliverMessagesOnChannel(projection.localChannelId, projectionDeliveries),
        projectionDeliveries.map((delivery) => delivery.agentId),
        "joint message",
      );
    });
    // Joint delivery performs database work after the send returns. Register it
    // synchronously so database teardown drains it before closing the connection.
    trackSenderReadReceipt(deliveries.then(() => {
      addTraceEvent("message_pipeline.joint_delivery.scheduled", {
        duration_ms: currentTimeMs() - jointDeliveryScheduleStart,
        projection_count: jointProjections.length,
        sender_type: senderType,
      });
    }).catch(() => {}));
    return enriched;
  }
  const deliveryPrepStart = currentTimeMs();
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

  // senderUniqueName (for @mentions) / senderDescription (agent-visible
  // metadata) were resolved once above, before the frontend payload.
  // For threads, resolve parent channel info and auto-join @mentioned agents
  let parentChannelName: string | undefined;
  let parentChannelId: string | undefined;
  let parentChannelType: string | undefined;
  let threadShortId: string | undefined;
  const newlyJoinedThreadAgentIds = new Set<string>();
  const reactivatedThreadAgentIds = new Set<string>();
  let threadJoinContextBase: ThreadJoinContextBase | undefined;
  // Task conversation (task v2): no parent message; its parent channel is on
  // the row, and agents address it by its task ref (`#parent:#7`, carried as
  // `task_conversation_number`).
  const parentTaskId = channel?.type === "task" ? channel.taskId : null;
  const taskConversationNumber = parentTaskId ? await taskNumberForTaskId(parentTaskId) : null;
  if (isThread && (channel?.parentMessageId || parentTaskId)) {
    const db = getDb();
    const [parentMsg] = channel.parentMessageId
      ? await db.select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, channel.parentMessageId))
      : channel.parentChannelId ? [{ channelId: channel.parentChannelId }] : [];
    if (parentMsg) {
      parentChannelId = jointThreadProjection?.localParentChannelId ?? parentMsg.channelId;
      threadShortId = channel.parentMessageId ? getMessageShortId(channel.parentMessageId) : channel.name;
      const parentChannel = await channelService.getChannel(parentChannelId);
      if (parentChannel) {
        parentChannelName = parentChannel.name;
        parentChannelType = parentChannel.type;
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
              channel.parentMessageId ?? null,
              "mentioned",
              { parentTaskId, reactivateUnfollowed: true, preserveExistingReason: true, joinedThroughSeq: message.seq - 1 },
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
                channel.parentMessageId ?? null,
                "mentioned",
                { parentTaskId, reactivateUnfollowed: true, preserveExistingReason: true, joinedThroughSeq: message.seq - 1 },
              );
            }
          }
        }
      }

      // Join context reads the parent message (thread-only).
      if (channel.parentMessageId && channelAgentList.some((agent) => targetVisibleMentionedAgentIds.has(agent.id))) {
        threadJoinContextBase = await buildThreadJoinContextBase(
          channelId,
          channel.parentMessageId,
          message.seq,
          getHistoryCutoff(await getServerPlan(channel.serverId)),
        );
      }
    }
  }

  // Deliver to agents in parallel. Ordinary channel sends stay non-blocking;
  // direct DMs wait for typed receipts so the sender can see manual-stop drops.
  // Messages are already persisted in DB, so delivery warnings never fail the send.
  const renderedBaseContent = await deps.renderAgentReadablePermalinks(agentFacingBaseContent, channel.serverId);
  const deliveryOptions = await getAgentDeliveryOptionsForSender(deps, channel.serverId, senderType, senderId);
  const deliveryOutcomePromises: Promise<SenderDeliveryOutcome>[] = [];
  const preparedDeliveries: { agentId: string; deliveryPayload: AgentMessage }[] = [];
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

    const recipientNames = await resolveRecipientDeliveryNames(channel.serverId, agent.id, channel, {
      parent_channel_id: parentChannelId, parent_channel_name: parentChannelName,
      parent_channel_type: parentChannelType as AgentMessage["parent_channel_type"],
      ...(taskConversationNumber && { task_conversation_number: taskConversationNumber }),
    });
    const channelNameForAgent = recipientNames.channel_name;
    const parentNameForAgent = recipientNames.parent_channel_name ?? parentChannelName;

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
        sender_timezone: message.senderTimezone ?? null,
        ...(await agentDelegatedByField(message as { delegatedByAgentId?: string | null })),
        // RFC 082: a card message reads `card=r<revision>` in the header; its content is the fallback.
        ...agentMessageCardField((message as { actionMetadata?: unknown }).actionMetadata),
        sender_type: toAgentVisibleSenderType(senderType, message.messageType),
        content: renderedContent,
        timestamp: message.createdAt.toISOString(),
        seq: message.seq,
        message_id: message.id,
        ...(targetVisibleMentionedAgentIds.has(agent.id) && { mentioned: true }),
        ...(isThread && { parent_channel_name: parentNameForAgent, parent_channel_id: parentChannelId, parent_channel_type: parentChannelType as "channel" | "private" | "joint" | "dm" }),
        // Task v2: the agent addresses this task conversation by its ref.
        ...(isThread && taskConversationNumber && { task_conversation_number: taskConversationNumber }),
        ...(msgAttachments.length > 0 && {
          attachments: msgAttachments.map(a => ({
            id: a.id,
            filename: normalizeAttachmentFilename(a.filename),
            mimeType: resolveAttachmentMimeType(a.filename, a.mimeType),
            sizeBytes: a.sizeBytes,
          })),
        }),
        ...(message.senderType !== "external_projection" && message.taskStatus != null && {
          task_status: message.taskStatus as "backlog" | "todo" | "in_progress" | "in_review" | "done" | "closed",
          task_number: message.taskNumber,
          task_assignee_type: toAgentVisibleTaskAssigneeType(message.taskAssigneeType as InternalActorType | null),
          task_assignee_id: message.taskAssigneeId,
          task_assignee_name: getAgentVisibleTaskAssigneeName(message),
        }),
        ...(threadJoinContext && { thread_join_context: threadJoinContext }),
        ...(isThread && threadShortId && parentChannelType && parentNameForAgent && reactivatedThreadAgentIds.has(agent.id) && {
          thread_follow_reactivation: {
            thread_target: formatSubConversationTarget(parentChannelType, parentNameForAgent, threadShortId, taskConversationNumber),
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
  // broadcastAndDeliver returns. One channel batch: every recipient's agent row and channel
  // access are read in a fixed number of queries, not several per agent. Orchestrator
  // stand-ins without the batch entry deliver one by one.
  const deliveries = preparedDeliveries.map(({ agentId, deliveryPayload }) => {
    const mentionDeliveryOccurrenceId = mentionDeliveryOccurrenceIds.get(agentId);
    return {
      agentId,
      message: deliveryPayload,
      options: { ...deliveryOptions, ...(mentionDeliveryOccurrenceId && { mentionDeliveryOccurrenceId }) },
    };
  });
  const deliveryResults = agentOrchestrator.deliverMessagesOnChannel(channelId, deliveries);
  deliveries.forEach(({ agentId }, index) => {
    deliveryOutcomePromises.push(
      deliveryResults[index]!.then((result) => ({ agentId, result })).catch((err) => {
        console.error(`[MessageService] Failed to deliver to agent ${agentId}:`, serializeErrorForLog(err));
        return { agentId, result: null };
      }),
    );
  });
  // These delivery promises now carry real DB work, so the aggregate joins this file's existing
  // drainable lifecycle instead of staying an unregistered fire-and-forget. Registration is
  // synchronous, so it is visible before we return. Direct DMs also sample typed receipts with a
  // bounded wait, so a sender warning can never turn successful persistence into a slow send.
  trackSenderReadReceipt(Promise.all(deliveryOutcomePromises).then(() => undefined));
  let senderDeliveryWarningsTimedOut = false;
  if (isDM && deliveryOutcomePromises.length > 0) {
    const { outcomes: deliveryOutcomes, timedOut } = await collectSenderDeliveryWarningOutcomes(deliveryOutcomePromises);
    senderDeliveryWarningsTimedOut = timedOut;
    attachSenderDeliveryWarnings(
      enriched,
      await buildSenderDeliveryWarnings(deliveryOutcomes, { isDM, isAgentStuckOnTool: agentStuckOnToolLookup(agentOrchestrator) }),
    );
  }
  // An agent sender sees which agents this message was delivered to (raft
  // message send). The deliveries are already started; a failed name lookup
  // leaves it uncounted, never fails the send.
  if (senderType === "agent") {
    try {
      const names = preparedDeliveries.length > 0
        ? await deps.getAgentNamesByIds(preparedDeliveries.map(({ agentId }) => agentId))
        : new Map<string, string>();
      attachSenderDeliveredAgentNames(
        enriched,
        preparedDeliveries
          .map(({ agentId }) => names.get(agentId))
          .filter((name): name is string => Boolean(name))
          .sort((a, b) => a.localeCompare(b)),
      );
    } catch (err) {
      addTraceEvent("message_pipeline.sender_delivered_agents.degraded", { delivery_count: preparedDeliveries.length });
      console.error(`[MessageService] delivered-agent names unavailable for message ${message.id}:`, serializeErrorForLog(err));
    }
  }
  addTraceEvent("message_pipeline.agent_delivery.scheduled", {
    ...traceChannelAudienceAttrs(channel),
    duration_ms: currentTimeMs() - deliveryPrepStart,
    sender_type: senderType,
    channel_agent_count: channelAgentList.length,
    agent_audience_count: channelAgentList.length,
    mention_only_agent_count: mentionOnlyAgents.length,
    muted_agent_suppressed_count: mutedAgentDeliveryIds.size,
    delivery_count: deliveryOutcomePromises.length,
    agent_delivery_count: deliveryOutcomePromises.length,
    ...(senderDeliveryWarningsTimedOut && { sender_delivery_warning_timed_out: true }),
    newly_joined_thread_agent_count: newlyJoinedThreadAgentIds.size,
    reactivated_thread_agent_count: reactivatedThreadAgentIds.size,
    ...(threadAgentDeliveryResolution && { thread_agent_audience_source: threadAgentDeliveryResolution.source }),
  });

  // Task v2: a message sent as a task leaves the same "📌 X created #N from
  // this message" line in its thread as every other create (stdrc: a person's
  // create and an agent's, or one from the composer, do not differ). After
  // delivery, so the line follows the message; never fails the send.
  if (asTask && createdTask?.ownConversation && !replayed && channel) {
    const announced = createdTask;
    void import("./taskConversationNotice")
      .then(({ announceTasksCreatedFromSourceMessages }) => announceTasksCreatedFromSourceMessages(io, agentOrchestrator, {
        tasks: [announced],
        localChannel: { id: channel.id, name: channel.name, type: channel.type, deletedAt: channel.deletedAt ?? null },
        actor: { type: senderType, id: senderId },
      }))
      .catch((err: unknown) => console.error(`[MessageService] send-as-task announcement failed for message ${message.id}:`, serializeErrorForLog(err)));
  }

  return enriched;
}
