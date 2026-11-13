import { AGENT_LOUNGE_OUTSIDER_ADD_REFUSAL, AgentLoungeImmutableError, filterLoungeOutsiderAgents, getLoungeAgentIds, isLoungeOutsiderAgent } from "../services/agentLoungeService";
import { projectRuntimeErrorActivityDetail } from "../services/agentRuntimeErrorVisibility";
import { isRuntimeErrorDetailActivity } from "@botiverse/raft-shared";
import { refuse, RefusalError, type RefusalInput } from "../lib/refusal";
import { isJointHostSideMember } from "../services/jointHumanMembershipAccess";
import { JointActorUnavailableError } from "../services/jointHumanMembershipMirror";
import { hideUnfindableAgentsByParam } from "./unfindableAgentGate";
import { DEPRECATED_GRAVATAR_HASH, isExternalAgentRuntime, isSubConversationType } from "@botiverse/raft-shared";
import { getProductEventSink } from "../services/productEventIngest";
import { recordServerProductEvent } from "../services/serverProductEvents";
import { getAgentsLastSeenAt } from "../services/agentCredentialService";
import { type MarkConversationUnreadResponse } from "@botiverse/raft-shared";
import { emitChannelConversionCardUpdates } from "../services/channelConversionRealtimeService";
import { emitJointProjectionUpdates, publishChannelUpdate } from "../services/channelRealtimeEvents";
import { finishChannelArchive } from "../services/channelArchiveEffects";
import { isLastJointHostSideMember } from "../services/jointHostSideArchive";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { revokeSocketAccess } from "../socket/accessRevocation";
import { socketUserServerRoom } from "../socket/platformScope";
import { Router, type Request, type Response, type Router as RouterType } from "express";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import * as channelService from "../services/channelService";
import { archivedNameCollisionBody } from "./archivedNameCollision";
import { finishHumanChannelListItems, loadHumanChannelList, resolveExternalRelationViewer, withHumanChannelAuthorization } from "../services/channelListItems";
import { noteInboxWriteBeforeReply, readWithStaleOnOverload, resolveSoftTimeoutMs, STALE_RESPONSE_HEADER } from "./rwStaleRead";
import { admitJointInvite } from "../services/jointInviteRateLimit";
import { getActiveJointProjectionLocalChannelId, JointChannelLimitError } from "../services/jointChannelLimitService";
import { AttributedJointChannelLimitError, ExternalChannelLimitError } from "../services/externalChannelLimitService";
import { resolveGatingParentJointId } from "../services/jointChannelLimitState";
import * as channelConversionService from "../services/channelConversionService";
import { runConversionCommand, conversionCommandId } from "../services/channelConversionCommandService";
import * as agentService from "../services/agentService";
import * as serverService from "../services/serverService";
import { recordIntegrationAuditEvent, serverAuditContextMetadata } from "../services/integrationAuditService";
import { withVisitorVisible } from "../services/channelVisitorVisibility";
import { canView } from "../services/visibilityService";
import { attachChannelAnnouncement, channelAnnouncementChange } from "../services/channelAnnouncements";
import { postChannelAnnouncementChange } from "../services/channelAnnouncementMessages";
import * as messageService from "../services/messageService";
import * as userService from "../services/userService";
import * as savedService from "../services/savedService";
import * as externalInviteService from "../services/externalInviteService";
import { inviteEmailRecorder } from "../services/externalInviteProductEvents";
import * as jointMemberConnectService from "../services/jointMemberConnectService";
import * as externalInviteConnectService from "../services/externalInviteConnectService";
import {
  choseSeveral,
  noteServerConnectPaywallHits,
  publishExternalConnections,
  recordConnectFinished,
  recordServerConnectOutcomes,
  serializeServerConnectOutcome,
} from "./externalInvites";
import { refusedOutcome, type ConnectFinishedOutcome } from "../services/externalConnectProductEvents";
import { asServerId, CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY, channelTypeSupportsThreadSort, isChannelThreadSort, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, MAX_JOINT_CHANNEL_SERVERS, PUBLIC_SERVER_FEATURE_FLAG_KEY, channelTypeSupportsActivityMute, noopTracer, validateName, type ServerCapability, type ActiveSpan, type ServerId, type TraceAttributes, type Tracer } from "@botiverse/raft-shared";
import { getServerPlan, getHistoryCutoff, channelBillingReadOnlyBody, getChannelBillingReadOnly, isChannelReadOnlyByQuota } from "../services/planService";
import { setRequestTraceErrorCode, setRequestTraceLimitSide } from "../middleware/requestObservability";
import { noteLimitPaywallHit, notePaywallHit } from "./paywallHit";
import { getServerHistoryWindowForRead, isBehindHistoryWindow } from "../services/historyWindow";
import {
  evaluateFeatureFlag,
} from "../services/featureFlagService";
import { isReceiverStatePushEnabled } from "../services/receiverStatePushService";
import { onConversationsRead } from "../services/notifications/retraction";
import { emitScopeReadUpdated, getPeerReadHydrate } from "../services/readReceiptService";
import { emitThreadFollowersUpdated } from "../services/threadFollowerRealtimeService";
import {
  NotificationLevelError,
  emitLevelChange,
  loadConversationLevelSettings,
  setLevel as setNotificationLevel,
  withNotificationLevels,
} from "../services/notifications/settings";
import { assistantsAmong, stopAssistant } from "../services/assistantLifecycleService";
import { openDirectMessageForUser } from "../services/directMessageOpenService";
import { joinChannelAsUser } from "../services/channelJoinService";
import { isActionCardConversionError } from "../services/actionCardConversionService";
import {
  actorHasServerCapabilityInServer,
  actorRoleHasServerCapability,
  canHumanOperateAgentReadState,
  decideAgentResourceAuthority,
  getActorServerRoleInServer,
  type ReadStateDelegationBasis,
} from "../lib/actorPermissions";
import {
  actorHasChannelCapability,
  channelActorHasCapability,
  resolveChannelActorContext,
  withLockedChannelActorCapability,
  withLockedChannelActorCapabilities,
} from "../lib/channelActorPermissions";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import type { Server as SocketServer } from "socket.io";
import { addTraceEvent, createTraceDbQueryTracer, getCurrentTraceContext, tracePhase, withTraceChildSpan } from "../tracing/semanticTrace";
import {
  activityListFetchTraceAttrs,
  CHANNEL_FETCH_REASON_HEADER,
  channelGetTargetTraceAttrs,
  INBOX_FETCH_COALESCED_HEADER,
  INBOX_FETCH_TRIGGER_HEADER,
  inboxFetchTriggerTraceAttrs,
} from "./channelGetTrace";
import { getThumbnailUrl, normalizeAttachmentFilename, resolveAttachmentMimeType } from "./attachments";
import { CHANNEL_NOT_FOUND_BODY, denyChannelAccess } from "./channelAccessDenial";
import { MAX_MESSAGE_LENGTH } from "./messages";
import { addRouteFailureEvent, respondToRisingWaveUnavailable, sendJsonServerError } from "./errorResponse";
import { UUID_RE as ANY_UUID_RE } from "../lib/messageId";
import { guardUuidPathParams } from "../lib/uuidPathParams";
import {
  assertChannelConversionWritable,
  ChannelConversionInProgressError,
  resolveChannelConversionLockTarget,
} from "../services/channelConversionFenceService";
import {
  CompatibilityReadMutationPendingError,
  isReadMutationFenceRefusal,
  ReadMutationError,
} from "../services/readMutationSequencer";
import {
  DoneFrontierAboveInt4AuthorityError,
  DoneFrontierBeyondLatestError,
  DoneFrontierRequiredError,
} from "../services/inboxSuppressionWriters";
import { getInboxRouteBackpressureAdmission } from "../middleware/inboxRouteBackpressure";
import { firstPartyApp } from "../apps/firstPartyApps";
import { getActivityInboxItems, getObjectKindInboxItems, type ActivityInboxItem, type ActivityInboxResult } from "../services/objectActivityInbox";
import { markAllObjectActivityRead } from "../services/objectActivity";
import { announceActivityChanged } from "../services/activityRealtime";
import { getDb, getPoolMetrics, type DatabaseExecutor } from "../db/index";
import { parseOffsetQueryParam } from "../lib/offsetQueryParam";

/** Another person's personal assistant: answered as an id that names no agent (agentFindableBy). */
function isOthersAssistant(agent: { assistantOwnerUserId?: string | null } | null | undefined, userId: string): boolean {
  return Boolean(agent?.assistantOwnerUserId) && agent!.assistantOwnerUserId !== userId;
}

export const channelRouter: RouterType = Router();

// Uniform 404 for non-UUID path params (task #12), before any handler runs.
// `targetType` is deliberately excluded (it is a member kind, not a UUID).
guardUuidPathParams(channelRouter, {
  id: "Channel",
  inviteId: "Invite",
  jobId: "Conversion job",
  memberId: "Member",
  messageId: "Message",
  threadChannelId: "Thread",
  agentId: "Agent",
});
// Another person's personal assistant reads as an unknown agent (agentFindableBy).
hideUnfindableAgentsByParam(channelRouter, "agentId");
hideUnfindableAgentsByParam(channelRouter, "memberId");

async function attachHumanChannelAuthorization<T extends { id: string }>(
  channel: T,
  serverId: string,
  userId: string,
) {
  const context = await resolveChannelActorContext(serverId, channel.id, "user", userId);
  return withHumanChannelAuthorization(channel, context);
}

/**
 * A conversion job runs longer than the request that starts it, so the job
 * gets its own trace. The request trace gets a job started event that
 * carries the job trace id, and the job span carries the request ids.
 */
function startChannelConversionJobSpan(tracer: Tracer, attrs: TraceAttributes): ActiveSpan {
  const requestContext = getCurrentTraceContext();
  const jobSpan = tracer.startSpan("server.channel_conversion.job", {
    surface: "server",
    kind: "internal",
    attrs: {
      ...attrs,
      ...(requestContext ? {
        request_trace_id: requestContext.traceId,
        request_span_id: requestContext.spanId,
      } : {}),
    },
  });
  tracer.emitEvent("server.channel_conversion.job.started", {
    surface: "server",
    parent: requestContext,
    attrs: { ...attrs, job_trace_id: jobSpan.context.traceId },
  });
  return jobSpan;
}

function sendCompatibilityReadPending(
  res: Response,
  error: unknown,
  options: { primaryOutcomeCommitted?: boolean } = {},
): boolean {
  if (!options.primaryOutcomeCommitted && isReadMutationFenceRefusal(error)) {
    // Task #93 line B: the read-state admission fence refused after the request-level checks (the caller or the agent
    // receiver left the Server, or the delegation no longer holds). Routes whose primary outcome already committed
    // never reach here with a refusal: their read-state side effect swallows it.
    const notFound = !("reason" in error) ? false : error.reason === "not_found";
    res.status(notFound ? 404 : 403).json({ error: error.message, code: "READ_MUTATION_FENCE_REFUSED" });
    return true;
  }
  if (!(error instanceof CompatibilityReadMutationPendingError)) return false;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", "1");
  res.status(202).json({
    code: error.code,
    status: "admitted",
    outcome: "unknown",
    ...(options.primaryOutcomeCommitted ? { primaryOutcome: "committed" } : {}),
    mutationId: error.mutationId,
    authoritySeq: error.authoritySeq,
    frontierUrl: `/api/read-mutations/frontier?mutationId=${encodeURIComponent(error.mutationId)}`,
  });
  return true;
}

// Resolve "now" from an app-level clock seam (app.set("clock", ...)) so callers
// like the joint-channel billing gate can be pinned to a deterministic instant
// in tests instead of depending on the ambient wall-clock vs TRIAL_END_DATE.
// Defaults to the real clock, so production behavior is unchanged.
function resolveNow(req: { app: { get(key: string): unknown } }): Date {
  const clock = req.app.get("clock") as { now(): Date } | undefined;
  return clock?.now() ?? new Date();
}

const CHANNEL_FILES_DEFAULT_LIMIT = 50;
const CHANNEL_FILES_MAX_LIMIT = 100;
const THREAD_SUMMARY_PARENT_IDS_MAX = 500;
// Compatibility ceiling for old web clients that call
// GET /api/channels/:id/threads without parentMessageIds. New clients should
// pass the thread-parent message ids visible in their current timeline window;
// then the route can compute summaries exactly for that window. Until every
// deployed client does that, we bound the no-param path to the most recent
// thread parents so participant/unread fanout cannot scan every thread in a
// large channel. Cleanup condition: once trace
// parent_message_scope_source=compat_recent disappears across prod clients,
// remove this fallback and require parentMessageIds.
const THREAD_SUMMARY_COMPAT_PARENT_IDS_LIMIT = 100;
const receiverStatePushWarned = new Set<string>();
const receiverStatePushHost = hostname();

type ReadAllReceiver = { kind: "human" | "agent"; id: string };

function parseReadAllReceiver(body: unknown, callerUserId: string):
  | { ok: true; receiver: ReadAllReceiver; explicit: boolean }
  | { ok: false; status: 400 | 403 } {
  if (!body || typeof body !== "object" || !("receiver" in body)) {
    return { ok: true, receiver: { kind: "human", id: callerUserId }, explicit: false };
  }
  const receiver = (body as { receiver?: unknown }).receiver;
  if (
    !receiver
    || typeof receiver !== "object"
    || Array.isArray(receiver)
    || Object.keys(receiver).some((key) => key !== "kind" && key !== "id")
  ) {
    return { ok: false, status: 400 };
  }
  const { kind, id } = receiver as { kind?: unknown; id?: unknown };
  if ((kind !== "human" && kind !== "agent") || typeof id !== "string" || !ANY_UUID_RE.test(id)) {
    return { ok: false, status: 400 };
  }
  if (kind === "human" && id !== callerUserId) {
    return { ok: false, status: 403 };
  }
  return { ok: true, receiver: { kind, id: id.toLowerCase() }, explicit: true };
}

function warnReceiverStatePushOnce(reason: "disabled" | "missing_io", payload: Record<string, unknown>): void {
  const key = `${reason}:${payload.event ?? "unknown"}`;
  if (receiverStatePushWarned.has(key)) return;
  receiverStatePushWarned.add(key);
  console.warn("[ReceiverStatePush] socket_emit_suppressed", { reason, host: receiverStatePushHost, ...payload });
}

function logReadStatePush(
  req: Request,
  state: channelService.ReadStateMutationResult,
  payload: { outcome: "no_change" | "disabled" | "missing_io" | "emitted"; enabled: boolean; io_present: boolean },
): void {
  console.info("[ReceiverStatePush] read_state_emit", {
    event: "read_state:updated",
    host: receiverStatePushHost,
    serverId: req.serverId,
    room: `user:${req.userId}`,
    scopeId: state.channelId,
    maxReadSeq: state.maxReadSeq,
    readStateVersion: state.readStateVersion,
    changed: state.changed,
    ...payload,
  });
}

function emitReadStateUpdated(req: Request, state: channelService.ReadStateMutationResult): void {
  const enabled = isReceiverStatePushEnabled();
  const io = req.app.get("io") as SocketServer | undefined;
  const ioPresent = Boolean(io);
  if (!state.changed) {
    logReadStatePush(req, state, { outcome: "no_change", enabled, io_present: ioPresent });
    return;
  }
  retractReadNotifications(req, [state]);
  if (!enabled) {
    logReadStatePush(req, state, { outcome: "disabled", enabled, io_present: ioPresent });
    warnReceiverStatePushOnce("disabled", {
      event: "read_state:updated",
      serverId: req.serverId,
      room: `user:${req.userId}`,
      scopeId: state.channelId,
      maxReadSeq: state.maxReadSeq,
      readStateVersion: state.readStateVersion,
      changed: state.changed,
      enabled,
      io_present: ioPresent,
    });
    return;
  }
  if (!io) {
    logReadStatePush(req, state, { outcome: "missing_io", enabled, io_present: ioPresent });
    warnReceiverStatePushOnce("missing_io", {
      event: "read_state:updated",
      serverId: req.serverId,
      room: `user:${req.userId}`,
      scopeId: state.channelId,
      maxReadSeq: state.maxReadSeq,
      readStateVersion: state.readStateVersion,
      changed: state.changed,
      enabled,
      io_present: ioPresent,
    });
    return;
  }
  logReadStatePush(req, state, { outcome: "emitted", enabled, io_present: ioPresent });
  io.to(`user:${req.userId}`).emit("read_state:updated", {
    serverId: req.serverId,
    scopeId: state.channelId,
    maxReadSeq: state.maxReadSeq,
    readStateVersion: state.readStateVersion,
    ...(typeof state.unreadCount === "number" ? { unreadCount: state.unreadCount } : {}),
    // Additive: present only when the scope is marked unread (absent = not marked).
    ...(state.markedUnread === true ? { markedUnread: true } : {}),
  });
}

/**
 * The read position moved forward: withdraw that conversation's notifications
 * on the reader's other devices (services/notifications/retraction.ts). Not
 * behind the receiver-state switch: it is a notification, not a state fanout.
 */
function retractReadNotifications(req: Request, scopes: readonly channelService.ReadStateMutationResult[]): void {
  if (!req.userId || !req.serverId) return;
  const advanced = scopes.filter((scope) => scope.changed && scope.markedUnread !== true);
  if (advanced.length === 0) return;
  onConversationsRead(
    req.app.get("io") as SocketServer | undefined,
    req.userId,
    req.serverId,
    advanced.map((scope) => ({ conversationId: scope.channelId, throughSeq: scope.maxReadSeq })),
  );
}

/**
 * Done moves the read position too (the sequencer's cursor + Done composite):
 * withdraw the notifications it covered, as a read does, so a notification
 * already shown and a held phone alert (isNotificationReadThrough) agree.
 */
function retractDoneNotifications(req: Request, ack: { scopes: ReadonlyArray<{ scopeId: string; maxReadSeq: number; readStateVersion: number; changed: boolean; markedUnread?: true }> } | null | undefined): void {
  if (!ack) return;
  retractReadNotifications(req, ack.scopes.map((scope) => ({
    channelId: scope.scopeId,
    maxReadSeq: scope.maxReadSeq,
    readStateVersion: scope.readStateVersion,
    changed: scope.changed,
    ...(scope.markedUnread ? { markedUnread: true } : {}),
  })));
}

function emitReadStateUpdatedBulk(req: Request, scopes: channelService.ReadStateMutationResult[]): void {
  if (scopes.length === 0) return;
  retractReadNotifications(req, scopes);
  if (!isReceiverStatePushEnabled()) {
    warnReceiverStatePushOnce("disabled", { event: "read_state:updated_bulk", serverId: req.serverId });
    return;
  }
  const io = req.app.get("io") as SocketServer | undefined;
  if (!io) {
    warnReceiverStatePushOnce("missing_io", { event: "read_state:updated_bulk", serverId: req.serverId });
    return;
  }
  io.to(`user:${req.userId}`).emit("read_state:updated_bulk", {
    serverId: req.serverId,
    scopes: scopes.map((scope) => ({
      scopeId: scope.channelId,
      maxReadSeq: scope.maxReadSeq,
      readStateVersion: scope.readStateVersion,
      ...(typeof scope.unreadCount === "number" ? { unreadCount: scope.unreadCount } : {}),
      ...(scope.markedUnread === true ? { markedUnread: true } : {}),
    })),
  });
}

function emitNotificationPrefsUpdated(
  req: Request,
  scopeId: string,
  state: channelService.InboxTargetActivityMuteState,
): void {
  if (!state.changed) return;
  if (!isReceiverStatePushEnabled()) {
    warnReceiverStatePushOnce("disabled", { event: "notification_prefs:updated", serverId: req.serverId });
    return;
  }
  const io = req.app.get("io") as SocketServer | undefined;
  if (!io) {
    warnReceiverStatePushOnce("missing_io", { event: "notification_prefs:updated", serverId: req.serverId });
    return;
  }
  io.to(`user:${req.userId}`).emit("notification_prefs:updated", {
    serverId: req.serverId,
    scopeId,
    prefs: {
      activityMuted: state.activityMuted,
      muteFromSeq: state.muteFromSeq,
    },
    prefsVersion: state.prefsVersion,
  });
}

function emitMessageDisplayPrefsUpdated(
  req: Request,
  scopeId: string,
  prefs: channelService.UserChannelMessageDisplayPrefs,
): void {
  if (!prefs.changed) return;
  if (!isReceiverStatePushEnabled()) {
    warnReceiverStatePushOnce("disabled", { event: "message_display_prefs:updated", serverId: req.serverId });
    return;
  }
  const io = req.app.get("io") as SocketServer | undefined;
  if (!io) {
    warnReceiverStatePushOnce("missing_io", { event: "message_display_prefs:updated", serverId: req.serverId });
    return;
  }
  io.to(`user:${req.userId}`).emit("message_display_prefs:updated", {
    serverId: req.serverId,
    scopeId,
    prefs: {
      collapseLongMessages: prefs.collapseLongMessages,
    },
    prefsVersion: prefs.prefsVersion,
  });
}

function parseChannelFilesLimit(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return CHANNEL_FILES_DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return CHANNEL_FILES_DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(parsed), CHANNEL_FILES_MAX_LIMIT));
}

function encodeChannelFilesCursor(file: channelService.ChannelFileEntry): string {
  return Buffer.from(JSON.stringify({ createdAt: file.createdAt, id: file.id }), "utf8").toString("base64url");
}

function parseChannelFilesCursor(raw: unknown): channelService.ChannelFilesCursor | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid_cursor");
  }
  if (
    typeof decoded !== "object"
    || decoded === null
    || typeof (decoded as { createdAt?: unknown }).createdAt !== "string"
    || typeof (decoded as { id?: unknown }).id !== "string"
  ) {
    throw new Error("invalid_cursor");
  }
  return {
    createdAt: (decoded as { createdAt: string }).createdAt,
    id: (decoded as { id: string }).id,
  };
}

function countJoinedChannels(list: readonly unknown[]): number {
  return list.filter((channel) => (
    typeof channel === "object"
    && channel !== null
    && (channel as { joined?: unknown }).joined === true
  )).length;
}

function countDmPeerType(list: readonly channelService.DMChannel[], peerType: channelService.DMChannel["peerType"]): number {
  return list.filter((channel) => channel.peerType === peerType).length;
}

function parseThreadSummaryParentMessageIds(raw: unknown): string[] | undefined | null {
  if (raw === undefined) return undefined;
  const rawValues = Array.isArray(raw) ? raw : [raw];
  const ids: string[] = [];
  for (const value of rawValues) {
    if (typeof value !== "string") return null;
    ids.push(...value.split(",").map((part) => part.trim()).filter(Boolean));
  }
  if (ids.length > THREAD_SUMMARY_PARENT_IDS_MAX) return null;
  const deduped = [...new Set(ids)];
  if (deduped.some((id) => !ANY_UUID_RE.test(id))) return null;
  return deduped;
}

function shouldExposeHumanInHiddenChannelDirectory(human: { id: string; serverSlug?: string | null; role?: string | null }, requesterId: string): boolean {
  return serverService.shouldExposeHumanInHiddenDirectory(human, requesterId);
}

function emitChannelMembersUpdated(
  io: SocketServer | undefined,
  serverId: string,
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  addedUserIds?: string | readonly string[],
) {
  const targetedUserIds = typeof addedUserIds === "string" ? [addedUserIds] : addedUserIds ?? [];
  for (const addedUserId of targetedUserIds) {
    io?.to(`user:${addedUserId}`).emit("channel:updated", { channel: { ...channel, joined: true } });
  }
  if (channel.type === "private") {
    io?.to(`channel:${channel.id}`).emit("channel:members-updated", { channelId: channel.id });
    return;
  }
  io?.to(`server:${serverId}`).emit("channel:members-updated", { channelId: channel.id });
}

type ParsedChannelMemberBatch = {
  userIds: string[];
  agentIds: string[];
};

function parseChannelMemberBatch(body: unknown): ParsedChannelMemberBatch | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { userIds = [], agentIds = [] } = body as { userIds?: unknown; agentIds?: unknown };
  if (!Array.isArray(userIds) || !Array.isArray(agentIds)) return null;
  if (
    userIds.some((id) => typeof id !== "string" || !ANY_UUID_RE.test(id))
    || agentIds.some((id) => typeof id !== "string" || !ANY_UUID_RE.test(id))
  ) {
    return null;
  }
  return {
    userIds: [...new Set(userIds as string[])],
    agentIds: [...new Set(agentIds as string[])],
  };
}

async function shouldFilterChannelHumansForRequester(
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  requesterId: string,
) {
  if (!await serverService.shouldHideHumanDirectoryFromRequester(channel.serverId, requesterId)) {
    return false;
  }
  if (channel.type === "channel") {
    return channelService.isAllSystemChannel(channel);
  }
  if (channel.type === "thread") {
    if (!channel.parentMessageId) return false;
    const parentMessage = await channelService.getMessage(channel.parentMessageId);
    if (!parentMessage) return false;
    const parentChannel = await channelService.getChannel(parentMessage.channelId);
    return parentChannel ? channelService.isAllSystemChannel(parentChannel) : false;
  }
  // Task v2: a task conversation lists its task channel's members, so it hides
  // them exactly as that channel does (a task can live in #all).
  if (channel.type === "task") {
    if (!channel.parentChannelId) return false;
    const parentChannel = await channelService.getChannel(channel.parentChannelId);
    return parentChannel ? channelService.isAllSystemChannel(parentChannel) : false;
  }
  return false;
}

// Contract v0.3 §18.7: over-limit admissions are rejected with a stable code
// the web client maps to its own copy (free-server cap vs. 30-server cap).
/**
 * A Joint Channel limit refused the request. The two Free limits are paywalls
 * (paywall_hit): too many Free servers in one channel, and a Free server's own
 * hosting limit, except when accepting an invite, where the hosting limit is
 * the host's plan, not this server's. The 30-server cap applies on every plan.
 */
function sendJointLimitError(res: Response, error: unknown, req: Request, opts: { acceptingInvite?: boolean } = {}): boolean {
  if (!(error instanceof JointChannelLimitError)) return false;
  setRequestTraceErrorCode(res, error.code);
  if (error instanceof AttributedJointChannelLimitError) setRequestTraceLimitSide(res, error.limitSide);
  if (error.code === "joint_free_server_limit") notePaywallHit(req, "joint_channel_free_cap");
  else if (error.code === "joint_channel_free_limit_reached" && !opts.acceptingInvite) notePaywallHit(req, "joint_channel_host_limit");
  res.status(403).json({
    error: error.message,
    code: error.code,
    ...(error.details.blockingChannelName ? { blockingChannel: { name: error.details.blockingChannelName } } : {}),
  });
  return true;
}

/**
 * The free plan's one external channel refused a joint invite accept (the
 * accepting server is free and already in one; its host has external
 * channels on): 409 with the body an external invite's connection answers
 * (routes/externalInvites.ts), naming whose limit it is. Also the host's own
 * send-time refusals and a person's unarchive. The free plan's refusal is a
 * paywall (paywall_hit), counted for the server whose limit it is and only
 * when the caller is its member (noteLimitPaywallHit); a full channel is not.
 */
function sendExternalLimitError(res: Response, error: unknown, req: Request): boolean {
  if (!(error instanceof ExternalChannelLimitError)) return false;
  setRequestTraceErrorCode(res, error.code);
  setRequestTraceLimitSide(res, error.limitSide);
  noteLimitPaywallHit(req, error);
  res.status(409).json({ error: error.message, code: error.code, limitSide: error.limitSide, limitServerId: error.limitServerId });
  return true;
}

function sendJointInviteValidationError(res: Response, error: unknown): boolean {
  if (!(error instanceof channelService.JointChannelInviteValidationError)) {
    return false;
  }
  res.status(400).json({
    error: error.message,
    code: error.code,
    ...(error.targetServerSlug ? { targetServerSlug: error.targetServerSlug } : {}),
    // `inviteeIndex` refers to the deduplicated/merged invitee list, so clients
    // cannot map it back to the list they submitted; send the invitee itself.
    ...(error.invitee !== undefined ? { invitee: error.invitee } : {}),
    ...(error.inviteeIndex !== undefined ? { inviteeIndex: error.inviteeIndex } : {}),
  });
  return true;
}

/** 403 body for a refused #all leave/removal: #all's audience is the whole server. */
function allChannelMembershipRefusal(msg: string): { error: string; code: string } | null {
  return msg === channelService.ALL_CHANNEL_LEAVE_MESSAGE || msg === channelService.ALL_CHANNEL_REMOVE_MEMBERS_MESSAGE
    ? { error: msg, code: "all_channel_membership_fixed" }
    : null;
}

function assertAgentCanBeRemovedFromChannel(channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>) {
  if (channelService.isAllSystemChannel(channel)) {
    throw new Error(channelService.ALL_CHANNEL_REMOVE_MEMBERS_MESSAGE);
  }
}

/**
 * Push fresh metadata to every projection of a parent joint whose over-limit
 * state a background observer just changed (sweep, billing sync), so the
 * grace banner or read-only state updates without a reload.
 */
export async function emitJointLimitStateChange(io: SocketServer | undefined, parentJointId: string) {
  if (!io) return;
  const localChannelId = await getActiveJointProjectionLocalChannelId(parentJointId);
  if (localChannelId) await emitJointProjectionUpdates(io, localChannelId);
}

export async function emitChannelConversionState(io: SocketServer | undefined, sourceChannelId: string) {
  if (!io) return;
  const channel = await channelService.getChannel(sourceChannelId);
  if (!channel) return;
  const [state] = await channelConversionService.attachLatestChannelConversionJobs(
    await channelService.attachJointChannelMetadata([channel]),
  );
  io.to(`channel:${sourceChannelId}`).emit("channel:updated", { channel: state });
}

