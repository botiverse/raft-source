import { serializeErrorForLog } from "../tracing/safeErrorLog.js";
// LEGACY AGENT API SURFACE: DO NOT ADD OR EXPAND ROUTES HERE.
//
// This router exists for old daemon builds and compatibility clients that
// still hold a machine token. New managed-runner launches must mint an
// `sk_agent_*` credential and use `/internal/agent-api/*`; #1836 deliberately
// does not use this legacy surface as an in-process fallback when runner
// credential mint fails. The release safety story for new daemon builds is
// server-first rollout plus daemon binary rollback.
//
// `/internal/agent/:id/*` is the legacy machine-on-behalf agent surface. It is
// kept only for compatibility until it can be deleted; new agent-facing APIs
// belong on the contract-backed `/internal/agent-api/*` surface.
//
// Keep auth/router adapter concerns here. When sharing implementation with
// `/internal/agent-api/*`, extract principal-agnostic service/use-case helpers
// that receive an already-authorized actor value instead of branching on
// machine-vs-runner principal inside shared core.
import { Router, type Request, type RequestHandler, type Response, type Router as RouterType } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import * as messageService from "../services/messageService.js";
import * as channelService from "../services/channelService.js";
import * as agentService from "../services/agentService.js";
import * as machineService from "../services/machineService.js";
import * as serverService from "../services/serverService.js";
import * as taskService from "../services/taskService.js";
import {
  getTaskRealtimeSurfaceTargets,
  resolveTaskChannelSurface,
} from "../services/taskChannelSurface.js";
import * as searchService from "../services/searchService.js";
import * as reminderCrud from "../apps/reminder/crud.js";
import * as reminderService from "../apps/reminder/service.js";
import * as oauthService from "../services/oauthService.js";
import { resolveScheduleInput } from "../services/reminderScheduleInput.js";
import { parseRecurrenceString, computeNextFire, formatRecurrence, type Recurrence } from "../services/recurrence.js";
import * as agentPermalinkRenderService from "../services/agentPermalinkRenderService.js";
import * as actionCardsService from "../services/actionCardsService.js";
import * as attestedSendService from "../services/attestedSendService.js";
import { emitScopeReadUpdated } from "../services/readReceiptService.js";
import { emitThreadFollowersUpdated } from "../services/threadFollowerRealtimeService.js";
import { emitTaskCreated, emitTaskMessageNew } from "../services/taskRealtimeEvents.js";
import {
  describeTaskMutation,
  emitTaskMutationToSurfaces,
} from "../services/taskMutationBroadcast.js";
import {
  loadCanonicalTaskFactsByMessageId,
  refreshQueuedAgentTaskProjections,
  withProjectedTaskFacts,
} from "../services/messageTaskProjection.js";
import { projectRichMessageSocketPayload } from "../services/messageRealtimeEvents.js";
import { mutateMessageReaction } from "../services/messageReactionService.js";
import { buildMachineReadModel } from "../services/machineReadModel.js";
import { getLatestDaemonVersion } from "../services/daemonVersionService.js";
import { resolveSearchSenderFilter } from "../services/searchSenderFilterService.js";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions.js";
import { getServerPlan, getHistoryCutoff, isChannelReadOnlyByBillingFeature, isChannelReadOnlyByQuota } from "../services/planService.js";
import {
  PLAN_CONFIG,
  DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY,
  buildApmFreshnessDecisionProducerFactId,
  projectApmHeldFreshnessActivity,
  projectApmHeldFreshnessEnvelope,
  getEffectiveLimits,
  getServerCapabilities,
  renderThirdPartyInertText,
  isReminderStatus,
  isTaskStatus,
  legacyAgentSendBodySchema,
  type AgentMessage,
  type AgentProfileView,
  type HumanProfileView,
  type ProfileCreatedAgentSummary,
  type ProfileCreatorSummary,
  type ProfileView,
  type ReminderStatus,
  type ServerPlan,
  type TaskStatus,
  type ActionCardAction,
  type ApmFreshnessHeldDecision,
  asMachineId,
} from "@botiverse/raft-shared";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";
import type { Server as SocketServer } from "socket.io";
import { getFlyInstanceForMachine } from "../replicaRouter.js";
import { getDb } from "../db/index.js";
import { getAppUrl } from "../config/appUrl.js";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  jointChannels,
  jointChannelServers,
  messages,
  users,
} from "../db/schema.js";
import { and, desc, eq, gt, not, sql } from "drizzle-orm";
import { getStorage, getCdnStorage, isStorageTimeoutError } from "../services/storageService.js";
import {
  FileUploadQuotaExceededError,
  buildFileUploadQuotaExceededResponse,
} from "../services/fileUploadQuotaService.js";
import { uploadAttachmentBuffers } from "../services/attachmentUploadWriterService.js";
import {
  buildAttachmentTooLargeResponse,
  canGenerateImagePreview,
  generateThumbnail,
  generateSvgRasterPreview,
  getThumbnailUrl,
  getAttachmentsForMessages,
  isEmptyUploadedFile,
  isOversizedUploadedFile,
  isSvgAttachmentMimeType,
  normalizeAttachmentFilename,
  normalizeUploadedMimeType,
  resolveAttachmentMimeType,
  resolveRequestAttachmentFileSizeLimitBytes,
  runSingleAttachmentUpload,
} from "./attachments.js";
import { applyHistoryThreadMetadata, getHistoryThreadParentMessageIds } from "./historyThreadMetadata.js";
import { paginateHistoryProbe } from "./historyCursor.js";
import { forbiddenMessageForTarget, notFoundMessageForTarget, resolveWritableAgentTarget } from "./agentWritableTarget.js";
import { createScopeAttestation } from "../lib/scopeAttestation.js";
import { messageIdShortPrefixConditions, UUID_RE } from "../lib/messageId.js";
import { requireAgentScope } from "../middleware/agentScope.js";
import { AGENT_CREDENTIAL_BRIDGE_MACHINE_ID } from "../middleware/agentCredentialBridge.js";
import * as agentScopesService from "../services/agentScopesService.js";
import { addTraceEvent, getCurrentTraceContext, getCurrentTraceSpan, tracePhase } from "../tracing/semanticTrace.js";
import {
  createAvatarUpload,
  MAX_PROFILE_AVATAR_BYTES,
  PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
  PROFILE_AVATAR_TOO_LARGE_MESSAGE,
  runSingleAvatarUpload,
  storeAgentAvatar,
  storeServerAvatar,
} from "../services/avatarService.js";
import { handleAgentKnowledgeGet, handleAgentKnowledgeSearch } from "./agentKnowledge.js";
import { AttachmentLinkError } from "../services/attachmentLinkingService.js";
import { getActorServerRoleInServer } from "../lib/actorPermissions.js";
import { bindRequestAbortSignal } from "./requestAbortSignal.js";
import { createChannelForAgent } from "./agentChannelCreate.js";
import { addChannelMemberForAgent, removeChannelMemberForAgent } from "./agentChannelMembers.js";
import { updateChannelForAgent } from "./agentChannelUpdate.js";
import { sendJsonServerError } from "./errorResponse.js";
import { assertAgentCanManageServerProfile, updateServerProfileForAgent } from "./agentServerManage.js";

export const internalRouter: RouterType = Router();

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
    // Lifecycle commit remains authoritative; arm watchdog/snapshot retries.
    console.warn(`[reminder] Computer sync failed for ${row.id}@${row.version}:`, serializeErrorForLog(error));
  }
}

const MAX_REACTION_LENGTH = 16;
const ATTESTED_SEND_HELD_CONTEXT_LIMIT = 3;
type AgentVisibleHuman = {
  id?: string | null;
  userId?: string | null;
  serverSlug?: string | null;
  role?: string | null;
};

export async function filterAgentVisibleHumansForHiddenDirectory<T extends AgentVisibleHuman>(
  serverId: string,
  agentId: string,
  humans: T[],
): Promise<T[]> {
  if (!await serverService.shouldHideHumanDirectoryFromAgentRequester(serverId, agentId)) {
    return humans;
  }
  return humans.filter((human) => serverService.shouldExposeHumanInHiddenDirectory(human, null));
}

function parseReactionEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const emoji = value.trim();
  if (!emoji || emoji.length > MAX_REACTION_LENGTH || /\s/.test(emoji)) return null;
  return emoji;
}

async function loadVisibleMessageForAgent(
  messageId: string,
  agentId: string,
  serverId: string,
  res: Response,
): Promise<NonNullable<Awaited<ReturnType<typeof messageService.getMessage>>> | null> {
  const resolvedMessageId = await messageService.resolveMessageIdVisibleToAgent(serverId, agentId, messageId);
  if (!resolvedMessageId.ok) {
    res.status(resolvedMessageId.status).json({ error: resolvedMessageId.error });
    return null;
  }
  const message = await messageService.getMessage(resolvedMessageId.messageId);
  if (!message) {
    res.status(404).json({ error: "Message not found" });
    return null;
  }

  const channel = await channelService.getChannel(message.channelId);
  if (!channel || channel.serverId !== serverId) {
    res.status(404).json({ error: "Message not found" });
    return null;
  }

  const canAccess = await channelService.canAgentAccessChannel(message.channelId, agentId);
  if (!canAccess) {
    res.status(404).json({ error: "Message not found" });
    return null;
  }

  return message;
}

async function canAgentAccessQueuedMessageTarget(
  message: AgentMessage,
  agentId: string,
  serverId: string,
): Promise<boolean> {
  if (message.third_party_event) return true;
  try {
    const channel = await channelService.getChannel(message.channel_id);
    if (!channel || channel.serverId !== serverId) return false;
    return channelService.canAgentReceiveChannelDelivery(message.channel_id, agentId, {
      personalMention: message.mentioned === true,
    });
  } catch {
    return false;
  }
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

async function recordAgentRaftAction(
  req: Request,
  agentId: string,
  event: Parameters<AgentOrchestrator["recordAgentRaftAction"]>[1],
): Promise<void> {
  const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
  if (typeof agentOrchestrator?.recordAgentRaftAction !== "function") return;
  await agentOrchestrator.recordAgentRaftAction(agentId, event);
}

function formatAttestedMessageCount(count: number): string {
  return `${count} newer message${count === 1 ? "" : "s"}`;
}

function toAgentFacingActorType(type: "user" | "agent" | "external_projection"): "human" | "agent" | "third_party_app" {
  return type === "external_projection" ? "third_party_app" : type === "user" ? "human" : "agent";
}

export async function buildServerInfoAgentSummaries(
  serverId: string,
  agentOrchestrator?: AgentOrchestrator,
) {
  const allAgentsList = await agentService.listAgents(serverId);
  return Promise.all(allAgentsList.map(async (a) => {
    const visibleActivity = agentOrchestrator
      ? await agentOrchestrator.getActivity(a.id, { parent: getCurrentTraceContext() })
      : null;
    const resolvedRole = await getActorServerRoleInServer(serverId, "agent", a.id);
    return {
      name: a.name,
      description: a.description,
      status: a.status,
      activity: visibleActivity?.activity ?? null,
      activityDetail: visibleActivity?.activityDetail ?? "",
      role: resolvedRole === "guest" ? null : resolvedRole,
    };
  }));
}

export function messageResolveErrorPayload(resolved: { ok: false; error: string }) {
  if (/ambiguous/i.test(resolved.error)) {
    return {
      error: resolved.error,
      errorCode: "AMBIGUOUS_ID",
      suggestedNextAction: "Use the full message UUID instead of the 8-character short id.",
    };
  }
  if (/must be/i.test(resolved.error)) {
    return {
      error: resolved.error,
      errorCode: "INVALID_ARG",
    };
  }
  return {
    error: resolved.error,
    errorCode: "NOT_FOUND",
  };
}

function isHistoryAnchorShape(value: string): boolean {
  return /^\d+$/.test(value) || /^[0-9a-f]{8}$/i.test(value) || UUID_RE.test(value);
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

export async function buildAgentResolvedMessagePayload(
  resolvedMessage: messageService.EnrichedMessageRow,
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  serverId: string,
  requestingAgentId: string,
) {
  // v1.4: task facts live in `tasks`; project them onto the host message so the
  // agent-facing `[task #N status=...]` suffix survives the storage move.
  const [message] = await withProjectedTaskFacts([resolvedMessage]);
  const external = message.senderType === "external_projection";
  const sender = message.messageType === "system"
    ? { name: "system", description: null }
    : message.senderType === "user"
      ? await getDb().select({ name: users.name, description: users.description }).from(users).where(eq(users.id, message.senderId)).then((rows) => rows[0] ?? null)
      : message.senderType === "external_projection"
        ? { name: message.externalAuthor?.displayName ?? "External user", description: null }
        : await agentService.getAgent(message.senderId);
  let parentChannel: Awaited<ReturnType<typeof channelService.getChannel>> | null = null;
  if (channel.type === "thread" && channel.parentMessageId) {
    const parentMessage = await messageService.getMessage(channel.parentMessageId);
    parentChannel = parentMessage ? await channelService.getChannel(parentMessage.channelId) : null;
  }
  const channelName = channel.type === "dm"
    ? await resolveDmChannelNameForAgent(channel.id, requestingAgentId)
    : channel.name;
  const parentChannelName = parentChannel?.type === "dm"
    ? await resolveDmChannelNameForAgent(parentChannel.id, requestingAgentId)
    : parentChannel?.name ?? null;
  if (!channelName || (parentChannel?.type === "dm" && !parentChannelName)) {
    return null;
  }
  const taskAssigneeName = !external && message.taskAssigneeId
    ? message.taskAssigneeType === "user"
      ? await getDb().select({ name: users.name }).from(users).where(eq(users.id, message.taskAssigneeId)).then((rows) => rows[0]?.name ?? null)
      : await agentService.getAgent(message.taskAssigneeId).then((agent) => agent?.name ?? null)
    : null;
  const [renderedContent] = await agentPermalinkRenderService.renderAgentReadablePermalinksInTexts(
    [message.content],
    serverId,
  );
  const attachmentMap = await getAttachmentsForMessages([message.id]);
  const resolvedAttachments = attachmentMap.get(message.id) ?? [];
  return {
    message_id: message.id,
    seq: message.seq,
    channel_type: channel.type === "thread"
      ? "thread"
      : channel.type === "dm"
        ? "dm"
        : channel.type === "private"
          ? "private"
          : "channel",
    channel_name: channel.type === "thread" && channel.parentMessageId
      ? channel.parentMessageId.slice(0, 8)
      : channelName,
    parent_channel_type: parentChannel
      ? parentChannel.type === "dm" ? "dm" : parentChannel.type === "private" ? "private" : "channel"
      : null,
    parent_channel_name: parentChannelName,
    timestamp: message.createdAt.toISOString(),
    sender_type: message.messageType === "system" ? "system" : toAgentFacingActorType(message.senderType),
    sender_name: sender?.name ?? "unknown",
    sender_description: sender?.description ?? null,
    ...messageService.toAgentVisibleExternalMessage(message),
    content: messageService.appendAgentFacingForwardedSnapshot(
      messageService.renderAgentVisibleMessageContent(message, renderedContent),
      external ? null : "actionMetadata" in message ? message.actionMetadata : null,
    ),
    attachments: resolvedAttachments.map((attachment) => ({
      id: attachment.id,
      filename: normalizeAttachmentFilename(attachment.filename),
      mimeType: resolveAttachmentMimeType(attachment.filename, attachment.mimeType),
      sizeBytes: attachment.sizeBytes,
      width: attachment.width,
      height: attachment.height,
      thumbnailUrl: getThumbnailUrl(attachment.thumbnailKey),
    })),
    task_status: external ? null : message.taskStatus,
    task_number: external ? null : message.taskNumber,
    task_assignee_type: !external && message.taskAssigneeType ? toAgentFacingActorType(message.taskAssigneeType) : null,
    task_assignee_id: external ? null : message.taskAssigneeId,
    task_assignee_name: external ? null : taskAssigneeName,
    ...(!external && message.taskCurrentProjection && {
      task_current_projection: {
        title: message.taskCurrentProjection.title,
        description: message.taskCurrentProjection.description,
        revision: message.taskCurrentProjection.revision,
        superseded: message.taskCurrentProjection.superseded,
        amended_at: message.taskCurrentProjection.amendedAt?.toISOString() ?? null,
        amended_by_type: message.taskCurrentProjection.amendedByType,
        amended_by_name: message.taskCurrentProjection.amendedByName,
        source: message.taskCurrentProjection.source,
      },
    }),
  };
}

export async function resolveAgentVisibleMessagePayload(
  messageId: string,
  serverId: string,
  requestingAgentId: string,
) {
  const message = await messageService.getMessage(messageId);
  if (!message) return null;

  const storageChannel = await channelService.getChannel(message.channelId);
  if (!storageChannel) return null;

  const jointProjections = await channelService.getActiveJointChannelProjectionsByLocalChannel(message.channelId);
  const localProjection = jointProjections.find((projection) => projection.serverId === serverId);
  if (localProjection) {
    const localChannel = await channelService.getChannel(localProjection.localChannelId);
    if (!localChannel) return null;
    const canAccessProjection = await channelService.canAgentAccessChannel(localProjection.localChannelId, requestingAgentId);
    if (!canAccessProjection) return null;
    const [viewerScopedMessage] = await messageService.listMessagesByIds([message.id], {
      forwardedBundleViewerAgentId: requestingAgentId,
      forwardedBundleViewerServerId: serverId,
    });
    if (!viewerScopedMessage) return null;
    return buildAgentResolvedMessagePayload(
      { ...viewerScopedMessage, channelId: localProjection.localChannelId },
      localChannel,
      serverId,
      requestingAgentId,
    );
  }

  if (storageChannel.serverId !== serverId) return null;
  const canAccess = await channelService.canAgentAccessChannel(message.channelId, requestingAgentId);
  if (!canAccess) return null;
  const [viewerScopedMessage] = await messageService.listMessagesByIds([message.id], {
    forwardedBundleViewerAgentId: requestingAgentId,
    forwardedBundleViewerServerId: serverId,
  });
  if (!viewerScopedMessage) return null;
  return buildAgentResolvedMessagePayload(viewerScopedMessage, storageChannel, serverId, requestingAgentId);
}

async function resolveDmChannelNameForAgent(
  channelId: string,
  requestingAgentId: string,
): Promise<string | null> {
  const db = getDb();
  const humanPeers = await db
    .select({ name: users.name })
    .from(channelHumans)
    .innerJoin(users, eq(channelHumans.userId, users.id))
    .where(eq(channelHumans.channelId, channelId));
  if (humanPeers.length === 1 && humanPeers[0]?.name) return humanPeers[0].name;
  if (humanPeers.length > 1) return null;

  const agentPeers = await db
    .select({ id: agents.id, name: agents.name })
    .from(channelAgents)
    .innerJoin(agents, eq(channelAgents.agentId, agents.id))
    .where(eq(channelAgents.channelId, channelId));
  const peerAgents = agentPeers.filter((agent) => agent.id !== requestingAgentId);
  return peerAgents.length === 1 ? peerAgents[0]?.name ?? null : null;
}

function serializeOAuthClientForAgent(
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
      : client.description,
    homepageUrl: client.homepageUrl,
    returnUrl: client.returnUrl,
    agentManifestUrl: agentManifest.url,
    agentManifestUrlSource: agentManifest.source,
    allowedScopes: client.allowedScopes ?? [],
    createdAt: client.createdAt.toISOString(),
    updatedAt: client.updatedAt.toISOString(),
  };
}

function normalizeAgentLoginScopes(
  raw: unknown,
  client: Pick<oauthService.OAuthClientRecord, "clientId" | "allowedScopes">,
): string[] {
  if (raw === undefined || raw === null) {
    const scopes = oauthService.defaultAgentLoginScopes(client);
    if (scopes.length === 0) throw new Error("invalid_scope");
    return scopes;
  }
  return oauthService.normalizeAgentRequestedScopes(raw, client);
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

function optionalString(raw: unknown): string | undefined {
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

function classifyAgentSendTarget(raw: unknown): "channel" | "thread" | "dm" | "legacy_dm" | "unknown" {
  if (typeof raw !== "string") return "unknown";
  if (raw.startsWith("dm:@")) return "dm";
  if (raw.startsWith("@")) return "legacy_dm";
  if (raw.includes(":")) return "thread";
  if (raw.startsWith("#")) return "channel";
  return "unknown";
}

const validateLegacyAgentSendBody: RequestHandler<{ id: string }> = (req, res, next) => {
  const parsed = legacyAgentSendBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid legacy agent send body",
      code: "legacy_agent_send_contract_invalid",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }
  req.body = parsed.data;
  next();
};

/**
 * Validate that the requesting machine owns the agent (agent.machineId === req.machineId).
 * Prevents a machine from impersonating agents assigned to a different machine.
 */
function verifyMachineOwnsAgent(
  agent: { machineId: string | null; serverId: string },
  machineId: string | undefined,
  serverId: string | undefined,
): string | null {
  if (agent.serverId !== serverId) return "Agent not found";
  if (machineId === AGENT_CREDENTIAL_BRIDGE_MACHINE_ID && agent.machineId === null) return null;
  if (!machineId || agent.machineId !== machineId) return "This agent is not assigned to your machine";
  return null; // OK
}

type OwnedMachineAgentResult =
  | {
      agent: NonNullable<Awaited<ReturnType<typeof agentService.getAgent>>>;
    }
  | {
      status: 401 | 403 | 404;
      error: string;
    };

async function loadOwnedMachineAgent(
  agentId: string,
  machineId: string | undefined,
  serverId: string | undefined,
): Promise<OwnedMachineAgentResult> {
  if (!machineId || !serverId) {
    return { status: 401, error: "Machine authentication required" };
  }

  const agent = await agentService.getAgent(agentId);
  if (!agent) {
    return { status: 404, error: "Agent not found" };
  }

  const ownerErr = verifyMachineOwnsAgent(agent, machineId, serverId);
  if (ownerErr) {
    return { status: ownerErr === "Agent not found" ? 404 : 403, error: ownerErr };
  }

  return { agent };
}

function normalizeProfileTarget(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new Error("target must be a string");
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("target must not be empty");
  }
  if (!trimmed.startsWith("@")) {
    throw new Error("target must start with @");
  }

  const handle = trimmed.slice(1).trim();
  if (!handle) {
    throw new Error("target handle must not be empty");
  }
  return handle;
}

function toProfileCreatedAgentSummary(agent: {
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  runtime: string;
  status: string;
}): ProfileCreatedAgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    displayName: agent.displayName,
    avatarUrl: agent.avatarUrl,
    runtime: agent.runtime,
    status: agent.status as ProfileCreatedAgentSummary["status"],
  };
}

