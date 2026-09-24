import { serializeErrorForLog } from "../tracing/safeErrorLog.js";
// /internal/agent-api/* — RFC v0.8 sk_agent_* runner data-plane surface.
// New managed-runner daemon builds use this surface for agent data-plane work
// after successful runner credential mint. If mint fails, startup hard-fails;
// the daemon must not silently fall back to legacy `/internal/agent/:id/*`.
// Operators deploy server first and roll back the daemon binary if this
// surface must be disabled.
//
// Auth is wired upstream via `requireAgentCredentialAuth`. By the time
// these handlers run:
//   - req.principalKind        === "agent_credential"
//   - req.actingAgentId        === <bound agent id>
//   - req.serverId             === <agent's server id>
//   - req.agentCredentialId    === <credential row id>
//   - req.agentCredentialScopes === <credential scope list>
//
// Cross-principal rejection (RFC §5.6) is enforced upstream — an
// sk_machine_* / sk_computer_* / JWT caller hitting this surface gets
// 401 invalid_principal before reaching here.
//
// IMPORTANT — no `:id` path param. All routes act on the credential's
// bound agent identity. This is the core "agent-self" contract: a single
// credential cannot impersonate another agent on the same server.
//
// v0.8 handlers mirror the relevant legacy `/internal/agent/:id/*`
// behavior, minus the `loadOwnedMachineAgent` ownership check (the
// credential is already bound to the agent at auth time). Shared logic must
// live in principal-agnostic helpers that receive an already-authorized actor
// value; do not move machine-vs-runner auth branching into shared core.

import { randomUUID } from "node:crypto";
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router as RouterType,
} from "express";
import multer from "multer";
import { and, desc, eq, gt, isNotNull, isNull, not, or, sql } from "drizzle-orm";
import {
  AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE,
  ATTENTION_HINT_COPY_VERSION,
  ATTENTION_HINT_SCHEMA,
  DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY,
  EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
  buildApmFreshnessDecisionProducerFactId,
  agentApiContract,
  getAgentApiResponseKind,
  type AgentApiAttachmentCommentsResponse,
  type AgentApiFeedbackLocatorListQuery,
  type AgentApiContractRoute,
  type AgentApiHeldFreshnessResponse,
  type AgentApiMessageEnvelope,
  type AgentApiRequestBodyByRoute,
  type AgentApiRequestParamsByRoute,
  type AgentApiRequestQueryByRoute,
  type AgentApiResponseByRoute,
  type AgentApiRouteKey,
  isExternalAgentRuntime,
  isReminderStatus,
  isRaftOAuthScope,
  projectApmHeldFreshnessActivity,
  projectApmHeldFreshnessEnvelope,
  asChannelId,
  asMachineId,
  canonicalizeOAuthClientCategory,
  getServerCapabilities,
  type AgentApiTaskClaimConflict,
  type AgentMessage,
  type ExternalAgentActivityEvent,
  type ExternalAgentActivityIngestRequest,
  isTaskStatus,
  renderThirdPartyInertText,
  type ActionCardAction,
  type ReminderStatus,
  type ServerId,
  type TaskStatus,
  failpoints,
} from "@botiverse/raft-shared";
import * as agentService from "../services/agentService.js";
import { resolveReadableAttachmentAuthorityContext } from "../services/attachmentAuthorityService.js";
import * as agentMigrationService from "../services/agentMigrationService.js";
import { emitAgentMigrationUpdated } from "../services/agentMigrationRealtime.js";
import * as actionCardsService from "../services/actionCardsService.js";
import * as attachmentCommentService from "../services/attachmentCommentService.js";
import * as channelService from "../services/channelService.js";
import { CHANNEL_NOT_FOUND_BODY, threadAnchorNotFoundBody } from "./channelAccessDenial.js";
import * as messageService from "../services/messageService.js";
import {
  loadCanonicalTaskFactsByMessageId,
  refreshQueuedAgentTaskProjections,
} from "../services/messageTaskProjection.js";
import * as mentionDeliveryOccurrenceService from "../services/mentionDeliveryOccurrenceService.js";
import * as searchService from "../services/searchService.js";
import { resolveSearchSenderFilter } from "../services/searchSenderFilterService.js";
import * as serverService from "../services/serverService.js";
import * as machineService from "../services/machineService.js";
import * as agentScopesService from "../services/agentScopesService.js";
import * as oauthService from "../services/oauthService.js";
import * as integrationAppQueryService from "../services/integrationAppQueryService.js";
import * as reminderCrud from "../apps/reminder/crud.js";
import * as reminderService from "../apps/reminder/service.js";
import {
  ackBuiltInAppSource,
  publishTaskResourceExpiryFollowup,
  taskResourceExpiryFollowups,
} from "../registry.manifest.js";
import {
  getRapAppConfig,
  patchRapAppConfig,
  RapAppConfigError,
} from "../services/rapAppConfigService.js";
import { pushBuiltInAppConfigForOwner } from "../services/appConfigTransportComposition.js";
import * as taskService from "../services/taskService.js";
import * as wikiService from "../services/wikiService.js";
import {
  getTaskRealtimeSurfaceTargets,
  resolveTaskChannelSurface,
  type TaskChannelSurface,
  type TaskSurfaceChannel,
} from "../services/taskChannelSurface.js";
import { emitTaskCreated, emitTaskDeleted, emitTaskMessageNew } from "../services/taskRealtimeEvents.js";
import {
  describeTaskMutation,
  emitTaskMutationToSurfaces,
} from "../services/taskMutationBroadcast.js";
import { projectRichMessageSocketPayload } from "../services/messageRealtimeEvents.js";
import { mutateMessageReaction } from "../services/messageReactionService.js";
import { isChannelReadOnlyByBillingFeature, isChannelReadOnlyByQuota } from "../services/planService.js";
import { getAttachmentFileSizeLimitBytes } from "../services/attachmentUploadPolicy.js";
import { uploadAttachmentBuffers } from "../services/attachmentUploadWriterService.js";
import type { AttachmentUploadSessionService } from "./attachmentUploadSessions.js";
import { resolveScheduleInput } from "../services/reminderScheduleInput.js";
import { computeNextFire, parseRecurrenceString, type Recurrence } from "../services/recurrence.js";
import * as agentPermalinkRenderService from "../services/agentPermalinkRenderService.js";
import * as attestedSendService from "../services/attestedSendService.js";
import { emitScopeReadUpdated } from "../services/readReceiptService.js";
import { emitThreadFollowersUpdated } from "../services/threadFollowerRealtimeService.js";
import { paginateHistoryProbe } from "./historyCursor.js";
import {
  buildServerInfoAgentSummaries,
  buildAgentProfileView,
  filterAgentVisibleHumansForHiddenDirectory,
  messageResolveErrorPayload,
  resolveAgentVisibleMessagePayload,
  resolveProfileViewForAgent,
} from "./internal.js";
import { getDb } from "../db/index.js";
import {
  attachments,
  channelAgents,
  channels,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
} from "../db/schema.js";
import { messageIdShortPrefixConditions } from "../lib/messageId.js";
import { forbiddenMessageForTarget, notFoundMessageForTarget, resolveWritableAgentTarget } from "./agentWritableTarget.js";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";
import type { Server as SocketServer } from "socket.io";
import type { AgentCapability } from "../services/agentCredentialService.js";
import { getCdnStorage, getStorage, isStorageTimeoutError } from "../services/storageService.js";
import { streamStorageResponse } from "../services/storageResponseStream.js";
import {
  buildAttachmentTooLargeResponse,
  buildAttachmentContentDisposition,
  buildAttachmentContentLengthHeader,
  buildAttachmentResponseContentType,
  canGenerateImagePreview,
  generateSvgRasterPreview,
  generateThumbnail,
  getThumbnailUrl,
  isEmptyUploadedFile,
  isOversizedUploadedFile,
  isSvgAttachmentMimeType,
  normalizeAttachmentFilename,
  normalizeUploadedMimeType,
  resolveAttachmentMimeType,
  resolveRequestAttachmentFileSizeLimitBytes,
  runSingleAttachmentUpload,
} from "./attachments.js";
import { addTraceEvent, tracePhase, withTraceChildSpan } from "../tracing/semanticTrace.js";
import { traceSendRouteFailure, traceSendRouteCatch } from "../tracing/sendRouteFailure.js";
import { traceQuerySpan } from "../tracing/queryTrace.js";
import { handleAgentKnowledgeGet, handleAgentKnowledgeSearch } from "./agentKnowledge.js";
import { AttachmentLinkError } from "../services/attachmentLinkingService.js";
import { bindRequestAbortSignal } from "./requestAbortSignal.js";
import { createChannelForAgent } from "./agentChannelCreate.js";
import { addChannelMemberForAgent, removeChannelMemberForAgent } from "./agentChannelMembers.js";
import { setChannelArchivedForAgent } from "./agentChannelLifecycle.js";
import { updateChannelForAgent } from "./agentChannelUpdate.js";
import { assertAgentCanManageServerProfile, updateServerProfileForAgent } from "./agentServerManage.js";
import { sendJsonServerError } from "./errorResponse.js";
import {
  createAvatarUpload,
  MAX_PROFILE_AVATAR_BYTES,
  PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
  PROFILE_AVATAR_TOO_LARGE_MESSAGE,
  runSingleAvatarUpload,
  storeAgentAvatar,
  storeServerAvatar,
} from "../services/avatarService.js";
import {
  FileUploadQuotaExceededError,
  buildFileUploadQuotaExceededResponse,
  getFileUploadQuotaSummary,
} from "../services/fileUploadQuotaService.js";
import {
  buildPendingMentionActionPayload,
  executeMentionActionId,
  listPendingMentionActionsForSender,
  type MentionActionExecutionOptions,
  type MentionActionKind,
  type MentionActionResult,
} from "../services/mentionActionService.js";
import { actorHasServerCapabilityInServer, getActorServerRoleInServer } from "../lib/actorPermissions.js";
import { getAppUrl } from "../config/appUrl.js";
import {
  getAgentServerLabs,
  patchAgentServerLabsAccess,
  putAgentServerLabEnrollment,
} from "./serverLabs.js";
import {
  executeManagedMcpCall,
  getManagedMcpRuntimeSnapshot,
  ManagedMcpServiceError,
} from "../services/managedMcpService.js";
import { ManagedMcpCredentialError } from "../services/managedMcpCredentialService.js";
import { ManagedMcpGatewayError } from "../services/managedMcpGateway.js";
import { ManagedMcpOAuthError } from "../services/managedMcpOAuthService.js";
import {
  FeedbackLocatorIngestError,
  ingestFeedbackLocator,
  queryFeedbackLocators,
} from "../services/productFeedbackLocatorService.js";

export const internalAgentApiRouter: RouterType = Router();

async function syncReminderToComputer(
  req: Request,
  row: reminderService.ReminderRow,
  mode: "upsert" | "cancel",
): Promise<void> {
  const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
  if (!orchestrator) return;
  try {
    if (mode === "cancel") {
      await orchestrator.pushReminderCancel(row.ownerAgentId, row.id, row.version);
    } else {
      await orchestrator.pushReminderUpsert(row.ownerAgentId, row);
    }
  } catch (error) {
    console.warn(`[reminder] Computer sync failed for ${row.id}@${row.version}:`, serializeErrorForLog(error));
  }
}

const MAX_REACTION_LENGTH = 16;
const ATTESTED_SEND_HELD_CONTEXT_LIMIT = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const profileAvatarUpload = createAvatarUpload();
const serverAvatarUpload = createAvatarUpload();
const integrationLogoUpload = createAvatarUpload();
const MAX_AGENT_PROFILE_DESCRIPTION_LENGTH = 3000;
const MAX_AGENT_PROFILE_DISPLAY_NAME_LENGTH = 80;
const REMINDER_MAX_TITLE_LEN = 500;

type AgentMigrationSummary = AgentApiResponseByRoute["migrationBegin"]["migration"];

function getFullUuidParam(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return UUID_RE.test(raw) ? raw : null;
}

function sendAttachmentNotFound(res: Response): void {
  res.status(404).json({ error: "Attachment not found" });
}

function sendAttachmentDownloadUnavailable(res: Response): void {
  res.status(404).json(AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE);
}

function serializeAgentMigration(row: agentMigrationService.AgentMigrationRow): AgentMigrationSummary {
  return {
    id: row.id,
    agentId: row.agentId,
    sourceMachineId: row.sourceMachineId,
    targetMachineId: row.targetMachineId,
    state: row.state,
    manifestPath: row.manifestPath,
    manifestSha256: row.manifestSha256,
    arrivalReportPath: row.arrivalReportPath,
    arrivalReportSha256: row.arrivalReportSha256,
    abortReason: row.abortReason,
    failureReason: row.failureReason,
    prepDeadlineAt: row.prepDeadlineAt.toISOString(),
    transferDeadlineAt: row.transferDeadlineAt.toISOString(),
    arrivalDeadlineAt: row.arrivalDeadlineAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
    flippedAt: row.flippedAt?.toISOString() ?? null,
    arrivedAt: row.arrivedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    abortedAt: row.abortedAt?.toISOString() ?? null,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sendMigrationServiceError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message === "MIGRATION_NOT_FOUND") {
    res.status(404).json({ error: "Migration not found", code: message });
    return;
  }
  if (
    message === "AGENT_NOT_FOUND" ||
    message === "AGENT_HAS_NO_SOURCE_MACHINE" ||
    message === "TARGET_MACHINE_NOT_IN_AGENT_SERVER" ||
    message === "TARGET_MACHINE_MATCHES_SOURCE"
  ) {
    res.status(400).json({ error: message, code: message });
    return;
  }
  if (message.startsWith("MIGRATION_")) {
    res.status(409).json({ error: message, code: message });
    return;
  }
  throw err;
}

function thirdPartyEventIdFromMessage(message: AgentMessage): string | null {
  const eventId = message.third_party_event?.id;
  if (typeof eventId === "string" && eventId.length > 0) return eventId;
  if (message.sender_type !== "third_party_app") return null;
  const messageId = (message as { message_id?: unknown }).message_id;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : null;
}

async function rebuildPendingThirdPartyAgentEvents(
  agentOrchestrator: AgentOrchestrator,
  agentId: string,
): Promise<void> {
  const pendingEventIds = agentOrchestrator.peekPendingMessages(agentId)
    .map(thirdPartyEventIdFromMessage)
    .filter((id): id is string => id !== null);
  const rebuilt = await oauthService.rebuildPendingThirdPartyAgentEventMessages({
    agentId,
    excludeEventIds: pendingEventIds,
  });
  for (const message of rebuilt) {
    agentOrchestrator.deliverToLocalInbox(agentId, message, { notifyPendingReceive: false });
  }
}

function validateAgentApiRequestPart<T, K extends AgentApiRouteKey>(
  routeKey: K,
  part: "params" | "query" | "body",
  value: unknown,
  res: Response,
): T | null {
  const route = agentApiContract[routeKey];
  let schema;
  if (part === "params") {
    schema = "params" in route.request ? route.request.params : undefined;
  } else if (part === "query") {
    schema = "query" in route.request ? route.request.query : undefined;
  } else {
    schema = "body" in route.request ? route.request.body : undefined;
  }
  if (!schema) return null;
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: `Invalid agent-api ${route.key} ${part}`,
      code: "agent_api_contract_invalid",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return null;
  }
  return parsed.data as T;
}

function validateAgentApiParams<K extends AgentApiRouteKey>(
  routeKey: K,
  req: Request,
  res: Response,
): AgentApiRequestParamsByRoute[K] | null {
  return validateAgentApiRequestPart<AgentApiRequestParamsByRoute[K], K>(routeKey, "params", req.params, res);
}

function validateAgentApiQuery<K extends AgentApiRouteKey>(
  routeKey: K,
  req: Request,
  res: Response,
): AgentApiRequestQueryByRoute[K] | null {
  return validateAgentApiRequestPart<AgentApiRequestQueryByRoute[K], K>(routeKey, "query", req.query, res);
}

function validateAgentApiBody<K extends AgentApiRouteKey>(
  routeKey: K,
  req: Request,
  res: Response,
): AgentApiRequestBodyByRoute[K] | null {
  return validateAgentApiRequestPart<AgentApiRequestBodyByRoute[K], K>(routeKey, "body", req.body, res);
}

function validateAgentApiParamsMiddleware<K extends AgentApiRouteKey>(routeKey: K) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = validateAgentApiParams(routeKey, req, res);
    if (!parsed) return;
    req.params = parsed as Request["params"];
    next();
  };
}

function validateAgentApiBodyMiddleware<K extends AgentApiRouteKey>(routeKey: K) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = validateAgentApiBody(routeKey, req, res);
    if (!parsed) return;
    req.body = parsed;
    next();
  };
}

function validateAgentApiQueryMiddleware<K extends AgentApiRouteKey>(routeKey: K) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = validateAgentApiQuery(routeKey, req, res);
    if (!parsed) return;
    Object.defineProperty(req, "query", {
      value: parsed as Request["query"],
      configurable: true,
      enumerable: true,
      writable: true,
    });
    next();
  };
}

// Agent API response contracts describe the JSON wire payload. Server handlers
// may still hand us DB/domain objects containing Date instances, which Express
// would stringify only after this contract check. Normalize that boundary here
// so shared schemas stay wire-only instead of accepting server-domain values.
function normalizeAgentApiWireValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeAgentApiWireValue);
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, nested]) => [key, normalizeAgentApiWireValue(nested)]),
    );
  }
  return value;
}

function sendAgentApiResponse<K extends AgentApiRouteKey>(
  routeKey: K,
  res: Response,
  body: AgentApiResponseByRoute[K],
): void {
  const route: AgentApiContractRoute = agentApiContract[routeKey];
  if (getAgentApiResponseKind(route.response) === "binary") {
    console.error(`internal.agent-api.${route.key} binary route attempted JSON response helper`);
    res.status(500).json({ error: "Agent API response contract violation" });
    return;
  }
  if (!("body" in route.response)) {
    console.error(`internal.agent-api.${route.key} JSON response route is missing a body schema`);
    res.status(500).json({ error: "Agent API response contract violation" });
    return;
  }
  const parsed = route.response.body.safeParse(normalizeAgentApiWireValue(body));
  if (!parsed.success) {
    console.error(`internal.agent-api.${route.key} response contract violation:`, parsed.error.flatten());
    res.status(500).json({ error: "Agent API response contract violation" });
    return;
  }
  res.json(parsed.data);
}

function validateAgentApiResponseMiddleware<K extends AgentApiRouteKey>(routeKey: K) {
  const route = agentApiContract[routeKey];
  if (getAgentApiResponseKind(route.response) === "binary") {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  if (!("body" in route.response)) {
    throw new Error(`Agent API ${route.key} JSON response route is missing a body schema`);
  }
  const responseBodySchema = route.response.body;
  return (_req: Request, res: Response, next: NextFunction) => {
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const parsed = responseBodySchema.safeParse(normalizeAgentApiWireValue(body));
        if (!parsed.success) {
          console.error(`internal.agent-api.${route.key} bridged response contract violation:`, parsed.error.flatten());
          res.status(500);
          return originalJson({ error: "Agent API response contract violation" });
        }
        return originalJson(parsed.data);
      }
      return originalJson(body);
    }) as Response["json"];
    next();
  };
}

async function canAgentAccessLinkedJointAttachment(
  attachment: typeof attachments.$inferSelect,
  serverId: string,
  agentId: string,
): Promise<boolean> {
  if (!attachment.messageId) return false;

  const db = getDb();
  const [message] = await db
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, attachment.messageId))
    .limit(1);
  if (!message) return false;

  const projections = await channelService.getActiveJointChannelProjectionsByLocalChannel(message.channelId);
  const localProjection = projections.find((projection) => projection.serverId === serverId);
  if (!localProjection) return false;

  return channelService.canAgentAccessChannel(localProjection.localChannelId, agentId);
}

async function canAgentAccessAttachment(
  attachment: typeof attachments.$inferSelect,
  serverId: string,
  agentId: string,
): Promise<boolean> {
  const channel = await channelService.getChannel(attachment.channelId);
  if (channel?.serverId === serverId && await channelService.canAgentAccessChannel(attachment.channelId, agentId)) {
    return true;
  }
  return canAgentAccessLinkedJointAttachment(attachment, serverId, agentId);
}

async function resolveAgentReadableAttachment(
  projection: typeof attachments.$inferSelect,
  serverId: string,
  agentId: string,
): Promise<typeof attachments.$inferSelect | null> {
  if (!projection.objectId) {
    return await canAgentAccessAttachment(projection, serverId, agentId) ? projection : null;
  }
  const context = await resolveReadableAttachmentAuthorityContext({
    projectionId: projection.id,
    requestServerId: serverId as ServerId,
    principal: { type: "agent", id: agentId },
  });
  if (!context) return null;
  return {
    ...context.projection,
    uploaderId: context.object.uploaderId,
    uploaderType: context.object.uploaderType,
    mimeType: context.object.mimeType,
    sizeBytes: context.object.sizeBytes,
    storageKey: context.object.storageKey,
    thumbnailKey: context.object.thumbnailKey,
    contentHash: context.object.contentHash,
    width: context.object.width,
    height: context.object.height,
  };
}

async function resolveReminderMsgIdForAgentApi(
  serverId: string,
  agentId: string,
  msgId: string,
): Promise<
  | { ok: true; messageId: string }
  | { ok: false; status: 400 | 404; error: string }
> {
  const db = getDb();
  if (/^[0-9a-f]{8}$/i.test(msgId)) {
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
      .where(and(
        sql`(${channels.serverId} = ${serverId} OR ${jointChannelServers.serverId} = ${serverId})`,
        ...messageIdShortPrefixConditions(msgId),
      ));

    const visibleRows = [];
    for (const row of rows) {
      const payload = await resolveAgentVisibleMessagePayload(row.id, serverId, agentId);
      if (payload) visibleRows.push(row);
    }

    if (visibleRows.length === 1) return { ok: true, messageId: visibleRows[0].id };
    if (visibleRows.length === 0) return { ok: false, status: 404, error: "message not found" };
    return { ok: false, status: 400, error: "msgId short id is ambiguous" };
  }

  if (!UUID_RE.test(msgId)) {
    return { ok: false, status: 400, error: "msgId must be a full UUID or 8-char short id" };
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
      eq(messages.id, msgId),
    ))
    .limit(1);

  if (!row) return { ok: false, status: 404, error: "message not found" };
  const payload = await resolveAgentVisibleMessagePayload(row.id, serverId, agentId);
  if (!payload) return { ok: false, status: 404, error: "message not found" };
  return { ok: true, messageId: row.id };
}

function parseReminderStatusFilter(
  req: Request,
  res: Response,
): ReminderStatus[] | null {
  const statusRaw = typeof req.query.status === "string" ? req.query.status : "";
  let statusFilter: ReminderStatus[] = ["scheduled", "fired"];
  if (statusRaw) {
    const parts = statusRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const validated: ReminderStatus[] = [];
    for (const p of parts) {
      if (!isReminderStatus(p)) {
        res.status(400).json({ error: "Invalid status value" });
        return null;
      }
      validated.push(p);
    }
    statusFilter = validated;
  } else if (req.query.all === "true") {
    statusFilter = ["scheduled", "fired", "canceled"];
  }
  return statusFilter;
}

function readReminderTimezone(
  tz: unknown,
  res: Response,
): string | null {
  if (tz === undefined) return "UTC";
  if (typeof tz !== "string" || tz.length === 0) {
    res.status(400).json({ error: "tz must be a non-empty IANA timezone string" });
    return null;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
  } catch {
    res.status(400).json({ error: `unknown timezone "${tz}"` });
    return null;
  }
  return tz;
}

function parseReminderRecurrence(
  repeat: unknown,
  tz: unknown,
  res: Response,
): Recurrence | null | undefined {
  if (repeat == null) return null;
  if (typeof repeat !== "string") {
    res.status(400).json({ error: "repeat must be a string (e.g. every:15m | daily@09:00 | weekly:mon,fri@09:00)" });
    return undefined;
  }
  const ruleTz = readReminderTimezone(tz, res);
  if (ruleTz === null) return undefined;
  const parsed = parseRecurrenceString(repeat, ruleTz);
  if (!parsed.ok) {
    res.status(400).json({ error: `repeat: ${parsed.error}` });
    return undefined;
  }
  if (
    (parsed.recurrence.rule.kind === "daily" || parsed.recurrence.rule.kind === "weekly") &&
    tz === undefined
  ) {
    res.status(400).json({
      error: "tz is required for daily@ or weekly: rules (IANA name, e.g. America/Los_Angeles)",
    });
    return undefined;
  }
  return parsed.recurrence;
}

async function loadOwnedReminder(
  reminderId: string,
  serverId: string,
  agentId: string,
): Promise<reminderService.ReminderRow | null> {
  const existing = await reminderCrud.getAppReminderById(reminderId);
  if (!existing || existing.serverId !== serverId || existing.ownerAgentId !== agentId) return null;
  return existing;
}

function emitReminderScheduled(req: Request, row: reminderService.ReminderRow, summary: unknown): void {
  const io = req.app.get("io") as SocketServer;
  io?.to(`server:${row.serverId}`).emit("reminder:scheduled", { reminder: summary });
}

function requireAgentCapability(capability: AgentCapability) {
  return (req: Request, res: Response, next: NextFunction) => {
    const failure = getAgentCapabilityFailure(req, capability);
    if (failure) {
      res.status(failure.status).json(failure.body);
      return;
    }
    next();
  };
}

function getAgentCapabilityFailure(
  req: Request,
  capability: AgentCapability,
): { status: number; body: { error: string; code: string; requiredCapability: AgentCapability } } | null {
  const scopes = Array.isArray(req.agentCredentialScopes) ? req.agentCredentialScopes : [];
  if (!scopes.includes(capability)) {
    return {
      status: 403,
      body: {
        error: "Agent credential is not authorized for this capability",
        code: "capability_not_authorized",
        requiredCapability: capability,
      },
    };
  }
  const activeRaw = typeof req.headers["x-slock-agent-active-capabilities"] === "string"
    ? req.headers["x-slock-agent-active-capabilities"]
    : "";
  if (activeRaw.trim()) {
    const active = new Set(activeRaw.split(",").map((item) => item.trim()).filter(Boolean));
    if (!active.has(capability)) {
      return {
        status: 501,
        body: {
          error: "The current runner session does not support this capability",
          code: "unsupported_capability",
          requiredCapability: capability,
        },
      };
    }
  }
  return null;
}

const continueToLegacyBridge = (_req: Request, _res: Response, next: NextFunction) => next();

function agentApiRequestValidators<K extends AgentApiRouteKey>(routeKey: K): RequestHandler[] {
  const route = agentApiContract[routeKey];
  const validators: RequestHandler[] = [];
  if ("params" in route.request) {
    validators.push(validateAgentApiParamsMiddleware(routeKey));
  }
  if ("query" in route.request) {
    validators.push(validateAgentApiQueryMiddleware(routeKey));
  }
  if ("body" in route.request) {
    validators.push(validateAgentApiBodyMiddleware(routeKey));
  }
  return validators;
}

function registerAgentApiRoute<K extends AgentApiRouteKey>(
  routeKey: K,
  ...handlers: RequestHandler[]
): void {
  const route: AgentApiContractRoute = agentApiContract[routeKey];
  const routeHandlers: RequestHandler[] = [
    requireAgentCapability(route.capability),
    ...handlers,
  ];
  switch (route.method) {
    case "GET":
      internalAgentApiRouter.get(route.path, ...routeHandlers);
      return;
    case "POST":
      internalAgentApiRouter.post(route.path, ...routeHandlers);
      return;
    case "PATCH":
      internalAgentApiRouter.patch(route.path, ...routeHandlers);
      return;
    case "DELETE":
      internalAgentApiRouter.delete(route.path, ...routeHandlers);
      return;
  }
}

function registerAgentApiBridgeRoute<K extends AgentApiRouteKey>(routeKey: K): void {
  registerAgentApiRoute(
    routeKey,
    ...agentApiRequestValidators(routeKey),
    validateAgentApiResponseMiddleware(routeKey),
    continueToLegacyBridge,
  );
}

registerAgentApiRoute(
  "feedbackLocatorIngest",
  ...agentApiRequestValidators("feedbackLocatorIngest"),
  validateAgentApiResponseMiddleware("feedbackLocatorIngest"),
  async (req, res) => {
    try {
      const receipt = await ingestFeedbackLocator({
        serverId: req.serverId!,
        agentId: req.actingAgentId!,
        artifactKind: req.body.artifact_kind,
        eventKind: req.body.event_kind,
        payload: req.body.payload,
      });
      res.json(receipt);
    } catch (error) {
      if (error instanceof FeedbackLocatorIngestError) {
        const status = error.reasonCode === "report_identity_conflict"
          ? 409
          : error.reasonCode === "storage_failed"
            ? 503
            : 400;
        res.status(status).json({ status: "failed", reason_code: error.reasonCode });
        return;
      }
      console.error("internal.agent-api.feedback-locators failed", serializeErrorForLog(error));
      res.status(503).json({ status: "failed", reason_code: "storage_failed" });
    }
  },
);

registerAgentApiRoute(
  "feedbackLocatorList",
  ...agentApiRequestValidators("feedbackLocatorList"),
  validateAgentApiResponseMiddleware("feedbackLocatorList"),
  async (req, res) => {
    const query = req.query as AgentApiFeedbackLocatorListQuery;
    const rows = await queryFeedbackLocators({
      serverId: req.serverId!,
      reportId: query.report_id,
      runtime: query.runtime,
      nativeStatus: query.native_status,
      nativeLookupMethod: query.native_lookup_method,
      servedExactSha256: query.served_exact_sha256,
      routeBasis: query.route_basis,
      limit: query.limit ? Number(query.limit) : undefined,
    });
    res.json({
      locators: rows.map((row) => ({
        report_id: row.reportId,
        receipt_id: row.receiptId,
        captured_at: row.capturedAt.toISOString(),
        runtime: row.runtime,
        native_status: row.nativeStatus,
        native_lookup_method: row.nativeLookupMethod,
        native_locator_kind: row.nativeLocatorKind,
        has_served_exact: row.hasServedExact,
        served_exact_sha256: row.servedExactSha256,
        route_basis: row.routeBasis,
        route_target: row.routeTarget,
      })),
    });
  },
);

function parseReactionEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const emoji = value.trim();
  if (!emoji || emoji.length > MAX_REACTION_LENGTH || /\s/.test(emoji)) return null;
  return emoji;
}

function toAgentFacingActorType(type: "user" | "agent" | "external_projection"): "human" | "agent" | "third_party_app" {
  return type === "external_projection" ? "third_party_app" : type === "user" ? "human" : "agent";
}

type AgentApiMessageSource = Record<string, unknown> & {
  content?: string;
  createdAt?: Date | string;
  messageType?: string;
  senderHandle?: string | null;
  senderName?: string | null;
  senderType?: string;
  taskAssigneeType?: string | null;
  taskAssigneeName?: string | null;
  timestamp?: Date | string;
  taskCurrentProjection?: {
    title: string;
    description: string | null;
    revision: number;
    superseded: boolean;
    amendedAt: Date | string | null;
    amendedByType: "user" | "agent" | "system" | null;
    amendedByName: string | null;
    source: "tasks_current_projection";
  };
};

function toAgentFacingActorTypeFromRow(value: unknown): "human" | "agent" | "third_party_app" {
  return value === "external_projection" ? "third_party_app" : value === "user" ? "human" : "agent";
}

