import { AGENT_LOUNGE_OUTSIDER_REFUSAL, isLoungeOutsiderAgent } from "../services/agentLoungeService";
import { wakeForEventsMergedSinceHandover } from "../services/appItemWakeCoalescing";
import { renderAgentFacingContents } from "../services/agentFacingContent";
import { JointChannelAccessChangedError } from "../lib/channelActorPermissions";
import { DmPeerNotMemberError } from "../services/dmSendPolicy";
import { AGENT_CONTEXT_READ_DEFAULT_LIMIT, AGENT_CONTEXT_SEARCH_DEFAULT_LIMIT, CONTINUATIONS_DRAFT_FLOW_RUNTIMES, CONTINUATIONS_PILOT_FEATURE_FLAG_KEY, RAFT_CLIENT_VERSION_HEADER, raftbenchFindingsQuerySchema, type AgentContextQuery } from "@botiverse/raft-shared";
import { hasRaftbenchReaderGrant, readFindings } from "../raftbench/readers";
import { AGENT_GATED_WRITES, agentTaskWriteKey, agentWriteTaskNumber, agentTaskThreadTarget, formatAgentTaskCommandHint, type AgentGatedTaskWriteAction, formatAgentTaskRef, formatAgentTaskRefTail, formatHint, isSubConversationType, parseAgentTaskRef, RAFT_HINTS, TASK_TARGET_USE_TASK_COMMAND_ERROR_CODE, type AgentApiHistoryQuery } from "@botiverse/raft-shared";
import { AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS, raftbenchContextQuerySchema, raftbenchReportSchema } from "@botiverse/raft-shared";
import { checkTaskAssignReason, checkTaskCreateStatus, checkTaskStatusReason, isTaskCreateStatus, TASK_ASSIGN_REASON_REQUIRED, TASK_ASSIGN_REASON_REQUIRED_MESSAGE, TASK_ASSIGN_REASON_UNCHANGED, TASK_ASSIGN_REASON_UNCHANGED_MESSAGE } from "@botiverse/raft-shared";
import { readContext as readRaftbenchContext, submitReport as submitRaftbenchReport, RaftbenchError } from "../raftbench/service";
import { getAppInstallationSetup } from "../services/appSetupService";
import { issueAgentAudienceJwt, AgentAudienceJwtError } from "../services/agentAudienceJwtService";
import { respondToTaskWriteError } from "../lib/taskWriteErrorResponse";
import { sharedSseStreamRegistry } from "../services/sseStreamRegistry";
import { isReadMutationFenceRefusal } from "../services/readMutationSequencer";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { REMINDER_MIGRATED, refuseIfRemindersMovedToApp, reminderMigratedRefusal } from "./reminderAppRollout";
import {
  agentEventsRetryAfterMs,
  parseAgentEventsWaitAttempt,
  parseAgentEventsWaitFor,
  unsatisfiedAfterPull,
  waitForAgentInboxChain,
  type AgentEventsWaitPair,
  type AgentEventsWaitResult,
} from "./agentEventsWaitFor";
import { evaluateFeatureFlag, evaluateFeatureFlags, REMINDER_APP_FEATURE_FLAG_KEY, VAULT_APP_FEATURE_FLAG_KEY } from "../services/featureFlagService";
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
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, not, or, sql } from "drizzle-orm";
import {
  AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE,
  AGENT_API_ATTACHMENT_DOWNLOAD_URL_TTL_SECONDS,
  AGENT_API_USER_CHANNELS_DEFAULT_LIMIT,
  AGENT_API_USER_NOT_FOUND_CODE,
  AGENT_API_ATTACHMENT_DOWNLOAD_URL_UNAVAILABLE_RESPONSE,
  ATTENTION_HINT_COPY_VERSION,
  ATTENTION_HINT_SCHEMA,
  DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY,
  EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
  AGENT_TURN_ENDED_MAX_SHOWN_TARGETS,
  AGENT_TURN_ENDED_OUTCOMES,
  type AgentTurnEndedOutcome,
  type ExternalAgentTurnEnded,
  type TraceAttributes,
  RAFT_AGENT_STATUS_DETAIL_LIMIT,
  RAFT_AGENT_STATUS_VALUES,
  RAFT_CLIENT_CAPABILITIES_HEADER,
  hasInboxItemsCapability,
  buildApmFreshnessDecisionProducerFactId,
  agentApiContract,
  getAgentApiResponseKind,
  type AgentApiAttachmentCommentsResponse,
  type AgentApiFeedbackLocatorListQuery,
  type AgentApiContractRoute,
  type AgentApiHeldFreshnessResponse,
  type AgentApiTaskWriteUnseen,
  type AgentApiMessageEnvelope,
  type AgentApiRequestBodyByRoute,
  type AgentApiRequestParamsByRoute,
  type AgentApiRequestQueryByRoute,
  type AgentScope,
  type AgentApiResponseByRoute,
  asServerId,
  type AgentApiRouteKey,
  buildRaftCliGuideMarkdown,
  guideAppsForClient,
  formatInboxMessageTarget,
  isExternalAgentActivityLegacyStatus,
  isExternalAgentRuntime,
  isRaftAgentStatus,
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
  type ApmFreshnessSideEffectAction,
  type ExternalAgentActivityEvent,
  type ExternalAgentActivityIngestRequest,
  isTaskStatus,
  renderThirdPartyInertText,
  isSlackBridgedExternalProvider,
  type ActionCardAction,
  type ReminderStatus,
  type ServerId,
  type TaskStatus,
  failpoints,
  AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT,
  AGENT_API_MESSAGE_SEARCH_MAX_LIMIT,
  AGENT_API_INBOX_DEFAULT_LIMIT,
  AGENT_API_INBOX_MAX_LIMIT,
  type AgentApiInboxListQuery,
  type AgentApiInboxListResponse,
  type AgentApiHistoryResponse,
  AGENT_API_ASSISTANT_INBOX_DEFAULT_LIMIT,
  AGENT_API_ASSISTANT_INBOX_MAX_LIMIT,
  AGENT_API_ASSISTANT_MESSAGES_DEFAULT_LIMIT,
  AGENT_API_ASSISTANT_MESSAGES_MAX_LIMIT,
  type AgentApiAssistantOwnerInboxQuery,
  type AgentApiAssistantOwnerMessagesQuery,
  type AgentApiAssistantOwnerArtifactQuery,
  type AgentApiAssistantOwnerArtifactPublishBody,
  type AgentApiAssistantSendAsOwnerBody,
  type AgentApiAssistantForwardAsOwnerBody,
  type AgentApiAssistantSearchForwardTargetsQuery,
  type AgentApiAssistantOwnerActivityQuery,
  type AgentApiAssistantOwnerResolveQuery,
  THIRD_PARTY_EVENT_DELIVERED_REPORT_MAX_IDS,
  isThirdPartyEventId,
  buildIntegrationInviteUrl,
  channelCardRev,
  peerCardHasContent,
  type AgentApiChannelCard,
  type AgentApiPeerCard,
  type Tracer,
  AGENT_API_RATE_LIMITED_CODE,
} from "@botiverse/raft-shared";
import type { AgentApiRateLimitedBody } from "@botiverse/raft-shared";
import * as agentService from "../services/agentService";
import { recordExternalTurnEndSnapshot, takeExternalTurnEndSnapshot } from "../services/externalTurnEndSnapshot";
import { isAssistantWeChatActive, recordAssistantTurnTriggers } from "../services/wechatTurn";
import { markWeChatMirrorInTransaction } from "../services/wechatMirrorDecision";
import { recordIntegrationAuditEvent, recordIntegrationAuditEventBestEffort } from "../services/integrationAuditService";
import { shownSnapshotTargets } from "../services/turnEndUnreadSnapshot";
import { settleUnowedReadBacklog } from "../services/unowedReadBacklog";
import * as assistantService from "../services/assistantService";
import { listOwnerInboxPage } from "../services/assistantCheckService";
import * as assistantContactRulesService from "../services/assistantContactRulesService";
import * as assistantOwnerSettingsService from "../services/assistantOwnerSettingsService";
import * as assistantNotifyService from "../services/assistantNotifyService";
import * as assistantSendAsOwnerService from "../services/assistantSendAsOwnerService";
import * as assistantForwardAsOwnerService from "../services/assistantForwardAsOwnerService";
import { assistantReachesApp } from "../services/assistantRouteAllowlist";
import { publishOwnerArtifact, readOwnerArtifact } from "../services/assistantOwnerArtifacts";
import { ASSISTANT_INTEGRATION_NOT_ALLOWED_BODY } from "../services/assistantIntegrations";
import { resolveReadableAttachmentAuthorityContext } from "../services/attachmentAuthorityService";
import {
  type AttachmentObjectMetadata,
  type ResolvedAttachment,
  withAttachmentObjectMetadata,
} from "../services/attachmentRecord";
import * as actionCardsService from "../services/actionCardsService";
import { messageWithoutAgentHiddenActionCardSpec, withoutAgentHiddenActionCardSpec } from "../services/actionCardPresentation";
import * as idempotentAgentApiService from "../services/agentApiIdempotencyService";
import * as attachmentCommentService from "../services/attachmentCommentService";
import { renderAgentCommentScopedContent } from "../services/attachmentCommentAnchorLabel";
import * as channelService from "../services/channelService";
import { agentRefusalBody } from "../lib/agentServerRoleRequired";
import { readPositionSettleMs, scheduleDeferredReadAdvance, settledReadThroughSeq } from "../services/readPositionSettle";
import { commitAgentInboxLatePending, recordAgentInboxAck, recordAgentInboxLatePending } from "../services/agentInboxLateRows";

/** Rows the deferred read-advance check scans in (fromSeq, toSeq]; a history page is at most 100. */
const DEFERRED_READ_ADVANCE_SCAN_LIMIT = 500;
import { CHANNEL_NOT_FOUND_BODY } from "./channelAccessDenial";
import * as messageService from "../services/messageService";
import { AgentContextQueryRateLimiter, handleAgentContextQuery } from "../services/agentContextQueryApi";
import {
  agentMessageCardField,
  admitMessageCardUpdate,
  applyMessageCardUpdate,
  findCommittedMessageCardUpdate,
  MESSAGE_CARD_NOT_FOUND_BODY,
  prepareMessageCardSend,
  prepareMessageCardUpdate,
  withinMessageCardUpdateWindow,
  type MessageCardRefusal,
  type MessageCardSend,
} from "../services/messageCardService";
import { isMessageCardMetadata, MESSAGE_CARD_ERROR_CODES, type MessageCard } from "@botiverse/raft-shared";
import {
  loadCanonicalTaskFactsByMessageId,
  refreshQueuedAgentTaskProjections,
  withAgentSourceTasks,
} from "../services/messageTaskProjection";
import * as mentionDeliveryOccurrenceService from "../services/mentionDeliveryOccurrenceService";
import { projectMentionDeliveryForSender } from "../services/senderMentionDeliveryProjection";
import * as searchService from "../services/searchService";
import { resolveSearchSenderFilter } from "../services/searchSenderFilterService";
import * as serverService from "../services/serverService";
import * as machineService from "../services/machineService";
import * as agentScopesService from "../services/agentScopesService";
import * as oauthService from "../services/oauthService";
import { resolveAgentFacingPromptText } from "../services/appPromptTextService";
import * as integrationAppQueryService from "../services/integrationAppQueryService";
import * as reminderCrud from "../apps/reminder/crud";
import * as reminderService from "../apps/reminder/service";
import {
  ackBuiltInAppSource,
  publishTaskResourceExpiryFollowup,
  taskResourceExpiryFollowups,
} from "../registry.manifest";
import { publishReminderEvent } from "../apps/reminder/realtime";
import {
  getRapAppConfig,
  patchRapAppConfig,
  RapAppConfigError,
} from "../services/rapAppConfigService";
import { pushBuiltInAppConfigForOwner } from "../services/appConfigTransportComposition";
import * as taskService from "../services/taskService";
import { resolveAgentTaskSurfaces } from "../services/agentAssignedTaskSurfaces";
import { computeIdleTaskReminder } from "../services/idleTaskReminderService";
import { canView } from "../services/visibilityService";
import {
  getTaskRealtimeSurfaceTargets,
  resolveTaskChannelSurface,
  isHistoricalJointTaskReadOnly,
  isTaskConversationReadOnly,
  type TaskChannelSurface,
  type TaskSurfaceChannel,
} from "../services/taskChannelSurface";
import { emitTaskCreated, emitTaskDeleted, emitTaskMessageNew } from "../services/taskRealtimeEvents";
import { isTaskV2ConversationsEnabled, isTaskV2ConversationsEnabledForChannel, readTaskV2ConversationsEnabled, INVALID_TASK_SOURCE_STEP, taskSourceRequiredRefusal } from "../services/taskConversationsGate";
import { isV2Task, pendingTaskConversationFollowReason, taskUsesOwnConversation, type TaskModeFields } from "../services/taskV2Mode";
import {
  describeTaskMutation,
  emitTaskMutationToSurfaces,
  ensureTaskConversationAndBroadcast,
  withTaskConversationEnsured,
} from "../services/taskMutationBroadcast";
import { mutateMessageReaction } from "../services/messageReactionService";
import { withAgentMessageReactions } from "../services/agentMessageReactions";
import { ChannelConversionInProgressError } from "../services/channelConversionFenceService";
import { getHistoryCutoff, getServerPlan, channelBillingReadOnlyRefusal, getChannelBillingReadOnly, isChannelReadOnlyByBillingFeature, isChannelReadOnlyByQuota } from "../services/planService";
import { agentSearchUpgradeCardHint, agentUpgradeCardHint } from "../services/agentUpgradeCardService";
import { noteAgentHistoryBlock } from "../services/agentHistoryBlocks";
import { agentHistoryLimitedRefusal, agentHistoryLimitNote, agentSearchHistoryLimitNote, getServerHistoryWindowForRead, isAttachmentBehindWindow, isBehindHistoryWindow, lastSeqBehindWindow } from "../services/historyWindow";
import type { HistoryWindow } from "../services/historyWindow";
import { resolveMessageResourceAccess } from "../services/messageResourceAccess";
import { emitProjectedMessageUpdate, projectUpdatedMessageForLocalChannel } from "./messages";
import { resolveCardMessageForSender } from "../services/messageCardConversation";
import { getAttachmentFileSizeLimitBytes, getLegacyAttachmentFileSizeLimitBytes } from "../services/attachmentUploadPolicy";
import { attachmentUploadCapabilitiesSchema } from "@botiverse/raft-shared/src/attachmentUploadContract";
import { uploadAttachmentBuffers } from "../services/attachmentUploadWriterService";
import type { AttachmentUploadSessionService } from "./attachmentUploadSessions";
import { resolveScheduleInput } from "../services/reminderScheduleInput";
import { computeNextFire, parseRecurrenceString, type Recurrence } from "../services/recurrence";
import * as agentPermalinkRenderService from "../services/agentPermalinkRenderService";
import {
  acknowledgeAgentInboxEventsCursor,
  canAgentAccessQueuedMessageTarget,
  normalizeAgentApiWireValue,
  partitionDeliverableInboxMessages,
  projectAgentInboxEvents,
  recordAgentInboxEventsPendingAck,
} from "../services/agentInboxEvents";
import {
  AgentInboxPushError,
  deleteAgentInboxPushRegistration,
  getAgentInboxPushStatus,
  putAgentInboxPushRegistration,
} from "../services/agentInboxPushService";
import * as attestedSendService from "../services/attestedSendService";
import { emitScopeReadUpdated } from "../services/readReceiptService";
import { emitThreadFollowersUpdated } from "../services/threadFollowerRealtimeService";
import { noteAgentChannelMuteChanged } from "../services/agentReadProgressService";
import { listTaskConversationsByParentChannel, resolveLocalTaskConversationId } from "../services/taskConversationService";
import { paginateHistoryProbe } from "./historyCursor";
import {
  buildServerInfoAgentSummaries,
  buildServerInfoHumanSummaries,
  findServerInfoAgentSummaryByName,
  findServerInfoHumanSummaryByName,
  buildAgentProfileView,
  filterAgentVisibleHumansForHiddenDirectory,
  resolveAgentVisibleMessagePayload,
  resolveProfileViewForAgent,
} from "./internal";
import { getDb, type DatabaseExecutor } from "../db/index";
import { managedMcpAgentErrorMessage } from "./managedMcpAgentErrors";
import { formatManagedMcpPromptName, MCP_CALL_INTERNAL_ERROR_TEXT } from "@botiverse/raft-shared";
import {
  agents,
  appBotBindings,
  oauthClientInstalls,
  attachments,
  channelAgents,
  channels,
  jointChannels,
  jointChannelServers,
  managedMcpServers,
  raftbenchConfigs,
  messageMentions,
  messages,
  threadFollows,
  users,
} from "../db/schema";
import { messageIdShortPrefixConditions, UUID_RE } from "../lib/messageId";
import { guardUuidPathParams } from "../lib/uuidPathParams";
import { refuse, RefusalError, sentenceQuoting, type RefusalInput, type RefusalStatus } from "../lib/refusal";
import {
  AGENT_CHANNEL_NOT_FOUND_REFUSAL,
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
  TASK_STATE_CONFLICT_ERROR,
  taskNotFoundRefusal,
  taskStatusRefusal,
  taskUnclaimRefusal,
  THREAD_NOT_FOUND_REFUSAL,
  THREAD_NOT_JOINABLE_REFUSAL,
  TOO_MANY_TASKS_REFUSAL,
  agentProfileUpdateFields,
  AGENT_GONE_REFUSAL,
  AGENT_JWT_NOT_AUTHORIZED_REFUSAL,
  AGENT_SERVER_GONE_REFUSAL,
  agentLoginScopeRefusal,
  APP_BOT_AVATAR_MANAGED_REFUSAL,
  APP_CARD_TARGET_REQUIRED_REFUSAL,
  APP_CATEGORY_INVALID_REFUSAL,
  APP_NAME_REQUIRED_REFUSAL,
  APP_RETURN_URL_REQUIRED_REFUSAL,
  APP_SCOPE_UNKNOWN_REFUSAL,
  APP_UPDATE_CARD_DISABLED_REFUSAL,
  AVATAR_BAD_FORMAT_REFUSAL,
  AVATAR_FILE_REQUIRED_REFUSAL,
  AVATAR_TOO_LARGE_REFUSAL,
  DESCRIPTION_HUMAN_ONLY_REFUSAL,
  SERVER_GONE_FOR_AVATAR_REFUSAL,
  installationSuspendedRefusal,
  MARKETPLACE_LIMIT_INVALID_REFUSAL,
  targetNotFoundRefusal,
  unwritableTargetRefusal,
  UPLOAD_CHANNEL_REQUIRED_REFUSAL,
  UPLOAD_FILE_EMPTY_REFUSAL,
  UPLOAD_FILE_REQUIRED_REFUSAL,
  UPLOAD_MEMBERSHIP_REQUIRED_REFUSAL,
  APP_CLIENT_KEY_REQUIRED_REFUSAL,
  APP_NOT_FOUND_REFUSAL,
  appManageAuthorityRefusal,
  APP_TRANSFER_FIELDS_REQUIRED_REFUSAL,
  appTransferTargetNotFoundRefusal,
  APP_UPDATE_NO_FIELDS_REFUSAL,
  APP_RETURN_URL_EMPTY_REFUSAL,
  shareLinkTargetNotApplicableRefusal,
  SHARE_LINK_TARGET_INVALID_REFUSAL,
  SHARE_LINK_TARGET_REQUIRED_REFUSAL,
  SHARE_LINK_UNAVAILABLE_REFUSAL,
  SHARE_LINK_NOT_FOUND_REFUSAL,
  PUBLISH_REQUEST_UNAVAILABLE_REFUSAL,
  APP_NOT_PUBLISHED_REFUSAL,
  APP_PUBLISHED_NOT_DELETABLE_REFUSAL,
  LOGO_FILE_REQUIRED_REFUSAL,
  APP_LOGO_TOO_LARGE_REFUSAL,
  APP_LOGO_BAD_FORMAT_REFUSAL,
  APP_STATUS_LOOKUP_INVALID_REFUSAL,
  agentProfileFenceRefusal,
  APP_NOT_FOUND_BY_CARD_REFUSAL,
  APP_REVIEW_DESCRIPTION_MESSAGE,
  APP_REVIEW_DESCRIPTION_REQUIRED_REFUSAL,
  ACTION_TYPE_NOT_PREPARABLE_REFUSAL,
  agentLoginNotFoundRefusal,
  appMetadataInvalidRefusal,
  appRegistrationScopeRefusal,
  MESSAGE_NOT_FOUND_REFUSAL,
  messageResolveRefusal,
  serviceMessageRefusal,
  SINCE_SEQ_INVALID_REFUSAL,
  SINCE_TIME_INVALID_REFUSAL,
  taskAssignRefusal,
  threadAnchorNotFoundRefusal,
} from "./agentRouteRefusals";
import { consumeReadAgentEvent, handleInboxDismiss, handleInboxRead, inboxItemsListFields, type ServeConversationReadSink, isAssistantRequest as isAssistantInboxRequest, refuseInboxItemsDisabled, reminderItemsDeclared } from "./agentInboxItemsRoutes";
import { inboxItemsEnabled, withinPageBudget } from "../services/agentInboxItems";
import {
  isThreadTarget,
  parseAppSubjectDmTarget,
  rejectUnwritableTaskConversation,
  resolveAgentTaskRefConversation,
  resolveWritableAgentTarget,
  taskRefOfMessageTarget,
} from "./agentWritableTarget";
import { isDurableAgentInboxMessage, type AgentOrchestrator } from "../services/agentOrchestrator";
import type { Server as SocketServer } from "socket.io";
import { announceTaskClaim, announceTaskCreationAssignment, announceTasksCreatedFromSourceMessages, buildTaskAmendNotice, buildTaskAssignmentNotice, buildTaskStatusNotice, postTaskConversationNotice, publishTaskResourceReceiptLine } from "../services/taskConversationNotice";
import { taskV2ClaimByMessageRefusal, taskV2ConvertRefusal } from "../services/taskV2UseCreate";
import type { AgentCapability } from "../services/agentCredentialService";
import { getCdnStorage, getStorage, isStorageTimeoutError } from "../services/storageService";
import { streamStorageResponse } from "../services/storageResponseStream";
import {
  attachmentTooLargeRefusal,
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
} from "./attachments";
import { addTraceEvent, errorClassOf, getCurrentTraceSpan, recordTraceEvent, tracePhase, withTraceChildSpan, withTraceRoot } from "../tracing/semanticTrace";
import { agentRequestContextFromHeaders, recordAgentContextReturned } from "../tracing/agentContextReturnTrace";
import { agentIdHashAttrs, serverIdHashAttrs } from "../tracing/traceIdentity";
import { cardEvaluatedAttrs } from "../tracing/agentCardTrace";
import { traceSendRouteFailure, traceSendRouteCatch } from "../tracing/sendRouteFailure";
import { traceQuerySpan } from "../tracing/queryTrace";
import { handleAgentKnowledgeGet, handleAgentKnowledgeSearch } from "./agentKnowledge";
import { AttachmentLinkError } from "../services/attachmentLinkingService";
import { bindRequestAbortSignal } from "./requestAbortSignal";
import { broadcastAgentUpdated } from "./agentUpdatedBroadcast";
import { announceRemovedAppBots } from "./appBotRemovalBroadcast";
import { createChannelForAgent } from "./agentChannelCreate";
import { addChannelMemberForAgent, lastMemberRefusal, removeChannelMemberForAgent, removeUnlessLastMember } from "./agentChannelMembers";
import { setChannelArchivedForAgent } from "./agentChannelLifecycle";
import { updateChannelForAgent } from "./agentChannelUpdate";
import { resolveChannelAnnouncementsOf, withChannelAnnouncement } from "../services/channelAnnouncements";
import { agentServerProfileAudit, assertAgentCanManageServerProfile, updateServerProfileForAgent } from "./agentServerManage";
import { respondToDmTargetResolutionError, sendJsonServerError, transientSendConflictBody } from "./errorResponse";
import { handleAgentMigrationRetry } from "./agentMigrationRetryRoute";
import { DmTargetResolutionError } from "../services/dmTargetResolutionError";
import { transientTransactionSqlState } from "../db/transientTransactionRetry";
import {
  createAvatarUpload,
  PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
  runSingleAvatarUpload,
  storeAgentAvatar,
  storeServerAvatar,
} from "../services/avatarService";
import {
  FILE_UPLOAD_QUOTA_EXCEEDED_MESSAGE,
  FileUploadQuotaExceededError,
  getFileUploadQuotaSummary,
  type FileUploadQuotaExceededResponse,
} from "../services/fileUploadQuotaService";
import { agentFileUploadQuotaExceededResponse, agentUploadUpgradeHint } from "../services/agentUploadUpgradeHint";
import { noteAppPaywallHit } from "./paywallHit";
import {
  buildPendingMentionActionPayload,
  executeMentionActionId,
  listPendingMentionActionsForSender,
  type MentionActionExecutionOptions,
  type MentionActionKind,
  type MentionActionResult,
} from "../services/mentionActionService";
import { actorHasServerCapabilityInServer, getActorServerRoleInServer, getAgentServerRolesInServer } from "../lib/actorPermissions";
import { getAppUrl } from "../config/appUrl";
import { firstPartyApps } from "../apps/firstPartyApps";
import { enabledFirstPartyAppIds } from "../services/firstPartyAppFlags";
import type { AgentApiCall, AgentApiMount, AppAgentClient, AppClientRefusal, AppError, FirstPartyApp } from "../platform/apps";
import { appNoticeOutbox } from "../services/firstPartyAppHost";
import {
  getAgentServerLabs,
  patchAgentServerLabsAccess,
  putAgentServerLabEnrollment,
} from "./serverLabs";
import { produceMcpConnectionCard } from "../services/managedMcpConnectionCardService";
import {
  executeManagedMcpCall,
  getManagedMcpRuntimeSnapshot,
  ManagedMcpServiceError,
} from "../services/managedMcpService";
import { ManagedMcpCredentialError } from "../services/managedMcpCredentialService";
import {
  findMcpAppForService,
  listAgentMcpAppsForIntegrationInventory,
  mcpAppLoginMessage,
  mcpAppNeedsRequest,
} from "../services/managedMcpIntegrationInventory";
import { recordAgentApiSeen } from "../services/externalAgentPresence";
import { agentCredentialStreamState, revokeAgentCredentialWithOutcome, SELF_REVOKED_REASON } from "../services/agentCredentialService";
import { broadcastAgentCredentialRevocation } from "../replicaRouter";
import { subscribeAgentCredentialRevocation } from "../services/agentCredentialRevocationBus";
import { ManagedMcpGatewayError } from "../services/managedMcpGateway";
import { ManagedMcpOAuthError } from "../services/managedMcpOAuthService";
import { getHostedRuntimeSummary } from "../services/agentRuntimeProvisionService";
import { requestTraceErrorCode, setRequestTraceActionType, setRequestTraceErrorCode, setRequestTraceRateLimiter } from "../middleware/requestObservability";
import {
  FeedbackLocatorIngestError,
  ingestFeedbackLocator,
  queryFeedbackLocators,
} from "../services/productFeedbackLocatorService";
import { parseOffsetQueryParam } from "../lib/offsetQueryParam";
import { admitAgentApiWrite, agentApiWriteBudgetNoun, AGENT_API_WRITE_WINDOW_SECONDS, type AgentApiWriteBudgetClass } from "../services/agentApiWriteLimits";
import { assistantAllowedOAuthClientUuid, resolveAgentLoginClient } from "../services/oauthClientKeys";

export const internalAgentApiRouter: RouterType = Router();

// Uniform 404 for non-UUID path params (task #12). `labKey` is excluded
// (string key, not a UUID). `messageId`/`attachmentId` are deliberately NOT
// guarded here: those routes cloak unknown AND malformed ids behind the same
// contract bodies (ATTACHMENT_UNAVAILABLE / {status:"NOT_JOINABLE"}) so a
// malformed id is indistinguishable from a foreign one — guarding would leak
// the difference (internalAgentApi.auth/senderMentionDeliveries tests).
guardUuidPathParams(internalAgentApiRouter, {
  channelId: "Channel",
});

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
    console.warn(`[reminder] Computer sync failed for ${row.id}@${row.version}:`, serializeErrorForLog(error));
  }
}

const MAX_REACTION_LENGTH = 16;
const ATTESTED_SEND_HELD_CONTEXT_LIMIT = 3;
const profileAvatarUpload = createAvatarUpload();
const serverAvatarUpload = createAvatarUpload();
const integrationLogoUpload = createAvatarUpload();

function getFullUuidParam(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return UUID_RE.test(raw) ? raw : null;
}

function sendAttachmentNotFound(res: Response): void {
  // The same body the attachment comment service answers for an attachment it
  // can't find (attachmentCommentService.ts), so a malformed id reads the same.
  refuse(res, 404, { code: "attachment_not_found", error: "Attachment not found" });
}

function sendAttachmentDownloadUnavailable(res: Response): void {
  // refusal-ok: shared contract body; its `error` carries the command too, for older CLIs that print only `error` (agentApiContract.ts)
  res.status(404).json(AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE);
}

/**
 * After a handover: an item's events merged since its pushed one get the
 * item's one push (wakeForEventsMergedSinceHandover). Never fails the
 * handover report: the agent got what it was handed.
 */
async function wakeForMergedSinceHandover(agentOrchestrator: AgentOrchestrator | undefined, agentId: string, eventIds: readonly string[]): Promise<void> {
  try {
    await wakeForEventsMergedSinceHandover(agentOrchestrator, agentId, eventIds);
  } catch (err) {
    console.warn(`[AppItemWake] merged events of agent ${agentId} not pushed after a handover`, serializeErrorForLog(err));
  }
}

function thirdPartyEventIdFromMessage(message: AgentMessage): string | null {
  const eventId = message.third_party_event?.id;
  if (typeof eventId === "string" && eventId.length > 0) return eventId;
  if (message.sender_type !== "third_party_app") return null;
  const messageId = (message as { message_id?: unknown }).message_id;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : null;
}

/** Returns the ids of the events it put in the buffer (already through their delivery guard). */
async function rebuildPendingThirdPartyAgentEvents(
  agentOrchestrator: AgentOrchestrator,
  agentId: string,
): Promise<Set<string>> {
  const pendingEventIds = agentOrchestrator.peekPendingMessages(agentId)
    .map(thirdPartyEventIdFromMessage)
    .filter((id): id is string => id !== null);
  const rebuilt = await oauthService.rebuildPendingThirdPartyAgentEventMessages({
    agentId,
    excludeEventIds: pendingEventIds,
  });
  const serviceOnly = await agentService.isRaftBenchServiceAgent(agentId);
  const buffered = new Set<string>();
  for (const message of rebuilt) {
    if (serviceOnly && message.third_party_event?.client_id !== "system.raftbench") continue;
    agentOrchestrator.deliverToLocalInbox(agentId, message, { notifyPendingReceive: false });
    if (message.third_party_event?.id) buffered.add(message.third_party_event.id);
  }
  return buffered;
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
    // refusal-ok: `issues` names the field that is wrong, the only detail behind this generic sentence; the envelope has `details` only for listed codes
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

function sendAgentApiResponse<K extends AgentApiRouteKey>(
  routeKey: K,
  res: Response,
  body: AgentApiResponseByRoute[K],
): void {
  prepareAgentApiResponse(routeKey, res, body)?.();
}

/**
 * The response checked against its contract but not sent yet: the returned
 * function sends it. Null when the body breaks the contract; the 500 is then
 * already answered. A read that consumes what it returns (a read position, an
 * app event) checks first, consumes, then sends, so a response that cannot be
 * sent leaves everything unread.
 */
function prepareAgentApiResponse<K extends AgentApiRouteKey>(
  routeKey: K,
  res: Response,
  body: AgentApiResponseByRoute[K],
): (() => void) | null {
  const route: AgentApiContractRoute = agentApiContract[routeKey];
  if (getAgentApiResponseKind(route.response) === "binary") {
    console.error(`internal.agent-api.${route.key} binary route attempted JSON response helper`);
    res.status(500).json({ error: "Agent API response contract violation" });
    return null;
  }
  if (!("body" in route.response)) {
    console.error(`internal.agent-api.${route.key} JSON response route is missing a body schema`);
    res.status(500).json({ error: "Agent API response contract violation" });
    return null;
  }
  let data: unknown;
  try {
    const parsed = route.response.body.safeParse(normalizeAgentApiWireValue(body));
    if (!parsed.success) {
      console.error(`internal.agent-api.${route.key} response contract violation:`, parsed.error.flatten());
      res.status(500).json({ error: "Agent API response contract violation" });
      return null;
    }
    data = parsed.data;
  } catch (err) {
    // A schema that throws instead of reporting issues (zod's "Unmergable intersection").
    console.error(`internal.agent-api.${route.key} response contract check threw:`, serializeErrorForLog(err));
    res.status(500).json({ error: "Agent API response contract violation" });
    return null;
  }
  return () => {
    res.json(data);
  };
}

/**
 * Idempotency scope for a keyed write, or null when the request carries no
 * usable key (behaviour then is unchanged: every request writes).
 */
function agentApiIdempotencyScope(
  agentId: string,
  route: idempotentAgentApiService.AgentApiIdempotentRoute,
  rawKey: unknown,
  normalizedRequest: unknown,
): idempotentAgentApiService.AgentApiIdempotencyScope | null {
  const idempotencyKey = idempotentAgentApiService.normalizeAgentApiIdempotencyKey(rawKey);
  if (!idempotencyKey) return null;
  return {
    agentId,
    route,
    idempotencyKey,
    requestFingerprint: idempotentAgentApiService.fingerprintAgentApiRequest(route, normalizedRequest),
  };
}

/**
 * Answer a keyed write from its ledger: the first response (status and body)
 * when the key is bound to this same request, without any side effect.
 * Returns false when the key is unused. A key bound to a different request
 * throws AgentApiIdempotencyConflictError (see respondToAgentApiIdempotencyConflict).
 */
async function replayAgentApiIdempotentWrite(
  scope: idempotentAgentApiService.AgentApiIdempotencyScope,
  res: Response,
): Promise<boolean> {
  const stored = await idempotentAgentApiService.findAgentApiIdempotentResponse(scope);
  if (!stored) return false;
  res.status(stored.status);
  sendAgentApiResponse(scope.route, res, stored.body as AgentApiResponseByRoute[typeof scope.route]);
  return true;
}

/** Same 409 shape and code as message send's reused-key refusal. */
function respondToAgentApiIdempotencyConflict(err: unknown, res: Response): boolean {
  if (!(err instanceof idempotentAgentApiService.AgentApiIdempotencyConflictError)) return false;
  res.status(err.status).json({
    error: err.message,
    code: err.code,
    mismatch: err.mismatch,
    suggestedNextAction: err.suggestedNextAction,
  });
  return true;
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

/**
 * The file the agent may read, with its message's time from the access check's
 * authority context, for the history window step after it
 * (`isAttachmentBehindWindow`).
 */
async function resolveAgentReadableAttachment(
  projection: typeof attachments.$inferSelect,
  serverId: string,
  agentId: string,
): Promise<{ attachment: ResolvedAttachment; messageCreatedAt: Date } | null> {
  // Size, type and key come only from the object.
  const context = await resolveReadableAttachmentAuthorityContext({
    projectionId: projection.id,
    requestServerId: serverId as ServerId,
    principal: { type: "agent", id: agentId },
  });
  if (!context) return null;
  return { messageCreatedAt: context.canonicalMessage.createdAt, attachment: withAttachmentObjectMetadata({
    ...context.projection,
    uploaderId: context.object.uploaderId,
    uploaderType: context.object.uploaderType,
  }, context.object) };
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
        refuse(res, 400, REMINDER_STATUS_FILTER_INVALID_REFUSAL);
        return null;
      }
      validated.push(p);
    }
    statusFilter = validated;
  } else if (req.query.all === "true") {
    statusFilter = ["scheduled", "fired", "canceled"];
  }
  // Only on request: older CLIs parse the status enum strictly and would fail
  // the whole list on a `migrated` row. A new CLI asks with `includeMigrated`
  // (an older server ignores it); an explicit `status=migrated` lists it too.
  if (req.query.includeMigrated === "true" && !statusFilter.includes("migrated")) {
    statusFilter = [...statusFilter, "migrated"];
  }
  return statusFilter;
}

function readReminderTimezone(
  tz: unknown,
  res: Response,
): string | null {
  if (tz === undefined) return "UTC";
  if (typeof tz !== "string" || tz.length === 0) {
    refuse(res, 400, REMINDER_TIMEZONE_INVALID_REFUSAL);
    return null;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
  } catch {
    refuse(res, 400, reminderTimezoneUnknownRefusal(tz));
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
    refuse(res, 400, REMINDER_REPEAT_INVALID_REFUSAL);
    return undefined;
  }
  const ruleTz = readReminderTimezone(tz, res);
  if (ruleTz === null) return undefined;
  const parsed = parseRecurrenceString(repeat, ruleTz);
  if (!parsed.ok) {
    refuse(res, 400, reminderRepeatUnparsedRefusal(parsed.error));
    return undefined;
  }
  if (
    (parsed.recurrence.rule.kind === "daily" || parsed.recurrence.rule.kind === "weekly") &&
    tz === undefined
  ) {
    refuse(res, 400, REMINDER_TIMEZONE_REQUIRED_REFUSAL);
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

/**
 * Per-agent grant required by each Agent API operation, in addition to the
 * credential capability. Grants are the human-managed scope set
 * (`agentScopesService`, `PUT /internal/agent/:id/scopes`); the credential
 * capability only says what a token may carry. Both must hold, exactly as on
 * the legacy `/internal/agent/:id/*` routes, whose `requireAgentScope(...)`
 * gate is the source of each entry below (`routes/internal.ts`):
 *
 *   operation                     legacy route                              grant
 *   attachmentUpload              POST   /agent/:id/upload                  attachment:upload
 *   attachmentUploadSessionCreate (chunked form of POST /agent/:id/upload)  attachment:upload
 *   attachmentUploadSessionComplete (chunked form of POST /agent/:id/upload) attachment:upload
 *   messageSend / messageSendV2   POST   /agent/:id/send                    message:send
 *   messageReactionAdd            POST   /agent/:id/messages/:m/reactions   message:send
 *   messageReactionRemove         DELETE /agent/:id/messages/:m/reactions   message:send
 *   messageCardUpdate             (none: RFC 082, agent API only)            message:send
 *   events                        GET    /agent/:id/receive                 message:read
 *   messageResolve                GET    /agent/:id/messages/:m/resolve     message:read
 *   historyRead                   GET    /agent/:id/history                 message:read
 *   messageSearch                 GET    /agent/:id/search                  message:read
 *   channelJoin                   POST   /agent/:id/channels/:c/join        channel:join
 *   channelLeave                  POST   /agent/:id/channels/:c/leave       channel:leave
 *   threadUnfollow                POST   /agent/:id/threads/unfollow        thread:unfollow
 *   channelMembers                GET    /agent/:id/channel-members         channel:read
 *   serverInfo                    GET    /agent/:id/server                  server:read
 *   serverUpdate                  PATCH  /agent/:id/server                  server:update
 *   channelCreate                 POST   /agent/:id/channels                channel:create
 *   channelUpdate                 PATCH  /agent/:id/channels/:c             channel:update
 *   channelMemberAdd              POST   /agent/:id/channels/:c/members     channel:add_member
 *   channelMemberRemove           DELETE /agent/:id/channels/:c/members     channel:remove_member
 *   knowledgeGet                  GET    /agent/:id/knowledge               knowledge:read
 *   knowledgeSearch               GET    /agent/:id/knowledge/search        knowledge:read
 *   taskList                      GET    /agent/:id/tasks                   task:read
 *   taskCreate                    POST   /agent/:id/tasks                   task:write
 *   taskClaim                     POST   /agent/:id/tasks/claim             task:write
 *   taskUnclaim                   POST   /agent/:id/tasks/unclaim           task:write
 *   taskUpdateStatus              POST   /agent/:id/tasks/update-status     task:write
 *   actionPrepare                 POST   /agent/:id/prepare-action          action:prepare
 *
 * actionWithdraw (POST /actions/:messageId/withdraw, a question card's agent
 * taking it back) has no legacy twin: it takes action:prepare, as the prepare
 * of the card it withdraws did.
 *
 * userChannels (GET /users/:name/channels, `raft user info`) has no legacy
 * twin: it replaces serverInfo + channelMembers and requires channel:read here
 * and server:read inline.
 *
 * The server avatar route is not a contract operation (multipart upload); it
 * carries `requireAgentGrant(...)` inline below.
 * `internalAgentApi.grantCoverage.test.ts` derives the expected pairs from the
 * legacy router and fails when a counterpart here lacks the same grant.
 */
export const AGENT_API_ROUTE_GRANTS: Partial<Record<AgentApiRouteKey, AgentScope>> = {
  raftbenchFindings: "message:read",
  raftbenchContext: "message:read",
  attachmentUpload: "attachment:upload",
  attachmentUploadSessionCreate: "attachment:upload",
  attachmentUploadSessionComplete: "attachment:upload",
  messageSend: "message:send",
  messageSendV2: "message:send",
  messageReactionAdd: "message:send",
  messageReactionRemove: "message:send",
  // RFC 082: no legacy twin; updating a card is sending (§6 rule 5: no new grant).
  messageCardUpdate: "message:send",
  events: "message:read",
  messageResolve: "message:read",
  historyRead: "message:read",
  // RFC 081: no legacy twin; reading or dismissing an inbox item is reading history.
  inboxRead: "message:read",
  inboxDismiss: "message:read",
  messageSearch: "message:read",
  channelJoin: "channel:join",
  channelLeave: "channel:leave",
  threadUnfollow: "thread:unfollow",
  channelMembers: "channel:read",
  serverInfo: "server:read",
  // Plus server:read inline: it replaces serverInfo and channelMembers.
  userChannels: "channel:read",
  serverUpdate: "server:update",
  channelCreate: "channel:create",
  channelUpdate: "channel:update",
  channelMemberAdd: "channel:add_member",
  channelMemberRemove: "channel:remove_member",
  knowledgeGet: "knowledge:read",
  knowledgeSearch: "knowledge:read",
  taskList: "task:read",
  taskCreate: "task:write",
  taskClaim: "task:write",
  taskUnclaim: "task:write",
  taskUpdateStatus: "task:write",
  // Lists the agent's assigned tasks, like `taskList --mine`.
  taskIdleNudge: "task:read",
  actionPrepare: "action:prepare",
  actionWithdraw: "action:prepare",
};

/**
 * Deny with the legacy `requireAgentScope` 403 shape when the bound agent's
 * grant set lacks `scope`. Default-mode agents (no `agent_scopes` row) carry
 * every grantable scope, so this only bites once a human saved a custom set.
 * Tagged with `__agentScope` like the legacy middleware so route walkers can
 * read the required grant off the handler chain.
 */
function requireAgentGrant(scope: AgentScope): RequestHandler {
  const handler: RequestHandler = async (req, res, next) => {
    const agentId = req.actingAgentId;
    if (!agentId) {
      res.status(500).json({ error: "Agent credential state missing" });
      return;
    }
    let reason: "missing_scope" | "scope_lookup_failed";
    try {
      if (await agentScopesService.agentHasScope(agentId, scope)) {
        next();
        return;
      }
      reason = "missing_scope";
    } catch (err) {
      console.error("agent-api scope lookup failed", serializeErrorForLog(err));
      reason = "scope_lookup_failed";
    }
    req.scopeDenyReason = reason;
    req.scopeRequired = scope;
    if (req.raftbenchServiceAgent) {
      // No requiredScope: the CLI would turn it into its generic permission-denied text, and the harness stops on this code (as raftbench/service.ts sends it).
      refuse(res, 403, { code: "raftbench_read_permission_revoked", error: "This service agent no longer has the required read permission.", suggestedNextAction: "Stop this run. An administrator has to restore its read grants; retrying will not help." });
      return;
    }
    // refusal-ok: the scope-deny shape: the CLI branches on top-level requiredScope (cli/src/client.ts); `reason` matches middleware/agentScope.ts
    res.status(403).json({ error: "missing required scope", requiredScope: scope, reason });
  };
  (handler as RequestHandler & { __agentScope?: AgentScope }).__agentScope = scope;
  return handler;
}

/**
 * RFC 075 v4: a personal assistant reads, reacts and downloads only in its DM
 * with its owner (and threads under it). True for every other agent. The
 * assistant route allowlist (auth) has already refused every other route.
 */
async function assistantConfinedToOwnerDm(req: Request, channelId: string): Promise<boolean> {
  if (!req.actingAgentAssistantOwnerUserId) return true;
  return (await channelService.assistantMayPostTo(channelId, req.actingAgentId!)) === true;
}

function registerAgentApiRoute<K extends AgentApiRouteKey>(
  routeKey: K,
  ...handlers: RequestHandler[]
): void {
  mountAgentApiRoute(routeKey, handlers);
}

/**
 * The agent API writes that post or fan out, by budget class
 * (services/agentApiWriteLimits.ts: per agent and per Server, per minute).
 * mountAgentApiRoute counts them right after the capability and grant checks,
 * before the body is validated or anything runs. A keyed replay (task create,
 * action prepare, send's idempotencyKey) spends budget too: its ledger lookup
 * runs inside the handler, after the request is normalized. A send's
 * `reconcileOnly` lookup spends the `reconcile` class instead (isReconcileOnlySend).
 */
export const AGENT_API_WRITE_BUDGET_ROUTES: Partial<Record<AgentApiRouteKey, AgentApiWriteBudgetClass>> = {
  messageSend: "messages",
  messageSendV2: "messages",
  taskReply: "messages",
  assistantSendAsOwner: "messages",
  assistantForwardAsOwner: "messages",
  assistantNotify: "messages",
  messageReactionAdd: "reactions",
  mentionActionsExecute: "mentionActions",
  taskCreate: "taskWrites",
  taskAssign: "taskWrites",
  taskUpdateStatus: "taskWrites",
  taskAmend: "taskWrites",
  taskConvert: "taskWrites",
  taskDelete: "taskWrites",
  taskClaim: "taskWrites",
  taskUnclaim: "taskWrites",
  channelCreate: "channelWrites",
  channelJoin: "channelWrites",
  channelMemberAdd: "channelWrites",
  attachmentUpload: "otherWrites",
  threadFollow: "otherWrites",
  // RFC 081: posts nothing, but a loop of `--before` calls is bounded here (one unit a call).
  inboxDismiss: "otherWrites",
  actionPrepare: "otherWrites",
  integrationAppPrepare: "otherWrites",
  migrationRetry: "otherWrites",
  // Artifacts (apps/artifacts/mount.ts): every write but a push's file uploads, in its own class.
  // The push is counted ahead of its large body's parser (app.ts), once.
  artifactPublish: "artifactWrites",
  // A personal assistant's publish into its DM with its owner (#proj-assistant:#31): the same class as a push.
  assistantOwnerArtifactPublish: "artifactWrites",
  artifactImport: "artifactWrites",
  artifactComment: "artifactWrites",
  artifactReview: "artifactWrites",
  // A thread's resolve (with its note, at most one reply) and reopen: one write each, as a comment (#249).
  artifactCommentResolve: "artifactWrites",
  artifactCommentReopen: "artifactWrites",
  artifactCommentImageUpload: "artifactWrites",
  artifactSubscribe: "artifactWrites",
  artifactUnsubscribe: "artifactWrites",
  artifactMove: "artifactWrites",
  artifactDelete: "artifactWrites",
  artifactSaveAttachment: "artifactWrites",
  artifactUpload: "artifactUploads",
};

/**
 * The send routes whose `reconcileOnly: true` request only asks whether an
 * earlier send under its idempotencyKey committed: handleAgentApiMessageSend
 * answers it from the ledger and returns before any write, refusing content
 * or a card with it. It spends no budget, so a client that lost a response
 * near the limit can still learn whether its send landed instead of a 429.
 */
const RECONCILE_ONLY_SEND_ROUTES: ReadonlySet<string> = new Set(["messageSend", "messageSendV2", "taskReply"]);

function isReconcileOnlySend(operation: string, body: unknown): boolean {
  return RECONCILE_ONLY_SEND_ROUTES.has(operation)
    && Boolean(body) && typeof body === "object"
    && (body as Record<string, unknown>).reconcileOnly === true;
}

/** The units a request spends: one, or one per resolution id / per task of a batch / per comment of a review. */
function agentApiWriteUnits(operation: string, body: unknown): number {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (operation === "mentionActionsExecute") {
    const ids = Array.isArray(record.resolutionIds) ? record.resolutionIds : Array.isArray(record.ids) ? record.ids : [];
    return Math.min(100, new Set(ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim())).size);
  }
  if (operation === "taskCreate") return Array.isArray(record.tasks) ? record.tasks.length : 1;
  if (operation === "artifactReview") {
    // A review the route refuses for its size (400 TOO_MANY_COMMENTS) posts nothing: one write, not its comments.
    const count = Array.isArray(record.comments) ? record.comments.length : 0;
    return count >= 1 && count <= AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS ? count : 1;
  }
  return 1;
}

/** res.locals: the budget class a request was already charged to (a push, ahead of its body's parser). */
const WRITE_BUDGET_CHARGED = "agentApiWriteBudgetCharged";

/**
 * Spends the calling agent's and its Server's budget for `kind`; past either,
 * 429 RATE_LIMITED (agentApiRateLimit.ts's body, Retry-After) before the
 * route does anything. A body left unread (an upload, a push refused ahead
 * of its parser) is not drained: the connection is closed. Each request is
 * charged once: a push charged ahead of its parser passes at the route.
 * Tagged `__agentApiWriteBudget` (the class) for route walkers.
 */
export function agentApiWriteBudget(routeKind: AgentApiWriteBudgetClass, operation: string): RequestHandler {
  const handler: RequestHandler = async (req, res, next) => {
    // Auth answered already when it set no agent; the route's own chain runs it again.
    if (res.locals[WRITE_BUDGET_CHARGED] === routeKind || !req.actingAgentId || !req.serverId) {
      next();
      return;
    }
    res.locals[WRITE_BUDGET_CHARGED] = routeKind;
    let kind = routeKind;
    try {
      // Task create carries at most 50 tasks (its handler refuses more), mention
      // actions at most 100 ids, an Artifact review at most 50 comments: all
      // within their per-agent budgets.
      // A reconcileOnly lookup spends its own budget, not the send's.
      if (isReconcileOnlySend(operation, req.body)) kind = "reconcile";
      const units = agentApiWriteUnits(operation, req.body);
      const admission = await admitAgentApiWrite(kind, { agentId: req.actingAgentId!, serverId: req.serverId!, units });
      if (admission.admitted) {
        next();
        return;
      }
      if (admission.scope === "request") {
        refuse(res, 400, {
          code: "agent_api_write_too_large",
          // A review's units are its comments (each one write).
          error: operation === "artifactReview"
            ? `One review can carry at most ${admission.limit} comments, each one of this agent's writes; split it into smaller reviews.`
            : `One request can carry at most ${admission.limit} ${agentApiWriteBudgetNoun(kind)}; split it into smaller requests.`,
        });
        return;
      }
      const { limit, retryAfterSeconds } = admission;
      const wait = `Retry in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.`;
      const what = agentApiWriteBudgetNoun(kind);
      setRequestTraceRateLimiter(res, `agent-api-${kind}-${admission.scope}`);
      res.setHeader("Cache-Control", "private, no-store");
      if (!req.readableEnded) res.setHeader("Connection", "close");
      refuse(res, 429, {
        code: AGENT_API_RATE_LIMITED_CODE,
        error: admission.scope === "agent"
          ? `This agent made too many ${what}: the limit is ${limit} a minute. ${wait}`
          : `The agents of this server made too many ${what}: the limit is ${limit} a minute for the whole server. ${wait}`,
        retryAfterSeconds,
        details: { operation, limit, windowSeconds: AGENT_API_WRITE_WINDOW_SECONDS, retryAfterSeconds },
      });
    } catch (err) {
      next(err);
    }
  };
  (handler as RequestHandler & { __agentApiWriteBudget?: AgentApiWriteBudgetClass }).__agentApiWriteBudget = routeKind;
  return handler;
}

/**
 * A contract route: `before` (a first-party app's client gate), then the
 * route's capability and grant, then its write budget
 * (AGENT_API_WRITE_BUDGET_ROUTES), then `handlers`.
 */
function mountAgentApiRoute(routeKey: AgentApiRouteKey, handlers: RequestHandler[], before: RequestHandler[] = []): void {
  const route: AgentApiContractRoute = agentApiContract[routeKey];
  const grant = AGENT_API_ROUTE_GRANTS[routeKey];
  const writeBudget = AGENT_API_WRITE_BUDGET_ROUTES[routeKey];
  const routeHandlers: RequestHandler[] = [
    ...before,
    requireAgentCapability(route.capability),
    ...(grant ? [requireAgentGrant(grant)] : []),
    ...(writeBudget ? [agentApiWriteBudget(writeBudget, routeKey)] : []),
    ...handlers,
  ];
  switch (route.method) {
    case "GET":
      internalAgentApiRouter.get(route.path, ...routeHandlers);
      return;
    case "POST":
      internalAgentApiRouter.post(route.path, ...routeHandlers);
      return;
    case "PUT":
      internalAgentApiRouter.put(route.path, ...routeHandlers);
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

function toAgentApiMessageEnvelope(
  message: AgentApiMessageSource,
  content: string,
  viewerAgentId: string,
): AgentApiMessageEnvelope {
  // An action card's `presentation.card` is for human clients only.
  const { senderHandle, ...messageEnvelopeFields } = messageWithoutAgentHiddenActionCardSpec(message);
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
      viewerAgentId,
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
    // RFC 082: `card=r<revision>` in the reader's header; `content` is the card's fallback.
    ...agentMessageCardField("actionMetadata" in message ? message.actionMetadata : null),
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

/**
 * refuse(), keeping the more specific reason the route already put on the
 * request span (setRequestTraceErrorCode): refuse() records the refusal's
 * code, which a uniform refusal shares across all its reasons.
 */
function refuseKeepingTraceReason(res: Response, status: RefusalStatus, input: RefusalInput): void {
  const reason = requestTraceErrorCode(res);
  refuse(res, status, input);
  if (reason) setRequestTraceErrorCode(res, reason);
}

/**
 * A history read's `--before` / `--after` / `--around` anchor it can't use.
 * An invalid anchor is not echoed (it can be any text); an ambiguous or
 * missing one has the anchor's shape, so it is.
 */
function refuseHistoryAnchor(
  res: Response,
  channelRef: string,
  anchor: string,
  reason: "not_found" | "ambiguous" | "invalid",
): void {
  if (reason === "invalid") {
    refuse(res, 400, {
      code: "INVALID_ARG",
      error: sentenceQuoting([String(channelRef)], `That message anchor isn't a seq number, a full message UUID or an 8-character short id: use one of those to read ${channelRef}.`, "That message anchor isn't a seq number, a full message UUID or an 8-character short id: use one of those to read this conversation."),
    });
    return;
  }
  if (reason === "ambiguous") {
    refuse(res, 400, {
      code: "AMBIGUOUS_ID",
      error: sentenceQuoting([String(channelRef), String(anchor)], `More than one message in ${channelRef} has the short id ${anchor}: use the full message UUID instead.`, "More than one message here has that short id: use the full message UUID instead."),
      suggestedNextAction: "Use the full message UUID instead of the 8-character short id.",
    });
    return;
  }
  refuse(res, 404, {
    code: "NOT_FOUND",
    error: sentenceQuoting([String(anchor), String(channelRef)], `There is no message ${anchor} in ${channelRef}: check the id, or read the conversation's latest messages to find it.`, "There is no such message in this conversation: check the id, or read the conversation's latest messages to find it."),
    next: RAFT_HINTS.messageRead({ target: channelRef }),
  });
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

  // "You joined this channel" only when the agent joined it itself (`raft
  // channel join` writes the "@agent joined this channel." line, caused by the
  // agent) for this membership. An agent added by someone else — at channel
  // creation, by an invite — did not join to post: a recent membership alone
  // is not a join.
  const [selfJoin] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(
      eq(messages.channelId, resolved.channelId),
      eq(messages.messageType, "system"),
      eq(messages.systemSubtype, "agent.join_channel"),
      eq(messages.causalActorType, "agent"),
      eq(messages.causalActorId, actingAgentId),
      gte(messages.createdAt, membership.addedAt),
    ))
    .limit(1);
  if (!selfJoin) return null;

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
    refuse(res, 404, AGENT_CHANNEL_NOT_FOUND_REFUSAL);
    return null;
  }
  if (isSubConversationType(channel.type)) {
    refuse(res, 400, {
      code: "thread_not_mutable",
      error: "Threads do not have a separate mute state. Ordinary thread delivery is controlled by follow/unfollow and is independent from the parent channel's mute state; unfollow this thread to stop it.",
    });
    return null;
  }
  if (channel.type === "dm") {
    refuse(res, 400, { code: "dm_not_mutable", error: "A DM's activity can't be muted with channel mute." });
    return null;
  }
  if (channel.archivedAt) {
    refuse(res, 409, { code: "channel_archived", error: "This channel is archived, so its mute setting can't change until it is unarchived." });
    return null;
  }
  const isMember = channelService.isEnabledAllChannel(channel)
    || await channelService.isChannelAgent(channel.id, actingAgentId);
  if (!isMember) {
    refuse(res, 403, { code: "channel_mute_requires_membership", error: "You can only mute a channel you are a member of." });
    return null;
  }
  return channel;
}

/** What a gated write's freshness check found: see {@link evaluateAgentFreshness}. */
type AgentFreshnessEvaluation = {
  /** Where the conversation's messages are stored: the canonical thread for a joint thread projection. */
  messageChannelId: string;
  latestFreshnessSeq: number;
  latestFreshnessMessageId: string | null;
  attestedBoundarySeq: number;
  attestedBoundaryMessageId: string | null;
  newMessageCount: number;
  attestedTargetType: attestedSendService.AttestedSendTargetType;
  boundarySource: string;
  formalMentionFacts: Awaited<ReturnType<typeof attestedSendService.getFormalMentionFacts>>;
  useAttentionFacts: boolean;
  seenExactSeqs: number[];
  /** The agent's server's history window, read once per write and reused by the hold. */
  historyWindow: HistoryWindow;
  /** Only chat messages count (`counts: "chat"`): system notices are left out of every count and window. */
  chatOnly: boolean;
};

/**
 * The freshness check a gated write runs (a send, and a task claim, status
 * update or amend): the newest message in the conversation the agent did not
 * write itself, against the model-seen boundary its request attests. One
 * function, so every gated write holds by the same rule.
 */
async function evaluateAgentFreshness(input: {
  agentId: string;
  /** The agent's server: its plan's history window bounds what can be unseen. */
  serverId: string;
  channelId: string;
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  seenUpToSeq: number | undefined;
  requestedSeenExactSeqs: number[] | undefined;
  /** Count only chat messages, not system notices (a task write's `counts: "chat"`). */
  chatOnly?: boolean;
}): Promise<AgentFreshnessEvaluation> {
  const { agentId, serverId, channelId, channelType, seenUpToSeq, requestedSeenExactSeqs } = input;
  const chatOnly = input.chatOnly === true;
  const selfSender = { senderType: "agent" as const, senderId: agentId };
  const useAttentionFacts = channelType !== "thread";
  // A joint thread's local projection stores no messages: they (and the
  // parent message) live on the canonical thread, whose seqs are the ones the
  // agent saw. Message reads use that storage id; mention rows stay keyed by
  // the local projection.
  const messageChannelId = channelType === "thread"
    ? await channelService.getMessageStorageChannelIdWithExecutor(getDb(), channelId)
    : channelId;
  // Messages behind the plan's history window can never be shown to the
  // agent, so they are never unseen (services/historyWindow.ts): every count
  // and anchor below reads only messages created after the cutoff. A channel
  // whose messages are all behind it has nothing new.
  const historyWindow = await getServerHistoryWindowForRead(serverId);
  const createdAfter = historyWindow.cutoff;
  const hasClientSeenBoundary = typeof seenUpToSeq === "number" && Number.isFinite(seenUpToSeq);
  const clientSeenUpToSeq = hasClientSeenBoundary
    ? Math.max(0, Math.floor(seenUpToSeq))
    : 0;
  // With a model-seen boundary the anchor is searched only after it: a
  // message at or before the boundary cannot be unseen, so every hold and its
  // context come out the same. Found nothing after it: the boundary stands in
  // as the latest seq (no new messages, as the unbounded search concluded).
  const attentionAnchor = useAttentionFacts
    ? await attestedSendService.getLatestAgentAttentionAnchor(agentId, channelId, {
      excludeSender: selfSender,
      createdAfter,
      chatOnly,
      ...(hasClientSeenBoundary ? { afterSeq: Math.min(clientSeenUpToSeq, Number.MAX_SAFE_INTEGER) } : {}),
    })
    : null;
  const latestAnchor = attentionAnchor
    ? (hasClientSeenBoundary && attentionAnchor.seq === 0 ? { seq: Math.min(clientSeenUpToSeq, Number.MAX_SAFE_INTEGER), messageId: null } : attentionAnchor)
    : await attestedSendService.getLatestMessageAnchor(messageChannelId, {
      excludeSender: selfSender,
      createdAfter,
      chatOnly,
    });
  const threadParentAnchor = !hasClientSeenBoundary && channelType === "thread"
    ? await attestedSendService.getThreadParentAnchor(messageChannelId)
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
      : await attestedSendService.getMessageIdForSeq(messageChannelId, attestedBoundarySeq);
  const seenExactSeqs = [...new Set((requestedSeenExactSeqs ?? [])
    .map((seq) => Math.floor(Number(seq)))
    .filter((seq) => Number.isInteger(seq)
      && seq > attestedBoundarySeq
      && seq <= latestFreshnessSeq))]
    .slice(0, 2_500);
  const newMessageCount = latestFreshnessSeq > attestedBoundarySeq
    ? useAttentionFacts
      ? await attestedSendService.countAgentAttentionMessagesAfterSeq(agentId, channelId, attestedBoundarySeq, {
        excludeSender: selfSender,
        latestSeq: latestFreshnessSeq,
        excludeExactSeqs: seenExactSeqs,
        createdAfter,
        chatOnly,
      })
      : await attestedSendService.countMessagesAfterSeq(messageChannelId, attestedBoundarySeq, {
        excludeSender: selfSender,
        latestSeq: latestFreshnessSeq,
        excludeExactSeqs: seenExactSeqs,
        createdAfter,
        chatOnly,
      })
    : 0;
  const attestedTargetType = toAttestedSendTargetType(channelType);
  const boundarySource = hasClientSeenBoundary
    ? "client_seen"
    : seenExactSeqs.length > 0
      ? "client_seen_exact"
    : threadParentAnchor
      ? "thread_parent"
      : "none";
  const formalMentionFacts = latestFreshnessSeq > attestedBoundarySeq
    ? await attestedSendService.getFormalMentionFacts(
        agentId,
        channelId,
        attestedBoundarySeq,
        latestFreshnessSeq,
        seenExactSeqs,
        createdAfter,
      )
    : { count: 0, firstMessageId: null, firstHandle: null };
  return {
    messageChannelId,
    latestFreshnessSeq,
    latestFreshnessMessageId,
    attestedBoundarySeq,
    attestedBoundaryMessageId,
    newMessageCount,
    attestedTargetType,
    boundarySource,
    formalMentionFacts,
    useAttentionFacts,
    seenExactSeqs,
    historyWindow,
    chatOnly,
  };
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
  historyWindow: HistoryWindow,
  options?: attestedSendService.FreshnessMessageRangeOptions,
): Promise<AgentApiMessageEnvelope[]> {
  // An agent whose read position is older than the plan's history window is
  // not shown what the window leaves out (services/historyWindow.ts).
  const freshnessMessages = useAttentionFacts
    ? await attestedSendService.listRecentAgentAttentionMessagesAfterSeq(
      agentId,
      channelId,
      afterSeq,
      limit,
      { ...options, latestSeq, createdAfter: historyWindow.cutoff },
    )
    : await attestedSendService.listRecentMessagesAfterSeq(
      messageChannelId,
      afterSeq,
      limit,
      { ...options, latestSeq, createdAfter: historyWindow.cutoff },
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
  // Message rows carry no conversation identity; without it clients cannot
  // form a reply target and drop every held message. Resolve the agent-facing
  // identity of the send target once and label each held envelope with it.
  const identity = await messageService.resolveAgentConversationIdentity(agentServerId, agentId, channelId);
  return (await withAgentMessageReactions(await withAgentSourceTasks(recentMessages, undefined, agentServerId))).map((message) => ({
    ...toAgentApiMessageEnvelope(message, typeof message.content === "string" ? message.content : "", agentId),
    ...identity,
  }));
}

/**
 * Shows a gated write the messages its conversation has that the model has
 * not seen (the bounded window), and books them as shown: the agent's read
 * position moves and their delivery is acknowledged only when every counted
 * message is in the window. A hold returns them in place of the write; an
 * applied write that attaches them (agentWriteLanding.ts `attach`) returns
 * them with its result.
 */
async function showUnseenContext(req: Request, input: {
  agentId: string;
  serverId: string;
  agentServerId: string;
  channelId: string;
  evaluation: AgentFreshnessEvaluation;
  withhold: boolean;
  agentOrchestrator: AgentOrchestrator;
  /** A hold shows them in place of the write; an applied write attaches them to its result. */
  source: "hold" | "attach";
}): Promise<{ heldMessages: AgentApiMessageEnvelope[]; heldSeqs: number[]; attentionHoldCount: number; shownMessageCount: number }> {
  const { agentId, serverId, agentServerId, channelId, evaluation, withhold, agentOrchestrator } = input;
  const {
    attestedBoundarySeq: boundarySeq,
    latestFreshnessSeq: latestSeq,
    useAttentionFacts,
    seenExactSeqs,
  } = evaluation;
  const heldMessages = withhold
    ? []
    : await listRecentFreshnessMessagesAfterSeq(
        agentId,
        serverId,
        channelId,
        evaluation.messageChannelId,
        boundarySeq,
        ATTESTED_SEND_HELD_CONTEXT_LIMIT,
        latestSeq,
        useAttentionFacts,
        evaluation.historyWindow,
        {
          excludeSender: { senderType: "agent", senderId: agentId },
          excludeExactSeqs: seenExactSeqs,
          chatOnly: evaluation.chatOnly,
        },
      );
  const heldSeqs = heldMessages
    .map((message) => Number((message as { seq?: unknown }).seq))
    .filter((seq) => Number.isInteger(seq) && seq > 0);
  recordAgentContextReturned({
    source: input.source,
    agentId,
    channelId,
    ...agentRequestContextFromHeaders(req.headers),
    seqs: heldSeqs,
  });
  const attentionHoldCount = latestSeq > boundarySeq
    ? useAttentionFacts
      ? await attestedSendService.countAgentAttentionMessagesAfterSeq(agentId, channelId, boundarySeq, {
        excludeSender: { senderType: "agent", senderId: agentId },
        latestSeq,
        excludeExactSeqs: seenExactSeqs,
        chatOnly: evaluation.chatOnly,
      })
      : await attestedSendService.countMessagesAfterSeq(evaluation.messageChannelId, boundarySeq, {
        excludeSender: { senderType: "agent", senderId: agentId },
        latestSeq,
        excludeExactSeqs: seenExactSeqs,
        chatOnly: evaluation.chatOnly,
      })
    : 0;
  const shownMessageCount = heldMessages.length;
  // The read position moves to latestSeq only when this hold showed every
  // message it counts. When some were omitted (the context cap), they
  // have not been handed to the agent; marking them read would drop them
  // from its inbox (an external agent never receives them otherwise), so
  // the position stays and they are delivered as usual.
  const showedEveryHeldMessage = shownMessageCount >= attentionHoldCount;
  if (!withhold && showedEveryHeldMessage) {
    // Task #93 line B: the agent's own read is a side effect of the send; a read-state fence refusal must not fail
    // the send. Any other error still surfaces.
    const readState = await channelService.markRead(
      { kind: "agent", id: agentId },
      channelId,
      latestSeq,
    ).catch((error: unknown) => {
      if (isReadMutationFenceRefusal(error)) return null;
      throw error;
    });
    if (readState) {
      await emitScopeReadUpdated({
        io: req.app.get("io") as SocketServer | undefined,
        serverId: agentServerId,
        scopeId: channelId,
        peerKind: "agent",
        peerId: agentId,
        maxReadSeq: readState.maxReadSeq,
        changed: readState.changed,
      });
    }
  }
  if (!withhold && latestSeq > boundarySeq) {
    // Held context is returned inline; do not also redeliver it as unread.
    // Only what was shown: omitted messages stay queued for delivery.
    if (showedEveryHeldMessage) {
      agentOrchestrator.acknowledgeDeliveredMessagesForChannelUpToSeq?.(
        agentId,
        channelId,
        latestSeq,
      ) ?? agentOrchestrator.acknowledgeDeliveredMessagesForChannel(agentId, channelId, heldSeqs);
    } else {
      agentOrchestrator.acknowledgeDeliveredMessagesForChannel(agentId, channelId, heldSeqs);
    }
  }
  return { heldMessages, heldSeqs, attentionHoldCount, shownMessageCount };
}

/**
 * The held response of a gated write (a send, a task claim, status update or
 * amend) whose freshness check found newer messages: the bounded window of
 * them, the read position and delivery acknowledgements when every counted
 * message was shown, the recorded hold (`gate_triggered`, with the board's
 * channel id so a task write's retry can find it), and the agent's activity.
 * One function, so every gated write holds with the same envelope.
 */
async function renderAgentFreshnessHold(req: Request, hold: {
  action: ApmFreshnessSideEffectAction;
  agentId: string;
  serverId: string;
  agentServerId: string;
  channelId: string;
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  target: string;
  withhold: boolean;
  agentOrchestrator: AgentOrchestrator;
  evaluation: AgentFreshnessEvaluation;
  /** Task writes: which write was held, so only its own rerun is covered by the hold. */
  writeKey?: string;
  /** Send only: the draft this send replaced, how often it was held, and whether it is `--send-draft`. */
  replacedExisting?: boolean;
  reholdCount?: number;
  isSendDraft?: boolean;
}): Promise<AgentApiHeldFreshnessResponse> {
  const { action, agentId, serverId, agentServerId, channelId, channelType, target, withhold, agentOrchestrator } = hold;
  const replacedExisting = hold.replacedExisting ?? false;
  const reholdCount = hold.reholdCount ?? 0;
  const isSendDraft = hold.isSendDraft ?? false;
  const {
    attestedBoundarySeq: boundarySeq,
    attestedBoundaryMessageId: boundaryMessageId,
    latestFreshnessSeq: latestSeq,
    latestFreshnessMessageId: latestMessageId,
    boundarySource,
    attestedTargetType,
    useAttentionFacts,
    seenExactSeqs,
  } = hold.evaluation;
  const mentionCount = hold.evaluation.formalMentionFacts.count;
  const { heldMessages, heldSeqs, attentionHoldCount, shownMessageCount } = await showUnseenContext(req, {
    agentId,
    serverId,
    agentServerId,
    channelId,
    evaluation: hold.evaluation,
    withhold,
    agentOrchestrator,
    source: "hold",
  });
  // Without a model-seen boundary, do not present the whole target
  // history as "new messages"; this is a bounded first-touch context.
  // A boundary of 0 with nothing seen exactly proves nothing either: a
  // Computer attests 0 for a task write's conversation its model has not
  // read in this context, so that the write is still checked
  // (agentCredentialProxy attestTaskWriteLanding). Its hold reads as a
  // send's first touch, not "134 unread" with 131 "skipped". Only the
  // count and the text: whether it holds, what it shows, the read position
  // and `seenUpToSeq` come from the evaluation as before.
  const attestsNothingSeen = boundarySource === "client_seen" && boundarySeq <= 0 && seenExactSeqs.length === 0;
  const hasModelSeenProof = (boundarySource === "client_seen" || boundarySource === "client_seen_exact") && !attestsNothingSeen;
  const firstTouchContextCount = withhold
    ? Math.min(attentionHoldCount, ATTESTED_SEND_HELD_CONTEXT_LIMIT)
    : shownMessageCount;
  const holdCount = hasModelSeenProof ? attentionHoldCount : firstTouchContextCount;
  const omittedMessageCount = !withhold && hasModelSeenProof
    ? Math.max(0, attentionHoldCount - shownMessageCount)
    : 0;
  // Chat semantics (task #41 final review): the hold's obligation is the honest
  // in-the-moment sentence: true skipped count (omittedMessageCount,
  // attention semantics — never a seq span) plus the runnable --before
  // anchor (minShownSeq). Nothing is persisted or re-surfaced.
  const minShownSeq = heldSeqs.length > 0 ? Math.min(...heldSeqs) : null;
  // Thread digest anchor: where this conversation started. Only fetched
  // for threads, only when context is shown, and only when the parent
  // is not already inside the displayed window.
  const threadParentCandidate = !withhold && channelType === "thread"
    ? await attestedSendService.getThreadParentMessage(hold.evaluation.messageChannelId)
    : null;
  // Not when it is behind the plan's history window: the agent may not read it.
  const threadParentMessage = threadParentCandidate?.createdAt
    && isBehindHistoryWindow(threadParentCandidate.createdAt, hold.evaluation.historyWindow)
    ? null
    : threadParentCandidate;
  await attestedSendService.recordGateTriggered({
    id: randomUUID(),
    agentId: agentId,
    serverId: agentServerId,
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
    action,
    channelId,
    writeKey: hold.writeKey,
  });
  const freshnessDecision = {
    action,
    decision: "syncing_hold" as const,
    ...(withhold ? { freshnessContextMode: "withheld" as const } : {}),
    target,
    reason: hasModelSeenProof ? "server_stale_model_boundary" : "server_first_touch_context",
    pendingMaxSeq: latestSeq,
    modelSeenSeq: boundarySource === "client_seen" ? boundarySeq : 0,
    heldMessageCount: shownMessageCount,
    omittedMessageCount,
  };
  const producerFactId = buildApmFreshnessDecisionProducerFactId(agentId, freshnessDecision);
  const envelope = projectApmHeldFreshnessEnvelope<AgentApiMessageEnvelope>({
    producerFactId,
    action,
    decision: "syncing_hold",
    heldMessages,
    newMessageCount: holdCount,
    omittedMessageCount,
    seenUpToSeq: latestSeq,
    freshnessContextMode: withhold ? "withheld" : undefined,
  });
  if (withhold) {
    await recordAgentRaftAction(req, agentId, {
      title: "Reviewer-isolation freshness hold",
      text: `${formatAttestedMessageCount(holdCount)} withheld`,
    });
  } else {
    const activity = projectApmHeldFreshnessActivity({
      producerFactId,
      action,
      decision: "syncing_hold",
      target,
      messageCount: shownMessageCount,
    });
    const title = action === "send" && (reholdCount > 0 || isSendDraft) ? "Send draft held" : activity.entry.title;
    await recordAgentRaftAction(req, agentId, {
      title,
      text: activity.entry.text,
      producerFactId,
      activity: activity.statusEntry.activity,
      activityDetail: title,
    });
  }
  return {
    ...(!withhold ? { ok: true } : {}),
    ...envelope.body,
    ...(!withhold
      ? { mentionAnnotation: { formalMentionCount: mentionCount } }
      : {}),
    ...(!withhold && action === "send"
      ? { continueAnywaySuggested: reholdCount >= 3 }
      : {}),
    ...(!withhold
      ? { seenUpToMessageId: latestMessageId }
      : {}),
    ...(!withhold && minShownSeq !== null
      ? { firstShownSeq: minShownSeq }
      : {}),
    ...(!withhold
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
}

/**
 * Where a gated task write's result lands, resolved on this server: the
 * conversation its freshness check reads (shared agentWriteLanding.ts).
 * `target` is that conversation as the agent addresses it, echoed in a hold.
 */
type TaskWriteLanding = { channelId: string; target: string };

/**
 * The task's own conversation (`#channel:#N`), where its claim, release,
 * assignment and status lines are posted. Null when the task does not talk in
 * one (a pre-v2 task on a flag-off server) or it does not exist yet: then there
 * is nothing there to have missed.
 */
async function taskConversationLanding(
  ctx: AgentApiTaskChannelContext,
  channel: string,
  task: { id: string; taskNumber: number } & TaskModeFields,
): Promise<TaskWriteLanding | null> {
  if (!taskUsesOwnConversation(task, await isTaskV2ConversationsEnabled(ctx.localChannel.serverId))) return null;
  const channelId = await resolveLocalTaskConversationId(task.id, ctx.channelId);
  const target = formatAgentTaskRef(channel, task.taskNumber);
  return channelId && target ? { channelId, target } : null;
}

/**
 * The thread of the message a task is created from, where someone else's
 * "on it" and the "created #N from this message" line land. Null when nobody
 * has replied yet.
 */
async function sourceThreadLanding(
  ctx: AgentApiTaskChannelContext,
  channel: string,
  sourceMessageId: string,
): Promise<TaskWriteLanding | null> {
  const thread = await channelService.getThreadInfoForChannel(ctx.channelId, sourceMessageId);
  return thread ? { channelId: thread.threadChannelId, target: agentTaskThreadTarget(channel, sourceMessageId) } : null;
}

/**
 * The freshness gate on a task write: before an agent's write puts something
 * in a conversation others read, it must have seen what is new there
 * (#wg-task-v2:98488173). AGENT_GATED_WRITES says, per write, where its
 * result lands, which messages count, and what happens to unseen ones.
 *
 * - The conversation is where the write's result lands (`landing`): the
 *   task's own conversation for a claim, release, assignment, status update
 *   or amend; the source message's thread for a create. A write that lands in
 *   none (several tasks at once, a pre-v2 task, a thread nobody replied in) is
 *   not checked.
 * - It runs only when the request attests what its model has seen of that
 *   landing (`seenFor` naming it, and `seenUpToSeq` or a non-empty
 *   `seenExactSeqs`). Older Computers attest the board, without `seenFor`, and
 *   are not checked.
 * - `counts: "chat"` leaves system notices out: a task conversation's
 *   lifecycle lines restate the task's state, which the write's own checks
 *   (claim conflict, revision, status transitions) already cover.
 * - `onUnseen: "hold"` (create, claim, assign): the write is not applied, and
 *   rerunning it after reading passes. At most one hold per catch-up: when
 *   this same write (`agentTaskWriteKey`) was held in the landing within
 *   TASK_WRITE_REHOLD_WINDOW_MS and the rerun's boundary covers that hold,
 *   newer messages do not hold it again. The hold is a row, so a rerun on any
 *   replica finds it. Reviewer isolation shows no messages, so there a recent
 *   hold of the write lets it pass.
 * - `onUnseen: "attach"` (release, status update, amend): the write is
 *   applied and the unseen messages come back with its result (`unseen`),
 *   so the agent reads them in the same turn instead of spending one to rerun.
 *
 * Returns `{ held }` to answer with instead of applying the write, else
 * `{ unseen }` (possibly undefined) to attach to the write's result.
 */
async function gateTaskWriteFreshness(req: Request, input: {
  action: AgentGatedTaskWriteAction;
  agentId: string;
  serverId: string;
  ctx: AgentApiTaskChannelContext;
  /** The request body: what it attests, and the write's identity. */
  body: Record<string, unknown>;
  /** Resolves where the write's result lands; called only for an attested write. */
  landing: () => Promise<TaskWriteLanding | null>;
}): Promise<{ held: AgentApiHeldFreshnessResponse } | { held?: undefined; unseen?: AgentApiTaskWriteUnseen }> {
  const { action, agentId, serverId, ctx, body } = input;
  const write = AGENT_GATED_WRITES[action];
  const seenUpToSeq = typeof body.seenUpToSeq === "number" ? body.seenUpToSeq : undefined;
  const seenExactSeqs = Array.isArray(body.seenExactSeqs) ? body.seenExactSeqs as number[] : undefined;
  const attested = body.seenFor === write.landing
    && (seenUpToSeq !== undefined || (seenExactSeqs?.length ?? 0) > 0);
  if (!attested || !isSendFreshnessEnabled(ctx.agent.serverId, agentId)) return {};
  const landing = await input.landing();
  if (!landing) return {};
  const writeKey = agentTaskWriteKey(action, body);
  const withhold = body.freshnessContextMode === "withheld";
  const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
  const gate = await tracePhase(
    async () => {
      const evaluation = await evaluateAgentFreshness({
        agentId,
        serverId: ctx.agent.serverId,
        channelId: landing.channelId,
        // Both landings are sub-conversations (a task conversation or a
        // thread), whose own messages are counted, as a send to a task ref is
        // (agentWritableTarget.ts); storage resolves either kind.
        channelType: "thread",
        seenUpToSeq,
        requestedSeenExactSeqs: seenExactSeqs,
        chatOnly: write.counts === "chat",
      });
      if (evaluation.newMessageCount === 0) return { evaluation, outcome: "passed" as const };
      if (write.onUnseen === "attach") return { evaluation, outcome: "attached" as const };
      const lastHold = await attestedSendService.getRecentGateTriggered(
        agentId,
        landing.channelId,
        writeKey,
        attestedSendService.TASK_WRITE_REHOLD_WINDOW_MS,
      );
      const caughtUp = lastHold !== null && (withhold || evaluation.attestedBoundarySeq >= lastHold.latestSeq);
      return { evaluation, outcome: caughtUp ? "repeat_passed" as const : "held" as const };
    },
    (_durationMs, result) => ({
      name: "agent_api_task.freshness.evaluated",
      attrs: {
        action,
        landing: write.landing,
        outcome: result.outcome,
        boundary_source: result.evaluation.boundarySource,
        new_message_count: result.evaluation.newMessageCount,
        freshness_context_mode: withhold ? "withheld" : "inline",
      },
    }),
  );
  if (gate.outcome === "held") {
    return {
      held: await renderAgentFreshnessHold(req, {
        action,
        agentId,
        serverId,
        agentServerId: ctx.agent.serverId,
        channelId: landing.channelId,
        channelType: "thread",
        target: landing.target,
        withhold,
        agentOrchestrator,
        evaluation: gate.evaluation,
        writeKey,
      }),
    };
  }
  // Reviewer isolation shows no message bodies: nothing to attach.
  if (gate.outcome !== "attached" || withhold) return {};
  const shown = await showUnseenContext(req, {
    agentId,
    serverId,
    agentServerId: ctx.agent.serverId,
    channelId: landing.channelId,
    evaluation: gate.evaluation,
    withhold: false,
    agentOrchestrator,
    source: "attach",
  });
  return {
    unseen: {
      target: landing.target,
      messages: shown.heldMessages,
      newMessageCount: shown.attentionHoldCount,
      omittedMessageCount: Math.max(0, shown.attentionHoldCount - shown.shownMessageCount),
      seenUpToSeq: gate.evaluation.latestFreshnessSeq,
    },
  };
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

/**
 * Closed-set client label for send traces: `cli` (raft CLI, also via the
 * daemon credential proxy), `sdk` (the raft SDK names itself), `daemon`,
 * `other`, or `absent` (no header: SDK builds before it named itself and the
 * cloud runtime send none).
 */
function agentApiClientKind(req: Request): "cli" | "sdk" | "daemon" | "other" | "absent" {
  const client = req.header("X-Raft-Client") ?? req.header("X-Slock-Client");
  if (!client) return "absent";
  if (client === "cli") return "cli";
  if (client === "sdk") return "sdk";
  if (client.startsWith("daemon")) return "daemon";
  return "other";
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

async function serializeOAuthClientForAgentApi(
  client: Awaited<ReturnType<typeof oauthService.listOAuthClients>>[number],
  serverId: string,
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
    // whenToUse is rendered verbatim into an agent system prompt; always run
    // it through the inert renderer, for every app type, so a bare @name can
    // never reach a daemon as a reference token.
    whenToUse: client.whenToUse
      ? renderThirdPartyInertText({ field: "when_to_use", value: client.whenToUse })
      : null,
    homepageUrl: client.homepageUrl ?? null,
    returnUrl: client.returnUrl ?? null,
    ...(client.setupUrl ? {
      setupUrl: client.setupUrl,
      setupDescription: client.setupDescription ? renderThirdPartyInertText({ field: "description", value: client.setupDescription }) : null,
      setup: await getAppInstallationSetup({ clientId: client.id, serverId }),
    } : {}),
    agentManifestUrl: agentManifest.url,
    agentManifestUrlSource: agentManifest.source ?? null,
    createdAt: client.createdAt.toISOString(),
    updatedAt: client.updatedAt.toISOString(),
    ...await oauthService.projectOfficialAppDiscoveryForAgent(client),
  };
}

async function serializeMarketplaceOAuthClientForAgentApi(
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
    ...(client.setupUrl ? { setupUrl: client.setupUrl, setupDescription: client.setupDescription ? renderThirdPartyInertText({ field: "description", value: client.setupDescription }) : null } : {}),
    agentManifestUrl: agentManifest.url,
    agentManifestUrlSource: agentManifest.source ?? null,
    allowedScopes: client.allowedScopes ?? [],
    logoUrl: client.logoUrl ?? null,
    installedOnServer: client.installedAt !== null,
    updatedAt: client.updatedAt.toISOString(),
    ...await oauthService.projectOfficialAppDiscoveryForAgent(client),
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

type AgentApiTaskChannelContext = {
  agent: NonNullable<Awaited<ReturnType<typeof agentService.getAgent>>>;
  channelId: string;
  storageChannelId: string;
  localChannel: TaskSurfaceChannel;
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  surface: TaskChannelSurface;
};

/** Null when the channel can't be used for tasks; the reason goes on the request span (o11y T1), the body is TASK_CHANNEL_NOT_FOUND_REFUSAL. */
async function resolveAgentApiTaskChannel(
  agentId: string,
  serverId: string,
  channelRef: string,
  res: Response,
): Promise<AgentApiTaskChannelContext | null> {
  const agent = await agentService.getAgent(agentId);
  if (!agent || agent.serverId !== serverId) {
    setRequestTraceErrorCode(res, "agent_not_found");
    return null;
  }
  const resolved = await channelService.resolveChannelByName(serverId, agentId, channelRef);
  if (!resolved) {
    setRequestTraceErrorCode(res, "channel_not_found");
    return null;
  }
  const surface = await resolveTaskChannelSurface(serverId, resolved.channelId);
  if (!surface) {
    setRequestTraceErrorCode(res, "task_channel_unavailable");
    return null;
  }
  return {
    agent,
    channelId: surface.localChannel.id,
    storageChannelId: surface.storageChannelId,
    localChannel: surface.localChannel,
    channelType: surface.localChannel.type,
    surface,
  };
}

/**
 * Task v2: `{ taskRef: "#channel:#7" }` for a task mutation's response when the
 * task talks in its own conversation (per-task mode, ../services/taskV2Mode:
 * a v2 task whatever the flag, any task where the initiating server has task
 * conversations on); the CLI then names the task by its ref. `{}` otherwise,
 * so flag-off responses for pre-v2 tasks keep their shape.
 */
async function agentApiTaskRefField(
  ctx: AgentApiTaskChannelContext,
  channel: string,
  task: { taskNumber: number } & TaskModeFields,
): Promise<{ taskRef?: string }> {
  if (!taskUsesOwnConversation(task, await isTaskV2ConversationsEnabled(ctx.localChannel.serverId))) return {};
  const taskRef = formatAgentTaskRef(channel, task.taskNumber);
  return taskRef ? { taskRef } : {};
}

/** The credential's agent was deleted, or moved to another server (401 `agent_not_found`). */
function refuseAgentGone(res: Response): void {
  refuse(res, 401, { code: "agent_not_found", error: "The agent this credential belongs to no longer exists on this server: use the credential of an agent that does." });
}

function refuseTaskChannelNotFound(res: Response): void {
  refuseKeepingTraceReason(res, 404, TASK_CHANNEL_NOT_FOUND_REFUSAL);
}

/** A task route called without an agent's own credential (401 `invalid_principal`). */
const AGENT_CREDENTIAL_REQUIRED_REFUSAL: RefusalInput = {
  code: "invalid_principal",
  error: "Task requests need an agent's own credential: send this request with the agent's API key.",
};

/** Another agent's lounge, which only its own agent takes part in (403 `agent_lounge_outsider`; the sentence is agentLoungeService's). */
const AGENT_LOUNGE_OUTSIDER: RefusalInput = { code: "agent_lounge_outsider", error: AGENT_LOUNGE_OUTSIDER_REFUSAL };

function refuseTaskNotFound(res: Response, channel: string, taskNumber: number): void {
  refuse(res, 404, taskNotFoundRefusal(channel, taskNumber));
}

/** A task's history or amendment refused because it is a pre-canonical task card (`task_legacy_card`). */
function taskLegacyCardRefusal(taskNumber: number, action: "amend" | "history"): RefusalInput {
  return {
    code: "task_legacy_card",
    error: action === "amend"
      ? `Task #${taskNumber} is a legacy task card, which can't be amended: create a new task with the title and description you want instead.`
      : `Task #${taskNumber} is a legacy task card, which keeps no change history: read the task in its channel's task list instead.`,
  };
}

/** An amendment the task service refused (409); its reasons are fixed strings (taskService.amendTask). */
function taskAmendRefusal(reason: string, channel: string, taskNumber: number): RefusalInput {
  switch (reason) {
    case "task not found":
      return taskNotFoundRefusal(channel, taskNumber);
    case "legacy task cards cannot be amended":
      return taskLegacyCardRefusal(taskNumber, "amend");
    case taskService.TASK_AMEND_MEMBERSHIP_ERROR:
      return { code: "channel_membership_required", error: "You can amend tasks only in a channel you are a member of and can post in: join this channel first." };
    case taskService.TASK_AMEND_STALE_REVISION_ERROR:
      return { code: "task_state_conflict", error: TASK_STATE_CONFLICT_ERROR };
    case taskService.TASK_AMEND_NO_CHANGES_ERROR:
      return { code: "task_amend_no_changes", error: `Task #${taskNumber} already has that title and description, so there is nothing to change.` };
    default:
      return { code: "task_amend_rejected", error: reason };
  }
}

/** A message the task service would not convert into a task (409); its reasons are fixed strings (taskService.convertMessageToTask). */
function taskConvertRefusal(reason: string): RefusalInput {
  if (reason === "already converted") {
    return { code: "already_converted", error: "That message is already a task, so it can't be converted again: work on the existing task instead." };
  }
  if (reason === "message not found" || reason === "message not in this channel") {
    return { code: "message_not_found", error: "There is no such message in this channel to convert: use the id of a message in the channel the task goes on." };
  }
  if (reason.startsWith("thread messages")) {
    return { code: "thread_target", error: "A thread's messages can't become tasks: create the task in the thread's channel instead." };
  }
  if (reason.startsWith("external projection messages")) {
    return { code: "external_message", error: "A message mirrored from another workspace can't become a task here: create a new task that describes the work instead." };
  }
  if (reason.startsWith("system messages")) {
    return { code: "system_message", error: "A system message can't become a task: if it describes something you should do, just do it; otherwise ignore it." };
  }
  return { code: "task_convert_rejected", error: reason };
}

function rejectAgentApiTaskWriteIfNeeded(canPost: boolean, res: Response): boolean {
  if (!canPost) {
    refuse(res, 403, TASK_MEMBERSHIP_REQUIRED_REFUSAL);
    return true;
  }
  return false;
}

function rejectHistoricalJointTaskWriteIfNeeded(
  surface: TaskChannelSurface,
  createdAt: Date | string,
  res: Response,
): boolean {
  if (!isHistoricalJointTaskReadOnly(surface, createdAt)) return false;
  refuse(res, 403, JOINT_TASK_READ_ONLY_REFUSAL);
  return true;
}

async function assertAgentApiTaskWritableChannel(
  ctx: AgentApiTaskChannelContext,
  agentId: string,
  res: Response,
  options: { threadRefusal: RefusalInput },
): Promise<boolean> {
  // A sub-conversation (a thread, a task's own conversation) holds no tasks.
  if (isSubConversationType(ctx.channelType)) {
    refuse(res, 409, options.threadRefusal);
    return false;
  }
  if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return false;
  if (await channelService.isChannelArchived(ctx.channelId)) {
    refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
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
  "detail",
  "occurredAt",
  "occurred_at",
  "durationMs",
  "duration_ms",
  "toolUseId",
  "tool_use_id",
  "exitCode",
  "exit_code",
  "ok",
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
  // A subagent's event (ids and enums; validated at ingest).
  "subagent",
]);

const EXTERNAL_ACTIVITY_IGNORED_FIELD_REPORT_LIMIT = 20;

type ParsedExternalAgentActivityIngest = ExternalAgentActivityIngestRequest & {
  /** Unknown event field names stripped before ingest (bounded, for logs). */
  ignoredFields: string[];
};

function parseExternalAgentTurnEnded(value: unknown): ExternalAgentTurnEnded | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { snapshotId, outcome, shownUnreadTargets } = value as Record<string, unknown>;
  if (typeof snapshotId !== "string" || !snapshotId || snapshotId.length > 128) return null;
  if (!(AGENT_TURN_ENDED_OUTCOMES as readonly unknown[]).includes(outcome)) return null;
  if (!Array.isArray(shownUnreadTargets)) return null;
  return {
    snapshotId,
    outcome: outcome as AgentTurnEndedOutcome,
    shownUnreadTargets: shownUnreadTargets
      .filter((target): target is string => typeof target === "string" && target.length > 0 && target.length <= 512)
      .slice(0, AGENT_TURN_ENDED_MAX_SHOWN_TARGETS),
  };
}

function parseExternalAgentActivityIngest(body: unknown): ParsedExternalAgentActivityIngest | { error: string; code: string } {
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
  const events: ExternalAgentActivityEvent[] = [];
  const ignoredFields = new Set<string>();
  for (const event of candidate.events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return { error: "events must contain objects", code: "event_invalid" };
    }
    // Unknown fields are stripped, not rejected: a 400 fails the whole batch and
    // stalls the sender's cursor, so a newer bridge adding a field would stop
    // all its activity. Only allowlisted fields reach ingest.
    const known: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
      if (FORBIDDEN_EXTERNAL_ACTIVITY_KEYS.has(key)) {
        return { error: "transcript_path is not accepted on activity ingest", code: "transcript_path_forbidden" };
      }
      if (ALLOWED_EXTERNAL_ACTIVITY_KEYS.has(key)) {
        known[key] = value;
      } else if (ignoredFields.size < EXTERNAL_ACTIVITY_IGNORED_FIELD_REPORT_LIMIT) {
        ignoredFields.add(key.slice(0, 64));
      }
    }
    events.push(known as ExternalAgentActivityEvent);
    // raft-agent-status.v1 fields. Legacy hook-outcome `status` values are
    // still accepted (and ignored for status) so existing bridges keep working.
    const { status, detail } = event as { status?: unknown; detail?: unknown };
    if (status !== undefined && !isRaftAgentStatus(status) && !isExternalAgentActivityLegacyStatus(status)) {
      return { error: `status must be one of ${RAFT_AGENT_STATUS_VALUES.join(", ")}`, code: "status_invalid" };
    }
    if (detail !== undefined && typeof detail !== "string") {
      return { error: "detail must be a string", code: "detail_invalid" };
    }
    if (typeof detail === "string" && detail.length > RAFT_AGENT_STATUS_DETAIL_LIMIT) {
      return { error: `detail cannot exceed ${RAFT_AGENT_STATUS_DETAIL_LIMIT} characters`, code: "detail_too_long" };
    }
  }
  // A malformed `turnEnded` is dropped like an unknown field, never the batch.
  const turnEnded = parseExternalAgentTurnEnded(candidate.turnEnded);
  if (candidate.turnEnded !== undefined && !turnEnded) ignoredFields.add("turnEnded");
  return {
    schema: EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
    events,
    ignoredFields: [...ignoredFields],
    ...(turnEnded ? { turnEnded } : {}),
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
  /**
   * Canonical send target of the pending message (`#name`, `#name:<8hex>`,
   * `dm:@peer[~kind]`, `dm:@peer:<8hex>`), the same string `/events`
   * `reply_target` and the CLI print and `/send` resolves. Null when the queued
   * message carries no conversation name to derive it from.
   */
  target: string | null;
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
    // Derived from the routing fields the queued message already carries
    // (channel/parent names, DM peer ref) -- no per-hint DB read.
    target: formatInboxMessageTarget(message),
    channel_id: channelId,
    channel_name: message.channel_name,
    channel_type: message.channel_type,
    wake_reason: queuedMessageReason(message),
  };
  if (message.attention_hint) hint.attention_hint = message.attention_hint;
  if (message.traceparent) hint.traceparent = message.traceparent;
  return hint;
}

/**
 * `login_required` refusals for which a connection card was actually raised or reused. The runtime
 * tells the model "a request is waiting for a human, do not retry" only when this says so: a call
 * without a valid origin (batched turns, steer, recovery replays, background work) raises NO card,
 * and telling that model to wait would leave it and the human both waiting on nothing (@Huarong).
 */
const loginRequiredWithConnectionCard = new WeakSet<object>();

/** Exported for its status test only; routes call it from the handlers below. */
export function sendManagedMcpAgentApiError(error: unknown, res: Response, context: { serverName?: string | null; toolName?: string | null; mcpServerId?: string | null; isCall?: boolean } = {}): void {
  // The agent-facing words for the common failures (managedMcpAgentErrors),
  // also as suggestedNextAction, which raft-sdk shows as the next action (it
  // never shows a raw `error`); anything else keeps its original message.
  const body = (code: string, message: string) => {
    // The span names the refusal too, so an MCP 503 splits by cause (unreachable, credential key, OAuth busy).
    setRequestTraceErrorCode(res, code);
    // A refusal the service already worded for the agent (call_tool's own misuse) keeps its words.
    const agentText = error instanceof ManagedMcpServiceError && error.agentFacing
      ? message
      : managedMcpAgentErrorMessage(code, context);
    return agentText ? { error: agentText, code, suggestedNextAction: agentText } : { error: message, code };
  };
  if (error instanceof ManagedMcpServiceError) {
    const status = error.code.endsWith("not_found") ? 404 : 409;
    res.status(status).json({
      ...body(error.code, error.message),
      ...(error.code === "managed_mcp_login_required"
        ? { connectionRequested: loginRequiredWithConnectionCard.has(error) }
        : {}),
    });
    return;
  }
  if (error instanceof ManagedMcpCredentialError) {
    res.status(503).json(body(error.code, error.message));
    return;
  }
  if (error instanceof ManagedMcpGatewayError) {
    // 503, not 502. The daemon reaches this route through Cloudflare, which replaces an origin's
    // 502 body with its own HTML page; the daemon then had no `code`, and the model could not tell
    // "unreachable, one later retry is reasonable" from a refusal that needs a human (@Huarong).
    // The daemon only checks `!response.ok`, so the status change is compatible with old daemons.
    res.status(error.code === "managed_mcp_unreachable" ? 503 : error.code === "managed_mcp_endpoint_blocked" ? 403 : 409).json(body(error.code, error.message));
    return;
  }
  if (error instanceof ManagedMcpOAuthError) {
    res.status(error.code === "managed_mcp_oauth_busy" ? 503 : 409).json(body(error.code, error.message));
    return;
  }
  // On a call, an unexpected failure can come after the remote tool ran: say so (same words as raft-sdk).
  setRequestTraceErrorCode(res, "managed_mcp_internal_error");
  if (context.isCall) {
    res.status(500).json({ error: MCP_CALL_INTERNAL_ERROR_TEXT, code: "managed_mcp_internal_error", suggestedNextAction: MCP_CALL_INTERNAL_ERROR_TEXT });
    return;
  }
  res.status(500).json({ error: "Managed MCP request failed", code: "managed_mcp_internal_error" });
}

/** Broadcast a profile refresh to every live bot bound to this app's
 * installations — install rows carry each bot's own serverId, so a bot on
 * another server still gets its room's event. */
async function broadcastManagedBotProfileUpdatesForClient(req: Parameters<typeof broadcastAgentUpdated>[0], clientDbId: string): Promise<void> {
  const botRows = await getDb()
    .select({ agentId: appBotBindings.agentId, serverId: oauthClientInstalls.serverId })
    .from(appBotBindings)
    .innerJoin(oauthClientInstalls, eq(oauthClientInstalls.id, appBotBindings.installId))
    .where(and(
      eq(oauthClientInstalls.clientId, clientDbId),
      eq(appBotBindings.state, "active"),
    ));
  for (const row of botRows) {
    broadcastAgentUpdated(req, row.serverId, row.agentId);
  }
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
      () => executeManagedMcpCall(req.serverId!, req.actingAgentId!, request)
        .catch(async (error: unknown) => {
          // ⭐ The production producer hook. `ensureMcpConnectionCard()` existed, was tested, and had
          // NO non-test caller -- so "a real refusal raises a card" was unreachable in the product
          // (@Huarong). This is the one place a real Agent MCP call learns it needs a Connection.
          //
          // Fires ONLY on `login_required`. A tool restriction is `tool_not_allowed` and must not
          // raise a Connect card: a Connection cannot widen `allowedTools`, so such a card could be
          // "completed" without unblocking anything and would regenerate on the next call.
          //
          // `origin` is the runtime's foreground turn. It is re-validated server-side
          // (`resolveMcpCallOrigin`: message exists, same server, acting Agent is a member); no
          // valid origin means NO card -- background work still gets the refusal, and a later call
          // carrying a real origin is what materialises it.
          if (error instanceof ManagedMcpServiceError && error.code === "managed_mcp_login_required") {
            try {
              // A refusal from a Raft Apps tool (`raft_app_tools` / `raft_app_call`) names the App it
              // was about; the card is that App's, never the reserved Raft Apps id's.
              const cardApp = error.app ?? { id: request.mcpServerId, configVersion: request.expectedConfigVersion };
              const card = await produceMcpConnectionCard({
                serverId: req.serverId!,
                agentId: req.actingAgentId!,
                mcpServerId: cardApp.id,
                // Admission already refused a stale `expectedConfigVersion` with `config_stale`, so
                // by here this equals the server's current revision.
                revision: cardApp.configVersion,
                ...(request.origin ? { origin: request.origin } : {}),
              });
              if (card.cardMessageId) loginRequiredWithConnectionCard.add(error);
            } catch {
              // Best-effort. The refusal is the contract; failing to post a card must never turn a
              // denial into a success, nor replace the caller's error with a card-plumbing one.
            }
          }
          throw error;
        }),
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
    const request = req.body as AgentApiRequestBodyByRoute["managedMcpCall"];
    const [named] = await getDb().select({ name: managedMcpServers.name }).from(managedMcpServers)
      .where(and(eq(managedMcpServers.id, request.mcpServerId), eq(managedMcpServers.serverId, req.serverId!)))
      .limit(1)
      .catch(() => []);
    // Through `call_tool`, a refusal of the App tool it named is about that tool.
    const toolName = error instanceof ManagedMcpServiceError && error.toolName ? error.toolName : request.toolName;
    sendManagedMcpAgentApiError(error, res, { serverName: named?.name ?? null, toolName, mcpServerId: request.mcpServerId, isCall: true });
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
      refuseAgentGone(res);
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
    sendJsonServerError(req, res, {
      error: "Failed to load agent identity",
      logPrefix: "internal.agent-api.whoami error:",
      err,
    });
  }
});

/**
 * POST /internal/agent-api/credentials/self/revoke
 *
 * The holder of an `sk_agent_*` key revokes that key, with the key itself as
 * proof of possession: only the credential that authenticated this request,
 * never another (there is no id to name one). It only removes access, so a
 * leaked key lets its finder do no more than kill that key. Needs no
 * capability: any live key may end itself.
 *
 * Only a key a person minted is self-revocable (isSelfRevocableAgentCredential):
 * a runner, cloud-runtime or App Bot key is managed by the system holding it,
 * so it is refused with 403 `credential_not_self_revocable` and stays live.
 *
 * Revokes with reason `self_revoked`, records `agent_credential.revoked` in the
 * same transaction (actor: the agent; ids only, never key material), then
 * closes the agent's open streams on every replica. The same key is then
 * refused at authentication (401) like any revoked key.
 *
 * Response 200: { revoked: true, credentialId }
 */
internalAgentApiRouter.post("/credentials/self/revoke", async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    const credentialId = req.agentCredentialId;
    if (req.principalKind !== "agent_credential" || !agentId || !serverId || !credentialId) {
      res.status(500).json({ error: "Agent credential state missing" });
      return;
    }
    const outcome = await getDb().transaction(async (tx) => {
      const result = await revokeAgentCredentialWithOutcome({
        credentialId, agentId, serverId, reason: SELF_REVOKED_REASON, selfRevocableOnly: true,
      }, { executor: tx });
      // A concurrent repeat with the same key revokes nothing, so it records nothing.
      if (result === "revoked") {
        await recordIntegrationAuditEvent({
          serverId,
          eventType: "agent_credential.revoked",
          outcome: "success",
          source: "api",
          actor: { type: "agent", id: agentId },
          subject: { type: "agent", id: agentId },
          target: { type: "agent_credential", id: credentialId },
          metadata: { agentId, credentialId, reason: SELF_REVOKED_REASON },
        }, tx);
      }
      return result;
    });
    if (outcome === "not_self_revocable") {
      addTraceEvent("agent_api.credentials.self_revoke.refused", { agent_id: agentId, server_id: serverId, credential_id: credentialId, reason: "credential_not_self_revocable" });
      refuse(res, 403, {
        code: "credential_not_self_revocable",
        error: "This credential is managed by the system that issued it (a Computer runner, a cloud runtime or an App), so it cannot revoke itself.",
      });
      return;
    }
    if (outcome !== "revoked" && outcome !== "already_revoked") {
      // Authenticated a moment ago, so it exists: only a concurrent agent delete gets here.
      refuse(res, 401, {
        code: "agent_credential_invalid",
        error: "This agent credential is no longer valid, so there is nothing left to revoke.",
      });
      return;
    }
    // After commit: close this agent's open streams of the revoked key on every replica now.
    await broadcastAgentCredentialRevocation(agentId);
    addTraceEvent("agent_api.credentials.self_revoked", { agent_id: agentId, server_id: serverId, credential_id: credentialId, reason: SELF_REVOKED_REASON });
    res.setHeader("Cache-Control", "no-store");
    res.json({ revoked: true, credentialId });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to revoke agent credential",
      logPrefix: "internal.agent-api.credentials.self-revoke error:",
      err,
    });
  }
});

/**
 * GET /internal/agent-api/server
 *
 * Agent-self equivalent of the legacy `/internal/agent/:id/server` route.
 * The acting agent is the credential-bound runner principal; there is no
 * URL `:id` to spoof.
 */
/**
 * The rollout flags a managed agent's Computer gets at start (AgentConfig
 * reminderApp / vaultApp / enabledApps), for agents that build their own
 * prompt, and the continuation pilot, which the CLI reads here when a send is
 * held (managed and external agents alike). An evaluation failure reads as
 * off, as it does at agent start.
 */
async function agentContextFeatures(
  serverId: string,
): Promise<{ reminderApp: boolean; vaultApp: boolean; taskConversations?: true; continuationsPilot?: true; enabledApps: string[] }> {
  // Task v2: present (true) only on a server with task conversations, so the
  // flag-off answer keeps its shape.
  let taskConversations = false;
  try {
    taskConversations = await isTaskV2ConversationsEnabled(serverId);
  } catch (error) {
    console.warn("[agent-context] task conversations flag evaluation failed; reporting off", serializeErrorForLog(error));
  }
  // The continuation pilot: likewise present (true) only while on.
  let continuationsPilot = false;
  try {
    continuationsPilot = (await evaluateFeatureFlag({ key: CONTINUATIONS_PILOT_FEATURE_FLAG_KEY, serverId })).enabled;
  } catch (error) {
    console.warn("[agent-context] continuations pilot flag evaluation failed; reporting off", serializeErrorForLog(error));
  }
  const presentWhileOn = {
    ...(taskConversations ? { taskConversations: true as const } : {}),
    ...(continuationsPilot ? { continuationsPilot: true as const } : {}),
  };
  // First-party apps on for the server (their registry ids),
  // beside the booleans older clients read; the Reminder and Vault apps stay on those.
  const enabledApps = await enabledFirstPartyAppIds(serverId, "agent-context");
  try {
    const [reminderApp, vaultApp] = await evaluateFeatureFlags([
      { key: REMINDER_APP_FEATURE_FLAG_KEY, serverId },
      { key: VAULT_APP_FEATURE_FLAG_KEY, serverId },
    ]);
    return { reminderApp: reminderApp?.enabled === true, vaultApp: vaultApp?.enabled === true, ...presentWhileOn, enabledApps };
  } catch (error) {
    console.warn("[agent-context] app rollout flag evaluation failed; reporting both off", serializeErrorForLog(error));
    return { reminderApp: false, vaultApp: false, ...presentWhileOn, enabledApps };
  }
}

// Identity bootstrap. A managed agent learns who it is from the standing
// system prompt its daemon builds; an external agent has no daemon, so it asks
// here. The prompt is the self-hosted-runner guide rendered by the same shared
// builder the daemon uses for the `raft-cli-overview` manual, filled with this
// agent's identity.
registerAgentApiRoute("agentContext", async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      refuseAgentGone(res);
      return;
    }
    const server = await serverService.getServer(serverId);
    if (!server) {
      refuse(res, 401, { code: "server_not_found", error: "The server this credential belongs to no longer exists: use the credential of an agent on a server that does." });
      return;
    }
    const external = isExternalAgentRuntime(agent.runtime);
    const serverRole = await getActorServerRoleInServer(serverId, "agent", actingAgentId);
    const { continuationsPilot, ...serverFeatures } = await agentContextFeatures(serverId);
    // The pilot stays off for a runtime it fails (codex), whatever the flag.
    const pilot = continuationsPilot && !CONTINUATIONS_DRAFT_FLOW_RUNTIMES.has(agent.runtime)
      ? { continuationsPilot }
      : {};
    // An assistant is told only about apps its credential can reach (its
    // routes are an allowlist): the others would refuse every call.
    const features = {
      ...serverFeatures,
      ...pilot,
      ...(agent.assistantOwnerUserId ? { enabledApps: serverFeatures.enabledApps.filter(assistantReachesApp) } : {}),
    };
    // An app's entry only for a client built with its commands (its guide-app
    // token at the entry's version): the entry names CLI commands, and an
    // older CLI lacks them.
    const guideApps = guideAppsForClient(features.enabledApps, req.header(RAFT_CLIENT_CAPABILITIES_HEADER));
    const prompt = external
      ? {
          audience: "self-hosted-runner" as const,
          text: buildRaftCliGuideMarkdown({
            handle: agent.name,
            displayName: agent.displayName || agent.name,
            description: agent.description,
            serverName: server.name,
            serverRole,
          }, {
            taskConversations: features.taskConversations === true,
            enabledApps: guideApps,
            // RFC 081: entries 1 and 13 teach `raft inbox read` only where inbox
            // items are on, and only to a CLI that declares it has the command.
            inboxItems: hasInboxItemsCapability(req.header(RAFT_CLIENT_CAPABILITIES_HEADER)) && await inboxItemsEnabled(serverId),
          }),
        }
      : null;
    sendAgentApiResponse("agentContext", res, {
      agent: {
        id: agent.id,
        name: agent.name,
        displayName: agent.displayName ?? null,
        description: agent.description ?? null,
        runtime: agent.runtime,
        external,
        assistantOf: await assistantService.describeAssistantOf(agent),
        ...(await hasRaftbenchReaderGrant(serverId, actingAgentId) ? { raftbenchReader: true as const } : {}),
        serverRole,
      },
      server: { id: server.id, slug: server.slug, name: server.name },
      credential: { capabilities: [...(req.agentCredentialScopes ?? [])] },
      prompt,
      features,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to load agent context",
      logPrefix: "internal.agent-api.context error:",
      err,
    });
  }
});

registerAgentApiRoute("serverInfo", async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      refuseAgentGone(res);
      return;
    }

    const listedChannels = await channelService.listChannelsForAgent(serverId, actingAgentId);
    // Channel announcements: `announcement` on each channel that can have one, only while channel_announcement_v0 is on.
    const announcements = await resolveChannelAnnouncementsOf({ type: "agent", id: actingAgentId, serverId: asServerId(serverId) }, listedChannels);
    const channels = listedChannels.map((channel) => ({
      ...withChannelAnnouncement(channel, announcements),
      id: asChannelId(channel.id),
    }));
    // Archived channels stay out of `channels` (every listing reads it); the
    // count tells the agent they exist, and `?archived=include` lists them.
    // Same visibility as `channels`: a private archived channel the agent is
    // not in is neither listed nor counted.
    const archivedChannels = req.query.archived === "include"
      ? (await channelService.listChannelsForAgent(serverId, actingAgentId, { scope: "archived" })).map((channel) => ({ ...channel, id: asChannelId(channel.id), archived: true as const }))
      : undefined;
    const archivedChannelCount = archivedChannels?.length ?? await channelService.countArchivedChannelsForAgent(serverId, actingAgentId);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const allAgents = await buildServerInfoAgentSummaries(serverId, agentOrchestrator);

    const humans = await buildServerInfoHumanSummaries(serverId, actingAgentId);
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

    sendAgentApiResponse("serverInfo", res, { runtimeContext, serverRole, serverCapabilities: getServerCapabilities(serverRole), channels, archivedChannelCount, ...(archivedChannels ? { archivedChannels } : {}), agents: allAgents, humans });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to get server info",
      logPrefix: "internal.agent-api.server error:",
      err,
    });
  }
});

// `raft user info`: one user's serverInfo entry and their memberships among one
// window of the caller's serverInfo channels, each decided exactly as the
// caller's roster read (`channelMembers` on `#<name>`) would decide it, except
// that a joint channel's roster, which spans every server's projection, is
// matched by the user's identity rather than by name, and that the caller's
// built-in app conversations are inspected and list no one. Each membership
// row is the channel's own facts plus the user's membership (`joined`, and
// their `channelRole` where channel roles exist), none of the caller's. It
// replaces serverInfo plus one roster per channel, so it is gated by both:
// the contract's `channels` capability and `channel:read` grant (channelMembers),
// and serverInfo's `read` capability and `server:read` grant, below.
registerAgentApiRoute(
  "userChannels",
  requireAgentCapability("read"),
  requireAgentGrant("server:read"),
  ...agentApiRequestValidators("userChannels"),
  async (req, res) => {
    try {
      const actingAgentId = req.actingAgentId!;
      const serverId = req.serverId!;
      const agent = await agentService.getAgent(actingAgentId);
      if (!agent || agent.serverId !== serverId) {
        refuseAgentGone(res);
        return;
      }
      const params = req.params as AgentApiRequestParamsByRoute["userChannels"];
      const query = req.query as AgentApiRequestQueryByRoute["userChannels"];
      const name = params.name.startsWith("@") ? params.name.slice(1) : params.name;
      const offset = Number(query.offset ?? 0);
      const limit = Number(query.limit ?? AGENT_API_USER_CHANNELS_DEFAULT_LIMIT);

      // serverInfo's lookup: exact name, agents before humans, the caller's directory.
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
      const agentMatch = await findServerInfoAgentSummaryByName(serverId, name, agentOrchestrator);
      const humanMatch = agentMatch ? null : await findServerInfoHumanSummaryByName(serverId, actingAgentId, name);
      const subjectId = agentMatch?.id ?? humanMatch?.id;
      if (!subjectId) {
        refuse(res, 404, { code: AGENT_API_USER_NOT_FOUND_CODE, error: "Not found, or you don't have access: nobody you can see on this server has that name, so check the name against who is on the server.", next: RAFT_HINTS.serverInfo() });
        return;
      }
      const kind = agentMatch ? "agent" as const : "human" as const;

      const channels = (await channelService.listChannelsForAgent(serverId, actingAgentId)).map((channel) => ({
        ...channel,
        id: asChannelId(channel.id),
      }));
      const window = channels.slice(offset, offset + limit);
      const rosters = await channelService.getChannelRosterNameMatchesForAgentWindow(serverId, actingAgentId, window, { kind, name, id: subjectId });
      // The roster route's human filter: the caller's hidden directory.
      const visibleHumans = new Set(await filterAgentVisibleHumansForHiddenDirectory(
        serverId,
        actingAgentId,
        rosters.flatMap((roster) => roster?.humans ?? []),
      ));
      // A membership row describes the channel and the subject's membership,
      // never the caller's (see userChannelMembershipRow).
      const uncheckedCount = rosters.filter((roster) => !roster).length;
      const memberships = window.flatMap((channel, index) => {
        const roster = rosters[index];
        if (!roster) return [];
        const listed = kind === "agent"
          ? roster.agents[0]
          : roster.humans.find((human) => visibleHumans.has(human));
        return listed ? [channelService.userChannelMembershipRow(channel, listed.channelRole)] : [];
      });

      const page = { total: channels.length, offset, limit };
      if (agentMatch) {
        sendAgentApiResponse("userChannels", res, { user: agentMatch.summary, kind: "agent", memberships, uncheckedCount, page });
      } else {
        sendAgentApiResponse("userChannels", res, { user: humanMatch!.summary, kind: "human", memberships, uncheckedCount, page });
      }
    } catch (err) {
      sendJsonServerError(req, res, {
        error: "Failed to get user channels",
        logPrefix: "internal.agent-api.user-channels error:",
        err,
      });
    }
  },
);

registerAgentApiRoute("serverUpdate", async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      refuseAgentGone(res);
      return;
    }

    const result = await updateServerProfileForAgent({
      actor: { id: agent.id, name: agent.name, serverId: agent.serverId },
      serverId,
      body: req.body,
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to update server",
      logPrefix: "internal.agent-api.server.update error:",
      err,
    });
  }
});

// Server Labs uses the same transactional service and role policy as the
// human Settings API. The credential scope is an additional transport gate;
// it never substitutes for owner/admin membership authorization.
// Labs keep their own body checks (stable codes such as invalid_enabled and
// invalid_lab_key); the contract supplies the capability and the response shape.
registerAgentApiRoute("serverLabs", validateAgentApiResponseMiddleware("serverLabs"), getAgentServerLabs);
registerAgentApiRoute("serverLabsAccess", validateAgentApiResponseMiddleware("serverLabsAccess"), patchAgentServerLabsAccess);
registerAgentApiRoute("serverLabEnrollment", validateAgentApiResponseMiddleware("serverLabEnrollment"), putAgentServerLabEnrollment);

internalAgentApiRouter.post("/server/avatar", requireAgentCapability("server"), requireAgentGrant("server:update"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      refuseAgentGone(res);
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
      audit: await agentServerProfileAudit({ id: agent.id, name: agent.name, serverId: agent.serverId }, server.id),
    });
    if (!updated) {
      refuse(res, 404, SERVER_GONE_FOR_AVATAR_REFUSAL);
      return;
    }
    res.json(updated);
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
      error: "Failed to upload avatar",
      logPrefix: "internal.agent-api.server.avatar error:",
      err,
    });
  }
});

registerAgentApiRoute("knowledgeGet", async (req, res) => {
  const actingAgentId = req.actingAgentId;
  const serverId = req.serverId;
  if (!actingAgentId || !serverId) {
    res.status(500).json({ error: "Agent credential state missing" });
    return;
  }
  await handleAgentKnowledgeGet(req, res, { agentId: actingAgentId, serverId });
});

// #wg-ax:#15: an agent searching or reading its own View Context, or another
// agent's through a View Context grant (agentContextQueryApi.ts).
const agentContextQueryLimiter = new AgentContextQueryRateLimiter();

for (const routeKey of ["contextSearch", "contextRead"] as const) {
  registerAgentApiRoute(routeKey, ...agentApiRequestValidators(routeKey), async (req, res) => {
    const actingAgentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!actingAgentId || !serverId) {
      res.status(500).json({ error: "Agent credential state missing" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const messageId = String(body.message_id);
    const query: AgentContextQuery = routeKey === "contextSearch"
      ? {
        kind: "search",
        query: String(body.query),
        limit: typeof body.limit === "number" ? body.limit : AGENT_CONTEXT_SEARCH_DEFAULT_LIMIT,
        offset: typeof body.offset === "number" ? body.offset : 0,
      }
      : {
        kind: "read",
        around: String(body.around),
        limit: typeof body.limit === "number" ? body.limit : AGENT_CONTEXT_READ_DEFAULT_LIMIT,
        page: typeof body.page === "number" ? body.page : 1,
      };
    try {
      await handleAgentContextQuery(req, res, { agentId: actingAgentId, serverId, messageId, query, limiter: agentContextQueryLimiter });
    } catch (err) {
      sendJsonServerError(req, res, { error: "Failed to read the context", logPrefix: `internal.agent-api.${routeKey} error:`, err });
    }
  });
}

registerAgentApiRoute("knowledgeSearch", async (req, res) => {
  const actingAgentId = req.actingAgentId;
  const serverId = req.serverId;
  if (!actingAgentId || !serverId) {
    res.status(500).json({ error: "Agent credential state missing" });
    return;
  }
  await handleAgentKnowledgeSearch(req, res, { agentId: actingAgentId, serverId });
});

/** Channel types that have a card (passive-AX `channel` resource): the listable ones, not DMs or threads. */
const CHANNEL_CARD_TYPES: ReadonlySet<string> = new Set(channelService.LISTABLE_CHANNEL_TYPES);

type ChannelCardRow = { id: string; name: string; type: string; description: string | null; archivedAt: Date | null };

function channelCardOf(row: ChannelCardRow): AgentApiChannelCard {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description ?? null,
    archived: row.archivedAt != null,
  };
}

/**
 * The channel whose card goes with `channel`: the channel itself, a thread's
 * parent channel, or a joint thread's local parent projection (its projection
 * has no parent message). Null for DMs and threads under them. The one rule
 * for both history reads and sends, so a card recorded on read passes a send.
 */
async function resolveChannelCardRow(
  channel: (ChannelCardRow & { parentMessageId?: string | null; parentChannelId?: string | null }) | null | undefined,
  serverId: string,
): Promise<ChannelCardRow | null> {
  if (!channel) return null;
  if (CHANNEL_CARD_TYPES.has(channel.type)) return channel;
  if (!isSubConversationType(channel.type)) return null;
  // Task conversation (task v2): every face stores its local parent channel.
  const parentChannelId = channel.type === "task"
    ? channel.parentChannelId ?? null
    : channel.parentMessageId
      ? (await messageService.getMessage(channel.parentMessageId))?.channelId ?? null
      : (await channelService.getJointThreadProjectionByLocalThread(channel.id, serverId))?.localParentChannelId ?? null;
  const parent = parentChannelId ? await channelService.getChannel(parentChannelId) : null;
  return parent && CHANNEL_CARD_TYPES.has(parent.type) ? parent : null;
}

/**
 * GET /internal/agent-api/history?channel=<ref>&limit=<n>&before=<id|seq>&after=<id|seq>&around=<id|seq>
 *
 * Channel history visible to the bound agent, inside the plan's history
 * window (services/historyWindow.ts), as the legacy `GET /internal/agent/:id/history` reads it.
 */
registerAgentApiRoute("historyRead", async (req, res) => {
  const historyQuery = validateAgentApiQuery("historyRead", req, res);
  if (!historyQuery) return;
  await serveAgentHistoryRead(req, res, historyQuery, null);
});

type AgentHistoryReadQuery = Pick<AgentApiHistoryQuery, "channel" | "before" | "after" | "around" | "limit" | "consume" | "unread">;

/**
 * One history read window (`historyRead`). `taskConversation` (task v2,
 * `taskRead`): the already-resolved local task conversation to read, named
 * by its task ref; without it the target is resolved from `channel`, and a
 * task ref there still reads the task's conversation (older CLIs copy it from
 * the delivery; the current CLI refuses it locally and uses `raft task read`).
 */
async function serveAgentHistoryRead(
  req: Request,
  res: Response,
  historyQuery: AgentHistoryReadQuery,
  taskConversationTarget: { channelId: string; ref: string } | null,
  /**
   * RFC 081 `inbox read` of a conversation: the page goes to `sink` instead
   * of the response (refusals still answer `res`), and is cut to `maxChars`
   * of content (always one message) before anything is marked read, so
   * exactly what is returned is consumed.
   */
  inboxRead?: { sink: ServeConversationReadSink; maxChars: number },
): Promise<void> {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const channelRef = historyQuery.channel;
    let taskConversation = taskConversationTarget;
    const limit = Math.min(Number(historyQuery.limit) || 50, 100);
    // `consume=false`: return the page without marking it read, for reads
    // whose output may never reach the model.
    const consume = historyQuery.consume !== "false";

    if (!channelRef) {
      refuse(res, 400, HISTORY_TARGET_REQUIRED_REFUSAL);
      return;
    }

    // `agent-event:<id8>` is not a channel: it is the address every rendered
    // third-party line already prints. `message check` hands the body over once
    // and consumes the cursor, so without this an agent that was woken by an
    // event can never get back to it (task #257).
    // Accepts the 8-hex short form the message line prints AND the full event
    // UUID, which a short address shared by two events names in its 409 (a
    // system app's body also carries it as `event_id: <uuid>`). Both are scoped
    // to the acting agent inside the query.
    const eventRef = taskConversation ? undefined : /^agent-event:([0-9a-fA-F]{8}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/
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
        // The full ids are named here (owner-scoped, see above): the event line
        // prints only the short address.
        // Each candidate is checked on its own, so five of them still fit.
        const candidateLabels = found.candidates.map((candidate) => `${candidate.id} (${candidate.createdAt})`);
        const candidates = candidateLabels.join(", ");
        refuse(res, 409, {
          code: "AMBIGUOUS_ID",
          error: sentenceQuoting(
            candidateLabels,
            `That 8-character event address matches more than one of your events: ${candidates}. Read one by its full id.`,
            "That 8-character event address matches more than one of your events: read one by its full id.",
          ),
          next: RAFT_HINTS.messageRead({ target: `agent-event:${found.candidates[0]!.id}` }),
        });
        return;
      }
      if (found.kind === "expired") {
        // Safe to distinguish: only ever reached for an event that IS yours, so it
        // tells you nothing you did not already have visibility of.
        refuse(res, 410, { code: "EXPIRED", error: "This app event has expired and is no longer kept." });
        return;
      }
      if (found.kind === "absent") {
        // Deliberately the SAME neutral body used for an invisible channel, and a
        // CONSTANT: echoing the requested id here would make two ids distinguishable
        // even while errorCode stayed identical. The span (never the caller) says which.
        setRequestTraceErrorCode(res, "third_party_event_not_found");
        refuseKeepingTraceReason(res, 404, AGENT_CHANNEL_NOT_FOUND_REFUSAL);
        return;
      }
      // The same content /events hands over: Raft's own system apps' as an ordinary message's, an external app's inert.
      // Asked for, an external app's payload is shown too, in the content (dm:@artin:#1).
      const [content] = await renderAgentFacingContents([found.message], actingAgentId, serverId);
      // RFC 081 §5 / D1: reading one event consumes it, on the server (an
      // external agent's read used to leave it unread; only the daemon
      // reported its own): its app item counts one fewer, and it is not woken
      // or redelivered again.
      await consumeReadAgentEvent(req, actingAgentId, found.message);
      res.json({
        messages: [oauthService.withThirdPartyEventPayloadShown(found.message, content!)],
        has_more: false,
        has_older: false,
        has_newer: false,
      });
      return;
    }

    // Task v2: a task ref (`#parent:#7`) reads the task's conversation. CLIs
    // from before task v2 copy that target from the delivery, or the
    // `replyTarget=#parent:#7:<msg>` they print for each row (the same
    // conversation, as on send); newer CLIs use `raft task read`, and the
    // response says so (`taskCommandHint`).
    let taskCommandHint: string | undefined;
    const readTaskRef = taskConversation ? null : taskRefOfMessageTarget(channelRef);
    if (readTaskRef) {
      const found = await resolveAgentTaskRefConversation(serverId, actingAgentId, readTaskRef, { create: false });
      if (found && typeof found === "object") {
        taskCommandHint = formatAgentTaskCommandHint(found.ref, "read");
        if (found.kind === "pending") {
          // Nobody has written to it yet (lazy): no discussion yet.
          sendAgentApiResponse("historyRead", res, {
            target: found.ref,
            messages: [],
            has_more: false,
            has_older: false,
            has_newer: false,
            last_read_seq: 0,
            model_seen_up_to_seq: null,
            ...(historyQuery.unread === "true" && { unread_after_seq: 0, read_through_seq: 0 }),
            taskCommandHint,
          });
          return;
        }
        taskConversation = { channelId: found.channelId, ref: found.ref };
      }
    }
    const resolved = taskConversation
      ? { channelId: taskConversation.channelId, type: "thread" as const }
      : await channelService.resolveChannelByName(serverId, actingAgentId, channelRef);
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
            setRequestTraceErrorCode(res, "thread_has_no_replies");
            refuseKeepingTraceReason(res, 404, {
              code: "NOT_FOUND",
              error: sentenceQuoting([String(threadShortId), String(baseRef)], `Message ${threadShortId} in ${baseRef} has no replies yet, so there is no thread to read: read the message itself instead.`, "That message has no replies yet, so there is no thread to read: read the message itself instead."),
              next: RAFT_HINTS.messageRead({ target: baseRef, around: { shown: threadShortId, id: threadShortId } }),
            });
            return;
          }
          // No anchor here. Covers both "no such message anywhere" and "it lives in
          // another channel" -- one body for both, so they cannot be told apart.
          setRequestTraceErrorCode(res, "thread_anchor_not_found");
          refuseKeepingTraceReason(res, 404, threadAnchorNotFoundRefusal(baseRef));
          return;
        }
      }
      // The parent channel itself is missing or invisible. Shared neutral body:
      // it must not distinguish "does not exist" from "you cannot see it".
      setRequestTraceErrorCode(res, threadShortId ? "thread_parent_channel_not_found" : "channel_not_found");
      refuseKeepingTraceReason(res, 404, AGENT_CHANNEL_NOT_FOUND_REFUSAL);
      return;
    }

    const channelId = resolved.channelId;
    const hasAccess = await channelService.canAgentAccessChannel(channelId, actingAgentId);
    if (!hasAccess) {
      refuse(res, 403, HISTORY_NOT_ACCESSIBLE_REFUSAL);
      return;
    }
    if (!await assistantConfinedToOwnerDm(req, channelId)) {
      setRequestTraceErrorCode(res, "assistant_outside_owner_dm");
      refuseKeepingTraceReason(res, 404, AGENT_CHANNEL_NOT_FOUND_REFUSAL);
      return;
    }

    const channel = await channelService.getChannel(channelId);
    const jointThreadProjection = isSubConversationType(channel?.type)
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
    // `unread=true` (`raft message read --unread`): start right after the
    // agent's read position, the one `raft inbox check` counts unread from.
    const unread = historyQuery.unread === "true";
    if (unread && (beforeAnchor || afterAnchor || around)) {
      refuse(res, 400, {
        code: "INVALID_ARG",
        error: "A read of unread messages always starts right after your read position, so it can't also take a before, after or around anchor: drop the anchor, or drop unread to read around it.",
        next: taskConversation
          ? RAFT_HINTS.taskRead({ ref: taskConversation.ref, unread: true })
          : RAFT_HINTS.messageRead({ target: channelRef, unread: true }),
      });
      return;
    }
    if (beforeAnchor && !isHistoryAnchorShape(beforeAnchor)) {
      refuseHistoryAnchor(res, channelRef, beforeAnchor, "invalid");
      return;
    }
    if (afterAnchor && !isHistoryAnchorShape(afterAnchor)) {
      refuseHistoryAnchor(res, channelRef, afterAnchor, "invalid");
      return;
    }
    // The plan's history window (services/historyWindow.ts): an agent reads
    // what a person on this server sees, no further back. `hiddenThroughSeq`:
    // the newest seq behind it (0 when nothing is), never shown, so treated as
    // already read.
    const historyWindow = await getServerHistoryWindowForRead(serverId);
    const hiddenThroughSeq = await lastSeqBehindWindow(storageChannelId, historyWindow);
    // With what the window hides goes the offer of an upgrade card, where the
    // server allows one (#10999: null past Free or in a shared channel) and
    // the client can post it (else no hint at all). Not
    // for a task conversation, which is not a card target.
    const upgradeCardClient = { capabilities: req.header(RAFT_CLIENT_CAPABILITIES_HEADER), agentId: actingAgentId };
    const upgradeCardHint = (target: string) => taskConversation
      ? Promise.resolve(null)
      : agentUpgradeCardHint({ serverId, gate: "history_30d", target, channelId: projectionChannelId, client: upgradeCardClient });
    // `--before` / `--after` anchors are positions, not content: one behind
    // the window pages from there, and the window clips the page.
    const beforeResolution = beforeAnchor
      ? await messageService.resolveMessageSeqAnchor(storageChannelId, beforeAnchor, "pagination")
      : undefined;
    if (beforeResolution && !beforeResolution.ok) {
      refuseHistoryAnchor(res, channelRef, beforeAnchor!, beforeResolution.reason);
      return;
    }
    const afterResolution = afterAnchor
      ? await messageService.resolveMessageSeqAnchor(storageChannelId, afterAnchor, "pagination")
      : undefined;
    if (afterResolution && !afterResolution.ok) {
      refuseHistoryAnchor(res, channelRef, afterAnchor!, afterResolution.reason);
      return;
    }
    const beforeSeq = beforeResolution?.ok ? beforeResolution.seq : undefined;
    const lastReadSeq = await channelService.getAgentLegacyReadCursor(actingAgentId, channelId);
    const unreadAfterSeq = unread ? Math.max(0, Number(lastReadSeq) || 0) : undefined;
    const afterSeq = afterResolution?.ok ? afterResolution.seq : unreadAfterSeq;
    let rawMsgs;
    let hasOlder = false;
    let hasNewer = false;
    if (around) {
      if (!isHistoryAnchorShape(around)) {
        refuseHistoryAnchor(res, channelRef, around, "invalid");
        return;
      }
      const aroundResolution = await messageService.resolveMessageSeqAnchor(storageChannelId, around, "around", historyWindow.cutoff);
      if (!aroundResolution.ok) {
        // A message the window leaves out (every match of a short id, when
        // several) is said to be behind it, not missing. The second lookup is
        // in the channel whose access was resolved above.
        const anywhere = historyWindow.cutoff && aroundResolution.reason === "not_found"
          ? await messageService.resolveMessageSeqAnchor(storageChannelId, around, "around")
          : null;
        if (anywhere && (anywhere.ok || anywhere.reason === "ambiguous")) {
          const hint = await upgradeCardHint(channelRef);
          noteAgentHistoryBlock({ serverId, agentId: actingAgentId, reach: { conversationId: storageChannelId } });
          refuse(res, 404, { ...agentHistoryLimitedRefusal(historyWindow), ...(hint && { suggestedNextAction: hint }) });
          return;
        }
        refuseHistoryAnchor(res, channelRef, around, aroundResolution.reason);
        return;
      }
      const beforeCount = Math.floor((limit - 1) / 2);
      const afterCount = limit - beforeCount - 1;
      const context = await messageService.getMessageContextBySeq(
        storageChannelId,
        aroundResolution.seq,
        beforeCount,
        afterCount,
        historyWindow.cutoff,
        {
          forwardedBundleViewerAgentId: actingAgentId,
          viewerServerId: serverId,
          includeSenderTimezone: true,
        },
      );
      if (!context || context.channelId !== storageChannelId) {
        // A numeric `--around <seq>` resolves without a lookup: behind the
        // window, the context is empty there but not outside it.
        if (historyWindow.cutoff && aroundResolution.seq <= hiddenThroughSeq) {
          const hint = await upgradeCardHint(channelRef);
          noteAgentHistoryBlock({ serverId, agentId: actingAgentId, reach: { conversationId: storageChannelId } });
          refuse(res, 404, { ...agentHistoryLimitedRefusal(historyWindow), ...(hint && { suggestedNextAction: hint }) });
          return;
        }
        refuseHistoryAnchor(res, channelRef, around, "not_found");
        return;
      }
      rawMsgs = context.messages;
      hasOlder = context.hasOlder;
      hasNewer = context.hasNewer;
    } else {
      rawMsgs = await messageService.listMessages(storageChannelId, limit + 1, beforeSeq, afterSeq, historyWindow.cutoff, {
        forwardedBundleViewerAgentId: actingAgentId,
        viewerServerId: serverId,
        includeSenderTimezone: true,
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
    let pageMsgs = page.messages;
    hasOlder = page.hasOlder;
    hasNewer = page.hasNewer;
    if (inboxRead && pageMsgs.length > 0) {
      const budgeted = withinPageBudget(pageMsgs, (message) => message.content ?? "", inboxRead.maxChars);
      if (budgeted.length < pageMsgs.length) {
        pageMsgs = budgeted;
        hasNewer = true;
      }
    }
    // A `--before` page probes only older rows, so it always said "No newer"
    // although the anchor is a message the agent stepped back from.
    if (!around && beforeSeq !== undefined && afterSeq === undefined && !hasNewer) {
      hasNewer = await messageService.hasMessagesAtOrAfter(storageChannelId, beforeSeq, historyWindow.cutoff, {
        forwardedBundleViewerAgentId: actingAgentId,
        viewerServerId: serverId,
      });
    }
    // The read says why messages are missing (the CLI prints
    // `historyLimitMessage` in the window header): a read back to the start of
    // the window with older messages behind it, or a forward read (`--after`,
    // `--unread`) that started behind the window and skipped what it hides.
    const historyLimited = historyWindow.cutoff !== undefined && (afterSeq === undefined
      ? !hasOlder && await messageService.hasOlderMessages(storageChannelId, historyWindow.cutoff, beforeSeq)
      : hiddenThroughSeq > afterSeq);
    // Paging back (`--before`) into the window's start is an explicit reach
    // for older messages; a default page that touches it is not (C+ step 2).
    if (historyLimited && beforeSeq !== undefined && afterSeq === undefined && !around) {
      noteAgentHistoryBlock({ serverId, agentId: actingAgentId, reach: { conversationId: storageChannelId } });
    }

    let modelSeenUpToSeq: number | null = null;
    let readThroughSeq: number | null = null;
    // What this read does to the read position, decided here (the response
    // reports it) and run by commitReadPosition() only once the response has
    // passed its contract: a read that cannot answer leaves the page unread.
    const readPositionMoves: Array<() => Promise<void>> = [];
    const commitReadPosition = async (): Promise<void> => {
      for (const move of readPositionMoves) await move();
    };
    if (consume && !around && pageMsgs.length > 0) {
      const pageSeqs = pageMsgs
        .map((message) => Number(message.seq))
        .filter((seq) => Number.isInteger(seq) && seq > 0);
      const minSeq = pageSeqs.length > 0 ? Math.min(...pageSeqs) : 0;
      const maxSeq = pageSeqs.length > 0 ? Math.max(...pageSeqs) : 0;
      const priorReadSeq = Math.max(0, Number(lastReadSeq) || 0);
      // A read window may advance a high-water boundary only when it joins the
      // prior boundary without a hidden gap. Latest/before pages are safe when
      // they include the oldest row or overlap the prior cursor. An `after`
      // page is safe only when its exclusive anchor is at/below that cursor.
      // Otherwise the returned bodies remain useful exact-seq observations,
      // but must not consume earlier unseen messages outside the window.
      const canAdvanceModelSeen = afterSeq !== undefined
        ? afterSeq <= priorReadSeq
        : !hasOlder || minSeq <= priorReadSeq;
      if (maxSeq > 0 && canAdvanceModelSeen) {
        modelSeenUpToSeq = maxSeq;
        // Seq order is not commit order: a transaction holding seq 100 can
        // commit after one holding 101. Moving the read position to 101 the
        // moment 101 is visible would skip 100 forever (the next `--unread`
        // and `inbox check` both count from the read position). So the read
        // position only moves through the settled prefix of the page: rows
        // older than readPositionSettleMs(). Newer rows are still returned and
        // stay unread for now; a deferred check (below) moves the position
        // over them once the window has passed and no late lower seq appeared.
        readThroughSeq = settledReadThroughSeq(pageMsgs, Date.now() - readPositionSettleMs());
      }
      const markAgentRead = (seq: number) => channelService.markRead({ kind: "agent", id: actingAgentId }, channelId, seq).then((readState) =>
        emitScopeReadUpdated({
          io: req.app.get("io") as SocketServer | undefined,
          serverId,
          scopeId: channelId,
          peerKind: "agent",
          peerId: actingAgentId,
          maxReadSeq: readState.maxReadSeq,
          changed: readState.changed,
        })
      );
      if (readThroughSeq !== null && readThroughSeq > priorReadSeq) {
        const throughSeq = readThroughSeq;
        readPositionMoves.push(async () => {
          // An unread read is awaited: the next `--unread` must start after this
          // page, not race the write and return the same messages again.
          const marking = markAgentRead(throughSeq).catch(() => {});
          if (unread) await marking;
        });
      }
      if (maxSeq > 0 && canAdvanceModelSeen && maxSeq > Math.max(priorReadSeq, readThroughSeq ?? 0)) {
        const deferredFromSeq = Math.max(priorReadSeq, readThroughSeq ?? 0);
        readPositionMoves.push(async () => {
          scheduleDeferredReadAdvance({
            agentId: actingAgentId,
            channelId,
            fromSeq: deferredFromSeq,
            returnedSeqs: pageSeqs,
            // Inside the window, as the read was: hidden seqs are not a gap.
            listSeqs: async (fromSeq, toSeq) => (
              await messageService.listMessages(storageChannelId, DEFERRED_READ_ADVANCE_SCAN_LIMIT, toSeq + 1, fromSeq, historyWindow.cutoff)
            ).map((message) => Number(message.seq)).filter((seq) => Number.isInteger(seq) && seq > fromSeq && seq <= toSeq),
            advance: async (seq) => { await markAgentRead(seq); },
            record: (outcome, attrs) => recordTraceEvent("server.agent_api.history_read.deferred_advance", {
              outcome,
              agent_id: actingAgentId,
              channel_id: channelId,
              ...attrs,
            }),
          });
        });
      }
    }

    // An unread read whose read position was behind the window, with nothing
    // inside it yet: what the window hides can never be read, so the position
    // moves over it (or the inbox would count it unread forever).
    if (consume && unread && pageMsgs.length === 0 && hiddenThroughSeq > Math.max(0, Number(lastReadSeq) || 0)) {
      readThroughSeq = hiddenThroughSeq;
      readPositionMoves.push(async () => {
        const readState = await channelService.markRead({ kind: "agent", id: actingAgentId }, channelId, hiddenThroughSeq);
        void emitScopeReadUpdated({
          io: req.app.get("io") as SocketServer | undefined,
          serverId,
          scopeId: channelId,
          peerKind: "agent",
          peerId: actingAgentId,
          maxReadSeq: readState.maxReadSeq,
          changed: readState.changed,
        });
      });
    }

    // The agent's own messages are never unread for it: the inbox count and the
    // `/events` pull leave them out, and a send can leave the read position
    // below them (markAgentOwnSendRead). So `--unread` prints only others'
    // messages, while the read position above moved over the whole window, own
    // messages included, so the next `--unread` starts after them. A full page
    // followed only by own messages has no more unread.
    const ownSender = { senderType: "agent" as const, senderId: actingAgentId };
    // Task v2: chat messages list the tasks hanging under them (flag-on servers).
    // Each reaction names who reacted (handle and kind), for the reactions line of a read.
    const shownMsgs = await withAgentMessageReactions(await withAgentSourceTasks(unread
      ? pageMsgs.filter((message) => !(message.senderType === ownSender.senderType && message.senderId === ownSender.senderId))
      : pageMsgs, undefined, serverId));
    if (unread && hasNewer && pageMsgs.length > 0) {
      const pageLastSeq = Math.max(...pageMsgs.map((message) => Number(message.seq)));
      hasNewer = (await messageService.listMessages(storageChannelId, 1, undefined, pageLastSeq, historyWindow.cutoff, { excludeSender: ownSender })).length > 0;
    }

    const renderedContents = await agentPermalinkRenderService.renderAgentReadablePermalinksInTexts(
      shownMsgs.map((message) => message.content),
      serverId,
    );
    // Resolve the evidence key from the same authority that resolved this
    // request. Message envelopes intentionally omit channel identity fields,
    // so reconstructing a target from a rendered row can only guess (and in
    // CLI 0.0.28 guessed `#undefined`, collapsing every target together).
    let resolvedHistoryTarget = taskConversation
      ? taskConversation.ref
      : await channelService.resolveAgentFacingChannelRef(
        serverId,
        actingAgentId,
        projectionChannelId,
      );
    let dmHistoryScope = channel?.type === "dm";
    const cardChannel = await resolveChannelCardRow(channel, serverId);
    if (channel?.type === "thread" && channel.parentMessageId) {
      const parent = await messageService.getMessage(channel.parentMessageId);
      const parentChannel = parent ? await channelService.getChannel(parent.channelId) : null;
      dmHistoryScope = parentChannel?.type === "dm";
      const parentTarget = parent
        ? await channelService.resolveAgentFacingChannelRef(serverId, actingAgentId, parent.channelId)
        : null;
      if (parentTarget) {
        resolvedHistoryTarget = `${parentTarget}:${channel.parentMessageId.slice(0, 8)}`;
      }
    }
    const peerCard = dmHistoryScope ? await resolvePeerCard(serverId, actingAgentId, channel) : null;
    const historyBody: AgentApiHistoryResponse = {
      target: resolvedHistoryTarget ?? channelRef,
      ...(dmHistoryScope && channel && { consumption_scope: {
        agent_id: actingAgentId,
        channel_id: projectionChannelId,
        channel_type: channel.type as "dm" | "thread",
        target: resolvedHistoryTarget ?? channelRef,
      } }),
      messages: shownMsgs.map((message, index: number) =>
        toAgentApiMessageEnvelope(
          message,
          messageService.appendAgentFacingForwardedSnapshot(
            renderAgentCommentScopedContent(
              renderedContents[index] ?? "",
              message.commentRef,
            ),
            message.actionMetadata,
          ),
          actingAgentId,
        )
      ),
      has_more: hasOlder || hasNewer,
      has_older: hasOlder,
      has_newer: hasNewer,
      ...(historyLimited && {
        historyLimited: true,
        historyLimitMessage: [agentHistoryLimitNote(historyWindow), await upgradeCardHint(resolvedHistoryTarget ?? channelRef)]
          .filter(Boolean).join(" "),
      }),
      last_read_seq: lastReadSeq,
      model_seen_up_to_seq: modelSeenUpToSeq,
      ...(unreadAfterSeq !== undefined && {
        unread_after_seq: unreadAfterSeq,
        read_through_seq: Math.max(unreadAfterSeq, readThroughSeq ?? 0),
      }),
      ...(cardChannel && { channel_card: channelCardOf(cardChannel) }),
      ...(peerCard && { peer_card: peerCard }),
      ...(taskCommandHint && { taskCommandHint }),
    };
    // Checked, then marked read, then sent (prepareAgentApiResponse).
    const consumePage = async (): Promise<void> => {
      await commitReadPosition();
      recordAgentContextReturned({
        source: "history",
        agentId: actingAgentId,
        channelId: projectionChannelId,
        ...agentRequestContextFromHeaders(req.headers),
        seqs: shownMsgs.map((message) => message.seq),
      });
    };
    if (inboxRead) {
      const pageSeqs = pageMsgs.map((message) => Number(message.seq)).filter((seq) => Number.isInteger(seq) && seq > 0);
      await inboxRead.sink(historyBody, {
        storageChannelId,
        historyCutoff: historyWindow.cutoff,
        pageLastSeq: pageSeqs.length > 0 ? Math.max(...pageSeqs) : null,
        consumePage,
      });
      return;
    }
    const sendHistory = prepareAgentApiResponse("historyRead", res, historyBody);
    if (!sendHistory) return;
    await consumePage();
    sendHistory();
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to read history",
      logPrefix: "internal.agent-api.history error:",
      err,
    });
  }
}

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
registerAgentApiRoute("mentionsList", async (req, res) => {
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
    sendJsonServerError(req, res, {
      error: "Failed to load mentions",
      logPrefix: "internal.agent-api.mentions error:",
      err,
    });
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
      // refusal-ok: a mention-delivery diagnostic answers its own status shape, as on the human routes (servers.ts, messages.ts)
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
 * task #153 — GET /internal/agent-api/messages/:messageId/mention-deliveries
 *
 * The AUTHOR's view: for a message I sent, what happened to each target I
 * mentioned. This is the counterpart of `/mentions/:messageId/delivery`, which
 * is receiver-bound by design; without this the server knows a mention was
 * permanently lost and the only party who cannot find out is the one who sent it.
 *
 * Authority is authorship, and a non-author gets the SAME `404 NOT_JOINABLE`
 * shape a non-participant gets, so this cannot be used to probe whether someone
 * else's message exists.
 */
internalAgentApiRouter.get("/messages/:messageId/mention-deliveries", requireAgentCapability("mentions"), async (req, res) => {
  try {
    const messageId = typeof req.params.messageId === "string" ? req.params.messageId : "";
    if (!UUID_RE.test(messageId)) {
      // refusal-ok: a mention-delivery diagnostic answers its own status shape, as on the human routes (servers.ts, messages.ts)
      res.status(404).json({ status: "NOT_JOINABLE" });
      return;
    }
    const [message] = await getDb()
      .select({ senderType: messages.senderType, senderId: messages.senderId, channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    // Same body for "no such message" and "not yours": a distinguishable
    // response here would answer a question the caller is not entitled to ask.
    if (!message || message.senderType !== "agent" || message.senderId !== req.actingAgentId) {
      // refusal-ok: a mention-delivery diagnostic answers its own status shape, as on the human routes (servers.ts, messages.ts)
      res.status(404).json({ status: "NOT_JOINABLE" });
      return;
    }
    const rows = await mentionDeliveryOccurrenceService.listMentionDeliveryOccurrencesForMessage(messageId);
    // @Stone finding 1: identify the target by the handle the AUTHOR actually
    // wrote, not by whatever the agent is called today. The sender is
    // diagnosing a token they typed; if the target was renamed after the send,
    // the current name is a different string from the one they are looking for.
    // occurrenceId IS messageMentions.id, so this is an exact join, and
    // handleAtSendTime is notNull — no fallback to the live name is needed.
    const handles = new Map<string, string>();
    if (rows.length > 0) {
      const authored = await getDb()
        .select({ id: messageMentions.id, handleAtSendTime: messageMentions.handleAtSendTime })
        .from(messageMentions)
        .where(inArray(messageMentions.id, rows.map((row) => row.occurrenceId)));
      for (const mention of authored) handles.set(mention.id, mention.handleAtSendTime);
    }
    const serviceTargets = await getDb().select({ agentId: agents.id }).from(agents)
      .innerJoin(raftbenchConfigs, eq(raftbenchConfigs.agentId, agents.id))
      .where(inArray(agents.id, rows.map(row => row.agentId)));
    const serviceIds = new Set(serviceTargets.map(row => row.agentId));
    const deliveries = rows.map((row) => serviceIds.has(row.agentId)
      ? { targetHandle: handles.get(row.occurrenceId) ?? "", outcome: "lost" as const, reasonCategory: "unclassified" as const }
      : projectMentionDeliveryForSender(handles.get(row.occurrenceId) ?? "", mentionDeliveryOccurrenceService.evaluateMentionDeliveryOccurrence(row)));
    const dmPeers = await getDb().select({ agentId: agents.id, name: agents.name }).from(channels)
      .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
      .innerJoin(agents, eq(agents.id, channelAgents.agentId))
      .innerJoin(raftbenchConfigs, eq(raftbenchConfigs.agentId, agents.id))
      .where(and(eq(channels.id, message.channelId), eq(channels.type, "dm")));
    for (const peer of dmPeers) {
      if (!serviceIds.has(peer.agentId)) deliveries.push({ targetHandle: peer.name, outcome: "lost", reasonCategory: "unclassified" });
    }
    res.status(200).json({ messageId, deliveries });
  } catch (err) {
    console.error("internal.agent-api.sender-mention-deliveries error:", serializeErrorForLog(err));
    // LOOKUP_FAILED, not a verdict: "the query did not run" and "I read the rows
    // and they are broken" have opposite next actions. Same split the sibling
    // route already records.
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
    sendJsonServerError(req, res, {
      error: "Failed to load pending mention actions",
      logPrefix: "internal.agent-api.mention-actions.pending error:",
      err,
    });
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
      refuse(res, 400, { code: "mention_action_invalid", error: "A mention action is either notify or add." });
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
      refuse(res, 400, { code: "mention_resolution_ids_required", error: "Name at least one mention resolution id: the ids your pending mentions list shows." });
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
    sendJsonServerError(req, res, {
      error: "Failed to execute mention action",
      logPrefix: "internal.agent-api.mention-actions.execute error:",
      err,
    });
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
    refuse(res, 400, EMOJI_INVALID_REFUSAL);
    return;
  }

  const msgId = typeof req.params.msgId === "string" ? req.params.msgId : "";
  // Access (with the assistant's owner-DM confinement), then the plan's
  // history window (services/messageResourceAccess.ts).
  const access = await resolveMessageResourceAccess({
    messageId: msgId,
    serverId,
    actor: { type: "agent", id: actingAgentId, alsoRequire: (channelId) => assistantConfinedToOwnerDm(req, channelId) },
  });
  if (access.kind === "no_access") {
    setRequestTraceErrorCode(res, access.reason === "id_invalid" ? "message_id_invalid" : access.reason === "channel_not_found" ? "channel_not_found" : "message_not_found");
    res.status(access.status).json({ error: access.reason === "channel_not_found" ? "Channel not found" : access.error });
    return;
  }
  if (access.kind === "history_limited") {
    setRequestTraceErrorCode(res, "history_limited");
    refuseKeepingTraceReason(res, 404, agentHistoryLimitedRefusal(access.historyWindow));
    return;
  }
  // Post rights, archive, plan and the writer fence go by the agent's own
  // server's copy (a Joint Channel's projection); the reaction lands on the
  // stored message every copy shows (routes/messages.ts does the same for people).
  const { message, localChannelId } = access;
  if (message.messageType === "system") {
    refuse(res, 400, SYSTEM_MESSAGE_NOT_REACTABLE_REFUSAL);
    return;
  }
  const canPost = await channelService.canAgentPostToChannel(localChannelId, actingAgentId);
  if (!canPost) {
    refuse(res, 403, REACTION_MEMBERSHIP_REQUIRED_REFUSAL);
    return;
  }
  try {
    await channelService.assertChannelNotArchived(localChannelId);
  } catch (err) {
    if (err instanceof channelService.ChannelArchivedError) {
      refuse(res, 409, REACTION_CHANNEL_ARCHIVED_REFUSAL);
      return;
    }
    throw err;
  }
  const billingReadOnly = await getChannelBillingReadOnly(localChannelId, serverId);
  if (billingReadOnly) {
    setRequestTraceErrorCode(res, "channel_read_only");
    refuseKeepingTraceReason(res, 403, channelBillingReadOnlyRefusal(billingReadOnly));
    return;
  }
  if (await isChannelReadOnlyByQuota(localChannelId, serverId)) {
    refuse(res, 403, REACTION_CHANNEL_READ_ONLY_REFUSAL);
    return;
  }

  await mutateMessageReaction({
    channelId: localChannelId,
    messageId: message.id,
    emoji,
    actor: { kind: "agent", id: actingAgentId },
    operation: mode,
    noticeDeliverer: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
    message,
  });

  const context = await messageService.getMessageContext(message.id, 0, 0, undefined, {
    forwardedBundleViewerAgentId: actingAgentId,
    viewerServerId: serverId,
    includeSenderTimezone: true,
  });
  const enriched = context?.messages[0];
  if (!enriched) {
    res.status(500).json({ error: "Failed to reload updated message" });
    return;
  }
  await emitProjectedMessageUpdate(req.app.get("io"), message, enriched, localChannelId, serverId);
  const projected = await projectUpdatedMessageForLocalChannel(message, enriched, localChannelId, serverId);
  const [withReactors] = await withAgentMessageReactions([projected]);
  res.json(toAgentApiMessageEnvelope(withReactors ?? projected, projected.content, actingAgentId));
}

registerAgentApiRoute("messageReactionAdd", ...agentApiRequestValidators("messageReactionAdd"), validateAgentApiResponseMiddleware("messageReactionAdd"), async (req, res) => {
  try {
    await handleReaction(req, res, "add");
  } catch (err) {
    if (err instanceof ChannelConversionInProgressError) {
      res.status(err.status).json({ error: err.message, code: err.code, conversionEpoch: err.conversionEpoch });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to add reaction",
      logPrefix: "internal.agent-api.reactions.add error:",
      err,
    });
  }
});

registerAgentApiRoute("messageReactionRemove", ...agentApiRequestValidators("messageReactionRemove"), validateAgentApiResponseMiddleware("messageReactionRemove"), async (req, res) => {
  try {
    await handleReaction(req, res, "remove");
  } catch (err) {
    if (err instanceof ChannelConversionInProgressError) {
      res.status(err.status).json({ error: err.message, code: err.code, conversionEpoch: err.conversionEpoch });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to remove reaction",
      logPrefix: "internal.agent-api.reactions.remove error:",
      err,
    });
  }
});

// ---------------------------------------------------------------------------
// RFC 082 §4.2: PUT /messages/:messageId/card, the sender replacing its card
// message's card and fallback. Three steps: the checks (flag, sender, window,
// conversation, card), the limits (messageCardService.admitMessageCardUpdate,
// across replicas, spent only by an update the checks passed), the write
// (messageCardService.applyMessageCardUpdate: one transaction), then
// `message:updated` after the commit, the Slack edit's emitter. A retry under
// an `idempotencyKey` that already committed answers before all of them
// (messageCardService.findCommittedMessageCardUpdate). Notifies no one: no
// mention, inbox item, push or wakeup.

type CheckedMessageCardUpdate = {
  messageId: string;
  card: MessageCard;
  content: string;
  /** False when `content` is derived from the card: a replay under the key compares the card alone (RFC 082 §4.2). */
  senderWroteContent: boolean;
  /** A Joint Channel's card: what the write's lockJointPostingAuthority takes (messageCardConversation.ts). */
  jointPostingAuthorityChannelId: string | null;
  /** The message's stored channel the checks ran on: the write refuses a message moved since. */
  storageChannelId: string;
};

function refuseMessageCardUpdate(res: Response, status: number, body: { error: string; code: string; [key: string]: unknown } | (AgentApiRateLimitedBody & { retry_after: number })): void {
  addTraceEvent("agent_api.message_card_update.refused", { code: body.code, status });
  setRequestTraceErrorCode(res, body.code);
  res.status(status).json(body);
}

/** The update the checks let through, or null when they answered. */
async function checkMessageCardUpdate(req: Request, res: Response, body: AgentApiRequestBodyByRoute["messageCardUpdate"]): Promise<CheckedMessageCardUpdate | null> {
  const actingAgentId = req.actingAgentId!;
  const serverId = req.serverId!;
  // One answer for every message the caller may not update: not the sender
  // (another agent, a message it cannot see), older than the window,
  // deleted or retracted, not a card message, a conversation it can no
  // longer post in, a malformed or unknown id. A revoked credential or App
  // bot binding never gets here (agent API auth: 401).
  const notFound = () => {
    refuseMessageCardUpdate(res, 404, MESSAGE_CARD_NOT_FOUND_BODY);
    return null;
  };
  // The conversation it is updated through (messageCardConversation.ts): its
  // own, or, for a Joint Channel's card (stored in canonical storage), this
  // credential's Server's own projection of it. Every check below runs on that
  // conversation, as a send there checks it.
  const access = await resolveCardMessageForSender({
    messageId: typeof req.params.messageId === "string" ? req.params.messageId : "",
    serverId,
    agentId: actingAgentId,
    alsoRequire: (channelId) => assistantConfinedToOwnerDm(req, channelId),
  });
  if (!access) return notFound();
  const { message, conversation } = access;
  const conversationId = conversation.conversationId;
  if (message.senderType !== "agent" || message.senderId !== actingAgentId || message.deletedAt
    || !isMessageCardMetadata(message.actionMetadata) || !withinMessageCardUpdateWindow(message.createdAt)) {
    return notFound();
  }
  if (!await channelService.canAgentPostToChannel(conversationId, actingAgentId)) return notFound();
  // The sender's own message from here on: the refusals may say why.
  // A historical joint task's conversation, from a participant workspace, as a send there.
  if (await isTaskConversationReadOnly(serverId, conversation.conversation)) {
    refuseMessageCardUpdate(res, 403, { error: "Historical tasks are read-only from a participant workspace", code: "joint_task_read_only" });
    return null;
  }
  try {
    await channelService.assertChannelNotArchived(conversationId);
  } catch (err) {
    if (err instanceof channelService.ChannelArchivedError) {
      refuseMessageCardUpdate(res, 409, { error: "This channel is archived; its messages no longer change.", code: "channel_archived" });
      return null;
    }
    throw err;
  }
  // A plan limit's read-only (the free plan's external channel freeze), as on
  // send: a frozen channel's card does not change either (Tenny, #12644).
  const billingReadOnly = await getChannelBillingReadOnly(conversationId, serverId);
  if (billingReadOnly) {
    setRequestTraceErrorCode(res, "channel_read_only");
    refuseKeepingTraceReason(res, 403, channelBillingReadOnlyRefusal(billingReadOnly));
    return null;
  }
  if (await isChannelReadOnlyByQuota(conversationId, serverId)) {
    refuseMessageCardUpdate(res, 403, { error: "This channel is read-only on your current plan. Upgrade to continue.", code: "channel_read_only" });
    return null;
  }
  const prepared = prepareMessageCardUpdate({ card: body.card, content: body.content });
  if (!prepared.ok) {
    refuseMessageCardUpdate(res, prepared.refusal.status, prepared.refusal.body);
    return null;
  }
  // The limits, spent only now: past either, 429 with `retry_after` (seconds),
  // the agent API's RATE_LIMITED body and `Retry-After`.
  const budget = await admitMessageCardUpdate({ messageId: message.id, senderAgentId: actingAgentId });
  if (!budget.admitted) {
    const wait = `Wait ${budget.retryAfterSeconds} second${budget.retryAfterSeconds === 1 ? "" : "s"}, then run the same command again.`;
    res.setHeader("Retry-After", String(budget.retryAfterSeconds));
    refuseMessageCardUpdate(res, 429, {
      error: budget.scope === "message"
        ? `This card was updated too often: at most ${budget.limit} updates a minute per message. ${wait}`
        : `This agent updated cards too often: at most ${budget.limit} card updates an hour. ${wait}`,
      code: AGENT_API_RATE_LIMITED_CODE,
      retry_after: budget.retryAfterSeconds,
      details: { operation: "messageCardUpdate", limit: budget.limit, windowSeconds: budget.windowSeconds, retryAfterSeconds: budget.retryAfterSeconds },
    });
    return null;
  }
  return {
    messageId: message.id,
    card: prepared.card,
    content: prepared.content,
    senderWroteContent: prepared.senderWroteContent,
    jointPostingAuthorityChannelId: conversation.joint?.postingAuthorityChannelId ?? null,
    storageChannelId: message.channelId,
  };
}

registerAgentApiRoute(
  "messageCardUpdate",
  ...agentApiRequestValidators("messageCardUpdate"),
  validateAgentApiResponseMiddleware("messageCardUpdate"),
  async (req, res) => {
    try {
      const body = req.body as AgentApiRequestBodyByRoute["messageCardUpdate"];
      const idempotencyKey = idempotentAgentApiService.normalizeAgentApiIdempotencyKey(body.idempotencyKey);
      // The key's committed update answers before the checks: it stays
      // committed whatever changed since (the flag turned off, the 14 days
      // past, the limits spent, the sender's access to the conversation or
      // its side of a joint lost), so a refusal below only ever means this
      // attempt changed nothing, never that the first one did not land.
      let outcome = idempotencyKey
        ? await findCommittedMessageCardUpdate({
          messageId: typeof req.params.messageId === "string" ? req.params.messageId : "",
          senderAgentId: req.actingAgentId!,
          idempotencyKey,
          card: body.card,
          content: body.content,
        })
        : null;
      if (!outcome) {
        const checked = await checkMessageCardUpdate(req, res, body);
        if (!checked) return;
        outcome = await applyMessageCardUpdate({
          messageId: checked.messageId,
          senderAgentId: req.actingAgentId!,
          card: checked.card,
          content: checked.content,
          senderWroteContent: checked.senderWroteContent,
          expectedRevision: body.expectedRevision,
          idempotencyKey,
          jointPostingAuthorityChannelId: checked.jointPostingAuthorityChannelId,
          expectedChannelId: checked.storageChannelId,
        });
      }
      if (outcome.kind === "not_found") {
        refuseMessageCardUpdate(res, 404, MESSAGE_CARD_NOT_FOUND_BODY);
        return;
      }
      if (outcome.kind === "revision_conflict") {
        const current = outcome.currentRevision;
        refuseMessageCardUpdate(res, 409, {
          error: `The card is at revision ${current}, not ${body.expectedRevision}: it was updated since you read it, and nothing changed now. Read it again if you need to, then run the same command again with --expected-revision ${current}.`,
          code: MESSAGE_CARD_ERROR_CODES.revisionConflict,
          currentRevision: current,
          suggestedNextAction: `run the same command again with --expected-revision ${current}`,
        });
        return;
      }
      if (outcome.kind === "idempotency_conflict") {
        refuseMessageCardUpdate(res, 409, {
          error: "idempotencyKey was already used for an update of this card with a different card or content; nothing changed now. Use a new idempotencyKey for a different update.",
          code: "idempotency_key_reused",
          suggestedNextAction: "use a new idempotencyKey for a different update",
        });
        return;
      }
      addTraceEvent("agent_api.message_card_update.applied", { revision: outcome.answer.revision, replayed: outcome.replayed });
      // After the commit, to the conversation's connected clients (every local
      // projection, and the thread's parent preview): the Slack edit's emitter.
      // A replay changed nothing and emits nothing; an emit failure leaves the
      // update committed (clients that were away catch up through sync).
      const io = req.app.get("io") as SocketServer | undefined;
      if (!outcome.replayed && io) {
        await messageService.emitExternalLinkedMessageUpdateToFrontend(io, outcome.answer.messageId, { updateThreadPreview: true })
          .catch((err) => console.error("internal.agent-api.message-card.update emit failed:", serializeErrorForLog(err)));
      }
      sendAgentApiResponse("messageCardUpdate", res, outcome.answer);
    } catch (err) {
      sendJsonServerError(req, res, { error: "Failed to update the card", logPrefix: "internal.agent-api.message-card.update error:", err });
    }
  },
);

registerAgentApiRoute("channelJoin", ...agentApiRequestValidators("channelJoin"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      refuseAgentGone(res);
      return;
    }

    const channelId = typeof req.params.channelId === "string" ? req.params.channelId : "";
    const channel = await channelService.getChannel(channelId);
    // A channel the agent cannot see answers 404 whatever its type, exactly
    // like an id that does not exist (#wg-rbac B14).
    if (!channel || channel.serverId !== serverId || !await channelService.canAgentAccessChannel(channel.id, actingAgentId)) {
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
    if (await isLoungeOutsiderAgent(channel.id, actingAgentId)) {
      refuse(res, 403, AGENT_LOUNGE_OUTSIDER);
      return;
    }
    if (channel.archivedAt) {
      refuse(res, 409, JOIN_CHANNEL_ARCHIVED_REFUSAL);
      return;
    }
    // #all's audience is the whole server, not membership rows: there is
    // nothing to join and nothing to announce (same as the human route).
    if (channelService.isEnabledAllChannel(channel)) {
      sendAgentApiResponse("channelJoin", res, { ok: true });
      return;
    }
    const wasAgentMember = await channelService.isChannelAgent(channel.id, actingAgentId);
    if (wasAgentMember) {
      sendAgentApiResponse("channelJoin", res, { ok: true });
      return;
    }
    if (!await actorHasServerCapabilityInServer(serverId, "agent", actingAgentId, "joinPublicChannels")) {
      refuse(res, 403, SERVER_ROLE_CANNOT_JOIN_REFUSAL);
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
              causalActor: { type: "agent", id: actingAgentId },
            },
            // The joining agent should not see its own join as unread.
          },
        );
      }
    }
    req.app.get("io")?.to(`server:${serverId}`).emit("channel:members-updated", { channelId: channel.id });
    sendAgentApiResponse("channelJoin", res, { ok: true });
  } catch (err: any) {
    if (err instanceof Error && err.message === channelService.ASSISTANT_CHANNEL_FORBIDDEN_MESSAGE) {
      refuse(res, 403, { code: channelService.ASSISTANT_CHANNEL_FORBIDDEN_CODE, error: "A personal assistant can only be in its DM with its owner, so it can't join channels." });
      return;
    }
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
      refuseAgentGone(res);
      return;
    }

    const channelId = typeof req.params.channelId === "string" ? req.params.channelId : "";
    const channel = await channelService.getChannel(channelId);
    // A channel the agent cannot see answers 404 whatever its type, exactly
    // like an id that does not exist (#wg-rbac B14); the type refusals below
    // only speak about channels the agent can see.
    if (!channel || channel.serverId !== serverId || !await channelService.canAgentAccessChannel(channel.id, actingAgentId)) {
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

    const deleteIfLast = (req.body as AgentApiRequestBodyByRoute["channelLeave"]).deleteIfLast === true;
    const removal = await removeUnlessLastMember(() => channelService.removeAgent(channel.id, actingAgentId, undefined, undefined, deleteIfLast ? "delete" : "refuse"));
    if (!removal) {
      refuse(res, 409, lastMemberRefusal({ target: `#${channel.name}` }));
      return;
    }
    const { channelDeleted } = removal;
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
      ...(channelDeleted ? { channelDeleted: true as const } : {}),
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

registerAgentApiRoute("channelCreate", ...agentApiRequestValidators("channelCreate"), validateAgentApiResponseMiddleware("channelCreate"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      refuseAgentGone(res);
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
    sendJsonServerError(req, res, {
      error: "Failed to create channel",
      logPrefix: "internal.agent-api.channels.create error:",
      err,
    });
  }
});

registerAgentApiRoute("channelUpdate", ...agentApiRequestValidators("channelUpdate"), validateAgentApiResponseMiddleware("channelUpdate"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      refuseAgentGone(res);
      return;
    }

    const result = await updateChannelForAgent({
      actor: { id: agent.id, name: agent.name, serverId: agent.serverId },
      serverId,
      channelId: String(req.params.channelId),
      body: req.body,
      io: req.app.get("io") as SocketServer | undefined,
      agentOrchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to update channel",
      logPrefix: "internal.agent-api.channels.update error:",
      err,
    });
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
        refuseAgentGone(res);
        return;
      }

      const target = String((req.body as { target: string }).target);
      const resolved = await channelService.resolveChannelByName(serverId, actingAgentId, target);
      if (!resolved) {
        refuse(res, 404, AGENT_CHANNEL_NOT_FOUND_REFUSAL);
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
      sendJsonServerError(req, res, {
        error: `Failed to ${action} channel`,
        logPrefix: `internal.agent-api.channels.${action} error:`,
        err,
      });
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

registerAgentApiRoute("channelMemberAdd", ...agentApiRequestValidators("channelMemberAdd"), validateAgentApiResponseMiddleware("channelMemberAdd"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      refuseAgentGone(res);
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
    sendJsonServerError(req, res, {
      error: "Failed to add member",
      logPrefix: "internal.agent-api.channels.add-member error:",
      err,
    });
  }
});

registerAgentApiRoute("channelMemberRemove", ...agentApiRequestValidators("channelMemberRemove"), validateAgentApiResponseMiddleware("channelMemberRemove"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      refuseAgentGone(res);
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
    sendJsonServerError(req, res, {
      error: "Failed to remove member",
      logPrefix: "internal.agent-api.channels.remove-member error:",
      err,
    });
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
    if (state.changed) noteAgentChannelMuteChanged(serverId, channel.id);
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
    sendJsonServerError(req, res, {
      error: "Failed to mute channel activity",
      logPrefix: "internal.agent-api.channels.mute error:",
      err,
    });
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
    if (state.changed) noteAgentChannelMuteChanged(serverId, channel.id);
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
    sendJsonServerError(req, res, {
      error: "Failed to unmute channel activity",
      logPrefix: "internal.agent-api.channels.unmute error:",
      err,
    });
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
/**
 * An external agent's persisted messages from its durable inbox (see
 * messageService.pullExternalAgentInbox). A failed or unavailable pull yields
 * none: they are still unread and come on a later call.
 */
async function pullExternalAgentInboxMessages(
  agentOrchestrator: AgentOrchestrator,
  agentId: string,
  opts: Parameters<typeof messageService.pullExternalAgentInbox>[2],
): Promise<Extract<messageService.ExternalAgentInboxPull, { status: "pulled" }> | null> {
  try {
    const pulled = await messageService.pullExternalAgentInbox(agentOrchestrator, agentId, opts);
    return pulled.status === "pulled" ? pulled : null;
  } catch (err) {
    console.error(`internal.agent-api external agent inbox pull failed (${opts.route}):`, serializeErrorForLog(err));
    return null;
  }
}

/**
 * The pending items to serve. For an external agent (`durable` given):
 * persisted messages come only from the durable inbox pull, and the buffer
 * contributes only items with no durable row. Otherwise the buffer as is.
 */
function pendingAgentItems(
  buffered: AgentMessage[],
  durable: AgentMessage[] | undefined,
): { items: AgentMessage[]; staleBuffered: AgentMessage[] } {
  if (!durable) return { items: buffered, staleBuffered: [] };
  const bufferOnly = buffered.filter((message) => !isDurableAgentInboxMessage(message));
  const staleBuffered = buffered.filter((message) => isDurableAgentInboxMessage(message));
  return { items: [...bufferOnly, ...durable], staleBuffered };
}

async function collectDeliverableWakeHints(
  agentOrchestrator: AgentOrchestrator,
  actingAgentId: string,
  serverId: string,
  sinceSeq: number | null,
  limit: number,
  durable?: AgentMessage[],
): Promise<{ wakeHints: AgentApiWakeHint[]; hasMore: boolean }> {
  const { items: queued } = pendingAgentItems(agentOrchestrator.peekPendingMessages(actingAgentId), durable);
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
        refuse(res, 400, SINCE_SEQ_INVALID_REFUSAL);
        return;
      }
      sinceSeq = parsed;
    }

    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      refuseAgentGone(res);
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    // External agents: persisted messages are peeked from the durable inbox
    // (rate-limited per agent). No cursor moves here.
    const durable = isExternalAgentRuntime(agent.runtime)
      ? (await pullExternalAgentInboxMessages(agentOrchestrator, actingAgentId, { route: "wake_hints", slot: "wake_hints" }))?.messages ?? []
      : undefined;
    await rebuildPendingThirdPartyAgentEvents(agentOrchestrator, actingAgentId)
      .catch((err) => console.error("internal.agent-api third-party event rebuild failed:", serializeErrorForLog(err)));
    const { wakeHints, hasMore } = await collectDeliverableWakeHints(
      agentOrchestrator,
      actingAgentId,
      serverId,
      sinceSeq,
      limit,
      durable,
    );
    const newestHint = wakeHints[wakeHints.length - 1];

    res.json({
      wake_hints: wakeHints,
      last_hint_seq: newestHint?.seq ?? sinceSeq,
      has_more: hasMore,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to load wake hints",
      logPrefix: "internal.agent-api.wake-hints error:",
      err,
    });
  }
});

// Activity ingest intentionally uses read capability: the same minimal
// runner credential that can observe inbox state may report its own
// plugin-observed activity, while approve/send/write paths stay separate.
/**
 * An external agent's turn ended (`/activity` `turnEnded`): the first report for
 * the agent's current inbox snapshot consumes it; only `completed` marks read
 * the shown targets the snapshot holds that the agent owes nothing in
 * (unowedReadBacklog.ts). Another or an unknown snapshot changes nothing.
 */
async function settleExternalTurnEnded(
  agentId: string,
  serverId: string,
  turnEnded: ExternalAgentTurnEnded,
): Promise<{ outcome: "settled" | "skipped"; reason?: string; conversationCount?: number }> {
  const trace = (attrs: TraceAttributes) => recordTraceEvent("server.agent.external_turn_ended", {
    agent_id: agentId,
    server_id: serverId,
    turn_outcome: turnEnded.outcome,
    ...attrs,
  });
  const snapshot = await takeExternalTurnEndSnapshot(agentId, turnEnded.snapshotId);
  if (snapshot === null || snapshot === "mismatch") {
    const reason = snapshot === null ? "no_snapshot" : "stale_snapshot";
    trace({ outcome: "skipped", reason });
    return { outcome: "skipped", reason };
  }
  if (turnEnded.outcome !== "completed") {
    trace({ outcome: "skipped", reason: "not_completed" });
    return { outcome: "skipped", reason: "not_completed" };
  }
  const shown = shownSnapshotTargets(snapshot.targets, turnEnded.shownUnreadTargets);
  const settled = await settleUnowedReadBacklog(getDb(), agentId, shown.targets);
  trace({
    outcome: "settled",
    shown_target_count: shown.shownCount,
    ignored_target_count: shown.ignoredCount,
    conversation_count: settled.conversations,
    message_count: settled.messages,
    kept_conversation_count: settled.keptConversations,
  });
  return { outcome: "settled", conversationCount: settled.conversations };
}

internalAgentApiRouter.post("/activity", requireAgentCapability("read"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const parsed = parseExternalAgentActivityIngest(req.body);
    if ("error" in parsed) {
      refuse(res, 400, parsed);
      return;
    }

    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      refuseAgentGone(res);
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (typeof agentOrchestrator?.recordExternalAgentActivity !== "function") {
      res.status(503).json({ error: "Agent activity ingest is unavailable", code: "activity_ingest_unavailable" });
      return;
    }

    const { ignoredFields, turnEnded, ...ingest } = parsed;
    if (ignoredFields.length > 0) {
      console.warn(`[internal.agent-api.activity] agent ${actingAgentId}: ignored unknown event fields: ${ignoredFields.join(", ")}`);
    }
    const result = await agentOrchestrator.recordExternalAgentActivity(actingAgentId, ingest, serverId);
    const turnEndedResult = turnEnded ? await settleExternalTurnEnded(actingAgentId, serverId, turnEnded) : undefined;
    res.json({
      ok: true,
      ...result,
      ...(ignoredFields.length > 0 ? { ignoredFields } : {}),
      ...(turnEndedResult ? { turnEnded: turnEndedResult } : {}),
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to ingest activity",
      logPrefix: "internal.agent-api.activity error:",
      err,
    });
  }
});

/**
 * POST /internal/agent-api/third-party-events/delivered — task #175.
 *
 * A managed daemon answers `/events` from its Local Inbox and never forwards
 * that request, so the `/events` ack below never runs for the third-party
 * events it served. After writing such a response to the runtime, the daemon
 * reports the served event ids here. Idempotent by id (only queued/delivering
 * rows move to delivered) and scoped to the acting agent's own events.
 */
internalAgentApiRouter.post("/third-party-events/delivered", requireAgentCapability("read"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const rawIds: unknown = req.body?.eventIds;
    if (
      !Array.isArray(rawIds)
      || rawIds.length === 0
      || rawIds.length > THIRD_PARTY_EVENT_DELIVERED_REPORT_MAX_IDS
      || !rawIds.every(isThirdPartyEventId)
    ) {
      refuse(res, 400, {
        code: "event_ids_invalid",
        error: `eventIds is a list of 1 to ${THIRD_PARTY_EVENT_DELIVERED_REPORT_MAX_IDS} event ids, each an event's full UUID: send them in that form.`,
      });
      return;
    }
    const eventIds = [...new Set((rawIds as string[]).map((id) => id.toLowerCase()))];

    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      refuseAgentGone(res);
      return;
    }

    const delivered = await oauthService.markThirdPartyAgentEventsDelivered(eventIds, { agentId: actingAgentId });
    // The server buffer may still hold these seq-less entries (the daemon's
    // delivery ack carries seq 0, which clears nothing); drop them so they are
    // not served again by a later forwarded `/events`.
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    agentOrchestrator?.acknowledgeDeliveredMessages?.(actingAgentId, [], eventIds);
    await wakeForMergedSinceHandover(agentOrchestrator, actingAgentId, eventIds);
    res.json({ ok: true, delivered });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to record third-party event delivery",
      logPrefix: "internal.agent-api.third-party-events.delivered error:",
      err,
    });
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
      refuseAgentGone(res);
      return;
    }

    const sinceRaw = typeof req.query.since === "string" && req.query.since.trim() !== ""
      ? req.query.since.trim()
      : (typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : "");
    let lastSentSeq: number | null = null;
    if (sinceRaw && sinceRaw !== "latest") {
      const parsed = Number(sinceRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        refuse(res, 400, {
          code: "since_invalid",
          error: "since (or Last-Event-ID) is a message seq (a whole number, 0 or more) or latest: pass the seq of the last event you got, or latest.",
        });
        return;
      }
      lastSentSeq = parsed;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    // The stream lives for hours; its request span covers only the connection.
    // Each pull (the open one, every heartbeat, every wake) is its own root
    // trace that names the stream it came from: hanging them all on the
    // request span folded thousands of pulls into one trace (#proj-o11y task
    // #6). Wake and revocation callbacks also run in the context of whoever
    // fired them, so without their own root they would land in the sender's
    // or revoker's trace.
    const streamSpan = getCurrentTraceSpan();
    const streamContext = streamSpan?.context ?? null;
    const streamTracer = req.app.get("serverTracer") as Tracer | undefined;
    let tickOrdinal = 0;
    type StreamTickTrigger = "open" | "heartbeat" | "wake" | "wake_follow_up" | "revocation";
    const inStreamTickTrace = <T>(trigger: StreamTickTrigger, work: () => Promise<T>): Promise<T> =>
      withTraceRoot(streamTracer, "server.agent_api.wake_hints_stream.tick", {
        parent: null,
        surface: "server",
        kind: "internal",
        attrs: {
          trigger,
          tick_ordinal: ++tickOrdinal,
          ...(streamContext ? { stream_trace_id: streamContext.traceId, stream_span_id: streamContext.spanId } : {}),
          ...agentIdHashAttrs(actingAgentId),
          ...serverIdHashAttrs(serverId),
        },
      }, work);
    // A failed tick is already recorded on its own span; log it like the
    // flush does and keep the stream (and the process) running.
    const runStreamTick = (trigger: StreamTickTrigger, work: () => Promise<unknown>): void => {
      void inStreamTickTrace(trigger, work).catch((err) => {
        console.error("internal.agent-api.wake-hints-stream tick error:", serializeErrorForLog(err));
      });
    };

    // External agents: persisted messages are peeked from the durable inbox;
    // the latest pull is kept for this stream's flushes. No cursor moves here.
    const isExternal = isExternalAgentRuntime(agent.runtime);
    let durablePending: AgentMessage[] | undefined;
    const pullDurable = async (route: "wake_hints_stream_open" | "wake_hints_stream_flush", force: boolean) => {
      if (!isExternal) return;
      const pulled = await pullExternalAgentInboxMessages(agentOrchestrator, actingAgentId, { route, slot: "stream", force });
      if (pulled) durablePending = pulled.messages;
      durablePending ??= [];
    };
    await inStreamTickTrace("open", async () => {
      await pullDurable("wake_hints_stream_open", false);
      await rebuildPendingThirdPartyAgentEvents(agentOrchestrator, actingAgentId)
        .catch((err) => console.error("internal.agent-api third-party event rebuild failed:", serializeErrorForLog(err)));
    });

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    sharedSseStreamRegistry.register(res);

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
            durablePending,
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

    // Every flush pulls the durable inbox first (external agents only). A wake
    // signal (`force`) means something was just delivered — here or on
    // another replica (option C, #wg-external-agent 2026-06-11) — so it skips
    // the per-agent pull interval; heartbeat ticks respect it.
    const auditAndFlush = async (force: boolean): Promise<void> => {
      await pullDurable("wake_hints_stream_flush", force);
      await rebuildPendingThirdPartyAgentEvents(agentOrchestrator, actingAgentId)
        .catch((err) => console.error("internal.agent-api.wake-hints-stream third-party event rebuild failed:", serializeErrorForLog(err)));
      await flushHints();
    };

    // After a wake signal the chain may not have the message yet (see
    // EXTERNAL_WAKE_FOLLOW_UP_PULL_DELAYS_MS): pull again a bounded number of
    // times. A new signal replaces the pending follow-ups rather than stacking.
    let followUpTimers: ReturnType<typeof setTimeout>[] = [];
    const clearFollowUps = () => {
      for (const timer of followUpTimers) clearTimeout(timer);
      followUpTimers = [];
    };
    const onDelivered = (agentId: string) => {
      if (agentId !== actingAgentId) return;
      runStreamTick("wake", () => auditAndFlush(true));
      if (!isExternal) return;
      clearFollowUps();
      followUpTimers = messageService.externalWakeFollowUpPullDelaysMs().map((delayMs) => {
        const timer = setTimeout(() => {
          if (!closed) runStreamTick("wake_follow_up", () => auditAndFlush(true));
        }, delayMs);
        timer.unref?.();
        return timer;
      });
    };
    agentOrchestrator.on("external-inbox-delivered", onDelivered);

    // Heartbeat doubles as a server-side reconcile tick (field incident
    // 2026-06-11, #wg-external-agent:00fcc8f7): the live push path depends on
    // an IN-PROCESS orchestrator event (also fed cross-replica via the Redis
    // wake signal), and the periodic durable inbox pull remains the
    // correctness floor when both event layers miss. flushHints dedupes via
    // lastSentSeq and stays non-draining / zero-cursor, so a quiet tick
    // writes nothing.
    const heartbeatMs = Math.min(Math.max(Number(process.env.SLOCK_WAKE_STREAM_HEARTBEAT_MS) || 25_000, 250), 60_000);
    //
    // The credential was authenticated once, at open. Every tick re-validates
    // it (not revoked or expired, agent and server not deleted) before doing anything
    // on its behalf, and ends the stream when it no longer holds — so a
    // revoked credential or deleted agent loses the stream within one
    // heartbeat even if the revocation broadcast below is missed. A failed
    // check also ends the stream (fail closed); the client reconnects and
    // re-authenticates.
    const credentialId = req.agentCredentialId!;
    let unsubscribeRevocation: () => void = () => {};
    const cleanup = () => {
      closed = true;
      sharedSseStreamRegistry.unregister(res);
      clearInterval(heartbeat);
      clearFollowUps();
      agentOrchestrator.off("external-inbox-delivered", onDelivered);
      unsubscribeRevocation();
    };
    const credentialStillValid = async (): Promise<boolean> => {
      if (closed) return false;
      const state = await agentCredentialStreamState(credentialId).catch((err) => {
        console.error("internal.agent-api.wake-hints-stream credential check failed:", serializeErrorForLog(err));
        return "invalid" as const;
      });
      const active = state === "active";
      if (active || closed) return active && !closed;
      cleanup();
      // Connection-level: it ends the stream, so it stays on the stream's span.
      streamSpan?.addEvent("agent_api.wake_hints_stream.credential_invalidated", { agent_id: actingAgentId, credential_id: credentialId, reason: state });
      // An expired key (#wg-rbac:#27) is told apart, so its holder renews it
      // before reconnecting; a reconnect with it answers 401
      // agent_credential_expired either way.
      res.write(state === "expired"
        ? `event: credential-expired\ndata: {"code":"agent_credential_expired"}\n\n`
        : `event: credential-revoked\ndata: {"code":"credential_revoked"}\n\n`);
      res.end();
      return false;
    };
    // Each valid tick also counts as "seen" for presence (the open itself
    // already did, via the auth middleware), so a quiet but connected agent
    // stays online. Throttled per credential inside the recorder.
    const heartbeat = setInterval(() => {
      if (closed) return;
      runStreamTick("heartbeat", async () => {
        if (!(await credentialStillValid())) return;
        res.write(": ka\n\n");
        recordAgentApiSeen(req);
        await auditAndFlush(false);
      });
    }, heartbeatMs);
    heartbeat.unref?.();

    // Prompt close on revoke / agent delete: the writer broadcasts the
    // agentId to every replica after commit (replicaRouter
    // `broadcastAgentCredentialRevocation`); re-check this stream's
    // credential now instead of waiting for the next tick.
    unsubscribeRevocation = subscribeAgentCredentialRevocation(actingAgentId, () => {
      runStreamTick("revocation", credentialStillValid);
    });

    req.on("close", cleanup);

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
/** One line per wait_for that timed out with no rows: the requested since and each pair's conversation high-water. */
async function logAgentEventsWaitForEmpty(agentId: string, sinceSeq: number | null, pairs: readonly AgentEventsWaitPair[]): Promise<void> {
  try {
    const db = getDb();
    // One pair at a time (at most AGENT_EVENTS_WAIT_FOR_MAX_PAIRS): a log line
    // must not take a pool connection per pair. The route does not wait for it.
    const conversations: string[] = [];
    for (const pair of pairs) {
      const storageId = await channelService.getMessageStorageChannelIdWithExecutor(db, pair.targetId);
      const [row] = await db.select({ highWater: sql<string | null>`max(${messages.seq})::text` })
        .from(messages)
        .where(eq(messages.channelId, storageId));
      const readSeq = await channelService.getAgentLegacyReadCursor(agentId, pair.targetId);
      conversations.push(`${pair.targetId}:wait_seq=${pair.seq}:high_water=${row?.highWater ?? "none"}:read_seq=${readSeq}`);
    }
    console.warn(`internal.agent-api.events wait_for timed out with no rows: agent=${agentId} since=${sinceSeq ?? "latest"} ${conversations.join(" ")}`);
  } catch (err) {
    console.error("internal.agent-api.events wait_for empty log failed:", serializeErrorForLog(err));
  }
}

/**
 * GET /internal/agent-api/events?since=<seq|latest>&limit=<n>[&ack=cursor]
 *
 * RFC v0.8 — catch-up envelope. Returns messages delivered to the
 * bound agent since the given anchor, plus per-turn awareness fields:
 *   - last_seen_msgId      : delivery-batch tail id for client paging/debugging;
 *                            NOT a model-seen boundary for send freshness
 *   - last_seen_seq        : numeric cursor to pass back as `since`
 *   - reply_target         : canonical send target of the newest event
 *                            (e.g. `#general`, `#general:1a2b3c4d`, `dm:@alice`);
 *                            null when the batch is empty
 *   - pending_notice_ids   : transient system events queued for delivery
 *   - wake_reason          : placeholder until #164 lifecycle event RFC lands
 *   - ack_mode             : "cursor" | "immediate" — how this batch is acknowledged
 *
 * Slice-1 minimal contract: aggregates undelivered inbox entries via the
 * AgentOrchestrator. Designed to be the external-runtime equivalent of
 * the daemon's `agent:deliver` push channel.
 *
 * The `since` param accepts either a numeric `messageSeq` (canonical) or
 * the special string `"latest"` (return whatever is currently queued
 * without claiming an anchor). If a UUID/short id is passed, v0.8
 * returns 400; msg-id resolution is a later slice.
 *
 * Acknowledgement. By default (`ack_mode: "immediate"`, every published
 * client) the returned batch is acknowledged before the response is sent, so a
 * response lost in transit loses its messages. With `ack=cursor` (external
 * agents), durable inbox rows are acknowledged on the NEXT request instead: a
 * cursor-mode request with `since=<seq>` acknowledges the rows the previous
 * cursor-mode response handed over with seq <= since, then returns the next
 * batch unacknowledged. A client that did not get a response repeats its old
 * `since` and receives the same rows again. Items with no durable row
 * (third-party app events) are still acknowledged immediately.
 *
 * Late rows (external agents; services/agentInboxLateRows.ts). A message
 * whose transaction committed after an /events ack had moved the read position
 * past its seq sits below the read position; each pull also returns such rows
 * (at most 100, then `has_more`), whatever `since` says. In cursor mode they are
 * acknowledged only by a `since` at or above the cursor of the response that
 * carried them; a response carrying only late rows (all below `since`) returns
 * `last_seen_seq` = since + 1 so that cursor still moves.
 *
 * `wait_for=<target_id>:<seq>[,...]` (external agents; at most 20 pairs):
 * the pairs of the latest push notice (each target's `channelId` and
 * `latestSeq`). Before acking or pulling, the route waits for the inbox chain
 * to hold each pair (200, 400, 800, ... ms re-checks of just those rows, up to
 * AGENT_EVENTS_WAIT_FOR_CHAIN_MAX_MS, default 6 s; skipped while RisingWave is
 * overloaded or the process has its cap of waiters), then answers as without
 * it. A pair still behind adds `has_more: true` and `retry_after_ms`, a
 * backoff from `wait_attempt` (the client's prior retries for this notice):
 * min(1000 * 2^attempt, 8000), 8000 when RisingWave was spared. See
 * routes/agentEventsWaitFor.ts.
 */
registerAgentApiRoute("events", async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const eventsQuery = validateAgentApiQuery("events", req, res);
    if (!eventsQuery) return;
    const sinceRaw = eventsQuery.since?.trim() ?? "";
    const limit = Math.min(Math.max(Number(eventsQuery.limit) || 50, 1), 200);
    const ackRaw = typeof eventsQuery.ack === "string" ? eventsQuery.ack.trim() : "";
    if (ackRaw && ackRaw !== "cursor" && ackRaw !== "immediate") {
      refuse(res, 400, { code: "ack_invalid", error: "ack is cursor or immediate: use one of those, or leave it out." });
      return;
    }

    let sinceSeq: number | null = null;
    if (sinceRaw && sinceRaw !== "latest") {
      const parsed = Number(sinceRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        refuse(res, 400, SINCE_SEQ_INVALID_REFUSAL);
        return;
      }
      sinceSeq = parsed;
    }
    const waitFor = parseAgentEventsWaitFor(eventsQuery.wait_for);
    if (!waitFor.ok) {
      refuse(res, 400, { code: "wait_for_invalid", error: waitFor.error });
      return;
    }
    const waitAttempt = parseAgentEventsWaitAttempt(eventsQuery.wait_attempt);
    if (!waitAttempt.ok) {
      refuse(res, 400, { code: "wait_attempt_invalid", error: waitAttempt.error });
      return;
    }

    const agent = await agentService.getAgent(actingAgentId);
    if (!agent || agent.serverId !== serverId) {
      refuseAgentGone(res);
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const isExternal = isExternalAgentRuntime(agent.runtime);
    // wait_for: let the chain catch up to the notice before anything else (no
    // ack, no pull yet, no connection held). Only external agents are served
    // from the chain; for others there is nothing to wait for.
    let waited: AgentEventsWaitResult = { outcome: "none", waitedMs: 0, checks: 0, unsatisfied: [] };
    if (isExternal && waitFor.pairs.length > 0) {
      const aborted = new AbortController();
      const onClose = () => aborted.abort();
      res.once("close", onClose);
      try {
        // A notice target is untrusted input, not proof of access. Otherwise
        // the target-latest fallback reveals private/foreign activity through
        // has_more, retry_after_ms and the time spent waiting, even with no
        // agent inbox row. Invisible and missing targets are both ignored.
        const visible = await canView(
          { type: "agent", id: actingAgentId, serverId: serverId as ServerId },
          waitFor.pairs.map((pair) => ({ kind: "conversation", channelId: pair.targetId })),
        );
        waited = await waitForAgentInboxChain({
          agentId: actingAgentId,
          pairs: waitFor.pairs.filter((_pair, index) => visible[index]),
          sinceSeq,
          signal: aborted.signal,
        });
      } finally {
        res.off("close", onClose);
      }
      // The client left while we waited: acknowledge and hand over nothing.
      if (aborted.signal.aborted) return;
    }
    // Cursor acknowledgement applies to the durable inbox, which only external
    // agents are served from.
    const cursorAck = isExternal && ackRaw === "cursor";
    // The previous cursor-mode response's rows up to `since` were received:
    // acknowledge them before pulling, so the pull starts after them.
    const cursorAckedSeqs = new Set<number>();
    if (cursorAck && sinceSeq !== null) {
      const { acked, advances } = await acknowledgeAgentInboxEventsCursor(agentOrchestrator, actingAgentId, sinceSeq);
      for (const seq of acked) cursorAckedSeqs.add(seq);
      // Record what this ack passed under the previous batch's snapshot (late rows: agentInboxLateRows.ts).
      await commitAgentInboxLatePending(actingAgentId, { since: sinceSeq, advances });
    }
    // External agents: persisted messages come only from the durable inbox
    // pull (oldest first per conversation); the buffer serves only items with
    // no durable row. The pull itself moves no cursor; the ack below does.
    const pulled = isExternal
      ? await pullExternalAgentInboxMessages(agentOrchestrator, actingAgentId, { route: "events", slot: "events" })
      : null;
    // Late rows sit at or below the read position (and so below a client's
    // `since`): they are exactly what the agent has not received, even when a
    // repeated since just acknowledged them by seq.
    const lateSeqs = new Set((pulled?.late?.handed ?? []).map((row) => row.seq));
    // A pull already in flight may predate the cursor ack above.
    const durable = isExternal
      ? (pulled?.messages ?? []).filter((m) => !cursorAckedSeqs.has(m.seq ?? -1) || lateSeqs.has(m.seq!))
      : undefined;
    const durableSeqs = new Set((durable ?? []).map((m) => m.seq));
    const rebuiltEventIds = await rebuildPendingThirdPartyAgentEvents(agentOrchestrator, actingAgentId)
      .catch((err) => {
        console.error("internal.agent-api third-party event rebuild failed:", serializeErrorForLog(err));
        return new Set<string>();
      });

    // Pull whatever the orchestrator has queued for this agent. Non-blocking
    // (block=false, timeoutMs=0) — v0.8 does NOT implement long-poll on
    // this surface; the external runtime is expected to poll on its own
    // cadence or layer a WS/SSE transport on top in a later slice.
    const abortController = new AbortController();
    const buffered = await agentOrchestrator.receiveMessages(
      actingAgentId,
      false,
      0,
      abortController.signal,
    );
    const { items: queued, staleBuffered } = pendingAgentItems(buffered, durable);
    // A persisted message left in an external agent's buffer (queued before
    // it was pulled-only) is dropped: the inbox pull is its only source.
    if (staleBuffered.length > 0) {
      agentOrchestrator.discardUndeliverableMessages(actingAgentId, staleBuffered);
    }
    const { deliverable: deliverableQueued, undeliverable: undeliverableQueued } =
      await partitionDeliverableInboxMessages(queued, actingAgentId, serverId, { guardedEventIds: rebuiltEventIds });
    if (undeliverableQueued.length > 0) {
      agentOrchestrator.discardUndeliverableMessages(actingAgentId, undeliverableQueued);
    }
    // Pulled rows that cannot be handed over are acked with the batch, as live
    // delivery would have dropped them; left unread they would be pulled again
    // on every call.
    const droppedDurableSeqs = [
      ...(pulled?.droppedSeqs ?? []).filter((seq) => !cursorAckedSeqs.has(seq) || lateSeqs.has(seq)),
      ...undeliverableQueued.filter((m) => durableSeqs.has(m.seq)).map((m) => m.seq!),
    ];

    // Apply `since` filter in memory. Slice-1 simplicity — once we have
    // a typed inbox cursor on the orchestrator we'll push this down. In cursor
    // mode `since` is an acknowledgement, not a filter, for durable rows: what
    // the pull returns is exactly what is unacknowledged, including older rows
    // of other conversations.
    const filtered = sinceSeq !== null
      ? deliverableQueued.filter((m) => {
          if (cursorAck && durableSeqs.has(m.seq)) return true;
          if (durableSeqs.has(m.seq) && lateSeqs.has(m.seq!)) return true;
          const seq = Number((m as { seq?: unknown }).seq);
          if ((!Number.isFinite(seq) || seq <= 0) && thirdPartyEventIdFromMessage(m) !== null) return true;
          return Number.isFinite(seq) && seq > sinceSeq!;
        })
      : deliverableQueued;
    const trimmed = filtered.slice(0, limit);
    // Refresh every persisted message id now, before rendering or
    // acknowledging. The projection throws on canonical/provenance failure so
    // this whole request exits with zero ack and the batch is kept for retry.
    const events = await projectAgentInboxEvents(trimmed, serverId, actingAgentId);
    // A personal assistant's turn triggers, as the server hands them over (a
    // WeChat one makes the turn's DM replies go back to WeChat; wechatTurn.ts).
    // Before any ack: if this throws, nothing is handed over and the batch
    // stays queued.
    if (req.actingAgentAssistantOwnerUserId && events.length > 0) {
      await recordAssistantTurnTriggers({
        agentId: actingAgentId,
        serverId,
        ownerUserId: req.actingAgentAssistantOwnerUserId,
        // App events' ids match no message (the service keeps only UUIDs).
        messageIds: events.flatMap((m) => typeof m.message_id === "string" ? [m.message_id] : []),
        idleObservedAtMs: typeof agentOrchestrator.getTurnIdleObservedAtMs === "function"
          ? await agentOrchestrator.getTurnIdleObservedAtMs(actingAgentId)
          : null,
      });
    }
    const ackSeqs = events
      .map((m) => Number((m as { seq?: unknown }).seq))
      .filter((seq): seq is number => Number.isInteger(seq) && seq > 0);
    // Only when the whole pull was returned: the ack takes the highest seq per
    // conversation, so a dropped row above a trimmed one would skip it.
    if (filtered.length === trimmed.length) ackSeqs.push(...droppedDurableSeqs);
    const ackMessageIds = events
      .filter((m) => !Number.isInteger(Number(m.seq)) || Number(m.seq) <= 0)
      .map((m) => typeof m.message_id === "string" ? m.message_id : "")
      .filter(Boolean);
    const ackedThirdPartyEventIds = events
      .map(thirdPartyEventIdFromMessage)
      .filter((id): id is string => id !== null);
    // Cursor mode: durable rows wait for the next request's `since`; the rest
    // (non-durable items) is acknowledged now, as before.
    const cursorPendingSeqs = cursorAck ? ackSeqs.filter((seq) => durableSeqs.has(seq) || droppedDurableSeqs.includes(seq)) : [];
    const immediateAckSeqs = cursorAck ? ackSeqs.filter((seq) => !cursorPendingSeqs.includes(seq)) : ackSeqs;
    if (cursorAck) {
      await recordAgentInboxEventsPendingAck(actingAgentId, cursorPendingSeqs);
    }
    if (immediateAckSeqs.length > 0 || ackMessageIds.length > 0) {
      // `/events` is the agent-api equivalent of legacy receive+receive-ack:
      // claim exactly the returned batch so `slock message check` does not
      // replay the same inbox forever when using an sk_agent_* credential.
      agentOrchestrator.acknowledgeDeliveredMessages(actingAgentId, immediateAckSeqs, ackMessageIds);
      // Handing messages over advances the agent's read position — the agent
      // counterpart of a human reading them — unless a daemon tracks what its
      // model actually saw (model-seen boundary) and reports that instead. An
      // external agent has no daemon: for it, receiving IS reading, by rule
      // (not by the absence of a machine). Freshness proof is separate; send
      // still requires `seenUpToSeq`.
      const readPositionFollowsModelSeen = !isExternal
        && typeof agentOrchestrator.hasMachineCapability === "function"
        && agentOrchestrator.hasMachineCapability(agent.machineId, DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY);
      if (!readPositionFollowsModelSeen && immediateAckSeqs.length > 0) {
        const advances = await channelService.markAgentLegacyAckCheckpoint(actingAgentId, immediateAckSeqs);
        // Record what this ack passed under the pull's snapshot (late rows: agentInboxLateRows.ts).
        if (!cursorAck && pulled?.late) {
          const acked = new Set(immediateAckSeqs);
          await recordAgentInboxAck(actingAgentId, {
            snapshot: pulled.late.snapshot,
            advances,
            lateHanded: pulled.late.handed.filter((row) => acked.has(row.seq)),
          });
        }
      }
    }
    if (ackedThirdPartyEventIds.length > 0) {
      await oauthService.markThirdPartyAgentEventsDelivered(ackedThirdPartyEventIds);
      await wakeForMergedSinceHandover(req.app.get("agentOrchestrator") as AgentOrchestrator | undefined, actingAgentId, ackedThirdPartyEventIds);
    }

    // last_seen_msgId echo: prefer the newest event's id in this delivery
    // batch; if empty, return null. This is a delivery cursor/debug echo,
    // NOT a model-seen boundary. Do not feed it into send freshness;
    // `/internal/agent-api/send` requires runtime-maintained `seenUpToSeq`.
    const newestEvent = events[events.length - 1];
    const lastSeenMsgId = newestEvent?.id ?? null;
    // In cursor mode the cursor must cover every pending row (the batch is
    // not in seq order across the buffer and the inbox, and dropped rows ride
    // along), so passing it back acknowledges the whole batch.
    let lastSeenSeq = cursorAck
      ? (cursorPendingSeqs.length > 0 ? Math.max(...cursorPendingSeqs, sinceSeq ?? 0) : sinceSeq)
      : newestEvent?.seq ?? sinceSeq;
    // A batch of late rows only (all below `since`) must still move the cursor:
    // the late rows are acknowledged only by a since at or above this response's,
    // so a client repeating its old since after losing this response gets them again.
    if (cursorAck && sinceSeq !== null && lastSeenSeq === sinceSeq && cursorPendingSeqs.some((seq) => lateSeqs.has(seq))) {
      lastSeenSeq = sinceSeq + 1;
    }
    if (cursorAck && pulled?.late) {
      await recordAgentInboxLatePending(actingAgentId, { snapshot: pulled.late.snapshot, late: pulled.late.handed.filter((row) => cursorPendingSeqs.includes(row.seq)), cursor: lastSeenSeq });
    }

    // reply_target hint: the canonical send target of the newest event (the
    // same `#name` / `#name:<8hex>` / `dm:@peer` / `dm:@peer:<8hex>` string the
    // CLI prints for it and `/send` resolves). Null when the batch is empty or
    // the newest event has no conversation (third-party app events).
    const replyTarget = newestEvent ? formatInboxMessageTarget(newestEvent) : null;

    // Conversations still unread beyond this batch; present while any remain.
    const inboxHint = pulled && pulled.remainingConversations > 0
      ? { unread_conversations: pulled.remainingConversations, command: "raft inbox check" as const }
      : null;

    // A pair the wait left unsatisfied counts as caught up if the pull found
    // its message after all (returned, or left for has_more paging); otherwise
    // the client is told to ask again.
    const stillBehind = unsatisfiedAfterPull(waited.unsatisfied, filtered);
    const retryAfterMs = stillBehind.length > 0 ? agentEventsRetryAfterMs(waited.outcome, waitAttempt.attempt) : null;
    // The wait ran out and the pull still returned nothing: a conversation whose
    // high-water is above `since` with no rows handed over is the signature of
    // a row lost below the read position, so log both.
    if (waited.outcome === "cap" && events.length === 0 && stillBehind.length > 0) {
      void logAgentEventsWaitForEmpty(actingAgentId, sinceSeq, stillBehind);
    }

    addTraceEvent("external_agent.events.check.finished", {
      body_result: events.length > 0 ? "returned" : "empty",
      returned_count: events.length,
      queued_count: queued.length,
      filtered_count: filtered.length,
      undeliverable_count: undeliverableQueued.length,
      is_external: isExternal,
      pulled_count: durable?.length ?? 0,
      since_seq: sinceSeq,
      ack_mode: cursorAck ? "cursor" : "immediate",
      cursor_acked_count: cursorAckedSeqs.size,
      wait_pairs: waitFor.pairs.length,
      wait_outcome: waited.outcome,
      waited_ms: waited.waitedMs,
      wait_checks: waited.checks,
      wait_attempt: waitAttempt.attempt,
      wait_unsatisfied_count: stillBehind.length,
    });

    sendAgentApiResponse("events", res, {
      events,
      last_seen_msgId: lastSeenMsgId,
      last_seen_seq: lastSeenSeq,
      reply_target: replyTarget,
      // Deprecated, always empty/null and read by no client. Still sent
      // because published CLIs/SDKs parse them as required; the contract
      // marks them optional so a later release can drop them.
      pending_notice_ids: [] as string[],
      wake_reason: null as string | null,
      // More to page: this response was trimmed to `limit`, or the durable
      // inbox pull itself stopped at one of its caps (per conversation, total,
      // conversations) with unread left behind.
      // ... or a wait_for pair the chain had not caught up to yet.
      has_more: filtered.length > trimmed.length || pulled?.truncated === true || retryAfterMs !== null,
      inbox_hint: inboxHint,
      ack_mode: cursorAck ? "cursor" : "immediate",
      // wait_for only: the chain is still behind a pair; ask again after this.
      ...(retryAfterMs !== null ? { retry_after_ms: retryAfterMs } : {}),
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to load events",
      logPrefix: "internal.agent-api.events error:",
      err,
    });
  }
});

/**
 * Inbox push registration for the bound External Agent (raft-agent-inbox.v2;
 * see services/agentInboxPushService). Gated on `read`: a push hands over
 * exactly what `GET /events` (a `read` route) would, and acknowledges it the
 * same way, so a credential that may drain its inbox may also have it pushed.
 * The receiver supplies the signing secret; it is stored encrypted and never
 * returned by any route.
 */
function sendAgentInboxPushError(res: Response, error: AgentInboxPushError): void {
  const status = error.code === "AGENT_NOT_EXTERNAL"
    ? 403
    : error.code === "AGENT_NOT_FOUND" || error.code === "CREDENTIAL_INACTIVE"
      ? 401
      : error.code === "PUSH_UNAVAILABLE"
        ? 503
        : 400;
  res.status(status).json({ error: error.message, code: error.code });
}

registerAgentApiRoute("pushWebhookStatus", async (req, res) => {
  try {
    res.json(await getAgentInboxPushStatus({ agentId: req.actingAgentId!, serverId: req.serverId! }));
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to load push webhook",
      logPrefix: "internal.agent-api.push-webhook.get error:",
      err,
    });
  }
});

/**
 * A personal assistant's push registration is set only by its runtime
 * provider (routes/runtimeProviderControl.ts) while its WeChat bridge flags
 * are on (an evaluation error counts as on), never with the agent's own
 * credential: whoever holds the registration decides where the assistant's
 * inbox notices go.
 */
async function refuseAgentManagedAssistantPush(req: Request, res: Response): Promise<boolean> {
  const ownerUserId = req.actingAgentAssistantOwnerUserId;
  if (!ownerUserId || !await isAssistantWeChatActive(req.serverId!, ownerUserId)) return false;
  addTraceEvent("agent_inbox_push.registration.refused", { reason: "provider_managed" });
  refuse(res, 403, {
    code: "push_registration_provider_managed",
    error: "A personal assistant's push registration is managed by its runtime provider, so it can't be changed here.",
  });
  return true;
}

registerAgentApiRoute("pushWebhookRegister", async (req, res) => {
  if (await refuseAgentManagedAssistantPush(req, res)) return;
  const body = req.body as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => key !== "url" && key !== "secret")) {
    refuse(res, 400, { code: "INVALID_BODY", error: "A push registration is a JSON object with exactly two fields, url and secret: send just those." });
    return;
  }
  const { url, secret } = body as { url?: unknown; secret?: unknown };
  try {
    const status = await putAgentInboxPushRegistration({
      agentId: req.actingAgentId!,
      serverId: req.serverId!,
      credentialId: req.agentCredentialId!,
      url,
      secret,
      configuredBy: "agent",
    });
    await recordIntegrationAuditEventBestEffort({
      serverId: req.serverId!,
      eventType: "agent_inbox_push.configured",
      outcome: "success",
      source: "api",
      actor: { type: "agent", id: req.actingAgentId! },
      subject: { type: "agent", id: req.actingAgentId! },
      target: { type: "agent_inbox_push_registration", id: req.actingAgentId! },
      metadata: { agentId: req.actingAgentId!, endpointOrigin: status.url ? new URL(status.url).origin : null, configuredBy: "agent", secretSet: true },
    });
    res.json(status);
  } catch (err) {
    if (err instanceof AgentInboxPushError) {
      sendAgentInboxPushError(res, err);
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to store push webhook",
      logPrefix: "internal.agent-api.push-webhook.put error:",
      err,
    });
  }
});

registerAgentApiRoute("pushWebhookDelete", async (req, res) => {
  if (await refuseAgentManagedAssistantPush(req, res)) return;
  try {
    const deleted = await deleteAgentInboxPushRegistration({ agentId: req.actingAgentId!, serverId: req.serverId! });
    if (deleted) {
      await recordIntegrationAuditEventBestEffort({
        serverId: req.serverId!,
        eventType: "agent_inbox_push.deleted",
        outcome: "success",
        source: "api",
        actor: { type: "agent", id: req.actingAgentId! },
        subject: { type: "agent", id: req.actingAgentId! },
        target: { type: "agent_inbox_push_registration", id: req.actingAgentId! },
        metadata: { agentId: req.actingAgentId!, configuredBy: "agent" },
      });
    }
    res.status(204).end();
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to delete push webhook",
      logPrefix: "internal.agent-api.push-webhook.delete error:",
      err,
    });
  }
});

type AgentApiAttachmentDownloadTarget = {
  attachment: ResolvedAttachment;
  storage: NonNullable<ReturnType<typeof getStorage>>;
  contentType: string;
  contentDisposition: string;
};

/**
 * The one auth + visibility resolution behind both agent attachment download
 * routes (`attachmentDownload` streams/redirects the bytes,
 * `attachmentDownloadUrl` returns the presigned URL), so they cannot diverge.
 * Both routes are registered with the same contract capability. A malformed,
 * missing, or unreadable id answers the same uniform 404; missing storage
 * answers 503. Returns null once it has answered. `logContext.attachment` is
 * the row the caller's error log may describe.
 */
async function resolveAgentApiAttachmentDownloadTarget(
  req: Request,
  res: Response,
  logContext: { attachment: (typeof attachments.$inferSelect & Partial<AttachmentObjectMetadata>) | null },
): Promise<AgentApiAttachmentDownloadTarget | null> {
  const attachmentId = getFullUuidParam(req.params.attachmentId);
  if (!attachmentId) {
    sendAttachmentDownloadUnavailable(res);
    return null;
  }
  const [projection] = await getDb()
    .select()
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .limit(1);
  if (!projection) {
    sendAttachmentDownloadUnavailable(res);
    return null;
  }
  logContext.attachment = projection;
  const readable = await resolveAgentReadableAttachment(projection, req.serverId!, req.actingAgentId!);
  const attachment = readable && await assistantConfinedToOwnerDm(req, readable.attachment.channelId) ? readable.attachment : null;
  if (!readable || !attachment) {
    sendAttachmentDownloadUnavailable(res);
    return null;
  }
  logContext.attachment = attachment;
  // After access: a file in a message behind the plan's history window.
  const historyWindow = await getServerHistoryWindowForRead(req.serverId!);
  if (await isAttachmentBehindWindow({ messageId: attachment.messageId, messageCreatedAt: readable.messageCreatedAt }, historyWindow)) {
    setRequestTraceErrorCode(res, "history_limited");
    noteAgentHistoryBlock({ serverId: req.serverId!, agentId: req.actingAgentId!, reach: { conversationId: attachment.channelId } });
    refuseKeepingTraceReason(res, 404, agentHistoryLimitedRefusal(historyWindow, "file"));
    return null;
  }
  const storage = getStorage();
  if (!storage) {
    res.status(503).json({ error: "File storage is not configured on this server" });
    return null;
  }
  return {
    attachment,
    storage,
    contentType: buildAttachmentResponseContentType(attachment.mimeType),
    contentDisposition: buildAttachmentContentDisposition(attachment.filename, attachment.mimeType),
  };
}

/**
 * Presigned GET for the target, valid AGENT_API_ATTACHMENT_DOWNLOAD_URL_TTL_SECONDS,
 * or null when the storage backend cannot presign (local disk). The URL is a
 * bearer capability: never log or trace it.
 */
function presignAgentApiAttachmentDownload(target: AgentApiAttachmentDownloadTarget): Promise<string> | null {
  if (!target.storage.getPresignedUrl) return null;
  return target.storage.getPresignedUrl(target.attachment.storageKey, {
    expiresIn: AGENT_API_ATTACHMENT_DOWNLOAD_URL_TTL_SECONDS,
    responseContentDisposition: target.contentDisposition,
    responseContentType: target.contentType,
  });
}

/**
 * Error log for the agent attachment routes: ids and row metadata plus the
 * error class only. The error message is left out on purpose because a
 * storage/presign failure may carry the signed URL.
 */
function logAgentApiAttachmentError(
  logPrefix: string,
  req: Request,
  attachment: (typeof attachments.$inferSelect & Partial<AttachmentObjectMetadata>) | null,
  err: unknown,
): void {
  console.error(logPrefix, {
    attachmentId: attachment?.id ?? req.params.attachmentId ?? null,
    channelId: attachment?.channelId ?? null,
    storageKey: attachment?.storageKey ?? null,
    sizeBytes: attachment?.sizeBytes ?? null,
    mimeType: attachment?.mimeType ?? null,
    filename: attachment?.filename ?? null,
    errorClass: errorClassOf(err),
  });
}

registerAgentApiRoute("attachmentDownload", ...agentApiRequestValidators("attachmentDownload"), async (req, res) => {
  const logContext: { attachment: (typeof attachments.$inferSelect & Partial<AttachmentObjectMetadata>) | null } = { attachment: null };
  try {
    const target = await resolveAgentApiAttachmentDownloadTarget(req, res, logContext);
    if (!target) return;
    const { attachment, storage, contentType, contentDisposition } = target;
    const presigning = presignAgentApiAttachmentDownload(target);
    if (presigning) {
      const presignedUrl = await presigning;
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
    logAgentApiAttachmentError("internal.agent-api.attachments error:", req, logContext.attachment, err);
    res.status(500).json({ error: "Failed to serve attachment" });
  }
});

// Download URL for runtimes that cannot take binary tool results (hosted
// agents): same resolution as attachmentDownload above, then the URL in a JSON
// body instead of a 302. A storage backend that cannot presign (local disk)
// answers 409 download_url_unavailable: the request is fine and the
// attachment readable, but this Server can only stream it, so the caller
// should switch to the binary route rather than retry (a 5xx would invite
// retries under the read retry policy).
registerAgentApiRoute(
  "attachmentDownloadUrl",
  ...agentApiRequestValidators("attachmentDownloadUrl"),
  async (req, res) => {
    const logContext: { attachment: (typeof attachments.$inferSelect & Partial<AttachmentObjectMetadata>) | null } = { attachment: null };
    try {
      const target = await resolveAgentApiAttachmentDownloadTarget(req, res, logContext);
      if (!target) return;
      // Stamp the expiry before minting so expiresAt never overstates the
      // URL's real lifetime.
      const expiresAt = new Date(Date.now() + AGENT_API_ATTACHMENT_DOWNLOAD_URL_TTL_SECONDS * 1000);
      const presigning = presignAgentApiAttachmentDownload(target);
      if (!presigning) {
        refuse(res, 409, AGENT_API_ATTACHMENT_DOWNLOAD_URL_UNAVAILABLE_RESPONSE);
        return;
      }
      const url = await presigning;
      const { attachment } = target;
      res.setHeader("Cache-Control", "private, no-store");
      sendAgentApiResponse("attachmentDownloadUrl", res, {
        url,
        expiresAt: expiresAt.toISOString(),
        filename: attachment.filename,
        mimeType: attachment.mimeType,
      });
    } catch (err) {
      if (res.destroyed || res.headersSent) return;
      logAgentApiAttachmentError("internal.agent-api.attachments.url error:", req, logContext.attachment, err);
      res.status(500).json({ error: "Failed to mint attachment download URL" });
    }
  },
);

// --- First-party apps (apps/firstPartyApps.ts): each app's agent API routes ---
// An app's mount registers contract routes; here they are validated, run and
// their answers written: JSON checked against the contract, bytes streamed
// with a sandboxing CSP, raw-body uploads, or an error code. Each operation
// checks its app's flag for the agent's server. A route whose JSON body is
// over the global limit is parsed first by a route-scoped parser (app.ts,
// firstPartyAppAgentApiLargeBodies), and only once the app's flag is on for
// the agent's server: off, the body is never read. Every route whose contract
// method isn't GET spends core's write budgets (AGENT_API_WRITE_BUDGET_ROUTES,
// services/agentApiWriteLimits.ts: per agent and per server, across
// replicas), which the app neither chooses nor can leave out: a write route
// with no class there refuses to mount. An app may set one client gate
// (AgentApiMount.clientGate: Artifacts' minimum CLI version), run ahead of
// all of that on each of its routes.

/** The write budget of an app's route: none for a GET; any other must have a class (the server doesn't start otherwise). */
function appWriteBudgetOf(routeKey: AgentApiRouteKey): RequestHandler | null {
  if (agentApiContract[routeKey].method === "GET") return null;
  const kind = AGENT_API_WRITE_BUDGET_ROUTES[routeKey];
  if (!kind) throw new Error(`first-party app route ${routeKey} writes but has no write budget class (AGENT_API_WRITE_BUDGET_ROUTES)`);
  return agentApiWriteBudget(kind, routeKey);
}

export type FirstPartyAppAgentApiLargeBody = {
  app: string;
  /** The app's server-scoped flag (FirstPartyApp.flag), checked before the body is read. */
  flag: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The full path, under /internal/agent-api. */
  path: string;
  maxBytes: number;
  /** The app's client gate (AgentApiMount.clientGate; passes when it set none), run right after agent auth. */
  clientGate: RequestHandler;
  /** The route's write budget (null for a GET; agentApiWriteBudget), run after the client gate, ahead of the flag and the parser. */
  limit: RequestHandler | null;
  /** The answer while the flag is off for the agent's server. */
  notEnabled: AppError;
  onBodyError(problem: "too_large" | "malformed"): AppError | null;
};

const firstPartyAppLargeBodies: FirstPartyAppAgentApiLargeBody[] = [];

/** The agent API routes whose JSON body apps parse with a larger limit (app.ts mounts their parsers). */
export function firstPartyAppAgentApiLargeBodies(): readonly FirstPartyAppAgentApiLargeBody[] {
  return firstPartyAppLargeBodies;
}

/** An app's refusal; one that is a plan paywall (AppError.paywallHit) is recorded as the agent's (no person). */
function sendAppError(req: Request, res: Response, error: AppError): void {
  noteAppPaywallHit(req, error.paywallHit, null);
  setRequestTraceErrorCode(res, error.body.code);
  if (error.rateLimiter) setRequestTraceRateLimiter(res, error.rateLimiter);
  if (error.retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(Math.max(0, Math.ceil(error.retryAfterSeconds))));
  res.status(error.status).json(error.body);
}

function agentApiCallOf<K extends AgentApiRouteKey>(app: FirstPartyApp, req: Request): AgentApiCall<K> {
  return {
    agent: { agentId: req.actingAgentId!, serverId: asServerId(req.serverId!) },
    params: req.params as AgentApiCall<K>["params"],
    query: req.query as AgentApiCall<K>["query"],
    body: req.body as AgentApiCall<K>["body"],
    // Notices a write sends go to agents through this app's orchestrator.
    noticeOutbox: appNoticeOutbox(app, req.app.get("agentOrchestrator") as AgentOrchestrator | undefined),
  };
}

const CLIENT_HEADER_MAX_CHARS = 128;

/** The client a request says it came from (AppAgentClient), by its headers; an empty or overlong value is none. */
function agentApiClientOf(req: Request): AppAgentClient {
  const header = (name: string): string | null => {
    const value = req.header(name)?.trim();
    return value && value.length <= CLIENT_HEADER_MAX_CHARS ? value : null;
  };
  return { kind: header("X-Raft-Client") ?? header("X-Slock-Client"), version: header(RAFT_CLIENT_VERSION_HEADER) };
}

/**
 * The handler of an app's client gate: asks the gate the app set (read per
 * request, so the order the app registers it in doesn't matter) about an
 * agent's request; its refusal is the answer, `private, no-store`, and a body
 * left unread closes the connection. Tagged `__agentApiClientGate` (the app's
 * id) for route walkers.
 */
function appClientGate(appId: string, gateOf: () => ((client: AppAgentClient) => AppClientRefusal | null) | null): RequestHandler {
  const handler: RequestHandler = (req, res, next) => {
    const gate = gateOf();
    const refusal = gate && req.actingAgentId ? gate(agentApiClientOf(req)) : null;
    if (!refusal) {
      next();
      return;
    }
    setRequestTraceErrorCode(res, refusal.body.code);
    res.setHeader("Cache-Control", "private, no-store");
    if (!req.readableEnded) res.setHeader("Connection", "close");
    res.status(refusal.status).json(refusal.body);
  };
  (handler as RequestHandler & { __agentApiClientGate?: string }).__agentApiClientGate = appId;
  return handler;
}

/**
 * An app mounts only its own agent API: a contract route whose path is
 * `/<id>` or under `/<id>/` (so `/internal/agent-api/<id>/…`). Another route
 * (a core one such as messageSend, or another app's) is refused when the
 * app's routes are mounted, at startup.
 */
function assertOwnAgentApiRoute(app: Pick<FirstPartyApp, "id">, routeKey: AgentApiRouteKey): void {
  const { path } = agentApiContract[routeKey];
  if (path === `/${app.id}` || path.startsWith(`/${app.id}/`)) return;
  throw new Error(`first-party app ${app.id} may mount only its own agent API routes (/internal/agent-api/${app.id}/…); ${routeKey} is ${path}`);
}

/** The agent API mount core hands an app's registration (exported for firstPartyApps.test.ts). */
export function agentApiMountOf(app: FirstPartyApp): AgentApiMount {
  // The app's client gate, ahead of everything else on each of its routes.
  let clientGate: ((client: AppAgentClient) => AppClientRefusal | null) | null = null;
  const gate = appClientGate(app.id, () => clientGate);
  // mountAgentApiRoute charges the route's write budget; a write without one is refused here, at startup.
  const mountAppRoute = (routeKey: AgentApiRouteKey, handlers: RequestHandler[]) => {
    appWriteBudgetOf(routeKey);
    mountAgentApiRoute(routeKey, handlers, [gate]);
  };
  return {
    clientGate(check) {
      clientGate = check;
    },
    json(routeKey, failure, run) {
      assertOwnAgentApiRoute(app, routeKey);
      mountAppRoute(routeKey, [...agentApiRequestValidators(routeKey), async (req, res) => {
        try {
          const result = await run(agentApiCallOf(app, req));
          if (result.kind === "error") {
            sendAppError(req, res, result);
            return;
          }
          res.setHeader("Cache-Control", "private, no-store");
          res.status(result.status ?? 200);
          sendAgentApiResponse(routeKey, res, result.body);
        } catch (err) {
          if (res.headersSent) return;
          console.error(`internal.agent-api.${routeKey} failed`, serializeErrorForLog(err));
          res.status(500).json({ error: failure });
        }
      }]);
    },
    // The body is raw bytes, read by the operation as a stream (the global
    // JSON parser leaves application/octet-stream alone). Refusals that leave
    // the body unread close the connection rather than drain it.
    upload(routeKey, failure, run) {
      assertOwnAgentApiRoute(app, routeKey);
      mountAppRoute(routeKey, [...agentApiRequestValidators(routeKey), async (req, res) => {
        try {
          const result = await run(agentApiCallOf(app, req), {
            contentType: req.headers["content-type"],
            contentLength: req.headers["content-length"],
            body: req,
          });
          if (result.kind === "error") {
            if (!req.readableEnded) res.setHeader("Connection", "close");
            sendAppError(req, res, result);
            return;
          }
          res.status(204).end();
        } catch (err) {
          if (res.headersSent) return;
          console.error(`internal.agent-api.${routeKey} failed`, serializeErrorForLog(err));
          if (!req.readableEnded) res.setHeader("Connection", "close");
          res.status(500).json({ error: failure });
        }
      }]);
    },
    // As `upload`, answered with JSON (checked against the contract).
    objectFileUpload(routeKey, failure, run) {
      assertOwnAgentApiRoute(app, routeKey);
      mountAppRoute(routeKey, [...agentApiRequestValidators(routeKey), async (req, res) => {
        try {
          const result = await run(agentApiCallOf(app, req), {
            contentType: req.headers["content-type"],
            contentLength: req.headers["content-length"],
            body: req,
          });
          if (!req.readableEnded) res.setHeader("Connection", "close");
          if (result.kind === "error") {
            sendAppError(req, res, result);
            return;
          }
          res.setHeader("Cache-Control", "private, no-store");
          res.status(result.status ?? 200);
          sendAgentApiResponse(routeKey, res, result.body);
        } catch (err) {
          if (res.headersSent) return;
          console.error(`internal.agent-api.${routeKey} failed`, serializeErrorForLog(err));
          if (!req.readableEnded) res.setHeader("Connection", "close");
          res.status(500).json({ error: failure });
        }
      }]);
    },
    bytes(routeKey, failure, run) {
      assertOwnAgentApiRoute(app, routeKey);
      mountAppRoute(routeKey, [...agentApiRequestValidators(routeKey), async (req, res) => {
        try {
          const result = await run(agentApiCallOf(app, req));
          if (result.kind === "error") {
            sendAppError(req, res, result);
            return;
          }
          res.setHeader("Cache-Control", "private, no-store");
          res.setHeader("Content-Type", result.contentType);
          res.setHeader("Content-Length", String(result.size));
          res.setHeader("Content-Disposition", result.contentDisposition);
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
          await streamStorageResponse(result.stream, res);
        } catch (err) {
          if (res.destroyed || res.headersSent) return;
          // The error class only: a storage error may name its key.
          console.error(`internal.agent-api.${routeKey} failed`, { errorClass: errorClassOf(err) });
          res.status(500).json({ error: failure });
        }
      }]);
    },
    // A JSON route's body: its write budget is charged here, ahead of the parser (once: the route then passes it).
    largeBody(routeKey, maxBytes, { notEnabled, onBodyError }) {
      assertOwnAgentApiRoute(app, routeKey);
      const route: AgentApiContractRoute = agentApiContract[routeKey];
      firstPartyAppLargeBodies.push({ app: app.id, flag: app.flag, method: route.method, path: `/internal/agent-api${route.path}`, maxBytes, clientGate: gate, limit: appWriteBudgetOf(routeKey), notEnabled, onBodyError });
    },
  };
}

for (const app of firstPartyApps()) app.routes?.agentApi?.(agentApiMountOf(app));

// --- Attachment comments (attachment-comments MVP spec, PR3 agent transport) ---
// Mirrors the user routes on /api/attachments/:id/comments. Both transports
// reuse attachmentCommentService so there is exactly one comment pipeline;
// the agent-side authorize is canAgentPostToChannel on the parent channel.

registerAgentApiRoute("attachmentCommentsList", ...agentApiRequestValidators("attachmentCommentsList"), async (req, res) => {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
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
    const readable = await resolveAgentReadableAttachment(projection, serverId, actingAgentId);
    if (!readable) {
      sendAttachmentNotFound(res);
      return;
    }
    const { attachment } = readable;
    const historyWindow = await getServerHistoryWindowForRead(serverId);
    if (await isAttachmentBehindWindow({ messageId: attachment.messageId, messageCreatedAt: readable.messageCreatedAt }, historyWindow)) {
      setRequestTraceErrorCode(res, "history_limited");
      noteAgentHistoryBlock({ serverId, agentId: actingAgentId, reach: { conversationId: attachment.channelId } });
      refuseKeepingTraceReason(res, 404, agentHistoryLimitedRefusal(historyWindow, "file"));
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
    sendJsonServerError(req, res, {
      error: "Failed to load comments",
      logPrefix: "internal.agent-api.attachment-comments.list error:",
      err,
    });
  }
});

internalAgentApiRouter.post("/attachments/:attachmentId/comments", requireAgentCapability("send"), agentApiWriteBudget("otherWrites", "attachmentCommentCreate"), async (req, res) => {
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
      refuse(res, 404, AGENT_GONE_REFUSAL);
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
    sendJsonServerError(req, res, {
      error: "Failed to create comment",
      logPrefix: "internal.agent-api.attachment-comments.create error:",
      err,
    });
  }
});

/**
 * The other side of the DM `channel` is in (a DM, or a thread under one) as
 * the agent sees them: kind, handle, description, and the zone their latest
 * message there carried. Null when not a DM, for the agent's own or an app
 * DM, and for a peer with nothing to show (no description and no zone).
 */
async function resolvePeerCard(
  serverId: string,
  agentId: string,
  channel: { id: string; type: string; parentMessageId?: string | null } | null | undefined,
): Promise<AgentApiPeerCard | null> {
  return (await resolvePeerCardOf(serverId, agentId, channel))?.card ?? null;
}

/** The DM peer card and the DM it belongs to (a DM thread's card is its DM's). */
async function resolvePeerCardOf(
  serverId: string,
  agentId: string,
  channel: { id: string; type: string; parentMessageId?: string | null } | null | undefined,
): Promise<{ card: AgentApiPeerCard; dmChannelId: string } | null> {
  if (!channel) return null;
  let dmChannelId: string | null = channel.type === "dm" ? channel.id : null;
  if (!dmChannelId && channel.type === "thread" && channel.parentMessageId) {
    const parent = await messageService.getMessage(channel.parentMessageId);
    const parentChannel = parent ? await channelService.getChannel(parent.channelId) : null;
    if (parentChannel?.type === "dm") dmChannelId = parentChannel.id;
  }
  if (!dmChannelId) return null;
  const peer = await channelService.getDmPeerForAgent(serverId, agentId, dmChannelId);
  if (!peer) return null;
  const timezone = peer.kind === "human"
    ? await messageService.getLatestSenderTimezone([...new Set([dmChannelId, channel.id])], "user", peer.id)
    : null;
  const card: AgentApiPeerCard = { kind: peer.kind, name: peer.name, description: peer.description, timezone };
  return peerCardHasContent(card) ? { card, dmChannelId } : null;
}

/**
 * RFC 082: a send receipt's `messageCard` (the sent one, or a reconciliation's
 * `committed`), when the message carries a card: its revision now (a replay or
 * a reconciliation after updates reads the current one). Absent means no card
 * went out: an older Server ignores `card` and posts the text with the same 200.
 */
function messageCardReceiptField(actionMetadata: unknown): { messageCard?: { revision: number } } {
  return isMessageCardMetadata(actionMetadata) ? { messageCard: { revision: actionMetadata.revision } } : {};
}

/** Whether this agent already committed a send with this idempotency key. */
async function isAgentSendKeyCommitted(agentId: string, idempotencyKey: string): Promise<boolean> {
  const [committed] = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(and(
      eq(messages.senderType, "agent"),
      eq(messages.senderId, agentId),
      eq(messages.agentSendKey, idempotencyKey),
    ))
    .limit(1);
  return Boolean(committed);
}

/** A send target that resolves to nothing the agent can post in (404 `target_not_found`; agentRouteRefusals.ts). */
function refuseSendTargetNotFound(res: Response, target: string): void {
  const { status, refusal } = unwritableTargetRefusal(null, target);
  refuse(res, status, refusal);
}

async function handleAgentApiMessageSend(
  req: Request,
  res: Response,
  routeKey: "messageSend" | "messageSendV2" | "taskReply",
): Promise<void> {
  try {
    const actingAgentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const validatedBody = validateAgentApiBody(routeKey, req, res);
    if (!validatedBody) return;
    // Task v2 (`taskReply`): the same send, addressed to a task (board +
    // number) instead of a message target; no freshness hold, no cards.
    const sendBody = validatedBody as AgentApiRequestBodyByRoute["messageSendV2"] & Partial<AgentApiRequestBodyByRoute["taskReply"]>;
    const taskReplyAddress = routeKey === "taskReply" && sendBody.channel && sendBody.task_number
      ? { channel: sendBody.channel, taskNumber: sendBody.task_number }
      : null;
    const target = taskReplyAddress
      ? formatAgentTaskRef(taskReplyAddress.channel, taskReplyAddress.taskNumber) ?? taskReplyAddress.channel
      : sendBody.target;
    const {
      content: requestedContent,
      attachmentIds,
      idempotencyKey,
      reconcileOnly,
      continue: deprecatedContinue,
      sendDraft,
      continueAnyway,
      draftReholdCount,
      draftReplacedExisting,
      seenUpToSeq,
      seenExactSeqs: requestedSeenExactSeqs,
      seenCards,
      freshnessContextMode,
    } = sendBody;
    const mentions = (routeKey === "messageSendV2" || routeKey === "taskReply") && "mentions" in sendBody
      ? sendBody.mentions as messageService.StructuredMentionInput[] | undefined
      : undefined;
    // RFC 082: a card on a v2 send (checked below, before anything is resolved or held).
    const requestedCard = routeKey === "messageSendV2" ? sendBody.card : undefined;
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
      (Array.isArray(requestedSeenExactSeqs) && requestedSeenExactSeqs.length > 0) ||
      typeof draftReholdCount === "number" ||
      draftReplacedExisting === true ||
      withholdFreshnessContext;

    addTraceEvent("agent_api_send.request.started", {
      target_kind: inferAgentApiSendTargetKind(target),
      client_kind: agentApiClientKind(req),
      content_chars: typeof requestedContent === "string" ? requestedContent.length : 0,
      attachment_count: attachmentCount,
      idempotency_key_present: typeof idempotencyKey === "string" && idempotencyKey.length > 0,
      card_present: requestedCard !== undefined,
      reconcile_only: reconcileOnly === true,
      send_draft: isSendDraft,
      continue_anyway: isContinueAnyway,
      freshness_requested: requestedSendFreshness,
      freshness_exact_seen_count: requestedSeenExactSeqs?.length ?? 0,
      freshness_context_mode: freshnessContextMode ?? "inline",
    });

    if (!target || typeof target !== "string") {
      traceSendRouteFailure("bad_request", 400);
      refuse(res, 400, { code: "target_required", error: "A message needs a target: name the channel, DM or thread to send it to." });
      return;
    }
    if (deprecatedContinue === true) {
      traceSendRouteFailure("bad_request", 400);
      refuse(res, 400, {
        code: "continue_unsupported",
        error: "Continuing a held message is no longer supported: send the message again to update the saved draft, or send the saved draft as it is.",
        suggestedNextAction: "Send the message normally to update the draft, or send the current saved draft with raft message send --send-draft.",
      });
      return;
    }
    if (isContinueAnyway && !isSendDraft) {
      traceSendRouteFailure("bad_request", 400);
      refuse(res, 400, {
        code: "send_draft_required",
        error: "Sending anyway applies only when sending the saved draft: send the saved draft anyway, or send the message normally.",
        suggestedNextAction: "Use --anyway together with --send-draft, or drop --anyway.",
      });
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
      refuseAgentGone(res);
      return;
    }
    if (reconcileOnly === true) {
      if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
        traceSendRouteFailure("bad_request", 400);
        refuse(res, 400, {
          code: "idempotency_key_required",
          error: "Checking whether a send went through needs that send's idempotency key: send the check with the same key.",
        });
        return;
      }
      if (requestedContent !== undefined || requestedCard !== undefined) {
        traceSendRouteFailure("bad_request", 400);
        refuse(res, 400, {
          code: "reconcile_with_content",
          error: `A check of whether a send went through carries no ${requestedContent !== undefined ? "content" : "card"}: send the check with the idempotency key only.`,
        });
        return;
      }
      const [committed] = await getDb()
        .select({ id: messages.id, seq: messages.seq, actionMetadata: messages.actionMetadata })
        .from(messages)
        .where(and(
          eq(messages.senderType, "agent"),
          eq(messages.senderId, actingAgentId),
          eq(messages.agentSendKey, idempotencyKey),
        ))
        .limit(1);
      if (!committed) {
        sendAgentApiResponse(routeKey, res, {
          ok: true,
          state: "not_found",
          reconciliation: true,
        });
        return;
      }
      sendAgentApiResponse(routeKey, res, {
        ok: true,
        state: "committed",
        messageId: committed.id,
        messageSeq: committed.seq,
        reconciliation: true,
        receiptComplete: false,
        // RFC 082: a card message says so here too, as the sent receipt does.
        ...messageCardReceiptField(committed.actionMetadata),
      });
      return;
    }
    // RFC 082: a card send is refused (nothing posted) while the sender's
    // Server's `message_cards` flag is off, never sent without its card; then
    // it carries no files (any attachmentIds, in every conversation: §4.1),
    // the card must be valid, and its content is the sender's or derived from
    // it. The flag is the sender's Server's (the credential's) only, in a
    // Joint Channel too (v1.8): the other Servers in the joint need not have
    // it on, as rendering never reads it. A joint target takes the card like
    // any other: the send below stores it once, in canonical storage, through
    // the sender's own projection (its posting authority locked as for text).
    // A retry under a key that already committed skips the flag: the send
    // stays committed if the flag was turned off since, and the send-key
    // replay below answers it (the original message, or 409 for another
    // send). Its card is still prepared, to compare with the committed one.
    let messageCardSend: MessageCardSend | null = null;
    if (requestedCard !== undefined) {
      let refusal: MessageCardRefusal | null = null;
      const prepared = prepareMessageCardSend({ card: requestedCard, content: requestedContent, mentions, attachmentIds });
      if (prepared.ok) messageCardSend = prepared.send;
      else refusal = prepared.refusal;
      if (refusal) {
        addTraceEvent("agent_api_send.message_card.refused", { code: refusal.body.code, limit: refusal.body.limit ?? null });
        traceSendRouteFailure("bad_request", refusal.status);
        res.status(refusal.status).json(refusal.body);
        return;
      }
    }
    const content = messageCardSend ? messageCardSend.content : requestedContent;
    if (!content || typeof content !== "string") {
      traceSendRouteFailure("bad_request", 400);
      refuse(res, 400, { code: "content_required", error: "A message needs content: give it some text to send." });
      return;
    }
    const sendFreshnessEnabled = isSendFreshnessEnabled(agent.serverId, actingAgentId);
    const sendFreshnessMode = (process.env.SLOCK_ATTESTED_SEND_MODE ?? "on").trim().toLowerCase();
    // A task reply is never held for freshness (its route has no draft flow).
    const shouldRunSendFreshness = !taskReplyAddress && sendFreshnessEnabled &&
      (requestedSendFreshness || sendFreshnessMode === "force");
    if (!sendFreshnessEnabled && requestedSendFreshness) {
      traceSendRouteFailure("freshness_not_enabled", 403);
      refuse(res, 403, {
        code: "freshness_not_enabled",
        error: "The send freshness check is not enabled for this agent: send the message without its fields (seen messages, a draft to send, or sending anyway).",
      });
      return;
    }

    let taskReplyTarget: { channelId: string; type: "thread" } | null = null;
    if (taskReplyAddress) {
      // The task conversation (created on the first reply to an older task);
      // a refusal was already answered.
      taskReplyTarget = await resolveAgentApiTaskReplyTarget(req, res, taskReplyAddress.channel, taskReplyAddress.taskNumber);
      if (!taskReplyTarget) {
        traceSendRouteFailure("target_not_found", res.statusCode);
        return;
      }
    }
    const resolved = taskReplyTarget
      ? { channelId: taskReplyTarget.channelId, type: taskReplyTarget.type }
      : await tracePhase(
      () => resolveWritableAgentTarget(serverId, actingAgentId, target, {
        io: req.app.get("io") as SocketServer | undefined,
        appSubjectDm: { credentialId: req.agentCredentialId },
      }),
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
      const { status, refusal } = unwritableTargetRefusal("forbidden", target);
      refuse(res, status, refusal);
      return;
    }
    if (rejectUnwritableTaskConversation(resolved, res)) return;
    if (resolved === "peer-not-found") {
      traceSendRouteFailure("target_not_found", 404);
      const { status, refusal } = unwritableTargetRefusal("peer-not-found", target);
      refuse(res, status, refusal);
      return;
    }
    if (resolved === "self-dm") {
      traceSendRouteFailure("bad_request", 400);
      const { status, refusal } = unwritableTargetRefusal("self-dm", target);
      refuse(res, status, refusal);
      return;
    }
    if (!resolved) {
      traceSendRouteFailure("target_not_found", 404);
      refuseSendTargetNotFound(res, target);
      return;
    }
    // `dm:sub:<sub>` (App Bots): from here on the DM is named the way every
    // agent-facing surface names it, `dm:@<handle>`; the sub is not echoed.
    const agentFacingTarget = parseAppSubjectDmTarget(target)
      ? await channelService.resolveAgentFacingChannelRef(serverId, actingAgentId, resolved.channelId)
      : target;
    if (!agentFacingTarget) {
      traceSendRouteFailure("target_not_found", 404);
      refuseSendTargetNotFound(res, target);
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
        refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
        return;
      }
      throw err;
    }
    // A plan limit's read-only (the free plan's external channel freeze, a
    // joint over its free-server cap), as on the legacy send route.
    const billingReadOnly = await getChannelBillingReadOnly(resolved.channelId, serverId);
    if (billingReadOnly) {
      traceSendRouteFailure("target_forbidden", 403);
      refuseKeepingTraceReason(res, 403, channelBillingReadOnlyRefusal(billingReadOnly));
      return;
    }

    // Cards (passive AX): the target's channel card (`seenCards.channel`) and
    // a DM target's peer card (`seenCards.peer`), each only for a client that
    // names the version its model context has (null: not seen). Never seen in
    // this context: held once, like unread messages. Seen an older version:
    // sent, with the new card in the reply. Reviewer isolation sends no new
    // context, so it carries no card either.
    const seenChannelCard = withholdFreshnessContext ? undefined : seenCards?.channel;
    const seenPeerCard = withholdFreshnessContext ? undefined : seenCards?.peer;
    const targetChannel = seenChannelCard === undefined && seenPeerCard === undefined
      ? null
      : await channelService.getChannel(resolved.channelId);
    // The channel the card belongs to: a thread's card is its parent's.
    const channelCardRow = seenChannelCard === undefined ? null : await resolveChannelCardRow(targetChannel, serverId);
    const channelCardCheck = (() => {
      if (!channelCardRow) return null;
      const card = channelCardOf(channelCardRow);
      return channelCardRev(card) === seenChannelCard ? null : { card, changed: seenChannelCard !== null };
    })();
    // The peer is checked for "seen in this context" only: their zone travels
    // with each message, so a version compare would call every message from
    // another place a change. A changed description reaches the agent with
    // their next message.
    const peerCardOf = seenPeerCard !== null ? null : await resolvePeerCardOf(serverId, actingAgentId, targetChannel);
    const peerCardCheck = peerCardOf ? { card: peerCardOf.card, changed: false } : null;
    const unseenCardReasons = [
      ...(channelCardCheck && !channelCardCheck.changed ? ["channel_card"] : []),
      ...(peerCardCheck && !peerCardCheck.changed ? ["peer_card"] : []),
    ];
    // A retry of a send that already committed replays its receipt below; it
    // is not held for a card the original send was not held for.
    const holdForCards = unseenCardReasons.length > 0
      && !isContinueAnyway
      && !(typeof idempotencyKey === "string" && idempotencyKey.length > 0
        && await isAgentSendKeyCommitted(actingAgentId, idempotencyKey));
    // A channel card alone doesn't hold the send: it is sent, and the card
    // comes with the reply (#wg-ax:#25, Tenny 91b19c46). Of 162 card-only holds
    // in a week, 83% were re-sent unchanged and 3% edited, so the round trip
    // bought almost nothing; the agent follows the card from its next message.
    // The card still holds alongside unread messages (the freshness hold), and
    // a DM peer's card still holds.
    const sendWithChannelCard = holdForCards && unseenCardReasons.every((reason) => reason === "channel_card");
    const cardFields = {
      ...(channelCardCheck ? { channelCard: channelCardCheck.card, ...(channelCardCheck.changed ? { channelCardChanged: true } : {}) } : {}),
      ...(peerCardCheck ? { peerCard: peerCardCheck.card } : {}),
    };
    for (const [name, seen, check, cardChannelId] of [
      ["channel", seenChannelCard, channelCardCheck, channelCardRow?.id ?? null],
      ["peer", seenPeerCard, peerCardCheck, peerCardOf?.dmChannelId ?? null],
    ] as const) {
      if (seen === undefined) continue;
      addTraceEvent(`agent_api_send.${name}_card.evaluated`, cardEvaluatedAttrs({
        outcome: check === null ? "seen" : check.changed ? "changed" : holdForCards && !sendWithChannelCard ? "held" : "unseen_not_held",
        targetType: resolved.type,
        channelId: resolved.channelId,
        cardChannelId,
        headers: req.headers,
        seenCardPresent: seen !== null,
      }));
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
          const evaluation = await evaluateAgentFreshness({
            agentId: actingAgentId,
            serverId,
            channelId: resolved.channelId,
            channelType: resolved.type,
            seenUpToSeq,
            requestedSeenExactSeqs,
          });
          return { ...evaluation, shouldHoldForFreshness: !isContinueAnyway && evaluation.newMessageCount > 0 };
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
        targetRef: agentFacingTarget,
        newMessageCount: freshness.newMessageCount,
      };


      if (freshness.shouldHoldForFreshness) {
        const response = await tracePhase(
          () => renderAgentFreshnessHold(req, {
            action: "send",
            agentId: actingAgentId,
            serverId,
            agentServerId: agent.serverId,
            channelId: resolved.channelId,
            channelType: resolved.type,
            target: agentFacingTarget,
            withhold: withholdFreshnessContext,
            agentOrchestrator,
            evaluation: freshness,
            replacedExisting: draftReplacedExisting === true,
            reholdCount: parsedDraftReholdCount,
            isSendDraft,
          }),
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
        sendAgentApiResponse(routeKey, res, {
          ...response,
          ...(holdForCards ? { holdReasons: ["unread_messages", ...unseenCardReasons] } : {}),
          ...cardFields,
        });
        return;
      }
    }

    if (holdForCards && !sendWithChannelCard) {
      // No unread messages: the cards alone hold the send. Nothing was shown
      // from the conversation, so read positions do not move.
      await recordAgentRaftAction(req, actingAgentId, {
        title: unseenCardReasons.includes("channel_card") ? "Send held for the channel card" : "Send held for the DM peer's card",
        text: `target: ${agentFacingTarget}\nreason: ${unseenCardReasons.join(", ")} not in the agent's current context`,
      });
      addTraceEvent("response.ready", { status_code: 200, state: "held", held_message_count: 0, new_message_count: 0 });
      sendAgentApiResponse(routeKey, res, {
        ok: true,
        state: "held",
        holdReasons: unseenCardReasons,
        heldMessages: [],
        newMessageCount: 0,
        shownMessageCount: 0,
        omittedMessageCount: 0,
        ...cardFields,
      });
      return;
    }

    const sendAttention = await buildDriveByJoinedToPostAttention(actingAgentId, resolved, agentFacingTarget);
    // A personal assistant's message may go back to WeChat only if, as it is
    // sent, its turn carries a WeChat message from this very DM (top level):
    // marked in the send's transaction (wechatMirrorDecision.ts). The gate is
    // read before it (cached).
    const markWeChatMirror = agent.assistantOwnerUserId
      && await isAssistantWeChatActive(serverId, agent.assistantOwnerUserId)
      ? (executor: DatabaseExecutor, message: { id: string; channelId: string }) =>
        markWeChatMirrorInTransaction({ agentId: actingAgentId, messageId: message.id, channelId: message.channelId }, executor)
      : undefined;
    const enriched = await tracePhase(
      // slack-bridge-ordinary-message-producer: agent_api.send
      () => messageService.broadcastAndDeliver(io, agentOrchestrator, {
        channelId: resolved.channelId,
        senderType: "agent",
        senderId: actingAgentId,
        senderName: agent.displayName || agent.name || "Agent",
        content,
        mentions,
        mentionContract: routeKey === "messageSend" ? "v1" : "v2",
        // RFC 082: the card's metadata (revision 1); a derived fallback mentions no one.
        ...(messageCardSend
          ? { actionMetadata: messageCardSend.metadata, contentMentions: messageCardSend.contentMentions }
          : {}),
        attachmentIds: Array.isArray(attachmentIds) ? attachmentIds : [],
        ...(typeof idempotencyKey === "string" && idempotencyKey.length > 0
          ? { agentSendKey: idempotencyKey, rejectMismatchedAgentSendReplay: true }
          : {}),
        ...(markWeChatMirror ? { afterAgentInsertInTransaction: markWeChatMirror } : {}),
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

    // RFC 077: what an assistant says to its owner in their DM is told (references parsed server-side).
    // Only assistants: an ordinary agent's send costs nothing here. Off the response path: the send
    // never waits on it (it traces its own failures); a "more" right after may see the new total a beat later.
    if (agent.assistantOwnerUserId) void assistantContactRulesService.recordToldFromOwnerDmMessage({
      agentId: actingAgentId,
      serverId: agent.serverId,
      channelId: resolved.channelId,
      content,
      agentSendKey: typeof idempotencyKey === "string" ? idempotencyKey : null,
    });

    // Agent typing line: the agent is no longer about to post here, though the
    // command that posted may still be running. Best-effort, off the response path.
    void agentOrchestrator?.endAgentTypingForPostedMessage?.({
      agentId: actingAgentId,
      serverId: agent.serverId,
      channelId: resolved.channelId,
      // Task v2: a reply lands in the local task conversation.
      channelType: taskReplyAddress ? "task" : resolved.type,
      target: agentFacingTarget,
    });

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
                  `target: ${agentFacingTarget}`,
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
      // A send the channel card used to hold, sent with the card in the reply.
      ...(sendWithChannelCard ? { card_shown_after_send: true } : {}),
    });
    const pendingMentionActions = messageService.getSenderPendingMentionActions(enriched);
    const unresolvedMentionHandles = messageService.getSenderUnresolvedMentionHandles(enriched);
    const deliveredToAgents = messageService.getSenderDeliveredAgentNames(enriched);
    // Task v2: a message target that named a task conversation (a client from
    // before task v2 copying the delivered `#parent:#7`) gets the new command.
    const sentTaskRef = !taskReplyAddress ? parseAgentTaskRef(agentFacingTarget) : null;
    sendAgentApiResponse(routeKey, res, {
      ok: true,
      state: "sent",
      messageId: enriched.id,
      messageSeq: enriched.seq,
      ...(sentTaskRef && { taskCommandHint: formatAgentTaskCommandHint(sentTaskRef.ref, "send") }),
      ...(sendAttention ? { attention: sendAttention } : {}),
      ...(pendingMentionActions.length > 0 ? { pendingMentionActions } : {}),
      ...(unresolvedMentionHandles.length > 0 ? { unresolvedMentionHandles } : {}),
      ...(deliveredToAgents ? { deliveredToAgents } : {}),
      ...cardFields,
      ...(messageCardSend ? messageCardReceiptField(enriched.actionMetadata) : {}),
    });
  } catch (err) {
    if (routeKey !== "messageSend" && err instanceof messageService.MentionValidationError && err.code) {
      traceSendRouteFailure("mention_validation", 400);
      refuse(res, 400, { code: err.code, error: err.message });
      return;
    }
    if (err instanceof DmPeerNotMemberError || err instanceof JointChannelAccessChangedError) {
      traceSendRouteFailure("bad_request", err.status);
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof messageService.AgentSendIdempotencyConflictError) {
      // Closed-set subkind: a reused idempotency key is request misuse.
      traceSendRouteFailure("bad_request", err.status);
      res.status(err.status).json({
        error: err.message,
        code: err.code,
        mismatch: err.mismatch,
        suggestedNextAction: err.suggestedNextAction,
      });
      return;
    }
    if (err instanceof AttachmentLinkError) {
      traceSendRouteFailure("bad_request", err.status);
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof DmTargetResolutionError) {
      // An ambiguous same-name DM peer (409) or unknown peer kind (400) is a
      // target the caller can fix, not a server fault.
      traceSendRouteFailure("bad_request", err.status);
      res.status(err.status).json(err.toResponseBody());
      return;
    }
    if (transientTransactionSqlState(err)) {
      // The send transaction lost a deadlock/serialization race on every
      // bounded retry and rolled back: nothing was committed. The same
      // idempotencyKey is safe to resend.
      traceSendRouteCatch(err, 503);
      res.setHeader("Retry-After", "1");
      res.status(503).json(transientSendConflictBody());
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

// The route's own upload-session refusals keep the contract's code / message /
// retryable and add `error`, the field the CLI prints (it shows `error`, not
// `message`).
const UPLOAD_FORBIDDEN_MESSAGE = "The agent cannot upload to this channel.";
const uploadForbiddenBody = {
  code: "UPLOAD_FORBIDDEN",
  message: UPLOAD_FORBIDDEN_MESSAGE,
  retryable: false,
  error: UPLOAD_FORBIDDEN_MESSAGE,
} as const;

type AgentUploadSessionRefusal =
  | { status: 403; body: typeof uploadForbiddenBody }
  | {
    status: 413;
    body: { code: "UPLOAD_TOO_LARGE"; message: string; retryable: false; suggestedNextAction?: string }
      & ReturnType<typeof buildAttachmentTooLargeResponse>;
  }
  | { status: 403; body: { code: "UPLOAD_FORBIDDEN"; message: string; retryable: false } & FileUploadQuotaExceededResponse };

/**
 * The per-file limit an agent's upload here would have on Pro, as the
 * capabilities read would advertise it then: the multipart cap where an upload
 * session service runs without direct uploads, else Pro's own limit (null when
 * the service can't say). A file over it gets no upgrade card: Pro would
 * refuse it too.
 */
async function agentUploadLimitOnProBytes(req: Request): Promise<number | null> {
  const service = attachmentUploadSessionService(req);
  if (!service) return getAttachmentFileSizeLimitBytes("pro");
  try {
    const capabilities = await service.capabilities({ serverId: req.serverId!, agentId: req.actingAgentId! });
    const advertised = attachmentUploadCapabilitiesSchema.safeParse(capabilities.body);
    return advertised.success && advertised.data.directUploadEnabled
      ? getAttachmentFileSizeLimitBytes("pro")
      : getLegacyAttachmentFileSizeLimitBytes("pro");
  } catch (err) {
    // Only decides whether a size refusal offers the card: unknown is no card, not a failed refusal.
    console.error("agent upload Pro limit lookup failed:", serializeErrorForLog(err));
    return null;
  }
}

/**
 * Why the agent may not open this upload session, or null when it may: no
 * post access (or archived, read-only), a file over the plan's limit (the CLI
 * declares one here so the server says why), or the Free monthly quota. A Free
 * limit offers the upgrade card where the server allows one and Pro would
 * take the upload here.
 */
async function agentUploadSessionRefusal(
  req: Request,
  body: AgentApiRequestBodyByRoute["attachmentUploadSessionCreate"],
): Promise<AgentUploadSessionRefusal | null> {
  const agentId = req.actingAgentId!;
  const serverId = req.serverId!;
  const forbidden = { status: 403 as const, body: uploadForbiddenBody };
  if (!await channelService.canAgentPostToChannel(body.channelId, agentId)) return forbidden;
  if (
    await channelService.isChannelArchived(body.channelId)
    || await isChannelReadOnlyByBillingFeature(body.channelId, serverId)
    || await isChannelReadOnlyByQuota(body.channelId, serverId)
  ) return forbidden;
  const quota = await getFileUploadQuotaSummary(serverId);
  const maxBytes = getAttachmentFileSizeLimitBytes(quota.plan);
  if (body.sizeBytes > maxBytes) {
    const tooLarge = buildAttachmentTooLargeResponse(maxBytes);
    const limitOnPro = await agentUploadLimitOnProBytes(req);
    const hint = limitOnPro !== null && body.sizeBytes <= limitOnPro
      ? await agentUploadUpgradeHint({ serverId, agentId, channelId: body.channelId, capabilities: req.header(RAFT_CLIENT_CAPABILITIES_HEADER), gate: "upload_file_size" })
      : null;
    return {
      status: 413,
      body: { code: "UPLOAD_TOO_LARGE", message: tooLarge.error, retryable: false, ...tooLarge, ...(hint && { suggestedNextAction: hint }) },
    };
  }
  if (quota.enforced && body.sizeBytes > quota.remainingBytes) {
    const refusal = await agentFileUploadQuotaExceededResponse(
      { serverId, agentId, channelId: body.channelId, capabilities: req.header(RAFT_CLIENT_CAPABILITIES_HEADER) },
      new FileUploadQuotaExceededError(quota, body.sizeBytes),
    );
    return { status: 403, body: { code: "UPLOAD_FORBIDDEN", message: FILE_UPLOAD_QUOTA_EXCEEDED_MESSAGE, retryable: false, ...refusal } };
  }
  return null;
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
    // Refusals come first, whether or not direct uploads are on: the CLI
    // declares a file over the plan's limit here to learn why it is refused.
    const body = req.body as AgentApiRequestBodyByRoute["attachmentUploadSessionCreate"];
    const refusal = await agentUploadSessionRefusal(req, body);
    if (refusal) {
      res.status(refusal.status).json(refusal.body);
      return;
    }
    const service = attachmentUploadSessionService(req);
    if (!service) {
      // refusal-ok: the upload-session contract is a strict { code, message, retryable } body without `error`
      res.status(404).json({ code: "UPLOAD_SESSION_NOT_FOUND", message: "Direct uploads are disabled.", retryable: false });
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
      // refusal-ok: the upload-session contract is a strict { code, message, retryable } body without `error`
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
      // refusal-ok: the upload-session contract is a strict { code, message, retryable } body without `error`
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
      // refusal-ok: the upload-session contract is a strict { code, message, retryable } body without `error`
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
  const agentId = req.actingAgentId!;
  const serverId = req.serverId!;
  const channelId = typeof req.body?.channelId === "string" ? req.body.channelId : undefined;
  try {
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

    if (await channelService.isChannelArchived(channelId)) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }
    const billingReadOnly = await getChannelBillingReadOnly(channelId, serverId);
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
      res.status(err.status).json(await agentFileUploadQuotaExceededResponse(
        { serverId, agentId, channelId, capabilities: req.header(RAFT_CLIENT_CAPABILITIES_HEADER) },
        err,
      ));
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

    sendAgentApiResponse("resolveChannel", res, { channelId: resolved.channelId });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to resolve channel",
      logPrefix: "internal.agent-api.resolve-channel error:",
      err,
    });
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
        refuse(res, 404, AGENT_CHANNEL_NOT_FOUND_REFUSAL);
        return;
      }
      channelId = resolved.channelId;
    }

    const limit = Math.min(
      Number(queryInput.limit) || AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT,
      AGENT_API_MESSAGE_SEARCH_MAX_LIMIT,
    );
    const offset = parseOffsetQueryParam(queryInput.offset);
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
      refuse(res, 400, { code: "INVALID_DATE_FILTER", error: "A search's after and before are dates and times, such as 2026-11-01T09:00:00Z: send them in that form." });
      return;
    }
    const sort = queryInput.sort === "recent" ? "recent" : "relevance";
    const cursor = queryInput.cursor ? searchService.parseMessageSearchWalkCursor(queryInput.cursor) : undefined;
    // A cursor continues a recent page, or a relevance page answered newest
    // first (relevanceFallback).
    if (cursor === null || (cursor && !query)) {
      refuse(res, 400, { code: "search_cursor_invalid", error: "That search cursor can't continue this search: pass back nextCursor unchanged, with the same query." });
      return;
    }
    const hasMeaningfulFilter = Boolean(channelId || senderFilter.senderId || after || before);
    if (!query && !hasMeaningfulFilter) {
      sendAgentApiResponse("messageSearch", res, { results: [], hasMore: false });
      return;
    }

    const historyWindow = await getServerHistoryWindowForRead(serverId);
    const searchResponse = await searchService.searchMessagesForAgent({
      serverId,
      agentId,
      query,
      channelId,
      senderId: senderFilter.senderId,
      after,
      before,
      historyCutoff: historyWindow.cutoff,
      sort: query ? sort : "recent",
      limit,
      offset,
      cursor,
      signal: requestAbort.signal,
    });
    const [renderedContents, renderedSnippets, taskFacts, commentScopes] = await Promise.all([
      agentPermalinkRenderService.renderAgentReadablePermalinksInTexts(
        searchResponse.results.map((result) => result.content),
        serverId,
      ),
      agentPermalinkRenderService.renderAgentReadablePermalinksInTexts(
        searchResponse.results.map((result) => result.snippet),
        serverId,
      ),
      loadCanonicalTaskFactsByMessageId(searchResponse.results.map((result) => result.id)),
      // Search rows are intentionally lean. Load only the returned ids' scope
      // projections. Agent comment access is evaluated at the server level,
      // exactly like the dedicated Agent comment routes; user-targeted rules
      // remain human-viewer policy.
      messageService.loadAgentCommentScopesForMessages(
        searchResponse.results.map((result) => result.id),
        serverId,
      ),
    ]);

    // Matches the window hides (task #proj-commercial:#24, F): the CLI prints
    // the message, so the agent doesn't report "nothing found".
    const olderHidden = searchResponse.olderHidden;
    if (olderHidden && olderHidden.count > 0) noteAgentHistoryBlock({ serverId, agentId, reach: { search: true } });
    const historyLimit = olderHidden && olderHidden.count > 0
      ? {
        historyLimited: true as const,
        historyLimitMessage: [
          agentSearchHistoryLimitNote(historyWindow, olderHidden),
          await agentSearchUpgradeCardHint({
            serverId,
            client: { capabilities: req.header(RAFT_CLIENT_CAPABILITIES_HEADER), agentId },
          }),
        ].filter(Boolean).join(" "),
      }
      : {};
    sendAgentApiResponse("messageSearch", res, {
      ...searchResponse,
      ...historyLimit,
      results: searchResponse.results.map((result, index) => {
        // RFC 077: an agent reads "sent by an assistant for its owner" as `delegated_by=@name`, as on every other message it reads.
        const { externalMessage, delegatedBy, retracted: _retracted, ...visibleResult } = result;
        const external = result.senderType === "external_projection";
        // Slack-bridged rows read like ordinary messages; other external content stays inert.
        const inert = external && (!isSlackBridgedExternalProvider(externalMessage?.provider)
          || externalMessage?.actor_kind === "unknown");
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
          ...(external && !externalMessage ? { senderId: "" } : {}),
          senderType: toAgentFacingActorType(result.senderType),
          ...(externalMessage ? { external_message: externalMessage } : {}),
          ...(delegatedBy ? { delegated_by: { name: delegatedBy.name } } : {}),
          content: inert
            ? renderThirdPartyInertText({ field: "tool_result", value: result.content })
            : renderAgentCommentScopedContent(
                renderedContents[index] ?? result.content,
                commentScopes.get(result.id),
              ),
          snippet: inert
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
    if (respondToDmTargetResolutionError(err, res)) return;
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
      refuse(res, 401, { code: "invalid_principal", error: "Resolving a message needs an agent's own credential: send this request with the agent's API key." });
      return;
    }

    const resolved = await messageService.resolveMessageIdVisibleToAgent(serverId, agentId, rawMessageId);
    if (!resolved.ok) {
      refuse(res, resolved.status, messageResolveRefusal(resolved.error));
      return;
    }
    // After the access check: a message this agent may read, behind the plan's
    // history window (the time is from the row the lookup matched).
    const historyWindow = await getServerHistoryWindowForRead(serverId);
    if (isBehindHistoryWindow(resolved.message.createdAt, historyWindow)) {
      noteAgentHistoryBlock({ serverId, agentId, reach: { conversationId: resolved.message.channelId } });
      refuse(res, 404, agentHistoryLimitedRefusal(historyWindow));
      return;
    }

    const payload = await resolveAgentVisibleMessagePayload(resolved.messageId, serverId, agentId);
    if (!payload) {
      refuse(res, 404, MESSAGE_NOT_FOUND_REFUSAL);
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
    sendJsonServerError(req, res, {
      error: "Failed to resolve message",
      logPrefix: "internal.agent-api.message-resolve error:",
      err,
    });
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
      refuse(res, 404, AGENT_CHANNEL_NOT_FOUND_REFUSAL);
      return;
    }

    const members = await channelService.getChannelMembers(resolved.channelId);
    const agentRoles = await getAgentServerRolesInServer(serverId, members.agents.map((agent) => agent.id));
    const visibleAgents = members.agents.map((agent) => ({
      name: agent.name,
      status: agent.status,
      role: agentRoles.get(agent.id) ?? null,
    }));
    const visibleHumans = await filterAgentVisibleHumansForHiddenDirectory(
      serverId,
      agentId,
      members.humans,
    );
    sendAgentApiResponse("channelMembers", res, {
      channel: { ref: channelRef, type: resolved.type },
      agents: visibleAgents,
      humans: visibleHumans.map((human) => {
        const servers = channelService.agentVisibleMemberServers(human, serverId);
        // Another server's person: their role stays with their organization.
        return { name: human.name, description: human.description, ...(human.serverId === serverId ? { role: human.role } : {}), ...(servers ? { servers } : {}) };
      }),
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to get channel members",
      logPrefix: "internal.agent-api.channel-members error:",
      err,
    });
  }
});
/** `raft thread follow` given a task ref / task conversation: name `raft task follow`. */
function respondThreadFollowTaskTarget(res: Response, ref: string | null): void {
  const command = ref ? formatHint(RAFT_HINTS.taskFollow(ref)) : formatHint(RAFT_HINTS.taskFollow("#channel:#7"));
  const target = ref ?? "This target";
  refuse(res, 400, {
    code: TASK_TARGET_USE_TASK_COMMAND_ERROR_CODE,
    error: sentenceQuoting([target], `${target} is a task conversation, not a thread, so nothing was followed: follow the task instead.`, "That target is a task conversation, not a thread, so nothing was followed: follow the task instead."),
    suggestedNextAction: command,
  });
}

/**
 * `raft thread follow --target "#ch:<msg>"` (parity with `raft task follow`):
 * the agent follows the thread (reason `manual`, an earlier unfollow is
 * reactivated) and its read position starts at the latest reply, so existing
 * replies do not wake it. A message without replies yet gets its thread now,
 * which needs post access to the parent (the same rule as replying). Posts no
 * line: following is silent, as every other follow is.
 */
registerAgentApiRoute("threadFollow", ...agentApiRequestValidators("threadFollow"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const { thread: rawThreadRef } = req.body as AgentApiRequestBodyByRoute["threadFollow"];
    const threadRef = rawThreadRef.trim();
    const taskRef = parseAgentTaskRef(threadRef);
    if (taskRef) {
      respondThreadFollowTaskTarget(res, taskRef.ref);
      return;
    }

    let threadChannelId: string | null = null;
    let parentMessageId: string | null = null;
    if (UUID_RE.test(threadRef)) {
      const channel = await channelService.getChannel(threadRef);
      if (!channel || channel.serverId !== serverId || !await channelService.canAgentAccessChannel(channel.id, agentId)) {
        refuse(res, 404, THREAD_NOT_FOUND_REFUSAL);
        return;
      }
      if (channel.type === "task") {
        respondThreadFollowTaskTarget(res, null);
        return;
      }
      if (channel.type !== "thread") {
        refuse(res, 400, NOT_A_THREAD_REFUSAL);
        return;
      }
      threadChannelId = channel.id;
      parentMessageId = channel.parentMessageId ?? null;
    } else {
      const existing = await channelService.resolveChannelByName(serverId, agentId, threadRef);
      if (existing && existing.type !== "thread") {
        refuse(res, 400, NOT_A_THREAD_REFUSAL);
        return;
      }
      if (existing) {
        threadChannelId = existing.channelId;
      } else if (isThreadTarget(threadRef)) {
        // No thread yet under that message: create it (post authority on the parent).
        const created = await resolveWritableAgentTarget(serverId, agentId, threadRef);
        if (created === "forbidden") {
          refuse(res, 403, { code: "thread_follow_forbidden", error: "That message has no thread yet, and starting one needs permission to post where the message is: join its channel first, or ask to be added." });
          return;
        }
        if (rejectUnwritableTaskConversation(created, res)) return;
        if (created && typeof created === "object" && created.type === "thread") threadChannelId = created.channelId;
      }
      if (!threadChannelId) {
        refuse(res, 404, THREAD_NOT_FOUND_REFUSAL);
        return;
      }
      parentMessageId = (await channelService.getChannel(threadChannelId))?.parentMessageId ?? null;
    }
    // A joint thread's local projection names its parent through the projection.
    parentMessageId ??= (await channelService.getJointThreadProjectionByLocalThread(threadChannelId))?.canonicalParentMessageId ?? null;
    if (!parentMessageId) {
      refuse(res, 404, THREAD_NOT_FOUND_REFUSAL);
      return;
    }

    if (await isLoungeOutsiderAgent(threadChannelId, agentId)) {
      refuse(res, 403, AGENT_LOUNGE_OUTSIDER);
      return;
    }
    const before = await agentTaskConversationFollow(threadChannelId, agentId);
    if (!before.following) {
      await channelService.recordThreadFollow("agent", agentId, threadChannelId, parentMessageId, "manual", {
        reactivateUnfollowed: true,
        joinedThroughSeq: "latest",
      });
      await emitThreadFollowersUpdated(req.app.get("io") as SocketServer | undefined, threadChannelId);
    }
    const changed = !before.following;
    sendAgentApiResponse("threadFollow", res, { ok: true, following: true, changed });
    if (changed) {
      void recordAgentRaftAction(req, agentId, {
        title: "Followed thread",
        text: [`target: ${threadRef}`, `threadChannelId: ${threadChannelId}`].join("\n"),
      });
    }
  } catch (err: unknown) {
    if (respondToDmTargetResolutionError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to follow thread",
      code: "agent_api_thread_follow_failed",
      logPrefix: "[AgentAPI] Failed to follow thread",
      err,
    });
  }
});
registerAgentApiRoute("threadUnfollow", ...agentApiRequestValidators("threadUnfollow"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const { thread: threadRef, reason: rawReason } = req.body as AgentApiRequestBodyByRoute["threadUnfollow"];
    const reason = messageService.normalizeUnfollowReason(rawReason);

    let threadChannelId: string | null = null;
    if (UUID_RE.test(threadRef)) {
      const channel = await channelService.getChannel(threadRef);
      if (!channel || channel.serverId !== serverId) {
        refuse(res, 404, THREAD_NOT_FOUND_REFUSAL);
        return;
      }
      const canAccess = await channelService.canAgentAccessChannel(channel.id, agentId);
      if (!canAccess) {
        refuse(res, 404, THREAD_NOT_FOUND_REFUSAL);
        return;
      }
      if (!isSubConversationType(channel.type)) {
        refuse(res, 400, NOT_A_THREAD_REFUSAL);
        return;
      }
      threadChannelId = channel.id;
    } else {
      const resolved = await channelService.resolveChannelByName(serverId, agentId, threadRef);
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

    await channelService.unfollowThreadForFollower("agent", agentId, threadChannelId);
    const agent = await agentService.getAgent(agentId);
    const io = req.app.get("io") as SocketServer | undefined;
    await emitThreadFollowersUpdated(io, threadChannelId);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (agent && io && agentOrchestrator) {
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
        messageService.buildUnfollowNotice(agent.name, "thread", reason),
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
        `reason: ${reason ?? "(none)"}`,
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
registerAgentApiRoute("threadList", ...agentApiRequestValidators("threadList"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const threads = await channelService.listAgentFollowedThreads(serverId, agentId);
    sendAgentApiResponse("threadList", res, { threads });
  } catch (err: unknown) {
    sendJsonServerError(req, res, {
      error: "Failed to list followed threads",
      code: "agent_api_thread_list_failed",
      logPrefix: "[AgentAPI] Failed to list followed threads",
      err,
    });
  }
});
/**
 * GET /internal/agent-api/inbox/conversations?view=unread|mentions&before_seq=<n>&limit=<n>
 *
 * `raft inbox check`: the agent's durable unread conversations, newest activity
 * first (the agent counterpart of the human Activity panel). Not `/inbox`: the
 * managed-runner daemon proxy answers GET /inbox locally with its pending buffer.
 */
registerAgentApiRoute("inboxList", ...agentApiRequestValidators("inboxList"), async (req, res) => {
  const query = req.query as AgentApiInboxListQuery;
  const limit = Math.min(Number(query.limit ?? AGENT_API_INBOX_DEFAULT_LIMIT), AGENT_API_INBOX_MAX_LIMIT);
  try {
    // RFC 081 `items=true`: rows beside the list, only where the server has inbox items on.
    const withItems = query.items === "true" && await inboxItemsEnabled(req.serverId!);
    // A personal assistant lists app rows only (agentInboxItemsRoutes.ts): no
    // conversation, its owner DM reaches it through /events.
    const appRowsOnly = isAssistantInboxRequest(req);
    const { list, shownTargets, pageRows } = appRowsOnly
      ? {
        list: { view: query.view ?? "unread", items: [], hasMore: false, nextBeforeSeq: null, totals: { conversations: 0, dms: 0, mentions: 0 } } satisfies AgentApiInboxListResponse,
        shownTargets: new Map<string, { channelId: string; latestSeq: number }[]>(),
        pageRows: [] as channelService.AgentInboxChainRow[],
      }
      : await channelService.listAgentInboxWithShownTargets(req.actingAgentId!, req.serverId!, {
        view: query.view ?? "unread",
        beforeSeq: query.before_seq === undefined ? undefined : Number(query.before_seq),
        limit,
      });
    // An external agent's turn has no start input showing counts: the listing
    // does. Its end-of-turn report names this snapshot (externalTurnEndSnapshot.ts).
    let snapshotId: string | undefined;
    if (shownTargets.size > 0) {
      const agent = await agentService.getAgent(req.actingAgentId!);
      if (agent && isExternalAgentRuntime(agent.runtime)) {
        snapshotId = await recordExternalTurnEndSnapshot(req.actingAgentId!, shownTargets).catch((err: unknown) => {
          console.error("[AgentAPI] inbox list turn-end snapshot not recorded", serializeErrorForLog(err));
          return undefined;
        });
      }
    }
    const body: AgentApiInboxListResponse = snapshotId ? { ...list, snapshotId } : list;
    sendAgentApiResponse("inboxList", res, withItems
      ? {
        ...body,
        ...await inboxItemsListFields({
          agentId: req.actingAgentId!,
          serverId: req.serverId!,
          list: body,
          pageRows,
          firstPage: query.before_seq === undefined,
          reminderItems: reminderItemsDeclared(req),
          appRowsOnly,
        }),
      }
      : body);
  } catch (err: unknown) {
    if (err instanceof channelService.AgentInboxUnavailableError) {
      console.error("[AgentAPI] inbox list unavailable", serializeErrorForLog(err.cause ?? err));
      res.status(503).json({ error: "Inbox is temporarily unavailable", code: err.code });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to list inbox",
      code: "agent_api_inbox_list_failed",
      logPrefix: "[AgentAPI] Failed to list inbox",
      err,
    });
  }
});

/**
 * RFC 081 `raft inbox read --target <item>`: one page of one item,
 * consuming exactly what it returns (agentInboxItemsRoutes.ts). A
 * conversation is the history read's `--unread` page, cut to the page budget.
 */
registerAgentApiRoute("inboxRead", ...agentApiRequestValidators("inboxRead"), async (req, res) => {
  try {
    if (!await inboxItemsEnabled(req.serverId!)) {
      refuseInboxItemsDisabled(res);
      return;
    }
    await handleInboxRead(req, res, {
      serveConversation: (request, response, input) => serveAgentHistoryRead(
        request,
        response,
        { channel: input.target, unread: "true", limit: String(input.limit) },
        null,
        { sink: input.sink, maxChars: input.maxChars },
      ),
      prepare: (body) => prepareAgentApiResponse("inboxRead", res, body),
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to read the inbox item",
      code: "agent_api_inbox_read_failed",
      logPrefix: "[AgentAPI] Failed to read inbox item",
      err,
    });
  }
});

/** RFC 081 `raft inbox dismiss`: without reading, by `target` or `before`; traced (agentInboxItemsRoutes.ts). */
registerAgentApiRoute("inboxDismiss", ...agentApiRequestValidators("inboxDismiss"), async (req, res) => {
  try {
    if (!await inboxItemsEnabled(req.serverId!)) {
      refuseInboxItemsDisabled(res);
      return;
    }
    await handleInboxDismiss(req, res, { answer: (body) => sendAgentApiResponse("inboxDismiss", res, body) });
  } catch (err) {
    if (err instanceof channelService.AgentInboxUnavailableError) {
      console.error("[AgentAPI] inbox dismiss unavailable", serializeErrorForLog(err.cause ?? err));
      res.status(503).json({ error: "Inbox is temporarily unavailable", code: err.code });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to dismiss inbox items",
      code: "agent_api_inbox_dismiss_failed",
      logPrefix: "[AgentAPI] Failed to dismiss inbox items",
      err,
    });
  }
});
/**
 * RFC 074 §2 personal assistant (v0) reads. The assistant calls with its own
 * credential and the Server answers AS ITS OWNER (DMs too unless the owner
 * turned that off, RFC 077; never its own DM with the owner). Every request
 * re-resolves the owner (`resolveAssistantOwner`: flag on, live assistant,
 * owner still a member), and every way that fails gets the same
 * `403 assistant_not_enabled` so the reason is not observable. A DM, a thread
 * under a DM, and a channel the owner cannot see all get the same neutral 404.
 *
 * Neither read changes anyone's state: no read cursor, no activity, no
 * product event. Both reuse the human read paths (`getInboxItems`,
 * `filterUserAccessibleChannelIds`, `canUserAccessChannel`, `listMessages`).
 */
async function requireAssistantOwner(req: Request, res: Response): Promise<string | null> {
  const ownerUserId = await assistantService.resolveAssistantOwner(req.actingAgentId!, req.serverId!);
  if (!ownerUserId) {
    refuse(res, 403, {
      code: assistantService.ASSISTANT_NOT_ENABLED_CODE,
      error: "Only a personal assistant can use this, and only where personal assistants are enabled.",
    });
    return null;
  }
  return ownerUserId;
}

/**
 * The conversation fields for an owner-messages page. A DM (or a thread under
 * one) is named from the owner's side, `dm:@<peer>`; anything else by its
 * storage names, as on the delivery path.
 */
async function assistantOwnerConversationLabels(
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  serverId: string,
  ownerUserId: string,
) {
  const labels = await messageService.agentConversationLabelsForChannel(channel);
  const scope = await assistantService.dmScopeOf(channel);
  if (!scope.dm || !scope.rootChannelId) return labels;
  const peer = await channelService.resolveUserFacingDmPeerRef(serverId, ownerUserId, scope.rootChannelId);
  if (!peer) return labels;
  return channel.type === "dm"
    ? { ...labels, channel_type: "dm" as const, channel_name: peer }
    : { ...labels, parent_channel_type: "dm" as const, parent_channel_name: peer, parent_channel_id: scope.rootChannelId };
}

/** An owner conversation the assistant can't read: missing and not readable read the same (404 `channel_not_found`). */
const ASSISTANT_CHANNEL_NOT_FOUND_REFUSAL: RefusalInput = { code: "channel_not_found", error: CHANNEL_NOT_FOUND_BODY.error };

registerAgentApiRoute("assistantOwnerInbox", ...agentApiRequestValidators("assistantOwnerInbox"), async (req, res) => {
  try {
    const serverId = req.serverId!;
    const ownerUserId = await requireAssistantOwner(req, res);
    if (!ownerUserId) return;
    const query = req.query as AgentApiAssistantOwnerInboxQuery;
    const filter = query.filter ?? "unread";
    const limit = Math.min(Number(query.limit ?? AGENT_API_ASSISTANT_INBOX_DEFAULT_LIMIT), AGENT_API_ASSISTANT_INBOX_MAX_LIMIT);
    const offset = parseOffsetQueryParam(query.offset);
    const page = await listOwnerInboxPage({
      agentId: req.actingAgentId!, serverId, ownerUserId, filter, limit, offset,
    });
    recordTraceEvent("server.agent_api.assistant.owner_inbox", {
      agent_id: req.actingAgentId!,
      subject_user_id: ownerUserId,
      filter,
      row_count: page.loadedCount,
      returned_count: page.items.length,
      ...(page.total !== undefined ? { total: page.total } : {}),
    });
    sendAgentApiResponse("assistantOwnerInbox", res, {
      owner: { userId: ownerUserId },
      filter,
      items: page.items,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      ...(page.total !== undefined ? { total: page.total, totalCapped: page.totalCapped ?? false } : {}),
    });
  } catch (err: unknown) {
    sendJsonServerError(req, res, {
      error: "Failed to list the owner's inbox",
      code: "agent_api_assistant_owner_inbox_failed",
      logPrefix: "[AgentAPI] Failed to list assistant owner inbox",
      err,
    });
  }
});

registerAgentApiRoute("assistantOwnerMessages", ...agentApiRequestValidators("assistantOwnerMessages"), async (req, res) => {
  try {
    const serverId = req.serverId!;
    const ownerUserId = await requireAssistantOwner(req, res);
    if (!ownerUserId) return;
    const query = req.query as AgentApiAssistantOwnerMessagesQuery;
    const channelId = query.channelId;
    const anchors = [query.before, query.after, query.around].filter((value) => value !== undefined && value.trim() !== "");
    if (anchors.length > 1) {
      refuse(res, 400, { code: "invalid_message_page_cursor", error: "A page takes at most one of before, after or around: send only one." });
      return;
    }
    const channel = await channelService.getChannel(channelId);
    const dmPolicy = await assistantService.readableOwnerDmPolicy({ agentId: req.actingAgentId!, serverId, ownerUserId });
    if (
      !channel
      || channel.serverId !== serverId
      || !await assistantService.mayAssistantReadOwnerConversation(dmPolicy, channel)
      || !await channelService.canUserAccessChannel(channelId, ownerUserId, serverId)
    ) {
      refuse(res, 404, ASSISTANT_CHANNEL_NOT_FOUND_REFUSAL);
      return;
    }
    const limit = Math.min(Number(query.limit ?? AGENT_API_ASSISTANT_MESSAGES_DEFAULT_LIMIT), AGENT_API_ASSISTANT_MESSAGES_MAX_LIMIT);
    const historyCutoff = getHistoryCutoff(await getServerPlan(serverId));
    const jointThreadProjection = isSubConversationType(channel.type)
      ? await channelService.getJointThreadProjectionByLocalThread(channelId, serverId)
      : null;
    const resolvedAccess = channel.type === "joint"
      ? await channelService.resolveChannelAccess({ serverId, channelId })
      : null;
    const storageChannelId = jointThreadProjection?.canonicalThreadChannelId
      ?? (resolvedAccess?.kind === "joint" ? resolvedAccess.canonicalChannelId : channelId);
    const projectionChannelId = jointThreadProjection?.localThreadChannelId
      ?? (resolvedAccess?.kind === "joint" ? resolvedAccess.localChannelId : channelId);
    const viewer = {
      attachmentCommentViewerUserId: ownerUserId,
      forwardedBundleViewerUserId: ownerUserId,
      viewerServerId: serverId,
      includeSenderTimezone: true,
    };
    const anchorNotFound = () => refuse(res, 404, { code: "message_not_found", error: "No message in this conversation matches that anchor: check its id, short id or seq." });
    const around = query.around?.trim();
    const before = query.before?.trim();
    const after = query.after?.trim();
    for (const anchor of [around, before, after]) {
      if (anchor && !isHistoryAnchorShape(anchor)) {
        refuse(res, 400, { code: "invalid_message_page_cursor", error: "An anchor is a message id, an 8-character short id, or a seq: send one of those." });
        return;
      }
    }
    let rawMsgs;
    let hasOlder = false;
    let hasNewer = false;
    if (around) {
      const resolution = await messageService.resolveMessageSeqAnchor(storageChannelId, around, "around", historyCutoff);
      if (!resolution.ok) {
        anchorNotFound();
        return;
      }
      const beforeCount = Math.floor((limit - 1) / 2);
      const context = await messageService.getMessageContextBySeq(
        storageChannelId,
        resolution.seq,
        beforeCount,
        limit - beforeCount - 1,
        historyCutoff,
        viewer,
      );
      if (!context || context.channelId !== storageChannelId) {
        anchorNotFound();
        return;
      }
      rawMsgs = context.messages;
      hasOlder = context.hasOlder;
      hasNewer = context.hasNewer;
    } else {
      const anchor = before ?? after;
      const resolution = anchor
        ? await messageService.resolveMessageSeqAnchor(storageChannelId, anchor, "pagination", historyCutoff)
        : undefined;
      if (resolution && !resolution.ok) {
        anchorNotFound();
        return;
      }
      const beforeSeq = before && resolution?.ok ? resolution.seq : undefined;
      const afterSeq = after && resolution?.ok ? resolution.seq : undefined;
      rawMsgs = await messageService.listMessages(storageChannelId, limit + 1, beforeSeq, afterSeq, historyCutoff, viewer);
      const probed = paginateHistoryProbe(
        rawMsgs,
        limit,
        afterSeq !== undefined ? "after" : beforeSeq !== undefined ? "before" : "latest",
      );
      rawMsgs = probed.messages;
      hasOlder = probed.hasOlder;
      hasNewer = probed.hasNewer;
    }
    const pageMsgs = jointThreadProjection || resolvedAccess?.kind === "joint"
      ? await messageService.projectJointMessagesToLocalChannel(rawMsgs, projectionChannelId, serverId)
      : rawMsgs;
    const renderedContents = await agentPermalinkRenderService.renderAgentReadablePermalinksInTexts(
      pageMsgs.map((message) => message.content),
      serverId,
    );
    // Every envelope names its conversation, like a delivered message: SDK
    // projection (`projectRaftMessage`) drops an envelope without it. DM-scoped
    // channels were refused above, so storage names are the agent-facing ones.
    const conversationLabels = await assistantOwnerConversationLabels(channel, serverId, ownerUserId);
    recordTraceEvent("server.agent_api.assistant.owner_messages", {
      agent_id: req.actingAgentId!,
      subject_user_id: ownerUserId,
      channel_id: channelId,
      channel_type: channel.type,
      message_count: pageMsgs.length,
    });
    const ownerMsgs = await withAgentMessageReactions(pageMsgs);
    sendAgentApiResponse("assistantOwnerMessages", res, {
      owner: { userId: ownerUserId },
      channelId,
      messages: ownerMsgs.map((message, index: number) => ({
        ...toAgentApiMessageEnvelope(
          message,
          messageService.appendAgentFacingForwardedSnapshot(
            renderAgentCommentScopedContent(renderedContents[index] ?? "", message.commentRef),
            message.actionMetadata,
          ),
          req.actingAgentId!,
        ),
        ...conversationLabels,
      })),
      hasMore: hasOlder || hasNewer,
      hasOlder,
      hasNewer,
    });
  } catch (err: unknown) {
    sendJsonServerError(req, res, {
      error: "Failed to read the owner's messages",
      code: "agent_api_assistant_owner_messages_failed",
      logPrefix: "[AgentAPI] Failed to read assistant owner messages",
      err,
    });
  }
});

// RFC 075, #proj-assistant:#31: an Artifact the owner can open, read as they would on the web.
registerAgentApiRoute("assistantOwnerArtifact", ...agentApiRequestValidators("assistantOwnerArtifact"), async (req, res) => {
  try {
    const ownerUserId = await requireAssistantOwner(req, res);
    if (!ownerUserId) return;
    const query = req.query as AgentApiAssistantOwnerArtifactQuery;
    const result = await readOwnerArtifact({
      agentId: req.actingAgentId!,
      serverId: req.serverId!,
      ownerUserId,
      ref: query.artifact,
      ...(query.version !== undefined ? { version: Number(query.version) } : {}),
      ...(query.path !== undefined ? { path: query.path } : {}),
      ...(query.commentsBefore !== undefined ? { commentsBefore: query.commentsBefore } : {}),
    });
    if (!result.ok) {
      refuse(res, result.status as RefusalStatus, { code: result.code, error: result.error });
      return;
    }
    sendAgentApiResponse("assistantOwnerArtifact", res, result.body);
  } catch (err: unknown) {
    sendJsonServerError(req, res, {
      error: "Failed to read the Artifact for the owner",
      code: "agent_api_assistant_owner_artifact_failed",
      logPrefix: "[AgentAPI] Failed to read an Artifact for an assistant's owner",
      err,
    });
  }
});

// RFC 075, #proj-assistant:#31 step 2: an Artifact published as the assistant, into its DM with its owner.
registerAgentApiRoute("assistantOwnerArtifactPublish", ...agentApiRequestValidators("assistantOwnerArtifactPublish"), async (req, res) => {
  try {
    const ownerUserId = await requireAssistantOwner(req, res);
    if (!ownerUserId) return;
    const app = firstPartyApps().find((candidate) => candidate.actingFor?.publishAs);
    if (!app) {
      refuse(res, 404, { code: "artifact_not_found", error: "Artifacts can't be published here." });
      return;
    }
    const result = await publishOwnerArtifact({
      agentId: req.actingAgentId!,
      serverId: req.serverId!,
      ownerUserId,
      request: req.body as AgentApiAssistantOwnerArtifactPublishBody,
      outbox: appNoticeOutbox(app, req.app.get("agentOrchestrator") as AgentOrchestrator | undefined),
    });
    if (!result.ok) {
      // A plan quota refusal is a paywall hit, the assistant's (no person), as an app's own route records it.
      noteAppPaywallHit(req, result.paywallHit, null);
      if (result.retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(result.retryAfterSeconds));
      refuse(res, result.status as RefusalStatus, {
        code: result.code,
        error: result.error,
        ...(result.details ? { details: result.details } : {}),
        ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      } as RefusalInput);
      return;
    }
    res.status(result.status);
    sendAgentApiResponse("assistantOwnerArtifactPublish", res, result.body);
  } catch (err: unknown) {
    sendJsonServerError(req, res, {
      error: "Failed to publish the Artifact",
      code: "agent_api_assistant_owner_artifact_publish_failed",
      logPrefix: "[AgentAPI] Failed to publish an Artifact for an assistant",
      err,
    });
  }
});

// RFC 077 owner actions: what the owner did themself since a time (references only).
registerAgentApiRoute("assistantOwnerActivity", ...agentApiRequestValidators("assistantOwnerActivity"), async (req, res) => {
  try {
    const serverId = req.serverId!;
    const ownerUserId = await requireAssistantOwner(req, res);
    if (!ownerUserId) return;
    const query = req.query as AgentApiAssistantOwnerActivityQuery;
    const since = query.since ? new Date(query.since) : new Date(Date.now() - assistantService.ASSISTANT_OWNER_ACTIVITY_DEFAULT_WINDOW_MS);
    if (Number.isNaN(since.getTime())) {
      refuse(res, 400, SINCE_TIME_INVALID_REFUSAL);
      return;
    }
    const limit = Math.min(Number(query.limit ?? 50), assistantService.ASSISTANT_OWNER_ACTIVITY_MAX_LIMIT);
    const { items, hasMore } = await assistantService.listOwnerActivity({ agentId: req.actingAgentId!, serverId, ownerUserId, since, limit });
    recordTraceEvent("server.agent_api.assistant.owner_activity", {
      agent_id: req.actingAgentId!,
      subject_user_id: ownerUserId,
      returned_count: items.length,
    });
    sendAgentApiResponse("assistantOwnerActivity", res, {
      owner: { userId: ownerUserId },
      items: items.map((item) => ({ ...item })),
      hasMore,
      nextSince: items.length > 0 ? items[items.length - 1]!.at : null,
    });
  } catch (err: unknown) {
    sendJsonServerError(req, res, {
      error: "Failed to list the owner's activity",
      code: "agent_api_assistant_owner_activity_failed",
      logPrefix: "[AgentAPI] Failed to list assistant owner activity",
      err,
    });
  }
});

// Who `@name` is, as the owner would find them; someone the owner cannot see
// gets the same 404 as someone who does not exist.
registerAgentApiRoute("assistantOwnerResolve", ...agentApiRequestValidators("assistantOwnerResolve"), async (req, res) => {
  try {
    const serverId = req.serverId!;
    const ownerUserId = await requireAssistantOwner(req, res);
    if (!ownerUserId) return;
    const query = req.query as AgentApiAssistantOwnerResolveQuery;
    const result = await assistantService.resolveNameForOwner(serverId, ownerUserId, query.name);
    recordTraceEvent("server.agent_api.assistant.owner_resolve", {
      agent_id: req.actingAgentId!,
      subject_user_id: ownerUserId,
      outcome: result.ok ? result.type : result.code,
    });
    if (!result.ok) {
      res.status(result.code === assistantService.OWNER_RESOLVE_AMBIGUOUS_CODE ? 409 : 404).json(
        result.code === assistantService.OWNER_RESOLVE_AMBIGUOUS_CODE
          ? { error: "A person and an agent share that name. Add ~human or ~agent.", code: result.code }
          : { error: "Your owner cannot see anyone or any channel by that name here.", code: result.code },
      );
      return;
    }
    sendAgentApiResponse("assistantOwnerResolve", res, { id: result.id, type: result.type, name: result.name });
  } catch (err: unknown) {
    sendJsonServerError(req, res, {
      error: "Failed to resolve the name",
      code: "agent_api_assistant_owner_resolve_failed",
      logPrefix: "[AgentAPI] Failed to resolve a name for an assistant owner",
      err,
    });
  }
});

// RFC 077 step 1: the owner's contact rules, quiet hours and "already told"
// facts, kept by Raft (assistantContactRulesService). Every route re-resolves
// the live assistant link (`requireAssistantOwner`).
async function assistantContactRoute(
  req: Request,
  res: Response,
  label: string,
  run: (owner: { agentId: string; serverId: string; ownerUserId: string }) => Promise<void>,
): Promise<void> {
  try {
    const ownerUserId = await requireAssistantOwner(req, res);
    if (!ownerUserId) return;
    await run({ agentId: req.actingAgentId!, serverId: req.serverId!, ownerUserId });
  } catch (err: unknown) {
    if (err instanceof assistantContactRulesService.AssistantContactRuleError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    sendJsonServerError(req, res, {
      error: `Failed to ${label}`,
      code: "agent_api_assistant_contact_failed",
      logPrefix: `[AgentAPI] Failed to ${label}`,
      err,
    });
  }
}

registerAgentApiRoute("assistantContactRules", ...agentApiRequestValidators("assistantContactRules"), (req, res) =>
  assistantContactRoute(req, res, "list the owner's contact rules", async (owner) => {
    sendAgentApiResponse("assistantContactRules", res, await assistantContactRulesService.listContactRules(owner));
  }));

registerAgentApiRoute("assistantContactRuleAdd", ...agentApiRequestValidators("assistantContactRuleAdd"), (req, res) =>
  assistantContactRoute(req, res, "store the contact rule", async (owner) => {
    const body = req.body as AgentApiRequestBodyByRoute["assistantContactRuleAdd"];
    const result = await assistantContactRulesService.addContactRule(owner, body);
    recordTraceEvent("server.agent_api.assistant.contact_rule", {
      agent_id: owner.agentId,
      action: result.updated ? "updated" : "added",
      effect: result.rule.effect,
      subject_kind: result.rule.subject.kind,
    });
    sendAgentApiResponse("assistantContactRuleAdd", res, result);
  }));

registerAgentApiRoute("assistantContactRuleRemove", ...agentApiRequestValidators("assistantContactRuleRemove"), (req, res) =>
  assistantContactRoute(req, res, "remove the contact rule", async (owner) => {
    const params = req.params as AgentApiRequestParamsByRoute["assistantContactRuleRemove"];
    const result = await assistantContactRulesService.removeContactRule(owner, params.ruleId);
    recordTraceEvent("server.agent_api.assistant.contact_rule", { agent_id: owner.agentId, action: "removed" });
    sendAgentApiResponse("assistantContactRuleRemove", res, result);
  }));

registerAgentApiRoute("assistantContactSettings", ...agentApiRequestValidators("assistantContactSettings"), (req, res) =>
  assistantContactRoute(req, res, "set the owner's quiet hours", async (owner) => {
    const body = req.body as AgentApiRequestBodyByRoute["assistantContactSettings"];
    const result = await assistantContactRulesService.setContactSettings(owner, body);
    recordTraceEvent("server.agent_api.assistant.contact_settings", { agent_id: owner.agentId, quiet: result.settings.quiet ? "set" : "off" });
    sendAgentApiResponse("assistantContactSettings", res, result);
  }));

// The owner's own settings (theme in this server, UI language, time zone),
// changed when the owner asks: the web's own checks and writes, each change
// audited and shown to the owner (assistantOwnerSettingsService). A refusal is
// the web route's own 400 `{ error }`.
async function assistantOwnerSettingsRoute(
  req: Request,
  res: Response,
  label: string,
  run: (owner: { agentId: string; serverId: string; ownerUserId: string }) => Promise<void>,
): Promise<void> {
  try {
    const ownerUserId = await requireAssistantOwner(req, res);
    if (!ownerUserId) return;
    await run({ agentId: req.actingAgentId!, serverId: req.serverId!, ownerUserId });
  } catch (err: unknown) {
    if (err instanceof assistantOwnerSettingsService.AssistantOwnerSettingsError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    sendJsonServerError(req, res, {
      error: `Failed to ${label}`,
      code: "agent_api_assistant_owner_settings_failed",
      logPrefix: `[AgentAPI] Failed to ${label}`,
      err,
    });
  }
}

registerAgentApiRoute("assistantOwnerSettings", ...agentApiRequestValidators("assistantOwnerSettings"), (req, res) =>
  assistantOwnerSettingsRoute(req, res, "read the owner's settings", async (owner) => {
    const settings = await assistantOwnerSettingsService.getOwnerSettings(owner.serverId, owner.ownerUserId);
    sendAgentApiResponse("assistantOwnerSettings", res, { settings });
  }));

registerAgentApiRoute("assistantOwnerSettingsUpdate", ...agentApiRequestValidators("assistantOwnerSettingsUpdate"), (req, res) =>
  assistantOwnerSettingsRoute(req, res, "change the owner's settings", async (owner) => {
    const result = await assistantOwnerSettingsService.updateOwnerSettings(
      { ...owner, io: req.app.get("io") as SocketServer | undefined },
      req.body,
    );
    recordTraceEvent("server.agent_api.assistant.owner_settings", { agent_id: owner.agentId, changed: result.changed.join(",") });
    sendAgentApiResponse("assistantOwnerSettingsUpdate", res, result);
  }));

registerAgentApiRoute("assistantContactRulesImport", ...agentApiRequestValidators("assistantContactRulesImport"), (req, res) =>
  assistantContactRoute(req, res, "import the contact rules", async (owner) => {
    const body = req.body as AgentApiRequestBodyByRoute["assistantContactRulesImport"];
    const result = await assistantContactRulesService.importContactRules(owner, body);
    recordTraceEvent("server.agent_api.assistant.contact_rules_import", { agent_id: owner.agentId, ...result });
    sendAgentApiResponse("assistantContactRulesImport", res, result);
  }));

registerAgentApiRoute("assistantCheckStateImport", ...agentApiRequestValidators("assistantCheckStateImport"), (req, res) =>
  assistantContactRoute(req, res, "import the brief state", async (owner) => {
    const body = req.body as AgentApiRequestBodyByRoute["assistantCheckStateImport"];
    const result = await assistantService.importAssistantCheckState(owner, body);
    recordTraceEvent("server.assistant.check_state_import", { agent_id: owner.agentId, brief_today: result.briefToday });
    sendAgentApiResponse("assistantCheckStateImport", res, result);
  }));

registerAgentApiRoute("assistantToldRecord", ...agentApiRequestValidators("assistantToldRecord"), (req, res) =>
  assistantContactRoute(req, res, "record what the owner was told", async (owner) => {
    const body = req.body as AgentApiRequestBodyByRoute["assistantToldRecord"];
    const result = await assistantContactRulesService.recordTold(owner, body);
    recordTraceEvent("server.agent_api.assistant.told", { agent_id: owner.agentId, via: body.via, ...result });
    sendAgentApiResponse("assistantToldRecord", res, result);
  }));

registerAgentApiRoute("assistantToldList", ...agentApiRequestValidators("assistantToldList"), (req, res) =>
  assistantContactRoute(req, res, "list what the owner was told", async (owner) => {
    const query = req.query as AgentApiRequestQueryByRoute["assistantToldList"];
    const since = query.since ? new Date(query.since) : new Date(Date.now() - assistantContactRulesService.ASSISTANT_TOLD_RETENTION_MS);
    if (Number.isNaN(since.getTime())) {
      refuse(res, 400, SINCE_TIME_INVALID_REFUSAL);
      return;
    }
    const limit = Math.min(Number(query.limit ?? 200), 500);
    sendAgentApiResponse("assistantToldList", res, await assistantContactRulesService.listTold(owner.agentId, { since, cursor: query.cursor, limit }));
  }));

// RFC 077 step 2: the model's lines for a Raft check; Raft composes and sends the owner DM.
registerAgentApiRoute("assistantNotify", ...agentApiRequestValidators("assistantNotify"), async (req, res) => {
  try {
    const serverId = req.serverId!;
    const ownerUserId = await requireAssistantOwner(req, res);
    if (!ownerUserId) return;
    const body = req.body as AgentApiRequestBodyByRoute["assistantNotify"];
    const result = await assistantNotifyService.notifyOwner({
      io: req.app.get("io"),
      orchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator,
      agentId: req.actingAgentId!,
      serverId,
      ownerUserId,
      checkId: body.check_id,
      idempotencyKey: body.idempotency_key,
      items: body.items,
    });
    sendAgentApiResponse("assistantNotify", res, result);
  } catch (err: unknown) {
    if (err instanceof assistantNotifyService.AssistantNotifyError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to notify the owner",
      code: "agent_api_assistant_notify_failed",
      logPrefix: "[AgentAPI] Failed to notify an assistant owner",
      err,
    });
  }
});

// RFC 077: send a message as the owner (`delegated_by` = this assistant).
// Every check and its refusal lives in assistantSendAsOwnerService.
registerAgentApiRoute("assistantSendAsOwner", ...agentApiRequestValidators("assistantSendAsOwner"), async (req, res) => {
  try {
    const serverId = req.serverId!;
    const ownerUserId = await requireAssistantOwner(req, res);
    if (!ownerUserId) return;
    const body = req.body as AgentApiAssistantSendAsOwnerBody;
    const result = await assistantSendAsOwnerService.sendAsOwner({
      io: req.app.get("io"),
      orchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator,
      serverId,
      agentId: req.actingAgentId!,
      ownerUserId,
      ...(body.channelId ? { channelId: body.channelId } : {}),
      ...(body.dmWith ? { dmWith: body.dmWith } : {}),
      content: body.content,
      ...(body.parentMessageId ? { parentMessageId: body.parentMessageId } : {}),
    });
    sendAgentApiResponse("assistantSendAsOwner", res, { messageId: result.messageId, channelId: result.channelId });
  } catch (err: unknown) {
    if (err instanceof assistantSendAsOwnerService.AssistantSendAsOwnerError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof channelService.ChannelArchivedError) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to send as the owner",
      code: "agent_api_assistant_send_as_owner_failed",
      logPrefix: "[AgentAPI] Failed to send as assistant owner",
      err,
    });
  }
});

// RFC 077 forwardAsOwner: forward as the owner, shaped like the web's batch
// forward. Every check, refusal and the receipt live in assistantForwardAsOwnerService.
registerAgentApiRoute("assistantForwardAsOwner", ...agentApiRequestValidators("assistantForwardAsOwner"), async (req, res) => {
  try {
    const ownerUserId = await requireAssistantOwner(req, res);
    if (!ownerUserId) return;
    const body = req.body as AgentApiAssistantForwardAsOwnerBody;
    const result = await assistantForwardAsOwnerService.forwardAsOwner({
      io: req.app.get("io"),
      orchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator,
      serverId: req.serverId!,
      agentId: req.actingAgentId!,
      ownerUserId,
      messages: body.messages,
      to: body.to,
      ...(body.note !== undefined ? { note: body.note } : {}),
      requestId: body.requestId,
      ...(body.dryRun ? { dryRun: true } : {}),
    });
    sendAgentApiResponse("assistantForwardAsOwner", res, result);
  } catch (err: unknown) {
    if (err instanceof assistantSendAsOwnerService.AssistantSendAsOwnerError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof ChannelConversionInProgressError) {
      res.status(err.status).json({ error: "A source conversation is being converted right now. Retry the same request (same requestId) in a moment.", code: err.code });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to forward as the owner",
      code: "agent_api_assistant_forward_as_owner_failed",
      logPrefix: "[AgentAPI] Failed to forward as assistant owner",
      err,
    });
  }
});

// The web forward picker's search, as the owner; `to` goes back into forwardAsOwner.
registerAgentApiRoute("assistantSearchForwardTargets", ...agentApiRequestValidators("assistantSearchForwardTargets"), async (req, res) => {
  try {
    const ownerUserId = await requireAssistantOwner(req, res);
    if (!ownerUserId) return;
    const query = req.query as AgentApiAssistantSearchForwardTargetsQuery;
    const found = await assistantForwardAsOwnerService.searchForwardTargetsForOwner({
      serverId: req.serverId!,
      agentId: req.actingAgentId!,
      ownerUserId,
      q: query.q,
      ...(query.limit ? { limit: Number(query.limit) } : {}),
    });
    sendAgentApiResponse("assistantSearchForwardTargets", res, found);
  } catch (err: unknown) {
    sendJsonServerError(req, res, {
      error: "Failed to search forward targets",
      code: "agent_api_assistant_forward_targets_failed",
      logPrefix: "[AgentAPI] Failed to search forward targets for an assistant owner",
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
    // Both reading your own profile and looking up another member's need
    // only `read` (the route capability): a target lookup returns only
    // profiles this agent can already see (visibility is enforced by
    // resolveProfileViewForAgent), and member listing is already `read`.
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const resolved = await resolveProfileViewForAgent(serverId, agentId, query.target, agentOrchestrator);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    sendAgentApiResponse("profileShow", res, resolved.profile);
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to load profile",
      logPrefix: "internal.agent-api.profile-show error:",
      err,
    });
  }
});
registerAgentApiRoute("profileUpdate", ...agentApiRequestValidators("profileUpdate"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const body = req.body as AgentApiRequestBodyByRoute["profileUpdate"];
    // A missing row skips the fence: nothing is written, and the update below answers agent_not_found.
    const profileTarget = await agentService.getAgent(agentId);
    const fenced = profileTarget
      ? await agentProfileFenceRefusal(profileTarget, body, async () => Boolean(await getHostedRuntimeSummary(agentId)))
      : null;
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
    // An assistant is always Ottie (the allowlist already refuses this route
    // to it; this holds if that changes), and its avatar is reserved.
    const profileRefusal = profileTarget ? assistantService.agentProfileWriteRefusal(profileTarget, fields) : null;
    if (profileRefusal) {
      refuse(res, profileRefusal.status, { code: profileRefusal.code, error: profileRefusal.error });
      return;
    }

    const updated = await agentService.updateAgent(agentId, fields);
    if (!updated) {
      refuse(res, 404, AGENT_GONE_REFUSAL);
      return;
    }
    broadcastAgentUpdated(req, updated.serverId, agentId);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    agentOrchestrator?.evictCache(agentId);
    const profile = await buildAgentProfileView(agentId, agentId, agentOrchestrator);
    if (!profile) {
      refuse(res, 404, AGENT_GONE_REFUSAL);
      return;
    }
    sendAgentApiResponse("profileUpdate", res, profile);
    recordRaftCliActivity(req, agentId, {
      command: "profile.update",
      summary: "Updated profile",
      target: `@${profile.name}`,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to update profile",
      logPrefix: "internal.agent-api.profile-update error:",
      err,
    });
  }
});
registerAgentApiRoute("profileAvatarUpdate", async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const agent = await agentService.getAgent(agentId);
    if (!agent || agent.serverId !== serverId) {
      refuse(res, 404, AGENT_GONE_REFUSAL);
      return;
    }
    // Same fence as the admin route: a managed bot's avatar follows the app logo.
    if (agent.managedByAppInstallId) {
      refuse(res, 403, APP_BOT_AVATAR_MANAGED_REFUSAL);
      return;
    }
    // An assistant's avatar is always Ottie's (the allowlist refuses this route to it too).
    if (agent.assistantOwnerUserId) {
      refuse(res, 403, { code: assistantService.ASSISTANT_PROFILE_FIXED_CODE, error: assistantService.ASSISTANT_PROFILE_FIXED_ERROR });
      return;
    }
    const uploaded = await runSingleAvatarUpload(profileAvatarUpload, req);
    if (!uploaded) {
      refuse(res, 400, AVATAR_FILE_REQUIRED_REFUSAL);
      return;
    }

    const avatarUrl = await storeAgentAvatar(serverId, agent.avatarUrl, uploaded.buffer);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    agentOrchestrator?.evictCache(agentId);
    await agentService.updateAgent(agentId, { avatarUrl });
    broadcastAgentUpdated(req, serverId, agentId);

    const profile = await buildAgentProfileView(agentId, agentId, agentOrchestrator);
    if (!profile) {
      refuse(res, 404, AGENT_GONE_REFUSAL);
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
      refuse(res, 400, AVATAR_TOO_LARGE_REFUSAL);
      return;
    }
    if (err instanceof Error && err.message.includes(PROFILE_AVATAR_BAD_FORMAT_MESSAGE)) {
      refuse(res, 400, AVATAR_BAD_FORMAT_REFUSAL);
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to update avatar",
      logPrefix: "internal.agent-api.profile-avatar-update error:",
      err,
    });
  }
});
registerAgentApiRoute("integrationList", ...agentApiRequestValidators("integrationList"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    // A personal assistant sees the one app it may use (the Reminder app) and nothing else.
    const assistant = Boolean((await agentService.getAgent(agentId))?.assistantOwnerUserId);
    const [allClients, overview, allMcpApps] = await Promise.all([
      oauthService.listAgentAvailableOAuthClients(serverId),
      oauthService.getAgentIntegrationsOverview(agentId),
      // MCP Apps are Raft Apps too. A failure here must not take the Agent Login inventory down with
      // it: the field is then omitted, as from an older server.
      listAgentMcpAppsForIntegrationInventory(serverId, agentId).catch((err: unknown) => {
        console.error("internal.agent-api.integrations-list MCP Apps error:", err);
        return undefined;
      }),
    ]);
    const reminderUuid = assistant ? await assistantAllowedOAuthClientUuid() : null;
    const clients = assistant ? allClients.filter((client) => client.id === reminderUuid) : allClients;
    const mcpApps = assistant ? undefined : allMcpApps;
    const activeLogins = overview
      .filter((item) => item.type === "active" && !item.revokedAt)
      .filter((item) => !assistant || item.clientId === reminderUuid)
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
          // Publisher text: inert, like the services list's names.
          name: renderThirdPartyInertText({ field: "app_name", value: item.clientName }),
          description: item.clientDescription
            ? renderThirdPartyInertText({ field: "description", value: item.clientDescription })
            : null,
          homepageUrl: item.clientHomepageUrl ?? null,
          returnUrl: item.clientReturnUrl ?? null,
          agentManifestUrl: agentManifest.url,
          agentManifestUrlSource: agentManifest.source ?? null,
          scopes: item.scopes,
          createdAt: item.createdAt,
        };
      });

    // Task #4: an agent reads the prompt text its Server confirmed here too,
    // the same as in its system prompt; an app with none shows its name only.
    const services = (await resolveAgentFacingPromptText(serverId, clients)).map(({ promptText, ...client }) => ({
      ...client,
      name: promptText?.name ?? client.name,
      description: promptText ? promptText.description : null,
      whenToUse: promptText ? promptText.whenToUse : null,
    }));
    // RFC 084: the one resolver, so an old id finds its App and never another
    // App that happens to have that name. Left out for an ambiguous name, which
    // the CLI's and SDK's own name match has always taken as the first.
    const serviceQuery = (req.query as AgentApiRequestQueryByRoute["integrationList"]).service;
    const resolvedService = serviceQuery ? await resolveAgentLoginClient(clients, serviceQuery) : null;
    sendAgentApiResponse("integrationList", res, {
      services: await Promise.all(services.map((client) => serializeOAuthClientForAgentApi(client, serverId))),
      activeLogins,
      ...(mcpApps ? { mcpApps } : {}),
      ...(resolvedService && (resolvedService.ok || resolvedService.status === 404)
        ? { resolvedServiceId: resolvedService.ok ? resolvedService.client.id : null }
        : {}),
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to list agent integrations",
      logPrefix: "internal.agent-api.integrations-list error:",
      err,
    });
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
        refuse(res, 400, MARKETPLACE_LIMIT_INVALID_REFUSAL);
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
        apps: await Promise.all(apps.map(serializeMarketplaceOAuthClientForAgentApi)),
      });
      recordRaftCliActivity(req, agentId, {
        command: "integration.marketplace",
        summary: normalizedQuery ? "Searched public Marketplace apps" : "Listed public Marketplace apps",
        target: `${apps.length} result${apps.length === 1 ? "" : "s"}`,
      });
    } catch (err) {
      sendJsonServerError(req, res, {
        error: "Failed to search public Marketplace apps",
        logPrefix: "internal.agent-api.integrations-marketplace error:",
        err,
      });
    }
  },
);
registerAgentApiRoute("integrationToken", ...agentApiRequestValidators("integrationToken"), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const body = req.body as AgentApiRequestBodyByRoute["integrationToken"];
    const result = await issueAgentAudienceJwt({ serverId: req.serverId!, agentId: req.actingAgentId!, service: body.service });
    sendAgentApiResponse("integrationToken", res, result);
  } catch (error) {
    if (error instanceof AgentAudienceJwtError) {
      refuse(res, 403, AGENT_JWT_NOT_AUTHORIZED_REFUSAL);
      return;
    }
    sendJsonServerError(req, res, { error: "Agent JWT issuance failed", logPrefix: "internal.agent-api.integration-token error:", err: error });
  }
});
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
      refuse(res, 404, AGENT_GONE_REFUSAL);
      return;
    }
    phase = "server_lookup";
    const server = await serverService.getServer(serverId);
    if (!server) {
      closeTrace({ outcome: "rejected", reason: "server_not_found", httpStatus: 404 });
      refuse(res, 404, AGENT_SERVER_GONE_REFUSAL);
      return;
    }

    phase = "service_list";
    const clients = await oauthService.listAgentAvailableOAuthClients(serverId);
    phase = "service_resolve";
    const resolved = await resolveAgentLoginClient(clients, body.service);
    // RFC 077: a personal assistant may log in to the Reminder app only.
    if (agent.assistantOwnerUserId && !(resolved.ok && resolved.client.id === await assistantAllowedOAuthClientUuid())) {
      closeTrace({ outcome: "rejected", reason: "assistant_integration_not_allowed", httpStatus: 403 });
      refuse(res, 403, ASSISTANT_INTEGRATION_NOT_ALLOWED_BODY);
      return;
    }
    if (!resolved.ok) {
      if (resolved.status !== 404) {
        closeTrace({ outcome: "rejected", reason: "service_resolution_failed", httpStatus: resolved.status });
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }

      // Installed here but suspended: not available, and not "install it"
      // either (the Marketplace fallback below would offer an install).
      phase = "suspended_resolve";
      const suspended = await resolveAgentLoginClient(await oauthService.listSuspendedThirdPartyOAuthClients(serverId), body.service);
      if (suspended.ok) {
        appType = suspended.client.appType;
        closeTrace({ outcome: "rejected", reason: "installation_suspended", httpStatus: 403 });
        refuse(res, 403, installationSuspendedRefusal(suspended.client.clientId));
        return;
      }

      // An MCP App is a Raft App too, without Agent Login. `login` asks a person for what this Agent
      // lacks (the grant and/or a Connection) by posting the App's Connect card at --target, as an
      // ordinary login posts its approval card. Every answer is a non-2xx with its own errorCode and a
      // message that carries the next step: an older CLI, which knows no MCP Apps, prints the message
      // (a 2xx it does not know would be read as an Agent Login and crash).
      phase = "mcp_app_resolve";
      const mcpApp = !resolved.clientKeyMatched && typeof body.service === "string"
        ? findMcpAppForService(await listAgentMcpAppsForIntegrationInventory(serverId, agentId), body.service)
        : null;
      if (mcpApp) {
        const mcpAppRef = { type: mcpApp.type, id: mcpApp.id, name: mcpApp.name, state: mcpApp.state, grant: mcpApp.grant };
        const reply = (reason: string, httpStatus: number, errorCode: string, error: string, extra: Record<string, unknown> = {}) => {
          closeTrace({ outcome: "rejected", reason, httpStatus });
          res.status(httpStatus).json({ error, errorCode, mcpApp: mcpAppRef, ...extra });
        };
        if (mcpApp.state === "disabled") {
          reply("mcp_app_disabled", 409, "INTEGRATION_MCP_APP_DISABLED", mcpAppLoginMessage(mcpApp, "disabled"));
          return;
        }
        if (!mcpAppNeedsRequest(mcpApp)) {
          reply("mcp_app_ready", 409, "INTEGRATION_MCP_APP_READY", mcpAppLoginMessage(mcpApp, "ready"));
          return;
        }
        const mcpTarget = typeof body.target === "string" ? body.target.trim() : "";
        if (!mcpTarget) {
          reply("mcp_target_required", 409, "INTEGRATION_MCP_TARGET_REQUIRED", mcpAppLoginMessage(mcpApp, "target_required"));
          return;
        }
        phase = "mcp_card_target";
        const resolvedMcpTarget = await channelService.resolveChannelByName(serverId, agentId, mcpTarget);
        if (!resolvedMcpTarget) {
          closeTrace({ outcome: "rejected", reason: "mcp_card_target_not_found", httpStatus: 404 });
          refuse(res, 404, targetNotFoundRefusal(mcpTarget));
          return;
        }
        phase = "mcp_card";
        const [mcpRow] = await getDb()
          .select({ configVersion: managedMcpServers.configVersion })
          .from(managedMcpServers)
          .where(and(eq(managedMcpServers.id, mcpApp.id), eq(managedMcpServers.serverId, serverId)))
          .limit(1);
        // The same producer a refused tool call uses: one open card per (Server, Agent, App), reused.
        const card = await produceMcpConnectionCard({
          serverId,
          agentId,
          mcpServerId: mcpApp.id,
          revision: mcpRow?.configVersion ?? 1,
          targetChannelId: resolvedMcpTarget.channelId,
        });
        const asked = mcpApp.grant !== "granted" ? "grant you access to it" : "connect it";
        reply(
          "mcp_connection_requested",
          409,
          "INTEGRATION_MCP_CONNECTION_REQUESTED",
          `${formatManagedMcpPromptName(mcpApp.name)} is an MCP App, used through its MCP tools rather than Agent Login. `
            + (card.reused
              ? `A request for it is already open (card ${card.cardMessageId}); it was not posted again. `
              : `A request card was posted to ${mcpTarget} for a person who can ${asked}. `)
            + "Wait for them to grant it in the card, then call its MCP tools (if they are not in your tool list yet, use raft_app_tools / raft_app_call).",
          { actionCardMessageId: card.cardMessageId, target: mcpTarget, reused: card.reused },
        );
        return;
      }

      phase = "marketplace_resolve";
      const publicClients = await oauthService.listPublicMarketplaceOAuthClients();
      const marketplaceResolved = await resolveAgentLoginClient(publicClients, body.service);
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
        agentHandoffProtocol: marketplaceResolved.client.agentHandoffProtocol,
        service: await serializeOAuthClientForAgentApi(marketplaceResolved.client, serverId),
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
          refuse(res, 404, targetNotFoundRefusal(target));
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

    if (resolved.client.agentHandoffProtocol === "v1" && !body.agentHandoffChallenge) {
      refuse(res, 400, { code: "INTEGRATION_HANDOFF_UPGRADE_REQUIRED", error: "This App needs an updated Agent Login client; update it and retry." });
      return;
    }

    phase = "scope_normalize";
    const scopes = normalizeAgentLoginScopes(body.scopes, resolved.client);
    scopeCount = scopes.length;
    phase = "access_request";
    const requested = await oauthService.requestAgentAccess({
      clientId: resolved.client.id,
      serverSlug: server.slug,
      agentName: agent.name,
      scopes,
      initiatedByAgent: true,
      agentHandoffChallenge: resolved.client.agentHandoffProtocol === "v1" ? body.agentHandoffChallenge : undefined,
      resumeRequestId: resolved.client.agentHandoffProtocol === "v1" ? body.resumeRequestId : undefined,
    });

    if (requested.grantStatus === "pending") {
      const response: AgentApiResponseByRoute["integrationLogin"] = {
        status: "approval_required",
        agentHandoffProtocol: resolved.client.agentHandoffProtocol,
        service: await serializeOAuthClientForAgentApi(resolved.client, serverId),
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
          refuse(res, 404, targetNotFoundRefusal(target));
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
      agentHandoffProtocol: resolved.client.agentHandoffProtocol,
      service: await serializeOAuthClientForAgentApi(resolved.client, serverId),
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
    if (err instanceof DmTargetResolutionError) {
      closeTrace({ outcome: "rejected", reason: err.code, httpStatus: err.status });
      res.status(err.status).json(err.toResponseBody());
      return;
    }
    // Suspended between the listing and the request.
    if (err instanceof oauthService.OAuthInstallationSuspendedError) {
      closeTrace({ outcome: "rejected", reason: "installation_suspended", httpStatus: 403 });
      refuse(res, 403, installationSuspendedRefusal(null));
      return;
    }
    const message = err instanceof Error ? err.message : "Failed to provision agent login";
    if (message === "Agent handoff request unavailable") {
      closeTrace({ outcome: "rejected", reason: "handoff_unavailable", httpStatus: 409 });
      refuse(res, 409, { code: "INTEGRATION_HANDOFF_REQUEST_UNAVAILABLE", error: "This Agent Login request is no longer available; start login again." });
      return;
    }
    const scopeRefusal = agentLoginScopeRefusal(message);
    if (scopeRefusal) {
      closeTrace({ outcome: "rejected", reason: message, httpStatus: 400 });
      refuse(res, 400, scopeRefusal);
      return;
    }
    if (message.includes("not found")) {
      closeTrace({ outcome: "rejected", reason: "not_found", httpStatus: 404 });
      refuse(res, 404, agentLoginNotFoundRefusal(message));
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
      refuse(res, 410, APP_UPDATE_CARD_DISABLED_REFUSAL);
      return;
    }
    const target = optionalIntegrationString(body.target);
    if (!target) {
      refuse(res, 400, APP_CARD_TARGET_REQUIRED_REFUSAL);
      return;
    }
    const clientKey = optionalIntegrationString(body.clientKey);
    const resolvedTarget = await channelService.resolveChannelByName(serverId, agentId, target);
    if (!resolvedTarget) {
      refuse(res, 404, targetNotFoundRefusal(target));
      return;
    }

    const scopes = normalizeIntegrationAppPrepareScopes(body.scopes);
    if (scopes.some((scope) => !isRaftOAuthScope(scope))) {
      refuse(res, 400, APP_SCOPE_UNKNOWN_REFUSAL);
      return;
    }
    const rawCategory = optionalIntegrationString(body.category);
    const category = rawCategory ? canonicalizeOAuthClientCategory(rawCategory) : undefined;
    if (rawCategory && !category) {
      refuse(res, 400, APP_CATEGORY_INVALID_REFUSAL);
      return;
    }
    const unsafeDemoUrlOverride = body.unsafeDemoUrlOverride === true;
    const draftHint = optionalIntegrationString(body.draftHint);
    const homepageUrl = optionalIntegrationString(body.homepageUrl);
    const returnUrl = optionalIntegrationString(body.returnUrl);
    const agentManifestUrl = optionalIntegrationString(body.agentManifestUrl);
    const setupUrl = optionalIntegrationString(body.setupUrl);
    const setupDescription = optionalIntegrationString(body.setupDescription);

    const name = optionalIntegrationString(body.name);
    if (!name) {
      refuse(res, 400, APP_NAME_REQUIRED_REFUSAL);
      return;
    }
    if (!returnUrl) {
      refuse(res, 400, APP_RETURN_URL_REQUIRED_REFUSAL);
      return;
    }
    // The id is fixed here, so the card shows the exact one: the agent's, as
    // it will be stored, or the name as it is. Nothing random is added; a name
    // that makes no id, or an id another App holds, is the agent's to change
    // now, before a person is asked to approve it (artin, #proj-apps:#57).
    // Prepare reserves nothing: two open cards for one id still end in the
    // second's CLIENT_KEY_TAKEN when it is approved.
    const explicitClientKey = clientKey ? oauthService.canonicalClientKey(clientKey) : null;
    if (clientKey && !explicitClientKey) {
      refuse(res, 400, {
        code: "INVALID_CLIENT_KEY",
        error: "This client id isn't valid: an id starts with a letter, has 3 to 64 characters, and uses only lowercase letters, numbers and hyphens.",
        suggestedNextAction: "Choose a valid client id with --client-key.",
      });
      return;
    }
    const appClientKey = explicitClientKey ?? oauthService.clientKeyFromName(name);
    if (!appClientKey) {
      refuse(res, 400, {
        code: "CLIENT_KEY_REQUIRED",
        error: "This App name can't become a client id on its own: an id starts with a Latin letter and has at least 3 characters.",
        suggestedNextAction: "Choose a client id with --client-key.",
      });
      return;
    }
    if (await oauthService.isClientKeyTaken(appClientKey)) {
      refuse(res, 409, {
        code: "CLIENT_KEY_TAKEN",
        error: `The client id "${appClientKey}" is already taken by another App.`,
        suggestedNextAction: "Choose another client id with --client-key.",
      });
      return;
    }
    const action: Extract<ActionCardAction, { type: "integration:register_app" }> = {
      type: "integration:register_app",
      name,
      clientKey: appClientKey,
      description: optionalIntegrationString(body.description),
      category: category ?? undefined,
      homepageUrl,
      returnUrl,
      agentManifestUrl,
      setupUrl,
      setupDescription,
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
      refuse(res, 400, appRegistrationScopeRefusal(err.message));
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to prepare integration app registration",
      logPrefix: "internal.agent-api.integrations-app-prepare error:",
      err,
    });
  }
});
registerAgentApiRoute("integrationAppRotateSecret", ...agentApiRequestValidators("integrationAppRotateSecret"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const body = req.body as AgentApiRequestBodyByRoute["integrationAppRotateSecret"];
    const clientKey = optionalIntegrationString(body.clientKey);
    if (!clientKey) {
      refuse(res, 400, APP_CLIENT_KEY_REQUIRED_REFUSAL);
      return;
    }

    const rotated = await oauthService.rotateClientSecretForAgent({
      serverId,
      clientKey,
      actorAgentId: agentId,
    });

    if (rotated.status === "not_found") {
      // Unknown and cross-server clients remain non-enumerating.
      refuse(res, 404, APP_NOT_FOUND_REFUSAL);
      return;
    }
    if (rotated.status === "owner_required") {
      refuse(res, 403, appManageAuthorityRefusal("rotate its secret"));
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
    sendJsonServerError(req, res, {
      error: "Failed to rotate integration app secret",
      logPrefix: "internal.agent-api.integrations-app-rotate-secret error:",
      err,
    });
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
      refuse(res, 400, APP_TRANSFER_FIELDS_REQUIRED_REFUSAL);
      return;
    }
    const targetAgentId = await channelService.resolveAgentByName(serverId, targetAgentName, {});
    if (!targetAgentId) {
      refuse(res, 404, appTransferTargetNotFoundRefusal(targetAgentName));
      return;
    }

    const transferred = await oauthService.transferClientOwnershipForAgent({
      serverId,
      clientKey,
      actorAgentId: agentId,
      targetAgentId,
    });
    if (transferred.status === "not_found") {
      refuse(res, 404, APP_NOT_FOUND_REFUSAL);
      return;
    }
    if (transferred.status === "owner_required") {
      refuse(res, 403, appManageAuthorityRefusal("transfer it"));
      return;
    }
    if (transferred.status === "target_not_found") {
      refuse(res, 404, appTransferTargetNotFoundRefusal(targetAgentName));
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
    sendJsonServerError(req, res, {
      error: "Failed to transfer integration app ownership",
      logPrefix: "internal.agent-api.integrations-app-transfer-owner error:",
      err,
    });
  }
});
registerAgentApiRoute("integrationAppUpdate", ...agentApiRequestValidators("integrationAppUpdate"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const body = req.body as AgentApiRequestBodyByRoute["integrationAppUpdate"];
    const clientKey = optionalIntegrationString(body.clientKey);
    if (!clientKey) {
      refuse(res, 400, APP_CLIENT_KEY_REQUIRED_REFUSAL);
      return;
    }
    const updatedFields = ["name", "description", "whenToUse", "category", "homepageUrl", "returnUrl", "agentManifestUrl", "setupUrl", "setupDescription", "scopes"]
      .filter((field) => body[field as keyof typeof body] !== undefined);
    if (body.newClientKey !== undefined) updatedFields.push("clientKey");
    if (updatedFields.length === 0) {
      refuse(res, 400, APP_UPDATE_NO_FIELDS_REFUSAL);
      return;
    }
    if (body.returnUrl !== undefined && !body.returnUrl.trim()) {
      refuse(res, 400, APP_RETURN_URL_EMPTY_REFUSAL);
      return;
    }
    const unsafeDemoUrlOverride = body.unsafeDemoUrlOverride === true;
    const updated = await oauthService.updateOAuthClientForAgent({
      serverId,
      clientKey,
      actorAgentId: agentId,
      name: body.name,
      description: body.description,
      whenToUse: body.whenToUse,
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
      setupUrl: body.setupUrl === undefined ? undefined : actionCardsService.validateIntegrationUrl(body.setupUrl, "setupUrl", unsafeDemoUrlOverride),
      setupDescription: body.setupDescription,
      newClientKey: body.newClientKey,
      allowedScopes: body.scopes === undefined
        ? undefined
        : (() => {
          const scopes = normalizeIntegrationAppPrepareScopes(body.scopes);
          return scopes.length > 0 ? scopes : null;
        })(),
    });
    if (updated.status === "not_found") {
      refuse(res, 404, APP_NOT_FOUND_REFUSAL);
      return;
    }
    if (updated.status === "owner_required") {
      refuse(res, 403, appManageAuthorityRefusal("update it"));
      return;
    }
    if (updated.status === "invalid_return_url") {
      refuse(res, 400, APP_RETURN_URL_EMPTY_REFUSAL);
      return;
    }
    // Same live-follow rule as the human PATCH route: an agent-edited app
    // still owns its bots' cards, so every bound bot gets agent:updated on
    // its own server (never the editing agent's server alone).
    if (body.name !== undefined || body.description !== undefined) {
      await broadcastManagedBotProfileUpdatesForClient(req, updated.value.id);
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
    // Before the message checks below: a refusal's sentence can name an id that contains "scope".
    if (err instanceof RefusalError) {
      refuse(res, err.status, err.refusal);
      return;
    }
    if (err instanceof Error) {
      if (err.message.includes("category")) {
        refuse(res, 400, serviceMessageRefusal("INVALID_CATEGORY", err.message, APP_CATEGORY_INVALID_REFUSAL.error));
        return;
      }
      if (
        err.message.includes("required") ||
        err.message.includes("agentManifestUrl") || err.message.includes("setup") ||
        err.message.includes("scope") ||
        err.message.includes("whenToUse")
      ) {
        refuse(res, 400, appMetadataInvalidRefusal(err.message));
        return;
      }
    }
    if (err instanceof actionCardsService.ActionCardError) {
      res.status(err.status).json({ error: err.message, errorCode: err.code });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to update integration app",
      logPrefix: "internal.agent-api.integrations-app-update error:",
      err,
    });
  }
});
/** The manage actions a targetServerSlug applies to; every other action refuses it. */
const SHARE_LINK_TARGET_ACTIONS: ReadonlySet<AgentApiRequestBodyByRoute["integrationAppManage"]["action"]> = new Set([
  "share_link_create",
  "share_link_revoke",
]);
registerAgentApiRoute("integrationAppManage", ...agentApiRequestValidators("integrationAppManage"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const body = req.body as AgentApiRequestBodyByRoute["integrationAppManage"];
    // Share links install on one target Server, named by slug; whether the
    // slug names a Server is never answered (#proj-apps:769a57d4). The slug
    // means something only to share_link_create (required) and
    // share_link_revoke (which link to revoke); any other action refuses it
    // rather than ignoring it, before anything is looked up.
    if (body.targetServerSlug !== undefined && !SHARE_LINK_TARGET_ACTIONS.has(body.action)) {
      refuse(res, 400, shareLinkTargetNotApplicableRefusal(body.action));
      return;
    }
    const targetServerSlug = body.targetServerSlug
      ? oauthService.normalizeShareLinkTargetServerSlug(body.targetServerSlug)
      : null;
    if (body.targetServerSlug && !targetServerSlug) {
      refuse(res, 400, SHARE_LINK_TARGET_INVALID_REFUSAL);
      return;
    }
    const resolved = await oauthService.resolveOAuthClientForAgentMutation({
      serverId,
      clientKey: body.clientKey,
      actorAgentId: agentId,
    });
    if (resolved.status === "not_found") {
      refuse(res, 404, APP_NOT_FOUND_REFUSAL);
      return;
    }
    if (resolved.status === "owner_required") {
      refuse(res, 403, appManageAuthorityRefusal("manage it"));
      return;
    }
    const client = resolved.value.client;
    let publishStatus: string | null | undefined;
    let logoUrl: string | null | undefined;
    let shareUrl: string | null | undefined;
    const shareLinkJson = (record: oauthService.OAuthClientShareLinkRecord) => ({
      ...record,
      expiresAt: record.expiresAt?.toISOString() ?? null,
      revokedAt: record.revokedAt?.toISOString() ?? null,
      consumedAt: record.consumedAt?.toISOString() ?? null,
      lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
    let link: ReturnType<typeof shareLinkJson> | null | undefined;
    let links: Array<ReturnType<typeof shareLinkJson>> | undefined;
    if (body.action === "share_link_get") {
      const current = await oauthService.listOAuthClientShareLinks({
        serverId,
        clientId: client.id,
        actorAgentId: agentId,
      });
      links = (current ?? []).map(shareLinkJson);
      link = links[0] ?? null;
    } else if (body.action === "share_link_create") {
      if (!targetServerSlug) {
        refuse(res, 400, SHARE_LINK_TARGET_REQUIRED_REFUSAL);
        return;
      }
      const created = await oauthService.createOAuthClientShareLink({
        serverId,
        clientId: client.id,
        targetServerSlug,
        createdByAgentId: agentId,
        expiresInDays: body.expiresInDays,
      });
      if (!created) {
        refuse(res, 409, SHARE_LINK_UNAVAILABLE_REFUSAL);
        return;
      }
      link = shareLinkJson(created.link);
      shareUrl = buildIntegrationInviteUrl(getAppUrl(), created.token);
    } else if (body.action === "share_link_revoke") {
      const revoked = await oauthService.revokeOAuthClientShareLinks({
        serverId,
        clientId: client.id,
        targetServerSlug: targetServerSlug ?? undefined,
        revokedByAgentId: agentId,
      });
      if (!revoked || revoked.length === 0) {
        refuse(res, 404, SHARE_LINK_NOT_FOUND_REFUSAL);
        return;
      }
      links = revoked.map(shareLinkJson);
      link = links[0];
    } else if (body.action === "request_publish") {
      const updated = await oauthService.requestOAuthClientPublish({
        serverId,
        clientId: client.id,
        requestedByAgentId: agentId,
      });
      if (!updated) {
        refuse(res, 409, PUBLISH_REQUEST_UNAVAILABLE_REFUSAL);
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
        refuse(res, 409, APP_NOT_PUBLISHED_REFUSAL);
        return;
      }
      publishStatus = updated.publishStatus;
    } else if (body.action === "clear_logo") {
      // Clearing the logo clears every bound bot's avatar (all servers): one
      // transaction, then the bots re-read after commit, as for the upload below.
      const written = await getDb().transaction(async (tx) => {
        const logo = await oauthService.clearOAuthClientLogo({
          serverId,
          clientId: client.id,
          actorAgentId: agentId,
        }, { executor: tx });
        if (!logo) return null;
        const bots = await agentService.syncAppBotAvatarsToLogo(tx, { clientId: logo.client.id, logoUrl: null });
        return { ...logo, bots };
      });
      if (!written) {
        refuse(res, 404, APP_NOT_FOUND_REFUSAL);
        return;
      }
      // Committed: only now is the removed logo object unreferenced.
      oauthService.deleteStaleIntegrationLogo(written.staleLogoStorageKey);
      for (const bot of written.bots) broadcastAgentUpdated(req, bot.serverId, bot.agentId);
      logoUrl = written.client.logoUrl;
    } else {
      // The App's bots fall back to the generated avatar in the same
      // transaction, before the delete (the installation cascade unlinks them),
      // and re-read after commit; its logo object is deleted after commit.
      const written = await getDb().transaction(async (tx) => {
        const locked = await oauthService.lockDeletableOAuthClient(tx, {
          serverId,
          clientId: client.id,
          deletedByAgentId: agentId,
        });
        if (!locked) return null;
        const bots = await agentService.syncAppBotAvatarsToLogo(tx, { clientId: locked.id, logoUrl: null });
        const deleted = await oauthService.deleteLockedOAuthClient(tx, locked, { serverId, deletedByAgentId: agentId });
        return { ...deleted, bots };
      });
      if (!written) {
        refuse(res, 409, APP_PUBLISHED_NOT_DELETABLE_REFUSAL);
        return;
      }
      oauthService.deleteStaleIntegrationLogo(written.staleLogoStorageKey);
      for (const bot of written.bots) broadcastAgentUpdated(req, bot.serverId, bot.agentId);
      await announceRemovedAppBots(req, written.removedBots);
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
      links,
    });
    recordRaftCliActivity(req, agentId, {
      command: `integration.app.${body.action.replaceAll("_", "-")}`,
      summary: `Managed integration app ${client.clientId}: ${body.action}`,
      correlationId: client.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message === APP_REVIEW_DESCRIPTION_MESSAGE) {
      refuse(res, 400, APP_REVIEW_DESCRIPTION_REQUIRED_REFUSAL);
      return;
    }
    if (message.includes("description")) {
      refuse(res, 400, serviceMessageRefusal("app_description_invalid", message, "The app's description isn't valid: check it, then try again."));
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to manage integration app",
      logPrefix: "internal.agent-api.integrations-app-manage error:",
      err,
    });
  }
});
registerAgentApiRoute("integrationAppLogoUpdate", async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const uploaded = await runSingleAvatarUpload(integrationLogoUpload, req);
    const clientKey = optionalIntegrationString(req.body?.clientKey);
    if (!clientKey) {
      refuse(res, 400, APP_CLIENT_KEY_REQUIRED_REFUSAL);
      return;
    }
    if (!uploaded) {
      refuse(res, 400, LOGO_FILE_REQUIRED_REFUSAL);
      return;
    }
    const resolved = await oauthService.resolveOAuthClientForAgentMutation({
      serverId,
      clientKey,
      actorAgentId: agentId,
    });
    if (resolved.status === "not_found") {
      refuse(res, 404, APP_NOT_FOUND_REFUSAL);
      return;
    }
    if (resolved.status === "owner_required") {
      refuse(res, 403, appManageAuthorityRefusal("update its logo"));
      return;
    }
    // The logo IS every bound bot's avatar (all servers): one transaction, so
    // the logo and the bots never disagree; the bots re-read after commit.
    const written = await getDb().transaction(async (tx) => {
      const logo = await oauthService.updateOAuthClientLogo({
        serverId,
        clientId: resolved.value.client.id,
        fileBuffer: uploaded.buffer,
        actorAgentId: agentId,
      }, { executor: tx });
      if (!logo) return null;
      const bots = await agentService.syncAppBotAvatarsToLogo(tx, { clientId: logo.client.id, logoUrl: logo.client.logoUrl });
      return { ...logo, bots };
    });
    if (!written) {
      refuse(res, 404, APP_NOT_FOUND_REFUSAL);
      return;
    }
    // Committed: only now is the replaced logo object unreferenced.
    oauthService.deleteStaleIntegrationLogo(written.staleLogoStorageKey);
    for (const bot of written.bots) broadcastAgentUpdated(req, bot.serverId, bot.agentId);
    const updated = written.client;
    if (!updated.logoUrl) {
      refuse(res, 404, APP_NOT_FOUND_REFUSAL);
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
      refuse(res, 400, APP_LOGO_TOO_LARGE_REFUSAL);
      return;
    }
    if (err instanceof Error && err.message.includes(PROFILE_AVATAR_BAD_FORMAT_MESSAGE)) {
      refuse(res, 400, APP_LOGO_BAD_FORMAT_REFUSAL);
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to update integration app logo",
      logPrefix: "internal.agent-api.integrations-app-logo-update error:",
      err,
    });
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
    sendJsonServerError(req, res, {
      error: "Failed to list integration apps",
      logPrefix: "internal.agent-api.integrations-app-list error:",
      err,
    });
  }
});
registerAgentApiRoute("integrationAppStatus", ...agentApiRequestValidators("integrationAppStatus"), async (req, res) => {
  try {
    const query = req.query as AgentApiRequestQueryByRoute["integrationAppStatus"];
    const card = query.card?.trim();
    const clientKey = query.client?.trim();
    if (Boolean(card) === Boolean(clientKey)) {
      refuse(res, 400, APP_STATUS_LOOKUP_INVALID_REFUSAL);
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
      refuse(res, 404, card ? APP_NOT_FOUND_BY_CARD_REFUSAL : APP_NOT_FOUND_REFUSAL);
      return;
    }
    sendAgentApiResponse("integrationAppStatus", res, { app });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to load integration app status",
      logPrefix: "internal.agent-api.integrations-app-status error:",
      err,
    });
  }
});
registerAgentApiRoute("taskList", async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      refuse(res, 401, AGENT_CREDENTIAL_REQUIRED_REFUSAL);
      return;
    }

    const query = validateAgentApiQuery("taskList", req, res);
    if (!query) return;
    const { channel, mine, status } = query;

    let statusFilter: TaskStatus | undefined;
    if (status !== undefined && status !== "all") {
      if (typeof status !== "string" || !isTaskStatus(status)) {
        refuse(res, 400, {
          code: "invalid_status",
          error: "That isn't a task status: filter by backlog, todo, in_progress, in_review, done, closed or all.",
        });
        return;
      }
      statusFilter = status;
    }

    if (mine === "true") {
      const taskSurfaces = await resolveAgentTaskSurfaces(serverId, agentId);
      const assigned = await taskService.listTasksAssignedToAgent(
        [...taskSurfaces.keys()],
        agentId,
        status ?? undefined,
      );
      const pendingConversations = await isTaskV2ConversationsEnabled(serverId);
      const visibleTasks = markPendingTaskConversations(assigned, pendingConversations).flatMap((task) => {
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

    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel!, res);
    if (!ctx) {
      refuseTaskChannelNotFound(res);
      return;
    }

    const tasks = await taskService.listTasks(ctx.storageChannelId, statusFilter);
    // Task v2 gate: this request's (local) server, never the joint storage server.
    const pendingConversations = await readTaskV2ConversationsEnabled(ctx.localChannel.serverId);
    sendAgentApiResponse("taskList", res, {
      tasks: taskService.projectTasksToChannel(markPendingTaskConversations(tasks, pendingConversations), ctx.localChannel),
      scope: "channel",
      pagination: { mode: "complete", truncated: false },
    });
  } catch (err) {
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to list tasks",
      logPrefix: "internal.agent-api.task-list error:",
      err,
    });
  }
});

/**
 * Task v2 (flag-on server): mark tasks created before task v2 whose own
 * conversation does not exist yet (`conversationPending`; it is created on the
 * first write), so the CLI does not point at the old host message's thread.
 * Flag off: unchanged (pre-v2 output).
 */
function markPendingTaskConversations<T extends { taskNumber: number; messageId: string | null; hostMessageId: string | null; conversationAnchored: boolean; isLegacy: boolean }>(
  tasks: T[],
  enabled: boolean,
): Array<T & { conversationPending?: true }> {
  return tasks.map((task) => {
    const pending = enabled && !task.isLegacy && task.hostMessageId && !task.conversationAnchored;
    if (!pending && !task.conversationAnchored) return task;
    // A task addressed by its ref: `messageId` carries the ref's tail (`#7`)
    // so a CLI from before task v2 — which prints `msg=<messageId[0..8]>` and
    // follows up at `<board>:<messageId[0..8]>` — names `#board:#7`, the task
    // conversation. The real host message stays in `hostMessageId`.
    return {
      ...task,
      messageId: formatAgentTaskRefTail(task.taskNumber),
      ...(pending && { conversationPending: true as const }),
    };
  });
}

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
    channelService.resolveAgentByName(serverId, handle, {}),
  ]);

  if (humanId && targetAgentId) {
    refuse(res, 409, {
      code: "assignee_ambiguous",
      error: sentenceQuoting([String(handle)], `@${handle} names both a person and an agent on this server, so it can't pick the assignee: create the task unassigned, then assign it to the one you mean.`, "That name belongs to both a person and an agent on this server, so it can't pick the assignee: create the task unassigned, then assign it to the one you mean."),
    });
    return null;
  }

  const assignee: taskService.TaskCreationAssignee | null = targetAgentId
    ? { type: "agent", id: targetAgentId }
    : humanId
      ? { type: "user", id: humanId }
      : null;
  if (!assignee) {
    refuse(res, 404, {
      code: "assignee_not_found",
      error: sentenceQuoting([String(handle)], `No person or agent on this server is called @${handle}: check the assignee's name, or look it up in the server's directory.`, "No person or agent on this server has that name: check the assignee's name, or look it up in the server's directory."),
      next: RAFT_HINTS.serverInfo({ query: handle }),
    });
    return null;
  }

  const canClaim = assignee.type === "agent"
    ? await channelService.canAgentPostToChannel(channelId, assignee.id)
    : await channelService.canUserPostToChannel(channelId, assignee.id);
  if (!canClaim) {
    refuse(res, 403, {
      code: "assignee_cannot_claim",
      error: sentenceQuoting([String(handle)], `@${handle} can't take tasks in this channel because they can't post in it: add them to the channel first, or pick an assignee who is a member.`, "That assignee can't take tasks in this channel because they can't post in it: add them to the channel first, or pick an assignee who is a member."),
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
    refuse(res, 404, {
      code: "assignee_not_assignable",
      error: sentenceQuoting([String(handle)], `@${handle} isn't exactly one member of this shared channel, so tasks can't be assigned to that name here: pick one of the channel's members.`, "That name isn't exactly one member of this shared channel, so tasks can't be assigned to it here: pick one of the channel's members."),
    });
    return null;
  }
  return {
    ...assignee,
    name: handle,
  };
}

/**
 * The taskCreate response body. One builder for the live response and the
 * idempotency ledger, so a keyed replay returns exactly the first response.
 */
function buildTaskCreateResponse(
  created: Awaited<ReturnType<typeof taskService.createTasks>>["tasks"],
  assignmentReceipt?: taskService.TaskAssignmentReceipt | null,
  /** Per created task (same order): the thread reply given as its source, resolved to the thread's root. */
  sourceThreadReplyIds: readonly (string | null)[] = [],
): AgentApiResponseByRoute["taskCreate"] {
  return {
    tasks: created.map((task, index) => ({
      taskNumber: task.taskNumber,
      // Task v2: the ref's tail (`#7`), so a CLI from before task v2 follows
      // up at `#board:#7` (see markPendingTaskConversations).
      messageId: task.conversationAnchored ? formatAgentTaskRefTail(task.taskNumber) : task.messageId,
      title: task.title,
      status: task.status,
      claimedByType: task.claimedByType,
      claimedById: task.claimedById,
      claimedByName: task.claimedByName,
      claimedAt: task.claimedAt,
      requiresResourceReceipt: task.requiresResourceReceipt,
      // Task v2 only (own conversation): pre-v2 responses keep their shape.
      ...(task.conversationAnchored && {
        conversationAnchored: true,
        sourceMessageId: task.sourceMessageId,
        ...(sourceThreadReplyIds[index] && { sourceThreadReplyId: sourceThreadReplyIds[index] }),
      }),
    })),
    ...(assignmentReceipt && {
      assignmentReceipt: {
        messageId: assignmentReceipt.message.id,
        content: assignmentReceipt.content,
        assignee: assignmentReceipt.assignee,
        state: assignmentReceipt.state,
      },
    }),
  };
}

registerAgentApiRoute("taskCreate", ...agentApiRequestValidators("taskCreate"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      refuse(res, 401, AGENT_CREDENTIAL_REQUIRED_REFUSAL);
      return;
    }

    // An `alongside` field from older CLIs passes through unread: nothing
    // refuses a message that already has tasks (#wg-task-v2:458f336e).
    const { channel, tasks: items, assignee: assigneeRef, idempotencyKey, status: requestedStatus } = req.body as AgentApiRequestBodyByRoute["taskCreate"];
    if (items.length > 50) {
      refuse(res, 400, TOO_MANY_TASKS_REFUSAL);
      return;
    }
    // The status every task starts in: backlog, todo or in_progress; omitted keeps
    // the old default (self-assign starts work, anything else is todo).
    const statusRefusal = checkTaskCreateStatus(requestedStatus);
    if (statusRefusal) {
      refuse(res, 400, { code: statusRefusal.code, error: statusRefusal.message });
      return;
    }
    const initialStatus = isTaskCreateStatus(requestedStatus) ? requestedStatus : undefined;
    const idempotency = agentApiIdempotencyScope(agentId, "taskCreate", idempotencyKey, {
      channel,
      tasks: items.map((item) => ({
        title: item.title.trim(),
        createsResource: item.creates_resource === true,
        // Additive fields join the fingerprint only when present, so keyed
        // replays recorded before they existed keep matching.
        ...(item.description !== undefined && { description: item.description.trim() }),
        ...(item.source_message_id !== undefined && { sourceMessageId: item.source_message_id }),
      })),
      assignee: assigneeRef ?? null,
      ...(initialStatus !== undefined && { status: initialStatus }),
    });
    if (idempotency && await replayAgentApiIdempotentWrite(idempotency, res)) return;

    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel, res);
    if (!ctx) {
      refuseTaskChannelNotFound(res);
      return;
    }
    if (!await assertAgentApiTaskWritableChannel(ctx, agentId, res, { threadRefusal: TASK_CREATE_IN_THREAD_REFUSAL })) {
      return;
    }
    const assignee = assigneeRef
      ? ctx.surface.isJoint
        ? await resolveJointTaskCreateAssignee(ctx.channelId, assigneeRef, res)
        : await resolveTaskCreateAssignee(serverId, ctx.channelId, assigneeRef, res)
      : undefined;
    if (assigneeRef && !assignee) return;

    // Task v2: `source_message_id` needs task v2 conversations on the task
    // channel's server (createTasks re-checks it under the channel lock).
    const taskV2 = await isTaskV2ConversationsEnabled(ctx.localChannel.serverId);
    if (items.some((item) => item.source_message_id !== undefined) && !taskV2) {
      refuse(res, 403, {
        code: "task_v2_not_enabled",
        error: "Linking a task to a source message is not available on this server, because task v2 conversations are not enabled here: create the task without a source message.",
      });
      return;
    }
    // Task v2: a task always has a source, the message that asked for it
    // (#wg-task-v2:#23). Flag off keeps the pre-v2 host message.
    if (taskV2 && items.some((item) => item.source_message_id === undefined)) {
      refuse(res, 400, taskSourceRequiredRefusal(channel));
      return;
    }

    // Task v2: `backlog` needs task v2 conversations too (createTasks re-checks
    // it under the channel lock). Here so a create it would refuse is not held
    // for freshness first.
    if (initialStatus === "backlog") {
      const refusal = checkTaskCreateStatus(initialStatus, { taskV2: await isTaskV2ConversationsEnabled(ctx.localChannel.serverId) });
      if (refusal) {
        refuse(res, 400, { code: refusal.code, error: refusal.message });
        return;
      }
    }

    // Task v2: resolve each item's source message (full or short id) in the
    // target channel; createTasks re-validates it under the channel lock.
    // A reply in one of the channel's threads resolves to the thread's root.
    const createItems: taskService.TaskCreateItem[] = [];
    const sourceThreadReplyIds: (string | null)[] = [];
    for (const item of items) {
      let sourceMessageId: string | null = null;
      let sourceThreadReplyId: string | null = null;
      if (item.source_message_id !== undefined) {
        const resolved = await taskService.resolveTaskSourceMessage(ctx.storageChannelId, item.source_message_id);
        if (!resolved) {
          refuse(res, 400, {
            code: "invalid_source_message",
            error: sentenceQuoting([String(item.source_message_id)], `There is no message ${item.source_message_id} in this channel or its threads to make a task from: ${INVALID_TASK_SOURCE_STEP}`, `There is no such message in this channel or its threads to make a task from: ${INVALID_TASK_SOURCE_STEP}`),
          });
          return;
        }
        sourceMessageId = resolved.id;
        sourceThreadReplyId = resolved.threadReplyId;
      }
      sourceThreadReplyIds.push(sourceThreadReplyId);
      const description = item.description?.trim();
      createItems.push({
        title: item.title.trim(),
        ...(description ? { description } : {}),
        createsResource: item.creates_resource === true,
        sourceMessageId,
      });
    }

    const sourceMessageIds = [...new Set(createItems.flatMap((item) => item.sourceMessageId ? [item.sourceMessageId] : []))];
    const gate = await gateTaskWriteFreshness(req, {
      action: "task_create",
      agentId,
      serverId,
      ctx,
      body: req.body,
      landing: async () => sourceMessageIds.length === 1 ? sourceThreadLanding(ctx, channel, sourceMessageIds[0]!) : null,
    });
    if (gate.held) {
      sendAgentApiResponse("taskCreate", res, gate.held);
      return;
    }

    let created: Awaited<ReturnType<typeof taskService.createTasks>>["tasks"];
    let hostMessages: Awaited<ReturnType<typeof taskService.createTasks>>["hostMessages"];
    let hostMessagesVisible: boolean;
    let persistedAssignmentReceipt: taskService.TaskAssignmentReceipt | null = null;
    try {
      if (assignee) {
        const result = await taskService.createTasksWithAssignmentReceipt(
          ctx.storageChannelId,
          "agent",
          agentId,
          createItems,
          assignee,
          { assigneeName: assignee.name },
          {
            // Joint: the initiating local channel also gates task v2 (its server).
            ...(ctx.surface.isJoint ? { initiatingLocalChannelId: ctx.channelId } : {}),
            ...(initialStatus !== undefined && { initialStatus }),
            ...(idempotency && {
              beforeCommit: (executor, result) => idempotentAgentApiService.recordAgentApiIdempotentResponse(executor, idempotency, {
                status: 200,
                body: buildTaskCreateResponse(result.tasks, result.assignmentReceipt, sourceThreadReplyIds),
              }),
            }),
          },
        );
        created = result.tasks;
        hostMessages = result.hostMessages;
        hostMessagesVisible = result.hostMessagesVisible;
        persistedAssignmentReceipt = result.assignmentReceipt;
      } else {
        const result = await taskService.createTasks(
          ctx.storageChannelId,
          "agent",
          agentId,
          createItems,
          {
            initiatingServerId: ctx.localChannel.serverId,
            ...(initialStatus !== undefined && { initialStatus }),
            ...(idempotency && {
              beforeCommit: (executor, result) => idempotentAgentApiService.recordAgentApiIdempotentResponse(executor, idempotency, {
                status: 200,
                body: buildTaskCreateResponse(result.tasks, null, sourceThreadReplyIds),
              }),
            }),
          },
        );
        created = result.tasks;
        hostMessages = result.hostMessages;
        hostMessagesVisible = result.hostMessagesVisible;
      }
    } catch (err) {
      if (idempotency && err instanceof idempotentAgentApiService.AgentApiIdempotencyRaceLostError) {
        // A concurrent request with this key committed first; this request's
        // creation rolled back. Answer with the committed first response.
        if (await replayAgentApiIdempotentWrite(idempotency, res)) return;
        throw err;
      }
      if (err instanceof taskService.TaskCreationAssigneeEligibilityError) {
        refuse(res, 403, {
          code: err.code,
          error: "The assignee can no longer take tasks in this channel (they may have left it): pick another assignee, or create the task unassigned.",
        });
        return;
      }
      throw err;
    }

    const io: SocketServer = req.app.get("io");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const creatorName = created[0]?.createdByName || "Unknown";
    const fanoutCreatedTasks = async () => {
      // Task v2 (flag on): creating a task writes no message (the task has
      // its own conversation), so nothing goes out as message:new or to agents. Flag off (pre-v2, v1.4): the
      // host message broadcasts on the ordinary message/agent-delivery path.
      // The task fact broadcasts separately on the task board.
      const targets = await getTaskRealtimeSurfaceTargets(ctx.surface);
      for (const target of targets) {
        const projectedTasks = taskService.projectTasksToChannel(created, target.localChannel);
        const visibleHostMessages = hostMessagesVisible ? hostMessages : [];
        for (const message of visibleHostMessages) {
          // message-realtime-producer: task-route.new.agent-api
          emitTaskMessageNew(io, target, { ...message, channelId: target.channelId }, creatorName);
        }
        emitTaskCreated(io, target, {
          channelId: target.channelId,
          tasks: projectedTasks,
        });
        if (visibleHostMessages.length > 0) {
          const projectedMessages = visibleHostMessages.map((message) => ({ ...message, channelId: target.channelId }));
          await messageService.deliverMessagesToAgents(
            agentOrchestrator,
            projectedMessages,
            creatorName,
          );
        }
      }
    };

    const taskList = created
      .map((task) => `task #${task.taskNumber} "${messageService.summarizeForSystemMessage(task.title)}"`)
      .join(", ");
    if (assignee && persistedAssignmentReceipt) {
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
              causalActor: { type: "agent", id: agentId },
            },
            personalAttentionTargets: [{ type: assignee.type, id: assignee.id, name: assignee.name }],
            persistedMessage: persistedAssignmentReceipt.message,
          },
        );
      } catch (err) {
        // Durable state already committed. A transient fanout failure must not
        // turn success into retry-inviting HTTP 500 and duplicate the tasks.
        console.error("internal.agent-api.task-create post-commit fanout failed:", serializeErrorForLog(err));
      }
    } else if (!hostMessagesVisible) {
      // Task v2 (flag on): creating a task posts nothing in the channel — no
      // created summary, no channel assignment receipt. An assignment is
      // announced in each task's own conversation instead, mentioning the
      // assignee once exactly like a later assign.
      try {
        await fanoutCreatedTasks();
        if (assignee) {
          await announceTaskCreationAssignment(io, agentOrchestrator, {
            tasks: created.map((task) => ({ id: task.id, taskNumber: task.taskNumber, title: task.title })),
            localChannel: ctx.localChannel,
            actor: { type: "agent", id: agentId },
            assignee: { type: assignee.type, id: assignee.id },
          });
        }
        await announceTasksCreatedFromSourceMessages(io, agentOrchestrator, {
          tasks: created,
          localChannel: ctx.localChannel,
          actor: { type: "agent", id: agentId },
        });
      } catch (err) {
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
          causalActor: { type: "agent", id: agentId },
        },
        // The agent that created the tasks should not see its own action as unread.
      }).catch(() => {});
    }

    sendAgentApiResponse("taskCreate", res, buildTaskCreateResponse(created, persistedAssignmentReceipt, sourceThreadReplyIds));
    void recordAgentRaftAction(req, agentId, {
      title: `Created ${created.length} task${created.length === 1 ? "" : "s"}`,
      text: `target: ${channel}`,
    });
  } catch (err) {
    if (respondToAgentApiIdempotencyConflict(err, res)) return;
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to create tasks",
      logPrefix: "internal.agent-api.task-create error:",
      err,
    });
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
      refuse(res, 401, AGENT_CREDENTIAL_REQUIRED_REFUSAL);
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
      refuse(res, 400, { code: "task_numbers_required", error: "A claim needs the tasks to claim: give their task numbers or message ids." });
      return;
    }

    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel, res);
    if (!ctx) {
      traceTaskClaimFinished({
        outcome: "rejected",
        reason: "target_not_found",
        claim_mode: claimMode,
        input_count: inputCount,
      });
      refuseTaskChannelNotFound(res);
      return;
    }
    if (!await assertAgentApiTaskWritableChannel(ctx, agentId, res, { threadRefusal: TASK_CLAIM_IN_THREAD_REFUSAL })) {
      traceTaskClaimFinished({
        outcome: "rejected",
        reason: ctx.channelType === "thread" ? "thread_target" : "target_not_writable",
        claim_mode: claimMode,
        input_count: inputCount,
      });
      return;
    }

    // Task v2 server: claim by message id does not execute (nothing in the
    // call is claimed); answer with the --number / create commands (spec §5).
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
        traceTaskClaimFinished({
          outcome: "rejected",
          reason: "task_v2_use_create",
          claim_mode: claimMode,
          input_count: inputCount,
        });
        res.status(useCreate.status).json(useCreate.body);
        return;
      }
    }

    const io: SocketServer = req.app.get("io");
    const results: {
      taskNumber?: number;
      messageId?: string;
      /** Task v2: the task's conversation parent when it differs from `messageId`. */
      conversationMessageId?: string;
      success: boolean;
      reason?: string;
      conflict?: AgentApiTaskClaimConflict;
    }[] = [];
    let successfulClaimCount = 0;

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
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const announceClaim = async (
      claimedRow: { id: string; taskNumber: number; title: string; status: string },
      before: { status: string; claimedByType: string | null; claimedById: string | null } | undefined,
    ) => {
      if (!agentOrchestrator) return;
      await announceTaskClaim(io, agentOrchestrator, {
        taskId: claimedRow.id,
        taskNumber: claimedRow.taskNumber,
        title: claimedRow.title,
        localChannel: ctx.localChannel,
        actor: { type: "agent", id: agentId },
        // Unknown (raced into existence): read as an untaken Todo task.
        before: before ?? { status: "todo", claimedByType: null, claimedById: null },
        afterStatus: claimedRow.status,
        // Before task v2 an agent claim posted nothing.
        legacyContent: null,
      });
    };

    const gate = await gateTaskWriteFreshness(req, {
      action: "task_claim",
      agentId,
      serverId,
      ctx,
      body: req.body,
      landing: async () => {
        const taskNumber = agentWriteTaskNumber(req.body);
        const task = taskNumber === undefined ? null : await taskService.getTaskByNumber(ctx.storageChannelId, taskNumber);
        return task ? taskConversationLanding(ctx, channel, task) : null;
      },
    });
    if (gate.held) {
      traceTaskClaimFinished({
        outcome: "held",
        reason: "freshness",
        claim_mode: claimMode,
        input_count: inputCount,
      });
      sendAgentApiResponse("taskClaim", res, gate.held);
      return;
    }

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
      const batchResults = await taskService.batchClaimTasks(ctx.storageChannelId, task_numbers, "agent", agentId, ctx.localChannel);
      for (const result of batchResults) {
        let claimedMessageId: string | undefined;
        if (result.success && result.task) {
          // Task v2: a pre-v2 task gets its own conversation now, so the
          // printed follow-up target is that conversation (flag off: no-op).
          const claimed = await withTaskConversationEnsured(result.task, { initiatingServerId: ctx.localChannel.serverId });
          const facts = await emitTaskMutationToSurfaces(io, ctx.surface, claimed);
          claimedMessageId = facts.messageId ?? undefined;
          successfulClaimCount += 1;
          // Task v2: the claimer follows the task conversation (`assigned`;
          // an explicit unfollow is reactivated) and the conversation gets
          // the claim's lines. Flag off / none: no-op.
          await announceClaim(claimed.row, claimTargetsBefore.get(result.taskNumber));
        }
        results.push({
          taskNumber: result.taskNumber,
          messageId: claimedMessageId,
          ...(result.success && result.task ? { title: result.task.row.title } : {}),
          success: result.success,
          reason: result.reason,
          conflict: result.conflict,
        });
      }
    }

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
        const rejection = await taskService.getClaimRejectionForOwner(existingOwner, "agent", agentId);
        if (rejection) {
          results.push({
            messageId: msgId,
            success: false,
            reason: rejection.reason,
            conflict: rejection.conflict ?? undefined,
            taskNumber: existingNumber,
          });
          return "done";
        }
        const claimed = await taskService.claimTaskDetailed(existingOwner.row.id, "agent", agentId);
        if (typeof claimed.result !== "string") {
          const facts = await emitTaskMutationToSurfaces(io, ctx.surface, claimed.result);
          successfulClaimCount += 1;
          // A task that already has its conversation: the claimer follows it
          // and the conversation gets the claim's lines.
          await announceClaim(claimed.result.row, existingOwner.row);
          // Task v2: a pre-v2 task found through its source message talks in
          // its host message's thread, not in the source's thread.
          const conversationMessageId = existingOwner.row.messageId && existingOwner.row.messageId !== msgId
            ? existingOwner.row.messageId
            : null;
          results.push({
            messageId: msgId,
            success: true,
            taskNumber: facts.taskNumber,
            ...(conversationMessageId && { conversationMessageId }),
          });
          return "done";
        }
        results.push({
          messageId: msgId,
          success: false,
          reason: claimed.result,
          conflict: claimed.conflict,
          taskNumber: existingNumber,
        });
        return "done";
      };
      // A message behind the plan's history window can't become a task (its
      // text would be the title); a task it already names can still be claimed.
      const claimHistoryWindow = await getServerHistoryWindowForRead(ctx.agent.serverId);
      for (const rawMsgId of message_ids) {
        const resolved = await taskService.resolveMessageInChannel(ctx.storageChannelId, rawMsgId);
        if (!resolved) {
          results.push({ messageId: rawMsgId, success: false, reason: "message not found" });
          continue;
        }

        const msgId = resolved.id;
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
        const converted = await taskService.convertMessageToTask(msgId, "agent", agentId, ctx.storageChannelId);
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
    // Task v2: each task talking in its own conversation is named by its ref
    // (per-task mode: every task where the initiating server has the flag on,
    // a v2 task whatever the flag).
    const claimV2 = await isTaskV2ConversationsEnabled(ctx.localChannel.serverId);
    const v2TaskNumbers = claimV2 ? null : await taskService.listV2TaskNumbers(
      ctx.storageChannelId,
      results.flatMap((result) => (result.taskNumber ? [result.taskNumber] : [])),
    );
    sendAgentApiResponse("taskClaim", res, {
      results: results.map((result) => {
        if (!result.taskNumber || (v2TaskNumbers && !v2TaskNumbers.has(result.taskNumber))) return result;
        const taskRef = formatAgentTaskRef(channel, result.taskNumber);
        // `messageId` carries the ref's tail for clients from before task v2
        // (they follow up at `#board:<messageId[0..8]>` = the task ref).
        return taskRef
          ? { ...result, taskRef, ...(result.success && { messageId: formatAgentTaskRefTail(result.taskNumber) }) }
          : result;
      }),
    });
    if (successfulClaimCount > 0) {
      void recordAgentRaftAction(req, agentId, {
        title: `Claimed ${successfulClaimCount} task${successfulClaimCount === 1 ? "" : "s"}`,
        text: `target: ${channel}`,
      });
    }
  } catch (err) {
    if (respondToTaskWriteError(err, res)) return;
    traceTaskClaimFinished({
      outcome: "internal_error",
      reason: "unexpected_throw",
      error_class: errorClassOf(err),
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
      refuse(res, 401, AGENT_CREDENTIAL_REQUIRED_REFUSAL);
      return;
    }

    const { channel, task_number } = req.body as AgentApiRequestBodyByRoute["taskUnclaim"];
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel, res);
    if (!ctx) {
      refuseTaskChannelNotFound(res);
      return;
    }
    if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }

    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      refuseTaskNotFound(res, channel, task_number);
      return;
    }
    if (rejectHistoricalJointTaskWriteIfNeeded(ctx.surface, task.createdAt, res)) return;

    const gate = await gateTaskWriteFreshness(req, {
      action: "task_unclaim",
      agentId,
      serverId,
      ctx,
      body: req.body,
      landing: () => taskConversationLanding(ctx, channel, task),
    });
    if (gate.held) {
      sendAgentApiResponse("taskUnclaim", res, gate.held);
      return;
    }

    const result = await taskService.unclaimTask(task.id, "agent", agentId);
    if (typeof result === "string") {
      refuse(res, 409, taskUnclaimRefusal(result, channel, task_number));
      return;
    }

    const io: SocketServer = req.app.get("io");
    // Task v2: a task talking in its own conversation gets the "released"
    // line there, as the web unclaim posts it (no mention; the follow stays).
    // A pre-v2 task on a flag-off server: nothing posted, as before.
    const releasedLine = taskUsesOwnConversation(task, await isTaskV2ConversationsEnabled(ctx.localChannel.serverId));
    await emitTaskMutationToSurfaces(
      io,
      ctx.surface,
      releasedLine ? await withTaskConversationEnsured(result, { initiatingServerId: ctx.localChannel.serverId }) : result,
    );
    if (releasedLine) {
      const content = `🔓 ${ctx.agent.displayName || ctx.agent.name || "An agent"} released #${task.taskNumber} "${messageService.summarizeForSystemMessage(task.title)}"`;
      void (async () => {
        try {
          const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
          if (!agentOrchestrator) return;
          await postTaskConversationNotice(io, agentOrchestrator, {
            taskId: task.id,
            localChannel: ctx.localChannel,
            actor: { type: "agent", id: agentId },
            content,
            legacyContent: null,
          });
        } catch (err) {
          console.error("agent task unclaim: failed to post lifecycle system message:", err);
        }
      })();
    }

    sendAgentApiResponse("taskUnclaim", res, { ok: true, title: task.title, ...await agentApiTaskRefField(ctx, channel, task), ...(gate.unseen ? { unseen: gate.unseen } : {}) });
    void recordAgentRaftAction(req, agentId, {
      title: `Unclaimed task #${task_number}`,
      text: `target: ${channel}`,
      producerFactId: task.id,
    });
  } catch (err) {
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to unclaim task",
      logPrefix: "internal.agent-api.task-unclaim error:",
      err,
    });
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
      refuse(res, 401, AGENT_CREDENTIAL_REQUIRED_REFUSAL);
      return;
    }

    const { channel, task_number, assignee: assigneeRef, expected_revision, reason: rawReason } =
      req.body as AgentApiRequestBodyByRoute["taskAssign"];
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel, res);
    if (!ctx) {
      refuseTaskChannelNotFound(res);
      return;
    }
    if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }

    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      refuseTaskNotFound(res, channel, task_number);
      return;
    }
    if (rejectHistoricalJointTaskWriteIfNeeded(ctx.surface, task.createdAt, res)) return;

    let assignee: taskService.TaskCreationAssignee | null = null;
    if (assigneeRef !== null) {
      assignee = await resolveTaskAssignAssignee(ctx.channelId, assigneeRef);
      if (!assignee) {
        refuse(res, 404, {
          code: "assignee_not_assignable",
          error: sentenceQuoting([String(assigneeRef)], `${assigneeRef} isn't exactly one member of this channel, so the task can't be assigned to that name: pick one of the channel's members.`, "That assignee isn't exactly one member of this channel, so the task can't be assigned to that name: pick one of the channel's members."),
          next: RAFT_HINTS.channelMembers(channel),
        });
        return;
      }
    }

    // Handing the task to someone else carries what it waits on them for
    // (checkTaskAssignReason). From an agent it is required, when its client
    // offers a reason at all (sends the key): a CLI from before reasons has
    // no way to give one, so it is not refused for it. Checked before the
    // freshness gate: a missing or unusable reason fails at once, not after a
    // hold and a rerun. Re-assigning the current assignee changes nothing, so
    // it needs no reason, and a reason sent with it is refused (it would go
    // nowhere): a reply in the task's conversation is how to tell them.
    const handoff = assignee !== null && !(assignee.type === "agent" && assignee.id === agentId);
    const unchanged = assignee
      ? task.claimedByType === assignee.type && task.claimedById === assignee.id
      : task.claimedById === null;
    const reasonCheck = checkTaskAssignReason(rawReason, handoff);
    if (reasonCheck.refusal) {
      refuse(res, 400, { code: reasonCheck.refusal.code, error: reasonCheck.refusal.message });
      return;
    }
    const reason = reasonCheck.reason;
    const taskRef = formatAgentTaskRef(channel, task.taskNumber) ?? `${channel}:#${task.taskNumber}`;
    if (unchanged && reason) {
      refuse(res, 409, {
        code: TASK_ASSIGN_REASON_UNCHANGED,
        error: TASK_ASSIGN_REASON_UNCHANGED_MESSAGE,
        next: RAFT_HINTS.taskReply(taskRef),
      });
      return;
    }
    if (handoff && !unchanged && !reason && rawReason !== undefined) {
      refuse(res, 400, {
        code: TASK_ASSIGN_REASON_REQUIRED,
        error: TASK_ASSIGN_REASON_REQUIRED_MESSAGE,
        next: RAFT_HINTS.taskAssignWithReason({ ref: taskRef, target: channel, taskNumber: task.taskNumber, assignee: String(assigneeRef) }),
      });
      return;
    }

    const gate = await gateTaskWriteFreshness(req, {
      action: "task_assign",
      agentId,
      serverId,
      ctx,
      body: req.body,
      landing: () => taskConversationLanding(ctx, channel, task),
    });
    if (gate.held) {
      sendAgentApiResponse("taskAssign", res, gate.held);
      return;
    }

    const result = await taskService.assignTask(task.id, assignee, "agent", agentId, {
      expectedRevision: expected_revision,
      reason,
    });
    if (typeof result === "string") {
      refuse(res, 409, taskAssignRefusal(result, channel, task.taskNumber));
      return;
    }

    const io: SocketServer = req.app.get("io");
    // Task v2: a pre-v2 task gets its conversation before the broadcast, so
    // the board hears one update carrying it (flag off / no-op: unchanged).
    await emitTaskMutationToSurfaces(
      io,
      ctx.surface,
      result.row.revision !== task.revision ? await withTaskConversationEnsured(result, { initiatingServerId: ctx.localChannel.serverId }) : result,
    );

    // Lifecycle line in the task conversation (parity with the human route).
    // Handing the task to someone else makes them follow and mentions them
    // once: a person gets an inbox entry, an agent is woken (mute-piercing).
    // A no-op (same assignee, no revision bump) announces nothing. Without a
    // conversation (flag off) nothing is posted, as before task v2.
    if (result.row.revision !== task.revision) {
      const actor = { type: "agent" as const, id: agentId };
      void (async () => {
        try {
          const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
          if (!agentOrchestrator) return;
          const notice = await buildTaskAssignmentNotice({
            actor,
            assignee,
            taskNumber: task.taskNumber,
            title: task.title,
            reason,
          });
          await postTaskConversationNotice(io, agentOrchestrator, {
            taskId: task.id,
            localChannel: ctx.localChannel,
            actor,
            content: notice.content,
            attention: notice.attention,
            follower: notice.follower,
            legacyContent: null,
            actionMetadata: notice.actionMetadata,
          });
        } catch (err) {
          console.error("agent task assign: failed to post lifecycle system message:", err);
        }
      })();
    }

    sendAgentApiResponse("taskAssign", res, {
      ok: true,
      revision: result.row.revision,
      assignee: assigneeRef ?? null,
      title: task.title,
      ...await agentApiTaskRefField(ctx, channel, task),
    });
    void recordAgentRaftAction(req, agentId, {
      title: assigneeRef
        ? `Assigned task #${task_number} to ${assigneeRef}`
        : `Unassigned task #${task_number}`,
      text: `target: ${channel}`,
      producerFactId: task.id,
    });
  } catch (err) {
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to assign task",
      logPrefix: "internal.agent-api.task-assign error:",
      err,
    });
  }
});

registerAgentApiRoute("taskUpdateStatus", ...agentApiRequestValidators("taskUpdateStatus"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      refuse(res, 401, AGENT_CREDENTIAL_REQUIRED_REFUSAL);
      return;
    }

    const { channel, task_number, status, reason } = req.body as AgentApiRequestBodyByRoute["taskUpdateStatus"];
    // A move into backlog may say what would bring the task back; no other status takes a reason.
    const reasonCheck = checkTaskStatusReason(status, reason);
    if (reasonCheck.refusal) {
      refuse(res, 400, { code: reasonCheck.refusal.code, error: reasonCheck.refusal.message });
      return;
    }
    const backlogReason = reasonCheck.reason;
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel, res);
    if (!ctx) {
      refuseTaskChannelNotFound(res);
      return;
    }
    if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }

    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      refuseTaskNotFound(res, channel, task_number);
      return;
    }
    if (rejectHistoricalJointTaskWriteIfNeeded(ctx.surface, task.createdAt, res)) return;

    const gate = await gateTaskWriteFreshness(req, {
      action: "task_update",
      agentId,
      serverId,
      ctx,
      body: req.body,
      landing: () => taskConversationLanding(ctx, channel, task),
    });
    if (gate.held) {
      sendAgentApiResponse("taskUpdateStatus", res, gate.held);
      return;
    }

    // No admin force retry: since any status can move to any other (#12227),
    // a member-level refusal here is an invariant (done needs its receipt,
    // same status) or a lost write race, and an admin is refused the same way.
    // Same as the browser route.
    const result = await taskService.updateTaskStatus(task.id, status, agentId, "agent", undefined, {
      initiatingServerId: ctx.localChannel.serverId,
      ...(backlogReason && { backlogReason }),
    });
    if (typeof result === "string") {
      refuse(res, 409, taskStatusRefusal(result, channel, task_number));
      return;
    }
    // What was stored: a task v2 task asked for in_review stores in_progress.
    const storedStatus = result.row.status;

    const io: SocketServer = req.app.get("io");
    const hasDiscussion = Boolean(task.messageId || task.conversationChannelId || task.ownConversation);
    await emitTaskMutationToSurfaces(
      io,
      ctx.surface,
      hasDiscussion ? await withTaskConversationEnsured(result, { initiatingServerId: ctx.localChannel.serverId }) : result,
    );

    // Lifecycle system message into the task thread (parity with the human
    // route): the acting agent should not see its own status change as unread.
    // No status allow-list here — status is already constrained at route
    // validation, and buildTaskStatusChangeNotice has the emoji/label fallback.
    // A hand-written list here would drift from the human path (same bug we just fixed).
    // Nothing changed (in_review asked of a task v2 task already in_progress): no line.
    if (hasDiscussion && !result.unchanged) {
      void (async () => {
        try {
          const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
          if (!agentOrchestrator) return;
          const actor = { type: "agent" as const, id: agentId };
          await postTaskConversationNotice(io, agentOrchestrator, {
            taskId: task.id,
            localChannel: ctx.localChannel,
            actor,
            // The actor by display name, as every lifecycle line names it.
            content: await buildTaskStatusNotice({ actor, taskNumber: task.taskNumber, title: task.title, status: storedStatus, backlogReason }),
            // Flag off: the pre-v2 host-thread line, word for word (it named
            // the agent by handle).
            legacyContent: messageService.buildTaskStatusChangeNotice(ctx.agent.name || "Someone", task.taskNumber, task.title, storedStatus, backlogReason),
          });
        } catch (err) {
          console.error("agent task status: failed to post lifecycle system message:", err);
        }
      })();
    }

    sendAgentApiResponse("taskUpdateStatus", res, { ok: true, status: storedStatus, title: task.title, ...await agentApiTaskRefField(ctx, channel, task), ...(gate.unseen ? { unseen: gate.unseen } : {}) });
    void recordAgentRaftAction(req, agentId, {
      title: `Updated task #${task_number} to ${storedStatus}`,
      text: `target: ${channel}`,
      producerFactId: task.id,
    });
  } catch (err) {
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to update task status",
      logPrefix: "internal.agent-api.task-update-status error:",
      err,
    });
  }
});

registerAgentApiRoute("taskResourceReceipt", ...agentApiRequestValidators("taskResourceReceipt"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      refuse(res, 401, AGENT_CREDENTIAL_REQUIRED_REFUSAL);
      return;
    }

    const { channel, task_number, receipt } =
      req.body as AgentApiRequestBodyByRoute["taskResourceReceipt"];
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel, res);
    if (!ctx) {
      refuseTaskChannelNotFound(res);
      return;
    }
    if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }

    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      refuseTaskNotFound(res, channel, task_number);
      return;
    }
    if (rejectHistoricalJointTaskWriteIfNeeded(ctx.surface, task.createdAt, res)) return;
    const teardownOwner = await resolveTaskResourceTeardownOwner(
      ctx.surface,
      ctx.channelId,
      receipt.teardown_owner,
    );
    if (!teardownOwner) {
      refuse(res, 409, {
        code: "teardown_owner_not_assignable",
        error: sentenceQuoting([String(receipt.teardown_owner)], `${receipt.teardown_owner} isn't exactly one agent in this task's channel, so it can't own the resource's teardown: name an agent who is a member of the channel.`, "That teardown owner isn't exactly one agent in this task's channel, so it can't own the resource's teardown: name an agent who is a member of the channel."),
        next: RAFT_HINTS.channelMembers(channel),
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
    // Task v2: when the receipt line created the task's conversation (lazily;
    // only ever on a new receipt), this task:updated carries it to every
    // board showing the task, as the other lazy paths do
    // (broadcastCreatedTaskConversation): result.task is the post-creation row.
    if (!result.idempotent) {
      await emitTaskMutationToSurfaces(io, ctx.surface, { source: "tasks", row: result.task });
    }
    // Task v2: the follow-up's anchor line in the task conversation (no source message).
    if (result.receiptLine) {
      await publishTaskResourceReceiptLine(io, req.app.get("agentOrchestrator") as AgentOrchestrator, result.receiptLine, { type: "agent", id: agentId });
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
        // Task v2: the source message, or the receipt line in the task conversation.
        msgId: (result.expiryFollowup.msgId ?? result.task.messageId ?? result.task.sourceMessageId)!,
        // The task conversation (the owner's face) for a receipt-line anchor.
        targetChannelId: result.expiryFollowup.targetChannelId ?? teardownOwner.targetChannelId,
      },
    });
    void recordAgentRaftAction(req, agentId, {
      title: `Recorded resource receipt for task #${task_number}`,
      text: `target: ${channel}`,
      producerFactId: task.id,
    });
  } catch (err) {
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to record task resource receipt",
      logPrefix: "internal.agent-api.task-resource-receipt error:",
      err,
    });
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
      refuse(res, 401, AGENT_CREDENTIAL_REQUIRED_REFUSAL);
      return;
    }

    const { channel, task_number } = req.body as AgentApiRequestBodyByRoute["taskDelete"];
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel, res);
    if (!ctx) {
      refuseTaskChannelNotFound(res);
      return;
    }
    if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }

    const owner = await taskService.resolveTaskByNumber(ctx.storageChannelId, task_number);
    if (!owner) {
      refuseTaskNotFound(res, channel, task_number);
      return;
    }
    if (rejectHistoricalJointTaskWriteIfNeeded(ctx.surface, owner.row.createdAt, res)) return;

    const isCreator = owner.row.createdByType === "agent" && owner.row.createdById === agentId;
    if (!isCreator && !await actorHasServerCapabilityInServer(serverId, "agent", agentId, "deleteAnyTask")) {
      refuse(res, 403, {
        code: "task_delete_forbidden",
        error: "Only the task's creator or a server admin can delete a task: ask one of them to delete it, or close the task instead.",
      });
      return;
    }

    const title = owner.row.title;
    // Task v2 (W6): deleting a task deletes its conversation with it: every
    // face is soft-deleted and detached in the delete transaction (bridged
    // messages stay referenced), its follows go and every listing hides it.
    const conversations = await listTaskConversationsByParentChannel(owner.row.id);
    await taskService.deleteTaskByOwner(owner, { type: "agent", id: agentId, serverId });

    const io: SocketServer = req.app.get("io");
    const targets = await getTaskRealtimeSurfaceTargets(ctx.surface);
    for (const target of targets) {
      const conversationChannelId = conversations.get(target.channelId);
      emitTaskDeleted(io, target, { channelId: target.channelId, taskId: owner.row.id, ...(conversationChannelId && { conversationChannelId }) });
    }

    // A task created the v2 way posted nothing in the channel, so its
    // deletion posts nothing there either. Pre-v2 tasks: the line, as before.
    if (!owner.row.ownConversation) {
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
    }

    sendAgentApiResponse("taskDelete", res, { ok: true, ...await agentApiTaskRefField(ctx, channel, owner.row) });
    void recordAgentRaftAction(req, agentId, {
      title: `Deleted task #${task_number}`,
      text: `target: ${channel}`,
      producerFactId: owner.row.id,
    });
  } catch (err) {
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to delete task",
      logPrefix: "internal.agent-api.task-delete error:",
      err,
    });
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
      refuse(res, 401, AGENT_CREDENTIAL_REQUIRED_REFUSAL);
      return;
    }

    const { channel, message_id } = req.body as AgentApiRequestBodyByRoute["taskConvert"];
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel, res);
    if (!ctx) {
      refuseTaskChannelNotFound(res);
      return;
    }
    if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }

    // Task v2 server: a message is never converted; answer with the
    // create-from-message command instead (spec §5).
    const useCreate = await taskV2ConvertRefusal({
      storageChannelId: ctx.storageChannelId,
      initiatingServerId: ctx.localChannel.serverId,
      channel,
      messageId: message_id,
      selfHandle: ctx.agent.name,
    });
    if (useCreate) {
      res.status(useCreate.status).json(useCreate.body);
      return;
    }

    const resolved = await taskService.resolveMessageInChannel(ctx.storageChannelId, message_id);
    if (!resolved) {
      refuse(res, 404, {
        code: "message_not_found",
        error: sentenceQuoting([String(message_id)], `There is no message ${message_id} in this channel to convert: use the id of a message in the channel the task goes on.`, "There is no such message in this channel to convert: use the id of a message in the channel the task goes on."),
      });
      return;
    }
    // A message behind the plan's history window can't become a task: its text would be the title.
    const historyWindow = await getServerHistoryWindowForRead(serverId);
    if (isBehindHistoryWindow(resolved.createdAt, historyWindow)) {
      setRequestTraceErrorCode(res, "history_limited");
      refuseKeepingTraceReason(res, 404, agentHistoryLimitedRefusal(historyWindow));
      return;
    }
    if (rejectHistoricalJointTaskWriteIfNeeded(ctx.surface, resolved.createdAt, res)) return;

    const converted = await taskService.convertMessageToTask(resolved.id, "agent", agentId, ctx.storageChannelId);
    if (typeof converted === "string") {
      refuse(res, 409, taskConvertRefusal(converted));
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
          causalActor: { type: "agent", id: agentId },
        },
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
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to convert message to task",
      logPrefix: "internal.agent-api.task-convert error:",
      err,
    });
  }
});

registerAgentApiRoute("taskAmend", ...agentApiRequestValidators("taskAmend"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      refuse(res, 401, AGENT_CREDENTIAL_REQUIRED_REFUSAL);
      return;
    }

    const { channel, task_number, title, description } = req.body as AgentApiRequestBodyByRoute["taskAmend"];
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel, res);
    if (!ctx) {
      refuseTaskChannelNotFound(res);
      return;
    }
    if (rejectAgentApiTaskWriteIfNeeded(await channelService.canAgentPostToChannel(ctx.channelId, agentId), res)) return;
    if (await channelService.isChannelArchived(ctx.channelId)) {
      refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
      return;
    }

    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      refuseTaskNotFound(res, channel, task_number);
      return;
    }
    if (rejectHistoricalJointTaskWriteIfNeeded(ctx.surface, task.createdAt, res)) return;

    const gate = await gateTaskWriteFreshness(req, {
      action: "task_amend",
      agentId,
      serverId,
      ctx,
      body: req.body,
      landing: () => taskConversationLanding(ctx, channel, task),
    });
    if (gate.held) {
      sendAgentApiResponse("taskAmend", res, gate.held);
      return;
    }

    const patch: taskService.TaskAmendPatch = {};
    if (title !== undefined) patch.title = title;
    if (description !== undefined) patch.description = description;
    const result = await taskService.amendTask(task.id, patch, "agent", agentId);
    if (typeof result === "string") {
      refuse(res, 409, taskAmendRefusal(result, channel, task_number));
      return;
    }

    const actor = await agentService.getAgent(agentId);
    const io: SocketServer = req.app.get("io");
    const hasDiscussion = Boolean(task.messageId || task.conversationChannelId || task.ownConversation);
    const mutation = { source: "tasks" as const, row: result.row };
    await emitTaskMutationToSurfaces(
      io,
      ctx.surface,
      hasDiscussion ? await withTaskConversationEnsured(mutation, { initiatingServerId: ctx.localChannel.serverId }) : mutation,
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

    // The same line in the task's discussion as an edit on the web (parity
    // with PATCH /api/tasks/:taskId): "✏️ Cody changed the title of #7 …". It
    // notifies nobody. Without a conversation (flag off) it goes to the host
    // message's thread, as the status line does.
    if (hasDiscussion) {
      void (async () => {
        try {
          const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
          if (!agentOrchestrator) return;
          const noticeActor = { type: "agent" as const, id: agentId };
          const content = await buildTaskAmendNotice({
            actor: noticeActor,
            taskNumber: result.row.taskNumber,
            title: result.row.title,
            changed: {
              title: result.event.payload.changes.title !== undefined,
              description: result.event.payload.changes.description !== undefined,
            },
          });
          if (!content) return;
          await postTaskConversationNotice(io, agentOrchestrator, {
            taskId: task.id,
            localChannel: ctx.localChannel,
            actor: noticeActor,
            content,
          });
        } catch (err) {
          console.error("agent task amend: failed to post lifecycle system message:", err);
        }
      })();
    }

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
      ...(gate.unseen ? { unseen: gate.unseen } : {}),
    });
    void recordAgentRaftAction(req, agentId, {
      title: `Amended task #${task_number}`,
      text: `target: ${channel}\nrevision: ${result.row.revision}\nevent_seq: ${result.event.seq}`,
      producerFactId: result.event.id,
    });
  } catch (err) {
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to amend task",
      logPrefix: "internal.agent-api.task-amend error:",
      err,
    });
  }
});

registerAgentApiRoute("taskHistory", ...agentApiRequestValidators("taskHistory"), async (req, res) => {
  try {
    const agentId = req.actingAgentId;
    const serverId = req.serverId;
    if (!agentId || !serverId) {
      refuse(res, 401, AGENT_CREDENTIAL_REQUIRED_REFUSAL);
      return;
    }

    const query = validateAgentApiQuery("taskHistory", req, res);
    if (!query) return;
    const { channel, task_number } = query;
    const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel, res);
    if (!ctx) {
      refuseTaskChannelNotFound(res);
      return;
    }
    const task = await taskService.getTaskByNumber(ctx.storageChannelId, task_number);
    if (!task) {
      refuseTaskNotFound(res, channel, task_number);
      return;
    }
    const history = await taskService.listTaskHistory(task.id);
    if (typeof history === "string") {
      refuse(res, 409, history === "task not found"
        ? taskNotFoundRefusal(channel, task_number)
        : history.startsWith("legacy task cards")
          ? taskLegacyCardRefusal(task_number, "history")
          : { code: "task_history_rejected", error: history });
      return;
    }
    const owner = await taskService.resolveTaskById(task.id);
    if (!owner || owner.source !== "tasks") {
      refuse(res, 409, taskLegacyCardRefusal(task_number, "history"));
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
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to read task history",
      logPrefix: "internal.agent-api.task-history error:",
      err,
    });
  }
});

export const REMINDERS_UNSUPPORTED_FOR_EXTERNAL_AGENTS = "reminders_unsupported_for_external_agents";
/**
 * Guards the legacy reminder writes (schedule, update, snooze). Runs before
 * request validation so the answer does not depend on the payload. Reads
 * (list, log) and cancel stay available in both cases below, and reminders
 * already queued keep firing.
 *
 * - External agent: reminders are fired by the agent's Computer (the daemon
 *   schedules them locally); an external agent has none, so a reminder it
 *   schedules would be stored and never fire.
 * - `reminder_app` on for the server: reminders moved to the Reminder app
 *   (see refuseIfRemindersMovedToApp).
 */
const refuseLegacyReminderMutation: RequestHandler = async (req, res, next) => {
  try {
    const external = typeof req.actingAgentIsExternal === "boolean"
      ? req.actingAgentIsExternal
      : isExternalAgentRuntime((await agentService.getAgent(req.actingAgentId!))?.runtime ?? "");
    if (external) {
      refuse(res, 409, {
        code: REMINDERS_UNSUPPORTED_FOR_EXTERNAL_AGENTS,
        error: "Reminders are not yet supported for external agents, because a reminder is fired by the agent's Raft computer and an external agent has none: nothing was scheduled, so keep track of the time another way.",
      });
      return;
    }
    if (await refuseIfRemindersMovedToApp(res, req.serverId)) return;
    next();
  } catch (err) {
    next(err);
  }
};

// ── Task v2: task conversations (`raft task view|read|reply|follow|unfollow`) ──
//
// A task is addressed like every task route (`channel` = the agent's board
// target, `task_number`); the agent-facing name is the task ref
// (`#channel:#7`), formatted from that same board target. The conversation an
// agent reads, replies in and follows is its LOCAL task conversation (the
// canonical one for an ordinary channel, its server's projection for a joint
// channel). Reply and follow create the conversation of a task from before
// task v2 on a flag-on server (initiating server's flag); reads never create.

type AgentApiTaskConversationAddress = {
  /** The board target as the agent gave it (`#channel`, `dm:@peer`). */
  channel: string;
  ctx: AgentApiTaskChannelContext;
  task: NonNullable<Awaited<ReturnType<typeof taskService.getTaskByNumber>>>;
  taskRef: string;
};

async function resolveAgentApiTaskConversationAddress(
  req: Request,
  res: Response,
  channel: string,
  taskNumber: number,
): Promise<AgentApiTaskConversationAddress | null> {
  const agentId = req.actingAgentId;
  const serverId = req.serverId;
  if (!agentId || !serverId) {
    refuse(res, 401, AGENT_CREDENTIAL_REQUIRED_REFUSAL);
    return null;
  }
  const ctx = await resolveAgentApiTaskChannel(agentId, serverId, channel, res);
  if (!ctx) {
    refuseTaskChannelNotFound(res);
    return null;
  }
  // Visibility through the one entry (visibilityService.canView).
  const [visible] = await canView({ type: "agent", id: agentId, serverId: serverId as ServerId }, [{ kind: "conversation", channelId: ctx.channelId }]);
  if (!visible) {
    setRequestTraceErrorCode(res, "task_channel_not_accessible");
    refuseTaskChannelNotFound(res);
    return null;
  }
  const task = await taskService.getTaskByNumber(ctx.storageChannelId, taskNumber);
  if (!task) {
    refuseTaskNotFound(res, channel, taskNumber);
    return null;
  }
  const taskRef = formatAgentTaskRef(channel, taskNumber) ?? `${channel} task #${taskNumber}`;
  return { channel, ctx, task, taskRef };
}

/**
 * The agent's local conversation for the task, creating it (flag-on
 * initiating server) when `create`. Null: none exists (and, with `create`,
 * task conversations are off here). The flag-off answer names the old thread.
 */
async function agentApiLocalTaskConversation(
  address: AgentApiTaskConversationAddress,
  opts: { create: boolean; io?: SocketServer | null },
): Promise<string | null> {
  const { ctx, task } = address;
  if (opts.create) {
    // Created here (lazy): boards hear one task:updated carrying it.
    const ensured = await ensureTaskConversationAndBroadcast(opts.io, task.id, { initiatingServerId: ctx.localChannel.serverId });
    if (!ensured) return null;
  }
  return resolveLocalTaskConversationId(task.id, ctx.channelId);
}

function respondTaskConversationsNotEnabled(res: Response, address: AgentApiTaskConversationAddress): void {
  const hostMessageId = address.task.messageId;
  refuse(res, 409, {
    code: "task_conversations_not_enabled",
    error: hostMessageId
      ? `Task conversations are not enabled on this server, so task #${address.task.taskNumber} is discussed in its message's thread: reply there instead.`
      : `Task conversations are not enabled on this server, and task #${address.task.taskNumber} has no conversation: talk about it in its channel instead.`,
    ...(hostMessageId && { next: RAFT_HINTS.messageSend({ target: agentTaskThreadTarget(address.channel, hostMessageId) }) }),
  });
}

async function agentTaskConversationFollow(conversationChannelId: string, agentId: string): Promise<{ following: boolean; reason: string | null }> {
  const [row] = await getDb()
    .select({ reason: threadFollows.reason, doneAt: threadFollows.doneAt, unfollowedAt: threadFollows.unfollowedAt })
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, conversationChannelId),
      eq(threadFollows.followerType, "agent"),
      eq(threadFollows.followerId, agentId),
    ))
    .limit(1);
  if (!row || row.unfollowedAt) return { following: false, reason: null };
  return { following: true, reason: row.reason ?? null };
}

async function agentApiMessageSenderName(message: { senderType: string; senderId: string; messageType?: string | null }): Promise<string | null> {
  if (message.messageType === "system") return "system";
  if (message.senderType === "agent") return (await agentService.getAgent(message.senderId))?.name ?? null;
  if (message.senderType === "user") {
    const [user] = await getDb().select({ name: users.name }).from(users).where(eq(users.id, message.senderId)).limit(1);
    return user?.name ?? null;
  }
  return null;
}

registerAgentApiRoute("taskView", ...agentApiRequestValidators("taskView"), async (req, res) => {
  try {
    const query = validateAgentApiQuery("taskView", req, res);
    if (!query) return;
    const address = await resolveAgentApiTaskConversationAddress(req, res, query.channel, query.task_number);
    if (!address) return;
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const { ctx, task, taskRef } = address;
    const limit = Math.min(Math.max(Number(query.limit) || 5, 1), 20);

    const v2 = await isTaskV2ConversationsEnabled(ctx.localChannel.serverId);
    const [listed] = (await taskService.listTasks(ctx.storageChannelId)).filter((t) => t.taskNumber === task.taskNumber);
    const dto = listed
      ? taskService.projectTaskToChannel(markPendingTaskConversations([listed], v2)[0]!, ctx.localChannel)
      : { taskNumber: task.taskNumber, status: task.status, title: task.title, description: task.description };

    const conversationId = await agentApiLocalTaskConversation(address, { create: false });
    // The plan's history window, as for any read (services/historyWindow.ts).
    const historyWindow = await getServerHistoryWindowForRead(serverId);
    let recent: Array<Record<string, unknown>> = [];
    let hasOlder = false;
    let historyLimited = false;
    if (conversationId) {
      const projection = await channelService.getJointThreadProjectionByLocalThread(conversationId, serverId);
      const storageId = projection?.canonicalThreadChannelId ?? conversationId;
      const raw = await messageService.listMessages(storageId, limit + 1, undefined, undefined, historyWindow.cutoff, {
        forwardedBundleViewerAgentId: agentId,
        viewerServerId: serverId,
        includeSenderTimezone: true,
      });
      const projected = projection
        ? await messageService.projectJointMessagesToLocalChannel(raw, projection.localThreadChannelId, serverId)
        : raw;
      const page = paginateHistoryProbe(projected, limit, "latest");
      hasOlder = page.hasOlder;
      historyLimited = historyWindow.cutoff !== undefined && !hasOlder
        && await messageService.hasOlderMessages(storageId, historyWindow.cutoff);
      const rendered = await agentPermalinkRenderService.renderAgentReadablePermalinksInTexts(
        page.messages.map((message) => message.content),
        serverId,
      );
      recent = (await withAgentMessageReactions(page.messages)).map((message, index) => toAgentApiMessageEnvelope(
        message,
        messageService.appendAgentFacingForwardedSnapshot(
          renderAgentCommentScopedContent(rendered[index] ?? "", message.commentRef),
          message.actionMetadata,
        ),
        agentId,
      ));
    }

    let sourceMessage: AgentApiResponseByRoute["taskView"]["sourceMessage"] = null;
    // Only a recorded source, as the web shows it (enrichTaskRows'
    // `sourceRecorded`): a pre-v2 task posted as its own message has its echo
    // as "source", and a task created without one has none; both print
    // "Source: (not recorded)". A converted pre-v2 task's host is its source.
    const sourceRecorded = (listed as { sourceRecorded?: boolean } | undefined)?.sourceRecorded;
    const sourceMessageId = sourceRecorded === false ? null : task.sourceMessageId ?? task.messageId;
    if (sourceMessageId) {
      const source = await messageService.getMessage(sourceMessageId);
      if (source) {
        // A source behind the window keeps who and when, not what it said.
        const sourceBehindWindow = isBehindHistoryWindow(source.createdAt, historyWindow);
        sourceMessage = {
          id: source.id,
          target: query.channel,
          senderName: await agentApiMessageSenderName(source),
          content: sourceBehindWindow
            ? ""
            : (await agentPermalinkRenderService.renderAgentReadablePermalinksInTexts([source.content], serverId))[0] ?? source.content,
          ...(sourceBehindWindow && { historyLimitMessage: agentHistoryLimitedRefusal(historyWindow).error }),
          createdAt: source.createdAt instanceof Date ? source.createdAt.toISOString() : String(source.createdAt),
        };
      }
    }
    let earlierDiscussion: AgentApiResponseByRoute["taskView"]["earlierDiscussion"] = null;
    // A pre-v2 task talking in its own conversation (flag on, or it already
    // has one): its host message's thread is the earlier discussion.
    if (task.messageId && taskUsesOwnConversation(task, v2)) {
      const [thread] = await getDb()
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.parentMessageId, task.messageId), eq(channels.type, "thread"), isNull(channels.deletedAt)))
        .limit(1);
      if (thread) {
        const [counted] = await getDb()
          .select({ n: sql<number>`count(*)::int` })
          .from(messages)
          .where(and(eq(messages.channelId, thread.id), sql`${messages.messageType} <> 'system'`));
        const replyCount = Number(counted?.n ?? 0);
        if (replyCount > 0) {
          earlierDiscussion = { target: `${query.channel}:${task.messageId.slice(0, 8)}`, replyCount };
        }
      }
    }
    // No conversation yet (created lazily): a v2 task's creator and assignee
    // follow it from creation, so they are reported as following already
    // (one rule with --following and the web: ../services/taskV2Mode).
    const pendingReason = conversationId ? null : pendingTaskConversationFollowReason(task, { type: "agent", id: agentId });
    const follow = conversationId
      ? await agentTaskConversationFollow(conversationId, agentId)
      : { following: pendingReason !== null, reason: pendingReason };
    sendAgentApiResponse("taskView", res, {
      taskRef,
      task: dto as AgentApiResponseByRoute["taskView"]["task"],
      following: follow.following,
      followReason: follow.reason,
      conversation: {
        exists: Boolean(conversationId),
        replyCount: typeof (listed as { conversationReplyCount?: unknown } | undefined)?.conversationReplyCount === "number"
          ? (listed as { conversationReplyCount: number }).conversationReplyCount
          : recent.length,
      },
      sourceMessage,
      earlierDiscussion,
      recentMessages: recent as AgentApiResponseByRoute["taskView"]["recentMessages"],
      hasOlder,
      ...(historyLimited && { historyLimited: true, historyLimitMessage: agentHistoryLimitNote(historyWindow) }),
    });
  } catch (err) {
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to view task",
      logPrefix: "internal.agent-api.task-view error:",
      err,
    });
  }
});

registerAgentApiRoute("taskRead", ...agentApiRequestValidators("taskRead"), async (req, res) => {
  const query = validateAgentApiQuery("taskRead", req, res);
  if (!query) return;
  try {
    const address = await resolveAgentApiTaskConversationAddress(req, res, query.channel, query.task_number);
    if (!address) return;
    const conversationId = await agentApiLocalTaskConversation(address, { create: false });
    if (!conversationId) {
      if (!taskUsesOwnConversation(address.task, await isTaskV2ConversationsEnabled(address.ctx.localChannel.serverId))) {
        respondTaskConversationsNotEnabled(res, address);
        return;
      }
      // Nobody has written to it yet (lazy): no discussion yet.
      sendAgentApiResponse("taskRead", res, {
        target: address.taskRef,
        messages: [],
        has_more: false,
        has_older: false,
        has_newer: false,
        last_read_seq: 0,
        model_seen_up_to_seq: null,
        ...(query.unread === "true" && { unread_after_seq: 0, read_through_seq: 0 }),
      });
      return;
    }
    await serveAgentHistoryRead(req, res, {
      channel: address.taskRef,
      before: query.before,
      after: query.after,
      around: query.around,
      limit: query.limit,
      consume: query.consume,
      unread: query.unread,
    }, { channelId: conversationId, ref: address.taskRef });
  } catch (err) {
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: "Failed to read task conversation",
      logPrefix: "internal.agent-api.task-read error:",
      err,
    });
  }
});

registerAgentApiRoute("taskReply", (req, res) => handleAgentApiMessageSend(req, res, "taskReply"));

/**
 * Where a task reply lands: the agent's local task conversation, created on
 * the first reply to a task from before task v2 (flag-on initiating server).
 * Post authority = the task channel's (same as a thread's parent channel).
 */
async function resolveAgentApiTaskReplyTarget(
  req: Request,
  res: Response,
  channel: string,
  taskNumber: number,
): Promise<{ channelId: string; type: "thread"; taskRef: string } | null> {
  const address = await resolveAgentApiTaskConversationAddress(req, res, channel, taskNumber);
  if (!address) return null;
  const agentId = req.actingAgentId!;
  if (!await channelService.canAgentPostToChannel(address.ctx.channelId, agentId)) {
    refuse(res, 403, {
      code: "channel_membership_required",
      error: sentenceQuoting([String(channel)], `You can reply to ${channel}'s tasks only as a member of ${channel}: join it first.`, "You can reply to this channel's tasks only as a member of it: join it first."),
    });
    return null;
  }
  if (rejectHistoricalJointTaskWriteIfNeeded(address.ctx.surface, address.task.createdAt, res)) return null;
  if (await channelService.isChannelArchived(address.ctx.channelId)) {
    refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
    return null;
  }
  const conversationId = await agentApiLocalTaskConversation(address, { create: true, io: req.app.get("io") as SocketServer | undefined });
  if (!conversationId) {
    respondTaskConversationsNotEnabled(res, address);
    return null;
  }
  return { channelId: conversationId, type: "thread", taskRef: address.taskRef };
}

async function handleAgentApiTaskFollow(req: Request, res: Response, follow: boolean): Promise<void> {
  const routeKey = follow ? "taskFollow" : "taskUnfollow";
  try {
    const body = validateAgentApiBody(routeKey, req, res);
    if (!body) return;
    const address = await resolveAgentApiTaskConversationAddress(req, res, body.channel, body.task_number);
    if (!address) return;
    const agentId = req.actingAgentId!;
    // Follow creates the conversation (lazy). Unfollow creates it only for an
    // agent that follows from creation (creator / assignee): that follow is
    // what it leaves. Anyone else has nothing to leave.
    const create = follow || pendingTaskConversationFollowReason(address.task, { type: "agent", id: agentId }) !== null;
    const io = req.app.get("io") as SocketServer | undefined;
    let conversationId = await agentApiLocalTaskConversation(address, { create: false, io });
    if (!conversationId && create) {
      // Creating the conversation is a write, as for a person's follow and for
      // `raft task reply`: the agent may post in the task's channel, which is
      // not archived, and the task is not a historical joint (read-only) one.
      // Following an existing conversation only needs to see it.
      if (!await channelService.canAgentPostToChannel(address.ctx.channelId, agentId)) {
        refuse(res, 403, {
          code: "channel_membership_required",
          error: sentenceQuoting([String(body.channel)], `You can follow ${body.channel}'s tasks only as a member of ${body.channel}: join it first.`, "You can follow this channel's tasks only as a member of it: join it first."),
        });
        return;
      }
      if (rejectHistoricalJointTaskWriteIfNeeded(address.ctx.surface, address.task.createdAt, res)) return;
      if (await channelService.isChannelArchived(address.ctx.channelId)) {
        refuse(res, 409, CHANNEL_ARCHIVED_REFUSAL);
        return;
      }
      conversationId = await agentApiLocalTaskConversation(address, { create: true, io });
    }
    if (!conversationId) {
      if (!follow && taskUsesOwnConversation(address.task, await isTaskV2ConversationsEnabled(address.ctx.localChannel.serverId))) {
        sendAgentApiResponse(routeKey, res, { ok: true, taskRef: address.taskRef, following: false, changed: false });
        return;
      }
      respondTaskConversationsNotEnabled(res, address);
      return;
    }
    if (follow && await isLoungeOutsiderAgent(conversationId, agentId)) {
      refuse(res, 403, AGENT_LOUNGE_OUTSIDER);
      return;
    }
    const before = await agentTaskConversationFollow(conversationId, agentId);
    if (follow && !before.following) {
      await channelService.recordThreadFollow("agent", agentId, conversationId, null, "manual", {
        parentTaskId: address.task.id,
        reactivateUnfollowed: true,
        joinedThroughSeq: "latest",
      });
    } else if (!follow && before.following) {
      await channelService.unfollowThreadForFollower("agent", agentId, conversationId);
    }
    const changed = follow ? !before.following : before.following;
    if (changed) await emitThreadFollowersUpdated(io, conversationId);
    // Parity with `raft thread unfollow`: leaving says so in the task
    // conversation, with no inbox fact (zero audience). Following is silent.
    if (!follow && changed) {
      const reason = messageService.normalizeUnfollowReason((req.body as AgentApiRequestBodyByRoute["taskUnfollow"]).reason);
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
      const agent = await agentService.getAgent(agentId);
      if (agent && io && agentOrchestrator) {
        await messageService.broadcastSystemMessageToLocalSurfaces(
          io,
          agentOrchestrator,
          conversationId,
          messageService.buildUnfollowNotice(agent.name, "task", reason),
          {
            inboxFactPolicy: {
              mode: "skip",
              producer: "channel.self_unfollow_thread",
              reason: "self-unfollow has zero audience — no inbox fact",
            },
          },
        );
      }
    }
    sendAgentApiResponse(routeKey, res, { ok: true, taskRef: address.taskRef, following: follow, changed });
    if (changed) {
      void recordAgentRaftAction(req, agentId, {
        title: follow ? `Followed task ${address.taskRef}` : `Unfollowed task ${address.taskRef}`,
        text: `target: ${address.taskRef}`,
        producerFactId: address.task.id,
      });
    }
  } catch (err) {
    if (respondToTaskWriteError(err, res)) return;
    sendJsonServerError(req, res, {
      error: follow ? "Failed to follow task" : "Failed to unfollow task",
      logPrefix: `internal.agent-api.task-${follow ? "follow" : "unfollow"} error:`,
      err,
    });
  }
}

/**
 * GET /internal/agent-api/tasks/following — `raft task list --following`
 * (task v2): the task conversations the agent follows, with unread counts.
 * Threads stay in threadList.
 */
registerAgentApiRoute("taskFollowing", ...agentApiRequestValidators("taskFollowing"), async (req, res) => {
  try {
    const followed = await taskService.listAgentFollowedTaskConversations(req.serverId!, req.actingAgentId!);
    sendAgentApiResponse("taskFollowing", res, {
      tasks: followed.map(({ conversationChannelId: _local, ...task }) => task),
    });
  } catch (err: unknown) {
    sendJsonServerError(req, res, {
      error: "Failed to list followed tasks",
      code: "agent_api_task_following_failed",
      logPrefix: "[AgentAPI] Failed to list followed tasks",
      err,
    });
  }
});

registerAgentApiRoute("taskFollow", (req, res) => handleAgentApiTaskFollow(req, res, true));
registerAgentApiRoute("taskUnfollow", (req, res) => handleAgentApiTaskFollow(req, res, false));

/**
 * POST /internal/agent-api/tasks/idle-nudge — the idle task reminder
 * (#wg-task-v2:#9), asked by the agent's Computer on its Working→Idle edge:
 * which open tasks assigned to the agent, or with no assignee when it created
 * them, to remind it of now, why, and the notice to deliver. Records what it returns (services/idleTaskReminderService).
 * Off unless the server's `task_v2_conversations_v0` flag is on.
 */
registerAgentApiRoute(
  "taskIdleNudge",
  ...agentApiRequestValidators("taskIdleNudge"),
  validateAgentApiResponseMiddleware("taskIdleNudge"),
  async (req, res) => {
    try {
      const body = req.body as AgentApiRequestBodyByRoute["taskIdleNudge"];
      const result = await computeIdleTaskReminder({
        serverId: req.serverId!,
        agentId: req.actingAgentId!,
        freshSession: body.freshSession,
        backgroundTasks: body.backgroundTasks,
        rulesShown: body.rulesShown,
      });
      sendAgentApiResponse("taskIdleNudge", res, result);
    } catch (err: unknown) {
      sendJsonServerError(req, res, {
        error: "Failed to compute the idle task reminder",
        code: "agent_api_task_idle_nudge_failed",
        logPrefix: "[AgentAPI] Failed to compute the idle task reminder",
        err,
      });
    }
  },
);

/**
 * POST /internal/agent-api/migrations/retry — the acting agent retries, once,
 * its latest migration to another Computer that failed for workspace size
 * (routes/agentMigrationRetryRoute.ts).
 */
registerAgentApiRoute(
  "migrationRetry",
  validateAgentApiResponseMiddleware("migrationRetry"),
  handleAgentMigrationRetry,
);

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
    sendJsonServerError(req, res, {
      error: "Failed to list reminders",
      logPrefix: "internal.agent-api.reminder-list error:",
      err,
    });
  }
});

registerAgentApiRoute("reminderCreate", refuseLegacyReminderMutation, ...agentApiRequestValidators("reminderCreate"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const body = req.body as AgentApiRequestBodyByRoute["reminderCreate"];
    const { title, fireAt, delaySeconds, msgId, payload, repeat, tz, channel } = body;
    if (typeof title !== "string" || title.trim().length === 0) {
      refuse(res, 400, REMINDER_TITLE_REQUIRED_REFUSAL);
      return;
    }
    if (title.length > REMINDER_MAX_TITLE_LEN) {
      refuse(res, 400, REMINDER_TITLE_TOO_LONG_REFUSAL);
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
    const resolved = await resolveReminderMsgIdForAgentApi(serverId, agentId, msgId);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    // Agent Lounge: a reminder's receipt and firing land in its anchor's
    // conversation, which another agent's lounge never takes from them.
    const [anchor] = await getDb().select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, resolved.messageId));
    if (anchor && await isLoungeOutsiderAgent(anchor.channelId, agentId)) {
      refuse(res, 403, AGENT_LOUNGE_OUTSIDER);
      return;
    }

    let targetChannelId: string | null = null;
    if (channel != null) {
      if (typeof channel !== "string" || channel.length === 0) {
        refuse(res, 400, REMINDER_CHANNEL_INVALID_REFUSAL);
        return;
      }
      const ctx = await channelService.resolveChannelByName(serverId, agentId, channel);
      if (!ctx) {
        setRequestTraceErrorCode(res, "channel_not_found");
        refuseKeepingTraceReason(res, 404, REMINDER_CHANNEL_NOT_FOUND_REFUSAL);
        return;
      }
      if (await isLoungeOutsiderAgent(ctx.channelId, agentId)) {
        refuse(res, 403, AGENT_LOUNGE_OUTSIDER);
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
    await publishReminderEvent(req.app.get("io"), row, { type: "reminder:scheduled", reminder: summary });

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
    sendJsonServerError(req, res, {
      error: "Failed to create reminder",
      logPrefix: "internal.agent-api.reminder-create error:",
      err,
    });
  }
});

registerAgentApiRoute("reminderCancel", ...agentApiRequestValidators("reminderCancel"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const { reminderId } = req.params as AgentApiRequestParamsByRoute["reminderCancel"];
    const existing = await loadOwnedReminder(reminderId, serverId, agentId);
    if (!existing) {
      refuse(res, 404, REMINDER_NOT_FOUND_REFUSAL);
      return;
    }
    if (existing.status === "migrated") {
      setRequestTraceErrorCode(res, REMINDER_MIGRATED);
      refuse(res, 409, reminderMigratedRefusal(existing.id));
      return;
    }
    if (existing.status !== "scheduled" && existing.status !== "fired") {
      refuse(res, 409, reminderNotCancelableRefusal(existing.status));
      return;
    }

    const canceled = await reminderCrud.cancelAppReminder(reminderId, {
      actor: { type: "agent", id: agentId },
      expectedVersion: existing.version,
    });
    if (!canceled) {
      refuse(res, 409, REMINDER_STATE_CONFLICT_REFUSAL);
      return;
    }
    await syncReminderToComputer(req, canceled, "cancel");

    const [summary] = await reminderService.toReminderSummaries([canceled], serverId);
    await publishReminderEvent(req.app.get("io"), canceled, { type: "reminder:canceled" });

    sendAgentApiResponse("reminderCancel", res, { reminder: summary });
    recordRaftCliActivity(req, agentId, {
      command: "reminder.cancel",
      summary: "Canceled reminder",
      target: summary.msgRef ?? canceled.id,
      correlationId: canceled.id,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to cancel reminder",
      logPrefix: "internal.agent-api.reminder-cancel error:",
      err,
    });
  }
});

registerAgentApiRoute("reminderSnooze", refuseLegacyReminderMutation, ...agentApiRequestValidators("reminderSnooze"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const { reminderId } = req.params as AgentApiRequestParamsByRoute["reminderSnooze"];
    const { delaySeconds } = req.body as AgentApiRequestBodyByRoute["reminderSnooze"];
    const schedule = resolveScheduleInput({ delaySeconds }, Date.now());
    if (!schedule.ok) {
      setRequestTraceErrorCode(res, "reminder_schedule_invalid");
      refuse(res, 400, reminderScheduleInvalidRefusal(schedule.error));
      return;
    }

    const existing = await loadOwnedReminder(reminderId, serverId, agentId);
    if (!existing) {
      setRequestTraceErrorCode(res, "reminder_not_found");
      refuse(res, 404, REMINDER_NOT_FOUND_REFUSAL);
      return;
    }
    if (existing.status === "migrated") {
      setRequestTraceErrorCode(res, REMINDER_MIGRATED);
      refuse(res, 409, reminderMigratedRefusal(existing.id));
      return;
    }
    if (existing.status !== "scheduled" && existing.status !== "fired") {
      setRequestTraceErrorCode(res, "reminder_not_active");
      refuse(res, 409, reminderNotSnoozableRefusal(existing.status));
      return;
    }

    const snoozed = await reminderCrud.snoozeAppReminder(existing.id, Number(delaySeconds), {
      actor: { type: "agent", id: agentId },
      expectedVersion: existing.version,
    });
    if (!snoozed) {
      setRequestTraceErrorCode(res, "reminder_state_conflict");
      refuse(res, 409, REMINDER_STATE_CONFLICT_REFUSAL);
      return;
    }
    await syncReminderToComputer(req, snoozed, "upsert");

    const [summary] = await reminderService.toReminderSummaries([snoozed], serverId);
    await publishReminderEvent(req.app.get("io"), snoozed, { type: "reminder:scheduled", reminder: summary });
    sendAgentApiResponse("reminderSnooze", res, { reminder: summary });
    recordRaftCliActivity(req, agentId, {
      command: "reminder.snooze",
      summary: "Snoozed reminder",
      target: summary.msgRef ?? snoozed.id,
      correlationId: snoozed.id,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to snooze reminder",
      logPrefix: "internal.agent-api.reminder-snooze error:",
      err,
    });
  }
});

registerAgentApiRoute("reminderUpdate", refuseLegacyReminderMutation, ...agentApiRequestValidators("reminderUpdate"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const { reminderId } = req.params as AgentApiRequestParamsByRoute["reminderUpdate"];
    const body = req.body as AgentApiRequestBodyByRoute["reminderUpdate"];

    const existing = await loadOwnedReminder(reminderId, serverId, agentId);
    if (!existing) {
      setRequestTraceErrorCode(res, "reminder_not_found");
      refuse(res, 404, REMINDER_NOT_FOUND_REFUSAL);
      return;
    }
    if (existing.status === "fired") {
      setRequestTraceErrorCode(res, "reminder_not_active");
      refuse(res, 409, REMINDER_FIRED_NOT_UPDATABLE_REFUSAL);
      return;
    }
    if (existing.status === "migrated") {
      setRequestTraceErrorCode(res, REMINDER_MIGRATED);
      refuse(res, 409, reminderMigratedRefusal(existing.id));
      return;
    }
    if (existing.status !== "scheduled") {
      setRequestTraceErrorCode(res, "reminder_not_active");
      refuse(res, 409, reminderNotUpdatableRefusal(existing.status));
      return;
    }

    const { fireAt, delaySeconds, repeat, title, tz } = body;
    const mutations = [
      fireAt != null || delaySeconds != null ? "time" : null,
      repeat != null ? "repeat" : null,
      title != null ? "title" : null,
    ].filter(Boolean);
    if (mutations.length !== 1) {
      setRequestTraceErrorCode(res, "reminder_update_invalid");
      refuse(res, 400, REMINDER_UPDATE_INVALID_REFUSAL);
      return;
    }

    let patch: reminderService.ReminderUpdatePatch;
    let warning: string | undefined;
    if (fireAt != null || delaySeconds != null) {
      const schedule = resolveScheduleInput({ fireAt, delaySeconds }, Date.now());
      if (!schedule.ok) {
        setRequestTraceErrorCode(res, "reminder_schedule_invalid");
        refuse(res, 400, reminderScheduleInvalidRefusal(schedule.error));
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
        setRequestTraceErrorCode(res, "reminder_title_invalid");
        refuse(res, 400, REMINDER_TITLE_REQUIRED_REFUSAL);
        return;
      }
      if (title.length > REMINDER_MAX_TITLE_LEN) {
        setRequestTraceErrorCode(res, "reminder_title_invalid");
        refuse(res, 400, REMINDER_TITLE_TOO_LONG_REFUSAL);
        return;
      }
      patch = { kind: "title", title: title.trim() };
    }

    const updated = await reminderCrud.updateAppReminder(existing.id, patch, {
      actor: { type: "agent", id: agentId },
      expectedVersion: existing.version,
    });
    if (!updated) {
      setRequestTraceErrorCode(res, "reminder_state_conflict");
      refuse(res, 409, REMINDER_STATE_CONFLICT_REFUSAL);
      return;
    }
    await syncReminderToComputer(req, updated, "upsert");

    const [summary] = await reminderService.toReminderSummaries([updated], serverId);
    await publishReminderEvent(req.app.get("io"), updated, { type: "reminder:scheduled", reminder: summary });
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
    sendJsonServerError(req, res, {
      error: "Failed to update reminder",
      logPrefix: "internal.agent-api.reminder-update error:",
      err,
    });
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
    sendJsonServerError(req, res, {
      error: "Failed to acknowledge app source",
      logPrefix: "internal.agent-api.app-source-ack error:",
      err,
    });
  }
});

registerAgentApiRoute("reminderLog", ...agentApiRequestValidators("reminderLog"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;
    const { reminderId } = req.params as AgentApiRequestParamsByRoute["reminderLog"];
    const resolved = await reminderCrud.resolveAppHistoricalReminderIdForOwner(reminderId, serverId, agentId);
    if (resolved.kind === "ambiguous") {
      refuse(res, 409, {
        code: "reminder_id_ambiguous",
        error: "More than one of your reminders starts with that id: give more of the id, or the whole id.",
      });
      return;
    }
    if (resolved.kind !== "resolved") {
      refuse(res, 404, REMINDER_NOT_FOUND_REFUSAL);
      return;
    }

    const events = await reminderCrud.listAppReminderEventsForOwner(resolved.reminderId, serverId, agentId);
    sendAgentApiResponse("reminderLog", res, {
      // The `migrated` event stays server-side: older CLIs parse the event enum
      // strictly, and the list already shows the reminder as migrated.
      events: reminderService.toReminderEventSummaries(events.filter((event) => event.eventType !== "migrated")),
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to read reminder log",
      logPrefix: "internal.agent-api.reminder-log error:",
      err,
    });
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
    sendJsonServerError(req, res, {
      error: "Failed to read RAP App config",
      logPrefix: "internal.agent-api.app-config-get error:",
      err: error,
    });
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
    sendJsonServerError(req, res, {
      error: "Failed to update RAP App config",
      logPrefix: "internal.agent-api.app-config-patch error:",
      err: error,
    });
  }
});

function actionPrepareResponseBody(card: actionCardsService.PreparedActionCard): AgentApiResponseByRoute["actionPrepare"] {
  // The agent gets the card's metadata without `presentation.card` (copy for human clients).
  return { messageId: card.messageId, metadata: withoutAgentHiddenActionCardSpec({ ...card.metadata }), ...(card.existing ? { existing: true } : {}) };
}

// Ahead of the capability, grant and body checks, so a refused prepare names
// its card type too (a refused sign-in, or a body with no string
// `action.type`, has none).
const traceActionPrepareType: RequestHandler = (req, res, next) => {
  setRequestTraceActionType(res, (req.body as { action?: { type?: unknown } } | undefined)?.action?.type);
  next();
};

mountAgentApiRoute("actionPrepare", [...agentApiRequestValidators("actionPrepare"), async (req, res) => {
  try {
    const agentId = req.actingAgentId!;
    const serverId = req.serverId!;

    const body = req.body as AgentApiRequestBodyByRoute["actionPrepare"];
    const idempotency = agentApiIdempotencyScope(agentId, "actionPrepare", body.idempotencyKey, {
      target: body.target,
      action: body.action,
    });
    if (idempotency && await replayAgentApiIdempotentWrite(idempotency, res)) return;
    const actionType = typeof body.action.type === "string" ? body.action.type : null;
    if (actionType !== null && actionCardsService.INTEGRATION_COMMAND_ACTION_TYPES.has(actionType)) {
      refuse(res, 400, ACTION_TYPE_NOT_PREPARABLE_REFUSAL);
      return;
    }

    const target = body.target.trim();
    const resolved = await resolveWritableAgentTarget(serverId, agentId, target);
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
    let out: Awaited<ReturnType<typeof actionCardsService.prepareActionCard>>;
    try {
      out = await actionCardsService.prepareActionCard({
        serverId,
        requesterAgentId: agentId,
        targetChannelId: resolved.channelId,
        action: body.action,
        agentAuthored: true,
        io: io ?? null,
        ...(idempotency && {
          beforeCommit: (executor, result) => idempotentAgentApiService.recordAgentApiIdempotentResponse(executor, idempotency, {
            status: result.existing ? 200 : 201,
            body: actionPrepareResponseBody(result),
          }),
        }),
      });
    } catch (err) {
      if (idempotency && err instanceof idempotentAgentApiService.AgentApiIdempotencyRaceLostError) {
        // A concurrent request with this key committed first; this card
        // rolled back. Answer with the committed first response.
        if (await replayAgentApiIdempotentWrite(idempotency, res)) return;
      }
      throw err;
    }
    // A repeat that posted nothing (plan:upgrade within a day) answers 200
    // with the card already there, flagged `existing`.
    res.status(out.existing ? 200 : 201);
    sendAgentApiResponse("actionPrepare", res, actionPrepareResponseBody(out));
    recordRaftCliActivity(req, agentId, {
      command: "action.prepare",
      summary: out.existing ? "Action card already posted" : "Prepared action card",
      target,
      correlationId: out.messageId,
    });
  } catch (err) {
    if (respondToAgentApiIdempotencyConflict(err, res)) return;
    if (err instanceof actionCardsService.ActionCardError) {
      sendActionCardError(res, err);
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to prepare action card",
      logPrefix: "internal.agent-api.prepare-action error:",
      err,
    });
  }
}], [traceActionPrepareType]);

/**
 * An ActionCardError as an agent reads it: `error`, `errorCode`, the next
 * action, and what more the refusal carries (CARD_TOO_LARGE: bytes,
 * threshold, perQuestion; ALREADY_ANSWERED: the card's metadata).
 */
function sendActionCardError(res: Response, err: actionCardsService.ActionCardError): void {
  res.status(err.status).json({
    ...err.details,
    error: err.message,
    errorCode: err.code,
    ...(err.suggestedNextAction ? { suggestedNextAction: err.suggestedNextAction } : {}),
  });
}

// A question card's agent takes it back while nobody answered it (question-card spec §4.4).
mountAgentApiRoute("actionWithdraw", [...agentApiRequestValidators("actionWithdraw"), validateAgentApiResponseMiddleware("actionWithdraw"), async (req, res) => {
  const agentId = req.actingAgentId!;
  const { messageId } = req.params as AgentApiRequestParamsByRoute["actionWithdraw"];
  try {
    const out = await actionCardsService.withdrawQuestionCard({
      serverId: req.serverId!,
      requesterAgentId: agentId,
      messageRef: messageId,
      io: (req.app.get("io") ?? null) as Parameters<typeof actionCardsService.withdrawQuestionCard>[0]["io"],
    });
    sendAgentApiResponse("actionWithdraw", res, {
      messageId: out.messageId,
      metadata: { ...out.metadata },
      ...(out.alreadyWithdrawn ? { alreadyWithdrawn: true } : {}),
    });
    recordRaftCliActivity(req, agentId, {
      command: "action.withdraw",
      summary: out.alreadyWithdrawn ? "Question card already withdrawn" : "Withdrew question card",
      target: out.messageId,
      correlationId: out.messageId,
    });
  } catch (err) {
    if (err instanceof actionCardsService.ActionCardError) {
      sendActionCardError(res, err);
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to withdraw the question card",
      logPrefix: "internal.agent-api.withdraw-action error:",
      err,
    });
  }
}]);

const RAFTBENCH_RUN_UNAVAILABLE = { error: "RaftBench could not confirm this request. An interrupted submission may already have been accepted.", suggestedNextAction: "Retry the same context request or identical submission after a short delay." };
// A findings read has no submission to recover.
const RAFTBENCH_FINDINGS_UNAVAILABLE = { error: "RaftBench could not read findings right now.", suggestedNextAction: "Retry the same findings request after a short delay." };
function sendRaftbenchError(error: unknown, res: Response, unavailable = RAFTBENCH_RUN_UNAVAILABLE): void {
  if (error instanceof RaftbenchError) {
    res.status(error.status).json({ error: error.message, code: error.code, suggestedNextAction: error.suggestedNextAction, ...(error.issues ? { issues: error.issues } : {}) });
  } else {
    console.error("RaftBench request failed", serializeErrorForLog(error));
    res.status(503).json({ error: unavailable.error, code: "raftbench_unavailable", suggestedNextAction: unavailable.suggestedNextAction });
  }
}
registerAgentApiRoute("raftbenchContext", validateAgentApiResponseMiddleware("raftbenchContext"), async (req, res) => {
  const parsed = raftbenchContextQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    refuse(res, 400, { code: "raftbench_validation_failed", error: "Invalid context request.", suggestedNextAction: "Use the assigned run ID and nextCursor returned by context." }); return;
  }
  try { sendAgentApiResponse("raftbenchContext", res, await readRaftbenchContext(req.serverId!, req.actingAgentId!, parsed.data)); }
  catch (error) { sendRaftbenchError(error, res); }
});
registerAgentApiRoute("raftbenchSubmit", validateAgentApiResponseMiddleware("raftbenchSubmit"), async (req, res) => {
  const parsed = raftbenchReportSchema.safeParse(req.body);
  if (!parsed.success) {
    // refusal-ok: the raftbench submit reads the top-level `issues` list (serverIssues in shared/src/agentOps/raftbench.ts)
    res.status(422).json({ error: "Result validation failed; nothing has been saved.", code: "raftbench_validation_failed", issues: parsed.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message, suggestedFix: "Correct this field to match the result schema. Nothing has been saved." })), suggestedNextAction: "Correct all listed fields once. If still invalid, submit incomplete with the validation failure as its reason." }); return;
  }
  try { sendAgentApiResponse("raftbenchSubmit", res, await submitRaftbenchReport(req.serverId!, req.actingAgentId!, parsed.data)); }
  catch (error) { sendRaftbenchError(error, res); }
});

registerAgentApiRoute("raftbenchFindings", validateAgentApiResponseMiddleware("raftbenchFindings"), async (req, res) => {
  const parsed = raftbenchFindingsQuerySchema.safeParse(req.query);
  if (!parsed.success) { refuse(res, 400, { code: "raftbench_validation_failed", error: "Invalid findings query; nothing was read.", suggestedNextAction: "Use only kind, channelId (a channel ID from channels.info; omit it if you cannot look one up), period (recent or history), limit (1-20) and the previous page's nextCursor. The server comes from your credential." }); return; }
  try { sendAgentApiResponse("raftbenchFindings", res, await readFindings(req.serverId!, req.actingAgentId!, parsed.data)); }
  catch (error) { sendRaftbenchError(error, res, RAFTBENCH_FINDINGS_UNAVAILABLE); }
});