function toProfileCreatorSummary(
  creator: Awaited<ReturnType<typeof agentService.getAgentCreator>>,
): ProfileCreatorSummary | null {
  if (!creator) return null;
  if (creator.type === "human") {
    return {
      type: "human",
      id: creator.id,
      name: creator.name,
      displayName: creator.displayName,
      avatarUrl: creator.avatarUrl,
      gravatarHash: creator.gravatarHash,
    };
  }

  return {
    type: "agent",
    id: creator.id,
    name: creator.name,
    displayName: creator.displayName,
    avatarUrl: creator.avatarUrl,
    deletedAt: creator.deletedAt ? creator.deletedAt.toISOString() : null,
  };
}

async function buildHumanProfileView(
  serverId: string,
  userId: string,
): Promise<HumanProfileView | null> {
  const members = await serverService.getServerMembers(serverId, null);
  const member = members.find((candidate) => candidate.userId === userId);
  if (!member) return null;
  const createdAgents = await agentService.listCreatedAgents(serverId, "user", userId);

  return {
    kind: "human",
    id: member.userId,
    isSelf: false,
    name: member.name,
    displayName: member.displayName,
    description: member.description,
    avatarUrl: member.avatarUrl,
    email: member.email,
    role: member.role,
    joinedAt: member.joinedAt.toISOString(),
    membershipStatus: "active",
    createdAgents: createdAgents.map(toProfileCreatedAgentSummary),
  };
}

export async function buildAgentProfileView(
  agentId: string,
  selfAgentId: string,
  agentOrchestrator: AgentOrchestrator | undefined,
): Promise<AgentProfileView | null> {
  const agent = await agentService.getAgent(agentId, true);
  if (!agent) return null;

  const creator = await agentService.getAgentCreator(agent);
  const createdAgents = await agentService.listCreatedAgents(agent.serverId, "agent", agent.id);
  const resolvedServerRole = await getActorServerRoleInServer(agent.serverId, "agent", agent.id);
  const serverRole = resolvedServerRole === "guest" ? null : resolvedServerRole;
  const machine = agent.machineId ? await machineService.getMachine(asMachineId(agent.machineId)) : null;
  const daemonVersion = agent.machineId
    ? agentOrchestrator?.getMachineDaemonVersion(agent.machineId) ?? machine?.daemonVersion ?? null
    : null;

  return {
    kind: "agent",
    id: agent.id,
    isSelf: agent.id === selfAgentId,
    name: agent.name,
    displayName: agent.displayName,
    description: agent.description,
    avatarUrl: agent.avatarUrl,
    status: agent.status,
    serverRole,
    runtime: agent.runtime,
    lastRuntimeError: agent.lastRuntimeError ?? null,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort ?? null,
    executionMode: agent.executionMode,
    computerId: agent.machineId,
    computerName: machine?.name ?? null,
    computerHostname: machine?.hostname ?? null,
    daemonVersion,
    creator: toProfileCreatorSummary(creator),
    createdAgents: createdAgents.map(toProfileCreatedAgentSummary),
    createdAt: agent.createdAt.toISOString(),
    deletedAt: agent.deletedAt ? agent.deletedAt.toISOString() : null,
  };
}

export async function resolveProfileViewForAgent(
  serverId: string,
  selfAgentId: string,
  rawTarget: unknown,
  agentOrchestrator: AgentOrchestrator | undefined,
): Promise<
  | { ok: true; profile: ProfileView }
  | { ok: false; status: 400 | 404 | 409; error: string }
> {
  let targetHandle: string | null;
  try {
    targetHandle = normalizeProfileTarget(rawTarget);
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : "Invalid target" };
  }

  if (!targetHandle) {
    const selfProfile = await buildAgentProfileView(selfAgentId, selfAgentId, agentOrchestrator);
    if (!selfProfile) {
      return { ok: false, status: 404, error: "Agent not found" };
    }
    return { ok: true, profile: selfProfile };
  }

  const [humanId, targetAgentId] = await Promise.all([
    channelService.resolveUserByName(serverId, targetHandle),
    channelService.resolveAgentByName(serverId, targetHandle),
  ]);

  if (humanId && targetAgentId) {
    return { ok: false, status: 409, error: `Profile handle @${targetHandle} is ambiguous` };
  }

  if (targetAgentId) {
    const profile = await buildAgentProfileView(targetAgentId, selfAgentId, agentOrchestrator);
    return profile
      ? { ok: true, profile }
      : { ok: false, status: 404, error: `Profile @${targetHandle} not found` };
  }

  if (humanId) {
    const profile = await buildHumanProfileView(serverId, humanId);
    return profile
      ? { ok: true, profile }
      : { ok: false, status: 404, error: `Profile @${targetHandle} not found` };
  }

  return { ok: false, status: 404, error: `Profile @${targetHandle} not found` };
}

const DAEMON_CAPABILITY_TTL_MS = 2 * 60 * 1000;
const DAEMON_CAPABILITY_SCOPE_RE = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/;
const TRACE_BUNDLE_MAX_BYTES = 50 * 1024 * 1024;
type DaemonCapabilityPolicy = {
  audience: string;
  deriveResource: (ctx: { serverId: string; machineId: string }) => string;
  deriveMetadata?: (ctx: { serverId: string; machineId: string }, metadata: Record<string, unknown>) => Record<string, unknown>;
};

const DAEMON_CAPABILITY_POLICIES: Record<string, DaemonCapabilityPolicy> = {
  "feedback-report:create": {
    audience: "feedback-worker",
    deriveResource: ({ serverId, machineId }) => `servers/${serverId}/machines/${machineId}/feedback-reports`,
  },
  "daemon-trace-bundle:create": {
    audience: "trace-ingest-worker",
    deriveResource: ({ serverId, machineId }) => `servers/${serverId}/machines/${machineId}/trace-bundles`,
    deriveMetadata: deriveDaemonTraceBundleMetadata,
  },
};

type CreateDaemonScopeAttestationRequest = {
  scope: string;
  metadata: Record<string, unknown>;
};

function parseDaemonScopeAttestationRequest(raw: unknown): CreateDaemonScopeAttestationRequest {
  if (!raw || typeof raw !== "object") {
    throw new Error("Request body must be a JSON object");
  }

  const body = raw as Record<string, unknown>;
  const scope = typeof body.scope === "string" ? body.scope.trim() : "";

  if (!scope) throw new Error("scope is required");
  if (!DAEMON_CAPABILITY_SCOPE_RE.test(scope)) throw new Error("scope is invalid");
  if (!DAEMON_CAPABILITY_POLICIES[scope]) throw new Error(`Unsupported scope: ${scope}`);
  if (body.audience !== undefined) throw new Error("audience is derived from scope");
  if (body.resource !== undefined) throw new Error("resource is derived from scope");
  if (body.metadata !== undefined && (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
    throw new Error("metadata must be a JSON object");
  }

  return { scope, metadata: (body.metadata as Record<string, unknown> | undefined) ?? {} };
}

/**
 * Closed-set of `deployment.environment` values a trace producer (daemon /
 * Computer / future others) may self-declare. The server's job is to verify
 * the claim is consistent with this server's own deployment, NOT to overwrite
 * it: `deployment.environment` is a property of the producer, not the upload
 * gateway. See contract reasoning in #proj-o11y:99c372c9 (`190440fd`).
 */
const ALLOWED_PRODUCER_DEPLOYMENT_ENVIRONMENTS = new Set([
  "production",
  "staging",
  "dev",
  "test",
  "slockdev",
]);

function resolveServerDeploymentEnvironment(): string {
  return process.env.DEPLOYMENT_ENV || process.env.NODE_ENV || "unknown";
}

/**
 * Decide which `deployment.environment` value to stamp on an uploaded trace
 * bundle's resource attrs, given an optional producer-supplied claim and the
 * server's own deployment context.
 *
 * Policy (per `#proj-o11y:99c372c9` first-principles design):
 *   - producer omits claim → fall back to server's own deployment (backward compat)
 *   - producer claims `dev` → accept iff server is NOT production. This is the
 *     raftdev dogfood path: a staging or local server is allowed to receive
 *     traces from a dev-laptop daemon and surface them in ScopeDB under the
 *     `dev` filter.
 *   - producer claim equals server's own deployment → accept (trivial consistency)
 *   - any other claim → reject. Prevents a daemon from forging
 *     `production`/`staging` against a server it has no business labelling.
 */
function selectDaemonTraceBundleDeploymentEnvironment(
  claimedEnvironment: string | undefined,
  serverEnvironment: string,
): string {
  if (claimedEnvironment === undefined) return serverEnvironment;
  if (!ALLOWED_PRODUCER_DEPLOYMENT_ENVIRONMENTS.has(claimedEnvironment)) {
    throw new Error(`metadata.deploymentEnvironment "${claimedEnvironment}" is not in the allowed producer set`);
  }
  if (claimedEnvironment === serverEnvironment) return claimedEnvironment;
  if (claimedEnvironment === "dev" && serverEnvironment !== "production") return "dev";
  throw new Error(`metadata.deploymentEnvironment "${claimedEnvironment}" is inconsistent with server deployment "${serverEnvironment}"`);
}

function deriveDaemonTraceBundleMetadata(
  ctx: { serverId: string; machineId: string },
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const bundleId = readAttestationString(metadata.bundleId, "metadata.bundleId", 128);
  const bundleSha256 = readAttestationSha256(metadata.bundleSha256, "metadata.bundleSha256");
  const bundleSizeBytes = readAttestationInteger(metadata.bundleSizeBytes, "metadata.bundleSizeBytes", TRACE_BUNDLE_MAX_BYTES);
  const uploadId = randomUUID();
  const bundleContentType = typeof metadata.bundleContentType === "string" && metadata.bundleContentType.length > 0
    ? metadata.bundleContentType
    : "application/x-ndjson";
  const bundleContentEncoding = typeof metadata.bundleContentEncoding === "string" && metadata.bundleContentEncoding.length > 0
    ? metadata.bundleContentEncoding
    : "gzip";
  const claimedDeploymentEnvironment = typeof metadata.deploymentEnvironment === "string"
    && metadata.deploymentEnvironment.length > 0
    ? metadata.deploymentEnvironment
    : undefined;
  const deploymentEnvironment = selectDaemonTraceBundleDeploymentEnvironment(
    claimedDeploymentEnvironment,
    resolveServerDeploymentEnvironment(),
  );
  const result: Record<string, unknown> = {
    uploadId,
    objectKey: `trace-bundles/${ctx.serverId}/${ctx.machineId}/${uploadId}.jsonl.gz`,
    bundleId,
    bundleSha256,
    bundleSizeBytes,
    maxBytes: TRACE_BUNDLE_MAX_BYTES,
    bundleContentType,
    bundleContentEncoding,
    deploymentEnvironment,
  };
  if (typeof metadata.feedbackReportId === "string" && metadata.feedbackReportId.length > 0) {
    result.feedbackReportId = metadata.feedbackReportId;
  }
  if (typeof metadata.agentId === "string" && metadata.agentId.length > 0) {
    result.agentId = metadata.agentId;
  }
  const feedbackReportGeneratedAt = readOptionalAttestationTimestamp(
    metadata.feedbackReportGeneratedAt,
    "metadata.feedbackReportGeneratedAt",
  );
  if (feedbackReportGeneratedAt) result.feedbackReportGeneratedAt = feedbackReportGeneratedAt;
  const feedbackReportWindowStartAt = readOptionalAttestationTimestamp(
    metadata.feedbackReportWindowStartAt,
    "metadata.feedbackReportWindowStartAt",
  );
  if (feedbackReportWindowStartAt) result.feedbackReportWindowStartAt = feedbackReportWindowStartAt;
  const feedbackTranscriptFirstEventAt = readOptionalAttestationTimestamp(
    metadata.feedbackTranscriptFirstEventAt,
    "metadata.feedbackTranscriptFirstEventAt",
  );
  if (feedbackTranscriptFirstEventAt) result.feedbackTranscriptFirstEventAt = feedbackTranscriptFirstEventAt;
  const feedbackTranscriptLastEventAt = readOptionalAttestationTimestamp(
    metadata.feedbackTranscriptLastEventAt,
    "metadata.feedbackTranscriptLastEventAt",
  );
  if (feedbackTranscriptLastEventAt) result.feedbackTranscriptLastEventAt = feedbackTranscriptLastEventAt;
  if (
    metadata.feedbackReportTimeSource === "web_report_bundle"
    || metadata.feedbackReportTimeSource === "server_request_received"
  ) {
    result.feedbackReportTimeSource = metadata.feedbackReportTimeSource;
  }
  if (
    metadata.feedbackTranscriptWindowCoverage === "covered"
    || metadata.feedbackTranscriptWindowCoverage === "outside_report_window"
    || metadata.feedbackTranscriptWindowCoverage === "timestamps_unavailable"
    || metadata.feedbackTranscriptWindowCoverage === "report_time_invalid"
  ) {
    result.feedbackTranscriptWindowCoverage = metadata.feedbackTranscriptWindowCoverage;
  }
  if (
    typeof metadata.feedbackTranscriptWindowToleranceMs === "number"
    && Number.isSafeInteger(metadata.feedbackTranscriptWindowToleranceMs)
    && metadata.feedbackTranscriptWindowToleranceMs >= 0
    && metadata.feedbackTranscriptWindowToleranceMs <= 60 * 60 * 1000
  ) {
    result.feedbackTranscriptWindowToleranceMs = metadata.feedbackTranscriptWindowToleranceMs;
  }
  return result;
}

function readOptionalAttestationTimestamp(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} is invalid`);
  return new Date(parsed).toISOString();
}

function readAttestationString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  if (value.length > maxLength) throw new Error(`${name} is too long`);
  return value;
}

function readAttestationSha256(value: unknown, name: string): string {
  const result = readAttestationString(value, name, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function readAttestationInteger(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${name} is invalid`);
  if (value > max) throw new Error(`${name} exceeds maxBytes`);
  return value;
}