function toAgentFacingNullableActorTypeFromRow(value: unknown): "human" | "agent" | null {
  return value === "user" ? "human" : value === "agent" ? "agent" : null;
}

function toAgentApiTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return typeof value === "string" ? value : undefined;
}

function toAgentApiMessageEnvelope(message: AgentApiMessageSource, content: string): AgentApiMessageEnvelope {
  const { senderHandle, ...messageEnvelopeFields } = message;
  const createdAt = toAgentApiTimestamp(message.createdAt);
  const timestamp = toAgentApiTimestamp(message.timestamp);
  const senderType = message.messageType === "system"
    ? "system"
    : toAgentFacingActorTypeFromRow(message.senderType);
  const taskAssigneeType = toAgentFacingNullableActorTypeFromRow(message.taskAssigneeType);
  const external = message.senderType === "external_projection";
  if (external) {
    return messageService.projectAgentVisibleHttpMessageResponse(
      message as messageService.EnrichedMessageRow,
      content,
    ) as AgentApiMessageEnvelope;
  }
  const envelope: AgentApiMessageEnvelope = {
    ...messageEnvelopeFields,
    senderName: senderHandle ?? message.senderName ?? undefined,
    senderType,
    taskAssigneeType,
    taskAssigneeName: message.taskAssigneeName ?? null,
    content,
    createdAt,
    timestamp,
    ...(message.taskCurrentProjection && {
      taskCurrentProjection: {
        ...message.taskCurrentProjection,
        amendedAt: toAgentApiTimestamp(message.taskCurrentProjection.amendedAt) ?? null,
      },
    }),
  };
  return envelope;
}

function isHistoryAnchorShape(value: string): boolean {
  return /^\d+$/.test(value) || /^[0-9a-f]{8}$/i.test(value) || UUID_RE.test(value);
}

async function canAgentAccessQueuedMessageTarget(
  channelId: string,
  agentId: string,
  serverId: string,
  message?: AgentMessage,
): Promise<boolean> {
  if (message?.third_party_event) return true;
  if (!channelId) return false;
  try {
    const channel = await channelService.getChannel(channelId);
    if (!channel || channel.serverId !== serverId) return false;
    return channelService.canAgentReceiveChannelDelivery(channelId, agentId, {
      personalMention: message?.mentioned === true,
    });
  } catch {
    return false;
  }
}

function historyAnchorErrorPayload(
  channelRef: string,
  anchor: string,
  reason: "not_found" | "ambiguous" | "invalid",
) {
  if (reason === "invalid") {
    return {
      status: 400,
      body: {
        error: `Message anchor must be a seq, full UUID, or 8-character short id in ${channelRef}: ${anchor}`,
        errorCode: "INVALID_ARG",
      },
    };
  }
  if (reason === "ambiguous") {
    return {
      status: 400,
      body: {
        error: `Message anchor is ambiguous in ${channelRef}: ${anchor}`,
        errorCode: "AMBIGUOUS_ID",
        suggestedNextAction: "Use the full message UUID instead of the 8-character short id.",
      },
    };
  }
  return {
    status: 404,
    body: {
      error: `Message not found in ${channelRef}: ${anchor}`,
      errorCode: "NOT_FOUND",
    },
  };
}

function parseIdAllowlist(value: string | undefined): Set<string> {
  return new Set((value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean));
}

function isSendFreshnessEnabled(serverId: string, agentId: string): boolean {
  const mode = (process.env.SLOCK_ATTESTED_SEND_MODE ?? "on").trim().toLowerCase();
  if (mode === "on" || mode === "force" || mode === "1" || mode === "true") return true;
  if (mode !== "allowlist") return false;

  const serverAllowlist = parseIdAllowlist(process.env.SLOCK_ATTESTED_SEND_SERVER_IDS);
  const agentAllowlist = parseIdAllowlist(process.env.SLOCK_ATTESTED_SEND_AGENT_IDS);
  return serverAllowlist.has("*") ||
    agentAllowlist.has("*") ||
    serverAllowlist.has(serverId) ||
    agentAllowlist.has(agentId);
}

function toAttestedSendTargetType(type: "channel" | "private" | "joint" | "dm" | "thread"): attestedSendService.AttestedSendTargetType {
  return type === "private" || type === "joint" ? "channel" : type;
}

function formatAttestedMessageCount(count: number): string {
  return `${count} newer message${count === 1 ? "" : "s"}`;
}

function inferAgentApiSendTargetKind(target: unknown): string {
  if (typeof target !== "string") return "missing";
  const trimmed = target.trim();
  if (!trimmed) return "missing";
  if (trimmed.startsWith("dm:") && trimmed.includes(":")) return "dm_thread";
  if (trimmed.startsWith("dm:")) return "dm";
  if (trimmed.startsWith("#") && trimmed.includes(":")) return "channel_thread";
  if (trimmed.startsWith("#")) return "channel";
  if (trimmed.startsWith("@")) return "dm_peer";
  if (trimmed.startsWith("channelId:")) return "channel_id";
  return "unknown";
}

const DRIVE_BY_JOINED_TO_POST_WINDOW_MS = 24 * 60 * 60 * 1000;

async function buildDriveByJoinedToPostAttention(
  actingAgentId: string,
  resolved: { channelId: string; type: "channel" | "private" | "joint" | "dm" | "thread" },
  target: string,
): Promise<{
  driveByJoinedToPost: {
    reason: string;
    muteCommand: string;
    stillArrives: string[];
  };
} | null> {
  const trimmedTarget = target.trim();
  if (resolved.type !== "channel" || !trimmedTarget.startsWith("#") || trimmedTarget.includes(":")) return null;

  const db = getDb();
  const [membership] = await db
    .select({ addedAt: channelAgents.addedAt })
    .from(channelAgents)
    .where(and(
      eq(channelAgents.channelId, resolved.channelId),
      eq(channelAgents.agentId, actingAgentId),
    ))
    .limit(1);
  if (!membership) return null;

  const joinedAtMs = membership.addedAt.getTime();
  if (!Number.isFinite(joinedAtMs) || Date.now() - joinedAtMs >= DRIVE_BY_JOINED_TO_POST_WINDOW_MS) return null;

  const [priorMessage] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(
      eq(messages.channelId, resolved.channelId),
      eq(messages.senderType, "agent"),
      eq(messages.senderId, actingAgentId),
    ))
    .limit(1);
  if (priorMessage) return null;

  // No D(t) oracle is needed here: recent channel join plus first top-level
  // post is the drive-by signature. Channel mute preserves personal @mention
  // pierce and followed-thread delivery; thread quieting requires unfollow.
  return {
    driveByJoinedToPost: {
      reason: "first_agent_message_with_recent_channel_join",
      muteCommand: `raft channel mute "${trimmedTarget}"`,
      stillArrives: ["@mentions still reach you, and threads you started stay followed and keep delivering until you unfollow them."],
    },
  };
}

function buildAgentChannelMuteResponse(
  channel: { id: string; name: string },
  state: channelService.InboxTargetActivityMuteState,
) {
  const channelRef = `#${channel.name}`;
  if (state.activityMuted) {
    return {
      ...state,
      attention: {
        state: "muted",
        muteFromSeq: state.muteFromSeq,
        ordinaryActivity: `Ordinary activity for ${channelRef} is muted from sequence ${state.muteFromSeq}. Existing Activity facts are not removed.`,
        unmuteCommand: `raft channel unmute ${channelRef}`,
        unmuteApi: `POST /internal/agent-api/channels/${channel.id}/unmute`,
        stillArrives: [
          "Channel mute does not mute personal @mentions; they still notify this agent.",
          "DMs still notify this agent.",
          "A task in this channel notifies this agent only when it personally @mentions you — being a task does not pierce channel mute.",
        ],
        threadBoundary: "Channel mute suppresses ordinary Activity from this channel only. Threads you follow keep delivering independently until you unfollow them.",
        catchUp: `Messages remain in ${channelRef} history. Open or read the channel to catch up; unmute does not backfill Activity suppressed while muted.`,
      },
    };
  }
  return {
    ...state,
    attention: {
      state: "unmuted",
      muteFromSeq: null,
      ordinaryActivity: `Future ordinary activity for ${channelRef} can be promoted again. Activity suppressed during the muted period is not backfilled.`,
      muteCommand: `raft channel mute ${channelRef}`,
      muteApi: `POST /internal/agent-api/channels/${channel.id}/mute`,
    },
  };
}

function buildAgentChannelLeaveAttention(channel: { name: string }) {
  const channelRef = `#${channel.name}`;
  return {
    state: "left",
    ordinaryActivity: `Ordinary channel delivery for ${channelRef} has stopped.`,
    stillArrives: [
      `If ${channelRef} is public, followed threads still notify until you unfollow them.`,
      "Personal @mentions can still notify when current visibility allows.",
    ],
    threadBoundary: "Leaving a channel does not unfollow existing thread follows. Private channel/thread content still requires current parent access.",
    manageCommand: `raft thread unfollow --target "${channelRef}:<thread-short-id>"`,
    manageApi: "POST /internal/agent-api/threads/unfollow",
  };
}

async function resolveAgentActivityMuteTarget(req: Request, res: Response) {
  const actingAgentId = req.actingAgentId!;
  const serverId = req.serverId!;
  const channelId = typeof req.params.channelId === "string" ? req.params.channelId : "";
  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== serverId || channel.deletedAt) {
    res.status(404).json({ error: "Channel not found" });
    return null;
  }
  if (channel.type === "thread") {
    res.status(400).json({
      error: "Threads do not have a separate mute state. Ordinary thread delivery is controlled by follow/unfollow and is independent from the parent channel's mute state; unfollow this thread to stop it.",
    });
    return null;
  }
  if (channel.type === "dm") {
    res.status(400).json({ error: "DM activity cannot be muted with channel mute" });
    return null;
  }
  if (channel.archivedAt) {
    res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
    return null;
  }
  const isMember = channelService.isEnabledAllChannel(channel)
    || await channelService.isChannelAgent(channel.id, actingAgentId);
  if (!isMember) {
    res.status(403).json({ error: "Agent can only mute channels it belongs to" });
    return null;
  }
  return channel;
}

async function listRecentFreshnessMessagesAfterSeq(
  agentId: string,
  agentServerId: string,
  channelId: string,
  afterSeq: number,
  limit: number,
  latestSeq: number,
  useAttentionFacts: boolean,
  options?: attestedSendService.FreshnessMessageAnchorOptions,
): Promise<AgentApiMessageEnvelope[]> {
  const freshnessMessages = useAttentionFacts
    ? await attestedSendService.listRecentAgentAttentionMessagesAfterSeq(
      agentId,
      channelId,
      afterSeq,
      limit,
      { ...options, latestSeq },
    )
    : await attestedSendService.listRecentMessagesAfterSeq(
      channelId,
      afterSeq,
      limit,
      { ...options, latestSeq },
    );
  const recentMessages = await messageService.listMessagesByIds(
    freshnessMessages.map((message) => message.messageId),
    {
      forwardedBundleViewerAgentId: agentId,
      forwardedBundleViewerServerId: agentServerId,
    },
  );
  return recentMessages.map((message) =>
    toAgentApiMessageEnvelope(message, typeof message.content === "string" ? message.content : "")
  );
}

async function recordAgentRaftAction(
  req: Request,
  agentId: string,
  event: Parameters<AgentOrchestrator["recordAgentRaftAction"]>[1],
): Promise<void> {
  const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
  if (typeof agentOrchestrator?.recordAgentRaftAction !== "function") return;
  await agentOrchestrator.recordAgentRaftAction(agentId, event);
}

function isRaftCliRequest(req: Request): boolean {
  // Dual-read is permanent: senders switched from X-Slock-Client to
  // X-Raft-Client in the slock→raft rename, but already-deployed CLI/daemon
  // builds keep sending the legacy header indefinitely.
  const client = req.header("X-Raft-Client") ?? req.header("X-Slock-Client");
  return client === "cli";
}

function recordRaftCliActivity(
  req: Request,
  agentId: string,
  event: Parameters<AgentOrchestrator["recordRaftCliAction"]>[1],
) {
  if (!isRaftCliRequest(req)) return;
  const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
  agentOrchestrator?.recordRaftCliAction?.(agentId, event);
}

function serializeOAuthClientForAgentApi(
  client: Awaited<ReturnType<typeof oauthService.listOAuthClients>>[number],
) {
  const isThirdPartyGlobal = client.appType === "third_party_global";
  const agentManifest = oauthService.resolveAgentManifest(client);
  return {
    id: client.id,
    clientId: client.clientId,
    appType: client.appType,
    name: isThirdPartyGlobal
      ? renderThirdPartyInertText({ field: "app_name", value: client.name })
      : client.name,
    description: isThirdPartyGlobal && client.description
      ? renderThirdPartyInertText({ field: "description", value: client.description })
      : (client.description ?? null),
    homepageUrl: client.homepageUrl ?? null,
    returnUrl: client.returnUrl ?? null,
    agentManifestUrl: agentManifest.url,
    agentManifestUrlSource: agentManifest.source ?? null,
    createdAt: client.createdAt.toISOString(),
    updatedAt: client.updatedAt.toISOString(),
  };
}

function serializeMarketplaceOAuthClientForAgentApi(
  client: Awaited<ReturnType<typeof oauthService.searchPublicMarketplaceOAuthClients>>[number],
) {
  const agentManifest = oauthService.resolveAgentManifest(client);
  return {
    id: client.id,
    clientId: client.clientId,
    name: renderThirdPartyInertText({ field: "app_name", value: client.name }),
    description: client.description
      ? renderThirdPartyInertText({ field: "description", value: client.description })
      : null,
    category: client.category,
    dataAccessSummary: client.dataAccessSummary
      ? renderThirdPartyInertText({ field: "data_access", value: client.dataAccessSummary })
      : null,
    homepageUrl: client.homepageUrl ?? null,
    agentManifestUrl: agentManifest.url,
    agentManifestUrlSource: agentManifest.source ?? null,
    allowedScopes: client.allowedScopes ?? [],
    logoUrl: client.logoUrl ?? null,
    installedOnServer: client.installedAt !== null,
    updatedAt: client.updatedAt.toISOString(),
  };
}

function normalizeAgentLoginScopes(
  raw: unknown,
  client: Pick<oauthService.OAuthClientRecord, "allowedScopes">,
): string[] {
  if (raw === undefined || raw === null) {
    const scopes = oauthService.defaultAgentLoginScopes(client);
    if (scopes.length === 0) throw new Error("invalid_scope");
    return scopes;
  }
  if (!Array.isArray(raw)) throw new Error("scopes must be an array");

  const scopes = Array.from(new Set(raw.map((scope) => {
    if (typeof scope !== "string") throw new Error("scopes must contain strings");
    const trimmed = scope.trim();
    if (!trimmed) throw new Error("scope values must be non-empty");
    return trimmed;
  }))).sort();

  if (scopes.length === 0) throw new Error("at least one scope is required");
  return scopes;
}

function normalizeIntegrationAppPrepareScopes(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("scopes must be an array");
  return Array.from(new Set(raw.map((scope) => {
    if (typeof scope !== "string") throw new Error("scopes must contain strings");
    const trimmed = scope.trim();
    if (!trimmed) throw new Error("scope values must be non-empty");
    return trimmed;
  }))).sort();
}

function optionalIntegrationString(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw.trim() || undefined : undefined;
}

function resolveAgentLoginClient(
  clients: Awaited<ReturnType<typeof oauthService.listOAuthClients>>,
  rawService: unknown,
):
  | { ok: true; client: Awaited<ReturnType<typeof oauthService.listOAuthClients>>[number] }
  | { ok: false; status: 400 | 404 | 409; error: string } {
  if (typeof rawService !== "string" || !rawService.trim()) {
    return { ok: false, status: 400, error: "service is required" };
  }

  const service = rawService.trim();
  const exact = clients.find((client) => client.id === service || client.clientId === service);
  if (exact) return { ok: true, client: exact };

  const normalized = service.toLowerCase();
  const nameMatches = clients.filter((client) => client.name.toLowerCase() === normalized);
  if (nameMatches.length === 1) return { ok: true, client: nameMatches[0] };
  if (nameMatches.length > 1) {
    return { ok: false, status: 409, error: "Service name is ambiguous; use the service id or client id" };
  }

  return { ok: false, status: 404, error: "Registered service not found" };
}

async function requireBoundAgentScope(
  req: Request,
  res: Response,
  agentId: string,
  scope: "action:prepare",
): Promise<boolean> {
  try {
    if (await agentScopesService.agentHasScope(agentId, scope)) return true;
    req.scopeDenyReason = "missing_scope";
    req.scopeRequired = scope;
    res.status(403).json({
      error: "missing required scope",
      requiredScope: scope,
      reason: "missing_scope",
    });
    return false;
  } catch (err) {
    console.error("agent-api scope lookup failed", serializeErrorForLog(err));
    req.scopeDenyReason = "scope_lookup_failed";
    req.scopeRequired = scope;
    res.status(403).json({
      error: "missing required scope",
      requiredScope: scope,
      reason: "scope_lookup_failed",
    });
    return false;
  }
}

type AgentApiTaskChannelContext = {
  agent: NonNullable<Awaited<ReturnType<typeof agentService.getAgent>>>;
  channelId: string;
  storageChannelId: string;
  localChannel: TaskSurfaceChannel;
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  surface: TaskChannelSurface;
};

async function resolveAgentApiTaskChannel(
  agentId: string,
  serverId: string,
  channelRef: string,
): Promise<AgentApiTaskChannelContext | null> {
  const agent = await agentService.getAgent(agentId);
  if (!agent || agent.serverId !== serverId) return null;
  const resolved = await channelService.resolveChannelByName(serverId, agentId, channelRef);
  if (!resolved) return null;
  const surface = await resolveTaskChannelSurface(serverId, resolved.channelId);
  if (!surface) return null;
  return {
    agent,
    channelId: surface.localChannel.id,
    storageChannelId: surface.storageChannelId,
    localChannel: surface.localChannel,
    channelType: surface.localChannel.type,
    surface,
  };
}

function rejectAgentApiTaskWriteIfNeeded(canPost: boolean, res: Response): boolean {
  if (!canPost) {
    res.status(403).json({ error: "Agent must join this channel to modify tasks" });
    return true;
  }
  return false;
}

async function assertAgentApiTaskWritableChannel(
  ctx: AgentApiTaskChannelContext,
  agentId: string,
  res: Response,
  options: { threadError: string },
): Promise<boolean> {
  if (ctx.channelType === "thread") {
    res.status(409).json({ error: options.threadError });
    return false;
  }
  if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return false;
  if (await channelService.isChannelArchived(ctx.channelId)) {
    res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
    return false;
  }
  return true;
}

const EXTERNAL_ACTIVITY_EVENT_LIMIT = 200;
const FORBIDDEN_EXTERNAL_ACTIVITY_KEYS = new Set(["transcript_path", "transcriptPath"]);
const ALLOWED_EXTERNAL_ACTIVITY_KEYS = new Set([
  "schema",
  "eventId",
  "event_id",
  "sessionId",
  "session_id",
  "hookEventName",
  "hook_event_name",
  "toolName",
  "tool_name",
  "status",
  "occurredAt",
  "occurred_at",
  "durationMs",
  "duration_ms",
  "errorClass",
  "error_class",
  "toolInput",
  "tool_input",
  "toolOutput",
  "tool_output",
  "toolInputTruncated",
  "tool_input_truncated",
  "toolOutputTruncated",
  "tool_output_truncated",
  "truncated",
]);

function parseExternalAgentActivityIngest(body: unknown): ExternalAgentActivityIngestRequest | { error: string; code: string } {
  if (!body || typeof body !== "object") {
    return { error: "Request body is required", code: "body_required" };
  }
  const candidate = body as Record<string, unknown>;
  if (candidate.schema !== EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA) {
    return { error: "schema must be raft-agent-activity-ingest.v1", code: "schema_invalid" };
  }
  if (!Array.isArray(candidate.events)) {
    return { error: "events must be an array", code: "events_invalid" };
  }
  if (candidate.events.length > EXTERNAL_ACTIVITY_EVENT_LIMIT) {
    return { error: `events cannot exceed ${EXTERNAL_ACTIVITY_EVENT_LIMIT}`, code: "events_too_many" };
  }
  for (const event of candidate.events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return { error: "events must contain objects", code: "event_invalid" };
    }
    for (const key of Object.keys(event)) {
      if (FORBIDDEN_EXTERNAL_ACTIVITY_KEYS.has(key)) {
        return { error: "transcript_path is not accepted on activity ingest", code: "transcript_path_forbidden" };
      }
      if (!ALLOWED_EXTERNAL_ACTIVITY_KEYS.has(key)) {
        return { error: `unknown activity event field: ${key}`, code: "event_field_unknown" };
      }
    }
  }
  return {
    schema: EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
    events: candidate.events as ExternalAgentActivityEvent[],
    ...(typeof candidate.coreSessionId === "string" ? { coreSessionId: candidate.coreSessionId } : {}),
    ...(typeof candidate.adapterInstance === "string" ? { adapterInstance: candidate.adapterInstance } : {}),
    ...(typeof candidate.dropped === "number" ? { dropped: candidate.dropped } : {}),
  };
}

type AgentApiWakeReason = "message_pending" | "system_notice_pending" | "task_pending";

interface AgentApiWakeHint {
  event_id: string;
  seq: number | null;
  message_id: string | null;
  target: string;
  channel_id: string;
  channel_name: string;
  channel_type: AgentMessage["channel_type"];
  wake_reason: AgentApiWakeReason;
  attention_hint?: AgentMessage["attention_hint"];
  traceparent?: string;
}

function queuedMessageChannelId(message: AgentMessage): string {
  return (message as AgentMessage & { channelId?: string }).channel_id
    ?? (message as AgentMessage & { channelId?: string }).channelId
    ?? "";
}

function queuedMessageSeq(message: AgentMessage): number | null {
  return Number.isInteger(message.seq) && (message.seq ?? 0) > 0 ? message.seq! : null;
}

function queuedMessageReason(message: AgentMessage): AgentApiWakeReason {
  if (message.task_number != null) return "task_pending";
  if (message.sender_type === "system") return "system_notice_pending";
  return "message_pending";
}

function buildWakeHint(message: AgentMessage): AgentApiWakeHint | null {
  const channelId = queuedMessageChannelId(message);
  if (!channelId) return null;
  const seq = queuedMessageSeq(message);
  const messageId = message.message_id ?? null;
  const eventAnchor = messageId ?? (seq !== null ? `seq-${seq}` : `${channelId}-${message.timestamp}`);
  const hint: AgentApiWakeHint = {
    event_id: `wake-hint:${eventAnchor}`,
    seq,
    message_id: messageId,
    target: `channelId:${channelId}`,
    channel_id: channelId,
    channel_name: message.channel_name,
    channel_type: message.channel_type,
    wake_reason: queuedMessageReason(message),
  };
  if (message.attention_hint) hint.attention_hint = message.attention_hint;
  if (message.traceparent) hint.traceparent = message.traceparent;
  return hint;
}

function sendManagedMcpAgentApiError(error: unknown, res: Response): void {
  if (error instanceof ManagedMcpServiceError) {
    const status = error.code.endsWith("not_found") ? 404 : 409;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ManagedMcpCredentialError) {
    res.status(503).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ManagedMcpGatewayError) {
    res.status(error.code === "managed_mcp_unreachable" ? 502 : 409).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ManagedMcpOAuthError) {
    res.status(error.code === "managed_mcp_oauth_busy" ? 503 : 409).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: "Managed MCP request failed", code: "managed_mcp_internal_error" });
}

registerAgentApiRoute("managedMcpTools", validateAgentApiResponseMiddleware("managedMcpTools"), async (req, res) => {
  try {
    res.json(await getManagedMcpRuntimeSnapshot(req.serverId!, req.actingAgentId!));
  } catch (error) {
    sendManagedMcpAgentApiError(error, res);
  }
});

registerAgentApiRoute(
  "managedMcpCall",
  ...agentApiRequestValidators("managedMcpCall"),
  validateAgentApiResponseMiddleware("managedMcpCall"),
  async (req, res) => {
  try {
    const request = req.body as AgentApiRequestBodyByRoute["managedMcpCall"];
    res.json(await withTraceChildSpan(
      "server.managed_mcp.gateway_call",
      {
        surface: "server",
        attrs: {
          event_kind: "managed_mcp_gateway_call",
          server_id: req.serverId!,
          agent_id: req.actingAgentId!,
          mcp_server_id: request.mcpServerId,
        },
      },
      () => executeManagedMcpCall(req.serverId!, req.actingAgentId!, request),
      {
        onSuccess: (result) => ({
          outcome: "success",
          result_block_count: result.content.length,
          remote_error: result.isError,
        }),
        onError: (error) => ({
          outcome: "error",
          error_code: typeof (error as { code?: unknown } | null)?.code === "string"
            ? (error as { code: string }).code
            : "managed_mcp_internal_error",
        }),
      },
    ));
  } catch (error) {
    sendManagedMcpAgentApiError(error, res);
  }
  },
);

/**
 * GET /internal/agent-api
 *
 * RFC v0.8 — whoami. Returns the bound agent identity, server,
 * credential id, and the MAX-set scopes (active-set wiring lands later).
 *
 * Response 200:
 *   { agentId, agentName, agentDisplayName, serverId, credentialId, scopes }
 */
internalAgentApiRouter.get("/", async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId;
    const serverId = req.serverId;
    const credentialId = req.agentCredentialId;
    const scopes = req.agentCredentialScopes;
    if (!actingAgentId || !serverId || !credentialId || !scopes) {
      res.status(500).json({ error: "Agent credential state missing" });
      return;
    }

    const agent = await agentService.getAgent(actingAgentId);
    if (!agent) {
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }
    const serverRole = await getActorServerRoleInServer(serverId, "agent", actingAgentId);

    res.json({
      agentId: actingAgentId,
      agentName: agent.name,
      agentDisplayName: agent.displayName ?? null,
      serverId,
      serverRole,
      serverCapabilities: getServerCapabilities(serverRole),
      credentialId,
      scopes,
    });
  } catch (err) {
    console.error("internal.agent-api.whoami error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to load agent identity" });
  }
});

/**
 * GET /internal/agent-api/server
 *
 * Agent-self equivalent of the legacy `/internal/agent/:id/server` route.
 * The acting agent is the credential-bound runner principal; there is no
 * URL `:id` to spoof.
 */
registerAgentApiRoute("serverInfo", async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }

    const channels = (await channelService.listChannelsForAgent(serverId, actingAgentId)).map((channel) => ({
      ...channel,
      id: asChannelId(channel.id),
    }));
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const allAgents = await buildServerInfoAgentSummaries(serverId, agentOrchestrator);

    const members = await serverService.getServerMembers(serverId, null);
    const visibleMembers = await filterAgentVisibleHumansForHiddenDirectory(serverId, actingAgentId, members);
    const humans = visibleMembers.map((m) => ({
      name: m.name,
      description: m.description,
      role: m.role,
    }));
    const machine = agent.machineId ? await machineService.getMachine(asMachineId(agent.machineId)) : null;
    const serverRole = await getActorServerRoleInServer(serverId, "agent", actingAgentId);
    const runtimeContext = {
      agentId: agent.id,
      runtime: agent.runtime,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort ?? null,
      serverId: agent.serverId,
      machineId: agent.machineId,
      machineName: machine?.name ?? null,
      machineDescription: machine?.description ?? null,
      machineHostname: machine?.hostname ?? null,
      machineOs: machine?.os ?? null,
      daemonVersion: agent.machineId ? agentOrchestrator?.getMachineDaemonVersion(agent.machineId) ?? machine?.daemonVersion ?? null : null,
      workspacePath: null,
    };

    sendAgentApiResponse("serverInfo", res, { runtimeContext, serverRole, serverCapabilities: getServerCapabilities(serverRole), channels, agents: allAgents, humans });
  } catch (err) {
    console.error("internal.agent-api.server error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to get server info" });
  }
});

internalAgentApiRouter.patch("/server", requireAgentCapability("server"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }

    const result = await updateServerProfileForAgent({
      actor: { id: agent.id, name: agent.name, serverId: agent.serverId },
      serverId,
      body: req.body,
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("internal.agent-api.server.update error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to update server" });
  }
});

// Server Labs uses the same transactional service and role policy as the
// human Settings API. The credential scope is an additional transport gate;
// it never substitutes for owner/admin membership authorization.
internalAgentApiRouter.get("/labs", requireAgentCapability("read"), getAgentServerLabs);
internalAgentApiRouter.patch("/labs/access", requireAgentCapability("server"), patchAgentServerLabsAccess);
internalAgentApiRouter.put("/labs/:labKey", requireAgentCapability("server"), putAgentServerLabEnrollment);

internalAgentApiRouter.post("/server/avatar", requireAgentCapability("server"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }

    const authFailure = await assertAgentCanManageServerProfile({
      actor: { id: agent.id, name: agent.name, serverId: agent.serverId },
      serverId,
    });
    if (authFailure) {
      res.status(authFailure.status).json(authFailure.body);
      return;
    }

    const server = await serverService.getServer(serverId);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const uploaded = await runSingleAvatarUpload(serverAvatarUpload, req);
    if (!uploaded) {
      res.status(400).json({ error: "No avatar file provided" });
      return;
    }

    const avatarUrl = await storeServerAvatar(server.id, server.avatarUrl, uploaded.buffer);
    const updated = await serverService.updateServerProfile(server.id, { avatarUrl });
    if (!updated) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({
        error: PROFILE_AVATAR_TOO_LARGE_MESSAGE,
        errorCode: "PROFILE_AVATAR_TOO_LARGE",
        maxBytes: MAX_PROFILE_AVATAR_BYTES,
      });
      return;
    }
    if (err instanceof Error && err.message.includes(PROFILE_AVATAR_BAD_FORMAT_MESSAGE)) {
      res.status(400).json({
        error: PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
        errorCode: "PROFILE_AVATAR_BAD_FORMAT",
      });
      return;
    }
    console.error("internal.agent-api.server.avatar error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to upload avatar" });
  }
});

internalAgentApiRouter.get("/knowledge", requireAgentCapability("knowledge"), async (req, res) => {
  const actingAgentId = req.actingAgentId;
  const serverId = req.serverId;
  if (!actingAgentId || !serverId) {
    res.status(500).json({ error: "Agent credential state missing" });
    return;
  }
  await handleAgentKnowledgeGet(req, res, { agentId: actingAgentId, serverId });
});

internalAgentApiRouter.get("/knowledge/search", requireAgentCapability("knowledge"), async (req, res) => {
  const actingAgentId = req.actingAgentId;
  const serverId = req.serverId;
  if (!actingAgentId || !serverId) {
    res.status(500).json({ error: "Agent credential state missing" });
    return;
  }
  await handleAgentKnowledgeSearch(req, res, { agentId: actingAgentId, serverId });
});