export async function emitChannelConversionCompletion(
  io: SocketServer | undefined,
  jobId: string,
  sourceChannelId: string,
) {
  const converted = await channelService.getChannel(sourceChannelId);
  const [channelWithMetadata] = converted
    ? await channelConversionService.attachLatestChannelConversionJobs(await channelService.attachJointChannelMetadata([{ ...converted, joined: true }]))
    : [];
  if (converted && channelWithMetadata) {
    const audienceCutover = await channelConversionService.getChannelConversionAudienceCutover(jobId);
    channelConversionService.applyChannelConversionAudienceRealtimeCutover(io, audienceCutover);
    await emitJointProjectionUpdates(io, converted.id);
    // Channel-room events are shared by joined members and public readers.
    // Preserve each client's membership state rather than broadcasting joined=true.
    const { joined: _joined, ...sharedChannel } = channelWithMetadata;
    io?.to(`channel:${converted.id}`).emit("channel:updated", { channel: sharedChannel });
    await emitChannelConversionCardUpdates(io, jobId);
  }
  return { converted, channelWithMetadata };
}

async function broadcastMembershipSystemMessage(
  req: { app: { get(key: string): unknown } },
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  target: { type: "agent" | "human"; id: string; name: string },
  action: "added" | "removed",
  actorUserId: string,
  persistedMessage?: Awaited<ReturnType<typeof messageService.createMessage>>,
) {
  const io = req.app.get("io") as SocketServer | undefined;
  const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
  if (!io || !agentOrchestrator) {
    return;
  }

  const content = action === "added"
    ? `@${target.name} was added to this channel.`
    : `@${target.name} was removed from this channel.`;

  let targetAgentIds: string[] | undefined;
  if (target.type === "agent" && action === "removed" && channel.type !== "channel") {
    const remainingAgents = await channelService.getChannelAgents(channel.id);
    targetAgentIds = remainingAgents
      .filter((candidate) => candidate.id !== target.id)
      .map((candidate) => candidate.id);
  }

  const broadcast = persistedMessage
    ? messageService.broadcastSystemMessageToLocalSurfaces
    : messageService.broadcastSystemMessage;
  await broadcast(io, agentOrchestrator, channel.id, content, {
    inboxFactPolicy: {
      mode: "record",
      producer: target.type === "agent" ? "channel.agent_membership" : "channel.human_membership",
      reason: `${target.type} membership changes are shared channel activity`,
      causalActor: { type: "user", id: actorUserId },
    },
    // The human who added/removed the member should not see their own action
    // as unread in Activity.
    targetAgentIds,
    persistedMessage,
  });
}

/**
 * Tell the servers still connected that one left. Posted on the canonical
 * channel after the disconnect commits, so it reaches every remaining copy and
 * is never shown for a disconnect that rolled back.
 */
async function broadcastJointDisconnectSystemMessage(
  req: { app: { get(key: string): unknown } },
  canonicalChannelId: string,
  serverId: string,
  actorUserId: string,
  /** The host, when it disconnected the server (POST /:id/joint-servers/:serverId/disconnect). */
  byHostServerId?: string,
) {
  const io = req.app.get("io") as SocketServer | undefined;
  const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
  if (!io || !agentOrchestrator) {
    return;
  }
  const server = await serverService.getServer(serverId);
  const serverName = server?.name ?? "A server";
  const host = byHostServerId ? await serverService.getServer(byHostServerId) : null;
  await messageService.broadcastSystemMessageToLocalSurfaces(
    io,
    agentOrchestrator,
    canonicalChannelId,
    byHostServerId
      ? `${host?.name ?? "The host"} disconnected ${serverName} from this channel.`
      : `${serverName} disconnected from this channel.`,
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "channel.joint_disconnect",
        reason: "a server leaving a joint channel is shared channel activity",
        causalActor: { type: "user", id: actorUserId },
      },
    },
  );
}

async function broadcastChannelRenameSystemMessage(
  req: { app: { get(key: string): unknown } },
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  actorUserId: string,
  oldName: string,
  newName: string,
) {
  const io = req.app.get("io") as SocketServer | undefined;
  const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
  if (!io || !agentOrchestrator) {
    return;
  }

  const actor = await userService.getUser(actorUserId);
  const actorName = actor?.name ? `@${actor.name}` : actor?.displayName || "Someone";
  await messageService.broadcastSystemMessage(
    io,
    agentOrchestrator,
    channel.id,
    `${actorName} renamed this channel from #${oldName} to #${newName}.`,
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "channel.rename",
        reason: "channel rename is shared channel activity",
        causalActor: { type: "user", id: actorUserId },
      },
      // The renamer should not see their own rename as unread.
    },
  );
}

async function canSeeChannel(
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  userId: string,
  serverId: ServerId,
): Promise<boolean> {
  return channelService.canUserAccessChannel(channel.id, userId, serverId);
}

async function filterGuestInboxResult<T extends {
  items: ActivityInboxItem[];
  groups: channelService.InboxGroupCount[];
  totalCount: number;
  totalUnreadCount: number;
  activeUnreadCount: number;
}>(result: T, userId: string, serverId: ServerId): Promise<T> {
  if (await getActorServerRoleInServer(serverId, "user", userId) !== "guest") return result;
  const conversationItems = result.items.filter(isConversationInboxItem);
  const visible = await guestVisibleChannelIds([
    ...conversationItems.map(inboxItemAccessChannelId),
    ...result.groups.map((group) => group.channelId),
  ], userId, serverId);
  // Object rows were kept by the object's own visibility (services/objectActivity.ts), a guest's included.
  const items = result.items.filter((item) => !isConversationInboxItem(item) || visible.has(inboxItemAccessChannelId(item)));
  const groups = result.groups.filter((group) => visible.has(group.channelId));
  const kept = items.filter(isConversationInboxItem);
  const totalUnreadCount = kept.reduce((sum, item) => sum + item.unreadCount, 0);
  return { ...result, items, groups, totalCount: kept.length, totalUnreadCount, activeUnreadCount: totalUnreadCount };
}

/** A channel, DM, thread or task row (not an object row). */
function isConversationInboxItem(item: ActivityInboxItem): item is channelService.InboxItem {
  return item.kind !== "object";
}

/** RFC 077's facts on each conversation row's latest message; object rows as they are, in place. */
async function withLatestMessageFactsOnConversations(items: readonly ActivityInboxItem[]) {
  const withFacts = await messageService.withLatestMessageFacts(items.filter(isConversationInboxItem));
  let next = 0;
  return items.map((item) => (isConversationInboxItem(item) ? withFacts[next++]! : item));
}

async function filterGuestHistoryResult<T extends { items: channelService.InboxItem[]; totalCount: null }>(
  result: T,
  userId: string,
  serverId: ServerId,
): Promise<T> {
  if (await getActorServerRoleInServer(serverId, "user", userId) !== "guest") return result;
  const visible = await guestVisibleChannelIds(result.items.map(inboxItemAccessChannelId), userId, serverId);
  return { ...result, items: result.items.filter((item) => visible.has(inboxItemAccessChannelId(item))) };
}

function inboxItemAccessChannelId(item: channelService.InboxItem): string {
  return (item.kind === "thread" || item.kind === "task") ? item.parentChannelId : item.channelId;
}

/** The channels among these a guest can access, in one batched check. */
async function guestVisibleChannelIds(channelIds: readonly string[], userId: string, serverId: ServerId): Promise<Set<string>> {
  return channelService.filterUserAccessibleChannelIds([...new Set(channelIds)], userId, serverId);
}

/**
 * A conversion job (read, Retry, Cancel) is followed where external_channels_v1
 * is on for the Server: the flag that lets an external invite convert a
 * channel (#wg-rbac:#50; there is no separate conversion flag). Off: 404.
 */
async function requireChannelConversionEnabled(req: Request, res: Response): Promise<boolean> {
  if (await externalInviteService.externalChannelsEnabled(req.serverId!, req.userId!)) return true;
  res.status(404).json({ error: "Channel to Joint conversion is not enabled", code: "channel_to_joint_conversion_disabled" });
  return false;
}

/** The answer of a retired way of making a joint channel: 404, nothing written. */
function refuseRetiredJointEntry(res: Response,
  code: "joint_conversion_retired" | "joint_creation_retired" | "joint_server_invite_retired"): void {
  res.status(404).json({ error: "This way of sharing a channel is retired. Invite people outside the server to the channel instead.", code });
}

/**
 * With external_channels_v1 on for the Server, the old Create Joint Channel
 * does not exist (design v5.0 A1/E1; the web hides it since #12672): people
 * outside are invited to the channel instead. Answers itself (404) and
 * returns true. Following a conversion already under way (its job, Retry,
 * Cancel) stays open. Inviting another Server into an existing joint channel
 * (and re-sending those invites) is retired the same way (cindyz, #wg-rbac
 * 45b37df9); accepting an invite already sent and managing connected Servers
 * stay open. Convert to joint is retired on every Server (#wg-rbac:#50).
 */
async function refuseRetiredJointEntryWithExternalChannels(req: Request, res: Response,
  code: "joint_creation_retired" | "joint_server_invite_retired"): Promise<boolean> {
  if (!await externalInviteService.externalChannelsEnabled(req.serverId!, req.userId!)) return false;
  refuseRetiredJointEntry(res, code);
  return true;
}

// Read, Retry and Cancel resolve the same visible receipt. Mutation-specific
// capability and lifecycle checks remain with their respective handlers.
async function requireVisibleChannelConversionJob(req: Request, res: Response) {
  if (!await requireChannelConversionEnabled(req, res)) return null;
  const jobId = typeof req.params.jobId === "string" ? req.params.jobId : req.params.jobId[0];
  const job = jobId ? await channelConversionService.getChannelConversionJob(jobId) : null;
  if (!job || job.serverId !== req.serverId) {
    res.status(404).json({ error: "Conversion job not found", code: "job_not_found" });
    return null;
  }
  const source = await channelService.getChannel(job.sourceChannelId);
  if (!source || source.serverId !== req.serverId
    || !await canSeeChannel(source, req.userId!, req.serverId!)) {
    res.status(404).json({ error: "Conversion job not found", code: "job_not_found" });
    return null;
  }
  return job;
}

function countInboxItemsByKind(list: readonly ActivityInboxItem[], kind: ActivityInboxItem["kind"]): number {
  return list.filter((item) => item.kind === kind).length;
}

const INBOX_ROW_IDS_MAX = 50;

/**
 * Activity `ids` query param: comma-separated row ids (a channel/DM row's
 * channelId, a thread/task row's threadChannelId), 1..50 distinct UUIDs.
 * Undefined when absent; a string error when malformed.
 */
function parseInboxRowIdsParam(raw: unknown): string[] | undefined | { error: string } {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return { error: "ids must be a single comma-separated list" };
  const ids = [...new Set(raw.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean))];
  if (ids.length === 0) return { error: "ids must list at least one id" };
  if (ids.length > INBOX_ROW_IDS_MAX) return { error: `ids accepts at most ${INBOX_ROW_IDS_MAX} distinct ids` };
  if (ids.some((id) => !ANY_UUID_RE.test(id))) return { error: "ids must be UUIDs" };
  return ids;
}

/** An Activity scope that is one registered app's object rows (`scope=<its id>`, e.g. Activity's Artifacts filter). */
type AppInboxScope = { app: string; kinds: readonly string[] };

/**
 * Activity `scope` query param: "dms", "pinned", "saved", or the id of a registered app with object
 * kinds (that app's rows only; derived from the registry, core names no app); anything else is ignored (unscoped).
 */
function parseInboxScopeParam(raw: unknown): "dms" | "pinned" | "saved" | AppInboxScope | undefined {
  if (raw === "dms" || raw === "pinned" || raw === "saved") return raw;
  const app = typeof raw === "string" ? firstPartyApp(raw) : undefined;
  return app && app.objectKinds.length > 0 ? { app: app.id, kinds: app.objectKinds.map((entry) => entry.kind) } : undefined;
}

/**
 * Activity "Pinned" scope: the channel ids of every conversation the user
 * pinned in this server's sidebar. A channel ref pins that channel id; an
 * agent/human ref pins the user's DM(s) with that peer (resolved through
 * dm_channel_identities, removed peers included). Members whose pinned_refs
 * were never written fall back to the legacy fields the sidebar synthesizes
 * pins from. Ids the user cannot see are harmless: the Activity read only
 * restricts by this set. Lowercased, deduplicated and sorted, so the list is
 * also a stable cache-key input.
 */
async function resolvePinnedConversationChannelIds(serverId: string, userId: string): Promise<string[]> {
  const traceQuery = createTraceDbQueryTracer("inbox.pinned_scope.resolved");
  const [order, dmTargets] = await Promise.all([
    serverService.getMemberSidebarOrder(serverId, userId, { traceQuery }),
    channelService.listUserDMPinTargetsIncludingRemoved(serverId, userId, { traceQuery }),
  ]);
  if (!order) return [];
  const dmChannelIdsByPeer = new Map<string, string[]>();
  for (const target of dmTargets) {
    const key = `${target.peerType}:${target.peerId}`;
    dmChannelIdsByPeer.set(key, [...(dmChannelIdsByPeer.get(key) ?? []), target.channelId]);
  }
  const ids = new Set<string>();
  const addPeerDm = (kind: "agent" | "human", peerId: string) => {
    for (const channelId of dmChannelIdsByPeer.get(`${kind}:${peerId}`) ?? []) ids.add(channelId);
  };
  if (order.pinned) {
    for (const ref of order.pinned) {
      if (ref.kind === "channel") ids.add(ref.id);
      else addPeerDm(ref.kind, ref.id);
    }
  } else {
    // Legacy ids are channel ids (DM channel ids included) or agent ids.
    for (const id of [...order.pinnedOrder, ...order.pinnedChannelIds]) {
      ids.add(id);
      addPeerDm("agent", id);
    }
    for (const id of order.pinnedAgentIds) addPeerDm("agent", id);
  }
  return [...new Set([...ids].map((id) => id.toLowerCase()))].sort();
}

function scopeIdsCacheKey(scope: "pinned" | "saved", ids: readonly string[]): string {
  return `${scope}-${createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 16)}`;
}

const EMPTY_SCOPED_INBOX_RESULT = {
  items: [] as channelService.InboxItem[],
  groups: [] as channelService.InboxGroupCount[],
  hasMore: false,
  totalCount: 0,
  totalUnreadCount: 0,
  activeUnreadCount: 0,
};

function parseChannelVisibility(raw: unknown): "public" | "private" | "joint" | null {
  if (raw === undefined || raw === "public") return "public";
  if (raw === "private" || raw === "joint") return raw;
  return null;
}

function normalizeStringList(raw: unknown, maxItems?: number): string[] {
  if (!Array.isArray(raw)) return [];
  if (maxItems !== undefined && raw.length > maxItems) {
    throw new channelService.JointChannelInviteValidationError(
      `A joint channel invite can include a maximum of ${maxItems} invited people per target server`,
      "joint_invite_limit_exceeded",
    );
  }
  return [...new Set(raw.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

function parseJointInviteRequests(raw: {
  targetServerSlug?: unknown;
  invitedPeople?: unknown;
  sameAdmin?: unknown;
  jointInvites?: unknown;
}): channelService.JointInviteRequest[] {
  const rawRequests = Array.isArray(raw.jointInvites) && raw.jointInvites.length > 0
    ? raw.jointInvites.slice(0, channelService.MAX_JOINT_CHANNEL_INVITE_TARGETS + 1).map((request) => {
        const input = request && typeof request === "object"
          ? request as { targetServerSlug?: unknown; invitedPeople?: unknown; sameAdmin?: unknown }
          : {};
        return {
          targetServerSlug: typeof input.targetServerSlug === "string" ? input.targetServerSlug.trim() : "",
          invitedPeople: normalizeStringList(input.invitedPeople, channelService.MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET),
          sameAdmin: input.sameAdmin === true,
        };
      })
    : [{
        targetServerSlug: typeof raw.targetServerSlug === "string" ? raw.targetServerSlug.trim() : "",
        invitedPeople: normalizeStringList(raw.invitedPeople, channelService.MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET),
        sameAdmin: raw.sameAdmin === true,
      }];
  if (rawRequests.length > channelService.MAX_JOINT_CHANNEL_INVITE_TARGETS) {
    throw new channelService.JointChannelInviteValidationError(
      `Joint channels support a maximum of ${MAX_JOINT_CHANNEL_SERVERS} servers`,
      "joint_invite_limit_exceeded",
    );
  }

  return rawRequests;
}

/**
 * Joint invites spend the inviter's hourly budget of invited people
 * (jointInviteRateLimit), refused ones included. Answers 429 and returns false
 * once it is spent.
 */
async function admitJointInviteOrRefuse(req: Request, res: Response, people: number): Promise<boolean> {
  const admission = await admitJointInvite(req.userId!, people);
  if (admission.admitted) return true;
  res.setHeader("Retry-After", String(admission.retryAfterSeconds));
  res.status(429).json({
    error: "Too many joint channel invites. Try again later.",
    code: "joint_invite_rate_limited",
    retryAfterSeconds: admission.retryAfterSeconds,
  });
  return false;
}

// List all channels (excludes DMs), includes `joined` status for the requesting user.
// Supports `?archived=exclude|include|only` (default: exclude).
channelRouter.get("/", async (req, res) => {
  try {
    const raw = typeof req.query.archived === "string" ? req.query.archived : undefined;
    let archived: channelService.ArchivedFilter | undefined;
    if (raw === undefined) archived = undefined;
    else if (raw === "exclude" || raw === "include" || raw === "only") archived = raw;
    else {
      res.status(400).json({ error: "archived must be one of: exclude, include, only" });
      return;
    }
    const archivedFilter = archived ?? "exclude";
    addTraceEvent("channels.list.started", {
      archived_filter: archivedFilter,
    });
    const list = await tracePhase(
      () => loadHumanChannelList(req.serverId!, req.userId!, {
        archived,
        traceQuery: createTraceDbQueryTracer("channels.loaded"),
      }),
      (durationMs, result) => ({
        name: "channels.loaded",
        attrs: {
          archived_filter: archivedFilter,
          channels_count: result.length,
          joined_channels_count: countJoinedChannels(result),
          archived_channels_count: result.filter((channel) => channel.archivedAt !== null).length,
        },
      }),
    );
    addTraceEvent("response.ready", {
      archived_filter: archivedFilter,
      channels_count: list.length,
      joined_channels_count: countJoinedChannels(list),
    });
    // Items carry notificationLevel (finishHumanChannelListItems, shared with sync).
    res.json(await finishHumanChannelListItems(list, req.serverId!, req.userId!));
  } catch {
    res.status(500).json({ error: "Failed to list channels" });
  }
});

// List DM channels
channelRouter.get("/dm", async (req, res) => {
  try {
    addTraceEvent("dm_channels.list.started");
    const list = await tracePhase(
      async () => {
        return channelService.listDMChannels(req.serverId!, req.userId!, {
          traceQuery: createTraceDbQueryTracer("dm_channels.loaded"),
        });
      },
      (durationMs, result) => ({
        name: "dm_channels.loaded",
        attrs: {
          dm_channels_count: result.length,
          agent_dm_channels_count: countDmPeerType(result, "agent"),
          user_dm_channels_count: countDmPeerType(result, "user"),
        },
      }),
    );
    addTraceEvent("response.ready", {
      dm_channels_count: list.length,
      agent_dm_channels_count: countDmPeerType(list, "agent"),
      user_dm_channels_count: countDmPeerType(list, "user"),
    });
    res.json(await withNotificationLevels(req.userId!, list));
  } catch {
    res.status(500).json({ error: "Failed to list DM channels" });
  }
});

// Find or create DM — accepts { agentId } for agent-DM or { userId } for user-DM
channelRouter.post("/dm", async (req, res) => {
  try {
    const { agentId, userId } = req.body;
    if (!agentId && !userId) {
      res.status(400).json({ error: "Either agentId or userId is required" });
      return;
    }
    if (agentId && userId) {
      res.status(400).json({ error: "Cannot provide both agentId and userId" });
      return;
    }

    // The same rules as an assistant sending as its owner to a new DM (RFC 077 `dmWith`).
    const opened = await openDirectMessageForUser(req.serverId!, req.userId!, agentId ? { agentId } : { userId });
    if (!opened.ok) {
      res.status(opened.status).json({ error: opened.error, code: opened.code });
      return;
    }
    const channel = opened.channel;
    if (!channel) {
      res.json(null);
      return;
    }
    // As GET /:id: the client replaces its DM row with this response, so an
    // existing DM keeps its mute state.
    const [activityMuteState, activityMuteSupported] = await Promise.all([
      channelService.getInboxTargetActivityMuteState("user", req.userId!, channel.id),
      channelService.userActivityMuteSupported(channel),
    ]);
    res.json({
      ...channel,
      activityMuted: activityMuteState.activityMuted,
      muteFromSeq: activityMuteState.muteFromSeq,
      prefsVersion: activityMuteState.prefsVersion,
      activityMuteSupported,
    });
  } catch (err: any) {
    sendJsonServerError(req, res, {
      error: "Failed to create DM",
      logPrefix: "Failed to create DM:",
      err,
    });
  }
});

// Create channel
channelRouter.post("/", async (req, res) => {
  try {
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "createChannels"))) {
      res.status(403).json({ error: "You do not have permission to create channels" });
      return;
    }
    const { name, description, visibility, agentIds, userIds, targetServerSlug, invitedPeople, sameAdmin, jointInvites, actionCardMessageId, actionCardConfirmationVersion } = req.body;
    const parsedVisibility = parseChannelVisibility(visibility);
    if (parsedVisibility === null) {
      res.status(400).json({ error: "visibility must be one of: public, private, joint" });
      return;
    }
    const channelType: channelService.RegularChannelType = parsedVisibility === "private" ? "private" : "channel";
    if (parsedVisibility === "joint" && await refuseRetiredJointEntryWithExternalChannels(req, res, "joint_creation_retired")) return;
    const selectedJointInviteRequests = parseJointInviteRequests({ targetServerSlug, invitedPeople, sameAdmin, jointInvites });
    if (parsedVisibility === "joint" && !await admitJointInviteOrRefuse(
      req,
      res,
      selectedJointInviteRequests.reduce((sum, request) => sum + request.invitedPeople.length, 0),
    )) return;
    const nameError = validateName(name, "Channel name");
    if (nameError) {
      res.status(400).json({ error: nameError });
      return;
    }
    if (typeof name === "string" && name.trim() === "all") {
      res.status(400).json({ error: 'Channel name "all" is reserved' });
      return;
    }
    if (parsedVisibility === "joint" && selectedJointInviteRequests.some((request) => !request.targetServerSlug)) {
      res.status(400).json({ error: "Invite server slug is required" });
      return;
    }
    if (parsedVisibility === "joint" && (
      selectedJointInviteRequests.length === 0
      || selectedJointInviteRequests.some((request) => request.invitedPeople.length === 0)
    )) {
      res.status(400).json({ error: "At least one invited person is required" });
      return;
    }
    if (description && (typeof description !== "string" || description.length > 500)) {
      res.status(400).json({ error: "Description must be a string of at most 500 characters" });
      return;
    }
    const selectedAgentIds = Array.isArray(agentIds) ? [...new Set(agentIds.filter((id): id is string => typeof id === "string"))] : [];
    const selectedUserIds = Array.isArray(userIds) ? [...new Set(userIds.filter((id): id is string => typeof id === "string"))] : [];
    if (
      parsedVisibility === "joint"
      && !(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "federateChannels"))
    ) {
      res.status(403).json({ error: "You do not have permission to federate channels" });
      return;
    }
    // Creation is the one add-member bootstrap: the creator and all selected
    // initial members are committed together after target validation below.
    // Do not apply the existing-channel add policy before the creator's local
    // admin membership exists.
    for (const agentId of selectedAgentIds) {
      const agent = await agentService.getAgent(agentId);
      // Only its owner finds a personal assistant; for anyone else it is
      // answered exactly as an id that names no agent here.
      if (!agent || agent.serverId !== req.serverId || isOthersAssistant(agent, req.userId!)) {
        res.status(400).json({ error: "Agent not found in this server" });
        return;
      }
    }
    for (const userId of selectedUserIds) {
      const role = await getActorServerRoleInServer(req.serverId!, "user", userId);
      if (!role) {
        res.status(400).json({ error: "User is not a member of this server" });
        return;
      }
    }
    let channel: Awaited<ReturnType<typeof channelService.createChannel>>;
    let createdJointInvites: unknown[] = [];
    let sameAdminProjections: channelService.SameAdminAcceptedProjection[] = [];
    if (parsedVisibility === "joint") {
      const result = await channelService.createJointChannel({
        hostServerId: req.serverId!,
        createdByUserId: req.userId!,
        name: name.trim(),
        description,
        userIds: selectedUserIds,
        agentIds: selectedAgentIds,
        jointInvites: selectedJointInviteRequests,
        now: resolveNow(req),
      });
      channel = result.channel;
      createdJointInvites = result.invites;
      sameAdminProjections = result.acceptedProjections;
    } else {
      channel = await channelService.createChannel(
        req.serverId!,
        name.trim(),
        description,
        channelType,
        {
          type: "user",
          id: req.userId!,
          initialUserIds: selectedUserIds,
          initialAgentIds: selectedAgentIds,
          actionCardMessageId: typeof actionCardMessageId === "string" ? actionCardMessageId : undefined,
          actionCardConfirmationVersion: typeof actionCardConfirmationVersion === "number" ? actionCardConfirmationVersion : undefined,
        },
      );
    }
    const [channelWithMetadata] = await channelService.attachJointChannelMetadata([{ ...channel, joined: true }]);
    const io = req.app.get("io") as SocketServer | undefined;
    await publishChannelUpdate(io, channelWithMetadata);
    if (sameAdminProjections.length > 0) {
      await emitJointProjectionUpdates(io, channel.id);
      await emitSameAdminJointProjections(io, req.userId!, sameAdminProjections);
    }
    const activityMuteSupported = channelTypeSupportsActivityMute(channel.type);
    const rawActivityMuteState = activityMuteSupported
      ? await channelService.getInboxTargetActivityMuteState("user", req.userId!, channel.id)
      : null;
    const activityMuteState = rawActivityMuteState
      ? {
          activityMuted: rawActivityMuteState.activityMuted,
          muteFromSeq: rawActivityMuteState.muteFromSeq,
          prefsVersion: rawActivityMuteState.prefsVersion,
        }
      : {};
    const readState = await channelService.getReadStateSnapshot(req.userId!, channel.id);
    const peerReadHydrate = channel.type === "channel" || channel.type === "private" || channel.type === "joint" || channel.type === "dm"
      ? await getPeerReadHydrate({
          serverId: req.serverId!,
          channelId: channel.id,
          viewerKind: "human",
          viewerId: req.userId!,
        })
      : null;
    res.json({
      ...await attachHumanChannelAuthorization(channelWithMetadata, req.serverId!, req.userId!),
      ...activityMuteState,
      ...readState,
      ...(peerReadHydrate ?? {}),
      activityMuteSupported,
      jointInvites: createdJointInvites,
      jointInvite: createdJointInvites[0] ?? null,
    });
  } catch (err: any) {
    if (err instanceof channelService.ArchivedNameCollisionError) {
      res.status(409).json(await humanArchivedNameCollisionBody(req, err));
      return;
    }
    if (sendJointInviteValidationError(res, err)) return;
    if (sendJointLimitError(res, err, req)) return;
    // The creator's account retired or being deleted meanwhile (createJointChannel): as one who may not federate.
    if (err instanceof JointActorUnavailableError) {
      res.status(403).json({ error: "You do not have permission to federate channels" });
      return;
    }
    const msg = err?.message || "";
    if (isActionCardConversionError(err)) {
      // The source action card is frozen or needs reconfirmation: an expected 409, not a server fault.
      res.status(err.status).json({ error: err.message, code: err.code });
    } else if (msg.includes("already taken")) {
      res.status(409).json({ error: msg });
    } else if (msg.includes("Channel limit reached")) {
      res.status(403).json({ error: msg });
    } else if (msg.includes("requires the Pro plan")) {
      res.status(403).json({ error: msg });
    } else {
      sendJsonServerError(req, res, {
        error: "Failed to create channel",
        code: "internal_server_error",
        logPrefix: "[Channels] Failed to create channel",
        err,
      });
    }
  }
});

/**
 * A same-admin accept (RFC 075 §4.5) creates the target server's projection in
 * the inviting request. Like a link accept, the new projection goes only to the
 * inviter's sockets on that server; the caller refreshes existing projections
 * with emitJointProjectionUpdates.
 */
async function emitSameAdminJointProjections(
  io: SocketServer | undefined,
  userId: string,
  projections: readonly channelService.SameAdminAcceptedProjection[],
) {
  if (!io || projections.length === 0) return;
  const projectionsWithMetadata = await channelService.attachJointChannelMetadata(
    projections.map((projection) => ({ ...projection, joined: true })),
  );
  for (const channel of projectionsWithMetadata) {
    io.to(socketUserServerRoom(userId, channel.serverId)).emit("channel:updated", { channel });
  }
}

// Owners and admins see every joint copy their server holds, including ones
// none of them is a member of, so an orphaned copy can still be disconnected.
// Metadata only (#raft-architecture task #22).
channelRouter.get("/joint-connections", async (req, res) => {
  try {
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "federateChannels"))) {
      res.status(403).json({ error: "Only admins can manage joint channel connections" });
      return;
    }
    const connections = await channelService.listServerJointConnections(req.serverId!, req.userId!);
    res.json({ connections });
  } catch {
    res.status(500).json({ error: "Failed to list joint channel connections" });
  }
});

// Whether this Server's owner/admin may start another external channel
// (Create Channel's External): 404 while external_channels_v1 is off for it.
channelRouter.get("/external-availability", async (req, res) => {
  try {
    const flag = await evaluateFeatureFlag({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId: req.serverId!, userId: req.userId! });
    if (!flag.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(await externalInviteService.getExternalChannelAvailability(req.serverId!, req.userId!));
  } catch (err) {
    sendExternalInviteError(req, res, err, "read external channel availability");
  }
});

// "Your servers" (Create Channel's External, Invite People Outside): the
// servers this Server's owner/admin owns or administers that could connect
// to one of its channels. 404 while external_channels_v1 is off for it.
channelRouter.get("/external-connect-servers", async (req, res) => {
  try {
    const flag = await evaluateFeatureFlag({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId: req.serverId!, userId: req.userId! });
    if (!flag.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ servers: await externalInviteService.listOwnConnectableServers(req.serverId!, req.userId!) });
  } catch (err) {
    sendExternalInviteError(req, res, err, "list servers to connect");
  }
});