// Reminder receipt fallback text: deterministic UTC minute precision. The
// receipt now ships a structured token and the web UI re-renders it into the
// viewer's local timezone, but this UTC string remains as a safe fallback for
// any surface that doesn't understand the token yet.
function formatFireAtForReceiptFallback(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function buildReminderFireAtToken(d: Date): string {
  const fallback = formatFireAtForReceiptFallback(d);
  return `<span data-reminder-fire-at="${d.toISOString()}">${fallback}</span>`;
}

export async function resolveReminderMsgId(
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

    if (visibleRows.length === 1) {
      return { ok: true, messageId: visibleRows[0].id };
    }
    if (visibleRows.length === 0) {
      return { ok: false, status: 404, error: "message not found" };
    }
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

  if (!row) {
    return { ok: false, status: 404, error: "message not found" };
  }
  const payload = await resolveAgentVisibleMessagePayload(row.id, serverId, agentId);
  if (!payload) return { ok: false, status: 404, error: "message not found" };

  return { ok: true, messageId: row.id };
}

internalRouter.get("/machine/self", async (req, res) => {
  try {
    const machineId = req.machineId;
    const serverId = req.serverId;
    if (!machineId || !serverId) {
      res.status(401).json({ error: "Machine authentication required" });
      return;
    }

    const machine = await machineService.getMachine(machineId);
    if (!machine || machine.serverId !== serverId) {
      res.status(404).json({ error: "Machine not found" });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const readModel = await buildMachineReadModel(machine, agentOrchestrator);
    const server = await serverService.getServer(serverId);
    const latestDaemonVersion = await getLatestDaemonVersion();
    res.json({
      ...readModel,
      workspaceId: serverId,
      workspaceName: server?.name ?? null,
      serverSlug: server?.slug ?? null,
      latestDaemonVersion,
    });
  } catch {
    res.status(500).json({ error: "Failed to load machine" });
  }
});

internalRouter.get("/machine/agents", async (req, res) => {
  try {
    const machineId = req.machineId;
    const serverId = req.serverId;
    if (!machineId || !serverId) {
      res.status(401).json({ error: "Machine authentication required" });
      return;
    }

    const machine = await machineService.getMachine(machineId);
    if (!machine || machine.serverId !== serverId) {
      res.status(404).json({ error: "Machine not found" });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const agents = await agentService.getAgentsForMachine(machineId);
    const enriched = await Promise.all(
      agents
        .filter((agent) => agent.serverId === serverId)
        .map(async (agent) => {
          const { activity, activityDetail } = await agentOrchestrator.getActivity(agent.id, {
            parent: getCurrentTraceContext(),
          });
          return {
            id: agent.id,
            name: agent.name,
            displayName: agent.displayName,
            avatarUrl: agent.avatarUrl,
            description: agent.description,
            status: agent.status,
            activity,
            activityDetail,
            model: agent.model,
            runtime: agent.runtime,
            executionMode: agent.executionMode,
          };
        }),
    );

    res.json(enriched);
  } catch {
    res.status(500).json({ error: "Failed to load machine-assigned agents" });
  }
});

internalRouter.post("/machine/agents/:id/start", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    await agentOrchestrator.startAgent(result.agent.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to start machine-assigned agent",
    });
  }
});

internalRouter.post("/machine/agents/:id/stop", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    await agentOrchestrator.stopAgent(result.agent.id);
    res.json({ ok: true });
  } catch (err: any) {
    sendJsonServerError(req, res, {
      error: "Failed to stop machine-assigned agent",
      code: "machine_agent_stop_failed",
      logPrefix: "[Internal] Failed to stop machine-assigned agent",
      err,
    });
  }
});

internalRouter.get("/agent/:id/integrations", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const [clients, overview] = await Promise.all([
      oauthService.listAgentAvailableOAuthClients(result.agent.serverId),
      oauthService.getAgentIntegrationsOverview(result.agent.id),
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
          description: item.clientDescription,
          homepageUrl: item.clientHomepageUrl,
          returnUrl: item.clientReturnUrl,
          agentManifestUrl: agentManifest.url,
          agentManifestUrlSource: agentManifest.source,
          scopes: item.scopes,
          createdAt: item.createdAt,
        };
      });

    res.json({
      services: clients.map(serializeOAuthClientForAgent),
      activeLogins,
    });
  } catch (err) {
    console.error("List agent integrations error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to list agent integrations" });
  }
});

internalRouter.post("/agent/:id/integrations/login", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const server = await serverService.getServer(result.agent.serverId);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const clients = await oauthService.listAgentAvailableOAuthClients(result.agent.serverId);
    const resolved = resolveAgentLoginClient(clients, req.body?.service);
    if (!resolved.ok) {
      if (resolved.status !== 404) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }

      const publicClients = await oauthService.listPublicMarketplaceOAuthClients();
      const marketplaceResolved = resolveAgentLoginClient(publicClients, req.body?.service);
      if (!marketplaceResolved.ok) {
        res.status(marketplaceResolved.status).json({ error: marketplaceResolved.error });
        return;
      }

      const scopes = normalizeAgentLoginScopes(req.body?.scopes, marketplaceResolved.client);
      const marketplaceUrl = `${getAppUrl()}/s/${encodeURIComponent(server.slug)}/settings/applications?marketplace_app=${encodeURIComponent(marketplaceResolved.client.id)}`;
      const response: {
        status: "install_required";
        nextAction: "install_from_marketplace";
        service: ReturnType<typeof serializeOAuthClientForAgent>;
        scopes: string[];
        installation: {
          serverSlug: string;
          serverName: string;
          marketplaceUrl: string;
          target: string | null;
          actionCardMessageId: string | null;
        };
      } = {
        status: "install_required",
        nextAction: "install_from_marketplace",
        service: serializeOAuthClientForAgent(marketplaceResolved.client),
        scopes,
        installation: {
          serverSlug: server.slug,
          serverName: server.name,
          marketplaceUrl,
          target: null,
          actionCardMessageId: null,
        },
      };

      const target = optionalString(req.body?.target);
      if (target) {
        const resolvedTarget = await channelService.resolveChannelByName(
          result.agent.serverId,
          result.agent.id,
          target,
        );
        if (!resolvedTarget) {
          res.status(404).json({ error: "Install target not found or not visible to this agent" });
          return;
        }
        const agentName = result.agent.displayName ?? result.agent.name;
        const clientNameBinding = actionCardsService.bindMarketplaceAppName(marketplaceResolved.client.name);
        const card = await actionCardsService.prepareActionCard({
          serverId: result.agent.serverId,
          requesterAgentId: result.agent.id,
          targetChannelId: resolvedTarget.channelId,
          action: {
            type: "integration:install_marketplace_app",
            clientId: marketplaceResolved.client.id,
            clientKey: marketplaceResolved.client.clientId,
            ...clientNameBinding,
            agentId: result.agent.id,
            agentName,
            scopes,
            draftHint: `${agentName} requested ${clientNameBinding.clientName}, which is public in the Raft Marketplace but is not installed on this Server. Installing is a Server owner/admin action; the Agent cannot install it automatically.`,
          },
          io: (req.app.get("io") ?? null) as SocketServer | null,
        });
        response.installation.target = target;
        response.installation.actionCardMessageId = card.messageId;
      }

      res.json(response);
      return;
    }

    const scopes = normalizeAgentLoginScopes(req.body?.scopes, resolved.client);
    const requested = await oauthService.requestAgentAccess({
      clientId: resolved.client.id,
      serverSlug: server.slug,
      agentName: result.agent.name,
      scopes,
    });

    if (requested.grantStatus === "pending") {
      const response: {
        status: "approval_required";
        service: ReturnType<typeof serializeOAuthClientForAgent>;
        scopes: string[];
        requestId: string;
        approval: {
          requestId: string;
          target: string | null;
          actionCardMessageId: string | null;
        };
      } = {
        status: "approval_required",
        service: serializeOAuthClientForAgent(resolved.client),
        scopes: requested.request.scopes ?? [],
        requestId: requested.request.id,
        approval: {
          requestId: requested.request.id,
          target: null,
          actionCardMessageId: null,
        },
      };

      const rawTarget = req.body?.target;
      const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
      if (target) {
        const resolvedTarget = await channelService.resolveChannelByName(
          result.agent.serverId,
          result.agent.id,
          target,
        );
        if (!resolvedTarget) {
          res.status(404).json({ error: "Approval target not found or not visible to this agent" });
          return;
        }
        const card = await actionCardsService.prepareActionCard({
          serverId: result.agent.serverId,
          requesterAgentId: result.agent.id,
          targetChannelId: resolvedTarget.channelId,
          action: {
            type: "integration:approve_agent_login",
            requestId: requested.request.id,
            agentId: result.agent.id,
            agentName: result.agent.displayName ?? result.agent.name,
            clientId: resolved.client.id,
            clientKey: resolved.client.clientId,
            clientName: resolved.client.name,
            scopes: requested.request.scopes ?? [],
            draftHint:
              `${result.agent.displayName ?? result.agent.name} is requesting human approval to use ${resolved.client.name}. Server-installed apps do not need this approval; Marketplace apps do.`,
          },
          io: (req.app.get("io") ?? null) as SocketServer | null,
        });
        response.approval.target = target;
        response.approval.actionCardMessageId = card.messageId;
      }

      res.json(response);
      return;
    }

    res.json({
      status: requested.grantStatus === "reused" ? "already_logged_in" : "logged_in",
      service: serializeOAuthClientForAgent(resolved.client),
      scopes: requested.request.scopes ?? [],
      requestId: requested.request.id,
    });
  } catch (err: any) {
    const message = err?.message || "Failed to provision agent login";
    if (
      message === "scopes must be an array" ||
      message === "scopes must contain strings" ||
      message === "scope values must be non-empty" ||
      message === "at least one scope is required" ||
      message === "invalid_scope"
    ) {
      res.status(400).json({ error: message });
      return;
    }
    if (message.includes("not found")) {
      res.status(404).json({ error: message });
      return;
    }
    console.error("Agent integration login error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to provision agent login" });
  }
});

internalRouter.post("/agent/:id/integrations/app/prepare", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const target = optionalString(body.target);
    if (!target) {
      res.status(400).json({ error: "target is required" });
      return;
    }
    const mode = optionalString(body.mode);
    if (mode !== "register" && mode !== "update") {
      res.status(400).json({ error: "mode must be register or update" });
      return;
    }
    if (mode === "update") {
      res.status(410).json({
        error: "App registration update cards are disabled; the app owner must use the direct integration app update command",
        errorCode: "LEGACY_APP_UPDATE_DISABLED",
      });
      return;
    }
    const clientKey = optionalString(body.clientKey);

    const resolvedTarget = await channelService.resolveChannelByName(
      result.agent.serverId,
      result.agent.id,
      target,
    );
    if (!resolvedTarget) {
      res.status(404).json({ error: "Action-card target not found or not visible to this agent" });
      return;
    }

    const scopes = normalizeIntegrationAppPrepareScopes(body.scopes);
    const unsafeDemoUrlOverride = body.unsafeDemoUrlOverride === true;
    const draftHint = optionalString(body.draftHint);
    const homepageUrl = optionalString(body.homepageUrl);
    const returnUrl = optionalString(body.returnUrl);
    const agentManifestUrl = optionalString(body.agentManifestUrl);

    let action: ActionCardAction;
    if (mode === "register") {
      const name = optionalString(body.name);
      if (!name) {
        res.status(400).json({ error: "name is required for register" });
        return;
      }
      if (!returnUrl) {
        res.status(400).json({ error: "returnUrl is required for register" });
        return;
      }
      action = {
        type: "integration:register_app",
        name,
        ...(clientKey ? { clientKey } : {}),
        description: optionalString(body.description),
        homepageUrl,
        returnUrl,
        agentManifestUrl,
        scopes,
        unsafeDemoUrlOverride,
        draftHint: draftHint ?? `Agent prepared a Login with Raft app registration for ${name}. The requester becomes the app owner after server commit and receives the initial secret through a private transient handoff; only a lost handoff should be recovered with rotate-secret --output <new-private-path>. No secret is stored in this card.`,
      };
    } else {
      if (!clientKey) {
        res.status(400).json({ error: "clientKey is required for update" });
        return;
      }
      action = {
        type: "integration:update_app_registration",
        clientKey,
        name: optionalString(body.name),
        description: optionalString(body.description),
        homepageUrl,
        returnUrl,
        agentManifestUrl,
        scopes: body.scopes === undefined ? undefined : scopes,
        unsafeDemoUrlOverride,
        draftHint: draftHint ?? `Agent prepared a compatibility approval update for Login with Raft app ${clientKey}. App owners can use the direct integration app update command instead.`,
      };
    }

    const card = await actionCardsService.prepareActionCard({
      serverId: result.agent.serverId,
      requesterAgentId: result.agent.id,
      targetChannelId: resolvedTarget.channelId,
      action,
      io: (req.app.get("io") ?? null) as SocketServer | null,
    });

    res.status(201).json({
      status: "prepared",
      mode,
      target,
      actionCardMessageId: card.messageId,
      action: card.metadata.action,
    });
    recordRaftCliActivity(req, req.params.id, {
      command: "integration.app.prepare",
      summary: `Prepared integration app ${mode} card`,
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
    console.error("Prepare integration app registration error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to prepare integration app registration" });
  }
});

// Machine-auth, pull-on-demand scope capability for daemon direct-to-worker calls.
// The server signs authorization metadata only; upload/data bytes must go to the
// requested third-party worker directly from the daemon.
internalRouter.post("/machine/scope-attestation", async (req, res) => {
  try {
    if (!req.machineId || !req.serverId) {
      res.status(401).json({ error: "Machine authentication required" });
      return;
    }

    addTraceEvent("scope_attestation.request.started", {
      surface: "machine",
      metadata_present: typeof req.body?.metadata === "object" && req.body.metadata !== null,
    });

    const { scope, metadata: requestMetadata } = await tracePhase(
      () => Promise.resolve(parseDaemonScopeAttestationRequest(req.body)),
      (_durationMs, result) => ({
        name: "scope_attestation.request.parsed",
        attrs: {
          surface: "machine",
          scope: result.scope,
          metadata_present: !!result.metadata,
        },
      }),
    );
    const machine = await tracePhase(
      () => machineService.getMachine(req.machineId!),
      (_durationMs, result) => ({
        name: "scope_attestation.machine.loaded",
        attrs: {
          surface: "machine",
          outcome: result && result.serverId === req.serverId ? "found" : "missing",
        },
      }),
    );
    if (!machine || machine.serverId !== req.serverId) {
      res.status(401).json({ error: "Machine authentication required" });
      return;
    }

    const server = await tracePhase(
      () => serverService.getServer(req.serverId!),
      (_durationMs, result) => ({
        name: "scope_attestation.server.loaded",
        attrs: {
          surface: "machine",
          outcome: result ? "found" : "missing",
        },
      }),
    );
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const policy = DAEMON_CAPABILITY_POLICIES[scope];
    const audience = policy.audience;
    const resource = policy.deriveResource({ serverId: server.id, machineId: machine.id });
    const metadata = policy.deriveMetadata?.({ serverId: server.id, machineId: machine.id }, requestMetadata);

    const expiresAt = new Date(Date.now() + DAEMON_CAPABILITY_TTL_MS);
    const attestation = await tracePhase(
      () => Promise.resolve(createScopeAttestation({
        v: 1,
        typ: "scope-attestation",
        scope,
        sub: `machine:${machine.id}`,
        actorType: "machine",
        machineId: machine.id,
        serverId: server.id,
        serverSlug: server.slug,
        aud: audience,
        resource,
        ...(metadata ? { metadata } : {}),
        nonce: randomUUID(),
        jti: randomUUID(),
        exp: Math.floor(expiresAt.getTime() / 1000),
      })),
      () => ({
        name: "scope_attestation.signed",
        attrs: {
          surface: "machine",
          scope,
          audience,
          metadata_present: !!metadata,
          ttl_seconds: Math.floor(DAEMON_CAPABILITY_TTL_MS / 1000),
        },
      }),
    );

    addTraceEvent("response.ready", {
      status_code: 200,
      surface: "machine",
      scope,
    });
    res.json({
      attestation,
      scope,
      audience,
      resource,
      ...(metadata ? { metadata } : {}),
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create scope attestation";
    if (message.includes("not configured")) {
      res.status(503).json({ error: message });
      return;
    }
    if (
      message === "Request body must be a JSON object" ||
      message === "scope is required" ||
      message === "scope is invalid" ||
      message.startsWith("Unsupported scope:") ||
      message === "audience is derived from scope" ||
      message === "resource is derived from scope" ||
      message === "metadata must be a JSON object" ||
      message.startsWith("metadata.")
    ) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: "Failed to create scope attestation" });
  }
});