function sendWikiAgentApiError(res: Response, error: unknown): void {
  if (error instanceof wikiService.WikiError) {
    const status = error.code === "forbidden"
      ? 403
      : error.code === "not_found"
        ? 404
        : error.code === "conflict"
          ? 409
          : error.code === "storage_unavailable"
            ? 503
            : 400;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  console.error("internal.agent-api.wiki error:", serializeErrorForLog(error));
  res.status(500).json({ error: "Failed to handle Wiki Agent request" });
}

registerAgentApiRoute(
  "wikiManifestGet",
  validateAgentApiResponseMiddleware("wikiManifestGet"),
  async (req, res) => {
    try {
      res.json(await wikiService.getWikiAgentManifest(req.serverId!, req.actingAgentId!));
    } catch (error) {
      sendWikiAgentApiError(res, error);
    }
  },
);

registerAgentApiRoute(
  "wikiArtifactRead",
  ...agentApiRequestValidators("wikiArtifactRead"),
  validateAgentApiResponseMiddleware("wikiArtifactRead"),
  async (req, res) => {
    try {
      const params = req.params as AgentApiRequestParamsByRoute["wikiArtifactRead"];
      res.json(await wikiService.getWikiAgentArtifact(
        req.serverId!,
        req.actingAgentId!,
        params.artifactId,
      ));
    } catch (error) {
      sendWikiAgentApiError(res, error);
    }
  },
);

registerAgentApiRoute(
  "wikiManifestPublish",
  ...agentApiRequestValidators("wikiManifestPublish"),
  validateAgentApiResponseMiddleware("wikiManifestPublish"),
  async (req, res) => {
    try {
      const body = req.body as AgentApiRequestBodyByRoute["wikiManifestPublish"];
      res.json(await wikiService.publishWikiAgentManifest({
        serverId: req.serverId!,
        agentId: req.actingAgentId!,
        expectedEtag: body.expectedEtag,
        manifest: body.manifest,
        revisionBodies: body.revisionBodies,
      }));
    } catch (error) {
      sendWikiAgentApiError(res, error);
    }
  },
);

/**
 * GET /internal/agent-api/history?channel=<ref>&limit=<n>&before=<id|seq>&after=<id|seq>&around=<id|seq>
 *
 * Slice-1 thin port of `GET /internal/agent/:id/history`. Returns
 * channel history visible to the bound agent. No plan-cutoff handling
 * yet — that's intentionally left to the legacy surface in v0 and will
 * be folded back here in slice-2.
 */
registerAgentApiRoute("historyRead", async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const historyQuery = validateAgentApiQuery("historyRead", req, res);
    if (!historyQuery) return;
    const channelRef = historyQuery.channel;
    const limit = Math.min(Number(historyQuery.limit) || 50, 100);

    if (!channelRef) {
      res.status(400).json({ error: "channel query param is required (e.g. #all, dm:@richard)" });
      return;
    }

    // `agent-event:<id8>` is not a channel: it is the address every rendered
    // third-party line already prints. `message check` hands the body over once
    // and consumes the cursor, so without this an agent that was woken by an
    // event can never get back to it (task #257).
    // Accepts the 8-hex short form the message line prints AND the full event
    // UUID, which the rendered body already carries as `event_id: <uuid>`. Both
    // are scoped to the acting agent inside the query.
    const eventRef = /^agent-event:([0-9a-fA-F]{8}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/
      .exec(channelRef.trim())?.[1];
    if (eventRef) {
      const found = await oauthService.readThirdPartyAgentEventForAgent({
        agentId: actingAgentId,
        ref: eventRef,
      });
      if (found.kind === "ambiguous") {
        // Only reachable from owner-scoped rows, so naming the condition leaks
        // nothing. Returning the neutral 404 here would be safe but would leave
        // both of the caller's own live events permanently unreadable, which is
        // the guarantee this route exists to provide.
        res.status(409).json({
          error: "That 8-character event address matches more than one of your events. "
            + "Use the full event id, printed as `event_id:` in the event body.",
          errorCode: "AMBIGUOUS_ID",
          suggestedNextAction: "raft message read --target 'agent-event:<full-event-id>'",
        });
        return;
      }
      if (found.kind === "expired") {
        // Safe to distinguish: only ever reached for an event that IS yours, so it
        // tells you nothing you did not already have visibility of.
        res.status(410).json({
          error: "This third-party event has expired and its payload is no longer retained.",
          errorCode: "EXPIRED",
        });
        return;
      }
      if (found.kind === "absent") {
        // Deliberately the SAME neutral body used for an invisible channel, and a
        // CONSTANT: echoing the requested id here would make two ids distinguishable
        // even while errorCode stayed identical.
        res.status(404).json(CHANNEL_NOT_FOUND_BODY);
        return;
      }
      res.json({
        messages: [found.message],
        has_more: false,
        has_older: false,
        has_newer: false,
      });
      return;
    }

    const resolved = await channelService.resolveChannelByName(serverId, actingAgentId, channelRef);
    if (!resolved) {
      // Report which entity is actually missing. Saying "Channel not found" for a
      // thread ref whose channel resolves fine sent one reader into 8 retries and
      // a "the read surface is flaky" verdict for a deterministic empty (#145).
      //
      // The short id is evaluated ONLY inside the already-visible parent: a
      // `#channel:shortid` target is a thread of that channel or nothing. Looking
      // it up server-wide would hand the caller a cross-channel enumeration
      // surface they never had, and anything we then said about the other channel
      // would be a permission side-channel. @Tenny's ruling on #145.
      const { baseRef, threadShortId } = channelService.parseChannelRef(channelRef);
      if (threadShortId) {
        const parent = await channelService.resolveChannelByName(serverId, actingAgentId, baseRef);
        if (parent) {
          const anchored = await messageService.messageShortIdExistsInChannel(
            parent.channelId,
            threadShortId,
          );
          if (anchored) {
            // The anchor is genuinely here and genuinely has no replies -- the only
            // case where we may say so, because we checked.
            res.status(404).json({
              error: `No thread on message ${threadShortId} in ${baseRef}: the message is here, but it has no replies yet.`,
              errorCode: "NOT_FOUND",
              suggestedNextAction: `Read the message itself with: raft message read --target '${baseRef}' --around ${threadShortId}`,
            });
            return;
          }
          // No anchor here. Covers both "no such message anywhere" and "it lives in
          // another channel" -- one body for both, so they cannot be told apart.
          res.status(404).json(threadAnchorNotFoundBody(baseRef));
          return;
        }
      }
      // The parent channel itself is missing or invisible. Shared neutral body:
      // it must not distinguish "does not exist" from "you cannot see it".
      res.status(404).json(CHANNEL_NOT_FOUND_BODY);
      return;
    }

    const channelId = resolved.channelId;
    const hasAccess = await channelService.canAgentAccessChannel(channelId, actingAgentId);
    if (!hasAccess) {
      res.status(403).json({ error: "You do not have access to this history" });
      return;
    }

    const channel = await channelService.getChannel(channelId);
    const jointThreadProjection = channel?.type === "thread"
      ? await channelService.getJointThreadProjectionByLocalThread(channelId, serverId)
      : null;
    const resolvedAccess = channel?.type === "joint"
      ? await channelService.resolveChannelAccess({ serverId, channelId })
      : null;
    const storageChannelId = jointThreadProjection?.canonicalThreadChannelId
      ?? (resolvedAccess?.kind === "joint" ? resolvedAccess.canonicalChannelId : channelId);
    const projectionChannelId = jointThreadProjection?.localThreadChannelId
      ?? (resolvedAccess?.kind === "joint" ? resolvedAccess.localChannelId : channelId);
    const beforeAnchor = historyQuery.before?.trim();
    const afterAnchor = historyQuery.after?.trim();
    const around = historyQuery.around?.trim();
    if (beforeAnchor && !isHistoryAnchorShape(beforeAnchor)) {
      const failure = historyAnchorErrorPayload(channelRef, beforeAnchor, "invalid");
      res.status(failure.status).json(failure.body);
      return;
    }
    if (afterAnchor && !isHistoryAnchorShape(afterAnchor)) {
      const failure = historyAnchorErrorPayload(channelRef, afterAnchor, "invalid");
      res.status(failure.status).json(failure.body);
      return;
    }
    const beforeResolution = beforeAnchor
      ? await messageService.resolveMessageSeqAnchor(storageChannelId, beforeAnchor, "pagination")
      : undefined;
    if (beforeResolution && !beforeResolution.ok) {
      const failure = historyAnchorErrorPayload(channelRef, beforeAnchor!, beforeResolution.reason);
      res.status(failure.status).json(failure.body);
      return;
    }
    const afterResolution = afterAnchor
      ? await messageService.resolveMessageSeqAnchor(storageChannelId, afterAnchor, "pagination")
      : undefined;
    if (afterResolution && !afterResolution.ok) {
      const failure = historyAnchorErrorPayload(channelRef, afterAnchor!, afterResolution.reason);
      res.status(failure.status).json(failure.body);
      return;
    }
    const beforeSeq = beforeResolution?.ok ? beforeResolution.seq : undefined;
    const afterSeq = afterResolution?.ok ? afterResolution.seq : undefined;
    const lastReadSeq = await channelService.getAgentLegacyReadCursor(actingAgentId, channelId);
    let rawMsgs;
    let hasOlder = false;
    let hasNewer = false;
    if (around) {
      if (!isHistoryAnchorShape(around)) {
        const failure = historyAnchorErrorPayload(channelRef, around, "invalid");
        res.status(failure.status).json(failure.body);
        return;
      }
      const aroundResolution = await messageService.resolveMessageSeqAnchor(storageChannelId, around, "around");
      if (!aroundResolution.ok) {
        const failure = historyAnchorErrorPayload(channelRef, around, aroundResolution.reason);
        res.status(failure.status).json(failure.body);
        return;
      }
      const beforeCount = Math.floor((limit - 1) / 2);
      const afterCount = limit - beforeCount - 1;
      const context = await messageService.getMessageContextBySeq(
        storageChannelId,
        aroundResolution.seq,
        beforeCount,
        afterCount,
        undefined,
        {
          forwardedBundleViewerAgentId: actingAgentId,
          forwardedBundleViewerServerId: serverId,
        },
      );
      if (!context || context.channelId !== storageChannelId) {
        const failure = historyAnchorErrorPayload(channelRef, around, "not_found");
        res.status(failure.status).json(failure.body);
        return;
      }
      rawMsgs = context.messages;
      hasOlder = context.hasOlder;
      hasNewer = context.hasNewer;
    } else {
      rawMsgs = await messageService.listMessages(storageChannelId, limit + 1, beforeSeq, afterSeq, undefined, {
        forwardedBundleViewerAgentId: actingAgentId,
        forwardedBundleViewerServerId: serverId,
      });
    }
    const msgs = jointThreadProjection || resolvedAccess?.kind === "joint"
      ? await messageService.projectJointMessagesToLocalChannel(rawMsgs, projectionChannelId, serverId)
      : rawMsgs;
    const page = around
      ? { messages: msgs, hasOlder, hasNewer }
      : paginateHistoryProbe(
          msgs,
          limit,
          afterSeq !== undefined ? "after" : beforeSeq !== undefined ? "before" : "latest",
        );
    const pageMsgs = page.messages;
    hasOlder = page.hasOlder;
    hasNewer = page.hasNewer;

    if (!around && pageMsgs.length > 0) {
      const maxSeq = Math.max(...pageMsgs.map((m) => m.seq ?? 0));
      if (maxSeq > 0) {
        channelService.markRead({ kind: "agent", id: actingAgentId }, channelId, maxSeq).then((readState) =>
          emitScopeReadUpdated({
            io: req.app.get("io") as SocketServer | undefined,
            serverId,
            scopeId: channelId,
            peerKind: "agent",
            peerId: actingAgentId,
            maxReadSeq: readState.maxReadSeq,
            changed: readState.changed,
          })
        ).catch(() => {});
      }
    }

    const renderedContents = await agentPermalinkRenderService.renderAgentReadablePermalinksInTexts(
      pageMsgs.map((message) => message.content),
      serverId,
    );
    sendAgentApiResponse("historyRead", res, {
      messages: pageMsgs.map((message: Record<string, unknown>, index: number) =>
        toAgentApiMessageEnvelope(
          message,
          messageService.appendAgentFacingForwardedSnapshot(
            renderedContents[index] ?? "",
            message.actionMetadata,
          ),
        )
      ),
      has_more: hasOlder || hasNewer,
      has_older: hasOlder,
      has_newer: hasNewer,
      last_read_seq: lastReadSeq,
    });
  } catch (err) {
    console.error("internal.agent-api.history error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to read history" });
  }
});

/**
 * GET /internal/agent-api/mentions?limit=<n>&before_seq=<seq>
 *
 * RFC v0.8 + #proj-aiax v0 mention-CLI spec. Returns messages where
 * the bound agent was @-mentioned, newest first. v0 lock is frozen-baseline
 * + send-path-only (no backfill), filtered by `source = 'send_path'`.
 *
 * Slice-1 minimal: returns target-visible message_mentions rows. Pending
 * outsider rows remain sender-side actions until they were notifiable at send
 * time or an explicit notify/add action sets notified_at.
 */
internalAgentApiRouter.get("/mentions", requireAgentCapability("mentions"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const beforeSeq = req.query.before_seq ? Number(req.query.before_seq) : undefined;

    const db = getDb();
    const baseConditions = [
      eq(messageMentions.targetType, "agent"),
      eq(messageMentions.targetId, actingAgentId),
      eq(messageMentions.serverId, serverId),
      eq(messageMentions.source, "send_path"),
      or(eq(messageMentions.notifiableAtSend, true), isNotNull(messageMentions.notifiedAt)),
    ];

    const rows = await db
      .select({
        id: messageMentions.id,
        messageId: messageMentions.messageId,
        messageSeq: messageMentions.messageSeq,
        channelId: messageMentions.channelId,
        handleAtSendTime: messageMentions.handleAtSendTime,
        source: messageMentions.source,
        confidence: messageMentions.confidence,
        createdAt: messageMentions.createdAt,
      })
      .from(messageMentions)
      .where(and(...baseConditions))
      .orderBy(desc(messageMentions.messageSeq))
      .limit(limit + 1);

    // beforeSeq pagination applied in memory for v0 simplicity; index
    // `idx_message_mentions_inbox` already orders by message_seq DESC, so
    // a future optimization is a single drizzle `lt(messageSeq, beforeSeq)`.
    const filteredRows = beforeSeq
      ? rows.filter((r) => Number(r.messageSeq) < beforeSeq)
      : rows;
    const pageRows = filteredRows.slice(0, limit);

    res.json({
      mentions: pageRows.map((r) => ({
        id: r.id,
        messageId: r.messageId,
        messageSeq: Number(r.messageSeq),
        channelId: r.channelId,
        handleAtSendTime: r.handleAtSendTime,
        source: r.source,
        confidence: r.confidence,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      })),
      has_more: filteredRows.length > limit,
    });
  } catch (err) {
    console.error("internal.agent-api.mentions error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to load mentions" });
  }
});

/**
 * Exact self-diagnostic for one mention occurrence. The credential-bound
 * actingAgentId is the receiver identity; callers cannot select another agent.
 */
internalAgentApiRouter.get("/mentions/:messageId/delivery", requireAgentCapability("mentions"), async (req, res) => {
  try {
    const messageId = typeof req.params.messageId === "string" ? req.params.messageId : "";
    if (!UUID_RE.test(messageId)) {
      res.status(404).json({ status: "NOT_JOINABLE" });
      return;
    }
    const result = await mentionDeliveryOccurrenceService.lookupMentionDeliveryOccurrence(
      messageId,
      req.actingAgentId!,
    );
    res.status(result.status === "NOT_JOINABLE" ? 404 : 200).json(result);
  } catch (err) {
    console.error("internal.agent-api.mention-delivery error:", serializeErrorForLog(err));
    // LOOKUP_FAILED, not INSTRUMENT_FAILED. @Hipp traced that one token was carrying three
    // meanings: (a) a terminal error CODE in MentionDeliveryTerminalErrorCode — "delivery ended in
    // instrument failure"; (b) a lookup VERDICT in MentionDeliveryLookupResult.status — "I read the
    // row and it contradicts its own receipts"; (c) THIS — "the query did not run". (b) and (c)
    // both travel in a field named `status`, so a consumer could not tell them apart by shape.
    // The split is not cosmetic: (c) means "I cannot see", (a)/(b) mean "I saw it and it is
    // broken" — opposite next actions for whoever reads it. Same rule as the exit-code partition
    // ruled earlier today: codes divide by REMEDIATION, not by cause.
    // Local change: the shared union is MentionDeliveryTerminalErrorCode (meaning (a)); this 500
    // body is an untyped inline literal, so no consumer contract moves with it.
    res.status(500).json({ status: "LOOKUP_FAILED" });
  }
});

/**
 * GET /internal/agent-api/mention-actions/pending
 *
 * Sender-side mention-AX action query. These are outsider mentions emitted by
 * this bound agent where send-time delivery was intentionally withheld.
 */
registerAgentApiRoute("mentionActionsPending", async (req, res) => {
  try {
    const query = validateAgentApiQuery("mentionActionsPending", req, res);
    if (!query) return;
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
    const rows = await listPendingMentionActionsForSender(serverId, "agent", actingAgentId, limit + 1);
    const pageRows = rows.slice(0, limit);
    sendAgentApiResponse("mentionActionsPending", res, {
      pendingMentionActions: pageRows.map(buildPendingMentionActionPayload),
      has_more: rows.length > limit,
    });
  } catch (err) {
    console.error("internal.agent-api.mention-actions.pending error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to load pending mention actions" });
  }
});

/**
 * POST /internal/agent-api/mention-actions/execute
 *
 * Executes sender-side mention resolution actions. Every id is revalidated at
 * action time and returns a typed per-id status instead of failing the batch.
 */
registerAgentApiRoute("mentionActionsExecute", ...agentApiRequestValidators("mentionActionsExecute"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const action = typeof req.body?.action === "string" ? req.body.action : "";
    if (action !== "notify" && action !== "add") {
      res.status(400).json({ error: "action must be notify or add" });
      return;
    }
    const actionKind: MentionActionKind = action;
    const rawIds: unknown[] = Array.isArray(req.body?.resolutionIds)
      ? req.body.resolutionIds
      : Array.isArray(req.body?.ids)
        ? req.body.ids
        : [];
    const resolutionIds = [...new Set(rawIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean))]
      .slice(0, 100);
    if (resolutionIds.length === 0) {
      res.status(400).json({ error: "resolutionIds must include at least one id" });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const executionOptions: MentionActionExecutionOptions = agentOrchestrator
      ? {
          notifyAgent: ({ messageId, targetId }) =>
            messageService.deliverMessageToAgent(
              agentOrchestrator,
              messageId,
              targetId,
              { requireQueueReceipt: true, nonMemberMention: true },
            ),
        }
      : {};
    const results: MentionActionResult[] = [];
    for (const resolutionId of resolutionIds) {
      results.push(await executeMentionActionId(
        resolutionId,
        serverId,
        "agent",
        actingAgentId,
        actionKind,
        executionOptions,
      ));
    }
    if (agentOrchestrator && actionKind === "add") {
      await Promise.all(
        results.map(async (result) => {
          if (
            result.status !== "delivered"
            || result.reason === "already_delivered"
            || result.targetType !== "agent"
            || !result.targetId
            || !result.messageId
          ) {
            return;
          }
          try {
            await messageService.deliverMessageToAgent(
              agentOrchestrator,
              result.messageId,
              result.targetId,
              { requireQueueReceipt: true, reconcileNonMemberMention: true },
            );
          } catch (err) {
            console.error(
              `[internal.agent-api.mention-actions.execute] failed to deliver resolved mention ${result.resolutionId} to agent ${result.targetId}:`,
              err,
            );
          }
        }),
      );
    }
    sendAgentApiResponse("mentionActionsExecute", res, { ok: true, action, results });
  } catch (err) {
    console.error("internal.agent-api.mention-actions.execute error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to execute mention action" });
  }
});

/**
 * Shared reaction add/remove logic. Mirrors legacy /internal/agent/:id
 * reaction handlers without the loadOwnedMachineAgent check (the credential
 * is already bound to the agent at auth time).
 */
async function handleReaction(
  req: import("express").Request,
  res: import("express").Response,
  mode: "add" | "remove",
): Promise<void> {
  const actingAgentId = req.actingAgentId!;
  const serverId = req.serverId!;
  const emoji = parseReactionEmoji(req.body?.emoji);
  if (!emoji) {
    res.status(400).json({ error: "A valid emoji is required" });
    return;
  }

  const msgId = typeof req.params.msgId === "string" ? req.params.msgId : "";
  const resolvedMessageId = await messageService.resolveMessageIdVisibleToAgent(serverId, actingAgentId, msgId);
  if (!resolvedMessageId.ok) {
    res.status(resolvedMessageId.status).json({ error: resolvedMessageId.error });
    return;
  }
  const message = await messageService.getMessage(resolvedMessageId.messageId);
  if (!message) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  const channel = await channelService.getChannel(message.channelId);
  if (!channel || channel.serverId !== serverId) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }
  const canAccess = await channelService.canAgentAccessChannel(message.channelId, actingAgentId);
  if (!canAccess) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  if (message.messageType === "system") {
    res.status(400).json({ error: "System messages cannot receive reactions" });
    return;
  }
  const canPost = await channelService.canAgentPostToChannel(message.channelId, actingAgentId);
  if (!canPost) {
    res.status(403).json({ error: "Agent must join this channel to react to messages" });
    return;
  }
  try {
    await channelService.assertChannelNotArchived(message.channelId);
  } catch (err) {
    if (err instanceof channelService.ChannelArchivedError) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    throw err;
  }
  if (await isChannelReadOnlyByBillingFeature(message.channelId, serverId)) {
    res.status(403).json({ error: "Joint Channels require the Pro plan. Upgrade to continue." });
    return;
  }
  if (await isChannelReadOnlyByQuota(message.channelId, serverId)) {
    res.status(403).json({ error: "This channel is read-only on your current plan. Upgrade to continue." });
    return;
  }

  await mutateMessageReaction({
    messageId: message.id,
    emoji,
    actor: { kind: "agent", id: actingAgentId },
    operation: mode,
  });

  const context = await messageService.getMessageContext(message.id, 0, 0, undefined, {
    forwardedBundleViewerAgentId: actingAgentId,
    forwardedBundleViewerServerId: serverId,
  });
  const enriched = context?.messages[0];
  if (!enriched) {
    res.status(500).json({ error: "Failed to reload updated message" });
    return;
  }
  const io = req.app.get("io");
  // message-realtime-producer: route-agent-api.reaction.updated
  io.to(`channel:${message.channelId}`).emit(
    "message:updated",
    projectRichMessageSocketPayload(messageService.stripViewerScopedAttachmentCommentMetadata(enriched)),
  );
  res.json(toAgentApiMessageEnvelope(enriched, enriched.content));
}

registerAgentApiRoute("messageReactionAdd", ...agentApiRequestValidators("messageReactionAdd"), validateAgentApiResponseMiddleware("messageReactionAdd"), async (req, res) => {
  try {
    await handleReaction(req, res, "add");
  } catch (err) {
    console.error("internal.agent-api.reactions.add error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to add reaction" });
  }
});

registerAgentApiRoute("messageReactionRemove", ...agentApiRequestValidators("messageReactionRemove"), validateAgentApiResponseMiddleware("messageReactionRemove"), async (req, res) => {
  try {
    await handleReaction(req, res, "remove");
  } catch (err) {
    console.error("internal.agent-api.reactions.remove error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to remove reaction" });
  }
});

registerAgentApiRoute("channelJoin", ...agentApiRequestValidators("channelJoin"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }

    const channelId = typeof req.params.channelId === "string" ? req.params.channelId : "";
    const channel = await channelService.getChannel(channelId);
    if (!channel || channel.serverId !== serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type === "thread") {
      res.status(400).json({ error: "Thread membership is managed via follow/unfollow" });
      return;
    }
    if (channel.type === "dm") {
      res.status(403).json({ error: "Cannot join DM channels" });
      return;
    }
    if (channel.type === "private") {
      res.status(403).json({ error: "Private channels require an invitation" });
      return;
    }
    if (channel.type === "joint") {
      res.status(403).json({ error: "Joint channels require an invitation" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    const wasAgentMember = await channelService.isChannelAgent(channel.id, actingAgentId);
    if (wasAgentMember) {
      sendAgentApiResponse("channelJoin", res, { ok: true });
      return;
    }
    if (!await actorHasServerCapabilityInServer(serverId, "agent", actingAgentId, "joinPublicChannels")) {
      res.status(403).json({ error: "Server role cannot join public channels" });
      return;
    }

    await channelService.addAgent(channel.id, actingAgentId);
    if (!wasAgentMember) {
      const io = req.app.get("io") as SocketServer | undefined;
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
      if (io && agentOrchestrator) {
        await messageService.broadcastSystemMessage(
          io,
          agentOrchestrator,
          channel.id,
          `@${agent.name} joined this channel.`,
          {
            inboxFactPolicy: {
              mode: "record",
              producer: "agent.join_channel",
              reason: "agent joining a channel is shared channel activity",
            },
            // The joining agent should not see its own join as unread.
            causalActor: { type: "agent", id: actingAgentId },
          },
        );
      }
    }
    req.app.get("io")?.to(`server:${serverId}`).emit("channel:members-updated", { channelId: channel.id });
    sendAgentApiResponse("channelJoin", res, { ok: true });
  } catch (err: any) {
    sendJsonServerError(req, res, {
      error: "Failed to join channel",
      code: "agent_api_channel_join_failed",
      logPrefix: "[AgentAPI] Failed to join channel",
      err,
    });
  }
});

registerAgentApiRoute("channelLeave", ...agentApiRequestValidators("channelLeave"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }

    const channelId = typeof req.params.channelId === "string" ? req.params.channelId : "";
    const channel = await channelService.getChannel(channelId);
    if (!channel || channel.serverId !== serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type !== "channel" && channel.type !== "private") {
      res.status(403).json({ error: "Agents can only leave regular channels" });
      return;
    }
    const hasAccess = await channelService.canAgentAccessChannel(channel.id, actingAgentId);
    if (!hasAccess) {
      res.status(403).json({ error: "Agents can only leave visible regular channels" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    await channelService.removeAgent(channel.id, actingAgentId);
    if (channel.type !== "channel") {
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
      await agentOrchestrator.purgeAgentInboxForChannelTree(
        actingAgentId,
        channel.id,
        "channel_membership_removed",
      );
    }
    req.app.get("io")?.to(channel.type === "private" ? `channel:${channel.id}` : `server:${serverId}`).emit("channel:members-updated", { channelId: channel.id });
    sendAgentApiResponse("channelLeave", res, {
      ok: true,
      attention: buildAgentChannelLeaveAttention(channel),
    });
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg.includes("Cannot remove")) {
      res.status(403).json({ error: msg });
      return;
    }
    res.status(500).json({ error: "Failed to leave channel" });
  }
});

internalAgentApiRouter.post("/channels", requireAgentCapability("channels"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }

    const result = await createChannelForAgent({
      actor: { id: agent.id, name: agent.name, serverId: agent.serverId },
      serverId,
      body: req.body,
      io: req.app.get("io") as SocketServer | undefined,
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("internal.agent-api.channels.create error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to create channel" });
  }
});

internalAgentApiRouter.patch("/channels/:channelId", requireAgentCapability("channels"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }

    const result = await updateChannelForAgent({
      actor: { id: agent.id, name: agent.name, serverId: agent.serverId },
      serverId,
      channelId: String(req.params.channelId),
      body: req.body,
      io: req.app.get("io") as SocketServer | undefined,
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("internal.agent-api.channels.update error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to update channel" });
  }
});

function agentChannelLifecycleHandler(archived: boolean): RequestHandler {
  const action = archived ? "archive" : "unarchive";
  return async (req, res) => {
    try {
      const actingAgentId = req.actingAgentId!;
      const serverId = req.serverId!;
      const agent = await agentService.getAgent(actingAgentId);
      if (!agent || agent.serverId !== serverId) {
        res.status(401).json({ error: "Agent no longer exists" });
        return;
      }

      const target = String((req.body as { target: string }).target);
      const resolved = await channelService.resolveChannelByName(serverId, actingAgentId, target);
      if (!resolved) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }

      const result = await setChannelArchivedForAgent({
        actor: { id: agent.id, name: agent.name, serverId: agent.serverId },
        serverId,
        channelId: resolved.channelId,
        archived,
        io: req.app.get("io") as SocketServer | undefined,
        agentOrchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      console.error(`internal.agent-api.channels.${action} error:`, serializeErrorForLog(err));
      res.status(500).json({ error: `Failed to ${action} channel` });
    }
  };
}

registerAgentApiRoute(
  "channelArchive",
  ...agentApiRequestValidators("channelArchive"),
  validateAgentApiResponseMiddleware("channelArchive"),
  agentChannelLifecycleHandler(true),
);
registerAgentApiRoute(
  "channelUnarchive",
  ...agentApiRequestValidators("channelUnarchive"),
  validateAgentApiResponseMiddleware("channelUnarchive"),
  agentChannelLifecycleHandler(false),
);

internalAgentApiRouter.post("/channels/:channelId/members", requireAgentCapability("channels"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }

    const result = await addChannelMemberForAgent({
      actor: { id: agent.id, name: agent.name, serverId: agent.serverId },
      serverId,
      channelId: String(req.params.channelId),
      body: req.body,
      io: req.app.get("io") as SocketServer | undefined,
      agentOrchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("internal.agent-api.channels.add-member error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to add member" });
  }
});

internalAgentApiRouter.delete("/channels/:channelId/members", requireAgentCapability("channels"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }

    const result = await removeChannelMemberForAgent({
      actor: { id: agent.id, name: agent.name, serverId: agent.serverId },
      serverId,
      channelId: String(req.params.channelId),
      body: req.body,
      io: req.app.get("io") as SocketServer | undefined,
      agentOrchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("internal.agent-api.channels.remove-member error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to remove member" });
  }
});

registerAgentApiRoute("channelMute", ...agentApiRequestValidators("channelMute"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const channel = await resolveAgentActivityMuteTarget(req, res);
    if (!channel) return;

    const state = await channelService.setInboxTargetActivityMuteState({
      receiverType: "agent",
      receiverId: actingAgentId,
      serverId,
      sourceChannelId: channel.id,
      activityMuted: true,
    });
    addTraceEvent("activity_mute.agent_api.updated", {
      server_id: serverId,
      source_channel_id: channel.id,
      receiver_type: "agent",
      receiver_id: actingAgentId,
      activity_mute_state: "muted",
      activity_muted: true,
      mute_from_seq: state.muteFromSeq,
      negative_evidence_bucket: "does_not_prove_future_message_suppression",
    });
    const acceptedHint = (req.body as AgentApiRequestBodyByRoute["channelMute"] | undefined)?.attentionHintAccepted;
    if (acceptedHint && acceptedHint.scope === `#${channel.name}`) {
      addTraceEvent("attention_hint_accepted", {
        server_id: serverId,
        source_channel_id: channel.id,
        receiver_type: "agent",
        receiver_id: actingAgentId,
        schema: acceptedHint.schema || ATTENTION_HINT_SCHEMA,
        trigger: acceptedHint.trigger,
        scope: acceptedHint.scope,
        suggested_command: acceptedHint.suggested_command ?? `raft channel mute "${acceptedHint.scope}"`,
        copy_version: acceptedHint.copy_version || ATTENTION_HINT_COPY_VERSION,
        epoch_ms: acceptedHint.epoch_ms,
        action: "channel_mute",
      });
    }
    sendAgentApiResponse("channelMute", res, buildAgentChannelMuteResponse(channel, state));
  } catch (err) {
    console.error("internal.agent-api.channels.mute error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to mute channel activity" });
  }
});

