import { JointChannelAccessChangedError } from "../lib/channelActorPermissions";
import { projectRuntimeErrorActivityDetail, projectRuntimeErrorState } from "../services/agentRuntimeErrorVisibility";
import { DmPeerNotMemberError } from "../services/dmSendPolicy";
import { DEPRECATED_GRAVATAR_HASH, formatAgentTaskRefTail, isSubConversationType } from "@botiverse/raft-shared";
import { respondToTaskWriteError } from "../lib/taskWriteErrorResponse";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { traceIdentityHash } from "../tracing/traceIdentity";
import { refuseIfRemindersMovedToApp, reminderMigratedRefusal } from "./reminderAppRollout";
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
import * as messageService from "../services/messageService";
import { agentMessageCardField } from "../services/messageCardService";
import * as channelService from "../services/channelService";
import * as agentService from "../services/agentService";
import * as machineService from "../services/machineService";
import * as serverService from "../services/serverService";
import * as taskService from "../services/taskService";
import {
  getTaskRealtimeSurfaceTargets,
  isHistoricalJointTaskReadOnly,
  resolveTaskChannelSurface,
} from "../services/taskChannelSurface";
import * as searchService from "../services/searchService";
import * as reminderCrud from "../apps/reminder/crud";
import * as reminderService from "../apps/reminder/service";
import { publishReminderEvent } from "../apps/reminder/realtime";
import * as oauthService from "../services/oauthService";
import { resolveScheduleInput } from "../services/reminderScheduleInput";
import { parseRecurrenceString, computeNextFire, formatRecurrence, type Recurrence } from "../services/recurrence";
import * as agentPermalinkRenderService from "../services/agentPermalinkRenderService";
import * as actionCardsService from "../services/actionCardsService";
import { messageWithoutAgentHiddenActionCardSpec, withoutAgentHiddenActionCardSpec } from "../services/actionCardPresentation";
import * as attestedSendService from "../services/attestedSendService";
import { emitScopeReadUpdated } from "../services/readReceiptService";
import { emitThreadFollowersUpdated } from "../services/threadFollowerRealtimeService";
import { emitTaskCreated, emitTaskMessageNew } from "../services/taskRealtimeEvents";
import { INVALID_TASK_SOURCE_STEP, isTaskV2ConversationsEnabled, TaskV2NotEnabledError, taskSourceRequiredRefusal } from "../services/taskConversationsGate";
import { taskV2ClaimByMessageRefusal } from "../services/taskV2UseCreate";
import { announceTaskClaim, announceTasksCreatedFromSourceMessages, buildTaskStatusNotice, postTaskConversationNotice } from "../services/taskConversationNotice";
import {
  describeTaskMutation,
  emitTaskMutationToSurfaces,
  withTaskConversationEnsured,
} from "../services/taskMutationBroadcast";
import {
  loadCanonicalTaskFactsByMessageId,
  refreshQueuedAgentTaskProjections,
  withAgentSourceTasks,
  withProjectedTaskFacts,
} from "../services/messageTaskProjection";
import { projectRichMessageSocketPayload } from "../services/messageRealtimeEvents";
import { mutateMessageReaction } from "../services/messageReactionService";
import { ChannelConversionInProgressError } from "../services/channelConversionFenceService";
import { buildMachineReadModel } from "../services/machineReadModel";
import { resolveSearchSenderFilter } from "../services/searchSenderFilterService";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions";
import { getServerPlan, getHistoryCutoff, channelBillingReadOnlyRefusal, getChannelBillingReadOnly, isChannelReadOnlyByQuota } from "../services/planService";
import { agentHistoryLimitedRefusal, agentHistoryLimitNote, getServerHistoryWindowForRead, isBehindHistoryWindow } from "../services/historyWindow";
import { resolveMessageResourceAccess } from "../services/messageResourceAccess";
import {
  DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY,
  buildApmFreshnessDecisionProducerFactId,
  projectApmHeldFreshnessActivity,
  projectApmHeldFreshnessEnvelope,
  getServerCapabilities,
  renderThirdPartyInertText,
  isSlackBridgedExternalProvider,
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
  type TaskStatus,
  type ActionCardAction,
  type ApmFreshnessHeldDecision,
  FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_METADATA_KEYS,
  FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_RESULT_METADATA_KEYS,
  FEEDBACK_TRANSCRIPT_OUTCOME_MAX_UPLOAD_BYTES,
  isFeedbackTranscriptUploadableContentKind,
  readFeedbackTranscriptByteCount,
  readFeedbackTranscriptRequestId,
  type FeedbackTraceBundleTranscriptResultMetadataKey,
  asMachineId,
  FEEDBACK_MACHINE_EVIDENCE_MAX_UPLOAD_BYTES,
  FEEDBACK_AGENT_EVENT_TAIL_MAX_UPLOAD_BYTES,
  FEEDBACK_AGENT_EVENT_TAIL_OBJECT_KEY_PREFIX,
  FEEDBACK_MACHINE_EVIDENCE_SECTIONS,
  isFeedbackAttachmentKind,
  type FeedbackTraceBundleTranscriptMetadataKey,
  AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT,
  AGENT_API_MESSAGE_SEARCH_MAX_LIMIT,
  RAFT_CLIENT_CAPABILITIES_HEADER,
  type ServerRole,
} from "@botiverse/raft-shared";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import type { Server as SocketServer } from "socket.io";
import { getFlyInstanceForMachine } from "../replicaRouter";
import { getDb } from "../db/index";
import { getAppUrl } from "../config/appUrl";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  jointChannels,
  jointChannelServers,
  messages,
  users,
} from "../db/schema";
import { and, desc, eq, gt, isNull, not, sql } from "drizzle-orm";
import { getStorage, getCdnStorage, isStorageTimeoutError } from "../services/storageService";
import { FileUploadQuotaExceededError } from "../services/fileUploadQuotaService";
import { agentFileUploadQuotaExceededResponse } from "../services/agentUploadUpgradeHint";
import { uploadAttachmentBuffers } from "../services/attachmentUploadWriterService";
import {
  attachmentTooLargeRefusal,
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
} from "./attachments";
import { applyHistoryThreadMetadata, getHistoryThreadParentMessageIds } from "./historyThreadMetadata";
import { paginateHistoryProbe } from "./historyCursor";
import { rejectUnwritableTaskConversation, resolveAgentTaskRefConversation, resolveWritableAgentTarget } from "./agentWritableTarget";
import { createScopeAttestation, ScopeAttestationOverBudgetError } from "../lib/scopeAttestation";
import { messageIdShortPrefixConditions, UUID_RE } from "../lib/messageId";
import { requireAgentScope } from "../middleware/agentScope";
import * as agentScopesService from "../services/agentScopesService";
import { addTraceEvent, errorClassOf, getCurrentTraceContext, getCurrentTraceSpan, safeAddTraceEvent, tracePhase } from "../tracing/semanticTrace";
import {
  createAvatarUpload,
  PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
  runSingleAvatarUpload,
  storeAgentAvatar,
  storeServerAvatar,
} from "../services/avatarService";
import { handleAgentKnowledgeGet, handleAgentKnowledgeSearch } from "./agentKnowledge";
import { AttachmentLinkError } from "../services/attachmentLinkingService";
import { renderAgentFacingContents } from "../services/agentFacingContent";
import { partitionDeliverableSystemAppEventMessages } from "../services/systemAppDeliveryGuards";
import { getActorServerRoleInServer, getAgentServerRolesInServer } from "../lib/actorPermissions";
import { bindRequestAbortSignal } from "./requestAbortSignal";
import { broadcastAgentUpdated } from "./agentUpdatedBroadcast";
import { createChannelForAgent } from "./agentChannelCreate";
import { addChannelMemberForAgent, lastMemberRefusal, removeChannelMemberForAgent, removeUnlessLastMember } from "./agentChannelMembers";
import { updateChannelForAgent } from "./agentChannelUpdate";
import { respondToDmTargetResolutionError, sendJsonServerError, transientSendConflictBody } from "./errorResponse";
import { transientTransactionSqlState } from "../db/transientTransactionRetry";
import { agentServerProfileAudit, assertAgentCanManageServerProfile, updateServerProfileForAgent } from "./agentServerManage";
import { agentProfileWriteRefusal, ASSISTANT_PROFILE_FIXED_CODE, ASSISTANT_PROFILE_FIXED_ERROR } from "../services/assistantService";
import { parseOffsetQueryParam } from "../lib/offsetQueryParam";
import { resolveAgentLoginClient } from "../services/oauthClientKeys";
import { refuse } from "../lib/refusal";
import { getHostedRuntimeSummary } from "../services/agentRuntimeProvisionService";
import {
  AGENT_CHANNEL_NOT_FOUND_REFUSAL,
  agentProfileFenceRefusal,
  APP_BOT_AVATAR_MANAGED_REFUSAL,
  AGENT_GONE_REFUSAL,
  AVATAR_TOO_LARGE_REFUSAL,
  SERVER_GONE_FOR_AVATAR_REFUSAL,
  AGENT_SERVER_GONE_REFUSAL,
  agentLoginScopeRefusal,
  APP_CARD_MODE_INVALID_REFUSAL,
  APP_CARD_TARGET_REQUIRED_REFUSAL,
  APP_NAME_REQUIRED_REFUSAL,
  APP_RETURN_URL_REQUIRED_REFUSAL,
  APP_UPDATE_CARD_DISABLED_REFUSAL,
  installationSuspendedRefusal,
  targetNotFoundRefusal,
  ALL_CHANNEL_MEMBERSHIP_FIXED_REFUSAL,
  CHANNEL_ARCHIVED_REFUSAL,
  CHANNEL_TYPE_NOT_LEAVABLE_REFUSAL,
  DM_NOT_JOINABLE_REFUSAL,
  EMOJI_INVALID_REFUSAL,
  HISTORY_NOT_ACCESSIBLE_REFUSAL,
  HISTORY_TARGET_REQUIRED_REFUSAL,
  JOIN_CHANNEL_ARCHIVED_REFUSAL,
  JOINT_CHANNEL_ADD_ONLY_REFUSAL,
  JOINT_TASK_READ_ONLY_REFUSAL,
  LEAVE_CHANNEL_ARCHIVED_REFUSAL,
  NOT_A_THREAD_REFUSAL,
  PRIVATE_CHANNEL_INVITE_ONLY_REFUSAL,
  REACTION_CHANNEL_ARCHIVED_REFUSAL,
  REACTION_CHANNEL_READ_ONLY_REFUSAL,
  REACTION_MEMBERSHIP_REQUIRED_REFUSAL,
  REMINDER_CHANNEL_INVALID_REFUSAL,
  REMINDER_CHANNEL_NOT_FOUND_REFUSAL,
  REMINDER_FIRED_NOT_UPDATABLE_REFUSAL,
  REMINDER_MAX_TITLE_LEN,
  REMINDER_MESSAGE_REQUIRED_REFUSAL,
  REMINDER_NOT_FOUND_REFUSAL,
  REMINDER_REPEAT_INVALID_REFUSAL,
  REMINDER_SCHEDULE_REQUIRED_REFUSAL,
  REMINDER_STATE_CONFLICT_REFUSAL,
  REMINDER_STATUS_FILTER_INVALID_REFUSAL,
  REMINDER_TIMEZONE_INVALID_REFUSAL,
  REMINDER_TIMEZONE_REQUIRED_REFUSAL,
  REMINDER_TITLE_REQUIRED_REFUSAL,
  REMINDER_TITLE_TOO_LONG_REFUSAL,
  REMINDER_UPDATE_INVALID_REFUSAL,
  reminderNotCancelableRefusal,
  reminderNotSnoozableRefusal,
  reminderNotUpdatableRefusal,
  reminderRepeatUnparsedRefusal,
  reminderScheduleInvalidRefusal,
  reminderTimezoneUnknownRefusal,
  SERVER_ROLE_CANNOT_JOIN_REFUSAL,
  SYSTEM_MESSAGE_NOT_REACTABLE_REFUSAL,
  TASK_CHANNEL_NOT_FOUND_REFUSAL,
  TASK_CLAIM_IN_THREAD_REFUSAL,
  TASK_CREATE_IN_THREAD_REFUSAL,
  TASK_MEMBERSHIP_REQUIRED_REFUSAL,
  taskNotFoundRefusal,
  taskStatusRefusal,
  taskUnclaimRefusal,
  THREAD_NOT_FOUND_REFUSAL,
  THREAD_NOT_JOINABLE_REFUSAL,
  TOO_MANY_TASKS_REFUSAL,
  agentProfileUpdateFields,
  AVATAR_BAD_FORMAT_REFUSAL,
  AVATAR_FILE_REQUIRED_REFUSAL,
  unwritableTargetRefusal,
  UPLOAD_CHANNEL_REQUIRED_REFUSAL,
  UPLOAD_FILE_EMPTY_REFUSAL,
  UPLOAD_FILE_REQUIRED_REFUSAL,
  UPLOAD_MEMBERSHIP_REQUIRED_REFUSAL,
  ACTION_TYPE_NOT_PREPARABLE_REFUSAL,
  agentLoginNotFoundRefusal,
  appRegistrationScopeRefusal,
  MACHINE_AUTH_REQUIRED_REFUSAL,
  MACHINE_NOT_FOUND_REFUSAL,
  MACHINE_SERVER_GONE_REFUSAL,
  MESSAGE_NOT_FOUND_REFUSAL,
  messageResolveRefusal,
  serviceMessageRefusal,
  TARGET_REQUIRED_REFUSAL,
} from "./agentRouteRefusals";

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
      // The reminder itself was canceled: its Computer drops the un-acked items it holds of it.
      await orchestrator.pushReminderCancel(row.ownerAgentId, row.id, row.version, { canceled: true });
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
  // Access, then the plan's history window (services/messageResourceAccess.ts).
  const access = await resolveMessageResourceAccess({ messageId, serverId, actor: { type: "agent", id: agentId } });
  if (access.kind === "no_access") {
    res.status(access.status).json({ error: access.error });
    return null;
  }
  if (access.kind === "history_limited") {
    refuse(res, 404, agentHistoryLimitedRefusal(access.historyWindow));
    return null;
  }
  return access.message;
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

async function buildServerInfoAgentSummary(
  serverId: string,
  a: Awaited<ReturnType<typeof agentService.listAgents>>[number],
  agentOrchestrator?: AgentOrchestrator,
) {
  const visibleActivity = agentOrchestrator
    ? await agentOrchestrator.getActivity(a.id, { parent: getCurrentTraceContext() })
    : null;
  const resolvedRole = await getActorServerRoleInServer(serverId, "agent", a.id);
  return toServerInfoAgentSummary(a, visibleActivity, resolvedRole);
}

function toServerInfoAgentSummary(
  a: Awaited<ReturnType<typeof agentService.listAgents>>[number],
  visibleActivity: { activity: string | null; activityDetail: string; activityDetailKind?: string } | null,
  resolvedRole: ServerRole | null,
) {
  return {
    name: a.name,
    description: a.description,
    status: a.status,
    activity: visibleActivity?.activity ?? null,
    // #wg-rbac:#57: another agent reads an error activity as a member does.
    activityDetail: visibleActivity
      ? projectRuntimeErrorActivityDetail({ activity: visibleActivity.activity, detailKind: visibleActivity.activityDetailKind ?? null, detail: visibleActivity.activityDetail, lastRuntimeError: a.lastRuntimeError ?? null }, "member").detail
      : "",
    role: resolvedRole === "guest" ? null : resolvedRole,
  };
}