channelRouter.get("/joint-invites", async (req, res) => {
  try {
    const invites = await channelService.listPendingJointChannelInvites(req.serverId!, req.userId!);
    res.json({ invites });
  } catch {
    res.status(500).json({ error: "Failed to list joint channel invites" });
  }
});

// One user-selected connection operation: sources are frozen before the first
// accept, so a new member may have every selected source without later accepts
// silently adding sources to an existing member.
channelRouter.post("/joint-invites/accept-many",async(req,res)=>{
  try {
    const inviteIds=req.body?.inviteIds;
    if(!Array.isArray(inviteIds) || inviteIds.length===0 || inviteIds.length>=MAX_JOINT_CHANNEL_SERVERS
      || inviteIds.some((id:unknown)=>typeof id!=="string" || !channelService.isJointChannelInviteId(id))) {
      res.status(400).json({error:"Select valid joint invitations"});return;
    }
    const channels=await channelService.acceptJointChannelInvites({inviteIds,acceptedByUserId:req.userId!});
    const projected=await channelService.attachJointChannelMetadata(channels.map(channel=>({...channel,joined:true})));
    const io=req.app.get("io") as SocketServer|undefined;
    if(channels[0]) await emitJointProjectionUpdates(io,channels[0].id);
    for(const channel of projected) io?.to(socketUserServerRoom(req.userId!,channel.serverId)).emit("channel:updated",{channel});
    const orchestrator=req.app.get("agentOrchestrator") as AgentOrchestrator|undefined;
    if(io && orchestrator && channels[0]) {
      const servers = await serverService.getServersByIds(channels.map(channel => channel.serverId));
      const serverNames = new Map(servers.map(server => [server.id, server.name]));
      const names = channels.map(channel => serverNames.get(channel.serverId) ?? "A server").join(", ");
      await messageService.broadcastSystemMessageToLocalSurfaces(io,orchestrator,channels[0].id,`${names} connected to this channel.`,{
        inboxFactPolicy:{mode:"record",producer:"channel.joint_connect",reason:"one multi-server connection operation",
          causalActor:{type:"user",id:req.userId!}},
      });
    }
    res.json({channels:projected});
  } catch(error) {
    if(sendJointLimitError(res,error,req,{acceptingInvite:true}) || sendExternalLimitError(res,error,req)) return;
    if(error instanceof channelService.JointChannelArchivedError){res.status(409).json({error:error.message,code:error.code});return;}
    const message=error instanceof Error?error.message:"Failed to accept joint invitations";
    res.status(message.includes("not found")?404:message.includes("Only target server admins")?403:409).json({error:message});
  }
});

channelRouter.post("/joint-invites/:inviteId/accept", async (req, res) => {
  try {
    if (!channelService.isJointChannelInviteId(req.params.inviteId)) {
      res.status(404).json({ error: "Joint channel invite not found" });
      return;
    }
    const channel = await channelService.acceptJointChannelInvite({
      inviteId: req.params.inviteId,
      targetServerId: req.serverId!,
      acceptedByUserId: req.userId!,
    });
    const [channelWithMetadata] = await channelService.attachJointChannelMetadata([{ ...channel, joined: true }]);
    const io = req.app.get("io") as SocketServer | undefined;
    await emitJointProjectionUpdates(io, channel.id);
    // Only this server's sockets: the user room also reaches their other
    // servers, which would list this server's row as a duplicate.
    io?.to(socketUserServerRoom(req.userId!, req.serverId!)).emit("channel:updated", { channel: channelWithMetadata });
    res.json(channelWithMetadata);
  } catch (err: any) {
    if (sendJointLimitError(res, err, req, { acceptingInvite: true }) || sendExternalLimitError(res, err, req)) return;
    if (err instanceof channelService.JointChannelArchivedError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    const msg = err?.message || "";
    if (msg.includes("not found")) {
      res.status(404).json({ error: msg });
    } else if (msg.includes("Only target server admins")) {
      res.status(403).json({ error: msg });
    } else if (msg.includes("expired") || msg.includes("already taken") || msg.includes("already in this joint channel")) {
      res.status(409).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to accept joint channel invite" });
    }
  }
});

// Get unread counts for all channels in this server (must be before /:id)
channelRouter.get("/unread", async (req, res) => {
  try {
    addTraceEvent("unread_counts.load.started");
    const wantsSummary = req.query.summary === "1";
    const { value: body, stale, staleReason, traceAttrs: staleTraceAttrs } = await readWithStaleOnOverload({
      surface: wantsSummary ? "channels_unread_summary" : "channels_unread",
      userId: req.userId!,
      scope: req.serverId!,
      load: async () => {
        const loaded = wantsSummary
          ? await tracePhase(
            () => channelService.getUnreadSummary(req.serverId!, req.userId!, {
              traceQuery: createTraceDbQueryTracer("unread_counts.loaded"),
            }),
            (durationMs, result) => ({
              name: "unread_counts.loaded",
              attrs: {
                unread_channels_count: Object.keys(result).length,
                response_summary: wantsSummary,
              },
            }),
          )
          : await tracePhase(
            () => channelService.getUnreadCounts(req.serverId!, req.userId!, {
              traceQuery: createTraceDbQueryTracer("unread_counts.loaded"),
            }),
            (durationMs, result) => ({
              name: "unread_counts.loaded",
              attrs: {
                unread_channels_count: Object.keys(result).length,
                response_summary: wantsSummary,
              },
            }),
          );
        return wantsSummary
          ? {
            channels: loaded,
            threadUnread: channelService.summarizeThreadUnreadByParent(
              loaded as Record<string, channelService.ChannelUnreadSummaryEntry>,
            ),
          }
          : loaded;
      },
    });
    const channelsLoaded = wantsSummary ? (body as { channels: Record<string, unknown> }).channels : body;
    addTraceEvent("response.ready", {
      unread_channels_count: Object.keys(channelsLoaded).length,
      response_summary: wantsSummary,
      stale_served: stale,
      ...staleTraceAttrs,
    });
    if (stale) res.setHeader(STALE_RESPONSE_HEADER, staleReason ?? "rw_overloaded");
    // The bare count map is keyed by channel id, so it cannot carry a body
    // flag; the header marks it. The summary also says so in the body.
    res.json(stale && wantsSummary ? { ...(body as object), stale: true } : body);
  } catch (err) {
    if (respondToRisingWaveUnavailable(err, res)) return;
    res.status(500).json({ error: "Failed to get unread counts" });
  }
});

// Unified Inbox: regular channels, DMs, and followed threads that are not done.
channelRouter.get("/inbox", async (req, res) => {
  addTraceEvent("activity.list.fetch", {
    ...activityListFetchTraceAttrs("inbox", req.headers[CHANNEL_FETCH_REASON_HEADER], req.query.ids),
    // #triage:#229: the realtime event behind a realtime_fallback re-read.
    ...inboxFetchTriggerTraceAttrs(req.headers[INBOX_FETCH_TRIGGER_HEADER], req.headers[INBOX_FETCH_COALESCED_HEADER]),
  });
  const admission = getInboxRouteBackpressureAdmission(res);
  if (!admission) {
    throw new Error("Inbox route backpressure admission is missing");
  }
  try {
    const filterParam = req.query.filter;
    const filter: "all" | "unread" | "mentions" | "unread_mentions" =
      filterParam === "unread" || filterParam === "mentions" || filterParam === "unread_mentions"
        ? filterParam
        : "all";
    const offset = parseOffsetQueryParam(req.query.offset);
    const channelIdParam = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
    const channelId = channelIdParam && ANY_UUID_RE.test(channelIdParam) ? channelIdParam : undefined;
    const qParam = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const q = qParam || undefined;
    // `ids`: refresh just these rows (after a sync `conversation` change), with
    // the list's row shape and visibility. Not a list: the response is
    // `{ items }` only (no totals, groups, unread counts or hasMore), so a
    // client cannot mistake it for list-level state.
    const rowIds = parseInboxRowIdsParam(req.query.ids);
    if (rowIds && !Array.isArray(rowIds)) {
      res.status(400).json({ error: rowIds.error });
      return;
    }
    if (rowIds && (channelIdParam !== undefined || q || req.query.scope !== undefined || offset > 0 || (filterParam !== undefined && filterParam !== "all"))) {
      res.status(400).json({ error: "ids cannot be combined with channelId, q, scope, offset or a filter other than all" });
      return;
    }
    const limit = rowIds ? rowIds.length : Math.min(Number(req.query.limit) || 30, 100);
    const sort = req.query.sort === "asc" ? "asc" as const : "desc" as const;
    const scopeParam = parseInboxScopeParam(req.query.scope);
    const scope = scopeParam === "dms" ? "dms" as const : undefined;
    const pinnedChannelIds = scopeParam === "pinned"
      ? await resolvePinnedConversationChannelIds(req.serverId!, req.userId!)
      : undefined;
    // Saved: the threads followed through a save, as the rows' own ids (the
    // `ids` restriction), so each read source narrows rows, totals and paging.
    const savedThreadChannelIds = scopeParam === "saved"
      ? await savedService.listSavedFollowThreadChannelIds(req.userId!, req.serverId!)
      : undefined;
    addTraceEvent("inbox.load.started", {
      filter,
      limit,
      offset,
      channel_id_present: Boolean(channelId),
      query_present: Boolean(q),
      scope: typeof scopeParam === "object" ? scopeParam.app : scopeParam ?? "all",
      ...(pinnedChannelIds ? { pinned_channel_count: pinnedChannelIds.length } : {}),
      ...(savedThreadChannelIds ? { saved_thread_count: savedThreadChannelIds.length } : {}),
      ...(rowIds ? { row_id_count: rowIds.length } : {}),
    });
    if (pinnedChannelIds?.length === 0 || savedThreadChannelIds?.length === 0) {
      // Nothing pinned / saved: the scope is empty by definition; skip the read model.
      addTraceEvent("response.ready", {
        filter,
        inbox_items_count: 0,
        total_count: 0,
        ...(pinnedChannelIds ? { pinned_channel_count: 0 } : { saved_thread_count: 0 }),
      });
      res.json(EMPTY_SCOPED_INBOX_RESULT);
      return;
    }
    // Only the first page without a search: the view a fresh load opens on.
    const load = async () => {
      const plan = await tracePhase(
        () => getServerPlan(req.serverId!),
        (durationMs, result) => ({
          name: "history.policy.checked",
          attrs: {
            plan: result,
          },
        }),
      );
      const historyCutoff = getHistoryCutoff(plan);
      const reader = { userId: req.userId!, serverId: req.serverId!, sessionFamilyId: req.sessionFamilyId ?? null };
      const loadedResult = await tracePhase(
        // An app's filter (`scope=<app id>`, e.g. Artifacts): that app's object rows only, none for a search or
        // a channel (object rows aren't searched). Otherwise object rows merged in while an object app is on for
        // the server; else exactly getInboxItems.
        async (): Promise<ActivityInboxResult> => {
          if (typeof scopeParam === "object") {
            return q || channelId
              ? EMPTY_SCOPED_INBOX_RESULT
              : getObjectKindInboxItems(reader, scopeParam.kinds, { filter, limit, offset, sort, historyCutoff });
          }
          return getActivityInboxItems(reader, {
            filter,
            limit,
            offset,
            channelId,
            q,
            scope,
            pinnedChannelIds,
            // `ids` within Saved: both restrictions hold, as `ids` within Pinned.
            rowIds: savedThreadChannelIds && rowIds
              ? rowIds.filter((id) => savedThreadChannelIds.includes(id))
              : rowIds ?? savedThreadChannelIds,
            sort,
            historyCutoff,
            includeUnfollowedThreads: filter === "all",
            traceQuery: createTraceDbQueryTracer("inbox.loaded"),
            });
        },
        (durationMs, loaded) => ({
          name: "inbox.loaded",
          attrs: {
            filter,
            limit,
            offset,
            channel_id_present: Boolean(channelId),
            query_present: Boolean(q),
            history_cutoff_present: Boolean(historyCutoff),
            inbox_items_count: loaded.items.length,
            total_count: loaded.totalCount,
            total_unread_count: loaded.totalUnreadCount,
            active_unread_count: loaded.activeUnreadCount,
            channel_items_count: countInboxItemsByKind(loaded.items, "channel"),
            dm_items_count: countInboxItemsByKind(loaded.items, "dm"),
            thread_items_count: countInboxItemsByKind(loaded.items, "thread"),
            task_items_count: countInboxItemsByKind(loaded.items, "task"),
            object_items_count: countInboxItemsByKind(loaded.items, "object"),
            has_more: loaded.hasMore,
          },
        }),
      );
      const filtered = await filterGuestInboxResult(loadedResult, req.userId!, req.serverId!);
      // RFC 077: the "sent by an assistant for its owner" label on each row's latest message.
      return { ...filtered, items: await withLatestMessageFactsOnConversations(filtered.items) };
    };
    // An ids read is never served from the first-page cache: it must be fresh.
    // Uncached, a RisingWave overload still answers the standard 503 (catch below).
    const { value: result, stale, staleReason, traceAttrs: staleTraceAttrs } = offset === 0 && !q && !rowIds
      ? await readWithStaleOnOverload({
        surface: "inbox_first_page",
        userId: req.userId!,
        scope: [
          req.serverId!,
          filter,
          limit,
          sort,
          pinnedChannelIds
            ? scopeIdsCacheKey("pinned", pinnedChannelIds)
            : savedThreadChannelIds ? scopeIdsCacheKey("saved", savedThreadChannelIds) : typeof scopeParam === "object" ? `app:${scopeParam.app}` : scope ?? "",
          channelId ?? "",
        ].join(":"),
        load,
        softTimeoutMs: resolveSoftTimeoutMs(),
      })
      : { value: await load(), stale: false, staleReason: undefined, traceAttrs: {} };
    if (stale) res.setHeader(STALE_RESPONSE_HEADER, staleReason ?? "rw_overloaded");
    addTraceEvent("response.ready", {
      filter,
      channel_id_present: Boolean(channelId),
      query_present: Boolean(q),
      inbox_items_count: result.items.length,
      total_count: result.totalCount,
      total_unread_count: result.totalUnreadCount,
      active_unread_count: result.activeUnreadCount,
      has_more: result.hasMore,
      stale_served: stale,
      ...staleTraceAttrs,
    });
    if (rowIds) {
      res.json({ items: result.items });
      return;
    }
    res.json(stale ? { ...result, stale: true } : result);
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to get inbox",
      logPrefix: "Failed to get inbox:",
      err,
      risingWaveUnconfiguredAs503: true,
    });
  } finally {
    admission.release();
  }
});

// Durable Done history for Activity v2. Kept out of the active Inbox serving
// contract so rollout can be feature-gated without changing legacy clients.
channelRouter.get("/inbox/done", async (req, res) => {
  addTraceEvent("activity.list.fetch", activityListFetchTraceAttrs("done", req.headers[CHANNEL_FETCH_REASON_HEADER]));
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const offset = parseOffsetQueryParam(req.query.offset);
    const channelIdParam = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
    const channelId = channelIdParam && ANY_UUID_RE.test(channelIdParam) ? channelIdParam : undefined;
    const qParam = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const q = qParam || undefined;
    const sort = req.query.sort === "asc" ? "asc" as const : "desc" as const;
    const plan = await getServerPlan(req.serverId!);
    const loadedResult = await channelService.getDoneInboxItems(req.serverId!, req.userId!, {
      limit,
      offset,
      channelId,
      q,
      sort,
      historyCutoff: getHistoryCutoff(plan),
      traceQuery: createTraceDbQueryTracer("done_inbox.loaded"),
    });
    res.json(await filterGuestHistoryResult(loadedResult, req.userId!, req.serverId!));
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to get Done history",
      logPrefix: "Failed to get Done history:",
      err,
    });
  }
});

// Compatibility history for clients that still request explicit unfollows.
// Activity All now includes not-Done unfollowed rows directly, while this
// endpoint retains the frozen history projection across completion states.
channelRouter.get("/inbox/unfollowed", async (req, res) => {
  addTraceEvent("activity.list.fetch", activityListFetchTraceAttrs("unfollowed", req.headers[CHANNEL_FETCH_REASON_HEADER]));
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const offset = parseOffsetQueryParam(req.query.offset);
    const channelIdParam = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
    const channelId = channelIdParam && ANY_UUID_RE.test(channelIdParam) ? channelIdParam : undefined;
    const qParam = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const q = qParam || undefined;
    const sort = req.query.sort === "asc" ? "asc" as const : "desc" as const;
    const scopeParam = parseInboxScopeParam(req.query.scope);
    const pinnedChannelIds = scopeParam === "pinned"
      ? await resolvePinnedConversationChannelIds(req.serverId!, req.userId!)
      : undefined;
    // Saved lists followed threads only: it has no unfollowed rows.
    if (pinnedChannelIds?.length === 0 || scopeParam === "saved" || typeof scopeParam === "object") {
      res.json({ items: [], hasMore: false, totalCount: null });
      return;
    }
    const plan = await getServerPlan(req.serverId!);
    const loadedResult = await channelService.getUnfollowedInboxItems(req.serverId!, req.userId!, {
      limit,
      offset,
      channelId,
      pinnedChannelIds,
      q,
      sort,
      historyCutoff: getHistoryCutoff(plan),
      traceQuery: createTraceDbQueryTracer("unfollowed_inbox.loaded"),
    });
    res.json(await filterGuestHistoryResult(loadedResult, req.userId!, req.serverId!));
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to get unfollowed Activity history",
      logPrefix: "Failed to get unfollowed Activity history:",
      err,
    });
  }
});

channelRouter.post("/inbox/done", noteInboxWriteBeforeReply, async (req, res) => {
  try {
    const { channelId, throughActivitySeq, frontierSpace: requestedFrontierSpace } = req.body;
    if (!channelId) {
      res.status(400).json({ error: "channelId is required" });
      return;
    }
    // Adjudicated compatibility matrix (keep this explicit rather than hiding
    // it behind a display-to-storage mapper): omitted value => the existing
    // canonical snapshot, with or without an explicit storage identity;
    // value without identity => refresh-required 412; unsupported identity =>
    // 400; storage value => the unchanged strict guard below.
    if (requestedFrontierSpace === undefined && throughActivitySeq !== undefined) {
      res.status(412).json({
        error: "frontierSpace is required; refresh and retry",
        code: "DONE_FRONTIER_SPACE_REQUIRED",
      });
      return;
    }
    if (requestedFrontierSpace !== undefined && requestedFrontierSpace !== "storage") {
      res.status(400).json({
        error: "frontierSpace must be storage",
        code: "DONE_FRONTIER_UNMAPPABLE",
      });
      return;
    }
    const channel = await channelService.getChannel(channelId);
    if (!channel || isSubConversationType(channel.type)) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const canonicalServerId = channel.serverId as ServerId;
    // This item may belong to a server other than the active request server;
    // resolve its canonical membership before applying conversation policy.
    const isCanonicalServerMember = await serverService.isMember(canonicalServerId, req.userId!);
    if (!isCanonicalServerMember) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const canAccess = await channelService.canUserAccessChannel(channelId, req.userId!, canonicalServerId);
    if (!canAccess) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const ack = await channelService.markChannelInboxDone(req.userId!, channelId, throughActivitySeq);
    retractDoneNotifications(req, ack);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DoneFrontierRequiredError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof DoneFrontierBeyondLatestError || err instanceof DoneFrontierAboveInt4AuthorityError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    if (sendCompatibilityReadPending(res, err)) return;
    res.status(500).json({ error: "Failed to mark chat as done" });
  }
});

channelRouter.post("/inbox/undone", noteInboxWriteBeforeReply, async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) {
      res.status(400).json({ error: "channelId is required" });
      return;
    }
    const channel = await channelService.getChannel(channelId);
    if (!channel || isSubConversationType(channel.type)) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const canonicalServerId = channel.serverId as ServerId;
    const isCanonicalServerMember = await serverService.isMember(canonicalServerId, req.userId!);
    if (!isCanonicalServerMember) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const canAccess = await channelService.canUserAccessChannel(channelId, req.userId!, canonicalServerId);
    if (!canAccess) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    await channelService.markChannelInboxActive(req.userId!, channelId);
    res.json({ ok: true });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to restore chat from Done",
      logPrefix: "Failed to restore chat from Done:",
      err,
    });
  }
});

channelRouter.post("/inbox/read-all", noteInboxWriteBeforeReply, async (req, res) => {
  try {
    // Phase span + pool gauges: the read-all incident showed end-to-end times
    // (avg 7.3s, 30s upstream-timeout p-attempts) with no visibility into
    // where inside the request they accumulate. The read_mutations timestamps
    // could not answer it until #8256: before that change, terminalAt reused
    // the pre-execution clock, so admitted→terminal measured queue wait only
    // and execution time was never recorded (Ray/Tenny, 2026-09-24). After
    // #8256, executing→terminal is execution time.
    // ⛔ Usage rule (Tenny): never compare admitted→terminal across the #8256
    // deploy — pre-deploy it is queueing, post-deploy it is queueing +
    // execution, and a before/after on it yields a fake regression made
    // purely of the definition change. Queue is admitted→executing;
    // execution is executing→terminal (post-#8256 only). This child span
    // measures the mutation phase's real wall time from the request,
    // independent of those columns.
    // Pool gauges are sampled twice (Ray): at request start — "was the pool
    // already saturated when I arrived", the multi-victim scenario — and
    // after the mutation; idle distinguishes "pool full" from "pool not yet
    // grown". Omitted when there is no pool (PGlite tests), never fatal.
    const samplePool = (phase: string) => {
      try {
        const metrics = getPoolMetrics();
        if (metrics) {
          addTraceEvent("inbox.read_all.pool_gauges", {
            phase,
            pool_waiting: metrics.waitingCount,
            pool_total: metrics.totalCount,
            pool_idle: metrics.idleCount,
          });
        }
      } catch {
        // No pool (PGlite-backed tests): gauges omitted, never fatal.
      }
    };
    samplePool("request_start");
    const result = await withTraceChildSpan(
      "inbox.read_all.mutation",
      { surface: "server", kind: "internal" },
      () => channelService.markInboxReadLatest(req.serverId!, req.userId!),
      {
        onSuccess: (marked) => ({
          scope_count: marked.scopes.length,
          changed_scope_count: marked.scopes.filter((scope) => scope.changed).length,
        }),
      },
    );
    samplePool("post_mutation");
    emitReadStateUpdatedBulk(req, result.scopes);
    // Object rows too (a no-op while no object app is on for the server); their apps move their read positions.
    const objectsMarked = await markAllObjectActivityRead({ userId: req.userId!, serverId: req.serverId!, sessionFamilyId: req.sessionFamilyId ?? null });
    if (objectsMarked > 0) announceActivityChanged(req.serverId!, [req.userId!]);
    // No per-scope emitScopeReadUpdated here: this route is human-only and
    // human reads are never broadcast to peers. The fan-out used to run ~6
    // queries per changed scope concurrently, only to drop every one.
    res.json({ ok: true, markedCount: result.markedCount, scopes: result.scopes.map((scope) => ({
      scopeId: scope.channelId,
      maxReadSeq: scope.maxReadSeq,
      readStateVersion: scope.readStateVersion,
    })) });
  } catch (err) {
    if (sendCompatibilityReadPending(res, err)) return;
    sendJsonServerError(req, res, {
      error: "Failed to mark inbox as read",
      logPrefix: "Failed to mark inbox as read:",
      err,
    });
  }
});

// List threads the user participates in, with unread counts
const FOLLOWED_THREADS_MAX_LIMIT = 200;

channelRouter.get("/threads/followed", async (req, res) => {
  addTraceEvent("activity.list.fetch", activityListFetchTraceAttrs("followed_threads", req.headers[CHANNEL_FETCH_REASON_HEADER]));
  try {
    addTraceEvent("followed_threads.load.started");
    // `limit` pages the list (newest activity first) and returns `next`;
    // without it the whole list is returned as before (older web clients).
    // `unreadOnly=1` keeps only the threads with unread replies, all channels.
    const limitParam = req.query.limit;
    const limit = limitParam === undefined ? undefined : Number(limitParam);
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= FOLLOWED_THREADS_MAX_LIMIT)) {
      res.status(400).json({ error: `limit must be an integer from 1 to ${FOLLOWED_THREADS_MAX_LIMIT}` });
      return;
    }
    const cursorParam = req.query.cursor;
    const cursor = cursorParam === undefined ? null : channelService.parseFollowedThreadsCursor(cursorParam);
    if (cursorParam !== undefined && (cursor === null || limit === undefined)) {
      res.status(400).json({ error: "cursor must be a value returned as next, with limit" });
      return;
    }
    const unreadOnly = req.query.unreadOnly === "1" || req.query.unreadOnly === "true";
    const load = async () => {
      // The window the paywall reads (getServerHistoryWindowForRead), so
      // the history flags below agree with what opening the thread shows.
      const historyWindow = await tracePhase(
        () => getServerHistoryWindowForRead(req.serverId!),
        (durationMs, result) => ({
          name: "history.policy.checked",
          attrs: {
            plan: result.plan,
          },
        }),
      );
      const historyCutoff = historyWindow.cutoff;
      const loaded = await tracePhase(
        () => channelService.loadFollowedThreads(req.serverId!, req.userId!, historyCutoff, {
          traceQuery: createTraceDbQueryTracer("followed_threads.loaded"),
          unreadOnly,
          // Task v2: followed task conversations are listed (kind "task")
          // whatever the reader's flag (per-task mode: a v2 task keeps its
          // conversation after a rollback / on the flag-off side of a joint
          // channel). Without task conversations this is the thread list.
          includeTaskConversations: true,
          ...(limit === undefined ? {} : { page: { limit, cursor } }),
        }),
        (durationMs, result) => ({
          name: "followed_threads.loaded",
          attrs: {
            followed_threads_count: result.threads.length,
            unread_threads_count: result.threads.filter((thread) => thread.unreadCount > 0).length,
            history_cutoff_present: Boolean(historyCutoff),
            unread_only: unreadOnly,
            paged: limit !== undefined,
            has_next: result.next !== null,
          },
        }),
      );
      // Where the thread sits against the history cutoff, from the same window
      // the paywall reads, so the web neither compares times nor reads the plan:
      // parentInHistory, the parent message is after the cutoff; repliesInHistory,
      // a reply is. Both true when the plan keeps all history. The web opens the
      // thread panel directly only for an old parent with a recent reply.
      const inHistory = (at: Date | string | null | undefined) =>
        historyCutoff === undefined || (at != null && !isBehindHistoryWindow(at, historyWindow));
      return {
        ...loaded,
        threads: loaded.threads.map((thread) => ({
          ...thread,
          parentInHistory: inHistory(thread.parentMessageCreatedAt),
          repliesInHistory: inHistory(thread.lastReplyAt),
        })),
      };
    };
    // Only first pages are remembered for the stale fallback (like the Inbox).
    const { value: loaded, stale, staleReason, traceAttrs: staleTraceAttrs } = cursor === null
      ? await readWithStaleOnOverload({
        surface: "followed_threads",
        userId: req.userId!,
        scope: [req.serverId!, unreadOnly ? "unread" : "all", limit ?? "full"].join(":"),
        load,
      })
      : { value: await load(), stale: false, staleReason: undefined, traceAttrs: {} };
    const { threads, next } = loaded;
    addTraceEvent("response.ready", {
      followed_threads_count: threads.length,
      unread_threads_count: threads.filter((thread) => thread.unreadCount > 0).length,
      stale_served: stale,
      ...staleTraceAttrs,
    });
    if (stale) res.setHeader(STALE_RESPONSE_HEADER, staleReason ?? "rw_overloaded");
    const body = limit === undefined ? { threads } : { threads, next };
    res.json(stale ? { ...body, stale: true } : body);
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to get followed threads",
      logPrefix: "Failed to get followed threads:",
      err,
      risingWaveUnconfiguredAs503: true,
    });
  }
});

// Thread follower management also covers task conversations (task v2): a
// task conversation is a sub-conversation whose parent is the task.
async function resolveManagedThread(req: Request, res: Response, threadChannelId: string) {
  const channel = await channelService.getChannel(threadChannelId);
  if (!channel || !isSubConversationType(channel.type) || channel.serverId !== req.serverId) {
    res.status(404).json({ error: "Thread not found" });
    return null;
  }
  if (!await channelService.canUserAccessChannel(threadChannelId, req.userId!, req.serverId!)) {
    res.status(404).json({ error: "Thread not found" });
    return null;
  }
  return channel;
}

/**
 * Who may remove or restore an Agent follower of a thread / task conversation.
 * The thread's author (a task's creator) may manage their own server's
 * Agents. Beyond that it is the parent channel's member-removal rule for an
 * Agent target (channelActorHasCapability "removeChannelMembers", "agent"):
 * a server owner/admin or a channel admin of the parent channel; in a joint
 * channel the host's owner/admin or appointed manager for any server's Agent,
 * another server's owner/admin for its own server's Agents only.
 */
type ThreadFollowerManagement = {
  canManage: boolean;
  canManageAgentOf: (agentServerId: string) => boolean;
};

async function resolveThreadFollowerManagement(
  req: Request,
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
): Promise<ThreadFollowerManagement> {
  const [isAuthor, authorityChannelId] = await Promise.all([
    isManagedThreadAuthor(req, channel),
    channelService.getChannelMembershipAuthorityChannelId(channel.id),
  ]);
  const authority = authorityChannelId
    ? await resolveChannelActorContext(req.serverId!, authorityChannelId, "user", req.userId!)
    : null;
  const channelManager = authority !== null && channelActorHasCapability(authority, "removeChannelMembers", "agent");
  // Only the host entry of a joint channel manages another server's Agents.
  const managesAnyServer = channelManager
    && (authority.channelType !== "joint" || authority.jointAuthority?.isHostEntry === true);
  const canManageAgentOf = (agentServerId: string) => agentServerId === req.serverId
    ? isAuthor || channelManager
    : managesAnyServer;
  return { canManage: isAuthor || channelManager, canManageAgentOf };
}