registerAgentApiRoute("channelUnmute", ...agentApiRequestValidators("channelUnmute"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const channel = await resolveAgentActivityMuteTarget(req, res);
    if (!channel) return;

    const state = await channelService.setInboxTargetActivityMuteState({
      receiverType: "agent",
      receiverId: actingAgentId,
      serverId,
      sourceChannelId: channel.id,
      activityMuted: false,
    });
    addTraceEvent("activity_mute.agent_api.updated", {
      server_id: serverId,
      source_channel_id: channel.id,
      receiver_type: "agent",
      receiver_id: actingAgentId,
      activity_mute_state: "unmuted",
      activity_muted: false,
      mute_from_seq: null,
      negative_evidence_bucket: "does_not_prove_future_message_suppression",
    });
    sendAgentApiResponse("channelUnmute", res, buildAgentChannelMuteResponse(channel, state));
  } catch (err) {
    console.error("internal.agent-api.channels.unmute error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to unmute channel activity" });
  }
});

/**
 * GET /internal/agent-api/wake-hints?since=<seq|latest>&limit=<n>
 *
 * Step1 bridge D7 — content-free wake hint polling surface. This is a peek
 * over the server-side volatile delivery buffer: it returns enough metadata
 * for a bridge to wake an external runtime, but never returns message bodies,
 * never calls `/events`, and never acknowledges/drains domain delivery.
 */

/**
 * Peek the agent's deliverable pending messages and project them as
 * content-free wake hints (shared by the poll route and the SSE stream —
 * task #72). Never drains, never acks, never advances cursors; inaccessible
 * queued messages are discarded exactly as the poll route always did.
 */
async function collectDeliverableWakeHints(
  agentOrchestrator: AgentOrchestrator,
  actingAgentId: string,
  serverId: string,
  sinceSeq: number | null,
  limit: number,
): Promise<{ wakeHints: AgentApiWakeHint[]; hasMore: boolean }> {
  const queued = agentOrchestrator.peekPendingMessages(actingAgentId);
  const deliverableQueued: AgentMessage[] = [];
  const undeliverableQueued: AgentMessage[] = [];
  for (const message of queued) {
    const channelId = queuedMessageChannelId(message);
    const canAccess = await canAgentAccessQueuedMessageTarget(channelId, actingAgentId, serverId, message);
    if (canAccess) {
      deliverableQueued.push(message);
    } else {
      undeliverableQueued.push(message);
    }
  }
  if (undeliverableQueued.length > 0) {
    agentOrchestrator.discardUndeliverableMessages(actingAgentId, undeliverableQueued);
  }
  const filtered = sinceSeq !== null
    ? deliverableQueued.filter((message) => {
        const seq = queuedMessageSeq(message);
        if (seq === null && thirdPartyEventIdFromMessage(message) !== null) return true;
        return seq !== null && seq > sinceSeq;
      })
    : deliverableQueued;
  const trimmed = filtered.slice(0, limit);
  const wakeHints = trimmed
    .map(buildWakeHint)
    .filter((hint): hint is AgentApiWakeHint => hint !== null);
  return { wakeHints, hasMore: filtered.length > trimmed.length };
}

internalAgentApiRouter.get("/wake-hints", requireAgentCapability("read"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const sinceRaw = typeof req.query.since === "string" ? req.query.since.trim() : "";
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    let sinceSeq: number | null = null;
    if (sinceRaw && sinceRaw !== "latest") {
      const parsed = Number(sinceRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        res.status(400).json({
          error: "since must be a non-negative integer (messageSeq) or 'latest'",
          code: "since_invalid",
        });
        return;
      }
      sinceSeq = parsed;
    }

    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    if (isExternalAgentRuntime(agent.runtime)) {
      // CS-4: refill the volatile inbox from the durable per-channel ack
      // watermark so a server restart/deploy cannot make undrained messages
      // permanently invisible. Failure degrades to buffer-only (pre-CS-4
      // behavior) rather than failing the read. No cursor moves here.
      await messageService.rebuildExternalAgentPendingFromAckCursors(agentOrchestrator, actingAgentId, "wake_hints")
        .catch((err) => console.error("internal.agent-api cursor rebuild failed:", serializeErrorForLog(err)));
    }
    await rebuildPendingThirdPartyAgentEvents(agentOrchestrator, actingAgentId)
      .catch((err) => console.error("internal.agent-api third-party event rebuild failed:", serializeErrorForLog(err)));
    const { wakeHints, hasMore } = await collectDeliverableWakeHints(
      agentOrchestrator,
      actingAgentId,
      serverId,
      sinceSeq,
      limit,
    );
    const newestHint = wakeHints[wakeHints.length - 1];

    res.json({
      wake_hints: wakeHints,
      last_hint_seq: newestHint?.seq ?? sinceSeq,
      has_more: hasMore,
    });
  } catch (err) {
    console.error("internal.agent-api.wake-hints error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to load wake hints" });
  }
});

// Activity ingest intentionally uses read capability: the same minimal
// runner credential that can observe inbox state may report its own
// plugin-observed activity, while approve/send/write paths stay separate.
internalAgentApiRouter.post("/activity", requireAgentCapability("read"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const parsed = parseExternalAgentActivityIngest(req.body);
    if ("error" in parsed) {
      res.status(400).json(parsed);
      return;
    }

    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (typeof agentOrchestrator?.recordExternalAgentActivity !== "function") {
      res.status(503).json({ error: "Agent activity ingest is unavailable", code: "activity_ingest_unavailable" });
      return;
    }

    const result = await agentOrchestrator.recordExternalAgentActivity(actingAgentId, parsed, serverId);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("internal.agent-api.activity error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to ingest activity" });
  }
});

/**
 * GET /internal/agent-api/wake-hints/stream — D7 T1 push (task #72).
 *
 * SSE projection of the same content-free wake-hint peek as the poll route:
 * on connect it replays the currently deliverable pending hints (after
 * `Last-Event-ID`/`?since` filtering), then pushes live as the orchestrator
 * delivers to this external agent's inbox. Observationally identical to
 * polling: no bodies, no draining, no acks, no cursor movement — wake-hint
 * receipt must never advance any consume/read boundary (FH-EXT-001
 * orthogonality; wire contract #wg-external-agent:0b2a7438 msg=3f265263).
 */
internalAgentApiRouter.get("/wake-hints/stream", requireAgentCapability("read"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;

    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }

    const sinceRaw = typeof req.query.since === "string" && req.query.since.trim() !== ""
      ? req.query.since.trim()
      : (typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : "");
    let lastSentSeq: number | null = null;
    if (sinceRaw && sinceRaw !== "latest") {
      const parsed = Number(sinceRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        res.status(400).json({
          error: "since / Last-Event-ID must be a non-negative integer (messageSeq) or 'latest'",
          code: "since_invalid",
        });
        return;
      }
      lastSentSeq = parsed;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    if (isExternalAgentRuntime(agent.runtime)) {
      // CS-4: refill the volatile inbox from the durable per-channel ack
      // watermark so a server restart/deploy cannot make undrained messages
      // permanently invisible. Failure degrades to buffer-only (pre-CS-4
      // behavior) rather than failing the read. No cursor moves here.
      await messageService.rebuildExternalAgentPendingFromAckCursors(agentOrchestrator, actingAgentId, "wake_hints_stream_open")
        .catch((err) => console.error("internal.agent-api cursor rebuild failed:", serializeErrorForLog(err)));
    }
    await rebuildPendingThirdPartyAgentEvents(agentOrchestrator, actingAgentId)
      .catch((err) => console.error("internal.agent-api third-party event rebuild failed:", serializeErrorForLog(err)));

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    let closed = false;
    let flushing = false;
    let flushQueued = false;

    const flushHints = async () => {
      if (closed) return;
      if (flushing) {
        flushQueued = true;
        return;
      }
      flushing = true;
      try {
        do {
          flushQueued = false;
          const { wakeHints } = await collectDeliverableWakeHints(
            agentOrchestrator,
            actingAgentId,
            serverId,
            lastSentSeq,
            200,
          );
          for (const hint of wakeHints) {
            if (closed) return;
            res.write(`event: wake-hint\nid: ${hint.seq}\ndata: ${JSON.stringify(hint)}\n\n`);
            if (typeof hint.seq === "number" && (lastSentSeq === null || hint.seq > lastSentSeq)) {
              lastSentSeq = hint.seq;
            }
          }
        } while (flushQueued && !closed);
      } catch (err) {
        console.error("internal.agent-api.wake-hints-stream flush error:", serializeErrorForLog(err));
      } finally {
        flushing = false;
      }
    };

    // Every flush audits durable truth first (CS-4 rebuild, external agents
    // only): the flush trigger may be a cross-replica signal for a delivery
    // this process never buffered (option C, #wg-external-agent 2026-06-11),
    // a heartbeat tick, or a local emit (where the rebuild candidate query
    // is a cheap indexed no-op because the buffer already holds the rows).
    const auditAndFlush = async (): Promise<void> => {
      if (isExternalAgentRuntime(agent.runtime)) {
        await messageService.rebuildExternalAgentPendingFromAckCursors(agentOrchestrator, actingAgentId, "wake_hints_stream_flush")
          .catch((err) => console.error("internal.agent-api.wake-hints-stream durable audit failed:", serializeErrorForLog(err)));
      }
      await rebuildPendingThirdPartyAgentEvents(agentOrchestrator, actingAgentId)
        .catch((err) => console.error("internal.agent-api.wake-hints-stream third-party event rebuild failed:", serializeErrorForLog(err)));
      await flushHints();
    };

    const onDelivered = (agentId: string) => {
      if (agentId !== actingAgentId) return;
      void auditAndFlush();
    };
    agentOrchestrator.on("external-inbox-delivered", onDelivered);

    // Heartbeat doubles as a server-side reconcile tick (field incident
    // 2026-06-11, #wg-external-agent:00fcc8f7): the live push path depends on
    // an IN-PROCESS orchestrator event (now also fed cross-replica via the
    // Redis wake signal), and the periodic durable re-peek remains the
    // correctness floor when both event layers miss. flushHints dedupes via
    // lastSentSeq and stays non-draining / zero-cursor, so a quiet tick
    // writes nothing.
    const heartbeatMs = Math.min(Math.max(Number(process.env.SLOCK_WAKE_STREAM_HEARTBEAT_MS) || 25_000, 250), 60_000);
    const heartbeat = setInterval(() => {
      if (closed) return;
      res.write(": ka\n\n");
      void auditAndFlush();
    }, heartbeatMs);
    heartbeat.unref?.();

    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      agentOrchestrator.off("external-inbox-delivered", onDelivered);
    });

    // Initial replay of currently pending hints.
    await flushHints();
  } catch (err) {
    console.error("internal.agent-api.wake-hints-stream error:", serializeErrorForLog(err));
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to open wake hint stream" });
    } else {
      res.end();
    }
  }
});

/**
 * POST /internal/agent-api/send
 *
 * Slice-2 send: resolves target, runs the same freshness/held-draft gate
 * as the legacy `/internal/agent/:id/send` surface, then broadcasts +
 * delivers via `messageService.broadcastAndDeliver`.
 *
 * Body: {
 *   target: <ref>,
 *   content: string,
 *   attachmentIds?: string[],
 *   idempotencyKey?: string,
 *   sendDraft?: boolean,
 *   continueAnyway?: boolean,
 *   draftReholdCount?: number,
 *   draftReplacedExisting?: boolean,
 *   seenUpToSeq?: number
 * }
 */
/**
 * GET /internal/agent-api/events?since=<seq|latest>&limit=<n>
 *
 * RFC v0.8 — catch-up envelope. Returns messages delivered to the
 * bound agent since the given anchor, plus per-turn awareness fields:
 *   - last_seen_msgId      : delivery-batch tail id for client paging/debugging;
 *                            NOT a model-seen boundary for send freshness
 *   - last_seen_seq        : numeric cursor to pass back as `since`
 *   - reply_target         : default target hint (most recent channel)
 *   - pending_notice_ids   : transient system events queued for delivery
 *   - wake_reason          : placeholder until #164 lifecycle event RFC lands
 *
 * Slice-1 minimal contract: aggregates undelivered inbox entries via the
 * AgentOrchestrator. Designed to be the external-runtime equivalent of
 * the daemon's `agent:deliver` push channel.
 *
 * The `since` param accepts either a numeric `messageSeq` (canonical) or
 * the special string `"latest"` (return whatever is currently queued
 * without claiming an anchor). If a UUID/short id is passed, v0.8
 * returns 400; msg-id resolution is a later slice.
 */
registerAgentApiRoute("events", async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const eventsQuery = validateAgentApiQuery("events", req, res);
    if (!eventsQuery) return;
    const sinceRaw = eventsQuery.since?.trim() ?? "";
    const limit = Math.min(Math.max(Number(eventsQuery.limit) || 50, 1), 200);

    let sinceSeq: number | null = null;
    if (sinceRaw && sinceRaw !== "latest") {
      const parsed = Number(sinceRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        res.status(400).json({
          error: "since must be a non-negative integer (messageSeq) or 'latest'",
          code: "since_invalid",
        });
        return;
      }
      sinceSeq = parsed;
    }

    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    if (isExternalAgentRuntime(agent.runtime)) {
      // CS-4: refill the volatile inbox from the durable per-channel ack
      // watermark so a server restart/deploy cannot make undrained messages
      // permanently invisible. Failure degrades to buffer-only (pre-CS-4
      // behavior) rather than failing the read. No cursor moves here.
      await messageService.rebuildExternalAgentPendingFromAckCursors(agentOrchestrator, actingAgentId, "events")
        .catch((err) => console.error("internal.agent-api cursor rebuild failed:", serializeErrorForLog(err)));
    }
    await rebuildPendingThirdPartyAgentEvents(agentOrchestrator, actingAgentId)
      .catch((err) => console.error("internal.agent-api third-party event rebuild failed:", serializeErrorForLog(err)));

    // Pull whatever the orchestrator has queued for this agent. Non-blocking
    // (block=false, timeoutMs=0) — v0.8 does NOT implement long-poll on
    // this surface; the external runtime is expected to poll on its own
    // cadence or layer a WS/SSE transport on top in a later slice.
    const abortController = new AbortController();
    const queued = await agentOrchestrator.receiveMessages(
      actingAgentId,
      false,
      0,
      abortController.signal,
    );
    const deliverableQueued: typeof queued = [];
    const undeliverableQueued: typeof queued = [];
    for (const message of queued) {
      const channelId = (message as { channel_id?: string; channelId?: string }).channel_id
        ?? (message as { channel_id?: string; channelId?: string }).channelId
        ?? "";
      const canAccess = await canAgentAccessQueuedMessageTarget(channelId, actingAgentId, serverId, message);
      if (canAccess) {
        deliverableQueued.push(message);
      } else {
        undeliverableQueued.push(message);
      }
    }
    if (undeliverableQueued.length > 0) {
      agentOrchestrator.discardUndeliverableMessages(actingAgentId, undeliverableQueued);
    }

    // Apply `since` filter in memory. Slice-1 simplicity — once we have
    // a typed inbox cursor on the orchestrator we'll push this down.
    const filtered = sinceSeq !== null
      ? deliverableQueued.filter((m) => {
          const seq = Number((m as { seq?: unknown }).seq);
          if ((!Number.isFinite(seq) || seq <= 0) && thirdPartyEventIdFromMessage(m) !== null) return true;
          return Number.isFinite(seq) && seq > sinceSeq!;
        })
      : deliverableQueued;
    const trimmed = filtered.slice(0, limit);
    // Queue payloads are enqueue-time snapshots. A task may be amended (or a
    // plain message converted into a task) before this drain. Refresh every
    // persisted message id now, before rendering or acknowledging. The helper
    // throws on canonical/provenance failure so this whole request exits with
    // zero ack and the orchestrator keeps the batch for retry.
    const refreshed = await refreshQueuedAgentTaskProjections(trimmed);

    const renderedContents = await agentPermalinkRenderService.renderAgentReadablePermalinksInTexts(
      refreshed.map((m) => m.content ?? ""),
      serverId,
    );

    type QueuedAgentEventMessage = AgentMessage & {
      channelId?: string;
      channel_id?: string;
      id?: string;
      message_id?: string;
      messageType?: string;
      senderType?: string;
      sender_type?: string;
      seq?: number;
    };
    const queuedEvents = refreshed as QueuedAgentEventMessage[];
    const events = queuedEvents.map((m, index) => {
      const fallbackSenderType = m.messageType === "system"
        ? "system"
        : m.senderType === "user" || m.senderType === "agent" || m.senderType === "external_projection"
          ? toAgentFacingActorType(m.senderType)
          : "agent";
      return {
        ...m,
        // Buffer entries are snake_case AgentMessage: `sender_type` is already
        // agent-facing ("human" | "agent" | "system" | "third_party_app"). The previous mapping read
        // camelCase `m.senderType` (always undefined here), so this echo field
        // was stuck at "agent" for every event regardless of the real sender.
        senderType: m.sender_type ?? fallbackSenderType,
        content: m.sender_type === "third_party_app"
          ? m.external_message
            ? m.content
            : renderThirdPartyInertText({ field: "tool_result", value: m.content })
          : renderedContents[index],
      };
    });
    const ackSeqs = refreshed
      .map((m) => Number((m as { seq?: unknown }).seq))
      .filter((seq): seq is number => Number.isInteger(seq) && seq > 0);
    const ackMessageIds = queuedEvents
      .filter((m) => !Number.isInteger(Number(m.seq)) || Number(m.seq) <= 0)
      .map((m) => typeof m.message_id === "string" ? m.message_id : "")
      .filter(Boolean);
    const ackedThirdPartyEventIds = queuedEvents
      .map(thirdPartyEventIdFromMessage)
      .filter((id): id is string => id !== null);
    if (ackSeqs.length > 0 || ackMessageIds.length > 0) {
      // `/events` is the agent-api equivalent of legacy receive+receive-ack:
      // claim exactly the returned batch so `slock message check` does not
      // replay the same inbox forever when using an sk_agent_* credential.
      agentOrchestrator.acknowledgeDeliveredMessages(actingAgentId, ackSeqs, ackMessageIds);
      // Pre-model-seen daemon compatibility: delivery ack also advances the
      // legacy usability checkpoint until a daemon explicitly advertises true
      // model-seen boundary support. This remains distinct from freshness
      // proof; send still requires `seenUpToSeq`.
      const hasModelSeenBoundaryCapability =
        typeof agentOrchestrator.hasMachineCapability === "function"
        && agentOrchestrator.hasMachineCapability(agent.machineId, DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY);
      if (!hasModelSeenBoundaryCapability && ackSeqs.length > 0) {
        await channelService.markAgentLegacyAckCheckpoint(actingAgentId, ackSeqs);
      }
    }
    if (ackedThirdPartyEventIds.length > 0) {
      await oauthService.markThirdPartyAgentEventsDelivered(ackedThirdPartyEventIds);
    }

    // last_seen_msgId echo: prefer the newest event's id in this delivery
    // batch; if empty, return null. This is a delivery cursor/debug echo,
    // NOT a model-seen boundary. Do not feed it into send freshness;
    // `/internal/agent-api/send` requires runtime-maintained `seenUpToSeq`.
    const newestEvent = events[events.length - 1] as QueuedAgentEventMessage | undefined;
    const lastSeenMsgId = newestEvent?.id ?? null;
    const lastSeenSeq = newestEvent?.seq ?? sinceSeq;

    // reply_target hint: newest event's channelId is a reasonable default
    // for the external runtime's first action. Null when the batch is empty.
    const replyChannelId = newestEvent?.channelId ?? newestEvent?.channel_id;
    const replyTarget = replyChannelId
      ? `channelId:${replyChannelId}`
      : null;

    addTraceEvent("external_agent.events.check.finished", {
      body_result: events.length > 0 ? "returned" : "empty",
      returned_count: events.length,
      queued_count: queued.length,
      filtered_count: filtered.length,
      undeliverable_count: undeliverableQueued.length,
      is_external: isExternalAgentRuntime(agent.runtime),
      since_seq: sinceSeq,
    });

    sendAgentApiResponse("events", res, {
      events,
      last_seen_msgId: lastSeenMsgId,
      last_seen_seq: lastSeenSeq,
      reply_target: replyTarget,
      // Slice-1 placeholders — populated once the corresponding subsystems land.
      pending_notice_ids: [] as string[],
      wake_reason: null as string | null,
      has_more: filtered.length > trimmed.length,
    });
  } catch (err) {
    console.error("internal.agent-api.events error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to load events" });
  }
});

registerAgentApiRoute("attachmentDownload", ...agentApiRequestValidators("attachmentDownload"), async (req, res) => {
  let attachmentForLog: typeof attachments.$inferSelect | null = null;
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const attachmentId = getFullUuidParam(req.params.attachmentId);
    if (!attachmentId) {
      sendAttachmentDownloadUnavailable(res);
      return;
    }
    const db = getDb();
    const [projection] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    if (!projection) {
      sendAttachmentDownloadUnavailable(res);
      return;
    }
    attachmentForLog = projection;
    const attachment = await resolveAgentReadableAttachment(projection, serverId, actingAgentId);
    if (!attachment) {
      sendAttachmentDownloadUnavailable(res);
      return;
    }
    const storage = getStorage();
    if (!storage) {
      res.status(503).json({ error: "File storage is not configured on this server" });
      return;
    }
    const contentType = buildAttachmentResponseContentType(attachment.mimeType);
    const contentDisposition = buildAttachmentContentDisposition(attachment.filename, attachment.mimeType);
    if (storage.getPresignedUrl) {
      const presignedUrl = await storage.getPresignedUrl(attachment.storageKey, {
        expiresIn: 300,
        responseContentDisposition: contentDisposition,
        responseContentType: contentType,
      });
      res.status(302);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Location", presignedUrl);
      res.setHeader("Content-Length", "0");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end();
      return;
    }

    const stream = await storage.get(attachment.storageKey);
    const contentLength = buildAttachmentContentLengthHeader(attachment.sizeBytes);
    res.setHeader("Cache-Control", "private, immutable, max-age=31536000");
    res.setHeader("Content-Type", contentType);
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", contentDisposition);
    await streamStorageResponse(stream, res);
  } catch (err) {
    if (res.destroyed || res.headersSent) return;
    console.error("internal.agent-api.attachments error:", {
      attachmentId: attachmentForLog?.id ?? req.params.attachmentId ?? null,
      channelId: attachmentForLog?.channelId ?? null,
      storageKey: attachmentForLog?.storageKey ?? null,
      sizeBytes: attachmentForLog?.sizeBytes ?? null,
      mimeType: attachmentForLog?.mimeType ?? null,
      filename: attachmentForLog?.filename ?? null,
      errorClass: err instanceof Error ? err.name : typeof err,
    });
    res.status(500).json({ error: "Failed to serve attachment" });
  }
});

// --- Attachment comments (attachment-comments MVP spec, PR3 agent transport) ---
// Mirrors the user routes on /api/attachments/:id/comments. Both transports
// reuse attachmentCommentService so there is exactly one comment pipeline;
// the agent-side authorize is canAgentPostToChannel on the parent channel.

registerAgentApiRoute("attachmentCommentsList", ...agentApiRequestValidators("attachmentCommentsList"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    // Feature flag gate — agents outside the enabled server get the same
    // consistent 403 as the user APIs.
    if (!(await attachmentCommentService.attachmentCommentsEnabledForServer(serverId))) {
      res.status(403).json({ error: "Attachment comments are not enabled on this server", code: "attachment_comments_disabled" });
      return;
    }
    const attachmentId = getFullUuidParam(req.params.attachmentId);
    if (!attachmentId) {
      sendAttachmentNotFound(res);
      return;
    }
    const db = getDb();
    const [projection] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    if (!projection) {
      sendAttachmentNotFound(res);
      return;
    }
    const attachment = await resolveAgentReadableAttachment(projection, serverId, actingAgentId);
    if (!attachment) {
      sendAttachmentNotFound(res);
      return;
    }
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const result = await attachmentCommentService.listAttachmentComments(attachment.id, {
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
    });
    // §5 resolve AX (task #40): enrich each comment with resolved status
    // so agents see which comments are actionable without reimplementing
    // the resolve rule from raw reactions.
    const parentMsg = attachment.messageId
      ? await db.select({ senderId: messages.senderId, senderType: messages.senderType })
          .from(messages).where(eq(messages.id, attachment.messageId)).limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    const enrichedComments = parentMsg
      ? attachmentCommentService.enrichCommentsWithResolveStatus(
          result.comments as Array<Record<string, unknown> & { senderId: string; reactions: Array<{ emoji: string; reactorType: string; reactorId: string; createdAt: Date }> }>,
          parentMsg,
        )
      : result.comments.map((c) => ({ ...c, resolved: false, resolvedBy: null, resolvedAt: null }));
    // Viewer resolve capability: an agent can resolve iff it is the parent
    // message author (its ✅ satisfies §5 rule 2).
    const canResolve = !!(parentMsg && actingAgentId === parentMsg.senderId);
    const body: AgentApiAttachmentCommentsResponse = {
      ...result,
      comments: enrichedComments as AgentApiAttachmentCommentsResponse["comments"],
      viewer: {
        canComment: false,
        reason: "agent_descoped" as const,
        canResolve,
        ...(canResolve ? { resolveAction: { type: "reaction", emoji: "✅" } } : {}),
      },
    };
    sendAgentApiResponse("attachmentCommentsList", res, body);
  } catch (err) {
    console.error("internal.agent-api.attachment-comments.list error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to load comments" });
  }
});

internalAgentApiRouter.post("/attachments/:attachmentId/comments", requireAgentCapability("send"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const content = req.body?.content;
    const attachmentId = getFullUuidParam(req.params.attachmentId);
    if (!attachmentId) {
      sendAttachmentNotFound(res);
      return;
    }
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const io = req.app.get("io");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const result = await attachmentCommentService.createAttachmentComment(io, agentOrchestrator, {
      attachmentId,
      serverId,
      senderType: "agent",
      senderId: actingAgentId,
      senderName: agent.displayName || agent.name || "Agent",
      content,
      authorize: async (parentChannelId) => {
        const canPost = await channelService.canAgentPostToChannel(parentChannelId, actingAgentId);
        if (!canPost) {
          throw new attachmentCommentService.AttachmentCommentError(
            403,
            "not_a_member",
            "Agent must be a member of this channel to comment",
          );
        }
      },
    });
    res.json(result);
  } catch (err) {
    if (err instanceof attachmentCommentService.AttachmentCommentError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    console.error("internal.agent-api.attachment-comments.create error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to create comment" });
  }
});