export async function buildServerInfoAgentSummaries(
  serverId: string,
  agentOrchestrator?: AgentOrchestrator,
) {
  const allAgentsList = await agentService.listAgents(serverId, false, { memberListsOnly: true });
  // Every agent's activity and role as two batches, not two reads per agent
  // under Promise.all (one connection each on a server with hundreds).
  const [activities, roles] = await Promise.all([
    agentOrchestrator ? agentOrchestrator.getActivities(allAgentsList, { parent: getCurrentTraceContext() }) : null,
    getAgentServerRolesInServer(serverId, allAgentsList.map((a) => a.id)),
  ]);
  return allAgentsList.map((a, index) => toServerInfoAgentSummary(a, activities?.[index] ?? null, roles.get(a.id) ?? null));
}

/**
 * The first `serverInfo` agents entry with exactly this name and that agent's
 * id, or null; only that agent's activity is read.
 */
export async function findServerInfoAgentSummaryByName(
  serverId: string,
  name: string,
  agentOrchestrator?: AgentOrchestrator,
) {
  const agent = (await agentService.listAgents(serverId, false, { memberListsOnly: true })).find((candidate) => candidate.name === name);
  return agent ? { id: agent.id, summary: await buildServerInfoAgentSummary(serverId, agent, agentOrchestrator) } : null;
}

/** Server members the requesting agent's directory shows, in `serverInfo` order. */
async function listServerInfoVisibleHumans(serverId: string, agentId: string) {
  const members = await serverService.getServerMembers(serverId, null);
  return filterAgentVisibleHumansForHiddenDirectory(serverId, agentId, members);
}

function toServerInfoHumanSummary(member: Awaited<ReturnType<typeof listServerInfoVisibleHumans>>[number]) {
  return {
    name: member.name,
    description: member.description,
    role: member.role,
  };
}

/** The `serverInfo` humans entries: server members the requesting agent's directory shows. */
export async function buildServerInfoHumanSummaries(serverId: string, agentId: string) {
  return (await listServerInfoVisibleHumans(serverId, agentId)).map(toServerInfoHumanSummary);
}

/** The first `serverInfo` humans entry with exactly this name and that user's id, or null. */
export async function findServerInfoHumanSummaryByName(serverId: string, agentId: string, name: string) {
  const member = (await listServerInfoVisibleHumans(serverId, agentId)).find((candidate) => candidate.name === name);
  return member ? { id: member.userId, summary: toServerInfoHumanSummary(member) } : null;
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
  const [message] = await withAgentSourceTasks(await withProjectedTaskFacts([resolvedMessage]), undefined, serverId);
  const external = message.senderType === "external_projection";
  const sender = message.messageType === "system"
    ? { name: "system", description: null }
    : message.senderType === "user"
      ? await getDb().select({ name: users.name, description: users.description }).from(users).where(eq(users.id, message.senderId)).then((rows) => rows[0] ?? null)
      : message.senderType === "external_projection"
        ? { name: message.externalAuthor?.displayName ?? "External user", description: null }
        : await agentService.getAgent(message.senderId);
  let parentChannel: Awaited<ReturnType<typeof channelService.getChannel>> | null = null;
  let threadParentMessageId: string | null = null;
  // Task v2: a message in a task's own conversation is addressed by the task
  // ref (`#parent:#7`): a thread under the task's channel plus its number.
  const taskConversationNumber = await messageService.taskConversationNumberForChannel(channel);
  if (channel.type === "task" && channel.parentChannelId) {
    parentChannel = await channelService.getChannel(channel.parentChannelId);
  }
  if (channel.type === "thread") {
    // resolveThreadParent also covers a joint thread's local projection, whose
    // parent is this server's joint channel face and whose reply target is
    // the canonical parent message (what `#channel:<id>` resolves).
    const threadParent = await channelService.resolveThreadParent(channel);
    if (threadParent) {
      threadParentMessageId = threadParent.parentMessageId;
      parentChannel = await channelService.getChannel(threadParent.parentChannelId);
    }
  }
  const channelName = channel.type === "dm"
    ? await channelService.resolveAgentFacingDmPeerFace(serverId, requestingAgentId, channel.id)
    : channel.name;
  const parentChannelName = parentChannel?.type === "dm"
    ? await channelService.resolveAgentFacingDmPeerFace(serverId, requestingAgentId, parentChannel.id)
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
    channel_type: channel.type === "thread" || taskConversationNumber
      ? "thread"
      : channel.type === "dm"
        ? "dm"
        : channel.type === "private"
          ? "private"
          : "channel",
    channel_name: taskConversationNumber
      ? formatAgentTaskRefTail(taskConversationNumber)
      : channel.type === "thread" && threadParentMessageId
        ? threadParentMessageId.slice(0, 8)
        : channelName,
    parent_channel_type: parentChannel
      ? parentChannel.type === "dm" ? "dm" : parentChannel.type === "private" ? "private" : "channel"
      : null,
    parent_channel_name: parentChannelName,
    ...(taskConversationNumber && { task_conversation_number: taskConversationNumber }),
    timestamp: message.createdAt.toISOString(),
    sender_type: message.messageType === "system" ? "system" : toAgentFacingActorType(message.senderType),
    sender_name: sender?.name ?? "unknown",
    sender_description: sender?.description ?? null,
    sender_timezone: external ? null : message.senderTimezone ?? null,
    // RFC 077: resolve reads "sent by an assistant for its owner" like every other read.
    ...(await messageService.agentDelegatedByField(message as { delegatedByAgentId?: string | null })),
    // RFC 082: a card message reads `card=r<revision>` in the header; its content is the fallback.
    ...agentMessageCardField(external ? null : "actionMetadata" in message ? message.actionMetadata : null),
    ...messageService.toAgentVisibleExternalMessage(message),
    ...(external && {
      mentioned: messageService.isSlackBridgedExternalMessage(message)
        && messageService.isAgentPersonallyMentioned(message.mentions, requestingAgentId),
    }),
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
    // External rows carry no task authority keys at all (not even null): the
    // Agent API envelope contract rejects their presence on external_message.
    ...(!external && {
      task_status: message.taskStatus,
      task_number: message.taskNumber,
      task_assignee_type: message.taskAssigneeType ? toAgentFacingActorType(message.taskAssigneeType) : null,
      task_assignee_id: message.taskAssigneeId,
      task_assignee_name: taskAssigneeName,
    }),
    // Task v2: every task hanging under this chat message (flag-on servers).
    ...(!external && message.source_tasks && { source_tasks: message.source_tasks }),
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
      viewerServerId: serverId,
      includeSenderTimezone: true,
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
    viewerServerId: serverId,
    includeSenderTimezone: true,
  });
  if (!viewerScopedMessage) return null;
  return buildAgentResolvedMessagePayload(viewerScopedMessage, storageChannel, serverId, requestingAgentId);
}

async function serializeOAuthClientForAgent(
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
    ...await oauthService.projectOfficialAppDiscoveryForAgent(client),
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
    // refusal-ok: `issues` names the field that is wrong, the only detail behind this generic sentence; the envelope has `details` only for listed codes
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
      gravatarHash: DEPRECATED_GRAVATAR_HASH,
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

/**
 * A human's profile as an agent reads it. Agents never get a human's email:
 * the member read below has no requester, so getServerMembers already masks
 * it, and the view pins `email: null` so a change to that masking cannot leak
 * it here. The profile card renders a null email as absent.
 */
async function buildHumanProfileView(
  serverId: string,
  userId: string,
  selfAgentId: string,
): Promise<HumanProfileView | null> {
  const members = await serverService.getServerMembers(serverId, null);
  const member = members.find((candidate) => candidate.userId === userId);
  if (!member) return null;
  // Read by an agent, which is never the owner: another person's assistant
  // is left out; the assistant reading its own owner's profile finds itself.
  const createdAgents = await agentService.listCreatedAgents(serverId, "user", userId, { agentId: selfAgentId });

  return {
    kind: "human",
    id: member.userId,
    isSelf: false,
    name: member.name,
    displayName: member.displayName,
    description: member.description,
    avatarUrl: member.avatarUrl,
    email: null,
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
  const createdAgents = await agentService.listCreatedAgents(agent.serverId, "agent", agent.id, { agentId: selfAgentId });
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
    // #wg-rbac:#57: an agent reads its own error scrubbed; another agent reads it as a member does.
    lastRuntimeError: projectRuntimeErrorState(agent.lastRuntimeError, agent.id === selfAgentId ? "manager" : "member"),
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

  // A human the agent's hidden human directory does not show resolves like a
  // handle nobody has (findAgentVisibleServerHuman), so neither the profile nor
  // the ambiguous/not-found answers confirm a hidden person.
  const [human, targetAgentId] = await Promise.all([
    serverService.findAgentVisibleServerHuman(serverId, selfAgentId, { name: targetHandle }),
    channelService.resolveAgentByName(serverId, targetHandle, { agentId: selfAgentId }),
  ]);
  const humanId = human?.userId ?? null;

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
    const profile = await buildHumanProfileView(serverId, humanId, selfAgentId);
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
  // Every daemon-supplied string that is signed is bounded to what the worker
  // accepts, so the server never mints a claim the worker would refuse.
  const bundleContentType = readOptionalBoundedAttestationString(metadata.bundleContentType, "metadata.bundleContentType", 128)
    ?? "application/x-ndjson";
  const bundleContentEncoding = readOptionalBoundedAttestationString(metadata.bundleContentEncoding, "metadata.bundleContentEncoding", 64)
    ?? "gzip";
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
  // Both ids become object-store path segments on the worker, so only a
  // canonical UUID is ever signed.
  const feedbackReportId = readOptionalAttestationUuid(metadata.feedbackReportId, "metadata.feedbackReportId");
  if (feedbackReportId) result.feedbackReportId = feedbackReportId;
  const agentId = readOptionalAttestationUuid(metadata.agentId, "metadata.agentId");
  if (agentId) result.agentId = agentId;
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
  const transcriptHandlers = {
    feedbackReportTimeSource(value: unknown): void {
      if (value === "web_report_bundle" || value === "server_request_received") {
        result.feedbackReportTimeSource = value;
      }
    },
    feedbackTranscriptFirstEventAt(): void {
      if (feedbackTranscriptFirstEventAt) result.feedbackTranscriptFirstEventAt = feedbackTranscriptFirstEventAt;
    },
    feedbackTranscriptLastEventAt(): void {
      if (feedbackTranscriptLastEventAt) result.feedbackTranscriptLastEventAt = feedbackTranscriptLastEventAt;
    },
    feedbackTranscriptTruncated(value: unknown): void {
      if (value === "true" || value === "false") {
        result.feedbackTranscriptTruncated = value;
      }
    },
    feedbackTranscriptTruncationDirection(value: unknown): void {
      if (value === "head" || value === "tail" || value === "window") {
        result.feedbackTranscriptTruncationDirection = value;
      }
    },
    feedbackTranscriptWindowCoverage(value: unknown): void {
      if (
        value === "covered"
        || value === "outside_report_window"
        || value === "timestamps_unavailable"
        || value === "report_time_invalid"
      ) {
        result.feedbackTranscriptWindowCoverage = value;
      }
    },
  } satisfies Record<FeedbackTraceBundleTranscriptMetadataKey, (value: unknown) => void>;
  for (const key of Object.keys(FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_METADATA_KEYS) as FeedbackTraceBundleTranscriptMetadataKey[]) {
    transcriptHandlers[key](metadata[key]);
  }
  // task #1228 ①: what the transcript bytes are (closed enum; there is no
  // "placeholder" value because placeholders are never uploaded), the two
  // byte counts, and the request id that links the transcript to its
  // transcript_outcome. Malformed values are dropped, never coerced.
  const resultHandlers = {
    feedbackTranscriptContent(value: unknown): void {
      if (isFeedbackTranscriptUploadableContentKind(value)) result.feedbackTranscriptContent = value;
    },
    feedbackTranscriptSourceBytes(value: unknown): void {
      const n = readFeedbackTranscriptByteCount(value);
      if (n !== null) result.feedbackTranscriptSourceBytes = n;
    },
    feedbackTranscriptBytes(value: unknown): void {
      const n = readFeedbackTranscriptByteCount(value);
      if (n !== null) result.feedbackTranscriptBytes = n;
    },
    feedbackTranscriptRequestId(value: unknown): void {
      const id = readFeedbackTranscriptRequestId(value);
      if (id) result.feedbackTranscriptRequestId = id;
    },
  } satisfies Record<FeedbackTraceBundleTranscriptResultMetadataKey, (value: unknown) => void>;
  for (const key of Object.keys(FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_RESULT_METADATA_KEYS) as FeedbackTraceBundleTranscriptResultMetadataKey[]) {
    resultHandlers[key](metadata[key]);
  }
  if (
    typeof metadata.feedbackTranscriptWindowToleranceMs === "number"
    && Number.isSafeInteger(metadata.feedbackTranscriptWindowToleranceMs)
    && metadata.feedbackTranscriptWindowToleranceMs >= 0
    && metadata.feedbackTranscriptWindowToleranceMs <= 60 * 60 * 1000
  ) {
    result.feedbackTranscriptWindowToleranceMs = metadata.feedbackTranscriptWindowToleranceMs;
  }
  // Feedback diagnostics (tier-1 observed-failure summary, task #279 trace
  // tail + machine state) are NEVER signed. They travel as their own
  // machine_evidence object; anything optional in this token competes with
  // the transcript for the worker's SCOPE_ATTESTATION_MAX_CHARS budget, and a
  // busy trace window used to make the TRANSCRIPT fail. Daemons <= a8039c677
  // still send them here: strip, warn, and record it. Nothing is lost — the
  // worker never read these claims.
  const unsignedDiagnostics = FEEDBACK_MACHINE_EVIDENCE_SECTIONS.filter((key) => metadata[key] !== undefined).sort();
  if (unsignedDiagnostics.length > 0) {
    console.warn(
      `[trace-bundle] stripping unsigned feedback diagnostics from machine ${ctx.machineId}: ${unsignedDiagnostics.join(",")} (older daemon; diagnostics now travel as machine_evidence)`,
    );
    safeAddTraceEvent("machine.trace_bundle.evidence_unsigned", () => ({
      event_kind: "legacy_diagnostics_stripped",
      outcome: "dropped",
      reason: "diagnostics_not_signed",
      machine_id: ctx.machineId,
      fields: unsignedDiagnostics.join(","),
    }));
  }
  // Tier 2 (task #272): the machine log tail is a distinct attachment KIND on
  // the same bundle path. The kind is a closed enum so a reader can tell a
  // transcript from a log tail without sniffing content; the tail's counters
  // are bounded and dropped-with-warn when malformed rather than failing the
  // upload.
  if (metadata.feedbackAttachmentKind !== undefined) {
    if (isFeedbackAttachmentKind(metadata.feedbackAttachmentKind)) {
      result.feedbackAttachmentKind = metadata.feedbackAttachmentKind;
    } else {
      console.warn(`[trace-bundle] dropping unknown feedbackAttachmentKind from machine ${ctx.machineId}`);
    }
  }
  // machine_evidence: one gzipped JSON object, bound to a report and an agent,
  // filed outside trace-bundles/ so nothing that scans trace bundles reads it
  // as traces. Its content type, encoding, key and size bound are the
  // server's, not the daemon's. The agent binding to THIS machine is checked
  // in the route (it needs the database).
  if (result.feedbackAttachmentKind === "machine_evidence") {
    if (!result.feedbackReportId) throw new Error("metadata.feedbackReportId is required for machine_evidence");
    if (!result.agentId) throw new Error("metadata.agentId is required for machine_evidence");
    if (bundleSizeBytes > FEEDBACK_MACHINE_EVIDENCE_MAX_UPLOAD_BYTES) {
      throw new Error("metadata.bundleSizeBytes exceeds the machine_evidence limit");
    }
    result.objectKey = `feedback-machine-evidence/${ctx.serverId}/${ctx.machineId}/${uploadId}.json.gz`;
    result.maxBytes = FEEDBACK_MACHINE_EVIDENCE_MAX_UPLOAD_BYTES;
    result.bundleContentType = "application/json";
    result.bundleContentEncoding = "gzip";
  }
  // transcript_outcome (task #1228 ①): one small gzipped JSON object bound to
  // a report, an agent and a request; filed outside trace-bundles/ (readers
  // that accept only trace-bundles/<serverId>/ keys skip it). It carries no
  // transcript label. The agent binding to THIS machine is checked in the route.
  if (result.feedbackAttachmentKind === "transcript_outcome") {
    if (!result.feedbackReportId) throw new Error("metadata.feedbackReportId is required for transcript_outcome");
    if (!result.agentId) throw new Error("metadata.agentId is required for transcript_outcome");
    if (!result.feedbackTranscriptRequestId) throw new Error("metadata.feedbackTranscriptRequestId is required for transcript_outcome");
    if (bundleSizeBytes > FEEDBACK_TRANSCRIPT_OUTCOME_MAX_UPLOAD_BYTES) {
      throw new Error("metadata.bundleSizeBytes exceeds the transcript_outcome limit");
    }
    for (const key of ["feedbackTranscriptContent", "feedbackTranscriptSourceBytes", "feedbackTranscriptBytes"] as const) delete result[key];
    result.objectKey = `feedback-transcript-outcomes/${ctx.serverId}/${ctx.machineId}/${uploadId}.json.gz`;
    result.maxBytes = FEEDBACK_TRANSCRIPT_OUTCOME_MAX_UPLOAD_BYTES;
    result.bundleContentType = "application/json";
    result.bundleContentEncoding = "gzip";
  }
  // agent_event_tail (task #1230): one bounded gzipped JSON object bound to a
  // report, an agent and a request; filed outside trace-bundles/ and never
  // ingested as traces. Only bounded ids are signed (the events, counts and
  // scan facts travel in the PUT body only). The agent binding to THIS machine
  // is checked in the route.
  if (result.feedbackAttachmentKind === "agent_event_tail") {
    if (!result.feedbackReportId) throw new Error("metadata.feedbackReportId is required for agent_event_tail");
    if (!result.agentId) throw new Error("metadata.agentId is required for agent_event_tail");
    if (!result.feedbackTranscriptRequestId) throw new Error("metadata.feedbackTranscriptRequestId is required for agent_event_tail");
    if (bundleSizeBytes > FEEDBACK_AGENT_EVENT_TAIL_MAX_UPLOAD_BYTES) {
      throw new Error("metadata.bundleSizeBytes exceeds the agent_event_tail limit");
    }
    for (const key of ["feedbackTranscriptContent", "feedbackTranscriptSourceBytes", "feedbackTranscriptBytes"] as const) delete result[key];
    result.objectKey = `${FEEDBACK_AGENT_EVENT_TAIL_OBJECT_KEY_PREFIX}${ctx.serverId}/${ctx.machineId}/${uploadId}.json.gz`;
    result.maxBytes = FEEDBACK_AGENT_EVENT_TAIL_MAX_UPLOAD_BYTES;
    result.bundleContentType = "application/json";
    result.bundleContentEncoding = "gzip";
  }
  if (result.feedbackAttachmentKind === "machine_log_tail") {
    for (const key of [
      "feedbackMachineLogTailLineCount",
      "feedbackMachineLogTailSourceLineCount",
      "feedbackMachineLogTailLinesOutsideWindow",
      "feedbackMachineLogTailUndatedLines",
    ] as const) {
      const value = metadata[key];
      if (value === undefined) continue;
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000) {
        result[key] = value;
      } else {
        console.warn(`[trace-bundle] dropping malformed ${key} from machine ${ctx.machineId}`);
      }
    }
    for (const key of ["feedbackMachineLogTailTruncated", "feedbackMachineLogTailIncludesOtherAgents"] as const) {
      const value = metadata[key];
      if (value === undefined) continue;
      if (value === "true" || value === "false") {
        result[key] = value;
      } else {
        console.warn(`[trace-bundle] dropping malformed ${key} from machine ${ctx.machineId}`);
      }
    }
  }
  return result;
}

function readOptionalBoundedAttestationString(value: unknown, name: string, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.length > maxLength) throw new Error(`${name} is too long`);
  return value;
}