async function isManagedThreadAuthor(
  req: Request,
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
): Promise<boolean> {
  // A task conversation's "author" is the task's creator.
  if (channel.type === "task") {
    const task = await channelService.resolveTaskConversationFollowerManagement(channel);
    return task?.createdByType === "user" && task.createdById === req.userId;
  }
  // resolveManagedThread scoped the thread to req.serverId, so a joint thread
  // resolves through this server's projection to its canonical parent.
  const threadParent = await channelService.resolveThreadParent(channel);
  if (!threadParent) return false;
  const parent = await channelService.getMessage(threadParent.parentMessageId);
  return parent?.senderType === "user" && parent.senderId === req.userId;
}

/**
 * Authorize an Agent-follower write and find the projection holding the
 * follower row. Sends the response and returns null when refused.
 */
async function authorizeManagedFollowerWrite(
  req: Request,
  res: Response,
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  agentId: string,
  verb: "remove" | "restore",
): Promise<{ followerThreadChannelId: string } | null> {
  const management = await resolveThreadFollowerManagement(req, channel);
  const author = channel.type === "task" ? "task creator" : "thread author";
  if (!management.canManage) {
    res.status(403).json({ error: `Only the ${author} or a channel manager can ${verb} followers` });
    return null;
  }
  const agent = await agentService.getAgent(agentId);
  const followerThreadChannelId = agent
    ? await channelService.getManagedFollowerThreadChannelIdForServer(channel.id, agent.serverId)
    : null;
  if (!agent || !followerThreadChannelId) {
    res.status(404).json({ error: "Agent follower not found" });
    return null;
  }
  if (!management.canManageAgentOf(agent.serverId)) {
    res.status(403).json({ error: `Only a channel manager of the host server can ${verb} another server's Agent followers` });
    return null;
  }
  return { followerThreadChannelId };
}

const THREAD_FOLLOWER_ROSTER_MAX = 100;

/** How the follower receipt names the conversation: the thread's channel name, or the task's ref. */
async function managedFollowerConversationLabel(
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
): Promise<{ threadLabel: string; conversationKind: channelService.ManagedFollowerConversationKind }> {
  if (channel.type === "task") {
    const task = await channelService.resolveTaskConversationFollowerManagement(channel);
    return { threadLabel: task?.label ?? "task", conversationKind: "task" };
  }
  return { threadLabel: channel.name || "thread", conversationKind: "thread" };
}

async function resolveManagedFollowerActivity(
  orchestrator: AgentOrchestrator | undefined,
  agentId: string,
) {
  if (!orchestrator) return { activity: "online" as const, activityDetail: "" };
  try {
    return await orchestrator.getActivity(agentId);
  } catch (error) {
    console.warn("Failed to resolve Agent activity for follower management:", serializeErrorForLog(error));
    return { activity: "online" as const, activityDetail: "" };
  }
}

async function emitManagedFollowerActivity(
  orchestrator: AgentOrchestrator | undefined,
  agentId: string,
  activityEvent: NonNullable<channelService.ManagedAgentThreadFollowerMutation["activityEvent"]>,
): Promise<void> {
  if (!orchestrator) return;
  try {
    await orchestrator.recordAgentRaftAction(agentId, {
      title: activityEvent.title,
      text: activityEvent.text,
      producerFactId: activityEvent.id,
      dedupeKey: activityEvent.dedupeKey,
    });
  } catch (error) {
    // The canonical Activity row committed with the follower mutation. A live
    // socket projection failure must not turn a completed state change into an
    // HTTP error or cause a retry to create a second user-visible action.
    console.warn("Failed to emit managed follower Activity event:", serializeErrorForLog(error));
  }
}

// Current Agent followers for thread cards/detail headers. Historical followers
// (unfollowed) are deliberately excluded.
channelRouter.get("/threads/followers", async (req, res) => {
  try {
    const raw = typeof req.query.threadChannelIds === "string" ? req.query.threadChannelIds : "";
    const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0 || ids.length > THREAD_FOLLOWER_ROSTER_MAX || ids.some((id) => !ANY_UUID_RE.test(id))) {
      res.status(400).json({ error: "threadChannelIds must contain 1-100 thread UUIDs" });
      return;
    }
    const threads = [];
    for (const threadChannelId of ids) {
      const channel = await resolveManagedThread(req, res, threadChannelId);
      if (!channel) return;
      const [followers, management] = await Promise.all([
        channelService.getManagedThreadAgentFollowers(threadChannelId),
        resolveThreadFollowerManagement(req, channel),
      ]);
      threads.push({
        threadChannelId,
        agents: followers.map((agent) => ({
          ...agent,
          isCurrentServer: agent.serverId === req.serverId,
          canRemove: management.canManageAgentOf(agent.serverId),
        })),
        canManage: management.canManage,
      });
    }
    res.json({ threads });
  } catch (error) {
    sendJsonServerError(req, res, {
      error: "Failed to get thread Agent followers",
      logPrefix: "Failed to get thread Agent followers:",
      err: error,
    });
  }
});

channelRouter.delete("/threads/:threadChannelId/followers/agents/:agentId", async (req, res) => {
  try {
    const threadChannelId = String(req.params.threadChannelId);
    const agentId = String(req.params.agentId);
    if (!ANY_UUID_RE.test(threadChannelId) || !ANY_UUID_RE.test(agentId)) {
      res.status(400).json({ error: "Invalid thread or Agent id" });
      return;
    }
    const channel = await resolveManagedThread(req, res, threadChannelId);
    if (!channel) return;
    const authorized = await authorizeManagedFollowerWrite(req, res, channel, agentId, "remove");
    if (!authorized) return;
    const actor = await userService.getUser(req.userId!);
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const currentActivity = await resolveManagedFollowerActivity(orchestrator, agentId);
    const result = await channelService.removeManagedAgentThreadFollower({
      threadChannelId: authorized.followerThreadChannelId,
      agentId,
      actorLabel: actor?.name ? `@${actor.name}` : actor?.displayName || "A channel manager",
      ...await managedFollowerConversationLabel(channel),
      ...currentActivity,
    });
    if (result.changed && result.activityEvent) {
      await emitManagedFollowerActivity(orchestrator, agentId, result.activityEvent);
    }
    if (result.changed) {
      await emitThreadFollowersUpdated(req.app.get("io") as SocketServer | undefined, threadChannelId);
    }
    res.json({
      ok: true,
      removed: Boolean(result.removalToken),
      undoToken: result.removalToken,
    });
  } catch (error) {
    sendJsonServerError(req, res, {
      error: "Failed to remove Agent thread follower",
      logPrefix: "Failed to remove Agent thread follower:",
      err: error,
    });
  }
});

channelRouter.post("/threads/:threadChannelId/followers/agents/:agentId/restore", async (req, res) => {
  try {
    const threadChannelId = String(req.params.threadChannelId);
    const agentId = String(req.params.agentId);
    const removalToken = typeof req.body?.undoToken === "string" ? req.body.undoToken : "";
    if (!ANY_UUID_RE.test(threadChannelId) || !ANY_UUID_RE.test(agentId) || !removalToken) {
      res.status(400).json({ error: "Valid thread, Agent, and undo token are required" });
      return;
    }
    const channel = await resolveManagedThread(req, res, threadChannelId);
    if (!channel) return;
    const authorized = await authorizeManagedFollowerWrite(req, res, channel, agentId, "restore");
    if (!authorized) return;
    const actor = await userService.getUser(req.userId!);
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const currentActivity = await resolveManagedFollowerActivity(orchestrator, agentId);
    const result = await channelService.restoreManagedAgentThreadFollower({
      threadChannelId: authorized.followerThreadChannelId,
      agentId,
      actorLabel: actor?.name ? `@${actor.name}` : actor?.displayName || "A channel manager",
      ...await managedFollowerConversationLabel(channel),
      removalToken,
      ...currentActivity,
    });
    if (result.changed && result.activityEvent) {
      await emitManagedFollowerActivity(orchestrator, agentId, result.activityEvent);
    }
    if (result.changed) {
      await emitThreadFollowersUpdated(req.app.get("io") as SocketServer | undefined, threadChannelId);
    }
    res.json({ ok: true, restored: result.changed });
  } catch (error) {
    sendJsonServerError(req, res, {
      error: "Failed to restore Agent thread follower",
      logPrefix: "Failed to restore Agent thread follower:",
      err: error,
    });
  }
});

// Follow a thread (manual follow)
channelRouter.post("/threads/follow", noteInboxWriteBeforeReply, async (req, res) => {
  try {
    const { parentMessageId, threadChannelId } = req.body;
    // Task v2: a task conversation has no parent message; the web bell names
    // the conversation itself (the reader's local one; joint: its projection).
    if (!parentMessageId && typeof threadChannelId === "string" && threadChannelId) {
      const conversation = await channelService.getChannel(threadChannelId).catch(() => null);
      if (!conversation || conversation.type !== "task" || conversation.serverId !== req.serverId) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }
      if (!await channelService.canUserAccessChannel(conversation.id, req.userId!, req.serverId!)) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }
      // The Follow button: the thread scope moves only the follow state (a thread has no level).
      const followed = await setNotificationLevel({ userId: req.userId!, scope: "thread", id: conversation.id, level: "all", accessChecked: true, button: true });
      await emitLevelChange(req.app.get("io") as SocketServer | undefined, req.userId!, { ...followed, followChanged: false });
      if (followed.pendingRead) throw followed.pendingRead;
      await emitThreadFollowersUpdated(req.app.get("io") as SocketServer | undefined, conversation.id);
      res.json({ ok: true, threadChannelId: conversation.id });
      return;
    }
    if (!parentMessageId) {
      res.status(400).json({ error: "parentMessageId is required" });
      return;
    }

    // Verify the parent message exists and belongs to a channel in this server
    const parentMsg = await channelService.getMessage(parentMessageId);
    if (!parentMsg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const parentChannel = await channelService.getChannel(parentMsg.channelId);
    if (!parentChannel) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    let localParentChannelId = parentMsg.channelId;
    if (parentChannel.serverId !== req.serverId || parentChannel.type === "joint") {
      const localProjection = (await channelService.getActiveJointChannelProjectionsByLocalChannel(parentMsg.channelId))
        .find((projection) => projection.serverId === req.serverId);
      if (!localProjection) {
        res.status(404).json({ error: "Message not found" });
        return;
      }
      localParentChannelId = localProjection.localChannelId;
    }
    const canAccessParent = await channelService.canUserAccessChannel(localParentChannelId, req.userId!, req.serverId!);
    if (!canAccessParent) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    // Find thread channel for this message
    const thread = await channelService.getOrCreateThreadForChannel(localParentChannelId, parentMessageId, req.userId!, "user");
    // The Follow button: the thread scope moves only the follow state (a thread has no level).
    const followed = await setNotificationLevel({ userId: req.userId!, scope: "thread", id: thread.id, level: "all", accessChecked: true, button: true });
    await emitLevelChange(req.app.get("io") as SocketServer | undefined, req.userId!, { ...followed, followChanged: false });
    if (followed.pendingRead) throw followed.pendingRead;
    await emitThreadFollowersUpdated(req.app.get("io") as SocketServer | undefined, thread.id);
    res.json({ ok: true, threadChannelId: thread.id });
  } catch (err: any) {
    if (err instanceof NotificationLevelError) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    if (sendCompatibilityReadPending(res, err, { primaryOutcomeCommitted: true })) return;
    sendJsonServerError(req, res, {
      error: "Failed to follow thread",
      logPrefix: "Failed to follow thread:",
      err,
    });
  }
});

// Unfollow a thread
channelRouter.post("/threads/unfollow", noteInboxWriteBeforeReply, async (req, res) => {
  try {
    const { threadChannelId } = req.body;
    if (!threadChannelId) {
      res.status(400).json({ error: "threadChannelId is required" });
      return;
    }
    // Verify the thread channel belongs to this server
    const channel = await channelService.getChannel(threadChannelId);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    const canAccess = await channelService.canUserAccessChannel(threadChannelId, req.userId!, req.serverId!);
    if (!canAccess) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    // The Unfollow button: the thread scope moves only the follow state (a thread has no level).
    const unfollowed = await setNotificationLevel({ userId: req.userId!, scope: "thread", id: threadChannelId, level: "mentions", accessChecked: true, button: true });
    await emitLevelChange(req.app.get("io") as SocketServer | undefined, req.userId!, { ...unfollowed, followChanged: false });
    if (unfollowed.pendingRead) throw unfollowed.pendingRead;
    await emitThreadFollowersUpdated(req.app.get("io") as SocketServer | undefined, threadChannelId);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof NotificationLevelError) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    if (sendCompatibilityReadPending(res, err, { primaryOutcomeCommitted: true })) return;
    res.status(500).json({ error: "Failed to unfollow thread" });
  }
});

// Mark a thread as done (hide from active list, auto-restores on new messages)
channelRouter.post("/threads/done", noteInboxWriteBeforeReply, async (req, res) => {
  try {
    const { threadChannelId, throughActivitySeq, frontierSpace } = req.body;
    if (!threadChannelId) {
      res.status(400).json({ error: "threadChannelId is required" });
      return;
    }
    // Same adjudicated four-way matrix as /inbox/done: omitted value uses the
    // existing canonical snapshot (whether storage is explicit or omitted), a
    // value without identity is refresh-required, an unsupported identity is
    // invalid, and only an explicit storage value enters the strict guard.
    if (frontierSpace === undefined && throughActivitySeq !== undefined) {
      res.status(412).json({
        error: "frontierSpace is required; refresh and retry",
        code: "DONE_FRONTIER_SPACE_REQUIRED",
      });
      return;
    }
    if (frontierSpace !== undefined && frontierSpace !== "storage") {
      res.status(400).json({
        error: "frontierSpace must be storage",
        code: "DONE_FRONTIER_UNMAPPABLE",
      });
      return;
    }
    // Resolution is fail-closed: any throw before the caller's standing is
    // established collapses to the same 404 rather than a 500. A 500 is
    // distinguishable from a 404, so a future throw in any helper would reopen
    // the existence oracle through a different exit.
    let activeChannel: Awaited<ReturnType<typeof channelService.getChannel>> | null = null;
    let channel: Awaited<ReturnType<typeof channelService.getChannel>> | null = null;
    try {
      activeChannel = await channelService.getChannel(threadChannelId);
      channel = activeChannel
        ?? await channelService.getChannel(threadChannelId, { includeDeleted: true });
    } catch (resolveErr) {
      console.error("[threads/done] resolve failed:", resolveErr);
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    // Never-existed and lives-in-another-server are merged deliberately: telling
    // them apart makes this endpoint an existence oracle over thread ids.
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }

    const authorize = async () => {
      try {
        return await channelService.canUserAccessChannel(
          threadChannelId,
          req.userId!,
          req.serverId!,
          { includeDeleted: true },
        );
      } catch (authErr) {
        console.error("[threads/done] authorize failed:", authErr);
        return false;
      }
    };

    // A non-thread scope is a caller bug worth naming -- but only to someone who
    // can already see the channel. To anyone else it stays in the merged 404,
    // because "wrong type" still reveals that the id is real.
    // Task v2: a task conversation is sub-conversation Done like a thread.
    if (channel.type !== "thread" && channel.type !== "task") {
      if (await authorize()) {
        res.status(400).json({ error: "Not a thread", code: "NOT_A_THREAD" });
      } else {
        res.status(404).json({ error: "Thread not found" });
      }
      return;
    }
    // Deleted threads are adjudicated by the caller's OWN residue, not by parent
    // access, so this precedes the access gate exactly as in #6052. Callers with
    // no receiver-owned evidence get SCOPE_NOT_FOUND -> the same merged 404.
    if (!activeChannel && channel.deletedAt) {
      await channelService.retireDeletedThreadDoneResidue(
        req.userId!,
        threadChannelId,
        throughActivitySeq,
      );
      // activity-v1 declares this 200 as V1AckResponse `{ ok: true }` with
      // `unevaluatedProperties: { not: {} }`, so the legacy compatibility
      // receipt stays internal. It is the boundary the service retired to,
      // not a field this endpoint is allowed to promise; the API tests assert
      // it directly against channelService instead (task #67).
      res.json({ ok: true });
      return;
    }
    // A live thread below a deleted DM parent is no longer a content-access
    // target, but the receiver may still own stale Activity residue. Keep this
    // narrower than the ordinary authorization path: live private/hidden
    // parents still pass through authorize() and remain merged into 404.
    if (activeChannel && await channelService.hasDeletedDmThreadParent(threadChannelId, req.serverId!)) {
      if (!await channelService.hasUserThreadResidue(req.userId!, req.serverId!, threadChannelId)) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }
      await channelService.retireDeletedThreadDoneResidue(
        req.userId!,
        threadChannelId,
        throughActivitySeq,
      );
      // activity-v1 declares this 200 as V1AckResponse `{ ok: true }` with
      // `unevaluatedProperties: { not: {} }`, so the legacy compatibility
      // receipt stays internal. It is the boundary the service retired to,
      // not a field this endpoint is allowed to promise; the API tests assert
      // it directly against channelService instead (task #67).
      res.json({ ok: true });
      return;
    }
    if (!await authorize()) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    const ack = await channelService.markThreadDone(req.userId!, threadChannelId, throughActivitySeq);
    retractDoneNotifications(req, ack);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DoneFrontierRequiredError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof DoneFrontierBeyondLatestError || err instanceof DoneFrontierAboveInt4AuthorityError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof ReadMutationError && err.code === "SCOPE_NOT_FOUND") {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    if (sendCompatibilityReadPending(res, err)) return;
    res.status(500).json({ error: "Failed to mark thread as done" });
  }
});

// Un-done a thread (restore to active list)
channelRouter.post("/threads/undone", noteInboxWriteBeforeReply, async (req, res) => {
  try {
    const { threadChannelId } = req.body;
    if (!threadChannelId) {
      res.status(400).json({ error: "threadChannelId is required" });
      return;
    }
    const channel = await channelService.getChannel(threadChannelId);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    const canAccess = await channelService.canUserAccessChannel(threadChannelId, req.userId!, req.serverId!);
    if (!canAccess) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    await channelService.undoneThread(req.userId!, threadChannelId);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to undone thread" });
  }
});

// ── Saved Messages ──

// List all saved messages
channelRouter.get("/saved", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const offset = parseOffsetQueryParam(req.query.offset);
    const channelIdParam = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
    const channelId = channelIdParam && ANY_UUID_RE.test(channelIdParam) ? channelIdParam : undefined;
    const qParam = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const q = qParam || undefined;
    const sort = req.query.sort === "asc" ? "asc" as const : "desc" as const;
    // The plan's history window (services/historyWindow.ts): saved messages
    // behind it are not listed or counted in the totals; the first page says
    // how many there are, for the list's card (cindyz, task #8, frame 16).
    // Not for a search: counting old matches would search what is hidden.
    const { cutoff: historyCutoff } = await getServerHistoryWindowForRead(req.serverId!);
    const inside = historyCutoff ? { cutoff: historyCutoff, side: "inside" as const } : undefined;
    const filteredTotalPromise = savedService.countSaved(req.userId!, req.serverId!, { channelId, q, history: inside });
    const globalTotalPromise = channelId || q
      ? savedService.countSaved(req.userId!, req.serverId!, { history: inside })
      : filteredTotalPromise;
    const historyHiddenPromise = historyCutoff && !q && offset === 0
      ? savedService.countSaved(req.userId!, req.serverId!, { channelId, history: { cutoff: historyCutoff, side: "behind" } })
      : Promise.resolve(0);
    const [saved, total, globalTotal, historyHiddenCount] = await Promise.all([
      savedService.listSaved(req.userId!, req.serverId!, { limit, offset, channelId, q, sort, history: inside }),
      filteredTotalPromise,
      globalTotalPromise,
      historyHiddenPromise,
    ]);
    // `total` = true saved count (drives the sidebar/panel badge, which used to
    // be capped at the loaded page size); `saved` is one page. Derive hasMore
    // from the true total — `saved.length >= limit` over-reports when the count
    // is an exact multiple of limit (a full last page wrongly looks like there's
    // more), so a `total`-exact check is both correct and simpler.
    res.json({
      saved,
      hasMore: offset + saved.length < total,
      total,
      globalTotal,
      ...(historyHiddenCount > 0 && { historyHidden: { count: historyHiddenCount } }),
    });
  } catch {
    res.status(500).json({ error: "Failed to list saved messages" });
  }
});

// Save a message; with `saved: false`, unsave it (the owner's assistant's save_message, #proj-assistant:#19).
channelRouter.post("/saved", async (req, res) => {
  try {
    const { messageId, saved } = req.body;
    if (!messageId || typeof messageId !== "string") {
      res.status(400).json({ error: "messageId is required" });
      return;
    }
    if (saved !== undefined && typeof saved !== "boolean") {
      res.status(400).json({ error: "saved must be true or false" });
      return;
    }
    if (saved === false) {
      const { unfollowedThreadChannelId } = await savedService.unsaveMessage(req.userId!, messageId);
      if (unfollowedThreadChannelId) await emitThreadFollowersUpdated(req.app.get("io") as SocketServer | undefined, unfollowedThreadChannelId);
      res.json({ ok: true, saved: false });
      return;
    }
    // Verify the message is visible in this server. Joint messages live under
    // canonical storage, so raw message.channelId/serverId is not enough.
    const canAccess = await savedService.canSaveMessage(req.userId!, req.serverId!, messageId);
    if (!canAccess) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    // Saving also follows the message's thread (thread contract D, db/schema.ts).
    const { followedThreadChannelId } = await savedService.saveMessage(req.userId!, messageId, req.serverId!);
    if (followedThreadChannelId) await emitThreadFollowersUpdated(req.app.get("io") as SocketServer | undefined, followedThreadChannelId);
    res.json({ ok: true, saved: true });
  } catch (err) {
    // The save and its follow committed; only the follow's read-position move is pending.
    if (sendCompatibilityReadPending(res, err, { primaryOutcomeCommitted: true })) return;
    res.status(500).json({ error: "Failed to save message" });
  }
});

// Unsave a message
channelRouter.delete("/saved/:messageId", async (req, res) => {
  try {
    const { unfollowedThreadChannelId } = await savedService.unsaveMessage(req.userId!, req.params.messageId);
    if (unfollowedThreadChannelId) await emitThreadFollowersUpdated(req.app.get("io") as SocketServer | undefined, unfollowedThreadChannelId);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to unsave message" });
  }
});

// Check saved status for a batch of message IDs
channelRouter.post("/saved/check", async (req, res) => {
  try {
    const { messageIds } = req.body;
    if (!Array.isArray(messageIds)) {
      res.status(400).json({ error: "messageIds array is required" });
      return;
    }
    if (messageIds.length > 200) {
      res.status(400).json({ error: "Maximum 200 messageIds per request" });
      return;
    }
    if (!messageIds.every((id: unknown) => typeof id === "string")) {
      res.status(400).json({ error: "messageIds must be strings" });
      return;
    }
    // Clients may include ids of messages that only exist locally (e.g. `local-send-…` optimistic
    // sends). Those can never be saved, and querying the uuid columns with them makes Postgres throw,
    // which used to surface as a silent 500 (task #335). Treat any non-UUID id as "not saved".
    // Any-version UUID shape (what the uuid column accepts), via the shared UUID_RE.
    const serverMessageIds = messageIds.filter((id: string) => ANY_UUID_RE.test(id));
    const saved = await savedService.getSavedMessageIds(req.userId!, req.serverId!, serverMessageIds);
    res.json({ savedIds: [...saved] });
  } catch (error) {
    sendJsonServerError(req, res, {
      error: "Failed to check saved messages",
      logPrefix: "[Saved] saved check failed",
      err: error,
    });
  }
});

function parseRegularChannelVisibility(raw: unknown): channelService.RegularChannelType | undefined {
  if (raw === undefined) return undefined;
  if (raw === "public") return "channel";
  if (raw === "private") return "private";
  throw new Error("invalid_visibility");
}

// Hide the built-in #all channel. The mirror of /system/all/restore, and the
// only way in: the generic visibility field refuses #all outright.
//
// This endpoint exists because hiding #all is not an instance of "make a channel
// private". #all carries no membership rows -- its audience is derived from
// server membership -- so the transition drops everyone at once, including the
// actor, and an agent that reached #all through that derived audience can never
// reach it again. Keeping both directions on dedicated, human-only, id-free
// endpoints makes the door two-way by construction.
channelRouter.post("/system/all/hide", async (req, res) => {
  try {
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "changeChannelVisibility"))) {
      res.status(403).json({ error: "Only admins can hide #all" });
      return;
    }

    const channel = await channelService.getSystemAllChannel(req.serverId!);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const alreadyHidden = !channelService.isEnabledAllChannel(channel);
    const updated = alreadyHidden
      ? channel
      : await channelService.updateChannel(channel.id, { type: "private" });

    // Moved here from the generic PATCH handler along with the hide path itself.
    // Claiming the unlock instruction is what stops the onboarding team-growth
    // unlock from re-revealing an #all that an admin hid on purpose
    // (agentService reads `allChannelUnlockInstructionSentAt` before unlocking).
    // Leaving it behind in PATCH would have resurrected that bug silently: the
    // regression test covering it drives the PATCH route, so it would have kept
    // passing against a path nothing uses any more.
    // Unconditional on purpose. Guarding this with `!alreadyHidden` meant an #all
    // that was ALREADY hidden never got the claim -- and that is the birth state
    // of every new server (#all is born hidden), instruction unclaimed. The owner
    // who hides an already-hidden #all expresses the same intent as one who hides a
    // visible one, and used to get a different durable outcome: team growth
    // re-revealed it. The claim is idempotent (it writes only when the column is
    // null), so calling it always costs nothing and removes the divergence.
    // Found in independent review of this PR.
    const server = await serverService.getServer(req.serverId!);
    if (server) {
      await serverService.tryClaimAllChannelUnlockInstruction(req.serverId!, server.ownerId, resolveNow(req));
    }

    const io = req.app.get("io") as SocketServer | undefined;
    io?.in(`server:${req.serverId}`).socketsLeave(`channel:${channel.id}`);
    await publishChannelUpdate(io, updated);
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed to hide #all" });
  }
});

// Restore the built-in #all channel when it is hidden. Hidden #all is
// deliberately omitted from ordinary channel lists, so the admin UI cannot
// rely on already knowing the channel id.
channelRouter.post("/system/all/restore", async (req, res) => {
  try {
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "changeChannelVisibility"))) {
      res.status(403).json({ error: "Only admins can restore #all" });
      return;
    }

    const channel = await channelService.getSystemAllChannel(req.serverId!);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const updated = channelService.isEnabledAllChannel(channel)
      ? channel
      : await channelService.updateChannel(channel.id, { type: "channel" });

    await publishChannelUpdate(req.app.get("io"), updated);
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed to restore #all" });
  }
});

// Update channel (name / description / visibility)
/** A person's 409 for a name an archived channel holds: specific only if they can see it (archivedNameCollision.ts). */
function humanArchivedNameCollisionBody(req: Request, err: channelService.ArchivedNameCollisionError) {
  return archivedNameCollisionBody(
    err,
    { type: "user", id: req.userId!, serverId: req.serverId! },
    async () => err.archivedChannelType === "channel" || err.archivedChannelType === "private"
      ? actorHasChannelCapability(req.serverId!, err.archivedChannelId, "user", req.userId!, "archiveChannels")
      : err.archivedChannelType === "joint"
        && actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "archiveChannels"),
  );
}

/** PATCH /api/channels/:id visitorVisible refusals (#wg-rbac:#51). */
const VISITOR_VISIBILITY_FORBIDDEN: RefusalInput = {
  error: "Only server owners and admins can change whether a channel is visible to visitors",
  code: "visitor_visibility_forbidden",
};
const VISITOR_VISIBILITY_UNSUPPORTED_CHANNEL: RefusalInput = {
  error: "Visitor visibility is supported only for ordinary channels",
  code: "visitor_visibility_unsupported_channel",
};
const VISITOR_VISIBILITY_REQUIRES_PUBLIC_CHANNEL: RefusalInput = {
  error: "Only a public channel can be visible to visitors",
  code: "visitor_visibility_requires_public_channel",
};
const VISITOR_VISIBILITY_REQUIRES_PUBLIC_SERVER: RefusalInput = {
  error: "Make the server public before making its channels visible to visitors",
  code: "visitor_visibility_requires_public_server",
};

/**
 * `visitorVisible`, or `guestVisible`, the legacy name older clients still
 * send (accepted for one release). Both sent and different is a 400.
 */
function parseVisitorVisibleRequest(body: Record<string, unknown>):
  { ok: true; value: boolean | undefined } | { ok: false; refusal: RefusalInput } {
  const { visitorVisible, guestVisible } = body;
  if (visitorVisible !== undefined && typeof visitorVisible !== "boolean") {
    return { ok: false, refusal: { error: "visitorVisible must be a boolean", code: "visitor_visible_invalid" } };
  }
  if (guestVisible !== undefined && typeof guestVisible !== "boolean") {
    return { ok: false, refusal: { error: "guestVisible must be a boolean", code: "visitor_visible_invalid" } };
  }
  if (visitorVisible !== undefined && guestVisible !== undefined && visitorVisible !== guestVisible) {
    return { ok: false, refusal: { error: "visitorVisible and guestVisible disagree; send visitorVisible only", code: "visitor_visible_conflict" } };
  }
  return { ok: true, value: visitorVisible ?? guestVisible };
}

/**
 * Why visitorVisible may not be turned on, or null. The same conditions the
 * anonymous read path applies (publicServer.ts anonymousReadableChannel and
 * its server gate): the server is publicly visible with public_server_v0 on
 * (evaluated as that path does, per server, platform web), and the channel is
 * a plain public channel, after any visibility change in the same request.
 * #all is not one: its audience is managed only through its own surfaces.
 */