// --- Agent file upload ---

const profileAvatarUpload = createAvatarUpload();
const serverAvatarUpload = createAvatarUpload();

type InternalAgentSendState = "sent" | "held";

function toAttestedSendTargetType(type: "channel" | "private" | "joint" | "dm" | "thread"): attestedSendService.AttestedSendTargetType {
  return type === "private" || type === "joint" ? "channel" : type;
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

interface InternalAgentSendResponse {
  ok: true;
  state: InternalAgentSendState;
  messageId?: string;
  messageSeq?: number;
  decision?: ApmFreshnessHeldDecision;
  heldMessages?: unknown[];
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  mentionAnnotation?: { formalMentionCount: number };
  continueAnywaySuggested?: boolean;
  seenUpToSeq?: number;
  seenUpToMessageId?: string | null;
  // Sender-side info prompt (mention-AX M-4/N-5): outsider mentions that were
  // not notified on this send. Only ever present on state:"sent" responses —
  // a held response (message not committed) MUST NOT carry it (contract A2).
  pendingMentionActions?: messageService.PendingMentionAction[];
  // Sender-only, original-send warning for authored @tokens that matched no
  // actor in the effective mention scope. No durable mention row exists.
  unresolvedMentionHandles?: string[];
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
): Promise<unknown[]> {
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
  return messageService.listMessagesByIds(
    freshnessMessages.map((message) => message.messageId),
    {
      forwardedBundleViewerAgentId: agentId,
      forwardedBundleViewerServerId: agentServerId,
    },
  );
}

// Agent uploads an attachment
internalRouter.post("/agent/:id/upload", requireAgentScope("attachment:upload"), (req, res, next) => {
  runSingleAttachmentUpload(req, res, next);
}, async (req, res) => {
  try {
    const agentId = req.params.id as string;
    const result = await loadOwnedMachineAgent(agentId, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;

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

    // Archive gate: no new attachments on an archived channel.
    if (await channelService.isChannelArchived(channelId)) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    if (await isChannelReadOnlyByBillingFeature(channelId, agent.serverId)) {
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
      serverId: req.serverId!,
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

    res.json({
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
  } catch (err: any) {
    console.error("Agent upload error:", serializeErrorForLog(err));
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

// Agent resolves a channel target to an ID (used by upload_file)
internalRouter.post("/agent/:id/resolve-channel", async (req, res) => {
  try {
    const agentId = req.params.id;
    const { target } = req.body;

    if (!target) {
      res.status(400).json({ error: "target is required" });
      return;
    }

    const result = await loadOwnedMachineAgent(agentId, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;

    const resolved = await resolveWritableAgentTarget(agent.serverId, agentId, target);
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

    res.json({ channelId: resolved.channelId });
  } catch (err) {
    console.error("Resolve channel error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to resolve channel" });
  }
});

// Agent sends a message
internalRouter.post("/agent/:id/send", validateLegacyAgentSendBody, requireAgentScope("message:send"), async (req, res) => {
  try {
    addTraceEvent("agent_send.request.started", {
      attachment_ids_count: Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds.length : 0,
      idempotency_key_present: typeof req.body?.idempotencyKey === "string" && req.body.idempotencyKey.length > 0,
      send_draft_requested: req.body?.sendDraft === true,
    });
    const agentId = req.params.id;
    const { target, channel, dm_to, content, attachmentIds, idempotencyKey, continue: deprecatedContinue, sendDraft, continueAnyway, draftReholdCount, draftReplacedExisting, seenUpToSeq } = req.body;
    const isSendDraft = sendDraft === true;
    const isContinueAnyway = continueAnyway === true;
    const parsedDraftReholdCount = typeof draftReholdCount === "number" && Number.isFinite(draftReholdCount)
      ? Math.max(0, Math.floor(draftReholdCount))
      : 0;

    if (deprecatedContinue === true) {
      addTraceEvent("agent_send.request.rejected", { reason: "deprecated_continue" });
      res.status(400).json({
        error: "--continue is no longer supported. Use normal message send to update a draft, or --send-draft to send the current saved draft.",
      });
      return;
    }
    if (!content) {
      addTraceEvent("agent_send.request.rejected", { reason: "missing_content" });
      res.status(400).json({ error: "Content is required" });
      return;
    }
    if (isContinueAnyway && !isSendDraft) {
      addTraceEvent("agent_send.request.rejected", { reason: "send_draft_anyway_without_send_draft" });
      res.status(400).json({ error: "--send-draft --anyway requires a saved draft" });
      return;
    }

    // Unified target param (new) or legacy channel/dm_to (backward compat)
    const effectiveTarget = target || channel || (dm_to ? `dm:@${dm_to.replace(/^@/, "")}` : null);
    const targetKind = classifyAgentSendTarget(effectiveTarget);
    if (!effectiveTarget) {
      addTraceEvent("agent_send.request.rejected", { reason: "missing_target" });
      res.status(400).json({ error: "target is required" });
      return;
    }

    const result = await tracePhase(
      () => loadOwnedMachineAgent(agentId, req.machineId, req.serverId),
      (_durationMs, authResult) => ({
        name: "agent.ownership.checked",
        attrs: {
          authorized: !("error" in authResult),
          ...(("error" in authResult) ? { status_code: authResult.status } : {}),
        },
      }),
    );
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;
    const sendFreshnessMode = (process.env.SLOCK_ATTESTED_SEND_MODE ?? "on").trim().toLowerCase();
    const sendFreshnessEnabled = isSendFreshnessEnabled(agent.serverId, agentId);
    const requestedSendFreshness = isSendDraft ||
      isContinueAnyway ||
      typeof seenUpToSeq === "number" ||
      typeof draftReholdCount === "number" ||
      draftReplacedExisting === true;
    const shouldRunSendFreshness = sendFreshnessEnabled &&
      (requestedSendFreshness || sendFreshnessMode === "force");
    if (!sendFreshnessEnabled && requestedSendFreshness) {
      addTraceEvent("agent_send.request.rejected", { reason: "send_freshness_disabled" });
      res.status(403).json({ error: "Send freshness interface is not enabled for this agent." });
      return;
    }

    const resolved = await tracePhase(
      () => resolveWritableAgentTarget(agent.serverId, agentId, effectiveTarget),
      (_durationMs, targetResult) => ({
        name: "target.resolved",
        attrs: {
          target_kind: targetKind,
          outcome: typeof targetResult === "string"
            ? targetResult
            : targetResult
              ? "resolved"
              : "not_found",
          ...(targetResult && typeof targetResult === "object" ? { channel_type: targetResult.type } : {}),
        },
      }),
    );
    if (resolved === "forbidden") {
      res.status(403).json({ error: forbiddenMessageForTarget(effectiveTarget) });
      return;
    }
    if (resolved === "peer-not-found") {
      res.status(404).json({ error: `User or agent not found: @${effectiveTarget.slice(4)}` });
      return;
    }
    if (resolved === "self-dm") {
      res.status(400).json({ error: "Cannot create a DM with yourself" });
      return;
    }
    if (!resolved) {
      res.status(404).json({ error: notFoundMessageForTarget(effectiveTarget) });
      return;
    }
    if (await isChannelReadOnlyByBillingFeature(resolved.channelId, agent.serverId)) {
      res.status(403).json({ error: "Joint Channels require the Pro plan. Upgrade to continue." });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const runSend = async () => {
      let attestedSendActivityContext: {
        targetType: attestedSendService.AttestedSendTargetType;
        targetRef: string;
        newMessageCount: number;
      } | null = null;
      if (shouldRunSendFreshness) {
        const selfSender = { senderType: "agent" as const, senderId: agentId };
        const useAttentionFacts = resolved.type !== "thread";
        const latestAnchor = useAttentionFacts
          ? await attestedSendService.getLatestAgentAttentionAnchor(agentId, resolved.channelId, {
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
        // A cold thread still has a freshness boundary: the parent message the
        // first reply is based on. Once the first reply lands, peers based on
        // that same parent boundary must be held like any other stale draft.
        const latestFreshnessSeq = Math.max(latestAnchor.seq, threadParentAnchor?.seq ?? 0);
        const latestFreshnessMessageId = latestAnchor.seq > 0 && latestAnchor.seq >= (threadParentAnchor?.seq ?? 0)
          ? latestAnchor.messageId
          : (threadParentAnchor?.messageId ?? latestAnchor.messageId);
        // Freshness proof must come from the current generation's model-seen
        // boundary, not the legacy read-ish cursor. `agentChannelReadCursors`
        // is durable read state and therefore cannot prove the current prompt
        // contained the message. Until the daemon/CLI
        // carries a first-class turn-context boundary, channel sends without
        // explicit `seenUpToSeq` conservatively hold; thread first replies keep
        // the parent-message fallback.
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
            ? await attestedSendService.countAgentAttentionMessagesAfterSeq(agentId, resolved.channelId, attestedBoundarySeq, {
              excludeSender: selfSender,
              latestSeq: latestFreshnessSeq,
            })
            : await attestedSendService.countMessagesAfterSeq(resolved.channelId, attestedBoundarySeq, {
              excludeSender: selfSender,
              latestSeq: latestFreshnessSeq,
            })
          : 0;
        const attestedTargetType = toAttestedSendTargetType(resolved.type);
        attestedSendActivityContext = {
          targetType: attestedTargetType,
          targetRef: effectiveTarget,
          newMessageCount,
        };
        const formalMentionFacts = attestedBoundarySeq > 0 && latestFreshnessSeq > attestedBoundarySeq
          ? await attestedSendService.getFormalMentionFacts(agentId, resolved.channelId, attestedBoundarySeq, latestFreshnessSeq)
          : { count: 0, firstMessageId: null, firstHandle: null };
        const shouldHoldForFreshness =
          !isContinueAnyway && newMessageCount > 0 && formalMentionFacts.count === 0;
        const boundarySource = hasClientSeenBoundary
          ? "client_seen"
          : threadParentAnchor
            ? "thread_parent"
            : "none";
        addTraceEvent("attested_send.freshness.evaluated", {
          target_type: attestedTargetType,
          channel_type: resolved.type,
          outcome: shouldHoldForFreshness
            ? "held"
            : formalMentionFacts.count > 0
              ? "mention_exempt"
              : "fresh",
          new_message_count: newMessageCount,
          boundary_source: boundarySource,
          boundary_seq: attestedBoundarySeq,
          latest_seq: latestFreshnessSeq,
        });

        const renderHeldResponse = async (
          replacedExisting: boolean,
          reholdCount: number,
          attestedBoundarySeq: number,
          attestedBoundaryMessageId: string | null,
          latestSeq: number,
          latestMessageId: string | null,
          mentionCount: number,
        ): Promise<InternalAgentSendResponse> => {
          const heldMessages = await listRecentFreshnessMessagesAfterSeq(
            agentId,
            agent.serverId,
            resolved.channelId,
            attestedBoundarySeq,
            ATTESTED_SEND_HELD_CONTEXT_LIMIT,
            latestSeq,
            useAttentionFacts,
            { excludeSender: { senderType: "agent", senderId: agentId } },
          );
          const heldSeqs = heldMessages
            .map((message) => Number((message as { seq?: unknown }).seq))
            .filter((seq) => Number.isInteger(seq) && seq > 0);
          const attentionHoldCount = latestSeq > attestedBoundarySeq
            ? useAttentionFacts
              ? await attestedSendService.countAgentAttentionMessagesAfterSeq(agentId, resolved.channelId, attestedBoundarySeq, {
                excludeSender: { senderType: "agent", senderId: agentId },
                latestSeq,
              })
              : await attestedSendService.countMessagesAfterSeq(resolved.channelId, attestedBoundarySeq, {
                excludeSender: { senderType: "agent", senderId: agentId },
                latestSeq,
              })
            : 0;
          const shownMessageCount = heldMessages.length;
          // Without a model-seen boundary, do not present the whole target
          // history as "new messages"; this is a bounded first-touch context.
          const hasModelSeenBoundary = boundarySource === "client_seen";
          const holdCount = hasModelSeenBoundary ? attentionHoldCount : shownMessageCount;
          const omittedMessageCount = hasModelSeenBoundary
            ? Math.max(0, attentionHoldCount - shownMessageCount)
            : 0;
          const eventSubject = {
            id: randomUUID(),
            agentId,
            serverId: agent.serverId,
            targetType: attestedTargetType,
            targetRef: effectiveTarget,
          };
          const readState = await channelService.markAgentLegacyRead(agentId, resolved.channelId, latestSeq);
          await emitScopeReadUpdated({
            io: req.app.get("io") as SocketServer | undefined,
            serverId: agent.serverId,
            scopeId: resolved.channelId,
            peerKind: "agent",
            peerId: agentId,
            maxReadSeq: readState.maxReadSeq,
            changed: readState.changed,
          });
          if (latestSeq > attestedBoundarySeq) {
            const ack = agentOrchestrator.acknowledgeDeliveredMessagesForChannelUpToSeq?.(
              agentId,
              resolved.channelId,
              latestSeq,
            ) ?? agentOrchestrator.acknowledgeDeliveredMessagesForChannel(agentId, resolved.channelId, heldSeqs);
            addTraceEvent("held_context.delivery_suppressed", {
              target_type: attestedTargetType,
              shown_message_count: shownMessageCount,
              omitted_message_count: omittedMessageCount,
              removed_count: ack.removedCount,
            });
          }
          await attestedSendService.recordGateTriggered(eventSubject, {
            lastSeenMessageId: attestedBoundaryMessageId,
            latestMessageId,
            hasFormalMentionSinceLastSeen: false,
            draftReplacedExisting: replacedExisting,
            newMessageCount: holdCount,
            boundarySource,
            boundarySeq: attestedBoundarySeq,
            latestSeq,
          });
          const freshnessDecision = {
            action: "send" as const,
            decision: "syncing_hold" as const,
            target: effectiveTarget,
            reason: hasModelSeenBoundary ? "server_stale_model_boundary" : "server_first_touch_context",
            pendingMaxSeq: latestSeq,
            modelSeenSeq: hasModelSeenBoundary ? attestedBoundarySeq : 0,
            heldMessageCount: shownMessageCount,
            omittedMessageCount,
          };
          const producerFactId = buildApmFreshnessDecisionProducerFactId(agentId, freshnessDecision);
          const envelope = projectApmHeldFreshnessEnvelope({
            producerFactId,
            action: "send",
            decision: "syncing_hold",
            heldMessages,
            newMessageCount: holdCount,
            omittedMessageCount,
            seenUpToSeq: latestSeq,
          });
          const activity = projectApmHeldFreshnessActivity({
            producerFactId,
            action: "send",
            decision: "syncing_hold",
            target: effectiveTarget,
            messageCount: shownMessageCount,
          });
          const title = reholdCount > 0 || isSendDraft ? "Send draft held" : activity.entry.title;
          await recordAgentRaftAction(req, agentId, {
            title,
            text: activity.entry.text,
            producerFactId,
            activity: activity.statusEntry.activity,
            activityDetail: title,
          });
          return {
            ok: true,
            ...envelope.body,
            mentionAnnotation: { formalMentionCount: mentionCount },
            continueAnywaySuggested: reholdCount >= 3,
            seenUpToMessageId: latestMessageId,
          };
        };

        if (shouldHoldForFreshness) {
          const response = await renderHeldResponse(
            draftReplacedExisting === true,
            parsedDraftReholdCount,
            attestedBoundarySeq,
            attestedBoundaryMessageId,
            latestFreshnessSeq,
            latestFreshnessMessageId,
            formalMentionFacts.count,
          );
          res.json(response);
          return;
        }

        if (formalMentionFacts.count > 0 && formalMentionFacts.firstMessageId && formalMentionFacts.firstHandle) {
          await attestedSendService.recordE1ExemptEvent({
            agentId,
            serverId: agent.serverId,
            targetType: attestedTargetType,
            targetRef: effectiveTarget,
            mentionMessageId: formalMentionFacts.firstMessageId,
            mentionedHandle: formalMentionFacts.firstHandle,
            newMessageCountSinceLastSeen: newMessageCount,
          });
          await recordAgentRaftAction(req, agentId, {
            title: "Send freshness check passed by mention",
            text: [
              `target: ${effectiveTarget}`,
              `reason: direct @${formalMentionFacts.firstHandle} mention`,
              `new messages: ${formatAttestedMessageCount(newMessageCount)}`,
            ].join("\n"),
          });
        }
      }

    // Unified pipeline: DB write → broadcast → agent delivery
    const io = req.app.get("io");
    const enriched = await tracePhase(
      // slack-bridge-ordinary-message-producer: internal_agent.send
      () => messageService.broadcastAndDeliver(io, agentOrchestrator, {
        channelId: resolved.channelId,
        senderType: "agent",
        senderId: agentId,
        senderName: agent.displayName || agent.name || "Agent",
        content,
        attachmentIds,
        ...(typeof idempotencyKey === "string" && idempotencyKey.length > 0
          ? { agentSendKey: idempotencyKey }
          : {}),
      }),
      (_durationMs, message) => ({
        name: "message.sent",
        attrs: {
          channel_type: resolved.type,
          message_id_present: Boolean(message.id),
          attachments_count: message.attachments.length,
          idempotency_key_present: typeof idempotencyKey === "string" && idempotencyKey.length > 0,
          send_draft_requested: isSendDraft,
        },
      }),
    );

    addTraceEvent("response.ready", {
      attachment_ids_count: Array.isArray(attachmentIds) ? attachmentIds.length : 0,
      send_draft_requested: isSendDraft,
    });

    if (shouldRunSendFreshness && isSendDraft && attestedSendActivityContext) {
      const result = isContinueAnyway ? "committed_anyway" : "committed";
      await attestedSendService.recordContinueEvent({
        agentId,
        serverId: agent.serverId,
        targetType: attestedSendActivityContext.targetType,
        targetRef: attestedSendActivityContext.targetRef,
        messageId: enriched.id,
        result,
        newMessageCount: attestedSendActivityContext.newMessageCount,
      });
      const title = isContinueAnyway ? "Send draft sent anyway" : "Send draft sent";
      await recordAgentRaftAction(req, agentId, {
        title,
        text: [
          `target: ${effectiveTarget}`,
          `freshness updates: ${formatAttestedMessageCount(attestedSendActivityContext.newMessageCount)}`,
          isContinueAnyway
            ? "decision: sent anyway after reviewing freshness context"
            : "decision: saved draft freshness check passed when sent",
        ].join("\n"),
      });
    }

    const pendingMentionActions = messageService.getSenderPendingMentionActions(enriched);
    const unresolvedMentionHandles = messageService.getSenderUnresolvedMentionHandles(enriched);
    const response: InternalAgentSendResponse = {
      ok: true,
      state: "sent",
      messageId: enriched.id,
      messageSeq: enriched.seq,
      ...(pendingMentionActions.length > 0 ? { pendingMentionActions } : {}),
      ...(unresolvedMentionHandles.length > 0 ? { unresolvedMentionHandles } : {}),
    };
    res.json(response);
    recordRaftCliActivity(req, agentId, {
      command: "message.send",
      summary: "Sent message",
      target: effectiveTarget,
      correlationId: enriched.id,
    });
    };

    if (shouldRunSendFreshness) {
      await attestedSendService.withTargetFreshnessGate(resolved.channelId, runSend);
    } else {
      await runSend();
    }
    return;
  } catch (err) {
    if (err instanceof channelService.ChannelArchivedError) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    if (err instanceof AttachmentLinkError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    console.error("Internal send error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to send message" });
  }
});

// Agent reactions are intentionally lightweight state updates: they update the
// message summary for viewers, but do not wake agents or enter inbox/context.
internalRouter.post("/agent/:id/messages/:messageId/reactions", requireAgentScope("message:send"), async (req, res) => {
  try {
    const emoji = parseReactionEmoji(req.body?.emoji);
    if (!emoji) {
      res.status(400).json({ error: "A valid emoji is required" });
      return;
    }

    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;

    const message = await loadVisibleMessageForAgent(req.params.messageId, agent.id, agent.serverId, res);
    if (!message) return;
    if (message.messageType === "system") {
      res.status(400).json({ error: "System messages cannot receive reactions" });
      return;
    }

    const canPost = await channelService.canAgentPostToChannel(message.channelId, agent.id);
    if (!canPost) {
      res.status(403).json({ error: "Agent must join this channel to react to messages" });
      return;
    }

    await channelService.assertChannelNotArchived(message.channelId);

    if (await isChannelReadOnlyByBillingFeature(message.channelId, agent.serverId)) {
      res.status(403).json({ error: "Joint Channels require the Pro plan. Upgrade to continue." });
      return;
    }
    if (await isChannelReadOnlyByQuota(message.channelId, agent.serverId)) {
      res.status(403).json({ error: "This channel is read-only on your current plan. Upgrade to continue." });
      return;
    }

    await mutateMessageReaction({
      messageId: message.id,
      emoji,
      actor: { kind: "agent", id: agent.id },
      operation: "add",
    });

    const context = await messageService.getMessageContext(message.id, 0, 0, undefined, {
      forwardedBundleViewerAgentId: agent.id,
      forwardedBundleViewerServerId: agent.serverId,
    });
    const enriched = context?.messages[0];
    if (!enriched) {
      res.status(500).json({ error: "Failed to reload updated message" });
      return;
    }

    const io = req.app.get("io");
    // message-realtime-producer: route-internal.reaction-add.updated
    io.to(`channel:${message.channelId}`).emit(
      "message:updated",
      projectRichMessageSocketPayload(messageService.stripViewerScopedAttachmentCommentMetadata(enriched)),
    );
    res.json(messageService.projectAgentVisibleHttpMessageResponse(enriched));
  } catch (err) {
    if (err instanceof channelService.ChannelArchivedError) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    console.error("Internal add reaction error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to add reaction" });
  }
});

internalRouter.delete("/agent/:id/messages/:messageId/reactions", requireAgentScope("message:send"), async (req, res) => {
  try {
    const emoji = parseReactionEmoji(req.body?.emoji);
    if (!emoji) {
      res.status(400).json({ error: "A valid emoji is required" });
      return;
    }

    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;

    const message = await loadVisibleMessageForAgent(req.params.messageId, agent.id, agent.serverId, res);
    if (!message) return;
    if (message.messageType === "system") {
      res.status(400).json({ error: "System messages cannot receive reactions" });
      return;
    }

    const canPost = await channelService.canAgentPostToChannel(message.channelId, agent.id);
    if (!canPost) {
      res.status(403).json({ error: "Agent must join this channel to react to messages" });
      return;
    }

    await channelService.assertChannelNotArchived(message.channelId);

    if (await isChannelReadOnlyByBillingFeature(message.channelId, agent.serverId)) {
      res.status(403).json({ error: "Joint Channels require the Pro plan. Upgrade to continue." });
      return;
    }
    if (await isChannelReadOnlyByQuota(message.channelId, agent.serverId)) {
      res.status(403).json({ error: "This channel is read-only on your current plan. Upgrade to continue." });
      return;
    }

    await mutateMessageReaction({
      messageId: message.id,
      emoji,
      actor: { kind: "agent", id: agent.id },
      operation: "remove",
    });

    const context = await messageService.getMessageContext(message.id, 0, 0, undefined, {
      forwardedBundleViewerAgentId: agent.id,
      forwardedBundleViewerServerId: agent.serverId,
    });
    const enriched = context?.messages[0];
    if (!enriched) {
      res.status(500).json({ error: "Failed to reload updated message" });
      return;
    }

    const io = req.app.get("io");
    // message-realtime-producer: route-internal.reaction-remove.updated
    io.to(`channel:${message.channelId}`).emit(
      "message:updated",
      projectRichMessageSocketPayload(messageService.stripViewerScopedAttachmentCommentMetadata(enriched)),
    );
    res.json(messageService.projectAgentVisibleHttpMessageResponse(enriched));
  } catch (err) {
    if (err instanceof channelService.ChannelArchivedError) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    console.error("Internal remove reaction error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to remove reaction" });
  }
});

// Agent receives messages (long-poll)
internalRouter.get("/agent/:id/receive", requireAgentScope("message:read"), async (req, res) => {
  try {
    const agentId = req.params.id;
    const block = req.query.block === "true";
    const timeoutMs = Number(req.query.timeout) || 30000;

    addTraceEvent("agent_receive.request.started", {
      block,
      timeout_ms: timeoutMs,
    });

    const result = await tracePhase(
      () => loadOwnedMachineAgent(agentId, req.machineId, req.serverId),
      (_durationMs, ownershipResult) => ({
        name: "agent.ownership.checked",
        attrs: {
          outcome: "error" in ownershipResult ? "rejected" : "owned",
          rejection_status: "error" in ownershipResult ? ownershipResult.status : 0,
        },
      }),
    );
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    // Ensure this request hits the replica where the machine's inbox lives.
    // On Fly.io, if the machine is on a different instance, replay the request there.
    const routing = await tracePhase(
      async () => {
        const machineLocal = agent.machineId ? agentOrchestrator.hasMachineLocally(agent.machineId) : false;
        const flyInstance = agent.machineId && !machineLocal
          ? await getFlyInstanceForMachine(agent.machineId)
          : null;
        return { machineLocal, flyInstance };
      },
      (_durationMs, routeResult) => ({
        name: "machine.routing.checked",
        attrs: {
          machine_id_present: Boolean(agent.machineId),
          machine_local: routeResult.machineLocal,
          fly_instance_present: Boolean(routeResult.flyInstance),
        },
      }),
    );
    if (routing.flyInstance) {
      res.set("fly-replay", `instance=${routing.flyInstance}`);
      res.status(307).end();
      return;
    }

    const abortController = new AbortController();
    const receiveSpan = getCurrentTraceSpan();
    res.prependOnceListener("close", () => {
      receiveSpan?.addEvent("agent_receive.request.closed", {
        block,
        timeout_ms: timeoutMs,
      });
      abortController.abort();
    });
    addTraceEvent("agent_receive.wait.started", {
      block,
      timeout_ms: timeoutMs,
    });
    const messages = await tracePhase(
      () => agentOrchestrator.receiveMessages(agentId, block, timeoutMs, abortController.signal),
      (_durationMs, receivedMessages) => ({
        name: "agent_receive.messages.received",
        attrs: {
          messages_count: receivedMessages.length,
          outcome: receivedMessages.length > 0 ? "messages" : block ? "timeout" : "empty",
        },
      }),
    );

    if (abortController.signal.aborted) return;
    const deliverableMessages: typeof messages = [];
    const undeliverableMessages: typeof messages = [];
    for (const message of messages) {
      const canAccess = await canAgentAccessQueuedMessageTarget(message, agentId, agent.serverId);
      if (canAccess) {
        deliverableMessages.push(message);
      } else {
        undeliverableMessages.push(message);
      }
    }
    if (undeliverableMessages.length > 0) {
      const discarded = agentOrchestrator.discardUndeliverableMessages(agentId, undeliverableMessages);
      addTraceEvent("agent_receive.undeliverable_messages.discarded", {
        requested_messages_count: messages.length,
        undeliverable_messages_count: undeliverableMessages.length,
        removed_count: discarded.removedCount,
      });
    }

    // The legacy daemon acks in a separate request, but it can only ack what
    // this response exposes. Fail closed before rendering so a stale queued
    // task snapshot is never returned as current after a later amendment.
    const refreshedDeliverableMessages = await refreshQueuedAgentTaskProjections(deliverableMessages);

    const renderedContents = await tracePhase(
      () => agentPermalinkRenderService.renderAgentReadablePermalinksInTexts(
        refreshedDeliverableMessages.map((message) => message.content),
        agent.serverId,
      ),
      (_durationMs, rendered) => ({
        name: "messages.rendered",
        attrs: {
          messages_count: rendered.length,
        },
      }),
    );
    addTraceEvent("response.ready", {
      messages_count: refreshedDeliverableMessages.length,
    });
    res.json({
      messages: refreshedDeliverableMessages.map((message, index) => ({
        ...message,
        content: message.sender_type === "third_party_app"
          ? message.external_message
            ? message.content
            : renderThirdPartyInertText({ field: "tool_result", value: message.content })
          : renderedContents[index],
      })),
    });
  } catch (err) {
    addTraceEvent("agent_receive.request.failed", {
      error_class: err instanceof Error ? err.name : typeof err,
    });
    console.error("Internal receive error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to receive messages" });
  }
});

internalRouter.post("/agent/:id/receive-ack", async (req, res) => {
  try {
    const agentId = req.params.id;
    const seqs = Array.isArray(req.body?.seqs)
      ? req.body.seqs
          .map((value: unknown) => Number(value))
          .filter((value: number) => Number.isInteger(value) && value > 0)
      : [];
    const messageIds = Array.isArray(req.body?.messageIds)
      ? req.body.messageIds
          .map((value: unknown) => typeof value === "string" ? value.trim() : "")
          .filter(Boolean)
      : [];

    if (seqs.length === 0 && messageIds.length === 0) {
      res.status(400).json({ error: "seqs or messageIds must be a non-empty array" });
      return;
    }

    const result = await loadOwnedMachineAgent(agentId, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    agentOrchestrator.acknowledgeDeliveredMessages(agentId, seqs, messageIds);
    // Pre-model-seen daemon compatibility: delivery ack is also the usability
    // checkpoint that keeps unread/pending-summary distance bounded until a
    // daemon explicitly advertises true model-seen boundary support. This is
    // not freshness proof; attested send must continue to require
    // `seenUpToSeq` / model-seen provenance.
    const hasModelSeenBoundaryCapability =
      typeof agentOrchestrator.hasMachineCapability === "function"
      && agentOrchestrator.hasMachineCapability(req.machineId, DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY);
    if (!hasModelSeenBoundaryCapability && seqs.length > 0) {
      await channelService.markAgentLegacyAckCheckpoint(agentId, seqs);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Internal receive-ack error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to acknowledge received messages" });
  }
});

// Legacy runtime-control action. Runtime Profile changes now reset the
// session automatically, so this endpoint is a compatibility no-op that can
// also clear old pending migration rows left by pre-reset-session deployments.
internalRouter.post("/agent/:id/runtime-profile/migration-done", async (req, res) => {
  try {
    const agentId = req.params.id;
    const migrationKey = typeof req.body?.migrationKey === "string"
      ? req.body.migrationKey.trim()
      : "";

    const result = await loadOwnedMachineAgent(agentId, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }

    const launchId = typeof req.headers["x-agent-launch-id"] === "string"
      ? req.headers["x-agent-launch-id"]
      : null;
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const handled = await agentOrchestrator.completeRuntimeProfileMigrationFromAgent(
      agentId,
      migrationKey,
      launchId,
    );
    if (!handled) {
      res.json({
        ok: true,
        deprecated: true,
        noop: "no pending migration",
        message: "Runtime Profile migration acknowledgments are deprecated; runtime changes reset the session automatically.",
      });
      return;
    }

    res.json({
      ok: true,
      deprecated: true,
      message: "Runtime Profile migration acknowledgments are deprecated; runtime changes reset the session automatically.",
    });
  } catch (err) {
    console.error("Internal runtime-profile migration-done error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to complete runtime profile reset acknowledgment" });
  }
});

// Agent resolves a cited message id exactly. This is a verifier command, not a
// context-navigation fallback: unknown or ambiguous ids fail closed.
internalRouter.get("/agent/:id/messages/:messageId/resolve", requireAgentScope("message:read"), async (req, res) => {
  try {
    const agentId = req.params.id;
    const rawMessageId = req.params.messageId;

    const result = await loadOwnedMachineAgent(agentId, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;

    const resolved = await messageService.resolveMessageIdVisibleToAgent(agent.serverId, agentId, rawMessageId);
    if (!resolved.ok) {
      res.status(resolved.status).json(messageResolveErrorPayload(resolved));
      return;
    }

    const payload = await resolveAgentVisibleMessagePayload(resolved.messageId, agent.serverId, agentId);
    if (!payload) {
      res.status(404).json({ error: "Message not found", errorCode: "NOT_FOUND" });
      return;
    }

    res.json({ message: payload });
  } catch (err) {
    console.error("Internal message resolve error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to resolve message" });
  }
});

// Agent reads message history
internalRouter.get("/agent/:id/history", requireAgentScope("message:read"), async (req, res) => {
  try {
    const agentId = req.params.id;
    const channelRef = req.query.channel as string;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const around = typeof req.query.around === "string" ? req.query.around.trim() : undefined;

    if (!channelRef) {
      res.status(400).json({ error: "channel query param is required (e.g. #all, DM:@richard)" });
      return;
    }

    const result = await loadOwnedMachineAgent(agentId, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;

    const resolved = await channelService.resolveChannelByName(agent.serverId, agentId, channelRef);
    if (!resolved) {
      res.status(404).json({ error: `Channel not found: ${channelRef}` });
      return;
    }

    const channelId = resolved.channelId;
    const hasAccess = await channelService.canAgentAccessChannel(channelId, agentId);
    if (!hasAccess) {
      res.status(403).json({ error: "You do not have access to this history" });
      return;
    }

    const channel = await channelService.getChannel(channelId);
    const jointThreadProjection = channel?.type === "thread"
      ? await channelService.getJointThreadProjectionByLocalThread(channelId, agent.serverId)
      : null;
    const resolvedAccess = channel?.type === "joint"
      ? await channelService.resolveChannelAccess({ serverId: agent.serverId, channelId })
      : null;
    const storageChannelId = jointThreadProjection?.canonicalThreadChannelId
      ?? (resolvedAccess?.kind === "joint" ? resolvedAccess.canonicalChannelId : channelId);
    const projectionChannelId = jointThreadProjection?.localThreadChannelId
      ?? (resolvedAccess?.kind === "joint" ? resolvedAccess.localChannelId : channelId);
    const lastReadSeq = await channelService.getAgentLegacyReadCursor(agentId, channelId);

    // Apply plan-based history limit
    const plan = await getServerPlan(agent.serverId);
    const historyCutoff = getHistoryCutoff(plan);
    const beforeAnchor = typeof req.query.before === "string" ? req.query.before.trim() : undefined;
    const afterAnchor = typeof req.query.after === "string" ? req.query.after.trim() : undefined;
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
      ? await messageService.resolveMessageSeqAnchor(storageChannelId, beforeAnchor, "pagination", historyCutoff)
      : undefined;
    if (beforeResolution && !beforeResolution.ok) {
      const failure = historyAnchorErrorPayload(channelRef, beforeAnchor!, beforeResolution.reason);
      res.status(failure.status).json(failure.body);
      return;
    }
    const afterResolution = afterAnchor
      ? await messageService.resolveMessageSeqAnchor(storageChannelId, afterAnchor, "pagination", historyCutoff)
      : undefined;
    if (afterResolution && !afterResolution.ok) {
      const failure = historyAnchorErrorPayload(channelRef, afterAnchor!, afterResolution.reason);
      res.status(failure.status).json(failure.body);
      return;
    }
    const beforeSeq = beforeResolution?.ok ? beforeResolution.seq : undefined;
    const afterSeq = afterResolution?.ok ? afterResolution.seq : undefined;
    let msgs;
    let hasOlder = false;
    let hasNewer = false;

    if (around) {
      const beforeCount = Math.floor((limit - 1) / 2);
      const afterCount = limit - beforeCount - 1;
      if (!isHistoryAnchorShape(around)) {
        const failure = historyAnchorErrorPayload(channelRef, around, "invalid");
        res.status(failure.status).json(failure.body);
        return;
      }
      const aroundResolution = await messageService.resolveMessageSeqAnchor(storageChannelId, around, "around", historyCutoff);
      if (!aroundResolution.ok) {
        const failure = historyAnchorErrorPayload(channelRef, around, aroundResolution.reason);
        res.status(failure.status).json(failure.body);
        return;
      }
      const context = await messageService.getMessageContextBySeq(
        storageChannelId,
        aroundResolution.seq,
        beforeCount,
        afterCount,
        historyCutoff,
        {
          forwardedBundleViewerAgentId: agent.id,
          forwardedBundleViewerServerId: agent.serverId,
        },
      );
      if (!context || context.channelId !== storageChannelId) {
        const failure = historyAnchorErrorPayload(channelRef, around, "not_found");
        res.status(failure.status).json(failure.body);
        return;
      }
      msgs = context.messages;
      hasOlder = context.hasOlder;
      hasNewer = context.hasNewer;
    } else {
      msgs = await messageService.listMessages(storageChannelId, limit + 1, beforeSeq, afterSeq, historyCutoff, {
        forwardedBundleViewerAgentId: agent.id,
        forwardedBundleViewerServerId: agent.serverId,
      });
    }

    if (jointThreadProjection || resolvedAccess?.kind === "joint") {
      msgs = await messageService.projectJointMessagesToLocalChannel(msgs, projectionChannelId, agent.serverId);
    }
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

    // Check if plan limit is truncating results
    let historyLimited = false;
    let historyLimitMessage: string | undefined;
    if (historyCutoff) {
      historyLimited = await messageService.hasOlderMessages(storageChannelId, historyCutoff, beforeSeq);
      if (historyLimited) {
        const days = getEffectiveLimits(plan as ServerPlan).messageHistoryDays;
        historyLimitMessage = `History limited to ${days} days on the ${PLAN_CONFIG[plan as ServerPlan].displayName} plan.`;
      }
    }

    // Advance the legacy read-ish cursor to the max seq in returned messages
    // (GREATEST prevents regression). This is not a delivery replay boundary.
    if (pageMsgs.length > 0) {
      const maxSeq = Math.max(...pageMsgs.map((m) => m.seq ?? 0));
      if (maxSeq > 0) {
        channelService.markAgentLegacyRead(agentId, channelId, maxSeq).then((readState) =>
          emitScopeReadUpdated({
            io: req.app.get("io") as SocketServer | undefined,
            serverId: agent.serverId,
            scopeId: channelId,
            peerKind: "agent",
            peerId: agentId,
            maxReadSeq: readState.maxReadSeq,
            changed: readState.changed,
          })
        ).catch(() => {});
      }
    }

    const threadParentMessageIds = getHistoryThreadParentMessageIds(pageMsgs);
    const threadSummaries = threadParentMessageIds.length > 0
      ? await channelService.getThreadSummariesForParentMessages(threadParentMessageIds)
      : {};
    const renderedHistoryContents = await agentPermalinkRenderService.renderAgentReadablePermalinksInTexts(
      pageMsgs.map((message) => message.content),
      agent.serverId,
    );
    const enrichedMsgs = applyHistoryThreadMetadata(pageMsgs, threadSummaries);
    res.json({
      messages: enrichedMsgs.map((message: any, index: number) => {
        const external = message.senderType === "external_projection";
        const {
          externalAuthor: _externalAuthor,
          actionMetadata,
          taskStatus,
          taskNumber,
          taskAssigneeType,
          taskAssigneeId,
          taskAssigneeName,
          ...visibleMessage
        } = message;
        return {
          ...visibleMessage,
          senderType: message.messageType === "system" ? "system" : toAgentFacingActorType(message.senderType),
          ...(!external && {
            actionMetadata,
            taskStatus,
            taskNumber,
            taskAssigneeType: taskAssigneeType ? toAgentFacingActorType(taskAssigneeType) : null,
            taskAssigneeId,
            taskAssigneeName,
          }),
          content: messageService.appendAgentFacingForwardedSnapshot(
            messageService.renderAgentVisibleMessageContent(message, renderedHistoryContents[index] ?? ""),
            external ? null : actionMetadata,
          ),
          ...messageService.toAgentVisibleExternalMessage(message),
        };
      }),
      has_more: hasOlder || hasNewer,
      has_older: hasOlder,
      has_newer: hasNewer,
      last_read_seq: lastReadSeq,
      historyLimited,
      historyLimitMessage,
    });
  } catch (err) {
    console.error("Internal history error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to read history" });
  }
});

const EXPLICIT_SEARCH_TIMESTAMP_OFFSET_RE = /(?:[zZ]|[+-]\d{2}:\d{2})$/;

function parseOffsetSearchTimestamp(raw: string): { ok: true; value: Date } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!EXPLICIT_SEARCH_TIMESTAMP_OFFSET_RE.test(trimmed)) {
    return {
      ok: false,
      error: "Search date filters are missing a timezone offset; use a \"+08:00\"-style ISO timestamp or the raft CLI.",
    };
  }
  const value = new Date(trimmed);
  if (Number.isNaN(value.getTime())) {
    return {
      ok: false,
      error: "Invalid date filter; use an ISO timestamp with a timezone offset such as 2026-08-06T04:38:00+08:00 or the raft CLI.",
    };
  }
  return { ok: true, value };
}

internalRouter.get("/agent/:id/search", requireAgentScope("message:read"), async (req, res) => {
  const requestAbort = bindRequestAbortSignal(req, res);
  try {
    const agentId = req.params.id;
    const rawQuery = typeof req.query.q === "string" ? req.query.q : "";
    const query = rawQuery.trim();

    const result = await loadOwnedMachineAgent(agentId, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;

    const channelRef = typeof req.query.channel === "string" ? req.query.channel : undefined;
    let channelId: string | undefined;
    if (channelRef) {
      const resolved = await channelService.resolveChannelByName(agent.serverId, agentId, channelRef);
      if (!resolved) {
        res.status(404).json({ error: `Channel not found: ${channelRef}` });
        return;
      }
      channelId = resolved.channelId;
    }

    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const senderFilter = await resolveSearchSenderFilter(
      agent.serverId,
      { type: "agent", id: agentId },
      req.query.sender,
      req.query.senderId,
    );
    if (!senderFilter.ok) {
      res.status(senderFilter.status).json({ error: senderFilter.error, errorCode: senderFilter.errorCode });
      return;
    }
    const afterRaw = typeof req.query.after === "string" ? req.query.after : undefined;
    const beforeRaw = typeof req.query.before === "string" ? req.query.before : undefined;
    const afterParsed = afterRaw ? parseOffsetSearchTimestamp(afterRaw) : undefined;
    if (afterParsed && !afterParsed.ok) {
      res.status(400).json({ error: afterParsed.error, errorCode: "INVALID_DATE_FILTER" });
      return;
    }
    const beforeParsed = beforeRaw ? parseOffsetSearchTimestamp(beforeRaw) : undefined;
    if (beforeParsed && !beforeParsed.ok) {
      res.status(400).json({ error: beforeParsed.error, errorCode: "INVALID_DATE_FILTER" });
      return;
    }
    const after = afterParsed?.value;
    const before = beforeParsed?.value;
    const sortRaw = typeof req.query.sort === "string" ? req.query.sort : undefined;
    if (sortRaw && sortRaw !== "relevance" && sortRaw !== "recent") {
      res.status(400).json({ error: "Invalid search sort" });
      return;
    }
    const sort = sortRaw === "recent" ? "recent" : "relevance";
    const hasMeaningfulFilter = Boolean(channelId || senderFilter.senderId || after || before);
    if (!query && !hasMeaningfulFilter) {
      res.json({ results: [], hasMore: false });
      return;
    }

    const searchResponse = await searchService.searchMessagesForAgent({
      serverId: agent.serverId,
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
        agent.serverId,
      ),
      agentPermalinkRenderService.renderAgentReadablePermalinksInTexts(
        searchResponse.results.map((result) => result.snippet),
        agent.serverId,
      ),
      loadCanonicalTaskFactsByMessageId(searchResponse.results.map((result) => result.id)),
    ]);

    res.json({
      ...searchResponse,
      results: searchResponse.results.map((result, index) => {
        const { externalMessage, ...visibleResult } = result;
        const external = result.senderType === "external_projection";
        const taskFact = external ? undefined : taskFacts.get(result.id);
        return {
          ...visibleResult,
          senderType: toAgentFacingActorType(result.senderType),
          ...(externalMessage ? { external_message: externalMessage } : {}),
          content: external
            ? renderThirdPartyInertText({ field: "tool_result", value: result.content })
            : renderedContents[index],
          snippet: external
            ? renderThirdPartyInertText({ field: "tool_result", value: result.snippet })
            : renderedSnippets[index],
          ...(taskFact && {
            taskStatus: taskFact.taskStatus,
            taskNumber: taskFact.taskNumber,
            taskCurrentProjection: {
              ...taskFact.taskCurrentProjection,
              amendedAt: taskFact.taskCurrentProjection.amendedAt?.toISOString() ?? null,
            },
          }),
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
    console.error("Internal search error:", serializeErrorForLog(err));
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to search messages" });
    }
  } finally {
    requestAbort.cleanup();
  }
});

internalRouter.post("/agent/:id/channels/:channelId/join", requireAgentScope("channel:join"), async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const channel = await channelService.getChannel(req.params.channelId);
    if (!channel || channel.serverId !== result.agent.serverId) {
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
    const wasAgentMember = await channelService.isChannelAgent(channel.id, result.agent.id);
    if (wasAgentMember) {
      res.json({ ok: true });
      return;
    }
    if (!await actorHasServerCapabilityInServer(result.agent.serverId, "agent", result.agent.id, "joinPublicChannels")) {
      res.status(403).json({ error: "Server role cannot join public channels" });
      return;
    }

    await channelService.addAgent(channel.id, result.agent.id);
    if (!wasAgentMember) {
      const io = req.app.get("io") as SocketServer | undefined;
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
      if (io && agentOrchestrator) {
        await messageService.broadcastSystemMessage(
          io,
          agentOrchestrator,
          channel.id,
          `@${result.agent.name} joined this channel.`,
          {
            inboxFactPolicy: {
              mode: "record",
              producer: "agent.join_channel",
              reason: "agent joining a channel is shared channel activity",
            },
            // The joining agent should not see its own join as unread.
            causalActor: { type: "agent", id: result.agent.id },
          },
        );
      }
    }
    req.app.get("io")?.to(`server:${result.agent.serverId}`).emit("channel:members-updated", { channelId: channel.id });
    res.json({ ok: true });
    recordRaftCliActivity(req, result.agent.id, {
      command: "channel.join",
      summary: "Joined channel",
      target: channel.name ? `#${channel.name}` : channel.id,
    });
  } catch (err: any) {
    sendJsonServerError(req, res, {
      error: "Failed to join channel",
      code: "agent_channel_join_failed",
      logPrefix: "[Internal] Failed to join channel",
      err,
    });
  }
});

internalRouter.post("/agent/:id/channels/:channelId/leave", requireAgentScope("channel:leave"), async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const channel = await channelService.getChannel(req.params.channelId);
    if (!channel || channel.serverId !== result.agent.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type !== "channel" && channel.type !== "private") {
      res.status(403).json({ error: "Agents can only leave regular channels" });
      return;
    }
    const hasAccess = await channelService.canAgentAccessChannel(channel.id, result.agent.id);
    if (!hasAccess) {
      res.status(403).json({ error: "Agents can only leave visible regular channels" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    await channelService.removeAgent(channel.id, result.agent.id);
    if (channel.type !== "channel") {
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
      await agentOrchestrator.purgeAgentInboxForChannelTree(
        result.agent.id,
        channel.id,
        "channel_membership_removed",
      );
    }
    req.app.get("io")?.to(channel.type === "private" ? `channel:${channel.id}` : `server:${result.agent.serverId}`).emit("channel:members-updated", { channelId: channel.id });
    res.json({ ok: true });
    recordRaftCliActivity(req, result.agent.id, {
      command: "channel.leave",
      summary: "Left channel",
      target: channel.name ? `#${channel.name}` : channel.id,
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

internalRouter.post("/agent/:id/channels", requireAgentScope("channel:create"), async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const created = await createChannelForAgent({
      actor: { id: result.agent.id, name: result.agent.name, serverId: result.agent.serverId },
      serverId: result.agent.serverId,
      body: req.body,
      io: req.app.get("io") as SocketServer | undefined,
    });
    res.status(created.status).json(created.body);
    if (created.status >= 200 && created.status < 300) {
      const channelName = typeof created.body.name === "string" ? created.body.name : undefined;
      recordRaftCliActivity(req, result.agent.id, {
        command: "channel.create",
        summary: "Created channel",
        target: channelName ? `#${channelName}` : undefined,
      });
    }
  } catch (err) {
    console.error("Internal channel create error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to create channel" });
  }
});

internalRouter.patch("/agent/:id/channels/:channelId", requireAgentScope("channel:update"), async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const updated = await updateChannelForAgent({
      actor: { id: result.agent.id, name: result.agent.name, serverId: result.agent.serverId },
      serverId: result.agent.serverId,
      channelId: req.params.channelId,
      body: req.body,
      io: req.app.get("io") as SocketServer | undefined,
    });
    res.status(updated.status).json(updated.body);
    if (updated.status >= 200 && updated.status < 300) {
      const channelName = typeof updated.body.name === "string" ? updated.body.name : undefined;
      recordRaftCliActivity(req, result.agent.id, {
        command: "channel.update",
        summary: "Updated channel",
        target: channelName ? `#${channelName}` : req.params.channelId,
      });
    }
  } catch (err) {
    console.error("Internal channel update error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to update channel" });
  }
});

internalRouter.post("/agent/:id/channels/:channelId/members", requireAgentScope("channel:add_member"), async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const added = await addChannelMemberForAgent({
      actor: { id: result.agent.id, name: result.agent.name, serverId: result.agent.serverId },
      serverId: result.agent.serverId,
      channelId: req.params.channelId,
      body: req.body,
      io: req.app.get("io") as SocketServer | undefined,
      agentOrchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
    });
    res.status(added.status).json(added.body);
    if (added.status >= 200 && added.status < 300) {
      const member = added.body.member as { type?: string; name?: string } | undefined;
      recordRaftCliActivity(req, result.agent.id, {
        command: "channel.add_member",
        summary: "Added channel member",
        target: member?.name ? `@${member.name}` : undefined,
      });
    }
  } catch (err) {
    console.error("Internal channel add member error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to add member" });
  }
});

internalRouter.delete("/agent/:id/channels/:channelId/members", requireAgentScope("channel:remove_member"), async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const removed = await removeChannelMemberForAgent({
      actor: { id: result.agent.id, name: result.agent.name, serverId: result.agent.serverId },
      serverId: result.agent.serverId,
      channelId: req.params.channelId,
      body: req.body,
      io: req.app.get("io") as SocketServer | undefined,
      agentOrchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
    });
    res.status(removed.status).json(removed.body);
    if (removed.status >= 200 && removed.status < 300) {
      const member = removed.body.member as { type?: string; name?: string } | undefined;
      recordRaftCliActivity(req, result.agent.id, {
        command: "channel.remove_member",
        summary: "Removed channel member",
        target: member?.name ? `@${member.name}` : undefined,
      });
    }
  } catch (err) {
    console.error("Internal channel remove member error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to remove member" });
  }
});

internalRouter.post("/agent/:id/threads/unfollow", requireAgentScope("thread:unfollow"), async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const threadRef = typeof req.body?.thread === "string" ? req.body.thread.trim() : "";
    if (!threadRef) {
      res.status(400).json({ error: "thread is required" });
      return;
    }
    const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
      ? req.body.reason.trim()
      : "no longer following";

    let threadChannelId: string | null = null;
    if (UUID_RE.test(threadRef)) {
      const channel = await channelService.getChannel(threadRef);
      if (!channel || channel.serverId !== result.agent.serverId) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }
      if (channel.type !== "thread") {
        res.status(400).json({ error: "Target must be a thread" });
        return;
      }
      threadChannelId = channel.id;
    } else {
      const resolved = await channelService.resolveChannelByName(result.agent.serverId, result.agent.id, threadRef);
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

    await channelService.unfollowThreadForFollower("agent", result.agent.id, threadChannelId);
    const io = req.app.get("io") as SocketServer | undefined;
    await emitThreadFollowersUpdated(io, threadChannelId);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (io && agentOrchestrator) {
      await messageService.broadcastSystemMessage(
        io,
        agentOrchestrator,
        threadChannelId,
        `@${result.agent.name} stopped following this thread: ${messageService.summarizeForSystemMessage(reason)}`,
        {
          // Self-unfollow has a zero-person audience. Record no inbox fact.
          // Tenny ruling (#8): skip-mode, not born-read.
          inboxFactPolicy: {
            mode: "skip",
            producer: "channel.self_unfollow_thread",
            reason: "self-unfollow has zero audience — no inbox fact",
          },
        },
      );
    }
    res.json({ ok: true });
    recordRaftCliActivity(req, result.agent.id, {
      command: "thread.unfollow",
      summary: "Unfollowed thread",
      target: threadRef,
      correlationId: threadChannelId,
    });
  } catch (err: any) {
    sendJsonServerError(req, res, {
      error: "Failed to unfollow thread",
      code: "agent_thread_unfollow_failed",
      logPrefix: "[Internal] Failed to unfollow thread",
      err,
    });
  }
});

internalRouter.get("/agent/:id/channel-members", requireAgentScope("channel:read"), async (req, res) => {
  try {
    const channelRef = typeof req.query.channel === "string" ? req.query.channel : "";
    if (!channelRef) {
      res.status(400).json({ error: "channel query param is required (e.g. #general)" });
      return;
    }

    const ctx = await resolveAgentChannel(req.params.id, req.serverId!, req.machineId, channelRef);
    if (!ctx) {
      res.status(404).json({ error: `Channel not found: ${channelRef}` });
      return;
    }

    const members = await channelService.getChannelMembers(ctx.channelId);
    const visibleAgents = await Promise.all(members.agents.map(async (a) => ({
      name: a.name,
      status: a.status,
      role: await getActorServerRoleInServer(ctx.agent.serverId, "agent", a.id),
    })));
    const visibleHumans = await filterAgentVisibleHumansForHiddenDirectory(
      ctx.agent.serverId,
      ctx.agent.id,
      members.humans,
    );
    res.json({
      channel: { ref: channelRef, type: ctx.channelType },
      agents: visibleAgents,
      humans: visibleHumans.map((u) => ({ name: u.name, description: u.description, role: u.role })),
    });
  } catch (err) {
    console.error("Internal channel members error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to get channel members" });
  }
});

// Agent lists server info (all regular channels with joined status, agents, humans)
internalRouter.get("/agent/:id/server", requireAgentScope("server:read"), async (req, res) => {
  try {
    const agentId = req.params.id;

    const result = await loadOwnedMachineAgent(agentId, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;

    const channels = await channelService.listChannelsForAgent(agent.serverId, agentId);
    const allAgents = await buildServerInfoAgentSummaries(agent.serverId, agentOrchestrator);

    const members = await serverService.getServerMembers(agent.serverId, null);
    const visibleMembers = await filterAgentVisibleHumansForHiddenDirectory(
      agent.serverId,
      agent.id,
      members,
    );
    const humans = visibleMembers.map((m) => ({
      name: m.name,
      description: m.description,
      role: m.role,
    }));
    const machine = agent.machineId ? await machineService.getMachine(asMachineId(agent.machineId)) : null;
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

    const serverRole = await getActorServerRoleInServer(agent.serverId, "agent", agent.id);

    res.json({
      runtimeContext,
      serverRole,
      serverCapabilities: getServerCapabilities(serverRole),
      channels,
      agents: allAgents,
      humans,
    });
  } catch (err) {
    console.error("Internal server info error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to get server info" });
  }
});

internalRouter.patch("/agent/:id/server", requireAgentScope("server:update"), async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const updated = await updateServerProfileForAgent({
      actor: { id: result.agent.id, name: result.agent.name, serverId: result.agent.serverId },
      serverId: result.agent.serverId,
      body: req.body,
    });
    res.status(updated.status).json(updated.body);
    if (updated.status >= 200 && updated.status < 300) {
      recordRaftCliActivity(req, result.agent.id, {
        command: "server.update",
        summary: "Updated server profile",
        target: typeof updated.body.name === "string" ? updated.body.name : result.agent.serverId,
      });
    }
  } catch (err) {
    console.error("Internal server update error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to update server" });
  }
});