function readOptionalAttestationUuid(value: unknown, name: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

async function isAgentBoundToMachine(agentId: string, ctx: { serverId: string; machineId: string }): Promise<boolean> {
  if (!UUID_RE.test(agentId)) return false;
  const [row] = await getDb()
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.id, agentId),
      eq(agents.serverId, ctx.serverId),
      eq(agents.machineId, ctx.machineId),
      isNull(agents.deletedAt),
    ))
    .limit(1);
  return !!row;
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
      refuse(res, 401, MACHINE_AUTH_REQUIRED_REFUSAL);
      return;
    }

    const machine = await machineService.getMachine(machineId);
    if (!machine || machine.serverId !== serverId) {
      refuse(res, 404, MACHINE_NOT_FOUND_REFUSAL);
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const readModel = await buildMachineReadModel(machine, agentOrchestrator);
    const server = await serverService.getServer(serverId);
    res.json({
      ...readModel,
      workspaceId: serverId,
      workspaceName: server?.name ?? null,
      serverSlug: server?.slug ?? null,
      // Retired with the standalone daemon release; kept for older daemons.
      latestDaemonVersion: null,
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
      refuse(res, 401, MACHINE_AUTH_REQUIRED_REFUSAL);
      return;
    }

    const machine = await machineService.getMachine(machineId);
    if (!machine || machine.serverId !== serverId) {
      refuse(res, 404, MACHINE_NOT_FOUND_REFUSAL);
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const agents = await agentService.getAgentsForMachine(machineId);
    const serverAgents = agents.filter((agent) => agent.serverId === serverId);
    const activities = await agentOrchestrator.getActivities(serverAgents, { parent: getCurrentTraceContext() });
    const enriched = serverAgents.map((agent, index) => {
      const { activity, activityDetail } = activities[index]!;
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
    });

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
    sendJsonServerError(req, res, {
      error: "Failed to list agent integrations",
      logPrefix: "List agent integrations error:",
      err,
    });
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
      refuse(res, 404, AGENT_SERVER_GONE_REFUSAL);
      return;
    }

    const clients = await oauthService.listAgentAvailableOAuthClients(result.agent.serverId);
    const resolved = await resolveAgentLoginClient(clients, req.body?.service);
    if (!resolved.ok) {
      if (resolved.status !== 404) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }

      // Installed here but suspended: refuse rather than offer an install.
      const suspended = await resolveAgentLoginClient(
        await oauthService.listSuspendedThirdPartyOAuthClients(result.agent.serverId),
        req.body?.service,
      );
      if (suspended.ok) {
        refuse(res, 403, installationSuspendedRefusal(suspended.client.clientId));
        return;
      }

      const publicClients = await oauthService.listPublicMarketplaceOAuthClients();
      const marketplaceResolved = await resolveAgentLoginClient(publicClients, req.body?.service);
      if (!marketplaceResolved.ok) {
        res.status(marketplaceResolved.status).json({ error: marketplaceResolved.error });
        return;
      }

      const scopes = normalizeAgentLoginScopes(req.body?.scopes, marketplaceResolved.client);
      const marketplaceUrl = `${getAppUrl()}/s/${encodeURIComponent(server.slug)}/settings/applications?marketplace_app=${encodeURIComponent(marketplaceResolved.client.id)}`;
      const response: {
        status: "install_required";
        agentHandoffProtocol: "legacy" | "v1";
        nextAction: "install_from_marketplace";
        service: Awaited<ReturnType<typeof serializeOAuthClientForAgent>>;
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
        agentHandoffProtocol: marketplaceResolved.client.agentHandoffProtocol,
        nextAction: "install_from_marketplace",
        service: await serializeOAuthClientForAgent(marketplaceResolved.client),
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
          refuse(res, 404, targetNotFoundRefusal(target));
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
      initiatedByAgent: true,
    });

    if (requested.grantStatus === "pending") {
      const response: {
        status: "approval_required";
        agentHandoffProtocol: "legacy" | "v1";
        service: Awaited<ReturnType<typeof serializeOAuthClientForAgent>>;
        scopes: string[];
        requestId: string;
        approval: {
          requestId: string;
          target: string | null;
          actionCardMessageId: string | null;
        };
      } = {
        status: "approval_required",
        agentHandoffProtocol: resolved.client.agentHandoffProtocol,
        service: await serializeOAuthClientForAgent(resolved.client),
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
          refuse(res, 404, targetNotFoundRefusal(target));
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
      agentHandoffProtocol: resolved.client.agentHandoffProtocol,
      service: await serializeOAuthClientForAgent(resolved.client),
      scopes: requested.request.scopes ?? [],
      requestId: requested.request.id,
    });
  } catch (err: any) {
    if (err instanceof oauthService.OAuthInstallationSuspendedError) {
      refuse(res, 403, installationSuspendedRefusal(null));
      return;
    }
    const message = err?.message || "Failed to provision agent login";
    const scopeRefusal = agentLoginScopeRefusal(message);
    if (scopeRefusal) {
      refuse(res, 400, scopeRefusal);
      return;
    }
    if (message.includes("not found")) {
      refuse(res, 404, agentLoginNotFoundRefusal(message));
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to provision agent login",
      logPrefix: "Agent integration login error:",
      err,
    });
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
      refuse(res, 400, APP_CARD_TARGET_REQUIRED_REFUSAL);
      return;
    }
    const mode = optionalString(body.mode);
    if (mode === "update") {
      refuse(res, 410, APP_UPDATE_CARD_DISABLED_REFUSAL);
      return;
    }
    if (mode !== "register") {
      refuse(res, 400, APP_CARD_MODE_INVALID_REFUSAL);
      return;
    }
    const clientKey = optionalString(body.clientKey);

    const resolvedTarget = await channelService.resolveChannelByName(
      result.agent.serverId,
      result.agent.id,
      target,
    );
    if (!resolvedTarget) {
      refuse(res, 404, targetNotFoundRefusal(target));
      return;
    }

    const scopes = normalizeIntegrationAppPrepareScopes(body.scopes);
    const unsafeDemoUrlOverride = body.unsafeDemoUrlOverride === true;
    const draftHint = optionalString(body.draftHint);
    const homepageUrl = optionalString(body.homepageUrl);
    const returnUrl = optionalString(body.returnUrl);
    const agentManifestUrl = optionalString(body.agentManifestUrl);

    const name = optionalString(body.name);
    if (!name) {
      refuse(res, 400, APP_NAME_REQUIRED_REFUSAL);
      return;
    }
    if (!returnUrl) {
      refuse(res, 400, APP_RETURN_URL_REQUIRED_REFUSAL);
      return;
    }
    const action: ActionCardAction = {
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
      refuse(res, 400, appRegistrationScopeRefusal(err.message));
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to prepare integration app registration",
      logPrefix: "Prepare integration app registration error:",
      err,
    });
  }
});