async function visitorVisibilityTurnOnRefusal(
  serverId: string,
  channel: Parameters<typeof channelService.isAllSystemChannel>[0],
  nextType: channelService.RegularChannelType | undefined,
): Promise<RefusalInput | null> {
  const [server, publicGate] = await Promise.all([
    serverService.getServer(serverId),
    evaluateFeatureFlag({ key: PUBLIC_SERVER_FEATURE_FLAG_KEY, serverId, platform: "web" }),
  ]);
  if (!server?.publiclyVisible || !publicGate.enabled) return VISITOR_VISIBILITY_REQUIRES_PUBLIC_SERVER;
  if ((nextType ?? channel.type) !== "channel" || channelService.isAllSystemChannel(channel)) {
    return VISITOR_VISIBILITY_REQUIRES_PUBLIC_CHANNEL;
  }
  return null;
}

channelRouter.patch("/:id", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const [canEditChannelMetadata, canChangeChannelVisibility, canManageVisitorAccess] = await Promise.all([
      actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "editChannelMetadata"),
      actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "changeChannelVisibility"),
      // Server owner/admin only: a channel admin role never grants it
      // (not in CHANNEL_ADMIN_CAPABILITIES).
      actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "manageVisitorAccess"),
    ]);
    const canManageRequestedChange = canEditChannelMetadata || canChangeChannelVisibility || canManageVisitorAccess;
    const isHiddenAllChannel = channelService.isAllSystemChannel(channel)
      && !channelService.isEnabledAllChannel(channel);
    if (isHiddenAllChannel && !canManageRequestedChange) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!isHiddenAllChannel && !await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    // DMs cannot be renamed/updated
    if (channel.type === "dm") {
      res.status(403).json({ error: "Cannot edit DM channels" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    // guestJoinable is retired (#wg-rbac:#47): a Guest never joins a channel
    // itself, so the field is no longer read. visitorVisible (legacy alias
    // guestVisible) puts the channel on its public server's page for
    // signed-out visitors (cindyz, #wg-rbac:#51, msg 4987425b).
    const { name, description, visibility, threadSort } = req.body;
    const visitorVisibilityRequested = req.body.visitorVisible !== undefined || req.body.guestVisible !== undefined;
    // Forum-style channels (#proj-chat:#24): behind channel_thread_sort_v0
    // (404 while off, like an unknown field), editChannelMetadata like the name,
    // regular channels only (not joint, DM, thread or task).
    if (threadSort !== undefined) {
      const threadSortGate = await evaluateFeatureFlag({
        key: CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY,
        serverId: req.serverId!,
        userId: req.userId!,
      });
      if (!threadSortGate.enabled) {
        res.status(404).json({ error: "Thread sort is not enabled" });
        return;
      }
      if (!canEditChannelMetadata) {
        res.status(403).json({ error: "You do not have permission to edit channel metadata" });
        return;
      }
      if (!isChannelThreadSort(threadSort)) {
        res.status(400).json({ error: "threadSort must be one of: time, activity" });
        return;
      }
      if (!channelTypeSupportsThreadSort(channel.type)) {
        res.status(400).json({ error: "Thread sort is supported only for ordinary channels", code: "thread_sort_unsupported" });
        return;
      }
    }
    // Channel announcements (#proj-chat:#29): behind channel_announcement_v0,
    // editChannelMetadata like the name, an Artifact homed in this channel
    // (channelAnnouncements.ts; null removes it).
    let announcementArtifactId: string | null | undefined;
    if (req.body.announcement !== undefined) {
      const change = await channelAnnouncementChange({
        actor: { type: "user", id: req.userId!, serverId: asServerId(req.serverId!) },
        channel,
        raw: req.body.announcement,
        canEditChannelMetadata,
      });
      if (!change.ok) {
        refuse(res, change.status, change.refusal);
        return;
      }
      announcementArtifactId = change.artifactId;
    }
    if ((name !== undefined || description !== undefined) && !canEditChannelMetadata) {
      res.status(403).json({ error: "You do not have permission to edit channel metadata" });
      return;
    }
    if (visibility !== undefined && !canChangeChannelVisibility) {
      res.status(403).json({ error: "You do not have permission to change channel visibility" });
      return;
    }
    if (visitorVisibilityRequested && !canManageVisitorAccess) {
      refuse(res, 403, VISITOR_VISIBILITY_FORBIDDEN);
      return;
    }
    const parsedVisitorVisible = parseVisitorVisibleRequest(req.body);
    if (!parsedVisitorVisible.ok) {
      refuse(res, 400, parsedVisitorVisible.refusal);
      return;
    }
    const visitorVisible = parsedVisitorVisible.value;
    if (name === undefined && description === undefined && visibility === undefined && !visitorVisibilityRequested && !canEditChannelMetadata) {
      res.status(403).json({ error: "You do not have permission to update channels" });
      return;
    }
    if (name !== undefined) {
      const nameError = validateName(name, "Channel name");
      if (nameError) {
        res.status(400).json({ error: nameError });
        return;
      }
    }
    if (description !== undefined && (typeof description !== "string" || description.length > 500)) {
      res.status(400).json({ error: "Description must be a string of at most 500 characters" });
      return;
    }
    let type: channelService.RegularChannelType | undefined;
    try {
      type = parseRegularChannelVisibility(visibility);
    } catch {
      res.status(400).json({ error: "visibility must be one of: public, private" });
      return;
    }
    // #all is never reachable through the generic visibility field (@cindyz,
    // 2026-09-07, #wg-rbac msg=c1a72093). Hiding it is not "making a channel
    // private": #all has no membership rows at all, so the transition drops the
    // entire derived audience at once and takes the actor down with it. It is
    // managed only through the dedicated human surfaces below.
    //
    // Written as an explicit refusal rather than leaning on the membership check
    // that follows. #all happens to carry zero rows today, so the membership rule
    // would exclude it as a side effect -- but a side effect is not a contract:
    // the day anything writes an explicit #all row the gate would reopen silently
    // and no test would go red.
    if (visibility !== undefined && channelService.isAllSystemChannel(channel)) {
      res.status(403).json({
        error: channelService.ALL_CHANNEL_VISIBILITY_REFUSAL,
        code: "all_channel_visibility_managed_separately",
      });
      return;
    }
    // Both humans and agents must be members of the channel whose visibility they
    // change (@cindyz, 2026-09-07). This is what makes the door two-way: a public
    // channel is readable without a membership row, so an admin who was never a
    // member could turn it private and then be refused by the very rule they had
    // just created. Requiring membership up front means the actor holds a row,
    // and ordinary channels preserve rows across the transition.
    if (visibility !== undefined && !await channelService.isChannelHuman(channel.id, req.userId!)) {
      res.status(403).json({
        error: "You must be a member of this channel to change its visibility",
        code: "channel_membership_required",
      });
      return;
    }
    if (visitorVisible !== undefined && channel.type !== "channel" && channel.type !== "private") {
      refuse(res, 400, VISITOR_VISIBILITY_UNSUPPORTED_CHANNEL);
      return;
    }
    // Turning it on needs a reader on both sides: the public read path
    // (routes/publicServer.ts) serves only plain public channels of a server
    // that is publicly visible with public_server_v0 on. Off is always allowed.
    if (visitorVisible === true) {
      const refusal = await visitorVisibilityTurnOnRefusal(req.serverId!, channel, type);
      if (refusal) {
        refuse(res, 400, refusal);
        return;
      }
    }
    const requiredCapabilities: ServerCapability[] = [];
    if (name !== undefined || description !== undefined || threadSort !== undefined || announcementArtifactId !== undefined) requiredCapabilities.push("editChannelMetadata");
    if (visibility !== undefined) requiredCapabilities.push("changeChannelVisibility");
    if (visitorVisible !== undefined) requiredCapabilities.push("manageVisitorAccess");
    // The announcement as it was under the lock: which change the event line names (set, replaced, removed).
    let announcementBefore: string | null = channel.announcementArtifactId ?? null;
    const updated = await withLockedChannelActorCapabilities({
      serverId: req.serverId!,
      channelId: channel.id,
      actorType: "user",
      actorId: req.userId!,
      capabilities: requiredCapabilities,
    }, async (tx, actor) => {
      // Under the channel row lock, which sending and accepting an external
      // invite take first: no relation can appear beside this check.
      if (visitorVisible === true
        && (await channelService.channelIdsWithExternalRelation([channel.id], tx)).has(channel.id)) {
        throw new RefusalError(400, VISITOR_VISIBILITY_UNSUPPORTED_CHANNEL);
      }
      const before = await channelService.getChannel(channel.id, { executor: tx });
      if (before) announcementBefore = before.announcementArtifactId ?? null;
      const result = await channelService.updateChannel(req.params.id, {
        name: name?.trim(),
        description,
        type,
        guestVisible: visitorVisible,
        threadSort,
        announcementArtifactId,
      }, tx);
      // Also when making the channel private turned it off.
      if (before && before.guestVisible !== result.guestVisible) {
        await recordIntegrationAuditEvent({
          serverId: req.serverId!,
          eventType: "channel.visitor_visibility_changed",
          outcome: "success",
          source: "web",
          actor: { type: "human", id: req.userId! },
          target: { type: "channel", id: channel.id },
          metadata: {
            channelId: channel.id,
            visitorVisible: result.guestVisible,
            ...serverAuditContextMetadata({ actorRole: actor.serverRole }),
          },
        }, tx);
      }
      return result;
    });
    await channelService.revokeChannelAccessAfterUpdate({ type, guestVisible: visitorVisible }, updated);
    const renamed = updated.name !== channel.name;

    // Notify clients about channel update
    const io = req.app.get("io");
    if (channel.guestVisible && !updated.guestVisible) {
      const guests = (await serverService.getServerMembers(req.serverId!, req.userId!))
        .filter((member) => member.role === "guest");
      for (const guest of guests) {
        io?.in(`user:${guest.userId}`).socketsLeave(`channel:${updated.id}`);
      }
    }
    const visibilityChanged = type !== undefined && type !== channel.type;
    // The #all unlock-instruction claim used to live here. It moved to
    // POST /system/all/hide together with the only path that can now hide #all;
    // this route refuses #all visibility outright, so a claim here would be dead
    // code that hides the move.
    if (updated.type === "joint") {
      await emitJointProjectionUpdates(io, updated.id);
    } else {
      await publishChannelUpdate(io, updated);
    }

    if (renamed) {
      await broadcastChannelRenameSystemMessage(req, updated, req.userId!, channel.name, updated.name).catch((err: unknown) => {
        console.error("channel rename: failed to broadcast system message:", err);
      });
    }
    // Set, replaced or removed (not a new version of it): one event line (tygg, #proj-chat:#29).
    if (announcementArtifactId !== undefined) {
      await postChannelAnnouncementChange({
        io,
        agentOrchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
        channelId: updated.id,
        actor: { type: "user", id: req.userId! },
        before: announcementBefore,
        after: updated.announcementArtifactId ?? null,
      });
    }

    res.json(withVisitorVisible(await attachChannelAnnouncement({ type: "user", id: req.userId!, serverId: asServerId(req.serverId!) }, updated)));
  } catch (err: any) {
    const msg = err?.message || "";
    if (err instanceof RefusalError) {
      refuse(res, err.status, err.refusal);
    } else if (err instanceof channelService.ExternalMembersKeepPrivateError) {
      res.status(409).json({ error: err.message, code: err.code });
    } else if (err instanceof AgentLoungeImmutableError) {
      res.status(409).json({ error: err.message, code: err.code });
    } else if (msg === "Channel capability required") {
      res.status(403).json({ error: "You do not have permission to update channels" });
    } else if (err instanceof channelService.ArchivedNameCollisionError) {
      res.status(409).json(await humanArchivedNameCollisionBody(req, err));
    } else if (msg.includes("already taken")) {
      res.status(409).json({ error: msg });
    } else if (msg === "Thread sort is supported only for ordinary channels") {
      res.status(400).json({ error: msg, code: "thread_sort_unsupported" });
    } else if (msg.includes("Cannot rename") || msg.includes("Cannot edit") || msg === channelService.JOINT_VISIBILITY_FIXED_MESSAGE || msg.includes("reserved")) {
      res.status(403).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to update channel" });
    }
  }
});

// List message attachments visible from a channel-level Files tab.
// Thread attachments are included under their parent channel and carry enough
// source metadata for the client to jump back to the original thread surface.
channelRouter.get("/:id/files", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json(CHANNEL_NOT_FOUND_BODY);
      return;
    }
    const canAccess = await channelService.canUserAccessChannel(channel.id, req.userId!, req.serverId!);
    if (!canAccess) {
      await denyChannelAccess(res, req.userId!, channel.id, "You do not have access to this channel");
      return;
    }

    const plan = await getServerPlan(req.serverId!);
    const historyCutoff = getHistoryCutoff(plan);
    const limit = parseChannelFilesLimit(req.query.limit);
    let cursor: channelService.ChannelFilesCursor | null;
    try {
      cursor = parseChannelFilesCursor(req.query.cursor);
    } catch {
      res.status(400).json({ error: "Invalid cursor" });
      return;
    }
    // Task v2: attachments posted in the channel's task conversations are
    // listed too, whatever the reader's flag (per-task mode).
    const files = await channelService.listChannelFiles(channel.id, { historyCutoff, limit: limit + 1, cursor, includeTaskConversations: true });
    const pageFiles = files.slice(0, limit);
    const nextCursor = files.length > limit && pageFiles.length > 0
      ? encodeChannelFilesCursor(pageFiles[pageFiles.length - 1])
      : null;
    // On a plan with a history window, the first page says whether the
    // window hides any of the channel's files, so the panel says so only
    // then. A channel younger than the window has none to hide.
    const historyLimited = cursor !== null || historyCutoff === undefined
      ? undefined
      : new Date(channel.createdAt) < historyCutoff
        && await channelService.hasChannelFilesBehindHistory(channel.id, historyCutoff, { includeTaskConversations: true });
    res.json({
      files: pageFiles.map((file) => {
        const filename = normalizeAttachmentFilename(file.filename);
        return {
          id: file.id,
          messageId: file.messageId,
          channelId: file.channelId,
          filename,
          mimeType: resolveAttachmentMimeType(filename, file.mimeType),
          sizeBytes: file.sizeBytes,
          width: file.width,
          height: file.height,
          thumbnailUrl: getThumbnailUrl(file.thumbnailKey),
          createdAt: file.createdAt,
          uploader: {
            type: file.uploaderType,
            id: file.uploaderId,
            name: file.uploaderName,
            displayName: file.uploaderDisplayName || file.uploaderName,
          },
          source: file.source,
        };
      }),
      nextCursor,
      ...(historyLimited !== undefined && { historyLimited }),
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to list channel files",
      logPrefix: "Failed to list channel files:",
      err,
    });
  }
});

async function resolveActivityMuteTarget(req: Request, res: Response) {
  const channelId = typeof req.params.id === "string" ? req.params.id : req.params.id[0];
  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== req.serverId) {
    res.status(404).json({ error: "Channel not found" });
    return null;
  }
  if (isSubConversationType(channel.type)) {
    res.status(400).json({ error: "Thread notification settings are managed via follow/unfollow" });
    return null;
  }
  const canAccess = await channelService.canUserAccessChannel(channel.id, req.userId!, req.serverId!);
  if (!canAccess) {
    res.status(404).json({ error: "Channel not found" });
    return null;
  }
  return channel;
}

async function resolveMessageDisplayPrefsTarget(req: Request, res: Response) {
  const channelId = typeof req.params.id === "string" ? req.params.id : req.params.id[0];
  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== req.serverId) {
    res.status(404).json({ error: "Channel not found" });
    return null;
  }
  if (isSubConversationType(channel.type)) {
    res.status(400).json({ error: "Thread message display settings are managed by the parent channel" });
    return null;
  }
  // Display prefs are a per-user "my channel" setting, so the gate is channel
  // membership — not canUserAccessChannel, which lets any server member read a
  // public channel without joining it. The #all system channel has implicit
  // membership for every server human (addHuman is a no-op there).
  const requesterRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
  const isPrefsMember = channelService.isAllSystemChannel(channel)
    ? requesterRole !== "guest" && channelService.isEnabledAllChannel(channel)
    : channel.type === "channel"
      ? await channelService.isChannelHuman(channel.id, req.userId!)
      : await channelService.canUserAccessChannel(channel.id, req.userId!, req.serverId!);
  if (!isPrefsMember) {
    res.status(404).json({ error: "Channel not found" });
    return null;
  }
  return channel;
}

channelRouter.get("/:id/notification-settings", async (req, res) => {
  try {
    const channel = await resolveActivityMuteTarget(req, res);
    if (!channel) return;
    const [state, activityMuteSupported] = await Promise.all([
      channelService.getInboxTargetActivityMuteState("user", req.userId!, channel.id),
      channelService.userActivityMuteSupported(channel),
    ]);
    addTraceEvent("activity_mute.setting.loaded", {
      server_id: req.serverId,
      source_channel_id: channel.id,
      receiver_type: "user",
      activity_mute_state: state.activityMuted ? "muted" : "unmuted",
      activity_muted: state.activityMuted,
      mute_from_seq: state.muteFromSeq,
      negative_evidence_bucket: "does_not_prove_future_message_suppression",
    });
    res.json({
      activityMuted: state.activityMuted,
      muteFromSeq: state.muteFromSeq,
      prefsVersion: state.prefsVersion,
      activityMuteSupported,
    });
  } catch {
    res.status(500).json({ error: "Failed to get channel notification settings" });
  }
});

channelRouter.patch("/:id/notification-settings", noteInboxWriteBeforeReply, async (req, res) => {
  try {
    const channel = await resolveActivityMuteTarget(req, res);
    if (!channel) return;
    if (typeof req.body?.activityMuted !== "boolean") {
      res.status(400).json({ error: "activityMuted must be a boolean" });
      return;
    }
    const activityMuteSupported = await channelService.userActivityMuteSupported(channel);
    // Muting is refused where the person cannot mute (a DM with a person or an
    // ordinary agent, or a removed bot's DM). Unmuting is always accepted, so a
    // mute stored before the DM stopped qualifying can still be undone.
    if (req.body.activityMuted && !activityMuteSupported) {
      res.status(400).json({ error: "This conversation can't be muted", code: "ACTIVITY_MUTE_NOT_SUPPORTED" });
      return;
    }
    const state = await channelService.setInboxTargetActivityMuteState({
      receiverType: "user",
      receiverId: req.userId!,
      serverId: req.serverId!,
      sourceChannelId: channel.id,
      activityMuted: req.body.activityMuted,
    });
    addTraceEvent("activity_mute.api.updated", {
      server_id: req.serverId,
      source_channel_id: channel.id,
      receiver_type: "user",
      activity_mute_state: state.activityMuted ? "muted" : "unmuted",
      activity_muted: state.activityMuted,
      mute_from_seq: state.muteFromSeq,
      negative_evidence_bucket: "does_not_prove_future_message_suppression",
    });
    emitNotificationPrefsUpdated(req, channel.id, state);
    // How often people mute a conversation (#proj-analytics:#17): every client writes here; only a real change counts.
    if (state.changed) {
      void recordServerProductEvent(getProductEventSink(req.app), {
        event: "conversation_mute_changed",
        userId: req.userId!,
        serverId: req.serverId!,
        properties: { muted: state.activityMuted, kind: channel.type === "dm" ? "dm" : "channel" },
      });
    }
    res.json({
      activityMuted: state.activityMuted,
      muteFromSeq: state.muteFromSeq,
      prefsVersion: state.prefsVersion,
      activityMuteSupported,
    });
  } catch {
    res.status(500).json({ error: "Failed to update channel notification settings" });
  }
});

/**
 * Channel announcements: the channel's announcement as this person sees it
 * (`{ announcement }`: ChannelAnnouncementForPerson, null for none, also
 * while channel_announcement_v0 is off). What the web's strip reads, without
 * the whole channel payload: GET /channels (the list) doesn't carry it, and
 * it changes with a new version, which changes no channel row.
 */
channelRouter.get("/:id/announcement", async (req, res) => {
  try {
    const viewer = { type: "user" as const, id: req.userId!, serverId: asServerId(req.serverId!) };
    const channel = await channelService.getChannel(req.params.id as string);
    // The unified visibility entry (visibilityService canView on the conversation); one 404 for missing and not visible.
    const [visible] = channel && channel.serverId === req.serverId ? await canView(viewer, [{ kind: "conversation", channelId: channel.id }]) : [false];
    if (!channel || !visible) {
      refuse(res, 404, { code: "channel_not_found", error: "Not found, or you don't have access to this channel." });
      return;
    }
    const withAnnouncement = await attachChannelAnnouncement(viewer, channel);
    res.json({ announcement: withAnnouncement.announcement ?? null });
  } catch {
    res.status(500).json({ error: "Failed to read the channel announcement" });
  }
});

channelRouter.get("/:id/message-display-settings", async (req, res) => {
  try {
    const channel = await resolveMessageDisplayPrefsTarget(req, res);
    if (!channel) return;
    const prefs = await channelService.getUserChannelMessageDisplayPrefs(req.userId!, channel.id);
    res.json({
      collapseLongMessages: prefs.collapseLongMessages,
      prefsVersion: prefs.prefsVersion,
    });
  } catch {
    res.status(500).json({ error: "Failed to get channel message display settings" });
  }
});

channelRouter.patch("/:id/message-display-settings", async (req, res) => {
  try {
    const channel = await resolveMessageDisplayPrefsTarget(req, res);
    if (!channel) return;
    if (typeof req.body?.collapseLongMessages !== "boolean") {
      res.status(400).json({ error: "collapseLongMessages must be a boolean" });
      return;
    }
    const prefs = await channelService.setUserChannelMessageDisplayPrefs({
      userId: req.userId!,
      serverId: req.serverId!,
      channelId: channel.id,
      collapseLongMessages: req.body.collapseLongMessages,
    });
    emitMessageDisplayPrefsUpdated(req, channel.id, prefs);
    res.json({
      collapseLongMessages: prefs.collapseLongMessages,
      prefsVersion: prefs.prefsVersion,
    });
  } catch {
    res.status(500).json({ error: "Failed to update channel message display settings" });
  }
});

// Read-only progress surface for the settings drawer. Keep this before the
// generic /:id route so Express does not treat "conversion-jobs" as a channel
// id.
channelRouter.get("/conversion-jobs/:jobId", async (req, res) => {
  try {
    const job = await requireVisibleChannelConversionJob(req, res);
    if (!job) return;
    const converted = await channelService.getChannel(job.sourceChannelId);
    const [channelWithMetadata] = converted
      ? await channelConversionService.attachLatestChannelConversionJobs(await channelService.attachJointChannelMetadata([{ ...converted, joined: true }]))
      : [];
    res.json({ channel: channelWithMetadata ?? converted, conversionJob: channelConversionService.conversionJobView(job) });
  } catch (error) {
    sendJsonServerError(req, res, {
      error: "Failed to read conversion progress",
      logPrefix: "[ChannelConversion] progress read failed",
      err: error,
    });
  }
});

// Retry a failed conversion without re-running the ordinary-channel start
// eligibility gate. During rollout a source projection can already report
// `type=joint` while the durable job is still failed; the job/fence pair is
// the authority for this action.
channelRouter.post("/conversion-jobs/:jobId/retry", async (req, res) => {
  try {
    const job = await requireVisibleChannelConversionJob(req, res);
    if (!job) return;
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "federateChannels"))) {
      res.status(403).json({ error: "Only admins can retry channel conversion", code: "forbidden" });
      return;
    }
    if (job.status !== "failed") {
      res.status(409).json({
        error: "Only a failed conversion can be retried",
        code: "channel_conversion_retry_not_allowed",
      });
      return;
    }
    const retried = await runConversionCommand({
      id: conversionCommandId(req.body?.commandId), serverId: req.serverId!, sourceChannelId: job.sourceChannelId,
      requestedByUserId: req.userId!, kind: "retry", jobId: job.id,
    });
    const tracer = (req.app.get("serverTracer") as Tracer | undefined) ?? noopTracer;
    const jobSpan = startChannelConversionJobSpan(tracer, {
      event_kind: "channel_conversion",
      job_id: retried.id,
      channel_id: retried.sourceChannelId,
      phase: retried.phase,
      outcome: "ok",
    });
    void channelConversionService.runChannelConversionJob(retried.id, {
      io: req.app.get("io") as SocketServer | undefined,
      tracer,
      traceParent: jobSpan.context,
    }).then(async (completed) => {
      try {
        if (["done", "canceled", "failed"].includes(completed.status)) {
          await emitChannelConversionCompletion(
            req.app.get("io") as SocketServer | undefined,
            completed.id,
            completed.sourceChannelId,
          );
        }
        const current = await channelConversionService.getChannelConversionJob(completed.id);
        jobSpan.end(current?.status === "failed" ? "error" : "ok");
      } catch {
        jobSpan.end("error");
      }
    }).catch(() => jobSpan.end("error"));
    const refreshed = await channelService.getChannel(retried.sourceChannelId);
    const [channelWithMetadata] = refreshed
      ? await channelConversionService.attachLatestChannelConversionJobs(await channelService.attachJointChannelMetadata([{ ...refreshed, joined: true }]))
      : [];
    res.status(202).json({ channel: channelWithMetadata ?? refreshed, conversionJob: channelConversionService.conversionJobView(retried) });
  } catch (err: unknown) {
    console.error("[ChannelConversion] command request failed", { path: req.path, jobId: req.params.jobId, error: err });
    if (err instanceof channelConversionService.ChannelConversionError) {
      const status = err.code === "job_not_found" ? 404 : 409;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to retry channel conversion",
      code: "channel_conversion_retry_failed",
      logPrefix: "[ChannelConversion] command request failed",
      err,
    });
  }
});

// Cancellation releases the source after compensating any pre-cutover copy.
// Once audience cutover commits, the job remains fenced and is repaired forward.
channelRouter.post("/conversion-jobs/:jobId/cancel", async (req, res) => {
  try {
    const job = await requireVisibleChannelConversionJob(req, res);
    if (!job) return;
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "federateChannels"))) {
      res.status(403).json({ error: "Only admins can cancel channel conversion", code: "forbidden" });
      return;
    }
    const canceled = await runConversionCommand({
      id: conversionCommandId(req.body?.commandId), serverId: req.serverId!, sourceChannelId: job.sourceChannelId,
      requestedByUserId: req.userId!, kind: "cancel", jobId: job.id,
    });
    const { converted: restored, channelWithMetadata } = await emitChannelConversionCompletion(
      req.app.get("io") as SocketServer | undefined, canceled.id, canceled.sourceChannelId,
    );
    res.json({ channel: channelWithMetadata ?? restored, conversionJob: channelConversionService.conversionJobView(canceled) });
  } catch (err: unknown) {
    console.error("[ChannelConversion] command request failed", { path: req.path, jobId: req.params.jobId, error: err });
    if (err instanceof channelConversionService.ChannelConversionError) {
      const status = err.code === "job_not_found" ? 404 : 409;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to cancel channel conversion",
      code: "channel_conversion_cancel_failed",
      logPrefix: "[ChannelConversion] command request failed",
      err,
    });
  }
});