internalRouter.post("/agent/:id/server/avatar", requireAgentScope("server:update"), async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const authFailure = await assertAgentCanManageServerProfile({
      actor: { id: result.agent.id, name: result.agent.name, serverId: result.agent.serverId },
      serverId: result.agent.serverId,
    });
    if (authFailure) {
      res.status(authFailure.status).json(authFailure.body);
      return;
    }

    const server = await serverService.getServer(result.agent.serverId);
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
    recordRaftCliActivity(req, result.agent.id, {
      command: "server.avatar.update",
      summary: "Updated server avatar",
      target: updated.name,
    });
  } catch (err: any) {
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
    console.error("Internal server avatar update error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to upload avatar" });
  }
});

internalRouter.get("/agent/:id/knowledge", requireAgentScope("knowledge:read"), async (req, res) => {
  const agentId = req.params.id;
  const serverId = req.serverId;
  if (!serverId) {
    res.status(500).json({ error: "Machine authentication state missing" });
    return;
  }
  await handleAgentKnowledgeGet(req, res, { agentId, serverId, computerId: req.machineId ?? null });
});

internalRouter.get("/agent/:id/knowledge/search", requireAgentScope("knowledge:read"), async (req, res) => {
  const agentId = req.params.id;
  const serverId = req.serverId;
  if (!serverId) {
    res.status(500).json({ error: "Machine authentication state missing" });
    return;
  }
  await handleAgentKnowledgeSearch(req, res, { agentId, serverId, computerId: req.machineId ?? null });
});