// Machine-auth, pull-on-demand scope capability for daemon direct-to-worker calls.
// The server signs authorization metadata only; upload/data bytes must go to the
// requested third-party worker directly from the daemon.
internalRouter.post("/machine/scope-attestation", async (req, res) => {
  try {
    if (!req.machineId || !req.serverId) {
      refuse(res, 401, MACHINE_AUTH_REQUIRED_REFUSAL);
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
      refuse(res, 401, MACHINE_AUTH_REQUIRED_REFUSAL);
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
      refuse(res, 404, MACHINE_SERVER_GONE_REFUSAL);
      return;
    }

    const policy = DAEMON_CAPABILITY_POLICIES[scope];
    const audience = policy.audience;
    const resource = policy.deriveResource({ serverId: server.id, machineId: machine.id });
    const metadata = policy.deriveMetadata?.({ serverId: server.id, machineId: machine.id }, requestMetadata);
    // machine_evidence binds an agent; it must be an agent of THIS server
    // that runs on THIS (credential-derived) machine.
    if (
      (metadata?.feedbackAttachmentKind === "machine_evidence"
        || metadata?.feedbackAttachmentKind === "transcript_outcome"
        || metadata?.feedbackAttachmentKind === "agent_event_tail")
      && !(await isAgentBoundToMachine(String(metadata.agentId), { serverId: server.id, machineId: machine.id }))
    ) {
      addTraceEvent("response.ready", { status_code: 403, surface: "machine", scope, reason: "machine_evidence_agent_not_bound" });
      refuse(res, 403, { code: "machine_evidence_agent_not_bound", error: "That agentId isn't an agent bound to this machine, so this machine can't attest evidence for it: name an agent that runs here." });
      return;
    }

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
    if (err instanceof ScopeAttestationOverBudgetError) {
      // Never sign what the worker would refuse; required claims alone should
      // not get here (all daemon-supplied strings are bounded above).
      console.error(`[scope-attestation] refusing to sign: ${err.message}`);
      safeAddTraceEvent("scope_attestation.over_budget", () => ({
        outcome: "error",
        surface: "machine",
        attestation_chars: err.attestationChars,
        max_chars: err.maxChars,
      }));
      res.status(500).json({ error: "Scope attestation exceeds the signing budget", code: "scope_attestation_over_budget" });
      return;
    }
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
      refuse(res, 400, serviceMessageRefusal("scope_attestation_invalid", message, "This scope attestation request isn't valid: check its scope and metadata."));
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
  messageChannelId: string,
  afterSeq: number,
  limit: number,
  latestSeq: number,
  useAttentionFacts: boolean,
  options?: attestedSendService.FreshnessMessageAnchorOptions,
): Promise<unknown[]> {
  // Same as the agent API: not past the plan's history window.
  const { cutoff: createdAfter } = await getServerHistoryWindowForRead(agentServerId);
  const freshnessMessages = useAttentionFacts
    ? await attestedSendService.listRecentAgentAttentionMessagesAfterSeq(
      agentId,
      channelId,
      afterSeq,
      limit,
      { ...options, latestSeq, createdAfter },
    )
    : await attestedSendService.listRecentMessagesAfterSeq(
      messageChannelId,
      afterSeq,
      limit,
      { ...options, latestSeq, createdAfter },
    );
  const recentMessages = await messageService.listMessagesByIds(
    freshnessMessages.map((message) => message.messageId),
    {
      forwardedBundleViewerAgentId: agentId,
      viewerServerId: agentServerId,
      includeSenderTimezone: true,
    },
  );
  if (recentMessages.length === 0) return [];
  // Same as the agent API held path: label each held row with the send
  // target's agent-facing conversation identity, resolved once.
  const identity = await messageService.resolveAgentConversationIdentity(agentServerId, agentId, channelId);
  return recentMessages.map((message) => ({ ...messageWithoutAgentHiddenActionCardSpec(message), ...identity }));
}

// Agent uploads an attachment
internalRouter.post("/agent/:id/upload", requireAgentScope("attachment:upload"), (req, res, next) => {
  runSingleAttachmentUpload(req, res, next);
}, async (req, res) => {
  const agentId = req.params.id as string;
  const channelId = typeof req.body?.channelId === "string" ? req.body.channelId : undefined;
  try {
    const result = await loadOwnedMachineAgent(agentId, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;

    const file = req.file;
    if (!file) {
      refuse(res, 400, UPLOAD_FILE_REQUIRED_REFUSAL);
      return;
    }
    if (isEmptyUploadedFile(file)) {
      refuse(res, 400, UPLOAD_FILE_EMPTY_REFUSAL);
      return;
    }
    const maxBytes = await resolveRequestAttachmentFileSizeLimitBytes(req);
    if (isOversizedUploadedFile(file, maxBytes)) {
      refuse(res, 413, attachmentTooLargeRefusal(maxBytes));
      return;
    }

    if (!channelId) {
      refuse(res, 400, UPLOAD_CHANNEL_REQUIRED_REFUSAL);
      return;
    }

    const canPost = await channelService.canAgentPostToChannel(channelId, agentId);
    if (!canPost) {
      refuse(res, 403, UPLOAD_MEMBERSHIP_REQUIRED_REFUSAL);
      return;
    }

    // Archive gate: no new attachments on an archived channel.
    if (await channelService.isChannelArchived(channelId)) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }
    const billingReadOnly = await getChannelBillingReadOnly(channelId, agent.serverId);
    if (billingReadOnly) {
      refuse(res, 403, channelBillingReadOnlyRefusal(billingReadOnly));
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
      res.status(err.status).json(await agentFileUploadQuotaExceededResponse(
        { serverId: req.serverId!, agentId, channelId, capabilities: req.header(RAFT_CLIENT_CAPABILITIES_HEADER) },
        err,
      ));
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
      refuse(res, 400, TARGET_REQUIRED_REFUSAL);
      return;
    }

    const result = await loadOwnedMachineAgent(agentId, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;

    const resolved = await resolveWritableAgentTarget(agent.serverId, agentId, target);
    if (resolved === "forbidden" || resolved === "peer-not-found" || resolved === "self-dm") {
      const { status, refusal } = unwritableTargetRefusal(resolved, target);
      refuse(res, status, refusal);
      return;
    }
    if (rejectUnwritableTaskConversation(resolved, res)) return;
    if (!resolved) {
      const { status, refusal } = unwritableTargetRefusal(null, target);
      refuse(res, status, refusal);
      return;
    }

    res.json({ channelId: resolved.channelId });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to resolve channel",
      logPrefix: "Resolve channel error:",
      err,
    });
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
      refuse(res, 400, {
        code: "send_continue_unsupported",
        error: "Continuing a draft is no longer supported: send the message normally to update the draft, or send the saved draft as it is.",
        suggestedNextAction: "Run the normal message send to update the draft, or add --send-draft to send the current saved draft (--continue is no longer supported).",
      });
      return;
    }
    if (!content) {
      addTraceEvent("agent_send.request.rejected", { reason: "missing_content" });
      refuse(res, 400, { code: "content_required", error: "Content is required: a message needs the text to post." });
      return;
    }
    if (isContinueAnyway && !isSendDraft) {
      addTraceEvent("agent_send.request.rejected", { reason: "send_draft_anyway_without_send_draft" });
      refuse(res, 400, {
        code: "send_draft_required",
        error: "Sending anyway applies only to sending a saved draft: send the saved draft with it, or leave it out.",
        suggestedNextAction: "Use --anyway only together with --send-draft.",
      });
      return;
    }

    // Unified target param (new) or legacy channel/dm_to (backward compat)
    const effectiveTarget = target || channel || (dm_to ? `dm:@${dm_to.replace(/^@/, "")}` : null);
    const targetKind = classifyAgentSendTarget(effectiveTarget);
    if (!effectiveTarget) {
      addTraceEvent("agent_send.request.rejected", { reason: "missing_target" });
      refuse(res, 400, TARGET_REQUIRED_REFUSAL);
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
      refuse(res, 403, { code: "send_freshness_disabled", error: "Send freshness is not enabled for this agent: send without asking for it." });
      return;
    }

    const resolved = await tracePhase(
      () => resolveWritableAgentTarget(agent.serverId, agentId, effectiveTarget, { io: req.app.get("io") as SocketServer | undefined }),
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
    if (resolved === "forbidden" || resolved === "peer-not-found" || resolved === "self-dm") {
      const { status, refusal } = unwritableTargetRefusal(resolved, effectiveTarget);
      refuse(res, status, refusal);
      return;
    }
    if (rejectUnwritableTaskConversation(resolved, res)) return;
    if (!resolved) {
      const { status, refusal } = unwritableTargetRefusal(null, effectiveTarget);
      refuse(res, status, refusal);
      return;
    }
    const billingReadOnly = await getChannelBillingReadOnly(resolved.channelId, agent.serverId);
    if (billingReadOnly) {
      refuse(res, 403, channelBillingReadOnlyRefusal(billingReadOnly));
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
        // Joint thread projection: messages live on the canonical thread (see
        // evaluateAgentFreshness in internalAgentApi.ts); mentions stay local.
        const messageChannelId = resolved.type === "thread"
          ? await channelService.getMessageStorageChannelIdWithExecutor(getDb(), resolved.channelId)
          : resolved.channelId;
        // As in the agent API: messages behind the plan's history window are
        // never unseen, so counts and anchors read only what is after it.
        const { cutoff: createdAfter } = await getServerHistoryWindowForRead(agent.serverId);
        const hasClientSeenBoundary = typeof seenUpToSeq === "number" && Number.isFinite(seenUpToSeq);
        const clientSeenUpToSeq = hasClientSeenBoundary
          ? Math.max(0, Math.floor(seenUpToSeq))
          : 0;
        // As in evaluateAgentFreshness: the anchor is searched only after the
        // model-seen boundary; nothing after it leaves the boundary as latest.
        const attentionAnchor = useAttentionFacts
          ? await attestedSendService.getLatestAgentAttentionAnchor(agentId, resolved.channelId, {
            excludeSender: selfSender,
            createdAfter,
            ...(hasClientSeenBoundary ? { afterSeq: Math.min(clientSeenUpToSeq, Number.MAX_SAFE_INTEGER) } : {}),
          })
          : null;
        const latestAnchor = attentionAnchor
          ? (hasClientSeenBoundary && attentionAnchor.seq === 0 ? { seq: Math.min(clientSeenUpToSeq, Number.MAX_SAFE_INTEGER), messageId: null } : attentionAnchor)
          : await attestedSendService.getLatestMessageAnchor(messageChannelId, {
            excludeSender: selfSender,
            createdAfter,
          });
        const threadParentAnchor = !hasClientSeenBoundary && resolved.type === "thread"
          ? await attestedSendService.getThreadParentAnchor(messageChannelId)
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
            : await attestedSendService.getMessageIdForSeq(messageChannelId, attestedBoundarySeq);
        const newMessageCount = latestFreshnessSeq > attestedBoundarySeq
          ? useAttentionFacts
            ? await attestedSendService.countAgentAttentionMessagesAfterSeq(agentId, resolved.channelId, attestedBoundarySeq, {
              excludeSender: selfSender,
              latestSeq: latestFreshnessSeq,
              createdAfter,
            })
            : await attestedSendService.countMessagesAfterSeq(messageChannelId, attestedBoundarySeq, {
              excludeSender: selfSender,
              latestSeq: latestFreshnessSeq,
              createdAfter,
            })
          : 0;
        const attestedTargetType = toAttestedSendTargetType(resolved.type);
        attestedSendActivityContext = {
          targetType: attestedTargetType,
          targetRef: effectiveTarget,
          newMessageCount,
        };
        const formalMentionFacts = attestedBoundarySeq > 0 && latestFreshnessSeq > attestedBoundarySeq
          ? await attestedSendService.getFormalMentionFacts(agentId, resolved.channelId, attestedBoundarySeq, latestFreshnessSeq, undefined, createdAfter)
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
            messageChannelId,
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
              : await attestedSendService.countMessagesAfterSeq(messageChannelId, attestedBoundarySeq, {
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
          // Read through (and drop from the delivery queue) only what this hold
          // showed: messages omitted by the context cap were not handed to the
          // agent, so they stay unread and queued for delivery.
          const showedEveryHeldMessage = shownMessageCount >= attentionHoldCount;
          if (showedEveryHeldMessage) {
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
          }
          if (latestSeq > attestedBoundarySeq) {
            const ack = showedEveryHeldMessage
              ? agentOrchestrator.acknowledgeDeliveredMessagesForChannelUpToSeq?.(
                  agentId,
                  resolved.channelId,
                  latestSeq,
                ) ?? agentOrchestrator.acknowledgeDeliveredMessagesForChannel(agentId, resolved.channelId, heldSeqs)
              : agentOrchestrator.acknowledgeDeliveredMessagesForChannel(agentId, resolved.channelId, heldSeqs);
            addTraceEvent("held_context.delivery_suppressed", {
              target_type: attestedTargetType,
              shown_message_count: shownMessageCount,
              omitted_message_count: omittedMessageCount,
              removed_count: ack.removedCount,
              read_through: showedEveryHeldMessage,
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
          ? { agentSendKey: idempotencyKey, rejectMismatchedAgentSendReplay: true }
          : {}),
      }),
      (_durationMs, message) => {
        // Keyed hashes, never the raw ids: lets a trace be matched to the
        // message and conversation an agent sent to (traceIdentity.ts).
        const messageIdHash = traceIdentityHash("message_id_hash", message.id);
        const conversationIdHash = traceIdentityHash("conversation_id_hash", resolved.channelId);
        return {
          name: "message.sent",
          attrs: {
            channel_type: resolved.type,
            message_id_present: Boolean(message.id),
            ...(messageIdHash ? { message_id_hash: messageIdHash } : {}),
            ...(conversationIdHash ? { conversation_id_hash: conversationIdHash } : {}),
            attachments_count: message.attachments.length,
            idempotency_key_present: typeof idempotencyKey === "string" && idempotencyKey.length > 0,
            send_draft_requested: isSendDraft,
          },
        };
      },
    );

    // Agent typing line: the agent is no longer about to post here (see the agent-api send route).
    void agentOrchestrator?.endAgentTypingForPostedMessage?.({
      agentId,
      serverId: agent.serverId,
      channelId: resolved.channelId,
      channelType: resolved.type,
      target: effectiveTarget,
    });

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
    if (err instanceof ChannelConversionInProgressError) {
      res.status(err.status).json({ error: err.message, code: err.code, conversionEpoch: err.conversionEpoch });
      return;
    }
    if (err instanceof channelService.ChannelArchivedError) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }
    if (err instanceof DmPeerNotMemberError || err instanceof JointChannelAccessChangedError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof messageService.AgentSendIdempotencyConflictError) {
      res.status(err.status).json({
        error: err.message,
        code: err.code,
        mismatch: err.mismatch,
        suggestedNextAction: err.suggestedNextAction,
      });
      return;
    }
    if (err instanceof AttachmentLinkError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (transientTransactionSqlState(err)) {
      res.setHeader("Retry-After", "1");
      res.status(503).json(transientSendConflictBody());
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to send message",
      logPrefix: "Internal send error:",
      err,
    });
  }
});

// Agent reactions are intentionally lightweight state updates: they update the
// message summary for viewers, but do not wake agents or enter inbox/context.
internalRouter.post("/agent/:id/messages/:messageId/reactions", requireAgentScope("message:send"), async (req, res) => {
  try {
    const emoji = parseReactionEmoji(req.body?.emoji);
    if (!emoji) {
      refuse(res, 400, EMOJI_INVALID_REFUSAL);
      return;
    }

    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;

    const message = await loadVisibleMessageForAgent(req.params.messageId, agent.id, agent.serverId, res);
    if (!message) return;
    if (message.messageType === "system") {
      refuse(res, 400, SYSTEM_MESSAGE_NOT_REACTABLE_REFUSAL);
      return;
    }

    const canPost = await channelService.canAgentPostToChannel(message.channelId, agent.id);
    if (!canPost) {
      refuse(res, 403, REACTION_MEMBERSHIP_REQUIRED_REFUSAL);
      return;
    }

    await channelService.assertChannelNotArchived(message.channelId);

    const billingReadOnly = await getChannelBillingReadOnly(message.channelId, agent.serverId);
    if (billingReadOnly) {
      refuse(res, 403, channelBillingReadOnlyRefusal(billingReadOnly));
      return;
    }
    if (await isChannelReadOnlyByQuota(message.channelId, agent.serverId)) {
      refuse(res, 403, REACTION_CHANNEL_READ_ONLY_REFUSAL);
      return;
    }

    await mutateMessageReaction({
      channelId: message.channelId,
      messageId: message.id,
      emoji,
      actor: { kind: "agent", id: agent.id },
      operation: "add",
      noticeDeliverer: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
      message,
    });

    const context = await messageService.getMessageContext(message.id, 0, 0, undefined, {
      forwardedBundleViewerAgentId: agent.id,
      viewerServerId: agent.serverId,
      includeSenderTimezone: true,
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
    res.json(messageService.projectAgentVisibleHttpMessageResponse(enriched, enriched.content, agent.id));
  } catch (err) {
    if (err instanceof ChannelConversionInProgressError) {
      res.status(err.status).json({ error: err.message, code: err.code, conversionEpoch: err.conversionEpoch });
      return;
    }
    if (err instanceof channelService.ChannelArchivedError) {
      refuse(res, 409, REACTION_CHANNEL_ARCHIVED_REFUSAL);
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to add reaction",
      logPrefix: "Internal add reaction error:",
      err,
    });
  }
});

internalRouter.delete("/agent/:id/messages/:messageId/reactions", requireAgentScope("message:send"), async (req, res) => {
  try {
    const emoji = parseReactionEmoji(req.body?.emoji);
    if (!emoji) {
      refuse(res, 400, EMOJI_INVALID_REFUSAL);
      return;
    }

    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;

    const message = await loadVisibleMessageForAgent(req.params.messageId, agent.id, agent.serverId, res);
    if (!message) return;
    if (message.messageType === "system") {
      refuse(res, 400, SYSTEM_MESSAGE_NOT_REACTABLE_REFUSAL);
      return;
    }

    const canPost = await channelService.canAgentPostToChannel(message.channelId, agent.id);
    if (!canPost) {
      refuse(res, 403, REACTION_MEMBERSHIP_REQUIRED_REFUSAL);
      return;
    }

    await channelService.assertChannelNotArchived(message.channelId);

    const billingReadOnly = await getChannelBillingReadOnly(message.channelId, agent.serverId);
    if (billingReadOnly) {
      refuse(res, 403, channelBillingReadOnlyRefusal(billingReadOnly));
      return;
    }
    if (await isChannelReadOnlyByQuota(message.channelId, agent.serverId)) {
      refuse(res, 403, REACTION_CHANNEL_READ_ONLY_REFUSAL);
      return;
    }

    await mutateMessageReaction({
      channelId: message.channelId,
      messageId: message.id,
      emoji,
      actor: { kind: "agent", id: agent.id },
      operation: "remove",
      noticeDeliverer: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
      message,
    });

    const context = await messageService.getMessageContext(message.id, 0, 0, undefined, {
      forwardedBundleViewerAgentId: agent.id,
      viewerServerId: agent.serverId,
      includeSenderTimezone: true,
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
    res.json(messageService.projectAgentVisibleHttpMessageResponse(enriched, enriched.content, agent.id));
  } catch (err) {
    if (err instanceof ChannelConversionInProgressError) {
      res.status(err.status).json({ error: err.message, code: err.code, conversionEpoch: err.conversionEpoch });
      return;
    }
    if (err instanceof channelService.ChannelArchivedError) {
      refuse(res, 409, REACTION_CHANNEL_ARCHIVED_REFUSAL);
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to remove reaction",
      logPrefix: "Internal remove reaction error:",
      err,
    });
  }
});

// Agent receives messages (long-poll)
// A long poll (`block=true`) whose buffer holds only system-app events their
// guard withholds (fail closed: they stay buffered) would otherwise answer at
// once, empty, and the daemon would ask again at once, in a loop. It reads the
// buffer again every withheldReceiveBackoffMs instead, until something can be
// handed over or the poll's timeout ends.
let withheldReceiveBackoffMs = 5_000;

/** Test seam: how long a blocking receive waits between reads while all it has is withheld. */
export function __setWithheldReceiveBackoffMsForTests(ms: number | null): void {
  withheldReceiveBackoffMs = ms ?? 5_000;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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
    const deadline = Date.now() + timeoutMs;
    let messages: AgentMessage[];
    let guarded: Awaited<ReturnType<typeof partitionDeliverableSystemAppEventMessages<AgentMessage>>>;
    for (;;) {
      const remainingMs = Math.max(0, deadline - Date.now());
      messages = await tracePhase(
        () => agentOrchestrator.receiveMessages(agentId, block, remainingMs, abortController.signal),
        (_durationMs, receivedMessages) => ({
          name: "agent_receive.messages.received",
          attrs: {
            messages_count: receivedMessages.length,
            outcome: receivedMessages.length > 0 ? "messages" : block ? "timeout" : "empty",
          },
        }),
      );

      if (abortController.signal.aborted) return;
      // System-app events their app's delivery guard vetoes are dropped too; one
      // it withholds (fail closed) is not returned but stays buffered.
      guarded = await partitionDeliverableSystemAppEventMessages(messages, agentId);
      // Withheld alone, in a long poll: back off and read again (see
      // withheldReceiveBackoffMs) rather than answer empty at once.
      if (!block || guarded.deliverable.length > 0 || guarded.vetoed.length > 0 || guarded.withheld.length === 0) break;
      const waitMs = Math.min(withheldReceiveBackoffMs, deadline - Date.now());
      if (waitMs <= 0) break;
      addTraceEvent("agent_receive.withheld_backoff", { withheld_count: guarded.withheld.length, wait_ms: waitMs });
      await abortableDelay(waitMs, abortController.signal);
      if (abortController.signal.aborted) return;
    }
    const deliverableMessages: typeof messages = [];
    const undeliverableMessages: typeof messages = [...guarded.vetoed];
    for (const message of guarded.deliverable) {
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

    // Raft's own system apps' events read as ordinary messages; an external app's inert (agentFacingContent.ts).
    const renderedContents = await tracePhase(
      () => renderAgentFacingContents(refreshedDeliverableMessages, agentId, agent.serverId),
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
        content: renderedContents[index],
      })),
    });
  } catch (err) {
    addTraceEvent("agent_receive.request.failed", {
      error_class: errorClassOf(err),
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
      refuse(res, 400, { code: "receive_ack_ids_required", error: "An acknowledgement needs the deliveries it covers: give a non-empty list of seqs or message ids." });
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
    sendJsonServerError(req, res, {
      error: "Failed to acknowledge received messages",
      logPrefix: "Internal receive-ack error:",
      err,
    });
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
    sendJsonServerError(req, res, {
      error: "Failed to complete runtime profile reset acknowledgment",
      logPrefix: "Internal runtime-profile migration-done error:",
      err,
    });
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
      refuse(res, resolved.status, messageResolveRefusal(resolved.error));
      return;
    }
    // After the access check, as the agent API does: behind the plan's history
    // window (the time is from the row the lookup matched).
    const historyWindow = await getServerHistoryWindowForRead(agent.serverId);
    if (isBehindHistoryWindow(resolved.message.createdAt, historyWindow)) {
      refuse(res, 404, agentHistoryLimitedRefusal(historyWindow));
      return;
    }

    const payload = await resolveAgentVisibleMessagePayload(resolved.messageId, agent.serverId, agentId);
    if (!payload) {
      refuse(res, 404, MESSAGE_NOT_FOUND_REFUSAL);
      return;
    }

    res.json({ message: payload });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to resolve message",
      logPrefix: "Internal message resolve error:",
      err,
    });
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
      refuse(res, 400, HISTORY_TARGET_REQUIRED_REFUSAL);
      return;
    }

    const result = await loadOwnedMachineAgent(agentId, req.machineId, req.serverId);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    const { agent } = result;

    // Task v2: a task ref (`#parent:#7`, as deliveries name a task's
    // conversation) reads that conversation; none yet is an empty page.
    const taskConversation = await resolveAgentTaskRefConversation(agent.serverId, agentId, channelRef, { create: false });
    if (taskConversation && typeof taskConversation === "object" && taskConversation.kind === "pending") {
      res.json({ messages: [], has_more: false, has_older: false, has_newer: false, last_read_seq: 0 });
      return;
    }
    const resolved = taskConversation && typeof taskConversation === "object"
      ? { channelId: taskConversation.channelId, type: "thread" as const }
      : await channelService.resolveChannelByName(agent.serverId, agentId, channelRef);
    if (!resolved) {
      refuse(res, 404, AGENT_CHANNEL_NOT_FOUND_REFUSAL);
      return;
    }

    const channelId = resolved.channelId;
    const hasAccess = await channelService.canAgentAccessChannel(channelId, agentId);
    if (!hasAccess) {
      refuse(res, 403, HISTORY_NOT_ACCESSIBLE_REFUSAL);
      return;
    }

    const channel = await channelService.getChannel(channelId);
    const jointThreadProjection = isSubConversationType(channel?.type)
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
          viewerServerId: agent.serverId,
          includeSenderTimezone: true,
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
        viewerServerId: agent.serverId,
        includeSenderTimezone: true,
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
    // As the agent API: a `--before` page says whether anything is at or after its anchor.
    if (!around && beforeSeq !== undefined && afterSeq === undefined && !hasNewer) {
      hasNewer = await messageService.hasMessagesAtOrAfter(storageChannelId, beforeSeq, historyCutoff, {
        forwardedBundleViewerAgentId: agent.id,
        viewerServerId: agent.serverId,
      });
    }

    // Check if plan limit is truncating results
    let historyLimited = false;
    let historyLimitMessage: string | undefined;
    if (historyCutoff) {
      historyLimited = await messageService.hasOlderMessages(storageChannelId, historyCutoff, beforeSeq);
      if (historyLimited) {
        historyLimitMessage = agentHistoryLimitNote({ plan, cutoff: historyCutoff });
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
            actionMetadata: withoutAgentHiddenActionCardSpec(actionMetadata),
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
          ...(external && {
            mentioned: messageService.isSlackBridgedExternalMessage(message)
              && messageService.isAgentPersonallyMentioned(message.mentions, agentId),
          }),
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
    sendJsonServerError(req, res, {
      error: "Failed to read history",
      logPrefix: "Internal history error:",
      err,
    });
  }
});