// Get channel details
channelRouter.get("/:id", async (req, res) => {
  try {
    // A non-uuid :id already 404'd in the router.param guard (task #12).
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    // Every type uses the same current read policy. Threads inherit their
    // parent policy, and public channels still need Guest visibility checks.
    if (!await channelService.canUserAccessChannel(channel.id, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    addTraceEvent("channels.get.target", channelGetTargetTraceAttrs(channel.type, req.headers[CHANNEL_FETCH_REASON_HEADER]));
    // Include `joined` to align response shape with `/channels` list. Without
    // this, first-paint hydration via `ensureChannel()` (added in PR #1549)
    // treats `joined === undefined` as not-joined and flashes a "Join channel"
    // CTA for users who are already members. DMs are always joined for the
    // recipient by definition; for regular/private channels we check the
    // human membership table. (#engineering:e4f52605 / staging-only regression
    // observed by @xxchan; root-cause + patch reviewed by @哭哭 + @Leiysky.)
    // #all uses implicit membership (no channelHumans row — addHuman is a no-op
    // for the system #all channel), so isChannelHuman is false for members. Mirror
    // the listChannels contract and treat an enabled #all as joined; otherwise a
    // direct GET /channels/:id (ensureChannel navigation) flashes a "Join #all" CTA
    // for someone already in it, until a full /channels refresh corrects it.
    const readableDm = channel.type === "dm"
      ? await channelService.getReadableDMChannelForUser(channel.id, req.userId!)
      : null;
    // A joint thread's local projection has no parent columns; expose this
    // server's projection of the parent joint channel and the canonical parent
    // message, as thread pushes do. No projection leaves them null.
    const jointThreadParent = channel.type === "thread" && !channel.parentMessageId
      ? await channelService.resolveThreadParent(channel)
      : null;
    const channelForResponse = readableDm
      ? { ...channel, ...readableDm, serverId: channel.serverId }
      : jointThreadParent
        ? { ...channel, parentMessageId: jointThreadParent.parentMessageId, parentChannelId: jointThreadParent.parentChannelId }
        : channel;
    const requesterRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    const joined = channel.type === "dm"
      ? true
      : requesterRole !== "guest" && channelService.isEnabledAllChannel(channel)
        ? true
        : channelService.isAllSystemChannel(channel) && requesterRole === "guest"
          ? false
          : await channelService.isChannelHuman(channel.id, req.userId!);
    const activityMuteSupported = await channelService.userActivityMuteSupported(channel);
    // A DM carries its stored mute even when it can no longer be muted (its
    // App bot was removed), so a mute is always undoable; the client replaces
    // its DM row with this response.
    const activityMuteState = activityMuteSupported || channel.type === "dm"
      ? await channelService.getInboxTargetActivityMuteState("user", req.userId!, channel.id)
      : {};
    const messageDisplayPrefs = channel.type !== "thread"
      ? await channelService.getUserChannelMessageDisplayPrefs(req.userId!, channel.id)
      : { collapseLongMessages: false, prefsVersion: 0 };
    const readState = await channelService.getReadStateSnapshot(req.userId!, channel.id);
    const peerReadHydrate = channel.type === "channel" || channel.type === "private" || channel.type === "joint" || channel.type === "dm" || channel.type === "thread"
      ? await getPeerReadHydrate({
          serverId: req.serverId!,
          channelId: channel.id,
          viewerKind: "human",
          viewerId: req.userId!,
        })
      : null;
    const loungeAgentId = channel.type === "channel"
      ? (await getLoungeAgentIds([channel.id])).get(channel.id) ?? null
      : null;
    const [channelWithJointMetadata] = await channelService.attachJointChannelMetadata([{
      ...channelForResponse,
      loungeAgentId,
      joined,
      ...activityMuteState,
      collapseLongMessages: messageDisplayPrefs.collapseLongMessages,
      displayPrefsVersion: messageDisplayPrefs.prefsVersion,
      ...readState,
      ...(peerReadHydrate ?? {}),
      activityMuteSupported,
      // For the leave confirmation: this person is the joint's last member
      // from the host, so leaving archives it for every side.
      ...(channel.type === "joint" && joined ? { leaveArchivesJoint: await isLastJointHostSideMember(channel.id, req.userId!) } : {}),
    }]);
    const [channelWithMetadata] = await channelService.attachExternalBridgeMetadata([channelWithJointMetadata]);
    const [channelWithConversionJob] = await channelConversionService.attachLatestChannelConversionJobs([channelWithMetadata]);
    // Same rule as the list row (a Guest gets it on its own channel only).
    const [channelWithExternalRelation] = await channelService.attachExternalRelations(
      [channelWithConversionJob!],
      await resolveExternalRelationViewer(req.serverId!, req.userId!, requesterRole),
    );
    const [withLevel] = await withNotificationLevels(req.userId!, [channelWithExternalRelation!]);
    // Channel announcements: `announcement` (an Artifact homed here, null for none) only while channel_announcement_v0 is on.
    const withAnnouncement = await attachChannelAnnouncement({ type: "user", id: req.userId!, serverId: asServerId(req.serverId!) }, withLevel!);
    res.json(withVisitorVisible(await attachHumanChannelAuthorization(withAnnouncement, req.serverId!, req.userId!)));
  } catch {
    res.status(500).json({ error: "Failed to get channel" });
  }
});

// Archive channel (freezes writes, preserves name)
channelRouter.post("/:id/archive", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!["channel", "private", "joint"].includes(channel.type)) {
      res.status(400).json({ error: "Only regular channels can be archived" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const canArchive = await actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "archiveChannels");
    if (!canArchive) {
      res.status(403).json({ error: "Only admins can archive channels" });
      return;
    }

    const wasArchived = !!channel.archivedAt;
    // Archiving ends its Guests' server membership in the same commit; their
    // sockets, notifications and credentials are finished after it.
    const endedGuests: channelService.EndedChannelGuest[] = [];
    const updated = await withLockedChannelActorCapability({
          serverId: req.serverId!,
          channelId: channel.id,
          actorType: "user",
          actorId: req.userId!,
          capability: "archiveChannels",
          // The Guests the archive removes: their users rows first, with the archiver's.
          guessUserIds: () => channelService.archiveBoundGuestIds(channel.id),
        }, (tx, _context, lockedUserIds) => {
          endedGuests.length = 0; // A restarted attempt starts over.
          return channelService.archiveChannel(req.params.id, req.userId!, tx, { endedGuests, lockedUserIds });
        });
    let systemMessage: { content: string; causalActor: { type: "user"; id: string } } | undefined;
    if (!wasArchived) {
      const user = await userService.getUser(req.userId!);
      const userName = user?.displayName || user?.name || "Someone";
      systemMessage = { content: `📦 ${userName} archived this channel`, causalActor: { type: "user", id: req.userId! } };
    }
    // After commit: the ended Guests, their sockets, every projection's update
    // and the system message (shared with the joint host-side archive).
    await finishChannelArchive(req.app.get("io"), req.app.get("agentOrchestrator") as AgentOrchestrator, updated, { endedGuests, systemMessage });

    res.json(updated);
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg === "Channel capability required") {
      res.status(403).json({ error: "Only admins can archive channels" });
    } else if (msg.includes("#all") || msg.includes("Only regular")) {
      res.status(400).json({ error: msg });
    } else if (msg === "Channel not found") {
      res.status(404).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to archive channel" });
    }
  }
});

// Unarchive channel
channelRouter.post("/:id/unarchive", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!["channel", "private", "joint"].includes(channel.type)) {
      res.status(400).json({ error: "Only regular channels can be unarchived" });
      return;
    }
    // A host owner/admin may bring back the host's archived joint copy when
    // nobody from the host is left in it (channelActorHasCapability); the
    // unarchive rejoins them. Anyone else gets today's refusal.
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)
      && !(channel.type === "joint" && await actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "archiveChannels"))) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const canUnarchive = await actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "archiveChannels");
    if (!canUnarchive) {
      res.status(403).json({ error: "Only admins can unarchive channels" });
      return;
    }

    const wasArchived = !!channel.archivedAt;
    let rejoined = false;
    const updated = await withLockedChannelActorCapability({
          serverId: req.serverId!,
          channelId: channel.id,
          actorType: "user",
          actorId: req.userId!,
          capability: "archiveChannels",
          // The free plan's external channel rule is checked under them (ADMISSION_LOCK_ORDER).
          admissionServerIds: wasArchived ? await channelService.unarchiveAdmissionServerIds(channel.id) : [],
        }, async (tx, context) => {
          const unarchived = await channelService.unarchiveChannel(req.params.id, tx);
          // The host admin outside it (its host side was empty) rejoins in the
          // same commit, admitted by themself through the host: the host side
          // is no longer empty and they see the channel at once.
          if (context.jointAuthority && !context.canAccessChannel) {
            // Only with them on the host side again. A removal of theirs still
            // pending (an old membership not yet cleaned up) keeps them off it
            // and would end it after this commit (addHuman then either refuses
            // or finds the old row): refuse, and roll back the unarchive.
            const cleanupPending = new RefusalError(409, {
              code: "joint_cleanup_pending",
              error: "This channel is still finishing removing a member. Try again in a moment.",
              retryAfterSeconds: 5,
            });
            try {
              rejoined = await channelService.addHuman(channel.id, req.userId!, { executor: tx, actorUserId: req.userId!, jointChannelLock: "no key update" });
            } catch (error) {
              if (error instanceof Error && error.message === "Joint membership cleanup in progress") throw cleanupPending;
              throw error;
            }
            if (!rejoined || !await isJointHostSideMember(channel.id, req.userId!, tx)) throw cleanupPending;
          }
          return unarchived;
        });

    const io = req.app.get("io");
    if (updated.type === "joint") {
      await emitJointProjectionUpdates(io, updated.id);
    } else {
      await publishChannelUpdate(io, updated);
    }
    if (rejoined) emitChannelMembersUpdated(io, req.serverId!, updated, req.userId!);

    if (wasArchived) {
      const user = await userService.getUser(req.userId!);
      const userName = user?.displayName || user?.name || "Someone";
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
      messageService.broadcastSystemMessage(io, agentOrchestrator, req.params.id,
        `📤 ${userName} unarchived this channel`, {
          inboxFactPolicy: {
            mode: "record",
            producer: "channel.unarchive",
            reason: "channel unarchive is shared channel activity",
            causalActor: { type: "user", id: req.userId! },
          },
        }).catch(() => {});
    }

    res.json(updated);
  } catch (err: any) {
    if (err instanceof RefusalError) {
      refuse(res, err.status, err.refusal);
      return;
    }
    // Unarchiving would put a free server in a second external channel.
    if (sendExternalLimitError(res, err, req)) return;
    const msg = err?.message || "";
    if (msg === "Channel capability required") {
      res.status(403).json({ error: "Only admins can unarchive channels" });
    } else if (msg.includes("Only regular")) {
      res.status(400).json({ error: msg });
    } else if (msg === "Channel not found") {
      res.status(404).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to unarchive channel" });
    }
  }
});

// Delete channel
channelRouter.delete("/:id", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type === "joint") {
      res.status(400).json({ error: "Joint channels cannot be deleted; disconnect this server instead" });
      return;
    }
    // DMs: only participants can delete; regular/private channels: admin/owner only
    if (channel.type !== "dm") {
      if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "deleteChannels"))) {
        res.status(403).json({ error: "Only admins can delete channels" });
        return;
      }
    }
    await channelService.deleteChannel(req.params.id, { deletedByUserId: req.userId! });
    res.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || "";
    // The deleter's account retired or being deleted meanwhile (deleteChannel): as one who may not delete it.
    if (err instanceof JointActorUnavailableError) {
      res.status(403).json({ error: "Only admins can delete channels" });
    } else if (msg.includes("cannot be deleted")) {
      res.status(403).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to delete channel" });
    }
  }
});

channelRouter.post("/:id/disconnect", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type !== "joint") {
      res.status(400).json({ error: "Only joint channels can be disconnected" });
      return;
    }
    // The server capability is checked here; disconnectJointChannel also requires the admin to be able to open the
    // channel. A non-host copy whose last member left is disconnected
    // automatically (jointHumanMembershipMirror), so none is stranded.
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "federateChannels"))) {
      if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
      res.status(403).json({ error: "Only admins can disconnect joint channels" });
      return;
    }

    // Resolve before disconnecting: afterwards this projection no longer
    // resolves, and the remaining participants still need the update (their
    // server list changed, and the joint may be back within its limit).
    const parentJointId = await resolveGatingParentJointId(getDb(), req.params.id, req.serverId!);
    const { canonicalChannelId } = await channelService.disconnectJointChannel(req.params.id, req.userId!);
    const io = req.app.get("io");
    io?.to(`server:${req.serverId}`).emit("channel:updated", { channelId: req.params.id });
    await broadcastJointDisconnectSystemMessage(req, canonicalChannelId, req.serverId!, req.userId!).catch((err: unknown) => {
      console.error("joint disconnect: failed to post the system message:", err);
    });
    if (parentJointId) {
      await emitJointLimitStateChange(io, parentJointId).catch((err: unknown) => {
        console.error("joint disconnect: failed to notify remaining participants:", err);
      });
    }
    res.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || "";
    if (err instanceof channelService.JointHostDisconnectError) {
      res.status(403).json({ error: err.message, code: err.code });
    } else if (err instanceof channelService.JointGuestsPresentError) {
      refuse(res, 409, { code: err.code, error: err.message });
    } else if (msg === "Joint channel not found" || msg === "Channel not found") {
      res.status(404).json({ error: "Channel not found" });
    } else if (msg.includes("Only joint")) {
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to disconnect joint channel" });
    }
  }
});

/** The 404 every channel route here answers for a channel that is missing or
 * hidden from the caller: byte-identical, so the two can't be told apart. */
function channelNotFound(res: Response) {
  // refusal-ok: must stay byte-identical to this router's other "Channel not found" 404s (no existence oracle)
  res.status(404).json({ error: "Channel not found" });
}

/**
 * The host's owner/admin disconnects a participant server from a joint channel
 * (external_channels_v1 on for the host; off, the route answers as an
 * unknown channel). `:id` is the host's copy; `:serverId` the participant.
 * A server disconnecting itself stays POST /:id/disconnect.
 */
channelRouter.post("/:id/joint-servers/:serverId/disconnect", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId || !await canSeeChannel(channel, req.userId!, req.serverId!)) {
      channelNotFound(res);
      return;
    }
    if (!(await evaluateFeatureFlag({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId: req.serverId!, userId: req.userId! })).enabled) {
      channelNotFound(res);
      return;
    }
    if (channel.type !== "joint") {
      refuse(res, 400, { code: "not_joint_host", error: new channelService.JointNotHostError().message });
      return;
    }
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "federateChannels"))) {
      refuse(res, 403, { code: "forbidden", error: "Only admins of the host server can disconnect another server." });
      return;
    }
    const targetServerId = req.params.serverId;
    if (!ANY_UUID_RE.test(targetServerId)) {
      const notConnected = new channelService.JointServerNotConnectedError();
      refuse(res, 404, { code: notConnected.code, error: notConnected.message });
      return;
    }
    if (targetServerId === req.serverId) {
      refuse(res, 400, { code: "host_cannot_be_disconnected", error: "The host server can't disconnect from its own channel. Archive the channel instead." });
      return;
    }

    const result = await channelService.disconnectParticipantServerByHost(req.params.id, targetServerId, req.userId!);
    const io = req.app.get("io");
    // Both sides refresh: the participant's copy is gone, the host's server list changed.
    io?.to(`server:${targetServerId}`).emit("channel:updated", { channelId: result.targetChannelId });
    io?.to(`server:${req.serverId}`).emit("channel:updated", { channelId: req.params.id });
    await broadcastJointDisconnectSystemMessage(req, result.canonicalChannelId, targetServerId, req.userId!, req.serverId!).catch((err: unknown) => {
      console.error("joint host disconnect: failed to post the system message:", err);
    });
    await emitJointLimitStateChange(io, result.jointChannelId).catch((err: unknown) => {
      console.error("joint host disconnect: failed to notify remaining participants:", err);
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (err instanceof channelService.JointNotHostError || err instanceof channelService.JointServerNotConnectedError
      || err instanceof channelService.JointGuestsPresentError) {
      const status = err instanceof channelService.JointNotHostError ? 400 : err instanceof channelService.JointServerNotConnectedError ? 404 : 409;
      refuse(res, status, { code: err.code, error: err.message });
    } else if (msg === "Channel capability required") {
      refuse(res, 403, { code: "forbidden", error: "Only admins of the host server can disconnect another server." });
    } else if (msg === "Channel not found") {
      channelNotFound(res);
    } else {
      sendJsonServerError(req, res, {
        error: "Couldn't disconnect the server. Try again.",
        logPrefix: "joint host disconnect failed:",
        err,
      });
    }
  }
});

/**
 * A channel member connects servers they own or administer to the channel,
 * no host approval (jointMemberConnectService; design v3). `:id` is the
 * caller's own server's copy; the host's copy is resolved from it. The host's
 * external_channels_v1 decides first: off, and for anyone not a member, the
 * same 404 as an unknown
 * channel. A public channel: channel_not_invitable. Each chosen server is
 * answered on its own, as Your servers answers (connected, connecting while a
 * private channel is converted, or refused with why).
 */
/**
 * Connect your servers, on opening (design v3 F): the caller's servers that
 * could connect to the channel (they own or administer it, not yet in it),
 * each with its own Free external-channel limit (`atLimit`), whether the
 * caller may upgrade it (`canUpgrade`: manageBilling, an owner) and its
 * owners for "Ask an owner". The same gates and the same 404 as the POST.
 */
channelRouter.get("/:id/connect-my-servers", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId || !await canSeeChannel(channel, req.userId!, req.serverId!)) {
      channelNotFound(res);
      return;
    }
    const hostServerId = await jointMemberConnectService.memberConnectHostServerId(channel);
    if (!hostServerId || !await jointMemberConnectService.memberConnectEnabled(hostServerId, req.userId!)) {
      channelNotFound(res);
      return;
    }
    const entry = await jointMemberConnectService.resolveMemberConnectEntry(channel, req.userId!);
    if (!entry) {
      channelNotFound(res);
      return;
    }
    res.json({ servers: await jointMemberConnectService.listMemberConnectableServers(entry, req.userId!) });
  } catch (err) {
    if (err instanceof jointMemberConnectService.MemberConnectRefusal) {
      refuse(res, err.status, { code: err.code, error: err.message });
    } else {
      sendJsonServerError(req, res, {
        error: "Failed to list your servers to connect",
        code: "internal_server_error",
        logPrefix: "[Channels] Failed to list a member's servers to connect",
        err,
      });
    }
  }
});

channelRouter.post("/:id/connect-my-servers", async (req, res) => {
  const serverIds = (req.body as { serverIds?: unknown } | null)?.serverIds;
  // Set once the attempt is made (the 404s before it are not attempts): the host whose switch and plan the rows take.
  let attemptHost: string | null = null;
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId || !await canSeeChannel(channel, req.userId!, req.serverId!)) {
      channelNotFound(res);
      return;
    }
    const hostServerId = await jointMemberConnectService.memberConnectHostServerId(channel);
    if (!hostServerId || !await jointMemberConnectService.memberConnectEnabled(hostServerId, req.userId!)) {
      channelNotFound(res);
      return;
    }
    const entry = await jointMemberConnectService.resolveMemberConnectEntry(channel, req.userId!);
    if (!entry) {
      channelNotFound(res);
      return;
    }
    // From here on the attempt is made: each way it ends is a row (the 404s above are not attempts).
    attemptHost = entry.hostChannel.serverId;
    const result = await jointMemberConnectService.connectMyServersToChannel(entry, req.userId!, serverIds, {
      revalidateExternalPrivacy: req.app.get("slackBridgePrivacyRevalidator"),
    });
    await publishExternalConnections(req, result.connections);
    if (result.servers.some((server) => server.state !== "refused")) emitExternalRelationChanged(req, entry.hostChannel.id);
    noteServerConnectPaywallHits(req, result.servers);
    res.json({ servers: result.servers.map(serializeServerConnectOutcome) });
    recordServerConnectOutcomes(req, res, {
      path: "self_connect", outcomes: result.servers, multi: choseSeveral(serverIds), server: req.serverId!, host: { hostServerId: entry.hostChannel.serverId },
    });
  } catch (err) {
    // The not_found answered as the channel-not-found 404 is not an attempt either.
    const answeredNotFound = err instanceof externalInviteService.ExternalInviteError && err.code === "not_found";
    if (attemptHost !== null && !answeredNotFound) {
      const outcome: ConnectFinishedOutcome = err instanceof jointMemberConnectService.MemberConnectRefusal || err instanceof externalInviteService.ExternalInviteError
        ? refusedOutcome(err.code)
        : err instanceof externalInviteConnectService.ExternalConnectError && err.code === "invalid_server" ? refusedOutcome("invalid_input") : { result: "error" };
      recordConnectFinished(req, [{ path: "self_connect", outcome, multi: choseSeveral(serverIds), server: req.serverId!, host: { hostServerId: attemptHost } }]);
    }
    if (err instanceof jointMemberConnectService.MemberConnectRefusal) {
      refuse(res, err.status, { code: err.code, error: err.message });
    } else if (err instanceof externalInviteConnectService.ExternalConnectError && err.code === "invalid_server") {
      refuse(res, 400, { code: "invalid_input", error: "serverIds must be a list of 1 to 29 servers" });
    } else if (err instanceof externalInviteService.ExternalInviteError && err.code === "not_found") {
      channelNotFound(res);
    } else if (err instanceof externalInviteService.ExternalInviteError) {
      refuse(res, 409, { code: err.code, error: err.message });
    } else {
      sendJsonServerError(req, res, {
        error: "Failed to connect your servers",
        code: "internal_server_error",
        logPrefix: "[Channels] Failed to connect a member's servers",
        err,
      });
    }
  }
});

channelRouter.post("/:id/joint-invite/resend", async (req, res) => {
  try {
    if (await refuseRetiredJointEntryWithExternalChannels(req, res, "joint_server_invite_retired")) return;
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type !== "joint") {
      res.status(400).json({ error: "Only joint channels can resend joint invites" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "federateChannels"))) {
      res.status(403).json({ error: "Only admins can resend joint channel invites" });
      return;
    }

    // A resend re-emails every pending invitee: it spends the same hourly
    // budget of invited people as the invites themselves (jointInviteRateLimit).
    const result = await channelService.resendPendingJointChannelInvites({
      localChannelId: req.params.id,
      fromServerId: req.serverId!,
      requestedByUserId: req.userId!,
      admitResend: async (people) => {
        const admission = await admitJointInvite(req.userId!, people);
        if (admission.admitted) return;
        throw new RefusalError(429, {
          code: "joint_invite_rate_limited",
          error: "Too many joint channel invites. Try again later.",
          retryAfterSeconds: admission.retryAfterSeconds,
        });
      },
    });
    res.json(result);
  } catch (err: any) {
    const msg = err?.message || "";
    if (err instanceof RefusalError) {
      refuse(res, err.status, err.refusal);
    } else if (msg === "Joint channel not found" || msg === "Channel not found") {
      res.status(404).json({ error: "Channel not found" });
    } else if (msg.includes("No pending")) {
      res.status(409).json({ error: msg });
    } else if (msg.includes("Only joint")) {
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to resend joint channel invite" });
    }
  }
});

channelRouter.post("/:id/convert-to-joint", (_req, res) => {
  // Retired on every Server (#wg-rbac:#50; cindyz: the old conversion entry
  // should not exist): a channel becomes joint only by inviting people outside
  // the Server, which external_channels_v1 allows. Before any lookup.
  refuseRetiredJointEntry(res, "joint_conversion_retired");
});

channelRouter.post("/:id/joint-invites", async (req, res) => {
  try {
    if (await refuseRetiredJointEntryWithExternalChannels(req, res, "joint_server_invite_retired")) return;
    const { targetServerSlug, invitedPeople, sameAdmin } = req.body || {};
    if (typeof targetServerSlug !== "string" || !targetServerSlug.trim()) {
      res.status(400).json({ error: "Invite server slug is required" });
      return;
    }
    const selectedInvitedPeople = normalizeStringList(invitedPeople, channelService.MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET);
    if (selectedInvitedPeople.length === 0) {
      res.status(400).json({ error: "At least one invited person is required" });
      return;
    }
    if (!await admitJointInviteOrRefuse(req, res, selectedInvitedPeople.length)) return;

    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type !== "joint") {
      res.status(400).json({ error: "Only joint channels can invite servers" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "federateChannels"))) {
      res.status(403).json({ error: "Only admins can invite servers to joint channels" });
      return;
    }

    const result = await channelService.inviteServerToJointChannel({
      localChannelId: req.params.id,
      fromServerId: req.serverId!,
      invitedByUserId: req.userId!,
      targetServerSlug,
      invitedPeople: selectedInvitedPeople,
      sameAdmin: sameAdmin === true,
    });
    const [channelWithMetadata] = await channelService.attachJointChannelMetadata([{ ...channel, joined: true }]);
    const io = req.app.get("io") as SocketServer | undefined;
    await emitJointProjectionUpdates(io, channel.id);
    await emitSameAdminJointProjections(io, req.userId!, result.acceptedProjections);
    res.json({ ...channelWithMetadata, jointInvites: result.invites, jointInvite: result.invites[0] ?? null });
  } catch (err: any) {
    if (sendJointInviteValidationError(res, err)) return;
    if (sendJointLimitError(res, err, req)) return;
    // The inviter's account retired or being deleted meanwhile (inviteServerToJointChannel): as one who may not federate.
    if (err instanceof JointActorUnavailableError) {
      res.status(403).json({ error: "Only admins can invite servers to joint channels" });
      return;
    }
    const msg = err?.message || "";
    if (msg === "Joint channel not found" || msg === "Channel not found") {
      res.status(404).json({ error: msg === "Joint channel not found" ? "Channel not found" : msg });
    } else {
      sendJsonServerError(req, res, {
        error: "Failed to invite server to joint channel",
        code: "internal_server_error",
        logPrefix: "[Channels] Failed to invite server to joint channel",
        err,
      });
    }
  }
});

// ── External channel invites (#wg-rbac:#16, P2a-1) ──
// A host Server's owner or admin invites people outside the Server to a
// channel by email. Starting something new (preview, send, resend) is 404
// while external_channels_v1 is off for the host Server (the channel's, which
// must be the request's Server); listing and revoking open invites are not
// gated, so turning the flag off never strands one (plan §2a).

const EXTERNAL_INVITE_ERROR_STATUS: Record<externalInviteService.ExternalInviteErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  channel_membership_required: 403,
  invalid_input: 400,
  channel_not_invitable: 400,
  make_private_required: 400,
  channel_archived: 409,
  invite_not_pending: 409,
  connecting: 409,
  daily_cap: 429,
  invite_open: 409,
};

/**
 * The flag (unless `ungated`: list and revoke), then the channel in this
 * Server that the caller can see; answers 404 itself and returns false
 * otherwise. Who may act (host owner/admin) is the service's check either way.
 */
async function admitExternalInviteRequest(req: Request, res: Response, opts: { ungated?: true } = {}): Promise<boolean> {
  if (!opts.ungated) {
    const flag = await evaluateFeatureFlag({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId: req.serverId!, userId: req.userId! });
    if (!flag.enabled) {
      res.status(404).json({ error: "Not found" });
      return false;
    }
  }
  const channel = await channelService.getChannel(String(req.params.id));
  if (!channel || channel.serverId !== req.serverId || !await canSeeChannel(channel, req.userId!, req.serverId!)) {
    res.status(404).json({ error: "Channel not found" });
    return false;
  }
  return true;
}

/** `emails`: 1 to 20 strings, one address each (the client splits pasted text). */
function parseExternalInviteEmails(body: unknown): string[] | null {
  const emails = (body as { emails?: unknown } | null)?.emails;
  if (!Array.isArray(emails) || emails.length === 0 || emails.length > externalInviteService.EXTERNAL_INVITE_MAX_ENTRIES) return null;
  return emails.every((email): email is string => typeof email === "string") ? emails : null;
}

function sendExternalInviteError(req: Request, res: Response, err: unknown, action: string): void {
  if (err instanceof externalInviteService.ExternalInviteError) {
    setRequestTraceErrorCode(res, err.code);
    res.status(EXTERNAL_INVITE_ERROR_STATUS[err.code]).json({ error: err.message, code: err.code });
    return;
  }
  // The send-time limits (free plan, slots): the host's own, as the accept's body names them.
  if (sendExternalLimitError(res, err, req)) return;
  sendJsonServerError(req, res, {
    error: `Failed to ${action}`,
    code: "internal_server_error",
    logPrefix: `[Channels] Failed to ${action}`,
    err,
  });
}

/**
 * `hasExternalRelation` may have changed: an id-only `channel:updated` makes
 * each client in the channel re-read its own row (GET /channels/:id), so the
 * field reaches only the viewers it is for (a broadcast row cannot carry it).
 */
function emitExternalRelationChanged(req: Request, channelId: string): void {
  (req.app.get("io") as SocketServer | undefined)?.to(`channel:${channelId}`).emit("channel:updated", { channelId });
}

const INVALID_EXTERNAL_INVITE_EMAILS = {
  error: `emails must be a list of 1 to ${externalInviteService.EXTERNAL_INVITE_MAX_ENTRIES} email addresses`,
  code: "invalid_input",
};

// The review before Create Channel's External creates the channel (design
// E1): the same preview, for the request's Server, with no channel yet.
channelRouter.post("/external-invites/preview", async (req, res) => {
  try {
    const flag = await evaluateFeatureFlag({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId: req.serverId!, userId: req.userId! });
    if (!flag.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const emails = parseExternalInviteEmails(req.body);
    if (!emails) {
      res.status(400).json(INVALID_EXTERNAL_INVITE_EMAILS);
      return;
    }
    res.json(await externalInviteService.previewExternalInvitesForNewChannel(req.serverId!, req.userId!, emails));
  } catch (err) {
    sendExternalInviteError(req, res, err, "preview external invites");
  }
});

/**
 * Members of the host Server among a send's addresses join the channel
 * (design A2 "will be added"), as the inviter adding them with Add Member
 * would: the addChannelMembers capability, the membership notice and the
 * same events. One that can't be added stays in `skipped.alreadyMembers`; the
 * invites are sent either way. Returns the addresses added.
 */
async function addInvitedServerMembers(
  req: Request,
  channelId: string,
  members: ReadonlyArray<{ userId: string; email: string }>,
): Promise<string[]> {
  if (members.length === 0) return [];
  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.archivedAt) return [];
  if (!await actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "addChannelMembers")) return [];
  const io = req.app.get("io") as SocketServer | undefined;
  const added: string[] = [];
  // In turn, at most 20 per send (EXTERNAL_INVITE_MAX_ENTRIES), each under its own capability lock as POST /:id/members adds one.
  for (const member of members) {
    try {
      const targetUser = await userService.getUser(member.userId);
      if (!targetUser) continue;
      const persisted = await withLockedChannelActorCapability({
        serverId: req.serverId!,
        channelId: channel.id,
        actorType: "user",
        actorId: req.userId!,
        capability: "addChannelMembers",
        humanSubjectIds: [member.userId],
      }, (tx) => messageService.addHumanWithMembershipSystemMessage({
        channel,
        userId: member.userId,
        userName: targetUser.name,
        causalActor: { type: "user", id: req.userId! },
        executor: tx,
      }));
      if (persisted.added) {
        await broadcastMembershipSystemMessage(
          req,
          channel,
          { type: "human", id: targetUser.id, name: targetUser.name },
          "added",
          req.userId!,
          persisted.message,
        );
      }
      emitChannelMembersUpdated(io, req.serverId!, channel, member.userId);
      added.push(member.email);
    } catch (err) {
      console.error("[Channels] Failed to add an invited server member to the channel:", err);
    }
  }
  return added;
}

channelRouter.post("/:id/external-invites/preview", async (req, res) => {
  try {
    if (!await admitExternalInviteRequest(req, res)) return;
    const emails = parseExternalInviteEmails(req.body);
    if (!emails) {
      res.status(400).json(INVALID_EXTERNAL_INVITE_EMAILS);
      return;
    }
    res.json(await externalInviteService.previewExternalInvites(req.params.id, req.userId!, emails));
  } catch (err) {
    sendExternalInviteError(req, res, err, "preview external invites");
  }
});

channelRouter.post("/:id/external-invites", async (req, res) => {
  try {
    if (!await admitExternalInviteRequest(req, res)) return;
    const emails = parseExternalInviteEmails(req.body);
    const makePrivate = (req.body as { makePrivate?: unknown } | null)?.makePrivate;
    if (!emails || (makePrivate !== undefined && typeof makePrivate !== "boolean")) {
      res.status(400).json(emails ? { error: "makePrivate must be a boolean", code: "invalid_input" } : INVALID_EXTERNAL_INVITE_EMAILS);
      return;
    }
    const result = await externalInviteService.sendExternalInvites(req.params.id, req.userId!, emails, {
      makePrivate,
      onEmails: inviteEmailRecorder(req, req.userId!, "send"),
    });
    if (result.madePrivate) await publishChannelUpdate(req.app.get("io"), result.madePrivate);
    if (result.sent.length > 0) emitExternalRelationChanged(req, req.params.id);
    const added = await addInvitedServerMembers(req, req.params.id, result.membersToAdd);
    const notAdded = result.skipped.alreadyMembers.filter((email) => !added.includes(email));
    res.json({ sent: result.sent, added, skipped: { ...result.skipped, alreadyMembers: notAdded } });
  } catch (err) {
    sendExternalInviteError(req, res, err, "send external invites");
  }
});