async function handleAgentApiMessageSend(
  req: Request,
  res: Response,
  routeKey: "messageSend" | "messageSendV2",
): Promise<void> {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const sendBody = validateAgentApiBody(routeKey, req, res);
    if (!sendBody) return;
    const {
      target,
      content,
      attachmentIds,
      idempotencyKey,
      continue: deprecatedContinue,
      sendDraft,
      continueAnyway,
      draftReholdCount,
      draftReplacedExisting,
      seenUpToSeq,
      freshnessContextMode,
    } = sendBody;
    const mentions = routeKey === "messageSendV2" && "mentions" in sendBody
      ? sendBody.mentions as messageService.StructuredMentionInput[] | undefined
      : undefined;
    const isSendDraft = sendDraft === true;
    const isContinueAnyway = continueAnyway === true;
    const withholdFreshnessContext = freshnessContextMode === "withheld";
    const parsedDraftReholdCount = typeof draftReholdCount === "number" && Number.isFinite(draftReholdCount)
      ? Math.max(0, Math.floor(draftReholdCount))
      : 0;
    const attachmentCount = Array.isArray(attachmentIds) ? attachmentIds.length : 0;
    const requestedSendFreshness = isSendDraft ||
      isContinueAnyway ||
      typeof seenUpToSeq === "number" ||
      typeof draftReholdCount === "number" ||
      draftReplacedExisting === true ||
      withholdFreshnessContext;

    addTraceEvent("agent_api_send.request.started", {
      target_kind: inferAgentApiSendTargetKind(target),
      content_chars: typeof content === "string" ? content.length : 0,
      attachment_count: attachmentCount,
      idempotency_key_present: typeof idempotencyKey === "string" && idempotencyKey.length > 0,
      send_draft: isSendDraft,
      continue_anyway: isContinueAnyway,
      freshness_requested: requestedSendFreshness,
      freshness_context_mode: freshnessContextMode ?? "inline",
    });

    if (!target || typeof target !== "string") {
      traceSendRouteFailure("bad_request", 400);
      res.status(400).json({ error: "target is required" });
      return;
    }
    if (!content || typeof content !== "string") {
      traceSendRouteFailure("bad_request", 400);
      res.status(400).json({ error: "Content is required" });
      return;
    }
    if (deprecatedContinue === true) {
      traceSendRouteFailure("bad_request", 400);
      res.status(400).json({
        error: "--continue is no longer supported. Use normal message send to update a draft, or --send-draft to send the current saved draft.",
      });
      return;
    }
    if (isContinueAnyway && !isSendDraft) {
      traceSendRouteFailure("bad_request", 400);
      res.status(400).json({ error: "--send-draft --anyway requires a saved draft" });
      return;
    }

    const agent = await tracePhase(
      () => agentService.getAgent(actingAgentId),
      (_durationMs, result) => ({
        name: "agent_api_send.agent.loaded",
        attrs: {
          outcome: result && result.serverId === serverId ? "found" : "missing",
          runtime: result?.runtime ?? null,
        },
      }),
    );
    if (!agent || agent.serverId !== serverId) {
      traceSendRouteFailure("agent_not_found", 401);
      res.status(401).json({ error: "Agent no longer exists" });
      return;
    }
    const sendFreshnessEnabled = isSendFreshnessEnabled(agent.serverId, actingAgentId);
    const sendFreshnessMode = (process.env.SLOCK_ATTESTED_SEND_MODE ?? "on").trim().toLowerCase();
    const shouldRunSendFreshness = sendFreshnessEnabled &&
      (requestedSendFreshness || sendFreshnessMode === "force");
    if (!sendFreshnessEnabled && requestedSendFreshness) {
      traceSendRouteFailure("freshness_not_enabled", 403);
      res.status(403).json({ error: "Send freshness interface is not enabled for this agent." });
      return;
    }

    const resolved = await tracePhase(
      () => resolveWritableAgentTarget(serverId, actingAgentId, target),
      (_durationMs, result) => ({
        name: "agent_api_send.target.resolved",
        attrs: {
          outcome: typeof result === "string" ? result : result ? "resolved" : "not_found",
          target_type: typeof result === "object" && result ? result.type : null,
        },
      }),
    );
    if (resolved === "forbidden") {
      traceSendRouteFailure("target_forbidden", 403);
      res.status(403).json({ error: forbiddenMessageForTarget(target) });
      return;
    }
    if (resolved === "peer-not-found") {
      traceSendRouteFailure("target_not_found", 404);
      res.status(404).json({ error: `User or agent not found: @${target.slice(4)}` });
      return;
    }
    if (resolved === "self-dm") {
      traceSendRouteFailure("bad_request", 400);
      res.status(400).json({ error: "Cannot create a DM with yourself" });
      return;
    }
    if (!resolved) {
      traceSendRouteFailure("target_not_found", 404);
      res.status(404).json({ error: notFoundMessageForTarget(target) });
      return;
    }
    try {
      await tracePhase(
        () => channelService.assertChannelNotArchived(resolved.channelId),
        () => ({
          name: "agent_api_send.archive.checked",
          attrs: {
            outcome: "active",
            target_type: resolved.type,
          },
        }),
      );
    } catch (err) {
      if (err instanceof channelService.ChannelArchivedError) {
        addTraceEvent("agent_api_send.archive.checked", {
          outcome: "archived",
          target_type: resolved.type,
        });
        traceSendRouteFailure("channel_archived", 409);
        res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
        return;
      }
      throw err;
    }

    const io = req.app.get("io");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    let attestedSendActivityContext: {
      targetType: attestedSendService.AttestedSendTargetType;
      targetRef: string;
      newMessageCount: number;
    } | null = null;

    if (shouldRunSendFreshness) {
      const freshness = await tracePhase(
        async () => {
          const selfSender = { senderType: "agent" as const, senderId: actingAgentId };
          const useAttentionFacts = resolved.type !== "thread";
          const latestAnchor = useAttentionFacts
            ? await attestedSendService.getLatestAgentAttentionAnchor(actingAgentId, resolved.channelId, {
              excludeSender: selfSender,
            })
            : await attestedSendService.getLatestMessageAnchor(resolved.channelId, {
              excludeSender: selfSender,
            });
          const hasClientSeenBoundary = typeof seenUpToSeq === "number" && Number.isFinite(seenUpToSeq);
          const clientSeenUpToSeq = hasClientSeenBoundary
            ? Math.max(0, Math.floor(seenUpToSeq))
            : 0;
          const threadParentAnchor = !hasClientSeenBoundary && resolved.type === "thread"
            ? await attestedSendService.getThreadParentAnchor(resolved.channelId)
            : null;
          // Freshness proof must come from the current model-seen boundary.
          // Durable legacy read-ish cursors cannot prove the model actually saw
          // the messages; delivery ack state is volatile inbox state. The only
          // fallback is a cold thread's parent message.
          const latestFreshnessSeq = Math.max(latestAnchor.seq, threadParentAnchor?.seq ?? 0);
          const latestFreshnessMessageId = latestAnchor.seq > 0 && latestAnchor.seq >= (threadParentAnchor?.seq ?? 0)
            ? latestAnchor.messageId
            : (threadParentAnchor?.messageId ?? latestAnchor.messageId);
          const fallbackBoundarySeq = threadParentAnchor?.seq ?? 0;
          const attestedBoundarySeq = Math.min(
            hasClientSeenBoundary ? clientSeenUpToSeq : fallbackBoundarySeq,
            latestFreshnessSeq,
          );
          const attestedBoundaryMessageId = attestedBoundarySeq <= 0
            ? null
            : attestedBoundarySeq === threadParentAnchor?.seq
              ? threadParentAnchor.messageId
              : await attestedSendService.getMessageIdForSeq(resolved.channelId, attestedBoundarySeq);
          const newMessageCount = latestFreshnessSeq > attestedBoundarySeq
            ? useAttentionFacts
              ? await attestedSendService.countAgentAttentionMessagesAfterSeq(actingAgentId, resolved.channelId, attestedBoundarySeq, {
                excludeSender: selfSender,
                latestSeq: latestFreshnessSeq,
              })
              : await attestedSendService.countMessagesAfterSeq(resolved.channelId, attestedBoundarySeq, {
                excludeSender: selfSender,
                latestSeq: latestFreshnessSeq,
              })
            : 0;
          const attestedTargetType = toAttestedSendTargetType(resolved.type);
          const boundarySource = hasClientSeenBoundary
            ? "client_seen"
            : threadParentAnchor
              ? "thread_parent"
              : "none";
          const formalMentionFacts = attestedBoundarySeq > 0 && latestFreshnessSeq > attestedBoundarySeq
            ? await attestedSendService.getFormalMentionFacts(actingAgentId, resolved.channelId, attestedBoundarySeq, latestFreshnessSeq)
            : { count: 0, firstMessageId: null, firstHandle: null };
          return {
            latestFreshnessSeq,
            latestFreshnessMessageId,
            attestedBoundarySeq,
            attestedBoundaryMessageId,
            newMessageCount,
            attestedTargetType,
            boundarySource,
            formalMentionFacts,
            useAttentionFacts,
            shouldHoldForFreshness: !isContinueAnyway && newMessageCount > 0,
          };
        },
        (_durationMs, result) => ({
          name: "agent_api_send.freshness.evaluated",
          attrs: {
            outcome: result.shouldHoldForFreshness ? "held" : "passed",
            target_type: resolved.type,
            boundary_source: result.boundarySource,
            new_message_count: result.newMessageCount,
            formal_mention_count: result.formalMentionFacts.count,
            send_draft: isSendDraft,
            continue_anyway: isContinueAnyway,
          },
        }),
      );
      attestedSendActivityContext = {
        targetType: freshness.attestedTargetType,
        targetRef: target,
        newMessageCount: freshness.newMessageCount,
      };

      const renderHeldResponse = async (
        replacedExisting: boolean,
        reholdCount: number,
        boundarySeq: number,
        boundaryMessageId: string | null,
        latestSeq: number,
        latestMessageId: string | null,
        mentionCount: number,
        boundarySource: string,
        attestedTargetType: attestedSendService.AttestedSendTargetType,
        useAttentionFacts: boolean,
      ): Promise<AgentApiHeldFreshnessResponse> => {
        const heldMessages = withholdFreshnessContext
          ? []
          : await listRecentFreshnessMessagesAfterSeq(
              actingAgentId,
              serverId,
              resolved.channelId,
              boundarySeq,
              ATTESTED_SEND_HELD_CONTEXT_LIMIT,
              latestSeq,
              useAttentionFacts,
              { excludeSender: { senderType: "agent", senderId: actingAgentId } },
            );
        const heldSeqs = heldMessages
          .map((message) => Number((message as { seq?: unknown }).seq))
          .filter((seq) => Number.isInteger(seq) && seq > 0);
        const attentionHoldCount = latestSeq > boundarySeq
          ? useAttentionFacts
            ? await attestedSendService.countAgentAttentionMessagesAfterSeq(actingAgentId, resolved.channelId, boundarySeq, {
              excludeSender: { senderType: "agent", senderId: actingAgentId },
              latestSeq,
            })
            : await attestedSendService.countMessagesAfterSeq(resolved.channelId, boundarySeq, {
              excludeSender: { senderType: "agent", senderId: actingAgentId },
              latestSeq,
            })
          : 0;
        const shownMessageCount = heldMessages.length;
        // Without a model-seen boundary, do not present the whole target
        // history as "new messages"; this is a bounded first-touch context.
        const hasModelSeenBoundary = boundarySource === "client_seen";
        const firstTouchContextCount = withholdFreshnessContext
          ? Math.min(attentionHoldCount, ATTESTED_SEND_HELD_CONTEXT_LIMIT)
          : shownMessageCount;
        const holdCount = hasModelSeenBoundary ? attentionHoldCount : firstTouchContextCount;
        const omittedMessageCount = !withholdFreshnessContext && hasModelSeenBoundary
          ? Math.max(0, attentionHoldCount - shownMessageCount)
          : 0;
        // Chat semantics (task #41 final review): the boundary advances to
        // latestSeq below and skipped messages are silently read through,
        // like a human opening a conversation — that behavior is correct and
        // deliberately unchanged. The hold's only obligation is the honest
        // in-the-moment sentence: true skipped count (omittedMessageCount,
        // attention semantics — never a seq span) plus the runnable --before
        // anchor (minShownSeq). Nothing is persisted or re-surfaced.
        const minShownSeq = heldSeqs.length > 0 ? Math.min(...heldSeqs) : null;
        // Thread digest anchor: where this conversation started. Only fetched
        // for threads, only when context is shown, and only when the parent
        // is not already inside the displayed window.
        const threadParentMessage = !withholdFreshnessContext && resolved.type === "thread"
          ? await attestedSendService.getThreadParentMessage(resolved.channelId)
          : null;
        if (!withholdFreshnessContext) {
          const readState = await channelService.markRead(
            { kind: "agent", id: actingAgentId },
            resolved.channelId,
            latestSeq,
          );
          await emitScopeReadUpdated({
            io: req.app.get("io") as SocketServer | undefined,
            serverId: agent.serverId,
            scopeId: resolved.channelId,
            peerKind: "agent",
            peerId: actingAgentId,
            maxReadSeq: readState.maxReadSeq,
            changed: readState.changed,
          });
          if (latestSeq > boundarySeq) {
            const ack = agentOrchestrator.acknowledgeDeliveredMessagesForChannelUpToSeq?.(
              actingAgentId,
              resolved.channelId,
              latestSeq,
            ) ?? agentOrchestrator.acknowledgeDeliveredMessagesForChannel(actingAgentId, resolved.channelId, heldSeqs);
            if (ack.removedCount > 0) {
              // Held context is returned inline; do not also redeliver it as unread.
            }
          }
        }
        await attestedSendService.recordGateTriggered({
          id: randomUUID(),
          agentId: actingAgentId,
          serverId: agent.serverId,
          targetType: attestedTargetType,
          targetRef: target,
        }, {
          lastSeenMessageId: boundaryMessageId,
          latestMessageId,
          hasFormalMentionSinceLastSeen: false,
          draftReplacedExisting: replacedExisting,
          newMessageCount: holdCount,
          boundarySource,
          boundarySeq,
          latestSeq,
        });
        const freshnessDecision = {
          action: "send" as const,
          decision: "syncing_hold" as const,
          ...(withholdFreshnessContext ? { freshnessContextMode: "withheld" as const } : {}),
          target,
          reason: hasModelSeenBoundary ? "server_stale_model_boundary" : "server_first_touch_context",
          pendingMaxSeq: latestSeq,
          modelSeenSeq: hasModelSeenBoundary ? boundarySeq : 0,
          heldMessageCount: shownMessageCount,
          omittedMessageCount,
        };
        const producerFactId = buildApmFreshnessDecisionProducerFactId(actingAgentId, freshnessDecision);
        const envelope = projectApmHeldFreshnessEnvelope<AgentApiMessageEnvelope>({
          producerFactId,
          action: "send",
          decision: "syncing_hold",
          heldMessages,
          newMessageCount: holdCount,
          omittedMessageCount,
          seenUpToSeq: latestSeq,
          freshnessContextMode: withholdFreshnessContext ? "withheld" : undefined,
        });
        if (withholdFreshnessContext) {
          await recordAgentRaftAction(req, actingAgentId, {
            title: "Reviewer-isolation freshness hold",
            text: `${formatAttestedMessageCount(holdCount)} withheld`,
          });
        } else {
          const activity = projectApmHeldFreshnessActivity({
            producerFactId,
            action: "send",
            decision: "syncing_hold",
            target,
            messageCount: shownMessageCount,
          });
          const title = reholdCount > 0 || isSendDraft ? "Send draft held" : activity.entry.title;
          await recordAgentRaftAction(req, actingAgentId, {
            title,
            text: activity.entry.text,
            producerFactId,
            activity: activity.statusEntry.activity,
            activityDetail: title,
          });
        }
        return {
          ...(!withholdFreshnessContext ? { ok: true } : {}),
          ...envelope.body,
          ...(!withholdFreshnessContext
            ? { mentionAnnotation: { formalMentionCount: mentionCount } }
            : {}),
          ...(!withholdFreshnessContext
            ? { continueAnywaySuggested: reholdCount >= 3 }
            : {}),
          ...(!withholdFreshnessContext
            ? { seenUpToMessageId: latestMessageId }
            : {}),
          ...(!withholdFreshnessContext && minShownSeq !== null
            ? { firstShownSeq: minShownSeq }
            : {}),
          ...(!withholdFreshnessContext
            && threadParentMessage
            && (minShownSeq === null || threadParentMessage.seq < minShownSeq)
            ? {
              threadParentMessage: {
                seq: threadParentMessage.seq,
                messageId: threadParentMessage.messageId,
                senderName: threadParentMessage.senderName,
                createdAt: threadParentMessage.createdAt?.toISOString() ?? null,
                content: threadParentMessage.content,
              },
            }
            : {}),
        };
      };

      if (freshness.shouldHoldForFreshness) {
        const response = await tracePhase(
          () => renderHeldResponse(
            draftReplacedExisting === true,
            parsedDraftReholdCount,
            freshness.attestedBoundarySeq,
            freshness.attestedBoundaryMessageId,
            freshness.latestFreshnessSeq,
            freshness.latestFreshnessMessageId,
            freshness.formalMentionFacts.count,
            freshness.boundarySource,
            freshness.attestedTargetType,
            freshness.useAttentionFacts,
          ),
          (_durationMs, result) => ({
            name: "agent_api_send.held_response.rendered",
            attrs: {
              held_message_count: result.heldMessages?.length ?? 0,
              new_message_count: result.newMessageCount ?? 0,
              shown_message_count: result.shownMessageCount ?? 0,
              omitted_message_count: result.omittedMessageCount ?? 0,
            },
          }),
        );
        addTraceEvent("response.ready", {
          status_code: 200,
          state: "held",
          held_message_count: response.heldMessages?.length ?? 0,
          new_message_count: response.newMessageCount ?? 0,
        });
        sendAgentApiResponse(routeKey, res, response);
        return;
      }
    }

    const sendAttention = await buildDriveByJoinedToPostAttention(actingAgentId, resolved, target);
    const enriched = await tracePhase(
      // slack-bridge-ordinary-message-producer: agent_api.send
      () => messageService.broadcastAndDeliver(io, agentOrchestrator, {
        channelId: resolved.channelId,
        senderType: "agent",
        senderId: actingAgentId,
        senderName: agent.displayName || agent.name || "Agent",
        content,
        mentions,
        mentionContract: routeKey === "messageSendV2" ? "v2" : "v1",
        attachmentIds: Array.isArray(attachmentIds) ? attachmentIds : [],
        ...(typeof idempotencyKey === "string" && idempotencyKey.length > 0
          ? { agentSendKey: idempotencyKey }
          : {}),
      }),
      (_durationMs, result) => ({
        name: "agent_api_send.commit.finished",
        attrs: {
          target_type: resolved.type,
          attachment_count: attachmentCount,
          idempotency_key_present: typeof idempotencyKey === "string" && idempotencyKey.length > 0,
          message_seq_present: Number.isFinite(Number(result.seq)),
        },
      }),
    );

    if (shouldRunSendFreshness && isSendDraft && attestedSendActivityContext) {
      const result = isContinueAnyway ? "committed_anyway" : "committed";
      await tracePhase(
        async () => {
          await attestedSendService.recordContinueEvent({
            agentId: actingAgentId,
            serverId: agent.serverId,
            targetType: attestedSendActivityContext.targetType,
            targetRef: attestedSendActivityContext.targetRef,
            messageId: enriched.id,
            result,
            newMessageCount: attestedSendActivityContext.newMessageCount,
          });
          const reviewerIsolationContinuation = withholdFreshnessContext;
          const title = reviewerIsolationContinuation
            ? "Reviewer-isolation draft sent"
            : isContinueAnyway
              ? "Send draft sent anyway"
              : "Send draft sent";
          await recordAgentRaftAction(req, actingAgentId, {
            title,
            text: reviewerIsolationContinuation
              ? `${formatAttestedMessageCount(attestedSendActivityContext.newMessageCount)} withheld`
              : [
                  `target: ${target}`,
                  `freshness updates: ${formatAttestedMessageCount(attestedSendActivityContext.newMessageCount)}`,
                  isContinueAnyway
                    ? "decision: sent anyway after reviewing freshness context"
                    : "decision: saved draft freshness check passed when sent",
                ].join("\n"),
          });
        },
        () => ({
          name: "agent_api_send.continue_event.recorded",
          attrs: {
            result,
            new_message_count: attestedSendActivityContext?.newMessageCount ?? 0,
          },
        }),
      );
    }

    addTraceEvent("response.ready", {
      status_code: 200,
      state: "sent",
      target_type: resolved.type,
      message_seq_present: Number.isFinite(Number(enriched.seq)),
    });
    const pendingMentionActions = messageService.getSenderPendingMentionActions(enriched);
    const unresolvedMentionHandles = messageService.getSenderUnresolvedMentionHandles(enriched);
    sendAgentApiResponse(routeKey, res, {
      ok: true,
      state: "sent",
      messageId: enriched.id,
      messageSeq: enriched.seq,
      ...(sendAttention ? { attention: sendAttention } : {}),
      ...(pendingMentionActions.length > 0 ? { pendingMentionActions } : {}),
      ...(unresolvedMentionHandles.length > 0 ? { unresolvedMentionHandles } : {}),
    });
  } catch (err) {
    if (routeKey === "messageSendV2" && err instanceof messageService.MentionValidationError && err.code) {
      traceSendRouteFailure("mention_validation", 400);
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof AttachmentLinkError) {
      traceSendRouteFailure("bad_request", err.status);
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    // #79: classify the failure into a closed-set error_subkind (+ bounded
    // sanitized message) so the otherwise-opaque 500 is splittable in traces
    // (input-validation vs genuine server-internal). Classification is
    // structural only — never sniffs err.message. HTTP status unchanged (the
    // mention_validation 500→4xx fix is a separate PR).
    traceSendRouteCatch(err, 500);
    console.error("internal.agent-api.send error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to send message" });
  }
}

registerAgentApiRoute("messageSend", (req, res) => handleAgentApiMessageSend(req, res, "messageSend"));
registerAgentApiRoute("messageSendV2", (req, res) => handleAgentApiMessageSend(req, res, "messageSendV2"));

function parseAgentApiAttachmentUpload(req: Request, res: Response, next: NextFunction): void {
  runSingleAttachmentUpload(req, res, next);
}

function attachmentUploadSessionService(req: Request): AttachmentUploadSessionService | null {
  return (req.app.get("attachmentUploadSessionService") as AttachmentUploadSessionService | undefined) ?? null;
}

function limitAttachmentUploadSessionCreate(req: Request, res: Response, next: NextFunction): void {
  const limiter = req.app.get("attachmentUploadSessionCreateLimiter") as RequestHandler | undefined;
  if (!limiter) {
    res.status(500).json({ error: "Attachment upload limiter is unavailable" });
    return;
  }
  limiter(req, res, next);
}

const uploadForbiddenBody = {
  code: "UPLOAD_FORBIDDEN",
  message: "The agent cannot upload to this channel.",
  retryable: false,
} as const;

async function agentCanCreateUploadSession(
  req: Request,
  body: AgentApiRequestBodyByRoute["attachmentUploadSessionCreate"],
): Promise<boolean> {
  const agentId = req.actingAgentId!;
  const serverId = req.serverId!;
  if (!await channelService.canAgentPostToChannel(body.channelId, agentId)) return false;
  if (
    await channelService.isChannelArchived(body.channelId)
    || await isChannelReadOnlyByBillingFeature(body.channelId, serverId)
    || await isChannelReadOnlyByQuota(body.channelId, serverId)
  ) return false;
  const quota = await getFileUploadQuotaSummary(serverId);
  return body.sizeBytes <= getAttachmentFileSizeLimitBytes(quota.plan)
    && (!quota.enforced || body.sizeBytes <= quota.remainingBytes);
}

registerAgentApiRoute(
  "attachmentUploadCapabilities",
  validateAgentApiResponseMiddleware("attachmentUploadCapabilities"),
  async (req, res) => {
    const service = attachmentUploadSessionService(req);
    if (service) {
      const result = await service.capabilities({ serverId: req.serverId!, agentId: req.actingAgentId! });
      res.status(result.status).json(result.body);
      return;
    }
    const quota = await getFileUploadQuotaSummary(req.serverId!);
    res.json({
      directUploadEnabled: false,
      directUploadThresholdBytes: null,
      maxBytes: getAttachmentFileSizeLimitBytes(quota.plan),
      sessionExpiresInSeconds: null,
    });
  },
);

registerAgentApiRoute(
  "attachmentUploadSessionCreate",
  limitAttachmentUploadSessionCreate,
  ...agentApiRequestValidators("attachmentUploadSessionCreate"),
  validateAgentApiResponseMiddleware("attachmentUploadSessionCreate"),
  async (req, res) => {
    const service = attachmentUploadSessionService(req);
    if (!service) {
      res.status(404).json({ code: "UPLOAD_SESSION_NOT_FOUND", message: "Direct uploads are disabled.", retryable: false });
      return;
    }
    const body = req.body as AgentApiRequestBodyByRoute["attachmentUploadSessionCreate"];
    if (!await agentCanCreateUploadSession(req, body)) {
      res.status(403).json(uploadForbiddenBody);
      return;
    }
    const result = await service.create({ serverId: req.serverId!, agentId: req.actingAgentId! }, body);
    res.status(result.status).json(result.body);
  },
);

registerAgentApiRoute(
  "attachmentUploadSessionComplete",
  ...agentApiRequestValidators("attachmentUploadSessionComplete"),
  validateAgentApiResponseMiddleware("attachmentUploadSessionComplete"),
  async (req, res) => {
    const service = attachmentUploadSessionService(req);
    if (!service) {
      res.status(404).json({ code: "UPLOAD_SESSION_NOT_FOUND", message: "Direct uploads are disabled.", retryable: false });
      return;
    }
    const result = await service.complete(
      { serverId: req.serverId!, agentId: req.actingAgentId! },
      req.params.uploadId as string,
    );
    res.status(result.status).json(result.body);
  },
);

registerAgentApiRoute(
  "attachmentUploadSessionCancel",
  ...agentApiRequestValidators("attachmentUploadSessionCancel"),
  validateAgentApiResponseMiddleware("attachmentUploadSessionCancel"),
  async (req, res) => {
    const service = attachmentUploadSessionService(req);
    if (!service) {
      res.status(404).json({ code: "UPLOAD_SESSION_NOT_FOUND", message: "Direct uploads are disabled.", retryable: false });
      return;
    }
    const result = await service.cancel(
      { serverId: req.serverId!, agentId: req.actingAgentId! },
      req.params.uploadId as string,
    );
    res.status(result.status).json(result.body);
  },
);

registerAgentApiRoute(
  "attachmentUploadSessionStatus",
  ...agentApiRequestValidators("attachmentUploadSessionStatus"),
  validateAgentApiResponseMiddleware("attachmentUploadSessionStatus"),
  async (req, res) => {
    const service = attachmentUploadSessionService(req);
    if (!service) {
      res.status(404).json({ code: "UPLOAD_SESSION_NOT_FOUND", message: "Direct uploads are disabled.", retryable: false });
      return;
    }
    const result = await service.status(
      { serverId: req.serverId!, agentId: req.actingAgentId! },
      req.params.uploadId as string,
    );
    res.status(result.status).json(result.body);
  },
);