const EXPLICIT_SEARCH_TIMESTAMP_OFFSET_RE = /(?:[zZ]|[+-]\d{2}:\d{2})$/;

function parseOffsetSearchTimestamp(raw: string): { ok: true; value: Date } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!EXPLICIT_SEARCH_TIMESTAMP_OFFSET_RE.test(trimmed)) {
    return {
      ok: false,
      error: "A search date filter needs a time zone offset: give an ISO timestamp such as 2026-08-06T04:38:00+08:00.",
    };
  }
  const value = new Date(trimmed);
  if (Number.isNaN(value.getTime())) {
    return {
      ok: false,
      error: "That search date filter isn't a valid time: give an ISO timestamp with a time zone offset, such as 2026-08-06T04:38:00+08:00.",
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
        refuse(res, 404, AGENT_CHANNEL_NOT_FOUND_REFUSAL);
        return;
      }
      channelId = resolved.channelId;
    }

    const limit = Math.min(
      Number(req.query.limit) || AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT,
      AGENT_API_MESSAGE_SEARCH_MAX_LIMIT,
    );
    const offset = parseOffsetQueryParam(req.query.offset);
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
      refuse(res, 400, { code: "INVALID_DATE_FILTER", error: afterParsed.error });
      return;
    }
    const beforeParsed = beforeRaw ? parseOffsetSearchTimestamp(beforeRaw) : undefined;
    if (beforeParsed && !beforeParsed.ok) {
      refuse(res, 400, { code: "INVALID_DATE_FILTER", error: beforeParsed.error });
      return;
    }
    const after = afterParsed?.value;
    const before = beforeParsed?.value;
    const sortRaw = typeof req.query.sort === "string" ? req.query.sort : undefined;
    if (sortRaw && sortRaw !== "relevance" && sortRaw !== "recent") {
      refuse(res, 400, { code: "search_sort_invalid", error: "A search sorts by relevance or by recent: use one of those, or leave the sort out." });
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
      historyCutoff: getHistoryCutoff(await getServerPlan(agent.serverId)),
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
        // RFC 077: an agent reads "sent by an assistant for its owner" as `delegated_by=@name`, as on every other message it reads.
        const { externalMessage, delegatedBy, retracted: _retracted, ...visibleResult } = result;
        const external = result.senderType === "external_projection";
        // Slack-bridged rows read like ordinary messages; other external content stays inert.
        const inert = external && (!isSlackBridgedExternalProvider(externalMessage?.provider)
          || externalMessage?.actor_kind === "unknown");
        const taskFact = external ? undefined : taskFacts.get(result.id);
        return {
          ...visibleResult,
          ...(external && !externalMessage ? { senderId: "" } : {}),
          senderType: toAgentFacingActorType(result.senderType),
          ...(externalMessage ? { external_message: externalMessage } : {}),
          ...(delegatedBy ? { delegated_by: { name: delegatedBy.name } } : {}),
          content: inert
            ? renderThirdPartyInertText({ field: "tool_result", value: result.content })
            : renderedContents[index],
          snippet: inert
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
    if (respondToDmTargetResolutionError(err, res)) return;
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
    // A channel the agent cannot see answers 404 whatever its type, exactly
    // like an id that does not exist (#wg-rbac B14, as the agent API's join).
    if (!channel || channel.serverId !== result.agent.serverId || !await channelService.canAgentAccessChannel(channel.id, result.agent.id)) {
      // One constant for a missing channel and one the agent cannot see (no existence oracle).
      refuse(res, 404, AGENT_CHANNEL_NOT_FOUND_REFUSAL);
      return;
    }
    if (isSubConversationType(channel.type)) {
      refuse(res, 400, THREAD_NOT_JOINABLE_REFUSAL);
      return;
    }
    if (channel.type === "dm") {
      refuse(res, 403, DM_NOT_JOINABLE_REFUSAL);
      return;
    }
    if (channel.type === "private") {
      refuse(res, 403, PRIVATE_CHANNEL_INVITE_ONLY_REFUSAL);
      return;
    }
    if (channel.type === "joint") {
      refuse(res, 403, JOINT_CHANNEL_ADD_ONLY_REFUSAL);
      return;
    }
    if (channel.archivedAt) {
      refuse(res, 409, JOIN_CHANNEL_ARCHIVED_REFUSAL);
      return;
    }
    const wasAgentMember = await channelService.isChannelAgent(channel.id, result.agent.id);
    if (wasAgentMember) {
      res.json({ ok: true });
      return;
    }
    if (!await actorHasServerCapabilityInServer(result.agent.serverId, "agent", result.agent.id, "joinPublicChannels")) {
      refuse(res, 403, SERVER_ROLE_CANNOT_JOIN_REFUSAL);
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
              causalActor: { type: "agent", id: result.agent.id },
            },
            // The joining agent should not see its own join as unread.
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
    // Visibility first: a channel the agent cannot see answers 404 whatever
    // its type, exactly like an id that does not exist (#wg-rbac B14).
    if (!channel || channel.serverId !== result.agent.serverId || !await channelService.canAgentAccessChannel(channel.id, result.agent.id)) {
      // One constant for a missing channel and one the agent cannot see (no existence oracle).
      refuse(res, 404, AGENT_CHANNEL_NOT_FOUND_REFUSAL);
      return;
    }
    // Joint channels carry ordinary membership: a human can leave one, so an
    // agent can too. Leaving only removes this agent's row on this server's
    // projection; other servers' members are untouched.
    if (channel.type !== "channel" && channel.type !== "private" && channel.type !== "joint") {
      refuse(res, 403, CHANNEL_TYPE_NOT_LEAVABLE_REFUSAL);
      return;
    }
    if (channel.archivedAt) {
      refuse(res, 409, LEAVE_CHANNEL_ARCHIVED_REFUSAL);
      return;
    }

    // An older CLI's path: the same refusal as the agent API's leave (it can't send deleteIfLast, so a person deletes the channel).
    const deleteIfLast = (req.body as { deleteIfLast?: unknown } | undefined)?.deleteIfLast === true;
    const removal = await removeUnlessLastMember(() => channelService.removeAgent(channel.id, result.agent.id, undefined, undefined, deleteIfLast ? "delete" : "refuse"));
    if (!removal) {
      refuse(res, 409, lastMemberRefusal({ target: `#${channel.name}` }));
      return;
    }
    if (channel.type !== "channel") {
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
      await agentOrchestrator.purgeAgentInboxForChannelTree(
        result.agent.id,
        channel.id,
        "channel_membership_removed",
      );
    }
    req.app.get("io")?.to(channel.type === "private" ? `channel:${channel.id}` : `server:${result.agent.serverId}`).emit("channel:members-updated", { channelId: channel.id });
    res.json({ ok: true, ...(removal.channelDeleted ? { channelDeleted: true } : {}) });
    recordRaftCliActivity(req, result.agent.id, {
      command: "channel.leave",
      summary: "Left channel",
      target: channel.name ? `#${channel.name}` : channel.id,
    });
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg === channelService.ALL_CHANNEL_LEAVE_MESSAGE || msg === channelService.ALL_CHANNEL_REMOVE_MEMBERS_MESSAGE) {
      refuse(res, 403, ALL_CHANNEL_MEMBERSHIP_FIXED_REFUSAL);
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
    sendJsonServerError(req, res, {
      error: "Failed to create channel",
      logPrefix: "Internal channel create error:",
      err,
    });
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
    sendJsonServerError(req, res, {
      error: "Failed to update channel",
      logPrefix: "Internal channel update error:",
      err,
    });
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
    sendJsonServerError(req, res, {
      error: "Failed to add member",
      logPrefix: "Internal channel add member error:",
      err,
    });
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
    sendJsonServerError(req, res, {
      error: "Failed to remove member",
      logPrefix: "Internal channel remove member error:",
      err,
    });
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
      refuse(res, 400, { code: "thread_required", error: "An unfollow needs a thread: name it as #channel:<msg> or dm:@peer:<msg>, with the parent message's msg= short id." });
      return;
    }
    const reason = messageService.normalizeUnfollowReason(req.body?.reason);

    let threadChannelId: string | null = null;
    if (UUID_RE.test(threadRef)) {
      const channel = await channelService.getChannel(threadRef);
      // Visibility before the kind check: an id the agent cannot see answers
      // 404 like one that does not exist, never "not a thread" (#wg-rbac B14).
      if (!channel || channel.serverId !== result.agent.serverId || !await channelService.canAgentAccessChannel(channel.id, result.agent.id)) {
        refuse(res, 404, THREAD_NOT_FOUND_REFUSAL);
        return;
      }
      if (!isSubConversationType(channel.type)) {
        refuse(res, 400, NOT_A_THREAD_REFUSAL);
        return;
      }
      threadChannelId = channel.id;
    } else {
      const resolved = await channelService.resolveChannelByName(result.agent.serverId, result.agent.id, threadRef);
      if (!resolved) {
        refuse(res, 404, THREAD_NOT_FOUND_REFUSAL);
        return;
      }
      if (resolved.type !== "thread") {
        refuse(res, 400, NOT_A_THREAD_REFUSAL);
        return;
      }
      threadChannelId = resolved.channelId;
    }

    await channelService.unfollowThreadForFollower("agent", result.agent.id, threadChannelId);
    const io = req.app.get("io") as SocketServer | undefined;
    await emitThreadFollowersUpdated(io, threadChannelId);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (io && agentOrchestrator) {
      // Joint threads: the local projection is not where reads resolve.
      // broadcastSystemMessage persists against the channelId it is handed,
      // so a receipt for a joint thread landed in the LOCAL projection while
      // every read (permalink, thread parent lookup) resolves to the
      // CANONICAL thread -- the message became unreachable, and the local
      // projection has no parent linkage, so Activity rendered a blank row.
      // ...ToLocalSurfaces resolves the projection first and falls back to
      // this exact call when there is no joint mapping.
      await messageService.broadcastSystemMessageToLocalSurfaces(
        io,
        agentOrchestrator,
        threadChannelId,
        messageService.buildUnfollowNotice(result.agent.name, "thread", reason),
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
      refuse(res, 400, { code: "channel_required", error: "Listing a channel's members needs a channel: name one, such as #general." });
      return;
    }

    const ctx = await resolveAgentChannel(req.params.id, req.serverId!, req.machineId, channelRef);
    if (!ctx) {
      refuse(res, 404, AGENT_CHANNEL_NOT_FOUND_REFUSAL);
      return;
    }

    const members = await channelService.getChannelMembers(ctx.channelId);
    const agentRoles = await getAgentServerRolesInServer(ctx.agent.serverId, members.agents.map((a) => a.id));
    const visibleAgents = members.agents.map((a) => ({
      name: a.name,
      status: a.status,
      role: agentRoles.get(a.id) ?? null,
    }));
    const visibleHumans = await filterAgentVisibleHumansForHiddenDirectory(
      ctx.agent.serverId,
      ctx.agent.id,
      members.humans,
    );
    res.json({
      channel: { ref: channelRef, type: ctx.channelType },
      agents: visibleAgents,
      humans: visibleHumans.map((u) => {
        const servers = channelService.agentVisibleMemberServers(u, ctx.agent.serverId);
        // Another server's person: their role stays with their organization.
        return { name: u.name, description: u.description, ...(u.serverId === ctx.agent.serverId ? { role: u.role } : {}), ...(servers ? { servers } : {}) };
      }),
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to get channel members",
      logPrefix: "Internal channel members error:",
      err,
    });
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
    sendJsonServerError(req, res, {
      error: "Failed to get server info",
      logPrefix: "Internal server info error:",
      err,
    });
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
    sendJsonServerError(req, res, {
      error: "Failed to update server",
      logPrefix: "Internal server update error:",
      err,
    });
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
      refuse(res, 404, SERVER_GONE_FOR_AVATAR_REFUSAL);
      return;
    }
    const uploaded = await runSingleAvatarUpload(serverAvatarUpload, req);
    if (!uploaded) {
      refuse(res, 400, AVATAR_FILE_REQUIRED_REFUSAL);
      return;
    }

    const avatarUrl = await storeServerAvatar(server.id, server.avatarUrl, uploaded.buffer);
    const updated = await serverService.updateServerProfile(server.id, { avatarUrl }, {
      audit: await agentServerProfileAudit({ id: result.agent.id, name: result.agent.name, serverId: result.agent.serverId }, server.id),
    });
    if (!updated) {
      refuse(res, 404, SERVER_GONE_FOR_AVATAR_REFUSAL);
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
      refuse(res, 400, AVATAR_TOO_LARGE_REFUSAL);
      return;
    }
    if (err instanceof Error && err.message.includes(PROFILE_AVATAR_BAD_FORMAT_MESSAGE)) {
      refuse(res, 400, AVATAR_BAD_FORMAT_REFUSAL);
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to upload avatar",
      logPrefix: "Internal server avatar update error:",
      err,
    });
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
    sendJsonServerError(req, res, {
      error: "Failed to load profile",
      logPrefix: "Internal profile read error:",
      err,
    });
  }
});