// "Your servers": the host owner/admin connects servers of theirs they own
// or administer, now (no email, no approval; Create Joint Channel's direct
// connect). Each server is answered on its own (connected, connecting while
// the channel is converted, or refused with why). A public channel becomes
// private with it (makePrivate), as with a send.
channelRouter.post("/:id/external-connect-servers", async (req, res) => {
  const body = req.body as { serverIds?: unknown; makePrivate?: unknown } | null;
  // The caller's own server, the host (its owner or admin decides each server).
  // The host (the request's server): the row's server when the caller is its full member, and the switch and plan.
  const row = { path: "host_direct", multi: choseSeveral(body?.serverIds), server: req.serverId!, host: { hostServerId: req.serverId! } } as const;
  let attempted = false;
  try {
    // A channel they cannot see, or the feature off: not an attempt.
    if (!await admitExternalInviteRequest(req, res)) return;
    attempted = true;
    if (body?.makePrivate !== undefined && typeof body.makePrivate !== "boolean") {
      recordConnectFinished(req, [{ ...row, outcome: refusedOutcome("invalid_input") }]);
      res.status(400).json({ error: "makePrivate must be a boolean", code: "invalid_input" });
      return;
    }
    const result = await externalInviteConnectService.connectOwnServersToChannel(
      req.params.id, req.userId!, body?.serverIds, { makePrivate: body?.makePrivate }, { revalidateExternalPrivacy: req.app.get("slackBridgePrivacyRevalidator") },
    );
    if (result.madePrivate) await publishChannelUpdate(req.app.get("io"), result.madePrivate);
    await publishExternalConnections(req, result.connections);
    // As the revoke route: an open invite replaced by this one was revoked.
    if (result.replacedInviteId || result.servers.some((server) => server.state !== "refused")) emitExternalRelationChanged(req, req.params.id);
    noteServerConnectPaywallHits(req, result.servers);
    res.json({ servers: result.servers.map(serializeServerConnectOutcome) });
    recordServerConnectOutcomes(req, res, { ...row, outcomes: result.servers });
  } catch (err) {
    if (attempted) {
      const outcome: ConnectFinishedOutcome = err instanceof externalInviteConnectService.ExternalConnectError ? refusedOutcome("invalid_input")
        : err instanceof externalInviteService.ExternalInviteError ? refusedOutcome(err.code)
        : err instanceof ExternalChannelLimitError ? refusedOutcome(err.code, err.limitSide)
        : { result: "error" };
      recordConnectFinished(req, [{ ...row, outcome }]);
    }
    if (err instanceof externalInviteConnectService.ExternalConnectError) {
      res.status(400).json({ error: "serverIds must be a list of 1 to 29 servers", code: "invalid_input" });
      return;
    }
    sendExternalInviteError(req, res, err, "connect servers");
  }
});

channelRouter.get("/:id/external-invites", async (req, res) => {
  try {
    // Not flag-gated: admins see (and can revoke) open invites with the flag off.
    if (!await admitExternalInviteRequest(req, res, { ungated: true })) return;
    res.json(await externalInviteService.listChannelExternalInvites(req.params.id, req.userId!));
  } catch (err) {
    sendExternalInviteError(req, res, err, "list external invites");
  }
});

channelRouter.post("/:id/external-invites/:inviteId/resend", async (req, res) => {
  try {
    if (!await admitExternalInviteRequest(req, res)) return;
    res.json(await externalInviteService.resendExternalInvite(req.params.id, req.params.inviteId, req.userId!, {
      onEmails: inviteEmailRecorder(req, req.userId!, "resend"),
    }));
  } catch (err) {
    sendExternalInviteError(req, res, err, "resend external invite");
  }
});

channelRouter.delete("/:id/external-invites/:inviteId", async (req, res) => {
  try {
    // Not flag-gated (plan §2a: admins can still revoke pending invites).
    if (!await admitExternalInviteRequest(req, res, { ungated: true })) return;
    await externalInviteService.revokeExternalInvite(req.params.id, req.params.inviteId, req.userId!);
    emitExternalRelationChanged(req, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    sendExternalInviteError(req, res, err, "revoke external invite");
  }
});

// Get agents in channel
channelRouter.get("/:id/agents", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const agentList = await channelService.getChannelAgents(req.params.id);
    res.json(agentList);
  } catch {
    res.status(500).json({ error: "Failed to get agents" });
  }
});

// Stop all agents in channel (emergency stop)
channelRouter.post("/:id/stop-all-agents", async (req, res) => {
  try {
    // Stopping agents is a server owner/admin's call (cindyz, 2026-10-29); a
    // member's stop-all reaches only the agents that member may stop alone
    // (ones they created, their own assistant).
    if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "controlAgentRuntime")) {
      res.status(403).json({ error: "The `controlAgentRuntime` capability is required to stop all agents in a channel" });
      return;
    }
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const agents = await channelService.getChannelAgents(req.params.id);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    // A personal assistant is decided on its own: only its owner, or a server
    // owner/admin (who then notifies the owner), may stop it.
    const callerRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    const assistants = await assistantsAmong(agents.map((agent) => agent.id));
    const creators = actorRoleHasServerCapability(callerRole, "stopAgents")
      ? null
      : new Map((await agentService.getAgentsByIds(agents.map((agent) => agent.id))).map((row) => [row.id, row]));
    const results: { agentId: string; ok: boolean; reason?: string; error?: string }[] = [];
    await Promise.allSettled(
      agents.map(async (agent) => {
        const assistant = assistants.get(agent.id);
        if (assistant && decideAgentResourceAuthority(callerRole, req.userId!, assistant, "stopAgents", { stop: true }) !== "allowed") {
          results.push({ agentId: agent.id, ok: false, reason: "assistant_owner_only" });
          return;
        }
        const row = creators?.get(agent.id);
        if (!assistant && creators && !(row?.creatorType === "user" && row.creatorId === req.userId)) {
          results.push({ agentId: agent.id, ok: false, reason: "forbidden" });
          return;
        }
        try {
          if (assistant) {
            // The assistant Stop path: an admin pauses it and its owner is told.
            const stopped = await stopAssistant({
              io: req.app.get("io") as SocketServer | undefined,
              orchestrator: agentOrchestrator,
              serverId: req.serverId!,
              agent: assistant,
              actorUserId: req.userId!,
            });
            results.push(stopped.ok ? { agentId: agent.id, ok: true } : { agentId: agent.id, ok: false, reason: stopped.code });
            return;
          }
          // A person's Stop on the channel's agents: `owner_stop` (it also ends
          // the agent's `raft proc` jobs), as for a single agent's Stop.
          await agentOrchestrator.stopAgent(agent.id, "manual", { daemonReason: "owner_stop" });
          results.push({ agentId: agent.id, ok: true });
        } catch (err: unknown) {
          results.push({ agentId: agent.id, ok: false, error: (err as Error).message });
        }
      })
    );
    res.json({ ok: true, stopped: results.filter((r) => r.ok).length, total: agents.length, results });
  } catch {
    res.status(500).json({ error: "Failed to stop agents" });
  }
});

// Resume all agents in channel (SOS recovery)
channelRouter.post("/:id/resume-all-agents", async (req, res) => {
  try {
    if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "controlAgentRuntime")) {
      res.status(403).json({ error: "The `controlAgentRuntime` capability is required to resume all agents in a channel" });
      return;
    }
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const { prompt, agentIds } = req.body as { prompt?: string; agentIds?: unknown };
    if (prompt && (typeof prompt !== "string" || prompt.length > 10000)) {
      res.status(400).json({ error: "Prompt must be a string under 10000 characters" });
      return;
    }
    if (agentIds !== undefined && (!Array.isArray(agentIds) || !agentIds.every((id) => typeof id === "string"))) {
      res.status(400).json({ error: "agentIds must be an array of agent ids" });
      return;
    }
    // A retry names only the agents the last attempt missed, so the ones that
    // already got the guidance do not get it again. Ids outside this channel are ignored.
    const requested = agentIds ? new Set(agentIds as string[]) : null;
    const agents = (await channelService.getChannelAgents(req.params.id))
      .filter((agent) => !requested || requested.has(agent.id));
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    // Only its owner may start a personal assistant.
    const callerRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    const assistants = await assistantsAmong(agents.map((agent) => agent.id));
    const results: { agentId: string; ok: boolean; reason?: string; error?: string }[] = [];
    await Promise.allSettled(
      agents.map(async (agent) => {
        const assistant = assistants.get(agent.id);
        if (assistant && decideAgentResourceAuthority(callerRole, req.userId!, assistant, "controlAgentRuntime") !== "allowed") {
          results.push({ agentId: agent.id, ok: false, reason: "assistant_owner_only" });
          return;
        }
        try {
          // RFC 071 §5: a person resumed the channel's agents: human starts (E3).
          const result = await agentOrchestrator.startAgent(agent.id, { resumePrompt: prompt, control: "human_start" });
          if (result.outcome === "skipped") {
            // Not started, so the person's prompt was not delivered. A held
            // wake lock means another start for this agent is in flight.
            results.push({ agentId: agent.id, ok: false, reason: result.reason === "wake_lock_held" ? "start_in_flight" : result.reason });
            return;
          }
          results.push({ agentId: agent.id, ok: true });
        } catch (err: unknown) {
          results.push({ agentId: agent.id, ok: false, error: (err as Error).message });
        }
      })
    );
    const started = results.filter((r) => r.ok).length;
    res.json({ ok: started === agents.length, started, total: agents.length, results });
  } catch {
    res.status(500).json({ error: "Failed to resume agents" });
  }
});

/**
 * A joint channel's roster lists people from every server in it. What a
 * reader learns about another server's people is what their joint profile
 * shows (`toChannelScopedHumanProfile`):
 * - their roles (server role, channel role on their own projection) stay
 *   with their organization: a row from another server, person or agent,
 *   carries none, so it reads as a plain member.
 * A row from the reader's own server is a member of it (its projection
 * requires that), so it is unchanged and only the other servers' rows are
 * checked.
 */
type ChannelRoster = Awaited<ReturnType<typeof channelService.getChannelMembers>>;
type ViewerRosterHuman = Omit<ChannelRoster["humans"][number], "role" | "serverRole" | "channelRole">
  & { role: string | null; serverRole?: string | null; channelRole?: string | null };
type ViewerRosterAgent = Omit<ChannelRoster["agents"][number], "serverRole" | "channelRole">
  & { serverRole?: string | null; channelRole?: string | null };
function projectJointRosterForViewer(
  rawMembers: ChannelRoster,
  viewerServerId: string,
): { agents: ViewerRosterAgent[]; humans: ViewerRosterHuman[] } {
  // Another server's agent: likewise no roles (as `toJointAgentProfile`).
  const members = {
    ...rawMembers,
    agents: rawMembers.agents.map((agent): ViewerRosterAgent => (
      agent.serverId === viewerServerId ? agent : { ...agent, serverRole: null, channelRole: null }
    )),
  };
  // Computed rows say directly whether the person is in the viewer's server
  // (their `serverId` is only the first display source); legacy rows are the
  // viewer's own when they come from its projection.
  const isViewerServerHuman = (human: ChannelRoster["humans"][number]) =>
    human.inViewerServer ?? human.serverId === viewerServerId;
  return {
    ...members,
    humans: members.humans.map((human): ViewerRosterHuman => (
      isViewerServerHuman(human)
        ? human
        : {
          ...human,
          role: null,
          serverRole: null,
          channelRole: human.isManager ? "admin" : null,
        }
    )),
  };
}

/**
 * The GET /api/channels/:id/members body for one human viewer of a channel
 * they can see (the caller checks). `only` (GET /api/sync/changes rebuilding
 * changed member rows) reads just these members (in the roster query, so a
 * join to #all reads one member, not the server) and leaves the external
 * members out; each row is the row the full roster shows that viewer.
 */
export async function buildChannelMembersView(
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  viewer: { serverId: ServerId; userId: string },
  agentOrchestrator: AgentOrchestrator,
  only?: channelService.ChannelMemberFilter,
) {
  const [rawMembers, externalMembers] = await Promise.all([
    channelService.getChannelMembers(channel.id, only),
    // GET /api/sync/changes rebuilds member rows only; it never reads these.
    only ? Promise.resolve([]) : channelService.getChannelExternalMembers(channel.id),
  ]);
  const members = projectJointRosterForViewer(rawMembers, viewer.serverId);
  const viewerContext = await resolveChannelActorContext(
    viewer.serverId,
    channel.id,
    "user",
    viewer.userId,
  );
  const viewerCanChangeRoles = viewerContext
    ? channelActorHasCapability(viewerContext, "changeChannelMemberRoles")
    : false;
  // A joint roster merges every server's projection, but a role can only be
  // set on this server's own members (their rows are on this projection).
  const localMemberIds = channel.type === "joint" && viewerCanChangeRoles
    ? await channelService.getLocalChannelMemberIds(channel.id)
    : null;
  const computedCandidates=viewerCanChangeRoles && channel.type==="joint"
    ? await channelService.getJointHumanManagerCandidateIds(channel.id,rawMembers.humans.map(row=>row.id)) : null;
  const humanIds=new Set(rawMembers.humans.map(row=>row.id));
  const isRoleTargetable = (id: string) => (computedCandidates && humanIds.has(id) ? computedCandidates.has(id) : !localMemberIds
    || localMemberIds.userIds.has(id)
    || localMemberIds.agentIds.has(id));
  const projectMemberRole = <T extends { id: string; serverId?: string; serverRole?: string | null; role?: string | null; channelRole?: string | null; isManager?: boolean }>(member: T) => {
    // Human roster rows historically expose the server role as `role`,
    // while Agent rows use `serverRole`. Normalize before projecting the
    // effective channel role; otherwise every human in #all appears to be a
    // plain Member even when they inherit Owner/Admin authority.
    const serverRole = member.serverRole ?? member.role ?? "member";
    return {
      ...member,
      // Another server's member carries no role (projectJointRosterForViewer):
      // they read as a plain member, without a made-up server role.
      serverRole: member.serverId !== undefined && member.serverId !== viewer.serverId ? null : serverRole,
      effectiveChannelRole: member.isManager ? "admin" : serverRole === "owner"
        ? "owner"
        : serverRole === "admin" || member.channelRole === "admin"
          ? "admin"
          : serverRole === "guest" ? "guest" : "member",
      channelAdminBasis: member.isManager !== undefined ? null : serverRole === "owner" || serverRole === "admin"
        ? member.channelRole === "admin" ? "both" : "server_role"
        : member.channelRole === "admin" ? "channel_role" : null,
      canChangeChannelRole: viewerCanChangeRoles
        && isRoleTargetable(member.id)
        && member.id !== viewer.userId
        && serverRole !== "owner"
        && serverRole !== "admin"
        && serverRole !== "guest",
    };
  };
  if (viewerContext?.serverRole === "guest") {
    return {
      agents: members.agents.map((agent) => ({
        id: agent.id,
        // A joint channel (P3, decision A): each agent's own server, as for
        // people, so the Guest sees "from <server>" on other servers' agents.
        serverId: channel.type === "joint" ? agent.serverId : viewer.serverId,
        ...(channel.type === "joint" && "serverName" in agent ? { serverName: agent.serverName } : {}),
        ...(channel.type === "joint" && "serverSlug" in agent ? { serverSlug: agent.serverSlug } : {}),
        name: agent.name,
        displayName: agent.displayName,
        avatarUrl: agent.avatarUrl,
        status: agent.status,
        profileProjection: "channel_summary",
        effectiveChannelRole: "member",
        canChangeChannelRole: false,
      })),
      humans: members.humans.map((human) => ({
        id: human.id,
        name: human.name,
        displayName: human.displayName,
        avatarUrl: human.avatarUrl,
        gravatarHash: DEPRECATED_GRAVATAR_HASH,
        effectiveChannelRole: human.role === "guest" ? "guest" : "member",
        canChangeChannelRole: false,
        // A joint channel (P3, cindyz decision A): a Guest sees which server
        // each person comes from, as members do. Source tags and grouping
        // only: never their email, role or other memberships.
        ...(channel.type === "joint" ? {
          serverId: human.serverId,
          serverName: human.serverName,
          serverSlug: human.serverSlug,
          ...(human.servers !== undefined ? { servers: human.servers } : {}),
          ...(human.inViewerServer !== undefined ? { inViewerServer: human.inViewerServer } : {}),
        } : {}),
      })),
    };
  }
  // Every member's activity in one batch (#all lists the whole server):
  // one agent row read, then getActivities, instead of a read per agent.
  let activityById = new Map<string, { activity: string; activityDetail: string }>();
  // External agents' presence, as `GET /agents` serves it: a joint
  // channel's other-server agents are in no viewer's agent list, so their
  // `lastSeenAt` arrives here (and then by `agent:seen` pushes).
  const presenceById = new Map<string, { external: true; lastSeenAt: string | null }>();
  try {
    const rows = await agentService.getAgentsByIds(members.agents.map((agent) => agent.id));
    const externalIds = rows.filter((row) => isExternalAgentRuntime(row.runtime)).map((row) => row.id);
    const [activities, lastSeenByAgent] = await Promise.all([
      agentOrchestrator.getActivities(rows),
      externalIds.length > 0 ? getAgentsLastSeenAt(externalIds) : Promise.resolve(new Map<string, Date>()),
    ]);
    // #wg-rbac:#57: a member list is read by every viewer of the channel, so
    // an error activity reads as it does for a member: code and fixed sentence.
    const otherServerAgentIds = new Set(members.agents.filter((agent) => agent.serverId !== viewer.serverId).map((agent) => agent.id));
    activityById = new Map(rows.map((row, index) => {
      const resolved = activities[index]!;
      // A joint channel's other-server agent: its state only, as the joint
      // projection rooms get it (`agent:activity` with `detail: ""`), never its
      // work summary, typed diagnostics (spawn failure and model, stuck tool,
      // credential hold, ...) or error detail.
      if (otherServerAgentIds.has(row.id)) return [row.id, { activity: resolved.activity, activityDetail: "" }];
      const shown = { activity: resolved.activity, detailKind: resolved.activityDetailKind ?? null, detail: resolved.activityDetail };
      if (!isRuntimeErrorDetailActivity(shown)) return [row.id, resolved];
      const { detail, errorCode } = projectRuntimeErrorActivityDetail({ ...shown, lastRuntimeError: row.lastRuntimeError ?? null }, "member");
      return [row.id, { ...resolved, activityDetail: detail, ...(errorCode ? { activityErrorCode: errorCode } : {}) }];
    }));
    for (const id of externalIds) {
      presenceById.set(id, { external: true, lastSeenAt: lastSeenByAgent.get(id)?.toISOString() ?? null });
    }
  } catch {
    // As before, a failed activity read lists the member without activity.
  }
  const agents = members.agents.map((agent) => {
    const resolved = activityById.get(agent.id);
    const presence = presenceById.get(agent.id);
    return { ...projectMemberRole({ ...agent, ...resolved, ...presence }),
      ...(viewerContext?.jointAuthority && { canRemoveFromChannel: channelActorHasCapability(viewerContext, "removeChannelMembers", "agent")
        && (viewerContext.jointAuthority.isHostEntry || agent.serverId === viewer.serverId) }),
    };
  });
  const humans = members.humans.map(human => ({ ...projectMemberRole(human),
    ...(viewerContext?.jointAuthority && { canRemoveFromChannel: channelActorHasCapability(viewerContext, "removeChannelMembers") }),
  }));
  if (await shouldFilterChannelHumansForRequester(channel, viewer.userId)) {
    return {
      ...members,
      agents,
      humans: humans.filter((human) => shouldExposeHumanInHiddenChannelDirectory(human, viewer.userId)),
      externalMembers,
    };
  }
  return { ...members, agents, humans, externalMembers };
}

// Get all members (agents + humans) of a channel
channelRouter.get("/:id/members", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    res.json(await buildChannelMembersView(channel, { serverId: req.serverId!, userId: req.userId! }, agentOrchestrator));
  } catch {
    res.status(500).json({ error: "Failed to get members" });
  }
});