registerAgentApiRoute("attachmentUpload", parseAgentApiAttachmentUpload, async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }
    if (isEmptyUploadedFile(file)) {
      res.status(400).json({ error: "Empty files are not allowed" });
      return;
    }
    const maxBytes = await resolveRequestAttachmentFileSizeLimitBytes(req);
    if (isOversizedUploadedFile(file, maxBytes)) {
      res.status(413).json(buildAttachmentTooLargeResponse(maxBytes));
      return;
    }

    const channelId = typeof req.body.channelId === "string" ? req.body.channelId : undefined;
    if (!channelId) {
      res.status(400).json({ error: "channelId is required" });
      return;
    }

    const canPost = await channelService.canAgentPostToChannel(channelId, agentId);
    if (!canPost) {
      res.status(403).json({ error: "Agent must join this channel before sending or uploading" });
      return;
    }

    if (await channelService.isChannelArchived(channelId)) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    if (await isChannelReadOnlyByBillingFeature(channelId, serverId)) {
      res.status(403).json({ error: "Joint Channels require the Pro plan. Upgrade to continue." });
      return;
    }

    const storage = getStorage();
    if (!storage) {
      res.status(503).json({ error: "File uploads are not configured on this server" });
      return;
    }

    const normalizedFilename = normalizeAttachmentFilename(file.originalname);
    const explicitMimeType = typeof req.body.mimeType === "string" ? req.body.mimeType : undefined;
    const normalizedMimeType = normalizeUploadedMimeType(
      normalizedFilename,
      file.mimetype,
      file.buffer,
      explicitMimeType,
    );
    const cdnStorage = getCdnStorage();

    const [inserted] = await uploadAttachmentBuffers({
      serverId,
      channelId,
      uploaderId: agentId,
      uploaderType: "agent",
      files: [{ buffer: file.buffer, filename: normalizedFilename, mimeType: normalizedMimeType }],
      storage,
      cdnStorage,
      preview: {
        canGenerate: canGenerateImagePreview,
        generateThumbnail,
        isSvg: isSvgAttachmentMimeType,
        generateSvgRasterPreview,
      },
    });

    sendAgentApiResponse("attachmentUpload", res, {
      id: inserted.id,
      filename: normalizeAttachmentFilename(inserted.filename),
      mimeType: resolveAttachmentMimeType(inserted.filename, inserted.mimeType),
      sizeBytes: inserted.sizeBytes,
      thumbnailUrl: getThumbnailUrl(inserted.thumbnailKey),
    });
    recordRaftCliActivity(req, agentId, {
      command: "attachment.upload",
      summary: "Uploaded attachment",
      target: `${channelId} · ${normalizeAttachmentFilename(inserted.filename)}`,
      correlationId: inserted.id,
    });
  } catch (err) {
    console.error("internal.agent-api.upload error:", serializeErrorForLog(err));
    if (isStorageTimeoutError(err)) {
      res.status(504).json({ error: "Attachment storage timed out" });
      return;
    }
    if (err instanceof FileUploadQuotaExceededError) {
      res.status(err.status).json(await buildFileUploadQuotaExceededResponse(req.serverId!, err));
      return;
    }
    res.status(500).json({ error: "Failed to upload file" });
  }
});
registerAgentApiRoute("resolveChannel", ...agentApiRequestValidators("resolveChannel"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const { target } = req.body as AgentApiRequestBodyByRoute["resolveChannel"];

    const resolved = await resolveWritableAgentTarget(serverId, agentId, target);
    if (resolved === "forbidden") {
      res.status(403).json({ error: forbiddenMessageForTarget(target) });
      return;
    }
    if (resolved === "peer-not-found") {
      res.status(404).json({ error: `User or agent not found: @${target.slice(4)}` });
      return;
    }
    if (resolved === "self-dm") {
      res.status(400).json({ error: "Cannot create a DM with yourself" });
      return;
    }
    if (!resolved) {
      res.status(404).json({ error: notFoundMessageForTarget(target) });
      return;
    }

    sendAgentApiResponse("resolveChannel", res, { channelId: resolved.channelId });
  } catch (err) {
    console.error("internal.agent-api.resolve-channel error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to resolve channel" });
  }
});
registerAgentApiRoute("messageSearch", async (req, res) => {
  const requestAbort = bindRequestAbortSignal(req, res);
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const queryInput = validateAgentApiQuery("messageSearch", req, res);
    if (!queryInput) return;
    const query = (queryInput.q ?? "").trim();

    const channelRef = queryInput.channel;
    let channelId: string | undefined;
    if (channelRef) {
      const resolved = await channelService.resolveChannelByName(serverId, agentId, channelRef);
      if (!resolved) {
        res.status(404).json({ error: `Channel not found: ${channelRef}` });
        return;
      }
      channelId = resolved.channelId;
    }

    const limit = Math.min(Number(queryInput.limit) || 20, 50);
    const offset = Math.max(Number(queryInput.offset) || 0, 0);
    const senderFilter = await resolveSearchSenderFilter(
      serverId,
      { type: "agent", id: agentId },
      queryInput.sender,
      queryInput.senderId,
    );
    if (!senderFilter.ok) {
      res.status(senderFilter.status).json({ error: senderFilter.error, errorCode: senderFilter.errorCode });
      return;
    }
    const after = queryInput.after ? new Date(queryInput.after) : undefined;
    const before = queryInput.before ? new Date(queryInput.before) : undefined;
    if ((after && Number.isNaN(after.getTime())) || (before && Number.isNaN(before.getTime()))) {
      res.status(400).json({ error: "Invalid date filter" });
      return;
    }
    const sort = queryInput.sort === "recent" ? "recent" : "relevance";
    const hasMeaningfulFilter = Boolean(channelId || senderFilter.senderId || after || before);
    if (!query && !hasMeaningfulFilter) {
      sendAgentApiResponse("messageSearch", res, { results: [], hasMore: false });
      return;
    }

    const searchResponse = await searchService.searchMessagesForAgent({
      serverId,
      agentId,
      query,
      channelId,
      senderId: senderFilter.senderId,
      after,
      before,
      sort: query ? sort : "recent",
      limit,
      offset,
      signal: requestAbort.signal,
    });
    const [renderedContents, renderedSnippets, taskFacts] = await Promise.all([
      agentPermalinkRenderService.renderAgentReadablePermalinksInTexts(
        searchResponse.results.map((result) => result.content),
        serverId,
      ),
      agentPermalinkRenderService.renderAgentReadablePermalinksInTexts(
        searchResponse.results.map((result) => result.snippet),
        serverId,
      ),
      loadCanonicalTaskFactsByMessageId(searchResponse.results.map((result) => result.id)),
    ]);

    sendAgentApiResponse("messageSearch", res, {
      ...searchResponse,
      results: searchResponse.results.map((result, index) => {
        const { externalMessage, ...visibleResult } = result;
        const external = result.senderType === "external_projection";
        const taskFact = external ? undefined : taskFacts.get(result.id);
        const taskProjectionFields = taskFact ? {
          taskStatus: taskFact.taskStatus,
          taskNumber: taskFact.taskNumber,
          taskCurrentProjection: {
            ...taskFact.taskCurrentProjection,
            amendedAt: taskFact.taskCurrentProjection.amendedAt?.toISOString() ?? null,
          },
        } : {};
        return {
          ...visibleResult,
          senderType: toAgentFacingActorType(result.senderType),
          ...(externalMessage ? { external_message: externalMessage } : {}),
          content: external
            ? renderThirdPartyInertText({ field: "tool_result", value: result.content })
            : renderedContents[index] ?? result.content,
          snippet: external
            ? renderThirdPartyInertText({ field: "tool_result", value: result.snippet })
            : renderedSnippets[index] ?? result.snippet,
          ...taskProjectionFields,
        };
      }),
    });
  } catch (err) {
    if (searchService.isMessageSearchPublicError(err)) {
      res.status(err.status).json({ error: err.message, errorCode: err.code });
      return;
    }
    if (requestAbort.signal.aborted || searchService.isSearchQueryAbortedError(err)) {
      return;
    }
    console.error("internal.agent-api.search error:", serializeErrorForLog(err));
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to search messages" });
    }
  } finally {
    requestAbort.cleanup();
  }
});
registerAgentApiRoute("messageResolve", ...agentApiRequestValidators("messageResolve"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    const { msgId: rawMessageId } = req.params as AgentApiRequestParamsByRoute["messageResolve"];
    if (!agentId || !serverId) {
      res.status(401).json({ error: "Agent credential required", code: "invalid_principal" });
      return;
    }

    const resolved = await messageService.resolveMessageIdVisibleToAgent(serverId, agentId, rawMessageId);
    if (!resolved.ok) {
      res.status(resolved.status).json(messageResolveErrorPayload(resolved));
      return;
    }

    const payload = await resolveAgentVisibleMessagePayload(resolved.messageId, serverId, agentId);
    if (!payload) {
      res.status(404).json({ error: "Message not found", errorCode: "NOT_FOUND" });
      return;
    }

    sendAgentApiResponse("messageResolve", res, {
      message: {
        ...payload,
        parent_channel_type: payload.parent_channel_type ?? undefined,
        parent_channel_name: payload.parent_channel_name ?? undefined,
      },
    });
  } catch (err) {
    console.error("internal.agent-api.message-resolve error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to resolve message" });
  }
});
registerAgentApiRoute("channelMembers", async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const channelMembersQuery = validateAgentApiQuery("channelMembers", req, res);
    if (!channelMembersQuery) return;
    const { channel: channelRef } = channelMembersQuery;
    const resolved = await channelService.resolveChannelByName(serverId, agentId, channelRef);
    if (!resolved) {
      res.status(404).json({ error: `Channel not found: ${channelRef}` });
      return;
    }

    const members = await channelService.getChannelMembers(resolved.channelId);
    const visibleAgents = await Promise.all(members.agents.map(async (agent) => ({
      name: agent.name,
      status: agent.status,
      role: await getActorServerRoleInServer(serverId, "agent", agent.id),
    })));
    const visibleHumans = await filterAgentVisibleHumansForHiddenDirectory(
      serverId,
      agentId,
      members.humans,
    );
    sendAgentApiResponse("channelMembers", res, {
      channel: { ref: channelRef, type: resolved.type },
      agents: visibleAgents,
      humans: visibleHumans.map((human) => ({ name: human.name, description: human.description, role: human.role })),
    });
  } catch (err) {
    console.error("internal.agent-api.channel-members error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to get channel members" });
  }
});
registerAgentApiRoute("threadUnfollow", ...agentApiRequestValidators("threadUnfollow"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const { thread: threadRef } = req.body as AgentApiRequestBodyByRoute["threadUnfollow"];
    const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
      ? req.body.reason.trim()
      : "no longer following";

    let threadChannelId: string | null = null;
    if (UUID_RE.test(threadRef)) {
      const channel = await channelService.getChannel(threadRef);
      if (!channel || channel.serverId !== serverId) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }
      const canAccess = await channelService.canAgentAccessChannel(channel.id, agentId);
      if (!canAccess) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }
      if (channel.type !== "thread") {
        res.status(400).json({ error: "Target must be a thread" });
        return;
      }
      threadChannelId = channel.id;
    } else {
      const resolved = await channelService.resolveChannelByName(serverId, agentId, threadRef);
      if (!resolved) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }
      if (resolved.type !== "thread") {
        res.status(400).json({ error: "Target must be a thread" });
        return;
      }
      threadChannelId = resolved.channelId;
    }

    await channelService.unfollowThreadForFollower("agent", agentId, threadChannelId);
    const agent = await agentService.getAgent(agentId);
    const io = req.app.get("io") as SocketServer | undefined;
    await emitThreadFollowersUpdated(io, threadChannelId);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (agent && io && agentOrchestrator) {
      await messageService.broadcastSystemMessage(
        io,
        agentOrchestrator,
        threadChannelId,
        `@${agent.name} stopped following this thread: ${messageService.summarizeForSystemMessage(reason)}`,
        {
          // Self-unfollow has a zero-person audience (the only actor who cares is
          // the agent that just left the thread). Record no inbox fact at all.
          // Tenny ruling (#8): skip-mode, not born-read.
          inboxFactPolicy: {
            mode: "skip",
            producer: "channel.self_unfollow_thread",
            reason: "self-unfollow has zero audience — no inbox fact",
          },
        },
      );
    }
    await recordAgentRaftAction(req, agentId, {
      title: "Unfollowed thread",
      text: [
        `target: ${threadRef}`,
        `threadChannelId: ${threadChannelId}`,
        `reason: ${reason}`,
      ].join("\n"),
    });
    sendAgentApiResponse("threadUnfollow", res, { ok: true });
  } catch (err: any) {
    sendJsonServerError(req, res, {
      error: "Failed to unfollow thread",
      code: "agent_api_thread_unfollow_failed",
      logPrefix: "[AgentAPI] Failed to unfollow thread",
      err,
    });
  }
});
registerAgentApiRoute("profileShow", async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const query = validateAgentApiQuery("profileShow", req, res);
    if (!query) return;
    // Reading YOUR OWN profile is identity introspection for ordinary
    // read-capable runners. Looking up OTHERS stays server-grade while
    // preserving the contract's single id-less GET /profile route.
    if (query.target) {
      const failure = getAgentCapabilityFailure(req, "server");
      if (failure) {
        res.status(failure.status).json(failure.body);
        return;
      }
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const resolved = await resolveProfileViewForAgent(serverId, agentId, query.target, agentOrchestrator);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    sendAgentApiResponse("profileShow", res, resolved.profile);
  } catch (err) {
    console.error("internal.agent-api.profile-show error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to load profile" });
  }
});
registerAgentApiRoute("profileUpdate", ...agentApiRequestValidators("profileUpdate"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const body = req.body as AgentApiRequestBodyByRoute["profileUpdate"];
    const hasAvatarUrl = Object.prototype.hasOwnProperty.call(body, "avatarUrl");
    const hasDisplayName = Object.prototype.hasOwnProperty.call(body, "displayName");
    const hasDescription = Object.prototype.hasOwnProperty.call(body, "description");
    if (!hasAvatarUrl && !hasDisplayName && !hasDescription) {
      res.status(400).json({
        error: "Provide at least one of avatarUrl, displayName, or description",
        errorCode: "PROFILE_UPDATE_NO_FIELDS",
      });
      return;
    }

    const fields: { avatarUrl?: string; displayName?: string; description?: string } = {};
    if (hasAvatarUrl) {
      const value = body.avatarUrl;
      if (typeof value !== "string") {
        res.status(400).json({ error: "avatarUrl must be a string" });
        return;
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        res.status(400).json({ error: "avatarUrl must not be empty" });
        return;
      }
      if (!trimmed.startsWith("pixel:")) {
        res.status(400).json({
          error: "avatarUrl must be a pixel: URL",
          errorCode: "PROFILE_AVATAR_URL_BAD_FORMAT",
        });
        return;
      }
      fields.avatarUrl = trimmed;
    }
    if (hasDisplayName) {
      const value = body.displayName;
      if (typeof value !== "string") {
        res.status(400).json({ error: "displayName must be a string" });
        return;
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        res.status(400).json({ error: "displayName must not be empty" });
        return;
      }
      if (trimmed.length > MAX_AGENT_PROFILE_DISPLAY_NAME_LENGTH) {
        res.status(400).json({
          error: `displayName must be at most ${MAX_AGENT_PROFILE_DISPLAY_NAME_LENGTH} characters`,
        });
        return;
      }
      fields.displayName = trimmed;
    }
    if (hasDescription) {
      const value = body.description;
      if (typeof value !== "string") {
        res.status(400).json({ error: "description must be a string" });
        return;
      }
      if (value.length === 0) {
        res.status(400).json({ error: "description must not be empty" });
        return;
      }
      if (value.length > MAX_AGENT_PROFILE_DESCRIPTION_LENGTH) {
        res.status(400).json({
          error: `description must be at most ${MAX_AGENT_PROFILE_DESCRIPTION_LENGTH} characters`,
        });
        return;
      }
      fields.description = value;
    }

    const updated = await agentService.updateAgent(agentId, fields);
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    agentOrchestrator?.evictCache(agentId);
    const profile = await buildAgentProfileView(agentId, agentId, agentOrchestrator);
    if (!profile) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    sendAgentApiResponse("profileUpdate", res, profile);
    recordRaftCliActivity(req, agentId, {
      command: "profile.update",
      summary: "Updated profile",
      target: `@${profile.name}`,
    });
  } catch (err) {
    console.error("internal.agent-api.profile-update error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to update profile" });
  }
});
registerAgentApiRoute("profileAvatarUpdate", async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(agentId);
    if (!agent || agent.serverId !== serverId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const uploaded = await runSingleAvatarUpload(profileAvatarUpload, req);
    if (!uploaded) {
      res.status(400).json({ error: "No avatar file provided" });
      return;
    }

    const avatarUrl = await storeAgentAvatar(serverId, agent.avatarUrl, uploaded.buffer);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    agentOrchestrator?.evictCache(agentId);
    await agentService.updateAgent(agentId, { avatarUrl });

    const profile = await buildAgentProfileView(agentId, agentId, agentOrchestrator);
    if (!profile) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    sendAgentApiResponse("profileAvatarUpdate", res, profile);
    recordRaftCliActivity(req, agentId, {
      command: "profile.avatar.update",
      summary: "Updated profile avatar",
      target: `@${profile.name}`,
    });
  } catch (err) {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({
        error: PROFILE_AVATAR_TOO_LARGE_MESSAGE,
        errorCode: "PROFILE_AVATAR_TOO_LARGE",
        maxBytes: MAX_PROFILE_AVATAR_BYTES,
      });
      return;
    }
    if (err instanceof Error && err.message.includes(PROFILE_AVATAR_BAD_FORMAT_MESSAGE)) {
      res.status(400).json({
        error: PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
        errorCode: "PROFILE_AVATAR_BAD_FORMAT",
      });
      return;
    }
    console.error("internal.agent-api.profile-avatar-update error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to update avatar" });
  }
});
registerAgentApiRoute("integrationList", async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const [clients, overview] = await Promise.all([
      oauthService.listAgentAvailableOAuthClients(serverId),
      oauthService.getAgentIntegrationsOverview(agentId),
    ]);
    const activeLogins = overview
      .filter((item) => item.type === "active" && !item.revokedAt)
      .map((item) => {
        const agentManifest = oauthService.resolveAgentManifest({
          agentManifestUrl: item.clientAgentManifestUrl,
          homepageUrl: item.clientHomepageUrl,
          returnUrl: item.clientReturnUrl,
        });
        return {
          id: item.id,
          serviceId: item.clientId,
          clientId: item.clientKey,
          name: item.clientName,
          description: item.clientDescription ?? null,
          homepageUrl: item.clientHomepageUrl ?? null,
          returnUrl: item.clientReturnUrl ?? null,
          agentManifestUrl: agentManifest.url,
          agentManifestUrlSource: agentManifest.source ?? null,
          scopes: item.scopes,
          createdAt: item.createdAt,
        };
      });

    sendAgentApiResponse("integrationList", res, {
      services: clients.map(serializeOAuthClientForAgentApi),
      activeLogins,
    });
  } catch (err) {
    console.error("internal.agent-api.integrations-list error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to list agent integrations" });
  }
});
registerAgentApiRoute(
  "integrationMarketplaceSearch",
  ...agentApiRequestValidators("integrationMarketplaceSearch"),
  async (req, res) => {
    try {
      const agentId = req.actingAgentId!;
      const serverId = req.serverId!;
      const query = req.query as AgentApiRequestQueryByRoute["integrationMarketplaceSearch"];
      const limit = query.limit ? Number(query.limit) : 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        res.status(400).json({ error: "limit must be an integer from 1 to 50" });
        return;
      }
      const normalizedQuery = query.query?.trim() || null;
      const apps = await oauthService.searchPublicMarketplaceOAuthClients({
        serverId,
        query: normalizedQuery,
        limit,
      });
      sendAgentApiResponse("integrationMarketplaceSearch", res, {
        surface: "public_marketplace",
        metadataTrust: "untrusted_app_supplied",
        query: normalizedQuery,
        limit,
        apps: apps.map(serializeMarketplaceOAuthClientForAgentApi),
      });
      recordRaftCliActivity(req, agentId, {
        command: "integration.marketplace",
        summary: normalizedQuery ? "Searched public Marketplace apps" : "Listed public Marketplace apps",
        target: `${apps.length} result${apps.length === 1 ? "" : "s"}`,
      });
    } catch (err) {
      console.error("internal.agent-api.integrations-marketplace error:", serializeErrorForLog(err));
      res.status(500).json({ error: "Failed to search public Marketplace apps" });
    }
  },
);
registerAgentApiRoute("integrationLogin", ...agentApiRequestValidators("integrationLogin"), async (req, res) => {
  let phase = "agent_lookup";
  let appType: oauthService.OAuthClientAppType | "unresolved" = "unresolved";
  let scopeCount = 0;
  const defaultScopesUsed = (
    req.body as AgentApiRequestBodyByRoute["integrationLogin"] | undefined
  )?.scopes == null;
  const closeTrace = (input: {
    outcome: "success" | "rejected" | "error";
    reason: string;
    httpStatus: number;
    grantStatus?: "created" | "reused" | "pending";
  }) => {
    addTraceEvent("agent_integration_login.request.closed", {
      event_kind: "agent_integration_login",
      outcome: input.outcome,
      reason: input.reason,
      phase,
      http_status: input.httpStatus,
      app_type: appType,
      requested_scope_count: scopeCount,
      default_scopes_used: defaultScopesUsed,
      ...(input.grantStatus ? { grant_status: input.grantStatus } : {}),
    });
  };
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const body = req.body as AgentApiRequestBodyByRoute["integrationLogin"];
    const agent = await agentService.getAgent(agentId);
    if (!agent || agent.serverId !== serverId) {
      closeTrace({ outcome: "rejected", reason: "agent_not_found", httpStatus: 404 });
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    phase = "server_lookup";
    const server = await serverService.getServer(serverId);
    if (!server) {
      closeTrace({ outcome: "rejected", reason: "server_not_found", httpStatus: 404 });
      res.status(404).json({ error: "Server not found" });
      return;
    }

    phase = "service_list";
    const clients = await oauthService.listAgentAvailableOAuthClients(serverId);
    phase = "service_resolve";
    const resolved = resolveAgentLoginClient(clients, body.service);
    if (!resolved.ok) {
      if (resolved.status !== 404) {
        closeTrace({ outcome: "rejected", reason: "service_resolution_failed", httpStatus: resolved.status });
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }

      phase = "marketplace_resolve";
      const publicClients = await oauthService.listPublicMarketplaceOAuthClients();
      const marketplaceResolved = resolveAgentLoginClient(publicClients, body.service);
      if (!marketplaceResolved.ok) {
        closeTrace({ outcome: "rejected", reason: "service_resolution_failed", httpStatus: marketplaceResolved.status });
        res.status(marketplaceResolved.status).json({ error: marketplaceResolved.error });
        return;
      }
      appType = marketplaceResolved.client.appType;
      phase = "scope_normalize";
      const scopes = oauthService.normalizeAgentRequestedScopes(
        normalizeAgentLoginScopes(body.scopes, marketplaceResolved.client),
        marketplaceResolved.client,
      );
      scopeCount = scopes.length;
      const response: AgentApiResponseByRoute["integrationLogin"] = {
        status: "install_required",
        nextAction: "install_from_marketplace",
        service: serializeOAuthClientForAgentApi(marketplaceResolved.client),
        scopes,
        installation: {
          serverSlug: server.slug,
          serverName: server.name,
          marketplaceUrl: `${getAppUrl()}/s/${encodeURIComponent(server.slug)}/settings/applications?marketplace_app=${encodeURIComponent(marketplaceResolved.client.id)}`,
          target: null,
          actionCardMessageId: null,
        },
      };
      const target = typeof body.target === "string" ? body.target.trim() : "";
      if (target) {
        phase = "install_target";
        const resolvedTarget = await channelService.resolveChannelByName(serverId, agentId, target);
        if (!resolvedTarget) {
          closeTrace({ outcome: "rejected", reason: "install_target_not_found", httpStatus: 404 });
          res.status(404).json({ error: "Install target not found or not visible to this agent" });
          return;
        }
        phase = "install_card";
        const agentName = agent.displayName ?? agent.name;
        const clientNameBinding = actionCardsService.bindMarketplaceAppName(marketplaceResolved.client.name);
        const card = await actionCardsService.prepareActionCard({
          serverId,
          requesterAgentId: agentId,
          targetChannelId: resolvedTarget.channelId,
          action: {
            type: "integration:install_marketplace_app",
            clientId: marketplaceResolved.client.id,
            clientKey: marketplaceResolved.client.clientId,
            ...clientNameBinding,
            agentId,
            agentName,
            scopes,
            draftHint: `${agentName} requested ${clientNameBinding.clientName}, which is public in the Raft Marketplace but is not installed on this Server. Installing is a Server owner/admin action; the Agent cannot install it automatically.`,
          },
          io: (req.app.get("io") ?? null) as SocketServer | null,
        });
        response.installation = {
          ...response.installation!,
          target,
          actionCardMessageId: card.messageId,
        };
      }
      phase = "response";
      sendAgentApiResponse("integrationLogin", res, response);
      closeTrace({ outcome: "success", reason: "install_required", httpStatus: 200 });
      return;
    }
    appType = resolved.client.appType;

    phase = "scope_normalize";
    const scopes = normalizeAgentLoginScopes(body.scopes, resolved.client);
    scopeCount = scopes.length;
    phase = "access_request";
    const requested = await oauthService.requestAgentAccess({
      clientId: resolved.client.id,
      serverSlug: server.slug,
      agentName: agent.name,
      scopes,
    });

    if (requested.grantStatus === "pending") {
      const response: AgentApiResponseByRoute["integrationLogin"] = {
        status: "approval_required",
        service: serializeOAuthClientForAgentApi(resolved.client),
        scopes: requested.request.scopes ?? [],
        requestId: requested.request.id,
        approval: {
          requestId: requested.request.id,
          target: null,
          actionCardMessageId: null,
        },
      };

      const target = typeof body.target === "string" ? body.target.trim() : "";
      if (target) {
        phase = "approval_target";
        const resolvedTarget = await channelService.resolveChannelByName(serverId, agentId, target);
        if (!resolvedTarget) {
          closeTrace({
            outcome: "rejected",
            reason: "approval_target_not_found",
            httpStatus: 404,
            grantStatus: "pending",
          });
          res.status(404).json({ error: "Approval target not found or not visible to this agent" });
          return;
        }
        phase = "approval_card";
        const card = await actionCardsService.prepareActionCard({
          serverId,
          requesterAgentId: agentId,
          targetChannelId: resolvedTarget.channelId,
          action: {
            type: "integration:approve_agent_login",
            requestId: requested.request.id,
            agentId,
            agentName: agent.displayName ?? agent.name,
            clientId: resolved.client.id,
            clientKey: resolved.client.clientId,
            clientName: resolved.client.name,
            scopes: requested.request.scopes ?? [],
            draftHint:
              `${agent.displayName ?? agent.name} is requesting human approval to use ${resolved.client.name}. Server-installed apps do not need this approval; Marketplace apps do.`,
          },
          io: (req.app.get("io") ?? null) as SocketServer | null,
        });
        response.approval = {
          requestId: requested.request.id,
          target,
          actionCardMessageId: card.messageId,
        };
      }

      phase = "response";
      sendAgentApiResponse("integrationLogin", res, response);
      closeTrace({
        outcome: "success",
        reason: "approval_required",
        httpStatus: 200,
        grantStatus: "pending",
      });
      return;
    }

    phase = "response";
    const responseStatus = requested.grantStatus === "reused" ? "already_logged_in" : "logged_in";
    sendAgentApiResponse("integrationLogin", res, {
      status: responseStatus,
      service: serializeOAuthClientForAgentApi(resolved.client),
      scopes: requested.request.scopes ?? [],
      requestId: requested.request.id,
    });
    closeTrace({
      outcome: "success",
      reason: responseStatus,
      httpStatus: 200,
      grantStatus: requested.grantStatus,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to provision agent login";
    if (
      message === "scopes must be an array" ||
      message === "scopes must contain strings" ||
      message === "scope values must be non-empty" ||
      message === "at least one scope is required" ||
      message === "invalid_scope"
    ) {
      const error = message === "invalid_scope"
        ? "Requested scopes are not allowed for this service; use --scope with a scope declared by the service"
        : message;
      closeTrace({ outcome: "rejected", reason: message, httpStatus: 400 });
      res.status(400).json({
        error,
        ...(message === "invalid_scope" ? { errorCode: "INVALID_SCOPE" } : {}),
      });
      return;
    }
    if (message.includes("not found")) {
      closeTrace({ outcome: "rejected", reason: "not_found", httpStatus: 404 });
      res.status(404).json({ error: message });
      return;
    }
    closeTrace({
      outcome: "error",
      reason: "unexpected_error",
      httpStatus: 500,
    });
    console.error("internal.agent-api.integrations-login error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to provision agent login" });
  }
});
registerAgentApiRoute("integrationAppPrepare", ...agentApiRequestValidators("integrationAppPrepare"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const body = req.body as AgentApiRequestBodyByRoute["integrationAppPrepare"];
    if (body.mode === "update") {
      res.status(410).json({
        error: "App registration update cards are disabled; the app owner must use the direct integration app update command",
        errorCode: "LEGACY_APP_UPDATE_DISABLED",
      });
      return;
    }
    const target = optionalIntegrationString(body.target);
    if (!target) {
      res.status(400).json({ error: "target is required" });
      return;
    }
    const clientKey = optionalIntegrationString(body.clientKey);
    const resolvedTarget = await channelService.resolveChannelByName(serverId, agentId, target);
    if (!resolvedTarget) {
      res.status(404).json({ error: "Action-card target not found or not visible to this agent" });
      return;
    }

    const scopes = normalizeIntegrationAppPrepareScopes(body.scopes);
    if (scopes.some((scope) => !isRaftOAuthScope(scope))) {
      res.status(400).json({ error: "invalid_scope", errorCode: "INVALID_SCOPE" });
      return;
    }
    const rawCategory = optionalIntegrationString(body.category);
    const category = rawCategory ? canonicalizeOAuthClientCategory(rawCategory) : undefined;
    if (rawCategory && !category) {
      res.status(400).json({ error: "invalid category", errorCode: "INVALID_CATEGORY" });
      return;
    }
    const unsafeDemoUrlOverride = body.unsafeDemoUrlOverride === true;
    const draftHint = optionalIntegrationString(body.draftHint);
    const homepageUrl = optionalIntegrationString(body.homepageUrl);
    const returnUrl = optionalIntegrationString(body.returnUrl);
    const agentManifestUrl = optionalIntegrationString(body.agentManifestUrl);

    const name = optionalIntegrationString(body.name);
    if (!name) {
      res.status(400).json({ error: "name is required for register" });
      return;
    }
    if (!returnUrl) {
      res.status(400).json({ error: "returnUrl is required for register" });
      return;
    }
    const action: Extract<ActionCardAction, { type: "integration:register_app" }> = {
      type: "integration:register_app",
      name,
      ...(clientKey ? { clientKey } : {}),
      description: optionalIntegrationString(body.description),
      category: category ?? undefined,
      homepageUrl,
      returnUrl,
      agentManifestUrl,
      scopes,
      unsafeDemoUrlOverride,
      draftHint: draftHint ?? `Agent prepared a Login with Raft app registration for ${name}. The requester becomes the app owner after server commit and receives the initial secret through a private transient handoff; only a lost handoff should be recovered with rotate-secret --output <new-private-path>. No secret is stored in this card.`,
    };

    const card = await actionCardsService.prepareActionCard({
      serverId,
      requesterAgentId: agentId,
      targetChannelId: resolvedTarget.channelId,
      action,
      io: (req.app.get("io") ?? null) as SocketServer | null,
    });

    res.status(201);
    sendAgentApiResponse("integrationAppPrepare", res, {
      status: "prepared",
      mode: body.mode,
      target,
      actionCardMessageId: card.messageId,
      action,
    });
    recordRaftCliActivity(req, agentId, {
      command: "integration.app.prepare",
      summary: `Prepared integration app ${body.mode} card`,
      target,
      correlationId: card.messageId,
    });
  } catch (err) {
    if (err instanceof actionCardsService.ActionCardError) {
      res.status(err.status).json({ error: err.message, errorCode: err.code });
      return;
    }
    if (err instanceof Error && /scope/.test(err.message)) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("internal.agent-api.integrations-app-prepare error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to prepare integration app registration" });
  }
});
registerAgentApiRoute("integrationAppRotateSecret", ...agentApiRequestValidators("integrationAppRotateSecret"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const body = req.body as AgentApiRequestBodyByRoute["integrationAppRotateSecret"];
    const clientKey = optionalIntegrationString(body.clientKey);
    if (!clientKey) {
      res.status(400).json({ error: "clientKey is required" });
      return;
    }

    const rotated = await oauthService.rotateClientSecretForAgent({
      serverId,
      clientKey,
      actorAgentId: agentId,
    });

    if (rotated.status === "not_found") {
      // Unknown and cross-server clients remain non-enumerating.
      res.status(404).json({ error: "Integration app not found" });
      return;
    }
    if (rotated.status === "owner_required") {
      res.status(403).json({
        error: "Only this app's owner, delegated rotate maintainer, or a current server admin can rotate its secret",
        errorCode: "APP_MANAGE_AUTHORITY_REQUIRED",
      });
      return;
    }

    sendAgentApiResponse("integrationAppRotateSecret", res, {
      clientId: rotated.value.clientId,
      clientKey: rotated.value.clientKey,
      clientName: rotated.value.clientName,
      clientSecret: rotated.value.clientSecret,
    });
    // Activity log carries only the client key — never the rotated plaintext.
    recordRaftCliActivity(req, agentId, {
      command: "integration.app.rotate-secret",
      summary: `Rotated integration app secret for ${rotated.value.clientKey}`,
      correlationId: rotated.value.clientId,
    });
  } catch (err) {
    // Never surface the secret in logs: the catch path only ran if rotation
    // threw before returning, so no plaintext is in scope here regardless.
    console.error("internal.agent-api.integrations-app-rotate-secret error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to rotate integration app secret" });
  }
});
registerAgentApiRoute("integrationAppTransferOwner", ...agentApiRequestValidators("integrationAppTransferOwner"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const body = req.body as AgentApiRequestBodyByRoute["integrationAppTransferOwner"];
    const clientKey = optionalIntegrationString(body.clientKey);
    const targetAgentName = optionalIntegrationString(body.targetAgent)?.replace(/^@/, "");
    if (!clientKey || !targetAgentName) {
      res.status(400).json({ error: "clientKey and targetAgent are required" });
      return;
    }
    const targetAgentId = await channelService.resolveAgentByName(serverId, targetAgentName);
    if (!targetAgentId) {
      res.status(404).json({ error: "Target agent not found" });
      return;
    }

    const transferred = await oauthService.transferClientOwnershipForAgent({
      serverId,
      clientKey,
      actorAgentId: agentId,
      targetAgentId,
    });
    if (transferred.status === "not_found") {
      res.status(404).json({ error: "Integration app not found" });
      return;
    }
    if (transferred.status === "owner_required") {
      res.status(403).json({
        error: "Only this app's owner or a current server admin can transfer it",
        errorCode: "APP_MANAGE_AUTHORITY_REQUIRED",
      });
      return;
    }
    if (transferred.status === "target_not_found") {
      res.status(404).json({ error: "Target agent not found" });
      return;
    }

    sendAgentApiResponse("integrationAppTransferOwner", res, {
      ...transferred.value,
      ownerAgentName: targetAgentName,
    });
    recordRaftCliActivity(req, agentId, {
      command: "integration.app.transfer-owner",
      summary: transferred.value.ownershipOutcome === "transferred"
        ? `Transferred integration app ${transferred.value.clientKey} to @${targetAgentName}`
        : `Confirmed integration app ${transferred.value.clientKey} is already owned by @${targetAgentName}`,
      correlationId: transferred.value.clientId,
    });
  } catch (err) {
    console.error("internal.agent-api.integrations-app-transfer-owner error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to transfer integration app ownership" });
  }
});
registerAgentApiRoute("integrationAppUpdate", ...agentApiRequestValidators("integrationAppUpdate"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const body = req.body as AgentApiRequestBodyByRoute["integrationAppUpdate"];
    const clientKey = optionalIntegrationString(body.clientKey);
    if (!clientKey) {
      res.status(400).json({ error: "clientKey is required" });
      return;
    }
    const updatedFields = ["name", "description", "category", "homepageUrl", "returnUrl", "agentManifestUrl", "scopes"]
      .filter((field) => body[field as keyof typeof body] !== undefined);
    if (updatedFields.length === 0) {
      res.status(400).json({ error: "At least one app field is required" });
      return;
    }
    if (body.returnUrl !== undefined && !body.returnUrl.trim()) {
      res.status(400).json({
        error: "returnUrl cannot be empty; OAuth apps must keep a registered callback URL",
        errorCode: "RETURN_URL_REQUIRED",
      });
      return;
    }
    const unsafeDemoUrlOverride = body.unsafeDemoUrlOverride === true;
    const updated = await oauthService.updateOAuthClientForAgent({
      serverId,
      clientKey,
      actorAgentId: agentId,
      name: body.name,
      description: body.description,
      category: body.category,
      homepageUrl: body.homepageUrl === undefined
        ? undefined
        : actionCardsService.validateIntegrationUrl(body.homepageUrl, "homepageUrl", unsafeDemoUrlOverride),
      returnUrl: body.returnUrl === undefined
        ? undefined
        : actionCardsService.validateIntegrationUrl(body.returnUrl, "returnUrl", unsafeDemoUrlOverride),
      agentManifestUrl: body.agentManifestUrl === undefined
        ? undefined
        : actionCardsService.validateIntegrationUrl(body.agentManifestUrl, "agentManifestUrl", unsafeDemoUrlOverride),
      allowedScopes: body.scopes === undefined
        ? undefined
        : (() => {
          const scopes = normalizeIntegrationAppPrepareScopes(body.scopes);
          return scopes.length > 0 ? scopes : null;
        })(),
    });
    if (updated.status === "not_found") {
      res.status(404).json({ error: "Integration app not found" });
      return;
    }
    if (updated.status === "owner_required") {
      res.status(403).json({
        error: "Only this app's owner or a current server admin can update it",
        errorCode: "APP_MANAGE_AUTHORITY_REQUIRED",
      });
      return;
    }
    if (updated.status === "invalid_return_url") {
      res.status(400).json({
        error: "returnUrl cannot be empty; OAuth apps must keep a registered callback URL",
        errorCode: "RETURN_URL_REQUIRED",
      });
      return;
    }
    sendAgentApiResponse("integrationAppUpdate", res, {
      clientId: updated.value.id,
      clientKey: updated.value.clientId,
      clientName: updated.value.name,
      updatedFields,
    });
    recordRaftCliActivity(req, agentId, {
      command: "integration.app.update",
      summary: `Updated integration app ${updated.value.clientId}: ${updatedFields.join(", ")}`,
      correlationId: updated.value.id,
    });
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes("category")) {
        res.status(400).json({ error: err.message, errorCode: "INVALID_CATEGORY" });
        return;
      }
      if (
        err.message.includes("required") ||
        err.message.includes("agentManifestUrl") ||
        err.message.includes("scope")
      ) {
        res.status(400).json({ error: err.message, errorCode: "INVALID_APP_METADATA" });
        return;
      }
    }
    if (err instanceof actionCardsService.ActionCardError) {
      res.status(err.status).json({ error: err.message, errorCode: err.code });
      return;
    }
    console.error("internal.agent-api.integrations-app-update error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to update integration app" });
  }
});
registerAgentApiRoute("integrationAppManage", ...agentApiRequestValidators("integrationAppManage"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const body = req.body as AgentApiRequestBodyByRoute["integrationAppManage"];
    const resolved = await oauthService.resolveOAuthClientForAgentMutation({
      serverId,
      clientKey: body.clientKey,
      actorAgentId: agentId,
    });
    if (resolved.status === "not_found") {
      res.status(404).json({ error: "Integration app not found" });
      return;
    }
    if (resolved.status === "owner_required") {
      res.status(403).json({
        error: "Only this app's owner or a current server admin can manage it",
        errorCode: "APP_MANAGE_AUTHORITY_REQUIRED",
      });
      return;
    }
    const client = resolved.value.client;
    let publishStatus: string | null | undefined;
    let logoUrl: string | null | undefined;
    let shareUrl: string | null | undefined;
    let link: {
      id: string;
      expiresAt: string | null;
      revokedAt: string | null;
      lastUsedAt: string | null;
      createdAt: string;
      updatedAt: string;
    } | null | undefined;

    if (body.action === "share_link_get") {
      const current = await oauthService.getOAuthClientShareLink({
        serverId,
        clientId: client.id,
        actorAgentId: agentId,
      });
      link = current ? {
        ...current,
        expiresAt: current.expiresAt?.toISOString() ?? null,
        revokedAt: current.revokedAt?.toISOString() ?? null,
        lastUsedAt: current.lastUsedAt?.toISOString() ?? null,
        createdAt: current.createdAt.toISOString(),
        updatedAt: current.updatedAt.toISOString(),
      } : null;
    } else if (body.action === "share_link_create") {
      const created = await oauthService.createOAuthClientShareLink({
        serverId,
        clientId: client.id,
        createdByAgentId: agentId,
        expiresInDays: body.expiresInDays,
      });
      if (!created) {
        res.status(409).json({ error: "Integration app cannot create a private share link in its current state" });
        return;
      }
      link = {
        ...created.link,
        expiresAt: created.link.expiresAt?.toISOString() ?? null,
        revokedAt: created.link.revokedAt?.toISOString() ?? null,
        lastUsedAt: created.link.lastUsedAt?.toISOString() ?? null,
        createdAt: created.link.createdAt.toISOString(),
        updatedAt: created.link.updatedAt.toISOString(),
      };
      shareUrl = `${getAppUrl()}/integration-invite/${encodeURIComponent(created.token)}`;
    } else if (body.action === "share_link_revoke") {
      const revoked = await oauthService.revokeOAuthClientShareLink({
        serverId,
        clientId: client.id,
        revokedByAgentId: agentId,
      });
      if (!revoked) {
        res.status(404).json({ error: "Integration app share link not found" });
        return;
      }
      link = {
        ...revoked,
        expiresAt: revoked.expiresAt?.toISOString() ?? null,
        revokedAt: revoked.revokedAt?.toISOString() ?? null,
        lastUsedAt: revoked.lastUsedAt?.toISOString() ?? null,
        createdAt: revoked.createdAt.toISOString(),
        updatedAt: revoked.updatedAt.toISOString(),
      };
    } else if (body.action === "request_publish") {
      const updated = await oauthService.requestOAuthClientPublish({
        serverId,
        clientId: client.id,
        requestedByAgentId: agentId,
      });
      if (!updated) {
        res.status(409).json({ error: "Integration app cannot request Marketplace review in its current state" });
        return;
      }
      publishStatus = updated.publishStatus;
    } else if (body.action === "request_unpublish") {
      const updated = await oauthService.requestOAuthClientUnpublish({
        serverId,
        clientId: client.id,
        requestedByAgentId: agentId,
      });
      if (!updated) {
        res.status(409).json({ error: "Integration app is not currently published" });
        return;
      }
      publishStatus = updated.publishStatus;
    } else if (body.action === "clear_logo") {
      const updated = await oauthService.clearOAuthClientLogo({
        serverId,
        clientId: client.id,
        actorAgentId: agentId,
      });
      if (!updated) {
        res.status(404).json({ error: "Integration app not found" });
        return;
      }
      logoUrl = updated.logoUrl;
    } else {
      const deleted = await oauthService.deleteOAuthClient({
        serverId,
        clientId: client.id,
        deletedByAgentId: agentId,
      });
      if (!deleted) {
        res.status(409).json({ error: "Published integration apps must request Marketplace removal before deletion" });
        return;
      }
    }

    sendAgentApiResponse("integrationAppManage", res, {
      action: body.action,
      clientId: client.id,
      clientKey: client.clientId,
      clientName: client.name,
      publishStatus,
      logoUrl,
      shareUrl,
      link,
    });
    recordRaftCliActivity(req, agentId, {
      command: `integration.app.${body.action.replaceAll("_", "-")}`,
      summary: `Managed integration app ${client.clientId}: ${body.action}`,
      correlationId: client.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("description")) {
      res.status(400).json({ error: message });
      return;
    }
    console.error("internal.agent-api.integrations-app-manage error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to manage integration app" });
  }
});
registerAgentApiRoute("integrationAppLogoUpdate", async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const uploaded = await runSingleAvatarUpload(integrationLogoUpload, req);
    const clientKey = optionalIntegrationString(req.body?.clientKey);
    if (!clientKey) {
      res.status(400).json({ error: "clientKey is required" });
      return;
    }
    if (!uploaded) {
      res.status(400).json({ error: "No logo file provided" });
      return;
    }
    const resolved = await oauthService.resolveOAuthClientForAgentMutation({
      serverId,
      clientKey,
      actorAgentId: agentId,
    });
    if (resolved.status === "not_found") {
      res.status(404).json({ error: "Integration app not found" });
      return;
    }
    if (resolved.status === "owner_required") {
      res.status(403).json({
        error: "Only this app's owner or a current server admin can update its logo",
        errorCode: "APP_MANAGE_AUTHORITY_REQUIRED",
      });
      return;
    }
    const updated = await oauthService.updateOAuthClientLogo({
      serverId,
      clientId: resolved.value.client.id,
      fileBuffer: uploaded.buffer,
      actorAgentId: agentId,
    });
    if (!updated?.logoUrl) {
      res.status(404).json({ error: "Integration app not found" });
      return;
    }
    sendAgentApiResponse("integrationAppLogoUpdate", res, {
      clientId: updated.id,
      clientKey: updated.clientId,
      clientName: updated.name,
      logoUrl: updated.logoUrl,
    });
    recordRaftCliActivity(req, agentId, {
      command: "integration.app.logo.update",
      summary: `Updated integration app logo for ${updated.clientId}`,
      correlationId: updated.id,
    });
  } catch (err) {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({
        error: PROFILE_AVATAR_TOO_LARGE_MESSAGE,
        errorCode: "APP_LOGO_TOO_LARGE",
        maxBytes: MAX_PROFILE_AVATAR_BYTES,
      });
      return;
    }
    if (err instanceof Error && err.message.includes(PROFILE_AVATAR_BAD_FORMAT_MESSAGE)) {
      res.status(400).json({
        error: PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
        errorCode: "APP_LOGO_BAD_FORMAT",
      });
      return;
    }
    console.error("internal.agent-api.integrations-app-logo-update error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to update integration app logo" });
  }
});
registerAgentApiRoute("integrationAppList", async (req, res) => {
  try {
    const apps = await integrationAppQueryService.listAgentIntegrationApps({
      serverId: req.serverId!,
      agentId: req.actingAgentId!,
    });
    sendAgentApiResponse("integrationAppList", res, { apps });
  } catch (err) {
    console.error("internal.agent-api.integrations-app-list error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to list integration apps" });
  }
});
registerAgentApiRoute("integrationAppStatus", ...agentApiRequestValidators("integrationAppStatus"), async (req, res) => {
  try {
    const query = req.query as AgentApiRequestQueryByRoute["integrationAppStatus"];
    const card = query.card?.trim();
    const clientKey = query.client?.trim();
    if (Boolean(card) === Boolean(clientKey)) {
      res.status(400).json({ error: "Exactly one of card or client is required" });
      return;
    }
    const app = card
      ? await integrationAppQueryService.getAgentIntegrationAppByCard({
          serverId: req.serverId!,
          agentId: req.actingAgentId!,
          cardRef: card,
        })
      : await integrationAppQueryService.getAgentIntegrationAppByClient({
          serverId: req.serverId!,
          agentId: req.actingAgentId!,
          clientKey: clientKey!,
        });
    if (!app) {
      res.status(404).json({ error: "Integration app not found" });
      return;
    }
    sendAgentApiResponse("integrationAppStatus", res, { app });
  } catch (err) {
    console.error("internal.agent-api.integrations-app-status error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to load integration app status" });
  }
});
registerAgentApiRoute("taskList", async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      res.status(401).json({ error: "Agent credential required", code: "invalid_principal" });
      return;
    }

    const query = validateAgentApiQuery("taskList", req, res);
    if (!query) return;
    const { channel, mine, status } = query;

    let statusFilter: TaskStatus | undefined;
    if (status !== undefined && status !== "all") {
      if (typeof status !== "string" || !isTaskStatus(status)) {
        res.status(400).json({ error: "Invalid status value" });
        return;
      }
      statusFilter = status;
    }

    if (mine === "true") {
      const channelRefs = await channelService.listAgentFacingTaskChannelRefs(serverId, agentId);
      const taskSurfaces = new Map<string, {
        channelRef: string;
        localChannel: TaskSurfaceChannel;
      }>();
      await Promise.all([...channelRefs].map(async ([localChannelId, channelRef]) => {
        const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channelRef);
        if (ctx) {
          const surface = {
            channelRef,
            localChannel: ctx.localChannel,
          };
          // Legacy/raw imports may still carry the authorized local joint id,
          // while Task V2 writes the canonical storage id. Both project to the
          // same caller-local surface; neither id is discovered from task rows.
          taskSurfaces.set(localChannelId, surface);
          taskSurfaces.set(ctx.storageChannelId, surface);
        }
      }));
      const assigned = await taskService.listTasksAssignedToAgent(
        [...taskSurfaces.keys()],
        agentId,
        status ?? undefined,
      );
      const visibleTasks = assigned.flatMap((task) => {
        const surface = taskSurfaces.get(task.channelId);
        return surface
          ? [{
              ...taskService.projectTaskToChannel(task, surface.localChannel),
              channelRef: surface.channelRef,
            }]
          : [];
      });
      sendAgentApiResponse("taskList", res, {
        tasks: visibleTasks,
        scope: "mine",
        coverage: {
          status: "incomplete",
          visibleChannelTypes: ["channel", "private", "joint", "dm"],
          includesArchived: true,
          inaccessibleScope: "not_asserted",
          reason: "Channel membership can change after assignment; inaccessible task scope is not asserted.",
        },
        pagination: { mode: "complete", truncated: false },
      });
      return;
    }

    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel!);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }

    const tasks = await taskService.listTasks(ctx.storageChannelId, statusFilter);
    sendAgentApiResponse("taskList", res, {
      tasks: taskService.projectTasksToChannel(tasks, ctx.localChannel),
      scope: "channel",
    });
  } catch (err) {
    console.error("internal.agent-api.task-list error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to list tasks" });
  }
});