internalRouter.post("/agent/:id/profile/avatar", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    // Same fence as the agent API: a managed bot's avatar follows the app logo.
    if (result.agent.managedByAppInstallId) {
      refuse(res, 403, APP_BOT_AVATAR_MANAGED_REFUSAL);
      return;
    }
    // A personal assistant's avatar is always Ottie's.
    if (result.agent.assistantOwnerUserId) {
      refuse(res, 403, { code: ASSISTANT_PROFILE_FIXED_CODE, error: ASSISTANT_PROFILE_FIXED_ERROR });
      return;
    }
    const uploaded = await runSingleAvatarUpload(profileAvatarUpload, req);
    if (!uploaded) {
      refuse(res, 400, AVATAR_FILE_REQUIRED_REFUSAL);
      return;
    }

    const avatarUrl = await storeAgentAvatar(result.agent.serverId, result.agent.avatarUrl, uploaded.buffer);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (agentOrchestrator) {
      agentOrchestrator.evictCache(result.agent.id);
    }
    await agentService.updateAgent(result.agent.id, { avatarUrl });
    broadcastAgentUpdated(req, result.agent.serverId, result.agent.id);

    const profile = await buildAgentProfileView(result.agent.id, result.agent.id, agentOrchestrator);
    if (!profile) {
      refuse(res, 404, AGENT_GONE_REFUSAL);
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
      refuse(res, 400, AVATAR_TOO_LARGE_REFUSAL);
      return;
    }
    if (err instanceof Error && err.message.includes(PROFILE_AVATAR_BAD_FORMAT_MESSAGE)) {
      refuse(res, 400, AVATAR_BAD_FORMAT_REFUSAL);
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to update avatar",
      logPrefix: "Internal profile avatar update error:",
      err,
    });
  }
});

internalRouter.post("/agent/:id/profile", async (req, res) => {
  try {
    const result = await loadOwnedMachineAgent(req.params.id, req.machineId, req.serverId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const body = (req.body ?? {}) as { avatarUrl?: unknown; displayName?: unknown; description?: unknown };
    const fenced = await agentProfileFenceRefusal(result.agent, body, async () => Boolean(await getHostedRuntimeSummary(result.agent.id)));
    if (fenced) {
      refuse(res, 403, fenced);
      return;
    }
    const checked = agentProfileUpdateFields(body);
    if (!checked.ok) {
      refuse(res, 400, checked.refusal);
      return;
    }
    const { fields } = checked;
    // A personal assistant is always Ottie; its avatar is reserved for assistants.
    const profileRefusal = agentProfileWriteRefusal(result.agent, fields);
    if (profileRefusal) {
      refuse(res, profileRefusal.status, { code: profileRefusal.code, error: profileRefusal.error });
      return;
    }

    const updated = await agentService.updateAgent(result.agent.id, fields);
    if (!updated) {
      refuse(res, 404, AGENT_GONE_REFUSAL);
      return;
    }
    broadcastAgentUpdated(req, result.agent.serverId, result.agent.id);

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (agentOrchestrator) {
      agentOrchestrator.evictCache(result.agent.id);
    }

    const profile = await buildAgentProfileView(result.agent.id, result.agent.id, agentOrchestrator);
    if (!profile) {
      refuse(res, 404, AGENT_GONE_REFUSAL);
      return;
    }

    res.json(profile);
    recordRaftCliActivity(req, result.agent.id, {
      command: "profile.update",
      summary: "Updated profile",
      target: `@${profile.name}`,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to update profile",
      logPrefix: "Internal profile update error:",
      err,
    });
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
    refuse(res, 403, TASK_MEMBERSHIP_REQUIRED_REFUSAL);
    return true;
  }
  return false;
}

function rejectHistoricalJointTaskWriteIfNeeded(
  surface: Awaited<ReturnType<typeof resolveTaskChannelSurface>>,
  createdAt: Date | string,
  res: Response,
): boolean {
  if (!surface || !isHistoricalJointTaskReadOnly(surface, createdAt)) return false;
  refuse(res, 403, JOINT_TASK_READ_ONLY_REFUSAL);
  return true;
}

// Agent lists tasks
internalRouter.get("/agent/:id/tasks", requireAgentScope("task:read"), async (req, res) => {
  try {
    const channelRef = req.query.channel as string;
    if (!channelRef) {
      refuse(res, 400, { code: "channel_required", error: "Listing tasks needs a channel: name one, such as #general." });
      return;
    }

    const ctx = await resolveAgentTaskChannel(req.params.id, req.serverId!, req.machineId, channelRef);
    if (!ctx) {
      refuse(res, 404, TASK_CHANNEL_NOT_FOUND_REFUSAL);
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
        refuse(res, 400, { code: "invalid_status", error: "That isn't a task status: filter by backlog, todo, in_progress, in_review, done or closed." });
        return;
      }
      statusFilter = statusParam;
    }
    const tasks = await taskService.listTasks(ctx.storageChannelId, statusFilter);
    res.json({ tasks: taskService.projectTasksToChannel(tasks, ctx.localChannel) });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to list tasks",
      logPrefix: "Internal list tasks error:",
      err,
    });
  }
});

// Agent creates tasks (batch)
internalRouter.post("/agent/:id/tasks", requireAgentScope("task:write"), async (req, res) => {
  try {
    const { channel, tasks: items } = req.body;
    if (!channel || !Array.isArray(items) || items.length === 0) {
      refuse(res, 400, { code: "tasks_required", error: "A task create needs a channel and at least one task: name the channel and give each task a title." });
      return;
    }
    if (items.length > 50) {
      refuse(res, 400, TOO_MANY_TASKS_REFUSAL);
      return;
    }
    for (const item of items) {
      if (!item.title || typeof item.title !== "string" || item.title.trim().length === 0) {
        refuse(res, 400, { code: "task_title_required", error: "Every task needs a title: give each one a short line saying what the work is." });
        return;
      }
      if (item.description != null && typeof item.description !== "string") {
        refuse(res, 400, { code: "task_description_invalid", error: "A task's description has to be text: send it as a string, or leave it out." });
        return;
      }
      if (item.source_message_id != null && typeof item.source_message_id !== "string") {
        refuse(res, 400, { code: "invalid_source_message", error: "A task's source message has to be given as a message id." });
        return;
      }
    }

    const ctx = await resolveAgentTaskChannel(req.params.id, req.serverId!, req.machineId, channel);
    if (!ctx) {
      refuse(res, 404, TASK_CHANNEL_NOT_FOUND_REFUSAL);
      return;
    }
    // A sub-conversation (a thread, a task's own conversation) holds no tasks.
    if (isSubConversationType(ctx.channelType)) {
      refuse(res, 409, TASK_CREATE_IN_THREAD_REFUSAL);
      return;
    }
    if (rejectAgentTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, req.params.id), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }

    // Task v2: a source message needs task v2 conversations on this server.
    const hasSource = (item: { source_message_id?: unknown }) => typeof item.source_message_id === "string" && item.source_message_id.trim().length > 0;
    const taskV2 = await isTaskV2ConversationsEnabled(ctx.localChannel.serverId);
    if (items.some(hasSource) && !taskV2) {
      const refusal = new TaskV2NotEnabledError();
      res.status(refusal.status).json({ error: refusal.message, code: refusal.code });
      return;
    }
    // Task v2: a task always has a source, the message that asked for it
    // (#wg-task-v2:#23). Flag off keeps the pre-v2 host message.
    if (taskV2 && !items.every(hasSource)) {
      refuse(res, 400, taskSourceRequiredRefusal(channel));
      return;
    }

    // Task v2: resolve each item's source message (full or short id) here, a
    // reply in one of the channel's threads to that thread's root;
    // createTasks re-validates it under the channel lock.
    const createItems: taskService.TaskCreateItem[] = [];
    for (const item of items) {
      let sourceMessageId: string | null = null;
      if (item.source_message_id) {
        const resolved = await taskService.resolveTaskSourceMessage(ctx.storageChannelId, item.source_message_id.trim());
        if (!resolved) {
          refuse(res, 400, { code: "invalid_source_message", error: `There is no such message in this channel or its threads to make a task from: ${INVALID_TASK_SOURCE_STEP}` });
          return;
        }
        sourceMessageId = resolved.id;
      }
      const description = typeof item.description === "string" ? item.description.trim() : "";
      createItems.push({ title: item.title.trim(), ...(description ? { description } : {}), sourceMessageId });
    }

    const { tasks: created, hostMessages, hostMessagesVisible } = await taskService.createTasks(
      ctx.storageChannelId,
      "agent",
      req.params.id,
      createItems,
      { initiatingServerId: ctx.localChannel.serverId },
    );

    const io: SocketServer = req.app.get("io");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const creatorName = created[0]?.createdByName || "Unknown";

    // Task v2 (flag on): creating a task writes no message (the task has
    // its own conversation), so nothing goes out as message:new or to agents. Flag off (pre-v2, v1.4): the
    // host message broadcasts on the ordinary message:new / agent-delivery
    // path. The task fact broadcasts separately on the task board.
    const targets = await getTaskRealtimeSurfaceTargets(ctx.surface);
    for (const target of targets) {
      const projectedTasks = taskService.projectTasksToChannel(created, target.localChannel);
      const projectedMessages = hostMessagesVisible
        ? hostMessages.map((message) => ({ ...message, channelId: target.channelId }))
        : [];
      for (const message of projectedMessages) {
        // message-realtime-producer: task-route.new.internal-agent
        emitTaskMessageNew(io, target, message, creatorName);
      }
      emitTaskCreated(io, target, {
        channelId: target.channelId,
        tasks: projectedTasks,
      });
      if (projectedMessages.length > 0) {
        await messageService.deliverMessagesToAgents(
          agentOrchestrator,
          projectedMessages,
          creatorName,
        );
      }
    }

    // Emit system message to chat (visible to humans + agents, counts as unread).
    // Task v2 (flag on): creating a task posts nothing in the
    // channel (spec §2, §4); the task board event above is the whole update.
    const taskList = created.map((t) => `#${t.taskNumber} "${messageService.summarizeForSystemMessage(t.title)}"`).join(", ");
    const sysContent = `📋 ${created.length} new task${created.length > 1 ? "s" : ""} created: ${taskList}`;
    if (hostMessagesVisible) messageService.broadcastSystemMessageToLocalSurfaces(io, agentOrchestrator, ctx.channelId, sysContent, {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.created_summary",
        reason: "new shared tasks are channel activity",
        causalActor: { type: "agent", id: req.params.id },
      },
      // The agent that created the tasks should not see its own action as unread.
    }).catch(() => {});

    // Task v2: the "created from this message" line in the source's thread,
    // as on the agent API, so whoever asked sees their request was taken.
    if (taskV2) {
      await announceTasksCreatedFromSourceMessages(io, agentOrchestrator, {
        tasks: created,
        localChannel: ctx.localChannel,
        actor: { type: "agent", id: req.params.id },
      }).catch((err) => console.error("internal.task-create source announcement failed:", err));
    }

    res.json({ tasks: taskService.projectTasksToChannel(created, ctx.localChannel) });
    recordRaftCliActivity(req, req.params.id, {
      command: "task.create",
      summary: `Created ${created.length} task${created.length === 1 ? "" : "s"}`,
      target: channel,
    });
  } catch (err) {
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to create tasks",
      logPrefix: "Internal create tasks error:",
      err,
    });
  }
});