internalRouter.get("/agent/:id/profile", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const resolved = await resolveProfileViewForAgent(
      result.agent.serverId,
      result.agent.id,
      req.query.target,
      agentOrchestrator,
    );
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }

    res.json(resolved.profile);
  } catch (err) {
    console.error("Internal profile read error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to load profile" });
  }
});

internalRouter.post("/agent/:id/profile/avatar", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const uploaded = await runSingleAvatarUpload(profileAvatarUpload, req);
    if (!uploaded) {
      res.status(400).json({ error: "No avatar file provided" });
      return;
    }

    const avatarUrl = await storeAgentAvatar(result.agent.serverId, result.agent.avatarUrl, uploaded.buffer);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (agentOrchestrator) {
      agentOrchestrator.evictCache(result.agent.id);
    }
    await agentService.updateAgent(result.agent.id, { avatarUrl });

    const profile = await buildAgentProfileView(result.agent.id, result.agent.id, agentOrchestrator);
    if (!profile) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    res.json(profile);
    recordRaftCliActivity(req, result.agent.id, {
      command: "profile.avatar.update",
      summary: "Updated profile avatar",
      target: `@${result.agent.name}`,
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
    console.error("Internal profile avatar update error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to update avatar" });
  }
});

const MAX_AGENT_PROFILE_DESCRIPTION_LENGTH = 3000;
const MAX_AGENT_PROFILE_DISPLAY_NAME_LENGTH = 80;