async function resolveTaskCreateAssignee(
  serverId: string,
  channelId: string,
  assigneeRef: string,
  res: Response,
): Promise<(taskService.TaskCreationAssignee & {
  name: string;
}) | null> {
  // @stdrc: assigning at create time carries the SAME permission as create and
  // as assign -- "只有 delete 这种行为，是只能创建者和 admin 做". The former
  // `manageServer` gate on dispatching to another actor is therefore removed.
  //
  // That gate also served as directory-oracle protection. It is not needed for
  // this actor class: a channel member can already enumerate server humans and
  // agents through `raft server info` / channel members, so distinguishable
  // not-found / ambiguous / cannot-claim answers leak nothing they cannot
  // already read, and they are materially better diagnostics for an agent.
  const handle = assigneeRef.slice(1).trim();

  const [humanId, targetAgentId] = await Promise.all([
    channelService.resolveUserByName(serverId, handle),
    channelService.resolveAgentByName(serverId, handle),
  ]);

  if (humanId && targetAgentId) {
    res.status(409).json({ error: `Assignee @${handle} is ambiguous`, code: "assignee_ambiguous" });
    return null;
  }

  const assignee: taskService.TaskCreationAssignee | null = targetAgentId
    ? { type: "agent", id: targetAgentId }
    : humanId
      ? { type: "user", id: humanId }
      : null;
  if (!assignee) {
    res.status(404).json({ error: `Assignee @${handle} not found`, code: "assignee_not_found" });
    return null;
  }

  const canClaim = assignee.type === "agent"
    ? await channelService.canAgentPostToChannel(channelId, assignee.id)
    : await channelService.canUserPostToChannel(channelId, assignee.id);
  if (!canClaim) {
    res.status(403).json({
      error: `Assignee @${handle} cannot claim tasks in this channel`,
      code: "assignee_cannot_claim",
    });
    return null;
  }

  return {
    ...assignee,
    name: handle,
  };
}

async function resolveJointTaskCreateAssignee(
  channelId: string,
  assigneeRef: string,
  res: Response,
): Promise<(taskService.TaskCreationAssignee & {
  name: string;
}) | null> {
  const handle = assigneeRef.slice(1).trim();
  const assignee = await resolveTaskAssignAssignee(channelId, assigneeRef);
  if (!assignee) {
    // Joint resolution is intentionally scoped to the channel-visible union.
    // Missing, ambiguous, and non-member handles remain one fail-closed shape.
    res.status(404).json({
      error: `Assignee @${handle} is not assignable in this channel`,
      code: "assignee_not_assignable",
    });
    return null;
  }
  return {
    ...assignee,
    name: handle,
  };
}

registerAgentApiRoute("taskCreate", ...agentApiRequestValidators("taskCreate"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      res.status(401).json({ error: "Agent credential required", code: "invalid_principal" });
      return;
    }

    const { channel, tasks: items, assignee: assigneeRef } = req.body as AgentApiRequestBodyByRoute["taskCreate"];
    if (items.length > 50) {
      res.status(400).json({ error: "Cannot create more than 50 tasks at once" });
      return;
    }

    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }
    if (!await assertAgentApiTaskWritableChannel(ctx, agentId, res, {
      threadError: "Thread messages cannot become tasks",
    })) {
      return;
    }
    const assignee = assigneeRef
      ? ctx.surface.isJoint
        ? await resolveJointTaskCreateAssignee(ctx.channelId, assigneeRef, res)
        : await resolveTaskCreateAssignee(serverId, ctx.channelId, assigneeRef, res)
      : undefined;
    if (assigneeRef && !assignee) return;

    let created: Awaited<ReturnType<typeof taskService.createTasks>>["tasks"];
    let hostMessages: Awaited<ReturnType<typeof taskService.createTasks>>["hostMessages"];
    let persistedAssignmentReceipt: taskService.TaskAssignmentReceipt | undefined;
    try {
      if (assignee) {
        const result = await taskService.createTasksWithAssignmentReceipt(
          ctx.storageChannelId,
          "agent",
          agentId,
          items.map((item) => ({
            title: item.title.trim(),
            createsResource: item.creates_resource === true,
          })),
          assignee,
          { assigneeName: assignee.name },
          ctx.surface.isJoint ? { initiatingLocalChannelId: ctx.channelId } : {},
        );
        created = result.tasks;
        hostMessages = result.hostMessages;
        persistedAssignmentReceipt = result.assignmentReceipt;
      } else {
        const result = await taskService.createTasks(
          ctx.storageChannelId,
          "agent",
          agentId,
          items.map((item) => ({
            title: item.title.trim(),
            createsResource: item.creates_resource === true,
          })),
        );
        created = result.tasks;
        hostMessages = result.hostMessages;
      }
    } catch (err) {
      if (err instanceof taskService.TaskCreationAssigneeEligibilityError) {
        res.status(403).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }

    const io: SocketServer = req.app.get("io");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const creatorName = created[0]?.createdByName || "Unknown";
    const fanoutCreatedTasks = async () => {
      // v1.4: host message broadcasts on the ordinary message/agent-delivery
      // path; the task fact broadcasts separately on the task board.
      const targets = await getTaskRealtimeSurfaceTargets(ctx.surface);
      for (const target of targets) {
        const projectedTasks = taskService.projectTasksToChannel(created, target.localChannel);
        for (const message of hostMessages) {
          // message-realtime-producer: task-route.new.agent-api
          emitTaskMessageNew(io, target, { ...message, channelId: target.channelId }, creatorName);
        }
        emitTaskCreated(io, target, {
          channelId: target.channelId,
          tasks: projectedTasks,
        });
        const projectedMessages = hostMessages.map((message) => ({ ...message, channelId: target.channelId }));
        await messageService.deliverMessagesToAgents(
          agentOrchestrator,
          projectedMessages,
          creatorName,
        );
      }
    };

    const taskList = created
      .map((task) => `task #${task.taskNumber} "${messageService.summarizeForSystemMessage(task.title)}"`)
      .join(", ");
    let assignmentReceipt: {
      messageId: string;
      content: string;
      assignee: string;
      state: "started" | "assigned";
    } | undefined;
    if (assignee && persistedAssignmentReceipt) {
      assignmentReceipt = {
        messageId: persistedAssignmentReceipt.message.id,
        content: persistedAssignmentReceipt.content,
        assignee: persistedAssignmentReceipt.assignee,
        state: persistedAssignmentReceipt.state,
      };
      // The transaction committed the channel's newest durable seq. Advance
      // heartbeat catch-up before any fallible realtime/delivery fanout so a
      // missed emit remains recoverable without waiting for a later message.
      const receiptTargets = await getTaskRealtimeSurfaceTargets(ctx.surface);
      for (const target of receiptTargets) {
        messageService.updateMaxSeq(target.serverId, persistedAssignmentReceipt.message.seq);
      }
      try {
        await failpoints.hit("server.task.assignedCreate.postCommitFanout", {
          channelId: ctx.channelId,
          receiptMessageId: persistedAssignmentReceipt.message.id,
        }, async () => undefined);
        await fanoutCreatedTasks();
        await messageService.broadcastSystemMessageToLocalSurfaces(
          io,
          agentOrchestrator,
          ctx.channelId,
          persistedAssignmentReceipt.content,
          {
            inboxFactPolicy: {
              mode: "record",
              producer: "task.assignment_receipt",
              reason: "a task assignment is durable directed attention for its assignee",
            },
            causalActor: { type: "agent", id: agentId },
            personalAttentionTargets: [{ type: assignee.type, id: assignee.id, name: assignee.name }],
            persistedMessage: persistedAssignmentReceipt.message,
          },
        );
      } catch (err) {
        // Durable state already committed. A transient fanout failure must not
        // turn success into retry-inviting HTTP 500 and duplicate the tasks.
        console.error("internal.agent-api.task-create post-commit fanout failed:", serializeErrorForLog(err));
      }
    } else {
      await fanoutCreatedTasks();
      const sysContent = `📋 ${created.length} new task${created.length > 1 ? "s" : ""} created: ${taskList}`;
      messageService.broadcastSystemMessageToLocalSurfaces(io, agentOrchestrator, ctx.channelId, sysContent, {
        inboxFactPolicy: {
          mode: "record",
          producer: "task.created_summary",
          reason: "new shared tasks are channel activity",
        },
        // The agent that created the tasks should not see its own action as unread.
        causalActor: { type: "agent", id: agentId },
      }).catch(() => {});
    }

    const responseTasks = created.map((task) => ({
      taskNumber: task.taskNumber,
      messageId: task.messageId,
      title: task.title,
      status: task.status,
      claimedByType: task.claimedByType,
      claimedById: task.claimedById,
      claimedByName: task.claimedByName,
      claimedAt: task.claimedAt,
      requiresResourceReceipt: task.requiresResourceReceipt,
    }));
    sendAgentApiResponse("taskCreate", res, {
      tasks: responseTasks,
      ...(assignmentReceipt && { assignmentReceipt }),
    });
    void recordAgentRaftAction(req, agentId, {
      title: `Created ${created.length} task${created.length === 1 ? "" : "s"}`,
      text: `target: ${channel}`,
    });
  } catch (err) {
    console.error("internal.agent-api.task-create error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to create tasks" });
  }
});

function taskClaimMode(hasTaskNumbers: boolean, hasMessageIds: boolean): "mixed" | "task_number" | "message_id" | "empty" {
  if (hasTaskNumbers && hasMessageIds) return "mixed";
  if (hasTaskNumbers) return "task_number";
  if (hasMessageIds) return "message_id";
  return "empty";
}

function taskClaimReasonBucket(reason: string | undefined): string {
  const normalized = reason?.toLowerCase() ?? "";
  if (!normalized) return "unknown_business_failure";
  if (normalized.includes("not found")) return "not_found";
  if (normalized.includes("already claimed")) return "already_claimed";
  if (normalized.includes("already converted")) return "already_converted";
  if (normalized.includes("archived")) return "channel_archived";
  if (normalized.includes("thread")) return "thread_target";
  return "unknown_business_failure";
}

function traceTaskClaimFinished(attrs: Record<string, unknown>): void {
  addTraceEvent("task_claim.finished", {
    event_kind: "task_claim",
    ...attrs,
  });
}

registerAgentApiRoute("taskClaim", ...agentApiRequestValidators("taskClaim"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      traceTaskClaimFinished({
        outcome: "rejected",
        reason: "invalid_principal",
        claim_mode: "empty",
        input_count: 0,
      });
      res.status(401).json({ error: "Agent credential required", code: "invalid_principal" });
      return;
    }

    const { channel, task_numbers, message_ids } = req.body as AgentApiRequestBodyByRoute["taskClaim"];
    const hasTaskNumbers = Array.isArray(task_numbers) && task_numbers.length > 0;
    const hasMessageIds = Array.isArray(message_ids) && message_ids.length > 0;
    const claimMode = taskClaimMode(hasTaskNumbers, hasMessageIds);
    const inputCount = (hasTaskNumbers ? task_numbers.length : 0) + (hasMessageIds ? message_ids.length : 0);
    if (!hasTaskNumbers && !hasMessageIds) {
      traceTaskClaimFinished({
        outcome: "rejected",
        reason: "invalid_body",
        claim_mode: claimMode,
        input_count: inputCount,
      });
      res.status(400).json({ error: "channel and either task_numbers or message_ids array are required" });
      return;
    }

    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel);
    if (!ctx) {
      traceTaskClaimFinished({
        outcome: "rejected",
        reason: "target_not_found",
        claim_mode: claimMode,
        input_count: inputCount,
      });
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }
    if (!await assertAgentApiTaskWritableChannel(ctx, agentId, res, {
      threadError: "Thread messages cannot be claimed as tasks",
    })) {
      traceTaskClaimFinished({
        outcome: "rejected",
        reason: ctx.channelType === "thread" ? "thread_target" : "target_not_writable",
        claim_mode: claimMode,
        input_count: inputCount,
      });
      return;
    }

    const io: SocketServer = req.app.get("io");
    const results: {
      taskNumber?: number;
      messageId?: string;
      success: boolean;
      reason?: string;
      conflict?: AgentApiTaskClaimConflict;
    }[] = [];
    let successfulClaimCount = 0;

    await traceQuerySpan({
      queryName: "tasks.claim",
      phase: "agent_api_task_claim",
      dbSystem: "postgresql",
      attrs: {
        claim_mode: claimMode,
        input_count: inputCount,
      },
      successAttrs: () => ({
        result_count: results.length,
        successful_claim_count: successfulClaimCount,
      }),
    }, async () => {

    if (hasTaskNumbers) {
      const batchResults = await taskService.batchClaimTasks(ctx.storageChannelId, task_numbers, "agent", agentId);
      for (const result of batchResults) {
        let claimedMessageId: string | undefined;
        if (result.success && result.task) {
          const facts = await emitTaskMutationToSurfaces(io, ctx.surface, result.task);
          claimedMessageId = facts.messageId ?? undefined;
          successfulClaimCount += 1;
        }
        results.push({
          taskNumber: result.taskNumber,
          messageId: claimedMessageId,
          success: result.success,
          reason: result.reason,
          conflict: result.conflict,
        });
      }
    }

    if (hasMessageIds) {
      for (const rawMsgId of message_ids) {
        const resolved = await taskService.resolveMessageInChannel(ctx.storageChannelId, rawMsgId);
        if (!resolved) {
          results.push({ messageId: rawMsgId, success: false, reason: "message not found" });
          continue;
        }

        const msgId = resolved.id;
        const converted = await taskService.convertMessageToTask(msgId, "agent", agentId, ctx.storageChannelId);
        if (typeof converted === "string") {
          if (converted === "already converted") {
            const existingOwner = await taskService.resolveTaskByMessageId(msgId);
            if (existingOwner) {
              // P3: both arms of the old ownership ternary read the same field.
              const existingNumber = existingOwner.row.taskNumber;
              const rejection = await taskService.getClaimRejectionForOwner(existingOwner, "agent", agentId);
              if (rejection) {
                results.push({
                  messageId: msgId,
                  success: false,
                  reason: rejection.reason,
                  conflict: rejection.conflict ?? undefined,
                  taskNumber: existingNumber,
                });
                continue;
              }
              const claimed = await taskService.claimTaskDetailed(existingOwner.row.id, "agent", agentId);
              if (typeof claimed.result !== "string") {
                const facts = await emitTaskMutationToSurfaces(io, ctx.surface, claimed.result);
                successfulClaimCount += 1;
                results.push({ messageId: msgId, success: true, taskNumber: facts.taskNumber });
                continue;
              }
              results.push({
                messageId: msgId,
                success: false,
                reason: claimed.result,
                conflict: claimed.conflict,
                taskNumber: existingNumber,
              });
              continue;
            }
          }
          results.push({ messageId: msgId, success: false, reason: converted });
        } else {
          const claimed = await taskService.claimTaskDetailed(converted.id, "agent", agentId);
          if (typeof claimed.result !== "string") {
            // The convert left the host message untouched, so only the task
            // board learns about this — no message:updated for an unchanged row.
            const facts = await describeTaskMutation(claimed.result);
            const targets = await getTaskRealtimeSurfaceTargets(ctx.surface);
            for (const target of targets) {
              emitTaskCreated(io, target, {
                channelId: target.channelId,
                tasks: [taskService.projectTaskToChannel(facts.enriched, target.localChannel)],
              });
            }
            successfulClaimCount += 1;
            results.push({ messageId: msgId, success: true, taskNumber: facts.taskNumber });
          } else {
            results.push({ messageId: msgId, success: false, reason: claimed.result, conflict: claimed.conflict });
          }
        }
      }
    }
    });

    // No post-hoc conflict projection happens here: every `conflict` above was
    // built by the authoritative claim writer (or channel-bound pre-check)
    // from the same observed row that produced its `reason`. A cross-channel
    // message id fails channel-bound resolution and stays indistinguishable
    // from a nonexistent one — prose "message not found", zero conflict.
    const failedResults = results.filter((result) => !result.success);
    traceTaskClaimFinished({
      outcome: successfulClaimCount > 0
        ? failedResults.length > 0 ? "partial_success" : "success"
        : "business_rejected",
      reason: successfulClaimCount > 0
        ? failedResults.length > 0 ? "partial_failure" : "claimed"
        : "no_claims",
      claim_mode: claimMode,
      input_count: inputCount,
      result_count: results.length,
      successful_claim_count: successfulClaimCount,
      failed_result_count: failedResults.length,
      failure_reason_buckets: [...new Set(failedResults.map((result) => taskClaimReasonBucket(result.reason)))].join(",") || "none",
    });
    sendAgentApiResponse("taskClaim", res, { results });
    if (successfulClaimCount > 0) {
      void recordAgentRaftAction(req, agentId, {
        title: `Claimed ${successfulClaimCount} task${successfulClaimCount === 1 ? "" : "s"}`,
        text: `target: ${channel}`,
      });
    }
  } catch (err) {
    traceTaskClaimFinished({
      outcome: "internal_error",
      reason: "unexpected_throw",
      error_class: err instanceof Error ? err.name : typeof err,
    });
    console.error("internal.agent-api.task-claim error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to claim tasks" });
  }
});

registerAgentApiRoute("taskUnclaim", ...agentApiRequestValidators("taskUnclaim"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      res.status(401).json({ error: "Agent credential required", code: "invalid_principal" });
      return;
    }

    const { channel, task_number } = req.body as AgentApiRequestBodyByRoute["taskUnclaim"];
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }
    if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const result = await taskService.unclaimTask(task.id, "agent", agentId);
    if (typeof result === "string") {
      res.status(409).json({ error: result });
      return;
    }

    const io: SocketServer = req.app.get("io");
    await emitTaskMutationToSurfaces(io, ctx.surface, result);

    sendAgentApiResponse("taskUnclaim", res, { ok: true });
    void recordAgentRaftAction(req, agentId, {
      title: `Unclaimed task #${task_number}`,
      text: `target: ${channel}`,
      producerFactId: task.id,
    });
  } catch (err) {
    console.error("internal.agent-api.task-unclaim error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to unclaim task" });
  }
});

/**
 * Resolve an `@handle` for the ASSIGN path.
 *
 * Deliberately NOT `resolveTaskCreateAssignee`. That one gates assigning to
 * another actor behind `manageServer`, and @stdrc ruled that setting an assignee
 * is member-level (任何人都可以 assign 给别人). Reusing it would have silently
 * re-imposed the admin gate on the very capability this feature exists to grant.
 *
 * But the concern the create path was protecting is real and survives: handle
 * resolution can be used as a **directory oracle** — probing which names exist,
 * are ambiguous, or are hidden from you. So instead of an authority gate, this
 * closes the oracle directly: every unresolvable handle, every handle for
 * someone outside this channel, and every ambiguous handle answer with the SAME
 * message. A caller learns only "not assignable here", never why.
 *
 * ⚠️ This makes the agent assign path member-level while assigned-CREATE stays
 * admin-only. That divergence is raised with @stdrc rather than resolved here —
 * loosening the create path is a permission change to shipped behavior and is
 * not this feature's call.
 */
async function resolveTaskAssignAssignee(
  channelId: string,
  assigneeRef: string,
): Promise<taskService.TaskCreationAssignee | null> {
  const handle = assigneeRef.startsWith("@") ? assigneeRef.slice(1).trim() : assigneeRef.trim();
  if (!handle) return null;

  // Resolve only through the channel-visible directory. For a joint channel,
  // getChannelMembers returns the union of active projections, so a peer-server
  // member is assignable without turning the requester's local server directory
  // into the authority source. Logical ids are deduped before ambiguity is
  // judged: one person present on both projections is still one candidate.
  const members = await channelService.getChannelMembers(channelId);
  const humanIds = new Set(members.humans.filter((human) => human.name === handle).map((human) => human.id));
  const agentIds = new Set(members.agents.filter((agent) => agent.name === handle).map((agent) => agent.id));
  if (humanIds.size + agentIds.size !== 1) return null;
  if (agentIds.size === 1) return { type: "agent", id: [...agentIds][0]! };
  return { type: "user", id: [...humanIds][0]! };
}

async function resolveTaskResourceTeardownOwner(
  surface: TaskChannelSurface,
  localChannelId: string,
  ownerRef: string,
): Promise<{ id: string; name: string; serverId: string; targetChannelId: string } | null> {
  const handle = ownerRef.startsWith("@") ? ownerRef.slice(1).trim() : ownerRef.trim();
  if (!handle) return null;
  const members = await channelService.getChannelMembers(localChannelId);
  const matches = members.agents.filter((agent) => agent.name === handle);
  const ids = new Set(matches.map((agent) => agent.id));
  if (ids.size !== 1) return null;
  const owner = matches.find((agent) => agent.id === [...ids][0]);
  if (!owner) return null;
  const targets = await getTaskRealtimeSurfaceTargets(surface);
  const target = targets.find((candidate) => candidate.serverId === owner.serverId);
  if (!target) return null;
  return {
    id: owner.id,
    name: owner.name,
    serverId: owner.serverId,
    targetChannelId: target.channelId,
  };
}