// Agent batch claims tasks (by task_numbers and/or message_ids)
internalRouter.post("/agent/:id/tasks/claim", requireAgentScope("task:write"), async (req, res) => {
  try {
    const { channel, task_numbers, message_ids } = req.body;
    const hasTaskNumbers = Array.isArray(task_numbers) && task_numbers.length > 0;
    const hasMessageIds = Array.isArray(message_ids) && message_ids.length > 0;

    if (!channel || (!hasTaskNumbers && !hasMessageIds)) {
      refuse(res, 400, { code: "task_numbers_required", error: "A claim needs a channel and the tasks to claim: name the channel, and give the task numbers or message ids." });
      return;
    }

    const ctx = await resolveAgentTaskChannel(req.params.id, req.serverId!, req.machineId, channel);
    if (!ctx) {
      refuse(res, 404, TASK_CHANNEL_NOT_FOUND_REFUSAL);
      return;
    }
    if (isSubConversationType(ctx.channelType)) {
      refuse(res, 409, TASK_CLAIM_IN_THREAD_REFUSAL);
      return;
    }
    if (rejectAgentTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, req.params.id), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }

    // Task v2 server: claim by message id does not execute (nothing in the
    // call is claimed); the error text carries the --number / create commands
    // so CLIs that only speak this legacy route print them (spec §5).
    if (hasMessageIds) {
      const useCreate = await taskV2ClaimByMessageRefusal({
        storageChannelId: ctx.storageChannelId,
        initiatingServerId: ctx.localChannel.serverId,
        channel,
        messageIds: message_ids,
        selfHandle: ctx.agent.name,
        alsoHadTaskNumbers: hasTaskNumbers,
      });
      if (useCreate) {
        res.status(useCreate.status).json(useCreate.body);
        return;
      }
    }

    const io: SocketServer = req.app.get("io");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const agentName = ctx.agent.displayName || ctx.agent.name;
    const successfulClaims: { taskNumber: number; title: string; messageId: string }[] = [];

    // The rows before the claim: each claim's lifecycle lines name what it
    // changed (taken / moved to In Progress).
    const claimTargetsBefore = new Map<number, { status: string; claimedByType: string | null; claimedById: string | null }>();
    if (hasTaskNumbers) {
      for (const taskNumber of task_numbers) {
        const existing = await taskService.getTaskByNumber(ctx.storageChannelId, taskNumber);
        if (existing && rejectHistoricalJointTaskWriteIfNeeded(ctx.surface, existing.createdAt, res)) return;
        if (existing) claimTargetsBefore.set(taskNumber, existing);
      }
    }
    // Task v2: the claimer follows the task conversation (`assigned`; an
    // explicit unfollow is reactivated) and the conversation gets the claim's
    // lines. Flag off / none: nothing, as before (no chat-surface line).
    const announceClaim = (
      claimedRow: { id: string; taskNumber: number; title: string; status: string },
      before: { status: string; claimedByType: string | null; claimedById: string | null } | undefined,
    ) => announceTaskClaim(io, agentOrchestrator, {
      taskId: claimedRow.id,
      taskNumber: claimedRow.taskNumber,
      title: claimedRow.title,
      localChannel: ctx.localChannel,
      actor: { type: "agent", id: req.params.id },
      before: before ?? { status: "todo", claimedByType: null, claimedById: null },
      afterStatus: claimedRow.status,
      legacyContent: null,
    });

    // Claim by task numbers
    const results: { taskNumber?: number; messageId?: string; success: boolean; reason?: string }[] = [];
    if (hasTaskNumbers) {
      const batchResults = await taskService.batchClaimTasks(
        ctx.storageChannelId,
        task_numbers,
        "agent",
        req.params.id,
        ctx.localChannel,
      );

      for (const r of batchResults) {
        let claimedMessageId: string | undefined;
        if (r.success && r.task) {
          // Task v2: a pre-v2 task gets its own conversation now, so the
          // returned thread target is that conversation (flag off: no-op).
          const claimedTask = await withTaskConversationEnsured(r.task, { initiatingServerId: ctx.localChannel.serverId });
          const facts = await emitTaskMutationToSurfaces(io, ctx.surface, claimedTask);
          await announceClaim(claimedTask.row, claimTargetsBefore.get(r.taskNumber));
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
        const preflight = await taskService.resolveMessageInChannel(ctx.storageChannelId, rawMsgId);
        if (preflight && rejectHistoricalJointTaskWriteIfNeeded(ctx.surface, preflight.createdAt, res)) return;
        if (preflight) {
          const existing = await taskService.resolveClaimTargetByMessageId(preflight.id);
          if (existing.kind === "task" && rejectHistoricalJointTaskWriteIfNeeded(ctx.surface, existing.owner.row.createdAt, res)) return;
        }
      }
      // Claim an existing task this message names (its pre-v2 host message, or
      // the single task hanging under it). "rejected-joint" = the response was already sent.
      const claimExistingTask = async (msgId: string, existingOwner: taskService.TaskOwner): Promise<"done" | "rejected-joint"> => {
        if (rejectHistoricalJointTaskWriteIfNeeded(ctx.surface, existingOwner.row.createdAt, res)) return "rejected-joint";
        const existingNumber = existingOwner.row.taskNumber;
        const reason = await taskService.getClaimConflictReasonForOwner(existingOwner, "agent", req.params.id);
        if (reason) {
          results.push({ messageId: msgId, success: false, reason, taskNumber: existingNumber });
          return "done";
        }
        const claimed = await taskService.claimTask(existingOwner.row.id, "agent", req.params.id);
        if (typeof claimed !== "string") {
          const facts = await emitTaskMutationToSurfaces(io, ctx.surface, claimed);
          await announceClaim(claimed.row, existingOwner.row);
          if (facts.messageId) {
            successfulClaims.push({ taskNumber: facts.taskNumber, title: facts.title, messageId: facts.messageId });
          }
          results.push({ messageId: msgId, success: true, taskNumber: facts.taskNumber });
          return "done";
        }
        results.push({ messageId: msgId, success: false, reason: claimed, taskNumber: existingNumber });
        return "done";
      };
      // As in the agent API: a message behind the plan's history window can't become a task.
      const claimHistoryWindow = await getServerHistoryWindowForRead(ctx.agent.serverId);
      for (const rawMsgId of message_ids) {
        // Resolve short ID prefix to full message ID
        const resolved = await taskService.resolveMessageInChannel(ctx.storageChannelId, rawMsgId);
        if (!resolved) {
          results.push({ messageId: rawMsgId, success: false, reason: "message not found" });
          continue;
        }
        const msgId = resolved.id;

        // Converting a pre-cutover message into a task is itself a historical
        // write. Participant projections may read it but cannot materialize
        // or mutate task identity in their local workspace.
        if (rejectHistoricalJointTaskWriteIfNeeded(ctx.surface, resolved.createdAt, res)) return;

        // Task v2: a pre-v2 host message names its task; a source message names the
        // tasks hanging under it — one is claimed, several must be picked by
        // number; none keeps the convert-to-task behavior below.
        const target = await taskService.resolveClaimTargetByMessageId(msgId);
        if (target.kind === "ambiguous") {
          results.push({
            messageId: msgId,
            success: false,
            reason: taskService.describeAmbiguousClaimByMessage(target.taskNumbers),
          });
          continue;
        }
        if (target.kind === "task") {
          if (await claimExistingTask(msgId, target.owner) === "rejected-joint") return;
          continue;
        }
        if (isBehindHistoryWindow(resolved.createdAt, claimHistoryWindow)) {
          results.push({ messageId: msgId, success: false, reason: agentHistoryLimitedRefusal(claimHistoryWindow).error });
          continue;
        }

        const converted = await taskService.convertMessageToTask(msgId, "agent", req.params.id, ctx.storageChannelId);
        if (typeof converted === "string") {
          if (converted === "already converted") {
            // Lost a race with a concurrent convert: claim what it created.
            const raced = await taskService.resolveClaimTargetByMessageId(msgId);
            if (raced.kind === "task") {
              if (await claimExistingTask(msgId, raced.owner) === "rejected-joint") return;
              continue;
            }
            if (raced.kind === "ambiguous") {
              results.push({
                messageId: msgId,
                success: false,
                reason: taskService.describeAmbiguousClaimByMessage(raced.taskNumbers),
              });
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
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to claim tasks",
      logPrefix: "Internal claim tasks error:",
      err,
    });
  }
});

/**
 * Task v2: a lifecycle line in the task conversation from a legacy daemon
 * route (created first for a v2 task). Without a conversation (flag off) these
 * routes post nothing, as before task v2. Never throws: the mutation committed.
 */
function postAgentTaskLifecycleLine(
  req: Request,
  task: { id: string },
  localChannel: { id: string; serverId?: string; deletedAt: Date | null },
  buildContent: () => Promise<string>,
): void {
  void (async () => {
    try {
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
      if (!agentOrchestrator) return;
      await postTaskConversationNotice(req.app.get("io") as SocketServer, agentOrchestrator, {
        taskId: task.id,
        localChannel,
        actor: { type: "agent", id: req.params.id as string },
        content: await buildContent(),
        legacyContent: null,
      });
    } catch (err) {
      console.error(`[internal] task ${task.id}: failed to post lifecycle line:`, err);
    }
  })();
}

// Agent unclaims a task
internalRouter.post("/agent/:id/tasks/unclaim", requireAgentScope("task:write"), async (req, res) => {
  try {
    const { channel, task_number } = req.body;
    if (!channel || task_number == null) {
      refuse(res, 400, { code: "task_number_required", error: "An unclaim needs a channel and a task number: name the task's channel and its number." });
      return;
    }

    const ctx = await resolveAgentTaskChannel(req.params.id, req.serverId!, req.machineId, channel);
    if (!ctx) {
      refuse(res, 404, TASK_CHANNEL_NOT_FOUND_REFUSAL);
      return;
    }
    if (rejectAgentTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, req.params.id), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }

    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      refuse(res, 404, taskNotFoundRefusal(channel, task_number));
      return;
    }

    if (rejectHistoricalJointTaskWriteIfNeeded(ctx.surface, task.createdAt, res)) return;

    const result = await taskService.unclaimTask(task.id, "agent", req.params.id);
    if (typeof result === "string") {
      refuse(res, 409, taskUnclaimRefusal(result, channel, task.taskNumber ?? Number(task_number)));
      return;
    }

    const io: SocketServer = req.app.get("io");
    await emitTaskMutationToSurfaces(io, ctx.surface, result);

    // Task unclaim is a small-audience event — no chat-surface 🔓 system
    // message. (stdrc #proj-task msg=c580faed) Task v2: the "released" line
    // in the task conversation, as the agent API and the web write it.
    postAgentTaskLifecycleLine(req, task, ctx.localChannel, async () =>
      `🔓 ${ctx.agent.displayName || ctx.agent.name || "An agent"} released #${task.taskNumber} "${messageService.summarizeForSystemMessage(task.title)}"`);

    res.json({ ok: true });
    recordRaftCliActivity(req, req.params.id, {
      command: "task.unclaim",
      summary: `Unclaimed task #${task_number}`,
      target: channel,
      correlationId: task.id,
    });
  } catch (err) {
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to unclaim task",
      logPrefix: "Internal unclaim task error:",
      err,
    });
  }
});