internalRouter.post("/agent/:id/profile", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const body = (req.body ?? {}) as { avatarUrl?: unknown; displayName?: unknown; description?: unknown };
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

    const updated = await agentService.updateAgent(result.agent.id, fields);
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (agentOrchestrator) {
      agentOrchestrator.evictCache(result.agent.id);
    }

    const profile = await buildAgentProfileView(result.agent.id, result.agent.id, agentOrchestrator);
    if (!profile) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    res.json(profile);
    recordRaftCliActivity(req, result.agent.id, {
      command: "profile.update",
      summary: "Updated profile",
      target: `@${profile.name}`,
    });
  } catch (err) {
    console.error("Internal profile update error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// ── Agent Task Board endpoints ──

// Helper: resolve channel from agent context (with machine ownership check)
async function resolveAgentChannel(agentId: string, serverId: string, machineId: string | undefined, channelRef: string) {
  const result = await loadOwnedMachineAgent(agentId, machineId, serverId);
  if ("error" in result) return null;
  const resolved = await channelService.resolveChannelByName(result.agent.serverId, agentId, channelRef);
  if (!resolved) return null;
  return { agent: result.agent, channelId: resolved.channelId, channelType: resolved.type };
}

async function resolveAgentTaskChannel(agentId: string, serverId: string, machineId: string | undefined, channelRef: string) {
  const result = await resolveAgentChannel(agentId, serverId, machineId, channelRef);
  if (!result) return null;
  const surface = await resolveTaskChannelSurface(serverId, result.channelId);
  if (!surface) return null;
  return {
    agent: result.agent,
    channelId: surface.localChannel.id,
    storageChannelId: surface.storageChannelId,
    localChannel: surface.localChannel,
    channelType: surface.localChannel.type,
    surface,
  };
}

function rejectAgentTaskWriteIfNeeded(canPost: boolean, res: Response): boolean {
  if (!canPost) {
    res.status(403).json({ error: "Agent must join this channel to modify tasks" });
    return true;
  }
  return false;
}

// Agent lists tasks
internalRouter.get("/agent/:id/tasks", requireAgentScope("task:read"), async (req, res) => {
  try {
    const channelRef = req.query.channel as string;
    if (!channelRef) {
      res.status(400).json({ error: "channel query param is required (e.g. #general)" });
      return;
    }

    const ctx = await resolveAgentTaskChannel(req.params.id, req.serverId!, req.machineId, channelRef);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }

    // Validate + narrow the optional ?status filter (was `as any`). A *present*
    // value is rejected with 400 unless it's a known TaskStatus string — this
    // fails closed on non-string params too (e.g. repeated `?status=a&status=b`,
    // which Express parses as an array), so the filter can't be bypassed.
    // Consistent with the reminders list endpoint; absent status = no filter.
    const statusParam = req.query.status;
    let statusFilter: TaskStatus | undefined;
    if (statusParam !== undefined) {
      if (typeof statusParam !== "string" || !isTaskStatus(statusParam)) {
        res.status(400).json({ error: "Invalid status value" });
        return;
      }
      statusFilter = statusParam;
    }
    const tasks = await taskService.listTasks(ctx.storageChannelId, statusFilter);
    res.json({ tasks: taskService.projectTasksToChannel(tasks, ctx.localChannel) });
  } catch (err) {
    console.error("Internal list tasks error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to list tasks" });
  }
});

// Agent creates tasks (batch)
internalRouter.post("/agent/:id/tasks", requireAgentScope("task:write"), async (req, res) => {
  try {
    const { channel, tasks: items } = req.body;
    if (!channel || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "channel and tasks array are required" });
      return;
    }
    if (items.length > 50) {
      res.status(400).json({ error: "Cannot create more than 50 tasks at once" });
      return;
    }
    for (const item of items) {
      if (!item.title || typeof item.title !== "string" || item.title.trim().length === 0) {
        res.status(400).json({ error: "Each task must have a non-empty title" });
        return;
      }
    }

    const ctx = await resolveAgentTaskChannel(req.params.id, req.serverId!, req.machineId, channel);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }
    if (ctx.channelType === "thread") {
      res.status(409).json({ error: "Thread messages cannot become tasks" });
      return;
    }
    if (rejectAgentTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, req.params.id), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const { tasks: created, hostMessages } = await taskService.createTasks(
      ctx.storageChannelId,
      "agent",
      req.params.id,
      items.map((i) => ({ title: i.title.trim() })),
    );

    const io: SocketServer = req.app.get("io");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const creatorName = created[0]?.createdByName || "Unknown";

    // v1.4: host message broadcasts on the ordinary message:new / agent-delivery
    // path; the task fact broadcasts separately on the task board.
    const targets = await getTaskRealtimeSurfaceTargets(ctx.surface);
    for (const target of targets) {
      const projectedTasks = taskService.projectTasksToChannel(created, target.localChannel);
      const projectedMessages = hostMessages.map((message) => ({ ...message, channelId: target.channelId }));
      for (const message of projectedMessages) {
        // message-realtime-producer: task-route.new.internal-agent
        emitTaskMessageNew(io, target, message, creatorName);
      }
      emitTaskCreated(io, target, {
        channelId: target.channelId,
        tasks: projectedTasks,
      });
      await messageService.deliverMessagesToAgents(
        agentOrchestrator,
        projectedMessages,
        creatorName,
      );
    }

    // Emit system message to chat (visible to humans + agents, counts as unread)
    const taskList = created.map((t) => `#${t.taskNumber} "${messageService.summarizeForSystemMessage(t.title)}"`).join(", ");
    const sysContent = `📋 ${created.length} new task${created.length > 1 ? "s" : ""} created: ${taskList}`;
    messageService.broadcastSystemMessageToLocalSurfaces(io, agentOrchestrator, ctx.channelId, sysContent, {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.created_summary",
        reason: "new shared tasks are channel activity",
      },
      // The agent that created the tasks should not see its own action as unread.
      causalActor: { type: "agent", id: req.params.id },
    }).catch(() => {});

    res.json({ tasks: taskService.projectTasksToChannel(created, ctx.localChannel) });
    recordRaftCliActivity(req, req.params.id, {
      command: "task.create",
      summary: `Created ${created.length} task${created.length === 1 ? "" : "s"}`,
      target: channel,
    });
  } catch (err) {
    console.error("Internal create tasks error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to create tasks" });
  }
});

// Agent batch claims tasks (by task_numbers and/or message_ids)
internalRouter.post("/agent/:id/tasks/claim", requireAgentScope("task:write"), async (req, res) => {
  try {
    const { channel, task_numbers, message_ids } = req.body;
    const hasTaskNumbers = Array.isArray(task_numbers) && task_numbers.length > 0;
    const hasMessageIds = Array.isArray(message_ids) && message_ids.length > 0;

    if (!channel || (!hasTaskNumbers && !hasMessageIds)) {
      res.status(400).json({ error: "channel and either task_numbers or message_ids array are required" });
      return;
    }

    const ctx = await resolveAgentTaskChannel(req.params.id, req.serverId!, req.machineId, channel);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }
    if (ctx.channelType === "thread") {
      res.status(409).json({ error: "Thread messages cannot be claimed as tasks" });
      return;
    }
    if (rejectAgentTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, req.params.id), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const io: SocketServer = req.app.get("io");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const agentName = ctx.agent.displayName || ctx.agent.name;
    const successfulClaims: { taskNumber: number; title: string; messageId: string }[] = [];

    // Claim by task numbers
    const results: { taskNumber?: number; messageId?: string; success: boolean; reason?: string }[] = [];
    if (hasTaskNumbers) {
      const batchResults = await taskService.batchClaimTasks(
        ctx.storageChannelId,
        task_numbers,
        "agent",
        req.params.id,
      );

      for (const r of batchResults) {
        let claimedMessageId: string | undefined;
        if (r.success && r.task) {
          const facts = await emitTaskMutationToSurfaces(io, ctx.surface, r.task);
          claimedMessageId = facts.messageId ?? undefined;
          if (facts.messageId) {
            successfulClaims.push({ taskNumber: facts.taskNumber, title: facts.title, messageId: facts.messageId });
          }
        }
        results.push({ taskNumber: r.taskNumber, messageId: claimedMessageId, success: r.success, reason: r.reason });
      }
    }

    // Convert messages to tasks then claim them (supports short ID prefixes)
    if (hasMessageIds) {
      for (const rawMsgId of message_ids) {
        // Resolve short ID prefix to full message ID
        const resolved = await taskService.resolveMessageInChannel(ctx.storageChannelId, rawMsgId);
        if (!resolved) {
          results.push({ messageId: rawMsgId, success: false, reason: "message not found" });
          continue;
        }
        const msgId = resolved.id;

        // First convert message to task
        const converted = await taskService.convertMessageToTask(msgId, "agent", req.params.id, ctx.storageChannelId);
        if (typeof converted === "string") {
          // If already converted, try to find and claim the existing task
          if (converted === "already converted") {
            const existingOwner = await taskService.resolveTaskByMessageId(msgId);
            if (existingOwner) {
              // P3: both arms of the old ownership ternary read the same field.
              const existingNumber = existingOwner.row.taskNumber;
              const reason = await taskService.getClaimConflictReasonForOwner(existingOwner, "agent", req.params.id);
              if (reason) {
                results.push({ messageId: msgId, success: false, reason, taskNumber: existingNumber });
                continue;
              }
              const claimed = await taskService.claimTask(existingOwner.row.id, "agent", req.params.id);
              if (typeof claimed !== "string") {
                const facts = await emitTaskMutationToSurfaces(io, ctx.surface, claimed);
                if (facts.messageId) {
                  successfulClaims.push({ taskNumber: facts.taskNumber, title: facts.title, messageId: facts.messageId });
                }
                results.push({ messageId: msgId, success: true, taskNumber: facts.taskNumber });
                continue;
              }
              results.push({ messageId: msgId, success: false, reason: claimed, taskNumber: existingNumber });
              continue;
            }
          }
          results.push({ messageId: msgId, success: false, reason: converted });
        } else {
          // Task created, now claim it. The host message was NOT rewritten by
          // the convert, so only the task board hears about this.
          const claimed = await taskService.claimTask(converted.id, "agent", req.params.id);
          if (typeof claimed !== "string") {
            const facts = await describeTaskMutation(claimed);
            const targets = await getTaskRealtimeSurfaceTargets(ctx.surface);
            for (const target of targets) {
              emitTaskCreated(io, target, {
                channelId: target.channelId,
                tasks: [taskService.projectTaskToChannel(facts.enriched, target.localChannel)],
              });
            }
            if (facts.messageId) {
              successfulClaims.push({ taskNumber: facts.taskNumber, title: facts.title, messageId: facts.messageId });
            }
            results.push({ messageId: msgId, success: true, taskNumber: facts.taskNumber });
          } else {
            results.push({ messageId: msgId, success: false, reason: claimed });
          }
        }
      }
    }

    // Task claim is a small-audience event — only the assignee/creator/reviewer
    // cares (stdrc #proj-task msg=b9b41129 + msg=c580faed). No chat-surface
    // 📌 system message; the assignment is reflected on the task card itself.
    void successfulClaims;

    res.json({ results });
    if (successfulClaims.length > 0) {
      recordRaftCliActivity(req, req.params.id, {
        command: "task.claim",
        summary: `Claimed ${successfulClaims.length} task${successfulClaims.length === 1 ? "" : "s"}`,
        target: channel,
      });
    }
  } catch (err) {
    console.error("Internal claim tasks error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to claim tasks" });
  }
});