registerAgentApiRoute("taskAssign", ...agentApiRequestValidators("taskAssign"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      res.status(401).json({ error: "Agent credential required", code: "invalid_principal" });
      return;
    }

    const { channel, task_number, assignee: assigneeRef, expected_revision } =
      req.body as AgentApiRequestBodyByRoute["taskAssign"];
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }
    if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    let assignee: taskService.TaskCreationAssignee | null = null;
    if (assigneeRef !== null) {
      assignee = await resolveTaskAssignAssignee(ctx.channelId, assigneeRef);
      if (!assignee) {
        res.status(404).json({
          error: `${assigneeRef} is not assignable in this channel`,
          code: "assignee_not_assignable",
        });
        return;
      }
    }

    const result = await taskService.assignTask(task.id, assignee, "agent", agentId, {
      expectedRevision: expected_revision,
    });
    if (typeof result === "string") {
      res.status(409).json({ error: result });
      return;
    }

    const io: SocketServer = req.app.get("io");
    await emitTaskMutationToSurfaces(io, ctx.surface, result);

    sendAgentApiResponse("taskAssign", res, {
      ok: true,
      revision: result.row.revision,
      assignee: assigneeRef ?? null,
    });
    void recordAgentRaftAction(req, agentId, {
      title: assigneeRef
        ? `Assigned task #${task_number} to ${assigneeRef}`
        : `Unassigned task #${task_number}`,
      text: `target: ${channel}`,
      producerFactId: task.id,
    });
  } catch (err) {
    console.error("internal.agent-api.task-assign error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to assign task" });
  }
});

registerAgentApiRoute("taskUpdateStatus", ...agentApiRequestValidators("taskUpdateStatus"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      res.status(401).json({ error: "Agent credential required", code: "invalid_principal" });
      return;
    }

    const { channel, task_number, status } = req.body as AgentApiRequestBodyByRoute["taskUpdateStatus"];
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }
    if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    // Same shape as the browser route: try the ordinary member-level update,
    // then let an actor holding `deleteAnyTask` force it. Agents carry a
    // `serverAgentMembers.role`, so an admin agent is a real state — this route
    // simply never consulted it, which made agents strictly weaker than human
    // admins for no stated reason (@stdrc: 人和 agent 的权限管理才一致).
    let result = await taskService.updateTaskStatus(task.id, status, agentId, "agent");
    if (typeof result === "string" && result !== "task not found") {
      if (await actorHasServerCapabilityInServer(serverId, "agent", agentId, "deleteAnyTask")) {
        result = await taskService.forceUpdateTaskStatus(task.id, status, "agent", agentId);
      }
    }
    if (typeof result === "string") {
      res.status(409).json({ error: result });
      return;
    }

    const io: SocketServer = req.app.get("io");
    await emitTaskMutationToSurfaces(io, ctx.surface, result);

    sendAgentApiResponse("taskUpdateStatus", res, { ok: true });
    void recordAgentRaftAction(req, agentId, {
      title: `Updated task #${task_number} to ${status}`,
      text: `target: ${channel}`,
      producerFactId: task.id,
    });
  } catch (err) {
    console.error("internal.agent-api.task-update-status error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to update task status" });
  }
});

registerAgentApiRoute("taskResourceReceipt", ...agentApiRequestValidators("taskResourceReceipt"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      res.status(401).json({ error: "Agent credential required", code: "invalid_principal" });
      return;
    }

    const { channel, task_number, receipt } =
      req.body as AgentApiRequestBodyByRoute["taskResourceReceipt"];
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }
    if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const teardownOwner = await resolveTaskResourceTeardownOwner(
      ctx.surface,
      ctx.channelId,
      receipt.teardown_owner,
    );
    if (!teardownOwner) {
      res.status(409).json({
        error: "teardown_owner is not a unique agent in this task channel",
        code: "teardown_owner_not_assignable",
      });
      return;
    }

    const result = await taskService.recordTaskResourceReceipt({
      taskId: task.id,
      receipt,
      actorType: "agent",
      actorId: agentId,
      teardownOwnerAgentId: teardownOwner.id,
      teardownOwnerServerId: teardownOwner.serverId,
      teardownOwnerTargetChannelId: teardownOwner.targetChannelId,
      expiryFollowups: taskResourceExpiryFollowups,
    });
    if (typeof result === "string") {
      const status = result.includes("must be") ? 400 : 409;
      res.status(status).json({ error: result });
      return;
    }

    const io: SocketServer = req.app.get("io");
    if (!result.idempotent) {
      await emitTaskMutationToSurfaces(io, ctx.surface, { source: "tasks", row: result.task });
    }
    // Retry the Computer handoff even for an idempotent HTTP retry: the
    // durable transaction may have committed while the first sync failed.
    await publishTaskResourceExpiryFollowup(
      req,
      result.expiryFollowup.id,
      teardownOwner.serverId,
      !result.idempotent,
    );

    sendAgentApiResponse("taskResourceReceipt", res, {
      ok: true,
      taskNumber: result.task.taskNumber,
      revision: result.task.revision,
      receipt: { ...result.receipt },
      expiryFollowup: {
        id: result.expiryFollowup.id,
        ownerAgentId: teardownOwner.id,
        owner: `@${teardownOwner.name}`,
        fireAt: result.expiryFollowup.fireAt.toISOString(),
        msgId: result.task.messageId!,
        targetChannelId: teardownOwner.targetChannelId,
      },
    });
    void recordAgentRaftAction(req, agentId, {
      title: `Recorded resource receipt for task #${task_number}`,
      text: `target: ${channel}`,
      producerFactId: task.id,
    });
  } catch (err) {
    console.error("internal.agent-api.task-resource-receipt error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to record task resource receipt" });
  }
});

/**
 * Delete a task.
 *
 * Authorization is the browser rule verbatim: the creator, or an actor holding
 * `deleteAnyTask`. Before this route existed an agent could not delete at all --
 * not even an admin agent, and not even a task it had created itself -- while a
 * human creator could. That was the one task verb with no agent surface.
 */
registerAgentApiRoute("taskDelete", ...agentApiRequestValidators("taskDelete"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      res.status(401).json({ error: "Agent credential required", code: "invalid_principal" });
      return;
    }

    const { channel, task_number } = req.body as AgentApiRequestBodyByRoute["taskDelete"];
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }
    if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const owner = await taskService.resolveTaskByNumber(ctx.storageChannelId, task_number);
    if (!owner) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const isCreator = owner.row.createdByType === "agent" && owner.row.createdById === agentId;
    if (!isCreator && !await actorHasServerCapabilityInServer(serverId, "agent", agentId, "deleteAnyTask")) {
      res.status(403).json({
        error: "Only the task creator or server admins can delete",
        code: "task_delete_forbidden",
      });
      return;
    }

    const title = owner.row.title;
    await taskService.deleteTaskByOwner(owner);

    const io: SocketServer = req.app.get("io");
    const targets = await getTaskRealtimeSurfaceTargets(ctx.surface);
    for (const target of targets) {
      emitTaskDeleted(io, target, { channelId: target.channelId, taskId: owner.row.id });
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const actor = await agentService.getAgent(agentId);
    const actorName = actor?.displayName || actor?.name || "An agent";
    messageService.broadcastSystemMessageToLocalSurfaces(io, agentOrchestrator, ctx.channelId,
      `🗑 ${actorName} deleted #${task_number} "${messageService.summarizeForSystemMessage(title)}"`, {
        inboxFactPolicy: {
          mode: "skip",
          producer: "task.deleted_summary",
          reason: "task lifecycle churn should not move Activity unread",
        },
      }).catch(() => {});

    sendAgentApiResponse("taskDelete", res, { ok: true });
    void recordAgentRaftAction(req, agentId, {
      title: `Deleted task #${task_number}`,
      text: `target: ${channel}`,
      producerFactId: owner.row.id,
    });
  } catch (err) {
    console.error("internal.agent-api.task-delete error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to delete task" });
  }
});

/**
 * Convert a message into a task WITHOUT claiming it.
 *
 * `taskClaim --message-id` already converts, but it also assigns the result to
 * the caller, so an agent filing work for someone else had no way to express
 * "this message is a task" without first taking it. The browser has had the
 * unclaimed form (`POST /tasks/convert-message`) all along.
 */
registerAgentApiRoute("taskConvert", ...agentApiRequestValidators("taskConvert"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      res.status(401).json({ error: "Agent credential required", code: "invalid_principal" });
      return;
    }

    const { channel, message_id } = req.body as AgentApiRequestBodyByRoute["taskConvert"];
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }
    if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const resolved = await taskService.resolveMessageInChannel(ctx.storageChannelId, message_id);
    if (!resolved) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    const converted = await taskService.convertMessageToTask(resolved.id, "agent", agentId, ctx.storageChannelId);
    if (typeof converted === "string") {
      res.status(409).json({ error: converted });
      return;
    }

    const enriched = await taskService.enrichSingleLegacyTask(converted);
    const io: SocketServer = req.app.get("io");
    // Converting does not rewrite the host message, so there is no
    // `message:updated` and nothing new to deliver — the message was already
    // delivered when it was sent. Only the board learns something.
    const targets = await getTaskRealtimeSurfaceTargets(ctx.surface);
    for (const target of targets) {
      emitTaskCreated(io, target, {
        channelId: target.channelId,
        tasks: [taskService.projectTaskToChannel(enriched, target.localChannel)],
      });
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const actor = await agentService.getAgent(agentId);
    const actorName = actor?.displayName || actor?.name || "An agent";
    messageService.broadcastSystemMessageToLocalSurfaces(io, agentOrchestrator, ctx.channelId,
      `📋 ${actorName} converted a message to task #${converted.taskNumber} "${messageService.summarizeForSystemMessage(converted.title)}"`, {
        inboxFactPolicy: {
          mode: "record",
          producer: "task.converted_summary",
          reason: "newly created task is shared channel activity",
        },
        causalActor: { type: "agent", id: agentId },
      }).catch(() => {});

    sendAgentApiResponse("taskConvert", res, {
      task: {
        taskNumber: enriched.taskNumber,
        messageId: enriched.messageId,
        title: enriched.title,
        status: enriched.status,
        claimedByType: enriched.claimedByType,
        claimedById: enriched.claimedById,
        claimedByName: enriched.claimedByName,
        claimedAt: enriched.claimedAt,
        requiresResourceReceipt: enriched.requiresResourceReceipt,
      },
    });
    void recordAgentRaftAction(req, agentId, {
      title: `Converted a message to task #${converted.taskNumber}`,
      text: `target: ${channel}`,
      producerFactId: converted.id,
    });
  } catch (err) {
    console.error("internal.agent-api.task-convert error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to convert message to task" });
  }
});

registerAgentApiRoute("taskAmend", ...agentApiRequestValidators("taskAmend"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      res.status(401).json({ error: "Agent credential required", code: "invalid_principal" });
      return;
    }

    const { channel, task_number, title, description } = req.body as AgentApiRequestBodyByRoute["taskAmend"];
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }
    if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const patch: taskService.TaskAmendPatch = {};
    if (title !== undefined) patch.title = title;
    if (description !== undefined) patch.description = description;
    const result = await taskService.amendTask(task.id, patch, "agent", agentId);
    if (typeof result === "string") {
      res.status(409).json({ error: result });
      return;
    }

    const actor = await agentService.getAgent(agentId);
    const io: SocketServer = req.app.get("io");
    await emitTaskMutationToSurfaces(
      io,
      ctx.surface,
      { source: "tasks", row: result.row },
      {
        title: result.row.title,
        description: result.row.description,
        revision: result.row.revision,
        superseded: true,
        amendedAt: result.event.createdAt.toISOString(),
        amendedByType: result.event.actorType,
        amendedByName: actor?.name ?? null,
        source: "tasks_current_projection",
      },
    );

    sendAgentApiResponse("taskAmend", res, {
      task: {
        taskNumber: result.row.taskNumber,
        title: result.row.title,
        description: result.row.description,
        revision: result.row.revision,
      },
      event: {
        id: result.event.id,
        seq: result.event.seq,
        eventType: result.event.eventType,
        actorType: result.event.actorType,
        actorName: actor?.name ?? null,
        payload: result.event.payload,
        createdAt: result.event.createdAt.toISOString(),
      },
    });
    void recordAgentRaftAction(req, agentId, {
      title: `Amended task #${task_number}`,
      text: `target: ${channel}\nrevision: ${result.row.revision}\nevent_seq: ${result.event.seq}`,
      producerFactId: result.event.id,
    });
  } catch (err) {
    console.error("internal.agent-api.task-amend error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to amend task" });
  }
});

registerAgentApiRoute("taskHistory", ...agentApiRequestValidators("taskHistory"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      res.status(401).json({ error: "Agent credential required", code: "invalid_principal" });
      return;
    }

    const query = validateAgentApiQuery("taskHistory", req, res);
    if (!query) return;
    const { channel, task_number } = query;
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }
    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const history = await taskService.listTaskHistory(task.id);
    if (typeof history === "string") {
      res.status(409).json({ error: history });
      return;
    }
    const owner = await taskService.resolveTaskById(task.id);
    if (!owner || owner.source !== "tasks") {
      res.status(409).json({ error: "legacy task cards do not have canonical history" });
      return;
    }
    sendAgentApiResponse("taskHistory", res, {
      task: {
        taskNumber: owner.row.taskNumber,
        title: owner.row.title,
        description: owner.row.description,
        revision: owner.row.revision,
      },
      events: history,
    });
  } catch (err) {
    console.error("internal.agent-api.task-history error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to read task history" });
  }
});

registerAgentApiRoute("migrationBegin", ...agentApiRequestValidators("migrationBegin"), async (req, res) => {
  void req;
  res.status(403).json({
    error: "Agent-initiated migration is not supported; start migration from the agent profile as its human creator, or with a role that includes `migrateAgents`",
    code: "not_supported",
  });
});

registerAgentApiRoute("migrationStatus", ...agentApiRequestValidators("migrationStatus"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      res.status(401).json({ error: "Agent credential required", code: "invalid_principal" });
      return;
    }

    const migration = await agentMigrationService.getActiveAgentMigration(agentId);
    sendAgentApiResponse("migrationStatus", res, {
      migration: migration ? serializeAgentMigration(migration) : null,
    });
  } catch (err) {
    console.error("internal.agent-api.migration-status error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to get migration status" });
  }
});

registerAgentApiRoute("migrationReady", ...agentApiRequestValidators("migrationReady"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      res.status(401).json({ error: "Agent credential required", code: "invalid_principal" });
      return;
    }

    const current = await agentMigrationService.getActiveAgentMigration(agentId);
    if (!current) {
      res.status(404).json({ error: "No active migration", code: "MIGRATION_NOT_FOUND" });
      return;
    }

    const body = req.body as AgentApiRequestBodyByRoute["migrationReady"];
    const migration = await agentMigrationService.markAgentMigrationReady({
      grantKey: current.grantKey,
      manifestPath: body.manifestPath,
      manifestSha256: body.manifestSha256,
    });
    await emitAgentMigrationUpdated(req.app.get("io") as SocketServer | undefined, migration);
    sendAgentApiResponse("migrationReady", res, { migration: serializeAgentMigration(migration) });
    void recordAgentRaftAction(req, agentId, {
      title: "Marked migration ready",
      text: `manifest: ${body.manifestPath}`,
      producerFactId: migration.id,
    });
  } catch (err) {
    try {
      sendMigrationServiceError(res, err);
    } catch (unhandled) {
      console.error("internal.agent-api.migration-ready error:", unhandled);
      res.status(500).json({ error: "Failed to mark migration ready" });
    }
  }
});

registerAgentApiRoute("migrationArrived", ...agentApiRequestValidators("migrationArrived"), async (req, res) => {
  res.status(409).json({
    error: "Migration arrival must be completed by the target Computer protocol",
    code: "MIGRATION_REQUIRES_COMPUTER_PROTOCOL",
  });
});

registerAgentApiRoute("reminderList", ...agentApiRequestValidators("reminderList"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const statusFilter = parseReminderStatusFilter(req, res);
    if (!statusFilter) return;

    const rows = await reminderCrud.listAppReminders({
      serverId,
      ownerAgentId: agentId,
      status: statusFilter,
    });
    const summaries = await reminderService.toReminderSummaries(rows, serverId);
    sendAgentApiResponse("reminderList", res, { reminders: summaries });
  } catch (err) {
    console.error("internal.agent-api.reminder-list error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to list reminders" });
  }
});

registerAgentApiRoute("reminderCreate", ...agentApiRequestValidators("reminderCreate"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const body = req.body as AgentApiRequestBodyByRoute["reminderCreate"];
    const { title, fireAt, delaySeconds, msgId, payload, repeat, tz, channel } = body;
    if (typeof title !== "string" || title.trim().length === 0) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    if (title.length > REMINDER_MAX_TITLE_LEN) {
      res.status(400).json({ error: `title must be at most ${REMINDER_MAX_TITLE_LEN} characters` });
      return;
    }

    const recurrence = parseReminderRecurrence(repeat, tz, res);
    if (recurrence === undefined) return;

    const hasScheduleInput = delaySeconds != null || fireAt != null;
    let fireAtDate: Date;
    let warning: string | undefined;
    if (hasScheduleInput) {
      const schedule = resolveScheduleInput({ delaySeconds, fireAt }, Date.now());
      if (!schedule.ok) {
        res.status(400).json({ error: schedule.error });
        return;
      }
      fireAtDate = schedule.fireAt;
      warning = schedule.warning;
    } else if (recurrence) {
      fireAtDate = computeNextFire(recurrence, new Date());
    } else {
      res.status(400).json({ error: "Provide delaySeconds, fireAt, or repeat" });
      return;
    }

    if (typeof msgId !== "string" || msgId.length === 0) {
      res.status(400).json({ error: "msgId is required for agent-created reminders" });
      return;
    }
    const resolved = await resolveReminderMsgIdForAgentApi(serverId, agentId, msgId);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }

    let targetChannelId: string | null = null;
    if (channel != null) {
      if (typeof channel !== "string" || channel.length === 0) {
        res.status(400).json({ error: "channel must be a non-empty string" });
        return;
      }
      const ctx = await channelService.resolveChannelByName(serverId, agentId, channel);
      if (!ctx) {
        res.status(404).json({ error: "Agent or channel not found" });
        return;
      }
      targetChannelId = ctx.channelId;
    }

    const row = await reminderCrud.createAppReminder({
      serverId,
      ownerAgentId: agentId,
      targetChannelId,
      msgId: resolved.messageId,
      title: title.trim(),
      fireAt: fireAtDate,
      payload: payload ?? null,
      recurrence,
      createdBy: { type: "agent", id: agentId },
    });
    await syncReminderToComputer(req, row, "upsert");
    const [summary] = await reminderService.toReminderSummaries([row], serverId);
    emitReminderScheduled(req, row, summary);

    const response: AgentApiResponseByRoute["reminderCreate"] = { reminder: summary };
    if (warning) response.warning = warning;
    res.status(201);
    sendAgentApiResponse("reminderCreate", res, response);
    recordRaftCliActivity(req, agentId, {
      command: "reminder.schedule",
      summary: "Scheduled reminder",
      target: summary.msgRef ?? row.id,
      correlationId: row.id,
    });
  } catch (err) {
    console.error("internal.agent-api.reminder-create error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to create reminder" });
  }
});

registerAgentApiRoute("reminderCancel", ...agentApiRequestValidators("reminderCancel"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const { reminderId } = req.params as AgentApiRequestParamsByRoute["reminderCancel"];
    const existing = await loadOwnedReminder(reminderId, serverId, agentId);
    if (!existing) {
      res.status(404).json({ error: "Reminder not found" });
      return;
    }
    if (existing.status !== "scheduled" && existing.status !== "fired") {
      res.status(409).json({ error: `Reminder is already ${existing.status}` });
      return;
    }

    const canceled = await reminderCrud.cancelAppReminder(reminderId, {
      actor: { type: "agent", id: agentId },
      expectedVersion: existing.version,
    });
    if (!canceled) {
      res.status(409).json({ error: "Reminder state changed; refresh and retry" });
      return;
    }
    await syncReminderToComputer(req, canceled, "cancel");

    const [summary] = await reminderService.toReminderSummaries([canceled], serverId);
    const io = req.app.get("io") as SocketServer;
    io?.to(`server:${canceled.serverId}`).emit("reminder:canceled", {
      reminderId: canceled.id,
      ownerAgentId: canceled.ownerAgentId,
    });

    sendAgentApiResponse("reminderCancel", res, { reminder: summary });
    recordRaftCliActivity(req, agentId, {
      command: "reminder.cancel",
      summary: "Canceled reminder",
      target: summary.msgRef ?? canceled.id,
      correlationId: canceled.id,
    });
  } catch (err) {
    console.error("internal.agent-api.reminder-cancel error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to cancel reminder" });
  }
});

registerAgentApiRoute("reminderSnooze", ...agentApiRequestValidators("reminderSnooze"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const { reminderId } = req.params as AgentApiRequestParamsByRoute["reminderSnooze"];
    const { delaySeconds } = req.body as AgentApiRequestBodyByRoute["reminderSnooze"];
    const schedule = resolveScheduleInput({ delaySeconds }, Date.now());
    if (!schedule.ok) {
      res.status(400).json({ error: schedule.error });
      return;
    }

    const existing = await loadOwnedReminder(reminderId, serverId, agentId);
    if (!existing) {
      res.status(404).json({ error: "Reminder not found" });
      return;
    }
    if (existing.status !== "scheduled" && existing.status !== "fired") {
      res.status(409).json({
        error: `Reminder ${existing.id} is ${existing.status}; only scheduled or fired reminders can be snoozed`,
      });
      return;
    }

    const snoozed = await reminderCrud.snoozeAppReminder(existing.id, Number(delaySeconds), {
      actor: { type: "agent", id: agentId },
      expectedVersion: existing.version,
    });
    if (!snoozed) {
      res.status(409).json({ error: "Reminder state changed; refresh and retry" });
      return;
    }
    await syncReminderToComputer(req, snoozed, "upsert");

    const [summary] = await reminderService.toReminderSummaries([snoozed], serverId);
    emitReminderScheduled(req, snoozed, summary);
    sendAgentApiResponse("reminderSnooze", res, { reminder: summary });
    recordRaftCliActivity(req, agentId, {
      command: "reminder.snooze",
      summary: "Snoozed reminder",
      target: summary.msgRef ?? snoozed.id,
      correlationId: snoozed.id,
    });
  } catch (err) {
    console.error("internal.agent-api.reminder-snooze error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to snooze reminder" });
  }
});

registerAgentApiRoute("reminderUpdate", ...agentApiRequestValidators("reminderUpdate"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const { reminderId } = req.params as AgentApiRequestParamsByRoute["reminderUpdate"];
    const body = req.body as AgentApiRequestBodyByRoute["reminderUpdate"];

    const existing = await loadOwnedReminder(reminderId, serverId, agentId);
    if (!existing) {
      res.status(404).json({ error: "Reminder not found" });
      return;
    }
    if (existing.status === "fired") {
      res.status(409).json({
        error: `Reminder ${existing.id} is fired; snooze it back to scheduled before updating, or schedule a new reminder`,
      });
      return;
    }
    if (existing.status !== "scheduled") {
      res.status(409).json({ error: `Reminder ${existing.id} is ${existing.status}` });
      return;
    }

    const { fireAt, delaySeconds, repeat, title, tz } = body;
    const mutations = [
      fireAt != null || delaySeconds != null ? "time" : null,
      repeat != null ? "repeat" : null,
      title != null ? "title" : null,
    ].filter(Boolean);
    if (mutations.length !== 1) {
      res.status(400).json({ error: "update requires exactly one of fireAt/delaySeconds, repeat, or title" });
      return;
    }

    let patch: reminderService.ReminderUpdatePatch;
    let warning: string | undefined;
    if (fireAt != null || delaySeconds != null) {
      const schedule = resolveScheduleInput({ fireAt, delaySeconds }, Date.now());
      if (!schedule.ok) {
        res.status(400).json({ error: schedule.error });
        return;
      }
      warning = schedule.warning;
      patch = fireAt != null
        ? { kind: "fireAt", fireAt: schedule.fireAt }
        : { kind: "delay", delaySeconds: Number(delaySeconds) };
    } else if (repeat != null) {
      const recurrence = parseReminderRecurrence(repeat, tz, res);
      if (!recurrence) return;
      patch = { kind: "recurrence", recurrence };
    } else {
      if (typeof title !== "string" || title.trim().length === 0) {
        res.status(400).json({ error: "title must be a non-empty string" });
        return;
      }
      if (title.length > REMINDER_MAX_TITLE_LEN) {
        res.status(400).json({ error: `title must be at most ${REMINDER_MAX_TITLE_LEN} characters` });
        return;
      }
      patch = { kind: "title", title: title.trim() };
    }

    const updated = await reminderCrud.updateAppReminder(existing.id, patch, {
      actor: { type: "agent", id: agentId },
      expectedVersion: existing.version,
    });
    if (!updated) {
      res.status(409).json({ error: "Reminder state changed; refresh and retry" });
      return;
    }
    await syncReminderToComputer(req, updated, "upsert");

    const [summary] = await reminderService.toReminderSummaries([updated], serverId);
    emitReminderScheduled(req, updated, summary);
    const response: AgentApiResponseByRoute["reminderUpdate"] = { reminder: summary };
    if (warning) response.warning = warning;
    sendAgentApiResponse("reminderUpdate", res, response);
    recordRaftCliActivity(req, agentId, {
      command: "reminder.update",
      summary: "Updated reminder",
      target: summary.msgRef ?? updated.id,
      correlationId: updated.id,
    });
  } catch (err) {
    console.error("internal.agent-api.reminder-update error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to update reminder" });
  }
});

registerAgentApiRoute("appSourceAck", ...agentApiRequestValidators("appSourceAck"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const body = req.body as AgentApiRequestBodyByRoute["appSourceAck"];
    const ack = await ackBuiltInAppSource({
      ...body,
      serverId,
      actingAgentId: agentId,
    });
    if (!ack.ok) {
      res.status(ack.status).json(ack.body);
      return;
    }

    sendAgentApiResponse("appSourceAck", res, ack.response);
  } catch (err) {
    console.error("internal.agent-api.app-source-ack error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to acknowledge app source" });
  }
});

registerAgentApiRoute("reminderLog", ...agentApiRequestValidators("reminderLog"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const { reminderId } = req.params as AgentApiRequestParamsByRoute["reminderLog"];
    const resolved = await reminderCrud.resolveAppHistoricalReminderIdForOwner(reminderId, serverId, agentId);
    if (resolved.kind === "ambiguous") {
      res.status(409).json({ error: "Reminder id prefix is ambiguous" });
      return;
    }
    if (resolved.kind !== "resolved") {
      res.status(404).json({ error: "Reminder not found" });
      return;
    }

    const events = await reminderCrud.listAppReminderEventsForOwner(resolved.reminderId, serverId, agentId);
    sendAgentApiResponse("reminderLog", res, {
      events: reminderService.toReminderEventSummaries(events),
    });
  } catch (err) {
    console.error("internal.agent-api.reminder-log error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to read reminder log" });
  }
});

function sendRapAppConfigError(res: Response, error: RapAppConfigError): void {
  const status = error.code === "RAP_APP_CONFIG_APP_UNKNOWN"
    ? 404
    : error.code === "RAP_APP_CONFIG_OWNER_MISMATCH"
      ? 403
      : error.code === "RAP_APP_CONFIG_REVISION_STALE"
        ? 409
        : error.code === "RAP_APP_CONFIG_STORED_INVALID"
          ? 500
          : 400;
  res.status(status).json({
    error: error.message,
    errorCode: error.code,
    ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
  });
}

registerAgentApiRoute("appConfigGet", ...agentApiRequestValidators("appConfigGet"), async (req, res) => {
  try {
    const { appId } = req.params as AgentApiRequestParamsByRoute["appConfigGet"];
    const snapshot = await getRapAppConfig({
      serverId: req.serverId!,
      subjectAgentId: req.actingAgentId!,
      appId,
    });
    sendAgentApiResponse("appConfigGet", res, { ...snapshot });
  } catch (error) {
    if (error instanceof RapAppConfigError) {
      sendRapAppConfigError(res, error);
      return;
    }
    console.error("internal.agent-api.app-config-get error:", serializeErrorForLog(error));
    res.status(500).json({ error: "Failed to read RAP App config" });
  }
});

registerAgentApiRoute("appConfigPatch", ...agentApiRequestValidators("appConfigPatch"), async (req, res) => {
  try {
    const serverId = req.serverId!;
    const subjectAgentId = req.actingAgentId!;
    const { appId } = req.params as AgentApiRequestParamsByRoute["appConfigPatch"];
    const body = req.body as AgentApiRequestBodyByRoute["appConfigPatch"];
    const snapshot = await patchRapAppConfig({
      serverId,
      subjectAgentId,
      appId,
      expectedRevision: body.expectedRevision,
      set: body.set,
      unset: body.unset,
    });
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    // Task #204: a durable config change must reach the owner's Computer. This
    // is best-effort by design — an offline machine refills on reconnect — so a
    // push failure must not fail the mutation the caller already committed.
    try {
      await pushBuiltInAppConfigForOwner({
        appId,
        serverId,
        ownerAgentId: subjectAgentId,
        orchestrator,
      });
    } catch (pushError) {
      console.error("internal.agent-api.app-config-push error:", pushError);
    }
    sendAgentApiResponse("appConfigPatch", res, { ...snapshot });
    recordRaftCliActivity(req, subjectAgentId, {
      command: "app.config",
      summary: `Updated ${appId} config`,
      target: appId,
      correlationId: `${appId}:${snapshot.revision}`,
    });
  } catch (error) {
    if (error instanceof RapAppConfigError) {
      sendRapAppConfigError(res, error);
      return;
    }
    console.error("internal.agent-api.app-config-patch error:", serializeErrorForLog(error));
    res.status(500).json({ error: "Failed to update RAP App config" });
  }
});

registerAgentApiRoute("actionPrepare", ...agentApiRequestValidators("actionPrepare"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    if (!await requireBoundAgentScope(req, res, agentId, "action:prepare")) return;

    const body = req.body as AgentApiRequestBodyByRoute["actionPrepare"];
    const actionType = typeof body.action.type === "string" ? body.action.type : null;
    if (
      actionType === "integration:approve_agent_login"
      || actionType === "integration:install_marketplace_app"
      || actionType === "integration:register_app"
      || actionType === "integration:update_app_registration"
    ) {
      res.status(400).json({
        error: "integration action cards must be created by raft integration commands",
        errorCode: "ACTION_TYPE_NOT_PREPARABLE",
      });
      return;
    }

    const target = body.target.trim();
    const resolved = await resolveWritableAgentTarget(serverId, agentId, target);
    if (resolved === "forbidden") {
      res.status(403).json({ error: forbiddenMessageForTarget(target) });
      return;
    }
    if (resolved === "peer-not-found") {
      res.status(404).json({ error: `User or agent not found: @${target.slice(4)}` });
      return;
    }
    if (resolved === "self-dm") {
      res.status(400).json({ error: "Cannot create a DM with yourself" });
      return;
    }
    if (!resolved) {
      res.status(400).json({ error: `Could not resolve target: ${body.target}` });
      return;
    }

    const io = (req.app.get("io") ?? null) as Parameters<typeof actionCardsService.prepareActionCard>[0]["io"];
    const out = await actionCardsService.prepareActionCard({
      serverId,
      requesterAgentId: agentId,
      targetChannelId: resolved.channelId,
      action: body.action,
      io: io ?? null,
    });
    res.status(201);
    sendAgentApiResponse("actionPrepare", res, { messageId: out.messageId, metadata: { ...out.metadata } });
    recordRaftCliActivity(req, agentId, {
      command: "action.prepare",
      summary: "Prepared action card",
      target,
      correlationId: out.messageId,
    });
  } catch (err) {
    if (err instanceof actionCardsService.ActionCardError) {
      res.status(err.status).json({ error: err.message, errorCode: err.code });
      return;
    }
    console.error("internal.agent-api.prepare-action error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to prepare action card" });
  }
});