// Add a mixed batch of agents and humans to a channel. The whole target set is
// validated before the transaction, then membership rows and their durable
// system notices commit under one channel capability lock. Existing members
// are idempotent successes and are reported separately.
channelRouter.post("/:id/members/batch", async (req, res) => {
  try {
    const batch = parseChannelMemberBatch(req.body);
    if (!batch) {
      res.status(400).json({
        error: "userIds and agentIds must be arrays of UUIDs",
        code: "invalid_member_batch",
      });
      return;
    }
    if (batch.userIds.length === 0 && batch.agentIds.length === 0) {
      res.status(400).json({
        error: "At least one userId or agentId is required",
        code: "empty_member_batch",
      });
      return;
    }

    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const canSee = await canSeeChannel(channel, req.userId!, req.serverId!);
    const requesterRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    const canManageUnjoined = (channel.type === "channel" || channel.type === "private")
      && (requesterRole === "owner" || requesterRole === "admin");
    if (!canSee && !canManageUnjoined) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (isSubConversationType(channel.type)) {
      res.status(400).json({ error: "Thread membership is managed via follow/unfollow" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    // A DM has two fixed parties (canAddChannelMembers): a participant gets the
    // shared rule's refusal below; anyone else the same 404 as before.
    if (channel.type === "dm" && !await channelService.isChannelHuman(channel.id, req.userId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!(await actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "addChannelMembers"))) {
      res.status(403).json({ error: "You do not have permission to add channel members" });
      return;
    }

    if ((await filterLoungeOutsiderAgents(channel.id, batch.agentIds)).size > 0) {
      res.status(403).json({ error: AGENT_LOUNGE_OUTSIDER_ADD_REFUSAL, code: "agent_lounge_outsider" });
      return;
    }
    // Every target in two queries, not one or two per id.
    const [agentRows, memberUsers] = await Promise.all([
      agentService.getAgentsByIds(batch.agentIds),
      serverService.getServerMemberUsersByIds(req.serverId!, batch.userIds),
    ]);
    const agentById = new Map(agentRows.map((agent) => [agent.id, agent]));
    const targetAgents = batch.agentIds.map((agentId) => agentById.get(agentId) ?? null);
    const targetUsers = batch.userIds.map((userId) => memberUsers.get(userId) ?? null);
    const invalidAgentIds = batch.agentIds.filter((_, index) => targetAgents[index]?.serverId !== req.serverId || isOthersAssistant(targetAgents[index], req.userId!));
    if (invalidAgentIds.length > 0) {
      res.status(400).json({
        error: "One or more agents are not members of this server",
        code: "agents_not_in_server",
        invalidAgentIds,
      });
      return;
    }
    const invalidUserIds = batch.userIds.filter((_, index) => !targetUsers[index]);
    if (invalidUserIds.length > 0) {
      res.status(400).json({
        error: "One or more users are not members of this server",
        code: "users_not_in_server",
        invalidUserIds,
      });
      return;
    }

    const applyBatch = async (tx: DatabaseExecutor) => {
      const addedUserIds: string[] = [];
      const addedAgentIds: string[] = [];
      const userMessages = new Map<string, Awaited<ReturnType<typeof messageService.createMessage>>>();
      const agentMessages = new Map<string, Awaited<ReturnType<typeof messageService.createMessage>>>();

      for (let index = 0; index < batch.userIds.length; index += 1) {
        const userId = batch.userIds[index];
        const user = targetUsers[index];
        if (!userId || !user) throw new Error("User is not a member of this server");
        const result = await messageService.addHumanWithMembershipSystemMessage({
          channel,
          userId,
          userName: user.name,
          causalActor: { type: "user", id: req.userId! },
          executor: tx,
          actionCardMessageId: typeof req.body?.actionCardMessageId === "string" ? req.body.actionCardMessageId : undefined,
          actionCardConfirmationVersion: typeof req.body?.actionCardConfirmationVersion === "number" ? req.body.actionCardConfirmationVersion : undefined,
        });
        if (result.added) {
          addedUserIds.push(userId);
          if (result.message) userMessages.set(userId, result.message);
        }
      }
      for (let index = 0; index < batch.agentIds.length; index += 1) {
        const agentId = batch.agentIds[index];
        const agent = targetAgents[index];
        if (!agentId || !agent) throw new Error("Agent is not a member of this server");
        const result = await messageService.addAgentWithMembershipSystemMessage({
          channel,
          agentId,
          agentName: agent.name,
          causalActor: { type: "user", id: req.userId! },
          executor: tx,
          actionCardMessageId: typeof req.body?.actionCardMessageId === "string" ? req.body.actionCardMessageId : undefined,
          actionCardConfirmationVersion: typeof req.body?.actionCardConfirmationVersion === "number" ? req.body.actionCardConfirmationVersion : undefined,
        });
        if (result.added) {
          addedAgentIds.push(agentId);
          if (result.message) agentMessages.set(agentId, result.message);
        }
      }
      return { addedUserIds, addedAgentIds, userMessages, agentMessages };
    };

    const result = await withLockedChannelActorCapability({
      serverId: req.serverId!,
      channelId: channel.id,
      actorType: "user",
      actorId: req.userId!,
      capability: "addChannelMembers",
      // The people added: their users rows are taken first, with the actor's.
      humanSubjectIds: batch.userIds,
    }, applyBatch);

    for (const userId of result.addedUserIds) {
      const user = targetUsers[batch.userIds.indexOf(userId)]!;
      await broadcastMembershipSystemMessage(
        req,
        channel,
        { type: "human", id: userId, name: user.name },
        "added",
        req.userId!,
        result.userMessages.get(userId),
      );
    }
    for (const agentId of result.addedAgentIds) {
      const agent = targetAgents[batch.agentIds.indexOf(agentId)]!;
      await broadcastMembershipSystemMessage(
        req,
        channel,
        { type: "agent", id: agentId, name: agent.name },
        "added",
        req.userId!,
        result.agentMessages.get(agentId),
      );
    }

    const io = req.app.get("io") as SocketServer | undefined;
    emitChannelMembersUpdated(io, req.serverId!, channel, result.addedUserIds);
    const addedUserIds = new Set(result.addedUserIds);
    const addedAgentIds = new Set(result.addedAgentIds);
    res.json({
      ok: true,
      added: {
        userIds: result.addedUserIds,
        agentIds: result.addedAgentIds,
      },
      alreadyMembers: {
        userIds: batch.userIds.filter((id) => !addedUserIds.has(id)),
        agentIds: batch.agentIds.filter((id) => !addedAgentIds.has(id)),
      },
    });
  } catch (err: unknown) {
    if (isActionCardConversionError(err)) {
      // The source action card is frozen or needs reconfirmation: an expected 409, not a server fault.
      res.status(err.status).json({ error: err.message, code: err.code });
    } else if (err instanceof Error && err.message === channelService.GUEST_ALL_CHANNEL_MESSAGE) {
      res.status(403).json({ error: err.message });
    } else if (err instanceof Error && err.message === "Channel capability required") {
      res.status(403).json({ error: "You do not have permission to add channel members" });
    } else if (err instanceof Error && err.message === channelService.ASSISTANT_CHANNEL_FORBIDDEN_MESSAGE) {
      res.status(403).json({ error: err.message, code: channelService.ASSISTANT_CHANNEL_FORBIDDEN_CODE });
    } else if (err instanceof Error && err.message === "Human is not a member of this channel's server") {
      res.status(400).json({ error: "One or more users are not members of this server", code: "users_not_in_server" });
    } else if (err instanceof Error && err.message === "Agent is not a member of this channel's server") {
      res.status(400).json({ error: "One or more agents are not members of this server", code: "agents_not_in_server" });
    } else {
      res.status(500).json({ error: "Failed to add channel members" });
    }
  }
});

// Add a member (agent or human) to a channel. Retained for older clients and
// single-row actions; multi-select clients should use /members/batch.
channelRouter.post("/:id/members", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const canSee = await canSeeChannel(channel, req.userId!, req.serverId!);
    const requesterRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    const canManageUnjoined = (channel.type === "channel" || channel.type === "private")
      && (requesterRole === "owner" || requesterRole === "admin");
    if (!canSee && !canManageUnjoined) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (isSubConversationType(channel.type)) {
      res.status(400).json({ error: "Thread membership is managed via follow/unfollow" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    // The object-aware add policy decides; server owner/admin may therefore
    // manage a private channel without first joining it. A DM has two fixed
    // parties: a participant gets its refusal, anyone else the same 404.
    if (channel.type === "dm" && !await channelService.isChannelHuman(channel.id, req.userId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!(await actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "addChannelMembers"))) {
      res.status(403).json({ error: "You do not have permission to add channel members" });
      return;
    }
    const { agentId, userId } = req.body;
    if (!agentId && !userId) {
      res.status(400).json({ error: "Either agentId or userId is required" });
      return;
    }
    if (agentId && await isLoungeOutsiderAgent(channel.id, agentId)) {
      res.status(403).json({ error: AGENT_LOUNGE_OUTSIDER_ADD_REFUSAL, code: "agent_lounge_outsider" });
      return;
    }
    if (agentId) {
      // Validate agent belongs to this server
      const agent = await agentService.getAgent(agentId);
      // Only its owner finds a personal assistant; for anyone else it is
      // answered exactly as an id that names no agent here.
      if (!agent || agent.serverId !== req.serverId || isOthersAssistant(agent, req.userId!)) {
        res.status(400).json({ error: "Agent not found in this server" });
        return;
      }
      const wasAgentMember = await channelService.isChannelAgent(req.params.id, agentId);
      const actionCardContext = {
        actionCardMessageId: typeof req.body?.actionCardMessageId === "string" ? req.body.actionCardMessageId : undefined,
        actionCardConfirmationVersion: typeof req.body?.actionCardConfirmationVersion === "number" ? req.body.actionCardConfirmationVersion : undefined,
      };
      await withLockedChannelActorCapability({
        serverId: req.serverId!,
        channelId: channel.id,
        actorType: "user",
        actorId: req.userId!,
        capability: "addChannelMembers",
      }, (tx) => channelService.addAgent(req.params.id, agentId, { ...actionCardContext, executor: tx }));
      if (!wasAgentMember) {
        await broadcastMembershipSystemMessage(req, channel, { type: "agent", ...agent }, "added", req.userId!);
      }
    } else {
      // Verify target user is a member of this server
      const targetRole = await getActorServerRoleInServer(req.serverId!, "user", userId);
      if (!targetRole) {
        res.status(400).json({ error: "User is not a member of this server" });
        return;
      }
      const targetUser = await userService.getUser(userId);
      if (!targetUser) {
        res.status(400).json({ error: "User is not a member of this server" });
        return;
      }
      const addHumanWithNotice = (executor?: Parameters<typeof messageService.addHumanWithMembershipSystemMessage>[0]["executor"]) =>
        messageService.addHumanWithMembershipSystemMessage({
          channel,
          userId,
          userName: targetUser.name,
          causalActor: { type: "user", id: req.userId! },
          executor,
          actionCardMessageId: typeof req.body?.actionCardMessageId === "string" ? req.body.actionCardMessageId : undefined,
          actionCardConfirmationVersion: typeof req.body?.actionCardConfirmationVersion === "number" ? req.body.actionCardConfirmationVersion : undefined,
        });
      const persisted = await withLockedChannelActorCapability({
        serverId: req.serverId!,
        channelId: channel.id,
        actorType: "user",
        actorId: req.userId!,
        capability: "addChannelMembers",
        humanSubjectIds: [userId],
      }, (tx) => addHumanWithNotice(tx));
      if (persisted.added) {
        await broadcastMembershipSystemMessage(
          req,
          channel,
          { type: "human", id: targetUser.id, name: targetUser.name },
          "added",
          req.userId!,
          persisted.message,
        );
      }
    }

    // Notify clients about membership change
    const io = req.app.get("io") as SocketServer | undefined;
    emitChannelMembersUpdated(io, req.serverId!, channel, userId);

    res.json({ ok: true });
  } catch (err: unknown) {
    if (isActionCardConversionError(err)) {
      // The source action card is frozen or needs reconfirmation: an expected 409, not a server fault.
      res.status(err.status).json({ error: err.message, code: err.code });
    } else if (err instanceof Error && err.message === channelService.GUEST_ALL_CHANNEL_MESSAGE) {
      res.status(403).json({ error: err.message });
    } else if (err instanceof Error && err.message === "Channel capability required") {
      res.status(403).json({ error: "You do not have permission to add channel members" });
    } else if (err instanceof Error && err.message === channelService.ASSISTANT_CHANNEL_FORBIDDEN_MESSAGE) {
      res.status(403).json({ error: err.message, code: channelService.ASSISTANT_CHANNEL_FORBIDDEN_CODE });
    } else {
      res.status(500).json({ error: "Failed to add member" });
    }
  }
});

// Human-only v1 surface for channel-local member/admin transitions. Agents can
// hold the role but intentionally have no Agent API/CLI/action-card entry.
channelRouter.patch("/:id/members/:targetType/:memberId/role", async (req, res) => {
  const targetType = req.params.targetType === "user" || req.params.targetType === "agent"
    ? req.params.targetType
    : null;
  const nextRole = req.body?.role === "member" || req.body?.role === "admin"
    ? req.body.role
    : null;
  if (!targetType || !nextRole) {
    res.status(400).json({ error: "targetType and role must be user|agent and member|admin" });
    return;
  }

  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const result = await channelService.changeChannelMembershipRole({
      serverId: req.serverId!,
      channelId: channel.id,
      requesterUserId: req.userId!,
      targetType,
      targetId: req.params.memberId,
      nextRole,
    });
    if (result.changed) {
      const io = req.app.get("io") as SocketServer | undefined;
      emitChannelMembersUpdated(io, req.serverId!, channel, targetType === "user" ? result.targetId : undefined);
      io?.to(targetType === "user" ? `user:${result.targetId}` : `agent:${result.targetId}`).emit(
        "channel:authority-updated",
        {
          channelId: channel.id,
          channelRole: result.channelRole,
          authorityRevision: result.authorityRevision,
        },
      );
      if (result.eventId) {
        try {
          await channelService.markChannelMembershipRoleEventDelivered(result.eventId);
        } catch (deliveryError) {
          // The role mutation and durable outbox row are already committed.
          // Leave the event pending for retry rather than turning a successful
          // authority change into an ambiguous HTTP 500.
          console.error("Failed to mark channel role event delivered:", deliveryError);
        }
      }
    }
    res.json(result);
  } catch (err) {
    if (err instanceof channelService.ChannelMembershipRoleMutationError) {
      if (err.code === "channel_not_found") {
        res.status(404).json({ error: err.message, code: err.code });
      } else if (err.code === "channel_capability_required" || err.code === "protected_server_role") {
        res.status(403).json({ error: err.message, code: err.code });
      } else if (err.code === "unsupported_channel_shape") {
        res.status(400).json({ error: err.message, code: err.code });
      } else {
        res.status(409).json({ error: err.message, code: err.code });
      }
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to change channel member role",
      logPrefix: "Failed to change channel member role:",
      err,
    });
  }
});

// Remove an agent member from a channel
channelRouter.delete("/:id/members/agent/:memberId", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (isSubConversationType(channel.type)) {
      res.status(400).json({ error: "Thread membership is managed via follow/unfollow" });
      return;
    }
    if (channel.type === "dm") {
      const isParticipant = await channelService.isChannelHuman(channel.id, req.userId!);
      if (!isParticipant) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
    } else if (!(await actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "removeChannelMembers", getDb(), "agent"))) {
      res.status(403).json({ error: "Only admins can remove channel agents" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    assertAgentCanBeRemovedFromChannel(channel);
    const agent = await agentService.getAgent(req.params.memberId);
    const targetChannel = await channelService.getJointAgentRemovalChannel(channel.id, req.params.memberId);
    const actorContext = await resolveChannelActorContext(req.serverId!, channel.id, "user", req.userId!);
    if (actorContext?.jointAuthority && !actorContext.jointAuthority.isHostEntry && agent?.serverId !== req.serverId) {
      res.status(403).json({ error: "Channel capability required" });
      return;
    }
    const wasAgentMember = targetChannel ? await channelService.isChannelAgent(targetChannel.id, req.params.memberId) : false;
    if (wasAgentMember && agent && targetChannel) {
      // Preserve the established audience ordering: the removed Agent must
      // receive the durable notice while its membership is still active.
      await broadcastMembershipSystemMessage(req, targetChannel, { type: "agent", ...agent }, "removed", req.userId!);
    }
    if (channel.type === "dm") {
      await channelService.removeAgent(req.params.id, req.params.memberId);
    } else {
      await withLockedChannelActorCapability({
        serverId: req.serverId!,
        channelId: channel.id,
        actorType: "user",
        actorId: req.userId!,
        capability: "removeChannelMembers",
        memberTargetType: "agent",
      }, (tx, context) => channelService.removeAgent(req.params.id, req.params.memberId, tx, context));
    }
    if (wasAgentMember && agent && targetChannel && channel.type !== "channel") {
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
      await agentOrchestrator.purgeAgentInboxForChannelTree(
        req.params.memberId,
        targetChannel.id,
        "channel_membership_removed",
      );
    }

    // Notify clients about membership change
    const io = req.app.get("io") as SocketServer | undefined;
    emitChannelMembersUpdated(io, req.serverId!, channel);
    if (channel.type === "joint") {
      for (const projection of await channelService.getActiveJointChannelProjectionsByLocalChannel(channel.id)) {
        if (projection.localChannelId !== channel.id) io?.to(`channel:${projection.localChannelId}`).emit("channel:members-updated", { channelId: projection.localChannelId });
      }
    }

    res.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || "";
    const allRefusal = allChannelMembershipRefusal(msg);
    if (allRefusal) {
      res.status(403).json(allRefusal);
    } else if (msg === "Channel capability required") {
      res.status(403).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to remove member" });
    }
  }
});

// Remove a human member from a channel
channelRouter.delete("/:id/members/user/:memberId", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (isSubConversationType(channel.type)) {
      res.status(400).json({ error: "Thread membership is managed via follow/unfollow" });
      return;
    }
    if (channel.type === "dm") {
      // DMs: only participants can interact, and only remove self
      const isParticipant = await channelService.isChannelHuman(channel.id, req.userId!);
      if (!isParticipant) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
      if (req.params.memberId !== req.userId) {
        res.status(403).json({ error: "Cannot remove other participants from a DM" });
        return;
      }
    } else if (!(await actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "removeChannelMembers"))) {
      res.status(403).json({ error: "Only admins can remove channel members" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    if (channel.type === "dm") {
      // A DM participant removes only themselves (checked above).
      await channelService.removeHuman(req.params.id, req.params.memberId, { self: true });
    } else {
      const removal = await withLockedChannelActorCapability({
        serverId: req.serverId!,
        channelId: channel.id,
        actorType: "user",
        actorId: req.userId!,
        capability: "removeChannelMembers",
        humanSubjectIds: [req.params.memberId],
      }, (tx, context) => channelService.removeHuman(req.params.id, req.params.memberId, context, tx));
      await channelService.finishChannelMemberRemoval(removal, req.params.memberId);
    }

    // Notify clients about membership change
    const io = req.app.get("io") as SocketServer | undefined;
    emitChannelMembersUpdated(io, req.serverId!, channel);

    res.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || "";
    const allRefusal = allChannelMembershipRefusal(msg);
    if (allRefusal) {
      res.status(403).json(allRefusal);
    } else if (msg === "Channel capability required") {
      res.status(403).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to remove member" });
    }
  }
});

// Join a channel (self). The rules are channelJoinService's, shared with an
// assistant's forward with `join: true` (RFC 077).
channelRouter.post("/:id/join", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    const joined = await joinChannelAsUser(req.app.get("io"), req.serverId!, req.userId!, channel);
    if (!joined.ok) {
      // `code` is new; status and error are as before. Archived always had its code.
      res.status(joined.status).json({ error: joined.error, code: joined.code });
      return;
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to join channel" });
  }
});

// Leave a channel (self)
channelRouter.post("/:id/leave", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (isSubConversationType(channel.type)) {
      res.status(400).json({ error: "Thread membership is managed via follow/unfollow" });
      return;
    }
    if (channel.type === "dm") {
      res.status(403).json({ error: "Cannot leave DM channels" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    await channelService.removeHuman(req.params.id, req.userId!, { self: true });

    const io = req.app.get("io");
    io?.to(`server:${req.serverId}`).emit("channel:members-updated", { channelId: req.params.id });

    res.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || "";
    const allRefusal = allChannelMembershipRefusal(msg);
    if (allRefusal) {
      res.status(403).json(allRefusal);
    } else {
      res.status(500).json({ error: "Failed to leave channel" });
    }
  }
});

// Mark a channel as read
channelRouter.post("/:id/read", noteInboxWriteBeforeReply, async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await channelService.canUserAccessChannel(channel.id, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const seq = Number(req.body.seq);
    if (!seq) {
      res.status(400).json({ error: "seq is required" });
      return;
    }
    const state = await channelService.markRead(req.userId!, channel.id, seq);
    emitReadStateUpdated(req, state);
    await emitScopeReadUpdated({
      io: req.app.get("io") as SocketServer | undefined,
      serverId: req.serverId!,
      scopeId: channel.id,
      peerKind: "human",
      peerId: req.userId!,
      maxReadSeq: state.maxReadSeq,
      changed: state.changed,
    });
    res.json({ ok: true, maxReadSeq: state.maxReadSeq, readStateVersion: state.readStateVersion });
  } catch (err) {
    if (sendCompatibilityReadPending(res, err)) return;
    addRouteFailureEvent("channel_read", err);
    res.status(500).json({ error: "Failed to mark as read" });
  }
});

// Mark a channel as fully read
channelRouter.post("/:id/read-all", noteInboxWriteBeforeReply, async (req, res) => {
  let receiver: ReadAllReceiver = { kind: "human", id: req.userId! };
  let delegationBasis: ReadStateDelegationBasis | null = null;
  try {
    const parsedReceiver = parseReadAllReceiver(req.body, req.userId!);
    if (!parsedReceiver.ok) {
      res.status(parsedReceiver.status).json({
        error: parsedReceiver.status === 403 ? "Read receiver is not authorized" : "Invalid read receiver",
      });
      return;
    }
    receiver = parsedReceiver.receiver;

    const channel = await channelService.getChannel(req.params.id)
      ?? await channelService.getChannel(req.params.id, { includeDeleted: true });
    const deletedInboxResidueRead = Boolean(channel?.deletedAt && channel.type !== "dm");
    if (
      !channel
      || channel.serverId !== req.serverId
      || (deletedInboxResidueRead && receiver.kind !== "human")
    ) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    // Set when the caller cannot access the channel but the server's own records
    // show they once did. They are allowed to retire THEIR OWN residue -- that is
    // the usability half of task #48 -- but they must learn nothing about the
    // channel's present state, so this branch answers from receiver-owned values
    // only. See the receipt below.
    let residueOnlyRetire = false;
    if (
      receiver.kind === "human"
      && !deletedInboxResidueRead
    ) {
      const canAccess = await channelService.canUserAccessChannel(channel.id, req.userId!, req.serverId!, { includeDeleted: true });
      if (!canAccess) {
        if (await channelService.hasPriorChannelRelationship(req.userId!, channel.id)) {
          residueOnlyRetire = true;
        } else {
          // Unchanged: a caller the server has no record of gets the same 404 a
          // missing id gets. This is what stops the usability fix from reopening
          // the existence oracle the privacy half closed.
          res.status(404).json({ error: "Channel not found" });
          return;
        }
      }
    }

    if (receiver.kind === "agent") {
      const agent = await agentService.getAgent(receiver.id);
      if (!agent || agent.serverId !== req.serverId) {
        res.status(404).json({ error: "Read receiver not found" });
        return;
      }
      const decision = await canHumanOperateAgentReadState(req.serverId!, req.userId!, agent);
      if (!decision.allowed) {
        addTraceEvent("channel_read_all.receiver.denied", {
          caller_kind: "human",
          caller_id: req.userId!,
          receiver_kind: receiver.kind,
          receiver_id: receiver.id,
          delegation_basis: null,
          scope_id: channel.id,
        });
        res.status(403).json({ error: "Read receiver is not authorized" });
        return;
      }
      delegationBasis = decision.basis;
    }

    addTraceEvent("channel_read_all.receiver.resolved", {
      caller_kind: "human",
      caller_id: req.userId!,
      receiver_kind: receiver.kind,
      receiver_id: receiver.id,
      delegation_basis: delegationBasis,
      scope_id: channel.id,
    });
    // Task #93 line B: an agent receiver is fenced on the delegating human as well as the agent's membership.
    const state = await channelService.markReadLatest(
      receiver,
      channel.id,
      receiver.kind === "agent" ? { actingUserId: req.userId! } : {},
    );
    if (residueOnlyRetire) {
      // Return BEFORE the emits, and structurally rather than by remembering to
      // strip a field. `emitReadStateUpdated` pushes `maxReadSeq` straight to
      // room `user:<id>`, so restricting only the HTTP body would have been
      // cosmetic -- the caller would receive the channel's live frontier through
      // the socket instead. `emitScopeReadUpdated` is skipped for the same
      // reason and because a former member's read position is not something the
      // channel's remaining members' read-receipt UI should be told about.
      res.json(channelService.buildResidueOnlyReadAllReceipt(state));
      return;
    }
    if (receiver.kind === "human") emitReadStateUpdated(req, state);
    await emitScopeReadUpdated({
      io: req.app.get("io") as SocketServer | undefined,
      serverId: req.serverId!,
      scopeId: channel.id,
      peerKind: receiver.kind,
      peerId: receiver.id,
      maxReadSeq: state.maxReadSeq,
      changed: state.changed,
    });
    res.json({ ok: true, seq: state.maxReadSeq, readStateVersion: state.readStateVersion });
  } catch (err) {
    if (sendCompatibilityReadPending(res, err)) return;
    if (err instanceof ReadMutationError && err.code === "SCOPE_NOT_FOUND") {
      addTraceEvent("channel_read_all.receiver.scope_rejected", {
        caller_kind: "human",
        caller_id: req.userId!,
        receiver_kind: receiver.kind,
        receiver_id: receiver.id,
        delegation_basis: delegationBasis,
        scope_id: req.params.id,
      });
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    addRouteFailureEvent("channel_read_all", err);
    res.status(500).json({ error: "Failed to mark as read" });
  }
});

// Explicit sidebar action: channel messages plus active followed threads.
// The existing /read-all contract remains a single-scope read.
channelRouter.post("/:id/conversation-read-all", noteInboxWriteBeforeReply, async (req, res) => {
  try {
    if (!await channelService.canUserAccessChannel(req.params.id, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const result = await channelService.markConversationReadLatest(req.serverId!, req.userId!, req.params.id);
    emitReadStateUpdatedBulk(req, result.scopes);
    res.json({
      ok: true,
      serverId: req.serverId!,
      markedCount: result.markedCount,
      scopes: result.scopes.map((scope) => ({
        scopeId: scope.channelId,
        maxReadSeq: scope.maxReadSeq,
        readStateVersion: scope.readStateVersion,
      })),
    });
  } catch (err) {
    if (sendCompatibilityReadPending(res, err)) return;
    if (err instanceof ReadMutationError && err.code === "SCOPE_NOT_FOUND") {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to mark conversation as read", logPrefix: "Failed to mark conversation as read:", err });
  }
});

// Mark a channel as unread
channelRouter.post("/:id/unread", noteInboxWriteBeforeReply, async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id)
      ?? await channelService.getChannel(req.params.id, { includeDeleted: true });
    if (!channel || channel.serverId !== req.serverId || (channel.deletedAt && channel.type !== "dm")) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await channelService.canUserAccessChannel(channel.id, req.userId!, req.serverId!, { includeDeleted: true })) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const state = await channelService.markUnread(req.userId!, channel.id);
    emitReadStateUpdated(req, state);
    // markedUnread: nothing countable to rewind over, so the scope is marked
    // unread with no count (always sent here, so a client can tell this server
    // from one that answers unreadCount 0 for "nothing to mark"). outcome:
    // counted / marked / nothing, decided in the read-state transaction.
    // Shape checked at compile time against the registered contract
    // (readStateContract.markUnread), not parsed: the write has committed, and
    // a 500 here would only make the client retry it.
    res.json({
      ok: true,
      unreadCount: state.unreadCount,
      maxReadSeq: state.maxReadSeq,
      readStateVersion: state.readStateVersion,
      markedUnread: state.markedUnread,
      outcome: state.outcome,
    } satisfies MarkConversationUnreadResponse);
  } catch (err) {
    if (sendCompatibilityReadPending(res, err)) return;
    sendJsonServerError(req, res, {
      error: "Failed to mark as unread",
      logPrefix: "Failed to mark as unread:",
      err,
    });
  }
});

// ── Thread routes ────────────────────────────────────────

// Create or get thread for a message, optionally post first reply
channelRouter.post("/:id/threads", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object"
      ? req.body as { parentMessageId?: unknown; content?: unknown }
      : {};
    const { parentMessageId, content } = body;
    if (typeof parentMessageId !== "string" || parentMessageId.trim() === "") {
      res.status(400).json({ error: "parentMessageId is required" });
      return;
    }

    // Verify the parent message belongs to this channel
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json(CHANNEL_NOT_FOUND_BODY);
      return;
    }

    // Access is established BEFORE the shape of the id is described. The nested-
    // thread 400 below used to run first, so a stranger probing an id learned
    // "this exists and is a thread" -- the same existence oracle the 403 was, just
    // through a different exit. Closing only the 403 would have left this door
    // open. Same ordering as the merged /threads/done split (`9566e1327`).
    const canAccess = await channelService.canUserAccessChannel(req.params.id, req.userId!, req.serverId!);
    if (!canAccess) {
      await denyChannelAccess(res, req.userId!, req.params.id, "Access denied");
      return;
    }

    // Prevent nested threads: cannot create a thread inside a thread channel.
    // Only reported to a caller who can already see the channel.
    if (isSubConversationType(channel.type)) {
      res.status(400).json({ error: "Cannot create a thread inside a thread" });
      return;
    }

    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    // A first reply is an ordinary message post. It must clear the same gates
    // as POST /api/messages (length, post authority, conversion fence, billing
    // read-only) before the thread is materialized, so a reader who cannot
    // post -- a Guest, or a member who has not joined a public channel --
    // neither writes a message nor leaves a thread behind. Post authority on a
    // thread resolves to its parent channel, so the parent is checked here.
    const firstReply = typeof content === "string" && content.trim().length > 0 ? content : null;
    if (firstReply !== null) {
      if (firstReply.length > MAX_MESSAGE_LENGTH) {
        res.status(400).json({ error: `Message content exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters` });
        return;
      }
      if (!(await channelService.canUserPostToChannel(channel.id, req.userId!))) {
        res.status(403).json({ error: "You must join this channel to send messages" });
        return;
      }
      const conversionTarget = await resolveChannelConversionLockTarget(getDb(), channel.id);
      if (conversionTarget) {
        await assertChannelConversionWritable(conversionTarget.sourceChannelId);
      }
      const billingReadOnly = await getChannelBillingReadOnly(channel.id, req.serverId!);
      if (billingReadOnly) {
        if (billingReadOnly.reason === "joint_over_limit") notePaywallHit(req, "joint_channel_read_only");
        res.status(403).json(channelBillingReadOnlyBody(billingReadOnly));
        return;
      }
      if (await isChannelReadOnlyByQuota(channel.id, req.serverId!)) {
        res.status(403).json({ error: "This channel is read-only on your current plan. Upgrade to continue." });
        return;
      }
    }

    // Create or get thread. Joint parents return a server-local thread
    // projection while storing replies in the canonical thread channel.
    const thread = await channelService.getOrCreateThreadForChannel(req.params.id, parentMessageId, req.userId!, "user");

    if (firstReply !== null) {
      const user = await userService.getUser(req.userId!);
      const senderName = user?.displayName || user?.name || "User";

      const io = req.app.get("io");
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
      // slack-bridge-ordinary-message-producer: channels.first_thread_reply
      await messageService.broadcastAndDeliver(io, agentOrchestrator, {
        channelId: thread.id,
        senderType: "user",
        senderId: req.userId!,
        senderName,
        content: firstReply,
      });
    }

    // Return thread info
    const info = await channelService.getThreadInfoForChannel(req.params.id, parentMessageId);
    res.json({ threadChannelId: thread.id, ...info });
  } catch (err: any) {
    if (err instanceof ChannelConversionInProgressError) {
      res.status(err.status).json({ error: err.message, code: err.code, conversionEpoch: err.conversionEpoch });
      return;
    }
    if (err instanceof channelService.ChannelArchivedError) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    const msg = err?.message || "";
    if (msg.includes("not found")) {
      res.status(404).json({ error: msg });
    } else {
      sendJsonServerError(req, res, {
        error: "Failed to create thread",
        logPrefix: "Failed to create thread:",
        err,
      });
    }
  }
});

// Get thread summaries for channel thread-parent messages.
//
// Preferred/current client behavior:
//   The web timeline sends parentMessageIds for the thread parents currently
//   loaded on screen. That keeps the participant/unread phases scoped to the
//   same window the user can inspect.
//
// Legacy/no-param compatibility behavior:
//   Older deployed clients call this route with no parentMessageIds and used
//   to trigger a full-channel thread summary fanout. For those clients only,
//   fall back to a bounded recent-parent window and tag traces as
//   parent_message_scope_source=compat_recent. This is deliberately a
//   compatibility escape hatch, not the long-term contract. Future cleanup:
//   when compat_recent disappears from production traces, make the parameter
//   required or remove the fallback.
channelRouter.get("/:id/threads", async (req, res) => {
  try {
    addTraceEvent("channel_threads.load.started");
    const channel = await tracePhase(
      () => channelService.getChannel(req.params.id),
      (durationMs, result) => ({
        name: "channel.loaded",
        attrs: {
          channel_found: Boolean(result),
          channel_type: result?.type ?? "missing",
          server_match: result?.serverId === req.serverId,
        },
      }),
    );
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json(CHANNEL_NOT_FOUND_BODY);
      return;
    }
    const canAccess = await tracePhase(
      () => channelService.canUserAccessChannel(req.params.id, req.userId!, req.serverId!),
      (durationMs, result) => ({
        name: "channel.access.checked",
        attrs: {
          allowed: result,
          channel_type: channel.type,
        },
      }),
    );
    if (!canAccess) {
      await denyChannelAccess(res, req.userId!, req.params.id, "Access denied");
      return;
    }

    const requestedParentMessageIds = parseThreadSummaryParentMessageIds(req.query.parentMessageIds);
    if (requestedParentMessageIds === null) {
      res.status(400).json({ error: "Invalid parentMessageIds" });
      return;
    }
    const parentMessageIds = requestedParentMessageIds ?? await channelService.listRecentThreadParentMessageIdsForChannelView(
      req.params.id,
      THREAD_SUMMARY_COMPAT_PARENT_IDS_LIMIT,
    );
    const parentMessageScopeSource = requestedParentMessageIds === undefined ? "compat_recent" : "client";

    // The parents are the caller's to name (any message id): the replies a
    // summary previews stay inside the plan's history window.
    const { cutoff: historyCutoff } = await getServerHistoryWindowForRead(req.serverId!);
    const summaries = await tracePhase(
      () => channelService.getThreadSummaries(req.params.id, {
        userId: req.userId!,
        parentMessageIds,
        parentMessageScopeSource,
        historyCutoff,
        traceQuery: createTraceDbQueryTracer("channel_threads.loaded"),
      }),
      (durationMs, result) => {
        const summaries = Object.values(result);
        return {
          name: "channel_threads.loaded",
          attrs: {
            thread_summaries_count: summaries.length,
            total_replies_count: summaries.reduce((sum, summary) => sum + summary.replyCount, 0),
            total_unread_replies_count: summaries.reduce((sum, summary) => sum + summary.unreadCount, 0),
            participant_links_count: summaries.reduce((sum, summary) => sum + summary.participantIds.length, 0),
            parent_message_scope_count: parentMessageIds.length,
            parent_message_scope_source: parentMessageScopeSource,
          },
        };
      },
    );
    addTraceEvent("response.ready", {
      thread_summaries_count: Object.keys(summaries).length,
      parent_message_scope_count: parentMessageIds.length,
      parent_message_scope_source: parentMessageScopeSource,
    });
    const threadLevels = (await loadConversationLevelSettings(req.userId!, {
      threadChannelIds: Object.values(summaries).map((summary) => summary.threadChannelId),
    })).thread;
    res.json(Object.fromEntries(Object.entries(summaries).map(([parentId, summary]) => [
      parentId,
      { ...summary, notificationLevel: threadLevels.get(summary.threadChannelId) ?? "default" },
    ])));
  } catch {
    res.status(500).json({ error: "Failed to get thread summaries" });
  }
});

// Get thread info for a specific parent message
//
// Every 404 branch records `threads.lookup.rejected` with a reject reason so a
// client "empty thread" report can be traced to the branch that fired (task
// #14). On server_mismatch the request's X-Server-Id and the channel's owning
// server id are recorded (ids only) to expose the client's server context.
type ThreadLookupRejectReason = "channel_not_found" | "server_mismatch" | "access_denied" | "not_found";
function recordThreadLookupRejected(reason: ThreadLookupRejectReason, attrs: Record<string, string | null> = {}): void {
  addTraceEvent("threads.lookup.rejected", { "threads.lookup.reject_reason": reason, ...attrs });
}

channelRouter.get("/:id/threads/:messageId", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel) {
      recordThreadLookupRejected("channel_not_found");
      res.status(404).json(CHANNEL_NOT_FOUND_BODY);
      return;
    }
    if (channel.serverId !== req.serverId) {
      recordThreadLookupRejected("server_mismatch", {
        request_server_id: req.serverId ?? null,
        channel_server_id: channel.serverId ?? null,
      });
      res.status(404).json(CHANNEL_NOT_FOUND_BODY);
      return;
    }
    const canAccess = await channelService.canUserAccessChannel(req.params.id, req.userId!, req.serverId!);
    if (!canAccess) {
      recordThreadLookupRejected("access_denied");
      await denyChannelAccess(res, req.userId!, req.params.id, "Access denied");
      return;
    }

    const info = await channelService.getThreadInfoForChannel(req.params.id, req.params.messageId);
    if (!info) {
      recordThreadLookupRejected("not_found");
      // `code` is the machine-readable "no thread yet" signal clients key on;
      // the other 404s on this route are lookup failures, not an empty thread.
      res.status(404).json({ code: "THREAD_NOT_FOUND", error: "No thread found for this message" });
      return;
    }
    // The lookup itself is not history-limited, but the thread panel's reply
    // fetch is. Record whether every reply sits behind the plan cutoff so a
    // "found (200) but rendered empty" thread is provable from the span.
    const plan = await tracePhase(
      () => getServerPlan(req.serverId!),
      (_durationMs, result) => ({ name: "history.policy.checked", attrs: { plan: result } }),
    );
    const historyCutoff = getHistoryCutoff(plan);
    addTraceEvent("history.limit.checked", {
      plan,
      history_cutoff_present: Boolean(historyCutoff),
      history_limited: Boolean(
        historyCutoff
        && info.lastReplyAt
        && new Date(info.lastReplyAt).getTime() < historyCutoff.getTime(),
      ),
      history_limit_scope: "all_replies",
      reply_count: info.replyCount,
    });
    const threadLevel = (await loadConversationLevelSettings(req.userId!, { threadChannelIds: [info.threadChannelId] })).thread;
    res.json({ ...info, notificationLevel: threadLevel.get(info.threadChannelId) ?? "default" });
  } catch {
    res.status(500).json({ error: "Failed to get thread info" });
  }
});