// Agent unclaims a task
internalRouter.post("/agent/:id/tasks/unclaim", requireAgentScope("task:write"), async (req, res) => {
  try {
    const { channel, task_number } = req.body;
    if (!channel || task_number == null) {
      res.status(400).json({ error: "channel and task_number are required" });
      return;
    }

    const ctx = await resolveAgentTaskChannel(req.params.id, req.serverId!, req.machineId, channel);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }
    if (rejectAgentTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, req.params.id), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const result = await taskService.unclaimTask(task.id, "agent", req.params.id);
    if (typeof result === "string") {
      res.status(409).json({ error: result });
      return;
    }

    const io: SocketServer = req.app.get("io");
    await emitTaskMutationToSurfaces(io, ctx.surface, result);

    // Task unclaim is a small-audience event — no chat-surface 🔓 system
    // message. (stdrc #proj-task msg=c580faed)

    res.json({ ok: true });
    recordRaftCliActivity(req, req.params.id, {
      command: "task.unclaim",
      summary: `Unclaimed task #${task_number}`,
      target: channel,
      correlationId: task.id,
    });
  } catch (err) {
    console.error("Internal unclaim task error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to unclaim task" });
  }
});

// Agent updates task status
internalRouter.post("/agent/:id/tasks/update-status", requireAgentScope("task:write"), async (req, res) => {
  try {
    const { channel, task_number, status } = req.body;
    if (!channel || task_number == null || !status) {
      res.status(400).json({ error: "channel, task_number, and status are required" });
      return;
    }
    if (!["todo", "in_progress", "in_review", "done", "closed"].includes(status)) {
      res.status(400).json({ error: "invalid status" });
      return;
    }

    const ctx = await resolveAgentTaskChannel(req.params.id, req.serverId!, req.machineId, channel);
    if (!ctx) {
      res.status(404).json({ error: "Agent or channel not found" });
      return;
    }
    if (rejectAgentTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, req.params.id), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const result = await taskService.updateTaskStatus(task.id, status, req.params.id, "agent");
    if (typeof result === "string") {
      res.status(409).json({ error: result });
      return;
    }

    const io: SocketServer = req.app.get("io");
    await emitTaskMutationToSurfaces(io, ctx.surface, result);

    // Task status transitions are small-audience lifecycle churn — no
    // chat-surface system message. (stdrc #proj-task msg=ef870d97 +
    // msg=b9b41129 + msg=c580faed). The current status is rendered on the
    // task card itself; assignee/creator/reviewer follow via task UI.

    res.json({ ok: true });
    recordRaftCliActivity(req, req.params.id, {
      command: "task.update_status",
      summary: `Updated task #${task_number} to ${status}`,
      target: channel,
      correlationId: task.id,
    });
  } catch (err) {
    console.error("Internal update-status task error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to update task status" });
  }
});

const REMINDER_MAX_TITLE_LEN = 500;

// Agent lists its own reminders
internalRouter.get("/agent/:id/reminders", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("status" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const statusRaw = typeof req.query.status === "string" ? req.query.status : "";
    let statusFilter: ReminderStatus[] = ["scheduled", "fired"];
    if (statusRaw) {
      const parts = statusRaw.split(",").map((s) => s.trim()).filter(Boolean);
      const validated: ReminderStatus[] = [];
      for (const p of parts) {
        if (!isReminderStatus(p)) {
          res.status(400).json({ error: "Invalid status value" });
          return;
        }
        validated.push(p); // p narrowed to ReminderStatus by the guard — no cast
      }
      statusFilter = validated;
    } else if (req.query.all === "true") {
      statusFilter = ["scheduled", "fired", "canceled"];
    }

    const rows = await reminderCrud.listAppReminders({
      serverId: req.serverId!,
      ownerAgentId: req.params.id,
      status: statusFilter,
    });
    const summaries = await reminderService.toReminderSummaries(rows, req.serverId!);
    res.json({ reminders: summaries });
  } catch (err) {
    console.error("Internal list reminders error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to list reminders" });
  }
});

// Agent schedules a reminder for itself
internalRouter.post("/agent/:id/reminders", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("status" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const { title, fireAt, delaySeconds, msgId, payload, repeat, tz, channel } = req.body ?? {};
    if (typeof title !== "string" || title.trim().length === 0) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    if (title.length > REMINDER_MAX_TITLE_LEN) {
      res.status(400).json({ error: `title must be at most ${REMINDER_MAX_TITLE_LEN} characters` });
      return;
    }

    // Snapshot the caller's IANA timezone into daily/weekly rules at create
    // time so later fires don't drift when the caller's host tz changes. If
    // the caller doesn't supply tz we fall back to UTC (safe for interval).
    let ruleTz = "UTC";
    if (tz !== undefined) {
      if (typeof tz !== "string" || tz.length === 0) {
        res.status(400).json({ error: "tz must be a non-empty IANA timezone string" });
        return;
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
      } catch {
        res.status(400).json({ error: `unknown timezone "${tz}"` });
        return;
      }
      ruleTz = tz;
    }

    let recurrence: Recurrence | null = null;
    if (repeat != null) {
      if (typeof repeat !== "string") {
        res.status(400).json({ error: "repeat must be a string (e.g. every:15m | daily@09:00 | weekly:mon,fri@09:00)" });
        return;
      }
      const parsed = parseRecurrenceString(repeat, ruleTz);
      if (!parsed.ok) {
        res.status(400).json({ error: `repeat: ${parsed.error}` });
        return;
      }
      // Wall-clock rules (daily, weekly) are ambiguous without an explicit
      // caller tz: silent UTC fallback would fire at wrong local times.
      // Force the caller to snapshot their tz so re-fires don't drift.
      if (
        (parsed.recurrence.rule.kind === "daily" || parsed.recurrence.rule.kind === "weekly") &&
        tz === undefined
      ) {
        res.status(400).json({
          error: "tz is required for daily@ or weekly: rules (IANA name, e.g. America/Los_Angeles)",
        });
        return;
      }
      recurrence = parsed.recurrence;
    }

    // For recurring reminders, delaySeconds/fireAt pin the *first* fire. If
    // neither is given, compute the first fire from the recurrence rule so
    // agents can write `--repeat daily@09:00` without also specifying when
    // the first one should go off.
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

    let resolvedMsgId: string | null = null;
    const resolved = await resolveReminderMsgId(req.serverId!, req.params.id, msgId);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    resolvedMsgId = resolved.messageId;

    // An explicit channel pins the future owner-agent wake surface. Scheduling
    // remains a personal event: no chat-surface receipt is broadcast here.
    let targetChannelId: string | null = null;
    if (channel != null) {
      if (typeof channel !== "string" || channel.length === 0) {
        res.status(400).json({ error: "channel must be a non-empty string" });
        return;
      }
      const ctx = await resolveAgentChannel(req.params.id, req.serverId!, req.machineId, channel);
      if (!ctx) {
        res.status(404).json({ error: "Agent or channel not found" });
        return;
      }
      targetChannelId = ctx.channelId;
    }

    const row = await reminderCrud.createAppReminder({
      serverId: req.serverId!,
      ownerAgentId: req.params.id,
      targetChannelId,
      msgId: resolvedMsgId,
      title: title.trim(),
      fireAt: fireAtDate,
      payload: payload ?? null,
      recurrence,
      createdBy: { type: "agent", id: req.params.id },
    });
    await syncReminderToComputer(req, row, "upsert");

    const io = req.app.get("io") as SocketServer;

    // No chat-surface "🔔 X scheduled a reminder ..." system message — schedule
    // is a personal event for the owner agent (per stdrc #proj-task msg=c580faed).
    // Audit lives in `reminder_events` (recordReminderEvent runs inside
    // createReminder); humans observe via the agent's reminder tab.

    const [summary] = await reminderService.toReminderSummaries([row], req.serverId!);

    // Live UI updates — humans watching the agent profile's Reminders tab
    // should see new entries appear without reloading. Scoped to the server
    // room so only members of this server receive it.
    io?.to(`server:${row.serverId}`).emit("reminder:scheduled", { reminder: summary });

    const body: { reminder: typeof summary; warning?: string } = { reminder: summary };
    if (warning) body.warning = warning;
    res.status(201).json(body);
    recordRaftCliActivity(req, req.params.id, {
      command: "reminder.schedule",
      summary: "Scheduled reminder",
      target: summary.msgRef ?? row.id,
      correlationId: row.id,
    });
  } catch (err) {
    console.error("Internal create reminder error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to create reminder" });
  }
});

// Agent cancels one of its own reminders
internalRouter.delete("/agent/:id/reminders/:reminderId", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("status" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const existing = await reminderCrud.getAppReminderById(req.params.reminderId);
    if (!existing || existing.serverId !== req.serverId || existing.ownerAgentId !== req.params.id) {
      res.status(404).json({ error: "Reminder not found" });
      return;
    }
    if (existing.status !== "scheduled" && existing.status !== "fired") {
      res.status(409).json({ error: `Reminder is already ${existing.status}` });
      return;
    }

    const canceled = await reminderCrud.cancelAppReminder(req.params.reminderId, {
      actor: { type: "agent", id: req.params.id },
      expectedVersion: existing.version,
    });
    if (!canceled) {
      res.status(409).json({ error: "Reminder state changed; refresh and retry" });
      return;
    }
    await syncReminderToComputer(req, canceled, "cancel");

    const [summary] = await reminderService.toReminderSummaries([canceled], req.serverId!);

    // Live UI update — pair with reminder:scheduled so the Reminders tab
    // reflects cancellations in real time without manual refresh.
    const io = req.app.get("io") as SocketServer;
    io?.to(`server:${canceled.serverId}`).emit("reminder:canceled", {
      reminderId: canceled.id,
      ownerAgentId: canceled.ownerAgentId,
    });

    res.json({ reminder: summary });
    recordRaftCliActivity(req, req.params.id, {
      command: "reminder.cancel",
      summary: "Canceled reminder",
      target: summary.msgRef ?? canceled.id,
      correlationId: canceled.id,
    });
  } catch (err) {
    console.error("Internal cancel reminder error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to cancel reminder" });
  }
});

// Agent snoozes one of its own scheduled/fired reminders
internalRouter.post("/agent/:id/reminders/:reminderId/snooze", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("status" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const { delaySeconds } = req.body ?? {};
    const schedule = resolveScheduleInput({ delaySeconds }, Date.now());
    if (!schedule.ok) {
      res.status(400).json({ error: schedule.error });
      return;
    }

    const existing = await reminderCrud.getAppReminderById(req.params.reminderId);
    if (!existing || existing.serverId !== req.serverId || existing.ownerAgentId !== req.params.id) {
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
      actor: { type: "agent", id: req.params.id },
      expectedVersion: existing.version,
    });
    if (!snoozed) {
      res.status(409).json({ error: "Reminder state changed; refresh and retry" });
      return;
    }
    await syncReminderToComputer(req, snoozed, "upsert");

    const [summary] = await reminderService.toReminderSummaries([snoozed], req.serverId!);
    const io = req.app.get("io") as SocketServer;
    io?.to(`server:${snoozed.serverId}`).emit("reminder:scheduled", { reminder: summary });
    res.json({ reminder: summary });
    recordRaftCliActivity(req, req.params.id, {
      command: "reminder.snooze",
      summary: "Snoozed reminder",
      target: summary.msgRef ?? snoozed.id,
      correlationId: snoozed.id,
    });
  } catch (err) {
    console.error("Internal snooze reminder error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to snooze reminder" });
  }
});

// Agent updates one of its own scheduled reminders
internalRouter.patch("/agent/:id/reminders/:reminderId", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("status" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const existing = await reminderCrud.getAppReminderById(req.params.reminderId);
    if (!existing || existing.serverId !== req.serverId || existing.ownerAgentId !== req.params.id) {
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

    const { fireAt, delaySeconds, repeat, title, tz } = req.body ?? {};
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
      if (typeof repeat !== "string") {
        res.status(400).json({ error: "repeat must be a string (e.g. every:15m | daily@09:00 | weekly:mon,fri@09:00)" });
        return;
      }
      let ruleTz = "UTC";
      if (tz !== undefined) {
        if (typeof tz !== "string" || tz.length === 0) {
          res.status(400).json({ error: "tz must be a non-empty IANA timezone string" });
          return;
        }
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
        } catch {
          res.status(400).json({ error: `unknown timezone "${tz}"` });
          return;
        }
        ruleTz = tz;
      }
      const parsed = parseRecurrenceString(repeat, ruleTz);
      if (!parsed.ok) {
        res.status(400).json({ error: `repeat: ${parsed.error}` });
        return;
      }
      if (
        (parsed.recurrence.rule.kind === "daily" || parsed.recurrence.rule.kind === "weekly") &&
        tz === undefined
      ) {
        res.status(400).json({
          error: "tz is required for daily@ or weekly: rules (IANA name, e.g. America/Los_Angeles)",
        });
        return;
      }
      patch = { kind: "recurrence", recurrence: parsed.recurrence };
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
      actor: { type: "agent", id: req.params.id },
      expectedVersion: existing.version,
    });
    if (!updated) {
      res.status(409).json({ error: "Reminder state changed; refresh and retry" });
      return;
    }
    await syncReminderToComputer(req, updated, "upsert");

    const [summary] = await reminderService.toReminderSummaries([updated], req.serverId!);
    const io = req.app.get("io") as SocketServer;
    io?.to(`server:${updated.serverId}`).emit("reminder:scheduled", { reminder: summary });
    const body: { reminder: typeof summary; warning?: string } = { reminder: summary };
    if (warning) body.warning = warning;
    res.json(body);
    recordRaftCliActivity(req, req.params.id, {
      command: "reminder.update",
      summary: "Updated reminder",
      target: summary.msgRef ?? updated.id,
      correlationId: updated.id,
    });
  } catch (err) {
    console.error("Internal update reminder error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to update reminder" });
  }
});

// Agent reads lifecycle log for one of its own reminders
internalRouter.get("/agent/:id/reminders/:reminderId/log", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("status" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const existing = await reminderCrud.getAppReminderById(req.params.reminderId);
    if (!existing || existing.serverId !== req.serverId || existing.ownerAgentId !== req.params.id) {
      res.status(404).json({ error: "Reminder not found" });
      return;
    }

    const events = await reminderCrud.listAppReminderEvents(existing.id);
    res.json({ events: reminderService.toReminderEventSummaries(events) });
  } catch (err) {
    console.error("Internal reminder log error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to read reminder log" });
  }
});

// ── Operation cards (B-mode) — agent prepares an action card ────────────────
//
// Body: { target: "#channel" | "dm:@peer" | thread, action: ActionCardAction }
// Resolves the target with the same writable-target helper used by message
// send, then posts a system message in that target whose
// actionMetadata.kind === "action-card" carries the prepared action.

internalRouter.post("/agent/:id/prepare-action", requireAgentScope("action:prepare"), async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("status" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const body = (req.body ?? {}) as { target?: unknown; action?: unknown };
    if (typeof body.target !== "string" || body.target.trim().length === 0) {
      res.status(400).json({ error: "target is required" });
      return;
    }
    const actionType = typeof (body.action as { type?: unknown } | null | undefined)?.type === "string"
      ? (body.action as { type: string }).type
      : null;
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
    const resolved = await resolveWritableAgentTarget(
      req.serverId!,
      req.params.id,
      target,
    );
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
      serverId: req.serverId!,
      requesterAgentId: req.params.id,
      targetChannelId: resolved.channelId,
      action: body.action as Parameters<typeof actionCardsService.prepareActionCard>[0]["action"],
      io: io ?? null,
    });
    res.status(201).json({ messageId: out.messageId, metadata: out.metadata });
    recordRaftCliActivity(req, req.params.id, {
      command: "action.prepare",
      summary: "Prepared action card",
      target: body.target.trim(),
      correlationId: out.messageId,
    });
  } catch (err) {
    if (err instanceof actionCardsService.ActionCardError) {
      res.status(err.status).json({ error: err.message, errorCode: err.code });
      return;
    }
    console.error("Internal prepare-action error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to prepare action card" });
  }
});

// ── Daemon scope-set fetch ──────────────────────────────────────────────────
//
// Called by the daemon on connect (and consumed by Noel's hot-swap cache on
// `agent:scope-updated` ws event). Returns the canonical AgentScopeSet wire
// shape — daemons cache this verbatim so the raft CLI wrapper can
// short-circuit obviously-denied calls before they hit the wire.
//
// No requireAgentScope() here — fetching one's own scope set is intrinsic to
// being an agent. The route still honors machine ownership: a machine API
// key cannot pull the scope set of an agent it doesn't own.
internalRouter.get("/agent/:id/scopes", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("status" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const set = await agentScopesService.loadAgentScopes(req.params.id);
    res.json(set);
  } catch (err) {
    if (err instanceof agentScopesService.AgentScopesNotFoundError) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    console.error("Internal agent scopes error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to load agent scopes" });
  }
});