// Agent updates task status
internalRouter.post("/agent/:id/tasks/update-status", requireAgentScope("task:write"), async (req, res) => {
  try {
    const { channel, task_number, status } = req.body;
    if (!channel || task_number == null || !status) {
      refuse(res, 400, { code: "task_status_required", error: "A status change needs a channel, a task number and the new status." });
      return;
    }
    // The pre-Agent-API route, for CLIs from before backlog: backlog and its
    // reason go through the Agent API route only, so here it stays invalid.
    if (!["todo", "in_progress", "in_review", "done", "closed"].includes(status)) {
      refuse(res, 400, { code: "invalid_status", error: "That isn't a status this request can set: use todo, in_progress, in_review, done or closed." });
      return;
    }

    const ctx = await resolveAgentTaskChannel(req.params.id, req.serverId!, req.machineId, channel);
    if (!ctx) {
      refuse(res, 404, TASK_CHANNEL_NOT_FOUND_REFUSAL);
      return;
    }
    if (rejectAgentTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, req.params.id), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }

    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      refuse(res, 404, taskNotFoundRefusal(channel, task_number));
      return;
    }

    if (rejectHistoricalJointTaskWriteIfNeeded(ctx.surface, task.createdAt, res)) return;

    const result = await taskService.updateTaskStatus(task.id, status, req.params.id, "agent", undefined, {
      initiatingServerId: ctx.localChannel.serverId,
    });
    if (typeof result === "string") {
      refuse(res, 409, taskStatusRefusal(result, channel, task.taskNumber ?? Number(task_number)));
      return;
    }
    // What was stored: a task v2 task asked for in_review stores in_progress.
    const storedStatus = result.row.status;

    const io: SocketServer = req.app.get("io");
    await emitTaskMutationToSurfaces(io, ctx.surface, result);

    // Task status transitions are small-audience lifecycle churn — no
    // chat-surface system message. (stdrc #proj-task msg=ef870d97 +
    // msg=b9b41129 + msg=c580faed). The current status is rendered on the
    // task card itself; assignee/creator/reviewer follow via task UI.
    // Task v2: the status line in the task conversation, as every path writes it
    // (none when nothing changed: in_review asked of a task v2 task already in_progress).
    if (!result.unchanged) {
      postAgentTaskLifecycleLine(req, task, ctx.localChannel, () => buildTaskStatusNotice({
        actor: { type: "agent", id: req.params.id },
        taskNumber: task.taskNumber,
        title: task.title,
        status: storedStatus,
      }));
    }

    res.json({ ok: true, status: storedStatus });
    recordRaftCliActivity(req, req.params.id, {
      command: "task.update_status",
      summary: `Updated task #${task_number} to ${storedStatus}`,
      target: channel,
      correlationId: task.id,
    });
  } catch (err) {
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to update task status",
      logPrefix: "Internal update-status task error:",
      err,
    });
  }
});


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
          refuse(res, 400, REMINDER_STATUS_FILTER_INVALID_REFUSAL);
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
    sendJsonServerError(req, res, {
      error: "Failed to list reminders",
      logPrefix: "Internal list reminders error:",
      err,
    });
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
    if (await refuseIfRemindersMovedToApp(res, result.agent.serverId)) return;

    const { title, fireAt, delaySeconds, msgId, payload, repeat, tz, channel } = req.body ?? {};
    if (typeof title !== "string" || title.trim().length === 0) {
      refuse(res, 400, REMINDER_TITLE_REQUIRED_REFUSAL);
      return;
    }
    if (title.length > REMINDER_MAX_TITLE_LEN) {
      refuse(res, 400, REMINDER_TITLE_TOO_LONG_REFUSAL);
      return;
    }

    // Snapshot the caller's IANA timezone into daily/weekly rules at create
    // time so later fires don't drift when the caller's host tz changes. If
    // the caller doesn't supply tz we fall back to UTC (safe for interval).
    let ruleTz = "UTC";
    if (tz !== undefined) {
      if (typeof tz !== "string" || tz.length === 0) {
        refuse(res, 400, REMINDER_TIMEZONE_INVALID_REFUSAL);
        return;
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
      } catch {
        refuse(res, 400, reminderTimezoneUnknownRefusal(tz));
        return;
      }
      ruleTz = tz;
    }

    let recurrence: Recurrence | null = null;
    if (repeat != null) {
      if (typeof repeat !== "string") {
        refuse(res, 400, REMINDER_REPEAT_INVALID_REFUSAL);
        return;
      }
      const parsed = parseRecurrenceString(repeat, ruleTz);
      if (!parsed.ok) {
        refuse(res, 400, reminderRepeatUnparsedRefusal(parsed.error));
        return;
      }
      // Wall-clock rules (daily, weekly) are ambiguous without an explicit
      // caller tz: silent UTC fallback would fire at wrong local times.
      // Force the caller to snapshot their tz so re-fires don't drift.
      if (
        (parsed.recurrence.rule.kind === "daily" || parsed.recurrence.rule.kind === "weekly") &&
        tz === undefined
      ) {
        refuse(res, 400, REMINDER_TIMEZONE_REQUIRED_REFUSAL);
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
        refuse(res, 400, reminderScheduleInvalidRefusal(schedule.error));
        return;
      }
      fireAtDate = schedule.fireAt;
      warning = schedule.warning;
    } else if (recurrence) {
      fireAtDate = computeNextFire(recurrence, new Date());
    } else {
      refuse(res, 400, REMINDER_SCHEDULE_REQUIRED_REFUSAL);
      return;
    }

    if (typeof msgId !== "string" || msgId.length === 0) {
      refuse(res, 400, REMINDER_MESSAGE_REQUIRED_REFUSAL);
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
        refuse(res, 400, REMINDER_CHANNEL_INVALID_REFUSAL);
        return;
      }
      const ctx = await resolveAgentChannel(req.params.id, req.serverId!, req.machineId, channel);
      if (!ctx) {
        refuse(res, 404, REMINDER_CHANNEL_NOT_FOUND_REFUSAL);
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

    // No chat-surface "🔔 X scheduled a reminder ..." system message — schedule
    // is a personal event for the owner agent (per stdrc #proj-task msg=c580faed).
    // Audit lives in `reminder_events` (recordReminderEvent runs inside
    // createReminder); humans observe via the agent's reminder tab.

    const [summary] = await reminderService.toReminderSummaries([row], req.serverId!);

    // Live UI updates — humans watching the agent profile's Reminders tab
    // should see new entries appear without reloading. Delivered only to
    // users who may inspect the owner agent's private surfaces.
    await publishReminderEvent(req.app.get("io"), row, { type: "reminder:scheduled", reminder: summary });

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
    sendJsonServerError(req, res, {
      error: "Failed to create reminder",
      logPrefix: "Internal create reminder error:",
      err,
    });
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
      refuse(res, 404, REMINDER_NOT_FOUND_REFUSAL);
      return;
    }
    if (existing.status === "migrated") {
      refuse(res, 409, reminderMigratedRefusal(existing.id));
      return;
    }
    if (existing.status !== "scheduled" && existing.status !== "fired") {
      refuse(res, 409, reminderNotCancelableRefusal(existing.status));
      return;
    }

    const canceled = await reminderCrud.cancelAppReminder(req.params.reminderId, {
      actor: { type: "agent", id: req.params.id },
      expectedVersion: existing.version,
    });
    if (!canceled) {
      refuse(res, 409, REMINDER_STATE_CONFLICT_REFUSAL);
      return;
    }
    await syncReminderToComputer(req, canceled, "cancel");

    const [summary] = await reminderService.toReminderSummaries([canceled], req.serverId!);

    // Live UI update — pair with reminder:scheduled so the Reminders tab
    // reflects cancellations in real time without manual refresh.
    await publishReminderEvent(req.app.get("io"), canceled, { type: "reminder:canceled" });

    res.json({ reminder: summary });
    recordRaftCliActivity(req, req.params.id, {
      command: "reminder.cancel",
      summary: "Canceled reminder",
      target: summary.msgRef ?? canceled.id,
      correlationId: canceled.id,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to cancel reminder",
      logPrefix: "Internal cancel reminder error:",
      err,
    });
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
    if (await refuseIfRemindersMovedToApp(res, result.agent.serverId)) return;

    const { delaySeconds } = req.body ?? {};
    const schedule = resolveScheduleInput({ delaySeconds }, Date.now());
    if (!schedule.ok) {
      refuse(res, 400, reminderScheduleInvalidRefusal(schedule.error));
      return;
    }

    const existing = await reminderCrud.getAppReminderById(req.params.reminderId);
    if (!existing || existing.serverId !== req.serverId || existing.ownerAgentId !== req.params.id) {
      refuse(res, 404, REMINDER_NOT_FOUND_REFUSAL);
      return;
    }
    if (existing.status === "migrated") {
      refuse(res, 409, reminderMigratedRefusal(existing.id));
      return;
    }
    if (existing.status !== "scheduled" && existing.status !== "fired") {
      refuse(res, 409, reminderNotSnoozableRefusal(existing.status));
      return;
    }

    const snoozed = await reminderCrud.snoozeAppReminder(existing.id, Number(delaySeconds), {
      actor: { type: "agent", id: req.params.id },
      expectedVersion: existing.version,
    });
    if (!snoozed) {
      refuse(res, 409, REMINDER_STATE_CONFLICT_REFUSAL);
      return;
    }
    await syncReminderToComputer(req, snoozed, "upsert");

    const [summary] = await reminderService.toReminderSummaries([snoozed], req.serverId!);
    await publishReminderEvent(req.app.get("io"), snoozed, { type: "reminder:scheduled", reminder: summary });
    res.json({ reminder: summary });
    recordRaftCliActivity(req, req.params.id, {
      command: "reminder.snooze",
      summary: "Snoozed reminder",
      target: summary.msgRef ?? snoozed.id,
      correlationId: snoozed.id,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to snooze reminder",
      logPrefix: "Internal snooze reminder error:",
      err,
    });
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
    if (await refuseIfRemindersMovedToApp(res, result.agent.serverId)) return;

    const existing = await reminderCrud.getAppReminderById(req.params.reminderId);
    if (!existing || existing.serverId !== req.serverId || existing.ownerAgentId !== req.params.id) {
      refuse(res, 404, REMINDER_NOT_FOUND_REFUSAL);
      return;
    }
    if (existing.status === "fired") {
      refuse(res, 409, REMINDER_FIRED_NOT_UPDATABLE_REFUSAL);
      return;
    }
    if (existing.status === "migrated") {
      refuse(res, 409, reminderMigratedRefusal(existing.id));
      return;
    }
    if (existing.status !== "scheduled") {
      refuse(res, 409, reminderNotUpdatableRefusal(existing.status));
      return;
    }

    const { fireAt, delaySeconds, repeat, title, tz } = req.body ?? {};
    const mutations = [
      fireAt != null || delaySeconds != null ? "time" : null,
      repeat != null ? "repeat" : null,
      title != null ? "title" : null,
    ].filter(Boolean);
    if (mutations.length !== 1) {
      refuse(res, 400, REMINDER_UPDATE_INVALID_REFUSAL);
      return;
    }

    let patch: reminderService.ReminderUpdatePatch;
    let warning: string | undefined;
    if (fireAt != null || delaySeconds != null) {
      const schedule = resolveScheduleInput({ fireAt, delaySeconds }, Date.now());
      if (!schedule.ok) {
        refuse(res, 400, reminderScheduleInvalidRefusal(schedule.error));
        return;
      }
      warning = schedule.warning;
      patch = fireAt != null
        ? { kind: "fireAt", fireAt: schedule.fireAt }
        : { kind: "delay", delaySeconds: Number(delaySeconds) };
    } else if (repeat != null) {
      if (typeof repeat !== "string") {
        refuse(res, 400, REMINDER_REPEAT_INVALID_REFUSAL);
        return;
      }
      let ruleTz = "UTC";
      if (tz !== undefined) {
        if (typeof tz !== "string" || tz.length === 0) {
          refuse(res, 400, REMINDER_TIMEZONE_INVALID_REFUSAL);
          return;
        }
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
        } catch {
          refuse(res, 400, reminderTimezoneUnknownRefusal(tz));
          return;
        }
        ruleTz = tz;
      }
      const parsed = parseRecurrenceString(repeat, ruleTz);
      if (!parsed.ok) {
        refuse(res, 400, reminderRepeatUnparsedRefusal(parsed.error));
        return;
      }
      if (
        (parsed.recurrence.rule.kind === "daily" || parsed.recurrence.rule.kind === "weekly") &&
        tz === undefined
      ) {
        refuse(res, 400, REMINDER_TIMEZONE_REQUIRED_REFUSAL);
        return;
      }
      patch = { kind: "recurrence", recurrence: parsed.recurrence };
    } else {
      if (typeof title !== "string" || title.trim().length === 0) {
        refuse(res, 400, REMINDER_TITLE_REQUIRED_REFUSAL);
        return;
      }
      if (title.length > REMINDER_MAX_TITLE_LEN) {
        refuse(res, 400, REMINDER_TITLE_TOO_LONG_REFUSAL);
        return;
      }
      patch = { kind: "title", title: title.trim() };
    }

    const updated = await reminderCrud.updateAppReminder(existing.id, patch, {
      actor: { type: "agent", id: req.params.id },
      expectedVersion: existing.version,
    });
    if (!updated) {
      refuse(res, 409, REMINDER_STATE_CONFLICT_REFUSAL);
      return;
    }
    await syncReminderToComputer(req, updated, "upsert");

    const [summary] = await reminderService.toReminderSummaries([updated], req.serverId!);
    await publishReminderEvent(req.app.get("io"), updated, { type: "reminder:scheduled", reminder: summary });
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
    sendJsonServerError(req, res, {
      error: "Failed to update reminder",
      logPrefix: "Internal update reminder error:",
      err,
    });
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
      refuse(res, 404, REMINDER_NOT_FOUND_REFUSAL);
      return;
    }

    const events = await reminderCrud.listAppReminderEvents(existing.id);
    // Older Computers parse the event enum strictly; `migrated` stays server-side.
    res.json({ events: reminderService.toReminderEventSummaries(events.filter((event) => event.eventType !== "migrated")) });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to read reminder log",
      logPrefix: "Internal reminder log error:",
      err,
    });
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
      refuse(res, 400, TARGET_REQUIRED_REFUSAL);
      return;
    }
    const actionType = typeof (body.action as { type?: unknown } | null | undefined)?.type === "string"
      ? (body.action as { type: string }).type
      : null;
    if (actionType !== null && actionCardsService.INTEGRATION_COMMAND_ACTION_TYPES.has(actionType)) {
      refuse(res, 400, ACTION_TYPE_NOT_PREPARABLE_REFUSAL);
      return;
    }
    const target = body.target.trim();
    const resolved = await resolveWritableAgentTarget(
      req.serverId!,
      req.params.id,
      target,
    );
    if (resolved === "forbidden" || resolved === "peer-not-found" || resolved === "self-dm") {
      const { status, refusal } = unwritableTargetRefusal(resolved, target);
      refuse(res, status, refusal);
      return;
    }
    if (rejectUnwritableTaskConversation(resolved, res)) return;
    if (!resolved) {
      const { status, refusal } = unwritableTargetRefusal(null, target);
      refuse(res, status, refusal);
      return;
    }

    const io = (req.app.get("io") ?? null) as Parameters<typeof actionCardsService.prepareActionCard>[0]["io"];
    const out = await actionCardsService.prepareActionCard({
      serverId: req.serverId!,
      requesterAgentId: req.params.id,
      targetChannelId: resolved.channelId,
      action: body.action as Parameters<typeof actionCardsService.prepareActionCard>[0]["action"],
      agentAuthored: true,
      io: io ?? null,
    });
    res.status(out.existing ? 200 : 201).json({ messageId: out.messageId, metadata: withoutAgentHiddenActionCardSpec(out.metadata), ...(out.existing ? { existing: true } : {}) });
    recordRaftCliActivity(req, req.params.id, {
      command: "action.prepare",
      summary: out.existing ? "Action card already posted" : "Prepared action card",
      target: body.target.trim(),
      correlationId: out.messageId,
    });
  } catch (err) {
    if (err instanceof actionCardsService.ActionCardError) {
      res.status(err.status).json({
        error: err.message,
        errorCode: err.code,
        ...(err.suggestedNextAction ? { suggestedNextAction: err.suggestedNextAction } : {}),
      });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to prepare action card",
      logPrefix: "Internal prepare-action error:",
      err,
    });
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
      refuse(res, 404, { code: "agent_not_found", error: "This agent no longer exists, so it has no scopes to read." });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to load agent scopes",
      logPrefix: "Internal agent scopes error:",
      err,
    });
  }
});
